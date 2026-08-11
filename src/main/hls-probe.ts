import { fetchRemoteResource } from './remote-resource-service.ts'
import { fetchBoundedHttps } from './secure-network.ts'

const PLAYLIST_LIMIT = 2 * 1_024 * 1_024
const PROBE_RANGE_BYTES = 64 * 1_024

export interface HlsProbeFetchResult {
  body: Uint8Array
  finalUrl: string
  statusCode: number
}

export type HlsProbeFetcher = (
  url: string,
  kind: 'playlist' | 'binary',
  range?: Readonly<{ start: number; end: number }>
) => Promise<HlsProbeFetchResult>

export interface HlsProbeResult {
  accepted: boolean
  redirected: boolean
  rootHost: string
  finalRootHost: string
  playlistHost: string
  playlistKind: 'master' | 'media' | 'unknown'
  variantCount: number
  renditionCount: number
  segmentContainer: 'mpeg-ts' | 'fmp4' | 'audio' | 'unknown'
  relativeReferences: boolean
  crossHostReferences: boolean
  hasByteRanges: boolean
  hasAes128: boolean
  hasUnsupportedProtection: boolean
  initRangeReadable: boolean | null
  segmentRangeReadable: boolean | null
  checkedHosts: string[]
  warning: string
}

interface ParsedPlaylist {
  kind: 'master' | 'media' | 'unknown'
  variants: Array<{ uri: string; bandwidth: number; codecs: string }>
  renditions: string[]
  segments: string[]
  initUri: string
  keyUri: string
  hasByteRanges: boolean
  hasAes128: boolean
  hasUnsupportedProtection: boolean
  relativeReferences: boolean
}

export async function probeHlsSource(
  inputUrl: string,
  fetcher: HlsProbeFetcher = defaultProbeFetcher
): Promise<HlsProbeResult> {
  const rootHost = hostnameOf(inputUrl)
  const checkedHosts = new Set<string>()
  const root = await fetcher(inputUrl, 'playlist')
  checkedHosts.add(hostnameOf(root.finalUrl))
  const rootPlaylist = parseHlsPlaylist(decodePlaylist(root.body))

  let mediaResponse = root
  let mediaPlaylist = rootPlaylist
  if (rootPlaylist.kind === 'master') {
    const variant = chooseProbeVariant(rootPlaylist.variants)
    const childReference = variant?.uri ?? rootPlaylist.renditions[0]
    if (!childReference) throw new Error('HLS Master Playlist 没有可验证的媒体子清单')
    const childUrl = new URL(childReference, root.finalUrl).toString()
    mediaResponse = await fetcher(childUrl, 'playlist')
    checkedHosts.add(hostnameOf(mediaResponse.finalUrl))
    mediaPlaylist = parseHlsPlaylist(decodePlaylist(mediaResponse.body))
  }

  if (mediaPlaylist.kind !== 'media') throw new Error('HLS 媒体清单格式无效或嵌套层级不受支持')
  const baseUrl = mediaResponse.finalUrl
  const referencedHosts = collectReferencedHosts(mediaPlaylist, baseUrl)
  for (const host of referencedHosts) checkedHosts.add(host)

  let initRangeReadable: boolean | null = null
  if (mediaPlaylist.initUri) {
    initRangeReadable = await probeRange(new URL(mediaPlaylist.initUri, baseUrl).toString(), fetcher, checkedHosts)
  }

  let segmentRangeReadable: boolean | null = null
  const segment = mediaPlaylist.segments[0]
  if (segment) {
    segmentRangeReadable = await probeRange(new URL(segment, baseUrl).toString(), fetcher, checkedHosts)
  }

  const keyReference = mediaPlaylist.keyUri || rootPlaylist.keyUri
  const keyBaseUrl = mediaPlaylist.keyUri ? baseUrl : root.finalUrl
  const hasAes128 = rootPlaylist.hasAes128 || mediaPlaylist.hasAes128
  const hasUnsupportedProtection = rootPlaylist.hasUnsupportedProtection || mediaPlaylist.hasUnsupportedProtection
  if (hasAes128 && keyReference) {
    const keyUrl = new URL(keyReference, keyBaseUrl).toString()
    const key = await fetcher(keyUrl, 'binary', { start: 0, end: 64 })
    checkedHosts.add(hostnameOf(key.finalUrl))
    if (key.body.byteLength < 16) throw new Error('AES-128 密钥响应长度不足')
  }

  const allReferences = [
    ...rootPlaylist.variants.map((entry) => entry.uri),
    ...rootPlaylist.renditions,
    ...mediaPlaylist.segments,
    mediaPlaylist.initUri,
    mediaPlaylist.keyUri
  ].filter(Boolean)
  const playlistHost = hostnameOf(mediaResponse.finalUrl)
  const crossHostReferences = [...checkedHosts].some((host) => host !== playlistHost)
  const warnings: string[] = []
  if (hasUnsupportedProtection) warnings.push('检测到 DRM 或非 AES-128 内容保护，未尝试绕过或读取密钥')
  if (initRangeReadable === false || segmentRangeReadable === false) warnings.push('至少一个媒体资源不接受 64 KiB 范围探测')
  if (allReferences.length === 0) warnings.push('媒体清单没有可探测的资源引用')

  return {
    accepted: mediaPlaylist.segments.length > 0 && !hasUnsupportedProtection,
    redirected: rootHost !== hostnameOf(root.finalUrl),
    rootHost,
    finalRootHost: hostnameOf(root.finalUrl),
    playlistHost,
    playlistKind: rootPlaylist.kind,
    variantCount: rootPlaylist.variants.length,
    renditionCount: rootPlaylist.renditions.length,
    segmentContainer: detectSegmentContainer(mediaPlaylist),
    relativeReferences: rootPlaylist.relativeReferences || mediaPlaylist.relativeReferences,
    crossHostReferences,
    hasByteRanges: mediaPlaylist.hasByteRanges,
    hasAes128,
    hasUnsupportedProtection,
    initRangeReadable,
    segmentRangeReadable,
    checkedHosts: [...checkedHosts].sort(),
    warning: warnings.join('；')
  }
}

