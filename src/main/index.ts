import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearCatalogCache, loadCatalog, loadOfflineDemo, toCatalogLoadFailure } from './catalog-service.ts'
import { fetchRemoteResource, validateRemoteResourceRequest } from './remote-resource-service.ts'
import { configureSystemProxyResolver } from './secure-network.ts'

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
  configureSystemProxyResolver((url) => session.defaultSession.resolveProxy(url))
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
  const windowWidth = smokeWindowDimension('TVFEED_SMOKE_WIDTH', 1440, 820, 2400)
  const windowHeight = smokeWindowDimension('TVFEED_SMOKE_HEIGHT', 900, 620, 1600)
  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
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
  const createdWindow = mainWindow
  mainWindow.on('enter-full-screen', () => {
    if (!createdWindow.isDestroyed()) createdWindow.webContents.send('player-fullscreen:changed', true)
  })
  mainWindow.on('leave-full-screen', () => {
    if (!createdWindow.isDestroyed()) createdWindow.webContents.send('player-fullscreen:changed', false)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.TVFEED_SMOKE_OUTPUT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (smokeHandled || !mainWindow) return
        smokeHandled = true
        void runSmokeInspection(mainWindow.webContents)
      }, process.env.TVFEED_SMOKE_LIVE === '1' && process.env.TVFEED_SMOKE_FORCE_NETWORK_FAILURE !== '1' ? 370_000 : 2_500)
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

function smokeWindowDimension(name: string, fallback: number, minimum: number, maximum: number): number {
  if (!process.env.TVFEED_SMOKE_OUTPUT) return fallback
  const value = Number(process.env[name])
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback
}

function reportLoadError(error: unknown): void {
  if (!process.env.TVFEED_SMOKE_OUTPUT) return
  process.stderr.write(`TVFEED_DIAGNOSTIC load-rejected ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`)
}

function sanitizeDiagnostic(value: string): string {
  return value.replace(/https:\/\/[^\s)]+/gi, '[remote URL]')
}

function registerIpc(): void {
  ipcMain.handle('catalog:load', async (event, forceRefresh: unknown, familySafety: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    try {
      const result = await loadCatalog(forceRefresh === true, familySafety === true, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('catalog:progress', progress)
      })
      return { ok: true, result }
    } catch (error) {
      return { ok: false, failure: toCatalogLoadFailure(error) }
    }
  })
  ipcMain.handle('catalog:offline-demo', (event, familySafety: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    return loadOfflineDemo(familySafety === true)
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
  ipcMain.handle('player-fullscreen:set', (event, fullscreen: unknown) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    if (typeof fullscreen !== 'boolean') throw new Error('全屏状态必须是布尔值')
    const browserWindow = BrowserWindow.fromWebContents(event.sender)
    if (!browserWindow || browserWindow.isDestroyed()) throw new Error('播放器窗口不可用')
    return setBrowserWindowFullscreen(browserWindow, fullscreen)
  })
  ipcMain.on('renderer:ready', (event) => {
    assertTrustedSender(event.senderFrame?.url ?? '')
    if (process.env.TVFEED_SMOKE_OUTPUT && !smokeHandled) {
      smokeHandled = true
      void runSmokeInspection(event.sender)
    }
  })
}

