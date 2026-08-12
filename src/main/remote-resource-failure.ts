import type {
  RemoteResourceFailure,
  RemoteResourceFailureCode
} from '../shared/remote-resource-contracts.ts'
import { SecureNetworkError, toSecureNetworkError } from './secure-network.ts'

export function toRemoteResourceFailure(error: unknown, networkOnline: boolean): RemoteResourceFailure {
  const specificCode = fixedFailureCode(error)
  if (specificCode) return failure(specificCode, false)

  const networkError = error instanceof SecureNetworkError ? error : toSecureNetworkError(error)
  switch (networkError.code) {
    case 'dns':
      return networkOnline && !networkError.retryable
        ? failure('dns-failure', false)
        : failure('network-unavailable', true)
    case 'proxy':
      return failure('network-unavailable', networkError.retryable)
    case 'timeout':
      return networkOnline
        ? failure('source-timeout', networkError.retryable)
        : failure('network-unavailable', true)
    case 'http':
      return networkError.statusCode === 401 || networkError.statusCode === 403 || networkError.statusCode === 451
        ? failure('access-restricted', false)
        : failure('source-offline', networkError.retryable)
    case 'security':
      return failure('unsafe-target', false)
    case 'network': {
      const nodeCode = nodeErrorCode(error)
      return !networkOnline || nodeCode === 'ENETDOWN' || nodeCode === 'ENETUNREACH'
        ? failure('network-unavailable', true)
        : failure('source-offline', networkError.retryable)
    }
  }
}

function fixedFailureCode(error: unknown): RemoteResourceFailureCode | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const value = message.toLocaleLowerCase()
  if (/重定向|redirect/.test(value)) return 'redirect-rejected'
  if (/字节安全上限|超过安全上限|response too large|content length exceeded|body exceeded/.test(value)) {
    return 'response-too-large'
  }
  if (/缺少 hls 标头|不是有效的 json|invalid json|invalid playlist|播放列表格式/.test(value)) {
    return 'invalid-playlist'
  }
  if (/非公网|公网 https|private address|loopback|link-local|证书|certificate|\btls\b/.test(value)) {
    return 'unsafe-target'
  }
  return undefined
}

function failure(code: RemoteResourceFailureCode, retryable: boolean): RemoteResourceFailure {
  return { code, retryable }
}

function nodeErrorCode(error: unknown): string {
  let current = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') return ''
    if ('code' in current && typeof current.code === 'string') return current.code
    current = current instanceof Error ? current.cause : undefined
  }
  return ''
}
