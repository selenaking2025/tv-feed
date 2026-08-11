import type {
  Catalog,
  UpstreamBlocklistEntry,
  UpstreamBundle,
  UpstreamCategory,
  UpstreamChannel,
  UpstreamCountry,
  UpstreamLogo,
  UpstreamStream
} from './contracts.ts'
import { normalizeRemoteHlsUrl, normalizeRemoteHttpsUrl } from './remote-url-policy.ts'

const KIB = 1_024
const MIB = 1_024 * KIB

export const UPSTREAM_RESPONSE_LIMITS = Object.freeze({
  channels: { maxBytes: 16 * MIB, maxRecords: 50_000 },
  streams: { maxBytes: 8 * MIB, maxRecords: 100_000 },
  countries: { maxBytes: 1 * MIB, maxRecords: 500 },
  categories: { maxBytes: 512 * KIB, maxRecords: 500 },
  logos: { maxBytes: 12 * MIB, maxRecords: 100_000 },
  blocklist: { maxBytes: 2 * MIB, maxRecords: 20_000 }
})

export const CATALOG_LIMITS = Object.freeze({
  maxSourcesPerChannel: 12,
  maxCatalogChannels: 25_000,
  maxCatalogBytes: 64 * MIB,
  catalogStructuralReserveBytes: 2 * MIB,
  maxCacheBytes: 64 * MIB,
  maxIdLength: 256,
  maxNameLength: 512,
  maxMetadataLength: 1_024,
  maxSearchTextLength: 32_768,
  maxAltNames: 32,
  maxCategoriesPerChannel: 64,
  maxLogoTags: 32
})

export type UpstreamEndpointName = keyof typeof UPSTREAM_RESPONSE_LIMITS

