import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls'
import { gunzip } from 'node:zlib'
import {
  isFakeIpDnsAddress,
  isPublicIpAddress,
  normalizeRemoteHttpsUrl
} from '../shared/remote-url-policy.ts'

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export interface ResolvedRemoteTarget {
  url: URL
  hostname: string
  addresses: readonly ResolvedAddress[]
}

export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>

export interface PinnedRequestOptions {
  headers: Readonly<Record<string, string>>
  signal?: AbortSignal
  timeoutMs: number
}

export interface RawHttpsResponse {
  statusCode: number
  headers: IncomingHttpHeaders
  body: AsyncIterable<Uint8Array>
  connectionReused?: boolean
  destroy(error?: Error): void
}

export type PinnedRequestExecutor = (
  target: ResolvedRemoteTarget,
  options: PinnedRequestOptions
) => Promise<RawHttpsResponse>

export interface SecureFetchOptions {
  maxBytes: number
  timeoutMs: number
  accept: string
  allowCompression?: boolean
  signal?: AbortSignal
  rangeStart?: number
  rangeEnd?: number
  maxRedirects?: number
}

export interface SecureFetchResult {
  body: Uint8Array
  contentType: string
  finalUrl: string
  statusCode: number
  connectionReused: boolean
}

export interface SecureStreamResult {
  body: AsyncIterable<Uint8Array>
  contentType: string
  contentLength: number | null
  contentRange: string
  acceptRanges: string
  finalUrl: string
  statusCode: number
  connectionReused: boolean
}

export interface SecureFetchDependencies {
  resolve?: AddressResolver
  request?: PinnedRequestExecutor
  trustFakeIpDns?: boolean
}

export type SecureNetworkFailureCode = 'proxy' | 'dns' | 'fake-ip-dns' | 'timeout' | 'http' | 'security' | 'network'

export class SecureNetworkError extends Error {
  readonly code: SecureNetworkFailureCode
  readonly retryable: boolean
  readonly statusCode: number | undefined

  constructor(
    code: SecureNetworkFailureCode,
    message: string,
    retryable: boolean,
    options: { cause?: unknown; statusCode?: number } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SecureNetworkError'
    this.code = code
    this.retryable = retryable
    this.statusCode = options.statusCode
  }
}

export interface ProxyRoute {
  kind: 'direct' | 'proxy'
  proxy?: URL
}

export type SystemProxyResolver = (url: string) => Promise<string>

let systemProxyResolver: SystemProxyResolver | undefined

// The catalog API host is a fixed application endpoint rather than
// user-controlled media metadata. Some macOS/PAC proxies route by hostname and
// do not support CONNECT to a pre-resolved IP. We still require a public DNS
// result first and retain TLS hostname verification. Every arbitrary remote
// resource continues to use the pinned-IP CONNECT path.
const VERIFIED_HOSTNAME_PROXY_TARGETS = new Set(['iptv-org.github.io'])

const DEFAULT_MAX_REDIRECTS = 5
const CONNECTION_POOL_MAX_ENTRIES = 64
const CONNECTION_POOL_IDLE_TTL_MS = 60_000
const CONNECTION_POOL_MAX_SOCKETS = 6
const CONNECTION_POOL_MAX_FREE_SOCKETS = 2

interface PooledAgentEntry {
  agent: HttpsAgent
  lastUsedAt: number
}

export class SecureConnectionPool {
  private readonly entries = new Map<string, PooledAgentEntry>()
  private readonly maxEntries: number
  private readonly idleTtlMs: number

