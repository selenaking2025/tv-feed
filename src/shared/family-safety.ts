import { OFFICIAL_SOURCE_POLICIES } from './official-sources.ts'

export interface FamilyApprovedChannel {
  channelId: string
  scope: 'iptv-org' | 'offline-sample'
  reviewedAt: string
}

// This allowlist is intentionally explicit. Adding an official-source policy
// does not silently approve that channel for family mode; both lists must be
// reviewed and updated independently.
export const FAMILY_APPROVED_CHANNELS: readonly FamilyApprovedChannel[] = Object.freeze([
  approved('BaichengTV.cn'),
  approved('CCTVPlus1.cn'),
  approved('CCTVPlus2.cn'),
  approved('CGTN.cn'),
  approved('CGTNArabic.cn'),
  approved('CGTNDocumentary.cn'),
  approved('CGTNFrench.cn'),
  approved('CGTNRussian.cn'),
  approved('CGTNSpanish.cn'),
  approved('HarbinComprehensiveNewsChannel.cn'),
  approved('BloombergTV.us'),
  approved('CBSNews247.us'),
  approved('FoxWeather.us'),
  approved('PBS.us'),
  approved('PBSKids.us'),
  approved('France24.fr'),
  approved('CanalMacau.mo'),
  approved('EBS1TV.kr'),
  approved('ShopChannel.jp'),
  approvedSample('TVFeedGeneral.demo'),
  approvedSample('TVFeedDocumentary.demo'),
  approvedSample('TVFeedNewsJapan.demo'),
  approvedSample('TVFeedNewsGermany.demo'),
  approvedSample('TVFeedNatureUS.demo'),
  approvedSample('TVFeedNewsFrance.demo'),
  approvedSample('TVFeedCultureKorea.demo'),
  approvedSample('TVFeedScienceUS.demo')
])

export const FAMILY_APPROVED_CHANNEL_IDS: ReadonlySet<string> = new Set(
  FAMILY_APPROVED_CHANNELS.map((entry) => entry.channelId)
)

export function familyApprovalHasIndependentOfficialReview(channelId: string): boolean {
  return OFFICIAL_SOURCE_POLICIES.some((entry) => entry.channelId === channelId)
}

function approved(channelId: string): FamilyApprovedChannel {
  return Object.freeze({ channelId, scope: 'iptv-org', reviewedAt: '2026-08-10' })
}

function approvedSample(channelId: string): FamilyApprovedChannel {
  return Object.freeze({ channelId, scope: 'offline-sample', reviewedAt: '2026-08-10' })
}
