import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CATALOG_LIMITS, parseCatalogCache, serializeCatalogForCache } from '../shared/catalog-limits.ts'
import type { Catalog } from '../shared/contracts.ts'

export async function readCatalogCacheFile(path: string): Promise<Catalog | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const before = await handle.stat()
    if (!before.isFile() || before.size <= 0 || before.size > CATALOG_LIMITS.maxCacheBytes) return undefined

    const body = new Uint8Array(before.size)
    let offset = 0
    while (offset < body.byteLength) {
      const { bytesRead } = await handle.read(body, offset, body.byteLength - offset, offset)
      if (bytesRead === 0) return undefined
      offset += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return undefined
    return parseCatalogCache(body)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function writeCatalogCacheAtomicAndVerify(
  path: string,
  catalog: Catalog,
  onVerifying: () => void = () => undefined
): Promise<Catalog> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  const serialized = serializeCatalogForCache(catalog)
  await mkdir(dirname(path), { recursive: true })

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(serialized, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined

    const staged = await readCatalogCacheFile(temporary)
    assertEquivalentCatalog(catalog, staged, '临时缓存')
    await rename(temporary, path)

    onVerifying()
    const persisted = await readCatalogCacheFile(path)
    assertEquivalentCatalog(catalog, persisted, '正式缓存')
    return persisted
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

function assertEquivalentCatalog(expected: Catalog, actual: Catalog | undefined, label: string): asserts actual is Catalog {
  if (!actual) throw new Error(`${label}无法使用当前目录解析器重新读取`)
  const expectedSourceCount = countSources(expected)
  const actualSourceCount = countSources(actual)
  if (
    actual.source !== expected.source ||
    actual.channels.length !== expected.channels.length ||
    actualSourceCount !== expectedSourceCount
  ) {
    throw new Error(
      `${label}复读计数不一致：频道 ${expected.channels.length}/${actual.channels.length}，线路 ${expectedSourceCount}/${actualSourceCount}`
    )
  }
  for (let index = 0; index < expected.channels.length; index += 1) {
    if (expected.channels[index]?.id !== actual.channels[index]?.id) {
      throw new Error(`${label}复读后的频道顺序或标识不一致`)
    }
  }
}

function countSources(catalog: Catalog): number {
  return catalog.channels.reduce((total, channel) => total + channel.sources.length, 0)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
