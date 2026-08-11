import { applyFamilySafetyAllowlist } from '../../shared/catalog.ts'
import {
  appendChannelNumberDigit,
  CHANNEL_NUMBER_COMMIT_DELAY_MS,
  channelIndexForNumber,
  hasLongerChannelNumber
} from '../../shared/channel-shortcuts.ts'
import type {
  CacheStatus,
  Catalog,
  CatalogChannel,
  CatalogLoadFailure,
  CatalogLoadResult,
  CatalogSource,
  CatalogSyncProgress
} from '../../shared/contracts.ts'
import { displayCountryName, getCountrySearchAliases, sortCountriesForDisplay } from '../../shared/countries.ts'
import { hasVerifiedOfficialSource, isVerifiedOfficialSource } from '../../shared/official-sources.ts'
import type { PlaybackDiagnostic } from '../../shared/playback-diagnostics.ts'
import { StreamPlayer, type PlaybackState } from './player.ts'

type ViewMode = 'all' | 'chinese' | 'favorites' | 'recent'

const ROW_HEIGHT = 76
const OVERSCAN = 7
const FAVORITES_KEY = 'tvfeed:favorites:v1'
const RECENTS_KEY = 'tvfeed:recents:v1'
const LAST_CHANNEL_KEY = 'tvfeed:last-channel:v1'
const REMOTE_LOGOS_KEY = 'tvfeed:remote-logos:v1'
const FAMILY_SAFETY_KEY = 'tvfeed:family-safety:v1'
const CHINESE_REGIONS = new Set(['CN', 'HK', 'TW', 'MO'])
const MAX_CONCURRENT_LOGO_REQUESTS = 4
const MAX_PENDING_LOGO_REQUESTS = 64
const compactSidebarQuery = window.matchMedia('(max-width: 1040px)')

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

let catalog: Catalog | undefined
let filteredChannels: CatalogChannel[] = []
let selectedChannelId = readStoredString(LAST_CHANNEL_KEY)
let activeSourceIndex = 0
let viewMode: ViewMode = 'all'
let favorites = new Set(readStoredArray(FAVORITES_KEY))
let recents = readStoredArray(RECENTS_KEY)
let failedSources = new Set<string>()
let refreshInProgress = false
let catalogSyncActive = false
let familySafetyEnabled = readStoredBoolean(FAMILY_SAFETY_KEY)
let remoteLogosEnabled = !familySafetyEnabled && readStoredBoolean(REMOTE_LOGOS_KEY)
let currentCacheStatus: CacheStatus = 'offline-sample'
let logoRequestSequence = 0
let activeLogoRequests = 0
let channelNumberBuffer = ''
let channelNumberTimer: number | undefined
let announcementTimer: number | undefined
let fullscreenTransitionInProgress = false
const logoQueue: Array<() => Promise<void>> = []
const activeLogoRequestIds = new Set<string>()
const activeLogoObjectUrls = new Set<string>()

const player = new StreamPlayer(elements.video, {
  onState: updatePlaybackState,
  onFatal: handleFatalSource
})

bindEvents()
void initialize()

async function initialize(): Promise<void> {
  catalogSyncActive = true
  try {
    if (familySafetyEnabled) enforceFamilyLocalState()
    const response = await window.tvFeed.loadCatalog(false, familySafetyEnabled)
    if (response.ok) applyCatalog(response.result)
    else showCatalogFailure(response.failure)
  } catch (error) {
    showCatalogFailure(unexpectedCatalogFailure(error))
  } finally {
    catalogSyncActive = false
    elements.loadingList.hidden = true
    elements.app.dataset.appReady = 'true'
    window.tvFeed.signalRendererReady()
  }
}

function bindEvents(): void {
  syncSafetyControls()
  elements.search.addEventListener('input', applyFilters)
  elements.country.addEventListener('change', applyFilters)
  elements.category.addEventListener('change', applyFilters)
  elements.channelList.addEventListener('scroll', renderVirtualRows, { passive: true })

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
  elements.stop.addEventListener('click', stopPlayback)
  elements.favorite.addEventListener('click', () => toggleFavorite(selectedChannelId))
  elements.pip.addEventListener('click', () => void togglePictureInPicture())
  elements.fullscreen.addEventListener('click', () => void toggleFullscreen())
  window.tvFeed.onPlayerFullscreenChange(syncFullscreenControl)

  elements.sidebarToggle.addEventListener('click', openSidebar)
  elements.sidebarClose.addEventListener('click', closeSidebar)
  elements.drawerScrim.addEventListener('click', closeSidebar)
  compactSidebarQuery.addEventListener('change', resetSidebarForViewport)

  elements.catalogInfo.addEventListener('click', () => elements.infoDialog.showModal())
  elements.dialogClose.addEventListener('click', () => elements.infoDialog.close())
  elements.familySafetyToggle.addEventListener('change', () => void updateFamilySafetyPreference())
  elements.remoteLogoToggle.addEventListener('change', updateRemoteLogoPreference)
  elements.clearCatalogCache.addEventListener('click', () => void clearCatalogCacheFromSettings())
  elements.clearViewingData.addEventListener('click', clearViewingDataFromSettings)
  elements.infoDialog.addEventListener('click', (event) => {
    if (event.target === elements.infoDialog) elements.infoDialog.close()
  })

  document.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('resize', renderVirtualRows)
  new ResizeObserver(renderVirtualRows).observe(elements.channelList)
  syncSidebarState()
  syncFullscreenControl(false)
}

