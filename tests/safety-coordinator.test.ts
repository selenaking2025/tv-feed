import assert from 'node:assert/strict'
import test from 'node:test'
import { SafetyCoordinator } from '../src/main/safety-coordinator.ts'
import { SafetyStateCommitUncertainError, type SafetyStateStorePort } from '../src/main/safety-state-store.ts'
import type { SafetyStateSnapshot } from '../src/shared/safety-contracts.ts'

class MemorySafetyStore implements SafetyStateStorePort {
  state: SafetyStateSnapshot | undefined
  readonly writes: SafetyStateSnapshot[] = []

  async read(): Promise<SafetyStateSnapshot | undefined> {
    return this.state ? { ...this.state } : undefined
  }

  async write(state: SafetyStateSnapshot): Promise<SafetyStateSnapshot> {
    this.state = { ...state }
    this.writes.push({ ...state })
    return { ...state }
  }
}

test('首次迁移把家庭安全写入主进程权威状态，再清缓存并等待渲染端确认清理', async () => {
  const store = new MemorySafetyStore()
  let invalidations = 0
  let logoCancellations = 0
  const coordinator = new SafetyCoordinator({
    store,
    now: () => 42,
    invalidateCatalog: async () => { invalidations += 1; return true },
    revokePlayback: () => undefined,
    cancelRemoteLogos: () => { logoCancellations += 1 }
  })

  const state = await coordinator.initialize({ familySafety: true, remoteLogos: true })
  assert.equal(state.familySafety, true)
  assert.equal(state.remoteLogos, false)
  assert.equal(state.pendingCatalogInvalidation, false)
  assert.equal(state.pendingViewingDataClear, true)
  assert.equal(invalidations, 1)
  assert.ok(logoCancellations >= 1)
  assert.throws(() => coordinator.assertRemoteResourceAllowed('logo'), /家庭安全模式/)

  const acknowledged = await coordinator.acknowledgeViewingDataClear(state.transitionId)
  assert.equal(acknowledged.pendingViewingDataClear, false)
  const disabled = await coordinator.setFamilySafety(false)
  assert.equal(disabled.state.familySafety, false)
})

test('启用家庭安全时先持久化限制状态，再等待可能阻塞的缓存清理', async () => {
  const store = new MemorySafetyStore()
  const gate = deferred<void>()
  let invalidationStarted = false
  let playbackRevoked = false
  const coordinator = new SafetyCoordinator({
    store,
    invalidateCatalog: async () => {
      invalidationStarted = true
      await gate.promise
      return true
    },
    revokePlayback: () => {
      assert.equal(store.state?.familySafety, true)
      playbackRevoked = true
    },
    cancelRemoteLogos: () => undefined
  })
  await coordinator.initialize({ familySafety: false, remoteLogos: true })

  const transition = coordinator.setFamilySafety(true)
  while (!invalidationStarted) await nextTurn()
  assert.equal(store.state?.familySafety, true)
  assert.equal(store.state?.remoteLogos, false)
  assert.equal(store.state?.pendingCatalogInvalidation, true)
  assert.equal(playbackRevoked, true)
  assert.throws(() => coordinator.assertRemoteResourceAllowed('logo'), /家庭安全模式/)
  assert.throws(() => coordinator.assertCatalogScope('standard'), /安全范围已经改变/)
  gate.resolve()
  assert.equal((await transition).state.pendingCatalogInvalidation, false)
})

test('崩溃遗留的缓存清理标记会在下次初始化重试，失败时仍保持安全准入', async () => {
  const store = new MemorySafetyStore()
  store.state = {
    schemaVersion: 1,
    revision: 3,
    familySafety: true,
    remoteLogos: false,
    transitionId: 'safety-recovery-1',
    pendingCatalogInvalidation: true,
    pendingViewingDataClear: true
  }
  const failed = new SafetyCoordinator({
    store,
    invalidateCatalog: async () => { throw new Error('磁盘忙') },
    revokePlayback: () => undefined,
    cancelRemoteLogos: () => undefined
  })
  const stillPending = await failed.initialize({ familySafety: false, remoteLogos: false })
  assert.equal(stillPending.pendingCatalogInvalidation, true)
  assert.equal(stillPending.familySafety, true)
  assert.throws(() => failed.assertRemoteResourceAllowed('logo'))

  const recovered = new SafetyCoordinator({
    store,
    invalidateCatalog: async () => true,
    revokePlayback: () => undefined,
    cancelRemoteLogos: () => undefined
  })
  const state = await recovered.initialize({ familySafety: false, remoteLogos: false })
  assert.equal(state.pendingCatalogInvalidation, false)
  assert.equal(state.familySafety, true)
})

