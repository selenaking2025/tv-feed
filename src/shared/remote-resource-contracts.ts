export type RemoteResourceKind = 'hls-playlist' | 'hls-json' | 'hls-binary' | 'logo'

export interface RemoteResourceRequest {
  requestId: string
  url: string
  kind: RemoteResourceKind
  rangeStart?: number
  rangeEnd?: number
}

export interface RemoteResourceResponse {
  body: Uint8Array
  contentType: string
  finalUrl: string
  statusCode: number
  connectionReused?: boolean
}

export const REMOTE_RESOURCE_FAILURE_CODES = Object.freeze([
  'network-unavailable',
  'dns-failure',
  'unsafe-target',
  'redirect-rejected',
  'response-too-large',
  'invalid-playlist',
  'access-restricted',
  'source-timeout',
  'source-offline'
] as const)

export type RemoteResourceFailureCode = typeof REMOTE_RESOURCE_FAILURE_CODES[number]

export interface RemoteResourceFailure {
  code: RemoteResourceFailureCode
  retryable: boolean
}

export type RemoteResourceFetchResult =
  | { ok: true; response: RemoteResourceResponse }
  | { ok: false; failure: RemoteResourceFailure }

export const REMOTE_RESOURCE_FAILURE_HEADER = 'X-TVFeed-Failure-Code'

export function isRemoteResourceFailureCode(value: unknown): value is RemoteResourceFailureCode {
  return typeof value === 'string' && REMOTE_RESOURCE_FAILURE_CODES.some((code) => code === value)
}

export interface RemoteResourceStreamTicket {
  streamUrl: string
}
