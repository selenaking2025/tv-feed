import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearCatalogCache, loadCatalog } from './catalog-service.ts'
import { fetchRemoteResource, validateRemoteResourceRequest } from './remote-resource-service.ts'

const APP_SCHEME = 'tvfeed'
const APP_HOST = 'app'
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const MAX_CONCURRENT_REMOTE_FETCHES = 8

if (process.env.TVFEED_SMOKE_OUTPUT && process.env.TVFEED_SMOKE_USER_DATA) {
  app.setPath('userData', process.env.TVFEED_SMOKE_USER_DATA)
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

let mainWindow: BrowserWindow | null = null
let smokeHandled = false
const remoteFetches = new Map<string, { controller: AbortController; senderId: number }>()

if (process.env.TVFEED_SMOKE_PLAY === '1') {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
}

app.whenReady().then(async () => {
  await registerAppProtocol()
  hardenSession()
  registerIpc()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || process.env.TVFEED_SMOKE_OUTPUT) app.quit()
})

function createMainWindow(): void {
  const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
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

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault()
  })
  const rendererId = mainWindow.webContents.id
  mainWindow.webContents.once('destroyed', () => abortRemoteFetches(rendererId))
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.TVFEED_SMOKE_OUTPUT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (smokeHandled || !mainWindow) return
        smokeHandled = true
        void runSmokeInspection(mainWindow.webContents)
      }, process.env.TVFEED_SMOKE_LIVE === '1' && process.env.TVFEED_SMOKE_FORCE_NETWORK_FAILURE !== '1' ? 90_000 : 2_500)
    })
    mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
      process.stderr.write(`TVFEED_DIAGNOSTIC load-failed ${code} ${sanitizeDiagnostic(description)} ${sanitizeDiagnostic(validatedUrl)}\n`)
    })
    mainWindow.webContents.on('preload-error', (_event, path, error) => {
      process.stderr.write(`TVFEED_DIAGNOSTIC preload-error ${sanitizeDiagnostic(path)} ${sanitizeDiagnostic(error.message)}\n`)
    })
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      abortRemoteFetches(rendererId)
      process.stderr.write(`TVFEED_DIAGNOSTIC renderer-gone ${details.reason} ${details.exitCode}\n`)
    })
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level >= 2) process.stderr.write(`TVFEED_DIAGNOSTIC console ${sanitizeDiagnostic(message)} ${sanitizeDiagnostic(sourceId)}:${line}\n`)
    })
  }

  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) {
    void mainWindow.loadURL(developmentUrl).catch(reportLoadError)
  } else {
    void mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/`).catch(reportLoadError)
  }
}

function reportLoadError(error: unknown): void {
  if (!process.env.TVFEED_SMOKE_OUTPUT) return
  process.stderr.write(`TVFEED_DIAGNOSTIC load-rejected ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`)
}

function sanitizeDiagnostic(value: string): string {
  return value.replace(/https:\/\/[^\s)]+/gi, '[remote URL]')
}

function registerIpc(): void {
  ipcMain.handle('catalog:load', (event, forceRefresh: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return loadCatalog(forceRefresh === true)
  })
  ipcMain.handle('catalog:clear-cache', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return clearCatalogCache()
  })
  ipcMain.handle('remote-resource:fetch', async (event, input: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    const request = validateRemoteResourceRequest(input)
    const senderId = event.sender.id
    if (countRemoteFetches(senderId) >= MAX_CONCURRENT_REMOTE_FETCHES) {
      throw new Error(`同时进行的远程资源请求不能超过 ${MAX_CONCURRENT_REMOTE_FETCHES} 个`)
    }
    const key = remoteFetchKey(senderId, request.requestId)
    if (remoteFetches.has(key)) throw new Error('远程资源请求 ID 已在使用')

    const controller = new AbortController()
    remoteFetches.set(key, { controller, senderId })
    try {
      return await fetchRemoteResource(request, controller.signal)
    } finally {
      remoteFetches.delete(key)
    }
  })
  ipcMain.on('remote-resource:cancel', (event, requestId: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(requestId)) return
    remoteFetches.get(remoteFetchKey(event.sender.id, requestId))?.controller.abort(new Error('远程资源请求已取消'))
  })
  ipcMain.handle('app:version', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return app.getVersion()
  })
  ipcMain.on('renderer:ready', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    if (process.env.TVFEED_SMOKE_OUTPUT && !smokeHandled) {
      smokeHandled = true
      void runSmokeInspection(event.sender)
    }
  })
}

function hardenSession(): void {
  const currentSession = session.defaultSession
  currentSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  currentSession.setPermissionCheckHandler(() => false)
  currentSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => callback(isAllowedDevelopmentRequest(details.url) ? {} : { cancel: true })
  )
}

function isAllowedDevelopmentRequest(url: string): boolean {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (!developmentUrl) return false
  try {
    return new URL(url).origin === new URL(developmentUrl).origin
  } catch {
    return false
  }
}

function countRemoteFetches(senderId: number): number {
  let count = 0
  for (const request of remoteFetches.values()) {
    if (request.senderId === senderId) count += 1
  }
  return count
}

function remoteFetchKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`
}

