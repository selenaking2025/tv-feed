import type { RemoteResourceKind } from '../shared/remote-resource-contracts.ts'
import type {
  LegacySafetyPreferences,
  SafetyStateSnapshot,
  SafetyTransitionResult
} from '../shared/safety-contracts.ts'
import type { CatalogScope } from '../shared/catalog-contracts.ts'
import type { SafetyStateStorePort } from './safety-state-store.ts'

export interface SafetyCoordinatorOptions {
  store: SafetyStateStorePort
  invalidateCatalog: () => Promise<boolean>
  cancelRemoteLogos: () => void
  now?: () => number
}

export class SafetyCoordinator {
  private readonly options: SafetyCoordinatorOptions
  private state: SafetyStateSnapshot | undefined
  private transitionSequence = 0
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly now: () => number

  constructor(options: SafetyCoordinatorOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  initialize(preferences: LegacySafetyPreferences): Promise<SafetyStateSnapshot> {
    return this.enqueue(async () => {
      if (!this.state) {
        const persisted = await this.options.store.read()
        if (persisted) {
          this.state = persisted
        } else {
          const familySafety = preferences.familySafety
          this.state = await this.options.store.write({
            schemaVersion: 1,
            revision: 1,
            familySafety,
            remoteLogos: !familySafety && preferences.remoteLogos,
            transitionId: this.nextTransitionId(),
            pendingCatalogInvalidation: familySafety,
            pendingViewingDataClear: familySafety
          })
        }
      }
      if (this.state.familySafety || !this.state.remoteLogos) this.options.cancelRemoteLogos()
      await this.reconcileCatalogInvalidation()
      return cloneState(this.requireState())
    })
  }

  setFamilySafety(enabled: boolean): Promise<SafetyTransitionResult> {
    return this.enqueue(async () => {
      const current = this.requireState()
      if (enabled === current.familySafety) {
        await this.reconcileCatalogInvalidation()
        return { state: cloneState(this.requireState()), warning: '' }
      }
      if (!enabled && current.pendingViewingDataClear) {
        throw new Error('本地观看数据尚未确认清除，不能关闭家庭安全模式')
      }

      const transitionId = this.nextTransitionId()
      const next = await this.persist({
        ...current,
        revision: current.revision + 1,
        familySafety: enabled,
        remoteLogos: false,
        transitionId,
        pendingCatalogInvalidation: true,
        pendingViewingDataClear: enabled
      })
      // The restrictive state is durable before any cleanup begins. From this
      // point, resource admission rejects logos even if cleanup later fails.
      this.options.cancelRemoteLogos()

      let warning = ''
      try {
        await this.options.invalidateCatalog()
        await this.persist({
          ...next,
          revision: next.revision + 1,
          pendingCatalogInvalidation: false
        })
      } catch (error) {
        warning = `目录缓存仍待清理；应用会在下次启动时重试。${errorMessage(error)}`
      }
      return { state: cloneState(this.requireState()), warning }
    })
  }

  setRemoteLogos(enabled: boolean): Promise<SafetyStateSnapshot> {
    return this.enqueue(async () => {
      const current = this.requireState()
      if (enabled && current.familySafety) throw new Error('家庭安全模式下不能开启远程台标')
      if (enabled === current.remoteLogos) return cloneState(current)
      const next = await this.persist({
        ...current,
        revision: current.revision + 1,
        remoteLogos: enabled
      })
      if (!enabled) this.options.cancelRemoteLogos()
      return cloneState(next)
    })
  }

  acknowledgeViewingDataClear(transitionId: string): Promise<SafetyStateSnapshot> {
    return this.enqueue(async () => {
      const current = this.requireState()
      if (transitionId !== current.transitionId) throw new Error('家庭安全清理确认已过期')
      if (!current.pendingViewingDataClear) return cloneState(current)
      return cloneState(await this.persist({
        ...current,
        revision: current.revision + 1,
        pendingViewingDataClear: false
      }))
    })
  }

  catalogScope(): CatalogScope {
    return this.requireState().familySafety ? 'family' : 'standard'
  }

  assertCatalogScope(expected: CatalogScope): void {
    if (this.catalogScope() !== expected) throw new Error('目录加载期间家庭安全范围已经改变，请重新加载')
  }

  assertRemoteResourceAllowed(kind: RemoteResourceKind): void {
    const state = this.requireState()
    if (kind === 'logo' && !state.remoteLogos) {
      throw new Error(state.familySafety
        ? '家庭安全模式已阻止远程台标'
        : '远程台标偏好未开启')
    }
  }

  snapshot(): SafetyStateSnapshot {
    return cloneState(this.requireState())
  }

  private async reconcileCatalogInvalidation(): Promise<void> {
    const current = this.requireState()
    if (!current.pendingCatalogInvalidation) return
    try {
      await this.options.invalidateCatalog()
      await this.persist({
        ...this.requireState(),
        revision: this.requireState().revision + 1,
        pendingCatalogInvalidation: false
      })
    } catch {
      // The pending bit is durable and will cause another retry. In family
      // mode, admission remains restrictive regardless of cleanup success.
    }
  }

  private requireState(): SafetyStateSnapshot {
    if (!this.state) throw new Error('家庭安全状态尚未初始化')
    return this.state
  }

  private async persist(next: SafetyStateSnapshot): Promise<SafetyStateSnapshot> {
    const persisted = await this.options.store.write(next)
    this.state = persisted
    return persisted
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private nextTransitionId(): string {
    this.transitionSequence += 1
    return `safety-${this.now().toString(36)}-${this.transitionSequence.toString(36)}`
  }
}

function cloneState(state: SafetyStateSnapshot): SafetyStateSnapshot {
  return { ...state }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
