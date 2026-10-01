/**
 * Where the API may listen.
 *
 * **A pure function over an interface map** (`resolveBindAddress`), so the rule
 * "bind the tailnet, or an address the owner named exactly" is decided without
 * a socket, without a running app, and without this machine's own interfaces —
 * which are not a fixture. The map it takes is the shape
 * `os.networkInterfaces()` returns, narrowed to the three fields the decision
 * reads.
 *
 * The tailnet range is CGNAT, `100.64.0.0/10` (RFC 6598): Tailscale hands each
 * node an address in it, and on macOS it lives on a `utun` interface — measured
 * 2026-09-22 on this machine, `os.networkInterfaces()` answers `lo0 127.0.0.1`,
 * `en0 192.168.1.10`, `utun9 100.64.0.1`, `utun8 10.0.0.2`. The filter is
 * the range and nothing else: a plain tunnel (`utun8`'s `10.0.0.2`) and the LAN
 * (`en0`) both have to lose, and an interface *name* is not evidence of what an
 * address is.
 *
 * Reasoning and the rejected alternatives: `docs/superpowers/specs/2026-09-22-ios-companion-design.md`
 * (D3), which adopts the OPDS spec's D4/D8 rather than re-deriving them.
 */

/** `os.networkInterfaces()`'s shape, narrowed to what the resolver reads. */
export interface InterfaceAddress {
  address: string
  family: string
  internal: boolean
}

export type InterfaceMap = Record<string, InterfaceAddress[] | undefined>

/** RFC 6598 carrier-grade NAT — where a tailnet address lives. */
export const TAILNET_CIDR = '100.64.0.0/10'

export interface BindDecision {
  /** True when there is an address to bind. */
  ok: boolean
  /** The address to bind; null when the decision is a refusal. */
  address: string | null
  /** Which rule produced it: the setting, the tailnet scan, or nothing at all. */
  source: 'override' | 'tailnet' | 'none'
  /** Why the refusal, in words a log line or a Settings row can carry. */
  reason: string | null
}

/**
 * Whether an address is inside `100.64.0.0/10`.
 *
 * Decided on the number, not on a prefix string: the range is the second
 * octet's top six bits, so `100.63.x.x` and `100.128.x.x` are outside it and a
 * `/^100\./` test would wave both through. IPv4 only by construction — the
 * range has no IPv6 form, and a `utun` full of link-local v6 addresses must not
 * be mistaken for one.
 */
export function isTailnetAddress(address: string): boolean {
  const octets = parseIPv4(address)
  if (!octets) return false
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  const inRange = (value & 0xffc00000) >>> 0 === 0x64400000
  return inRange
}

/** `127.0.0.0/8`, `::1`, and the loopback name the app's AI endpoint accepts. */
export function isLoopbackAddress(address: string): boolean {
  if (address === '::1' || address === 'localhost') return true
  const octets = parseIPv4(address)
  return octets !== null && octets[0] === 127
}

/**
 * Whether an address may be bound at all.
 *
 * This is the *write* rule as well as the resolve rule — `services/settings.ts`
 * validates `rest_api_bind` with it — so a value that saves is a value that
 * binds, and the refusal the user meets at save time is the one the server
 * would otherwise have logged at start-up.
 */
export function isAllowedBindAddress(address: string): boolean {
  return isLoopbackAddress(address) || isTailnetAddress(address)
}

/**
 * The address to bind, or the reason there is none.
 *
 * An explicit `rest_api_bind` wins and is never second-guessed — except that it
 * must be an address the rule allows, which is what stops a typo'd
 * `rest_api_bind` from putting the library on the LAN. `0.0.0.0`, `en0`'s LAN
 * address and a plain tunnel are all refused with a reason and no bind attempt.
 *
 * With nothing set, the first tailnet address is used. **There is deliberately
 * no loopback fallback** when the tailnet is absent: binding `127.0.0.1`
 * instead would report an enabled, listening surface that no phone can reach —
 * a wrong answer wearing the shape of a right one. The refusal names
 * `rest_api_bind`, which is how loopback is asked for on purpose.
 */
export function resolveBindAddress(map: InterfaceMap, override?: string | null): BindDecision {
  const named = override?.trim() ?? ''
  if (named) {
    if (isAllowedBindAddress(named)) {
      return { ok: true, address: named, source: 'override', reason: null }
    }
    return {
      ok: false,
      address: null,
      source: 'override',
      reason: `rest_api_bind "${named}" is neither loopback nor a tailnet address (${TAILNET_CIDR}) — refusing to bind it`
    }
  }

  const found = findTailnetAddress(map)
  if (found) return { ok: true, address: found, source: 'tailnet', reason: null }

  return {
    ok: false,
    address: null,
    source: 'none',
    reason: `no tailnet address (${TAILNET_CIDR}) on this machine — set rest_api_bind to name the address to bind`
  }
}

/**
 * The first tailnet address in the map, walked in interface-name order.
 *
 * Sorted so the same machine always answers the same address: two tailnets, or
 * two interfaces carrying one, is a machine whose owner should name the address
 * in `rest_api_bind` rather than be surprised by which one won. Internal
 * interfaces (`lo0`) are skipped — they are this machine talking to itself,
 * which is the one thing a phone cannot do.
 */
function findTailnetAddress(map: InterfaceMap): string | null {
  for (const name of Object.keys(map).sort()) {
    for (const entry of map[name] ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4') continue
      if (isTailnetAddress(entry.address)) return entry.address
    }
  }
  return null
}

/** Dotted-quad to four octets, or null when the string is not one. */
function parseIPv4(address: string): [number, number, number, number] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return [octets[0], octets[1], octets[2], octets[3]]
}
