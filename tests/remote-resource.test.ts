import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fetchRemoteResource,
  REMOTE_RESOURCE_LIMITS,
  validateRemoteResourceRequest
} from '../src/main/remote-resource-service.ts'
import type { RemoteResourceKind, RemoteResourceRequest } from '../src/shared/contracts.ts'
import type { SecureFetchOptions, SecureFetchResult } from '../src/main/secure-network.ts'

test('HLS 播放列表、JSON、分片/密钥和 Logo 全部经过同一个安全请求接口', async () => {
  const calls: Array<{ url: string; options: SecureFetchOptions }> = []
  const fetcher = async (url: string, options: SecureFetchOptions): Promise<SecureFetchResult> => {
    calls.push({ url, options })
    const kind = kindFromAccept(options.accept)
    return {
      body: bodyFor(kind),
      contentType: kind === 'hls-json' ? 'application/json' : 'application/octet-stream',
      finalUrl: url,
      statusCode: 200
    }
  }

  for (const kind of ['hls-playlist', 'hls-json', 'hls-binary', 'logo'] as const) {
    await fetchRemoteResource(request(kind), new AbortController().signal, fetcher)
  }

  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map((call) => call.url), [
    'https://media.example.com/resource',
    'https://media.example.com/resource',
    'https://media.example.com/resource',
    'https://media.example.com/resource'
  ])
  assert.deepEqual(calls.map((call) => call.options.maxBytes), [
    REMOTE_RESOURCE_LIMITS['hls-playlist'].maxBytes,
    REMOTE_RESOURCE_LIMITS['hls-json'].maxBytes,
    REMOTE_RESOURCE_LIMITS['hls-binary'].maxBytes,
    REMOTE_RESOURCE_LIMITS.logo.maxBytes
  ])
  assert.deepEqual(calls.map((call) => call.options.allowCompression), [true, true, false, false])
})

test('远程播放列表必须是 HLS，远程 Logo 必须是安全位图', async () => {
  const invalidPlaylist = async (): Promise<SecureFetchResult> => ({
    body: new TextEncoder().encode('<html>not hls</html>'),
    contentType: 'text/html',
    finalUrl: 'https://media.example.com/manifest',
    statusCode: 200
  })
  await assert.rejects(
    fetchRemoteResource(request('hls-playlist'), new AbortController().signal, invalidPlaylist),
    /缺少 HLS 标头/
  )

  const svgLogo = async (): Promise<SecureFetchResult> => ({
    body: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    contentType: 'image/svg+xml',
    finalUrl: 'https://media.example.com/logo.svg',
    statusCode: 200
  })
  await assert.rejects(
    fetchRemoteResource(request('logo'), new AbortController().signal, svgLogo),
    /不是受支持的安全位图格式/
  )
})

test('IPC 请求拒绝超长 URL、不完整 Range 和未知资源类型', () => {
  assert.throws(() => validateRemoteResourceRequest({
    requestId: 'x',
    url: `https://example.com/${'x'.repeat(4_096)}`,
    kind: 'hls-binary'
  }), /URL 无效/)
  assert.throws(() => validateRemoteResourceRequest({
    requestId: 'x',
    url: 'https://media.example.com/segment.ts',
    kind: 'hls-binary',
    rangeStart: 0
  }), /必须成对提供/)
  assert.throws(() => validateRemoteResourceRequest({
    requestId: 'x',
    url: 'https://media.example.com/segment.ts',
    kind: 'unknown'
  }), /类型无效/)
})

function request(kind: RemoteResourceKind): RemoteResourceRequest {
  return {
    requestId: `test-${kind}`,
    url: 'https://media.example.com/resource',
    kind
  }
}

function kindFromAccept(accept: string): RemoteResourceKind {
  if (accept.includes('mpegurl')) return 'hls-playlist'
  if (accept.includes('application/json')) return 'hls-json'
  if (accept.includes('image/png')) return 'logo'
  return 'hls-binary'
}

function bodyFor(kind: RemoteResourceKind): Uint8Array {
  if (kind === 'hls-playlist') return new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n')
  if (kind === 'hls-json') return new TextEncoder().encode('{"ok":true}')
  if (kind === 'logo') return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Uint8Array.from([0, 1, 2, 3])
}
