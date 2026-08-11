import type {
  Catalog,
  CatalogCategory,
  CatalogChannel,
  CatalogCountry,
  CatalogSource,
  UpstreamChannel,
  UpstreamLogo,
  UpstreamStream
} from './catalog-contracts.ts'
import { CATALOG_LIMITS, sanitizeUpstreamBundle } from './catalog-limits.ts'
import { FAMILY_APPROVED_CHANNEL_IDS } from './family-safety.ts'
import { PROJECT_DENIED_CHANNEL_IDS } from './project-denylist.ts'
import { normalizeRemoteHlsUrl, normalizeRemoteHttpsUrl } from './remote-url-policy.ts'

const FORBIDDEN_CATEGORY_IDS = new Set(['xxx'])

export function transformIptvData(
  input: unknown,
  generatedAt = new Date().toISOString(),
  projectDeniedChannelIds: ReadonlySet<string> = PROJECT_DENIED_CHANNEL_IDS
): Catalog {
  const sanitized = sanitizeUpstreamBundle(input)
  const bundle = sanitized.bundle
  if (generatedAt.length > 64 || !Number.isFinite(Date.parse(generatedAt))) throw new Error('目录生成时间无效')
  const countryMap = new Map(bundle.countries.map((country) => [country.code, country]))
  const categoryMap = new Map(bundle.categories.map((category) => [category.id, category]))
  const blockedChannels = new Set([
    ...bundle.blocklist.map((entry) => entry.channel),
    ...projectDeniedChannelIds
  ])
  const channelMap = new Map(bundle.channels.map((channel) => [channel.id, channel]))
  const logoMap = buildLogoMap(bundle.logos)
  const groupedSources = new Map<string, Map<string, CatalogSource>>()

  let excludedUnknownChannel = 0
  let excludedUnsafeChannel = 0
  let excludedBlockedChannel = 0
  let excludedBrowserIncompatible = 0

  for (const stream of bundle.streams) {
    const channel = stream.channel ? channelMap.get(stream.channel) : undefined
    if (!channel) {
      excludedUnknownChannel += 1
      continue
    }

    if (!isExplicitlySafeChannel(channel)) {
      excludedUnsafeChannel += 1
      continue
    }

    if (blockedChannels.has(channel.id)) {
      excludedBlockedChannel += 1
      continue
    }

    const normalizedUrl = normalizeBrowserHlsUrl(stream)
    if (!normalizedUrl) {
      excludedBrowserIncompatible += 1
      continue
    }

    const sources = groupedSources.get(channel.id) ?? new Map<string, CatalogSource>()
    insertBoundedSource(sources, toCatalogSource(channel.id, stream, normalizedUrl))
    if (sources.size > 0) groupedSources.set(channel.id, sources)
  }

  const channels: CatalogChannel[] = []
  const encoder = new TextEncoder()
  const channelByteBudget = CATALOG_LIMITS.maxCatalogBytes - CATALOG_LIMITS.catalogStructuralReserveBytes
  let retainedChannelBytes = 0
  for (const [channelId, sourceMap] of groupedSources) {
    const channel = channelMap.get(channelId)
    if (!channel) continue
    if (channels.length >= CATALOG_LIMITS.maxCatalogChannels) {
      throw new Error(`筛选后频道数超过安全上限 ${CATALOG_LIMITS.maxCatalogChannels}`)
    }

    const country = countryMap.get(channel.country)
    const categoryIds = (channel.categories ?? []).filter((id) => categoryMap.has(id) && !FORBIDDEN_CATEGORY_IDS.has(id))
    const categoryNames = categoryIds.map((id) => categoryMap.get(id)?.name ?? id)
    const sortedSources = [...sourceMap.values()].sort(compareSources)

    const name = cleanText(channel.name) || channel.id
    const altNames = (channel.alt_names ?? []).map(cleanText).filter(Boolean)
    const network = cleanText(channel.network ?? '')
    const countryName = cleanText(country?.name ?? channel.country) || '未知地区'
    const flag = cleanText(country?.flag ?? '')
    const searchText = [name, ...altNames, channel.id, network, countryName, channel.country, ...categoryIds, ...categoryNames]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
    if (searchText.length > CATALOG_LIMITS.maxSearchTextLength) {
      throw new Error(`频道 ${channel.id} 的搜索元数据超过安全上限`)
    }

    const catalogChannel: CatalogChannel = {
      id: channel.id,
      name,
      altNames,
      network,
      countryCode: channel.country,
      countryName,
      flag,
      categoryIds,
      categoryNames,
      logoUrl: logoMap.get(channel.id) ?? '',
      website: normalizeRemoteHttpsUrl(channel.website ?? ''),
      searchText,
      sources: sortedSources
    }
    retainedChannelBytes += encoder.encode(JSON.stringify(catalogChannel)).byteLength
    if (retainedChannelBytes > channelByteBudget) {
      throw new Error(`筛选后频道目录超过 ${channelByteBudget} 字节摄取预算`)
    }
    channels.push(catalogChannel)
  }

  channels.sort(compareChannels)
  const candidateStreams = channels.reduce((total, channel) => total + channel.sources.length, 0)

  return {
    version: 1,
    generatedAt,
    source: 'iptv-org',
    channels,
    countries: buildCountryFacets(channels),
    categories: buildCategoryFacets(channels, categoryMap),
    stats: {
      rawChannels: bundle.channels.length,
      rawStreams: bundle.streams.length,
      candidateStreams,
      channels: channels.length,
      excludedUnknownChannel,
      excludedUnsafeChannel,
      excludedBlockedChannel,
      excludedBrowserIncompatible,
      discardedUpstreamRecords: Object.values(sanitized.discardedRecords).reduce((total, count) => total + count, 0)
    }
  }
}

