import type { CatalogChannel, CatalogSource } from './contracts.ts'

export interface OfficialSourcePolicy {
  channelId: string
  officialWebsite: string
  approvedSourceHosts: readonly string[]
  verifiedAt: string
}

// This deliberately stores channel IDs and exact, manually reviewed hostnames,
// never full stream URLs. A normal iptv-org entry does not become an "official
// source" unless both its channel ID and its current source hostname match.
export const OFFICIAL_SOURCE_POLICIES: readonly OfficialSourcePolicy[] = Object.freeze([
  policy('BaichengTV.cn', 'https://www.jlntv.cn/', ['stream2.jlntv.cn']),
  policy('CCTVPlus1.cn', 'https://www.cctvplus.com/', ['cd-live-stream.news.cctvplus.com']),
  policy('CCTVPlus2.cn', 'https://www.cctvplus.com/', ['cd-live-stream.news.cctvplus.com']),
  policy('CGTN.cn', 'https://www.cgtn.com/tv', ['english-livebkali.cgtn.com', 'news.cgtn.com']),
  policy('CGTNArabic.cn', 'https://arabic.cgtn.com/', ['arabic-livews.cgtn.com', 'news.cgtn.com']),
  policy('CGTNDocumentary.cn', 'https://www.cgtn.com/channel/documentary', ['english-livebkali.cgtn.com', 'news.cgtn.com']),
  policy('CGTNFrench.cn', 'https://francais.cgtn.com/', ['francais-livews.cgtn.com', 'news.cgtn.com']),
  policy('CGTNRussian.cn', 'https://russian.cgtn.com/', ['russian-livews.cgtn.com', 'news.cgtn.com']),
  policy('CGTNSpanish.cn', 'https://espanol.cgtn.com/', ['espanol-livews.cgtn.com', 'news.cgtn.com']),
  policy('HarbinComprehensiveNewsChannel.cn', 'https://www.hrbtv.net/', ['stream.hrbtv.net']),
  policy('BloombergTV.us', 'https://www.bloomberg.com/live/us/btv', ['bloomberg.com']),
  policy('CBSNews247.us', 'https://www.cbsnews.com/live/', [
    'cbsn-us-vtt.cbsnstream.cbsnews.com',
    'cbsn-us.cbsnstream.cbsnews.com'
  ]),
  policy('FoxWeather.us', 'https://www.foxweather.com/live', ['247wlive.foxweather.com']),
  policy('PBS.us', 'https://www.pbs.org/', ['pbs.lls.cdn.pbs.org']),
  policy('PBSKids.us', 'https://pbskids.org/', ['livestream.pbskids.org']),
  policy('France24.fr', 'https://www.france24.com/', ['live.france24.com']),
  policy('CanalMacau.mo', 'https://www.tdm.com.mo/', ['live3.tdm.com.mo']),
  policy('EBS1TV.kr', 'https://www.ebs.co.kr/', ['ebsonair.ebs.co.kr']),
  policy('ShopChannel.jp', 'https://www.shopch.jp/', ['stream3.shopch.jp'])
])

const policyByChannelId = new Map(OFFICIAL_SOURCE_POLICIES.map((entry) => [entry.channelId, entry]))

export function officialSourcePolicy(channelId: string): OfficialSourcePolicy | undefined {
  return policyByChannelId.get(channelId)
}

export function isVerifiedOfficialSource(channel: Pick<CatalogChannel, 'id'>, source: Pick<CatalogSource, 'url'>): boolean {
  const entry = officialSourcePolicy(channel.id)
  if (!entry) return false
  try {
    const hostname = new URL(source.url).hostname.toLocaleLowerCase()
    return entry.approvedSourceHosts.includes(hostname)
  } catch {
    return false
  }
}

export function hasVerifiedOfficialSource(channel: Pick<CatalogChannel, 'id' | 'sources'>): boolean {
  return channel.sources.some((source) => isVerifiedOfficialSource(channel, source))
}

function policy(
  channelId: string,
  officialWebsite: string,
  approvedSourceHosts: readonly string[]
): OfficialSourcePolicy {
  return Object.freeze({
    channelId,
    officialWebsite,
    approvedSourceHosts: Object.freeze(approvedSourceHosts.map((host) => host.toLocaleLowerCase())),
    verifiedAt: '2026-08-10'
  })
}
