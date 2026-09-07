import {
  appendChannelNumberDigit, CHANNEL_NUMBER_COMMIT_DELAY_MS, channelIndexForNumber, hasLongerChannelNumber
} from '../../shared/channel-shortcuts.ts'
import type { CatalogChannel } from '../../shared/catalog-contracts.ts'

interface KeyboardOptions {
  elements: { app: HTMLElement; search: HTMLInputElement; infoDialog: HTMLDialogElement }
  compactSidebarQuery: MediaQueryList
  channels: () => readonly CatalogChannel[]
  closeSidebar: () => void
  toggleFullscreen: () => Promise<void>
  togglePictureInPicture: () => Promise<void>
  togglePlayback: () => Promise<void>
  moveChannel: (direction: -1 | 1) => void
  selectChannel: (id: string, autoplay: boolean, remember: boolean) => void
  ensureChannelVisible: (index: number) => void
  onMute: () => void
  onVolume: (delta: number) => void
  announce: (message: string) => void
  showToast: (message: string) => void
}

export function createKeyboardControls(options: KeyboardOptions) {
  const { elements, compactSidebarQuery, closeSidebar, toggleFullscreen, togglePictureInPicture,
    togglePlayback, moveChannel, selectChannel, ensureChannelVisible, announce, showToast } = options
  let channelNumberBuffer = ''
  let channelNumberTimer: number | undefined
  return { handleKeydown: handleGlobalKeydown, resetNumber: resetChannelNumberBuffer }

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
        options.onMute()
        break
      case '+':
      case '=':
        event.preventDefault()
        options.onVolume(0.1)
        break
      case '-':
      case '_':
        event.preventDefault()
        options.onVolume(-0.1)
        break
      case ' ':
        event.preventDefault()
        void togglePlayback()
        break
    }
  }

  function queueChannelNumber(digit: string): void {
    const next = appendChannelNumberDigit(channelNumberBuffer, digit, options.channels().length)
    if (!next) {
      announce('频道编号从 1 开始')
      return
    }
    channelNumberBuffer = next
    announce(`频道编号 ${channelNumberBuffer}`)

    if (channelNumberTimer !== undefined) window.clearTimeout(channelNumberTimer)
    if (!hasLongerChannelNumber(channelNumberBuffer, options.channels().length)) {
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
    const index = channelIndexForNumber(value, options.channels().length)
    const channel = index === undefined ? undefined : options.channels()[index]
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

}
