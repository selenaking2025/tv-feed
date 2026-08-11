import Hls from 'hls.js'
import type { CatalogSource } from '../../shared/catalog-contracts.ts'
import {
  classifyPlaybackDiagnostic,
  type PlaybackDiagnostic
} from '../../shared/playback-diagnostics.ts'
import {
  bufferedAheadSeconds,
  mediaAdvanceDelta,
  percentile95,
  type PlaybackMetricsSnapshot
} from '../../shared/playback-metrics.ts'
import { decideStallRecovery } from '../../shared/playback-stability.ts'
import { SecureHlsLoader } from './secure-hls-loader.ts'

const AUTOPLAY_BUFFER_TARGET_SECONDS = 5
const AUTOPLAY_BUFFER_MAX_WAIT_MS = 8_000
const STALL_RECOVERY_WINDOW_MS = 8_000

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

interface PlayerCallbacks {
  onState(state: PlaybackState, message: string): void
  onFatal(diagnostic: PlaybackDiagnostic): void
  onMetrics(snapshot: PlaybackMetricsSnapshot): void
}

export interface VolumeState {
  muted: boolean
  percent: number
}

export class StreamPlayer {
  private readonly video: HTMLVideoElement
  private readonly callbacks: PlayerCallbacks
  private hls: Hls | undefined
  private currentSource: CatalogSource | undefined
  private shouldAutoplay = false
  private mediaRecoveryAttempted = false
  private stopping = false
  private metricsTimer: number | undefined
  private stallWatchdogTimer: number | undefined
  private loadGeneration = 0
  private stallRecoveryAttempted = false
  private metricsStartedAt = 0
  private firstPlayingAt = 0
  private lastObservedCurrentTime = 0
  private accumulatedMediaAdvancedSeconds = 0
  private stallStartedAt = 0
  private completedStallDurationMs = 0
  private stallCount = 0
  private fragmentCount = 0
  private fragmentBytes = 0
  private fragmentLoadRatios: number[] = []
  private retryCount = 0
  private reusedConnectionCount = 0

  constructor(video: HTMLVideoElement, callbacks: PlayerCallbacks) {
    this.video = video
    this.callbacks = callbacks
    this.bindVideoEvents()
  }

  get hasSource(): boolean {
    return Boolean(this.currentSource)
  }

  get isPlaying(): boolean {
    return this.hasSource && !this.video.paused && !this.video.ended
  }

  get volumeState(): VolumeState {
    return {
      muted: this.video.muted || this.video.volume === 0,
      percent: Math.round(this.video.volume * 100)
    }
  }

  get metricsSnapshot(): PlaybackMetricsSnapshot {
    this.updateMediaAdvanced()
    const quality = this.videoPlaybackQuality()
    const activeStallMs = this.stallStartedAt > 0 ? performance.now() - this.stallStartedAt : 0
    return {
      sourceId: this.currentSource?.id ?? '',
      startupMs: this.firstPlayingAt > 0 ? Math.max(0, this.firstPlayingAt - this.metricsStartedAt) : null,
      currentTime: finiteNonNegative(this.video.currentTime),
      mediaAdvancedSeconds: this.accumulatedMediaAdvancedSeconds,
      bufferAheadSeconds: this.bufferAheadSeconds(),
      stallCount: this.stallCount,
      stallDurationMs: Math.round(this.completedStallDurationMs + activeStallMs),
      fragmentCount: this.fragmentCount,
      fragmentBytes: this.fragmentBytes,
      fragmentLoadRatioP95: percentile95(this.fragmentLoadRatios),
      retryCount: this.retryCount,
      reusedConnectionCount: this.reusedConnectionCount,
      droppedFrames: quality.droppedFrames,
      totalFrames: quality.totalFrames,
      droppedFrameRatio: quality.totalFrames > 0 ? quality.droppedFrames / quality.totalFrames : null
    }
  }

