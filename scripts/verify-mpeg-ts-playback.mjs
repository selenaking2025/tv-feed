import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const electronPath = require('electron')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tv-feed-mpeg-ts-ab-'))
const mediaRoot = join(temporaryRoot, 'media')
const harnessRoot = join(temporaryRoot, 'harness')
let server

process.once('exit', () => rmSync(temporaryRoot, { recursive: true, force: true }))

try {
  await generateFixture(mediaRoot)
  await buildHarness(harnessRoot)
  server = await startFixtureServer(harnessRoot, mediaRoot)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('本地测试服务没有取得端口')
  const result = await runElectron(`http://127.0.0.1:${address.port}/mpeg-ts-harness.html`)
  verifyInterleavedResult(result)
  const summary = result.rounds.map((round) => ({
    round: round.round,
    mode: round.mode === 'library-default' ? 'library-default' : 'production-forced',
    fragments: round.fragmentCount,
    bufferedSeconds: round.bufferedSeconds,
    mediaAdvancedSeconds: round.mediaAdvancedSeconds,
    frames: round.totalFrames,
    passed: round.passed
  }))
  process.stdout.write(`MPEG-TS 交错 A/B 通过：${JSON.stringify(summary)}\n`)
} finally {
  if (server) await new Promise((resolveClose) => server.close(() => resolveClose())).catch(() => undefined)
  rmSync(temporaryRoot, { recursive: true, force: true })
}

async function generateFixture(outputRoot) {
  await mkdir(outputRoot, { recursive: true })
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '14', '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0',
    '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-b:v', '2500k',
    '-maxrate', '3000k', '-bufsize', '6000k', '-g', '50', '-keyint_min', '50',
    '-sc_threshold', '0', '-threads', '1',
    '-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-ac', '1',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
    '-hls_segment_filename', join(outputRoot, 'segment-%02d.ts'),
    join(outputRoot, 'live.m3u8')
  ]
  await runProcess('ffmpeg', args, { cwd: projectRoot, timeoutMs: 30_000 })
  const segmentNames = (await readdir(outputRoot)).filter((name) => /^segment-\d{2}\.ts$/.test(name)).sort()
  if (segmentNames.length < 6) throw new Error(`MPEG-TS 测试信号分片不足：${segmentNames.length}`)
  for (const name of segmentNames) {
    const metadata = await stat(join(outputRoot, name))
    if (metadata.size < 256 * 1_024 || metadata.size > 4 * 1_024 * 1_024) {
      throw new Error(`MPEG-TS 测试分片没有覆盖多块 progressive 路径：${name} ${metadata.size}`)
    }
  }
}

async function buildHarness(outputRoot) {
  await build({
    root: join(projectRoot, 'tests/fixtures'),
    configFile: false,
    logLevel: 'error',
    build: {
      target: 'chrome142',
      outDir: outputRoot,
      emptyOutDir: true,
      rollupOptions: {
        input: join(projectRoot, 'tests/fixtures/mpeg-ts-harness.html')
      }
    }
  })
}

async function startFixtureServer(harnessRoot, mediaRoot) {
  const rawManifest = await readFile(join(mediaRoot, 'live.m3u8'), 'utf8')
  const liveManifest = rawManifest
    .replace(/^#EXT-X-PLAYLIST-TYPE:.*\n/gm, '')
    .replace(/^#EXT-X-ENDLIST\s*$/gm, '')
  const fixtureServer = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (pathname === '/fixture/live.m3u8') {
        send(response, 200, 'application/vnd.apple.mpegurl', Buffer.from(liveManifest))
        return
      }
      const segment = pathname.match(/^\/fixture\/(segment-\d{2}\.ts)$/)?.[1]
      if (segment) {
        await sendChunked(response, 'video/mp2t', await readFile(join(mediaRoot, segment)))
        return
      }
      const relative = pathname === '/' ? 'mpeg-ts-harness.html' : pathname.slice(1)
      const candidate = normalize(join(harnessRoot, relative))
      if (!candidate.startsWith(`${normalize(harnessRoot)}${sep}`)) {
        send(response, 404, 'text/plain', Buffer.from('not found'))
        return
      }
      const body = await readFile(candidate)
      send(response, 200, contentType(candidate), body)
    } catch {
      send(response, 404, 'text/plain', Buffer.from('not found'))
    }
  })
  await new Promise((resolveListen, reject) => {
    fixtureServer.once('error', reject)
    fixtureServer.listen(0, '127.0.0.1', resolveListen)
  })
  return fixtureServer
}

function send(response, statusCode, type, body) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': body.byteLength,
    'Content-Type': type
  })
  response.end(body)
}

async function sendChunked(response, type, body) {
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': body.byteLength,
    'Content-Type': type
  })
  const chunkSize = 32 * 1_024
  for (let offset = 0; offset < body.byteLength; offset += chunkSize) {
    response.write(body.subarray(offset, Math.min(body.byteLength, offset + chunkSize)))
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 12))
  }
  response.end()
}

function contentType(path) {
  const extension = extname(path)
  if (extension === '.html') return 'text/html; charset=utf-8'
  if (extension === '.js') return 'text/javascript; charset=utf-8'
  if (extension === '.css') return 'text/css; charset=utf-8'
  return 'application/octet-stream'
}

async function runElectron(harnessUrl) {
  const result = await runProcess(electronPath, [join(projectRoot, 'scripts/mpeg-ts-electron-runner.mjs')], {
    cwd: projectRoot,
    timeoutMs: 100_000,
    env: { ...process.env, TVFEED_MPEG_TS_HARNESS_URL: harnessUrl }
  })
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('TVFEED_MPEG_TS_RESULT '))
  if (!line) throw new Error(`Electron MPEG-TS harness 没有返回结果：${sanitizeOutput(result.stderr)}`)
  const payload = JSON.parse(line.slice('TVFEED_MPEG_TS_RESULT '.length))
  if (payload?.ok !== true || !Array.isArray(payload.rounds)) {
    throw new Error(`Electron MPEG-TS harness 失败：${String(payload?.error ?? 'unknown')}`)
  }
  return payload
}

function verifyInterleavedResult(result) {
  const expected = [
    'production-forced',
    'library-default',
    'library-default',
    'production-forced',
    'library-default',
    'production-forced'
  ]
  if (JSON.stringify(result.sequence) !== JSON.stringify(expected)) throw new Error('MPEG-TS A/B 顺序被意外改变')
  const defaults = result.rounds.filter((round) => round.mode === 'library-default')
  const controls = result.rounds.filter((round) => round.mode === 'production-forced')
  if (defaults.length !== 3 || controls.length !== 3) throw new Error('MPEG-TS A/B 轮次不完整')
  if (!defaults.every((round) => round.progressive === false && round.passed === true)) {
    throw new Error(`hls.js 默认模式没有稳定通过三轮：${JSON.stringify(defaults)}`)
  }
  if (!controls.every((round) => round.progressive === true && round.passed === true)) {
    throw new Error(`生产 progressive 模式与库默认模式出现分化，需要重新评估：${JSON.stringify(controls)}`)
  }
}

function runProcess(command, args, options) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timeout = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) resolveProcess({ stdout, stderr })
      else reject(new Error(`命令执行失败（退出码 ${code ?? 'none'}，信号 ${signal ?? 'none'}）：${sanitizeOutput(stderr)}`))
    })
  })
}

function sanitizeOutput(value) {
  return value
    .replace(/\b(?:https?|file|tvfeed):\/\/\S+/gi, '[address]')
    .replace(/\/Users\/\S+/g, '[local path]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 600)
}
