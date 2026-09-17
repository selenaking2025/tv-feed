import type {
  Catalog,
  CatalogChannel,
  CatalogLoadFailure,
  CatalogLoadResult,
  CatalogSource,
  CatalogSyncProgress
} from '../../shared/catalog-contracts.ts'
import { displayCountryName } from '../../shared/countries.ts'
import { hasVerifiedOfficialSource, isVerifiedOfficialSource } from '../../shared/official-sources.ts'
import {
  classifyPlaybackDiagnostic,
  playbackDiagnosticInputForRemoteFailure,
  type PlaybackDiagnostic
} from '../../shared/playback-diagnostics.ts'
import type { PlaybackMetricsSnapshot } from '../../shared/playback-metrics.ts'
import type { SafetyStateSnapshot } from '../../shared/safety-contracts.ts'
import { rankSources } from '../../shared/source-health.ts'
import { StreamPlayer, type PlaybackState } from './player.ts'
import {
  PlaybackNetworkRecoveryGate,
  type PlaybackNetworkTarget
} from './playback-network-recovery.ts'
import { ViewingState } from './viewing-state.ts'
import { CatalogRequests } from './catalog-requests.ts'
import { createCatalogStatusView } from './catalog-status-view.ts'
import { createKeyboardControls } from './keyboard-controls.ts'
import { RemoteLogoController } from './remote-logo-controller.ts'
import { SafetyClient } from './safety-client.ts'
import { createChannelList, type ViewMode } from './channel-list.ts'
import { createRotaryControl } from './rotary-control.ts'

const NETWORK_RECOVERY_DELAY_MS = 3_000
const NETWORK_RECOVERY_COOLDOWN_MS = 30_000

const elements = {
  app: required<HTMLElement>('#app-shell'),
  workspace: required<HTMLElement>('.workspace'),
  channelPane: required<HTMLElement>('#channel-pane'),
  sidebarToggle: required<HTMLButtonElement>('#sidebar-toggle'),
  sidebarClose: required<HTMLButtonElement>('#sidebar-close'),
  drawerScrim: required<HTMLElement>('#drawer-scrim'),
  catalogState: required<HTMLElement>('#catalog-state'),
  refreshCatalog: required<HTMLButtonElement>('#refresh-catalog'),
  search: required<HTMLInputElement>('#channel-search'),
  country: required<HTMLSelectElement>('#country-filter'),
  category: required<HTMLSelectElement>('#category-filter'),
  resultCount: required<HTMLElement>('#result-count'),
  channelList: required<HTMLElement>('#channel-list'),
  channelSpacer: required<HTMLElement>('#channel-spacer'),
  channelWindow: required<HTMLElement>('#channel-window'),
  loadingList: required<HTMLElement>('#loading-list'),
  catalogFailure: required<HTMLElement>('#catalog-failure'),
  catalogFailureTitle: required<HTMLElement>('#catalog-failure-title'),
  catalogFailureMessage: required<HTMLElement>('#catalog-failure-message'),
  retryCatalog: required<HTMLButtonElement>('#retry-catalog'),
  toggleCatalogDiagnostics: required<HTMLButtonElement>('#toggle-catalog-diagnostics'),
  openOfflineDemo: required<HTMLButtonElement>('#open-offline-demo'),
  catalogDiagnostics: required<HTMLElement>('#catalog-diagnostics'),
  video: required<HTMLVideoElement>('#video-player'),
  playerStage: required<HTMLElement>('#player-stage'),
  playerEmpty: required<HTMLElement>('#player-empty'),
  playerStatus: required<HTMLElement>('#player-status-overlay'),
  playerStatusText: required<HTMLElement>('#player-status-text'),
  nowPlaying: required<HTMLElement>('#now-playing'),
  sourceQuality: required<HTMLElement>('#source-quality'),
  channelDial: required<HTMLElement>('#channel-dial'),
  channelNumber: required<HTMLOutputElement>('#channel-number'),
  volumeDial: required<HTMLElement>('#volume-dial'),
  volumeValue: required<HTMLOutputElement>('#volume-value'),
  mute: required<HTMLButtonElement>('#mute-player'),
  powerLabel: required<HTMLElement>('#power-label'),
  sourcePanel: required<HTMLElement>('#source-panel'),
  sourceToggle: required<HTMLButtonElement>('#source-toggle'),
  sourceClose: required<HTMLButtonElement>('#source-close'),
  previous: required<HTMLButtonElement>('#previous-channel'),
  togglePlay: required<HTMLButtonElement>('#toggle-play'),
  next: required<HTMLButtonElement>('#next-channel'),
  stop: required<HTMLButtonElement>('#stop-player'),
  pip: required<HTMLButtonElement>('#picture-in-picture'),
  fullscreen: required<HTMLButtonElement>('#fullscreen-player'),
  detailLogo: required<HTMLElement>('#detail-logo'),
  channelMeta: required<HTMLElement>('#channel-meta'),
  channelTitle: required<HTMLElement>('#channel-title'),
  channelDescription: required<HTMLElement>('#channel-description'),
  favorite: required<HTMLButtonElement>('#favorite-channel'),
  sourceList: required<HTMLElement>('#source-list'),
  sourceHelp: required<HTMLElement>('#source-help'),
  channelHealth: required<HTMLElement>('#channel-health'),
  playbackDiagnostic: required<HTMLElement>('#playback-diagnostic'),
  catalogInfo: required<HTMLButtonElement>('#catalog-info'),
  infoDialog: required<HTMLDialogElement>('#info-dialog'),
  dialogClose: required<HTMLButtonElement>('#dialog-close'),
  catalogStats: required<HTMLElement>('#catalog-stats'),
  familySafetyToggle: required<HTMLInputElement>('#family-safety-toggle'),
  remoteLogoToggle: required<HTMLInputElement>('#remote-logo-toggle'),
  remoteLogoHelp: required<HTMLElement>('#remote-logo-help'),
  safetyBadgeLabel: required<HTMLElement>('#safety-badge-label'),
  clearCatalogCache: required<HTMLButtonElement>('#clear-catalog-cache'),
  clearViewingData: required<HTMLButtonElement>('#clear-viewing-data'),
  privacyStatus: required<HTMLElement>('#privacy-control-status'),
  toastRegion: required<HTMLElement>('#toast-region'),
  announcementRegion: required<HTMLElement>('#announcement-region')
}

