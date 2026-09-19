import assert from 'node:assert/strict'
import test from 'node:test'
import { PlaybackController } from '../src/renderer/src/playback-controller.ts'
import { ViewingState } from '../src/renderer/src/viewing-state.ts'
import { createOfflineSampleCatalog } from '../src/shared/sample-catalog.ts'
import { classifyPlaybackDiagnostic, playbackDiagnosticInputForRemoteFailure } from '../src/shared/playback-diagnostics.ts'
import type { CatalogSource } from '../src/shared/catalog-contracts.ts'
import type { PlaybackMetricsSnapshot } from '../src/shared/playback-metrics.ts'
import type { PlaybackState } from '../src/renderer/src/player.ts'

const offline = classifyPlaybackDiagnostic(playbackDiagnosticInputForRemoteFailure('network-unavailable'))
const failed = classifyPlaybackDiagnostic(playbackDiagnosticInputForRemoteFailure('access-restricted'))
const timeout = classifyPlaybackDiagnostic(playbackDiagnosticInputForRemoteFailure('source-timeout'))

test('线路失败逐个切换，耗尽后手动播放重新尝试完整线路集合', async () => {
  const f = setup()
  f.controller.selectChannel(f.channel.id, true, true)
  await f.fatal(f.channel.sources[0]!, failed)
  assert.equal(f.loads.at(-1), f.channel.sources[1]!.id)
  await f.fatal(f.channel.sources[1]!, failed)
  assert.equal(f.states.at(-1), 'error')
  await f.controller.toggle()
  await f.fatal(f.channel.sources[1]!, failed)
  assert.equal(f.loads.at(-1), f.channel.sources[0]!.id)
  assert.equal(f.loads.length, 4)
})

test('断网不记录线路失败，重复在线事件只确认和重连一次', async () => {
  const f = setup()
  f.controller.selectChannel(f.channel.id, true, false)
  await f.fatal(f.channel.sources[0]!, offline)
  assert.equal(f.viewing.health.size, 0)
  assert.equal(f.loads.length, 1)
  const gate = deferred<boolean>()
  let checks = 0
  f.network.check = () => { checks += 1; return gate.promise }
  const first = f.controller.retryPendingNetwork('online')
  const second = f.controller.retryPendingNetwork('online')
  gate.resolve(true)
  await Promise.all([first, second])
  assert.equal(checks, 1)
  assert.equal(f.loads.length, 2)
  assert.equal(f.loads[0], f.loads[1])
  assert.equal(f.timers.size, 0)
  await f.fatal(f.channel.sources[0]!, offline)
  assert.equal(f.timers.size, 0, '30 秒冷却期内不应再次自动安排重试')
})

test('停止或切台使迟到的断网检查失效，不重连旧频道、不污染线路健康', async () => {
  for (const action of ['stop', 'switch'] as const) {
    const f = setup()
    f.controller.selectChannel(f.channel.id, true, false)
    const gate = deferred<boolean>()
    f.network.check = () => gate.promise
    const pending = f.fatal(f.channel.sources[0]!, timeout)
    if (action === 'stop') f.controller.stop()
    else f.controller.selectChannel(f.other.id, true, false)
    gate.resolve(false)
    await pending
    assert.equal(f.viewing.health.size, 0)
    assert.equal(f.timers.size, 0)
    assert.equal(await f.controller.retryPendingNetwork('online'), false)
    assert.equal(f.loads.length, action === 'stop' ? 1 : 2)
  }
})

test('待恢复期间切台，即使旧在线确认迟到也不会覆盖新线路', async () => {
  const f = setup()
  f.controller.selectChannel(f.channel.id, true, false)
  await f.fatal(f.channel.sources[0]!, offline)
  const gate = deferred<boolean>()
  f.network.check = () => gate.promise
  const pending = f.controller.retryPendingNetwork('online')
  f.controller.selectChannel(f.other.id, true, false)
  gate.resolve(true)
  await pending
  assert.equal(f.controller.selectedChannelId, f.other.id)
  assert.equal(f.loads.length, 2)
  assert.equal(f.loads.at(-1), f.other.sources[0]!.id)
})

test('只为当前稳定播放线路记录一次成功，清理记录后可重新观察', () => {
  const f = setup()
  f.controller.selectChannel(f.channel.id, true, false)
  const sample: PlaybackMetricsSnapshot = {
    sourceId: f.channel.sources[0]!.id, startupMs: 500, currentTime: 20, mediaAdvancedSeconds: 20,
    bufferAheadSeconds: 10, stallCount: 0, stallDurationMs: 0, fragmentCount: 10, fragmentBytes: 1000,
    fragmentLoadRatioP95: 0.1, retryCount: 0, reusedConnectionCount: 0, droppedFrames: 0,
    totalFrames: 500, droppedFrameRatio: 0
  }
  f.controller.handleMetrics({ ...sample, sourceId: f.other.sources[0]!.id })
  f.controller.handleMetrics({ ...sample, mediaAdvancedSeconds: 10 })
  f.controller.handleMetrics({ ...sample, droppedFrameRatio: 0.1 })
  assert.equal(f.viewing.health.size, 0)
  f.controller.handleMetrics(sample)
  f.controller.handleMetrics(sample)
  assert.equal(f.viewing.health.get(sample.sourceId)?.successCount, 1)
  f.viewing.clearAll()
  f.controller.resetHealthObservation()
  f.controller.handleMetrics(sample)
  assert.equal(f.viewing.health.get(sample.sourceId)?.successCount, 1)
})

function setup() {
  const channels = createOfflineSampleCatalog().channels
  const channel = channels.find(value => value.sources.length === 2)!
  const other = channels.find(value => value.id !== channel.id)!
  const storage = new Map<string, string>()
  const viewing = new ViewingState({ getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } })
  const loads: string[] = []
  const states: PlaybackState[] = []
  const timers = new Map<number, () => void>()
  let sequence = 0
  const network = { check: async () => true }
  const player = {
    hasSource: false,
    load: (source: CatalogSource) => { player.hasSource = true; loads.push(source.id) },
    stop: () => { player.hasSource = false },
    toggle: async () => undefined
  }
  const controller = new PlaybackController({
    player, viewing, channel: id => channels.find(value => value.id === id),
    isNetworkOnline: () => network.check(), canRecordHealth: () => true,
    clock: { now: () => 0, setTimeout: callback => { timers.set(++sequence, callback); return sequence },
      clearTimeout: id => { timers.delete(id) } },
    view: { selected: () => undefined, starting: () => undefined, state: state => { states.push(state) },
      diagnostic: () => undefined, metrics: () => undefined, recentChanged: () => undefined, toast: () => undefined }
  })
  const fatal: typeof controller.handleFatal = async (source, diagnostic) => {
    player.hasSource = false
    await controller.handleFatal(source, diagnostic)
  }
  return { controller, channel, other, loads, viewing, network, timers, states, fatal }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
