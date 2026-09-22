import { timingSafeEqual } from 'node:crypto'

/**
 * The API's credential check: one bearer token, compared in constant time.
 *
 * Three rules, and they are the whole file:
 *
 * 1. **`crypto.timingSafeEqual`, never `===`.** The token is a shared secret,
 *    and a comparison that leaked how far a guess matched would let a tailnet
 *    peer recover it byte by byte.
 * 2. **Fail closed.** No configured token means no request is authorized: an
 *    enabled surface with no credential is the one shape this must never grow.
 *    `api/rest.ts` also refuses to start in that state — this is the second of
 *    the two defences, and the one that holds if the first is ever bypassed.
 * 3. **A refusal logs the client, never the attempt.** The address is useful.
 *    The presented credential is not: a rejected guess is often a *real*
 *    credential with a typo, and the token itself belongs in no log file.
 */

export type AuthFailure = 'missing' | 'malformed' | 'mismatch' | 'unconfigured'

export interface AuthResult {
  ok: boolean
  /** Why not; null when the request is authorized. */
  failed: AuthFailure | null
}

/** The scheme is case-insensitive (RFC 7235); the token is taken verbatim. */
const BEARER = /^Bearer +(\S+)$/i

/**
 * The credential a header carries, or null when it carries none this server
 * understands.
 */
export function bearerFrom(header: string | undefined | null): string | null {
  if (!header) return null
  const match = BEARER.exec(header.trim())
  return match ? match[1] : null
}

/**
 * The token comparison on its own, so a case can drive it directly.
 *
 * The lengths are compared first because `timingSafeEqual` **throws** on
 * buffers of unequal length — and a throw inside an auth check is a 500 where a
 * 401 belongs. The early return only reveals a length, which the token's own
 * format already publishes.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Whether a request may proceed.
 *
 * `token` is the *real* value (`resolveRestApiConfig().token` from
 * `services/settings.ts`), never a masked view: masking is for the UI, and a
 * server comparing against a masked string would authorize nobody (or, worse,
 * everybody).
 */
export function checkBearer(header: string | undefined | null, token: string | null): AuthResult {
  if (!token) return { ok: false, failed: 'unconfigured' }
  const presented = bearerFrom(header)
  if (!presented) return { ok: false, failed: header ? 'malformed' : 'missing' }
  return tokensMatch(presented, token)
    ? { ok: true, failed: null }
    : { ok: false, failed: 'mismatch' }
}

/**
 * One line about a request that was refused: **the client address and nothing
 * else**. Not the header, not the presented credential, and not the token it
 * failed to match.
 */
export function logRejectedAttempt(address: string | null): void {
  console.warn(`[rest] refused an unauthorized request from ${address ?? 'an unknown address'}`)
}
