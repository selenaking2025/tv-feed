import assert from 'node:assert/strict'
import test from 'node:test'
import { decideStallRecovery } from '../src/shared/playback-stability.ts'

test('持续无缓冲停滞先重载当前线路，再交给上层切线', () => {
  assert.equal(decideStallRecovery({
    stalledForMs: 7_999,
    bufferAheadSeconds: 0,
    recoveryAttempted: false,
    paused: false,
    hasSource: true
  }), 'wait')
  assert.equal(decideStallRecovery({
    stalledForMs: 8_000,
    bufferAheadSeconds: 0.4,
    recoveryAttempted: false,
    paused: false,
    hasSource: true
  }), 'restart-load')
  assert.equal(decideStallRecovery({
    stalledForMs: 16_000,
    bufferAheadSeconds: 0,
    recoveryAttempted: true,
    paused: false,
    hasSource: true
  }), 'failover')
  assert.equal(decideStallRecovery({
    stalledForMs: 20_000,
    bufferAheadSeconds: 1,
    recoveryAttempted: true,
    paused: false,
    hasSource: true
  }), 'wait')
})
