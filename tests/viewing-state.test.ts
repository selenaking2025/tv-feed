import assert from 'node:assert/strict'
import test from 'node:test'
import { ViewingState } from '../src/renderer/src/viewing-state.ts'

function storageFor(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries))
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) } }
}

test('进入演示、收藏和播放样例、返回真实目录均不修改真实观看数据', () => {
  const storage = storageFor({
    'tvfeed:favorites:v1': '["Existing.channel","TemporarilyMissing.channel"]',
    'tvfeed:recents:v1': '["Existing.channel"]',
    'tvfeed:last-channel:v1': 'Existing.channel'
  })
  const before = new Map(storage.values)
  const viewing = new ViewingState(storage)
  viewing.useCatalog('offline-sample')
  viewing.select('Sample.demo')
  viewing.remember('Sample.demo')
  viewing.toggleFavorite('Sample.demo')
  viewing.recordFailure('Sample-source')
  assert.deepEqual(storage.values, before)
  assert.equal(viewing.lastChannel, 'Sample.demo')
  viewing.useCatalog('iptv-org')
  assert.equal(viewing.lastChannel, 'Existing.channel')
  assert.ok(viewing.favorites.has('TemporarilyMissing.channel'))
  assert.deepEqual(viewing.recents, ['Existing.channel'])
  assert.deepEqual(storage.values, before)
})

test('家庭清理同时清除真实和演示观看记录并保留收藏，显式清除会删除全部收藏', () => {
  const storage = storageFor({'tvfeed:favorites:v1': '["Existing.channel"]'})
  const viewing = new ViewingState(storage)
  viewing.remember('Existing.channel')
  viewing.useCatalog('offline-sample')
  viewing.remember('Sample.demo')
  assert.equal(viewing.clearWatching(), true)
  assert.deepEqual(viewing.recents, [])
  viewing.useCatalog('iptv-org')
  assert.deepEqual(viewing.recents, [])
  assert.ok(viewing.favorites.has('Existing.channel'))
  assert.equal(viewing.clearAll(), true)
  assert.equal(storage.values.size, 0)
})

test('存储清理失败必须报告失败，不能确认已完成家庭数据清理', () => {
  const storage = storageFor({'tvfeed:recents:v1': '["Existing.channel"]'})
  storage.removeItem = () => { throw new Error('storage unavailable') }
  assert.equal(new ViewingState(storage).clearWatching(), false)
})
