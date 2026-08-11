import type { TvFeedBridge } from '../../shared/ipc-contract.ts'
import type { SafetyStateSnapshot, SafetyTransitionResult } from '../../shared/safety-contracts.ts'
import { readStoredBoolean, writeStoredBoolean } from './local-state.ts'

const LEGACY_REMOTE_LOGOS_KEY = 'tvfeed:remote-logos:v1'
const LEGACY_FAMILY_SAFETY_KEY = 'tvfeed:family-safety:v1'

type SafetyBridge = Pick<
  TvFeedBridge,
  'initializeSafetyState' | 'setFamilySafety' | 'setRemoteLogos' | 'acknowledgeSafetyCleanup'
>

export class SafetyClient {
  private readonly bridge: SafetyBridge
  private state: SafetyStateSnapshot | undefined

  constructor(bridge: SafetyBridge) {
    this.bridge = bridge
  }

  async initialize(): Promise<SafetyStateSnapshot> {
    const state = await this.bridge.initializeSafetyState({
      familySafety: readStoredBoolean(LEGACY_FAMILY_SAFETY_KEY),
      remoteLogos: readStoredBoolean(LEGACY_REMOTE_LOGOS_KEY)
    })
    return this.accept(state)
  }

  async setFamilySafety(enabled: boolean): Promise<SafetyTransitionResult> {
    const result = await this.bridge.setFamilySafety(enabled)
    this.accept(result.state)
    return result
  }

  async setRemoteLogos(enabled: boolean): Promise<SafetyStateSnapshot> {
    return this.accept(await this.bridge.setRemoteLogos(enabled))
  }

  async acknowledgeCleanup(transitionId: string): Promise<SafetyStateSnapshot> {
    return this.accept(await this.bridge.acknowledgeSafetyCleanup(transitionId))
  }

  snapshot(): SafetyStateSnapshot {
    if (!this.state) throw new Error('家庭安全状态尚未初始化')
    return { ...this.state }
  }

  private accept(state: SafetyStateSnapshot): SafetyStateSnapshot {
    this.state = { ...state }
    // Compatibility projection for rollback to versions that still read these
    // renderer keys. It is not an authority in the current architecture.
    writeStoredBoolean(LEGACY_FAMILY_SAFETY_KEY, state.familySafety)
    writeStoredBoolean(LEGACY_REMOTE_LOGOS_KEY, state.remoteLogos)
    return { ...state }
  }
}