const viewing = new ViewingState()
const catalogRequests = new CatalogRequests()
let catalog: Catalog | undefined
let selectedChannelId = viewing.lastChannel
let activeSourceIndex = 0
let viewMode: ViewMode = 'all'
let failedSources = new Set<string>()
let healthRecordedForLoad = false
let refreshInProgress = false
let catalogSyncActive = false
let familySafetyEnabled = false
let remoteLogosEnabled = false
let announcementTimer: number | undefined
let fullscreenTransitionInProgress = false
let playbackAttemptGeneration = 0
let networkRecoveryTimer: number | undefined
let networkRecoveryCheckGeneration: number | undefined
const safetyClient = new SafetyClient(window.tvFeed)
const remoteLogoController = new RemoteLogoController(window.tvFeed)
const networkRecovery = new PlaybackNetworkRecoveryGate(NETWORK_RECOVERY_COOLDOWN_MS)
const catalogStatus = createCatalogStatusView(elements, () => familySafetyEnabled)
const {
  populateFacets, renderCatalogStats, updateCatalogStatus,
  setCatalogFailureVisible, setCatalogControlsEnabled, toggleCatalogDiagnostics
} = catalogStatus

const player = new StreamPlayer(elements.video, {
  onState: updatePlaybackState,
  onFatal: (source, diagnostic) => void handleFatalSource(source, diagnostic),
  onMetrics: handlePlaybackMetrics
})

const channelList = createChannelList({
  elements, viewing, catalog: () => catalog, viewMode: () => viewMode,
  selectedChannelId: () => selectedChannelId, selectChannel, toggleFavorite,
  createLogo, createOfficialBadge, createStarIcon, emptyMessage, resetChannelNumberBuffer
})

const keyboard = createKeyboardControls({
  elements, openSidebar, channels: () => channelList.channels,
  closeSidebar, closeSources, toggleFullscreen, togglePictureInPicture, togglePlayback, moveChannel,
  selectChannel, ensureChannelVisible, announce, showToast,
  onMute: () => announceVolume(player.toggleMuted()),
  onVolume: (delta) => announceVolume(player.adjustVolume(delta))
})

const channelDial = createRotaryControl({
  element: elements.channelDial, minimum: 1, maximum: 0, value: 1, pixelsPerStep: 14,
  deferred: true, angle: (value) => (value - 1) * 30 - 45,
  describe: (value) => `第 ${value} 台，${channelList.channels[value - 1]?.name ?? '未选择'}`,
  onPreview: (value) => { elements.channelNumber.value = channelList.channels.length ? String(value).padStart(2, '0') : '—' },
  onChange: (value) => {
    const channel = channelList.channels[value - 1]
    if (channel) { selectChannel(channel.id, true, true); ensureChannelVisible(value - 1) }
  }
})
const volumeDial = createRotaryControl({
  element: elements.volumeDial, minimum: 0, maximum: 100, value: player.volumeState.percent, pixelsPerStep: 1.5,
  angle: (value) => -135 + value * 2.7,
  describe: (value) => `音量 ${value}%`,
  onPreview: (value) => { elements.volumeValue.value = String(value).padStart(2, '0') },
  onChange: (value) => { player.setVolume(value) }
})

function resetChannelNumberBuffer(): void { keyboard.resetNumber() }

bindEvents()
void initialize()

async function initialize(): Promise<void> {
  const generation = catalogRequests.begin()
  elements.refreshCatalog.disabled = true
  catalogSyncActive = true
  try {
    let safety = await safetyClient.initialize()
    applySafetyState(safety)
    if (safety.pendingViewingDataClear) {
      enforceFamilyLocalState()
      safety = await safetyClient.acknowledgeCleanup(safety.transitionId)
      applySafetyState(safety)
    } else if (familySafetyEnabled) {
      enforceFamilyLocalState()
    }
    elements.refreshCatalog.disabled = false
    const response = await window.tvFeed.loadCatalog(catalogRequests.command('startup', generation))
    if (!catalogRequests.isCurrent(generation)) return
    if (response.ok) applyCatalog(response.result)
    else showCatalogFailure(response.failure)
  } catch (error) {
    if (catalogRequests.isCurrent(generation)) showCatalogFailure(unexpectedCatalogFailure(error))
  } finally {
    if (catalogRequests.isCurrent(generation)) {
      catalogSyncActive = false
      elements.refreshCatalog.disabled = false
      elements.loadingList.hidden = true
    }
    syncSafetyControls()
    elements.app.dataset.appReady = 'true'
    window.tvFeed.signalRendererReady()
  }
}

