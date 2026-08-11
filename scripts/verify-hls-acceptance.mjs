import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { OFFICIAL_SOURCE_POLICIES, isVerifiedOfficialSource } from '../src/shared/official-sources.ts'
import { probeHlsSource } from '../src/main/hls-probe.ts'
import { fetchBoundedHttps } from '../src/main/secure-network.ts'
import { readAcceptanceCatalog } from './lib/read-acceptance-catalog.mjs'

const APPLE_EXAMPLE_PAGES = [
  ['Apple 3D', 'https://developer.apple.com/streaming/examples/advanced-stream-3d.html'],
  ['Apple Dolby Vision and Atmos', 'https://developer.apple.com/streaming/examples/advanced-stream-dv-atmos.html'],
  ['Apple Bip Bop advanced', 'https://developer.apple.com/streaming/examples/advanced-stream-hevc.html'],
  ['Apple AV1', 'https://developer.apple.com/streaming/examples/tv-trailer-av1.html'],
  ['Apple interstitial', 'https://developer.apple.com/streaming/examples/tv-trailer-interstitial.html']
]

const HLSJS_TEST_CASES = [
  ['hls.js Mux adaptive', 'bbb'],
  ['hls.js AES-128 and alternate audio', 'tracksWithAES'],
  ['hls.js MPEG audio-only', 'mpegAudioOnly'],
  ['hls.js Google Shaka fMP4', 'fmp4'],
  ['hls.js multi-track audio-only', 'altAudioMultiAudioOnly']
]

const HLSJS_TEST_MANIFEST = 'https://raw.githubusercontent.com/video-dev/hls.js/master/tests/test-streams.js'

const args = parseArgs(process.argv.slice(2))
const results = await runLimited(APPLE_EXAMPLE_PAGES.map(([label, pageUrl]) => async () => {
  try {
    const sourceUrl = await discoverAppleExample(pageUrl)
    return await runProbe('protocol-example', label, sourceUrl)
  } catch (error) {
    return failedResult('protocol-example', label, error)
  }
}), 3)

try {
  const manifest = await fetchHlsJsTestManifest()
  results.push(...await runLimited(HLSJS_TEST_CASES.map(([label, key]) => async () => {
    try {
      return await runProbe('protocol-example', label, discoverHlsJsTestStream(manifest, key))
    } catch (error) {
      return failedResult('protocol-example', label, error)
    }
  }), 3))
} catch (error) {
  for (const [label] of HLSJS_TEST_CASES) results.push(failedResult('protocol-example', label, error))
}

if (args.catalogPath) {
  const catalog = await readAcceptanceCatalog(args.catalogPath)
  const broadcasterTasks = OFFICIAL_SOURCE_POLICIES.slice(0, args.maxBroadcasters).map((policy) => async () => {
    const channel = catalog.channels.find((entry) => entry.id === policy.channelId)
    const source = channel?.sources.find((entry) => isVerifiedOfficialSource(channel, entry))
    if (!channel || !source) {
      return {
        group: 'official-broadcaster',
        label: policy.channelId,
        accepted: false,
        status: 'not-in-current-catalog',
        error: '当前本机目录没有与人工批准主机相符的线路'
      }
    }
    return runProbe('official-broadcaster', channel.name, source.url, {
      channelId: channel.id,
      officialWebsiteHost: new URL(policy.officialWebsite).hostname,
      verifiedAt: policy.verifiedAt
    })
  })
  results.push(...await runLimited(broadcasterTasks, 3))
}

const summary = {
  generatedAt: new Date().toISOString(),
  protocolExamples: summarize(results.filter((entry) => entry.group === 'protocol-example')),
  officialBroadcasters: summarize(results.filter((entry) => entry.group === 'official-broadcaster')),
  note: '报告不保存完整直播 URL，只记录来源名称、主机名和 HLS 协议特征。'
}
const report = { summary, results }
if (args.reportPath) await writeFile(args.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })

