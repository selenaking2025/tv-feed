import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  HlsConfig,
  LoaderConfiguration,
  LoaderContext,
  LoaderResponse
} from 'hls.js'
import { resourceKind, resourceRange, SecureHlsLoader } from '../src/renderer/src/secure-hls-loader.ts'
import type { RemoteResourceRequest, RemoteResourceResponse } from '../src/shared/contracts.ts'

const LOADER_CONFIGURATION: LoaderConfiguration = {
  loadPolicy: {
    maxTimeToFirstByteMs: 1_000,
    maxLoadTimeMs: 1_000,
    timeoutRetry: null,
    errorRetry: null
  },
  maxRetry: 0,
  timeout: 1_000,
  retryDelay: 0,
  maxRetryDelay: 0
}

test('HLS 上下文把播放列表、JSON、分片和密钥映射到受控资源类型', () => {
  assert.equal(resourceKind({ responseType: '' }), 'hls-playlist')
  assert.equal(resourceKind({ responseType: 'text' }), 'hls-playlist')
  assert.equal(resourceKind({ responseType: 'json' }), 'hls-json')
  assert.equal(resourceKind({ responseType: 'arraybuffer' }), 'hls-binary')
})

test('hls.js 的 0/0 表示完整资源，只有正向有效区间才进入 IPC Range', () => {
  assert.deepEqual(resourceRange({ rangeStart: 0, rangeEnd: 0 }), {})
  assert.deepEqual(resourceRange({}), {})
  assert.deepEqual(resourceRange({ rangeStart: 100, rangeEnd: 200 }), { rangeStart: 100, rangeEnd: 200 })
  assert.throws(() => resourceRange({ rangeStart: 200, rangeEnd: 100 }), /字节范围无效/)
  assert.throws(() => resourceRange({ rangeEnd: 100 }), /字节范围无效/)
})

test('安全 HLS Loader 不直接联网，所有上下文都经 preload 桥请求主进程', async () => {
  const requests: RemoteResourceRequest[] = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      tvFeed: {
        fetchRemoteResource: async (request: RemoteResourceRequest): Promise<RemoteResourceResponse> => {
          requests.push(request)
          return responseFor(request)
        },
        cancelRemoteResource: () => undefined
      }
    }
  })

  try {
    const playlist = await load({ url: 'https://media.example.com/master.m3u8', responseType: '' })
    const metadata = await load({ url: 'https://media.example.com/steering.json', responseType: 'json' })
    const binary = await load({
      url: 'https://media.example.com/segment.ts',
      responseType: 'arraybuffer',
      rangeStart: 100,
      rangeEnd: 200
    })

    assert.match(String(playlist.data), /^#EXTM3U/)
    assert.deepEqual(metadata.data, { ok: true })
    assert.ok(binary.data instanceof ArrayBuffer)
    assert.deepEqual(requests.map((request) => request.kind), ['hls-playlist', 'hls-json', 'hls-binary'])
    assert.deepEqual(requests[2] && { start: requests[2].rangeStart, end: requests[2].rangeEnd }, { start: 100, end: 200 })
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('切台或销毁 Loader 会取消尚未完成的主进程请求并忽略迟到响应', async () => {
  const cancelled: string[] = []
  let resolveRemote: ((response: RemoteResourceResponse) => void) | undefined
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      tvFeed: {
        fetchRemoteResource: () => new Promise<RemoteResourceResponse>((resolve) => {
          resolveRemote = resolve
        }),
        cancelRemoteResource: (requestId: string) => cancelled.push(requestId)
      }
    }
  })

  try {
    const loader = new SecureHlsLoader({} as HlsConfig)
    let succeeded = false
    let aborted = false
    loader.load({ url: 'https://media.example.com/live.m3u8', responseType: '' }, LOADER_CONFIGURATION, {
      onSuccess: () => { succeeded = true },
      onError: (error) => assert.fail(error.text),
      onTimeout: () => assert.fail('unexpected timeout'),
      onAbort: () => { aborted = true }
    })
    loader.abort()
    assert.equal(cancelled.length, 1)
    assert.equal(aborted, true)
    resolveRemote?.(responseFor({ requestId: 'late', url: 'https://media.example.com/live.m3u8', kind: 'hls-playlist' }))
    await Promise.resolve()
    assert.equal(succeeded, false)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

function load(context: LoaderContext): Promise<LoaderResponse> {
  const loader = new SecureHlsLoader({} as HlsConfig)
  return new Promise((resolve, reject) => {
    loader.load(context, LOADER_CONFIGURATION, {
      onSuccess: (response) => resolve(response),
      onError: (error) => reject(new Error(error.text)),
      onTimeout: () => reject(new Error('loader timed out'))
    })
  })
}

function responseFor(request: RemoteResourceRequest): RemoteResourceResponse {
  const body = request.kind === 'hls-playlist'
    ? new TextEncoder().encode('#EXTM3U\n')
    : request.kind === 'hls-json'
      ? new TextEncoder().encode('{"ok":true}')
      : Uint8Array.from([1, 2, 3, 4])
  return {
    body,
    contentType: request.kind === 'hls-json' ? 'application/json' : 'application/octet-stream',
    finalUrl: request.url,
    statusCode: 200
  }
}
