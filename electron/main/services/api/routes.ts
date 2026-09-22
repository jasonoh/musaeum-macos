import type { CoverFileResult } from '../book-bytes'
import type { ApiError } from './shape'

/**
 * Which book route a path is, and what a resolver's refusal is called (D2, D10).
 *
 * Moved out of `api/rest.ts` for the same reason its sibling `query.ts` was:
 * these are decisions — is this `/api/books/{id}`, or `…/cover`, or `…/file`,
 * and what does a percent-escaped segment decode to — and a decision that can
 * be a pure function of a path belongs where the suite can make it without a
 * socket. The socket keeps what genuinely needs one: the byte writer, the
 * transfer budget, the status record and the auth check, all of which write
 * headers or hold a socket open.
 *
 * **The refusal mapping lives here so `API_ERRORS` has one home.** The cover
 * route used to answer from the resolver's status with
 * `cover.status === 400 ? 'badRequest' : 'notFound'` inline in the router —
 * a status→word table with two homes, which is how the words and the
 * document's error table drift apart. The union below is *derived from the
 * resolver's own result type*, so a third refusal status in
 * `services/book-bytes.ts` is a `npm run typecheck` failure here until its
 * word is named, exactly as `BOOK_CONTENT_TYPES` is for the format union.
 *
 * The import above is `import type` and is erased at build time: this module
 * has no runtime dependency on the filesystem or the NAS, which is what keeps
 * its cases socketless.
 */

/** Only `/api/books/`-prefixed paths reach the matcher below. */
export const BOOKS_PREFIX = '/api/books/'

/**
 * The resource a book path names. `''` is the book itself; `reading` is slice
 * 1c's write and is the only one a `PUT` may reach.
 */
export type BookResource = '' | 'cover' | 'file' | 'reading'

export interface BookPath {
  id: string
  resource: BookResource
}

/** A percent-escaped path segment, or null when the escape is malformed. */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * `/api/books/{id}`, `/api/books/{id}/cover`, `/api/books/{id}/file`,
 * `/api/books/{id}/reading`.
 *
 * A book id is opaque and never touches the filesystem — it is a cache key, and
 * a traversing one is simply not a book (404). **Only `/api/books/`-prefixed
 * paths reach here**, and a path with extra segments is not one of the four
 * shapes, so it is not this route's business (`null`, and the switch's 404).
 *
 * Which *method* each resource answers is deliberately not decided here (the
 * router's policy does that): matching a path says what a client was aiming at,
 * not whether it may have it, and `unknown path` and `known path, wrong method`
 * are the same uniform 404 on the wire (D11).
 */
export function matchBookPath(pathname: string): BookPath | null {
  if (!pathname.startsWith(BOOKS_PREFIX)) return null

  const [segment, resource = '', ...rest] = pathname.slice(BOOKS_PREFIX.length).split('/')
  if (!segment || rest.length) return null
  if (resource !== '' && resource !== 'cover' && resource !== 'file' && resource !== 'reading') {
    return null
  }

  const id = decodeSegment(segment)
  return id ? { id, resource } : null
}

/**
 * The statuses `resolveCoverFile` can refuse with, read off its own result
 * rather than re-typed — see the note above.
 */
export type ResolverRefusalStatus = Extract<CoverFileResult, { ok: false }>['status']

/**
 * The refusal words, exhaustively. A `Record` over the derived union means the
 * table and the resolver cannot disagree silently, and the words themselves are
 * `ApiError` keys — so `docs/rest-api.md`'s error table, the shaper and this
 * mapping are one declaration with three readers.
 */
const REFUSAL_WORDS: Record<ResolverRefusalStatus, ApiError> = {
  400: 'badRequest',
  404: 'notFound'
}

/** What a resolver's refusal is called on the wire. */
export function refusalError(status: ResolverRefusalStatus): ApiError {
  return REFUSAL_WORDS[status]
}