function bindEvents(): void {
  syncSafetyControls()
  elements.search.addEventListener('input', applyFilters)
  elements.country.addEventListener('change', applyFilters)
  elements.category.addEventListener('change', applyFilters)
  const filterToggle = required<HTMLButtonElement>('#filter-toggle')
  const filters = required<HTMLElement>('#channel-filters')
  filterToggle.addEventListener('click', () => {
    filters.hidden = !filters.hidden
    filterToggle.setAttribute('aria-expanded', String(!filters.hidden))
    renderVirtualRows()
  })

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    button.addEventListener('click', () => setViewMode(button.dataset.view as ViewMode))
  }

  elements.refreshCatalog.addEventListener('click', () => void refreshCatalog())
  elements.retryCatalog.addEventListener('click', () => void refreshCatalog())
  elements.toggleCatalogDiagnostics.addEventListener('click', toggleCatalogDiagnostics)
  elements.openOfflineDemo.addEventListener('click', () => void openOfflineDemo())
  window.tvFeed.onCatalogSyncProgress(updateCatalogProgress)
  elements.previous.addEventListener('click', () => moveChannel(-1))
  elements.next.addEventListener('click', () => moveChannel(1))
  elements.togglePlay.addEventListener('click', () => void togglePlayback())
  elements.stop.addEventListener('click', () => {
    if (elements.app.dataset.power === 'on') stopPlayback()
    else void togglePlayback()
  })
  elements.mute.addEventListener('click', () => announceVolume(player.toggleMuted()))
  elements.video.addEventListener('volumechange', syncVolumeControl)
  for (const action of ['minimize', 'close'] as const) {
    required<HTMLButtonElement>(`#${action}-window`).addEventListener('click', () => {
      void window.tvFeed.windowAction(action).catch(() => showToast('窗口操作未完成，请重试'))
    })
  }
  elements.favorite.addEventListener('click', () => toggleFavorite(selectedChannelId))
  elements.pip.addEventListener('click', () => void togglePictureInPicture())
  elements.fullscreen.addEventListener('click', () => void toggleFullscreen())
  window.tvFeed.onPlayerFullscreenChange(syncFullscreenControl)

  elements.sidebarToggle.addEventListener('click', () => {
    if (elements.app.classList.contains('sidebar-open')) closeSidebar()
    else openSidebar()
  })
  elements.sidebarClose.addEventListener('click', closeSidebar)
  elements.drawerScrim.addEventListener('click', closeSidebar)
  elements.sourceToggle.addEventListener('click', toggleSources)
  elements.sourceClose.addEventListener('click', () => closeSources())

  elements.catalogInfo.addEventListener('click', () => {
    closeSidebar()
    closeSources()
    syncSettingsBounds()
    elements.infoDialog.showModal()
  })
  new ResizeObserver(syncSettingsBounds).observe(elements.playerStage)
  window.addEventListener('resize', syncSettingsBounds)
  elements.dialogClose.addEventListener('click', () => elements.infoDialog.close())
  elements.infoDialog.addEventListener('close', () => elements.catalogInfo.focus({ preventScroll: true }))
  elements.familySafetyToggle.addEventListener('change', () => void updateFamilySafetyPreference())
  elements.remoteLogoToggle.addEventListener('change', () => void updateRemoteLogoPreference())
  elements.clearCatalogCache.addEventListener('click', () => void clearCatalogCacheFromSettings())
  elements.clearViewingData.addEventListener('click', clearViewingDataFromSettings)
  elements.infoDialog.addEventListener('click', (event) => {
    if (event.target === elements.infoDialog) elements.infoDialog.close()
  })

  document.addEventListener('keydown', keyboard.handleKeydown)
  window.addEventListener('online', () => void retryPendingNetworkPlayback('online'))
  syncSidebarState()
  syncFullscreenControl(false)
  syncVolumeControl()
}

function applyCatalog(result: CatalogLoadResult): void {
  catalogSyncActive = false
  setCatalogFailureVisible(false)
  setCatalogControlsEnabled(true)
  elements.loadingList.hidden = true
  const previous = getChannel(selectedChannelId)
  const playingSourceId = player.hasSource ? previous?.sources[activeSourceIndex]?.id : undefined
  if (viewing.useCatalog(result.catalog.source)) selectedChannelId = viewing.lastChannel
  catalog = result.catalog
  catalogRequests.index(catalog)
  elements.app.dataset.catalogSource = result.catalog.source
  elements.app.dataset.catalogCount = String(result.catalog.channels.length)
  populateFacets(result.catalog)
  renderCatalogStats(result.catalog)
  updateCatalogStatus(result.cacheStatus, result.catalog.channels.length)

  applyFilters()
  const initial = getChannel(selectedChannelId) ?? channelList.channels[0] ?? result.catalog.channels[0]
  if (initial) {
    const retainedSourceIndex = initial.sources.findIndex((source) => source.id === playingSourceId)
    if (initial.id === previous?.id && player.hasSource && retainedSourceIndex >= 0) {
      activeSourceIndex = retainedSourceIndex
      renderChannelDetail(initial)
      renderSources(initial)
    } else {
      if (player.hasSource) player.stop()
      selectChannel(initial.id, false, false)
    }
    const initialIndex = channelList.channels.findIndex((channel) => channel.id === initial.id)
    if (initialIndex >= 0) ensureChannelVisible(initialIndex)
  }

  if (result.warning) showToast(result.warning, 7000)
}

async function refreshCatalog(): Promise<void> {
  if (refreshInProgress) return
  refreshInProgress = true
  const generation = catalogRequests.begin()
  elements.refreshCatalog.disabled = true
  elements.retryCatalog.disabled = true
  elements.openOfflineDemo.disabled = true
  syncSafetyControls()
  beginCatalogSync('正在从 iptv-org 更新…')
  try {
    const response = await window.tvFeed.loadCatalog(catalogRequests.command('refresh', generation))
    if (!catalogRequests.isCurrent(generation)) return
    if (response.ok) {
      applyCatalog(response.result)
      showToast(response.result.cacheStatus === 'network' ? '频道目录已更新' : '已重新载入频道目录')
    } else {
      showCatalogFailure(response.failure)
    }
  } catch (error) {
    if (catalogRequests.isCurrent(generation)) showCatalogFailure(unexpectedCatalogFailure(error))
  } finally {
    if (catalogRequests.isCurrent(generation)) {
      refreshInProgress = false
      elements.refreshCatalog.disabled = false
      elements.retryCatalog.disabled = false
      elements.openOfflineDemo.disabled = false
      syncSafetyControls()
    }
  }
}

function applyFilters(): void { channelList.applyFilters(); syncChannelDial() }
function renderVirtualRows(): void { channelList.render() }
function ensureChannelVisible(index: number): void { channelList.ensureVisible(index) }

function selectChannel(channelId: string, autoplay: boolean, rememberRecent: boolean): void {
  const channel = getChannel(channelId)
  if (!channel) return
  playbackAttemptGeneration += 1
  resetNetworkRecovery()
  selectedChannelId = channel.id
  activeSourceIndex = preferredSource(channel)?.index ?? 0
  failedSources = new Set()
  viewing.select(channel.id)

  if (rememberRecent) addRecent(channel.id)
  renderVirtualRows()
  renderChannelDetail(channel)
  renderSources(channel)
  clearPlaybackDiagnostic()
  if (!autoplay) updateChannelHealth('not-checked')
  announce(`已选择频道 ${channel.name}`)

  const preferred = preferredSource(channel)
  if (autoplay && preferred) playSource(preferred.source, preferred.index)
  syncChannelDial()
  if (autoplay) closeSidebar()
}

