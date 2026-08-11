import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CatalogCacheRepository,
  readCatalogCacheFile,
  readCatalogCacheV2File,
  writeCatalogCacheAtomicAndVerify
} from '../src/main/catalog-cache.ts'
import { createOfflineSampleCatalog } from '../src/shared/sample-catalog.ts'

test('频道缓存经临时文件原子替换后使用同一解析器复读并核对计数', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tv-feed-cache-test-'))
  const destination = join(directory, 'catalog-v1.json')
  try {
    const catalog = createOfflineSampleCatalog('2026-08-10T00:00:00.000Z')
    const persisted = await writeCatalogCacheAtomicAndVerify(destination, catalog)
    const reread = await readCatalogCacheFile(destination)

    assert.ok(reread)
    assert.equal(persisted.channels.length, catalog.channels.length)
    assert.equal(reread.channels.length, catalog.channels.length)
    assert.equal(
      reread.channels.reduce((total, channel) => total + channel.sources.length, 0),
      catalog.channels.reduce((total, channel) => total + channel.sources.length, 0)
    )
    assert.deepEqual(await readdir(directory), ['catalog-v1.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('损坏缓存不会被当成可跨启动使用的目录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tv-feed-cache-corrupt-test-'))
  const destination = join(directory, 'catalog-v1.json')
  try {
    await writeFile(destination, '{"version":1,"channels":')
    assert.equal(await readCatalogCacheFile(destination), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('V2 缓存记录范围、过滤策略和应用版本，复读成功后才删除旧缓存', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tv-feed-cache-v2-test-'))
  const legacyPath = join(directory, 'catalog-v1.json')
  const v2Path = join(directory, 'catalog-v2.json')
  try {
    const catalog = createOfflineSampleCatalog('2026-08-11T00:00:00.000Z')
    await writeCatalogCacheAtomicAndVerify(legacyPath, catalog)
    const repository = new CatalogCacheRepository({
      v2Path,
      legacyV1Path: legacyPath,
      filterPolicyRevision: 'filter-v1-test',
      appVersion: '0.1.0',
      now: () => new Date('2026-08-11T01:00:00.000Z')
    })
    await repository.write('family', catalog)

    const envelope = await readCatalogCacheV2File(v2Path)
    assert.equal(envelope?.schemaVersion, 2)
    assert.equal(envelope?.scope, 'family')
    assert.equal(envelope?.filterPolicyRevision, 'filter-v1-test')
    assert.equal(envelope?.generatedByAppVersion, '0.1.0')
    assert.equal(await readCatalogCacheFile(legacyPath), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('策略或范围不匹配的 V2 缓存不具备读取权威，旧 V1 仅可作为标准模式降级候选', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tv-feed-cache-policy-test-'))
  const legacyPath = join(directory, 'catalog-v1.json')
  const v2Path = join(directory, 'catalog-v2.json')
  try {
    const catalog = createOfflineSampleCatalog('2026-08-11T00:00:00.000Z')
    await writeCatalogCacheAtomicAndVerify(legacyPath, catalog)
    const writer = new CatalogCacheRepository({
      v2Path,
      legacyV1Path: join(directory, 'missing-v1.json'),
      filterPolicyRevision: 'filter-v1-old',
      appVersion: '0.1.0'
    })
    await writer.write('standard', catalog)
    const reader = new CatalogCacheRepository({
      v2Path,
      legacyV1Path: legacyPath,
      filterPolicyRevision: 'filter-v2-new',
      appVersion: '0.2.0'
    })

    const standard = await reader.readCandidates('standard')
    assert.equal(standard.current, undefined)
    assert.equal(standard.legacy?.source, 'legacy-v1')
    const family = await reader.readCandidates('family')
    assert.equal(family.current, undefined)
    assert.equal(family.legacy, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
