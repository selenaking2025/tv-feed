import {
  parseSourceHealthStore,
  recordSourceFailure,
  recordSourceSuccess,
  serializeSourceHealthStore,
  type SourceHealthRecords
} from '../../shared/source-health.ts'

const KEYS = {
  favorites: 'tvfeed:favorites:v1',
  recents: 'tvfeed:recents:v1',
  lastChannel: 'tvfeed:last-channel:v1',
  health: 'tvfeed:source-health:v1'
} as const

type ViewingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
interface ViewingData {
  favorites: Set<string>
  recents: string[]
  lastChannel: string
  health: SourceHealthRecords
}

/** User-owned records outlive catalog projections. Demo records never reach storage. */
export class ViewingState {
  private readonly storage: ViewingStorage
  private readonly real: ViewingData
  private demo: ViewingData = emptyViewingData()
  private demoMode = false

  constructor(storage: ViewingStorage = localStorage) {
    this.storage = storage
    this.real = {
      favorites: new Set(this.readArray(KEYS.favorites)),
      recents: this.readArray(KEYS.recents).slice(0, 100),
      lastChannel: this.read(KEYS.lastChannel) ?? '',
      health: parseSourceHealthStore(this.read(KEYS.health))
    }
  }

  get favorites(): ReadonlySet<string> { return this.active.favorites }
  get recents(): readonly string[] { return this.active.recents }
  get lastChannel(): string { return this.active.lastChannel }
  get health(): SourceHealthRecords { return this.active.health }
  private get active(): ViewingData { return this.demoMode ? this.demo : this.real }

  useCatalog(source: 'iptv-org' | 'offline-sample'): boolean {
    const changed = this.demoMode !== (source === 'offline-sample')
    this.demoMode = source === 'offline-sample'
    return changed
  }

  select(channelId: string): void {
    this.active.lastChannel = channelId
    if (!this.demoMode) this.write(KEYS.lastChannel, channelId)
  }

  remember(channelId: string): void {
    this.active.recents = [channelId, ...this.active.recents.filter((id) => id !== channelId)].slice(0, 100)
    if (!this.demoMode) this.write(KEYS.recents, JSON.stringify(this.active.recents))
  }

  toggleFavorite(channelId: string): boolean {
    if (this.active.favorites.has(channelId)) this.active.favorites.delete(channelId)
    else this.active.favorites.add(channelId)
    if (!this.demoMode) this.write(KEYS.favorites, JSON.stringify([...this.active.favorites]))
    return this.active.favorites.has(channelId)
  }

  recordSuccess(sourceId: string, input: { startupMs: number; stallRatio: number }): void {
    this.active.health = recordSourceSuccess(this.active.health, sourceId, input)
    this.persistHealth()
  }

  recordFailure(sourceId: string): void {
    this.active.health = recordSourceFailure(this.active.health, sourceId)
    this.persistHealth()
  }

  clearWatching(): boolean {
    for (const data of [this.real, this.demo]) {
      data.recents = []
      data.lastChannel = ''
      data.health = new Map()
    }
    return this.remove([KEYS.recents, KEYS.lastChannel, KEYS.health])
  }

  clearAll(): boolean {
    this.real.favorites.clear()
    this.demo.favorites.clear()
    const watchingCleared = this.clearWatching()
    return this.remove([KEYS.favorites]) && watchingCleared
  }

  private persistHealth(): void {
    if (!this.demoMode) this.write(KEYS.health, serializeSourceHealthStore(this.active.health))
  }

  private read(key: string): string | null {
    try { return this.storage.getItem(key) } catch { return null }
  }

  private readArray(key: string): string[] {
    try {
      const value: unknown = JSON.parse(this.read(key) ?? '[]')
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    } catch { return [] }
  }

  private write(key: string, value: string): void {
    try { this.storage.setItem(key, value) } catch { /* Optional ranking must not stop playback. */ }
  }

  private remove(keys: string[]): boolean {
    let cleared = true
    for (const key of keys) {
      try {
        this.storage.removeItem(key)
        if (this.storage.getItem(key) !== null) cleared = false
      } catch { cleared = false }
    }
    return cleared
  }
}

function emptyViewingData(): ViewingData {
  return { favorites: new Set(), recents: [], lastChannel: '', health: new Map() }
}
