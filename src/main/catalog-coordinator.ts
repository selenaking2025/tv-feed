import { applyFamilySafetyAllowlist, applyProjectDenylist, transformIptvData } from '../shared/catalog.ts'
import type {
  Catalog,
  CatalogFailureCode,
  CatalogLoadCommand,
  CatalogLoadResult,
  CatalogScope,
  CatalogSyncProgress,
  CatalogSyncProgressUpdate
} from '../shared/catalog-contracts.ts'
import { createHlsAcceptanceCatalog, createOfflineSampleCatalog } from '../shared/sample-catalog.ts'
import type {
  CatalogCacheCandidates,
  CatalogCacheRepositoryPort
} from './catalog-cache.ts'
import { fetchIptvOrgBundle } from './catalog-upstream.ts'

const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1_000

export interface CatalogRuntimeMode {
  acceptanceUrl: string
  useAcceptanceCatalog: boolean
  useOfflineDemo: boolean
  forceNetworkFailure: boolean
}

export interface CatalogFetchResult {
  catalog: Catalog
  warnings: string[]
}

export interface CatalogCoordinatorOptions {
  cache: CatalogCacheRepositoryPort
  runtime?: Partial<CatalogRuntimeMode>
  fetchCatalog?: (report: (progress: CatalogSyncProgressUpdate) => void) => Promise<CatalogFetchResult>
  now?: () => number
  cacheTtlMs?: number
}

type ProgressReporter = (progress: CatalogSyncProgress) => void

interface RunningOperation {
  operationId: string
  reporters: Set<ProgressReporter>
  latestProgress?: CatalogSyncProgress
  promise: Promise<CatalogLoadResult>
}

interface CacheWriteOutcome {
  catalog?: Catalog
  superseded: boolean
}

export class CatalogCoordinator {
  private readonly options: CatalogCoordinatorOptions
  private readonly runtime: CatalogRuntimeMode
  private readonly fetchCatalog: NonNullable<CatalogCoordinatorOptions['fetchCatalog']>
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private readonly inFlight = new Map<string, RunningOperation>()
  private operationSequence = 0
  private cacheEpoch = 0
  private latestCommittedSequence = 0
  private cacheMutationTail: Promise<void> = Promise.resolve()