export function applyProjectDenylist(
  catalog: Catalog,
  projectDeniedChannelIds: ReadonlySet<string> = PROJECT_DENIED_CHANNEL_IDS
): Catalog {
  if (projectDeniedChannelIds.size === 0) return catalog

  const removed = catalog.channels.filter((channel) => projectDeniedChannelIds.has(channel.id))
  if (removed.length === 0) return catalog

  const channels = catalog.channels.filter((channel) => !projectDeniedChannelIds.has(channel.id))
  const removedSources = removed.reduce((total, channel) => total + channel.sources.length, 0)
  const categoryMap = new Map(catalog.categories.map((category) => [category.id, category]))

  return {
    ...catalog,
    channels,
    countries: buildCountryFacets(channels),
    categories: buildCategoryFacets(channels, categoryMap),
    stats: {
      ...catalog.stats,
      candidateStreams: Math.max(0, catalog.stats.candidateStreams - removedSources),
      channels: channels.length,
      excludedBlockedChannel: catalog.stats.excludedBlockedChannel + removedSources
    }
  }
}

export function applyFamilySafetyAllowlist(
  catalog: Catalog,
  approvedChannelIds: ReadonlySet<string> = FAMILY_APPROVED_CHANNEL_IDS
): Catalog {
  const removed = catalog.channels.filter((channel) => !approvedChannelIds.has(channel.id))
  const channels = catalog.channels
    .filter((channel) => approvedChannelIds.has(channel.id))
    .map((channel) => ({ ...channel, logoUrl: '' }))
  const removedSources = removed.reduce((total, channel) => total + channel.sources.length, 0)
  const categoryMap = new Map(catalog.categories.map((category) => [category.id, category]))

  return {
    ...catalog,
    channels,
    countries: buildCountryFacets(channels),
    categories: buildCategoryFacets(channels, categoryMap),
    stats: {
      ...catalog.stats,
      candidateStreams: Math.max(0, catalog.stats.candidateStreams - removedSources),
      channels: channels.length,
      excludedFamilySafety: (catalog.stats.excludedFamilySafety ?? 0) + removedSources
    }
  }
}

export function isExplicitlySafeChannel(channel: UpstreamChannel): boolean {
  if (channel.is_nsfw !== false) return false
  if (Boolean(channel.closed)) return false
  return !(channel.categories ?? []).some((category) => FORBIDDEN_CATEGORY_IDS.has(category))
}