function setBrowserWindowFullscreen(browserWindow: BrowserWindow, fullscreen: boolean): Promise<boolean> {
  if (isBrowserWindowFullscreen(browserWindow) === fullscreen) return Promise.resolve(fullscreen)
  if (process.platform === 'darwin') {
    browserWindow.setSimpleFullScreen(fullscreen)
    const result = browserWindow.isSimpleFullScreen()
    browserWindow.webContents.send('player-fullscreen:changed', result)
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
    const familySafetyCheck = await runFamilySafetyCheck(webContents)
    const playbackDiagnosticCheck = await runPlaybackDiagnosticCheck(webContents)
    const directExternalFetchBlocked: unknown = await webContents.executeJavaScript(
      `fetch('https://127.0.0.1/tv-feed-security-smoke').then(() => false, () => true)`
    )
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350))
    const domResult: unknown = await webContents.executeJavaScript(`(async () => {
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
      const resultCount = document.querySelector('#result-count')
      const channelHealth = document.querySelector('#channel-health')
      const playerStatus = document.querySelector('#player-status-overlay')
      const announcementRegion = document.querySelector('#announcement-region')
      const shortcutText = document.querySelector('.shortcut-strip')?.textContent ?? ''
      const favorite = document.querySelector('#favorite-channel')
      const storageBeforeInteraction = {
        favorites: localStorage.getItem('tvfeed:favorites:v1'),
        recents: localStorage.getItem('tvfeed:recents:v1'),
        remoteLogos: localStorage.getItem('tvfeed:remote-logos:v1')
      }
      const remoteLogoToggle = document.querySelector('#remote-logo-toggle')
      const familySafetyToggle = document.querySelector('#family-safety-toggle')
      const infoDialog = document.querySelector('#info-dialog')
      const modalOpen = infoDialog instanceof HTMLDialogElement && infoDialog.open
      const catalogFailure = document.querySelector('#catalog-failure')
      const retryCatalog = document.querySelector('#retry-catalog')
      const diagnosticsToggle = document.querySelector('#toggle-catalog-diagnostics')
      const offlineDemo = document.querySelector('#open-offline-demo')
      const diagnostics = document.querySelector('#catalog-diagnostics')
      const catalogFailureVisible = catalogFailure instanceof HTMLElement && !catalogFailure.hidden
      if (catalogFailureVisible && diagnosticsToggle instanceof HTMLButtonElement) diagnosticsToggle.click()
      const diagnosticsVisible = diagnostics instanceof HTMLElement && !diagnostics.hidden && Boolean(diagnostics.textContent?.trim())
      const playerStage = document.querySelector('#player-stage')
      const playerSurface = document.querySelector('#player-surface')
      const playerControls = document.querySelector('.player-controls')
      const sidebarClose = document.querySelector('#sidebar-close')
      const sidebarToggle = document.querySelector('#sidebar-toggle')
      const channelPane = document.querySelector('#channel-pane')
      const stageRect = playerStage?.getBoundingClientRect()
      const controlsRect = playerControls?.getBoundingClientRect()
      const controlsBelowPlayer = Boolean(
        playerSurface &&
        playerControls?.parentElement === playerSurface &&
        stageRect &&
        controlsRect &&
        controlsRect.top >= stageRect.bottom &&
        getComputedStyle(playerControls).position !== 'absolute'
      )
      let sidebarCollapseWorks = false
      let sidebarRestoreWorks = false
      let playerExpansion = 0
      if (
        app instanceof HTMLElement &&
        playerStage instanceof HTMLElement &&
        sidebarClose instanceof HTMLButtonElement &&
        sidebarToggle instanceof HTMLButtonElement &&
        channelPane instanceof HTMLElement &&
        matchMedia('(min-width: 1041px)').matches
      ) {
        const initialPlayerWidth = playerStage.getBoundingClientRect().width
        sidebarClose.click()
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const collapsedPlayerWidth = playerStage.getBoundingClientRect().width
        playerExpansion = Math.round(collapsedPlayerWidth - initialPlayerWidth)
        sidebarCollapseWorks =
          app.classList.contains('sidebar-collapsed') &&
          getComputedStyle(channelPane).display === 'none' &&
          getComputedStyle(sidebarToggle).display !== 'none' &&
          sidebarToggle.getAttribute('aria-expanded') === 'false' &&
          channelPane.inert &&
          playerExpansion > 100
        sidebarToggle.click()
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        sidebarRestoreWorks =
          !app.classList.contains('sidebar-collapsed') &&
          getComputedStyle(channelPane).display !== 'none' &&
          sidebarToggle.getAttribute('aria-expanded') === 'true' &&
          !channelPane.inert
      }
      const focusOutlineVisible = [...document.styleSheets].some((sheet) =>
        [...sheet.cssRules].some((rule) => rule instanceof CSSStyleRule &&
          rule.selectorText.includes(':focus-visible') &&
          rule.style.outlineStyle !== 'none' &&
          parseFloat(rule.style.outlineWidth) >= 2)
      )
      const mutedBefore = video instanceof HTMLVideoElement ? video.muted : null
      const volumeBefore = video instanceof HTMLVideoElement ? video.volume : null
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))
      const muteChanged = video instanceof HTMLVideoElement && mutedBefore !== null && video.muted !== mutedBefore
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }))
      const volumeChanged = video instanceof HTMLVideoElement && volumeBefore !== null && video.volume < volumeBefore
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))
      const muteShortcutWorks = !modalOpen && muteChanged
      const volumeShortcutWorks = !modalOpen && volumeChanged
      const modalShortcutIsolationWorks = modalOpen && !muteChanged && !volumeChanged
      await new Promise((resolve) => setTimeout(resolve, 40))
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
      let officialSourceMarkingCheck = { attempted: false, passed: false, badges: 0 }
      if (${JSON.stringify(process.env.TVFEED_SMOKE_LIVE === '1')}) {
        if (search instanceof HTMLInputElement) {
          search.value = 'CGTN'
          search.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const badges = document.querySelectorAll('.official-source-badge').length
        officialSourceMarkingCheck = { attempted: true, passed: badges > 0, badges }
      }
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
        catalogSource: app instanceof HTMLElement ? app.dataset.catalogSource ?? '' : '',
        catalogCount: app instanceof HTMLElement ? Number(app.dataset.catalogCount ?? 0) : 0,
        catalogFailureVisible,
        catalogFailureCode: catalogFailure instanceof HTMLElement ? catalogFailure.dataset.errorCode ?? '' : '',
        retryCatalogVisible: retryCatalog instanceof HTMLButtonElement && !retryCatalog.hidden && !retryCatalog.disabled,
        offlineDemoVisible: offlineDemo instanceof HTMLButtonElement && !offlineDemo.hidden && !offlineDemo.disabled,
        diagnosticsVisible,
        sampleNamesPresent: /TV Feed 综合样例|Demo News Japan|Demo Nature US/.test(document.body?.innerText ?? ''),
        rows: rows.length,
        visibleChannelNames,
        hasVideo: video instanceof HTMLVideoElement,
        selectedChannel: selected?.getAttribute('data-channel-id') ?? document.querySelector('#channel-title')?.textContent ?? '',
        sourceButtons: sourceButtons.length,
        sourceTitlesHideUrls: [...sourceButtons].every((button) => !(button.getAttribute('title') ?? '').includes('://')),
        officialBadges: document.querySelectorAll('.official-source-badge').length,
        storageBeforeInteraction,
        remoteLogoChecked: remoteLogoToggle instanceof HTMLInputElement ? remoteLogoToggle.checked : null,
        remoteLogoDisabled: remoteLogoToggle instanceof HTMLInputElement ? remoteLogoToggle.disabled : null,
        familySafetyChecked: familySafetyToggle instanceof HTMLInputElement ? familySafetyToggle.checked : null,
        familySafetyBadge: document.querySelector('#safety-badge-label')?.textContent ?? '',
        noAutoplay: video instanceof HTMLVideoElement ? video.paused && !video.currentSrc : false,
        countryOptions,
        chinaSearchResult,
        chinaSearchWorks,
        favoriteToggleWorks,
        searchFilterWorks,
        officialSourceMarkingCheck,
        gridColumns: layout ? getComputedStyle(layout).gridTemplateColumns : '',
        controlsBelowPlayer,
        sidebarCollapseWorks,
        sidebarRestoreWorks,
        playerExpansion,
        searchLabel: search?.getAttribute('aria-label') ?? '',
        resultCountAnnounced: resultCount?.getAttribute('role') === 'status' && resultCount?.getAttribute('aria-live') === 'polite',
        channelHealthAnnounced: channelHealth?.getAttribute('role') === 'status' && channelHealth?.getAttribute('aria-live') === 'polite',
        playerStatusAnnounced: playerStatus?.getAttribute('role') === 'status' && playerStatus?.getAttribute('aria-live') === 'polite',
        announcementRegionReady: announcementRegion?.getAttribute('role') === 'status' && announcementRegion?.getAttribute('aria-live') === 'polite',
        keyboardHintsComplete: shortcutText.includes('数字选台') && shortcutText.includes('静音') && shortcutText.includes('音量'),
        focusOutlineVisible,
        modalOpen,
        muteShortcutWorks,
        volumeShortcutWorks,
        modalShortcutIsolationWorks,
        bridge: typeof window.tvFeed?.loadCatalog === 'function' && typeof window.tvFeed?.loadOfflineDemo === 'function',
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
      }
    })()`)
    const offlineDemoTransitionCheck = await runOfflineDemoTransitionCheck(webContents)
    const fullscreenCheck = await runFullscreenCheck(webContents)
    await webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    const image = await webContents.capturePage()
    const result = {
      ...(domResult && typeof domResult === 'object' ? domResult : {}),
      playbackCheck,
      familySafetyCheck,
      playbackDiagnosticCheck,
      offlineDemoTransitionCheck,
      fullscreenCheck,
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

async function runOfflineDemoTransitionCheck(webContents: Electron.WebContents): Promise<Record<string, unknown>> {
  if (process.env.TVFEED_SMOKE_OPEN_OFFLINE_DEMO !== '1') return { attempted: false }
  const before: unknown = await webContents.executeJavaScript(`(() => ({
    failureVisible: document.querySelector('#catalog-failure') instanceof HTMLElement && !document.querySelector('#catalog-failure').hidden,
    source: document.querySelector('#app-shell')?.dataset.catalogSource ?? '',
    rows: document.querySelectorAll('[data-channel-row]').length
  }))()`)
  const clicked = await webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#open-offline-demo')
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false
    button.click()
    return true
  })()`)
  let after: Record<string, unknown> = {}
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    const snapshot: unknown = await webContents.executeJavaScript(`(() => ({
      source: document.querySelector('#app-shell')?.dataset.catalogSource ?? '',
      state: document.querySelector('#catalog-state')?.textContent ?? '',
      rows: document.querySelectorAll('[data-channel-row]').length,
      failureVisible: document.querySelector('#catalog-failure') instanceof HTMLElement && !document.querySelector('#catalog-failure').hidden
    }))()`)
    after = snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : {}
    if (after.source === 'offline-sample' && Number(after.rows) >= 8) break
  }
  const beforeState = before && typeof before === 'object' ? before as Record<string, unknown> : {}
  return {
    attempted: true,
    clicked: clicked === true,
    before: beforeState,
    after,
    passed:
      beforeState.failureVisible === true &&
      beforeState.source === '' &&
      Number(beforeState.rows) === 0 &&
      clicked === true &&
      after.source === 'offline-sample' &&
      String(after.state ?? '').startsWith('离线样例') &&
      Number(after.rows) >= 8 &&
      after.failureVisible === false
  }
}

async function runFullscreenCheck(webContents: Electron.WebContents): Promise<Record<string, unknown>> {
  const browserWindow = BrowserWindow.fromWebContents(webContents)
  if (!browserWindow || browserWindow.isDestroyed()) {
    return { attempted: false, passed: false, reason: 'missing-window' }
  }

  const capability: unknown = await webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#fullscreen-player')
    return {
      ready: button instanceof HTMLButtonElement,
      bridge: typeof window.tvFeed?.setPlayerFullscreen === 'function'
    }
  })()`)
  const canRun = capability && typeof capability === 'object' ? capability as Record<string, unknown> : {}
  if (canRun.ready !== true || canRun.bridge !== true) {
    return { attempted: false, passed: false, reason: canRun.ready === true ? 'missing-bridge' : 'missing-elements' }
  }

  const enterButtonClicked = await webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#fullscreen-player')
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false
    button.click()
    return true
  })()`)
  const enteredNativeFullscreen = enterButtonClicked === true && await waitForWindowFullscreenState(browserWindow, true)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  const enteredSnapshot: unknown = await webContents.executeJavaScript(`(() => {
    const app = document.querySelector('#app-shell')
    const controls = document.querySelector('.player-controls')
    const button = document.querySelector('#fullscreen-player')
    const surface = document.querySelector('#player-surface')
    const channelPane = document.querySelector('#channel-pane')
    const titlebar = document.querySelector('.titlebar')
    return {
      appFullscreenClass: app?.classList.contains('player-fullscreen') === true,
      controlsVisible: controls instanceof HTMLElement && controls.getBoundingClientRect().height >= 40 && getComputedStyle(controls).display !== 'none',
      exitLabelVisible: button?.getAttribute('aria-label') === '退出全屏' && button?.classList.contains('is-fullscreen'),
      playerFillsViewport: surface instanceof HTMLElement && surface.getBoundingClientRect().width >= innerWidth - 2 && surface.getBoundingClientRect().height >= innerHeight - 2,
      surroundingChromeHidden: channelPane instanceof HTMLElement && titlebar instanceof HTMLElement && getComputedStyle(channelPane).display === 'none' && getComputedStyle(titlebar).display === 'none'
    }
  })()`)
  const entered = enteredSnapshot && typeof enteredSnapshot === 'object'
    ? enteredSnapshot as Record<string, unknown>
    : {}

  const exitButtonClicked = enteredNativeFullscreen
    ? await webContents.executeJavaScript(`(() => {
        const button = document.querySelector('#fullscreen-player')
        if (!(button instanceof HTMLButtonElement) || button.disabled) return false
        button.click()
        return true
      })()`)
    : false
  const exitedNativeFullscreen = exitButtonClicked === true && await waitForWindowFullscreenState(browserWindow, false)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  const exitedSnapshot: unknown = await webContents.executeJavaScript(`(() => {
    const app = document.querySelector('#app-shell')
    const button = document.querySelector('#fullscreen-player')
    return {
      appFullscreenClassRemoved: app?.classList.contains('player-fullscreen') === false,
      enterLabelRestored: button?.getAttribute('aria-label') === '全屏' && !button?.classList.contains('is-fullscreen')
    }
  })()`)
  const exited = exitedSnapshot && typeof exitedSnapshot === 'object'
    ? exitedSnapshot as Record<string, unknown>
    : {}
  if (isBrowserWindowFullscreen(browserWindow)) {
    if (process.platform === 'darwin') browserWindow.setSimpleFullScreen(false)
    else browserWindow.setFullScreen(false)
  }
  return {
    attempted: true,
    enterButtonClicked,
    enteredNativeFullscreen,
    ...entered,
    exitButtonClicked,
    exitedNativeFullscreen,
    ...exited,
    passed:
      enterButtonClicked === true &&
      enteredNativeFullscreen &&
      entered.appFullscreenClass === true &&
      entered.controlsVisible === true &&
      entered.exitLabelVisible === true &&
      entered.playerFillsViewport === true &&
      entered.surroundingChromeHidden === true &&
      exitButtonClicked === true &&
      exitedNativeFullscreen &&
      exited.appFullscreenClassRemoved === true &&
      exited.enterLabelRestored === true
  }
}

async function waitForWindowFullscreenState(browserWindow: BrowserWindow, fullscreen: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (browserWindow.isDestroyed()) return false
    if (isBrowserWindowFullscreen(browserWindow) === fullscreen) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  return !browserWindow.isDestroyed() && isBrowserWindowFullscreen(browserWindow) === fullscreen
}

async function runPlaybackDiagnosticCheck(webContents: Electron.WebContents): Promise<Record<string, unknown>> {
  if (process.env.TVFEED_SMOKE_DIAGNOSTIC !== '1') return { attempted: false }

  const navigationSeed: unknown = await webContents.executeJavaScript(`(() => {
    const selected = () => document.querySelector('[data-channel-selected="true"]')?.getAttribute('data-channel-id') ?? ''
    const initialChannel = selected()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const afterArrow = selected()
    document.querySelector('#stop-player')?.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }))
    return { initialChannel, afterArrow }
  })()`)
  const navigation = navigationSeed && typeof navigationSeed === 'object'
    ? navigationSeed as Record<string, unknown>
    : {}
  let state: Record<string, unknown> = { attempted: true, passed: false }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    const snapshot: unknown = await webContents.executeJavaScript(`(() => {
      const diagnostic = document.querySelector('#playback-diagnostic')
      const text = diagnostic?.textContent ?? ''
      return {
        code: diagnostic instanceof HTMLElement ? diagnostic.dataset.code ?? '' : '',
        text,
        health: document.querySelector('#channel-health')?.textContent ?? '',
        selectedChannel: document.querySelector('[data-channel-selected="true"]')?.getAttribute('data-channel-id') ?? '',
        containsSensitiveUrl: /https?:\\/\\/|\\.invalid|(?:token|signature)=/i.test(text)
      }
    })()`)
    state = { attempted: true, ...(snapshot && typeof snapshot === 'object' ? snapshot : {}) }
    const arrowShortcutWorks = typeof navigation.initialChannel === 'string' && navigation.initialChannel.length > 0 && navigation.afterArrow !== navigation.initialChannel
    const numericShortcutWorks = typeof state.selectedChannel === 'string' && state.selectedChannel.length > 0 && state.selectedChannel !== navigation.afterArrow
    if (state.code === 'dns-failure' && state.containsSensitiveUrl === false && arrowShortcutWorks && numericShortcutWorks) {
      return { ...state, arrowShortcutWorks, numericShortcutWorks, passed: true }
    }
  }
  await webContents.executeJavaScript(`document.querySelector('#stop-player')?.click()`)
  return { ...state, passed: false }
}

async function runFamilySafetyCheck(webContents: Electron.WebContents): Promise<Record<string, unknown>> {
  if (process.env.TVFEED_SMOKE_FAMILY !== '1') return { attempted: false }

  await webContents.executeJavaScript(`document.querySelector('#family-safety-toggle')?.click()`)
  let state: Record<string, unknown> = { attempted: true, passed: false }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    const snapshot: unknown = await webContents.executeJavaScript(`(() => {
      const family = document.querySelector('#family-safety-toggle')
      const remote = document.querySelector('#remote-logo-toggle')
      const familyNote = document.querySelector('#family-safety-note')?.textContent ?? ''
      const manualImportControls = document.querySelectorAll('[data-manual-url-import], input[type="url"]').length
      return {
        familyChecked: family instanceof HTMLInputElement ? family.checked : null,
        familyDisabled: family instanceof HTMLInputElement ? family.disabled : null,
        familyStored: localStorage.getItem('tvfeed:family-safety:v1'),
        recentsStored: localStorage.getItem('tvfeed:recents:v1'),
        remoteChecked: remote instanceof HTMLInputElement ? remote.checked : null,
        remoteDisabled: remote instanceof HTMLInputElement ? remote.disabled : null,
        remoteStored: localStorage.getItem('tvfeed:remote-logos:v1'),
        remoteLogoImages: document.querySelectorAll('img[data-remote-logo="true"]').length,
        manualImportControls,
        disclaimerPresent: familyNote.includes('不是儿童绝对安全保证'),
        badge: document.querySelector('#safety-badge-label')?.textContent ?? '',
        catalogState: document.querySelector('#catalog-state')?.textContent ?? '',
        rows: document.querySelectorAll('[data-channel-row]').length
      }
    })()`)
    state = { attempted: true, ...(snapshot && typeof snapshot === 'object' ? snapshot : {}) }
    if (
      state.familyChecked === true &&
      state.familyDisabled === false &&
      state.familyStored === 'true' &&
      state.remoteChecked === false &&
      state.remoteDisabled === true &&
      state.remoteStored === 'false' &&
      state.remoteLogoImages === 0 &&
      state.manualImportControls === 0 &&
      state.disclaimerPresent === true &&
      String(state.badge ?? '').includes('本地允许列表') &&
      String(state.catalogState ?? '').includes('家庭安全')
    ) {
      const dialogOpened = await webContents.executeJavaScript(`(() => {
        const dialog = document.querySelector('#info-dialog')
        if (!(dialog instanceof HTMLDialogElement)) return false
        if (!dialog.open) dialog.showModal()
        return dialog.open
      })()`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
      return { ...state, dialogOpened: dialogOpened === true, passed: dialogOpened === true }
    }
  }
  return { ...state, passed: false }
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