function applyCatalog(result: CatalogLoadResult): void {
  catalogSyncActive = false
  setCatalogFailureVisible(false)
  setCatalogControlsEnabled(true)
  elements.loadingList.hidden = true
  catalog = result.catalog
  elements.app.dataset.catalogSource = result.catalog.source
  elements.app.dataset.catalogCount = String(result.catalog.channels.length)
  populateFacets(result.catalog)
  renderCatalogStats(result.catalog)
  updateCatalogStatus(result.cacheStatus, result.catalog.channels.length)

  const knownIds = new Set(result.catalog.channels.map((channel) => channel.id))
  if (!familySafetyEnabled) favorites = new Set([...favorites].filter((id) => knownIds.has(id)))
  recents = recents.filter((id) => knownIds.has(id)).slice(0, 100)
  if (familySafetyEnabled) writeStoredArray(RECENTS_KEY, recents)
  else persistCollections()

  applyFilters()
  const initial = getChannel(selectedChannelId) ?? filteredChannels[0] ?? result.catalog.channels[0]
  if (initial) {
    selectChannel(initial.id, false, false)
    const initialIndex = filteredChannels.findIndex((channel) => channel.id === initial.id)
    if (initialIndex >= 0) ensureChannelVisible(initialIndex)
  }

  if (result.warning) showToast(result.warning, 7000)
}

async function refreshCatalog(): Promise<void> {
  if (refreshInProgress) return
  refreshInProgress = true
  elements.refreshCatalog.disabled = true
  elements.retryCatalog.disabled = true
  elements.openOfflineDemo.disabled = true
  syncSafetyControls()
  beginCatalogSync('正在从 iptv-org 更新…')
  try {
    const response = await window.tvFeed.loadCatalog(true, familySafetyEnabled)
    if (response.ok) {
      applyCatalog(response.result)
      showToast(response.result.cacheStatus === 'network' ? '频道目录已更新' : '已重新载入频道目录')
    } else {
      showCatalogFailure(response.failure)
    }
  } catch (error) {
    showCatalogFailure(unexpectedCatalogFailure(error))
  } finally {
    refreshInProgress = false
    elements.refreshCatalog.disabled = false
    elements.retryCatalog.disabled = false
    elements.openOfflineDemo.disabled = false
    syncSafetyControls()
  }
}

function populateFacets(value: Catalog): void {
  replaceSelectOptions(
    elements.country,
    '所有地区',
    sortCountriesForDisplay(value.countries).map((country) => ({
      value: country.code,
      label: `${country.flag} ${displayCountryName(country.code, country.name)} · ${formatCount(country.count)}`
    }))
  )
  replaceSelectOptions(
    elements.category,
    '所有类型',
    value.categories.map((category) => ({ value: category.id, label: `${category.name} · ${formatCount(category.count)}` }))
  )
}

function replaceSelectOptions(select: HTMLSelectElement, allLabel: string, options: Array<{ value: string; label: string }>): void {
  const previous = select.value
  const nodes: HTMLOptionElement[] = []
  const all = document.createElement('option')
  all.value = ''
  all.textContent = allLabel
  nodes.push(all)
  for (const item of options) {
    const option = document.createElement('option')
    option.value = item.value
    option.textContent = item.label
    nodes.push(option)
  }
  select.replaceChildren(...nodes)
  if (options.some((item) => item.value === previous)) select.value = previous
}