function renderChannelDetail(channel: CatalogChannel): void {
  elements.channelTitle.textContent = channel.name
  const metaText = document.createElement('span')
  metaText.textContent = `${channel.flag} ${displayCountryName(channel.countryCode, channel.countryName)} · ${channel.categoryNames.join(' / ') || '综合频道'}`.trim()
  const metaNodes: Node[] = [metaText]
  if (hasVerifiedOfficialSource(channel)) metaNodes.push(createOfficialBadge('含官方源'))
  elements.channelMeta.replaceChildren(...metaNodes)
  if (catalog?.source === 'offline-sample') {
    elements.channelDescription.textContent = `${channel.sources.length} 条内置演示线路 · 不代表真实频道或直播源`
  } else {
    elements.channelDescription.textContent = channel.network
      ? `${channel.network} · ${channel.sources.length} 条第三方直播线路`
      : `${channel.sources.length} 条第三方直播线路 · 线路状态可能随时变化`
  }
  elements.detailLogo.replaceWith(createDetailLogo(channel))
  elements.detailLogo = required<HTMLElement>('#detail-logo')
  updateFavoriteButton()
  elements.sourceHelp.textContent = `${channel.sources.length} 条浏览器兼容线路；线路自身失败时自动切换，本机断网时保留当前线路。`
}

function createDetailLogo(channel: CatalogChannel): HTMLElement {
  const logo = createLogo(channel, 'detail-logo')
  logo.id = 'detail-logo'
  logo.setAttribute('aria-hidden', 'true')
  return logo
}

function createLogo(channel: CatalogChannel, className: string): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.className = className
  const fallback = document.createElement('span')
  fallback.className = 'logo-fallback'
  fallback.textContent = channel.flag || initials(channel.name)
  wrapper.append(fallback)
  if (remoteLogoController.enabled && channel.logoUrl) {
    const image = document.createElement('img')
    image.dataset.remoteLogo = 'true'
    image.alt = ''
    image.loading = 'lazy'
    image.referrerPolicy = 'no-referrer'
    image.hidden = true
    wrapper.append(image)
    remoteLogoController.attach(wrapper, image, channel.logoUrl)
  }
  return wrapper
}

function syncSafetyControls(): void {
  elements.familySafetyToggle.checked = familySafetyEnabled
  elements.familySafetyToggle.disabled = refreshInProgress || catalogSyncActive
  elements.remoteLogoToggle.checked = remoteLogosEnabled
  elements.remoteLogoToggle.disabled = familySafetyEnabled
  elements.remoteLogoHelp.textContent = familySafetyEnabled
    ? '家庭安全模式已锁定为关闭；台标只使用本地文字或旗帜占位。'
    : '开启后，台标主机会收到由本机发出的图片请求。'
  elements.safetyBadgeLabel.textContent = familySafetyEnabled ? '家庭安全 · 本地允许列表' : '按上游标记过滤'
  elements.app.dataset.familySafety = String(familySafetyEnabled)
}

function applySafetyState(state: SafetyStateSnapshot): void {
  familySafetyEnabled = state.familySafety
  remoteLogosEnabled = state.remoteLogos
  remoteLogoController.setEnabled(remoteLogosEnabled)
  syncSafetyControls()
}

function disableRemoteLogos(): void {
  remoteLogosEnabled = false
  remoteLogoController.setEnabled(false)
  syncSafetyControls()
}

function enforceFamilyLocalState(): void {
  disableRemoteLogos()
  selectedChannelId = ''
  healthRecordedForLoad = false
  player.stop()
  if (!viewing.clearWatching()) throw new Error('观看记录未能完整清除，请重试或重新启动应用')
}

async function updateFamilySafetyPreference(): Promise<void> {
  if (refreshInProgress) {
    elements.familySafetyToggle.checked = familySafetyEnabled
    showToast('目录更新完成后再切换家庭安全模式')
    return
  }

  const requested = elements.familySafetyToggle.checked
  if (requested === familySafetyEnabled) return
  const generation = catalogRequests.begin()
  refreshInProgress = true
  // Withdraw every old selection route before an asynchronous safety transition.
  player.stop()
  catalog = undefined
  catalogRequests.clear()
  channelList.clear()
  syncChannelDial()
  delete elements.app.dataset.catalogSource
  delete elements.app.dataset.catalogCount
  elements.channelTitle.textContent = '正在切换频道目录…'
  elements.channelMeta.replaceChildren()
  elements.channelDescription.textContent = ''
  elements.sourceList.replaceChildren()
  elements.sourceHelp.textContent = ''
  setCatalogControlsEnabled(false)
  elements.refreshCatalog.disabled = true
  beginCatalogSync(requested ? '正在加载家庭安全目录…' : '正在恢复完整目录…')
  syncSafetyControls()

  try {
    const transition = await safetyClient.setFamilySafety(requested)
    applySafetyState(transition.state)
    if (transition.state.pendingViewingDataClear) {
      enforceFamilyLocalState()
      applySafetyState(await safetyClient.acknowledgeCleanup(transition.state.transitionId))
    }
    elements.catalogState.textContent = familySafetyEnabled ? '正在加载家庭安全目录…' : '正在恢复完整目录…'
    const response = await window.tvFeed.loadCatalog(catalogRequests.command('refresh', generation))
    if (!catalogRequests.isCurrent(generation)) return
    if (response.ok) {
      applyCatalog(response.result)
      const message = familySafetyEnabled
        ? `家庭安全模式已开启；仅显示本地允许列表。${transition.warning}`
        : '家庭安全模式已关闭；已恢复保守过滤后的目录。'
      setPrivacyStatus(message)
      showToast(familySafetyEnabled ? '家庭安全模式已开启' : '家庭安全模式已关闭')
    } else {
      showCatalogFailure(response.failure)
      setPrivacyStatus(`${response.failure.title}。${transition.warning}`)
    }
  } catch (error) {
    if (!catalogRequests.isCurrent(generation)) return
    elements.familySafetyToggle.checked = familySafetyEnabled
    showCatalogFailure(unexpectedCatalogFailure(error))
    const message = `切换家庭安全模式后目录加载失败：${errorMessage(error)}`
    setPrivacyStatus(message)
    showToast(message, 7000)
  } finally {
    if (catalogRequests.isCurrent(generation)) {
      refreshInProgress = false
      elements.refreshCatalog.disabled = false
      syncSafetyControls()
    }
  }
}

