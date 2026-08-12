import {
  REMOTE_RESOURCE_FAILURE_HEADER,
  type RemoteResourceFetchResult,
  type RemoteResourceKind,
  type RemoteResourceRequest
} from '../shared/remote-resource-contracts.ts'
import { APP_PROTOCOL } from '../shared/ipc-contract.ts'
import { OneTimeTicketRegistry } from './one-time-ticket-registry.ts'
import { toRemoteResourceFailure } from './remote-resource-failure.ts'
import { fetchRemoteResource, validateRemoteResourceRequest } from './remote-resource-service.ts'
import { streamRemoteResource, validateRemoteStreamRequest } from './remote-resource-stream.ts'

const MAX_CONCURRENT_REMOTE_FETCHES = 8
const REMOTE_STREAM_TICKET_TTL_MS = 15_000
const MAX_REMOTE_STREAM_TICKETS = 128

interface ActiveRemoteFetch {
  controller: AbortController
  senderId: number
  kind: RemoteResourceKind
  mode: 'buffered' | 'stream-pending' | 'streaming'
  streamToken: string
}

interface RemoteStreamTicketEntry {
  controller: AbortController
  key: string
  request: RemoteResourceRequest & { kind: 'hls-binary' }
  senderId: number
}

export interface RemoteResourceBrokerOptions {
  assertAllowed: (kind: RemoteResourceKind) => void
  isNetworkOnline: () => boolean
  rendererUrl: string
}

export interface RemoteResourceBrokerDependencies {
  fetchResource?: typeof fetchRemoteResource
  streamResource?: typeof streamRemoteResource
}

