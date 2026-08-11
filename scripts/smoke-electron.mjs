import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, readFile, stat, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const projectRoot = resolve(import.meta.dirname, '..')
const electronPath = process.env.TVFEED_ELECTRON_PATH || require('electron')
const screenshotPath = process.env.TVFEED_SMOKE_OUTPUT || join(tmpdir(), 'tv-feed-smoke.png')
const liveCatalog = process.env.TVFEED_SMOKE_LIVE === '1'
const playbackRequested = process.env.TVFEED_SMOKE_PLAY === '1'
const forcedNetworkFailure = process.env.TVFEED_SMOKE_FORCE_NETWORK_FAILURE === '1'
const expectedPackaged = process.env.TVFEED_EXPECT_PACKAGED === '1'
const smokeUserDataPath = await mkdtemp(join(tmpdir(), 'tv-feed-smoke-user-data-'))
const packagedStdoutPath = join(tmpdir(), `tv-feed-smoke-${process.pid}.stdout`)
const packagedStderrPath = join(tmpdir(), `tv-feed-smoke-${process.pid}.stderr`)
process.once('exit', () => {
  rmSync(smokeUserDataPath, { recursive: true, force: true })
  rmSync(packagedStdoutPath, { force: true })
  rmSync(packagedStderrPath, { force: true })
})

await unlink(screenshotPath).catch(() => undefined)

const childEnvironment = {
  ...process.env,
  TVFEED_OFFLINE_DEMO: liveCatalog ? '0' : '1',
  TVFEED_SMOKE_OUTPUT: screenshotPath,
  TVFEED_SMOKE_USER_DATA: smokeUserDataPath
}
const packagedEnvironmentArguments = Object.entries(childEnvironment)
  .filter(([key, value]) => key.startsWith('TVFEED_') && typeof value === 'string')
  .flatMap(([key, value]) => ['--env', `${key}=${value}`])
const command = expectedPackaged ? '/usr/bin/open' : electronPath
const commandArguments = expectedPackaged
  ? [
      '-n',
      '-W',
      '-j',
      '-o',
      packagedStdoutPath,
      '--stderr',
      packagedStderrPath,
      ...packagedEnvironmentArguments,
      resolve(electronPath, '../../..')
    ]
  : ['.']

const child = spawn(command, commandArguments, {
  cwd: projectRoot,
  env: childEnvironment,
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

const timeout = setTimeout(() => child.kill('SIGTERM'), liveCatalog && !forcedNetworkFailure ? 120_000 : 30_000)
const exitCode = await new Promise((resolveExit) => {
  child.once('error', (error) => {
    errorOutput += error.message
    resolveExit(1)
  })
  child.once('exit', (code) => resolveExit(code ?? 1))
})
clearTimeout(timeout)

if (expectedPackaged) {
  output += await readFile(packagedStdoutPath, 'utf8').catch(() => '')
  errorOutput += await readFile(packagedStderrPath, 'utf8').catch(() => '')
  process.stdout.write(output)
  process.stderr.write(errorOutput)
}

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
if (!checks.directExternalFetchBlocked || /(?:img|media|connect)-src[^;]*https:/i.test(checks.csp || '')) {
  throw new Error(`渲染器外部直连策略未生效：${JSON.stringify({ blocked: checks.directExternalFetchBlocked, csp: checks.csp })}`)
}
if (checks.rows < 8 || checks.visibleChannelNames < 8 || checks.sourceButtons < 1 || !checks.selectedChannel) {
  throw new Error(`频道界面未完整渲染：${JSON.stringify(checks)}`)
}
if (!checks.favoriteToggleWorks || !checks.searchFilterWorks) {
  throw new Error(`核心交互未通过：${JSON.stringify(checks)}`)
}
if (checks.remoteLogoChecked !== false) {
  throw new Error(`远程台标默认状态不安全：${JSON.stringify({ remoteLogoChecked: checks.remoteLogoChecked })}`)
}
if (
  !playbackRequested &&
  (![null, '[]'].includes(checks.storageBeforeInteraction?.favorites) || ![null, '[]'].includes(checks.storageBeforeInteraction?.recents))
) {
  throw new Error(`首次启动包含观看状态：${JSON.stringify(checks.storageBeforeInteraction)}`)
}
if (!playbackRequested && checks.noAutoplay !== true) {
  throw new Error(`首次启动发生了自动播放：${JSON.stringify({ noAutoplay: checks.noAutoplay })}`)
}
if (forcedNetworkFailure && !checks.catalogState?.startsWith('离线样例')) {
  throw new Error(`网络失败时未回退到离线样例：${JSON.stringify({ catalogState: checks.catalogState })}`)
}
if (expectedPackaged && (!checks.packaged || checks.appName !== 'TV Feed' || checks.executableName !== 'TV Feed')) {
  throw new Error(`未运行预期的打包应用：${JSON.stringify({ packaged: checks.packaged, appName: checks.appName, executableName: checks.executableName })}`)
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

const cacheExists = await stat(join(smokeUserDataPath, 'catalog-v1.json')).then(() => true, () => false)
if ((!liveCatalog || forcedNetworkFailure) && cacheExists) {
  throw new Error('离线或网络失败验收意外生成了频道缓存')
}

process.stdout.write(`Electron 验收通过：${screenshotPath}（${screenshot.size} bytes）\n`)
