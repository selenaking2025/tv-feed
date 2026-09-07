import type { Catalog, CatalogLoadCommand, CatalogSyncProgress } from '../../shared/catalog-contracts.ts'

/** Only the latest user intent may publish a result, error, progress or completion. */
export class CatalogRequests {
  private generation = 0
  private readonly prefix = crypto.randomUUID()
  private channelsById = new Map<string, Catalog['channels'][number]>()

  begin(): number {
    return ++this.generation
  }

  isCurrent(generation: number): boolean { return generation === this.generation }

  command(intent: CatalogLoadCommand['intent'], generation: number): CatalogLoadCommand {
    return { intent, requestId: `${this.prefix}:${generation}` }
  }

  index(catalog: Catalog): void {
    this.channelsById = new Map(catalog.channels.map((channel) => [channel.id, channel]))
  }

  clear(): void { this.channelsById.clear() }
  channel(id: string): Catalog['channels'][number] | undefined { return this.channelsById.get(id) }

  acceptsProgress(progress: CatalogSyncProgress): boolean {
    return progress.requestId === `${this.prefix}:${this.generation}`
  }
}
