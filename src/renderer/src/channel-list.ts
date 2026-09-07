import type { Catalog, CatalogChannel } from '../../shared/catalog-contracts.ts'
import { displayCountryName, getCountrySearchAliases } from '../../shared/countries.ts'
import { hasVerifiedOfficialSource } from '../../shared/official-sources.ts'
import type { ViewingState } from './viewing-state.ts'

export type ViewMode = 'all' | 'chinese' | 'favorites' | 'recent'
const ROW_HEIGHT = 76
const OVERSCAN = 7
const CHINESE_REGIONS = new Set(['CN', 'HK', 'TW', 'MO'])

interface ChannelListOptions {
  elements: {
    search: HTMLInputElement; country: HTMLSelectElement; category: HTMLSelectElement
    resultCount: HTMLElement; channelList: HTMLElement; channelSpacer: HTMLElement; channelWindow: HTMLElement
  }
  viewing: ViewingState
  catalog: () => Catalog | undefined
  viewMode: () => ViewMode
  selectedChannelId: () => string
  selectChannel: (id: string, autoplay: boolean, remember: boolean) => void
  toggleFavorite: (id: string) => void
  createLogo: (channel: CatalogChannel, className: string) => HTMLElement
  createOfficialBadge: (label: string) => HTMLElement
  createStarIcon: () => HTMLElement
  emptyMessage: () => string
  resetChannelNumberBuffer: () => void
}

export function createChannelList(options: ChannelListOptions) {
  const { elements, viewing, selectChannel, toggleFavorite, createLogo, createOfficialBadge,
    createStarIcon, emptyMessage, resetChannelNumberBuffer } = options
  let filteredChannels: CatalogChannel[] = []
  let lastRangeKey = ''
  let scheduledFrame: number | undefined
  function scheduleRender(): void {
    if (scheduledFrame !== undefined) return
    scheduledFrame = requestAnimationFrame(() => {
      scheduledFrame = undefined
      renderVirtualRows(false)
    })
  }
  elements.channelList.addEventListener('scroll', scheduleRender, { passive: true })
  new ResizeObserver(scheduleRender).observe(elements.channelList)
  return {
    get channels(): readonly CatalogChannel[] { return filteredChannels },
    applyFilters, render: renderVirtualRows, ensureVisible: ensureChannelVisible,
    clear(): void {
      filteredChannels = []
      lastRangeKey = ''
      elements.channelWindow.replaceChildren()
      elements.channelSpacer.style.height = '0px'
    }
  }

  function applyFilters(): void {
    const catalog = options.catalog()
    if (!catalog) return
    resetChannelNumberBuffer()
    const query = elements.search.value.trim().toLocaleLowerCase()
    const countryCode = elements.country.value
    const categoryId = elements.category.value
    const recentOrder = new Map(viewing.recents.map((id, index) => [id, index]))

    filteredChannels = catalog.channels.filter((channel) => {
      if (options.viewMode() === 'chinese' && !CHINESE_REGIONS.has(channel.countryCode)) return false
      if (options.viewMode() === 'favorites' && !viewing.favorites.has(channel.id)) return false
      if (options.viewMode() === 'recent' && !recentOrder.has(channel.id)) return false
      if (countryCode && channel.countryCode !== countryCode) return false
      if (categoryId && !channel.categoryIds.includes(categoryId)) return false
      if (query && !channel.searchText.includes(query) && !getCountrySearchAliases(channel.countryCode).includes(query)) return false
      return true
    })

    if (options.viewMode() === 'recent') {
      filteredChannels.sort((a, b) => (recentOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (recentOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    }

    elements.resultCount.textContent = `${formatCount(filteredChannels.length)} 个频道`
    elements.channelList.scrollTop = 0
    elements.channelSpacer.style.height = `${filteredChannels.length * ROW_HEIGHT}px`
    renderVirtualRows()
  }

  function renderVirtualRows(force = true): void {
    const catalog = options.catalog()
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
    const rangeKey = `${start}:${end}`
    if (!force && rangeKey === lastRangeKey) return
    lastRangeKey = rangeKey
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
    row.dataset.channelSelected = String(channel.id === options.selectedChannelId())
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
    favorite.setAttribute('aria-label', viewing.favorites.has(channel.id) ? `取消收藏 ${channel.name}` : `收藏 ${channel.name}`)
    favorite.setAttribute('aria-pressed', String(viewing.favorites.has(channel.id)))
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

  function ensureChannelVisible(index: number): void {
    const top = index * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < elements.channelList.scrollTop) elements.channelList.scrollTop = top
    else if (bottom > elements.channelList.scrollTop + elements.channelList.clientHeight) {
      elements.channelList.scrollTop = bottom - elements.channelList.clientHeight
    }
    renderVirtualRows()
  }

}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}