  constructor(
    maxEntries = CONNECTION_POOL_MAX_ENTRIES,
    idleTtlMs = CONNECTION_POOL_IDLE_TTL_MS
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error('连接池容量无效')
    if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs <= 0) throw new Error('连接池空闲期限无效')
    this.maxEntries = maxEntries
    this.idleTtlMs = idleTtlMs
  }

  directAgent(target: ResolvedRemoteTarget, now = Date.now()): HttpsAgent {
    return this.acquire(`direct:${targetKey(target)}`, now, () => new HttpsAgent(agentOptions()))
  }

  proxyAgent(proxy: URL, target: ResolvedRemoteTarget, now = Date.now()): HttpsAgent {
    const proxyIdentity = `${proxy.protocol}//${proxy.host}\u0000${proxy.username}\u0000${proxy.password}`
    return this.acquire(`proxy:${proxyIdentity}:${targetKey(target)}`, now, () => createPooledProxyAgent(proxy, target))
  }

  get size(): number {
    return this.entries.size
  }

  destroy(): void {
    for (const entry of this.entries.values()) entry.agent.destroy()
    this.entries.clear()
  }

  private acquire(key: string, now: number, create: () => HttpsAgent): HttpsAgent {
    this.prune(now)
    const current = this.entries.get(key)
    if (current) {
      current.lastUsedAt = now
      this.entries.delete(key)
      this.entries.set(key, current)
      return current.agent
    }

    const entry = { agent: create(), lastUsedAt: now }
    this.entries.set(key, entry)
    this.prune(now)
    return entry.agent
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsedAt >= this.idleTtlMs) {
        entry.agent.destroy()
        this.entries.delete(key)
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined
      if (!oldestKey) break
      this.entries.get(oldestKey)?.agent.destroy()
      this.entries.delete(oldestKey)
    }
  }
}

const secureConnectionPool = new SecureConnectionPool()

export function configureSystemProxyResolver(resolver: SystemProxyResolver | undefined): void {
  if (systemProxyResolver !== resolver) secureConnectionPool.destroy()
  systemProxyResolver = resolver
}

export function destroySecureConnections(): void {
  secureConnectionPool.destroy()
}

export async function fetchBoundedHttps(
  inputUrl: string,
  options: SecureFetchOptions,
  dependencies: SecureFetchDependencies = {}
): Promise<SecureFetchResult> {
  validateFetchOptions(options)
  const resolve = dependencies.resolve ?? resolveSystemAddresses
  const request = dependencies.request ?? openPinnedHttpsRequest
  const trustFakeIpDns = dependencies.trustFakeIpDns ?? fakeIpDnsCompatibilityEnabled()
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const deadline = createDeadline(options.timeoutMs, options.signal)
  let currentUrl = inputUrl

  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      throwIfAborted(deadline.signal)
      const target = await abortable(resolvePublicTarget(currentUrl, resolve, { trustFakeIpDns }), deadline.signal)
      throwIfAborted(deadline.signal)
      const headers: Record<string, string> = {
        Accept: options.accept,
        'Accept-Encoding': options.allowCompression === true && options.rangeStart === undefined ? 'gzip' : 'identity',
        'User-Agent': 'TV-Feed/0.1'
      }
      if (options.rangeStart !== undefined && options.rangeEnd !== undefined) {
        headers.Range = `bytes=${options.rangeStart}-${options.rangeEnd - 1}`
      }

      const response = await request(target, {
        headers,
        timeoutMs: options.timeoutMs,
        signal: deadline.signal
      })
      const location = firstHeader(response.headers.location)
      if (isRedirect(response.statusCode)) {
        response.destroy()
        if (!location) throw new Error(`远程服务器返回 HTTP ${response.statusCode}，但没有安全的重定向地址`)
        if (redirectCount >= maxRedirects) throw new Error(`远程请求重定向超过 ${maxRedirects} 次`)
        try {
          currentUrl = new URL(location, target.url).toString()
        } catch {
          throw new Error('远程服务器返回了无效的重定向地址')
        }
        continue
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy()
        throw new SecureNetworkError(
          'http',
          `远程服务器返回 HTTP ${response.statusCode}`,
          response.statusCode === 429 || response.statusCode >= 500,
          { statusCode: response.statusCode }
        )
      }
      const contentEncoding = firstHeader(response.headers['content-encoding'])?.trim().toLocaleLowerCase()
      if (contentEncoding && contentEncoding !== 'identity' && contentEncoding !== 'gzip') {
        response.destroy()
        throw new Error(`远程服务器使用了不受支持的内容编码 ${contentEncoding}`)
      }
      if (contentEncoding === 'gzip' && options.allowCompression !== true) {
        response.destroy()
        throw new Error('远程服务器返回了当前请求未允许的 gzip 压缩正文')
      }

      const encodedBody = await readBoundedBody(response, options.maxBytes)
      const body = contentEncoding === 'gzip'
        ? await gunzipBounded(encodedBody, options.maxBytes)
        : encodedBody
      throwIfAborted(deadline.signal)
      return {
        body,
        contentType: normalizeContentType(firstHeader(response.headers['content-type']) ?? ''),
        finalUrl: target.url.toString(),
        statusCode: response.statusCode,
        connectionReused: response.connectionReused === true
      }
    }

    throw new Error('远程请求重定向处理失败')
  } catch (error) {
    if (deadline.signal.aborted) {
      const reason = deadline.signal.reason instanceof Error ? deadline.signal.reason : new Error('远程请求已取消')
      if (reason.message.includes('总时间上限')) {
        throw new SecureNetworkError('timeout', reason.message, true, { cause: reason })
      }
      throw toSecureNetworkError(reason)
    }
    throw toSecureNetworkError(error)
  } finally {
    deadline.dispose()
  }
}