async function updateRemoteLogoPreference(): Promise<void> {
  if (familySafetyEnabled) {
    disableRemoteLogos()
    setPrivacyStatus('家庭安全模式下不能开启远程台标。')
    showToast('家庭安全模式已阻止远程台标')
    return
  }
  const requested = elements.remoteLogoToggle.checked
  try {
    applySafetyState(await safetyClient.setRemoteLogos(requested))
    renderVirtualRows()
    const channel = getChannel(selectedChannelId)
    if (channel) renderChannelDetail(channel)

    const message = remoteLogosEnabled
      ? '远程台标已开启；台标图片将由本机直接请求第三方主机。'
      : '远程台标已关闭；频道列表将只显示本地文字或旗帜占位。'
    setPrivacyStatus(message)
    showToast(remoteLogosEnabled ? '已开启远程台标' : '已关闭远程台标')
  } catch (error) {
    elements.remoteLogoToggle.checked = remoteLogosEnabled
    const message = `远程台标设置失败：${errorMessage(error)}`
    setPrivacyStatus(message)
    showToast(message, 6000)
  }
}

async function clearCatalogCacheFromSettings(): Promise<void> {
  elements.clearCatalogCache.disabled = true
  try {
    const cleared = await window.tvFeed.clearCatalogCache()
    const message = cleared
      ? '目录缓存已删除。当前列表会保留到本次运行结束；刷新或下次启动时将重新加载目录。'
      : '当前没有可清除的目录缓存。'
    setPrivacyStatus(message)
    showToast(cleared ? '目录缓存已清除' : '没有可清除的目录缓存')
  } catch (error) {
    const message = `清除目录缓存失败：${errorMessage(error)}`
    setPrivacyStatus(message)
    showToast(message, 6000)
  } finally {
    elements.clearCatalogCache.disabled = false
  }
}

function clearViewingDataFromSettings(): void {
  const cleared = viewing.clearAll()
  healthRecordedForLoad = false
  updateFavoriteButton()
  if (viewMode === 'favorites' || viewMode === 'recent') applyFilters()
  else renderVirtualRows()

  const message = cleared ? '收藏、最近观看、上次频道和线路稳定记录已从本机清除。' : '部分观看记录未能清除，请重试。'
  setPrivacyStatus(message)
  showToast(cleared ? '本地观看记录已清除' : '观看记录清理未完成')
}

function setPrivacyStatus(message: string): void {
  elements.privacyStatus.textContent = message
}

function renderSources(channel: CatalogChannel): void {
  const nodes = channel.sources.map((source, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'source-button'
    button.dataset.sourceButton = 'true'
    button.setAttribute('aria-pressed', String(index === activeSourceIndex && player.hasSource))
    const label = sourceLabel(source, index)
    const verifiedOfficial = isVerifiedOfficialSource(channel, source)
    button.append(document.createTextNode(label))
    if (verifiedOfficial) button.append(createOfficialBadge())
    button.title = verifiedOfficial ? `${label}（已核对官方主机）` : label
    button.setAttribute('aria-label', verifiedOfficial ? `${label}，官方源` : label)
    button.addEventListener('click', () => {
      resetNetworkRecovery()
      failedSources = new Set()
      playSource(source, index)
    })
    return button
  })
  elements.sourceList.replaceChildren(...nodes)
}

function playSource(source: CatalogSource, index: number, preserveDiagnostic = false): void {
  const channel = getChannel(selectedChannelId)
  if (!channel) return
  playbackAttemptGeneration += 1
  cancelPendingNetworkRecovery()
  activeSourceIndex = index
  addRecent(channel.id)
  elements.playerEmpty.hidden = true
  elements.nowPlaying.hidden = false
  elements.sourceQuality.textContent = source.quality
  if (!preserveDiagnostic) clearPlaybackDiagnostic()
  updateChannelHealth('checking')
  updateSourceButtons()
  healthRecordedForLoad = false
  player.load(source, channel.id, true)
}

function updateSourceButtons(): void {
  for (const [index, button] of [...elements.sourceList.querySelectorAll<HTMLButtonElement>('[data-source-button]')].entries()) {
    button.setAttribute('aria-pressed', String(index === activeSourceIndex && player.hasSource))
  }
}

function preferredSource(channel: CatalogChannel, excludedSourceIds: ReadonlySet<string> = new Set()) {
  return rankSources(channel.sources, viewing.health, excludedSourceIds)[0]
}

function handlePlaybackMetrics(snapshot: PlaybackMetricsSnapshot): void {
  if (snapshot.sourceId) elements.video.dataset.playbackMetrics = JSON.stringify(snapshot)
  else delete elements.video.dataset.playbackMetrics
  if (healthRecordedForLoad || !snapshot.sourceId || snapshot.startupMs === null || snapshot.mediaAdvancedSeconds < 15) return
  const channel = getChannel(selectedChannelId)
  const activeSource = channel?.sources[activeSourceIndex]
  if (!activeSource || activeSource.id !== snapshot.sourceId || elements.video.paused || elements.video.readyState < 2) return

  const observationMs = snapshot.mediaAdvancedSeconds * 1_000 + snapshot.stallDurationMs
  const stallRatio = observationMs > 0 ? snapshot.stallDurationMs / observationMs : 0
  if (stallRatio > 0.05 || (snapshot.droppedFrameRatio ?? 0) > 0.02) return
  viewing.recordSuccess(activeSource.id, {
    startupMs: snapshot.startupMs,
    stallRatio
  })
  healthRecordedForLoad = true
}

