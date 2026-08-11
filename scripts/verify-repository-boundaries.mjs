import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FORBIDDEN_EXTENSIONS = new Set([
  '.dmg',
  '.key',
  '.m3u',
  '.m3u8',
  '.p12',
  '.pem',
  '.zip'
])

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.icns',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp'
])

const ALLOWED_OWNED_IMAGES = new Set([
  'build/icon.icns',
  'build/icon.png',
  'build/icon.svg',
  'docs/assets/tv-feed-offline-sample.png'
])

const SECRET_PATTERNS = [
  { name: 'GitHub token', pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'OpenAI-style key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g }
]

const DIRECT_RENDERER_NETWORK_PATTERNS = [
  { name: 'fetch()', pattern: /\bfetch\s*\(/g },
  { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/g },
  { name: 'WebSocket', pattern: /\bWebSocket\s*\(/g },
  { name: 'EventSource', pattern: /\bEventSource\s*\(/g },
  { name: 'sendBeacon()', pattern: /\bnavigator\.sendBeacon\s*\(/g }
]

export function findForbiddenPathViolations(files) {
  const violations = []
  for (const rawFile of files) {
    const file = normalizePath(rawFile)
    const segments = file.split('/')
    const basename = segments.at(-1)?.toLocaleLowerCase() ?? ''
    const extension = extname(basename)

    if (basename === 'catalog-v1.json' || basename === 'catalog-v2.json') violations.push(`${file}: 不得提交频道目录缓存`)
    if (segments.includes('out') || segments.includes('release') || segments.some((segment) => segment.endsWith('.app'))) {
      violations.push(`${file}: 不得提交构建或安装产物`)
    }
    if (FORBIDDEN_EXTENSIONS.has(extension)) violations.push(`${file}: 不得提交 ${extension} 文件`)
    if (IMAGE_EXTENSIONS.has(extension) && !ALLOWED_OWNED_IMAGES.has(file)) {
      violations.push(`${file}: 图片不在 TV Feed 自有素材允许列表中`)
    }
    if (basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example')) {
      violations.push(`${file}: 不得提交本地环境变量文件`)
    }
  }
  return violations
}

export function findLockfileRegistryViolations(lockfileText) {
  let lockfile
  try {
    lockfile = JSON.parse(lockfileText)
  } catch {
    return ['package-lock.json: 不是有效 JSON']
  }

  const violations = []
  for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
    if (!metadata || typeof metadata !== 'object' || typeof metadata.resolved !== 'string') continue
    let resolved
    try {
      resolved = new URL(metadata.resolved)
    } catch {
      violations.push(`package-lock.json:${packagePath || '<root>'}: resolved 不是有效 URL`)
      continue
    }
    if (resolved.protocol !== 'https:' || resolved.hostname !== 'registry.npmjs.org') {
      violations.push(`package-lock.json:${packagePath || '<root>'}: 依赖不来自官方 npm registry`)
    }
  }
  return violations
}

export function findRendererBoundaryViolations(entries) {
  const violations = []
  for (const [rawFile, text] of entries) {
    const file = normalizePath(rawFile)
    if (!file.startsWith('src/renderer/')) continue
    const networkScanText = file === 'src/renderer/src/secure-hls-loader.ts'
      ? text.replace(/\bwindow\.fetch\s*\(\s*streamUrl\s*,/g, 'readApprovedInternalStream(')
      : text
    for (const rule of DIRECT_RENDERER_NETWORK_PATTERNS) {
      rule.pattern.lastIndex = 0
      if (rule.pattern.test(networkScanText)) violations.push(`${file}: 渲染进程不得直接使用 ${rule.name}`)
    }
  }

  for (const requiredFile of ['src/main/app-protocol.ts', 'src/renderer/index.html']) {
    const source = entries.get(requiredFile)
    if (source === undefined) {
      violations.push(`${requiredFile}: 缺少 CSP 校验目标`)
      continue
    }
    for (const directive of ['img-src', 'media-src', 'connect-src']) {
      const match = source.match(new RegExp(`\\b${directive}\\s+([^;"<\\n]+)`))
      if (!match?.[1]) {
        violations.push(`${requiredFile}: CSP 缺少 ${directive}`)
      } else if (/(?:https?:|\*)/.test(match[1])) {
        violations.push(`${requiredFile}: CSP 的 ${directive} 不得允许任意远程网络`)
      }
    }
  }

  const rendererHtml = entries.get('src/renderer/index.html') ?? ''
  for (const stylesheet of ['/src/phosphor-icons.css', '/src/styles.css']) {
    if (!rendererHtml.includes(`<link rel="stylesheet" href="${stylesheet}" />`)) {
      violations.push(`src/renderer/index.html: 严格 CSP 下必须通过 HTML 外链加载 ${stylesheet}`)
    }
  }

  const rendererMain = entries.get('src/renderer/src/main.ts') ?? ''
  if (/import\s+['"]\.\/(?:phosphor-icons|styles)\.css['"]/.test(rendererMain)) {
    violations.push('src/renderer/src/main.ts: 严格 CSP 的开发模式不得通过 TypeScript 注入界面样式')
  }
  if (!/new\s+SafetyClient\(window\.tvFeed\)/.test(rendererMain)) {
    violations.push('src/renderer/src/main.ts: 家庭安全必须通过 SafetyClient 初始化主进程权威状态')
  }
  if (/tvfeed:(?:family-safety|remote-logos):v1/.test(rendererMain) || /readStoredBoolean\s*\(/.test(rendererMain)) {
    violations.push('src/renderer/src/main.ts: 不得把旧本地安全偏好重新作为渲染入口权威')
  }
  const safetyClient = entries.get('src/renderer/src/safety-client.ts') ?? ''
  if (!/initializeSafetyState\s*\(/.test(safetyClient) || !/state\.familySafety/.test(safetyClient) || !/state\.remoteLogos/.test(safetyClient)) {
    violations.push('src/renderer/src/safety-client.ts: 缺少主进程安全初始化或兼容投影')
  }
  return violations
}

export function findArchitectureBoundaryViolations(entries) {
  const violations = []
  const architecture = entries.get('docs/ARCHITECTURE.md') ?? ''
  for (const marker of [
    '<!-- architecture-record:v1 -->',
    '## 权威与投影',
    '## 阶段一：目录协调器',
    '## 阶段二：主进程家庭安全权威',
    '## 阶段三：目录缓存 V2',
    '## 阶段四：入口与边界拆分',
    '## 阶段五：架构守卫与政策生命周期',
    '## 验证契约'
  ]) {
    if (!architecture.includes(marker)) violations.push(`docs/ARCHITECTURE.md: 缺少架构记录标记 ${marker}`)
  }

  if (entries.has('src/shared/contracts.ts')) {
    violations.push('src/shared/contracts.ts: 已拆分的单体共享契约不得恢复')
  }
  if (entries.has('src/main/smoke-driver.ts')) {
    violations.push('src/main/smoke-driver.ts: 完整冒烟驱动不得进入生产源码')
  }

  const ipcLiteral = /['"](?:catalog|safety|remote-resource|app|player-fullscreen|renderer):[A-Za-z0-9:-]+['"]/g
  for (const [rawFile, text] of entries) {
    const file = normalizePath(rawFile)
    if (!file.startsWith('src/')) continue

    if (file !== 'src/main/runtime-config.ts' &&
      /(?:process\.env|environment)(?:\.TVFEED_SMOKE_[A-Z0-9_]+|\[['"]TVFEED_SMOKE_[A-Z0-9_]+['"]\])/.test(text)) {
      violations.push(`${file}: 冒烟环境变量只能由 runtime-config.ts 读取`)
    }
    if (file !== 'src/shared/ipc-contract.ts') {
      ipcLiteral.lastIndex = 0
      if (ipcLiteral.test(text)) violations.push(`${file}: IPC 通道字面量只能在 ipc-contract.ts 声明`)
    }
    if (file.startsWith('src/shared/') && /from\s+['"](?:node:|electron|\.\.\/main\/)/.test(text)) {
      violations.push(`${file}: shared 层不得依赖 Electron、Node 或 main 层`)
    }
    if (file.startsWith('src/renderer/') && /from\s+['"](?:node:|electron|\.\.\/\.\.\/main\/)/.test(text)) {
      violations.push(`${file}: renderer 层不得依赖 Electron、Node 或 main 层`)
    }
    if (file.startsWith('src/renderer/') && /from\s+['"][^'"]*catalog\.ts['"]/.test(text)) {
      violations.push(`${file}: renderer 不得直接执行目录安全投影`)
    }
    if (file !== 'src/main/catalog-service.ts' && /new\s+CatalogCacheRepository\s*\(/.test(text)) {
      violations.push(`${file}: 目录缓存仓库只能由 catalog-service.ts 组装`)
    }
  }

  const mainIndex = entries.get('src/main/index.ts') ?? ''
  if (mainIndex.split(/\r?\n/).length > 220) violations.push('src/main/index.ts: 主入口超过 220 行职责预算')
  for (const forbidden of [
    { label: 'IPC 注册', pattern: /\bipcMain\.(?:handle|on)\s*\(/ },
    { label: '协议处理', pattern: /\bprotocol\.handle\s*\(/ },
    { label: '远程请求表', pattern: /new\s+Map<[^>]*ActiveRemoteFetch/ },
    { label: '静态冒烟驱动', pattern: /(?:from\s+)?['"][^'"]*smoke-driver/ }
  ]) {
    if (forbidden.pattern.test(mainIndex)) violations.push(`src/main/index.ts: 不得重新承担 ${forbidden.label}职责`)
  }

  return violations
}

export function findSecretViolations(entries) {
  const violations = []
  for (const [rawFile, text] of entries) {
    const file = normalizePath(rawFile)
    for (const rule of SECRET_PATTERNS) {
      rule.pattern.lastIndex = 0
      if (rule.pattern.test(text)) violations.push(`${file}: 发现疑似 ${rule.name}`)
    }
  }
  return violations
}

export function findWorkflowViolations(workflowText) {
  const violations = []
  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(workflowText)) {
    violations.push('.github/workflows/ci.yml: 必须把默认权限限制为 contents: read')
  }
  for (const match of workflowText.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    const uses = match[1] ?? ''
    if (uses.startsWith('./')) continue
    const separator = uses.lastIndexOf('@')
    const reference = separator >= 0 ? uses.slice(separator + 1) : ''
    if (!/^[a-f0-9]{40}$/.test(reference)) {
      violations.push(`.github/workflows/ci.yml: ${uses} 必须固定到完整提交哈希`)
    }
  }
  for (const requiredCommand of [
    'npm ci --registry=https://registry.npmjs.org',
    'npm run verify:repository',
    'npm run verify:public-release:static',
    'npm run typecheck',
    'npm test',
    'npm run build'
  ]) {
    if (!workflowText.includes(requiredCommand)) {
      violations.push(`.github/workflows/ci.yml: 缺少 ${requiredCommand}`)
    }
  }
  return violations
}

export function verifyRepositorySnapshot({ files, entries }) {
  const violations = [
    ...findForbiddenPathViolations(files),
    ...findRendererBoundaryViolations(entries),
    ...findArchitectureBoundaryViolations(entries),
    ...findSecretViolations(entries)
  ]
  const lockfile = entries.get('package-lock.json')
  violations.push(...(lockfile === undefined
    ? ['package-lock.json: 缺少锁文件']
    : findLockfileRegistryViolations(lockfile)))
  const workflow = entries.get('.github/workflows/ci.yml')
  violations.push(...(workflow === undefined
    ? ['.github/workflows/ci.yml: 缺少 CI 工作流']
    : findWorkflowViolations(workflow)))
  return violations
}

export function readTrackedSnapshot(root) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })
  const files = output.toString('utf8').split('\0').filter(Boolean).map(normalizePath)
  const entries = new Map()
  for (const file of files) {
    let body
    try {
      body = readFileSync(resolve(root, file))
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue
      throw error
    }
    if (!looksBinary(body)) entries.set(file, body.toString('utf8'))
  }
  return { files, entries }
}

function looksBinary(body) {
  const sampleLength = Math.min(body.byteLength, 8_192)
  for (let index = 0; index < sampleLength; index += 1) {
    if (body[index] === 0) return true
  }
  return false
}

function normalizePath(value) {
  return value.replaceAll('\\', '/')
}

function runCli() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const violations = verifyRepositorySnapshot(readTrackedSnapshot(root))
  if (violations.length > 0) {
    process.stderr.write(`仓库边界验证失败（${violations.length} 项）：\n${violations.map((item) => `- ${item}`).join('\n')}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write('仓库边界验证通过：架构权威、依赖方向、IPC、运行配置、远程网络、内容文件、CI 固定版本和基本密钥扫描均符合要求。\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli()