export async function streamBoundedHttps(
  inputUrl: string,
  options: SecureFetchOptions,
  dependencies: SecureFetchDependencies = {}
): Promise<SecureStreamResult> {
  validateFetchOptions(options)
  if (options.allowCompression === true) throw new Error('安全流式响应不支持压缩正文')
  const resolve = dependencies.resolve ?? resolveSystemAddresses
  const request = dependencies.request ?? openPinnedHttpsRequest
  const trustFakeIpDns = dependencies.trustFakeIpDns ?? fakeIpDnsCompatibilityEnabled()
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const deadline = createDeadline(options.timeoutMs, options.signal)
  let currentUrl = inputUrl
  let bodyOwnershipTransferred = false

  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      throwIfAborted(deadline.signal)
      const target = await abortable(resolvePublicTarget(currentUrl, resolve, { trustFakeIpDns }), deadline.signal)
      throwIfAborted(deadline.signal)
      const headers: Record<string, string> = {
        Accept: options.accept,
        'Accept-Encoding': 'identity',
        'User-Agent': 'TV-Feed/0.1'
      }
      if (options.rangeStart !== undefined && options.rangeEnd !== undefined) {
        headers.Range = `bytes=${options.rangeStart}-${options.rangeEnd - 1}`
      }

      const response = await request(target, {
        headers,
        timeoutMs: options.timeoutMs,
        signal: deadline.signal
      })
      const location = firstHeader(response.headers.location)
      if (isRedirect(response.statusCode)) {
        response.destroy()
        if (!location) throw new Error(`远程服务器返回 HTTP ${response.statusCode}，但没有安全的重定向地址`)
        if (redirectCount >= maxRedirects) throw new Error(`远程请求重定向超过 ${maxRedirects} 次`)
        try {
          currentUrl = new URL(location, target.url).toString()
        } catch {
          throw new Error('远程服务器返回了无效的重定向地址')
        }
        continue
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy()
        throw new SecureNetworkError(
          'http',
          `远程服务器返回 HTTP ${response.statusCode}`,
          response.statusCode === 429 || response.statusCode >= 500,
          { statusCode: response.statusCode }
        )
      }
      const contentEncoding = firstHeader(response.headers['content-encoding'])?.trim().toLocaleLowerCase()
      if (contentEncoding && contentEncoding !== 'identity') {
        response.destroy()
        throw new Error(`安全流式响应不接受内容编码 ${contentEncoding}`)
      }
      const contentLength = parseContentLength(firstHeader(response.headers['content-length']))
      if (contentLength !== undefined && contentLength > options.maxBytes) {
        response.destroy()
        throw new Error(`远程响应声明的大小 ${contentLength} 超过 ${options.maxBytes} 字节安全上限`)
      }

      bodyOwnershipTransferred = true
      return {
        body: boundedStreamingBody(response, options.maxBytes, deadline),
        contentType: normalizeContentType(firstHeader(response.headers['content-type']) ?? ''),
        contentLength: contentLength ?? null,
        contentRange: safeContentRange(firstHeader(response.headers['content-range'])),
        acceptRanges: firstHeader(response.headers['accept-ranges'])?.trim().toLocaleLowerCase() === 'bytes' ? 'bytes' : '',
        finalUrl: target.url.toString(),
        statusCode: response.statusCode,
        connectionReused: response.connectionReused === true
      }
    }

    throw new Error('远程请求重定向处理失败')
  } catch (error) {
    if (deadline.signal.aborted) {
      const reason = deadline.signal.reason instanceof Error ? deadline.signal.reason : new Error('远程请求已取消')
      if (reason.message.includes('总时间上限')) {
        throw new SecureNetworkError('timeout', reason.message, true, { cause: reason })
      }
      throw toSecureNetworkError(reason)
    }
    throw toSecureNetworkError(error)
  } finally {
    if (!bodyOwnershipTransferred) deadline.dispose()
  }
}

