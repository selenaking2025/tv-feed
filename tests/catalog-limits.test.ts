import assert from 'node:assert/strict'
import test from 'node:test'
import { transformIptvData } from '../src/shared/catalog.ts'
import {
  assertBoundedUpstreamBundle,
  CATALOG_LIMITS,
  isValidBoundedCatalog,
  parseBoundedJsonArray,
  parseCatalogCache,
  serializeCatalogForCache
} from '../src/shared/catalog-limits.ts'
import type { Catalog, UpstreamBundle } from '../src/shared/contracts.ts'

test('JSON 数组在解析后立即执行记录数硬上限', () => {
  const body = new TextEncoder().encode('[{"id":1},{"id":2},{"id":3}]')
  assert.throws(() => parseBoundedJsonArray(body, '测试', 2), /记录数超过安全上限 2/)
  assert.equal(parseBoundedJsonArray(body, '测试', 3).length, 3)
})

test('上游字段、嵌套数组和总记录数都有明确边界', () => {
  const valid = bundle()
  assert.doesNotThrow(() => assertBoundedUpstreamBundle(valid))

  const oversizedName = bundle()
  oversizedName.channels[0]!.name = 'x'.repeat(CATALOG_LIMITS.maxNameLength + 1)
  assert.throws(() => assertBoundedUpstreamBundle(oversizedName), /频道\[0\]\.name/)

  const tooManyAltNames = bundle()
  tooManyAltNames.channels[0]!.alt_names = Array.from({ length: CATALOG_LIMITS.maxAltNames + 1 }, () => '别名')
  assert.throws(() => assertBoundedUpstreamBundle(tooManyAltNames), /alt_names/)
})

test('最终目录、单频道线路和序列化缓存都受硬上限保护', () => {
  const catalog = transformedCatalog()
  assert.equal(isValidBoundedCatalog(catalog), true)

  const tooManySources: Catalog = structuredClone(catalog)
  const source = tooManySources.channels[0]!.sources[0]!
  tooManySources.channels[0]!.sources = Array.from(
    { length: CATALOG_LIMITS.maxSourcesPerChannel + 1 },
    (_, index) => ({ ...source, id: `${source.id}-${index}`, url: `https://media.example.com/${index}.m3u8` })
  )
  assert.equal(isValidBoundedCatalog(tooManySources), false)

  const tooManyChannels: Catalog = {
    ...catalog,
    channels: Array.from({ length: CATALOG_LIMITS.maxCatalogChannels + 1 }, () => catalog.channels[0]!)
  }
  assert.equal(isValidBoundedCatalog(tooManyChannels), false)

  assert.throws(() => serializeCatalogForCache(catalog, 128), /超过 128 字节安全上限/)
  const serialized = serializeCatalogForCache(catalog)
  assert.equal(parseCatalogCache(new TextEncoder().encode(serialized))?.channels.length, 1)
})

test('共享分类元数据造成输出放大时在频道摄取阶段失败', () => {
  const amplified = bundle()
  amplified.categories = Array.from({ length: CATALOG_LIMITS.maxCategoriesPerChannel }, (_, index) => ({
    id: `category-${index}`,
    name: '类'.repeat(CATALOG_LIMITS.maxNameLength)
  }))
  amplified.channels[0]!.categories = amplified.categories.map((category) => category.id)
  assert.throws(() => transformIptvData(amplified), /搜索元数据超过安全上限/)
})

test('缓存正文超过读取预算时在 JSON.parse 前被拒绝', () => {
  const oversized = new Uint8Array(CATALOG_LIMITS.maxCacheBytes + 1)
  assert.equal(parseCatalogCache(oversized), undefined)
})

function transformedCatalog(): Catalog {
  return transformIptvData(bundle(), '2026-08-10T00:00:00.000Z')
}

function bundle(): UpstreamBundle {
  return {
    channels: [{
      id: 'safe.cn',
      name: '安全频道',
      country: 'CN',
      categories: ['general'],
      is_nsfw: false
    }],
    streams: [{ channel: 'safe.cn', url: 'https://media.example.com/live.m3u8', quality: '1080p' }],
    countries: [{ code: 'CN', name: '中国', flag: '🇨🇳' }],
    categories: [{ id: 'general', name: '综合' }],
    logos: [{ channel: 'safe.cn', in_use: true, url: 'https://img.example.com/logo.png' }],
    blocklist: []
  }
}