  constructor(options: CatalogCoordinatorOptions) {
    this.options = options
    this.runtime = {
      acceptanceUrl: options.runtime?.acceptanceUrl ?? '',
      useAcceptanceCatalog: options.runtime?.useAcceptanceCatalog ?? false,
      useOfflineDemo: options.runtime?.useOfflineDemo ?? false,
      forceNetworkFailure: options.runtime?.forceNetworkFailure ?? false
    }
    this.fetchCatalog = options.fetchCatalog ?? fetchAndTransformCatalog
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  load(command: CatalogLoadCommand, scope: CatalogScope, report: ProgressReporter = () => undefined): Promise<CatalogLoadResult> {
    const refreshKey = operationKey(scope, 'refresh')
    const ownKey = operationKey(scope, command.intent)
    const joinable = command.intent === 'startup'
      ? this.inFlight.get(refreshKey) ?? this.inFlight.get(ownKey)
      : this.inFlight.get(ownKey)
    if (joinable) {
      joinable.reporters.add(report)
      if (joinable.latestProgress) safelyReport(report, joinable.latestProgress)
      return joinable.promise
    }

    const sequence = ++this.operationSequence
    const operationId = `catalog-${sequence.toString(36)}-${this.now().toString(36)}`
    const reporters = new Set<ProgressReporter>([report])
    const running: RunningOperation = {
      operationId,
      reporters,
      promise: Promise.resolve(undefined as never)
    }
    const operationEpoch = this.cacheEpoch
    running.promise = this.execute(command, scope, operationId, sequence, operationEpoch, (update) => {
      const progress: CatalogSyncProgress = { operationId, ...update }
      running.latestProgress = progress
      for (const listener of running.reporters) safelyReport(listener, progress)
    }).finally(() => {
      if (this.inFlight.get(ownKey) === running) this.inFlight.delete(ownKey)
    })
    this.inFlight.set(ownKey, running)
    return running.promise
  }

  loadOfflineDemo(scope: CatalogScope): CatalogLoadResult {
    const catalog = projectCatalog(createOfflineSampleCatalog(), scope)
    return {
      operationId: `offline-${(++this.operationSequence).toString(36)}-${this.now().toString(36)}`,
      catalog,
      cacheStatus: 'offline-sample',
      warning: '离线演示模式：这是 8 个内置虚构样例，不是 iptv-org 真实频道目录。'
    }
  }

  invalidateCache(): Promise<boolean> {
    // Advance before waiting so an already-running write can observe that it
    // has lost authority. The queued clear removes a write already in progress.
    this.cacheEpoch += 1
    return this.enqueueCacheMutation(() => this.options.cache.clear())
  }

  private async execute(
    command: CatalogLoadCommand,
    scope: CatalogScope,
    operationId: string,
    sequence: number,
    operationEpoch: number,
    report: (progress: CatalogSyncProgressUpdate) => void
  ): Promise<CatalogLoadResult> {
    if (this.runtime.useAcceptanceCatalog && this.runtime.acceptanceUrl) {
      return {
        operationId,
        catalog: projectCatalog(createHlsAcceptanceCatalog(this.runtime.acceptanceUrl), scope),
        cacheStatus: 'offline-sample',
        warning: 'HLS 验收模式：频道目录使用内置虚构样例，媒体只使用本次运行传入的测试源。'
      }
    }

    report({ stage: 'checking-cache', message: '正在检查本机频道目录…' })
    const cache = await this.readCacheCandidates(scope, operationEpoch)

    if (this.runtime.useOfflineDemo) return this.offlineResult(scope, operationId)
    if (command.intent === 'startup' && cache.current && this.isFresh(cache.current.writtenAt)) {
      return {
        operationId,
        catalog: projectCatalog(cache.current.catalog, scope),
        cacheStatus: 'fresh-cache',
        warning: ''
      }
    }

    try {
      if (this.runtime.forceNetworkFailure) {
        throw new CatalogSyncError('network', '验收模式模拟目录网络失败', true)
      }
      const fetched = await this.fetchCatalog(report)
      const catalog = projectCatalog(fetched.catalog, scope)
      if (catalog.channels.length === 0) {
        throw new CatalogSyncError('invalid-data', '安全过滤后没有可用的真实频道', false)
      }
      report({ stage: 'writing-cache', message: '正在原子写入本机频道缓存…' })
      let writeOutcome: CacheWriteOutcome
      try {
        writeOutcome = await this.writeCacheIfAuthoritative(
          scope,
          catalog,
          sequence,
          operationEpoch,
          () => report({ stage: 'verifying-cache', message: '正在重新读取并验证刚写入的频道缓存…' })
        )
      } catch (error) {
        throw new CatalogSyncError('cache-write', '频道目录缓存写入或复读验证失败', false, error)
      }
      const supersededWarning = writeOutcome.superseded
        ? '本次同步在缓存失效或更新操作之后完成，因此未覆盖较新的本机缓存。'
        : ''
      return {
        operationId,
        catalog: writeOutcome.catalog ?? catalog,
        cacheStatus: 'network',
        warning: [...fetched.warnings, supersededWarning].filter(Boolean).join(' ')
      }
    } catch (error) {
      const fallback = cache.current ?? cache.legacy
      if (fallback) {
        return {
          operationId,
          catalog: projectCatalog(fallback.catalog, scope),
          cacheStatus: fallback.source === 'legacy-v1' ? 'legacy-cache' : 'stale-cache',
          warning: `iptv-org 暂时无法更新，继续使用本机${fallback.source === 'legacy-v1' ? '旧版' : ''}缓存。${catalogFailureReason(error)}`
        }
      }
      throw error
    }
  }

  private offlineResult(scope: CatalogScope, operationId: string): CatalogLoadResult {
    return {
      operationId,
      catalog: projectCatalog(createOfflineSampleCatalog(), scope),
      cacheStatus: 'offline-sample',
      warning: '离线演示模式：这是 8 个内置虚构样例，不是 iptv-org 真实频道目录。'
    }
  }

  private isFresh(writtenAt: string): boolean {
    const timestamp = Date.parse(writtenAt)
    const age = this.now() - timestamp
    return Number.isFinite(timestamp) && age >= 0 && age < this.cacheTtlMs
  }

  private async readCacheCandidates(scope: CatalogScope, operationEpoch: number): Promise<CatalogCacheCandidates> {
    await this.cacheMutationTail
    const candidates = await this.options.cache.readCandidates(scope)
    return operationEpoch === this.cacheEpoch ? candidates : {}
  }

  private writeCacheIfAuthoritative(
    scope: CatalogScope,
    catalog: Catalog,
    sequence: number,
    operationEpoch: number,
    onVerifying: () => void
  ): Promise<CacheWriteOutcome> {
    return this.enqueueCacheMutation(async () => {
      if (operationEpoch !== this.cacheEpoch || sequence < this.latestCommittedSequence) {
        return { superseded: true }
      }
      const persisted = await this.options.cache.write(scope, catalog, onVerifying)
      if (operationEpoch !== this.cacheEpoch) return { superseded: true }
      this.latestCommittedSequence = sequence
      return { catalog: persisted, superseded: false }
    })
  }

  private enqueueCacheMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.cacheMutationTail.then(operation, operation)
    this.cacheMutationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

export class CatalogSyncError extends Error {
  readonly code: CatalogFailureCode
  readonly retryable: boolean

  constructor(code: CatalogFailureCode, message: string, retryable: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CatalogSyncError'
    this.code = code
    this.retryable = retryable
  }
}

async function fetchAndTransformCatalog(
  report: (progress: CatalogSyncProgressUpdate) => void
): Promise<CatalogFetchResult> {
  const upstream = await fetchIptvOrgBundle(report)
  report({ stage: 'processing', message: '正在安全清洗和整理频道目录…' })
  try {
    return { catalog: transformIptvData(upstream.bundle), warnings: upstream.warnings }
  } catch (error) {
    throw new CatalogSyncError('invalid-data', 'iptv-org 返回的数据无法生成安全目录', false, error)
  }
}

function projectCatalog(catalog: Catalog, scope: CatalogScope): Catalog {
  const denied = applyProjectDenylist(catalog)
  return scope === 'family' ? applyFamilySafetyAllowlist(denied) : denied
}

function operationKey(scope: CatalogScope, intent: CatalogLoadCommand['intent']): string {
  return `${scope}:${intent}`
}

function safelyReport(report: ProgressReporter, progress: CatalogSyncProgress): void {
  try {
    report(progress)
  } catch {
    // Progress observers are projections; they must never own operation success.
  }
}

function catalogFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
