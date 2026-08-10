import { app, net } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { applyProjectDenylist, transformIptvData } from '../shared/catalog.ts'
import { createOfflineSampleCatalog } from '../shared/sample-catalog.ts'
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

const CACHE_TTL_MS = 12 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000
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
  const [channels, streams, countries, categories, logos, blocklist] = await Promise.all([
    fetchJsonArray<UpstreamChannel>(endpoints.channels, '频道'),
    fetchJsonArray<UpstreamStream>(endpoints.streams, '线路'),
    fetchJsonArray<UpstreamCountry>(endpoints.countries, '国家'),
    fetchJsonArray<UpstreamCategory>(endpoints.categories, '分类'),
    fetchJsonArray<UpstreamLogo>(endpoints.logos, '台标'),
    fetchJsonArray<UpstreamBlocklistEntry>(endpoints.blocklist, '屏蔽列表')
  ])

  return { channels, streams, countries, categories, logos, blocklist }
}

async function fetchJsonArray<T>(url: string, label: string): Promise<T[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) throw new Error(`${label}接口返回 HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (!Array.isArray(value)) throw new Error(`${label}接口格式无效`)
    return value as T[]
  } finally {
    clearTimeout(timeout)
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
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath(), 'utf8'))
    return isValidCatalog(parsed) ? applyProjectDenylist(parsed) : undefined
  } catch {
    return undefined
  }
}

async function writeCache(catalog: Catalog): Promise<void> {
  const destination = cachePath()
  const temporary = `${destination}.tmp`
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(temporary, JSON.stringify(catalog), 'utf8')
  await rename(temporary, destination)
}

function isValidCatalog(value: unknown): value is Catalog {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Catalog>
  if (candidate.version !== 1 || typeof candidate.generatedAt !== 'string' || !Array.isArray(candidate.channels)) return false
  if (!['iptv-org', 'offline-sample'].includes(candidate.source ?? '')) return false
  return candidate.channels.every((channel) => {
    if (!channel || typeof channel !== 'object') return false
    const item = channel as Partial<Catalog['channels'][number]>
    return typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.sources)
  })
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
