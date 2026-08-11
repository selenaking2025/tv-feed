import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTrackedSnapshot } from '../scripts/verify-repository-boundaries.mjs'
import { findPublicReleaseSnapshotViolations } from '../scripts/verify-public-release.mjs'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

test('当前仓库满足公开发布的许可证、声明、README 和第三方通知静态边界', () => {
  const snapshot = readTrackedSnapshot(projectRoot)
  assert.deepEqual(findPublicReleaseSnapshotViolations(snapshot), [])
})

test('公开发布门禁拒绝错误许可证、危险营销文字和未经批准的截图', () => {
  const snapshot = readTrackedSnapshot(projectRoot)
  const entries = new Map(snapshot.entries)
  const packageJson = JSON.parse(entries.get('package.json') ?? '{}') as Record<string, unknown>
  packageJson.license = 'UNLICENSED'
  entries.set('package.json', JSON.stringify(packageJson))
  entries.set('README.md', `${entries.get('README.md') ?? ''}\n9000 个免费电视台\n![节目画面](https://example.com/frame.png)`)

  const violations = findPublicReleaseSnapshotViolations({ files: snapshot.files, entries })
  assert.match(violations.join('\n'), /license 必须严格等于 MIT/)
  assert.match(violations.join('\n'), /不允许的免费、授权或绝对安全宣传/)
  assert.match(violations.join('\n'), /公开截图只能使用/)
})

test('公开发布门禁要求每个直接依赖都与第三方声明中的锁定版本一致', () => {
  const snapshot = readTrackedSnapshot(projectRoot)
  const entries = new Map(snapshot.entries)
  entries.set('THIRD_PARTY_NOTICES.md', (entries.get('THIRD_PARTY_NOTICES.md') ?? '').replace('| [hls.js]', '| [missing-hls.js]'))
  const violations = findPublicReleaseSnapshotViolations({ files: snapshot.files, entries })
  assert.match(violations.join('\n'), /hls\.js 必须记录锁定版本 1\.6\.17/)
})
