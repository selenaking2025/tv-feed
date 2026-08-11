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

export type CacheStatus = 'network' | 'fresh-cache' | 'stale-cache' | 'offline-sample'

export interface CatalogLoadResult {
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

export interface CatalogSyncProgress {
  stage: CatalogSyncStage
  message: string
  attempt?: number
  maxAttempts?: number
}

export type CatalogFailureCode =
  | 'proxy'
  | 'dns'
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

export type RemoteResourceKind = 'hls-playlist' | 'hls-json' | 'hls-binary' | 'logo'

export interface RemoteResourceRequest {
  requestId: string
  url: string
  kind: RemoteResourceKind
  rangeStart?: number
  rangeEnd?: number
}

export interface RemoteResourceResponse {
  body: Uint8Array
  contentType: string
  finalUrl: string
  statusCode: number
  connectionReused?: boolean
}

export interface RemoteResourceStreamTicket {
  streamUrl: string
}

export interface TvFeedBridge {
  platform: NodeJS.Platform
  loadCatalog(forceRefresh?: boolean, familySafety?: boolean): Promise<CatalogLoadResponse>
  loadOfflineDemo(familySafety?: boolean): Promise<CatalogLoadResult>
  onCatalogSyncProgress(listener: (progress: CatalogSyncProgress) => void): () => void
  clearCatalogCache(): Promise<boolean>
  fetchRemoteResource(request: RemoteResourceRequest): Promise<RemoteResourceResponse>
  prepareRemoteResourceStream(request: RemoteResourceRequest): Promise<RemoteResourceStreamTicket>
  cancelRemoteResource(requestId: string): void
  getAppVersion(): Promise<string>
  setPlayerFullscreen(fullscreen: boolean): Promise<boolean>
  onPlayerFullscreenChange(listener: (fullscreen: boolean) => void): () => void
  signalRendererReady(): void
}
