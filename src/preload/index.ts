import { contextBridge, ipcRenderer } from 'electron'
import type { TvFeedBridge } from '../shared/contracts.ts'

const bridge: TvFeedBridge = Object.freeze({
  platform: process.platform,
  loadCatalog: (forceRefresh = false) => ipcRenderer.invoke('catalog:load', forceRefresh),
  clearCatalogCache: () => ipcRenderer.invoke('catalog:clear-cache'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  signalRendererReady: () => ipcRenderer.send('renderer:ready')
})

contextBridge.exposeInMainWorld('tvFeed', bridge)
