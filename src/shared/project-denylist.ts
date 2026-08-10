export interface ProjectDenylistEntry {
  channelId: string
  addedAt: string
  reason: 'rights-request' | 'safety' | 'security' | 'other'
  reference: string
}

/**
 * Repository-maintained emergency denylist.
 *
 * Add one entry per blocked iptv-org channel ID. Keep the public reference free
 * of private identity documents, contracts, stream tokens, or personal data.
 * The list is applied to newly fetched directories and previously cached ones.
 */
export const PROJECT_DENYLIST: readonly ProjectDenylistEntry[] = []

export const PROJECT_DENIED_CHANNEL_IDS: ReadonlySet<string> = new Set(
  PROJECT_DENYLIST.map((entry) => entry.channelId.trim()).filter(Boolean)
)
