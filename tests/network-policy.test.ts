import assert from 'node:assert/strict'
import type { IncomingHttpHeaders } from 'node:http'
import type { LookupAddress } from 'node:dns'
import type { LookupFunction } from 'node:net'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  createPinnedLookup,
  fakeIpDnsCompatibilityEnabled,
  fetchBoundedHttps,
  formatConnectAuthority,
  gunzipBounded,
  parseSystemProxyRules,
  readBoundedBody,
  SecureConnectionPool,
  resolvePublicTarget,
  streamBoundedHttps,
  toSecureNetworkError,
  type AddressResolver,
  type PinnedRequestExecutor,
  type RawHttpsResponse
} from '../src/main/secure-network.ts'
import {
  isFakeIpDnsAddress,
  isPublicIpAddress,
  normalizeRemoteHttpsUrl
} from '../src/shared/remote-url-policy.ts'

const FETCH_OPTIONS = {
  accept: 'application/octet-stream',
  maxBytes: 64,
  timeoutMs: 1_000
} as const

test('HTTPS 连接池只复用同一主机、端口和已验证地址集合', () => {
  const pool = new SecureConnectionPool(4, 10)
  const firstTarget = {
    url: new URL('https://media.example.com/live.m3u8'),
    hostname: 'media.example.com',
    addresses: [{ address: '93.184.216.34', family: 4 as const }]
  }
  const reboundTarget = {
    ...firstTarget,
    addresses: [{ address: '93.184.216.35', family: 4 as const }]
  }

  const first = pool.directAgent(firstTarget, 0)
  assert.equal(pool.directAgent(firstTarget, 5), first)
  assert.notEqual(pool.directAgent(reboundTarget, 6), first)
  assert.notEqual(pool.directAgent(firstTarget, 20), first)
  pool.destroy()
  assert.equal(pool.size, 0)
})

test('macOS 代理规则只接受 DIRECT、PROXY 和 HTTPS 并保留回退顺序', () => {
  const routes = parseSystemProxyRules('PROXY 127.0.0.1:8080; HTTPS proxy.example.com:8443; DIRECT')
  assert.deepEqual(routes.map((route) => ({
    kind: route.kind,
    protocol: route.proxy?.protocol ?? '',
    hostname: route.proxy?.hostname ?? '',
    port: route.proxy?.port ?? ''
  })), [
    { kind: 'proxy', protocol: 'http:', hostname: '127.0.0.1', port: '8080' },
    { kind: 'proxy', protocol: 'https:', hostname: 'proxy.example.com', port: '8443' },
    { kind: 'direct', protocol: '', hostname: '', port: '' }
  ])
  assert.throws(() => parseSystemProxyRules('SOCKS5 127.0.0.1:1080'), /没有返回 DIRECT、PROXY 或 HTTPS/)
  assert.throws(() => parseSystemProxyRules('PROXY proxy.example.com/path'), /路径或端口/)
})

test('TLS 建立前的连接重置仍按临时网络故障重试，证书错误保持不可重试', () => {
  const reset = Object.assign(
    new Error('Client network socket disconnected before secure TLS connection was established'),
    { code: 'ECONNRESET' }
  )
  const resetFailure = toSecureNetworkError(reset)
  assert.equal(resetFailure.code, 'network')
  assert.equal(resetFailure.retryable, true)

  const certificateFailure = Object.assign(new Error('certificate has expired'), {
    code: 'CERT_HAS_EXPIRED'
  })
  const certificate = toSecureNetworkError(certificateFailure)
  assert.equal(certificate.code, 'security')
  assert.equal(certificate.retryable, false)
})

test('公网地址判定拒绝 IPv4 映射 IPv6、链路本地和保留地址', () => {
  assert.equal(isPublicIpAddress('8.8.8.8'), true)
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true)
  assert.equal(isPublicIpAddress('127.0.0.1'), false)
  assert.equal(isPublicIpAddress('169.254.169.254'), false)
  assert.equal(isPublicIpAddress('::ffff:127.0.0.1'), false)
  assert.equal(isPublicIpAddress('fe90::1'), false)
  assert.equal(isPublicIpAddress('fc00::1'), false)
  assert.equal(isPublicIpAddress('2001:db8::1'), false)
  assert.equal(isFakeIpDnsAddress('198.18.0.0'), true)
  assert.equal(isFakeIpDnsAddress('198.19.255.255'), true)
  assert.equal(isFakeIpDnsAddress('198.20.0.0'), false)
  assert.equal(normalizeRemoteHttpsUrl('https://2130706433/private'), '')
  assert.equal(normalizeRemoteHttpsUrl('https://0x7f000001/private'), '')
})

