import type {
  CatalogLoadCommand,
  CatalogLoadResponse,
  CatalogLoadResult,
  CatalogSyncProgress
} from './catalog-contracts.ts'
import type {
  RemoteResourceFetchResult,
  RemoteResourceRequest,
  RemoteResourceStreamTicket
} from './remote-resource-contracts.ts'
import type {
  LegacySafetyPreferences,
  SafetyStateSnapshot,
  SafetyTransitionResult
} from './safety-contracts.ts'
import type { PlaybackSession, PlaybackStartCommand } from './playback-contracts.ts'

export const APP_PROTOCOL = Object.freeze({
  scheme: 'tvfeed',
  host: 'app',
  remoteStreamPathPrefix: '/__hls_stream/'
})

export const IPC_CHANNELS = Object.freeze({
  catalogLoad: 'catalog:load',
  catalogOfflineDemo: 'catalog:offline-demo',
  catalogProgress: 'catalog:progress',
  catalogClearCache: 'catalog:clear-cache',
  safetyInitialize: 'safety:initialize',
  safetySetFamily: 'safety:set-family',
  safetySetRemoteLogos: 'safety:set-remote-logos',
  safetyAcknowledgeCleanup: 'safety:acknowledge-cleanup',
  remoteFetch: 'remote-resource:fetch',
  remotePrepareStream: 'remote-resource:prepare-stream',
  remoteCancel: 'remote-resource:cancel',
  playbackStart: 'playback:start',
  playbackEnd: 'playback:end',
  networkStatus: 'network:status',
  appVersion: 'app:version',
  playerSetFullscreen: 'player-fullscreen:set',
  playerFullscreenChanged: 'player-fullscreen:changed',
  rendererReady: 'renderer:ready'
})

export interface TvFeedBridge {
  platform: NodeJS.Platform
  initializeSafetyState(preferences: LegacySafetyPreferences): Promise<SafetyStateSnapshot>
  setFamilySafety(enabled: boolean): Promise<SafetyTransitionResult>
  setRemoteLogos(enabled: boolean): Promise<SafetyStateSnapshot>
  acknowledgeSafetyCleanup(transitionId: string): Promise<SafetyStateSnapshot>
  loadCatalog(command?: CatalogLoadCommand): Promise<CatalogLoadResponse>
  loadOfflineDemo(): Promise<CatalogLoadResult>
  onCatalogSyncProgress(listener: (progress: CatalogSyncProgress) => void): () => void
  clearCatalogCache(): Promise<boolean>
  fetchRemoteResource(request: RemoteResourceRequest): Promise<RemoteResourceFetchResult>
  prepareRemoteResourceStream(request: RemoteResourceRequest): Promise<RemoteResourceStreamTicket>
  cancelRemoteResource(requestId: string): void
  startPlayback(command: PlaybackStartCommand): Promise<PlaybackSession>
  endPlayback(sessionId: string): void
  isNetworkOnline(): Promise<boolean>
  getAppVersion(): Promise<string>
  setPlayerFullscreen(fullscreen: boolean): Promise<boolean>
  onPlayerFullscreenChange(listener: (fullscreen: boolean) => void): () => void
  signalRendererReady(): void
}

export function parseCatalogLoadCommand(value: unknown): CatalogLoadCommand {
  if (value === undefined) return { intent: 'startup' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('目录加载命令格式无效')
  const intent = (value as Record<string, unknown>).intent
  if (intent !== 'startup' && intent !== 'refresh') throw new Error('目录加载意图无效')
  const requestId = (value as Record<string, unknown>).requestId
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(requestId))) {
    throw new Error('目录请求标识无效')
  }
  return { intent, ...(typeof requestId === 'string' ? { requestId } : {}) }
}

export function parseLegacySafetyPreferences(value: unknown): LegacySafetyPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { familySafety: false, remoteLogos: false }
  }
  const candidate = value as Record<string, unknown>
  const familySafety = candidate.familySafety === true
  return {
    familySafety,
    remoteLogos: !familySafety && candidate.remoteLogos === true
  }
}
