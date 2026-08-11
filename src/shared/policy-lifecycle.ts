export interface ReviewablePolicyRecord {
  id: string
  reviewedAt: string
  reviewAfter: string
  evidenceReference: string
}

const MAX_REVIEW_INTERVAL_MS = 366 * 24 * 60 * 60 * 1_000

export function findPolicyLifecycleViolations(
  records: readonly ReviewablePolicyRecord[],
  asOf = new Date()
): string[] {
  const violations: string[] = []
  const seen = new Set<string>()
  const asOfTime = asOf.getTime()
  if (!Number.isFinite(asOfTime)) return ['策略检查日期无效']

  for (const record of records) {
    if (!record.id.trim()) violations.push('策略记录缺少 ID')
    else if (seen.has(record.id)) violations.push(`${record.id}: 策略 ID 重复`)
    else seen.add(record.id)
    if (!record.evidenceReference.trim()) violations.push(`${record.id}: 缺少证据引用`)

    const reviewedAt = parseDateOnly(record.reviewedAt)
    const reviewAfter = parseDateOnly(record.reviewAfter)
    if (reviewedAt === undefined) violations.push(`${record.id}: reviewedAt 不是有效日期`)
    if (reviewAfter === undefined) violations.push(`${record.id}: reviewAfter 不是有效日期`)
    if (reviewedAt === undefined || reviewAfter === undefined) continue
    if (reviewAfter <= reviewedAt) violations.push(`${record.id}: reviewAfter 必须晚于 reviewedAt`)
    if (reviewAfter - reviewedAt > MAX_REVIEW_INTERVAL_MS) violations.push(`${record.id}: 复核周期不能超过 366 天`)
    if (asOfTime > reviewAfter) violations.push(`${record.id}: 策略已超过复核日期 ${record.reviewAfter}`)
  }
  return violations
}

function parseDateOnly(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const parsed = Date.parse(`${value}T23:59:59.999Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
    ? parsed
    : undefined
}
