import { app, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'

export async function runSmokeInspection(webContents                      , runtime               )                {
  const outputPath = runtime.smoke.outputPath
  if (!outputPath) return

  try {
    const playbackCheck = await runPlaybackCheck(webContents, runtime)
    const familySafetyCheck = await runFamilySafetyCheck(webContents, runtime)
    const playbackDiagnosticCheck = await runPlaybackDiagnosticCheck(webContents, runtime)
    const directExternalFetchBlocked          = await webContents.executeJavaScript(
      `fetch('https://127.0.0.1/tv-feed-security-smoke').then(() => false, () => true)`
    )
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350))
    const domResult          = await webContents.executeJavaScript(`(async () => {
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
      let sourceHealthSummary = { present: false, records: 0, containsUrl: false }
      const sourceHealthRaw = localStorage.getItem('tvfeed:source-health:v1')
      if (sourceHealthRaw) {
        try {
          const parsed = JSON.parse(sourceHealthRaw)
          sourceHealthSummary = {
            present: true,
            records: Array.isArray(parsed?.records) ? parsed.records.length : 0,
            containsUrl: sourceHealthRaw.includes('://')
          }
        } catch {
          sourceHealthSummary = { present: true, records: -1, containsUrl: true }
        }
      }
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
      if (${JSON.stringify(runtime.smoke.liveCatalog)}) {
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
        sourceHealthSummary,
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
    const offlineDemoTransitionCheck = await runOfflineDemoTransitionCheck(webContents, runtime)
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

async function runOfflineDemoTransitionCheck(webContents                      , runtime               )                                   {
  if (!runtime.smoke.openOfflineDemo) return { attempted: false }
  const before          = await webContents.executeJavaScript(`(() => ({
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
  let after                          = {}
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    const snapshot          = await webContents.executeJavaScript(`(() => ({
      source: document.querySelector('#app-shell')?.dataset.catalogSource ?? '',
      state: document.querySelector('#catalog-state')?.textContent ?? '',
      rows: document.querySelectorAll('[data-channel-row]').length,
      failureVisible: document.querySelector('#catalog-failure') instanceof HTMLElement && !document.querySelector('#catalog-failure').hidden
    }))()`)
    after = snapshot && typeof snapshot === 'object' ? snapshot                            : {}
    if (after.source === 'offline-sample' && Number(after.rows) >= 8) break
  }
  const beforeState = before && typeof before === 'object' ? before                            : {}
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

async function runFullscreenCheck(webContents                      )                                   {
  const browserWindow = BrowserWindow.fromWebContents(webContents)
  if (!browserWindow || browserWindow.isDestroyed()) {
    return { attempted: false, passed: false, reason: 'missing-window' }
  }

  const capability          = await webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#fullscreen-player')
    return {
      ready: button instanceof HTMLButtonElement,
      bridge: typeof window.tvFeed?.setPlayerFullscreen === 'function'
    }
  })()`)
  const canRun = capability && typeof capability === 'object' ? capability                            : {}
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
  const enteredSnapshot          = await webContents.executeJavaScript(`(() => {
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
    ? enteredSnapshot
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
  const exitedSnapshot          = await webContents.executeJavaScript(`(() => {
    const app = document.querySelector('#app-shell')
    const button = document.querySelector('#fullscreen-player')
    return {
      appFullscreenClassRemoved: app?.classList.contains('player-fullscreen') === false,
      enterLabelRestored: button?.getAttribute('aria-label') === '全屏' && !button?.classList.contains('is-fullscreen')
    }
  })()`)
  const exited = exitedSnapshot && typeof exitedSnapshot === 'object'
    ? exitedSnapshot
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

async function waitForWindowFullscreenState(browserWindow               , fullscreen         )                   {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (browserWindow.isDestroyed()) return false
    if (isBrowserWindowFullscreen(browserWindow) === fullscreen) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  return !browserWindow.isDestroyed() && isBrowserWindowFullscreen(browserWindow) === fullscreen
}

async function runPlaybackDiagnosticCheck(webContents                      , runtime               )                                   {
  if (!runtime.smoke.diagnostic) return { attempted: false }

  const navigationSeed          = await webContents.executeJavaScript(`(() => {
    const selected = () => document.querySelector('[data-channel-selected="true"]')?.getAttribute('data-channel-id') ?? ''
    const initialChannel = selected()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const afterArrow = selected()
    document.querySelector('#stop-player')?.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }))
    return { initialChannel, afterArrow }
  })()`)
  const navigation = navigationSeed && typeof navigationSeed === 'object'
    ? navigationSeed
    : {}
  let state                          = { attempted: true, passed: false }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    const snapshot          = await webContents.executeJavaScript(`(() => {
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
async function runFamilySafetyCheck(webContents                      , runtime               )                                   {
  if (!runtime.smoke.familySafety) return { attempted: false }

  await webContents.executeJavaScript(`document.querySelector('#family-safety-toggle')?.click()`)
  let state                          = { attempted: true, passed: false }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    const snapshot          = await webContents.executeJavaScript(`(() => {
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

async function runPlaybackCheck(webContents                      , runtime               )                                   {
  if (!runtime.smoke.autoplay) return { attempted: false }

  await webContents.executeJavaScript(`document.querySelector('#toggle-play')?.click()`)
  let state                          = { attempted: true, passed: false }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    const snapshot = await readPlaybackSnapshot(webContents)
    state = { attempted: true, ...(snapshot && typeof snapshot === 'object' ? snapshot : {}) }
    const readyState = Number(state.readyState ?? -1)
    const width = Number(state.width ?? 0)
    if (readyState >= 2 && state.paused === false && width > 0) break
  }

  if (Number(state.readyState ?? -1) < 2 || state.paused !== false || Number(state.width ?? 0) <= 0) {
    return { ...state, passed: false, reasons: ['播放器未在 20 秒内完成起播'] }
  }

  const baselineMetrics = recordValue(state.metrics)
  const startedMediaAdvancedSeconds = finiteSmokeNumber(baselineMetrics.mediaAdvancedSeconds)
  const startedStallDurationMs = finiteSmokeNumber(baselineMetrics.stallDurationMs)
  const startedDroppedFrames = finiteSmokeNumber(baselineMetrics.droppedFrames)
  const startedTotalFrames = finiteSmokeNumber(baselineMetrics.totalFrames)
  const observationTargetMs = runtime.smoke.playbackObservationMs
  const observationStartedAt = Date.now()

  while (Date.now() - observationStartedAt < observationTargetMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    const snapshot = await readPlaybackSnapshot(webContents)
    state = { attempted: true, ...(snapshot && typeof snapshot === 'object' ? snapshot : {}) }
  }

  const observationMs = Date.now() - observationStartedAt
  const finalMetrics = recordValue(state.metrics)
  const continuity = evaluatePlaybackContinuity({
    startedCurrentTime: startedMediaAdvancedSeconds,
    endedCurrentTime: finiteSmokeNumber(finalMetrics.mediaAdvancedSeconds),
    observationMs,
    stallDurationMs: Math.max(0, finiteSmokeNumber(finalMetrics.stallDurationMs) - startedStallDurationMs),
    droppedFrames: Math.max(0, finiteSmokeNumber(finalMetrics.droppedFrames) - startedDroppedFrames),
    totalFrames: Math.max(0, finiteSmokeNumber(finalMetrics.totalFrames) - startedTotalFrames),
    readyState: finiteSmokeNumber(state.readyState, -1),
    paused: state.paused !== false,
    width: finiteSmokeNumber(state.width)
  })

  return {
    ...state,
    observationMs,
    continuity,
    passed: continuity.passed
  }
}

async function readPlaybackSnapshot(webContents                      )                   {
  return webContents.executeJavaScript(`(() => {
    const video = document.querySelector('video')
    if (!(video instanceof HTMLVideoElement)) {
      return { readyState: -1, paused: true, width: 0, height: 0, currentTime: 0, metrics: {} }
    }
    let metrics = {}
    try {
      metrics = JSON.parse(video.dataset.playbackMetrics ?? '{}')
    } catch {}
    let currentProtocol = ''
    try {
      currentProtocol = video.currentSrc ? new URL(video.currentSrc).protocol : ''
    } catch {}
    return {
      readyState: video.readyState,
      paused: video.paused,
      width: video.videoWidth,
      height: video.videoHeight,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      currentProtocol,
      metrics,
      status: document.querySelector('#player-status-text')?.textContent ?? ''
    }
  })()`)
}


function recordValue(value         )                          {
  return value && typeof value === 'object' && !Array.isArray(value) ? value                            : {}
}

function finiteSmokeNumber(value         , fallback = 0)         {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isBrowserWindowFullscreen(browserWindow               )          {
  return process.platform === 'darwin' ? browserWindow.isSimpleFullScreen() : browserWindow.isFullScreen()
}


function evaluatePlaybackContinuity(input) {
  const observationSeconds = Math.max(0, input.observationMs / 1_000)
  const advancedSeconds = Math.max(0, input.endedCurrentTime - input.startedCurrentTime)
  const minimumAdvanceSeconds = Math.max(2, observationSeconds * 0.8)
  const stallRatio = input.observationMs > 0 ? Math.max(0, input.stallDurationMs) / input.observationMs : 1
  const droppedFrameRatio = input.totalFrames > 0 ? Math.max(0, input.droppedFrames) / input.totalFrames : 0
  const reasons = []
  if (input.readyState < 2 || input.paused || input.width <= 0) reasons.push('播放器没有保持可播放状态')
  if (advancedSeconds < minimumAdvanceSeconds) reasons.push('观察期内播放时间推进不足')
  if (stallRatio > 0.05) reasons.push('观察期内缓冲停顿超过 5%')
  if (droppedFrameRatio > 0.02) reasons.push('观察期内掉帧超过 2%')
  return { passed: reasons.length === 0, advancedSeconds, minimumAdvanceSeconds, stallRatio, droppedFrameRatio, reasons }
}