export async function resolvePublicTarget(
  inputUrl: string,
  resolver: AddressResolver = resolveSystemAddresses,
  options: Readonly<{ trustFakeIpDns?: boolean }> = {}
): Promise<ResolvedRemoteTarget> {
  const normalized = normalizeRemoteHttpsUrl(inputUrl)
  if (!normalized) throw new Error('远程地址必须是无凭据的公网 HTTPS URL')
  const url = new URL(normalized)
  const hostname = stripIpv6Brackets(url.hostname)
  const literalFamily = isIP(hostname)

  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolver(hostname)
  if (resolved.length === 0) throw new Error(`远程主机 ${hostname} 没有可用的 A/AAAA 地址`)

  const fakeIpDnsOnly = literalFamily === 0 && resolved.every((entry) => (
    entry.family === 4 && isIP(entry.address) === 4 && isFakeIpDnsAddress(entry.address)
  ))
  if (fakeIpDnsOnly && options.trustFakeIpDns !== true) {
    throw new SecureNetworkError(
      'fake-ip-dns',
      '检测到 198.18.0.0/15 fake-IP DNS；兼容模式默认关闭',
      false
    )
  }

  const addresses: ResolvedAddress[] = []
  const seen = new Set<string>()
  for (const entry of resolved) {
    const family = isIP(entry.address)
    const acceptedFakeIp = fakeIpDnsOnly && options.trustFakeIpDns === true && isFakeIpDnsAddress(entry.address)
    if (
      (family !== 4 && family !== 6) ||
      family !== entry.family ||
      (!isPublicIpAddress(entry.address) && !acceptedFakeIp)
    ) {
      throw new Error(`远程主机 ${hostname} 解析到了非公网地址`)
    }
    const key = `${family}:${entry.address}`
    if (!seen.has(key)) {
      seen.add(key)
      addresses.push({ address: entry.address, family })
    }
  }
  if (addresses.length === 0) throw new Error(`远程主机 ${hostname} 没有可用的公网地址`)
  return { url, hostname, addresses }
}

export function fakeIpDnsCompatibilityEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.TVFEED_TRUST_FAKE_IP_DNS === '1'
}

export function createPinnedLookup(hostname: string, addresses: readonly ResolvedAddress[]): LookupFunction {
  const expectedHostname = canonicalHostname(hostname)
  return (requestedHostname, options, callback) => {
    if (canonicalHostname(requestedHostname) !== expectedHostname) {
      callback(networkError('EPERM', '固定 DNS 查询拒绝了不同的主机名'), '', 0)
      return
    }

    const requestedFamily = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family
    const eligible = requestedFamily === 4 || requestedFamily === 6
      ? addresses.filter((entry) => entry.family === requestedFamily)
      : [...addresses]
    if (eligible.length === 0) {
      callback(networkError('ENOTFOUND', '固定 DNS 查询没有匹配的地址族'), '', 0)
      return
    }
    if (options.all) {
      callback(null, eligible.map((entry) => ({ ...entry })))
    } else {
      const selected = eligible[0]
      if (!selected) {
        callback(networkError('ENOTFOUND', '固定 DNS 查询没有可用地址'), '', 0)
        return
      }
      callback(null, selected.address, selected.family)
    }
  }
}

