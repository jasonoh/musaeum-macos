import { describe, expect, it, vi } from 'vitest'
import { OPDS_USERNAME, checkBasic, logRejectedOpdsAttempt } from './basic-auth'

const TOKEN = 'a'.repeat(64)

function basic(user: string, pass: string, scheme = 'Basic'): string {
  return `${scheme} ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`
}

describe('checkBasic', () => {
  it('fails closed when there is no configured token (unconfigured)', () => {
    expect(checkBasic(basic(OPDS_USERNAME, TOKEN), null)).toEqual({
      ok: false,
      failed: 'unconfigured'
    })
    expect(checkBasic(undefined, null)).toEqual({ ok: false, failed: 'unconfigured' })
    expect(checkBasic(basic(OPDS_USERNAME, ''), '')).toEqual({ ok: false, failed: 'unconfigured' })
  })

  it('reports a missing header', () => {
    expect(checkBasic(undefined, TOKEN)).toEqual({ ok: false, failed: 'missing' })
    expect(checkBasic(null, TOKEN)).toEqual({ ok: false, failed: 'missing' })
    expect(checkBasic('', TOKEN)).toEqual({ ok: false, failed: 'missing' })
  })

  it('treats the Bearer scheme as malformed here', () => {
    expect(checkBasic(`Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: false, failed: 'malformed' })
  })

  it('refuses a wrong password as a mismatch', () => {
    expect(checkBasic(basic(OPDS_USERNAME, 'b'.repeat(64)), TOKEN)).toEqual({
      ok: false,
      failed: 'mismatch'
    })
  })

  it('refuses a wrong username with the right password as a mismatch', () => {
    expect(checkBasic(basic('someone', TOKEN), TOKEN)).toEqual({ ok: false, failed: 'mismatch' })
  })

  it('authorizes the correct pair', () => {
    expect(checkBasic(basic(OPDS_USERNAME, TOKEN), TOKEN)).toEqual({ ok: true, failed: null })
  })

  it('reads the scheme case-insensitively', () => {
    expect(checkBasic(basic(OPDS_USERNAME, TOKEN, 'basic'), TOKEN).ok).toBe(true)
    expect(checkBasic(basic(OPDS_USERNAME, TOKEN, 'BASIC'), TOKEN).ok).toBe(true)
  })

  it('splits a password containing colons on the first colon only', () => {
    expect(checkBasic(basic(OPDS_USERNAME, 'abc:def'), 'abc:def')).toEqual({
      ok: true,
      failed: null
    })
  })

  it('treats a non-base64 payload as malformed, not a throw', () => {
    expect(() => checkBasic('Basic !!!not-base64!!!', TOKEN)).not.toThrow()
    expect(checkBasic('Basic !!!not-base64!!!', TOKEN)).toEqual({ ok: false, failed: 'malformed' })
  })

  it('treats a payload with no colon as malformed', () => {
    const header = `Basic ${Buffer.from('musaeum', 'utf8').toString('base64')}`
    expect(checkBasic(header, TOKEN)).toEqual({ ok: false, failed: 'malformed' })
  })

  it('round-trips a UTF-8 password', () => {
    const token = 'pässwörd-日本語-🔑'
    expect(checkBasic(basic(OPDS_USERNAME, token), token)).toEqual({ ok: true, failed: null })
  })
})

describe('logRejectedOpdsAttempt', () => {
  it('logs the address and never anything else', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    logRejectedOpdsAttempt('100.64.0.1')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toEqual(['[opds] refused an unauthorized request from 100.64.0.1'])
    warn.mockRestore()
  })

  it('still says something when there is no address to name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    logRejectedOpdsAttempt(null)
    expect(warn.mock.calls[0]).toEqual([
      '[opds] refused an unauthorized request from an unknown address'
    ])
    warn.mockRestore()
  })
})
