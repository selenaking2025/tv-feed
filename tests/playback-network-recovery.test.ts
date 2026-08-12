import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PlaybackNetworkRecoveryGate,
  type PlaybackNetworkTarget
} from '../src/renderer/src/playback-network-recovery.ts'

const TARGET: PlaybackNetworkTarget = {
  channelId: 'bbc-news',
  sourceId: 'bbc-news-1',
  sourceIndex: 0
}

test('网络仍离线时保留当前线路，主进程确认在线后只放行一次', () => {
  const gate = new PlaybackNetworkRecoveryGate(30_000)
  const pending = gate.suspend(TARGET)

  assert.equal(gate.shouldSchedule(1_000), true)
  assert.equal(gate.claim(pending, false, TARGET, 1_000), undefined)
  assert.deepEqual(gate.snapshot(), pending)
  assert.deepEqual(gate.claim(pending, true, TARGET, 2_000), TARGET)
  assert.equal(gate.snapshot(), undefined)
  assert.equal(gate.claim(pending, true, TARGET, 2_001), undefined)
})

test('频道或线路已改变时拒绝迟到的网络确认', () => {
  const gate = new PlaybackNetworkRecoveryGate(30_000)
  const pending = gate.suspend(TARGET)
  const changed = { ...TARGET, sourceId: 'bbc-news-2', sourceIndex: 1 }

  assert.equal(gate.claim(pending, true, changed, 1_000), undefined)
  assert.equal(gate.snapshot(), undefined)
})

test('新代次使旧确认失效，冷却期阻止失败循环，显式重置恢复预算', () => {
  const gate = new PlaybackNetworkRecoveryGate(30_000)
  const oldPending = gate.suspend(TARGET)
  const currentPending = gate.suspend(TARGET)

  assert.equal(gate.claim(oldPending, true, TARGET, 1_000), undefined)
  assert.deepEqual(gate.claim(currentPending, true, TARGET, 2_000), TARGET)

  gate.suspend(TARGET)
  assert.equal(gate.shouldSchedule(31_999), false)
  assert.equal(gate.shouldSchedule(32_000), true)
  gate.reset()
  assert.equal(gate.snapshot(), undefined)
  assert.equal(gate.shouldSchedule(32_001), false)
})
