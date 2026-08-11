import assert from 'node:assert/strict'
import type { IncomingHttpHeaders } from 'node:http'
import type { LookupAddress } from 'node:dns'
import type { LookupFunction } from 'node:net'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  createPinnedLookup,
  fetchBoundedHttps,
  formatConnectAuthority,
  gunzipBounded,
  readBoundedBody,
  type AddressResolver,
  type PinnedRequestExecutor,
  type RawHttpsResponse
} from '../src/main/secure-network.ts'
import { isPublicIpAddress, normalizeRemoteHttpsUrl } from '../src/shared/remote-url-policy.ts'

const FETCH_OPTIONS = {
  accept: 'application/octet-stream',
  maxBytes: 64,
  timeoutMs: 1_000
} as const

test('公网地址判定拒绝 IPv4 映射 IPv6、链路本地和保留地址', () => {
  assert.equal(isPublicIpAddress('8.8.8.8'), true)
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true)
  assert.equal(isPublicIpAddress('127.0.0.1'), false)
  assert.equal(isPublicIpAddress('169.254.169.254'), false)
  assert.equal(isPublicIpAddress('::ffff:127.0.0.1'), false)
  assert.equal(isPublicIpAddress('fe90::1'), false)
  assert.equal(isPublicIpAddress('fc00::1'), false)
  assert.equal(isPublicIpAddress('2001:db8::1'), false)
  assert.equal(normalizeRemoteHttpsUrl('https://2130706433/private'), '')
  assert.equal(normalizeRemoteHttpsUrl('https://0x7f000001/private'), '')
})

test('域名任一 A/AAAA 结果为私网时，请求在网络连接前失败', async () => {
  let requestCount = 0
  const request: PinnedRequestExecutor = async () => {
    requestCount += 1
    return response(200, {}, [bytes('unexpected')])
  }

  await assert.rejects(
    fetchBoundedHttps('https://cdn.example.com/live.m3u8', FETCH_OPTIONS, {
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.7', family: 4 }
      ],
      request
    }),
    /解析到了非公网地址/
  )
  assert.equal(requestCount, 0)
})

test('每次重定向都重新解析并拒绝私网目标', async () => {
  const requestedHosts: string[] = []
  const resolve: AddressResolver = async (hostname) => hostname === 'public.example.com'
    ? [{ address: '93.184.216.34', family: 4 }]
    : [{ address: '10.1.2.3', family: 4 }]
  const request: PinnedRequestExecutor = async (target) => {
    requestedHosts.push(target.hostname)
    return response(302, { location: 'https://private.example.com/secret' }, [])
  }

  await assert.rejects(
    fetchBoundedHttps('https://public.example.com/start', FETCH_OPTIONS, { resolve, request }),
    /解析到了非公网地址/
  )
  assert.deepEqual(requestedHosts, ['public.example.com'])
})

test('固定 lookup 只把已验证地址交给实际连接，不进行第二次 DNS 查询', async () => {
  const lookup = createPinnedLookup('media.example.com', [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ])

  const all = await lookupAll(lookup, 'media.example.com')
  assert.deepEqual(all, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ])
  await assert.rejects(lookupAll(lookup, 'changed.example.com'), /不同的主机名/)
  assert.equal(formatConnectAuthority('93.184.216.34', 443), '93.184.216.34:443')
  assert.equal(formatConnectAuthority('2606:4700:4700::1111', 8443), '[2606:4700:4700::1111]:8443')
})

test('同一域名下一次请求发生 DNS rebinding 时会在连接前拒绝', async () => {
  let resolution = 0
  let requestCount = 0
  const resolve: AddressResolver = async () => {
    resolution += 1
    return resolution === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }]
  }
  const request: PinnedRequestExecutor = async () => {
    requestCount += 1
    return response(200, { 'content-type': 'text/plain' }, [bytes('ok')])
  }

  const first = await fetchBoundedHttps('https://rebind.example.com/data', FETCH_OPTIONS, { resolve, request })
  assert.equal(new TextDecoder().decode(first.body), 'ok')
  await assert.rejects(
    fetchBoundedHttps('https://rebind.example.com/data', FETCH_OPTIONS, { resolve, request }),
    /解析到了非公网地址/
  )
  assert.equal(requestCount, 1)
})

