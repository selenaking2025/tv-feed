import assert from 'node:assert/strict'
import test from 'node:test'
import { applyProjectDenylist, isExplicitlySafeChannel, normalizeBrowserHlsUrl, transformIptvData } from '../src/shared/catalog.ts'
import { displayCountryName, getCountrySearchAliases, sortCountriesForDisplay } from '../src/shared/countries.ts'
import { createHlsAcceptanceCatalog, createOfflineSampleCatalog } from '../src/shared/sample-catalog.ts'
import type { UpstreamBundle, UpstreamChannel } from '../src/shared/contracts.ts'

function channel(id: string, overrides: Partial<UpstreamChannel> = {}): UpstreamChannel {
  return {
    id,
    name: id,
    country: 'CN',
    categories: ['general'],
    is_nsfw: false,
    ...overrides
  }
}

function channelWithoutNsfwLabel(id: string): UpstreamChannel {
  const value = channel(id)
  delete value.is_nsfw
  return value
}

test('只保留符合上游元数据规则、未屏蔽且浏览器兼容的 HTTPS HLS 线路', () => {
  const bundle: UpstreamBundle = {
    channels: [
      channel('safe.cn', { name: '安全频道' }),
      channel('adult.cn', { is_nsfw: true }),
      channelWithoutNsfwLabel('unlabeled.cn'),
      channel('closed.cn', { closed: '2025-01-01' }),
      channel('xxx.cn', { categories: ['xxx'] }),
      channel('blocked.cn'),
      channel('local-blocked.cn')
    ],
    streams: [
      { channel: 'safe.cn', url: 'https://media.example.com/live/master.m3u8#fragment', quality: '1080p' },
      { channel: 'safe.cn', url: 'https://media.example.com/live/master.m3u8', quality: '720p' },
      { channel: 'safe.cn', url: 'https://media.example.com/live/backup.m3u8', quality: '720p' },
      { channel: 'safe.cn', url: 'http://media.example.com/insecure.m3u8' },
      { channel: 'safe.cn', url: 'https://media.example.com/header.m3u8', referrer: 'https://example.com' },
      { channel: 'safe.cn', url: 'https://127.0.0.1/private.m3u8' },
      { channel: 'safe.cn', url: 'https://media.example.com/video.mp4' },
      { channel: 'adult.cn', url: 'https://media.example.com/adult.m3u8' },
      { channel: 'unlabeled.cn', url: 'https://media.example.com/unlabeled.m3u8' },
      { channel: 'closed.cn', url: 'https://media.example.com/closed.m3u8' },
      { channel: 'xxx.cn', url: 'https://media.example.com/xxx.m3u8' },
      { channel: 'blocked.cn', url: 'https://media.example.com/blocked.m3u8' },
      { channel: 'local-blocked.cn', url: 'https://media.example.com/local-blocked.m3u8' },
      { channel: 'missing.cn', url: 'https://media.example.com/missing.m3u8' }
    ],
    countries: [{ code: 'CN', name: '中国', flag: '🇨🇳' }],
    categories: [
      { id: 'general', name: '综合' },
      { id: 'xxx', name: '成人' }
    ],
    logos: [
      { channel: 'safe.cn', in_use: true, tags: ['horizontal', 'white'], url: 'https://img.example.com/safe.png' },
      { channel: 'adult.cn', in_use: true, url: 'https://img.example.com/adult.png' }
    ],
    blocklist: [{ channel: 'blocked.cn', reason: 'dmca' }]
  }

  const catalog = transformIptvData(bundle, '2026-08-10T00:00:00.000Z', new Set(['local-blocked.cn']))

  assert.equal(catalog.channels.length, 1)
  assert.equal(catalog.channels[0]?.id, 'safe.cn')
  assert.equal(catalog.channels[0]?.sources.length, 2)
  assert.equal(catalog.channels[0]?.sources[0]?.quality, '1080p')
  assert.equal(catalog.channels[0]?.logoUrl, 'https://img.example.com/safe.png')
  assert.equal(catalog.stats.excludedUnsafeChannel, 4)
  assert.equal(catalog.stats.excludedBlockedChannel, 2)
  assert.equal(catalog.stats.excludedUnknownChannel, 1)
  assert.equal(catalog.stats.excludedBrowserIncompatible, 4)
})

test('频道必须被上游显式标记为非成人，并排除缺失标记、停播与成人分类', () => {
  assert.equal(isExplicitlySafeChannel(channel('safe')), true)
  assert.equal(isExplicitlySafeChannel(channel('adult', { is_nsfw: true })), false)
  assert.equal(isExplicitlySafeChannel(channelWithoutNsfwLabel('unlabeled')), false)
  assert.equal(isExplicitlySafeChannel(channel('closed', { closed: '2026-01-01' })), false)
  assert.equal(isExplicitlySafeChannel(channel('category', { categories: ['news', 'xxx'] })), false)
})

test('线路规范化拒绝私网、凭据、特殊请求头和非 HLS 地址', () => {
  assert.equal(normalizeBrowserHlsUrl({ channel: 'x', url: 'https://cdn.example.com/live.m3u8#x' }), 'https://cdn.example.com/live.m3u8')
  assert.equal(normalizeBrowserHlsUrl({ channel: 'x', url: 'https://user:pass@cdn.example.com/live.m3u8' }), '')
  assert.equal(normalizeBrowserHlsUrl({ channel: 'x', url: 'https://192.168.1.2/live.m3u8' }), '')
  assert.equal(normalizeBrowserHlsUrl({ channel: 'x', url: 'https://[::ffff:127.0.0.1]/live.m3u8' }), '')
  assert.equal(normalizeBrowserHlsUrl({ channel: 'x', url: 'https://[fe90::1]/live.m3u8' }), '')
  assert.equal(normalizeBrowserHlsUrl({ channel: 'x', url: 'https://cdn.example.com/live.m3u8', user_agent: 'custom' }), '')
  assert.equal(normalizeBrowserHlsUrl({ channel: 'x', url: 'https://cdn.example.com/video.mp4' }), '')
})