export function parseHlsPlaylist(text: string): ParsedPlaylist {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines[0] !== '#EXTM3U') throw new Error('远程播放列表缺少 HLS 标头')

  const variants: ParsedPlaylist['variants'] = []
  const renditions: string[] = []
  const segments: string[] = []
  let initUri = ''
  let keyUri = ''
  let hasByteRanges = false
  let hasAes128 = false
  let hasUnsupportedProtection = false
  let relativeReferences = false
  let pendingVariant: { bandwidth: number; codecs: string } | undefined

  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = parseAttributeList(line.slice(line.indexOf(':') + 1))
      pendingVariant = {
        bandwidth: numberAttribute(attributes.get('BANDWIDTH')),
        codecs: attributes.get('CODECS') ?? ''
      }
      continue
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const uri = parseAttributeList(line.slice(line.indexOf(':') + 1)).get('URI') ?? ''
      if (uri) {
        renditions.push(uri)
        relativeReferences ||= isRelativeReference(uri)
      }
      continue
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      initUri = parseAttributeList(line.slice(line.indexOf(':') + 1)).get('URI') ?? ''
      relativeReferences ||= isRelativeReference(initUri)
      continue
    }
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const attributes = parseAttributeList(line.slice(line.indexOf(':') + 1))
      const method = (attributes.get('METHOD') ?? '').toLocaleUpperCase()
      const keyFormat = (attributes.get('KEYFORMAT') ?? 'identity').replaceAll('"', '').toLocaleLowerCase()
      const uri = attributes.get('URI') ?? ''
      if (method === 'AES-128' && keyFormat === 'identity') {
        hasAes128 = true
        if (uri) keyUri = uri
      } else if (method && method !== 'NONE') {
        hasUnsupportedProtection = true
      }
      relativeReferences ||= isRelativeReference(uri)
      continue
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      hasByteRanges = true
      continue
    }
    if (line.startsWith('#')) continue

    relativeReferences ||= isRelativeReference(line)
    if (pendingVariant) {
      variants.push({ uri: line, ...pendingVariant })
      pendingVariant = undefined
    } else {
      segments.push(line)
    }
  }

  const kind = variants.length > 0 || renditions.length > 0
    ? 'master'
    : segments.length > 0 || lines.some((line) => line.startsWith('#EXTINF:'))
      ? 'media'
      : 'unknown'
  return {
    kind,
    variants,
    renditions,
    segments,
    initUri,
    keyUri,
    hasByteRanges,
    hasAes128,
    hasUnsupportedProtection,
    relativeReferences
  }
}

