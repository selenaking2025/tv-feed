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

export interface RemoteResourceStreamTicket {
  streamUrl: string
}
