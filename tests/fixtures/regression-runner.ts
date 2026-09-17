import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
import { hardenSession, registerAppProtocol, registerPrivilegedScheme } from '../../src/main/app-protocol.ts'
import { CatalogCoordinator, type CatalogFetchResult } from '../../src/main/catalog-coordinator.ts'
import { registerIpcHandlers } from '../../src/main/register-ipc.ts'
import { RemoteResourceBroker } from '../../src/main/remote-resource-broker.ts'
import { fetchRemoteResource } from '../../src/main/remote-resource-service.ts'
import { streamRemoteResource } from '../../src/main/remote-resource-stream.ts'
import { readRuntimeConfig } from '../../src/main/runtime-config.ts'
import { SafetyCoordinator } from '../../src/main/safety-coordinator.ts'
import { FileSafetyStateStore } from '../../src/main/safety-state-store.ts'
import { fetchBoundedHttps, streamBoundedHttps, SecureNetworkError, type SecureFetchDependencies } from '../../src/main/secure-network.ts'
import { createOfflineSampleCatalog } from '../../src/shared/sample-catalog.ts'
import type { Catalog, CatalogSyncProgressUpdate } from '../../src/shared/catalog-contracts.ts'

// Real renderer, preload, IPC, safety, catalog and resource services. Only the
// external catalog supplier and socket transport are replaced with fixtures.
const temporary = process.env.TVFEED_REGRESSION_ROOT!
const behaviorOnly = process.env.TVFEED_REGRESSION_BEHAVIOR_ONLY === '1'
const results: Record<string, unknown> = {}
let window: BrowserWindow
let resources: RemoteResourceBroker
let requests = 0
let abortedRequests = 0
let networkOnline = true
let mediaMode: 'forbidden' | 'play' | 'held' = 'forbidden'
let fetches = 0
let fetchNext: (report: (update: CatalogSyncProgressUpdate) => void) => Promise<CatalogFetchResult> = async () => {
  throw new SecureNetworkError('network', 'Fixture unavailable', false)
}
const runtime = readRuntimeConfig({ ELECTRON_RENDERER_URL: process.env.TVFEED_REGRESSION_RENDERER_URL ?? '' })
const cacheWrites: Catalog[] = []
const catalog = new CatalogCoordinator({
  cache: {
    readCandidates: async () => ({}),
    write: async (_scope, value, verify) => { cacheWrites.push(value); verify?.(); return value },
    clear: async () => true
  },
  fetchCatalog: (report) => { fetches += 1; return fetchNext(report) }
})

const transport: SecureFetchDependencies = {
  resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  request: async (target, options) => {
    requests += 1
    if (!networkOnline) throw new SecureNetworkError('network', 'Fixture offline', true)
    if (mediaMode === 'forbidden') throw new SecureNetworkError('http', 'Fixture access denied', false, { statusCode: 403 })
    if (mediaMode === 'held') {
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => { abortedRequests += 1; reject(new Error('Fixture cancelled')) }
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    const filename = target.url.pathname.split('/').at(-1) ?? ''
    assert.match(filename, /^(live\.m3u8|segment-\d{2}\.ts)$/)
    const bytes = await readFile(join(temporary, 'media', filename))
    let destroyed = false
    return {
      statusCode: 200,
      headers: {
        'content-type': filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        'content-length': String(bytes.length)
      },
      body: (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 32_768) {
          if (destroyed || options.signal?.aborted) throw new Error('Fixture cancelled')
          yield bytes.subarray(offset, offset + 32_768)
          await delay(3)
        }
      })(),
      destroy: () => { destroyed = true }
    }
  }
}