async function defaultProbeFetcher(
  url: string,
  kind: 'playlist' | 'binary',
  range?: Readonly<{ start: number; end: number }>
): Promise<HlsProbeFetchResult> {
  if (kind === 'playlist') {
    const result = await fetchRemoteResource({
      requestId: `acceptance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      url,
      kind: 'hls-playlist'
    }, new AbortController().signal)
    return result
  }
  const result = await fetchBoundedHttps(url, {
    accept: 'video/mp2t, video/iso.segment, audio/*, application/octet-stream;q=0.8',
    maxBytes: range ? range.end - range.start : PROBE_RANGE_BYTES,
    timeoutMs: 20_000,
    ...(range ? { rangeStart: range.start, rangeEnd: range.end } : {})
  })
  return result
}

async function probeRange(
  url: string,
  fetcher: HlsProbeFetcher,
  checkedHosts: Set<string>
): Promise<boolean> {
  try {
    const response = await fetcher(url, 'binary', { start: 0, end: PROBE_RANGE_BYTES })
    checkedHosts.add(hostnameOf(response.finalUrl))
    return response.body.byteLength > 0 && response.body.byteLength <= PROBE_RANGE_BYTES
  } catch {
    checkedHosts.add(hostnameOf(url))
    return false
  }
}

function chooseProbeVariant(variants: readonly ParsedPlaylist['variants'][number][]): ParsedPlaylist['variants'][number] | undefined {
  return [...variants].sort((a, b) => {
    const aAvc = /(?:^|,)\s*(?:avc1|hvc1|hev1)/i.test(a.codecs) ? 0 : 1
    const bAvc = /(?:^|,)\s*(?:avc1|hvc1|hev1)/i.test(b.codecs) ? 0 : 1
    return aAvc - bAvc || a.bandwidth - b.bandwidth
  })[0]
}

function collectReferencedHosts(playlist: ParsedPlaylist, baseUrl: string): Set<string> {
  const hosts = new Set<string>()
  for (const reference of [...playlist.segments.slice(0, 2), playlist.initUri, playlist.keyUri].filter(Boolean)) {
    const host = hostnameOf(new URL(reference, baseUrl).toString())
    if (host) hosts.add(host)
  }
  return hosts
}

function detectSegmentContainer(playlist: ParsedPlaylist): HlsProbeResult['segmentContainer'] {
  if (playlist.initUri) return 'fmp4'
  const path = playlist.segments[0]?.split(/[?#]/, 1)[0]?.toLocaleLowerCase() ?? ''
  if (path.endsWith('.ts')) return 'mpeg-ts'
  if (path.endsWith('.m4s') || path.endsWith('.mp4') || path.endsWith('.cmfv') || path.endsWith('.cmfa')) return 'fmp4'
  if (path.endsWith('.aac') || path.endsWith('.mp3')) return 'audio'
  return 'unknown'
}

function decodePlaylist(body: Uint8Array): string {
  if (body.byteLength === 0 || body.byteLength > PLAYLIST_LIMIT) throw new Error('HLS 清单大小无效')
  return new TextDecoder('utf-8', { fatal: true }).decode(body)
}

function parseAttributeList(value: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const match of value.matchAll(/(?:^|,)\s*([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi)) {
    const key = match[1]?.toLocaleUpperCase()
    const raw = match[2] ?? ''
    if (key) result.set(key, raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw)
  }
  return result
}

function numberAttribute(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER
}

function isRelativeReference(value: string): boolean {
  return Boolean(value) && !/^[a-z][a-z\d+.-]*:/i.test(value)
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname.toLocaleLowerCase()
  } catch {
    return ''
  }
}
