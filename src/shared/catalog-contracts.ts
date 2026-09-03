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
  excludedFamilySafety?: number
  discardedUpstreamRecords?: number
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

export type CatalogScope = 'standard' | 'family'
export type CatalogLoadIntent = 'startup' | 'refresh'

export interface CatalogLoadCommand {
  intent: CatalogLoadIntent
}

export type CacheStatus = 'network' | 'fresh-cache' | 'stale-cache' | 'legacy-cache' | 'offline-sample'

export interface CatalogLoadResult {
  operationId: string
  catalog: Catalog
  cacheStatus: CacheStatus
  warning: string
}

export type CatalogSyncStage =
  | 'checking-cache'
  | 'connecting'
  | 'core-data'
  | 'metadata'
  | 'processing'
  | 'writing-cache'
  | 'verifying-cache'

export interface CatalogSyncProgressUpdate {
  stage: CatalogSyncStage
  message: string
  attempt?: number
  maxAttempts?: number
}

export interface CatalogSyncProgress extends CatalogSyncProgressUpdate {
  operationId: string
}

export type CatalogFailureCode =
  | 'proxy'
  | 'dns'
  | 'fake-ip-dns'
  | 'timeout'
  | 'http'
  | 'security'
  | 'safety-data'
  | 'invalid-data'
  | 'cache-write'
  | 'network'
  | 'unknown'

export interface CatalogLoadFailure {
  code: CatalogFailureCode
  title: string
  message: string
  detail: string
  retryable: boolean
}

export type CatalogLoadResponse =
  | { ok: true; result: CatalogLoadResult }
  | { ok: false; failure: CatalogLoadFailure }
