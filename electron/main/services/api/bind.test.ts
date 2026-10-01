import { describe, expect, it } from 'vitest'
import {
  TAILNET_CIDR,
  isAllowedBindAddress,
  isLoopbackAddress,
  isTailnetAddress,
  resolveBindAddress,
  type InterfaceAddress,
  type InterfaceMap
} from './bind'

/**
 * Bind-address resolution (AC4).
 *
 * Every case runs over a **fixture** map, never this machine's own interfaces:
 * the machine is not a fixture, and its answers change with the network. The
 * addresses below are the ones measured on 2026-09-22
 * (`lo0 127.0.0.1`, `en0 192.168.1.10`, `utun9 100.64.0.1`,
 * `utun8 10.0.0.2`), so the case that matters is visible in the fixture: the
 * tailnet address must win and the plain tunnel must lose.
 */

function ip(address: string, internal = false): InterfaceAddress {
  return { address, family: 'IPv4', internal }
}

/** The machine as measured, as a fixture. */
const MEASURED: InterfaceMap = {
  lo0: [ip('127.0.0.1', true)],
  en0: [ip('192.168.1.10')],
  utun9: [ip('100.64.0.1')],
  utun8: [ip('10.0.0.2')]
}

describe('isTailnetAddress', () => {
  it('accepts the range CGNAT actually covers, ends included', () => {
    expect(isTailnetAddress('100.64.0.0')).toBe(true)
    expect(isTailnetAddress('100.64.0.1')).toBe(true)
    expect(isTailnetAddress('100.127.255.255')).toBe(true)
  })

  it('rejects the addresses either side of the range', () => {
    // A /^100\./ test would accept both of these — which is why this is decided
    // on the number
    expect(isTailnetAddress('100.63.255.255')).toBe(false)
    expect(isTailnetAddress('100.128.0.0')).toBe(false)
  })

  it('rejects a LAN address, a plain tunnel, and anything that is not IPv4', () => {
    expect(isTailnetAddress('192.168.1.10')).toBe(false)
    expect(isTailnetAddress('10.0.0.2')).toBe(false)
    expect(isTailnetAddress('fe80::1%utun9')).toBe(false)
    expect(isTailnetAddress('100.125.135')).toBe(false)
    expect(isTailnetAddress('100.64.0.256')).toBe(false)
    expect(isTailnetAddress('')).toBe(false)
  })
})

describe('isLoopbackAddress', () => {
  it('accepts the loopback block, the v6 loopback and the loopback name', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.4.5.6')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('localhost')).toBe(true)
  })

  it('rejects a LAN address and the wildcard', () => {
    expect(isLoopbackAddress('192.168.1.10')).toBe(false)
    expect(isLoopbackAddress('0.0.0.0')).toBe(false)
    expect(isLoopbackAddress('127.0.0.1.example.com')).toBe(false)
  })
})

describe('isAllowedBindAddress', () => {
  it('is loopback or tailnet, and nothing else', () => {
    expect(isAllowedBindAddress('127.0.0.1')).toBe(true)
    expect(isAllowedBindAddress('100.64.0.1')).toBe(true)
    expect(isAllowedBindAddress('0.0.0.0')).toBe(false)
    expect(isAllowedBindAddress('192.168.1.10')).toBe(false)
    expect(isAllowedBindAddress('10.0.0.2')).toBe(false)
  })
})

describe('resolveBindAddress — no override', () => {
  it('picks the tailnet address out of the measured interface map', () => {
    expect(resolveBindAddress(MEASURED)).toEqual({
      ok: true,
      address: '100.64.0.1',
      source: 'tailnet',
      reason: null
    })
  })

  it('does not pick the plain tunnel or the LAN address', () => {
    expect(resolveBindAddress({ utun8: [ip('10.0.0.2')] })).toMatchObject({
      ok: false,
      source: 'none'
    })
    expect(resolveBindAddress({ en0: [ip('192.168.1.10')] })).toMatchObject({
      ok: false,
      source: 'none'
    })
  })

  it('refuses with a reason naming the range when there is no tailnet address', () => {
    const decision = resolveBindAddress({ utun8: [ip('10.0.0.2')] })
    expect(decision.address).toBeNull()
    expect(decision.reason).toContain(TAILNET_CIDR)
    // The reason names the setting, because naming it is how loopback is asked for
    expect(decision.reason).toContain('rest_api_bind')
  })

  it('ignores an internal interface even when its address is in the range', () => {
    expect(resolveBindAddress({ lo0: [ip('100.64.0.1', true)] })).toMatchObject({
      ok: false,
      address: null,
      source: 'none'
    })
  })

  it('ignores a non-IPv4 address', () => {
    expect(
      resolveBindAddress({ utun9: [{ address: 'fe80::1', family: 'IPv6', internal: false }] })
    ).toMatchObject({ ok: false, source: 'none' })
  })

  it('answers the same address twice, and the sorted-first of two', () => {
    // Two tailnet addresses is an owner's job to disambiguate; until they do,
    // the same machine answers the same thing every time it is asked
    const two: InterfaceMap = { utun9: [ip('100.64.0.1')], utun6: [ip('100.64.0.5')] }
    expect(resolveBindAddress(two).address).toBe('100.64.0.5')
    expect(resolveBindAddress(two).address).toBe(resolveBindAddress(two).address)
  })

  it('refuses an empty map', () => {
    expect(resolveBindAddress({})).toMatchObject({ ok: false, source: 'none', address: null })
  })
})

describe('resolveBindAddress — rest_api_bind', () => {
  it('overrides the resolved address', () => {
    expect(resolveBindAddress(MEASURED, '100.64.0.9')).toEqual({
      ok: true,
      address: '100.64.0.9',
      source: 'override',
      reason: null
    })
  })

  it('honours a loopback override, which is the only way to ask for loopback', () => {
    for (const address of ['127.0.0.1', '::1', 'localhost']) {
      expect(resolveBindAddress(MEASURED, address)).toMatchObject({
        ok: true,
        address,
        source: 'override'
      })
    }
  })

  it('treats a blank override as no override', () => {
    expect(resolveBindAddress(MEASURED, '   ')).toMatchObject({
      ok: true,
      source: 'tailnet',
      address: '100.64.0.1'
    })
    expect(resolveBindAddress(MEASURED, null)).toMatchObject({ ok: true, source: 'tailnet' })
  })

  it.each(['0.0.0.0', '192.168.1.10', '10.0.0.2', '8.8.8.8', 'example.com'])(
    'refuses %s with a reason and no bind',
    (address) => {
      const decision = resolveBindAddress(MEASURED, address)
      expect(decision.ok).toBe(false)
      // "no bind attempt" is what a null address means: the caller has nothing
      // to hand to listen()
      expect(decision.address).toBeNull()
      expect(decision.source).toBe('override')
      expect(decision.reason).toContain(address)
      expect(decision.reason).toContain(TAILNET_CIDR)
    }
  )
})
