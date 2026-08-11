import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHlsPlaylist, probeHlsSource, type HlsProbeFetcher } from '../src/main/hls-probe.ts'
import {
  hasVerifiedOfficialSource,
  OFFICIAL_SOURCE_POLICIES,
  isVerifiedOfficialSource
} from '../src/shared/official-sources.ts'

const encoder = new TextEncoder()

test('官方源清单只通过频道 ID 与精确批准主机的组合', () => {
  assert.ok(OFFICIAL_SOURCE_POLICIES.length >= 10 && OFFICIAL_SOURCE_POLICIES.length <= 20)
  assert.equal(isVerifiedOfficialSource(
    { id: 'CGTN.cn' },
    { url: 'https://news.cgtn.com/resource/live/prog_index.m3u8' }
  ), true)
  assert.equal(isVerifiedOfficialSource(
    { id: 'CGTN.cn' },
    { url: 'https://news.cgtn.com.evil.example/live.m3u8' }
  ), false)
  assert.equal(isVerifiedOfficialSource(
    { id: 'Unknown.example' },
    { url: 'https://news.cgtn.com/live.m3u8' }
  ), false)
  assert.equal(hasVerifiedOfficialSource({
    id: 'CGTN.cn',
    sources: [
      { id: '1', url: 'https://news.cgtn.com.evil.example/live.m3u8', title: '', quality: '', label: '', feed: '' },
      { id: '2', url: 'https://news.cgtn.com/live.m3u8', title: '', quality: '', label: '', feed: '' }
    ]
  }), true)
  assert.equal(hasVerifiedOfficialSource({
    id: 'Unknown.example',
    sources: [{ id: '1', url: 'https://news.cgtn.com/live.m3u8', title: '', quality: '', label: '', feed: '' }]
  }), false)
})

test('HLS 解析器识别 Master、相对路径和媒体线路', () => {
  const parsed = parseHlsPlaylist(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.4d401f,mp4a.40.2"
video/index.m3u8
`)
  assert.equal(parsed.kind, 'master')
  assert.equal(parsed.variants.length, 1)
  assert.equal(parsed.renditions.length, 1)
  assert.equal(parsed.relativeReferences, true)
})

test('HLS 探测覆盖 Master、fMP4、Range 与跨域派生资源', async () => {
  const requested: Array<{ url: string; kind: string; range?: Readonly<{ start: number; end: number }> }> = []
  const fetcher: HlsProbeFetcher = async (url, kind, range) => {
    requested.push({ url, kind, ...(range ? { range } : {}) })
    if (url.endsWith('/master.m3u8')) {
      return response(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2"
media/live.m3u8
`, url)
    }
    if (url.endsWith('/media/live.m3u8')) {
      return response(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="https://media.example.net/init.mp4"
#EXT-X-BYTERANGE:65536@0
#EXTINF:6,
https://media.example.net/segment.m4s
`, url)
    }
    return { body: new Uint8Array(64), finalUrl: url, statusCode: 206 }
  }

  const result = await probeHlsSource('https://origin.example.com/master.m3u8', fetcher)
  assert.equal(result.accepted, true)
  assert.equal(result.redirected, false)
  assert.equal(result.playlistKind, 'master')
  assert.equal(result.segmentContainer, 'fmp4')
  assert.equal(result.relativeReferences, true)
  assert.equal(result.crossHostReferences, true)
  assert.equal(result.hasByteRanges, true)
  assert.equal(result.initRangeReadable, true)
  assert.equal(result.segmentRangeReadable, true)
  assert.equal(requested.filter((entry) => entry.kind === 'binary').length, 2)
  assert.ok(requested.filter((entry) => entry.kind === 'binary').every((entry) => entry.range?.end === 64 * 1_024))
})

test('HLS 探测识别 AES-128，并拒绝把 DRM 当成可接受明文源', async () => {
  const aesFetcher: HlsProbeFetcher = async (url, kind) => {
    if (kind === 'binary') return { body: new Uint8Array(16), finalUrl: url, statusCode: 200 }
    return response(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:6,
segment.ts
`, url)
  }
  const aes = await probeHlsSource('https://official.example/live.m3u8', aesFetcher)
  assert.equal(aes.accepted, true)
  assert.equal(aes.hasAes128, true)

  const drmFetcher: HlsProbeFetcher = async (url, kind) => kind === 'playlist'
    ? response(`#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://protected"
#EXTINF:6,
segment.m4s
`, url)
    : { body: new Uint8Array(64), finalUrl: url, statusCode: 206 }
  const drm = await probeHlsSource('https://official.example/protected.m3u8', drmFetcher)
  assert.equal(drm.accepted, false)
  assert.equal(drm.hasUnsupportedProtection, true)
  assert.match(drm.warning, /未尝试绕过/)
})

test('只有音频 rendition 的 Master 也能沿安全通道进入媒体清单', async () => {
  const fetcher: HlsProbeFetcher = async (url, kind) => {
    if (kind === 'binary') return { body: new Uint8Array(64), finalUrl: url, statusCode: 206 }
    if (url.endsWith('/master.m3u8')) {
      return response(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,URI="audio/index.m3u8"
`, url)
    }
    return response(`#EXTM3U
#EXTINF:6,
segment.aac
`, url)
  }
  const result = await probeHlsSource('https://audio.example/master.m3u8', fetcher)
  assert.equal(result.accepted, true)
  assert.equal(result.segmentContainer, 'audio')
})

function response(text: string, finalUrl: string) {
  return { body: encoder.encode(text), finalUrl, statusCode: 200 }
}
