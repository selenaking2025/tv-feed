import assert from 'node:assert/strict'
import test from 'node:test'
import {
  diagnosticTargetKind,
  sanitizeRuntimeDiagnostic
} from '../src/main/runtime-diagnostics.ts'

test('运行诊断隐藏远程地址、本机路径、凭据和多行控制字符', () => {
  const value = sanitizeRuntimeDiagnostic(
    'failed https://private.example/live.m3u8?token=secret at /Users/example/Projects/IPTV/file.ts\nBearer abc123'
  )

  assert.match(value, /failed \[address\] at \[local path\] Bearer \[hidden\]/)
  assert.doesNotMatch(value, /private\.example|secret|\/Users\/|abc123|[\r\n]/)
})

test('运行诊断只记录加载目标类别，不记录目标标识', () => {
  assert.equal(diagnosticTargetKind('http://localhost:5173/src/main.ts'), 'development')
  assert.equal(diagnosticTargetKind('tvfeed://app/index.html'), 'app')
  assert.equal(diagnosticTargetKind('file:///Users/example/private.html'), 'file')
  assert.equal(diagnosticTargetKind('https://private.example/path?token=secret'), 'remote')
  assert.equal(diagnosticTargetKind(''), 'none')
})