export class RemoteResourceBroker {
  private readonly options: RemoteResourceBrokerOptions
  private readonly fetchResource: typeof fetchRemoteResource
  private readonly streamResource: typeof streamRemoteResource
  private readonly active = new Map<string, ActiveRemoteFetch>()
  private readonly tickets = new OneTimeTicketRegistry<RemoteStreamTicketEntry>(
    REMOTE_STREAM_TICKET_TTL_MS,
    MAX_REMOTE_STREAM_TICKETS
  )
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    options: RemoteResourceBrokerOptions,
    dependencies: RemoteResourceBrokerDependencies = {}
  ) {
    this.options = options
    this.fetchResource = dependencies.fetchResource ?? fetchRemoteResource
    this.streamResource = dependencies.streamResource ?? streamRemoteResource
  }

  start(): void {
    if (this.sweepTimer === undefined) this.sweepTimer = setInterval(() => this.expireTickets(), 5_000)
  }

  async fetch(senderId: number, input: unknown): Promise<RemoteResourceFetchResult> {
    const request = validateRemoteResourceRequest(input)
    this.options.assertAllowed(request.kind)
    this.reserve(senderId, request.requestId)
    const key = remoteFetchKey(senderId, request.requestId)
    const controller = new AbortController()
    this.active.set(key, { controller, senderId, kind: request.kind, mode: 'buffered', streamToken: '' })
    try {
      return { ok: true, response: await this.fetchResource(request, controller.signal) }
    } catch (error) {
      return {
        ok: false,
        failure: toRemoteResourceFailure(error, this.options.isNetworkOnline())
      }
    } finally {
      this.finish(key, controller)
    }
  }

  prepareStream(senderId: number, input: unknown): { streamUrl: string } {
    const request = validateRemoteStreamRequest(input)
    this.options.assertAllowed(request.kind)
    this.reserve(senderId, request.requestId)
    const key = remoteFetchKey(senderId, request.requestId)
    const controller = new AbortController()
    const issued = this.tickets.issue({ controller, key, request, senderId })
    this.active.set(key, {
      controller,
      senderId,
      kind: request.kind,
      mode: 'stream-pending',
      streamToken: issued.token
    })
    return {
      streamUrl: `${APP_PROTOCOL.scheme}://${APP_PROTOCOL.host}${APP_PROTOCOL.remoteStreamPathPrefix}${issued.token}`
    }
  }

  cancel(senderId: number, requestId: unknown): void {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(requestId)) return
    this.cancelByKey(remoteFetchKey(senderId, requestId), new Error('远程资源请求已取消'))
  }

  cancelKind(kind: RemoteResourceKind): void {
    for (const [key, request] of this.active) {
      if (request.kind === kind) this.cancelByKey(key, new Error('远程资源权限已撤销'))
    }
  }

  abortSender(senderId: number): void {
    this.tickets.removeWhere((entry) => entry.senderId === senderId)
    for (const [key, request] of this.active) {
      if (request.senderId !== senderId) continue
      request.controller.abort(new Error('渲染进程已结束'))
      this.active.delete(key)
    }
  }

  dispose(): void {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
    for (const request of this.active.values()) request.controller.abort(new Error('应用正在退出'))
    this.active.clear()
    this.tickets.clear()
  }

  async handleStreamRequest(request: Request, url: URL): Promise<Response> {
    const corsHeaders = this.corsHeaders(request)
    if (!this.isTrustedStreamRequest(request) || url.search || url.hash) {
      return new Response('Forbidden', { status: 403, headers: corsHeaders })
    }
    const token = url.pathname.slice(APP_PROTOCOL.remoteStreamPathPrefix.length)
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      return new Response('Not found', { status: 404, headers: corsHeaders })
    }

    this.expireTickets()
    const entry = this.tickets.consume(token)
    if (!entry) return new Response('Not found', { status: 404, headers: corsHeaders })
    const active = this.active.get(entry.key)
    if (!active ||
      active.controller !== entry.controller ||
      active.senderId !== entry.senderId ||
      active.mode !== 'stream-pending' ||
      active.streamToken !== token) {
      entry.controller.abort(new Error('安全媒体流票据状态不一致'))
      this.finish(entry.key, entry.controller)
      return new Response('Not found', { status: 404, headers: corsHeaders })
    }
    active.mode = 'streaming'
    active.streamToken = ''

    try {
      const result = await this.streamResource(entry.request, entry.controller.signal)
      const iterator = result.body[Symbol.asyncIterator]()
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        this.finish(entry.key, entry.controller)
      }
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            const next = await iterator.next()
            if (next.done) {
              finish()
              controller.close()
              return
            }
            controller.enqueue(next.value)
          } catch {
            finish()
            controller.error(new Error('安全媒体流传输中断'))
          }
        },
        cancel: async () => {
          entry.controller.abort(new Error('安全媒体流消费已取消'))
          try {
            await iterator.return?.()
          } finally {
            finish()
          }
        }
      })
      const headers = new Headers(corsHeaders)
      headers.set('Cache-Control', 'no-store')
      headers.set('Content-Type', result.contentType || 'application/octet-stream')
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('X-TVFeed-Connection-Reused', result.connectionReused ? '1' : '0')
      headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-TVFeed-Connection-Reused')
      if (result.contentLength !== null) headers.set('Content-Length', String(result.contentLength))
      if (result.contentRange) headers.set('Content-Range', result.contentRange)
      if (result.acceptRanges) headers.set('Accept-Ranges', result.acceptRanges)
      return new Response(body, { status: result.statusCode, headers })
    } catch (error) {
      this.finish(entry.key, entry.controller)
      const failure = toRemoteResourceFailure(error, this.options.isNetworkOnline())
      const headers = new Headers(corsHeaders)
      headers.set('Cache-Control', 'no-store')
      headers.set('Content-Type', 'text/plain; charset=utf-8')
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set(REMOTE_RESOURCE_FAILURE_HEADER, failure.code)
      headers.set('Access-Control-Expose-Headers', REMOTE_RESOURCE_FAILURE_HEADER)
      return new Response('安全媒体流无法建立', {
        status: failure.code === 'network-unavailable' ? 503 : 502,
        headers
      })
    }
  }

  private reserve(senderId: number, requestId: string): void {
    this.expireTickets()
    if (this.countForSender(senderId) >= MAX_CONCURRENT_REMOTE_FETCHES) {
      throw new Error(`同时进行的远程资源请求不能超过 ${MAX_CONCURRENT_REMOTE_FETCHES} 个`)
    }
    if (this.active.has(remoteFetchKey(senderId, requestId))) throw new Error('远程资源请求 ID 已在使用')
  }

  private countForSender(senderId: number): number {
    let count = 0
    for (const request of this.active.values()) if (request.senderId === senderId) count += 1
    return count
  }

  private finish(key: string, controller: AbortController): void {
    if (this.active.get(key)?.controller === controller) this.active.delete(key)
  }

  private cancelByKey(key: string, reason: Error): void {
    const active = this.active.get(key)
    if (!active) return
    active.controller.abort(reason)
    if (active.mode === 'stream-pending' && active.streamToken) this.tickets.revoke(active.streamToken)
    if (active.mode !== 'buffered') this.finish(key, active.controller)
  }

  private expireTickets(): void {
    for (const entry of this.tickets.sweep()) {
      entry.controller.abort(new Error('安全媒体流票据已过期'))
      this.finish(entry.key, entry.controller)
    }
  }

  private isTrustedStreamRequest(request: Request): boolean {
    if (!this.options.rendererUrl) return true
    try {
      const expectedOrigin = new URL(this.options.rendererUrl).origin
      const origin = request.headers.get('origin')
      if (origin === expectedOrigin) return true
      return Boolean(request.referrer && new URL(request.referrer).origin === expectedOrigin)
    } catch {
      return false
    }
  }

  private corsHeaders(request: Request): Record<string, string> {
    if (!this.options.rendererUrl) return {}
    try {
      const expectedOrigin = new URL(this.options.rendererUrl).origin
      return request.headers.get('origin') === expectedOrigin
        ? { 'Access-Control-Allow-Origin': expectedOrigin, Vary: 'Origin' }
        : {}
    } catch {
      return {}
    }
  }
}

function remoteFetchKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`
}
