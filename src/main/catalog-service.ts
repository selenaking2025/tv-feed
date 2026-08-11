import { app } from 'electron'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { applyFamilySafetyAllowlist, applyProjectDenylist, transformIptvData } from '../shared/catalog.ts'
import { createHlsAcceptanceCatalog, createOfflineSampleCatalog } from '../shared/sample-catalog.ts'
import type {
  Catalog,
  CatalogFailureCode,
  CatalogLoadFailure,
  CatalogLoadResult,
  CatalogSyncProgress
} from '../shared/contracts.ts'
import { readCatalogCacheFile, writeCatalogCacheAtomicAndVerify } from './catalog-cache.ts'
import { fetchIptvOrgBundle, IptvOrgFetchError } from './catalog-upstream.ts'

const CACHE_TTL_MS = 12 * 60 * 60 * 1000
type ProgressReporter = (progress: CatalogSyncProgress) => void

let inFlightLoad: Promise<CatalogLoadResult> | undefined

export async function loadCatalog(
  forceRefresh = false,
  familySafety = false,
  report: ProgressReporter = () => undefined
): Promise<CatalogLoadResult> {
  if (!inFlightLoad) {
    inFlightLoad = loadCatalogInternal(forceRefresh, report).finally(() => {
      inFlightLoad = undefined
    })
  }
  const result = await inFlightLoad
  return familySafety ? { ...result, catalog: applyFamilySafetyAllowlist(result.catalog) } : result
}

export function loadOfflineDemo(familySafety = false): CatalogLoadResult {
  const catalog = applyProjectDenylist(createOfflineSampleCatalog())
  return {
    catalog: familySafety ? applyFamilySafetyAllowlist(catalog) : catalog,
    cacheStatus: 'offline-sample',
    warning: '离线演示模式：这是 8 个内置虚构样例，不是 iptv-org 真实频道目录。'
  }
}

async function loadCatalogInternal(forceRefresh: boolean, report: ProgressReporter): Promise<CatalogLoadResult> {
  const smokeAcceptanceUrl = process.env.TVFEED_SMOKE_ACCEPTANCE_URL
  if (process.env.TVFEED_SMOKE_OUTPUT && process.env.TVFEED_SMOKE_PLAY === '1' && smokeAcceptanceUrl) {
    return {
      catalog: applyProjectDenylist(createHlsAcceptanceCatalog(smokeAcceptanceUrl)),
      cacheStatus: 'offline-sample',
      warning: 'HLS 验收模式：频道目录使用内置虚构样例，媒体只使用本次运行传入的测试源。'
    }
  }

  report({ stage: 'checking-cache', message: '正在检查本机频道目录…' })
  const cache = await readCache()

  if (process.env.TVFEED_SMOKE_OUTPUT && process.env.TVFEED_SMOKE_OFFLINE_DEMO === '1') {
    return loadOfflineDemo(false)
  }

  if (!forceRefresh && cache && Date.now() - Date.parse(cache.generatedAt) < CACHE_TTL_MS) {
    return { catalog: cache, cacheStatus: 'fresh-cache', warning: '' }
  }

  try {
    if (process.env.TVFEED_SMOKE_OUTPUT && process.env.TVFEED_SMOKE_FORCE_NETWORK_FAILURE === '1') {
      throw new CatalogSyncError('network', '验收模式模拟目录网络失败', true)
    }
    const upstream = await fetchIptvOrgBundle(report)
    report({ stage: 'processing', message: '正在安全清洗和整理频道目录…' })
    let catalog: Catalog
    try {
      catalog = transformIptvData(upstream.bundle)
    } catch (error) {
      throw new CatalogSyncError(
        'invalid-data',
        'iptv-org 返回的数据无法生成安全目录',
        false,
        error
      )
    }
    if (catalog.channels.length === 0) {
      throw new CatalogSyncError('invalid-data', '安全过滤后没有可用的真实频道', false)
    }
    report({ stage: 'writing-cache', message: '正在原子写入本机频道缓存…' })
    let persisted: Catalog
    try {
      persisted = await writeCatalogCacheAtomicAndVerify(cachePath(), catalog, () => {
        report({ stage: 'verifying-cache', message: '正在重新读取并验证刚写入的频道缓存…' })
      })
    } catch (error) {
      throw new CatalogSyncError('cache-write', '频道目录缓存写入或复读验证失败', false, error)
    }
    return { catalog: applyProjectDenylist(persisted), cacheStatus: 'network', warning: upstream.warnings.join(' ') }
  } catch (error) {
    const reason = toCatalogLoadFailure(error).message
    if (cache) {
      return {
        catalog: cache,
        cacheStatus: 'stale-cache',
        warning: `iptv-org 暂时无法更新，继续使用本机缓存。${reason}`
      }
    }

    throw error
  }
}

