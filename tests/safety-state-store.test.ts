import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  readSafetyStateFile,
  writeSafetyStateAtomicAndVerify
} from '../src/main/safety-state-store.ts'
import type { SafetyStateSnapshot } from '../src/shared/safety-contracts.ts'

const validState: SafetyStateSnapshot = {
  schemaVersion: 1,
  revision: 1,
  familySafety: true,
  remoteLogos: false,
  transitionId: 'safety-test-1',
  pendingCatalogInvalidation: true,
  pendingViewingDataClear: true
}

test('家庭安全状态只把不存在视为首次启动，损坏文件会失败关闭', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tv-feed-safety-corrupt-'))
  const path = join(directory, 'safety-state-v1.json')
  try {
    assert.equal(await readSafetyStateFile(path), undefined)
    await writeFile(path, '{"schemaVersion":1,"familySafety":')
    await assert.rejects(readSafetyStateFile(path))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('家庭安全状态使用原子写入并在正式路径复读完整状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tv-feed-safety-write-'))
  const path = join(directory, 'safety-state-v1.json')
  try {
    const persisted = await writeSafetyStateAtomicAndVerify(path, validState)
    assert.deepEqual(persisted, validState)
    assert.deepEqual(await readSafetyStateFile(path), validState)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