async function handleFatalSource(failedSource: CatalogSource, diagnostic: PlaybackDiagnostic): Promise<void> {
  const failedAttemptGeneration = playbackAttemptGeneration
  let effectiveDiagnostic = diagnostic
  if (shouldConfirmLocalNetwork(diagnostic)) {
    try {
      if (!await window.tvFeed.isNetworkOnline()) {
        effectiveDiagnostic = classifyPlaybackDiagnostic(
          playbackDiagnosticInputForRemoteFailure('network-unavailable')
        )
      }
    } catch {
      // A failed status check must not suppress the original source failure.
    }
  }

  if (failedAttemptGeneration !== playbackAttemptGeneration) return
  const channel = getChannel(selectedChannelId)
  const current = channel?.sources[activeSourceIndex]
  if (!channel || !current || current.id !== failedSource.id) return
  renderPlaybackDiagnostic(effectiveDiagnostic)
  if (effectiveDiagnostic.code === 'network-unavailable') {
    updatePlaybackState('waiting-network', effectiveDiagnostic.message)
    networkRecovery.suspend({ channelId: channel.id, sourceId: current.id, sourceIndex: activeSourceIndex })
    updateChannelHealth('waiting-network')
    scheduleNetworkRecoveryCheck()
    showToast('网络暂时不可用，已暂停自动切换线路', 6000)
    return
  }
  resetNetworkRecovery()
  viewing.recordFailure(current.id)
  failedSources.add(current.id)
  const next = preferredSource(channel, failedSources)
  if (next) {
    showToast(`${effectiveDiagnostic.title}，正在尝试线路 ${next.index + 1}`)
    playSource(next.source, next.index, true)
    return
  }
  updatePlaybackState('error', `${effectiveDiagnostic.title}：${effectiveDiagnostic.message}`)
  showToast(`所有线路均连接失败；最后一次：${effectiveDiagnostic.title}`, 6000)
}

function shouldConfirmLocalNetwork(diagnostic: PlaybackDiagnostic): boolean {
  return diagnostic.code === 'dns-failure' ||
    diagnostic.code === 'source-timeout' ||
    diagnostic.code === 'source-offline'
}

function scheduleNetworkRecoveryCheck(): void {
  if (networkRecoveryTimer !== undefined || !networkRecovery.shouldSchedule(Date.now())) return
  networkRecoveryTimer = window.setTimeout(() => {
    networkRecoveryTimer = undefined
    void retryPendingNetworkPlayback('scheduled')
  }, NETWORK_RECOVERY_DELAY_MS)
}

async function retryPendingNetworkPlayback(trigger: 'manual' | 'online' | 'scheduled'): Promise<boolean> {
  const pending = networkRecovery.snapshot()
  if (!pending) return false
  if (networkRecoveryCheckGeneration === pending.generation) return true
  networkRecoveryCheckGeneration = pending.generation

  let confirmedOnline = false
  try {
    confirmedOnline = await window.tvFeed.isNetworkOnline()
  } catch {
    if (trigger === 'manual') showToast('暂时无法确认网络状态，请稍后再试')
    return true
  } finally {
    if (networkRecoveryCheckGeneration === pending.generation) networkRecoveryCheckGeneration = undefined
  }

  const target = networkRecovery.claim(pending, confirmedOnline, currentNetworkTarget(), Date.now())
  if (!confirmedOnline) {
    if (trigger === 'manual') showToast('网络仍不可用，请检查 Wi-Fi、VPN 或系统代理', 6000)
    return true
  }
  if (!target) return true

  const channel = getChannel(target.channelId)
  const source = channel?.sources[target.sourceIndex]
  if (!channel || !source || source.id !== target.sourceId) return true
  showToast('正在重新连接当前线路')
  playSource(source, target.sourceIndex)
  return true
}

function currentNetworkTarget(): PlaybackNetworkTarget | undefined {
  const channel = getChannel(selectedChannelId)
  const source = channel?.sources[activeSourceIndex]
  return channel && source
    ? { channelId: channel.id, sourceId: source.id, sourceIndex: activeSourceIndex }
    : undefined
}

function cancelPendingNetworkRecovery(): void {
  if (networkRecoveryTimer !== undefined) window.clearTimeout(networkRecoveryTimer)
  networkRecoveryTimer = undefined
  networkRecovery.cancelPending()
}

function resetNetworkRecovery(): void {
  if (networkRecoveryTimer !== undefined) window.clearTimeout(networkRecoveryTimer)
  networkRecoveryTimer = undefined
  networkRecovery.reset()
}

function updatePlaybackState(state: PlaybackState, message: string): void {
  const powered = state !== 'idle'
  elements.app.dataset.power = powered ? 'on' : 'off'
  elements.stop.setAttribute('aria-pressed', String(powered))
  elements.stop.setAttribute('aria-label', powered ? '关闭电视' : '打开电视')
  elements.stop.title = powered ? '关闭电视' : '打开电视'
  const labels: Record<PlaybackState, string> = {
    idle: '待机', loading: '连接中', playing: '播放中', paused: '已暂停',
    'waiting-network': '等待网络', error: '信号中断'
  }
  elements.powerLabel.textContent = labels[state]
  elements.togglePlay.classList.toggle('is-playing', state === 'playing')
  elements.togglePlay.setAttribute('aria-label', state === 'playing' ? '暂停' : '播放')
  elements.playerStatus.classList.toggle('error', state === 'error')
  elements.playerStatus.hidden = state === 'idle' || state === 'playing' || (state === 'paused' && !message)
  elements.playerStatusText.textContent = message || (state === 'paused' ? '已暂停' : '')
  if (state === 'loading') updateChannelHealth('checking')
  else if (state === 'playing') {
    resetNetworkRecovery()
    updateChannelHealth('playable')
    clearPlaybackDiagnostic()
  } else if (state === 'paused') updateChannelHealth('connected')
  else if (state === 'waiting-network') updateChannelHealth('waiting-network')
  else if (state === 'error') updateChannelHealth('unavailable')
  else updateChannelHealth('not-checked')
  if (state === 'idle' || state === 'error') {
    elements.nowPlaying.hidden = true
  } else if (state === 'waiting-network') {
    elements.nowPlaying.hidden = false
  }
  if (state === 'idle') {
    playbackAttemptGeneration += 1
    resetNetworkRecovery()
    updateSourceButtons()
  }
}

