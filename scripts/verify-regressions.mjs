import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, preview } from 'vite'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(join(tmpdir(), 'tv-feed-regressions-'))
const behaviorOnly = process.argv.includes('--behavior-only')
const development = process.argv.includes('--development')
let previewServer

try {
  const media = join(temporary, 'media')
  await mkdir(media)
  if (!behaviorOnly) {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '80', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
      '-preset', 'ultrafast', '-b:v', '2500k', '-g', '50', '-sc_threshold', '0', '-threads', '1',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_segment_filename', join(media, 'segment-%02d.ts'), join(media, 'live.m3u8')
    ], 45_000)
  }
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: join(root, 'tests/fixtures/regression-runner.ts'),
      outDir: join(temporary, 'main'),
      rollupOptions: { external: ['electron'], output: { entryFileNames: 'index.mjs' } }
    }
  })
  await symlink(join(root, 'out/renderer'), join(temporary, 'renderer'), 'dir')
  if (development) {
    previewServer = await preview({
      configFile: false, root, logLevel: 'error',
      build: { outDir: 'out/renderer' },
      preview: { host: '127.0.0.1', port: 0 }
    })
  }
  const rendererUrl = previewServer?.resolvedUrls?.local[0] ?? ''
  if (development && !rendererUrl) throw new Error('开发模式验收服务器未返回可用地址')
  const output = await run(require('electron'), [join(temporary, 'main/index.mjs')], 220_000, {
    TVFEED_REGRESSION_ROOT: temporary,
    TVFEED_REGRESSION_PRELOAD: join(root, 'out/preload/index.cjs'),
    TVFEED_REGRESSION_BEHAVIOR_ONLY: behaviorOnly ? '1' : '0',
    TVFEED_REGRESSION_RENDERER_URL: rendererUrl
  })
  const line = output.split('\n').find((value) => value.startsWith('TVFEED_REGRESSION_RESULT '))
  if (!line || JSON.parse(line.slice('TVFEED_REGRESSION_RESULT '.length)).ok !== true) {
    throw new Error('Electron 未返回完整回归验收结果')
  }
} finally {
  if (previewServer) await new Promise((resolveClose) => previewServer.httpServer.close(resolveClose))
  await rm(temporary, { recursive: true, force: true })
}

function run(command, args, timeoutMs, environment = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root, env: { ...process.env, ...environment, ELECTRON_RUN_AS_NODE: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let errors = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk) })
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-12_000) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) resolveRun(output)
      else reject(new Error(`${command} ${timedOut ? '超时' : `退出码 ${code}`}\n${errors}`))
    })
  })
}
