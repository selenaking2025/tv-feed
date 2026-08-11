export interface SourceHealthRecord {
  sourceId: string
  successCount: number
  failureCount: number
  consecutiveFailures: number
  averageStartupMs: number | null
  averageStallRatio: number
  lastSuccessAt: number
  lastFailureAt: number
  updatedAt: number
}

export interface RankedSource<T extends { id: string }> {
  source: T
  index: number
  score: number
}

export type SourceHealthRecords = ReadonlyMap<string, SourceHealthRecord>

const STORE_VERSION = 1
const MAX_RECORDS = 200
const MAX_RECORD_AGE_MS = 180 * 24 * 60 * 60 * 1_000

export function parseSourceHealthStore(serialized: string | null, now = Date.now()): Map<string, SourceHealthRecord> {
  if (!serialized) return new Map()
  try {
    const parsed: unknown = JSON.parse(serialized)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    const store = parsed as Record<string, unknown>
    if (store.version !== STORE_VERSION || !Array.isArray(store.records)) return new Map()
    const records = store.records
      .map((value) => parseRecord(value, now))
      .filter((value): value is SourceHealthRecord => Boolean(value))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_RECORDS)
    return new Map(records.map((record) => [record.sourceId, record]))
  } catch {
    return new Map()
  }
}

export function serializeSourceHealthStore(records: SourceHealthRecords): string {
  return JSON.stringify({
    version: STORE_VERSION,
    records: [...records.values()]
      .filter((record) => validSourceId(record.sourceId))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_RECORDS)
  })
}

export function recordSourceSuccess(
  records: SourceHealthRecords,
  sourceId: string,
  input: { startupMs: number; stallRatio: number },
  now = Date.now()
): Map<string, SourceHealthRecord> {
  if (!validSourceId(sourceId)) return new Map(records)
  const previous = records.get(sourceId)
  const startupMs = clampFinite(input.startupMs, 0, 120_000)
  const stallRatio = clampFinite(input.stallRatio, 0, 1)
  const record: SourceHealthRecord = {
    sourceId,
    successCount: Math.min(999, (previous?.successCount ?? 0) + 1),
    failureCount: previous?.failureCount ?? 0,
    consecutiveFailures: 0,
    averageStartupMs: previous?.averageStartupMs === null || previous?.averageStartupMs === undefined
      ? startupMs
      : Math.round(previous.averageStartupMs * 0.7 + startupMs * 0.3),
    averageStallRatio: previous
      ? previous.averageStallRatio * 0.7 + stallRatio * 0.3
      : stallRatio,
    lastSuccessAt: now,
    lastFailureAt: previous?.lastFailureAt ?? 0,
    updatedAt: now
  }
  return withBoundedRecord(records, record)
}

export function recordSourceFailure(
  records: SourceHealthRecords,
  sourceId: string,
  now = Date.now()
): Map<string, SourceHealthRecord> {
  if (!validSourceId(sourceId)) return new Map(records)
  const previous = records.get(sourceId)
  const record: SourceHealthRecord = {
    sourceId,
    successCount: previous?.successCount ?? 0,
    failureCount: Math.min(999, (previous?.failureCount ?? 0) + 1),
    consecutiveFailures: Math.min(20, (previous?.consecutiveFailures ?? 0) + 1),
    averageStartupMs: previous?.averageStartupMs ?? null,
    averageStallRatio: previous?.averageStallRatio ?? 0,
    lastSuccessAt: previous?.lastSuccessAt ?? 0,
    lastFailureAt: now,
    updatedAt: now
  }
  return withBoundedRecord(records, record)
}

export function rankSources<T extends { id: string }>(
  sources: readonly T[],
  records: SourceHealthRecords,
  excludedSourceIds: ReadonlySet<string> = new Set(),
  now = Date.now()
): Array<RankedSource<T>> {
  return sources
    .map((source, index) => ({
      source,
      index,
      score: sourceHealthScore(records.get(source.id), now)
    }))
    .filter((entry) => !excludedSourceIds.has(entry.source.id))
    .sort((left, right) => right.score - left.score || left.index - right.index)
}

export function sourceHealthScore(record: SourceHealthRecord | undefined, now = Date.now()): number {
  if (!record) return 0
  const successBonus = Math.min(48, record.successCount * 12)
  const failurePenalty = Math.min(60, record.failureCount * 15)
  const startupPenalty = record.averageStartupMs === null
    ? 0
    : Math.min(18, Math.max(0, record.averageStartupMs - 2_500) / 500)
  const stallPenalty = Math.min(30, record.averageStallRatio * 300)
  const failureAge = Math.max(0, now - record.lastFailureAt)
  const cooldownPenalty = record.consecutiveFailures === 0 || record.lastFailureAt <= record.lastSuccessAt
    ? 0
    : failureAge < 2 * 60_000
      ? 120
      : failureAge < 10 * 60_000
        ? 50
        : failureAge < 60 * 60_000
          ? 15
          : 0
  return successBonus - failurePenalty - startupPenalty - stallPenalty - cooldownPenalty
}

function parseRecord(value: unknown, now: number): SourceHealthRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!validSourceId(record.sourceId)) return undefined
  const updatedAt = safeTimestamp(record.updatedAt, now)
  if (updatedAt === 0 || now - updatedAt > MAX_RECORD_AGE_MS) return undefined
  return {
    sourceId: record.sourceId,
    successCount: safeInteger(record.successCount, 0, 999),
    failureCount: safeInteger(record.failureCount, 0, 999),
    consecutiveFailures: safeInteger(record.consecutiveFailures, 0, 20),
    averageStartupMs: record.averageStartupMs === null
      ? null
      : clampFinite(record.averageStartupMs, 0, 120_000),
    averageStallRatio: clampFinite(record.averageStallRatio, 0, 1),
    lastSuccessAt: safeTimestamp(record.lastSuccessAt, now),
    lastFailureAt: safeTimestamp(record.lastFailureAt, now),
    updatedAt
  }
}

function withBoundedRecord(
  records: SourceHealthRecords,
  record: SourceHealthRecord
): Map<string, SourceHealthRecord> {
  const next = new Map(records)
  next.set(record.sourceId, record)
  if (next.size <= MAX_RECORDS) return next
  const oldest = [...next.values()].sort((left, right) => left.updatedAt - right.updatedAt)
  for (const candidate of oldest.slice(0, next.size - MAX_RECORDS)) next.delete(candidate.sourceId)
  return next
}

function validSourceId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256 && !value.includes('://') && !/[\r\n]/.test(value)
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, Number(value))) : minimum
}

function safeTimestamp(value: unknown, now: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= now + 24 * 60 * 60 * 1_000
    ? Number(value)
    : 0
}

function clampFinite(value: unknown, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : minimum
}