app.setPath('userData', join(temporary, 'user-data'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
registerPrivilegedScheme()

void app.whenReady().then(async () => {
  const safety = new SafetyCoordinator({
    store: new FileSafetyStateStore(join(temporary, 'safety.json')),
    invalidateCatalog: () => catalog.invalidateCache(),
    cancelRemoteLogos: () => resources.cancelKind('logo'),
    revokePlayback: () => resources.revokePlayback()
  })
  resources = new RemoteResourceBroker({
    assertAllowed: (kind) => safety.assertRemoteResourceAllowed(kind),
    isNetworkOnline: () => networkOnline, rendererUrl: runtime.rendererUrl
  }, {
    fetchResource: (input, signal) => fetchRemoteResource(input, signal, (url, options) => fetchBoundedHttps(url, options, transport)),
    streamResource: (input, signal) => streamRemoteResource(input, signal, (url, options) => streamBoundedHttps(url, options, transport))
  })
  resources.start()
  registerIpcHandlers({
    appVersion: '0.1.0', runtime, catalog, safety, resources,
    isNetworkOnline: () => networkOnline, onRendererReady: () => undefined
  })
  hardenSession(runtime)
  await registerAppProtocol(runtime, resources)
  window = new BrowserWindow({
    width: 1440, height: 900, show: true,
    webPreferences: {
      preload: process.env.TVFEED_REGRESSION_PRELOAD!, sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false
    }
  })
  window.webContents.setAudioMuted(true)
  window.webContents.on('did-start-navigation', () => resources.abortSender(window.webContents.id))
  await reload()
  await verifyDemoIsolation()
  await verifyRetry()
  await verifyFamilyTransition()
  await verifyCatalogOrdering()
  if (!behaviorOnly) await verifyContinuousPlayback()
  results.networkRequests = requests
  results.abortedRequests = abortedRequests
  finish(0)
}).catch((error: unknown) => {
  results.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  finish(1)
})

async function verifyDemoIsolation(): Promise<void> {
  await waitFor('!document.querySelector("#catalog-failure").hidden')
  await evaluate(`
    localStorage.setItem('tvfeed:favorites:v1', JSON.stringify(['AuditExisting.channel', 'Absent.channel']));
    localStorage.setItem('tvfeed:recents:v1', JSON.stringify(['AuditExisting.channel']));
    localStorage.setItem('tvfeed:last-channel:v1', 'AuditExisting.channel');
  `)
  await reload()
  await waitFor('!document.querySelector("#catalog-failure").hidden')
  const before = await storage()
  await click('#open-offline-demo')
  await waitFor('document.querySelector("#app-shell").dataset.catalogSource === "offline-sample"')
  await verifyDeviceTuner()
  await click('#favorite-channel')
  await click('.channel-select')
  await waitFor('document.querySelector("#channel-health").dataset.state === "unavailable"')
  assert.deepEqual(await storage(), before, '演示操作污染了真实观看记录')
  fetchNext = async () => bundle('Existing')
  await click('#refresh-catalog')
  await waitFor('document.querySelector("#channel-title").textContent === "Audit Existing"')
  assert.deepEqual(await storage(), before, '返回真实目录丢失了原有收藏或记录')
  results.demoIsolation = { passed: true, retainedFavorites: 2 }
  report('演示隔离与真实记录恢复')
}

async function verifyRetry(): Promise<void> {
  await click('.channel-select')
  await waitFor('document.querySelector("#channel-health").dataset.state === "unavailable"')
  const before = requests
  await click('#toggle-play')
  await waitUntil(() => requests > before, '失败后的主播放按钮没有重新发起连接')
  await waitFor('document.querySelector("#channel-health").dataset.state === "unavailable"')
  assert.equal(requests - before, 2, '手动重试必须恢复整轮线路尝试，不能沿用上一轮失败集合')
  results.fatalRetry = { passed: true, newRequests: requests - before }
  report('致命失败后的主播放按钮重试')
}

async function verifyDeviceTuner(): Promise<void> {
  await click('#sidebar-close')
  const title = await evaluate('document.querySelector("#channel-title").textContent')
  const point = await evaluate(`(() => {
    const r = document.querySelector('#channel-dial').getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`) as { x: number; y: number }
  const drag = (): void => {
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y - 28 })
  }
  const release = (): void => window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y - 28, button: 'left', clickCount: 1 })
  const before = requests
  drag()
  await waitFor('document.querySelector("#channel-dial").getAttribute("aria-valuenow") === "3"')
  assert.equal(await evaluate('document.querySelector("#channel-title").textContent'), title, '旋钮拖动中不应提前切台')
  assert.equal(requests, before, '旋钮预览不应发起播放请求')
  await evaluate('document.querySelector("#channel-dial").dispatchEvent(new PointerEvent("pointercancel"))')
  release()
  assert.equal(await evaluate('document.querySelector("#channel-dial").getAttribute("aria-valuenow")'), '1')
  drag()
  await delay(40)
  release()
  await waitFor('document.querySelector("#channel-title").textContent === "Demo News Japan"')
  await waitFor('document.querySelector("#channel-health").dataset.state === "unavailable"')
  assert.equal(requests - before, 1, '松开换台旋钮只能提交一次频道选择')
  await click('#stop-player')
  await waitFor('document.querySelector("#app-shell").dataset.power === "off" && !document.querySelector("#player-empty").hidden')
  await click('#stop-player')
  await waitFor('document.querySelector("#app-shell").dataset.power === "on"')
  await waitFor('document.querySelector("#channel-health").dataset.state === "unavailable"')
  await click('#stop-player')
  await evaluate(`document.querySelector('#channel-dial').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))`)
  await waitFor('document.querySelector("#channel-dial").getAttribute("aria-valuenow") === "1"')
  await click('#stop-player')
  results.deviceTuner = { passed: true, previewWithoutRequests: true, cancelledDragRestored: true, singleCommit: true, powerToggle: true }
  report('电视机旋钮拖动、取消、换台与电源开关')
}

