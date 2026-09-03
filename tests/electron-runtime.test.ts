import assert from 'node:assert/strict'
import test from 'node:test'
import {
  electronExecutableRelativePath,
  inspectElectronRuntime
} from '../scripts/ensure-electron-runtime.mjs'

test('Electron 可执行文件位置按平台确定且未知平台失败关闭', () => {
  assert.equal(electronExecutableRelativePath('darwin'), 'Electron.app/Contents/MacOS/Electron')
  assert.equal(electronExecutableRelativePath('linux'), 'electron')
  assert.equal(electronExecutableRelativePath('win32'), 'electron.exe')
  assert.throws(() => electronExecutableRelativePath('unknown'), /不支持当前安装平台/)
})

test('当前精确依赖安装包含与 npm 包版本一致的 Electron 二进制', async () => {
  const state = await inspectElectronRuntime()
  assert.equal(state.ready, true, JSON.stringify({
    reason: state.reason,
    version: state.version,
    installedVersion: state.installedVersion,
    configuredRelativePath: state.configuredRelativePath,
    expectedRelativePath: state.expectedRelativePath,
    executablePresent: state.executablePresent
  }))
})
