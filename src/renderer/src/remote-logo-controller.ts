import type { TvFeedBridge } from '../../shared/ipc-contract.ts'

const MAX_CONCURRENT_LOGO_REQUESTS = 4
const MAX_PENDING_LOGO_REQUESTS = 64

type LogoBridge = Pick<TvFeedBridge, 'fetchRemoteResource' | 'cancelRemoteResource'>

export class RemoteLogoController {
  private readonly bridge: LogoBridge
  private requestSequence = 0
  private activeRequests = 0
  private allowed = false
  private readonly queue: Array<() => Promise<void>> = []
  private readonly activeRequestIds = new Set<string>()
  private readonly activeObjectUrls = new Set<string>()

  constructor(bridge: LogoBridge) {
    this.bridge = bridge
  }

  get enabled(): boolean {
    return this.allowed
  }

  setEnabled(enabled: boolean): void {
    this.allowed = enabled
    if (!enabled) this.clear()
  }

  attach(wrapper: HTMLElement, image: HTMLImageElement, url: string): void {
    if (!this.allowed || this.queue.length >= MAX_PENDING_LOGO_REQUESTS) {
      image.remove()
      return
    }
    this.queue.push(async () => {
      if (!this.allowed || !wrapper.isConnected) return
      const requestId = `logo-${Date.now().toString(36)}-${(++this.requestSequence).toString(36)}`
      this.activeRequestIds.add(requestId)
      try {
        const result = await this.bridge.fetchRemoteResource({ requestId, url, kind: 'logo' })
        if (!result.ok) {
          image.remove()
          return
        }
        const response = result.response
        if (!this.allowed || !wrapper.isConnected) return
        const objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(response.body).buffer], { type: response.contentType }))
        this.activeObjectUrls.add(objectUrl)
        const releaseObjectUrl = (): void => {
          if (!this.activeObjectUrls.delete(objectUrl)) return
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
        this.activeRequestIds.delete(requestId)
      }
    })
    this.pump()
  }

  clear(): void {
    this.queue.length = 0
    for (const requestId of this.activeRequestIds) this.bridge.cancelRemoteResource(requestId)
    this.activeRequestIds.clear()
    for (const objectUrl of this.activeObjectUrls) URL.revokeObjectURL(objectUrl)
    this.activeObjectUrls.clear()
    document.querySelectorAll<HTMLImageElement>('img[data-remote-logo="true"]').forEach((image) => image.remove())
  }

  private pump(): void {
    while (this.activeRequests < MAX_CONCURRENT_LOGO_REQUESTS) {
      const task = this.queue.shift()
      if (!task) return
      this.activeRequests += 1
      void task().finally(() => {
        this.activeRequests -= 1
        this.pump()
      })
    }
  }
}