async function verifyFamilyTransition(): Promise<void> {
  const gate = deferred<CatalogFetchResult>()
  fetchNext = () => gate.promise
  mediaMode = 'held'
  await evaluate(`window.retainedRow = document.querySelector('[data-channel-id="AuditExisting.channel"] .channel-select')`)
  const before = requests
  await click('#toggle-play')
  await waitUntil(() => requests > before, '未建立待取消的播放请求')
  // An explicit second session also proves tokens obtained before the family
  // transition cannot subsequently admit arbitrary renderer resource requests.
  await evaluate(`(async () => { window.oldSession = await window.tvFeed.startPlayback({ channelId: 'AuditExisting.channel', sourceId: 'AuditExisting.channel:1' }) })()`)
  await evaluate(`document.querySelector('#family-safety-toggle').click()`)
  await waitFor('document.querySelector("#app-shell").dataset.familySafety === "true"')
  const boundaryRequests = requests
  assert.equal(await evaluate('document.querySelectorAll(".channel-select").length'), 0)
  await evaluate(`
    window.retainedRow.click();
    document.querySelector('#toggle-play').click();
    document.querySelector('[data-source-button]')?.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  `)
  assert.equal(await evaluate(`window.tvFeed.startPlayback({ channelId: 'AuditExisting.channel', sourceId: 'AuditExisting.channel:1' }).then(() => false, () => true)`), true)
  assert.equal(await evaluate(`window.tvFeed.fetchRemoteResource({ requestId: 'old-family-session', url: 'https://fixture.invalid/live.m3u8', kind: 'hls-playlist', playbackSessionId: window.oldSession.sessionId }).then(() => false, () => true)`), true)
  await delay(150)
  assert.equal(requests, boundaryRequests, '家庭目录就绪前旧入口仍发出了媒体请求')
  assert.ok(abortedRequests > 0, '切换家庭安全没有取消旧播放请求')
  mediaMode = 'forbidden'
  gate.resolve(bundle('Family'))
  await waitFor('document.querySelector("#app-shell").dataset.catalogCount === "1"')
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-channel-row]")].map(row => row.dataset.channelId)'), ['BloombergTV.us'])
  const saved = await storage()
  assert.equal(saved['tvfeed:recents:v1'], null)
  assert.equal(saved['tvfeed:source-health:v1'], null)
  // Selecting the initial safe channel may record that new safe selection.
  assert.notEqual(saved['tvfeed:last-channel:v1'], 'AuditExisting.channel')
  results.familyTransition = { passed: true, blockedOldEntryPoints: 6, remainingChannels: 1 }
  fetchNext = async () => bundle('Existing')
  await click('#family-safety-toggle')
  await waitFor('document.querySelector("#app-shell").dataset.familySafety === "false" && document.querySelector("#app-shell").dataset.catalogCount === "2"')
  report('家庭模式切换、旧入口拦截和旧会话撤销')
}

