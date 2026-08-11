import type {
  RemoteResourceKind,
  RemoteResourceRequest,
  RemoteResourceResponse
} from '../shared/contracts.ts'
import { MAX_REMOTE_URL_LENGTH } from '../shared/remote-url-policy.ts'
import { fetchBoundedHttps, type SecureFetchOptions, type SecureFetchResult } from './secure-network.ts'

const MIB = 1_024 * 1_024

export const REMOTE_RESOURCE_LIMITS: Readonly<Record<RemoteResourceKind, {
  accept: string
  maxBytes: number
  timeoutMs: number
}>> = Object.freeze({
  'hls-playlist': {
    accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, audio/mpegurl, text/plain;q=0.8',
    maxBytes: 2 * MIB,
    timeoutMs: 20_000
  },
  'hls-json': {
    accept: 'application/json, text/json;q=0.9',
    maxBytes: 1 * MIB,
    timeoutMs: 20_000
  },
  'hls-binary': {
    accept: 'video/mp2t, video/iso.segment, audio/*, application/octet-stream;q=0.8',
    maxBytes: 32 * MIB,
    timeoutMs: 30_000
  },
  logo: {
    accept: 'image/png, image/jpeg, image/gif, image/webp, image/avif',
    maxBytes: 2 * MIB,
    timeoutMs: 15_000
  }
})

type SecureFetcher = (url: string, options: SecureFetchOptions) => Promise<SecureFetchResult>

export async function fetchRemoteResource(
  input: unknown,
  signal: AbortSignal,
  fetcher: SecureFetcher = fetchBoundedHttps
): Promise<RemoteResourceResponse> {
  const request = validateRemoteResourceRequest(input)
  const limits = REMOTE_RESOURCE_LIMITS[request.kind]
  const result = await fetcher(request.url, {
    accept: limits.accept,
    allowCompression: request.kind === 'hls-playlist' || request.kind === 'hls-json',
    maxBytes: limits.maxBytes,
    timeoutMs: limits.timeoutMs,
    signal,
    ...(request.rangeStart !== undefined && request.rangeEnd !== undefined
      ? { rangeStart: request.rangeStart, rangeEnd: request.rangeEnd }
      : {})
  })

  if (request.kind === 'hls-playlist') {
    assertHlsPlaylist(result.body)
  } else if (request.kind === 'hls-json') {
    assertJson(result.body)
  }
  const contentType = request.kind === 'logo'
    ? detectRasterImageType(result.body)
    : result.contentType

  return {
    body: result.body,
    contentType,
    finalUrl: result.finalUrl,
    statusCode: result.statusCode
  }
}

export function validateRemoteResourceRequest(value: unknown): RemoteResourceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('远程资源请求格式无效')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(candidate.requestId)) {
    throw new Error('远程资源请求 ID 无效')
  }
  if (typeof candidate.url !== 'string' || candidate.url.length === 0 || candidate.url.length > MAX_REMOTE_URL_LENGTH) {
    throw new Error('远程资源 URL 无效')
  }
  if (candidate.kind !== 'hls-playlist' && candidate.kind !== 'hls-json' && candidate.kind !== 'hls-binary' && candidate.kind !== 'logo') {
    throw new Error('远程资源类型无效')
  }

  const hasRangeStart = candidate.rangeStart !== undefined
  const hasRangeEnd = candidate.rangeEnd !== undefined
  if (hasRangeStart !== hasRangeEnd) throw new Error('远程资源字节范围必须成对提供')
  if (hasRangeStart && hasRangeEnd) {
    if (
      !Number.isSafeInteger(candidate.rangeStart) ||
      !Number.isSafeInteger(candidate.rangeEnd) ||
      Number(candidate.rangeStart) < 0 ||
      Number(candidate.rangeEnd) <= Number(candidate.rangeStart)
    ) {
      throw new Error('远程资源字节范围无效')
    }
  }

  return {
    requestId: candidate.requestId,
    url: candidate.url,
    kind: candidate.kind,
    ...(hasRangeStart && hasRangeEnd
      ? { rangeStart: Number(candidate.rangeStart), rangeEnd: Number(candidate.rangeEnd) }
      : {})
  }
}

function assertHlsPlaylist(body: Uint8Array): void {
  const prefix = new TextDecoder('utf-8').decode(body.subarray(0, Math.min(body.byteLength, 256)))
    .replace(/^\uFEFF/, '')
    .trimStart()
  if (!prefix.startsWith('#EXTM3U')) throw new Error('远程播放列表缺少 HLS 标头')
}

function assertJson(body: Uint8Array): void {
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    throw new Error('远程 HLS 元数据不是有效的 JSON')
  }
}

function detectRasterImageType(body: Uint8Array): string {
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(body, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(body, 0, 6) === 'GIF87a' || ascii(body, 0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(body, 0, 4) === 'RIFF' && ascii(body, 8, 4) === 'WEBP') return 'image/webp'
  if (ascii(body, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(body, 8, 4))) return 'image/avif'
  throw new Error('远程台标不是受支持的安全位图格式')
}

function startsWith(body: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => body[index] === value)
}

function ascii(body: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...body.subarray(offset, offset + length))
}
