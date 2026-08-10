import { spawn } from 'node:child_process'
import { stat, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const projectRoot = resolve(import.meta.dirname, '..')
const electronPath = process.env.TVFEED_ELECTRON_PATH || require('electron')
const screenshotPath = process.env.TVFEED_SMOKE_OUTPUT || join(tmpdir(), 'tv-feed-smoke.png')
const liveCatalog = process.env.TVFEED_SMOKE_LIVE === '1'
const playbackRequested = process.env.TVFEED_SMOKE_PLAY === '1'

await unlink(screenshotPath).catch(() => undefined)

const child = spawn(electronPath, ['.'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    TVFEED_OFFLINE_DEMO: liveCatalog ? '0' : '1',
    TVFEED_SMOKE_OUTPUT: screenshotPath
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let output = ''
let errorOutput = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  output += chunk
  process.stdout.write(chunk)
})
child.stderr.on('data', (chunk) => {
  errorOutput += chunk
  process.stderr.write(chunk)
})

const timeout = setTimeout(() => child.kill('SIGTERM'), liveCatalog ? 120_000 : 30_000)
const exitCode = await new Promise((resolveExit) => {
  child.once('error', (error) => {
    errorOutput += error.message
    resolveExit(1)
  })
  child.once('exit', (code) => resolveExit(code ?? 1))
})
clearTimeout(timeout)

const combined = `${output}\n${errorOutput}`
const resultLine = combined.split(/\r?\n/).find((line) => line.startsWith('TVFEED_SMOKE_RESULT '))
if (!resultLine) {
  throw new Error(`Electron 未返回验收结果（退出码 ${exitCode}）`)
}

const payload = JSON.parse(resultLine.slice('TVFEED_SMOKE_RESULT '.length))
if (!payload.ok) throw new Error(`Electron 验收失败：${payload.error || '未知错误'}`)

const checks = payload.result
if (checks.title !== 'TV Feed') throw new Error(`窗口标题不正确：${checks.title}`)
if (!checks.ready || !checks.bridge || !checks.hasVideo) throw new Error(`应用初始化不完整：${JSON.stringify(checks)}`)
if (checks.rows < 8 || checks.visibleChannelNames < 8 || checks.sourceButtons < 1 || !checks.selectedChannel) {
  throw new Error(`频道界面未完整渲染：${JSON.stringify(checks)}`)
}
if (!checks.favoriteToggleWorks || !checks.searchFilterWorks) {
  throw new Error(`核心交互未通过：${JSON.stringify(checks)}`)
}
if (checks.countryOptions?.[1]?.value !== 'CN' || !checks.countryOptions?.[1]?.label.includes('中国 / China') || !checks.chinaSearchWorks) {
  throw new Error(`中国地区入口未通过：${JSON.stringify({ countryOptions: checks.countryOptions, chinaSearchResult: checks.chinaSearchResult })}`)
}
if (playbackRequested && !checks.playbackCheck?.passed) {
  throw new Error(`真实播放未通过：${JSON.stringify(checks.playbackCheck)}`)
}
if (!checks.gridColumns || checks.gridColumns === 'none') throw new Error(`双栏布局未生效：${checks.gridColumns}`)

const screenshot = await stat(screenshotPath)
if (screenshot.size < 50_000) throw new Error(`验收截图异常小：${screenshot.size} bytes`)

process.stdout.write(`Electron 验收通过：${screenshotPath}（${screenshot.size} bytes）\n`)
