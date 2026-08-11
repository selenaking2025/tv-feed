import assert from 'node:assert/strict'
import test from 'node:test'
import { CATALOG_FILTER_POLICY_REVISION } from '../src/shared/catalog-policy.ts'
import { FAMILY_APPROVED_CHANNELS } from '../src/shared/family-safety.ts'
import { OFFICIAL_SOURCE_POLICIES } from '../src/shared/official-sources.ts'
import { findPolicyLifecycleViolations } from '../src/shared/policy-lifecycle.ts'
import { PROJECT_DENYLIST } from '../src/shared/project-denylist.ts'

test('家庭允许列表、官方来源和项目 denylist 均有证据与未过期的复核期限', () => {
  const records = [
    ...FAMILY_APPROVED_CHANNELS.map((entry) => ({
      id: `family:${entry.channelId}`,
      reviewedAt: entry.reviewedAt,
      reviewAfter: entry.reviewAfter,
      evidenceReference: entry.evidenceReference
    })),
    ...OFFICIAL_SOURCE_POLICIES.map((entry) => ({
      id: `official:${entry.channelId}`,
      reviewedAt: entry.verifiedAt,
      reviewAfter: entry.reviewAfter,
      evidenceReference: entry.officialWebsite
    })),
    ...PROJECT_DENYLIST.map((entry) => ({
      id: `deny:${entry.channelId}`,
      reviewedAt: entry.addedAt,
      reviewAfter: entry.reviewAfter,
      evidenceReference: entry.reference
    }))
  ]
  assert.deepEqual(findPolicyLifecycleViolations(records, new Date()), [])
  assert.match(CATALOG_FILTER_POLICY_REVISION, /^filter-v1-[a-f0-9]{8}$/)
})

test('策略生命周期校验拒绝过期、无证据、重复和超长复核周期', () => {
  const findings = findPolicyLifecycleViolations([
    { id: 'duplicate', reviewedAt: '2025-01-01', reviewAfter: '2027-01-02', evidenceReference: '' },
    { id: 'duplicate', reviewedAt: '2026-01-01', reviewAfter: '2026-02-01', evidenceReference: 'source' },
    { id: 'invalid-date', reviewedAt: '2026-02-31', reviewAfter: '2026-04-01', evidenceReference: 'source' }
  ], new Date('2026-08-11T00:00:00.000Z'))
  assert.match(findings.join('\n'), /缺少证据引用/)
  assert.match(findings.join('\n'), /复核周期不能超过/)
  assert.match(findings.join('\n'), /策略 ID 重复/)
  assert.match(findings.join('\n'), /已超过复核日期/)
  assert.match(findings.join('\n'), /reviewedAt 不是有效日期/)
})
