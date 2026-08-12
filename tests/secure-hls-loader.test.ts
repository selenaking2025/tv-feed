import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  HlsConfig,
  LoaderConfiguration,
  LoaderContext,
  LoaderResponse
} from 'hls.js'
import { resourceKind, resourceRange, SecureHlsLoader } from '../src/renderer/src/secure-hls-loader.ts'
import {
  REMOTE_RESOURCE_FAILURE_HEADER,
  type RemoteResourceFetchResult,
  type RemoteResourceRequest,
  type RemoteResourceResponse
} from '../src/shared/remote-resource-contracts.ts'
import { classifyPlaybackDiagnostic } from '../src/shared/playback-diagnostics.ts'

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

test('安全 HLS Loader 让小资源走 IPC、大分片只读取一次性应用内流', async () => {
  const bufferedRequests: RemoteResourceRequest[] = []
  const streamRequests: RemoteResourceRequest[] = []
  const fetchedUrls: string[] = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      fetch: async (url: string): Promise<Response> => {
        fetchedUrls.push(url)
        return new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: 200,
          headers: {
            'content-length': '4',
            'content-type': 'video/mp2t',
            'x-tvfeed-connection-reused': '1'
          }
        })
      },
      tvFeed: {
        fetchRemoteResource: async (request: RemoteResourceRequest): Promise<RemoteResourceFetchResult> => {
          bufferedRequests.push(request)
          return { ok: true, response: responseFor(request) }
        },
        prepareRemoteResourceStream: async (request: RemoteResourceRequest) => {
          streamRequests.push(request)
          return { streamUrl: 'tvfeed://app/__hls_stream/abcdefghijklmnopqrstuvwxyz_123456' }
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
    assert.deepEqual(bufferedRequests.map((request) => request.kind), ['hls-playlist', 'hls-json'])
    assert.deepEqual(streamRequests.map((request) => request.kind), ['hls-binary'])
    assert.deepEqual(streamRequests[0] && { start: streamRequests[0].rangeStart, end: streamRequests[0].rangeEnd }, { start: 100, end: 200 })
    assert.deepEqual(fetchedUrls, ['tvfeed://app/__hls_stream/abcdefghijklmnopqrstuvwxyz_123456'])
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('切台或销毁 Loader 会取消尚未完成的主进程请求并忽略迟到响应', async () => {
  const cancelled: string[] = []
  let resolveRemote: ((response: RemoteResourceFetchResult) => void) | undefined
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      tvFeed: {
        fetchRemoteResource: () => new Promise<RemoteResourceFetchResult>((resolve) => {
          resolveRemote = resolve
        }),
        prepareRemoteResourceStream: async () => ({
          streamUrl: 'tvfeed://app/__hls_stream/abcdefghijklmnopqrstuvwxyz_123456'
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
    resolveRemote?.({
      ok: true,
      response: responseFor({ requestId: 'late', url: 'https://media.example.com/live.m3u8', kind: 'hls-playlist' })
    })
    await Promise.resolve()
    assert.equal(succeeded, false)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('二进制安全媒体流逐块触发进度回调，不在 Loader 中重新拼成整片', async () => {
  const progress: number[][] = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      fetch: async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2]))
          controller.enqueue(Uint8Array.from([3, 4]))
          controller.close()
        }
      }), {
        status: 200,
        headers: {
          'content-length': '4',
          'content-type': 'video/mp2t',
          'x-tvfeed-connection-reused': '1'
        }
      }),
      tvFeed: {
        fetchRemoteResource: async () => assert.fail('binary stream must not use buffered IPC'),
        prepareRemoteResourceStream: async () => ({
          streamUrl: 'tvfeed://app/__hls_stream/abcdefghijklmnopqrstuvwxyz_123456'
        }),
        cancelRemoteResource: () => undefined
      }
    }
  })

  try {
    const loader = new SecureHlsLoader({} as HlsConfig)
    const response = await new Promise<LoaderResponse>((resolve, reject) => {
      loader.load({ url: 'https://media.example.com/segment.ts', responseType: 'arraybuffer' }, {
        ...LOADER_CONFIGURATION,
        highWaterMark: 3
      }, {
        onProgress: (_stats, _context, data) => progress.push([...new Uint8Array(data as ArrayBuffer)]),
        onSuccess: (result, stats, _context, networkDetails) => {
          assert.equal(stats.loaded, 4)
          assert.equal((networkDetails as { connectionReused?: boolean }).connectionReused, true)
          resolve(result)
        },
        onError: (error) => reject(new Error(error.text)),
        onTimeout: () => reject(new Error('loader timed out'))
      })
    })
    assert.deepEqual(progress, [[1, 2, 3, 4]])
    assert.equal((response.data as ArrayBuffer).byteLength, 0)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('缓冲与流式请求都把主进程固定失败类别传给播放诊断', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      fetch: async (): Promise<Response> => new Response('unavailable', {
        status: 503,
        headers: { [REMOTE_RESOURCE_FAILURE_HEADER]: 'network-unavailable' }
      }),
      tvFeed: {
        fetchRemoteResource: async (): Promise<RemoteResourceFetchResult> => ({
          ok: false,
          failure: { code: 'network-unavailable', retryable: true }
        }),
        prepareRemoteResourceStream: async () => ({
          streamUrl: 'tvfeed://app/__hls_stream/abcdefghijklmnopqrstuvwxyz_123456'
        }),
        cancelRemoteResource: () => undefined
      }
    }
  })

  try {
    const bufferedFailure = await load({
      url: 'https://media.example.com/live.m3u8',
      responseType: ''
    }).then(() => assert.fail('buffered request should fail'), (error: unknown) => error)
    const streamFailure = await load({
      url: 'https://media.example.com/segment.ts',
      responseType: 'arraybuffer'
    }).then(() => assert.fail('stream request should fail'), (error: unknown) => error)

    assert.equal(classifyPlaybackDiagnostic(bufferedFailure).code, 'network-unavailable')
    assert.equal(classifyPlaybackDiagnostic(streamFailure).code, 'network-unavailable')
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
