import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { IPC_CHANNELS, parseCatalogLoadCommand, parseLegacySafetyPreferences } from '../shared/ipc-contract.ts'
import type { CatalogLoadResponse } from '../shared/catalog-contracts.ts'
import { assertTrustedSender } from './app-protocol.ts'
import type { CatalogCoordinator } from './catalog-coordinator.ts'
import { toCatalogLoadFailure } from './catalog-service.ts'
import type { RemoteResourceBroker } from './remote-resource-broker.ts'
import type { RuntimeConfig } from './runtime-config.ts'
import type { SafetyCoordinator } from './safety-coordinator.ts'

export interface RegisterIpcOptions {
  appVersion: string
  runtime: RuntimeConfig
  catalog: CatalogCoordinator
  safety: SafetyCoordinator
  resources: RemoteResourceBroker
  onRendererReady: (webContents: WebContents) => void
}

export function registerIpcHandlers(options: RegisterIpcOptions): void {
  const trust = (url: string): void => assertTrustedSender(url, options.runtime)

  ipcMain.handle(IPC_CHANNELS.safetyInitialize, async (event, input: unknown) => {
    trust(event.senderFrame?.url ?? '')
    return options.safety.initialize(parseLegacySafetyPreferences(input))
  })
  ipcMain.handle(IPC_CHANNELS.safetySetFamily, (event, enabled: unknown) => {
    trust(event.senderFrame?.url ?? '')
    if (typeof enabled !== 'boolean') throw new Error('家庭安全状态必须是布尔值')
    return options.safety.setFamilySafety(enabled)
  })
  ipcMain.handle(IPC_CHANNELS.safetySetRemoteLogos, (event, enabled: unknown) => {
    trust(event.senderFrame?.url ?? '')
    if (typeof enabled !== 'boolean') throw new Error('远程台标状态必须是布尔值')
    return options.safety.setRemoteLogos(enabled)
  })
  ipcMain.handle(IPC_CHANNELS.safetyAcknowledgeCleanup, (event, transitionId: unknown) => {
    trust(event.senderFrame?.url ?? '')
    if (typeof transitionId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(transitionId)) {
      throw new Error('家庭安全清理确认无效')
    }
    return options.safety.acknowledgeViewingDataClear(transitionId)
  })

  ipcMain.handle(IPC_CHANNELS.catalogLoad, async (event, input: unknown): Promise<CatalogLoadResponse> => {
    trust(event.senderFrame?.url ?? '')
    try {
      const scope = options.safety.catalogScope()
      const result = await options.catalog.load(
        parseCatalogLoadCommand(input),
        scope,
        (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.catalogProgress, progress)
        }
      )
      // Never return a standard projection after family mode became
      // authoritative while the asynchronous load was in flight.
      options.safety.assertCatalogScope(scope)
      return { ok: true, result }
    } catch (error) {
      return { ok: false, failure: toCatalogLoadFailure(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.catalogOfflineDemo, (event) => {
    trust(event.senderFrame?.url ?? '')
    return options.catalog.loadOfflineDemo(options.safety.catalogScope())
  })
  ipcMain.handle(IPC_CHANNELS.catalogClearCache, (event) => {
    trust(event.senderFrame?.url ?? '')
    options.safety.snapshot()
    return options.catalog.invalidateCache()
  })

  ipcMain.handle(IPC_CHANNELS.remoteFetch, (event, input: unknown) => {
    trust(event.senderFrame?.url ?? '')
    return options.resources.fetch(event.sender.id, input)
  })
  ipcMain.handle(IPC_CHANNELS.remotePrepareStream, (event, input: unknown) => {
    trust(event.senderFrame?.url ?? '')
    return options.resources.prepareStream(event.sender.id, input)
  })
  ipcMain.on(IPC_CHANNELS.remoteCancel, (event, requestId: unknown) => {
    trust(event.senderFrame?.url ?? '')
    options.resources.cancel(event.sender.id, requestId)
  })

  ipcMain.handle(IPC_CHANNELS.appVersion, (event) => {
    trust(event.senderFrame?.url ?? '')
    return options.appVersion
  })
  ipcMain.handle(IPC_CHANNELS.playerSetFullscreen, (event, fullscreen: unknown) => {
    trust(event.senderFrame?.url ?? '')
    if (typeof fullscreen !== 'boolean') throw new Error('全屏状态必须是布尔值')
    const browserWindow = BrowserWindow.fromWebContents(event.sender)
    if (!browserWindow || browserWindow.isDestroyed()) throw new Error('播放器窗口不可用')
    return setBrowserWindowFullscreen(browserWindow, fullscreen)
  })
  ipcMain.on(IPC_CHANNELS.rendererReady, (event) => {
    trust(event.senderFrame?.url ?? '')
    options.onRendererReady(event.sender)
  })
}

function setBrowserWindowFullscreen(browserWindow: BrowserWindow, fullscreen: boolean): Promise<boolean> {
  if (isBrowserWindowFullscreen(browserWindow) === fullscreen) return Promise.resolve(fullscreen)
  if (process.platform === 'darwin') {
    browserWindow.setSimpleFullScreen(fullscreen)
    const result = browserWindow.isSimpleFullScreen()
    browserWindow.webContents.send(IPC_CHANNELS.playerFullscreenChanged, result)
    return Promise.resolve(result)
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const removeTransitionListener = (): void => {
      if (fullscreen) browserWindow.removeListener('enter-full-screen', onTransition)
      else browserWindow.removeListener('leave-full-screen', onTransition)
    }
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      removeTransitionListener()
      browserWindow.removeListener('closed', onClosed)
      resolvePromise(result)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      removeTransitionListener()
      browserWindow.removeListener('closed', onClosed)
      rejectPromise(error)
    }
    const onTransition = (): void => finish(fullscreen)
    const onClosed = (): void => finish(false)
    const timeout = setTimeout(() => finish(isBrowserWindowFullscreen(browserWindow)), 5_000)
    if (fullscreen) browserWindow.once('enter-full-screen', onTransition)
    else browserWindow.once('leave-full-screen', onTransition)
    browserWindow.once('closed', onClosed)
    try {
      browserWindow.setFullScreen(fullscreen)
    } catch (error) {
      fail(error)
    }
  })
}

function isBrowserWindowFullscreen(browserWindow: BrowserWindow): boolean {
  return process.platform === 'darwin' ? browserWindow.isSimpleFullScreen() : browserWindow.isFullScreen()
}
