import assert from 'node:assert/strict'
import test from 'node:test'
import { REMOTE_RESOURCE_LIMITS } from '../src/main/remote-resource-service.ts'
import { streamRemoteResource } from '../src/main/remote-resource-stream.ts'
import type { SecureFetchOptions, SecureStreamResult } from '../src/main/secure-network.ts'

test('流式资源服务只接受二进制 HLS，并把范围与安全上限交给网络层', async () => {
  let receivedOptions: SecureFetchOptions | undefined
  const result = await streamRemoteResource({
    requestId: 'stream-1',
    url: 'https://media.example.com/segment.ts',
    kind: 'hls-binary',
    rangeStart: 100,
    rangeEnd: 200
  }, new AbortController().signal, async (_url, options): Promise<SecureStreamResult> => {
    receivedOptions = options
    return {
      body: emptyBody(),
      contentType: 'video/mp2t',
      contentLength: 100,
      contentRange: 'bytes 100-199/1000',
      acceptRanges: 'bytes',
      finalUrl: 'https://media.example.com/segment.ts',
      statusCode: 206,
      connectionReused: false
    }
  })

  assert.equal(result.statusCode, 206)
  assert.equal(receivedOptions?.maxBytes, REMOTE_RESOURCE_LIMITS['hls-binary'].maxBytes)
  assert.equal(receivedOptions?.rangeStart, 100)
  assert.equal(receivedOptions?.rangeEnd, 200)
  assert.equal(receivedOptions?.allowCompression, false)

  await assert.rejects(streamRemoteResource({
    requestId: 'stream-2',
    url: 'https://media.example.com/master.m3u8',
    kind: 'hls-playlist'
  }, new AbortController().signal), /只接受 HLS 二进制资源/)
})

async function* emptyBody(): AsyncGenerator<Uint8Array> {
  return
}
