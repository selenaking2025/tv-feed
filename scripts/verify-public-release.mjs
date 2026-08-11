import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTrackedSnapshot, verifyRepositorySnapshot } from './verify-repository-boundaries.mjs'

const REQUIRED_FILES = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'LEGAL.md',
  'PRIVACY.md',
  'SECURITY.md',
  'docs/PUBLIC_RELEASE.md',
  'third_party_licenses/Apache-2.0.txt',
  'third_party_licenses/Electron-LICENSE.txt',
  'third_party_licenses/hls.js-LICENSE.txt'
]

const FORBIDDEN_MARKETING_PATTERNS = [
  /9000\s*个免费电视台/i,
  /国内外(?:电视剧|电影).*免费(?:看|观看)/i,
  /电影电视剧免费看/i,
  /海量免费频道/i,
  /所有频道均公开合法/i,
  /绝无成人内容/i,
  /严格过滤成人频道/i,
  /精选影视资源/i,
  /我们提供的电视节目/i,
  /一键观看全球付费电视/i
]

const POLICY_MARKERS = {
  'LEGAL.md': ['项目定位', '与 iptv-org 的关系', '不绕过访问控制', '权利人移除流程', '项目 denylist'],
  'PRIVACY.md': ['iptv-org API', 'Logo 主机', '直播源站或其 CDN', '没有 TV Feed 账号系统', '远程台标默认关闭'],
  'SECURITY.md': ['支持的版本', '私下报告安全问题', 'Report a vulnerability', '响应目标', '不接受的功能和研究行为'],
  'docs/PUBLIC_RELEASE.md': ['GitHub 仓库描述', '建议的 Topics', 'GitHub Release 文案模板', '单独授权动作', 'Apple Developer ID']
}