async function togglePlayback(): Promise<void> {
  if (await retryPendingNetworkPlayback('manual')) return
  const channel = getChannel(selectedChannelId) ?? channelList.channels[0]
  if (!channel) {
    showToast('当前筛选条件下没有可播放频道')
    openSidebar()
    return
  }
  if (channel.id !== selectedChannelId) selectChannel(channel.id, false, false)
  if (!player.hasSource) {
    failedSources = new Set()
    const preferred = preferredSource(channel)
    const source = channel.sources[activeSourceIndex] ?? preferred?.source
    if (source) playSource(source, channel.sources.indexOf(source))
    return
  }
  await player.toggle()
}

function stopPlayback(): void {
  resetNetworkRecovery()
  player.stop()
  failedSources = new Set()
  elements.playerEmpty.hidden = false
  clearPlaybackDiagnostic()
  updateChannelHealth('not-checked')
  updateSourceButtons()
}

function moveChannel(direction: -1 | 1): void {
  if (channelList.channels.length === 0) return
  const currentIndex = channelList.channels.findIndex((channel) => channel.id === selectedChannelId)
  const base = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0
  const targetIndex = (base + direction + channelList.channels.length) % channelList.channels.length
  const channel = channelList.channels[targetIndex]
  if (!channel) return
  selectChannel(channel.id, true, true)
  ensureChannelVisible(targetIndex)
}

function toggleFavorite(channelId: string): void {
  if (!channelId || !getChannel(channelId)) return
  showToast(viewing.toggleFavorite(channelId) ? '已加入收藏' : '已取消收藏')
  updateFavoriteButton()
  if (viewMode === 'favorites') applyFilters()
  else renderVirtualRows()
}

function updateFavoriteButton(): void {
  const active = viewing.favorites.has(selectedChannelId)
  elements.favorite.setAttribute('aria-pressed', String(active))
  const label = elements.favorite.querySelector('span')
  if (label) label.textContent = active ? '已收藏' : '收藏'
}

function addRecent(channelId: string): void {
  viewing.remember(channelId)
  if (viewMode === 'recent') applyFilters()
}

function setViewMode(mode: ViewMode): void {
  viewMode = mode
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === mode))
  }
  applyFilters()
}

async function togglePictureInPicture(): Promise<void> {
  try {
    await player.togglePictureInPicture()
  } catch (error) {
    showToast(errorMessage(error))
  }
}

async function toggleFullscreen(): Promise<void> {
  if (fullscreenTransitionInProgress) return
  const requested = !elements.app.classList.contains('player-fullscreen')
  fullscreenTransitionInProgress = true
  elements.fullscreen.disabled = true
  try {
    if (requested) { closeSidebar(); closeSources() }
    const fullscreen = await window.tvFeed.setPlayerFullscreen(requested)
    syncFullscreenControl(fullscreen)
    if (fullscreen !== requested) showToast(requested ? '系统未能进入全屏' : '系统未能退出全屏')
  } catch (error) {
    showToast(`无法切换全屏：${errorMessage(error)}`)
  } finally {
    fullscreenTransitionInProgress = false
    elements.fullscreen.disabled = false
  }
}

function syncFullscreenControl(fullscreen: boolean): void {
  elements.app.classList.toggle('player-fullscreen', fullscreen)
  elements.fullscreen.classList.toggle('is-fullscreen', fullscreen)
  elements.fullscreen.setAttribute('aria-label', fullscreen ? '退出全屏' : '全屏')
  elements.fullscreen.title = fullscreen ? '退出全屏（F 或 Esc）' : '全屏（F）'
}

function openSidebar(): void {
  closeSources()
  elements.app.classList.add('sidebar-open')
  syncSidebarState()
  renderVirtualRows()
  // Transfer focus once the screen menu has finished entering, including when
  // reduced motion cancels or shortens its transition.
  void Promise.allSettled(elements.channelPane.getAnimations().map((animation) => animation.finished)).then(() => {
    if (elements.infoDialog.open || !elements.app.classList.contains('sidebar-open')) return
    const target = elements.search.disabled ? elements.retryCatalog : elements.search
    target.focus({ preventScroll: true })
  })
}

function closeSidebar(): void {
  const returnFocus = elements.channelPane.contains(document.activeElement)
  elements.app.classList.remove('sidebar-open')
  syncSidebarState()
  if (returnFocus) elements.sidebarToggle.focus({ preventScroll: true })
}

function syncSidebarState(): void {
  const visible = elements.app.classList.contains('sidebar-open')
  elements.sidebarToggle.setAttribute('aria-expanded', String(visible))
  elements.sidebarToggle.setAttribute('aria-label', visible ? '关闭频道目录' : '打开频道目录')
  elements.sidebarToggle.title = visible ? '关闭频道目录' : '打开频道目录（/）'
  elements.channelPane.inert = !visible
}

function syncChannelDial(): void {
  const index = channelList.channels.findIndex((channel) => channel.id === selectedChannelId)
  channelDial.sync(Math.max(1, index + 1), channelList.channels.length)
  if (index < 0) elements.channelNumber.value = '—'
}

function syncSettingsBounds(): void {
  const screen = elements.playerStage.getBoundingClientRect()
  for (const [name, value] of Object.entries({
    left: screen.left + 12, top: screen.top + 12,
    width: Math.max(0, screen.width - 24), height: Math.max(0, screen.height - 24)
  })) elements.infoDialog.style.setProperty(`--dialog-${name}`, `${value}px`)
}

function syncVolumeControl(): void {
  const { percent, muted } = player.volumeState
  volumeDial.sync(percent)
  elements.mute.setAttribute('aria-pressed', String(muted))
  elements.mute.setAttribute('aria-label', muted ? '取消静音' : '静音')
  elements.mute.title = muted ? '取消静音（M）' : '静音（M）'
  const icon = elements.mute.querySelector('i')
  if (icon) icon.className = muted ? 'ph ph-speaker-slash' : 'ph ph-speaker-high'
}

function toggleSources(): void {
  if (closeSources()) return
  closeSidebar()
  elements.sourcePanel.hidden = false
  elements.sourceToggle.setAttribute('aria-expanded', 'true')
  const target = elements.sourceList.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? elements.sourceClose
  target.focus({ preventScroll: true })
}