function abortRemoteFetches(senderId: number | undefined): void {
  if (senderId === undefined) return
  for (const [key, request] of remoteFetches) {
    if (request.senderId === senderId) {
      request.controller.abort(new Error('渲染进程已结束'))
      remoteFetches.delete(key)
    }
  }
}

async function registerAppProtocol(): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) return

  const rendererRoot = resolve(fileURLToPath(new URL('../renderer/', import.meta.url)))
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== APP_HOST) return new Response('Not found', { status: 404 })
      const requestPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      const absolutePath = resolve(rendererRoot, `.${requestPath}`)
      if (absolutePath !== rendererRoot && !absolutePath.startsWith(`${rendererRoot}${sep}`)) {
        return new Response('Forbidden', { status: 403 })
      }
      const body = await readFile(absolutePath)
      const headers: Record<string, string> = {
        'Content-Type': mimeTypeFor(absolutePath),
        'Cache-Control': absolutePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'
      }
      if (absolutePath.endsWith('index.html')) headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY
      return new Response(body, {
        headers
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function isTrustedRendererUrl(url: string): boolean {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) {
    try {
      return new URL(url).origin === new URL(developmentUrl).origin
    } catch {
      return false
    }
  }
  return url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)
}

function assertTrustedSender(url: string): void {
  if (!isTrustedRendererUrl(url)) throw new Error('拒绝来自未知页面的请求')
}

function mimeTypeFor(path: string): string {
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.woff2': 'font/woff2'
  }[extname(path).toLocaleLowerCase()] ?? 'application/octet-stream'
}

