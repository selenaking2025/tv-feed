import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SafetyStateSnapshot } from '../shared/safety-contracts.ts'

const MAX_SAFETY_STATE_BYTES = 8 * 1_024

export interface SafetyStateStorePort {
  read(): Promise<SafetyStateSnapshot | undefined>
  /** A failure after replacement must use SafetyStateCommitUncertainError. */
  write(state: SafetyStateSnapshot): Promise<SafetyStateSnapshot>
}

export class SafetyStateCommitUncertainError extends Error {
  constructor(cause: unknown) {
    super('家庭安全状态已替换，但尚未完成确认', { cause })
    this.name = 'SafetyStateCommitUncertainError'
  }
}

export class FileSafetyStateStore implements SafetyStateStorePort {
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  read(): Promise<SafetyStateSnapshot | undefined> {
    return readSafetyStateFile(this.path)
  }

  write(state: SafetyStateSnapshot): Promise<SafetyStateSnapshot> {
    return writeSafetyStateAtomicAndVerify(this.path, state)
  }
}

export async function readSafetyStateFile(path: string): Promise<SafetyStateSnapshot | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const before = await handle.stat()
    if (!before.isFile() || before.size <= 0 || before.size > MAX_SAFETY_STATE_BYTES) {
      throw new Error('家庭安全状态文件大小或类型无效')
    }
    const body = new Uint8Array(before.size)
    let offset = 0
    while (offset < body.byteLength) {
      const { bytesRead } = await handle.read(body, offset, body.byteLength - offset, offset)
      if (bytesRead === 0) throw new Error('家庭安全状态文件读取不完整')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('家庭安全状态文件在读取期间发生变化')
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    if (!isSafetyStateSnapshot(value)) throw new Error('家庭安全状态文件格式无效')
    return value
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export async function writeSafetyStateAtomicAndVerify(
  path: string,
  state: SafetyStateSnapshot
): Promise<SafetyStateSnapshot> {
  if (!isSafetyStateSnapshot(state)) throw new Error('家庭安全状态无效')
  const serialized = JSON.stringify(state)
  if (new TextEncoder().encode(serialized).byteLength > MAX_SAFETY_STATE_BYTES) {
    throw new Error('家庭安全状态超过大小上限')
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(serialized, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    const staged = await readSafetyStateFile(temporary)
    assertEquivalentState(state, staged, '临时家庭安全状态')
    await rename(temporary, path)
    try {
      const persisted = await readSafetyStateFile(path)
      assertEquivalentState(state, persisted, '正式家庭安全状态')
      return persisted
    } catch (error) {
      throw new SafetyStateCommitUncertainError(error)
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

export function isSafetyStateSnapshot(value: unknown): value is SafetyStateSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<SafetyStateSnapshot>
  return candidate.schemaVersion === 1 &&
    Number.isSafeInteger(candidate.revision) && Number(candidate.revision) >= 1 &&
    typeof candidate.familySafety === 'boolean' &&
    typeof candidate.remoteLogos === 'boolean' &&
    !(candidate.familySafety && candidate.remoteLogos) &&
    typeof candidate.transitionId === 'string' &&
    /^[A-Za-z0-9:_-]{1,128}$/.test(candidate.transitionId) &&
    typeof candidate.pendingCatalogInvalidation === 'boolean' &&
    typeof candidate.pendingViewingDataClear === 'boolean'
}

function assertEquivalentState(
  expected: SafetyStateSnapshot,
  actual: SafetyStateSnapshot | undefined,
  label: string
): asserts actual is SafetyStateSnapshot {
  if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}复读不一致`)
  }
}
