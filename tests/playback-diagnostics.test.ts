import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyPlaybackDiagnostic,
  playbackDiagnosticInputForRemoteFailure
} from '../src/shared/playback-diagnostics.ts'

test('播放诊断识别安全网络失败类别', () => {
  assert.equal(classifyPlaybackDiagnostic('remote host example.test has no A/AAAA').code, 'dns-failure')
  assert.equal(classifyPlaybackDiagnostic('远程主机 example.test 解析到了非公网地址').code, 'unsafe-target')
  assert.equal(classifyPlaybackDiagnostic('远程请求重定向超过 5 次').code, 'redirect-rejected')
  assert.equal(classifyPlaybackDiagnostic('远程响应超过 2097152 字节安全上限').code, 'response-too-large')
  assert.equal(classifyPlaybackDiagnostic('远程播放列表缺少 HLS 标头').code, 'invalid-playlist')
})

test('播放诊断区分访问限制、超时、媒体错误和源站离线', () => {
  assert.equal(classifyPlaybackDiagnostic('HTTP Error 403 forbidden').code, 'access-restricted')
  assert.equal(classifyPlaybackDiagnostic('manifestLoadTimeout').code, 'source-timeout')
  assert.equal(classifyPlaybackDiagnostic('bufferIncompatibleCodecsError').code, 'unsupported-media')
  assert.equal(classifyPlaybackDiagnostic('当前系统无法启用安全 HLS 加载器').code, 'unsupported-media')
  assert.equal(classifyPlaybackDiagnostic('HTTP Error 502 upstream unavailable').code, 'source-offline')
})

test('主进程固定失败类别把本机网络中断与单一源站 DNS 失败分开', () => {
  const localNetwork = classifyPlaybackDiagnostic(playbackDiagnosticInputForRemoteFailure('network-unavailable'))
  const sourceDns = classifyPlaybackDiagnostic(playbackDiagnosticInputForRemoteFailure('dns-failure'))

  assert.equal(localNetwork.code, 'network-unavailable')
  assert.equal(localNetwork.title, '网络连接暂时不可用')
  assert.match(localNetwork.message, /Wi-Fi.*VPN.*系统代理/)
  assert.equal(sourceDns.code, 'dns-failure')
  assert.equal(sourceDns.title, '源站域名无法解析')
  assert.match(sourceDns.message, /稍后重试或选择其他线路/)
})

test('播放诊断绝不回显完整 URL、主机名或令牌', () => {
  const secret = 'https://private.example/live.m3u8?token=super-secret'
  const diagnostic = classifyPlaybackDiagnostic(`HTTP Error 403 while loading ${secret}`)
  const rendered = `${diagnostic.title} ${diagnostic.message}`

  assert.equal(diagnostic.code, 'access-restricted')
  assert.doesNotMatch(rendered, /https?:\/\//i)
  assert.doesNotMatch(rendered, /private\.example|super-secret|token/i)
})
