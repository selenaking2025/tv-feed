import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fetchIptvOrgBundle,
  IPTV_ORG_ENDPOINTS,
  IptvOrgFetchError
} from '../src/main/catalog-upstream.ts'
import { SecureNetworkError, type SecureFetchResult } from '../src/main/secure-network.ts'

test('Logo 等辅助接口失败时有限重试并继续生成核心真实目录输入', async () => {
  let logoAttempts = 0
  const result = await fetchIptvOrgBundle(() => undefined, {
    delay: async () => undefined,
    fetcher: async (url) => {
      if (url === IPTV_ORG_ENDPOINTS.logos) {
        logoAttempts += 1
        throw new SecureNetworkError('http', '远程服务器返回 HTTP 503', true, { statusCode: 503 })
      }
      return jsonResponse([])
    }
  })

  assert.equal(logoAttempts, 2)
  assert.deepEqual(result.bundle.logos, [])
  assert.ok(result.warnings.some((warning) => warning.includes('台标信息暂时不可用')))
})

test('blocklist 是必需安全输入，临时失败最多重试三次后明确阻断', async () => {
  let blocklistAttempts = 0
  await assert.rejects(
    fetchIptvOrgBundle(() => undefined, {
      delay: async () => undefined,
      fetcher: async (url) => {
        if (url === IPTV_ORG_ENDPOINTS.blocklist) {
          blocklistAttempts += 1
          throw new SecureNetworkError('timeout', '远程请求超过总时间上限', true)
        }
        return jsonResponse([])
      }
    }),
    (error: unknown) => error instanceof IptvOrgFetchError && error.code === 'safety-data' && error.retryable
  )
  assert.equal(blocklistAttempts, 3)
})

test('JSON 格式错误属于非临时错误，不会无意义重试', async () => {
  let channelAttempts = 0
  await assert.rejects(
    fetchIptvOrgBundle(() => undefined, {
      delay: async () => undefined,
      fetcher: async (url) => {
        if (url === IPTV_ORG_ENDPOINTS.channels) {
          channelAttempts += 1
          return { ...jsonResponse([]), body: new TextEncoder().encode('{broken') }
        }
        return jsonResponse([])
      }
    }),
    (error: unknown) => error instanceof IptvOrgFetchError && error.code === 'invalid-data' && !error.retryable
  )
  assert.equal(channelAttempts, 1)
})

function jsonResponse(value: unknown): SecureFetchResult {
  return {
    body: new TextEncoder().encode(JSON.stringify(value)),
    contentType: 'application/json',
    finalUrl: 'https://iptv-org.github.io/api/test.json',
    statusCode: 200,
    connectionReused: false
  }
}
