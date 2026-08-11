import { app } from 'electron'
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { applyProjectDenylist, transformIptvData } from '../shared/catalog.ts'
import {
  CATALOG_LIMITS,
  parseBoundedJsonArray,
  parseCatalogCache,
  serializeCatalogForCache,
  UPSTREAM_RESPONSE_LIMITS,
  type UpstreamEndpointName
} from '../shared/catalog-limits.ts'
import { createHlsAcceptanceCatalog, createOfflineSampleCatalog } from '../shared/sample-catalog.ts'
import type {
  Catalog,
  CatalogLoadResult,
  UpstreamBlocklistEntry,
  UpstreamBundle,
  UpstreamCategory,
  UpstreamChannel,
  UpstreamCountry,
  UpstreamLogo,
  UpstreamStream
} from '../shared/contracts.ts'
import { fetchBoundedHttps } from './secure-network.ts'

const CACHE_TTL_MS = 12 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 120_000
const API_ROOT = 'https://iptv-org.github.io/api'

const endpoints = {
  channels: `${API_ROOT}/channels.json`,
  streams: `${API_ROOT}/streams.json`,
  countries: `${API_ROOT}/countries.json`,
  categories: `${API_ROOT}/categories.json`,
  logos: `${API_ROOT}/logos.json`,
  blocklist: `${API_ROOT}/blocklist.json`
} as const

let inFlightLoad: Promise<CatalogLoadResult> | undefined

export function loadCatalog(forceRefresh = false): Promise<CatalogLoadResult> {
  if (!inFlightLoad) {
    inFlightLoad = loadCatalogInternal(forceRefresh).finally(() => {
      inFlightLoad = undefined
    })
  }
  return inFlightLoad
}

async function loadCatalogInternal(forceRefresh: boolean): Promise<CatalogLoadResult> {
  const smokeAcceptanceUrl = process.env.TVFEED_SMOKE_ACCEPTANCE_URL
  if (process.env.TVFEED_SMOKE_OUTPUT && process.env.TVFEED_SMOKE_PLAY === '1' && smokeAcceptanceUrl) {
    return {
      catalog: applyProjectDenylist(createHlsAcceptanceCatalog(smokeAcceptanceUrl)),
      cacheStatus: 'offline-sample',
      warning: 'HLS 验收模式：频道目录使用内置虚构样例，媒体只使用本次运行传入的测试源。'
    }
  }

  const cache = await readCache()

  if (process.env.TVFEED_OFFLINE_DEMO === '1') {
    return {
      catalog: applyProjectDenylist(createOfflineSampleCatalog()),
      cacheStatus: 'offline-sample',
      warning: '离线演示模式：正在使用内置虚构样例，未请求网络。'
    }
  }

  if (!forceRefresh && cache && Date.now() - Date.parse(cache.generatedAt) < CACHE_TTL_MS) {
    return { catalog: cache, cacheStatus: 'fresh-cache', warning: '' }
  }

  try {
    if (process.env.TVFEED_SMOKE_OUTPUT && process.env.TVFEED_SMOKE_FORCE_NETWORK_FAILURE === '1') {
      throw new Error('验收模式模拟目录网络失败')
    }
    const bundle = await fetchUpstreamBundle()
    const catalog = transformIptvData(bundle)
    if (catalog.channels.length === 0) throw new Error('目录过滤后没有可用频道')
    await writeCache(catalog)
    return { catalog, cacheStatus: 'network', warning: '' }
  } catch (error) {
    const reason = toErrorMessage(error)
    if (cache) {
      return {
        catalog: cache,
        cacheStatus: 'stale-cache',
        warning: `iptv-org 暂时无法更新，继续使用本机缓存。${reason}`
      }
    }

    return {
      catalog: applyProjectDenylist(createOfflineSampleCatalog()),
      cacheStatus: 'offline-sample',
      warning: `iptv-org 暂时无法连接，已切换到内置离线样例。${reason}`
    }
  }
}

async function fetchUpstreamBundle(): Promise<UpstreamBundle> {
  // Refreshes happen at most twice a day. Two bounded responses at a time avoid
  // the six-response peak while keeping the large public catalog usable.
  const [channels, logos] = await Promise.all([
    fetchJsonArray<UpstreamChannel>('channels', endpoints.channels, '频道'),
    fetchJsonArray<UpstreamLogo>('logos', endpoints.logos, '台标')
  ])
  const [streams, blocklist] = await Promise.all([
    fetchJsonArray<UpstreamStream>('streams', endpoints.streams, '线路'),
    fetchJsonArray<UpstreamBlocklistEntry>('blocklist', endpoints.blocklist, '屏蔽列表')
  ])
  const [countries, categories] = await Promise.all([
    fetchJsonArray<UpstreamCountry>('countries', endpoints.countries, '国家'),
    fetchJsonArray<UpstreamCategory>('categories', endpoints.categories, '分类')
  ])

  return { channels, streams, countries, categories, logos, blocklist }
}

async function fetchJsonArray<T>(endpoint: UpstreamEndpointName, url: string, label: string): Promise<T[]> {
  const limits = UPSTREAM_RESPONSE_LIMITS[endpoint]
  const response = await fetchBoundedHttps(url, {
    accept: 'application/json',
    allowCompression: true,
    maxBytes: limits.maxBytes,
    timeoutMs: REQUEST_TIMEOUT_MS
  })
  if (response.contentType !== 'application/json') throw new Error(`${label}接口返回了非 JSON 内容`)
  return parseBoundedJsonArray(response.body, label, limits.maxRecords) as T[]
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
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(cachePath(), 'r')
    const before = await handle.stat()
    if (!before.isFile() || before.size <= 0 || before.size > CATALOG_LIMITS.maxCacheBytes) return undefined

    const body = new Uint8Array(before.size)
    let offset = 0
    while (offset < body.byteLength) {
      const { bytesRead } = await handle.read(body, offset, body.byteLength - offset, offset)
      if (bytesRead === 0) return undefined
      offset += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return undefined
    const parsed = parseCatalogCache(body)
    return parsed ? applyProjectDenylist(parsed) : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeCache(catalog: Catalog): Promise<void> {
  const destination = cachePath()
  const temporary = `${destination}.tmp`
  const serialized = serializeCatalogForCache(catalog)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, destination)
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '请求超时。'
    return error.message ? `原因：${error.message}` : ''
  }
  return ''
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