  load(source: CatalogSource, autoplay = true): void {
    this.releaseMedia()
    this.currentSource = source
    this.shouldAutoplay = autoplay
    this.mediaRecoveryAttempted = false
    this.stallRecoveryAttempted = false
    this.beginMetrics()
    this.callbacks.onState('loading', '正在连接直播线路…')

    if (Hls.isSupported()) {
      const hls = new Hls({
        loader: SecureHlsLoader,
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 20,
        maxBufferLength: 60,
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 10,
        // Prefer steady decoding over racing back to the live edge after a
        // short interruption. Persistent lag is still bounded by the live
        // latency window and handled by the stall watchdog.
        maxLiveSyncPlaybackRate: 1,
        capLevelToPlayerSize: true,
        capLevelOnFPSDrop: true,
        startLevel: 0,
        abrBandWidthFactor: 0.75,
        abrBandWidthUpFactor: 0.55,
        abrMaxWithRealBitrate: true,
        abrEwmaFastLive: 5,
        abrEwmaSlowLive: 15,
        abrEwmaFastVoD: 5,
        abrEwmaSlowVoD: 15,
        maxStarvationDelay: 2,
        maxLoadingDelay: 2,
        fpsDroppedMonitoringPeriod: 3_000,
        // The continuity gate allows at most 2% dropped frames. Cap the
        // current level as soon as a monitoring window reaches that limit,
        // instead of waiting for hls.js's much looser default.
        fpsDroppedMonitoringThreshold: 0.02,
        manifestLoadingTimeOut: 15_000,
        fragLoadingTimeOut: 20_000,
        levelLoadingTimeOut: 15_000
      })
      // hls.js disables progressive mode automatically for unknown custom
      // loaders. SecureHlsLoader implements the same chunked callback contract,
      // so opt back in only after the instance has finished configuration.
      hls.config.progressive = true
      this.hls = hls
      const generation = this.loadGeneration
      this.hls.attachMedia(this.video)
      this.hls.on(Hls.Events.MEDIA_ATTACHED, () => this.hls?.loadSource(source.url))
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => void this.playIfRequested(generation))
      this.hls.on(Hls.Events.FRAG_LOADED, (_event, data) => this.trackFragment(data))
      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          this.retryCount += 1
          this.emitMetrics()
        }
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.mediaRecoveryAttempted) {
          this.mediaRecoveryAttempted = true
          this.callbacks.onState('loading', '正在恢复视频信号…')
          this.hls?.recoverMediaError()
          return
        }
        this.fail(data.details, data.error, data.response?.text, data.reason, data.type)
      })
      return
    }

    this.fail('当前系统无法启用安全 HLS 加载器')
  }

  async toggle(): Promise<void> {
    if (!this.currentSource) return
    if (this.video.paused) {
      try {
        await this.video.play()
      } catch {
        this.callbacks.onState('paused', '系统阻止了自动播放，请再次点击播放')
      }
    } else {
      this.video.pause()
    }
  }

  stop(): void {
    this.releaseMedia()
    this.callbacks.onState('idle', '')
  }

  toggleMuted(): VolumeState {
    this.video.muted = !this.video.muted
    return this.volumeState
  }

  adjustVolume(delta: number): VolumeState {
    const nextVolume = Math.min(1, Math.max(0, this.video.volume + delta))
    this.video.volume = Math.round(nextVolume * 10) / 10
    if (this.video.volume > 0) this.video.muted = false
    return this.volumeState
  }

  async togglePictureInPicture(): Promise<void> {
    if (!this.currentSource) throw new Error('请先播放一个频道')
    if (!document.pictureInPictureEnabled || typeof this.video.requestPictureInPicture !== 'function') {
      throw new Error('当前系统不支持画中画')
    }
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture()
    } else {
      await this.video.requestPictureInPicture()
    }
  }

  private async playIfRequested(generation: number): Promise<void> {
    const startedAt = performance.now()
    while (
      generation === this.loadGeneration &&
      this.shouldAutoplay &&
      this.bufferAheadSeconds() < AUTOPLAY_BUFFER_TARGET_SECONDS &&
      performance.now() - startedAt < AUTOPLAY_BUFFER_MAX_WAIT_MS
    ) {
      await new Promise<void>((resolvePromise) => window.setTimeout(resolvePromise, 200))
    }
    if (generation !== this.loadGeneration || !this.shouldAutoplay) return
    try {
      await this.video.play()
    } catch {
      this.callbacks.onState('paused', '点击播放按钮继续')
    }
  }

  private fail(...inputs: readonly unknown[]): void {
    if (!this.currentSource) return
    const diagnostic = classifyPlaybackDiagnostic(...inputs)
    this.loadGeneration += 1
    this.shouldAutoplay = false
    this.finishStall()
    this.stopMetricsTimer()
    this.emitMetrics()
    this.callbacks.onState('error', diagnostic.message)
    this.hls?.destroy()
    this.hls = undefined
    this.callbacks.onFatal(diagnostic)
  }

  private releaseMedia(): void {
    this.loadGeneration += 1
    this.stopping = true
    this.finishStall()
    this.stopMetricsTimer()
    this.hls?.destroy()
    this.hls = undefined
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
    this.currentSource = undefined
    this.shouldAutoplay = false
    this.resetMetrics()
    this.emitMetrics()
    this.stopping = false
  }

  private bindVideoEvents(): void {
    this.video.addEventListener('playing', () => {
      if (this.firstPlayingAt === 0) {
        this.firstPlayingAt = performance.now()
      }
      this.lastObservedCurrentTime = finiteNonNegative(this.video.currentTime)
      this.finishStall()
      this.stallRecoveryAttempted = false
      this.callbacks.onState('playing', '')
      this.emitMetrics()
    })
    this.video.addEventListener('pause', () => {
      this.updateMediaAdvanced()
      this.finishStall()
      if (!this.stopping && this.currentSource && !this.video.ended) this.callbacks.onState('paused', '')
    })
    this.video.addEventListener('waiting', () => {
      if (this.currentSource) {
        this.beginStall()
        this.callbacks.onState('loading', '正在缓冲直播信号…')
      }
    })
    this.video.addEventListener('stalled', () => {
      if (this.currentSource) {
        this.beginStall()
        this.callbacks.onState('loading', '直播信号暂时中断，正在重试…')
      }
    })
    this.video.addEventListener('timeupdate', () => this.updateMediaAdvanced())
    this.video.addEventListener('seeking', () => {
      this.lastObservedCurrentTime = finiteNonNegative(this.video.currentTime)
    })
    this.video.addEventListener('error', () => {
      if (!this.hls && this.currentSource) this.fail('系统播放器无法打开这条线路')
    })
  }

  private beginMetrics(): void {
    this.resetMetrics()
    this.metricsStartedAt = performance.now()
    this.metricsTimer = window.setInterval(() => this.emitMetrics(), 500)
    this.emitMetrics()
  }

  private resetMetrics(): void {
    this.metricsStartedAt = 0
    this.firstPlayingAt = 0
    this.lastObservedCurrentTime = 0
    this.accumulatedMediaAdvancedSeconds = 0
    this.stallStartedAt = 0
    this.completedStallDurationMs = 0
    this.stallCount = 0
    this.fragmentCount = 0
    this.fragmentBytes = 0
    this.fragmentLoadRatios = []
    this.retryCount = 0
    this.reusedConnectionCount = 0
  }

  private stopMetricsTimer(): void {
    if (this.metricsTimer !== undefined) window.clearInterval(this.metricsTimer)
    this.metricsTimer = undefined
  }

  private beginStall(): void {
    if (this.firstPlayingAt === 0 || this.stallStartedAt > 0 || this.video.paused) return
    this.stallStartedAt = performance.now()
    this.stallCount += 1
    this.scheduleStallWatchdog(STALL_RECOVERY_WINDOW_MS)
    this.emitMetrics()
  }

  private finishStall(): void {
    this.clearStallWatchdog()
    if (this.stallStartedAt === 0) return
    this.completedStallDurationMs += Math.max(0, performance.now() - this.stallStartedAt)
    this.stallStartedAt = 0
  }

  private scheduleStallWatchdog(delayMs: number): void {
    this.clearStallWatchdog()
    this.stallWatchdogTimer = window.setTimeout(() => this.handleStallWatchdog(), delayMs)
  }

  private handleStallWatchdog(): void {
    this.stallWatchdogTimer = undefined
    if (this.stallStartedAt === 0) return
    const stalledForMs = Math.max(0, performance.now() - this.stallStartedAt)
    const action = decideStallRecovery({
      stalledForMs,
      bufferAheadSeconds: this.bufferAheadSeconds(),
      recoveryAttempted: this.stallRecoveryAttempted,
      paused: this.video.paused,
      hasSource: Boolean(this.currentSource)
    })
    if (action === 'wait') {
      if (!this.video.paused && this.currentSource) this.scheduleStallWatchdog(1_000)
      return
    }
    if (action === 'restart-load') {
      this.stallRecoveryAttempted = true
      this.callbacks.onState('loading', '直播信号停滞，正在重新连接当前线路…')
      this.hls?.stopLoad()
      this.hls?.startLoad(-1)
      this.scheduleStallWatchdog(STALL_RECOVERY_WINDOW_MS)
      return
    }
    this.fail('当前线路在重新连接后仍持续停滞')
  }

  private clearStallWatchdog(): void {
    if (this.stallWatchdogTimer !== undefined) window.clearTimeout(this.stallWatchdogTimer)
    this.stallWatchdogTimer = undefined
  }

  private trackFragment(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const record = data as Record<string, unknown>
    const part = objectRecord(record.part)
    const fragment = objectRecord(record.frag)
    const stats = objectRecord(part?.stats) ?? objectRecord(fragment?.stats)
    const loading = objectRecord(stats?.loading)
    const duration = finitePositive(part?.duration) ?? finitePositive(fragment?.duration)
    const startedAt = finiteNonNegative(loading?.start)
    const endedAt = finiteNonNegative(loading?.end)
    const loaded = finiteNonNegative(stats?.loaded)

    this.fragmentCount += 1
    this.fragmentBytes += loaded
    if (duration !== undefined && endedAt >= startedAt) {
      this.fragmentLoadRatios.push(((endedAt - startedAt) / 1_000) / duration)
      if (this.fragmentLoadRatios.length > 100) this.fragmentLoadRatios.shift()
    }
    if (connectionWasReused(record.networkDetails)) this.reusedConnectionCount += 1
    this.emitMetrics()
  }

  private updateMediaAdvanced(): void {
    if (this.firstPlayingAt === 0) return
    const currentTime = finiteNonNegative(this.video.currentTime)
    this.accumulatedMediaAdvancedSeconds += mediaAdvanceDelta(this.lastObservedCurrentTime, currentTime)
    this.lastObservedCurrentTime = currentTime
  }

  private emitMetrics(): void {
    this.callbacks.onMetrics(this.metricsSnapshot)
  }

  private bufferAheadSeconds(): number {
    const ranges: Array<{ start: number; end: number }> = []
    for (let index = 0; index < this.video.buffered.length; index += 1) {
      ranges.push({ start: this.video.buffered.start(index), end: this.video.buffered.end(index) })
    }
    return bufferedAheadSeconds(finiteNonNegative(this.video.currentTime), ranges)
  }

  private videoPlaybackQuality(): { droppedFrames: number; totalFrames: number } {
    try {
      const quality = this.video.getVideoPlaybackQuality?.()
      return {
        droppedFrames: finiteNonNegative(quality?.droppedVideoFrames),
        totalFrames: finiteNonNegative(quality?.totalVideoFrames)
      }
    } catch {
      return { droppedFrames: 0, totalFrames: 0 }
    }
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function connectionWasReused(value: unknown): boolean {
  return objectRecord(value)?.connectionReused === true
}