export async function readBoundedBody(response: RawHttpsResponse, maxBytes: number): Promise<Uint8Array> {
  const contentLength = parseContentLength(firstHeader(response.headers['content-length']))
  if (contentLength !== undefined && contentLength > maxBytes) {
    response.destroy()
    throw new Error(`远程响应声明的大小 ${contentLength} 超过 ${maxBytes} 字节安全上限`)
  }

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    for await (const chunk of response.body) {
      totalBytes += chunk.byteLength
      if (totalBytes > maxBytes) {
        response.destroy()
        throw new Error(`远程响应超过 ${maxBytes} 字节安全上限`)
      }
      chunks.push(chunk)
    }
  } catch (error) {
    response.destroy(error instanceof Error ? error : undefined)
    throw error
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function* boundedStreamingBody(
  response: RawHttpsResponse,
  maxBytes: number,
  deadline: ReturnType<typeof createDeadline>
): AsyncGenerator<Uint8Array> {
  let totalBytes = 0
  let completed = false
  try {
    for await (const chunk of response.body) {
      throwIfAborted(deadline.signal)
      totalBytes += chunk.byteLength
      if (totalBytes > maxBytes) {
        throw new Error(`远程响应超过 ${maxBytes} 字节安全上限`)
      }
      yield chunk
    }
    throwIfAborted(deadline.signal)
    completed = true
  } catch (error) {
    response.destroy(error instanceof Error ? error : undefined)
    if (deadline.signal.aborted) {
      const reason = deadline.signal.reason instanceof Error ? deadline.signal.reason : new Error('远程请求已取消')
      if (reason.message.includes('总时间上限')) {
        throw new SecureNetworkError('timeout', reason.message, true, { cause: reason })
      }
      throw toSecureNetworkError(reason)
    }
    throw toSecureNetworkError(error)
  } finally {
    if (!completed) response.destroy(new Error('安全流式响应未完整消费'))
    deadline.dispose()
  }
}

export function gunzipBounded(body: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    gunzip(body, { maxOutputLength: maxBytes }, (error, result) => {
      if (error) {
        reject(new Error(`gzip 解压失败或解压后超过 ${maxBytes} 字节安全上限`))
        return
      }
      if (result.byteLength > maxBytes) {
        reject(new Error(`gzip 解压后超过 ${maxBytes} 字节安全上限`))
        return
      }
      resolve(Uint8Array.from(result))
    })
  })
}

async function resolveSystemAddresses(hostname: string): Promise<readonly ResolvedAddress[]> {
  const records = await dnsLookup(hostname, { all: true, order: 'verbatim' })
  return records.flatMap((entry) => entry.family === 4 || entry.family === 6
    ? [{ address: entry.address, family: entry.family }]
    : [])
}

async function openPinnedHttpsRequest(
  target: ResolvedRemoteTarget,
  options: PinnedRequestOptions
): Promise<RawHttpsResponse> {
  const routes = await resolveProxyRoutes(target.url, options.signal)
  let lastProxyError: unknown
  for (const route of routes) {
    if (route.kind === 'direct') {
      return issueHttpsRequest(
        target,
        options,
        secureConnectionPool.directAgent(target),
        createPinnedLookup(target.hostname, target.addresses)
      )
    }
    if (!route.proxy) continue
    try {
      return await issueHttpsRequest(target, options, secureConnectionPool.proxyAgent(route.proxy, target))
    } catch (error) {
      lastProxyError = error
    }
  }
  const failure = toSecureNetworkError(lastProxyError ?? new Error('代理没有提供可用路由'))
  throw new SecureNetworkError('proxy', `代理连接失败：${failure.message}`, failure.retryable, { cause: failure })
}

function issueHttpsRequest(
  target: ResolvedRemoteTarget,
  options: PinnedRequestOptions,
  agent: HttpsAgent,
  lookup?: LookupFunction
): Promise<RawHttpsResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target.url, {
      method: 'GET',
      headers: options.headers,
      agent,
      ...(lookup ? { lookup } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    }, onResponse)

    function onResponse(response: IncomingMessage): void {
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        connectionReused: request.reusedSocket,
        destroy: (error?: Error) => response.destroy(error)
      })
    }
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error('远程请求超时')))
    request.once('error', reject)
    request.end()
  })
}

function agentOptions(): ConstructorParameters<typeof HttpsAgent>[0] {
  return {
    keepAlive: true,
    keepAliveMsecs: 10_000,
    maxSockets: CONNECTION_POOL_MAX_SOCKETS,
    maxFreeSockets: CONNECTION_POOL_MAX_FREE_SOCKETS,
    timeout: CONNECTION_POOL_IDLE_TTL_MS
  }
}

function targetKey(target: ResolvedRemoteTarget): string {
  const port = target.url.port || '443'
  const addresses = [...target.addresses]
    .sort((left, right) => left.family - right.family || left.address.localeCompare(right.address))
    .map((entry) => `${entry.family}:${entry.address}`)
    .join(',')
  return `${canonicalHostname(target.hostname)}:${port}:${addresses}`
}

