import {
  parseBoundedJsonArray,
  UPSTREAM_RESPONSE_LIMITS,
  type UpstreamEndpointName
} from '../shared/catalog-limits.ts'
import type {
  CatalogFailureCode,
  CatalogSyncProgressUpdate,
  UpstreamBlocklistEntry,
  UpstreamBundle,
  UpstreamCategory,
  UpstreamChannel,
  UpstreamCountry,
  UpstreamLogo,
  UpstreamStream
} from '../shared/catalog-contracts.ts'
import {
  fetchBoundedHttps,
  SecureNetworkError,
  toSecureNetworkError,
  type SecureFetchOptions,
  type SecureFetchResult
} from './secure-network.ts'
import { setTimeout as delayWithSignal } from 'node:timers/promises'
import { withAbort } from './operation-signal.ts'

const API_ROOT = 'https://iptv-org.github.io/api'
const REQUEST_TIMEOUT_MS = 30_000
const CORE_ATTEMPTS = 3
const OPTIONAL_ATTEMPTS = 2
const OPTIONAL_REQUEST_TIMEOUT_MS = 2_500
const OPTIONAL_BUDGET_MS = 5_000
const OPTIONAL_CACHE_TTL_MS = 12 * 60 * 60 * 1_000

export const IPTV_ORG_ENDPOINTS = Object.freeze({
  channels: `${API_ROOT}/channels.json`,
  streams: `${API_ROOT}/streams.json`,
  countries: `${API_ROOT}/countries.json`,
  categories: `${API_ROOT}/categories.json`,
  logos: `${API_ROOT}/logos.json`,
  blocklist: `${API_ROOT}/blocklist.json`
})

type SecureFetcher = (url: string, options: SecureFetchOptions) => Promise<SecureFetchResult>
type ProgressReporter = (progress: CatalogSyncProgressUpdate) => void

export interface IptvOrgFetchDependencies {
  fetcher?: SecureFetcher
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  optionalBudgetMs?: number
}

type OptionalEndpoint = 'countries' | 'categories' | 'logos'
type MetadataCache = Map<OptionalEndpoint, { records: unknown[]; expiresAt: number; sequence: number }>

/** Per-coordinator, bounded in-memory reuse; never caches required safety inputs. */
export function createIptvOrgFetcher(dependencies: IptvOrgFetchDependencies = {}) {
  const cache: MetadataCache = new Map()
  let sequence = 0
  return (report: ProgressReporter = () => undefined, signal?: AbortSignal): Promise<IptvOrgBundleResult> =>
    fetchBundle(report, dependencies, cache, ++sequence, signal)
}

export interface IptvOrgBundleResult {
  bundle: UpstreamBundle
  warnings: string[]
}

export class IptvOrgFetchError extends Error {
  readonly endpoint: UpstreamEndpointName
  readonly code: CatalogFailureCode
  readonly retryable: boolean

  constructor(
    endpoint: UpstreamEndpointName,
    code: CatalogFailureCode,
    message: string,
    retryable: boolean,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'IptvOrgFetchError'
    this.endpoint = endpoint
    this.code = code
    this.retryable = retryable
  }
}

export async function fetchIptvOrgBundle(
  report: ProgressReporter = () => undefined,
  dependencies: IptvOrgFetchDependencies = {},
  signal?: AbortSignal
): Promise<IptvOrgBundleResult> {
  return createIptvOrgFetcher(dependencies)(report, signal)
}

