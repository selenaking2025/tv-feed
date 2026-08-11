import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { APP_PROTOCOL, IPC_CHANNELS } from '../shared/ipc-contract.ts'
import {
  hardenSession,
  isTrustedRendererUrl,
  registerAppProtocol,
  registerPrivilegedScheme
} from './app-protocol.ts'
import { createCatalogService } from './catalog-service.ts'
import { registerIpcHandlers } from './register-ipc.ts'
import { RemoteResourceBroker } from './remote-resource-broker.ts'
import { readRuntimeConfig } from './runtime-config.ts'
import { SafetyCoordinator } from './safety-coordinator.ts'
import { FileSafetyStateStore } from './safety-state-store.ts'
import { configureSystemProxyResolver, destroySecureConnections } from './secure-network.ts'

const runtime = readRuntimeConfig()

if (runtime.smoke.enabled && runtime.smoke.userDataPath) {
  app.setPath('userData', runtime.smoke.userDataPath)
}
if (runtime.smoke.autoplay) app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
registerPrivilegedScheme()

let mainWindow: BrowserWindow | null = null
let remoteResources: RemoteResourceBroker | undefined
let smokeHandled = false

app.whenReady().then(async () => {
  const catalog = createCatalogService(app.getPath('userData'), app.getVersion(), runtime)
  let resources: RemoteResourceBroker | undefined
  const safety = new SafetyCoordinator({
    store: new FileSafetyStateStore(join(app.getPath('userData'), 'safety-state-v1.json')),
    invalidateCatalog: () => catalog.invalidateCache(),
    cancelRemoteLogos: () => resources?.cancelKind('logo')
  })
  resources = new RemoteResourceBroker({
    assertAllowed: (kind) => safety.assertRemoteResourceAllowed(kind),
    rendererUrl: runtime.rendererUrl
  })
  remoteResources = resources

  await registerAppProtocol(runtime, resources)
  configureSystemProxyResolver((url) => session.defaultSession.resolveProxy(url))
  resources.start()
  hardenSession(runtime)
  registerIpcHandlers({
    appVersion: app.getVersion(),
    runtime,
    catalog,
    safety,
    resources,
    onRendererReady: (webContents) => {
      if (!runtime.smoke.enabled || smokeHandled) return
      smokeHandled = true
      void runConfiguredSmokeInspection(webContents)
    }
  })
  createMainWindow(resources)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(resources)
  })
}).catch((error) => {
  process.stderr.write(`TVFEED_STARTUP_ERROR ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || runtime.smoke.enabled) app.quit()
})

app.on('before-quit', () => {
  remoteResources?.dispose()
  remoteResources = undefined
  destroySecureConnections()
})

function createMainWindow(resources: RemoteResourceBroker): void {
  const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
  mainWindow = new BrowserWindow({
    width: runtime.smoke.windowWidth,
    height: runtime.smoke.windowHeight,
    minWidth: 820,
    minHeight: 620,
    show: false,
    backgroundColor: '#090b10',
    title: 'TV Feed',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } }
      : {}),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })

  const createdWindow = mainWindow
  const rendererId = createdWindow.webContents.id
  createdWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  createdWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl, runtime)) event.preventDefault()
  })
  createdWindow.webContents.once('destroyed', () => resources.abortSender(rendererId))
  createdWindow.once('ready-to-show', () => createdWindow.show())
  createdWindow.on('enter-full-screen', () => {
    if (!createdWindow.isDestroyed()) createdWindow.webContents.send(IPC_CHANNELS.playerFullscreenChanged, true)
  })
  createdWindow.on('leave-full-screen', () => {
    if (!createdWindow.isDestroyed()) createdWindow.webContents.send(IPC_CHANNELS.playerFullscreenChanged, false)
  })
  createdWindow.on('closed', () => {
    if (mainWindow === createdWindow) mainWindow = null
  })

  if (runtime.smoke.enabled) attachSmokeDiagnostics(createdWindow, rendererId, resources)

  const target = runtime.rendererUrl || `${APP_PROTOCOL.scheme}://${APP_PROTOCOL.host}/`
  void createdWindow.loadURL(target).catch(reportLoadError)
}

function attachSmokeDiagnostics(window: BrowserWindow, rendererId: number, resources: RemoteResourceBroker): void {
  window.webContents.once('did-finish-load', () => {
    const delay = runtime.smoke.liveCatalog && !runtime.smoke.forceNetworkFailure ? 370_000 : 2_500
    setTimeout(() => {
      if (smokeHandled || window.isDestroyed()) return
      smokeHandled = true
      void runConfiguredSmokeInspection(window.webContents)
    }, delay)
  })
  window.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    process.stderr.write(`TVFEED_DIAGNOSTIC load-failed ${code} ${sanitizeDiagnostic(description)} ${sanitizeDiagnostic(validatedUrl)}\n`)
  })
  window.webContents.on('preload-error', (_event, path, error) => {
    process.stderr.write(`TVFEED_DIAGNOSTIC preload-error ${sanitizeDiagnostic(path)} ${sanitizeDiagnostic(error.message)}\n`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    resources.abortSender(rendererId)
    process.stderr.write(`TVFEED_DIAGNOSTIC renderer-gone ${details.reason} ${details.exitCode}\n`)
  })
  window.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') {
      process.stderr.write(
        `TVFEED_DIAGNOSTIC console ${sanitizeDiagnostic(details.message)} ${sanitizeDiagnostic(details.sourceId)}:${details.lineNumber}\n`
      )
    }
  })
}

function reportLoadError(error: unknown): void {
  if (!runtime.smoke.enabled) return
  process.stderr.write(`TVFEED_DIAGNOSTIC load-rejected ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`)
}

async function runConfiguredSmokeInspection(webContents: Electron.WebContents): Promise<void> {
  try {
    if (!runtime.smoke.driverPath) throw new Error('Electron 冒烟驱动路径缺失')
    const module: unknown = await import(/* @vite-ignore */ pathToFileURL(runtime.smoke.driverPath).href)
    if (!module || typeof module !== 'object' || !('runSmokeInspection' in module) ||
      typeof module.runSmokeInspection !== 'function') {
      throw new Error('Electron 冒烟驱动格式无效')
    }
    await module.runSmokeInspection(webContents, runtime)
  } catch (error) {
    const payload = { ok: false, error: error instanceof Error ? error.message : String(error) }
    process.stderr.write(`TVFEED_SMOKE_RESULT ${JSON.stringify(payload)}\n`)
    process.exitCode = 1
    setTimeout(() => app.quit(), 100)
  }
}

function sanitizeDiagnostic(value: string): string {
  return value.replace(/https:\/\/[^\s)]+/gi, '[remote URL]')
}
