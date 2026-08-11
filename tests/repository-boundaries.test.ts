import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findForbiddenPathViolations,
  findLockfileRegistryViolations,
  findRendererBoundaryViolations,
  findSecretViolations,
  findWorkflowViolations
} from '../scripts/verify-repository-boundaries.mjs'

test('仓库路径门禁拒绝频道缓存、播放列表、构建产物和未批准图片', () => {
  assert.deepEqual(findForbiddenPathViolations([
    'src/main/index.ts',
    'build/icon.png',
    'docs/assets/tv-feed-offline-sample.png'
  ]), [])

  const violations = findForbiddenPathViolations([
    'catalog-v1.json',
    'fixtures/live.m3u8',
    'release/TV Feed.app/Contents/MacOS/TV Feed',
    'logos/third-party.png',
    '.env.local'
  ])
  assert.equal(violations.length, 5)
})

test('锁文件只接受官方 npm registry', () => {
  const official = JSON.stringify({ packages: { 'node_modules/example': { resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz' } } })
  const mirror = JSON.stringify({ packages: { 'node_modules/example': { resolved: 'https://registry.npmmirror.com/example/-/example-1.0.0.tgz' } } })
  assert.deepEqual(findLockfileRegistryViolations(official), [])
  assert.match(findLockfileRegistryViolations(mirror)[0] ?? '', /不来自官方 npm registry/)
})

test('渲染进程网络门禁拒绝直接 fetch 并要求 CSP 和远程台标默认关闭', () => {
  const safeEntries = new Map([
    ['src/main/index.ts', `const CSP = "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:;"`],
    ['src/renderer/index.html', `<meta content="img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:;">`],
    ['src/renderer/src/main.ts', `let remoteLogosEnabled = readStoredBoolean(REMOTE_LOGOS_KEY)\nfunction readStoredBoolean(key) { return localStorage.getItem(key) === 'true' }`]
  ])
  assert.deepEqual(findRendererBoundaryViolations(safeEntries), [])

  safeEntries.set('src/renderer/src/main.ts', `let familySafetyEnabled = readStoredBoolean(FAMILY_SAFETY_KEY)\nlet remoteLogosEnabled = !familySafetyEnabled && readStoredBoolean(REMOTE_LOGOS_KEY)\nfunction readStoredBoolean(key) { return localStorage.getItem(key) === 'true' }`)
  assert.deepEqual(findRendererBoundaryViolations(safeEntries), [])

  safeEntries.set('src/renderer/src/direct.ts', 'fetch("https://example.com")')
  assert.match(findRendererBoundaryViolations(safeEntries).join('\n'), /不得直接使用 fetch/)
})

test('基本密钥扫描识别常见凭据而不把普通配置误报为密钥', () => {
  assert.deepEqual(findSecretViolations(new Map([['safe.ts', 'const timeoutMs = 1000']])), [])
  const fakeToken = 'ghp_' + 'A'.repeat(30)
  assert.match(findSecretViolations(new Map([['unsafe.ts', `const value = '${fakeToken}'`]])).join('\n'), /GitHub token/)
})

test('CI 门禁要求最小权限、完整提交哈希和完整验证命令', () => {
  const safeWorkflow = `permissions:\n  contents: read\nsteps:\n  - uses: actions/checkout@${'a'.repeat(40)}\n  - run: npm ci --registry=https://registry.npmjs.org\n  - run: npm run verify:repository\n  - run: npm run verify:public-release:static\n  - run: npm run typecheck\n  - run: npm test\n  - run: npm run build\n`
  assert.deepEqual(findWorkflowViolations(safeWorkflow), [])
  assert.match(findWorkflowViolations(safeWorkflow.replace(`@${'a'.repeat(40)}`, '@v6')).join('\n'), /完整提交哈希/)
})
