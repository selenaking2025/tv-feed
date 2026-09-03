import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyPlaybackStartRejection } from '../src/shared/playback-start-diagnostics.ts'

test('play() 拒绝按稳定 DOMException 名称分类', () => {
  assert.equal(classifyPlaybackStartRejection({ name: 'NotAllowedError' }).code, 'user-action-required')
  assert.equal(classifyPlaybackStartRejection({ name: 'AbortError' }).code, 'request-interrupted')
  assert.equal(classifyPlaybackStartRejection({ name: 'NotSupportedError' }).code, 'media-not-supported')
  assert.equal(classifyPlaybackStartRejection({ name: 'SecurityError' }).code, 'security-rejected')
  assert.equal(classifyPlaybackStartRejection(new Error('unexpected')).code, 'unknown')
})

test('play() 拒绝诊断不回显异常消息中的地址或令牌', () => {
  const rejection = classifyPlaybackStartRejection(Object.assign(
    new Error('https://private.example/live.m3u8?token=secret'),
    { name: 'NotAllowedError' }
  ))
  const serialized = JSON.stringify(rejection)

  assert.equal(rejection.code, 'user-action-required')
  assert.doesNotMatch(serialized, /https?:|private\.example|token|secret/i)
})
