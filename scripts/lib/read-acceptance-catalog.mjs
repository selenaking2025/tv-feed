import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CATALOG_LIMITS } from '../../src/shared/catalog-limits.ts'
import { normalizeRemoteHlsUrl } from '../../src/shared/remote-url-policy.ts'

export async function readAcceptanceCatalog(path) {
  const resolved = resolve(path)
  const info = await stat(resolved)
  if (!info.isFile() || info.size <= 0 || info.size > 64 * 1_024 * 1_024) {
    throw new Error('目录缓存不存在或超过 64 MiB 验收上限')
  }
  let raw
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(resolved)))
  } catch {
    throw new Error('目录缓存不是有效的 UTF-8 JSON')
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.channels) || raw.channels.length > CATALOG_LIMITS.maxCatalogChannels) {
    throw new Error('目录缓存频道结构超过验收边界')
  }

  // Old caches can contain logo or website metadata rejected by today's URL
  // policy. The acceptance reader does not trust those fields; it extracts
  // only bounded IDs, labels, and source URLs that pass the current HLS policy.
  const channels = []
  for (const candidate of raw.channels) {
    if (!candidate || typeof candidate !== 'object') continue
    if (typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > CATALOG_LIMITS.maxIdLength) continue
    if (typeof candidate.name !== 'string' || candidate.name.length === 0 || candidate.name.length > CATALOG_LIMITS.maxNameLength) continue
    if (!Array.isArray(candidate.sources) || candidate.sources.length > CATALOG_LIMITS.maxSourcesPerChannel) continue
    const sources = candidate.sources.flatMap((source) => {
      if (!source || typeof source !== 'object' || typeof source.url !== 'string') return []
      const url = normalizeRemoteHlsUrl(source.url)
      return url && url === source.url ? [{ url }] : []
    })
    if (sources.length > 0) channels.push({ id: candidate.id, name: candidate.name, sources })
  }
  if (channels.length === 0) throw new Error('目录缓存没有符合当前 HLS URL 策略的频道')
  return { channels }
}
