import assert from 'node:assert/strict'
import test from 'node:test'
import type { Catalog, CatalogScope } from '../src/shared/catalog-contracts.ts'
import type {
  CatalogCacheCandidates,
  CatalogCacheRepositoryPort
} from '../src/main/catalog-cache.ts'
import { CatalogCoordinator } from '../src/main/catalog-coordinator.ts'
import { createOfflineSampleCatalog } from '../src/shared/sample-catalog.ts'

class MemoryCatalogCache implements CatalogCacheRepositoryPort {
  candidates: CatalogCacheCandidates = {}
  readonly writes: Array<{ scope: CatalogScope; catalog: Catalog }> = []
  clearCount = 0
  writeGate: Deferred<void> | undefined

  async readCandidates(): Promise<CatalogCacheCandidates> {
    return this.candidates
  }

  async write(scope: CatalogScope, catalog: Catalog, onVerifying = () => undefined): Promise<Catalog> {
    this.writes.push({ scope, catalog })
    await this.writeGate?.promise
    onVerifying()
    return catalog
  }

  async clear(): Promise<boolean> {
    this.clearCount += 1
    this.candidates = {}
    return true
  }
}

test('同范围同语义的目录加载共享操作与进度，启动加载可加入进行中的刷新', async () => {
  const cache = new MemoryCatalogCache()
  const gate = deferred<void>()
  let fetchCount = 0
  const coordinator = new CatalogCoordinator({
    cache,
    now: () => Date.parse('2026-08-11T00:00:00.000Z'),
    fetchCatalog: async (report) => {
      fetchCount += 1
      report({ stage: 'connecting', message: '连接中' })
      await gate.promise
      return { catalog: createOfflineSampleCatalog('2026-08-11T00:00:00.000Z'), warnings: [] }
    }
  })
  const progressIds: string[] = []
  const refresh = coordinator.load({ intent: 'refresh' }, 'standard', (progress) => progressIds.push(progress.operationId))
  await nextTurn()
  const startup = coordinator.load({ intent: 'startup' }, 'standard', (progress) => progressIds.push(progress.operationId))

  assert.strictEqual(startup, refresh)
  assert.equal(fetchCount, 1)
  gate.resolve()
  const result = await refresh
  assert.ok(progressIds.length >= 2)
  assert.ok(progressIds.every((operationId) => operationId === result.operationId))
})

test('显式刷新不会加入启动加载，较早操作晚到时不能覆盖较新缓存', async () => {
  const cache = new MemoryCatalogCache()
  const gates = [deferred<void>(), deferred<void>()]
  let fetchCount = 0
  const coordinator = new CatalogCoordinator({
    cache,
    now: () => Date.parse('2026-08-11T00:00:00.000Z'),
    fetchCatalog: async () => {
      const index = fetchCount++
      await gates[index]?.promise
      return {
        catalog: createOfflineSampleCatalog(`2026-08-11T00:00:0${index}.000Z`),
        warnings: []
      }
    }
  })

  const startup = coordinator.load({ intent: 'startup' }, 'standard')
  await nextTurn()
  const refresh = coordinator.load({ intent: 'refresh' }, 'standard')
  await nextTurn()
  assert.equal(fetchCount, 2)

  gates[1]?.resolve()
  const refreshResult = await refresh
  gates[0]?.resolve()
  const startupResult = await startup

  assert.notEqual(refreshResult.operationId, startupResult.operationId)
  assert.equal(cache.writes.length, 1)
  assert.equal(cache.writes[0]?.catalog.generatedAt, '2026-08-11T00:00:01.000Z')
  assert.match(startupResult.warning, /未覆盖较新的本机缓存/)
})

test('缓存失效与进行中的写入串行，失效期间完成的晚写会被清除并标记为失去权威', async () => {
  const cache = new MemoryCatalogCache()
  cache.writeGate = deferred<void>()
  const coordinator = new CatalogCoordinator({
    cache,
    fetchCatalog: async () => ({
      catalog: createOfflineSampleCatalog('2026-08-11T00:00:00.000Z'),
      warnings: []
    })
  })

  const load = coordinator.load({ intent: 'refresh' }, 'standard')
  while (cache.writes.length === 0) await nextTurn()
  const invalidation = coordinator.invalidateCache()
  assert.equal(cache.clearCount, 0)
  cache.writeGate.resolve()

  const result = await load
  assert.equal(await invalidation, true)
  assert.equal(cache.clearCount, 1)
  assert.match(result.warning, /缓存失效或更新操作之后完成/)
})

test('未来时间戳缓存不会被误判为新鲜缓存', async () => {
  const cache = new MemoryCatalogCache()
  cache.candidates = {
    current: {
      catalog: createOfflineSampleCatalog('2026-08-12T00:00:00.000Z'),
      source: 'v2',
      writtenAt: '2026-08-12T00:00:00.000Z'
    }
  }
  let fetchCount = 0
  const coordinator = new CatalogCoordinator({
    cache,
    now: () => Date.parse('2026-08-11T00:00:00.000Z'),
    fetchCatalog: async () => {
      fetchCount += 1
      return { catalog: createOfflineSampleCatalog('2026-08-11T00:00:00.000Z'), warnings: [] }
    }
  })
  const result = await coordinator.load({ intent: 'startup' }, 'standard')
  assert.equal(fetchCount, 1)
  assert.equal(result.cacheStatus, 'network')
})

