import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

export async function inspectElectronRuntime(root = projectRoot) {
  const require = createRequire(join(resolve(root), 'package.json'))
  let packageJsonPath
  try {
    packageJsonPath = require.resolve('electron/package.json')
  } catch (error) {
    return { ready: false, reason: 'package-missing', cause: error }
  }

  const packageRoot = dirname(packageJsonPath)
  const packageMetadata = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  const version = typeof packageMetadata.version === 'string' ? packageMetadata.version : ''
  const expectedRelativePath = electronExecutableRelativePath(
    process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform
  )
  const [installedVersion, configuredRelativePath] = await Promise.all([
    readFile(join(packageRoot, 'dist', 'version'), 'utf8').then((value) => value.trim().replace(/^v/, ''), () => ''),
    readFile(join(packageRoot, 'path.txt'), 'utf8').then((value) => value.trim(), () => '')
  ])
  const executablePath = process.env.ELECTRON_OVERRIDE_DIST_PATH
    ? join(process.env.ELECTRON_OVERRIDE_DIST_PATH, expectedRelativePath)
    : join(packageRoot, 'dist', expectedRelativePath)
  const executablePresent = await access(executablePath, constants.X_OK).then(() => true, () => false)
  const ready = Boolean(version) && installedVersion === version && configuredRelativePath === expectedRelativePath && executablePresent

  return {
    ready,
    reason: ready ? 'ready' : 'binary-missing-or-incomplete',
    version,
    packageRoot,
    installScript: join(packageRoot, 'install.js'),
    expectedRelativePath,
    installedVersion,
    configuredRelativePath,
    executablePresent
  }
}

export async function ensureElectronRuntime(root = projectRoot) {
  const before = await inspectElectronRuntime(root)
  if (before.ready) return before
  if (!before.installScript || !before.packageRoot) {
    throw new Error('Electron npm 包缺失；请先执行全新 npm ci')
  }

  process.stdout.write('Electron 二进制缺失或不完整，正在执行官方安装脚本…\n')
  await runInstaller(before.installScript, before.packageRoot)
  const after = await inspectElectronRuntime(root)
  if (!after.ready) {
    throw new Error(`Electron 官方安装脚本结束后仍不可用（${after.reason}）`)
  }
  return after
}

export function electronExecutableRelativePath(platform) {
  if (platform === 'darwin' || platform === 'mas') return 'Electron.app/Contents/MacOS/Electron'
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return 'electron'
  if (platform === 'win32') return 'electron.exe'
  throw new Error(`Electron 不支持当前安装平台：${platform}`)
}

function runInstaller(installScript, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [installScript], {
      cwd,
      env: process.env,
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`Electron 安装脚本失败（退出码 ${code ?? 'none'}，信号 ${signal ?? 'none'}）`))
    })
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const state = await ensureElectronRuntime()
  process.stdout.write(`Electron 运行时已就绪：v${state.version} · ${process.platform}/${process.arch}\n`)
}