export function findPublicReleaseSnapshotViolations({ files, entries }) {
  const violations = []
  const fileSet = new Set(files)
  for (const file of REQUIRED_FILES) {
    if (!fileSet.has(file)) violations.push(`${file}: 公开发布所需文件缺失`)
  }

  const packageJson = parsePackageJson(entries.get('package.json'), violations)
  const readme = entries.get('README.md') ?? ''
  const license = entries.get('LICENSE') ?? ''
  const notices = entries.get('THIRD_PARTY_NOTICES.md') ?? ''
  const legal = entries.get('LEGAL.md') ?? ''
  const privacy = entries.get('PRIVACY.md') ?? ''
  const security = entries.get('SECURITY.md') ?? ''
  const publicChecklist = entries.get('docs/PUBLIC_RELEASE.md') ?? ''

  if (packageJson) {
    if (packageJson.license !== 'MIT') violations.push('package.json: license 必须严格等于 MIT')
    if (packageJson.private !== true) violations.push('package.json: private 必须保持 true，防止误发布到 npm')
    const packageCopy = `${packageJson.description ?? ''}\n${readme}`
    violations.push(...findMarketingViolations(packageCopy, 'README.md/package.json'))
    violations.push(...findThirdPartyNoticeViolations(packageJson, notices))
    violations.push(...findPackagedNoticeViolations(packageJson))
  }

  if (!license.startsWith('MIT License') || !license.includes('Permission is hereby granted, free of charge') || !license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) {
    violations.push('LICENSE: 根目录必须保留标准 MIT License 文本，供 GitHub 识别')
  }

  const screenshots = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => normalizeMarkdownTarget(match[1] ?? ''))
  if (screenshots.length === 0) violations.push('README.md: 必须包含经过批准的离线样例截图')
  for (const target of screenshots) {
    if (target !== 'docs/assets/tv-feed-offline-sample.png') {
      violations.push(`README.md: 公开截图只能使用 docs/assets/tv-feed-offline-sample.png，当前为 ${target || '<空>'}`)
    }
  }
  if (!readme.includes('内置虚构样例频道') || !readme.includes('不显示实际节目画面')) {
    violations.push('README.md: 截图必须明确说明使用虚构离线样例且不显示实际节目画面')
  }
  if (!readme.includes('远程频道 Logo 默认关闭')) violations.push('README.md: 必须明确远程频道 Logo 默认关闭')
  if (!/上游误标[\s\S]{0,100}仍可能造成遗漏/.test(readme) || !/不(?:是|构成|将).*儿童绝对安全/.test(`${readme}\n${legal}\n${privacy}`)) {
    violations.push('README.md/法律文件: 成人过滤必须说明上游遗漏风险，且不能承诺儿童绝对安全')
  }
  if (!/(?:不设置[\s\S]{0,80}官方源|普通[\s\S]{0,80}不[\s\S]{0,40}官方源|只有[\s\S]{0,80}人工[\s\S]{0,80}官方源)/.test(readme)) {
    violations.push('README.md: 必须说明普通 iptv-org 条目不会被标记为精选或官方源')
  }
  if (/^#{1,6}\s*精选(?:频道|影视)|^\s*[-*]\s*精选频道/gm.test(readme)) {
    violations.push('README.md: 不得把普通目录条目作为精选频道宣传')
  }
  if (!/ad-hoc/.test(readme) || !/没有使用 Apple Developer ID/.test(readme)) {
    violations.push('README.md: macOS 开发包必须如实说明仅为 ad-hoc，未使用 Apple Developer ID')
  }

  for (const [file, markers] of Object.entries(POLICY_MARKERS)) {
    const text = entries.get(file) ?? ''
    for (const marker of markers) {
      if (!text.includes(marker)) violations.push(`${file}: 缺少公开发布必需说明“${marker}”`)
    }
  }

  if (!notices.includes('Dailymotion') || !notices.includes('Brightcove') || !notices.includes('Apache-2.0')) {
    violations.push('THIRD_PARTY_NOTICES.md: hls.js 的 Apache-2.0、Dailymotion 与 Brightcove 声明不完整')
  }
  const hlsLicense = entries.get('third_party_licenses/hls.js-LICENSE.txt') ?? ''
  if (!hlsLicense.includes('Dailymotion') || !hlsLicense.includes('Brightcove') || !hlsLicense.includes('Apache License, Version 2.0')) {
    violations.push('third_party_licenses/hls.js-LICENSE.txt: hls.js 原始版权与许可证声明不完整')
  }
  const apacheLicense = entries.get('third_party_licenses/Apache-2.0.txt') ?? ''
  if (!apacheLicense.includes('Apache License') || !apacheLicense.includes('Version 2.0, January 2004')) {
    violations.push('third_party_licenses/Apache-2.0.txt: 缺少完整 Apache-2.0 许可证文本')
  }
  const electronLicense = entries.get('third_party_licenses/Electron-LICENSE.txt') ?? ''
  if (!electronLicense.includes('Electron contributors') || !electronLicense.includes('Permission is hereby granted')) {
    violations.push('third_party_licenses/Electron-LICENSE.txt: Electron MIT 声明不完整')
  }

  violations.push(...findMarketingViolations(`${legal}\n${privacy}\n${security}\n${publicChecklist}`, '公开政策文件'))
  return violations
}

export function findGitReleaseStateViolations(root) {
  const violations = []
  try {
    const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (status.trim()) violations.push('Git: 工作区必须完全干净，不能有未提交或未跟踪文件')

    const branch = git(root, ['branch', '--show-current']).trim()
    if (branch !== 'main') violations.push(`Git: 公开发布审计必须在 main，当前为 ${branch || '<detached>'}`)

    const head = git(root, ['rev-parse', 'HEAD']).trim()
    const tracking = git(root, ['rev-parse', 'origin/main']).trim()
    if (head !== tracking) violations.push('Git: 本地 HEAD 与 origin/main 跟踪引用不一致')

    const remoteMain = gitRemote(root, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).trim().split(/\s+/)[0] ?? ''
    if (!remoteMain || head !== remoteMain) violations.push('Git: 远端 main 与本地审计提交不一致')

    const remoteHead = gitRemote(root, ['ls-remote', '--symref', 'origin', 'HEAD'])
    if (!/^ref:\s+refs\/heads\/main\s+HEAD$/m.test(remoteHead)) violations.push('GitHub: 远端默认分支必须是 main')
  } catch (error) {
    violations.push(`Git: 无法完成远端一致性检查（${error instanceof Error ? error.message : String(error)}）`)
  }
  return violations
}

function parsePackageJson(text, violations) {
  if (!text) {
    violations.push('package.json: 文件缺失')
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    violations.push('package.json: 不是有效 JSON')
    return undefined
  }
}

function findMarketingViolations(text, label) {
  const violations = []
  for (const pattern of FORBIDDEN_MARKETING_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) violations.push(`${label}: 包含不允许的免费、授权或绝对安全宣传“${pattern.source}”`)
  }
  return violations
}

