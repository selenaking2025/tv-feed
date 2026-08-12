import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteResourceBroker } from '../src/main/remote-resource-broker.ts'
import { REMOTE_RESOURCE_FAILURE_HEADER } from '../src/shared/remote-resource-contracts.ts'

test('缓冲资源失败通过固定信封返回，不把底层 DNS 文字跨进程抛出', async () => {
  const broker = new RemoteResourceBroker({
    assertAllowed: () => undefined,
    isNetworkOnline: () => true,
    rendererUrl: ''
  }, {
    fetchResource: async () => {
      throw Object.assign(new Error('query again private.example?token=secret'), { code: 'EAI_AGAIN' })
    }
  })

  try {
    const result = await broker.fetch(7, {
      requestId: 'playlist-1',
      url: 'https://media.example/live.m3u8',
      kind: 'hls-playlist'
    })
    assert.deepEqual(result, {
      ok: false,
      failure: { code: 'network-unavailable', retryable: true }
    })
    assert.doesNotMatch(JSON.stringify(result), /private\.example|token|secret|eai_again/i)
  } finally {
    broker.dispose()
  }
})

test('一次性媒体流建立失败返回固定类别响应头并保持票据单次消费', async () => {
  const broker = new RemoteResourceBroker({
    assertAllowed: () => undefined,
    isNetworkOnline: () => false,
    rendererUrl: ''
  }, {
    streamResource: async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND private.example'), { code: 'ENOTFOUND' })
    }
  })

  try {
    const ticket = broker.prepareStream(8, {
      requestId: 'segment-1',
      url: 'https://media.example/segment.ts',
      kind: 'hls-binary'
    })
    const request = new Request(ticket.streamUrl)
    const first = await broker.handleStreamRequest(request, new URL(ticket.streamUrl))
    const replay = await broker.handleStreamRequest(request, new URL(ticket.streamUrl))

    assert.equal(first.status, 503)
    assert.equal(first.headers.get(REMOTE_RESOURCE_FAILURE_HEADER), 'network-unavailable')
    assert.equal(await first.text(), '安全媒体流无法建立')
    assert.equal(replay.status, 404)
  } finally {
    broker.dispose()
  }
})
