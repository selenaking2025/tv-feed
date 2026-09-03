export type PlaybackStartRejectionCode =
  | 'user-action-required'
  | 'request-interrupted'
  | 'media-not-supported'
  | 'security-rejected'
  | 'unknown'

export interface PlaybackStartRejection {
  code: PlaybackStartRejectionCode
  message: string
}

const REJECTIONS: Readonly<Record<PlaybackStartRejectionCode, PlaybackStartRejection>> = Object.freeze({
  'user-action-required': Object.freeze({
    code: 'user-action-required',
    message: '系统需要再次确认播放，请点击播放按钮继续'
  }),
  'request-interrupted': Object.freeze({
    code: 'request-interrupted',
    message: '播放请求被新的操作中断；如未开始，请再次点击播放'
  }),
  'media-not-supported': Object.freeze({
    code: 'media-not-supported',
    message: '当前系统未能启动这条线路的媒体播放'
  }),
  'security-rejected': Object.freeze({
    code: 'security-rejected',
    message: '系统安全策略拒绝了这次播放请求'
  }),
  unknown: Object.freeze({
    code: 'unknown',
    message: '播放器未能开始播放，请再次点击播放'
  })
})

/**
 * Classifies only the stable DOMException name. Raw exception messages can
 * contain media URLs or browser internals and must not reach UI or logs.
 */
export function classifyPlaybackStartRejection(error: unknown): PlaybackStartRejection {
  const name = errorName(error)
  if (name === 'NotAllowedError') return REJECTIONS['user-action-required']
  if (name === 'AbortError') return REJECTIONS['request-interrupted']
  if (name === 'NotSupportedError') return REJECTIONS['media-not-supported']
  if (name === 'SecurityError') return REJECTIONS['security-rejected']
  return REJECTIONS.unknown
}

function errorName(error: unknown): string {
  if (!error || typeof error !== 'object' || !('name' in error)) return ''
  return typeof error.name === 'string' ? error.name : ''
}
