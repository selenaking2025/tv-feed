import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findForbiddenPathViolations,
  findArchitectureBoundaryViolations,
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
    ['src/main/app-protocol.ts', `const CSP = "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:;"`],
    ['src/renderer/index.html', `<meta content="img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:;"><link rel="stylesheet" href="/src/phosphor-icons.css" /><link rel="stylesheet" href="/src/styles.css" />`],
    ['src/renderer/src/main.ts', 'const safetyClient = new SafetyClient(window.tvFeed)'],
    ['src/renderer/src/safety-client.ts', 'bridge.initializeSafetyState(); state.familySafety; state.remoteLogos']
  ])
  assert.deepEqual(findRendererBoundaryViolations(safeEntries), [])

  safeEntries.set('src/renderer/src/secure-hls-loader.ts', 'window.fetch(streamUrl, { redirect: "error" })')
  assert.deepEqual(findRendererBoundaryViolations(safeEntries), [])
  safeEntries.set('src/renderer/src/secure-hls-loader.ts', 'window.fetch(userProvidedUrl)')
  assert.match(findRendererBoundaryViolations(safeEntries).join('\n'), /不得直接使用 fetch/)
  safeEntries.delete('src/renderer/src/secure-hls-loader.ts')

  safeEntries.set('src/renderer/src/main.ts', `const safetyClient = new SafetyClient(window.tvFeed)\nlet familySafetyEnabled = readStoredBoolean(FAMILY_SAFETY_KEY)`)
  assert.match(findRendererBoundaryViolations(safeEntries).join('\n'), /不得把旧本地安全偏好/)
  safeEntries.set('src/renderer/src/main.ts', 'const safetyClient = new SafetyClient(window.tvFeed)')

  safeEntries.set('src/renderer/src/network-state.ts', 'const online = navigator.onLine')
  assert.match(findRendererBoundaryViolations(safeEntries).join('\n'), /不得把 navigator\.onLine 作为网络状态权威/)
  safeEntries.delete('src/renderer/src/network-state.ts')

  safeEntries.set('src/renderer/src/main.ts', `const safetyClient = new SafetyClient(window.tvFeed)\nwindow.addEventListener('online', retryPlayback)`)
  assert.match(findRendererBoundaryViolations(safeEntries).join('\n'), /必须经主进程重新确认/)
  safeEntries.set('src/renderer/src/main.ts', `const safetyClient = new SafetyClient(window.tvFeed)\nwindow.addEventListener('online', () => window.tvFeed.isNetworkOnline())`)
  assert.deepEqual(findRendererBoundaryViolations(safeEntries), [])

  safeEntries.set('src/renderer/src/direct.ts', 'fetch("https://example.com")')
  assert.match(findRendererBoundaryViolations(safeEntries).join('\n'), /不得直接使用 fetch/)

  safeEntries.delete('src/renderer/src/direct.ts')
  safeEntries.set('src/renderer/src/main.ts', `import './styles.css'\nconst safetyClient = new SafetyClient(window.tvFeed)`)
  assert.match(findRendererBoundaryViolations(safeEntries).join('\n'), /不得通过 TypeScript 注入界面样式/)

  safeEntries.set('src/renderer/src/main.ts', 'const safetyClient = new SafetyClient(window.tvFeed)')
  safeEntries.set('src/renderer/index.html', `<meta content="img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:;">`)
  assert.match(findRendererBoundaryViolations(safeEntries).join('\n'), /必须通过 HTML 外链加载/)
})

test('架构门禁固定共享契约、依赖方向、IPC、运行配置和主入口职责', () => {
  const architecture = [
    '<!-- architecture-record:v1 -->',
    '## 权威与投影',
    '## 阶段一：目录协调器',
    '## 阶段二：主进程家庭安全权威',
    '## 阶段三：目录缓存 V2',
    '## 阶段四：入口与边界拆分',
    '## 阶段五：架构守卫与政策生命周期',
    '## 验证契约'
  ].join('\n')
  const safeEntries = new Map([
    ['docs/ARCHITECTURE.md', architecture],
    ['src/main/index.ts', 'createMainWindow()'],
    ['src/main/runtime-config.ts', 'environment.TVFEED_SMOKE_OUTPUT'],
    ['src/main/catalog-service.ts', 'new CatalogCacheRepository(options)'],
    ['src/shared/ipc-contract.ts', `const channel = 'catalog:load'`],
    ['src/renderer/src/main.ts', 'const safetyClient = new SafetyClient(window.tvFeed)']
  ])
  assert.deepEqual(findArchitectureBoundaryViolations(safeEntries), [])

  const unsafeEntries = new Map(safeEntries)
  unsafeEntries.set('src/renderer/src/bypass.ts', `import x from '../../main/index.ts'\nconst channel = 'catalog:load'\nconst flag = process.env.TVFEED_SMOKE_LIVE`)
  unsafeEntries.set('src/main/index.ts', `import './smoke-driver.ts'\nipcMain.handle(channel, handler)\nprotocol.handle('tvfeed', handler)`)
  unsafeEntries.set('src/shared/contracts.ts', 'export {}')
  const violations = findArchitectureBoundaryViolations(unsafeEntries).join('\n')
  unsafeEntries.set('src/renderer/src/viewing-bypass.ts', `localStorage.setItem('tvfeed:favorites:v1', '[]')`)
  assert.match(findArchitectureBoundaryViolations(unsafeEntries).join('\n'), /观看数据键只能由 viewing-state.ts 管理/)
  unsafeEntries.set('src/renderer/src/playback-bypass.ts', `const channel = 'playback:start'`)
  assert.match(findArchitectureBoundaryViolations(unsafeEntries).join('\n'), /playback-bypass.*IPC 通道字面量/)
  assert.match(violations, /单体共享契约不得恢复/)
  assert.match(violations, /renderer 层不得依赖/)
  assert.match(violations, /IPC 通道字面量/)
  assert.match(violations, /冒烟环境变量/)
  assert.match(violations, /不得重新承担 IPC 注册职责/)
  assert.match(violations, /不得重新承担 协议处理职责/)
  assert.match(violations, /不得重新承担 静态冒烟驱动职责/)
})

