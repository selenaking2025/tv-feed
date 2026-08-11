export interface RuntimeConfig {
  rendererUrl: string
  smoke: {
    enabled: boolean
    driverPath: string
    outputPath: string
    userDataPath: string
    autoplay: boolean
    liveCatalog: boolean
    forceNetworkFailure: boolean
    offlineDemo: boolean
    acceptanceUrl: string
    openOfflineDemo: boolean
    diagnostic: boolean
    familySafety: boolean
    playbackObservationMs: number
    windowWidth: number
    windowHeight: number
  }
}

export function readRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const outputPath = environment.TVFEED_SMOKE_OUTPUT ?? ''
  const enabled = outputPath.length > 0
  return Object.freeze({
    rendererUrl: environment.ELECTRON_RENDERER_URL ?? '',
    smoke: Object.freeze({
      enabled,
      driverPath: enabled ? environment.TVFEED_SMOKE_DRIVER_PATH ?? '' : '',
      outputPath,
      userDataPath: enabled ? environment.TVFEED_SMOKE_USER_DATA ?? '' : '',
      autoplay: enabled && environment.TVFEED_SMOKE_PLAY === '1',
      liveCatalog: enabled && environment.TVFEED_SMOKE_LIVE === '1',
      forceNetworkFailure: enabled && environment.TVFEED_SMOKE_FORCE_NETWORK_FAILURE === '1',
      offlineDemo: enabled && environment.TVFEED_SMOKE_OFFLINE_DEMO === '1',
      acceptanceUrl: enabled ? environment.TVFEED_SMOKE_ACCEPTANCE_URL ?? '' : '',
      openOfflineDemo: enabled && environment.TVFEED_SMOKE_OPEN_OFFLINE_DEMO === '1',
      diagnostic: enabled && environment.TVFEED_SMOKE_DIAGNOSTIC === '1',
      familySafety: enabled && environment.TVFEED_SMOKE_FAMILY === '1',
      playbackObservationMs: boundedNumber(environment.TVFEED_SMOKE_PLAY_OBSERVE_MS, 30_000, 10_000, 180_000),
      windowWidth: boundedNumber(environment.TVFEED_SMOKE_WIDTH, 1_440, 820, 2_400),
      windowHeight: boundedNumber(environment.TVFEED_SMOKE_HEIGHT, 900, 620, 1_600)
    })
  })
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}
