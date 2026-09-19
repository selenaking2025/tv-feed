import type { CatalogChannel, CatalogSource } from '../../shared/catalog-contracts.ts'
import { classifyPlaybackDiagnostic, playbackDiagnosticInputForRemoteFailure, type PlaybackDiagnostic } from '../../shared/playback-diagnostics.ts'
import type { PlaybackMetricsSnapshot } from '../../shared/playback-metrics.ts'
import { rankSources } from '../../shared/source-health.ts'
import type { PlaybackState, StreamPlayer } from './player.ts'
import { PlaybackNetworkRecoveryGate, type PlaybackNetworkTarget } from './playback-network-recovery.ts'
import type { ViewingState } from './viewing-state.ts'

interface PlaybackView {
  selected(channel: CatalogChannel, autoplay: boolean): void
  starting(source: CatalogSource, preserveDiagnostic: boolean): void
  state(state: PlaybackState, message: string): void
  diagnostic(diagnostic: PlaybackDiagnostic): void
  metrics(snapshot: PlaybackMetricsSnapshot): void
  recentChanged(): void
  toast(message: string, duration?: number): void
}

interface PlaybackClock {
  now(): number
  setTimeout(callback: () => void, milliseconds: number): number
  clearTimeout(timer: number): void
}

export interface PlaybackControllerOptions {
  player: Pick<StreamPlayer, 'hasSource' | 'load' | 'stop' | 'toggle'>
  viewing: ViewingState
  channel(id: string): CatalogChannel | undefined
  isNetworkOnline(): Promise<boolean>
  canRecordHealth(): boolean
  view: PlaybackView
  clock?: PlaybackClock
}

/** Owns selection and recovery policy; media resources remain owned by StreamPlayer. */
export class PlaybackController {
  private readonly options: PlaybackControllerOptions
  private readonly clock: PlaybackClock
  private readonly recovery = new PlaybackNetworkRecoveryGate(30_000)
  private selection: string
  private sourceIndex = 0
  private readonly failedSources = new Set<string>()
  private healthRecorded = false
  private attempt = 0
  private recoveryTimer: number | undefined
  private checkingGeneration: number | undefined

  constructor(options: PlaybackControllerOptions) {
    this.options = options
    this.selection = options.viewing.lastChannel
    this.clock = options.clock ?? {
      now: Date.now,
      setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
      clearTimeout: timer => window.clearTimeout(timer)
    }
  }

  get selectedChannelId(): string { return this.selection }
  get activeSourceIndex(): number { return this.sourceIndex }
  private get channel(): CatalogChannel | undefined { return this.options.channel(this.selection) }

  restoreSelection(channelId: string): void {
    this.stop()
    this.selection = channelId
    this.sourceIndex = 0
  }

  retainSource(index: number): void {
    if (this.channel?.sources[index]) this.sourceIndex = index
  }

  selectChannel(channelId: string, autoplay: boolean, rememberRecent: boolean): void {
    const channel = this.options.channel(channelId)
    if (!channel) return
    this.attempt += 1
    this.resetRecovery()
    this.selection = channel.id
    const preferred = this.preferredSource(channel)
    this.sourceIndex = preferred?.index ?? 0
    this.failedSources.clear()
    this.options.viewing.select(channel.id)
    if (rememberRecent) this.remember(channel.id)
    this.options.view.selected(channel, autoplay)
    if (autoplay && preferred) this.playSource(preferred.source, preferred.index)
  }

  selectSource(index: number): void {
    const source = this.channel?.sources[index]
    if (!source) return
    this.resetRecovery()
    this.failedSources.clear()
    this.playSource(source, index)
  }

  async toggle(fallback?: CatalogChannel): Promise<boolean> {
    if (await this.retryPendingNetwork('manual')) return true
    const channel = this.channel ?? fallback
    if (!channel) return false
    if (channel.id !== this.selection) this.selectChannel(channel.id, false, false)
    if (!this.options.player.hasSource) {
      this.failedSources.clear()
      const source = channel.sources[this.sourceIndex] ?? this.preferredSource(channel)?.source
      if (source) this.playSource(source, channel.sources.indexOf(source))
    } else {
      await this.options.player.toggle()
    }
    return true
  }

  stop(): void {
    this.attempt += 1
    this.resetRecovery()
    this.failedSources.clear()
    this.options.player.stop()
  }

  resetHealthObservation(): void { this.healthRecorded = false }

  handleState(state: PlaybackState, message: string): void {
    if (state === 'idle') this.attempt += 1
    if (state === 'playing' || state === 'idle') this.resetRecovery()
    this.options.view.state(state, message)
  }