function closeSources(): boolean {
  if (elements.sourcePanel.hidden) return false
  const returnFocus = elements.sourcePanel.contains(document.activeElement)
  elements.sourcePanel.hidden = true
  elements.sourceToggle.setAttribute('aria-expanded', 'false')
  if (returnFocus) elements.sourceToggle.focus({ preventScroll: true })
  return true
}

function showCatalogFailure(failure: CatalogLoadFailure): void {
  catalogSyncActive = false
  catalog = undefined
  catalogRequests.clear()
  delete elements.app.dataset.catalogSource
  delete elements.app.dataset.catalogCount
  channelList.clear()
  syncChannelDial()
  player.stop()
  catalogStatus.showFailure(failure)
  openSidebar()
  showToast(`${failure.title}，可以重新尝试或主动打开离线演示`, 7000)
}

function beginCatalogSync(message: string): void {
  catalogSyncActive = true
  catalogStatus.begin(message, Boolean(catalog))
}

function updateCatalogProgress(progress: CatalogSyncProgress): void {
  if (!catalogSyncActive || !catalogRequests.acceptsProgress(progress)) return
  catalogStatus.progress(progress, Boolean(catalog))
}

async function openOfflineDemo(): Promise<void> {
  if (refreshInProgress) return
  const generation = catalogRequests.begin()
  refreshInProgress = true
  elements.retryCatalog.disabled = true
  elements.openOfflineDemo.disabled = true
  elements.refreshCatalog.disabled = true
  beginCatalogSync('正在打开离线演示…')
  try {
    const result = await window.tvFeed.loadOfflineDemo()
    if (!catalogRequests.isCurrent(generation)) return
    applyCatalog(result)
    showToast('已打开离线演示；这些是虚构样例，不是 iptv-org 真实频道')
  } catch (error) {
    if (catalogRequests.isCurrent(generation)) showCatalogFailure(unexpectedCatalogFailure(error))
  } finally {
    if (catalogRequests.isCurrent(generation)) {
      refreshInProgress = false
      elements.retryCatalog.disabled = false
      elements.openOfflineDemo.disabled = false
      elements.refreshCatalog.disabled = false
    }
  }
}

function unexpectedCatalogFailure(error: unknown): CatalogLoadFailure {
  return {
    code: 'unknown',
    title: '频道目录加载失败',
    message: '应用没有收到可用的频道目录结果，请重新尝试。',
    detail: errorMessage(error),
    retryable: true
  }
}

function getChannel(channelId: string): CatalogChannel | undefined {
  return catalogRequests.channel(channelId)
}

function sourceLabel(source: CatalogSource, index: number): string {
  const details = [source.quality, source.label, source.feed].filter(Boolean).join(' / ')
  return `线路 ${index + 1}${details ? ` / ${details}` : ''}`
}

function createOfficialBadge(label = '官方源'): HTMLElement {
  const badge = document.createElement('span')
  badge.className = 'official-source-badge'
  badge.textContent = label
  badge.title = '频道 ID 与当前线路主机均经过人工核对'
  return badge
}

type ChannelHealthState = 'not-checked' | 'checking' | 'playable' | 'connected' | 'waiting-network' | 'unavailable'

function updateChannelHealth(state: ChannelHealthState): void {
  const labels: Record<ChannelHealthState, string> = {
    'not-checked': '选择并播放后检测',
    checking: '正在检测当前线路',
    playable: '当前线路可播放',
    connected: '当前线路已连接',
    'waiting-network': '等待网络恢复',
    unavailable: '当前线路不可用'
  }
  elements.channelHealth.dataset.state = state
  elements.channelHealth.textContent = labels[state]
}

function renderPlaybackDiagnostic(diagnostic: PlaybackDiagnostic): void {
  elements.playbackDiagnostic.hidden = false
  elements.playbackDiagnostic.dataset.code = diagnostic.code
  elements.playbackDiagnostic.replaceChildren()
  const title = document.createElement('strong')
  title.textContent = diagnostic.title
  const message = document.createElement('span')
  message.textContent = diagnostic.message
  elements.playbackDiagnostic.append(title, message)
}

function clearPlaybackDiagnostic(): void {
  elements.playbackDiagnostic.hidden = true
  delete elements.playbackDiagnostic.dataset.code
  elements.playbackDiagnostic.replaceChildren()
}

function announceVolume(state: Readonly<{ muted: boolean; percent: number }>): void {
  const message = state.muted ? '已静音' : `音量 ${state.percent}%`
  announce(message)
  showToast(message)
}

function announce(message: string): void {
  if (announcementTimer !== undefined) window.clearTimeout(announcementTimer)
  elements.announcementRegion.textContent = ''
  announcementTimer = window.setTimeout(() => {
    elements.announcementRegion.textContent = message
    announcementTimer = undefined
  }, 20)
}

function emptyMessage(): string {
  if (viewMode === 'favorites') return viewing.favorites.size > 0
    ? '当前目录或筛选条件下没有可显示的收藏。已保存的收藏仍然保留，可以更新目录或清除筛选后再查看。'
    : '还没有收藏频道。打开任一频道后，点击右侧的收藏按钮。'
  if (viewMode === 'recent') return viewing.recents.length > 0
    ? '当前目录或筛选条件下没有可显示的观看记录。已保存的记录仍然保留。'
    : '最近观看为空。播放过的频道会自动出现在这里。'
  return '没有找到符合条件的频道，请换个关键词或清除筛选。'
}

function createStarIcon(): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.className = 'favorite-icon'
  wrapper.setAttribute('aria-hidden', 'true')
  const outline = document.createElement('i')
  outline.className = 'ph ph-star'
  const filled = document.createElement('i')
  filled.className = 'ph-fill ph-star'
  wrapper.append(outline, filled)
  return wrapper
}

function showToast(message: string, duration = 3200): void {
  if ([...elements.toastRegion.querySelectorAll<HTMLElement>('.toast')].some((toast) => toast.textContent === message)) return
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.textContent = message
  elements.toastRegion.append(toast)
  window.setTimeout(() => toast.remove(), duration)
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`页面缺少必要元素：${selector}`)
  return element
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function initials(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toLocaleUpperCase() || 'TV'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
