export interface UpstreamChannel {
  id: string
  name: string
  alt_names?: string[]
  network?: string | null
  country: string
  categories?: string[]
  is_nsfw?: boolean
  closed?: string | null
  website?: string | null
}

export interface UpstreamStream {
  channel?: string | null
  feed?: string | null
  title?: string | null
  url: string
  referrer?: string | null
  user_agent?: string | null
  quality?: string | null
  label?: string | null
}

export interface UpstreamCountry {
  name: string
  code: string
  flag?: string
}

export interface UpstreamCategory {
  id: string
  name: string
  description?: string
}

export interface UpstreamLogo {
  channel?: string | null
  in_use?: boolean
  tags?: string[]
  url?: string | null
}

export interface UpstreamBlocklistEntry {
  channel: string
  reason: 'dmca' | 'nsfw' | string
  ref?: string
}

export interface UpstreamBundle {
  channels: UpstreamChannel[]
  streams: UpstreamStream[]
  countries: UpstreamCountry[]
  categories: UpstreamCategory[]
  logos: UpstreamLogo[]
  blocklist: UpstreamBlocklistEntry[]
}

export interface CatalogSource {
  id: string
  url: string
  title: string
  quality: string
  label: string
  feed: string
}

export interface CatalogChannel {
  id: string
  name: string
  altNames: string[]
  network: string
  countryCode: string
  countryName: string
  flag: string
  categoryIds: string[]
  categoryNames: string[]
  logoUrl: string
  website: string
  searchText: string
  sources: CatalogSource[]
}

export interface CatalogCountry {
  code: string
  name: string
  flag: string
  count: number
}

export interface CatalogCategory {
  id: string
  name: string
  count: number
}

export interface CatalogStats {
  rawChannels: number
  rawStreams: number
  candidateStreams: number
  channels: number
  excludedUnknownChannel: number
  excludedUnsafeChannel: number
  excludedBlockedChannel: number
  excludedBrowserIncompatible: number
}

export interface Catalog {
  version: 1
  generatedAt: string
  source: 'iptv-org' | 'offline-sample'
  channels: CatalogChannel[]
  countries: CatalogCountry[]
  categories: CatalogCategory[]
  stats: CatalogStats
}

export type CacheStatus = 'network' | 'fresh-cache' | 'stale-cache' | 'offline-sample'

export interface CatalogLoadResult {
  catalog: Catalog
  cacheStatus: CacheStatus
  warning: string
}

export interface TvFeedBridge {
  platform: NodeJS.Platform
  loadCatalog(forceRefresh?: boolean): Promise<CatalogLoadResult>
  clearCatalogCache(): Promise<boolean>
  getAppVersion(): Promise<string>
  signalRendererReady(): void
}