  handleMetrics(snapshot: PlaybackMetricsSnapshot): void {
    this.options.view.metrics(snapshot)
    if (this.healthRecorded || !snapshot.sourceId || snapshot.startupMs === null || snapshot.mediaAdvancedSeconds < 15) return
    const source = this.channel?.sources[this.sourceIndex]
    if (!source || source.id !== snapshot.sourceId || !this.options.canRecordHealth()) return
    const observationMs = snapshot.mediaAdvancedSeconds * 1000 + snapshot.stallDurationMs
    const stallRatio = observationMs > 0 ? snapshot.stallDurationMs / observationMs : 0
    if (stallRatio > 0.05 || (snapshot.droppedFrameRatio ?? 0) > 0.02) return
    this.options.viewing.recordSuccess(source.id, { startupMs: snapshot.startupMs, stallRatio })
    this.healthRecorded = true
  }

  async handleFatal(failedSource: CatalogSource, diagnostic: PlaybackDiagnostic): Promise<void> {
    const attempt = this.attempt
    let effective = diagnostic
    if (['dns-failure', 'source-timeout', 'source-offline'].includes(diagnostic.code)) {
      try {
        if (!await this.options.isNetworkOnline()) {
          effective = classifyPlaybackDiagnostic(playbackDiagnosticInputForRemoteFailure('network-unavailable'))
        }
      } catch { /* Retain the original source failure if the status check fails. */ }
    }
    if (attempt !== this.attempt) return
    const channel = this.channel
    const source = channel?.sources[this.sourceIndex]
    if (!channel || !source || source.id !== failedSource.id) return
    this.options.view.diagnostic(effective)
    if (effective.code === 'network-unavailable') {
      this.handleState('waiting-network', effective.message)
      this.recovery.suspend({ channelId: channel.id, sourceId: source.id, sourceIndex: this.sourceIndex })
      this.scheduleRecovery()
      this.options.view.toast('网络暂时不可用，已暂停自动切换线路', 6000)
      return
    }
    this.resetRecovery()
    this.options.viewing.recordFailure(source.id)
    this.failedSources.add(source.id)
    const next = this.preferredSource(channel, this.failedSources)
    if (next) {
      this.options.view.toast(`${effective.title}，正在尝试线路 ${next.index + 1}`)
      this.playSource(next.source, next.index, true)
    } else {
      this.handleState('error', `${effective.title}：${effective.message}`)
      this.options.view.toast(`所有线路均连接失败；最后一次：${effective.title}`, 6000)
    }
  }

  async retryPendingNetwork(trigger: 'manual' | 'online' | 'scheduled'): Promise<boolean> {
    const pending = this.recovery.snapshot()
    if (!pending) return false
    if (this.checkingGeneration === pending.generation) return true
    this.checkingGeneration = pending.generation
    let online = false
    try {
      online = await this.options.isNetworkOnline()
    } catch {
      if (trigger === 'manual') this.options.view.toast('暂时无法确认网络状态，请稍后再试')
      return true
    } finally {
      if (this.checkingGeneration === pending.generation) this.checkingGeneration = undefined
    }
    const target = this.recovery.claim(pending, online, this.currentTarget(), this.clock.now())
    if (!online) {
      if (trigger === 'manual') this.options.view.toast('网络仍不可用，请检查 Wi-Fi、VPN 或系统代理', 6000)
      return true
    }
    if (target) {
      const source = this.options.channel(target.channelId)?.sources[target.sourceIndex]
      if (source?.id === target.sourceId) {
        this.options.view.toast('正在重新连接当前线路')
        this.playSource(source, target.sourceIndex)
      }
    }
    return true
  }

  private playSource(source: CatalogSource, index: number, preserveDiagnostic = false): void {
    const channel = this.channel
    if (!channel) return
    this.attempt += 1
    this.clearRecoveryTimer()
    this.recovery.cancelPending()
    this.sourceIndex = index
    this.remember(channel.id)
    this.healthRecorded = false
    this.options.view.starting(source, preserveDiagnostic)
    this.options.player.load(source, channel.id, true)
  }

  private preferredSource(channel: CatalogChannel, excluded: ReadonlySet<string> = new Set()) {
    return rankSources(channel.sources, this.options.viewing.health, excluded)[0]
  }

  private remember(channelId: string): void {
    this.options.viewing.remember(channelId)
    this.options.view.recentChanged()
  }

  private currentTarget(): PlaybackNetworkTarget | undefined {
    const channel = this.channel
    const source = channel?.sources[this.sourceIndex]
    return channel && source ? { channelId: channel.id, sourceId: source.id, sourceIndex: this.sourceIndex } : undefined
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer !== undefined || !this.recovery.shouldSchedule(this.clock.now())) return
    this.recoveryTimer = this.clock.setTimeout(() => {
      this.recoveryTimer = undefined
      void this.retryPendingNetwork('scheduled')
    }, 3000)
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== undefined) this.clock.clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
  }

  private resetRecovery(): void {
    this.clearRecoveryTimer()
    this.recovery.reset()
  }
}
