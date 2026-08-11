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
