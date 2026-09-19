import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fetchIptvOrgBundle,
  createIptvOrgFetcher,
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

test('辅助接口共享短预算，超时后取消请求且不再启动下一批', { timeout: 2000 }, async () => {
  const signals: AbortSignal[] = []
  let logosRequested = false
  const result = await fetchIptvOrgBundle(() => undefined, {
    optionalBudgetMs: 20,
    fetcher: async (url, options) => {
      if (url === IPTV_ORG_ENDPOINTS.logos) logosRequested = true
      if (url === IPTV_ORG_ENDPOINTS.countries || url === IPTV_ORG_ENDPOINTS.categories) {
        assert.equal(options.timeoutMs, 2500)
        signals.push(options.signal!)
        // The caller must finish even if a transport fails to reject on abort.
        return new Promise(() => undefined)
      }
      assert.equal(options.timeoutMs, 30000)
      return jsonResponse([])
    }
  })
  assert.equal(signals.length, 2)
  assert.ok(signals.every(signal => signal.aborted))
  assert.equal(logosRequested, false)
  assert.equal(result.warnings.length, 3)
})

test('只复用未过期辅助信息，每次同步重新获取频道、线路和 blocklist', async () => {
  let now = 0
  const counts = new Map<string, number>()
  const fetch = createIptvOrgFetcher({ now: () => now, fetcher: async url => {
    counts.set(url, (counts.get(url) ?? 0) + 1)
    return jsonResponse([])
  } })
  await fetch()
  await fetch()
  for (const name of ['channels', 'streams', 'blocklist'] as const) assert.equal(counts.get(IPTV_ORG_ENDPOINTS[name]), 2)
  for (const name of ['countries', 'categories', 'logos'] as const) assert.equal(counts.get(IPTV_ORG_ENDPOINTS[name]), 1)
  now += 12 * 60 * 60 * 1000
  await fetch()
  assert.equal(counts.get(IPTV_ORG_ENDPOINTS.logos), 2)
})

test('取消目录请求停止退避重试，不降级成缺少辅助信息的成功结果', async () => {
  const controller = new AbortController()
  let attempts = 0
  await assert.rejects(fetchIptvOrgBundle(progress => {
    if (progress.attempt) controller.abort(new Error('caller-left'))
  }, {
    fetcher: async url => {
      if (url === IPTV_ORG_ENDPOINTS.logos) {
        attempts += 1
        throw new SecureNetworkError('timeout', 'Fixture timeout', true)
      }
      return jsonResponse([])
    }
  }, controller.signal), /caller-left/)
  assert.equal(attempts, 1)
})

test('必需输入失败取消并行的兄弟请求', async () => {
  let streamSignal: AbortSignal | undefined
  await assert.rejects(fetchIptvOrgBundle(() => undefined, { fetcher: async (url, options) => {
    if (url === IPTV_ORG_ENDPOINTS.channels) return { ...jsonResponse([]), body: new TextEncoder().encode('{broken') }
    streamSignal = options.signal
    return new Promise(() => undefined)
  } }))
  assert.equal(streamSignal?.aborted, true)
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