async function runSmokeInspection(webContents: Electron.WebContents): Promise<void> {
  const outputPath = process.env.TVFEED_SMOKE_OUTPUT
  if (!outputPath) return

  try {
    const playbackCheck = await runPlaybackCheck(webContents)
    const directExternalFetchBlocked: unknown = await webContents.executeJavaScript(
      `fetch('https://127.0.0.1/tv-feed-security-smoke').then(() => false, () => true)`
    )
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350))
    const image = await webContents.capturePage()
    const domResult: unknown = await webContents.executeJavaScript(`(() => {
      const app = document.querySelector('[data-app-ready="true"]')
      const rows = document.querySelectorAll('[data-channel-row]')
      const visibleChannelNames = [...document.querySelectorAll('.channel-name')]
        .filter((element) => element.getBoundingClientRect().width > 30 && element.textContent?.trim()).length
      const video = document.querySelector('video')
      const selected = document.querySelector('[data-channel-selected="true"]')
      const layout = document.querySelector('.workspace')
      const search = document.querySelector('#channel-search')
      const countrySelect = document.querySelector('#country-filter')
      const countryOptions = countrySelect instanceof HTMLSelectElement
        ? [...countrySelect.options].slice(0, 6).map((option) => ({ value: option.value, label: option.textContent ?? '' }))
        : []
      const sourceButtons = document.querySelectorAll('[data-source-button]')
      const favorite = document.querySelector('#favorite-channel')
      const storageBeforeInteraction = {
        favorites: localStorage.getItem('tvfeed:favorites:v1'),
        recents: localStorage.getItem('tvfeed:recents:v1'),
        remoteLogos: localStorage.getItem('tvfeed:remote-logos:v1')
      }
      const remoteLogoToggle = document.querySelector('#remote-logo-toggle')
      const favoriteBefore = favorite?.getAttribute('aria-pressed')
      favorite?.click()
      const favoriteToggleWorks = Boolean(favoriteBefore && favorite?.getAttribute('aria-pressed') !== favoriteBefore)
      favorite?.click()
      const originalSearch = search instanceof HTMLInputElement ? search.value : ''
      if (search instanceof HTMLInputElement) {
        search.value = '中国'
        search.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const chinaSearchResult = document.querySelector('#result-count')?.textContent ?? ''
      const chinaSearchWorks = !chinaSearchResult.startsWith('0 ')
      if (search instanceof HTMLInputElement) {
        search.value = '__tvfeed_smoke_no_match__'
        search.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const searchFilterWorks = Boolean(document.querySelector('.empty-list'))
      if (search instanceof HTMLInputElement) {
        search.value = originalSearch
        search.dispatchEvent(new Event('input', { bubbles: true }))
      }
      document.querySelectorAll('.toast').forEach((toast) => toast.remove())
      return {
        href: location.href,
        readyState: document.readyState,
        title: document.title,
        ready: Boolean(app),
        bodyText: document.body?.innerText.slice(0, 160) ?? '',
        scripts: [...document.scripts].map((script) => script.src),
        catalogState: document.querySelector('#catalog-state')?.textContent ?? '',
        resultCount: document.querySelector('#result-count')?.textContent ?? '',
        rows: rows.length,
        visibleChannelNames,
        hasVideo: video instanceof HTMLVideoElement,
        selectedChannel: selected?.getAttribute('data-channel-id') ?? document.querySelector('#channel-title')?.textContent ?? '',
        sourceButtons: sourceButtons.length,
        storageBeforeInteraction,
        remoteLogoChecked: remoteLogoToggle instanceof HTMLInputElement ? remoteLogoToggle.checked : null,
        noAutoplay: video instanceof HTMLVideoElement ? video.paused && !video.currentSrc : false,
        countryOptions,
        chinaSearchResult,
        chinaSearchWorks,
        favoriteToggleWorks,
        searchFilterWorks,
        gridColumns: layout ? getComputedStyle(layout).gridTemplateColumns : '',
        searchLabel: search?.getAttribute('aria-label') ?? '',
        bridge: typeof window.tvFeed?.loadCatalog === 'function',
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
      }
    })()`)
    const result = {
      ...(domResult && typeof domResult === 'object' ? domResult : {}),
      playbackCheck,
      directExternalFetchBlocked: directExternalFetchBlocked === true,
      packaged: app.isPackaged,
      appName: app.getName(),
      appVersion: app.getVersion(),
      executableName: process.execPath.split(/[\\/]/).at(-1) ?? ''
    }
    await writeFile(outputPath, image.toPNG())
    const payload = { ok: true, screenshot: outputPath, result }
    process.stdout.write(`TVFEED_SMOKE_RESULT ${JSON.stringify(payload)}\n`)
  } catch (error) {
    const payload = { ok: false, error: error instanceof Error ? error.message : String(error) }
    process.stderr.write(`TVFEED_SMOKE_RESULT ${JSON.stringify(payload)}\n`)
    process.exitCode = 1
  } finally {
    setTimeout(() => app.quit(), 100)
  }
}

async function runPlaybackCheck(webContents: Electron.WebContents): Promise<Record<string, unknown>> {
  if (process.env.TVFEED_SMOKE_PLAY !== '1') return { attempted: false }

  await webContents.executeJavaScript(`document.querySelector('#toggle-play')?.click()`)
  let state: Record<string, unknown> = { attempted: true, passed: false }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    const snapshot: unknown = await webContents.executeJavaScript(`(() => {
      const video = document.querySelector('video')
      if (!(video instanceof HTMLVideoElement)) return { readyState: -1, paused: true, width: 0, height: 0 }
      return {
        readyState: video.readyState,
        paused: video.paused,
        width: video.videoWidth,
        height: video.videoHeight,
        currentProtocol: video.currentSrc ? new URL(video.currentSrc).protocol : '',
        status: document.querySelector('#player-status-text')?.textContent ?? ''
      }
    })()`)
    state = { attempted: true, ...(snapshot && typeof snapshot === 'object' ? snapshot : {}) }
    const readyState = Number(state.readyState ?? -1)
    const width = Number(state.width ?? 0)
    if (readyState >= 2 && state.paused === false && width > 0) return { ...state, passed: true }
  }

  return { ...state, passed: false }
}
