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
    const session = broker.startPlayback(7, 'https://media.example/live.m3u8')
    const result = await broker.fetch(7, {
      playbackSessionId: session.sessionId,
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
    const session = broker.startPlayback(8, 'https://media.example/live.m3u8')
    const ticket = broker.prepareStream(8, {
      playbackSessionId: session.sessionId,
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

test('播放会话禁止跨窗口、旧会话和撤权后请求，撤权会同时撤销媒体流票据', async () => {
  const broker = new RemoteResourceBroker({assertAllowed:()=>undefined,isNetworkOnline:()=>true,rendererUrl:''})
  try {
    const first = broker.startPlayback(1, 'https://media.example/live.m3u8')
    const input = {requestId:'session-test',url:first.sourceUrl,kind:'hls-playlist' as const,playbackSessionId:first.sessionId}
    await assert.rejects(broker.fetch(2, input), /会话已失效/)
    const second = broker.startPlayback(1, first.sourceUrl)
    await assert.rejects(broker.fetch(1, input), /会话已失效/)
    broker.endPlayback(1, first.sessionId)
    const ticket = broker.prepareStream(1, {...input,kind:'hls-binary',playbackSessionId:second.sessionId})
    broker.revokePlayback()
    assert.equal((await broker.handleStreamRequest(new Request(ticket.streamUrl),new URL(ticket.streamUrl))).status, 404)
    await assert.rejects(broker.fetch(1, {...input,playbackSessionId:second.sessionId}), /会话已失效/)
  } finally { broker.dispose() }
})
