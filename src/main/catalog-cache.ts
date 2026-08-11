import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  CATALOG_LIMITS,
  isValidBoundedCatalog,
  parseCatalogCache,
  serializeCatalogForCache
} from '../shared/catalog-limits.ts'
import type { Catalog, CatalogScope } from '../shared/catalog-contracts.ts'

export const CATALOG_CACHE_SCHEMA_VERSION = 2
const CACHE_ENVELOPE_RESERVE_BYTES = 16 * 1_024

export interface CatalogCacheEnvelopeV2 {
  schemaVersion: 2
  scope: CatalogScope
  filterPolicyRevision: string
  generatedByAppVersion: string
  writtenAt: string
  catalog: Catalog
}

export interface CatalogCacheEntry {
  catalog: Catalog
  source: 'v2' | 'legacy-v1'
  writtenAt: string
}

export interface CatalogCacheCandidates {
  current?: CatalogCacheEntry
  legacy?: CatalogCacheEntry
}

export interface CatalogCacheRepositoryPort {
  readCandidates(scope: CatalogScope): Promise<CatalogCacheCandidates>
  write(scope: CatalogScope, catalog: Catalog, onVerifying?: () => void): Promise<Catalog>
  clear(): Promise<boolean>
}

export interface CatalogCacheRepositoryOptions {
  v2Path: string
  legacyV1Path: string
  filterPolicyRevision: string
  appVersion: string
  now?: () => Date
}

export class CatalogCacheRepository implements CatalogCacheRepositoryPort {
  private readonly options: CatalogCacheRepositoryOptions
  private readonly now: () => Date

  constructor(options: CatalogCacheRepositoryOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
  }

  async readCandidates(scope: CatalogScope): Promise<CatalogCacheCandidates> {
    const envelope = await readCatalogCacheV2File(this.options.v2Path)
    const current = envelope &&
      envelope.scope === scope &&
      envelope.filterPolicyRevision === this.options.filterPolicyRevision
      ? { catalog: envelope.catalog, source: 'v2' as const, writtenAt: envelope.writtenAt }
      : undefined

    // A v1 cache has no scope or filter-policy provenance. It can only be an
    // emergency standard-mode fallback after a network failure, never fresh.
    const legacyCatalog = scope === 'standard'
      ? await readCatalogCacheFile(this.options.legacyV1Path)
      : undefined
    const legacy = legacyCatalog
      ? { catalog: legacyCatalog, source: 'legacy-v1' as const, writtenAt: legacyCatalog.generatedAt }
      : undefined
    return {
      ...(current ? { current } : {}),
      ...(legacy ? { legacy } : {})
    }
  }

  async write(scope: CatalogScope, catalog: Catalog, onVerifying: () => void = () => undefined): Promise<Catalog> {
    const envelope: CatalogCacheEnvelopeV2 = {
      schemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
      scope,
      filterPolicyRevision: this.options.filterPolicyRevision,
      generatedByAppVersion: this.options.appVersion,
      writtenAt: this.now().toISOString(),
      catalog
    }
    const persisted = await writeCatalogCacheV2AtomicAndVerify(this.options.v2Path, envelope, onVerifying)
    // Delete legacy only after the replacement has passed a full read-back.
    await removeFile(this.options.legacyV1Path)
    return persisted.catalog
  }

  async clear(): Promise<boolean> {
    const [v2, legacy] = await Promise.all([
      removeFile(this.options.v2Path),
      removeFile(this.options.legacyV1Path)
    ])
    return v2 || legacy
  }
}

export async function readCatalogCacheFile(path: string): Promise<Catalog | undefined> {
  return readBoundedFile(path, CATALOG_LIMITS.maxCacheBytes, parseCatalogCache)
}

export async function readCatalogCacheV2File(path: string): Promise<CatalogCacheEnvelopeV2 | undefined> {
  return readBoundedFile(
    path,
    CATALOG_LIMITS.maxCacheBytes + CACHE_ENVELOPE_RESERVE_BYTES,
    parseCatalogCacheV2
  )
}

export async function writeCatalogCacheAtomicAndVerify(
  path: string,
  catalog: Catalog,
  onVerifying: () => void = () => undefined
): Promise<Catalog> {
  return writeAtomicAndVerify(
    path,
    serializeCatalogForCache(catalog),
    readCatalogCacheFile,
    (actual, label) => assertEquivalentCatalog(catalog, actual, label),
    onVerifying
  )
}

