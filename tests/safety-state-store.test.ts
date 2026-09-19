import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import {
  readSafetyStateFile, SafetyStateCommitUncertainError,
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

test('正式文件替换后读取失败明确报告提交待确认，文件仍可恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tv-feed-safety-readback-'))
  const path = join(directory, 'state.json')
  const originalOpen = fs.open
  const originalRename = fs.rename
  let committed = false
  try {
    fs.rename = async (from, to) => { await originalRename(from, to); committed = true }
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      if (committed && args[0] === path && args[1] === 'r') throw new Error('EIO')
      return originalOpen(...args)
    }
    syncBuiltinESMExports()
    await assert.rejects(writeSafetyStateAtomicAndVerify(path, validState), SafetyStateCommitUncertainError)
  } finally {
    fs.open = originalOpen
    fs.rename = originalRename
    syncBuiltinESMExports()
    try { assert.deepEqual(await readSafetyStateFile(path), validState) }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
})
