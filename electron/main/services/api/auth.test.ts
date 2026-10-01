import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { bearerFrom, checkBearer, logRejectedAttempt, tokensMatch } from './auth'

const TOKEN = 'a'.repeat(64)
const WRONG = 'b'.repeat(64)

describe('bearerFrom', () => {
  it('reads the credential, whatever the scheme’s case', () => {
    expect(bearerFrom('Bearer abc')).toBe('abc')
    expect(bearerFrom('bearer abc')).toBe('abc')
    expect(bearerFrom('  Bearer abc  ')).toBe('abc')
  })

  it('answers null for anything that is not a bearer credential', () => {
    expect(bearerFrom(undefined)).toBeNull()
    expect(bearerFrom(null)).toBeNull()
    expect(bearerFrom('')).toBeNull()
    expect(bearerFrom('Basic abc')).toBeNull()
    expect(bearerFrom('Bearer')).toBeNull()
    expect(bearerFrom('Bearer   ')).toBeNull()
  })
})

describe('tokensMatch', () => {
  it('matches identical tokens and nothing else', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true)
    expect(tokensMatch(WRONG, TOKEN)).toBe(false)
    // Same length, one byte different: the case timingSafeEqual is for
    expect(tokensMatch('a'.repeat(63) + 'c', TOKEN)).toBe(false)
    expect(tokensMatch('', '')).toBe(true)
  })

  it('returns false rather than throwing on a length mismatch', () => {
    // timingSafeEqual throws on unequal lengths; the length check runs first
    // precisely so an auth check can never answer 500 where 401 belongs
    expect(() => tokensMatch('short', TOKEN)).not.toThrow()
    expect(tokensMatch('short', TOKEN)).toBe(false)
    expect(() => tokensMatch(TOKEN, '')).not.toThrow()
  })
})

describe('checkBearer', () => {
  it('authorizes the right token', () => {
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: true, failed: null })
  })

  it('refuses a wrong token as a mismatch', () => {
    expect(checkBearer(`Bearer ${WRONG}`, TOKEN)).toEqual({ ok: false, failed: 'mismatch' })
  })

  it('distinguishes a missing header from a malformed one, and refuses both', () => {
    expect(checkBearer(undefined, TOKEN)).toEqual({ ok: false, failed: 'missing' })
    expect(checkBearer('', TOKEN)).toEqual({ ok: false, failed: 'missing' })
    expect(checkBearer('Basic abc', TOKEN)).toEqual({ ok: false, failed: 'malformed' })
  })

  it('fails closed when there is no configured token (AC6/D11)', () => {
    // An enabled surface with no credential is the shape this must never grow,
    // so the check refuses everything — including an empty presented token
    expect(checkBearer(`Bearer ${TOKEN}`, null)).toEqual({ ok: false, failed: 'unconfigured' })
    expect(checkBearer(undefined, null)).toEqual({ ok: false, failed: 'unconfigured' })
    expect(checkBearer('Bearer ', '')).toEqual({ ok: false, failed: 'unconfigured' })
  })
})

describe('logRejectedAttempt', () => {
  it('logs the client address and nothing else', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    logRejectedAttempt('100.64.0.1')
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).toContain('100.64.0.1')
    // No credential of any kind — not the attempt, not the real token
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toMatch(/bearer/i)
    warn.mockRestore()
  })

  it('still says something when there is no address to name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    logRejectedAttempt(null)
    expect(warn.mock.calls.flat().join(' ')).toContain('unknown address')
    warn.mockRestore()
  })
})

/**
 * AC3 — the comparison is constant-time, and a refusal never logs a credential.
 *
 * **The limit of this case is stated here on purpose:** no unit case can observe
 * timing, so what follows proves the *code* rather than the behaviour. It is a
 * source walk over `auth.ts` — the file that would have to change for either
 * rule to be lost (the same instrument `theme/store.test.ts` and
 * `theme/importer.test.ts` use for wiring their tests cannot reach).
 */
describe('AC3 — a source walk over auth.ts', () => {
  const SOURCE = readFileSync(
    join(process.cwd(), 'electron', 'main', 'services', 'api', 'auth.ts'),
    'utf8'
  )

  it('compares with crypto.timingSafeEqual, and checks the length first', () => {
    expect(SOURCE).toMatch(/import \{ timingSafeEqual \} from 'node:crypto'/)
    expect(SOURCE).toMatch(/timingSafeEqual\(/)
    // The length check must come before it: timingSafeEqual throws on unequal
    // lengths, so a missing guard turns a 401 into a 500
    const lengthCheck = SOURCE.indexOf('a.length !== b.length')
    expect(lengthCheck).toBeGreaterThan(-1)
    expect(lengthCheck).toBeLessThan(SOURCE.indexOf('timingSafeEqual(a, b)'))
    // And `===` is nowhere to be found as a comparison
    expect(SOURCE).not.toMatch(/presented ===|=== *token|token *===/)
  })

  it('never logs a credential', () => {
    const logCalls = SOURCE.split('\n').filter((line) =>
      /console\.(warn|error|log|info)/.test(line)
    )
    expect(logCalls.length).toBeGreaterThan(0)
    for (const call of logCalls) {
      expect(call).not.toMatch(/token|bearer|credential|header|presented|attempted/i)
      // The only thing the sentence may interpolate is the address
      expect(call).toMatch(/\$\{address/)
    }
  })
})