function cachePath(): string {
  return join(app.getPath('userData'), 'catalog-v1.json')
}

export async function clearCatalogCache(): Promise<boolean> {
  try {
    await unlink(cachePath())
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

async function readCache(): Promise<Catalog | undefined> {
  const parsed = await readCatalogCacheFile(cachePath())
  return parsed ? applyProjectDenylist(parsed) : undefined
}

export function toCatalogLoadFailure(error: unknown): CatalogLoadFailure {
  const normalized = normalizeCatalogError(error)
  const copy: Record<CatalogFailureCode, { title: string; message: string }> = {
    proxy: { title: '代理连接失败', message: '无法通过当前代理连接 iptv-org，请检查 macOS、PAC、VPN 或本机代理状态。' },
    dns: { title: '域名解析失败', message: '无法解析 iptv-org 的公网地址，请检查 DNS 或网络连接。' },
    timeout: { title: '连接 iptv-org 超时', message: '频道目录请求超过时间上限，可以稍后重新尝试。' },
    http: { title: 'iptv-org 暂时不可用', message: '上游服务返回临时错误，可以稍后重新尝试。' },
    security: { title: '安全检查未通过', message: '远程响应没有通过公网地址、TLS、重定向或大小限制检查。' },
    'safety-data': { title: '安全过滤数据获取失败', message: 'blocklist 是当前安全策略的必需输入，未获取成功前不会展示真实频道。' },
    'invalid-data': { title: '频道目录格式异常', message: 'iptv-org 响应无法生成符合当前安全规则的频道目录。' },
    'cache-write': { title: '本机缓存验证失败', message: '频道目录已获取，但未能安全写入并重新读取本机缓存。' },
    network: { title: '无法连接 iptv-org', message: '当前网络无法完成频道目录同步，请检查连接后重新尝试。' },
    unknown: { title: '频道目录加载失败', message: '发生了未识别的目录错误，请重新尝试。' }
  }
  return {
    code: normalized.code,
    title: copy[normalized.code].title,
    message: copy[normalized.code].message,
    detail: sanitizeFailureDetail(normalized.detail),
    retryable: normalized.retryable
  }
}

class CatalogSyncError extends Error {
  readonly code: CatalogFailureCode
  readonly retryable: boolean

  constructor(code: CatalogFailureCode, message: string, retryable: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CatalogSyncError'
    this.code = code
    this.retryable = retryable
  }
}

function normalizeCatalogError(error: unknown): { code: CatalogFailureCode; retryable: boolean; detail: string } {
  if (error instanceof CatalogSyncError || error instanceof IptvOrgFetchError) {
    return { code: error.code, retryable: error.retryable, detail: error.message }
  }
  return {
    code: 'unknown',
    retryable: false,
    detail: error instanceof Error ? error.message : String(error)
  }
}

function sanitizeFailureDetail(value: string): string {
  return value
    .replace(/https:\/\/[^\s)]+/gi, '[远程地址]')
    .replace(/(token|signature|key|password)=[^&\s]+/gi, '$1=[已隐藏]')
    .slice(0, 1_000)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