test('基本密钥扫描识别常见凭据而不把普通配置误报为密钥', () => {
  assert.deepEqual(findSecretViolations(new Map([['safe.ts', 'const timeoutMs = 1000']])), [])
  const fakeToken = 'ghp_' + 'A'.repeat(30)
  assert.match(findSecretViolations(new Map([['unsafe.ts', `const value = '${fakeToken}'`]])).join('\n'), /GitHub token/)
})

test('依赖门禁解析动态、裸 Node、深层路径、重导出和副作用导入', () => {
  const cases = [
    ['src/renderer/src/probe.ts', "const load = () => import('node:fs/promises')"],
    ['src/renderer/src/probe.ts', "import { readFile } from 'fs/promises'"],
    ['src/renderer/src/nested/probe.ts', "import { CatalogCoordinator } from '../../../main/catalog-coordinator.ts'"],
    ['src/shared/probe.ts', "import '../main/secure-network.ts'"],
    ['src/shared/probe.ts', "export * from '../main/secure-network.ts'"],
    ['src/renderer/src/probe.ts', "const fs = require('node:fs')"],
    ['src/renderer/src/probe.ts', "type App = import('electron').App"],
    ['src/renderer/src/probe.ts', 'const name = "module"; import(name)'],
    ['src/renderer/src/probe.ts', "import { x } from '@main/hidden'"],
    ['src/renderer/src/probe.ts', "import '../../../scripts/smoke-driver.mjs'"],
    ['src/main/probe.ts', "import '../renderer/src/main.ts'"]
  ] as const
  for (const [file, code] of cases) {
    assert.ok(findArchitectureBoundaryViolations(new Map([[file, code]])).some(message => message.startsWith(file)), code)
  }
  const valid = new Map([
    ['src/renderer/src/probe.ts', "import type { Catalog } from '../../shared/catalog-contracts.ts'; const text = \"import('node:fs')\""],
    ['src/shared/catalog-contracts.ts', 'export type Catalog = {}']
  ])
  assert.ok(!findArchitectureBoundaryViolations(valid).some(message => message.startsWith('src/')))
  valid.set('src/shared/catalog-contracts.ts', "export * from './catalog.ts'")
  assert.ok(findArchitectureBoundaryViolations(valid).some(message => message.includes('间接执行目录安全投影')))
  const emittedExtensions = new Map([
    ['src/renderer/src/probe.ts', "import '../../shared/bridge.js'"],
    ['src/shared/bridge.ts', "export * from './catalog.js'"],
    ['src/shared/catalog.ts', 'export const transform = () => undefined']
  ])
  assert.ok(findArchitectureBoundaryViolations(emittedExtensions).some(message => message.includes('间接执行目录安全投影')))
})

test('CI 门禁要求最小权限、完整提交哈希和完整验证命令', () => {
  const safeWorkflow = `permissions:\n  contents: read\nsteps:\n  - uses: actions/checkout@${'a'.repeat(40)}\n  - run: npm ci --registry=https://registry.npmjs.org\n  - run: sudo chown root:root node_modules/electron/dist/chrome-sandbox\n  - run: sudo chmod 4755 node_modules/electron/dist/chrome-sandbox\n  - run: npm run verify:repository\n  - run: npm run verify:public-release:static\n  - run: npm run typecheck\n  - run: npm test\n  - run: npm run build:app\n  - run: xvfb-run --auto-servernum npm run smoke\n  - run: xvfb-run --auto-servernum npm run verify:single-instance\n  - run: sudo apt-get install --yes --no-install-recommends ffmpeg\n  - run: xvfb-run --auto-servernum npm run verify:hls:mpeg-ts\n  - run: xvfb-run --auto-servernum npm run verify:regressions\n  - runs-on: macos-15\n  - run: npx --no-install electron-builder --mac dir --arm64 --publish never\n  - env: { }\n    TVFEED_EXPECT_PACKAGED: '1'\n`
  assert.deepEqual(findWorkflowViolations(safeWorkflow), [])
  assert.match(findWorkflowViolations(safeWorkflow.replace('xvfb-run --auto-servernum npm run verify:regressions', '')).join('\n'), /verify:regressions/)
  assert.match(findWorkflowViolations(safeWorkflow.replace('xvfb-run --auto-servernum npm run verify:single-instance', '')).join('\n'), /verify:single-instance/)
  assert.match(findWorkflowViolations(safeWorkflow.replace('runs-on: macos-15', '')).join('\n'), /macos-15/)
  assert.match(findWorkflowViolations(safeWorkflow.replace(`@${'a'.repeat(40)}`, '@v6')).join('\n'), /完整提交哈希/)
})