export function parseBoundedJsonArray(body: Uint8Array, label: string, maxRecords: number): unknown[] {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new Error(`${label}接口不是有效的 UTF-8`)
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${label}接口不是有效的 JSON`)
  }
  if (!Array.isArray(value)) throw new Error(`${label}接口格式无效`)
  if (value.length > maxRecords) throw new Error(`${label}接口记录数超过安全上限 ${maxRecords}`)
  return value
}

export function assertBoundedUpstreamBundle(value: unknown): asserts value is UpstreamBundle {
  const bundle = asRecord(value, '上游目录')
  const channels = boundedArray(bundle.channels, '频道', UPSTREAM_RESPONSE_LIMITS.channels.maxRecords)
  const streams = boundedArray(bundle.streams, '线路', UPSTREAM_RESPONSE_LIMITS.streams.maxRecords)
  const countries = boundedArray(bundle.countries, '国家', UPSTREAM_RESPONSE_LIMITS.countries.maxRecords)
  const categories = boundedArray(bundle.categories, '分类', UPSTREAM_RESPONSE_LIMITS.categories.maxRecords)
  const logos = boundedArray(bundle.logos, '台标', UPSTREAM_RESPONSE_LIMITS.logos.maxRecords)
  const blocklist = boundedArray(bundle.blocklist, '屏蔽列表', UPSTREAM_RESPONSE_LIMITS.blocklist.maxRecords)

  for (const [index, raw] of channels.entries()) {
    const item = asRecord(raw, `频道[${index}]`)
    requiredString(item.id, `频道[${index}].id`, CATALOG_LIMITS.maxIdLength)
    requiredString(item.name, `频道[${index}].name`, CATALOG_LIMITS.maxNameLength)
    requiredString(item.country, `频道[${index}].country`, 16)
    optionalString(item.network, `频道[${index}].network`, CATALOG_LIMITS.maxMetadataLength)
    optionalString(item.closed, `频道[${index}].closed`, 64)
    optionalString(item.website, `频道[${index}].website`, 4_096)
    optionalBoolean(item.is_nsfw, `频道[${index}].is_nsfw`)
    optionalStringArray(item.alt_names, `频道[${index}].alt_names`, CATALOG_LIMITS.maxAltNames, CATALOG_LIMITS.maxNameLength)
    optionalStringArray(item.categories, `频道[${index}].categories`, CATALOG_LIMITS.maxCategoriesPerChannel, CATALOG_LIMITS.maxIdLength)
  }

  for (const [index, raw] of streams.entries()) {
    const item = asRecord(raw, `线路[${index}]`)
    optionalString(item.channel, `线路[${index}].channel`, CATALOG_LIMITS.maxIdLength)
    requiredString(item.url, `线路[${index}].url`, 4_096)
    optionalString(item.feed, `线路[${index}].feed`, CATALOG_LIMITS.maxMetadataLength)
    optionalString(item.title, `线路[${index}].title`, CATALOG_LIMITS.maxNameLength)
    optionalString(item.referrer, `线路[${index}].referrer`, 4_096)
    optionalString(item.user_agent, `线路[${index}].user_agent`, CATALOG_LIMITS.maxMetadataLength)
    optionalString(item.quality, `线路[${index}].quality`, 64)
    optionalString(item.label, `线路[${index}].label`, CATALOG_LIMITS.maxMetadataLength)
  }

  for (const [index, raw] of countries.entries()) {
    const item = asRecord(raw, `国家[${index}]`)
    requiredString(item.name, `国家[${index}].name`, CATALOG_LIMITS.maxNameLength)
    requiredString(item.code, `国家[${index}].code`, 16)
    optionalString(item.flag, `国家[${index}].flag`, 32)
  }

  for (const [index, raw] of categories.entries()) {
    const item = asRecord(raw, `分类[${index}]`)
    requiredString(item.id, `分类[${index}].id`, CATALOG_LIMITS.maxIdLength)
    requiredString(item.name, `分类[${index}].name`, CATALOG_LIMITS.maxNameLength)
    optionalString(item.description, `分类[${index}].description`, 4_096)
  }

  for (const [index, raw] of logos.entries()) {
    const item = asRecord(raw, `台标[${index}]`)
    optionalString(item.channel, `台标[${index}].channel`, CATALOG_LIMITS.maxIdLength)
    optionalBoolean(item.in_use, `台标[${index}].in_use`)
    optionalString(item.url, `台标[${index}].url`, 4_096)
    optionalStringArray(item.tags, `台标[${index}].tags`, CATALOG_LIMITS.maxLogoTags, CATALOG_LIMITS.maxMetadataLength)
  }

  for (const [index, raw] of blocklist.entries()) {
    const item = asRecord(raw, `屏蔽列表[${index}]`)
    requiredString(item.channel, `屏蔽列表[${index}].channel`, CATALOG_LIMITS.maxIdLength)
    requiredString(item.reason, `屏蔽列表[${index}].reason`, CATALOG_LIMITS.maxMetadataLength)
    optionalString(item.ref, `屏蔽列表[${index}].ref`, 4_096)
  }
}

export interface SanitizedUpstreamBundle {
  bundle: UpstreamBundle
  discardedRecords: Readonly<Record<UpstreamEndpointName, number>>
}

/**
 * Keep response-level limits strict, but isolate malformed upstream records so
 * one optional field or one bad item cannot discard an otherwise safe catalog.
 */
export function sanitizeUpstreamBundle(value: unknown): SanitizedUpstreamBundle {
  const input = asRecord(value, '上游目录')
  const raw = {
    channels: boundedArray(input.channels, '频道', UPSTREAM_RESPONSE_LIMITS.channels.maxRecords),
    streams: boundedArray(input.streams, '线路', UPSTREAM_RESPONSE_LIMITS.streams.maxRecords),
    countries: boundedArray(input.countries, '国家', UPSTREAM_RESPONSE_LIMITS.countries.maxRecords),
    categories: boundedArray(input.categories, '分类', UPSTREAM_RESPONSE_LIMITS.categories.maxRecords),
    logos: boundedArray(input.logos, '台标', UPSTREAM_RESPONSE_LIMITS.logos.maxRecords),
    blocklist: boundedArray(input.blocklist, '屏蔽列表', UPSTREAM_RESPONSE_LIMITS.blocklist.maxRecords)
  }

  const channels = compactMap(raw.channels, sanitizeChannel)
  const streams = compactMap(raw.streams, sanitizeStream)
  const countries = compactMap(raw.countries, sanitizeCountry)
  const categories = compactMap(raw.categories, sanitizeCategory)
  const logos = compactMap(raw.logos, sanitizeLogo)
  const blocklist = compactMap(raw.blocklist, sanitizeBlocklistEntry)

  return {
    bundle: { channels, streams, countries, categories, logos, blocklist },
    discardedRecords: {
      channels: raw.channels.length - channels.length,
      streams: raw.streams.length - streams.length,
      countries: raw.countries.length - countries.length,
      categories: raw.categories.length - categories.length,
      logos: raw.logos.length - logos.length,
      blocklist: raw.blocklist.length - blocklist.length
    }
  }
}

function sanitizeChannel(value: unknown): UpstreamChannel | undefined {
  const item = recordOrUndefined(value)
  if (!item) return undefined
  const id = coreString(item.id, CATALOG_LIMITS.maxIdLength)
  const name = truncatableCoreString(item.name, CATALOG_LIMITS.maxNameLength)
  const country = coreString(item.country, 16)
  if (!id || !name || !country) return undefined
  if (item.categories !== undefined && item.categories !== null && !Array.isArray(item.categories)) return undefined
  if (Array.isArray(item.categories) && item.categories.length > CATALOG_LIMITS.maxCategoriesPerChannel) return undefined

  const result: UpstreamChannel = { id, name, country }
  assignString(result, 'network', item.network, CATALOG_LIMITS.maxMetadataLength)
  assignString(result, 'website', item.website, 4_096)
  if (typeof item.is_nsfw === 'boolean') result.is_nsfw = item.is_nsfw
  if (item.closed !== undefined && item.closed !== null) {
    result.closed = boundedString(item.closed, 64, true) ? item.closed : 'invalid-metadata'
  }
  const altNames = sanitizedStringArray(item.alt_names, CATALOG_LIMITS.maxAltNames, CATALOG_LIMITS.maxNameLength)
  if (altNames) result.alt_names = altNames
  const categories = sanitizedStringArray(item.categories, CATALOG_LIMITS.maxCategoriesPerChannel, CATALOG_LIMITS.maxIdLength)
  if (categories) result.categories = categories
  return result
}

function sanitizeStream(value: unknown): UpstreamStream | undefined {
  const item = recordOrUndefined(value)
  if (!item) return undefined
  const channel = coreString(item.channel, CATALOG_LIMITS.maxIdLength)
  const url = coreString(item.url, 4_096)
  if (!url) return undefined
  const result: UpstreamStream = { url }
  if (channel) result.channel = channel
  assignString(result, 'feed', item.feed, CATALOG_LIMITS.maxMetadataLength)
  assignString(result, 'title', item.title, CATALOG_LIMITS.maxNameLength)
  assignString(result, 'quality', item.quality, 64)
  assignString(result, 'label', item.label, CATALOG_LIMITS.maxMetadataLength)
  assignRejectingHeader(result, 'referrer', item.referrer, 4_096)
  assignRejectingHeader(result, 'user_agent', item.user_agent, CATALOG_LIMITS.maxMetadataLength)
  return result
}

function sanitizeCountry(value: unknown): UpstreamCountry | undefined {
  const item = recordOrUndefined(value)
  if (!item) return undefined
  const name = truncatableCoreString(item.name, CATALOG_LIMITS.maxNameLength)
  const code = coreString(item.code, 16)
  if (!name || !code) return undefined
  const result: UpstreamCountry = { name, code }
  assignString(result, 'flag', item.flag, 32)
  return result
}

function sanitizeCategory(value: unknown): UpstreamCategory | undefined {
  const item = recordOrUndefined(value)
  if (!item) return undefined
  const id = coreString(item.id, CATALOG_LIMITS.maxIdLength)
  const name = truncatableCoreString(item.name, CATALOG_LIMITS.maxNameLength)
  if (!id || !name) return undefined
  const result: UpstreamCategory = { id, name }
  assignString(result, 'description', item.description, 4_096)
  return result
}

function sanitizeLogo(value: unknown): UpstreamLogo | undefined {
  const item = recordOrUndefined(value)
  if (!item) return undefined
  const channel = coreString(item.channel, CATALOG_LIMITS.maxIdLength)
  const url = coreString(item.url, 4_096)
  const result: UpstreamLogo = {}
  if (channel) result.channel = channel
  if (url) result.url = url
  if (typeof item.in_use === 'boolean') result.in_use = item.in_use
  const tags = sanitizedStringArray(item.tags, CATALOG_LIMITS.maxLogoTags, CATALOG_LIMITS.maxMetadataLength)
  if (tags) result.tags = tags
  return result
}

function sanitizeBlocklistEntry(value: unknown): UpstreamBlocklistEntry | undefined {
  const item = recordOrUndefined(value)
  if (!item) return undefined
  const channel = coreString(item.channel, CATALOG_LIMITS.maxIdLength)
  if (!channel) return undefined
  const reason = coreString(item.reason, CATALOG_LIMITS.maxMetadataLength) ?? 'unspecified'
  const result: UpstreamBlocklistEntry = { channel, reason }
  assignString(result, 'ref', item.ref, 4_096)
  return result
}

function compactMap<T>(values: unknown[], transform: (value: unknown) => T | undefined): T[] {
  const result: T[] = []
  for (const value of values) {
    const transformed = transform(value)
    if (transformed !== undefined) result.push(transformed)
  }
  return result
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function coreString(value: unknown, maxLength: number): string | undefined {
  return boundedString(value, maxLength) ? value : undefined
}

function truncatableCoreString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.slice(0, maxLength)
}

function sanitizedStringArray(value: unknown, maxItems: number, maxItemLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .slice(0, maxItems)
    .filter((entry): entry is string => boundedString(entry, maxItemLength, true))
}

function assignString<T extends object>(
  target: T,
  key: string,
  value: unknown,
  maxLength: number
): void {
  if (boundedString(value, maxLength, true)) Object.assign(target, { [key]: value })
}

function assignRejectingHeader<T extends object>(
  target: T,
  key: string,
  value: unknown,
  maxLength: number
): void {
  if (value === undefined || value === null || value === '') return
  Object.assign(target, { [key]: boundedString(value, maxLength, true) ? value : 'invalid-metadata' })
}

export function parseCatalogCache(body: Uint8Array): Catalog | undefined {
  if (body.byteLength > CATALOG_LIMITS.maxCacheBytes) return undefined
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    if (isValidBoundedCatalog(value)) return value
    if (!canonicalizeLegacyCatalogUrls(value)) return undefined
    return isValidBoundedCatalog(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Older v1 caches could retain URL fragments that the current remote URL
 * policy removes. Canonicalize only values that still resolve to an allowed
 * public HTTPS/HLS URL, then run the complete strict validator again.
 * Unsafe or malformed values remain invalid instead of being silently erased.
 */
function canonicalizeLegacyCatalogUrls(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.version !== 1) return false

  const channels = candidate.channels
  if (!Array.isArray(channels) || channels.length > CATALOG_LIMITS.maxCatalogChannels) return false

  for (const rawChannel of channels) {
    if (!rawChannel || typeof rawChannel !== 'object' || Array.isArray(rawChannel)) return false
    const channel = rawChannel as Record<string, unknown>
    canonicalizeLegacyUrlField(channel, 'logoUrl', normalizeRemoteHttpsUrl)
    canonicalizeLegacyUrlField(channel, 'website', normalizeRemoteHttpsUrl)

    const sources = channel.sources
    if (!Array.isArray(sources) || sources.length > CATALOG_LIMITS.maxSourcesPerChannel) return false
    for (const rawSource of sources) {
      if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) return false
      canonicalizeLegacyUrlField(rawSource as Record<string, unknown>, 'url', normalizeRemoteHlsUrl)
    }
  }
  return true
}

function canonicalizeLegacyUrlField(
  record: Record<string, unknown>,
  field: string,
  normalize: (value: unknown) => string
): void {
  const current = record[field]
  if (!boundedString(current, 4_096, true) || current.length === 0) return
  const normalized = normalize(current)
  if (normalized) record[field] = normalized
}

export function serializeCatalogForCache(catalog: Catalog, maxBytes = CATALOG_LIMITS.maxCatalogBytes): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > CATALOG_LIMITS.maxCatalogBytes) {
    throw new Error('目录缓存大小上限无效')
  }
  if (!isValidBoundedCatalog(catalog)) throw new Error('生成的目录结构超过安全边界')
  const serialized = JSON.stringify(catalog)
  const byteLength = new TextEncoder().encode(serialized).byteLength
  if (byteLength > maxBytes) {
    throw new Error(`生成的目录超过 ${maxBytes} 字节安全上限`)
  }
  return serialized
}

export function isValidBoundedCatalog(value: unknown): value is Catalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const catalog = value as Partial<Catalog>
  if (catalog.version !== 1 || !boundedString(catalog.generatedAt, 64)) return false
  if (!Number.isFinite(Date.parse(catalog.generatedAt))) return false
  if (catalog.source !== 'iptv-org' && catalog.source !== 'offline-sample') return false
  if (!Array.isArray(catalog.channels) || catalog.channels.length > CATALOG_LIMITS.maxCatalogChannels) return false
  if (!Array.isArray(catalog.countries) || catalog.countries.length > UPSTREAM_RESPONSE_LIMITS.countries.maxRecords) return false
  if (!Array.isArray(catalog.categories) || catalog.categories.length > UPSTREAM_RESPONSE_LIMITS.categories.maxRecords) return false
  if (!isValidStats(catalog.stats)) return false

  for (const channel of catalog.channels) {
    if (!channel || typeof channel !== 'object') return false
    if (!boundedString(channel.id, CATALOG_LIMITS.maxIdLength) || !boundedString(channel.name, CATALOG_LIMITS.maxNameLength)) return false
    if (!stringArrayWithin(channel.altNames, CATALOG_LIMITS.maxAltNames, CATALOG_LIMITS.maxNameLength)) return false
    if (!boundedString(channel.network, CATALOG_LIMITS.maxMetadataLength, true)) return false
    if (!boundedString(channel.countryCode, 16) || !boundedString(channel.countryName, CATALOG_LIMITS.maxNameLength)) return false
    if (!boundedString(channel.flag, 32, true)) return false
    if (!stringArrayWithin(channel.categoryIds, CATALOG_LIMITS.maxCategoriesPerChannel, CATALOG_LIMITS.maxIdLength)) return false
    if (!stringArrayWithin(channel.categoryNames, CATALOG_LIMITS.maxCategoriesPerChannel, CATALOG_LIMITS.maxNameLength)) return false
    if (!boundedString(channel.logoUrl, 4_096, true) || (channel.logoUrl && normalizeRemoteHttpsUrl(channel.logoUrl) !== channel.logoUrl)) return false
    if (!boundedString(channel.website, 4_096, true) || (channel.website && normalizeRemoteHttpsUrl(channel.website) !== channel.website)) return false
    if (!boundedString(channel.searchText, CATALOG_LIMITS.maxSearchTextLength, true)) return false
    if (!Array.isArray(channel.sources) || channel.sources.length === 0 || channel.sources.length > CATALOG_LIMITS.maxSourcesPerChannel) return false
    for (const source of channel.sources) {
      if (!source || typeof source !== 'object') return false
      if (!boundedString(source.id, CATALOG_LIMITS.maxMetadataLength)) return false
      if (!boundedString(source.url, 4_096) || normalizeRemoteHlsUrl(source.url) !== source.url) return false
      if (!boundedString(source.title, CATALOG_LIMITS.maxNameLength, true)) return false
      if (!boundedString(source.quality, 64, true)) return false
      if (!boundedString(source.label, CATALOG_LIMITS.maxMetadataLength, true)) return false
      if (!boundedString(source.feed, CATALOG_LIMITS.maxMetadataLength, true)) return false
    }
  }

  for (const country of catalog.countries) {
    if (!country || typeof country !== 'object') return false
    if (!boundedString(country.code, 16) || !boundedString(country.name, CATALOG_LIMITS.maxNameLength)) return false
    if (!boundedString(country.flag, 32, true) || !nonNegativeInteger(country.count)) return false
  }
  for (const category of catalog.categories) {
    if (!category || typeof category !== 'object') return false
    if (!boundedString(category.id, CATALOG_LIMITS.maxIdLength) || !boundedString(category.name, CATALOG_LIMITS.maxNameLength)) return false
    if (!nonNegativeInteger(category.count)) return false
  }
  return true
}

function isValidStats(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const stats = value as Record<string, unknown>
  const requiredStatsAreValid = [
    'rawChannels',
    'rawStreams',
    'candidateStreams',
    'channels',
    'excludedUnknownChannel',
    'excludedUnsafeChannel',
    'excludedBlockedChannel',
    'excludedBrowserIncompatible'
  ].every((key) => nonNegativeInteger(stats[key]))
  return requiredStatsAreValid &&
    (stats.excludedFamilySafety === undefined || nonNegativeInteger(stats.excludedFamilySafety)) &&
    (stats.discardedUpstreamRecords === undefined || nonNegativeInteger(stats.discardedUpstreamRecords))
}

function boundedArray(value: unknown, label: string, maxLength: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}数据必须是数组`)
  if (value.length > maxLength) throw new Error(`${label}记录数超过安全上限 ${maxLength}`)
  return value
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string, maxLength: number): asserts value is string {
  if (!boundedString(value, maxLength)) throw new Error(`${label}必须是长度不超过 ${maxLength} 的非空字符串`)
}

function optionalString(value: unknown, label: string, maxLength: number): void {
  if (value === undefined || value === null) return
  if (!boundedString(value, maxLength, true)) throw new Error(`${label}必须是长度不超过 ${maxLength} 的字符串`)
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && value !== null && typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`)
}

function optionalStringArray(value: unknown, label: string, maxItems: number, maxItemLength: number): void {
  if (value === undefined || value === null) return
  if (!stringArrayWithin(value, maxItems, maxItemLength)) {
    throw new Error(`${label}必须是最多 ${maxItems} 个受限字符串组成的数组`)
  }
}

function stringArrayWithin(value: unknown, maxItems: number, maxItemLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => boundedString(item, maxItemLength, true))
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function nonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
