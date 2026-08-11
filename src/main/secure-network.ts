import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls'
import { gunzip } from 'node:zlib'
import { isPublicIpAddress, normalizeRemoteHttpsUrl } from '../shared/remote-url-policy.ts'

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
}

interface SecureFetchDependencies {
  resolve?: AddressResolver
  request?: PinnedRequestExecutor
}

const DEFAULT_MAX_REDIRECTS = 5

export async function fetchBoundedHttps(
  inputUrl: string,
  options: SecureFetchOptions,
  dependencies: SecureFetchDependencies = {}
): Promise<SecureFetchResult> {
  validateFetchOptions(options)
  const resolve = dependencies.resolve ?? resolveSystemAddresses
  const request = dependencies.request ?? openPinnedHttpsRequest
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const deadline = createDeadline(options.timeoutMs, options.signal)
  let currentUrl = inputUrl

  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      throwIfAborted(deadline.signal)
      const target = await abortable(resolvePublicTarget(currentUrl, resolve), deadline.signal)
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
        throw new Error(`远程服务器返回 HTTP ${response.statusCode}`)
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
        statusCode: response.statusCode
      }
    }

    throw new Error('远程请求重定向处理失败')
  } catch (error) {
    if (deadline.signal.aborted) {
      throw deadline.signal.reason instanceof Error ? deadline.signal.reason : new Error('远程请求已取消')
    }
    throw error
  } finally {
    deadline.dispose()
  }
}

export async function resolvePublicTarget(
  inputUrl: string,
  resolver: AddressResolver = resolveSystemAddresses
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

  const addresses: ResolvedAddress[] = []
  const seen = new Set<string>()
  for (const entry of resolved) {
    const family = isIP(entry.address)
    if ((family !== 4 && family !== 6) || family !== entry.family || !isPublicIpAddress(entry.address)) {
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
  const proxy = configuredHttpsProxy()
  if (proxy) {
    const socket = await createProxyTlsTunnel(proxy, target, options)
    return issueHttpsRequest(target, options, socket)
  }
  return issueHttpsRequest(target, options)
}

function issueHttpsRequest(
  target: ResolvedRemoteTarget,
  options: PinnedRequestOptions,
  socket?: TLSSocket
): Promise<RawHttpsResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target.url, {
      method: 'GET',
      headers: options.headers,
      agent: false,
      ...(socket
        ? { createConnection: () => socket }
        : { lookup: createPinnedLookup(target.hostname, target.addresses) }),
      ...(options.signal ? { signal: options.signal } : {})
    }, (response) => {
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        destroy: (error?: Error) => response.destroy(error)
      })
    })
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error('远程请求超时')))
    request.once('error', reject)
    request.end()
  })
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
    const authority = formatConnectAuthority(address.address, targetPort)
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

function normalizeContentType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLocaleLowerCase() ?? ''
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
