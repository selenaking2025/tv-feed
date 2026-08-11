import { randomBytes } from 'node:crypto'

interface TicketEntry<T> {
  value: T
  expiresAt: number
}

export interface IssuedTicket {
  token: string
  expiresAt: number
}

export class OneTimeTicketRegistry<T> {
  private readonly entries = new Map<string, TicketEntry<T>>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly tokenFactory: () => string

  constructor(
    ttlMs: number,
    maxEntries: number,
    tokenFactory: () => string = secureTicketToken
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('一次性票据有效期无效')
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error('一次性票据容量无效')
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.tokenFactory = tokenFactory
  }

  issue(value: T, now = Date.now()): IssuedTicket {
    this.sweep(now)
    if (this.entries.size >= this.maxEntries) throw new Error('安全媒体流票据已达到容量上限')
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = this.tokenFactory()
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('一次性票据生成器返回了无效令牌')
      if (this.entries.has(token)) continue
      const expiresAt = now + this.ttlMs
      this.entries.set(token, { value, expiresAt })
      return { token, expiresAt }
    }
    throw new Error('无法生成唯一的安全媒体流票据')
  }

  consume(token: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(token)
    if (!entry) return undefined
    // Keep an expired entry until sweep() can return its value to the owner for
    // cancellation and accounting cleanup.
    if (entry.expiresAt <= now) return undefined
    this.entries.delete(token)
    return entry.value
  }

  revoke(token: string): T | undefined {
    const entry = this.entries.get(token)
    if (!entry) return undefined
    this.entries.delete(token)
    return entry.value
  }

  sweep(now = Date.now()): T[] {
    const expired: T[] = []
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        expired.push(entry.value)
        this.entries.delete(token)
      }
    }
    return expired
  }

  removeWhere(predicate: (value: T) => boolean): T[] {
    const removed: T[] = []
    for (const [token, entry] of this.entries) {
      if (predicate(entry.value)) {
        removed.push(entry.value)
        this.entries.delete(token)
      }
    }
    return removed
  }

  clear(): T[] {
    const values = [...this.entries.values()].map((entry) => entry.value)
    this.entries.clear()
    return values
  }

  get size(): number {
    return this.entries.size
  }
}

function secureTicketToken(): string {
  return randomBytes(32).toString('base64url')
}
