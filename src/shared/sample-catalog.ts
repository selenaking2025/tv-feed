import type { Catalog, CatalogChannel } from './contracts.ts'
import { normalizeRemoteHlsUrl } from './remote-url-policy.ts'

const sampleChannels: CatalogChannel[] = [
  sampleChannel('TVFeedGeneral.demo', 'TV Feed 综合样例', 'CN', 'China', '🇨🇳', ['general'], ['综合'], 2),
  sampleChannel('TVFeedDocumentary.demo', 'TV Feed 纪录样例', 'CN', 'China', '🇨🇳', ['documentary'], ['纪录片'], 1),
  sampleChannel('TVFeedNewsJapan.demo', 'Demo News Japan', 'JP', 'Japan', '🇯🇵', ['news'], ['新闻'], 1),
  sampleChannel('TVFeedNewsGermany.demo', 'Demo News Germany', 'DE', 'Germany', '🇩🇪', ['news'], ['新闻'], 2),
  sampleChannel('TVFeedNatureUS.demo', 'Demo Nature US', 'US', 'United States', '🇺🇸', ['documentary'], ['纪录片'], 1),
  sampleChannel('TVFeedNewsFrance.demo', 'Demo News France', 'FR', 'France', '🇫🇷', ['news'], ['新闻'], 1),
  sampleChannel('TVFeedCultureKorea.demo', 'Demo Culture Korea', 'KR', 'South Korea', '🇰🇷', ['culture'], ['文化'], 1),
  sampleChannel('TVFeedScienceUS.demo', 'Demo Science US', 'US', 'United States', '🇺🇸', ['science'], ['科学'], 1)
]

export function createOfflineSampleCatalog(now = new Date().toISOString()): Catalog {
  return {
    version: 1,
    generatedAt: now,
    source: 'offline-sample',
    channels: sampleChannels,
    countries: [
      { code: 'CN', name: 'China', flag: '🇨🇳', count: 2 },
      { code: 'US', name: 'United States', flag: '🇺🇸', count: 2 },
      { code: 'JP', name: 'Japan', flag: '🇯🇵', count: 1 },
      { code: 'DE', name: 'Germany', flag: '🇩🇪', count: 1 },
      { code: 'FR', name: 'France', flag: '🇫🇷', count: 1 },
      { code: 'KR', name: 'South Korea', flag: '🇰🇷', count: 1 }
    ],
    categories: [
      { id: 'news', name: '新闻', count: 3 },
      { id: 'documentary', name: '纪录片', count: 2 },
      { id: 'general', name: '综合', count: 1 },
      { id: 'culture', name: '文化', count: 1 },
      { id: 'science', name: '科学', count: 1 }
    ],
    stats: {
      rawChannels: sampleChannels.length,
      rawStreams: sampleChannels.reduce((total, channel) => total + channel.sources.length, 0),
      candidateStreams: sampleChannels.reduce((total, channel) => total + channel.sources.length, 0),
      channels: sampleChannels.length,
      excludedUnknownChannel: 0,
      excludedUnsafeChannel: 0,
      excludedBlockedChannel: 0,
      excludedBrowserIncompatible: 0
    }
  }
}

export function createHlsAcceptanceCatalog(inputUrl: string, now = new Date().toISOString()): Catalog {
  const url = normalizeRemoteHlsUrl(inputUrl)
  if (!url) throw new Error('HLS 验收地址必须是受支持的公网 HTTPS 清单')
  const catalog = createOfflineSampleCatalog(now)
  const channels = catalog.channels.map((channel) => ({
    ...channel,
    sources: channel.sources.map((source) => ({
      ...source,
      url,
      title: '运行时 HLS 验收线路'
    }))
  }))
  return {
    ...catalog,
    channels
  }
}

function sampleChannel(
  id: string,
  name: string,
  countryCode: string,
  countryName: string,
  flag: string,
  categoryIds: string[],
  categoryNames: string[],
  sourceCount: number
): CatalogChannel {
  const sources = Array.from({ length: sourceCount }, (_, index) => ({
    id: `${id}:sample-${index + 1}`,
    url: `https://stream.invalid/${encodeURIComponent(id)}/line-${index + 1}.m3u8`,
    title: `${name} 示例线路 ${index + 1}`,
    quality: index === 0 ? '1080p' : '720p',
    label: '',
    feed: ''
  }))

  return {
    id,
    name,
    altNames: [],
    network: '',
    countryCode,
    countryName,
    flag,
    categoryIds,
    categoryNames,
    logoUrl: '',
    website: '',
    searchText: [id, name, countryCode, countryName, ...categoryIds, ...categoryNames].join(' ').toLocaleLowerCase(),
    sources
  }
}