function createPooledProxyAgent(proxy: URL, target: ResolvedRemoteTarget): HttpsAgent {
  const agent = new HttpsAgent(agentOptions())
  agent.createConnection = ((
    connectionOptions: { signal?: AbortSignal; timeout?: number },
    callback?: (error: Error | null, connectedSocket?: TLSSocket) => void
  ): undefined => {
    const timeoutMs = Number.isSafeInteger(connectionOptions.timeout) && Number(connectionOptions.timeout) > 0
      ? Math.min(Number(connectionOptions.timeout), 120_000)
      : 30_000
    void createProxyTlsTunnel(proxy, target, {
      headers: {},
      timeoutMs,
      ...(connectionOptions.signal ? { signal: connectionOptions.signal } : {})
    }).then(
      (socket) => callback?.(null, socket),
      (error: unknown) => callback?.(error instanceof Error ? error : new Error(String(error)))
    )
    return undefined
  }) as typeof agent.createConnection
  return agent
}

function createProxyTlsTunnel(
  proxy: URL,
  target: ResolvedRemoteTarget,
  options: PinnedRequestOptions
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const address = target.addresses[0]
    if (!address) {
      reject(new Error('没有可用于代理隧道的已验证公网地址'))
      return
    }
    const targetPort = target.url.port ? Number(target.url.port) : 443
    const authority = VERIFIED_HOSTNAME_PROXY_TARGETS.has(canonicalHostname(target.hostname))
      ? `${canonicalHostname(target.hostname)}:${targetPort}`
      : formatConnectAuthority(address.address, targetPort)
    const headers: Record<string, string> = {
      Host: authority,
      'User-Agent': 'TV-Feed/0.1'
    }
    if (proxy.username || proxy.password) {
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeUrlComponent(proxy.username)}:${decodeUrlComponent(proxy.password)}`).toString('base64')}`
    }

    const requestProxy = proxy.protocol === 'https:' ? httpsRequest : httpRequest
    const connectRequest = requestProxy({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
      ...(options.signal ? { signal: options.signal } : {})
    })
    connectRequest.setTimeout(options.timeoutMs, () => connectRequest.destroy(new Error('代理隧道连接超时')))
    connectRequest.once('error', reject)
    connectRequest.once('connect', (response, tunnelSocket, head) => {
      if (response.statusCode !== 200) {
        tunnelSocket.destroy()
        reject(new Error(`HTTPS 代理拒绝连接已验证目标：HTTP ${response.statusCode ?? 0}`))
        return
      }
      if (head.byteLength > 0) tunnelSocket.unshift(head)
      const secureSocket = tlsConnect({
        socket: tunnelSocket,
        rejectUnauthorized: true,
        ALPNProtocols: ['http/1.1'],
        ...(isIP(target.hostname) === 0 ? { servername: target.hostname } : {}),
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity(target.hostname, certificate)
      })
      secureSocket.setTimeout(options.timeoutMs, () => secureSocket.destroy(new Error('目标 TLS 连接超时')))
      secureSocket.once('error', reject)
      secureSocket.once('secureConnect', () => resolve(secureSocket))
    })
    connectRequest.end()
  })
}

export function formatConnectAuthority(address: string, port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('远程端口无效')
  return `${isIP(address) === 6 ? `[${address}]` : address}:${port}`
}

function configuredHttpsProxy(): URL | undefined {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
  if (!raw) return undefined
  let proxy: URL
  try {
    proxy = new URL(raw)
  } catch {
    throw new Error('HTTPS 代理配置不是有效 URL')
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new Error('仅支持 HTTP(S) CONNECT 代理')
  }
  if (!proxy.hostname || (proxy.pathname && proxy.pathname !== '/') || proxy.search || proxy.hash) {
    throw new Error('HTTPS 代理配置包含不受支持的路径或参数')
  }
  return proxy
}

async function resolveProxyRoutes(targetUrl: URL, signal?: AbortSignal): Promise<ProxyRoute[]> {
  const environmentProxy = configuredHttpsProxy()
  if (environmentProxy) return [{ kind: 'proxy', proxy: environmentProxy }]
  if (!systemProxyResolver) return [{ kind: 'direct' }]

  let rules: string
  try {
    const resolution = systemProxyResolver(targetUrl.toString())
    rules = signal ? await abortable(resolution, signal) : await resolution
  } catch (error) {
    throw new SecureNetworkError('proxy', '无法解析 macOS 系统代理配置', true, { cause: error })
  }
  return parseSystemProxyRules(rules)
}

