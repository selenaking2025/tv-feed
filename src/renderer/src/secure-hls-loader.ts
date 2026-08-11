import {
  LoadStats,
  type HlsConfig,
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
  type LoaderStats
} from 'hls.js'
import type {
  RemoteResourceKind,
  RemoteResourceResponse,
  RemoteResourceStreamTicket
} from '../../shared/contracts.ts'

let requestSequence = 0
const MAX_STREAM_BYTES = 32 * 1_024 * 1_024

export class SecureHlsLoader implements Loader<LoaderContext> {
  public context: LoaderContext | null = null
  public stats: LoaderStats = new LoadStats()

  private callbacks: LoaderCallbacks<LoaderContext> | null = null
  private requestId = ''
  private timeoutId: number | undefined
  private streamController: AbortController | undefined
  private completed = false
  private contentType = ''
  private responseHeaders = new Map<string, string>()

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
      this.streamController?.abort(new Error('安全媒体流加载超时'))
      window.tvFeed.cancelRemoteResource(this.requestId)
      callbacks.onTimeout(this.stats, context, null)
    }, timeoutMs)

    let range: ReturnType<typeof resourceRange>
    try {
      range = resourceRange(context)
    } catch (error) {
      this.fail(error)
      return
    }
    const request = {
      requestId: this.requestId,
      url: context.url,
      kind: resourceKind(context),
      ...range
    } as const
    if (request.kind === 'hls-binary') {
      const progressiveHighWaterMark = Number.isFinite(config.highWaterMark) && Number(config.highWaterMark) > 0
        ? Math.min(Number(config.highWaterMark), 1 * 1_024 * 1_024)
        : null
      void window.tvFeed.prepareRemoteResourceStream(request)
        .then((ticket) => this.loadStream(ticket, progressiveHighWaterMark), (error: unknown) => this.fail(error))
      return
    }
    void window.tvFeed.fetchRemoteResource(request)
      .then((response) => this.succeedBuffered(response), (error: unknown) => this.fail(error))
  }

  abort(): void {
    if (!this.context || this.completed || this.stats.aborted) return
    this.stats.aborted = true
    this.completed = true
    this.clearTimeout()
    this.streamController?.abort(new Error('安全媒体流已取消'))
    window.tvFeed.cancelRemoteResource(this.requestId)
    this.callbacks?.onAbort?.(this.stats, this.context, null)
  }

  destroy(): void {
    if (!this.completed && !this.stats.aborted && this.requestId) {
      this.stats.aborted = true
      this.streamController?.abort(new Error('安全媒体流已销毁'))
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
    return this.responseHeaders.get(name.toLocaleLowerCase()) ?? null
  }

  private succeedBuffered(response: RemoteResourceResponse): void {
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
    if (response.contentType) this.responseHeaders.set('content-type', response.contentType)

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

  private async loadStream(ticket: RemoteResourceStreamTicket, progressiveHighWaterMark: number | null): Promise<void> {
    const context = this.context
    const callbacks = this.callbacks
    if (!context || !callbacks || this.completed || this.stats.aborted) return
    const streamUrl = validateInternalStreamUrl(ticket.streamUrl)
    const controller = new AbortController()
    this.streamController = controller

    try {
      const response = await window.fetch(streamUrl, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`安全媒体流返回 HTTP ${response.status}`)
      if (!response.body) throw new Error('安全媒体流没有可读取的正文')
      if (this.completed || this.stats.aborted) {
        await response.body.cancel().catch(() => undefined)
        return
      }

      const contentLength = boundedContentLength(response.headers.get('content-length'))
      this.contentType = response.headers.get('content-type') ?? 'application/octet-stream'
      this.responseHeaders.set('content-type', this.contentType)
      for (const header of ['content-length', 'content-range', 'accept-ranges'] as const) {
        const value = response.headers.get(header)
        if (value) this.responseHeaders.set(header, value)
      }
      this.stats.loading.first = performance.now()
      if (contentLength !== null) this.stats.total = contentLength
      const networkDetails = {
        connectionReused: response.headers.get('x-tvfeed-connection-reused') === '1',
        delivery: 'stream'
      }
      const progressive = typeof callbacks.onProgress === 'function' && progressiveHighWaterMark !== null
      const chunks: Uint8Array[] = []
      const progressChunks: Uint8Array[] = []
      let progressBytes = 0
      const reader = response.body.getReader()

      while (true) {
        const next = await reader.read()
        if (next.done) break
        if (this.completed || this.stats.aborted) {
          await reader.cancel().catch(() => undefined)
          return
        }
        const chunk = Uint8Array.from(next.value)
        this.stats.loaded += chunk.byteLength
        if (this.stats.loaded > MAX_STREAM_BYTES) throw new Error('安全媒体流超过渲染器字节上限')
        if (!progressive) {
          chunks.push(chunk)
        } else if (progressBytes === 0 && chunk.byteLength >= progressiveHighWaterMark) {
          callbacks.onProgress?.(this.stats, context, chunk.buffer, networkDetails)
        } else {
          progressChunks.push(chunk)
          progressBytes += chunk.byteLength
          if (progressBytes >= progressiveHighWaterMark) {
            callbacks.onProgress?.(
              this.stats,
              context,
              concatenateChunks(progressChunks, progressBytes),
              networkDetails
            )
            progressChunks.length = 0
            progressBytes = 0
          }
        }
      }

      if (this.completed || this.stats.aborted) return
      if (progressive && progressBytes > 0) {
        callbacks.onProgress?.(
          this.stats,
          context,
          concatenateChunks(progressChunks, progressBytes),
          networkDetails
        )
      }
      const data = progressive ? new ArrayBuffer(0) : concatenateChunks(chunks, this.stats.loaded)
      if (!progressive && callbacks.onProgress) callbacks.onProgress(this.stats, context, data, networkDetails)
      this.succeedStream(response.status, data, networkDetails)
    } catch (error) {
      if (this.completed || this.stats.aborted) return
      this.fail(error)
    }
  }

  private succeedStream(
    statusCode: number,
    data: ArrayBuffer,
    networkDetails: { connectionReused: boolean; delivery: string }
  ): void {
    const context = this.context
    const callbacks = this.callbacks
    if (!context || !callbacks || this.completed || this.stats.aborted) return
    this.completed = true
    this.clearTimeout()
    const now = performance.now()
    if (this.stats.loading.first === 0) this.stats.loading.first = now
    this.stats.loading.end = now
    if (this.stats.total === 0) this.stats.total = this.stats.loaded
    const elapsedMs = Math.max(1, now - this.stats.loading.start)
    this.stats.bwEstimate = (this.stats.loaded * 8_000) / elapsedMs
    callbacks.onSuccess({
      url: context.url,
      data,
      code: statusCode
    }, this.stats, context, networkDetails)
  }

  private fail(error: unknown): void {
    const context = this.context
    const callbacks = this.callbacks
    if (!context || !callbacks || this.completed || this.stats.aborted) return
    this.completed = true
    this.clearTimeout()
    this.streamController?.abort(new Error('安全媒体流加载失败'))
    window.tvFeed.cancelRemoteResource(this.requestId)
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

export function resourceRange(
  context: Pick<LoaderContext, 'rangeStart' | 'rangeEnd'>
): Readonly<{ rangeStart: number; rangeEnd: number }> | Record<string, never> {
  // hls.js initializes full-resource fragment requests with 0/0. Its built-in
  // loaders only send a Range header when rangeEnd is truthy, so mirror that
  // convention before crossing the stricter IPC boundary.
  if (!context.rangeEnd) return {}
  if (
    !Number.isSafeInteger(context.rangeStart) ||
    !Number.isSafeInteger(context.rangeEnd) ||
    Number(context.rangeStart) < 0 ||
    Number(context.rangeEnd) <= Number(context.rangeStart)
  ) {
    throw new Error('HLS 字节范围无效')
  }
  return { rangeStart: Number(context.rangeStart), rangeEnd: Number(context.rangeEnd) }
}

function decodeResponseBody(context: LoaderContext, body: Uint8Array): string | ArrayBuffer | object {
  if (context.responseType === 'arraybuffer') return Uint8Array.from(body).buffer
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  return context.responseType === 'json' ? JSON.parse(text) as object : text
}

function boundedTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(value, 60_000) : 30_000
}

function validateInternalStreamUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('安全媒体流票据地址无效')
  }
  if (
    url.protocol !== 'tvfeed:' ||
    url.hostname !== 'app' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/__hls_stream\/[A-Za-z0-9_-]{32,128}$/.test(url.pathname)
  ) {
    throw new Error('安全媒体流票据地址越过应用边界')
  }
  return url.toString()
}

function boundedContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_STREAM_BYTES) {
    throw new Error('安全媒体流声明的大小超过渲染器字节上限')
  }
  return parsed
}

function concatenateChunks(chunks: readonly Uint8Array[], totalBytes: number): ArrayBuffer {
  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}