async function verifyCatalogOrdering(): Promise<void> {
  await evaluate(`localStorage.setItem('tvfeed:last-channel:v1', 'AuditExisting.channel')`)
  for (const outcome of ['success', 'failure'] as const) {
    const older = deferred<CatalogFetchResult>()
    const newer = deferred<CatalogFetchResult>()
    let oldProgress: ((update: CatalogSyncProgressUpdate) => void) | undefined
    fetchNext = (reportProgress) => { oldProgress = reportProgress; return older.promise }
    const previousFetches = fetches
    await reload()
    await waitUntil(() => fetches > previousFetches, '启动目录请求未发起')
    fetchNext = () => newer.promise
    await click('#refresh-catalog')
    await waitUntil(() => fetches > previousFetches + 1, '刷新未发起新请求')
    newer.resolve(bundle('NEW'))
    await waitFor('document.querySelector("#channel-title").textContent === "Audit NEW"')
    oldProgress?.({ stage: 'processing', message: 'Old progress must be ignored' })
    if (outcome === 'success') older.resolve(bundle('OLD'))
    else older.reject(new Error('Old failure must be ignored'))
    await waitFor('document.querySelector("#app-shell").dataset.appReady === "true"')
    assert.equal(await evaluate('document.querySelector("#channel-title").textContent'), 'Audit NEW')
    assert.equal(await evaluate('document.querySelector("#catalog-failure").hidden'), true)
    assert.ok(!(await evaluate('document.querySelector("#catalog-state").textContent') as string).includes('Old progress'))
    assert.equal(cacheWrites.at(-1)?.channels[0]?.name, 'Audit NEW')
  }
  results.catalogOrdering = { passed: true, lateSuccessIgnored: true, lateFailureIgnored: true, lateProgressIgnored: true }
  report('启动与刷新交错、迟到结果与进度')
}