export function normalizeBrowserHlsUrl(stream: UpstreamStream): string {
  if (stream.referrer || stream.user_agent) return ''
  return normalizeRemoteHlsUrl(stream.url)
}

function buildLogoMap(logos: UpstreamLogo[]): Map<string, string> {
  const candidates = new Map<string, { score: number; url: string }>()
  for (const logo of logos) {
    if (!logo.channel || !logo.in_use || !logo.url) continue
    const url = normalizeRemoteHttpsUrl(logo.url)
    if (!url) continue
    const tags = logo.tags ?? []
    const score = Number(tags.includes('horizontal')) * 2 + Number(tags.includes('white'))
    const current = candidates.get(logo.channel)
    if (!current || score > current.score) candidates.set(logo.channel, { score, url })
  }
  return new Map([...candidates].map(([channel, value]) => [channel, value.url]))
}

function toCatalogSource(channelId: string, stream: UpstreamStream, url: string): CatalogSource {
  const title = cleanText(stream.title ?? '')
  const quality = cleanText(stream.quality ?? '') || '未知清晰度'
  const label = cleanText(stream.label ?? '')
  const feed = cleanText(stream.feed ?? '')
  return {
    id: `${channelId}:${hashString(url)}`,
    url,
    title,
    quality,
    label,
    feed
  }
}

function compareSources(a: CatalogSource, b: CatalogSource): number {
  const availabilityDifference = Number(Boolean(a.label)) - Number(Boolean(b.label))
  if (availabilityDifference) return availabilityDifference
  return qualityScore(b.quality) - qualityScore(a.quality) || a.title.localeCompare(b.title)
}

function insertBoundedSource(sources: Map<string, CatalogSource>, candidate: CatalogSource): void {
  if (sources.has(candidate.url)) return
  if (sources.size < CATALOG_LIMITS.maxSourcesPerChannel) {
    sources.set(candidate.url, candidate)
    return
  }

  let worst: CatalogSource | undefined
  for (const source of sources.values()) {
    if (!worst || compareSources(source, worst) > 0) worst = source
  }
  if (worst && compareSources(candidate, worst) < 0) {
    sources.delete(worst.url)
    sources.set(candidate.url, candidate)
  }
}

function compareChannels(a: CatalogChannel, b: CatalogChannel): number {
  const priorityDifference = countryPriority(b.countryCode) - countryPriority(a.countryCode)
  if (priorityDifference) return priorityDifference
  return a.name.localeCompare(b.name, ['zh-CN', 'en'])
}

function countryPriority(code: string): number {
  return {
    CN: 100,
    HK: 92,
    TW: 90,
    MO: 88,
    US: 72,
    UK: 68,
    JP: 64,
    KR: 60,
    CA: 56,
    AU: 52
  }[code] ?? 0
}

function qualityScore(quality: string): number {
  const progressive = quality.match(/(\d{3,4})p/i)
  if (progressive?.[1]) return Number(progressive[1])
  const interlaced = quality.match(/(\d{3,4})i/i)
  if (interlaced?.[1]) return Number(interlaced[1]) - 80
  return 0
}

function buildCountryFacets(channels: CatalogChannel[]): CatalogCountry[] {
  const facets = new Map<string, CatalogCountry>()
  for (const channel of channels) {
    const current = facets.get(channel.countryCode)
    if (current) {
      current.count += 1
    } else {
      facets.set(channel.countryCode, {
        code: channel.countryCode,
        name: channel.countryName,
        flag: channel.flag,
        count: 1
      })
    }
  }
  return [...facets.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, ['zh-CN', 'en']))
}

function buildCategoryFacets(channels: CatalogChannel[], categoryMap: Map<string, { name: string }>): CatalogCategory[] {
  const counts = new Map<string, number>()
  for (const channel of channels) {
    for (const categoryId of channel.categoryIds) counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1)
  }
  return [...counts]
    .map(([id, count]) => ({ id, name: categoryMap.get(id)?.name ?? id, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, ['zh-CN', 'en']))
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
