import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { OFFICIAL_SOURCE_POLICIES, isVerifiedOfficialSource } from '../src/shared/official-sources.ts'
import { fetchBoundedHttps } from '../src/main/secure-network.ts'
import { readAcceptanceCatalog } from './lib/read-acceptance-catalog.mjs'

const args = parseArgs(process.argv.slice(2))
const source = args.catalogPath
  ? await sourceFromOfficialCatalog(args.catalogPath, args.channelId)
  : await discoverAppleBipBop()

const outputPath = args.outputPath || join(tmpdir(), 'tv-feed-hls-playback.png')
const child = spawn(process.execPath, ['scripts/smoke-electron.mjs'], {
  cwd: resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    TVFEED_SMOKE_ACCEPTANCE_URL: source.url,
    TVFEED_SMOKE_PLAY: '1',
    TVFEED_SMOKE_PLAY_OBSERVE_MS: process.env.TVFEED_SMOKE_PLAY_OBSERVE_MS || '60000',
    TVFEED_SMOKE_OUTPUT: outputPath
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let output = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  output += chunk
  process.stdout.write(chunk)
})
child.stderr.on('data', (chunk) => {
  output += chunk
  process.stderr.write(chunk)
})

const code = await new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', (exitCode) => resolveExit(exitCode ?? 1))
})
if (code !== 0) throw new Error(`Electron HLS 播放验收失败（退出码 ${code}）`)
if (/https?:\/\//i.test(output)) throw new Error('Electron HLS 播放验收输出意外包含完整远程 URL')
process.stdout.write(`HLS 实际播放通过：${source.label} · ${source.host}\n`)

async function discoverAppleBipBop() {
  const page = await fetchBoundedHttps('https://developer.apple.com/streaming/examples/advanced-stream-hevc.html', {
    accept: 'text/html',
    allowCompression: true,
    maxBytes: 512 * 1_024,
    timeoutMs: 20_000
  })
  const html = new TextDecoder('utf-8', { fatal: true }).decode(page.body)
  const url = html.match(/https:\/\/devstreaming-cdn\.apple\.com\/[^"'<>\s]+\.m3u8(?:\?[^"'<>\s]*)?/i)?.[0] ?? ''
  if (!url) throw new Error('Apple 官方示例页没有发现 HLS 清单')
  return { label: 'Apple Bip Bop advanced', host: new URL(url).hostname, url }
}

async function sourceFromOfficialCatalog(catalogPath, channelId) {
  const policy = OFFICIAL_SOURCE_POLICIES.find((entry) => entry.channelId === channelId)
  if (!policy) throw new Error(`频道 ${channelId} 不在人工批准的官方源清单中`)
  const catalog = await readAcceptanceCatalog(catalogPath)
  const channel = catalog.channels.find((entry) => entry.id === channelId)
  const source = channel?.sources.find((entry) => isVerifiedOfficialSource(channel, entry))
  if (!channel || !source) throw new Error(`当前目录没有 ${channelId} 的已批准官方线路`)
  return { label: channel.name, host: new URL(source.url).hostname, url: source.url }
}

function parseArgs(values) {
  let catalogPath = ''
  let channelId = ''
  let outputPath = ''
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--catalog') catalogPath = values[++index] ?? ''
    else if (value === '--channel') channelId = values[++index] ?? ''
    else if (value === '--output') outputPath = resolve(values[++index] ?? '')
    else throw new Error(`未知参数：${value}`)
  }
  if (Boolean(catalogPath) !== Boolean(channelId)) throw new Error('--catalog 与 --channel 必须同时提供')
  return { catalogPath, channelId, outputPath }
}