test('提交后确认失败会先撤权，再复读已提交状态并继续清理', async () => {
  const store = new MemorySafetyStore()
  const events: string[] = []
  const coordinator = new SafetyCoordinator({
    store,
    invalidateCatalog: async () => { events.push('clear'); return true },
    cancelRemoteLogos: () => { events.push('cancel') },
    revokePlayback: () => { events.push('revoke') }
  })
  await coordinator.initialize({ familySafety: false, remoteLogos: true })
  const write = store.write.bind(store)
  let failOnce = true
  store.write = async state => {
    const persisted = await write(state)
    if (failOnce) { failOnce = false; throw new SafetyStateCommitUncertainError(new Error('EIO')) }
    return persisted
  }
  store.read = async () => { events.push('read'); return store.state ? { ...store.state } : undefined }
  const result = await coordinator.setFamilySafety(true)
  assert.equal(result.state.familySafety, true)
  assert.equal(result.state.pendingCatalogInvalidation, false)
  assert.ok(events.indexOf('revoke') < events.indexOf('read'))
  assert.throws(() => coordinator.assertRemoteResourceAllowed('logo'))
})

test('持续复读失败或状态不匹配时关闭所有准入，重试后从磁盘恢复而不覆盖', async () => {
  const store = new MemorySafetyStore()
  const coordinator = new SafetyCoordinator({ store, invalidateCatalog: async () => true,
    cancelRemoteLogos: () => undefined, revokePlayback: () => undefined })
  await coordinator.initialize({ familySafety: false, remoteLogos: true })
  const write = store.write.bind(store)
  store.write = async state => {
    await write(state)
    throw new SafetyStateCommitUncertainError(new Error('EIO'))
  }
  store.read = async () => { throw new Error('EIO') }
  await assert.rejects(coordinator.setFamilySafety(true), /无法确认/)
  assert.throws(() => coordinator.catalogScope(), /尚未确认/)
  for (const kind of ['logo', 'hls-playlist', 'hls-binary'] as const) {
    assert.throws(() => coordinator.assertRemoteResourceAllowed(kind), /尚未确认/)
  }
  const committed = { ...store.state! }
  store.read = async () => ({ ...committed, familySafety: false })
  await assert.rejects(coordinator.initialize({ familySafety: false, remoteLogos: true }), /不一致/)
  assert.deepEqual(store.state, committed)
  store.write = write
  store.read = async () => ({ ...store.state! })
  const recovered = await coordinator.initialize({ familySafety: false, remoteLogos: true })
  assert.equal(recovered.familySafety, true)
  assert.equal(recovered.remoteLogos, false)
  assert.equal(recovered.pendingViewingDataClear, true)
  assert.equal(recovered.pendingCatalogInvalidation, false)
  await assert.rejects(coordinator.setFamilySafety(false), /未确认清除/)
  await coordinator.acknowledgeViewingDataClear(recovered.transitionId)
  assert.equal((await coordinator.setFamilySafety(false)).state.familySafety, false)
})

test('提交前失败保留已确认状态，后续写入可以重试', async () => {
  const store = new MemorySafetyStore()
  const coordinator = new SafetyCoordinator({ store, invalidateCatalog: async () => true,
    cancelRemoteLogos: () => undefined, revokePlayback: () => undefined })
  const initial = await coordinator.initialize({ familySafety: false, remoteLogos: true })
  const write = store.write.bind(store)
  store.write = async () => { throw new Error('ENOSPC') }
  await assert.rejects(coordinator.setFamilySafety(true), /ENOSPC/)
  assert.deepEqual(coordinator.snapshot(), initial)
  store.write = write
  assert.equal((await coordinator.setFamilySafety(true)).state.familySafety, true)
})

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