test('清除缓存后的刷新不加入旧任务，并重新写入可供下次启动的缓存', async () => {
  const cache = new MemoryCatalogCache()
  const oldGate = deferred<void>()
  let fetches = 0
  const coordinator = new CatalogCoordinator({cache, fetchCatalog: async () => {
    const index = ++fetches
    if (index === 1) await oldGate.promise
    return {catalog: createOfflineSampleCatalog(`2026-08-11T00:00:0${index}.000Z`), warnings: []}
  }})
  const old = coordinator.load({intent:'refresh'}, 'standard')
  await nextTurn()
  await coordinator.invalidateCache()
  const replacement = coordinator.load({intent:'refresh'}, 'standard')
  assert.notStrictEqual(old, replacement)
  await replacement
  oldGate.resolve()
  await old
  assert.equal(fetches, 2)
  assert.equal(cache.writes.length, 1)
  assert.equal(cache.writes[0]?.catalog.generatedAt, '2026-08-11T00:00:02.000Z')
})

test('播放准入只接受已返回的当前安全范围目录中的频道与线路', async () => {
  const coordinator = new CatalogCoordinator({cache: new MemoryCatalogCache()})
  const result = coordinator.loadOfflineDemo('standard')
  const channel = result.catalog.channels[0]!
  const source = channel.sources[0]!
  assert.equal(coordinator.playbackSource('standard', channel.id, source.id).url, source.url)
  assert.throws(() => coordinator.playbackSource('family', channel.id, source.id))
  assert.throws(() => coordinator.playbackSource('standard', 'Unknown.channel', source.id))
  assert.throws(() => coordinator.playbackSource('standard', channel.id, 'Unknown.source'))
})

test('首次加载期间清除缓存后，返回的内存目录仍可播放但不会写回磁盘', async () => {
  const cache = new MemoryCatalogCache()
  const gate = deferred<void>()
  const coordinator = new CatalogCoordinator({
    cache,
    fetchCatalog: async () => {
      await gate.promise
      return { catalog: createOfflineSampleCatalog(), warnings: [] }
    }
  })
  const loading = coordinator.load({ intent: 'startup' }, 'standard')
  await nextTurn()
  await coordinator.invalidateCache()
  gate.resolve()
  const result = await loading
  const channel = result.catalog.channels[0]!
  const source = channel.sources[0]!
  assert.equal(cache.writes.length, 0)
  assert.equal(coordinator.playbackSource('standard', channel.id, source.id).url, source.url)
})

test('合并任务的一个调用者取消不会打断其他调用者，取消后不再收到进度', async () => {
  const cache = new MemoryCatalogCache()
  const gate = deferred<void>()
  let transportSignal: AbortSignal | undefined
  let reportProgress = (): void => undefined
  const coordinator = new CatalogCoordinator({ cache, fetchCatalog: async (report, signal) => {
    transportSignal = signal
    reportProgress = () => report({ stage: 'metadata', message: 'progress' })
    await gate.promise
    return { catalog: createOfflineSampleCatalog(), warnings: [] }
  } })
  const a = new AbortController(), b = new AbortController()
  let aProgress = 0, bProgress = 0
  const first = coordinator.load({ intent: 'refresh' }, 'standard', () => { aProgress += 1 }, a.signal)
  const second = coordinator.load({ intent: 'startup' }, 'standard', () => { bProgress += 1 }, b.signal)
  await nextTurn()
  a.abort(new Error('first-left'))
  await assert.rejects(first, /first-left/)
  const before = aProgress
  reportProgress()
  assert.equal(aProgress, before)
  assert.ok(bProgress > 1)
  assert.equal(transportSignal?.aborted, false)
  gate.resolve()
  await second
  assert.equal(cache.writes.length, 1)
})

test('最后一个调用者离开后中止上游，忽略迟到结果且不写缓存或接受目录', async () => {
  const cache = new MemoryCatalogCache()
  const gate = deferred<void>()
  let signal: AbortSignal | undefined
  const sample = createOfflineSampleCatalog()
  const coordinator = new CatalogCoordinator({ cache, fetchCatalog: async (_report, current) => {
    signal = current
    await gate.promise
    return { catalog: sample, warnings: [] }
  } })
  const caller = new AbortController()
  const result = coordinator.load({ intent: 'refresh' }, 'standard', undefined, caller.signal)
  await nextTurn()
  caller.abort(new Error('last-left'))
  await assert.rejects(result, /last-left/)
  assert.equal(signal?.aborted, true)
  gate.resolve()
  await nextTurn()
  assert.equal(cache.writes.length, 0)
  assert.throws(() => coordinator.playbackSource('standard', sample.channels[0]!.id, sample.channels[0]!.sources[0]!.id))
})

test('退出时同时取消当前和旧缓存纪元的任务', async () => {
  const signals: AbortSignal[] = []
  const coordinator = new CatalogCoordinator({ cache: new MemoryCatalogCache(), fetchCatalog: async (_report, signal) => {
    signals.push(signal)
    return new Promise(() => undefined)
  } })
  const old = coordinator.load({ intent: 'refresh' }, 'standard')
  await nextTurn()
  await coordinator.invalidateCache()
  const current = coordinator.load({ intent: 'refresh' }, 'standard')
  await nextTurn()
  coordinator.dispose()
  await Promise.all([assert.rejects(old), assert.rejects(current)])
  assert.equal(signals.length, 2)
  assert.ok(signals.every(signal => signal.aborted))
})

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
