import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bufferedAheadSeconds,
  evaluatePlaybackContinuity,
  mediaAdvanceDelta,
  percentile95
} from '../src/shared/playback-metrics.ts'

test('播放指标计算当前时间所在缓冲区间的前向秒数', () => {
  assert.equal(bufferedAheadSeconds(12, [{ start: 0, end: 10 }, { start: 11, end: 20 }]), 8)
  assert.equal(bufferedAheadSeconds(10.5, [{ start: 11, end: 20 }]), 0)
  assert.equal(bufferedAheadSeconds(4, [{ start: 4.04, end: 8 }]), 4)
})

test('P95 忽略无效样本并保留高延迟尾部', () => {
  assert.equal(percentile95([]), null)
  assert.equal(percentile95([Number.NaN, -1, 0.4, 0.8, 1.2]), 1.2)
  assert.equal(percentile95(Array.from({ length: 20 }, (_, index) => index + 1)), 19)
})

test('累计播放推进忽略直播时间轴回跳和异常大幅跳转', () => {
  assert.equal(mediaAdvanceDelta(10, 10.5), 0.5)
  assert.equal(mediaAdvanceDelta(30, 0), 0)
  assert.equal(mediaAdvanceDelta(10, 30), 0)
  assert.equal(mediaAdvanceDelta(Number.NaN, 1), 0)
})

test('连续播放验收要求时间推进、低停顿和低掉帧', () => {
  const passing = evaluatePlaybackContinuity({
    startedCurrentTime: 100,
    endedCurrentTime: 126,
    observationMs: 30_000,
    stallDurationMs: 500,
    droppedFrames: 2,
    totalFrames: 900,
    readyState: 4,
    paused: false,
    width: 1920
  })
  assert.equal(passing.passed, true)

  const frozen = evaluatePlaybackContinuity({
    startedCurrentTime: 100,
    endedCurrentTime: 104,
    observationMs: 30_000,
    stallDurationMs: 8_000,
    droppedFrames: 60,
    totalFrames: 900,
    readyState: 2,
    paused: false,
    width: 1920
  })
  assert.equal(frozen.passed, false)
  assert.deepEqual(frozen.reasons, [
    '观察期内播放时间推进不足',
    '观察期内缓冲停顿超过 5%',
    '观察期内掉帧超过 2%'
  ])
})
