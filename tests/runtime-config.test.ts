import assert from 'node:assert/strict'
import test from 'node:test'
import { readRuntimeConfig } from '../src/main/runtime-config.ts'

test('开发服务器、显式开关和 smoke 都会开启脱敏运行诊断', () => {
  assert.equal(readRuntimeConfig({}).diagnostics.enabled, false)
  assert.equal(readRuntimeConfig({ ELECTRON_RENDERER_URL: 'http://localhost:5173' }).diagnostics.enabled, true)
  assert.equal(readRuntimeConfig({ TVFEED_DIAGNOSTICS: '1' }).diagnostics.enabled, true)
  assert.equal(readRuntimeConfig({ TVFEED_SMOKE_OUTPUT: '/tmp/result.png' }).diagnostics.enabled, true)
  assert.equal(readRuntimeConfig({ TVFEED_DIAGNOSTICS: '0' }).diagnostics.enabled, false)
})
