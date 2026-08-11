export type StallRecoveryAction = 'wait' | 'restart-load' | 'failover'

export interface StallRecoveryInput {
  stalledForMs: number
  bufferAheadSeconds: number
  recoveryAttempted: boolean
  paused: boolean
  hasSource: boolean
}

export function decideStallRecovery(input: StallRecoveryInput): StallRecoveryAction {
  if (!input.hasSource || input.paused || input.stalledForMs < 8_000 || input.bufferAheadSeconds > 0.5) {
    return 'wait'
  }
  return input.recoveryAttempted ? 'failover' : 'restart-load'
}
