import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteResourceBroker } from '../src/main/remote-resource-broker.ts'
import { REMOTE_RESOURCE_FAILURE_HEADER } from '../src/shared/remote-resource-contracts.ts'

test('开发页面的媒体流在 Electron 仅保留 referrer 时仍能读取，未知来源不能消费票据', async () => {
  const origin = 'http://localhost:5173'
  let opened = 0
  const broker = new RemoteResourceBroker({
    assertAllowed: () => undefined,
    isNetworkOnline: () => true,
    rendererUrl: `${origin}/`
  }, {
    streamResource: async () => {
      opened += 1
      return {
        statusCode: 200, contentType: 'video/mp2t', contentLength: 3, finalUrl: 'https://media.example/segment.ts',
        contentRange: '', acceptRanges: '', connectionReused: false,
        body: (async function* () { yield Uint8Array.from([1, 2, 3]) })()
      }
    }
  })
  try {
    const session = broker.startPlayback(1, 'https://media.example/live.m3u8')
    const ticket = broker.prepareStream(1, {
      requestId: 'development-segment', kind: 'hls-binary',
      url: 'https://media.example/segment.ts', playbackSessionId: session.sessionId
    })
    const url = new URL(ticket.streamUrl)
    for (const init of [
      {},
      { referrer: 'http://localhost:5174/' },
      { headers: { Origin: 'https://untrusted.example' }, referrer: `${origin}/` }
    ]) {
      const rejected = await broker.handleStreamRequest(new Request(url, init), url)
      assert.equal(rejected.status, 403)
      assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), null)
    }
    assert.equal(opened, 0)
    const request = new Request(url, { referrer: `${origin}/` })
    const response = await broker.handleStreamRequest(request, url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin)
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([1, 2, 3]))
    assert.equal(opened, 1)
    assert.equal((await broker.handleStreamRequest(request, url)).status, 404)
  } finally {
    broker.dispose()
  }
})

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
