import assert from 'node:assert/strict'
import test from 'node:test'
import { createSecureHls } from '../src/renderer/src/hls-engine.ts'

test('production HLS 引擎在证据充分前保留既有 progressive 策略并暴露 A/B 对照', () => {
  const production = createSecureHls()
  const libraryDefault = createSecureHls('library-default')
  try {
    assert.equal(production.config.progressive, true)
    assert.equal(libraryDefault.config.progressive, false)
  } finally {
    production.destroy()
    libraryDefault.destroy()
  }
})