function findThirdPartyNoticeViolations(packageJson, notices) {
  const violations = []
  const documented = new Map()
  for (const line of notices.split(/\r?\n/)) {
    const match = line.match(/^\|\s*\[([^\]]+)]\([^)]+\)\s*\|\s*([^|]+?)\s*\|/)
    if (match?.[1] && match[2]) documented.set(match[1].trim().toLocaleLowerCase(), match[2].trim())
  }
  const directPackages = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) }
  for (const [name, version] of Object.entries(directPackages)) {
    if (documented.get(name.toLocaleLowerCase()) !== version) {
      violations.push(`THIRD_PARTY_NOTICES.md: ${name} 必须记录锁定版本 ${String(version)}`)
    }
  }
  return violations
}

function findPackagedNoticeViolations(packageJson) {
  const violations = []
  const resources = Array.isArray(packageJson.build?.extraResources) ? packageJson.build.extraResources : []
  const destinations = new Set(resources.map((entry) => entry?.to).filter((value) => typeof value === 'string'))
  for (const destination of [
    'legal/LICENSE',
    'legal/THIRD_PARTY_NOTICES.md',
    'legal/third_party_licenses',
    'legal/ELECTRON-THIRD-PARTY-NOTICES.html'
  ]) {
    if (!destinations.has(destination)) violations.push(`package.json: 打包产物缺少第三方声明目标 ${destination}`)
  }
  return violations
}

function normalizeMarkdownTarget(value) {
  return value.trim().split(/\s+/)[0]?.replace(/^<|>$/g, '') ?? ''
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function gitRemote(root, args) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return git(root, args)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function runRuntimeChecks(root) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const environment = { ...process.env, TVFEED_OFFLINE_DEMO: '1' }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('TVFEED_SMOKE_') || key === 'TVFEED_ELECTRON_PATH' || key === 'TVFEED_EXPECT_PACKAGED') delete environment[key]
  }
  const commands = [
    ['run', 'verify:repository'],
    ['run', 'typecheck'],
    ['test'],
    ['run', 'build'],
    ['run', 'smoke']
  ]
  for (const args of commands) {
    const result = spawnSync(npm, args, { cwd: root, env: environment, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${npm} ${args.join(' ')} 失败（退出码 ${result.status ?? '未知'}）`)
  }
}

function printViolations(title, violations) {
  process.stderr.write(`${title}（${violations.length} 项）：\n${violations.map((item) => `- ${item}`).join('\n')}\n`)
}

function runCli() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const args = process.argv.slice(2)
  const snapshotOnly = args.length === 1 && args[0] === '--snapshot-only'
  if (args.length > 0 && !snapshotOnly) {
    process.stderr.write('用法：node scripts/verify-public-release.mjs [--snapshot-only]\n')
    process.exitCode = 1
    return
  }

  const snapshot = readTrackedSnapshot(root)
  const snapshotViolations = [
    ...verifyRepositorySnapshot(snapshot),
    ...findPublicReleaseSnapshotViolations(snapshot)
  ]
  if (snapshotViolations.length > 0) {
    printViolations('公开发布静态门禁失败', snapshotViolations)
    process.exitCode = 1
    return
  }
  if (snapshotOnly) {
    process.stdout.write('公开发布静态门禁通过：许可证、法律与隐私文件、第三方声明、README 表述和仓库内容边界均符合要求。\n')
    return
  }

  const gitViolations = findGitReleaseStateViolations(root)
  if (gitViolations.length > 0) {
    printViolations('公开发布 Git 门禁失败', gitViolations)
    process.exitCode = 1
    return
  }

  try {
    runRuntimeChecks(root)
  } catch (error) {
    process.stderr.write(`公开发布运行门禁失败：${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }

  const finalViolations = [
    ...verifyRepositorySnapshot(readTrackedSnapshot(root)),
    ...findPublicReleaseSnapshotViolations(readTrackedSnapshot(root)),
    ...findGitReleaseStateViolations(root)
  ]
  if (finalViolations.length > 0) {
    printViolations('公开发布最终回读失败', finalViolations)
    process.exitCode = 1
    return
  }

  process.stdout.write('公开发布自动门禁全部通过：本地审计版本与远端 main 一致，类型检查、测试、构建和 Electron 离线 smoke 均成功。仓库可见性、GitHub 元数据、Developer ID 签名、公证与 Release 发布仍是独立人工动作。\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli()