test('私网字面地址不能作为远程台标进入目录', () => {
  const bundle: UpstreamBundle = {
    channels: [channel('safe.cn')],
    streams: [{ channel: 'safe.cn', url: 'https://media.example.com/live.m3u8' }],
    countries: [{ code: 'CN', name: '中国', flag: '🇨🇳' }],
    categories: [{ id: 'general', name: '综合' }],
    logos: [{ channel: 'safe.cn', in_use: true, url: 'https://127.0.0.1/logo.png' }],
    blocklist: []
  }

  assert.equal(transformIptvData(bundle).channels[0]?.logoUrl, '')
})

test('每个频道在摄取阶段只保留有界 Top-K 线路', () => {
  const streams = Array.from({ length: 4_000 }, (_, index) => ({
    channel: 'safe.cn',
    url: `https://media.example.com/live/${index}.m3u8`,
    quality: index === 3_999 ? '1080p' : '360p'
  }))
  const bundle: UpstreamBundle = {
    channels: [channel('safe.cn')],
    streams,
    countries: [{ code: 'CN', name: '中国', flag: '🇨🇳' }],
    categories: [{ id: 'general', name: '综合' }],
    logos: [],
    blocklist: []
  }

  const catalog = transformIptvData(bundle)
  assert.equal(catalog.channels[0]?.sources.length, 12)
  assert.equal(catalog.stats.candidateStreams, 12)
  assert.ok(catalog.channels[0]?.sources.some((source) => source.quality === '1080p'))
})

test('离线样例仍遵循保守过滤后的目录结构且每个频道都有线路', () => {
  const catalog = createOfflineSampleCatalog('2026-08-10T00:00:00.000Z')
  assert.equal(catalog.source, 'offline-sample')
  assert.ok(catalog.channels.length >= 8)
  assert.ok(catalog.channels.every((item) => item.sources.length > 0))
  assert.ok(catalog.channels.every((item) => item.sources.every((source) => source.url.startsWith('https://'))))
})

test('HLS smoke 验收目录只接受公网 HTTPS 清单且不读取真实频道目录', () => {
  const catalog = createHlsAcceptanceCatalog('https://media.example.com/acceptance.m3u8', '2026-08-10T00:00:00.000Z')
  assert.equal(catalog.source, 'offline-sample')
  assert.ok(catalog.channels.length >= 8)
  assert.ok(catalog.channels.every((item) => item.sources.every((source) => source.url === 'https://media.example.com/acceptance.m3u8')))
  assert.throws(() => createHlsAcceptanceCatalog('https://127.0.0.1/private.m3u8'), /公网 HTTPS/)
  assert.throws(() => createHlsAcceptanceCatalog('http://media.example.com/live.m3u8'), /公网 HTTPS/)
})

test('项目 denylist 会从旧目录缓存中移除频道并重建统计与筛选项', () => {
  const catalog = createOfflineSampleCatalog('2026-08-10T00:00:00.000Z')
  const denied = catalog.channels[0]
  assert.ok(denied)

  const filtered = applyProjectDenylist(catalog, new Set([denied.id]))
  assert.equal(filtered.channels.some((channel) => channel.id === denied.id), false)
  assert.equal(filtered.channels.length, catalog.channels.length - 1)
  assert.equal(filtered.stats.channels, catalog.stats.channels - 1)
  assert.equal(
    filtered.stats.candidateStreams,
    catalog.stats.candidateStreams - denied.sources.length
  )
  assert.equal(
    filtered.stats.excludedBlockedChannel,
    catalog.stats.excludedBlockedChannel + denied.sources.length
  )
  assert.equal(
    filtered.countries.reduce((total, country) => total + country.count, 0),
    filtered.channels.length
  )
})

test('地区菜单将中国置顶，其余国家按英文名称排序，并支持中文搜索别名', () => {
  const sorted = sortCountriesForDisplay([
    { code: 'US', name: 'United States', flag: '🇺🇸', count: 1600 },
    { code: 'TW', name: 'Taiwan', flag: '🇹🇼', count: 11 },
    { code: 'CN', name: 'China', flag: '🇨🇳', count: 54 },
    { code: 'ZW', name: 'Zimbabwe', flag: '🇿🇼', count: 3000 },
    { code: 'HK', name: 'Hong Kong', flag: '🇭🇰', count: 9 },
    { code: 'DE', name: 'Germany', flag: '🇩🇪', count: 1 },
    { code: 'MO', name: 'Macao', flag: '🇲🇴', count: 7 },
    { code: 'AF', name: 'Afghanistan', flag: '🇦🇫', count: 2 }
  ])

  assert.deepEqual(sorted.map((country) => country.code), ['CN', 'AF', 'DE', 'HK', 'MO', 'TW', 'US', 'ZW'])
  assert.equal(displayCountryName('CN', 'China'), '中国 / China')
  assert.match(getCountrySearchAliases('CN'), /中国/)
})