async function verifyContinuousPlayback(): Promise<void> {
  mediaMode = 'play'
  await click('.channel-select')
  await waitFor('document.querySelector("#video-player").currentTime > 1', 20_000)
  networkOnline = false
  await click('[data-source-button]')
  await waitFor('document.querySelector("#channel-health").dataset.state === "waiting-network"', 15_000)
  const healthBefore = (await storage())['tvfeed:source-health:v1']
  const offlineRequests = requests
  await click('#toggle-play')
  await delay(200)
  assert.equal(requests, offlineRequests, '本机离线时不应持续发起重试')
  assert.equal((await storage())['tvfeed:source-health:v1'], healthBefore)
  networkOnline = true
  await evaluate('window.dispatchEvent(new Event("online"))')
  await waitFor('document.querySelector("#video-player").currentTime > 1 && document.querySelector("#channel-health").dataset.state === "playable"', 20_000)
  const started = Date.now()
  let previousTime = await evaluate('document.querySelector("#video-player").currentTime') as number
  const initialTime = previousTime
  const samples: Array<{ elapsedSeconds: number; currentTime: number }> = []
  let stagnantSamples = 0
  while (Date.now() - started < 60_000) {
    await delay(5_000)
    const time = await evaluate('document.querySelector("#video-player").currentTime') as number
    samples.push({ elapsedSeconds: (Date.now() - started) / 1_000, currentTime: time })
    if (time - previousTime < 3) stagnantSamples += 1
    previousTime = time
    if (Date.now() - started > 28_000 && Date.now() - started < 35_000) report('连续播放已推进 30 秒')
  }
  const metrics = await evaluate('JSON.parse(document.querySelector("#video-player").dataset.playbackMetrics)') as {
    mediaAdvancedSeconds: number; stallDurationMs: number; droppedFrameRatio: number; fragmentCount: number; startupMs: number
  }
  results.continuousPlayback = { observationSeconds: 60, initialTime, samples, stagnantSamples, ...metrics }
  assert.ok(metrics.mediaAdvancedSeconds >= 58, `连续播放推进不足：${metrics.mediaAdvancedSeconds}`)
  assert.ok(metrics.stallDurationMs < 3_000)
  assert.ok(metrics.droppedFrameRatio <= 0.02)
  assert.equal(stagnantSamples, 0)
  assert.ok((await storage())['tvfeed:source-health:v1'], '稳定播放未记录线路成功')
  results.continuousPlayback = { ...results.continuousPlayback as object, passed: true }
  results.offlineRecovery = { passed: true }
  report('断网恢复与 60 秒连续播放')
}

function bundle(label: string): CatalogFetchResult {
  const value = structuredClone(createOfflineSampleCatalog())
  value.source = 'iptv-org'
  value.channels = value.channels.slice(0, 2).map((channel, index) => {
    const id = index === 0 ? 'AuditExisting.channel' : 'BloombergTV.us'
    return {
      ...channel, id, name: index === 0 ? `Audit ${label}` : 'Approved fixture',
      searchText: `audit ${label.toLowerCase()} ${id.toLowerCase()}`,
      sources: channel.sources.map((source, sourceIndex) => ({
        ...source, id: `${id}:${sourceIndex + 1}`, url: 'https://fixture.invalid/live.m3u8'
      }))
    }
  })
  value.stats.channels = 2
  value.stats.candidateStreams = 3
  return { catalog: value, warnings: [] }
}

async function reload(): Promise<void> {
  await window.loadURL(runtime.rendererUrl || 'tvfeed://app/')
  await waitFor('Boolean(window.tvFeed && document.querySelector("#app-shell"))')
}

async function click(selector: string): Promise<void> {
  await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled) throw new Error('Unavailable control: ' + ${JSON.stringify(selector)}); node.click() })()`)
}

async function storage(): Promise<Record<string, string | null>> {
  return evaluate(`Object.fromEntries(['favorites', 'recents', 'last-channel', 'source-health'].map(key => ['tvfeed:' + key + ':v1', localStorage.getItem('tvfeed:' + key + ':v1')]))`)
}

function evaluate<T = unknown>(code: string): Promise<T> {
  return window.webContents.executeJavaScript(code, true).catch((error: Error) => {
    throw new Error(`Renderer evaluation failed: ${code.slice(0, 240)}`, { cause: error })
  }) as Promise<T>
}

async function waitFor(code: string, timeout = 8_000): Promise<void> {
  await waitUntil(() => evaluate<boolean>(code), `UI condition timed out: ${code}`, timeout)
}

async function waitUntil(check: () => boolean | Promise<boolean>, message: string, timeout = 8_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await delay(25)
  }
  throw new Error(message)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function report(message: string): void { process.stdout.write(`回归通过：${message}\n`) }

function finish(code: number): void {
  resources?.dispose()
  process.stdout.write(`TVFEED_REGRESSION_RESULT ${JSON.stringify({ ok: code === 0, ...results })}\n`)
  app.exit(code)
}
