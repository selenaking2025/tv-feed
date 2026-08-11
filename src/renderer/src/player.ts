import Hls from 'hls.js'
import type { CatalogSource } from '../../shared/contracts.ts'
import { SecureHlsLoader } from './secure-hls-loader.ts'

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

interface PlayerCallbacks {
  onState(state: PlaybackState, message: string): void
  onFatal(message: string): void
}

export class StreamPlayer {
  private readonly video: HTMLVideoElement
  private readonly callbacks: PlayerCallbacks
  private hls: Hls | undefined
  private currentSource: CatalogSource | undefined
  private shouldAutoplay = false
  private mediaRecoveryAttempted = false
  private stopping = false

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

  load(source: CatalogSource, autoplay = true): void {
    this.releaseMedia()
    this.currentSource = source
    this.shouldAutoplay = autoplay
    this.mediaRecoveryAttempted = false
    this.callbacks.onState('loading', '正在连接直播线路…')

    if (Hls.isSupported()) {
      this.hls = new Hls({
        loader: SecureHlsLoader,
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 60,
        maxBufferLength: 30,
        manifestLoadingTimeOut: 15_000,
        fragLoadingTimeOut: 20_000,
        levelLoadingTimeOut: 15_000
      })
      this.hls.attachMedia(this.video)
      this.hls.on(Hls.Events.MEDIA_ATTACHED, () => this.hls?.loadSource(source.url))
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => void this.playIfRequested())
      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.mediaRecoveryAttempted) {
          this.mediaRecoveryAttempted = true
          this.callbacks.onState('loading', '正在恢复视频信号…')
          this.hls?.recoverMediaError()
          return
        }
        this.fail(data.details ? `线路错误：${data.details}` : '线路无法播放')
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

  private async playIfRequested(): Promise<void> {
    if (!this.shouldAutoplay) return
    try {
      await this.video.play()
    } catch {
      this.callbacks.onState('paused', '点击播放按钮继续')
    }
  }

  private fail(message: string): void {
    if (!this.currentSource) return
    this.callbacks.onState('error', message)
    this.hls?.destroy()
    this.hls = undefined
    this.callbacks.onFatal(message)
  }

  private releaseMedia(): void {
    this.stopping = true
    this.hls?.destroy()
    this.hls = undefined
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
    this.currentSource = undefined
    this.shouldAutoplay = false
    this.stopping = false
  }

  private bindVideoEvents(): void {
    this.video.addEventListener('playing', () => this.callbacks.onState('playing', ''))
    this.video.addEventListener('pause', () => {
      if (!this.stopping && this.currentSource && !this.video.ended) this.callbacks.onState('paused', '')
    })
    this.video.addEventListener('waiting', () => {
      if (this.currentSource) this.callbacks.onState('loading', '正在缓冲直播信号…')
    })
    this.video.addEventListener('stalled', () => {
      if (this.currentSource) this.callbacks.onState('loading', '直播信号暂时中断，正在重试…')
    })
    this.video.addEventListener('error', () => {
      if (!this.hls && this.currentSource) this.fail('系统播放器无法打开这条线路')
    })
  }
}
