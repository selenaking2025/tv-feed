import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readCatalogCacheFile, writeCatalogCacheAtomicAndVerify } from '../src/main/catalog-cache.ts'
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
