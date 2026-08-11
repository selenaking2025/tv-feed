import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CatalogSyncProgress, RemoteResourceRequest, TvFeedBridge } from '../shared/contracts.ts'

const bridge: TvFeedBridge = Object.freeze({
  platform: process.platform,
  loadCatalog: (forceRefresh = false, familySafety = false) => ipcRenderer.invoke('catalog:load', forceRefresh, familySafety),
  loadOfflineDemo: (familySafety = false) => ipcRenderer.invoke('catalog:offline-demo', familySafety),
  onCatalogSyncProgress: (callback: (progress: CatalogSyncProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: unknown): void => {
      if (
        progress &&
        typeof progress === 'object' &&
        'message' in progress &&
        typeof progress.message === 'string'
      ) callback(progress as CatalogSyncProgress)
    }
    ipcRenderer.on('catalog:progress', listener)
    return () => ipcRenderer.removeListener('catalog:progress', listener)
  },
  clearCatalogCache: () => ipcRenderer.invoke('catalog:clear-cache'),
  fetchRemoteResource: (request: RemoteResourceRequest) => ipcRenderer.invoke('remote-resource:fetch', request),
  cancelRemoteResource: (requestId: string) => ipcRenderer.send('remote-resource:cancel', requestId),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  setPlayerFullscreen: (fullscreen: boolean) => ipcRenderer.invoke('player-fullscreen:set', fullscreen),
  onPlayerFullscreenChange: (callback: (fullscreen: boolean) => void) => {
    const listener = (_event: IpcRendererEvent, fullscreen: unknown): void => {
      if (typeof fullscreen === 'boolean') callback(fullscreen)
    }
    ipcRenderer.on('player-fullscreen:changed', listener)
    return () => ipcRenderer.removeListener('player-fullscreen:changed', listener)
  },
  signalRendererReady: () => ipcRenderer.send('renderer:ready')
})

contextBridge.exposeInMainWorld('tvFeed', bridge)
