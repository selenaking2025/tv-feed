import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

/** Exercises the device as a user does, including pointer capture in Electron. */
export async function runDeviceInspection(webContents, runtime) {
  const checks = await webContents.executeJavaScript(`(async () => {
    const get = (selector) => document.querySelector(selector)
    const app = get('#app-shell'), pane = get('#channel-pane'), search = get('#channel-search')
    const toggle = get('#sidebar-toggle'), sources = get('#source-panel'), dialog = get('#info-dialog')
    const stage = get('#player-stage'), controls = get('.player-controls'), footer = get('.device-footer')
    const video = get('#video-player'), volume = get('#volume-dial')
    const initialModal = dialog.open, initialMenu = app.classList.contains('sidebar-open')
    const initialVolume = video.volume, initialMuted = video.muted
    // Focus transfers after the menu transition. Wait for actual completion so
    // a busy renderer cannot make a fixed delay inspect the intermediate state.
    const settle = async () => {
      await new Promise(resolve => requestAnimationFrame(resolve))
      await Promise.allSettled(pane.getAnimations().map(animation => animation.finished))
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    const key = (target, value) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
    if (initialModal) dialog.close()
    const s = stage.getBoundingClientRect(), c = controls.getBoundingClientRect(), f = footer.getBoundingClientRect()
    const controlsBesideScreen = c.left >= s.right && c.right <= innerWidth && c.height >= 250
    const footerBelowScreen = f.top >= s.bottom && f.bottom <= innerHeight
    const directoryClosedInitially = !initialMenu && pane.inert && toggle.getAttribute('aria-expanded') === 'false'
    if (initialMenu) get('#sidebar-close').click()
    toggle.click()
    await settle()
    const p = pane.getBoundingClientRect()
    const menuOpenState = {
      focus: document.activeElement?.id ?? '', windowFocused: document.hasFocus(),
      inert: pane.inert, visibility: getComputedStyle(pane).visibility,
      expanded: toggle.getAttribute('aria-expanded'), searchDisabled: search.disabled,
      animations: pane.getAnimations().map(animation => animation.playState),
      bounds: { left: p.left, right: p.right, top: p.top, bottom: p.bottom }
    }
    const menuOpens = !pane.inert && getComputedStyle(pane).visibility === 'visible' &&
      toggle.getAttribute('aria-expanded') === 'true' &&
      p.left >= s.left && p.right <= s.right && p.top >= s.top && p.bottom <= s.bottom &&
      (search.disabled || document.activeElement === search)
    const screenKeepsSize = Math.abs(stage.getBoundingClientRect().width - s.width) < 1
    const listHeight = get('#channel-list').getBoundingClientRect().height
    get('#filter-toggle').click()
    const filtersReachable = [...pane.querySelectorAll('select')].every(select => select.getBoundingClientRect().height >= 28)
    get('#filter-toggle').click()
    get('#sidebar-close').click()
    await settle()
    const menuCloses = pane.inert && getComputedStyle(pane).visibility === 'hidden' && document.activeElement === toggle
    const menuCloseState = { focus: document.activeElement?.id ?? '', inert: pane.inert, visibility: getComputedStyle(pane).visibility }
    key(document, '/')
    await settle()
    const searchShortcut = app.classList.contains('sidebar-open') && (search.disabled || document.activeElement === search)
    key(document, 'Escape')
    const escapeCloses = pane.inert && !app.classList.contains('sidebar-open')
    toggle.click()
    await settle()
    get('#drawer-scrim').click()
    const backdropCloses = pane.inert && !app.classList.contains('sidebar-open')
    get('#source-toggle').click()
    const sourceOpens = !sources.hidden && get('#source-toggle').getAttribute('aria-expanded') === 'true'
    key(document, 'Escape')
    const sourceCloses = sources.hidden && document.activeElement === get('#source-toggle')
    get('#catalog-info').click()
    const d = dialog.getBoundingClientRect()
    const settingsOpens = dialog.open && d.left >= s.left && d.right <= s.right && d.top >= s.top && d.bottom <= s.bottom
    dialog.scrollTop = dialog.scrollHeight
    const lastSetting = dialog.querySelector('.dialog-primary').getBoundingClientRect()
    const settingsScrolls = lastSetting.bottom <= d.bottom && lastSetting.top >= d.top
    get('#dialog-close').click()
    await settle()
    const settingsCloses = document.activeElement === get('#catalog-info')
    dialog.scrollTop = 0
    video.volume = 0.5
    await settle()
    const titleBefore = get('#channel-title').textContent
    volume.focus()
    key(volume, 'ArrowDown')
    await settle()
    const volumeKeyboard = Math.abs(video.volume - 0.49) < 0.001 && volume.getAttribute('aria-valuenow') === '49' && get('#channel-title').textContent === titleBefore
    key(volume, 'Home')
    key(volume, 'ArrowDown')
    const volumeMinimum = video.volume === 0
    key(volume, 'End')
    key(volume, 'ArrowUp')
    const volumeMaximum = video.volume === 1
    get('#mute-player').click()
    await settle()
    const muteButton = video.muted !== initialMuted && get('#mute-player').getAttribute('aria-pressed') === String(video.muted)
    video.volume = initialVolume
    video.muted = initialMuted
    await settle()
    return { controlsBesideScreen, footerBelowScreen, directoryClosedInitially, menuOpens,
      screenKeepsSize, listHeight, filtersReachable, menuCloses, menuOpenState, menuCloseState, searchShortcut, escapeCloses,
      backdropCloses, sourceOpens, sourceCloses, settingsOpens, settingsScrolls, settingsCloses, volumeKeyboard,
      volumeMinimum, volumeMaximum, muteButton, initialModal, initialMenu,
      initialVolume, initialMuted, hadCatalogFailure: !get('#catalog-failure').hidden }
  })()`)

  const position = await webContents.executeJavaScript(`(() => {
    const r = document.querySelector('#volume-dial').getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  webContents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 })
  webContents.sendInputEvent({ type: 'mouseMove', x: position.x, y: position.y + 30 })
  webContents.sendInputEvent({ type: 'mouseUp', x: position.x, y: position.y + 30, button: 'left', clickCount: 1 })
  await new Promise(resolve => setTimeout(resolve, 100))
  checks.volumeDrag = await webContents.executeJavaScript(`(() => {
    const video = document.querySelector('video')
    const changed = Math.abs(video.volume - Math.max(0, ${checks.initialVolume} - 0.2)) < 0.011
    video.volume = ${checks.initialVolume}
    video.muted = ${checks.initialMuted}
    return changed
  })()`)

  // A directory screenshot contains only the explicitly selected sample catalog.
  if (!runtime.smoke.liveCatalog && !runtime.smoke.autoplay && !runtime.smoke.diagnostic && !runtime.smoke.familySafety) {
    await webContents.executeJavaScript(`document.querySelectorAll('.toast').forEach(toast => toast.remove())`)
    await webContents.executeJavaScript(`document.querySelector('#sidebar-toggle').click()`)
    await new Promise(resolve => setTimeout(resolve, 220))
    const image = await webContents.capturePage()
    checks.directoryScreenshot = join(tmpdir(), basename(runtime.smoke.outputPath).replace(/\.png$/, '-menu.png'))
    await writeFile(checks.directoryScreenshot, image.toPNG())
    await webContents.executeJavaScript(`document.querySelector('#sidebar-close').click()`)
    await webContents.executeJavaScript(`document.querySelector('#catalog-info').click()`)
    await new Promise(resolve => setTimeout(resolve, 220))
    checks.settingsScreenshot = join(tmpdir(), basename(runtime.smoke.outputPath).replace(/\.png$/, '-settings.png'))
    await writeFile(checks.settingsScreenshot, (await webContents.capturePage()).toPNG())
    await webContents.executeJavaScript(`document.querySelector('#dialog-close').click()`)
  }
  await webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.toast').forEach(toast => toast.remove())
    if (${checks.initialMenu}) document.querySelector('#sidebar-toggle').click()
    if (${checks.initialModal}) document.querySelector('#info-dialog').showModal()
    else document.activeElement?.blur()
  })()`)
  checks.passed = checks.controlsBesideScreen && checks.footerBelowScreen &&
    (checks.directoryClosedInitially || checks.hadCatalogFailure) &&
    checks.menuOpens && checks.screenKeepsSize && checks.listHeight >= 65 && checks.filtersReachable &&
    checks.menuCloses && checks.searchShortcut && checks.escapeCloses && checks.backdropCloses &&
    checks.sourceOpens && checks.sourceCloses && checks.settingsOpens && checks.settingsScrolls && checks.settingsCloses && checks.volumeKeyboard &&
    checks.volumeMinimum && checks.volumeMaximum && checks.muteButton && checks.volumeDrag
  return checks
}
