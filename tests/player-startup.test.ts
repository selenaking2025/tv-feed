import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { StreamPlayer, type PlaybackState } from '../src/renderer/src/player.ts'
import type { CatalogSource } from '../src/shared/catalog-contracts.ts'
import type { PlaybackDiagnostic } from '../src/shared/playback-diagnostics.ts'

const source: CatalogSource = {
  id: 'test:1', url: 'https://media.example/live.m3u8',
  title: 'Test', quality: '720p', label: 'Test', feed: ''
}

test('没有首帧且没有致命错误时，起播必须在 30 秒后结束并交给上层切线', (t) => {
  const { player, video, failures, states } = setup(t)
  player.load(source, 'test')
  video.paused = false
  video.dispatchEvent(new Event('waiting'))
  t.mock.timers.tick(29_999)
  assert.equal(failures.length, 0)
  t.mock.timers.tick(1)
  assert.equal(failures.length, 1)
  assert.equal(failures[0]?.code, 'source-timeout')
  assert.equal(states.at(-1), 'error')
  assert.equal(player.hasSource, false)
  t.mock.timers.tick(60_000)
  assert.equal(failures.length, 1)
})

test('首帧成功或停止播放后，不再触发起播超时', (t) => {
  const { player, video, failures } = setup(t)
  player.load(source, 'test')
  t.mock.timers.tick(10_000)
  video.paused = false
  video.dispatchEvent(new Event('playing'))
  t.mock.timers.tick(30_000)
  assert.equal(failures.length, 0)
  player.load(source, 'test')
  player.stop()
  t.mock.timers.tick(30_000)
  assert.equal(failures.length, 0)
})

test('切换线路后使用新起播期限，旧线路的超时不能中断新线路', (t) => {
  const { player, failures } = setup(t)
  player.load(source, 'test')
  t.mock.timers.tick(20_000)
  player.load({ ...source, id: 'test:2' }, 'test')
  t.mock.timers.tick(10_000)
  assert.equal(failures.length, 0)
  t.mock.timers.tick(20_000)
  assert.equal(failures.length, 1)
})

test('用户暂停或系统拒绝自动播放时，不把等待用户操作判为线路故障', async (t) => {
  const { player, video, failures, states } = setup(t)
  player.load(source, 'test')
  video.paused = false
  await player.toggle()
  t.mock.timers.tick(30_000)
  assert.equal(failures.length, 0)
  video.play = async () => { throw new DOMException('User gesture required', 'NotAllowedError') }
  await player.toggle()
  assert.equal(states.at(-1), 'paused')
  t.mock.timers.tick(30_000)
  assert.equal(failures.length, 0)
})

test('非自动播放不会计时，手动开始后仍有起播超时保护', async (t) => {
  const { player, failures } = setup(t)
  player.load(source, 'test', false)
  t.mock.timers.tick(30_000)
  assert.equal(failures.length, 0)
  await player.toggle()
  t.mock.timers.tick(30_000)
  assert.equal(failures[0]?.code, 'source-timeout')
})

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout, clearTimeout, setInterval, clearInterval,
      tvFeed: { startPlayback: () => new Promise(() => {}), endPlayback: () => undefined }
    }
  })
  const video = new TestVideo()
  const failures: PlaybackDiagnostic[] = []
  const states: PlaybackState[] = []
  const player = new StreamPlayer(video as unknown as HTMLVideoElement, {
    onState: (state) => states.push(state),
    onFatal: (_source, diagnostic) => failures.push(diagnostic),
    onMetrics: () => undefined
  })
  t.after(() => {
    player.stop()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  return { player, video, failures, states }
}

class TestVideo extends EventTarget {
  paused = true
  ended = false
  currentTime = 0
  buffered = { length: 0 }
  async play(): Promise<void> { this.paused = false }
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
  removeAttribute(): void {}
  load(): void {}
}
