import { tokensMatch, type AuthResult } from '../api/auth'

/**
 * The OPDS server's credential check: HTTP Basic, because it is the one scheme
 * an e-reader's OPDS client can be asked for (the REST API's bearer header is
 * not something a Boox or KOReader can send).
 *
 * The rules are the REST check's, restated for a different header:
 *
 * 1. **The shared constant-time compare.** The password is the same token the
 *    REST API uses, so it goes through `tokensMatch` — never `===`.
 * 2. **Fail closed.** No configured token means no request is authorized.
 * 3. **A refusal logs the client, never the attempt.**
 *
 * This file only *decides*; the server sets `WWW-Authenticate: Basic realm="Musaeum"`
 * on the 401.
 */

/** The fixed username. The token is the password; the username is only a label. */
export const OPDS_USERNAME = 'musaeum'

/** The scheme is case-insensitive (RFC 7235); the payload is taken verbatim. */
const BASIC = /^Basic +(\S+)$/i

/**
 * The `user:password` pair a header carries, or null when it carries none this
 * server understands. Never throws: `Buffer.from(..., 'base64')` silently drops
 * characters it cannot read, so a payload whose re-encoding differs from what
 * was sent (padding aside) is junk and is refused rather than half-decoded.
 */
function credentialsFrom(header: string): { user: string; password: string } | null {
  const match = BASIC.exec(header.trim())
  if (!match) return null
  const payload = match[1]!
  const bytes = Buffer.from(payload, 'base64')
  const strip = (s: string): string => s.replace(/=+$/, '')
  if (strip(bytes.toString('base64')) !== strip(payload)) return null
  const decoded = bytes.toString('utf8')
  // Split on the FIRST colon only: a username cannot contain one (RFC 7617), but
  // a password can, and the token must survive that
  const colon = decoded.indexOf(':')
  if (colon < 0) return null
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
}

/**
 * Whether a request may proceed.
 *
 * `token` is the *real* value (`resolveRestApiConfig().token`), never a masked
 * view. Username and password are both compared, and the second comparison runs
 * whether or not the first matched, so the response time does not say which
 * half was wrong.
 */
export function checkBasic(header: string | undefined | null, token: string | null): AuthResult {
  if (!token) return { ok: false, failed: 'unconfigured' }
  if (!header) return { ok: false, failed: 'missing' }
  const creds = credentialsFrom(header)
  if (!creds) return { ok: false, failed: 'malformed' }
  const userOk = tokensMatch(creds.user, OPDS_USERNAME)
  const passwordOk = tokensMatch(creds.password, token)
  return userOk && passwordOk ? { ok: true, failed: null } : { ok: false, failed: 'mismatch' }
}

/**
 * One line about a request that was refused: **the client address and nothing
 * else**. Not the header, not the presented credential, not the token.
 */
export function logRejectedOpdsAttempt(address: string | null): void {
  console.warn(`[opds] refused an unauthorized request from ${address ?? 'an unknown address'}`)
}