async function fetchBundle(
  report: ProgressReporter,
  dependencies: IptvOrgFetchDependencies,
  cache: MetadataCache,
  sequence: number,
  externalSignal?: AbortSignal
): Promise<IptvOrgBundleResult> {
  const fetcher = dependencies.fetcher ?? fetchBoundedHttps
  const delay = dependencies.delay ?? wait
  const now = dependencies.now ?? Date.now
  const controller = new AbortController()
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal
  signal.throwIfAborted()
  try {
    report({ stage: 'connecting', message: '正在连接 iptv-org…' })
    report({ stage: 'core-data', message: '正在获取频道、播放线路和安全过滤数据…' })

    const [channels, streams] = await Promise.all([
      fetchRequired<UpstreamChannel>('channels', '频道', CORE_ATTEMPTS, report, fetcher, delay, signal),
      fetchRequired<UpstreamStream>('streams', '播放线路', CORE_ATTEMPTS, report, fetcher, delay, signal)
    ])
    const blocklist = await fetchRequired<UpstreamBlocklistEntry>(
      'blocklist', '安全过滤', CORE_ATTEMPTS, report, fetcher, delay, signal
    )

    report({ stage: 'metadata', message: '正在获取国家、分类和台标等辅助信息…' })
    // Keep at most two large responses active. Common local/PAC proxies impose a
    // small per-process tunnel limit, and a third simultaneous CONNECT can make
    // every following optional request fail even though each endpoint is healthy.
    const optionalController = new AbortController()
    const optionalSignal = AbortSignal.any([signal, optionalController.signal])
    const timer = setTimeout(() => optionalController.abort(new Error('辅助信息等待预算已用尽')),
      dependencies.optionalBudgetMs ?? OPTIONAL_BUDGET_MS)
    try {
      const optional = async <T>(endpoint: OptionalEndpoint, label: string): Promise<{ records: T[]; warning: string }> => {
        signal.throwIfAborted()
        const cached = cache.get(endpoint)
        if (cached && cached.expiresAt > now()) return { records: cached.records as T[], warning: '' }
        try {
          const records = await fetchRequired<T>(endpoint, label, OPTIONAL_ATTEMPTS, report, fetcher, delay,
            optionalSignal, OPTIONAL_REQUEST_TIMEOUT_MS)
          if (sequence >= (cache.get(endpoint)?.sequence ?? 0)) {
            cache.set(endpoint, { records, expiresAt: now() + OPTIONAL_CACHE_TTL_MS, sequence })
          }
          return { records, warning: '' }
        } catch {
          signal.throwIfAborted()
          return { records: [], warning: `${label}暂时不可用，已继续生成不含该辅助信息的真实频道目录。` }
        }
      }
      const [countriesResult, categoriesResult] = await Promise.all([
        optional<UpstreamCountry>('countries', '国家信息'),
        optional<UpstreamCategory>('categories', '分类信息')
      ])
      const logosResult = await optional<UpstreamLogo>('logos', '台标信息')
      signal.throwIfAborted()

      return {
        bundle: {
          channels,
          streams,
          blocklist,
          countries: countriesResult.records,
          categories: categoriesResult.records,
          logos: logosResult.records
        },
        warnings: [countriesResult.warning, categoriesResult.warning, logosResult.warning].filter((value): value is string => Boolean(value))
      }
    } finally { clearTimeout(timer) }
  } finally { controller.abort(new Error('目录输入任务已结束')) }
}

async function fetchRequired<T>(
  endpoint: UpstreamEndpointName,
  label: string,
  maxAttempts: number,
  report: ProgressReporter,
  fetcher: SecureFetcher,
  delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T[]> {
  let lastError: IptvOrgFetchError | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal.throwIfAborted()
    try {
      return await withAbort(fetchEndpoint<T>(endpoint, label, fetcher, signal, timeoutMs), signal)
    } catch (error) {
      signal.throwIfAborted()
      lastError = normalizeEndpointError(endpoint, label, error)
      if (!lastError.retryable || attempt >= maxAttempts) throw lastError
      report({
        stage: endpoint === 'blocklist' ? 'core-data' : 'connecting',
        message: `${label}暂时不可用，正在重试（${attempt + 1}/${maxAttempts}）…`,
        attempt: attempt + 1,
        maxAttempts
      })
      await withAbort(delay(attempt === 1 ? 350 : 900, signal), signal)
    }
  }
  throw lastError ?? new IptvOrgFetchError(endpoint, 'unknown', `${label}获取失败`, false)
}

async function fetchEndpoint<T>(
  endpoint: UpstreamEndpointName,
  label: string,
  fetcher: SecureFetcher,
  signal: AbortSignal,
  timeoutMs: number
): Promise<T[]> {
  const limits = UPSTREAM_RESPONSE_LIMITS[endpoint]
  const response = await fetcher(IPTV_ORG_ENDPOINTS[endpoint], {
    accept: 'application/json',
    allowCompression: true,
    maxBytes: limits.maxBytes,
    timeoutMs,
    signal
  })
  if (response.contentType !== 'application/json') {
    throw new IptvOrgFetchError(endpoint, 'invalid-data', `${label}接口返回了非 JSON 内容`, false)
  }
  try {
    return parseBoundedJsonArray(response.body, label, limits.maxRecords) as T[]
  } catch (error) {
    throw new IptvOrgFetchError(
      endpoint,
      endpoint === 'blocklist' ? 'safety-data' : 'invalid-data',
      error instanceof Error ? error.message : `${label}接口格式无效`,
      false,
      error
    )
  }
}

function normalizeEndpointError(
  endpoint: UpstreamEndpointName,
  label: string,
  error: unknown
): IptvOrgFetchError {
  if (error instanceof IptvOrgFetchError) {
    if (endpoint !== 'blocklist' || error.code === 'safety-data') return error
    return new IptvOrgFetchError(endpoint, 'safety-data', error.message, error.retryable, error)
  }
  const network = error instanceof SecureNetworkError ? error : toSecureNetworkError(error)
  const code: CatalogFailureCode = endpoint === 'blocklist' ? 'safety-data' : network.code
  return new IptvOrgFetchError(endpoint, code, `${label}接口请求失败：${network.message}`, network.retryable, network)
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return delayWithSignal(milliseconds, undefined, { signal })
}
