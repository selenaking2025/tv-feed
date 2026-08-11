export interface PlaybackMetricsSnapshot {
  sourceId: string
  startupMs: number | null
  currentTime: number
  mediaAdvancedSeconds: number
  bufferAheadSeconds: number
  stallCount: number
  stallDurationMs: number
  fragmentCount: number
  fragmentBytes: number
  fragmentLoadRatioP95: number | null
  retryCount: number
  reusedConnectionCount: number
  droppedFrames: number
  totalFrames: number
  droppedFrameRatio: number | null
}

export interface PlaybackContinuityInput {
  startedCurrentTime: number
  endedCurrentTime: number
  observationMs: number
  stallDurationMs: number
  droppedFrames: number
  totalFrames: number
  readyState: number
  paused: boolean
  width: number
}

export interface PlaybackContinuityResult {
  passed: boolean
  advancedSeconds: number
  minimumAdvanceSeconds: number
  stallRatio: number
  droppedFrameRatio: number
  reasons: string[]
}

export function percentile95(values: readonly number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  if (finite.length === 0) return null
  const index = Math.min(finite.length - 1, Math.ceil(finite.length * 0.95) - 1)
  return finite[index] ?? null
}

export function bufferedAheadSeconds(
  currentTime: number,
  ranges: readonly Readonly<{ start: number; end: number }>[]
): number {
  if (!Number.isFinite(currentTime) || currentTime < 0) return 0
  for (const range of ranges) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) continue
    if (currentTime >= range.start - 0.05 && currentTime <= range.end) {
      return Math.max(0, range.end - currentTime)
    }
  }
  return 0
}

export function mediaAdvanceDelta(previousTime: number, currentTime: number): number {
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) return 0
  const delta = currentTime - previousTime
  // Live playlists may loop or replace their media timeline. Backward movement
  // must not erase already played time, while large seeks must not masquerade
  // as continuous playback.
  return delta > 0 && delta <= 5 ? delta : 0
}

export function evaluatePlaybackContinuity(input: PlaybackContinuityInput): PlaybackContinuityResult {
  const observationSeconds = Math.max(0, input.observationMs / 1_000)
  const advancedSeconds = Math.max(0, input.endedCurrentTime - input.startedCurrentTime)
  const minimumAdvanceSeconds = Math.max(2, observationSeconds * 0.8)
  const stallRatio = input.observationMs > 0 ? Math.max(0, input.stallDurationMs) / input.observationMs : 1
  const droppedFrameRatio = input.totalFrames > 0
    ? Math.max(0, input.droppedFrames) / input.totalFrames
    : 0
  const reasons: string[] = []

  if (input.readyState < 2 || input.paused || input.width <= 0) reasons.push('播放器没有保持可播放状态')
  if (advancedSeconds < minimumAdvanceSeconds) reasons.push('观察期内播放时间推进不足')
  if (stallRatio > 0.05) reasons.push('观察期内缓冲停顿超过 5%')
  if (droppedFrameRatio > 0.02) reasons.push('观察期内掉帧超过 2%')

  return {
    passed: reasons.length === 0,
    advancedSeconds,
    minimumAdvanceSeconds,
    stallRatio,
    droppedFrameRatio,
    reasons
  }
}
