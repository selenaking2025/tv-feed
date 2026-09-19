import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const electron = createRequire(import.meta.url)('electron')
const temporary = await mkdtemp(join(tmpdir(), 'tv-feed-single-instance-'))
const children = []
try {
  const driver = join(temporary, 'driver.mjs')
  await writeFile(driver, `
export async function runSmokeInspection(contents) {
  const { app, BrowserWindow } = await import('electron')
  if (!app.hasSingleInstanceLock()) throw new Error('Missing profile lock')
  const result = await contents.executeJavaScript('window.tvFeed.setFamilySafety(true)')
  let activations = 0
  app.on('second-instance', async () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) process.exit(3)
    if (!window.isVisible()) await new Promise(resolve => window.once('show', resolve))
    if (window.isMinimized()) process.exit(3)
    if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once('did-finish-load', resolve))
    const state = await window.webContents.executeJavaScript('window.tvFeed.initializeSafetyState({ familySafety: false, remoteLogos: true })')
    if (!state.familySafety || state.remoteLogos || (activations === 0 && state.revision !== result.state.revision)) process.exit(2)
    activations += 1
    process.stdout.write(activations === 1 ? 'INSTANCE_REACTIVATED\\n' : 'INSTANCE_REOPENED\\n')
    if (activations === 1 && process.platform === 'darwin') {
      // Exercise normal macOS window-close behavior while retaining the app.
      app.removeAllListeners('window-all-closed')
      window.close()
      process.stdout.write('INSTANCE_WINDOW_CLOSED\\n')
    }
  })
  BrowserWindow.fromWebContents(contents).minimize()
  process.stdout.write('INSTANCE_READY\\n')
}
`)
  const first = launch('shared')
  await waitFor(() => first.output.includes('INSTANCE_READY'), '首个实例没有完成初始化')
  const second = launch('shared')
  await waitFor(() => second.exited, '同目录第二个实例未退出')
  assert.equal(second.code, 0)
  assert.ok(!second.output.includes('INSTANCE_READY'))
  await waitFor(() => first.output.includes('INSTANCE_REACTIVATED'), '已有窗口未恢复或安全设置被覆盖')
  if (process.platform === 'darwin') {
    await waitFor(() => first.output.includes('INSTANCE_WINDOW_CLOSED'), 'macOS 窗口未关闭')
    const reopen = launch('shared')
    await waitFor(() => reopen.exited, '恢复已关闭窗口时新进程未退出')
    assert.equal(reopen.code, 0)
    await waitFor(() => first.output.includes('INSTANCE_REOPENED'), '应用留在后台时第二次启动未重开窗口')
  }
  const isolated = launch('isolated')
  await waitFor(() => isolated.output.includes('INSTANCE_READY'), '不同用户目录不能独立运行')
  assert.equal(first.exited, false)
  process.stdout.write('单实例验收通过：同目录第二次启动退出并恢复窗口，安全设置保持不变，不同目录独立运行。\n')

  function launch(profile) {
    const child = spawn(electron, [root], {
      cwd: root,
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '',
        TVFEED_SMOKE_OUTPUT: join(temporary, `${profile}.png`),
        TVFEED_SMOKE_USER_DATA: join(temporary, profile),
        TVFEED_SMOKE_DRIVER_PATH: driver,
        TVFEED_SMOKE_OFFLINE_DEMO: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const state = { child, output: '', exited: false, code: null, closed: null }
    state.closed = new Promise(resolveClose => child.once('close', code => { state.exited = true; state.code = code; resolveClose() }))
    child.stdout.on('data', chunk => { state.output += chunk })
    child.stderr.on('data', chunk => { state.output += chunk })
    child.on('error', error => { state.output += error.message; state.exited = true })
    children.push(state)
    return state
  }
} finally {
  for (const state of children) if (!state.exited) state.child.kill('SIGTERM')
  const forceExit = setTimeout(() => {
    for (const state of children) if (!state.exited) state.child.kill('SIGKILL')
  }, 5000)
  try { await Promise.all(children.map(state => state.closed)) }
  finally { clearTimeout(forceExit) }
  await rm(temporary, { recursive: true, force: true })
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 20_000
  while (!predicate()) {
    if (Date.now() >= deadline || children.some(state => state.exited && state.code !== 0)) {
      throw new Error(`${message}\n${children.map(state => state.output.slice(-3000)).join('\n')}`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
}
