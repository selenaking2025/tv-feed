export interface PlaybackNetworkTarget {
  channelId: string
  sourceId: string
  sourceIndex: number
}

export interface PlaybackNetworkRecoverySnapshot extends PlaybackNetworkTarget {
  generation: number
}

export class PlaybackNetworkRecoveryGate {
  private pending: PlaybackNetworkRecoverySnapshot | undefined
  private generation = 0
  private lastRetryAt = Number.NEGATIVE_INFINITY
  private readonly retryCooldownMs: number

  constructor(retryCooldownMs: number) {
    if (!Number.isFinite(retryCooldownMs) || retryCooldownMs < 0) {
      throw new Error('网络恢复重试冷却时间无效')
    }
    this.retryCooldownMs = retryCooldownMs
  }

  suspend(target: PlaybackNetworkTarget): PlaybackNetworkRecoverySnapshot {
    this.generation += 1
    this.pending = { ...target, generation: this.generation }
    return { ...this.pending }
  }

  snapshot(): PlaybackNetworkRecoverySnapshot | undefined {
    return this.pending ? { ...this.pending } : undefined
  }

  shouldSchedule(now: number): boolean {
    return Boolean(this.pending) && now - this.lastRetryAt >= this.retryCooldownMs
  }

  claim(
    expected: PlaybackNetworkRecoverySnapshot,
    confirmedOnline: boolean,
    current: PlaybackNetworkTarget | undefined,
    now: number
  ): PlaybackNetworkTarget | undefined {
    if (!this.pending || this.pending.generation !== expected.generation) return undefined
    if (!sameTarget(this.pending, current)) {
      this.cancelPending()
      return undefined
    }
    if (!confirmedOnline) return undefined
    const target = toTarget(this.pending)
    this.pending = undefined
    this.lastRetryAt = now
    return target
  }

  cancelPending(): void {
    this.generation += 1
    this.pending = undefined
  }

  reset(): void {
    this.cancelPending()
    this.lastRetryAt = Number.NEGATIVE_INFINITY
  }
}

function sameTarget(left: PlaybackNetworkTarget, right: PlaybackNetworkTarget | undefined): boolean {
  return Boolean(right) &&
    left.channelId === right?.channelId &&
    left.sourceId === right.sourceId &&
    left.sourceIndex === right.sourceIndex
}

function toTarget(value: PlaybackNetworkTarget): PlaybackNetworkTarget {
  return {
    channelId: value.channelId,
    sourceId: value.sourceId,
    sourceIndex: value.sourceIndex
  }
}
