export const MAX_REMOTE_URL_LENGTH = 4_096

interface Ipv4Range {
  network: number
  prefix: number
}

interface Ipv6Range {
  network: bigint
  prefix: number
}

const RESTRICTED_IPV4_RANGES: Ipv4Range[] = [
  ipv4Range('0.0.0.0', 8),
  ipv4Range('10.0.0.0', 8),
  ipv4Range('100.64.0.0', 10),
  ipv4Range('127.0.0.0', 8),
  ipv4Range('169.254.0.0', 16),
  ipv4Range('172.16.0.0', 12),
  ipv4Range('192.0.0.0', 24),
  ipv4Range('192.0.2.0', 24),
  ipv4Range('192.88.99.0', 24),
  ipv4Range('192.168.0.0', 16),
  ipv4Range('198.18.0.0', 15),
  ipv4Range('198.51.100.0', 24),
  ipv4Range('203.0.113.0', 24),
  ipv4Range('224.0.0.0', 4),
  ipv4Range('240.0.0.0', 4)
]

const RESTRICTED_IPV6_RANGES: Ipv6Range[] = [
  ipv6Range('2001::', 32),
  ipv6Range('2001:2::', 48),
  ipv6Range('2001:10::', 28),
  ipv6Range('2001:20::', 28),
  ipv6Range('2001:db8::', 32),
  ipv6Range('2002::', 16),
  ipv6Range('3fff::', 20)
]

export function normalizeRemoteHttpsUrl(value: unknown): string {
  const rawUrl = cleanText(value)
  if (!rawUrl || rawUrl.length > MAX_REMOTE_URL_LENGTH) return ''

  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return ''
    if (!isPotentiallyPublicHostname(parsed.hostname)) return ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

export function normalizeRemoteHlsUrl(value: unknown): string {
  const normalized = normalizeRemoteHttpsUrl(value)
  return normalized && normalized.toLocaleLowerCase().includes('.m3u8') ? normalized : ''
}

export function isPotentiallyPublicHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).replace(/\.$/, '').toLocaleLowerCase()
  if (!host || host.includes('%')) return false

  const ipv4 = parseIpv4(host)
  if (ipv4 !== undefined) return isPublicIpv4(ipv4)

  const ipv6 = parseIpv6(host)
  if (ipv6 !== undefined) return isPublicIpv6(ipv6)
  if (host.includes(':')) return false

  if (!host.includes('.')) return false
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'home.arpa' ||
    host.endsWith('.home.arpa')
  ) {
    return false
  }
  return true
}

export function isPublicIpAddress(address: string): boolean {
  const host = stripIpv6Brackets(address).toLocaleLowerCase()
  const ipv4 = parseIpv4(host)
  if (ipv4 !== undefined) return isPublicIpv4(ipv4)
  const ipv6 = parseIpv6(host)
  return ipv6 !== undefined && isPublicIpv6(ipv6)
}

function isPublicIpv4(address: number): boolean {
  return !RESTRICTED_IPV4_RANGES.some((range) => matchesIpv4Range(address, range))
}

function isPublicIpv6(address: bigint): boolean {
  // IANA currently allocates global unicast IPv6 from 2000::/3. Restricting
  // remote media to that range fails closed for mapped, link-local, unique-local,
  // multicast, documentation, translation and other special-purpose addresses.
  if (address >> 125n !== 1n) return false
  return !RESTRICTED_IPV6_RANGES.some((range) => matchesIpv6Range(address, range))
}

function matchesIpv4Range(address: number, range: Ipv4Range): boolean {
  if (range.prefix === 0) return true
  const mask = (0xffffffff << (32 - range.prefix)) >>> 0
  return (address & mask) >>> 0 === (range.network & mask) >>> 0
}

function matchesIpv6Range(address: bigint, range: Ipv6Range): boolean {
  const shift = 128n - BigInt(range.prefix)
  return address >> shift === range.network >> shift
}

function ipv4Range(network: string, prefix: number): Ipv4Range {
  const parsed = parseIpv4(network)
  if (parsed === undefined) throw new Error(`Invalid IPv4 range: ${network}`)
  return { network: parsed, prefix }
}

function ipv6Range(network: string, prefix: number): Ipv6Range {
  const parsed = parseIpv6(network)
  if (parsed === undefined) throw new Error(`Invalid IPv6 range: ${network}`)
  return { network: parsed, prefix }
}

function parseIpv4(value: string): number | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined
    result = ((result << 8) | octet) >>> 0
  }
  return result
}

function parseIpv6(value: string): bigint | undefined {
  if (!value || value.includes('%')) return undefined
  const doubleColonParts = value.split('::')
  if (doubleColonParts.length > 2) return undefined

  const left = parseIpv6Side(doubleColonParts[0] ?? '')
  const right = parseIpv6Side(doubleColonParts[1] ?? '')
  if (!left || !right) return undefined

  const hasCompression = doubleColonParts.length === 2
  const explicitLength = left.length + right.length
  if ((!hasCompression && explicitLength !== 8) || (hasCompression && explicitLength >= 8)) return undefined

  const zeroCount = hasCompression ? 8 - explicitLength : 0
  const groups = [...left, ...Array.from({ length: zeroCount }, () => 0), ...right]
  if (groups.length !== 8) return undefined

  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n)
}

function parseIpv6Side(value: string): number[] | undefined {
  if (!value) return []
  const parts = value.split(':')
  const groups: number[] = []
  for (const [index, part] of parts.entries()) {
    if (part.includes('.')) {
      if (index !== parts.length - 1) return undefined
      const ipv4 = parseIpv4(part)
      if (ipv4 === undefined) return undefined
      groups.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff)
      continue
    }
    if (!/^[\da-f]{1,4}$/i.test(part)) return undefined
    groups.push(Number.parseInt(part, 16))
  }
  return groups
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}
