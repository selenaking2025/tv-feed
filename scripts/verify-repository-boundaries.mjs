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

    if (basename === 'catalog-v1.json') violations.push(`${file}: 不得提交频道目录缓存`)
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
    for (const rule of DIRECT_RENDERER_NETWORK_PATTERNS) {
      rule.pattern.lastIndex = 0
      if (rule.pattern.test(text)) violations.push(`${file}: 渲染进程不得直接使用 ${rule.name}`)
    }
  }

  for (const requiredFile of ['src/main/index.ts', 'src/renderer/index.html']) {
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
  if (!/let\s+remoteLogosEnabled\s*=\s*(?:!familySafetyEnabled\s*&&\s*)?readStoredBoolean\(REMOTE_LOGOS_KEY\)/.test(rendererMain)) {
    violations.push('src/renderer/src/main.ts: 远程台标必须从默认关闭的本地布尔偏好读取')
  }
  if (!/localStorage\.getItem\(key\)\s*===\s*['"]true['"]/.test(rendererMain)) {
    violations.push('src/renderer/src/main.ts: 远程台标偏好在缺失时必须返回 false')
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
    const body = readFileSync(resolve(root, file))
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
  process.stdout.write('仓库边界验证通过：依赖来源、内容文件、远程网络边界、CI 固定版本和基本密钥扫描均符合要求。\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli()
