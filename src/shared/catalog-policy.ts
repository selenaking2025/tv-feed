import { FAMILY_APPROVED_CHANNELS } from './family-safety.ts'
import { PROJECT_DENYLIST } from './project-denylist.ts'

/**
 * Increment this value when filtering behavior changes without changing the
 * repository policy records. Data-only policy edits are picked up by the hash.
 */
export const CATALOG_FILTER_RULESET_VERSION = 1

export const CATALOG_FILTER_POLICY_REVISION = createPolicyRevision()

function createPolicyRevision(): string {
  const policy = JSON.stringify({
    ruleset: CATALOG_FILTER_RULESET_VERSION,
    family: [...FAMILY_APPROVED_CHANNELS]
      .map(({ channelId, scope, reviewedAt, reviewAfter, evidenceReference }) => ({
        channelId,
        scope,
        reviewedAt,
        reviewAfter,
        evidenceReference
      }))
      .sort((left, right) => left.channelId.localeCompare(right.channelId)),
    denied: [...PROJECT_DENYLIST]
      .map(({ channelId, addedAt, reviewAfter, reason, reference }) => ({
        channelId,
        addedAt,
        reviewAfter,
        reason,
        reference
      }))
      .sort((left, right) => left.channelId.localeCompare(right.channelId))
  })
  return `filter-v${CATALOG_FILTER_RULESET_VERSION}-${fnv1a(policy)}`
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
