import { contextBridge, ipcRenderer } from 'electron'
import type { RemoteResourceRequest, TvFeedBridge } from '../shared/contracts.ts'

const bridge: TvFeedBridge = Object.freeze({
  platform: process.platform,
  loadCatalog: (forceRefresh = false) => ipcRenderer.invoke('catalog:load', forceRefresh),
  clearCatalogCache: () => ipcRenderer.invoke('catalog:clear-cache'),
  fetchRemoteResource: (request: RemoteResourceRequest) => ipcRenderer.invoke('remote-resource:fetch', request),
  cancelRemoteResource: (requestId: string) => ipcRenderer.send('remote-resource:cancel', requestId),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  signalRendererReady: () => ipcRenderer.send('renderer:ready')
})

contextBridge.exposeInMainWorld('tvFeed', bridge)