export function parseSystemProxyRules(input: string): ProxyRoute[] {
  const routes: ProxyRoute[] = []
  const seen = new Set<string>()
  for (const rawDirective of input.split(';')) {
    const directive = rawDirective.trim()
    if (!directive) continue
    if (directive.toLocaleUpperCase() === 'DIRECT') {
      if (!seen.has('direct')) {
        seen.add('direct')
        routes.push({ kind: 'direct' })
      }
      continue
    }

    const match = directive.match(/^(PROXY|HTTPS)\s+(.+)$/i)
    if (!match?.[1] || !match[2]) continue
    const scheme = match[1].toLocaleUpperCase() === 'HTTPS' ? 'https:' : 'http:'
    let proxy: URL
    try {
      proxy = new URL(`${scheme}//${match[2]}`)
    } catch {
      throw new SecureNetworkError('proxy', 'macOS 系统代理返回了无效地址', false)
    }
    if (
      !proxy.hostname ||
      !proxy.port ||
      (proxy.pathname && proxy.pathname !== '/') ||
      proxy.search ||
      proxy.hash
    ) {
      throw new SecureNetworkError('proxy', 'macOS 系统代理包含不受支持的路径或端口', false)
    }
    const key = proxy.toString()
    if (!seen.has(key)) {
      seen.add(key)
      routes.push({ kind: 'proxy', proxy })
    }
  }
  if (routes.length === 0) {
    throw new SecureNetworkError('proxy', 'macOS 系统代理没有返回 DIRECT、PROXY 或 HTTPS 路由', false)
  }
  return routes
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error('HTTPS 代理凭据编码无效')
  }
}

function validateFetchOptions(options: SecureFetchOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new Error('远程响应大小上限无效')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 120_000) {
    throw new Error('远程请求超时上限无效')
  }
  if (options.rangeStart === undefined && options.rangeEnd === undefined) return
  if (
    !Number.isSafeInteger(options.rangeStart) ||
    !Number.isSafeInteger(options.rangeEnd) ||
    (options.rangeStart ?? -1) < 0 ||
    (options.rangeEnd ?? 0) <= (options.rangeStart ?? -1) ||
    (options.rangeEnd ?? 0) - (options.rangeStart ?? 0) > options.maxBytes
  ) {
    throw new Error('远程字节范围无效或超过安全上限')
  }
}

function isRedirect(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function safeContentRange(value: string | undefined): string {
  const normalized = value?.trim() ?? ''
  return /^bytes \d+-\d+\/(?:\d+|\*)$/i.test(normalized) ? normalized : ''
}

function normalizeContentType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLocaleLowerCase() ?? ''
}

export function toSecureNetworkError(error: unknown): SecureNetworkError {
  if (error instanceof SecureNetworkError) return error
  const source = error instanceof Error ? error : new Error(String(error))
  const message = source.message || '远程网络请求失败'
  const nodeCode = 'code' in source && typeof source.code === 'string' ? source.code : ''

  if (message.includes('超时') || message.includes('总时间上限') || nodeCode === 'ETIMEDOUT') {
    return new SecureNetworkError('timeout', message, true, { cause: source })
  }
  if (nodeCode === 'EAI_AGAIN') return new SecureNetworkError('dns', message, true, { cause: source })
  if (nodeCode === 'ENOTFOUND' || nodeCode === 'ENODATA') {
    return new SecureNetworkError('dns', message, false, { cause: source })
  }
  if (/代理|proxy/i.test(message)) return new SecureNetworkError('proxy', message, true, { cause: source })
  // A proxy or origin can reset a socket before the TLS handshake finishes.
  // Node includes "TLS" in that transient message, so classify concrete
  // transport errno values before the certificate/TLS security wording.
  if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(nodeCode)) {
    return new SecureNetworkError('network', message, true, { cause: source })
  }
  if (
    /非公网|无凭据的公网|证书|certificate|TLS|重定向|安全上限|内容编码|gzip|字节范围/i.test(message)
  ) {
    return new SecureNetworkError('security', message, false, { cause: source })
  }
  return new SecureNetworkError('network', message, false, { cause: source })
}

function canonicalHostname(value: string): string {
  return stripIpv6Brackets(value).replace(/\.$/, '').toLocaleLowerCase()
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('远程请求已取消')
}

function createDeadline(timeoutMs: number, externalSignal: AbortSignal | undefined): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason instanceof Error ? externalSignal.reason : new Error('远程请求已取消'))
  }
  const timeout = setTimeout(() => controller.abort(new Error('远程请求超过总时间上限')), timeoutMs)
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  if (externalSignal?.aborted) onExternalAbort()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('远程请求已取消'))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error('远程请求已取消')))
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    )
  })
}

function networkError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}