test('fake-IP DNS 默认给出明确类别，只有显式开关且全部结果为虚拟地址时才兼容', async () => {
  const resolver: AddressResolver = async () => [
    { address: '198.18.1.10', family: 4 },
    { address: '198.19.2.20', family: 4 }
  ]

  await assert.rejects(
    resolvePublicTarget('https://media.example.com/live.m3u8', resolver),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'fake-ip-dns'
  )
  const accepted = await resolvePublicTarget('https://media.example.com/live.m3u8', resolver, {
    trustFakeIpDns: true
  })
  assert.deepEqual(accepted.addresses, [
    { address: '198.18.1.10', family: 4 },
    { address: '198.19.2.20', family: 4 }
  ])
  assert.equal(fakeIpDnsCompatibilityEnabled({}), false)
  assert.equal(fakeIpDnsCompatibilityEnabled({ TVFEED_TRUST_FAKE_IP_DNS: '0' }), false)
  assert.equal(fakeIpDnsCompatibilityEnabled({ TVFEED_TRUST_FAKE_IP_DNS: '1' }), true)
})

test('fake-IP 兼容模式不接受 IP 字面量、混合公网或其他私网结果', async () => {
  await assert.rejects(
    resolvePublicTarget('https://198.18.1.10/live.m3u8', undefined, { trustFakeIpDns: true }),
    /公网 HTTPS URL/
  )
  await assert.rejects(
    resolvePublicTarget('https://media.example.com/live.m3u8', async () => [
      { address: '198.18.1.10', family: 4 },
      { address: '93.184.216.34', family: 4 }
    ], { trustFakeIpDns: true }),
    /非公网地址/
  )
  await assert.rejects(
    resolvePublicTarget('https://media.example.com/live.m3u8', async () => [
      { address: '198.18.1.10', family: 4 },
      { address: '10.0.0.7', family: 4 }
    ], { trustFakeIpDns: true }),
    /非公网地址/
  )
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

test('301、302、303、307 和 308 的每一跳都重新进入安全目标解析', async () => {
  for (const statusCode of [301, 302, 303, 307, 308]) {
    const requestedHosts: string[] = []
    const result = await fetchBoundedHttps('https://first.example.com/start', FETCH_OPTIONS, {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async (target) => {
        requestedHosts.push(target.hostname)
        return target.hostname === 'first.example.com'
          ? response(statusCode, { location: 'https://second.example.com/final' }, [])
          : response(200, { 'content-type': 'text/plain' }, [bytes('ok')])
      }
    })
    assert.equal(new TextDecoder().decode(result.body), 'ok')
    assert.deepEqual(requestedHosts, ['first.example.com', 'second.example.com'])
  }
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

test('安全媒体流逐块交付并保留受控响应元数据', async () => {
  const stream = await streamBoundedHttps('https://media.example.com/segment.ts', {
    ...FETCH_OPTIONS,
    maxBytes: 8,
    rangeStart: 0,
    rangeEnd: 8
  }, {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (_target, options) => {
      assert.equal(options.headers.Range, 'bytes=0-7')
      return {
        ...response(206, {
          'content-length': '8',
          'content-range': 'bytes 0-7/24',
          'accept-ranges': 'bytes',
          'content-type': 'video/mp2t'
        }, [bytes('1234'), bytes('5678')]),
        connectionReused: true
      }
    }
  })

  const chunks: string[] = []
  for await (const chunk of stream.body) chunks.push(new TextDecoder().decode(chunk))
  assert.deepEqual(chunks, ['1234', '5678'])
  assert.equal(stream.contentLength, 8)
  assert.equal(stream.contentRange, 'bytes 0-7/24')
  assert.equal(stream.acceptRanges, 'bytes')
  assert.equal(stream.connectionReused, true)
})

test('安全媒体流在传输途中超过上限会立即销毁响应', async () => {
  let destroyed = false
  const stream = await streamBoundedHttps('https://media.example.com/segment.ts', {
    ...FETCH_OPTIONS,
    maxBytes: 8
  }, {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => response(200, {}, [bytes('1234'), bytes('56789')], () => {
      destroyed = true
    })
  })

  await assert.rejects(async () => {
    for await (const _chunk of stream.body) {
      // Consume until the byte ceiling terminates the stream.
    }
  }, /超过 8 字节安全上限/)
  assert.equal(destroyed, true)
})

test('取消安全媒体流会中止尚未完成的正文并释放响应', async () => {
  const controller = new AbortController()
  let destroyed = false
  const stream = await streamBoundedHttps('https://media.example.com/segment.ts', {
    ...FETCH_OPTIONS,
    signal: controller.signal
  }, {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (_target, options) => response(200, {}, {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield bytes('first')
        await new Promise<void>((_resolve, reject) => {
          if (options.signal?.aborted) {
            reject(options.signal.reason)
            return
          }
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
      }
    }, () => {
      destroyed = true
    })
  })
  const iterator = stream.body[Symbol.asyncIterator]()
  assert.equal(new TextDecoder().decode((await iterator.next()).value), 'first')
  controller.abort(new Error('test cancel'))
  await assert.rejects(iterator.next(), /test cancel/)
  assert.equal(destroyed, true)
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
