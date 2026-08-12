import {
  REMOTE_RESOURCE_FAILURE_CODES,
  type RemoteResourceFailureCode
} from './remote-resource-contracts.ts'

export type PlaybackDiagnosticCode = RemoteResourceFailureCode | 'unsupported-media'

export interface PlaybackDiagnostic {
  code: PlaybackDiagnosticCode
  title: string
  message: string
}

const DIAGNOSTICS: Readonly<Record<PlaybackDiagnosticCode, PlaybackDiagnostic>> = Object.freeze({
  'network-unavailable': Object.freeze({
    code: 'network-unavailable',
    title: '网络连接暂时不可用',
    message: '请检查 Wi-Fi、VPN 或系统代理。连接恢复后会重试当前线路。'
  }),
  'dns-failure': Object.freeze({
    code: 'dns-failure',
    title: '源站域名无法解析',
    message: '这条线路的源站域名当前不可用，请稍后重试或选择其他线路。'
  }),
  'unsafe-target': Object.freeze({
    code: 'unsafe-target',
    title: '目标未通过安全校验',
    message: '线路目标不是可验证的公网地址，已停止连接。'
  }),
  'redirect-rejected': Object.freeze({
    code: 'redirect-rejected',
    title: '重定向被拒绝',
    message: '线路的重定向没有通过安全策略。'
  }),
  'response-too-large': Object.freeze({
    code: 'response-too-large',
    title: '响应超过安全上限',
    message: '第三方源站返回的数据量超过播放器允许的范围。'
  }),
  'invalid-playlist': Object.freeze({
    code: 'invalid-playlist',
    title: '播放列表格式无效',
    message: '第三方源站返回的内容不是有效的 HLS 播放列表。'
  }),
  'access-restricted': Object.freeze({
    code: 'access-restricted',
    title: '线路访问受限',
    message: '这条线路可能受地区、权限或源站访问策略限制。'
  }),
  'source-timeout': Object.freeze({
    code: 'source-timeout',
    title: '源站连接超时',
    message: '第三方源站没有在限定时间内响应。'
  }),
  'unsupported-media': Object.freeze({
    code: 'unsupported-media',
    title: '媒体格式不受支持',
    message: '当前系统无法解码这条线路提供的媒体格式。'
  }),
  'source-offline': Object.freeze({
    code: 'source-offline',
    title: '第三方源暂时不可用',
    message: '线路当前无法连接，可能已离线或临时中断。'
  })
})

const REMOTE_FAILURE_INPUT_PREFIX = 'tvfeed-remote-failure:'

export function playbackDiagnosticInputForRemoteFailure(code: RemoteResourceFailureCode): string {
  return `${REMOTE_FAILURE_INPUT_PREFIX}${code}`
}

/**
 * Converts untrusted network and media errors into a fixed, URL-free message.
 * The original input is only inspected for category matching and is never
 * returned to the renderer UI.
 */
export function classifyPlaybackDiagnostic(...inputs: readonly unknown[]): PlaybackDiagnostic {
  const value = inputs.map(normalizeDiagnosticInput).filter(Boolean).join(' ').toLocaleLowerCase()

  for (const code of REMOTE_RESOURCE_FAILURE_CODES) {
    if (value.includes(playbackDiagnosticInputForRemoteFailure(code))) return DIAGNOSTICS[code]
  }

  if (matches(value, [
    '非公网',
    '公网 https',
    'private address',
    'loopback',
    'link-local'
  ])) return DIAGNOSTICS['unsafe-target']

  if (matches(value, [
    'a/aaaa',
    'enotfound',
    'eai_again',
    'dns',
    'name not resolved',
    'could not resolve',
    '域名无法解析'
  ])) return DIAGNOSTICS['dns-failure']

  if (matches(value, ['重定向', 'redirect'])) return DIAGNOSTICS['redirect-rejected']

  if (matches(value, [
    '字节安全上限',
    '超过安全上限',
    'response too large',
    'content length exceeded',
    'body exceeded'
  ])) return DIAGNOSTICS['response-too-large']

  if (matches(value, [
    '缺少 hls 标头',
    '不是有效的 json',
    'invalid json',
    'manifestparsingerror',
    'manifest parsing',
    'levelparsingerror',
    'level parsing',
    'fragparsingerror',
    'no extsm3u',
    'invalid playlist',
    '播放列表格式'
  ])) return DIAGNOSTICS['invalid-playlist']

  if (/\b(?:http(?: error| status)?\s*)?(?:401|403|451)\b/i.test(value)) {
    return DIAGNOSTICS['access-restricted']
  }

  if (matches(value, ['timeout', 'timed out', '超时'])) return DIAGNOSTICS['source-timeout']

  if (matches(value, [
    'mediaerror',
    'media error',
    'bufferaddcodecerror',
    'bufferincompatiblecodecserror',
    'codec',
    'decode',
    '解码',
    '安全 hls 加载器',
    'secure hls loader',
    '系统播放器无法打开'
  ])) return DIAGNOSTICS['unsupported-media']

  return DIAGNOSTICS['source-offline']
}

function normalizeDiagnosticInput(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return `${value.name} ${value.message}`
  return ''
}

function matches(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern))
}
