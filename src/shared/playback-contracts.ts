export interface PlaybackStartCommand {
  channelId: string
  sourceId: string
}

export interface PlaybackSession {
  sessionId: string
  sourceUrl: string
}

export function parsePlaybackStartCommand(value: unknown): PlaybackStartCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('播放命令无效')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.channelId !== 'string' || candidate.channelId.length === 0 || candidate.channelId.length > 256 ||
    typeof candidate.sourceId !== 'string' || candidate.sourceId.length === 0 || candidate.sourceId.length > 512) {
    throw new Error('播放频道或线路标识无效')
  }
  return { channelId: candidate.channelId, sourceId: candidate.sourceId }
}