export async function writeCatalogCacheV2AtomicAndVerify(
  path: string,
  envelope: CatalogCacheEnvelopeV2,
  onVerifying: () => void = () => undefined
): Promise<CatalogCacheEnvelopeV2> {
  if (!isValidCatalogCacheEnvelopeV2(envelope)) throw new Error('目录缓存 V2 信封无效')
  // Validate the catalog independently so V2 cannot bypass the existing byte budget.
  serializeCatalogForCache(envelope.catalog)
  const serialized = JSON.stringify(envelope)
  if (new TextEncoder().encode(serialized).byteLength > CATALOG_LIMITS.maxCacheBytes + CACHE_ENVELOPE_RESERVE_BYTES) {
    throw new Error('目录缓存 V2 超过安全大小上限')
  }
  return writeAtomicAndVerify(
    path,
    serialized,
    readCatalogCacheV2File,
    (actual, label) => assertEquivalentEnvelope(envelope, actual, label),
    onVerifying
  )
}

export function parseCatalogCacheV2(body: Uint8Array): CatalogCacheEnvelopeV2 | undefined {
  if (body.byteLength > CATALOG_LIMITS.maxCacheBytes + CACHE_ENVELOPE_RESERVE_BYTES) return undefined
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    return isValidCatalogCacheEnvelopeV2(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isValidCatalogCacheEnvelopeV2(value: unknown): value is CatalogCacheEnvelopeV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<CatalogCacheEnvelopeV2>
  return candidate.schemaVersion === CATALOG_CACHE_SCHEMA_VERSION &&
    (candidate.scope === 'standard' || candidate.scope === 'family') &&
    typeof candidate.filterPolicyRevision === 'string' &&
    /^[A-Za-z0-9._-]{1,128}$/.test(candidate.filterPolicyRevision) &&
    typeof candidate.generatedByAppVersion === 'string' &&
    candidate.generatedByAppVersion.length > 0 &&
    candidate.generatedByAppVersion.length <= 64 &&
    typeof candidate.writtenAt === 'string' &&
    Number.isFinite(Date.parse(candidate.writtenAt)) &&
    isValidBoundedCatalog(candidate.catalog)
}

async function readBoundedFile<T>(
  path: string,
  maxBytes: number,
  parse: (body: Uint8Array) => T | undefined
): Promise<T | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const before = await handle.stat()
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) return undefined
    const body = new Uint8Array(before.size)
    let offset = 0
    while (offset < body.byteLength) {
      const { bytesRead } = await handle.read(body, offset, body.byteLength - offset, offset)
      if (bytesRead === 0) return undefined
      offset += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return undefined
    return parse(body)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeAtomicAndVerify<T>(
  path: string,
  serialized: string,
  readAt: (path: string) => Promise<T | undefined>,
  assertEquivalent: (actual: T | undefined, label: string) => asserts actual is T,
  onVerifying: () => void
): Promise<T> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(serialized, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined

    const stagedValue = await readAt(temporary)
    assertEquivalent(stagedValue, '临时缓存')
    await rename(temporary, path)

    onVerifying()
    const persisted = await readAt(path)
    assertEquivalent(persisted, '正式缓存')
    return persisted
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

function assertEquivalentEnvelope(
  expected: CatalogCacheEnvelopeV2,
  actual: CatalogCacheEnvelopeV2 | undefined,
  label: string
): asserts actual is CatalogCacheEnvelopeV2 {
  if (!actual ||
    actual.schemaVersion !== expected.schemaVersion ||
    actual.scope !== expected.scope ||
    actual.filterPolicyRevision !== expected.filterPolicyRevision ||
    actual.generatedByAppVersion !== expected.generatedByAppVersion ||
    actual.writtenAt !== expected.writtenAt) {
    throw new Error(`${label} V2 元数据复读不一致`)
  }
  assertEquivalentCatalog(expected.catalog, actual.catalog, label)
}

function assertEquivalentCatalog(expected: Catalog, actual: Catalog | undefined, label: string): asserts actual is Catalog {
  if (!actual) throw new Error(`${label}无法使用当前目录解析器重新读取`)
  const expectedSourceCount = countSources(expected)
  const actualSourceCount = countSources(actual)
  if (actual.source !== expected.source || actual.channels.length !== expected.channels.length || actualSourceCount !== expectedSourceCount) {
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

async function removeFile(path: string): Promise<boolean> {
  try {
    await unlink(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
