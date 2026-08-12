import assert from 'node:assert/strict'
import test from 'node:test'
import { toRemoteResourceFailure } from '../src/main/remote-resource-failure.ts'
import { SecureNetworkError } from '../src/main/secure-network.ts'

test('临时 DNS、离线网络和代理问题归为本机网络不可用', () => {
  const temporaryDns = Object.assign(new Error('query again private.example'), { code: 'EAI_AGAIN' })
  const missingDnsWhileOffline = Object.assign(new Error('not found private.example'), { code: 'ENOTFOUND' })

  assert.deepEqual(toRemoteResourceFailure(temporaryDns, true), {
    code: 'network-unavailable',
    retryable: true
  })
  assert.deepEqual(toRemoteResourceFailure(missingDnsWhileOffline, false), {
    code: 'network-unavailable',
    retryable: true
  })
  assert.deepEqual(toRemoteResourceFailure(new SecureNetworkError('proxy', '代理配置不可用', false), true), {
    code: 'network-unavailable',
    retryable: false
  })
})

test('确定性源站 DNS、HTTP 和内容错误保留各自固定类别', () => {
  const missingDns = Object.assign(new Error('not found source.example'), { code: 'ENOTFOUND' })
  assert.deepEqual(toRemoteResourceFailure(missingDns, true), { code: 'dns-failure', retryable: false })
  assert.deepEqual(
    toRemoteResourceFailure(new SecureNetworkError('http', 'remote HTTP 403', false, { statusCode: 403 }), true),
    { code: 'access-restricted', retryable: false }
  )
  assert.deepEqual(
    toRemoteResourceFailure(new Error('远程播放列表缺少 HLS 标头 private.example'), true),
    { code: 'invalid-playlist', retryable: false }
  )
  assert.deepEqual(
    toRemoteResourceFailure(new Error('远程请求重定向超过 5 次 private.example'), true),
    { code: 'redirect-rejected', retryable: false }
  )
})

test('源站拒绝或重置连接不会被误判成本机断网', () => {
  const refused = Object.assign(new Error('connect refused source.example'), { code: 'ECONNREFUSED' })
  const reset = Object.assign(new Error('socket reset source.example'), { code: 'ECONNRESET' })
  const localRouteDown = Object.assign(new Error('network unreachable'), { code: 'ENETUNREACH' })

  assert.deepEqual(toRemoteResourceFailure(refused, true), { code: 'source-offline', retryable: true })
  assert.deepEqual(toRemoteResourceFailure(reset, true), { code: 'source-offline', retryable: true })
  assert.deepEqual(toRemoteResourceFailure(localRouteDown, true), {
    code: 'network-unavailable',
    retryable: true
  })
})

test('跨进程失败信封不包含原始主机、URL 或底层错误文字', () => {
  const secret = 'https://private.example/live.m3u8?token=secret'
  const result = toRemoteResourceFailure(Object.assign(new Error(`getaddrinfo ENOTFOUND ${secret}`), {
    code: 'ENOTFOUND'
  }), true)
  const serialized = JSON.stringify(result)

  assert.deepEqual(result, { code: 'dns-failure', retryable: false })
  assert.doesNotMatch(serialized, /private\.example|https?:|secret|enotfound/i)
})
