import Hls from 'hls.js'
import { SecureHlsLoader } from './secure-hls-loader.ts'

export type HlsProgressiveMode = 'production-forced' | 'library-default'

/**
 * Keeps the production HLS configuration and the deterministic A/B harness on
 * the same construction path. Production retains its existing progressive
 * override until repeatable evidence identifies a stream characteristic that
 * fails under this mode and passes under the library default.
 */
export function createSecureHls(mode: HlsProgressiveMode = 'production-forced'): Hls {
  const hls = new Hls({
    loader: SecureHlsLoader,
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 20,
    maxBufferLength: 60,
    liveSyncDurationCount: 5,
    liveMaxLatencyDurationCount: 10,
    // Prefer steady decoding over racing back to the live edge after a short
    // interruption. Persistent lag is still bounded by the live latency
    // window and handled by the stall watchdog.
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
    // The continuity gate allows at most 2% dropped frames. Cap the current
    // level as soon as a monitoring window reaches that limit, instead of
    // waiting for hls.js's much looser default.
    fpsDroppedMonitoringThreshold: 0.02,
    manifestLoadingTimeOut: 15_000,
    fragLoadingTimeOut: 20_000,
    levelLoadingTimeOut: 15_000
  })

  if (mode === 'production-forced') hls.config.progressive = true
  return hls
}
