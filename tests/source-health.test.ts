import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseSourceHealthStore,
  rankSources,
  recordSourceFailure,
  recordSourceSuccess,
  serializeSourceHealthStore
} from '../src/shared/source-health.ts'

const NOW = 2_000_000

test('未知线路保持目录顺序，成功线路上浮，近期连续失败线路进入冷却', () => {
  const sources = [{ id: 'source-a' }, { id: 'source-b' }, { id: 'source-c' }]
  let records = new Map()
  assert.deepEqual(rankSources(sources, records, new Set(), NOW).map((entry) => entry.source.id), [
    'source-a', 'source-b', 'source-c'
  ])

  records = recordSourceSuccess(records, 'source-b', { startupMs: 3_000, stallRatio: 0.01 }, NOW - 1_000)
  records = recordSourceFailure(records, 'source-a', NOW - 500)
  assert.deepEqual(rankSources(sources, records, new Set(), NOW).map((entry) => entry.source.id), [
    'source-b', 'source-c', 'source-a'
  ])
  assert.deepEqual(rankSources(sources, records, new Set(['source-b']), NOW).map((entry) => entry.source.id), [
    'source-c', 'source-a'
  ])
})

test('线路健康记录有界、可复读且不接受 URL 作为标识', () => {
  let records = new Map()
  for (let index = 0; index < 220; index += 1) {
    records = recordSourceSuccess(records, `source-${index}`, { startupMs: 4_000, stallRatio: 0 }, NOW + index)
  }
  const serialized = serializeSourceHealthStore(records)
  const parsed = parseSourceHealthStore(serialized, NOW + 1_000)
  assert.equal(parsed.size, 200)
  assert.equal(serialized.includes('://'), false)

  const unsafe = JSON.stringify({
    version: 1,
    records: [{
      sourceId: 'https://media.example.com/live.m3u8',
      successCount: 1,
      failureCount: 0,
      consecutiveFailures: 0,
      averageStartupMs: 1_000,
      averageStallRatio: 0,
      lastSuccessAt: NOW,
      lastFailureAt: 0,
      updatedAt: NOW
    }]
  })
  assert.equal(parseSourceHealthStore(unsafe, NOW).size, 0)
})
