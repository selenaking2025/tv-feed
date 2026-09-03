import Hls from 'hls.js'
import type { RemoteResourceRequest } from '../../src/shared/remote-resource-contracts.ts'
import { createSecureHls, type HlsProgressiveMode } from '../../src/renderer/src/hls-engine.ts'

const ROUND_SEQUENCE: readonly HlsProgressiveMode[] = Object.freeze([
  'production-forced',
  'library-default',
  'library-default',
  'production-forced',
  'library-default',
  'production-forced'
])
const FIXTURE_ORIGIN = 'https://fixture.invalid'
const fixtureBase = '/fixture/'
const nativeFetch = window.fetch.bind(window)
const streamTickets = new Map<string, string>()
let ticketSequence = 0

Object.defineProperty(window, 'tvFeed', {
  configurable: true,
  value: {
    fetchRemoteResource: async (request: RemoteResourceRequest) => {
      const response = await nativeFetch(fixturePath(request.url), { cache: 'no-store' })
      if (!response.ok) return { ok: false, failure: { code: 'source-offline', retryable: false } }
      return {
        ok: true,
        response: {
          body: new Uint8Array(await response.arrayBuffer()),
          contentType: response.headers.get('content-type') ?? '',
          finalUrl: request.url,
          statusCode: response.status
        }
      }
    },
    prepareRemoteResourceStream: async (request: RemoteResourceRequest) => {
      ticketSequence += 1
      const ticket = `mpeg_ts_fixture_ticket_${String(ticketSequence).padStart(12, '0')}`
      streamTickets.set(ticket, fixturePath(request.url))
      return { streamUrl: `tvfeed://app/__hls_stream/${ticket}` }
    },
    cancelRemoteResource: () => undefined
  }
})

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (!value.startsWith('tvfeed://app/__hls_stream/')) return nativeFetch(input, init)
  const ticket = new URL(value).pathname.split('/').at(-1) ?? ''
  const path = streamTickets.get(ticket)
  if (!path) return new Response('missing fixture ticket', { status: 404 })
  return nativeFetch(path, { ...init, cache: 'no-store' })
}) as typeof window.fetch

void run().catch((error: unknown) => {
  const name = error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
    ? error.name
    : 'HarnessError'
  console.log(`TVFEED_MPEG_TS_RESULT ${JSON.stringify({ ok: false, error: name })}`)
})

async function run(): Promise<void> {
  if (!Hls.isSupported()) throw Object.assign(new Error('unsupported'), { name: 'HlsUnsupported' })
  const rounds = []
  for (const [index, mode] of ROUND_SEQUENCE.entries()) {
    rounds.push(await runRound(mode, index + 1))
    await wait(350)
  }
  console.log(`TVFEED_MPEG_TS_RESULT ${JSON.stringify({ ok: true, sequence: ROUND_SEQUENCE, rounds })}`)
}

async function runRound(mode: HlsProgressiveMode, round: number): Promise<Record<string, unknown>> {
  streamTickets.clear()
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.width = 192
  video.height = 108
  document.querySelector('#harness')?.append(video)

  const hls = createSecureHls(mode)
  const progressive = hls.config.progressive
  let fragmentCount = 0
  let fragmentBytes = 0
  let fatalError = ''
  let playRejection = ''
  let firstPlayingTime: number | undefined

  video.addEventListener('playing', () => {
    if (firstPlayingTime === undefined) firstPlayingTime = video.currentTime
  })

  hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
    fragmentCount += 1
    fragmentBytes += finiteNumber(data.frag.stats.loaded)
  })
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) fatalError = `${data.type}:${data.details}`
  })
  hls.on(Hls.Events.MEDIA_ATTACHED, () => {
    hls.loadSource(`${FIXTURE_ORIGIN}/live.m3u8`)
  })
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    void video.play().catch((error: unknown) => {
      playRejection = error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
        ? error.name
        : 'UnknownError'
    })
  })
  hls.attachMedia(video)

  const startedAt = performance.now()
  while (performance.now() - startedAt < 10_000) {
    const mediaAdvanced = firstPlayingTime === undefined ? 0 : Math.max(0, video.currentTime - firstPlayingTime)
    if (mediaAdvanced >= 1.25 && fragmentCount >= 2 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) break
    if (fatalError) break
    await wait(100)
  }

  const bufferedSeconds = bufferedDuration(video.buffered)
  const mediaAdvancedSeconds = firstPlayingTime === undefined ? 0 : Math.max(0, video.currentTime - firstPlayingTime)
  const quality = video.getVideoPlaybackQuality?.()
  const result = {
    round,
    mode,
    progressive,
    fragmentCount,
    fragmentBytes,
    readyState: video.readyState,
    bufferedSeconds: roundNumber(bufferedSeconds),
    mediaAdvancedSeconds: roundNumber(mediaAdvancedSeconds),
    totalFrames: finiteNumber(quality?.totalVideoFrames),
    droppedFrames: finiteNumber(quality?.droppedVideoFrames),
    fatalError: fixedErrorCategory(fatalError),
    playRejection,
    passed:
      !fatalError &&
      !playRejection &&
      fragmentCount >= 2 &&
      bufferedSeconds >= 0.5 &&
      mediaAdvancedSeconds >= 1 &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      finiteNumber(quality?.totalVideoFrames) > 0
  }

  hls.destroy()
  video.pause()
  video.removeAttribute('src')
  video.load()
  video.remove()
  return result
}

function fixturePath(inputUrl: string): string {
  const pathname = new URL(inputUrl).pathname
  const name = pathname.split('/').at(-1) ?? ''
  if (name === 'live.m3u8' || /^segment-\d{2}\.ts$/.test(name)) return `${fixtureBase}${name}`
  return `${fixtureBase}missing`
}

function bufferedDuration(ranges: TimeRanges): number {
  let total = 0
  for (let index = 0; index < ranges.length; index += 1) {
    total += Math.max(0, ranges.end(index) - ranges.start(index))
  }
  return total
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function roundNumber(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function fixedErrorCategory(value: string): string {
  if (!value) return ''
  if (value.includes('media')) return 'media'
  if (value.includes('network')) return 'network'
  return 'other'
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => window.setTimeout(resolvePromise, milliseconds))
}
