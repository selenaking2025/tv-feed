import {
  LoadStats,
  type HlsConfig,
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
  type LoaderStats
} from 'hls.js'
import type { RemoteResourceKind, RemoteResourceResponse } from '../../shared/contracts.ts'

let requestSequence = 0

export class SecureHlsLoader implements Loader<LoaderContext> {
  public context: LoaderContext | null = null
  public stats: LoaderStats = new LoadStats()

  private callbacks: LoaderCallbacks<LoaderContext> | null = null
  private requestId = ''
  private timeoutId: number | undefined
  private completed = false
  private contentType = ''

  constructor(_config: HlsConfig) {}

  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>
  ): void {
    if (this.context) throw new Error('安全加载器实例只能使用一次')
    this.context = context
    this.callbacks = callbacks
    this.stats.loading.start = performance.now()
    this.requestId = `hls-${Date.now().toString(36)}-${(requestSequence += 1).toString(36)}`

    const timeoutMs = boundedTimeout(config.loadPolicy.maxLoadTimeMs)
    this.timeoutId = window.setTimeout(() => {
      if (this.completed || this.stats.aborted) return
      this.completed = true
      this.stats.aborted = true
      window.tvFeed.cancelRemoteResource(this.requestId)
      callbacks.onTimeout(this.stats, context, null)
    }, timeoutMs)

    void window.tvFeed.fetchRemoteResource({
      requestId: this.requestId,
      url: context.url,
      kind: resourceKind(context),
      ...(context.rangeStart !== undefined && context.rangeEnd !== undefined
        ? { rangeStart: context.rangeStart, rangeEnd: context.rangeEnd }
        : {})
    }).then((response) => this.succeed(response), (error: unknown) => this.fail(error))
  }

  abort(): void {
    if (!this.context || this.completed || this.stats.aborted) return
    this.stats.aborted = true
    this.completed = true
    this.clearTimeout()
    window.tvFeed.cancelRemoteResource(this.requestId)
    this.callbacks?.onAbort?.(this.stats, this.context, null)
  }

  destroy(): void {
    if (!this.completed && !this.stats.aborted && this.requestId) {
      this.stats.aborted = true
      window.tvFeed.cancelRemoteResource(this.requestId)
    }
    this.completed = true
    this.clearTimeout()
    this.callbacks = null
    this.context = null
  }

  getCacheAge(): number | null {
    return null
  }

  getResponseHeader(name: string): string | null {
    return name.toLocaleLowerCase() === 'content-type' && this.contentType ? this.contentType : null
  }

  private succeed(response: RemoteResourceResponse): void {
    const context = this.context
    const callbacks = this.callbacks
    if (!context || !callbacks || this.completed || this.stats.aborted) return
    let data: string | ArrayBuffer | object
    try {
      data = decodeResponseBody(context, response.body)
    } catch (error) {
      this.fail(error)
      return
    }
    this.completed = true
    this.clearTimeout()
    this.contentType = response.contentType

    const now = performance.now()
    this.stats.loading.first = now
    this.stats.loading.end = now
    this.stats.loaded = response.body.byteLength
    this.stats.total = response.body.byteLength
    const elapsedMs = Math.max(1, now - this.stats.loading.start)
    this.stats.bwEstimate = (response.body.byteLength * 8_000) / elapsedMs

    if (typeof data === 'string' || data instanceof ArrayBuffer) {
      callbacks.onProgress?.(this.stats, context, data, response)
    }
    callbacks.onSuccess({
      url: response.finalUrl,
      data,
      code: response.statusCode
    }, this.stats, context, response)
  }

  private fail(error: unknown): void {
    const context = this.context
    const callbacks = this.callbacks
    if (!context || !callbacks || this.completed || this.stats.aborted) return
    this.completed = true
    this.clearTimeout()
    this.stats.loading.end = performance.now()
    callbacks.onError({
      code: 0,
      text: error instanceof Error ? error.message : String(error)
    }, context, null, this.stats)
  }

  private clearTimeout(): void {
    if (this.timeoutId !== undefined) window.clearTimeout(this.timeoutId)
    this.timeoutId = undefined
  }
}

export function resourceKind(context: Pick<LoaderContext, 'responseType'>): RemoteResourceKind {
  if (context.responseType === 'arraybuffer') return 'hls-binary'
  if (context.responseType === 'json') return 'hls-json'
  return 'hls-playlist'
}

function decodeResponseBody(context: LoaderContext, body: Uint8Array): string | ArrayBuffer | object {
  if (context.responseType === 'arraybuffer') return Uint8Array.from(body).buffer
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  return context.responseType === 'json' ? JSON.parse(text) as object : text
}

function boundedTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(value, 60_000) : 30_000
}
