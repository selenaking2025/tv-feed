import type { RemoteResourceRequest } from '../shared/contracts.ts'
import {
  streamBoundedHttps,
  type SecureFetchOptions,
  type SecureStreamResult
} from './secure-network.ts'
import { REMOTE_RESOURCE_LIMITS, validateRemoteResourceRequest } from './remote-resource-service.ts'

type SecureStreamer = (url: string, options: SecureFetchOptions) => Promise<SecureStreamResult>

export async function streamRemoteResource(
  input: unknown,
  signal: AbortSignal,
  streamer: SecureStreamer = streamBoundedHttps
): Promise<SecureStreamResult> {
  const request = validateRemoteStreamRequest(input)
  const limits = REMOTE_RESOURCE_LIMITS['hls-binary']
  return streamer(request.url, {
    accept: limits.accept,
    allowCompression: false,
    maxBytes: limits.maxBytes,
    timeoutMs: limits.timeoutMs,
    signal,
    ...(request.rangeStart !== undefined && request.rangeEnd !== undefined
      ? { rangeStart: request.rangeStart, rangeEnd: request.rangeEnd }
      : {})
  })
}

export function validateRemoteStreamRequest(value: unknown): RemoteResourceRequest & { kind: 'hls-binary' } {
  const request = validateRemoteResourceRequest(value)
  if (request.kind !== 'hls-binary') throw new Error('安全媒体流只接受 HLS 二进制资源')
  return request as RemoteResourceRequest & { kind: 'hls-binary' }
}