test('DNS 解析本身也受请求超时边界约束', async () => {
  let requestCount = 0
  await assert.rejects(
    fetchBoundedHttps('https://slow.example.com/data', { ...FETCH_OPTIONS, timeoutMs: 10 }, {
      resolve: () => new Promise(() => undefined),
      request: async () => {
        requestCount += 1
        return response(200, {}, [bytes('unexpected')])
      }
    }),
    /超过总时间上限/
  )
  assert.equal(requestCount, 0)
})

test('总时间上限覆盖响应正文持续缓慢传输的阶段', async () => {
  const request: PinnedRequestExecutor = async (_target, options) => response(200, {}, {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      yield bytes('a')
      await new Promise<void>((_resolve, reject) => {
        const signal = options.signal
        if (!signal) {
          reject(new Error('missing deadline signal'))
          return
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
  })

  await assert.rejects(
    fetchBoundedHttps('https://slow-body.example.com/data', { ...FETCH_OPTIONS, timeoutMs: 10 }, {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request
    }),
    /超过总时间上限/
  )
})

test('响应正文按流式累计字节执行硬上限', async () => {
  let destroyed = false
  const oversized = response(200, {}, [bytes('1234'), bytes('56789')], () => {
    destroyed = true
  })
  await assert.rejects(readBoundedBody(oversized, 8), /超过 8 字节安全上限/)
  assert.equal(destroyed, true)

  let iterated = false
  const declaredOversized = response(200, { 'content-length': '9' }, [{
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      iterated = true
      yield bytes('123456789')
    }
  }][0] ?? [])
  await assert.rejects(readBoundedBody(declaredOversized, 8), /声明的大小 9/)
  assert.equal(iterated, false)
})

test('gzip 的压缩正文和解压后正文分别受硬上限约束', async () => {
  const compressed = gzipSync(bytes('bounded response'))
  assert.equal(new TextDecoder().decode(await gunzipBounded(compressed, 64)), 'bounded response')

  const compressedBomb = gzipSync(new Uint8Array(1_024).fill(65))
  await assert.rejects(gunzipBounded(compressedBomb, 128), /解压失败或解压后超过 128 字节安全上限/)

  let unexpectedCompressionDestroyed = false
  await assert.rejects(fetchBoundedHttps('https://gzip.example.com/data', FETCH_OPTIONS, {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => response(200, { 'content-encoding': 'gzip' }, [compressed], () => {
      unexpectedCompressionDestroyed = true
    })
  }), /未允许的 gzip 压缩正文/)
  assert.equal(unexpectedCompressionDestroyed, true)

  let acceptEncoding = ''
  const request: PinnedRequestExecutor = async (_target, options) => {
    acceptEncoding = options.headers['Accept-Encoding'] ?? ''
    return response(200, {
      'content-encoding': 'gzip',
      'content-type': 'text/plain'
    }, [compressed])
  }
  const result = await fetchBoundedHttps('https://gzip.example.com/data', { ...FETCH_OPTIONS, allowCompression: true }, {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request
  })
  assert.equal(new TextDecoder().decode(result.body), 'bounded response')
  assert.equal(acceptEncoding, 'gzip')
})

function response(
  statusCode: number,
  headers: IncomingHttpHeaders,
  chunks: readonly Uint8Array[] | AsyncIterable<Uint8Array>,
  onDestroy: () => void = () => undefined
): RawHttpsResponse {
  const body: AsyncIterable<Uint8Array> = Symbol.asyncIterator in Object(chunks)
    ? chunks as AsyncIterable<Uint8Array>
    : {
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
          for (const chunk of chunks as readonly Uint8Array[]) yield chunk
        }
      }
  return {
    statusCode,
    headers,
    body,
    destroy: onDestroy
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function lookupAll(lookup: LookupFunction, hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, address) => {
      if (error) {
        reject(error)
        return
      }
      if (!Array.isArray(address)) {
        reject(new Error('lookup did not return all addresses'))
        return
      }
      resolve(address)
    })
  })
}
