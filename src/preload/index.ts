import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CatalogLoadCommand, CatalogSyncProgress } from '../shared/catalog-contracts.ts'
import { IPC_CHANNELS, type TvFeedBridge } from '../shared/ipc-contract.ts'
import type { RemoteResourceRequest } from '../shared/remote-resource-contracts.ts'
import type { LegacySafetyPreferences } from '../shared/safety-contracts.ts'
import type { PlaybackStartCommand } from '../shared/playback-contracts.ts'

const bridge: TvFeedBridge = Object.freeze({
  platform: process.platform,
  initializeSafetyState: (preferences: LegacySafetyPreferences) => ipcRenderer.invoke(IPC_CHANNELS.safetyInitialize, preferences),
  setFamilySafety: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.safetySetFamily, enabled),
  setRemoteLogos: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.safetySetRemoteLogos, enabled),
  acknowledgeSafetyCleanup: (transitionId: string) => ipcRenderer.invoke(IPC_CHANNELS.safetyAcknowledgeCleanup, transitionId),
  loadCatalog: (command: CatalogLoadCommand = { intent: 'startup' }) => ipcRenderer.invoke(IPC_CHANNELS.catalogLoad, command),
  loadOfflineDemo: () => ipcRenderer.invoke(IPC_CHANNELS.catalogOfflineDemo),
  onCatalogSyncProgress: (callback: (progress: CatalogSyncProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: unknown): void => {
      if (isCatalogSyncProgress(progress)) callback(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.catalogProgress, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.catalogProgress, listener)
  },
  clearCatalogCache: () => ipcRenderer.invoke(IPC_CHANNELS.catalogClearCache),
  fetchRemoteResource: (request: RemoteResourceRequest) => ipcRenderer.invoke(IPC_CHANNELS.remoteFetch, request),
  prepareRemoteResourceStream: (request: RemoteResourceRequest) => ipcRenderer.invoke(IPC_CHANNELS.remotePrepareStream, request),
  cancelRemoteResource: (requestId: string) => ipcRenderer.send(IPC_CHANNELS.remoteCancel, requestId),
  startPlayback: (command: PlaybackStartCommand) => ipcRenderer.invoke(IPC_CHANNELS.playbackStart, command),
  endPlayback: (sessionId: string) => ipcRenderer.send(IPC_CHANNELS.playbackEnd, sessionId),
  isNetworkOnline: () => ipcRenderer.invoke(IPC_CHANNELS.networkStatus),
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appVersion),
  windowAction: (action: 'minimize' | 'close') => ipcRenderer.invoke(IPC_CHANNELS.appWindowAction, action),
  setPlayerFullscreen: (fullscreen: boolean) => ipcRenderer.invoke(IPC_CHANNELS.playerSetFullscreen, fullscreen),
  onPlayerFullscreenChange: (callback: (fullscreen: boolean) => void) => {
    const listener = (_event: IpcRendererEvent, fullscreen: unknown): void => {
      if (typeof fullscreen === 'boolean') callback(fullscreen)
    }
    ipcRenderer.on(IPC_CHANNELS.playerFullscreenChanged, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.playerFullscreenChanged, listener)
  },
  signalRendererReady: () => ipcRenderer.send(IPC_CHANNELS.rendererReady)
})

contextBridge.exposeInMainWorld('tvFeed', bridge)

function isCatalogSyncProgress(value: unknown): value is CatalogSyncProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<CatalogSyncProgress>
  return typeof candidate.operationId === 'string' &&
    /^[A-Za-z0-9:_-]{1,128}$/.test(candidate.operationId) &&
    (candidate.requestId === undefined ||
      (typeof candidate.requestId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(candidate.requestId))) &&
    typeof candidate.message === 'string' &&
    typeof candidate.stage === 'string' &&
    ['checking-cache', 'connecting', 'core-data', 'metadata', 'processing', 'writing-cache', 'verifying-cache']
      .includes(candidate.stage)
}
