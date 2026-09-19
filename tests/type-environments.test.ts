import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('真实 renderer/shared 类型环境拒绝误用 Node 全局变量', async () => {
  const root = resolve(import.meta.dirname, '..')
  const directory = await mkdtemp(join(tmpdir(), 'tv-feed-type-boundaries-'))
  try {
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
    const probe = join(directory, 'probe.ts')
    await writeFile(probe, 'export const platform = process.platform; export const buffer = Buffer.from("test")')
    for (const layer of ['renderer', 'shared']) {
      const config = join(directory, `${layer}.json`)
      await writeFile(config, JSON.stringify({
        extends: join(root, `tsconfig.${layer}.json`),
        include: [join(root, `src/${layer}/**/*.ts`), probe]
      }))
      assert.throws(() => execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', config], {
        cwd: root, stdio: 'pipe'
      }), (error: unknown) => {
        const output = (error as { stdout?: Buffer }).stdout?.toString() ?? ''
        return !output.includes('TS2688') && output.includes('process') && output.includes('Buffer') && output.includes('probe.ts')
      })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