function applyFilters(): void {
  if (!catalog) return
  resetChannelNumberBuffer()
  const query = elements.search.value.trim().toLocaleLowerCase()
  const countryCode = elements.country.value
  const categoryId = elements.category.value
  const recentOrder = new Map(recents.map((id, index) => [id, index]))

  filteredChannels = catalog.channels.filter((channel) => {
    if (viewMode === 'chinese' && !CHINESE_REGIONS.has(channel.countryCode)) return false
    if (viewMode === 'favorites' && !favorites.has(channel.id)) return false
    if (viewMode === 'recent' && !recentOrder.has(channel.id)) return false
    if (countryCode && channel.countryCode !== countryCode) return false
    if (categoryId && !channel.categoryIds.includes(categoryId)) return false
    if (query && !channel.searchText.includes(query) && !getCountrySearchAliases(channel.countryCode).includes(query)) return false
    return true
  })

  if (viewMode === 'recent') {
    filteredChannels.sort((a, b) => (recentOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (recentOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }

  elements.resultCount.textContent = `${formatCount(filteredChannels.length)} 个频道`
  elements.channelList.scrollTop = 0
  elements.channelSpacer.style.height = `${filteredChannels.length * ROW_HEIGHT}px`
  renderVirtualRows()
}

function renderVirtualRows(): void {
  if (!catalog) return
  if (filteredChannels.length === 0) {
    elements.channelSpacer.style.height = '0px'
    const empty = document.createElement('div')
    empty.className = 'empty-list'
    empty.textContent = emptyMessage()
    elements.channelWindow.style.transform = 'translateY(0)'
    elements.channelWindow.replaceChildren(empty)
    return
  }

  const viewportHeight = Math.max(elements.channelList.clientHeight, ROW_HEIGHT * 6)
  const start = Math.max(0, Math.floor(elements.channelList.scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(filteredChannels.length, Math.ceil((elements.channelList.scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
  const fragment = document.createDocumentFragment()

  for (let index = start; index < end; index += 1) {
    const channel = filteredChannels[index]
    if (channel) fragment.append(createChannelRow(channel, index))
  }

  elements.channelWindow.style.transform = `translateY(${start * ROW_HEIGHT}px)`
  elements.channelWindow.replaceChildren(fragment)
}

function createChannelRow(channel: CatalogChannel, index: number): HTMLElement {
  const row = document.createElement('div')
  row.className = 'channel-row'
  row.dataset.channelRow = 'true'
  row.dataset.channelId = channel.id
  row.dataset.channelSelected = String(channel.id === selectedChannelId)
  row.setAttribute('role', 'listitem')

  const select = document.createElement('button')
  select.className = 'channel-select'
  select.type = 'button'
  select.dataset.channelIndex = String(index)
  const containsVerifiedOfficialSource = hasVerifiedOfficialSource(channel)
  select.setAttribute(
    'aria-label',
    `播放 ${channel.name}，${channel.countryName}，${channel.sources.length} 条线路${containsVerifiedOfficialSource ? '，包含人工核对的官方线路' : ''}`
  )
  select.addEventListener('click', () => selectChannel(channel.id, true, true))
  select.addEventListener('keydown', handleRowKeydown)

  const logo = createLogo(channel, 'channel-logo')
  const copy = document.createElement('span')
  copy.className = 'channel-copy'
  const name = document.createElement('span')
  name.className = 'channel-name'
  name.textContent = channel.name
  const nameLine = document.createElement('span')
  nameLine.className = 'channel-name-line'
  nameLine.append(name)
  if (containsVerifiedOfficialSource) nameLine.append(createOfficialBadge('含官方源'))
  const subtitle = document.createElement('span')
  subtitle.className = 'channel-subtitle'
  const region = document.createElement('span')
  region.textContent = `${channel.flag} ${displayCountryName(channel.countryCode, channel.countryName)}`.trim()
  const separator = document.createElement('span')
  separator.textContent = '·'
  const sourceCount = document.createElement('span')
  sourceCount.className = 'source-count'
  sourceCount.textContent = `${channel.sources.length} 线`
  subtitle.append(region, separator, sourceCount)
  copy.append(nameLine, subtitle)
  select.append(logo, copy)

  const favorite = document.createElement('button')
  favorite.className = 'row-favorite'
  favorite.type = 'button'
  favorite.setAttribute('aria-label', favorites.has(channel.id) ? `取消收藏 ${channel.name}` : `收藏 ${channel.name}`)
  favorite.setAttribute('aria-pressed', String(favorites.has(channel.id)))
  favorite.append(createStarIcon())
  favorite.addEventListener('click', () => toggleFavorite(channel.id))

  row.append(select, favorite)
  return row
}

function handleRowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const current = Number((event.currentTarget as HTMLElement).dataset.channelIndex)
  const target = clamp(current + (event.key === 'ArrowDown' ? 1 : -1), 0, filteredChannels.length - 1)
  const channel = filteredChannels[target]
  if (!channel) return
  ensureChannelVisible(target)
  requestAnimationFrame(() => {
    elements.channelWindow.querySelector<HTMLButtonElement>(`.channel-select[data-channel-index="${target}"]`)?.focus()
  })
}

function selectChannel(channelId: string, autoplay: boolean, rememberRecent: boolean): void {
  const channel = getChannel(channelId)
  if (!channel) return
  selectedChannelId = channel.id
  activeSourceIndex = 0
  failedSources = new Set()
  writeStoredString(LAST_CHANNEL_KEY, channel.id)

  if (rememberRecent) addRecent(channel.id)
  renderVirtualRows()
  renderChannelDetail(channel)
  renderSources(channel)
  clearPlaybackDiagnostic()
  if (!autoplay) updateChannelHealth('not-checked')
  announce(`已选择频道 ${channel.name}`)

  if (autoplay && channel.sources[0]) playSource(channel.sources[0], 0)
  if (window.innerWidth <= 1040 && autoplay) closeSidebar()
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
  elements.sourceHelp.textContent = `${channel.sources.length} 条浏览器兼容线路；当前线路失败时自动切换。`
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
  if (remoteLogosEnabled && channel.logoUrl) {
    const image = document.createElement('img')
    image.dataset.remoteLogo = 'true'
    image.alt = ''
    image.loading = 'lazy'
    image.referrerPolicy = 'no-referrer'
    image.hidden = true
    wrapper.append(image)
    enqueueLogoLoad(wrapper, image, channel.logoUrl)
  }
  return wrapper
}

function enqueueLogoLoad(wrapper: HTMLElement, image: HTMLImageElement, url: string): void {
  if (logoQueue.length >= MAX_PENDING_LOGO_REQUESTS) {
    image.remove()
    return
  }
  logoQueue.push(async () => {
    if (!remoteLogosEnabled || !wrapper.isConnected) return
    const requestId = `logo-${Date.now().toString(36)}-${(logoRequestSequence += 1).toString(36)}`
    activeLogoRequestIds.add(requestId)
    try {
      const response = await window.tvFeed.fetchRemoteResource({ requestId, url, kind: 'logo' })
      if (!remoteLogosEnabled || !wrapper.isConnected) return
      const objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(response.body).buffer], { type: response.contentType }))
      activeLogoObjectUrls.add(objectUrl)
      const releaseObjectUrl = (): void => {
        if (!activeLogoObjectUrls.delete(objectUrl)) return
        URL.revokeObjectURL(objectUrl)
      }
      image.addEventListener('load', () => {
        image.hidden = false
        releaseObjectUrl()
      }, { once: true })
      image.addEventListener('error', () => {
        releaseObjectUrl()
        image.remove()
      }, { once: true })
      image.src = objectUrl
    } catch {
      image.remove()
    } finally {
      activeLogoRequestIds.delete(requestId)
    }
  })
  pumpLogoQueue()
}

function pumpLogoQueue(): void {
  while (activeLogoRequests < MAX_CONCURRENT_LOGO_REQUESTS) {
    const task = logoQueue.shift()
    if (!task) return
    activeLogoRequests += 1
    void task().finally(() => {
      activeLogoRequests -= 1
      pumpLogoQueue()
    })
  }
}

function syncSafetyControls(): void {
  elements.familySafetyToggle.checked = familySafetyEnabled
  elements.familySafetyToggle.disabled = refreshInProgress
  elements.remoteLogoToggle.checked = remoteLogosEnabled
  elements.remoteLogoToggle.disabled = familySafetyEnabled
  elements.remoteLogoHelp.textContent = familySafetyEnabled
    ? '家庭安全模式已锁定为关闭；台标只使用本地文字或旗帜占位。'
    : '开启后，台标主机会收到由本机发出的图片请求。'
  elements.safetyBadgeLabel.textContent = familySafetyEnabled ? '家庭安全 · 本地允许列表' : '按上游标记过滤'
  elements.app.dataset.familySafety = String(familySafetyEnabled)
}

function clearRemoteLogoResources(): void {
  logoQueue.length = 0
  for (const requestId of activeLogoRequestIds) window.tvFeed.cancelRemoteResource(requestId)
  activeLogoRequestIds.clear()
  for (const objectUrl of activeLogoObjectUrls) URL.revokeObjectURL(objectUrl)
  activeLogoObjectUrls.clear()
  document.querySelectorAll<HTMLImageElement>('img[data-remote-logo="true"]').forEach((image) => image.remove())
}

function disableRemoteLogos(): void {
  remoteLogosEnabled = false
  writeStoredBoolean(REMOTE_LOGOS_KEY, false)
  clearRemoteLogoResources()
  syncSafetyControls()
}

function enforceFamilyLocalState(): void {
  disableRemoteLogos()
  recents = []
  selectedChannelId = ''
  removeStoredValue(RECENTS_KEY)
  removeStoredValue(LAST_CHANNEL_KEY)
  player.stop()
}

async function updateFamilySafetyPreference(): Promise<void> {
  if (refreshInProgress) {
    elements.familySafetyToggle.checked = familySafetyEnabled
    showToast('目录更新完成后再切换家庭安全模式')
    return
  }

  const requested = elements.familySafetyToggle.checked
  if (requested === familySafetyEnabled) return
  familySafetyEnabled = requested
  writeStoredBoolean(FAMILY_SAFETY_KEY, familySafetyEnabled)
  refreshInProgress = true
  elements.refreshCatalog.disabled = true
  syncSafetyControls()

  let cacheWarning = ''
  if (familySafetyEnabled) {
    enforceFamilyLocalState()
    if (catalog) {
      applyCatalog({
        catalog: applyFamilySafetyAllowlist(catalog),
        cacheStatus: currentCacheStatus,
        warning: ''
      })
    }
    try {
      await window.tvFeed.clearCatalogCache()
    } catch (error) {
      cacheWarning = `旧目录缓存未能清除：${errorMessage(error)}`
    }
  }

  elements.catalogState.textContent = familySafetyEnabled ? '正在加载家庭安全目录…' : '正在恢复完整目录…'
  try {
    const response = await window.tvFeed.loadCatalog(familySafetyEnabled, familySafetyEnabled)
    if (response.ok) {
      applyCatalog(response.result)
      const message = familySafetyEnabled
        ? `家庭安全模式已开启；仅显示本地允许列表。${cacheWarning}`
        : '家庭安全模式已关闭；已恢复保守过滤后的目录。'
      setPrivacyStatus(message)
      showToast(familySafetyEnabled ? '家庭安全模式已开启' : '家庭安全模式已关闭')
    } else {
      showCatalogFailure(response.failure)
      setPrivacyStatus(`${response.failure.title}。${cacheWarning}`)
    }
  } catch (error) {
    const message = `切换家庭安全模式后目录加载失败：${errorMessage(error)}`
    setPrivacyStatus(`${message}${cacheWarning ? `；${cacheWarning}` : ''}`)
    showToast(message, 7000)
  } finally {
    refreshInProgress = false
    elements.refreshCatalog.disabled = false
    syncSafetyControls()
  }
}

function updateRemoteLogoPreference(): void {
  if (familySafetyEnabled) {
    disableRemoteLogos()
    setPrivacyStatus('家庭安全模式下不能开启远程台标。')
    showToast('家庭安全模式已阻止远程台标')
    return
  }
  remoteLogosEnabled = elements.remoteLogoToggle.checked
  if (!remoteLogosEnabled) clearRemoteLogoResources()
  writeStoredBoolean(REMOTE_LOGOS_KEY, remoteLogosEnabled)
  syncSafetyControls()
  renderVirtualRows()
  const channel = getChannel(selectedChannelId)
  if (channel) renderChannelDetail(channel)

  const message = remoteLogosEnabled
    ? '远程台标已开启；台标图片将由本机直接请求第三方主机。'
    : '远程台标已关闭；频道列表将只显示本地文字或旗帜占位。'
  setPrivacyStatus(message)
  showToast(remoteLogosEnabled ? '已开启远程台标' : '已关闭远程台标')
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
  favorites = new Set()
  recents = []
  removeStoredValue(FAVORITES_KEY)
  removeStoredValue(RECENTS_KEY)
  removeStoredValue(LAST_CHANNEL_KEY)
  updateFavoriteButton()
  if (viewMode === 'favorites' || viewMode === 'recent') applyFilters()
  else renderVirtualRows()

  const message = '收藏、最近观看和上次频道记录已从本机清除。'
  setPrivacyStatus(message)
  showToast('本地观看记录已清除')
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
  activeSourceIndex = index
  addRecent(channel.id)
  elements.playerEmpty.hidden = true
  elements.nowPlaying.hidden = false
  elements.sourceQuality.textContent = source.quality
  if (!preserveDiagnostic) clearPlaybackDiagnostic()
  updateChannelHealth('checking')
  updateSourceButtons()
  player.load(source, true)
}

function updateSourceButtons(): void {
  for (const [index, button] of [...elements.sourceList.querySelectorAll<HTMLButtonElement>('[data-source-button]')].entries()) {
    button.setAttribute('aria-pressed', String(index === activeSourceIndex && player.hasSource))
  }
}

function handleFatalSource(diagnostic: PlaybackDiagnostic): void {
  const channel = getChannel(selectedChannelId)
  const current = channel?.sources[activeSourceIndex]
  if (!channel || !current) return
  renderPlaybackDiagnostic(diagnostic)
  failedSources.add(current.id)
  const nextIndex = channel.sources.findIndex((source) => !failedSources.has(source.id))
  if (nextIndex >= 0) {
    showToast(`${diagnostic.title}，正在尝试线路 ${nextIndex + 1}`)
    const nextSource = channel.sources[nextIndex]
    if (nextSource) playSource(nextSource, nextIndex, true)
    return
  }
  updatePlaybackState('error', `${diagnostic.title}：${diagnostic.message}`)
  showToast(`所有线路均连接失败；最后一次：${diagnostic.title}`, 6000)
}

function updatePlaybackState(state: PlaybackState, message: string): void {
  elements.togglePlay.classList.toggle('is-playing', state === 'playing')
  elements.togglePlay.setAttribute('aria-label', state === 'playing' ? '暂停' : '播放')
  elements.playerStatus.classList.toggle('error', state === 'error')
  elements.playerStatus.hidden = state === 'idle' || state === 'playing' || (state === 'paused' && !message)
  elements.playerStatusText.textContent = message || (state === 'paused' ? '已暂停' : '')
  if (state === 'loading') updateChannelHealth('checking')
  else if (state === 'playing') {
    updateChannelHealth('playable')
    clearPlaybackDiagnostic()
  } else if (state === 'paused') updateChannelHealth('connected')
  else if (state === 'error') updateChannelHealth('unavailable')
  else updateChannelHealth('not-checked')
  if (state === 'idle' || state === 'error') {
    elements.nowPlaying.hidden = true
  }
  if (state === 'idle') {
    updateSourceButtons()
  }
}

async function togglePlayback(): Promise<void> {
  const channel = getChannel(selectedChannelId) ?? filteredChannels[0]
  if (!channel) {
    showToast('当前筛选条件下没有可播放频道')
    return
  }
  if (channel.id !== selectedChannelId) selectChannel(channel.id, false, false)
  if (!player.hasSource) {
    const source = channel.sources[activeSourceIndex] ?? channel.sources[0]
    if (source) playSource(source, channel.sources.indexOf(source))
    return
  }
  await player.toggle()
}

function stopPlayback(): void {
  player.stop()
  failedSources = new Set()
  elements.playerEmpty.hidden = false
  clearPlaybackDiagnostic()
  updateChannelHealth('not-checked')
  updateSourceButtons()
}

function moveChannel(direction: -1 | 1): void {
  if (filteredChannels.length === 0) return
  const currentIndex = filteredChannels.findIndex((channel) => channel.id === selectedChannelId)
  const base = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0
  const targetIndex = (base + direction + filteredChannels.length) % filteredChannels.length
  const channel = filteredChannels[targetIndex]
  if (!channel) return
  selectChannel(channel.id, true, true)
  ensureChannelVisible(targetIndex)
}

function ensureChannelVisible(index: number): void {
  const top = index * ROW_HEIGHT
  const bottom = top + ROW_HEIGHT
  if (top < elements.channelList.scrollTop) elements.channelList.scrollTop = top
  else if (bottom > elements.channelList.scrollTop + elements.channelList.clientHeight) {
    elements.channelList.scrollTop = bottom - elements.channelList.clientHeight
  }
  renderVirtualRows()
}

function toggleFavorite(channelId: string): void {
  if (!channelId || !getChannel(channelId)) return
  if (favorites.has(channelId)) {
    favorites.delete(channelId)
    showToast('已取消收藏')
  } else {
    favorites.add(channelId)
    showToast('已加入收藏')
  }
  persistCollections()
  updateFavoriteButton()
  if (viewMode === 'favorites') applyFilters()
  else renderVirtualRows()
}

function updateFavoriteButton(): void {
  const active = favorites.has(selectedChannelId)
  elements.favorite.setAttribute('aria-pressed', String(active))
  const label = elements.favorite.querySelector('span')
  if (label) label.textContent = active ? '已收藏' : '收藏'
}

function addRecent(channelId: string): void {
  recents = [channelId, ...recents.filter((id) => id !== channelId)].slice(0, 100)
  persistCollections()
  if (viewMode === 'recent') applyFilters()
}

function persistCollections(): void {
  writeStoredArray(FAVORITES_KEY, [...favorites])
  writeStoredArray(RECENTS_KEY, recents)
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
    if (requested) elements.app.classList.remove('sidebar-open')
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

function handleGlobalKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  const isEditing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target?.isContentEditable

  if (event.key === 'Escape') {
    if (elements.app.classList.contains('player-fullscreen')) {
      event.preventDefault()
      void toggleFullscreen()
    } else if (compactSidebarQuery.matches && elements.app.classList.contains('sidebar-open')) closeSidebar()
    return
  }
  if (elements.infoDialog.open) return
  if (isEditing) return
  if (event.key === '/') {
    event.preventDefault()
    elements.search.focus()
    elements.search.select()
    return
  }
  if (target instanceof HTMLButtonElement) return

  if (/^\d$/.test(event.key) && !event.repeat) {
    event.preventDefault()
    queueChannelNumber(event.key)
    return
  }

  switch (event.key.toLocaleLowerCase()) {
    case 'arrowdown':
      event.preventDefault()
      moveChannel(1)
      break
    case 'arrowup':
      event.preventDefault()
      moveChannel(-1)
      break
    case 'j':
      event.preventDefault()
      moveChannel(1)
      break
    case 'k':
      event.preventDefault()
      moveChannel(-1)
      break
    case 'p':
      event.preventDefault()
      void togglePictureInPicture()
      break
    case 'f':
      event.preventDefault()
      void toggleFullscreen()
      break
    case 'm':
      event.preventDefault()
      announceVolume(player.toggleMuted())
      break
    case '+':
    case '=':
      event.preventDefault()
      announceVolume(player.adjustVolume(0.1))
      break
    case '-':
    case '_':
      event.preventDefault()
      announceVolume(player.adjustVolume(-0.1))
      break
    case ' ':
      event.preventDefault()
      void togglePlayback()
      break
  }
}

function openSidebar(): void {
  if (compactSidebarQuery.matches) elements.app.classList.add('sidebar-open')
  else elements.app.classList.remove('sidebar-collapsed')
  syncSidebarState()
  requestAnimationFrame(() => elements.search.focus())
}

function closeSidebar(): void {
  if (compactSidebarQuery.matches) elements.app.classList.remove('sidebar-open')
  else elements.app.classList.add('sidebar-collapsed')
  syncSidebarState()
  if (elements.channelPane.contains(document.activeElement)) requestAnimationFrame(() => elements.sidebarToggle.focus())
}

function resetSidebarForViewport(): void {
  elements.app.classList.remove('sidebar-open', 'sidebar-collapsed')
  syncSidebarState()
  renderVirtualRows()
}

function syncSidebarState(): void {
  const compact = compactSidebarQuery.matches
  const visible = compact
    ? elements.app.classList.contains('sidebar-open')
    : !elements.app.classList.contains('sidebar-collapsed')
  elements.sidebarToggle.setAttribute('aria-expanded', String(visible))
  elements.sidebarToggle.setAttribute('aria-label', compact ? '打开频道目录' : '显示频道目录')
  elements.sidebarToggle.title = compact ? '打开频道目录' : '显示频道目录'
  elements.sidebarClose.setAttribute('aria-label', compact ? '关闭频道目录' : '隐藏频道目录')
  elements.sidebarClose.title = compact ? '关闭频道目录' : '隐藏频道目录'
  elements.channelPane.inert = !visible
}

function updateCatalogStatus(status: CacheStatus, count: number): void {
  currentCacheStatus = status
  delete elements.catalogState.dataset.syncStage
  const labels: Record<CacheStatus, string> = {
    network: `已同步 iptv-org · ${formatCount(count)} 台`,
    'fresh-cache': `本机目录 · ${formatCount(count)} 台`,
    'stale-cache': `离线缓存 · ${formatCount(count)} 台`,
    'offline-sample': `离线样例 · ${formatCount(count)} 台`
  }
  elements.catalogState.textContent = `${labels[status]}${familySafetyEnabled ? ' · 家庭安全' : ''}`
  elements.catalogState.classList.toggle('warning', status === 'stale-cache' || status === 'offline-sample')
}

function renderCatalogStats(value: Catalog): void {
  const rows: Array<readonly [string, string]> = [
    ['目录来源', value.source === 'iptv-org' ? 'iptv-org API' : '内置离线样例'],
    ['家庭安全模式', familySafetyEnabled ? '已开启 · 本地允许列表' : '未开启 · 上游元数据保守过滤'],
    ['筛选后频道', formatCount(value.stats.channels)],
    ['候选线路', formatCount(value.stats.candidateStreams)],
    ['按标记排除成人 / 停播', formatCount(value.stats.excludedUnsafeChannel)],
    ['排除屏蔽频道', formatCount(value.stats.excludedBlockedChannel)],
    ['排除不兼容线路', formatCount(value.stats.excludedBrowserIncompatible)],
    ['跳过异常上游记录', formatCount(value.stats.discardedUpstreamRecords ?? 0)],
    ['家庭允许列表排除线路', formatCount(value.stats.excludedFamilySafety ?? 0)],
    ['目录生成时间', new Date(value.generatedAt).toLocaleString('zh-CN')]
  ]
  const fragment = document.createDocumentFragment()
  for (const [term, detail] of rows) {
    const dt = document.createElement('dt')
    const dd = document.createElement('dd')
    dt.textContent = term
    dd.textContent = detail
    fragment.append(dt, dd)
  }
  elements.catalogStats.replaceChildren(fragment)
}

function showCatalogFailure(failure: CatalogLoadFailure): void {
  catalogSyncActive = false
  catalog = undefined
  delete elements.app.dataset.catalogSource
  delete elements.app.dataset.catalogCount
  filteredChannels = []
  player.stop()
  elements.loadingList.hidden = true
  elements.channelWindow.replaceChildren()
  elements.channelWindow.hidden = true
  elements.channelSpacer.hidden = true
  setCatalogControlsEnabled(false)
  setCatalogFailureVisible(true)
  elements.catalogFailure.dataset.errorCode = failure.code
  elements.catalogFailureTitle.textContent = failure.title
  elements.catalogFailureMessage.textContent = failure.message
  elements.catalogDiagnostics.textContent = [
    `错误类别：${failure.code}`,
    `可重试：${failure.retryable ? '是' : '否'}`,
    `诊断：${failure.detail || '没有更多诊断信息'}`
  ].join('\n')
  elements.catalogDiagnostics.hidden = true
  elements.toggleCatalogDiagnostics.setAttribute('aria-expanded', 'false')
  elements.toggleCatalogDiagnostics.textContent = '查看诊断信息'
  elements.catalogState.textContent = '无法获取 iptv-org 目录'
  elements.catalogState.classList.add('warning')
  elements.resultCount.textContent = '未载入真实频道'
  showToast(`${failure.title}，可以重新尝试或主动打开离线演示`, 7000)
}

function beginCatalogSync(message: string): void {
  catalogSyncActive = true
  setCatalogFailureVisible(false)
  elements.catalogState.classList.remove('warning')
  elements.catalogState.textContent = message
  if (!catalog) {
    elements.channelWindow.hidden = true
    elements.channelSpacer.hidden = true
    elements.loadingList.hidden = false
    elements.resultCount.textContent = message
  }
}

function updateCatalogProgress(progress: CatalogSyncProgress): void {
  if (!catalogSyncActive) return
  elements.catalogState.dataset.syncStage = progress.stage
  elements.catalogState.textContent = progress.message
  if (!catalog) elements.resultCount.textContent = progress.message
}

function setCatalogFailureVisible(visible: boolean): void {
  elements.catalogFailure.hidden = !visible
  if (!visible) delete elements.catalogFailure.dataset.errorCode
  elements.channelWindow.hidden = visible
  elements.channelSpacer.hidden = visible
}

function setCatalogControlsEnabled(enabled: boolean): void {
  elements.search.disabled = !enabled
  elements.country.disabled = !enabled
  elements.category.disabled = !enabled
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) button.disabled = !enabled
}

function toggleCatalogDiagnostics(): void {
  const expanded = elements.toggleCatalogDiagnostics.getAttribute('aria-expanded') === 'true'
  elements.toggleCatalogDiagnostics.setAttribute('aria-expanded', String(!expanded))
  elements.toggleCatalogDiagnostics.textContent = expanded ? '查看诊断信息' : '隐藏诊断信息'
  elements.catalogDiagnostics.hidden = expanded
}

async function openOfflineDemo(): Promise<void> {
  if (refreshInProgress) return
  refreshInProgress = true
  elements.retryCatalog.disabled = true
  elements.openOfflineDemo.disabled = true
  elements.refreshCatalog.disabled = true
  beginCatalogSync('正在打开离线演示…')
  try {
    const result = await window.tvFeed.loadOfflineDemo(familySafetyEnabled)
    applyCatalog(result)
    showToast('已打开离线演示；这些是虚构样例，不是 iptv-org 真实频道')
  } catch (error) {
    showCatalogFailure(unexpectedCatalogFailure(error))
  } finally {
    refreshInProgress = false
    elements.retryCatalog.disabled = false
    elements.openOfflineDemo.disabled = false
    elements.refreshCatalog.disabled = false
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
  return catalog?.channels.find((channel) => channel.id === channelId)
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

type ChannelHealthState = 'not-checked' | 'checking' | 'playable' | 'connected' | 'unavailable'

function updateChannelHealth(state: ChannelHealthState): void {
  const labels: Record<ChannelHealthState, string> = {
    'not-checked': '选择并播放后检测',
    checking: '正在检测当前线路',
    playable: '当前线路可播放',
    connected: '当前线路已连接',
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

function queueChannelNumber(digit: string): void {
  const next = appendChannelNumberDigit(channelNumberBuffer, digit, filteredChannels.length)
  if (!next) {
    announce('频道编号从 1 开始')
    return
  }
  channelNumberBuffer = next
  announce(`频道编号 ${channelNumberBuffer}`)

  if (channelNumberTimer !== undefined) window.clearTimeout(channelNumberTimer)
  if (!hasLongerChannelNumber(channelNumberBuffer, filteredChannels.length)) {
    commitChannelNumber()
    return
  }
  channelNumberTimer = window.setTimeout(commitChannelNumber, CHANNEL_NUMBER_COMMIT_DELAY_MS)
}

function commitChannelNumber(): void {
  if (channelNumberTimer !== undefined) window.clearTimeout(channelNumberTimer)
  channelNumberTimer = undefined
  const value = channelNumberBuffer
  channelNumberBuffer = ''
  const index = channelIndexForNumber(value, filteredChannels.length)
  const channel = index === undefined ? undefined : filteredChannels[index]
  if (!channel || index === undefined) {
    announce(`没有频道编号 ${value}`)
    showToast(`没有频道编号 ${value}`)
    return
  }
  selectChannel(channel.id, true, true)
  ensureChannelVisible(index)
}

function resetChannelNumberBuffer(): void {
  channelNumberBuffer = ''
  if (channelNumberTimer !== undefined) window.clearTimeout(channelNumberTimer)
  channelNumberTimer = undefined
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
  if (viewMode === 'favorites') return '还没有收藏频道。打开任一频道后，点击右侧的收藏按钮。'
  if (viewMode === 'recent') return '最近观看为空。播放过的频道会自动出现在这里。'
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

function readStoredArray(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function writeStoredArray(key: string, value: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Preferences are optional; the player remains usable when storage is unavailable.
  }
}

function readStoredString(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeStoredString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // See writeStoredArray.
  }
}

function readStoredBoolean(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

function writeStoredBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // See writeStoredArray.
  }
}

function removeStoredValue(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // See writeStoredArray.
  }
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function initials(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toLocaleUpperCase() || 'TV'
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