for (const result of results) {
  const mark = result.accepted ? 'PASS' : result.status === 'not-in-current-catalog' ? 'SKIP' : 'FAIL'
  const host = result.rootHost ? ` · ${result.rootHost}` : ''
  const features = result.accepted
    ? ` · ${result.playlistKind}/${result.segmentContainer}${result.hasAes128 ? '/AES-128' : ''}`
    : ''
  process.stdout.write(`${mark} ${result.group} · ${result.label}${host}${features}\n`)
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

if (summary.protocolExamples.accepted === 0) {
  process.stderr.write('HLS 验收失败：Apple 官方协议示例均未通过。\n')
  process.exitCode = 1
}

async function runProbe(group, label, sourceUrl, metadata = {}) {
  try {
    const result = await probeHlsSource(sourceUrl)
    return {
      group,
      label,
      status: result.accepted ? 'accepted' : 'rejected',
      ...metadata,
      ...result
    }
  } catch (error) {
    return failedResult(group, label, error, {
      ...metadata,
      rootHost: safeHostname(sourceUrl)
    })
  }
}

function failedResult(group, label, error, metadata = {}) {
  return {
    group,
    label,
    accepted: false,
    status: 'failed',
    ...metadata,
    error: sanitizeError(error)
  }
}

async function discoverAppleExample(pageUrl) {
  const response = await fetchBoundedHttps(pageUrl, {
    accept: 'text/html',
    allowCompression: true,
    maxBytes: 512 * 1_024,
    timeoutMs: 20_000
  })
  const html = new TextDecoder('utf-8', { fatal: true }).decode(response.body)
  const candidates = [...html.matchAll(/https:\/\/devstreaming-cdn\.apple\.com\/[^"'<>\s]+\.m3u8(?:\?[^"'<>\s]*)?/g)]
    .map((match) => match[0])
  const sourceUrl = candidates[0]
  if (!sourceUrl) throw new Error('Apple 官方示例页没有发现 HLS 清单')
  return sourceUrl
}

async function fetchHlsJsTestManifest() {
  const response = await fetchBoundedHttps(HLSJS_TEST_MANIFEST, {
    accept: 'text/plain',
    allowCompression: true,
    maxBytes: 512 * 1_024,
    timeoutMs: 20_000
  })
  return new TextDecoder('utf-8', { fatal: true }).decode(response.body)
}

function discoverHlsJsTestStream(manifest, key) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) throw new Error('hls.js 测试项名称无效')
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = manifest.match(new RegExp(`(?:^|\\n)\\s*${escaped}:\\s*\\{[\\s\\S]{0,1024}?\\burl:\\s*['\"]([^'\"]+)['\"]`))
  const url = match?.[1] ?? ''
  if (!url.startsWith('https://') || !url.toLocaleLowerCase().includes('.m3u8')) {
    throw new Error(`hls.js 官方测试清单缺少 ${key}`)
  }
  return url
}

function summarize(entries) {
  return {
    total: entries.length,
    accepted: entries.filter((entry) => entry.accepted).length,
    failed: entries.filter((entry) => entry.status === 'failed' || entry.status === 'rejected').length,
    skipped: entries.filter((entry) => entry.status === 'not-in-current-catalog').length
  }
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/https:\/\/[^\s)]+/gi, '[远程 URL]')
}

function safeHostname(value) {
  try {
    return new URL(value).hostname
  } catch {
    return ''
  }
}

async function runLimited(tasks, concurrency) {
  const results = new Array(tasks.length)
  let next = 0
  async function worker() {
    while (next < tasks.length) {
      const index = next++
      results[index] = await tasks[index]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()))
  return results
}

function parseArgs(values) {
  let catalogPath = ''
  let reportPath = ''
  let maxBroadcasters = OFFICIAL_SOURCE_POLICIES.length
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--catalog') catalogPath = values[++index] ?? ''
    else if (value === '--report') reportPath = resolve(values[++index] ?? '')
    else if (value === '--max-broadcasters') maxBroadcasters = Number(values[++index] ?? '')
    else throw new Error(`未知参数：${value}`)
  }
  if (!Number.isSafeInteger(maxBroadcasters) || maxBroadcasters < 0 || maxBroadcasters > OFFICIAL_SOURCE_POLICIES.length) {
    throw new Error(`--max-broadcasters 必须在 0 到 ${OFFICIAL_SOURCE_POLICIES.length} 之间`)
  }
  return { catalogPath, reportPath, maxBroadcasters }
}
