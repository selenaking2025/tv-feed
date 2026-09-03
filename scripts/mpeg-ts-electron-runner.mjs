import { app, BrowserWindow } from 'electron'

const resultPrefix = 'TVFEED_MPEG_TS_RESULT '
const harnessUrl = process.env.TVFEED_MPEG_TS_HARNESS_URL ?? ''
let completed = false

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const timeout = setTimeout(() => finish(1, { ok: false, error: 'HarnessTimeout' }), 90_000)

app.whenReady().then(async () => {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/mpeg-ts-harness\.html$/.test(harnessUrl)) {
    finish(1, { ok: false, error: 'InvalidHarnessUrl' })
    return
  }
  const window = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  window.webContents.setAudioMuted(true)
  window.webContents.on('console-message', (details) => {
    if (!details.message.startsWith(resultPrefix)) return
    const serialized = details.message.slice(resultPrefix.length)
    try {
      const payload = JSON.parse(serialized)
      finish(payload?.ok === true ? 0 : 1, payload)
    } catch {
      finish(1, { ok: false, error: 'InvalidHarnessResult' })
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    finish(1, { ok: false, error: `RendererGone:${details.reason}` })
  })
  await window.loadURL(harnessUrl).catch(() => finish(1, { ok: false, error: 'HarnessLoadFailed' }))
}).catch(() => finish(1, { ok: false, error: 'ElectronStartupFailed' }))

function finish(exitCode, payload) {
  if (completed) return
  completed = true
  clearTimeout(timeout)
  process.stdout.write(`${resultPrefix}${JSON.stringify(payload)}\n`)
  process.exitCode = exitCode
  setTimeout(() => app.quit(), 50)
}
