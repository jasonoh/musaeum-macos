import { promises as fs } from 'fs'
import { extname, join, relative, resolve } from 'path'
import type { BookFormat } from '@shared/book.types'
import * as db from './db'
import * as nas from './nas-manager'

/**
 * What a book's bytes are, and what may be asked of them.
 *
 * Kept out of the protocol handler so the path rules — which are the security
 * boundary between a renderer URL (or an HTTP request) and the filesystem — are
 * testable without a running Electron app. Two consumers resolve through here:
 * `musaeum://book/{id}/{format}` and `musaeum://cover/{id}/{size}` for the
 * renderer (invariant 9: the renderer never gets `file://`), and
 * `GET /api/books/{id}/file` and `GET /api/books/{id}/cover` for the phone.
 *
 * **One boundary, not two.** A second resolver written beside this one would be
 * a second place to get the realpath rule wrong, and the wrong copy would be the
 * network-facing one (D8). The `Range` grammar lives here for the same reason:
 * it is a rule about bytes, and it is decidable without a socket.
 *
 * Every failure a caller can act on is *named*: `resolveBookFile` answers
 * `null` (its two consumers both answer 404, uniformly and reason-free), while
 * `resolveCoverFile` carries the 400/404 split the `musaeum://cover` handler
 * already makes — see its own note.
 */

const FORMATS = new Set<string>(['epub', 'mobi', 'azw3', 'pdf'] satisfies BookFormat[])

/**
 * The media type a book file is served as, keyed by the format union.
 *
 * The `Record<BookFormat, …>` is load-bearing in the same way
 * `BOOK_FILE_EXTENSIONS`' is: it is declared over the same union, so a sixth
 * format is an `npm run typecheck` failure here until its type is named — there
 * is no second format list to keep in step.
 */
export const BOOK_CONTENT_TYPES: Record<BookFormat, string> = {
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  pdf: 'application/pdf'
}

/**
 * The type to serve for a format. Anything outside the union is
 * `application/octet-stream`: unreachable through the HTTP route, because
 * `resolveBookFile` answers `null` for a format it does not know first, and a
 * total function here keeps that one check in one place.
 */
export function bookContentType(format: string): string {
  return BOOK_CONTENT_TYPES[format as BookFormat] ?? 'application/octet-stream'
}

export async function resolveBookFile(bookId: string, format: string): Promise<string | null> {
  if (!FORMATS.has(format)) return null

  const dir = await bookFolder(bookId)
  if (!dir) return null

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }

  // By extension, not by canonical name — same rule as file-access and
  // deleteFormats, so a book renamed after import still opens
  const match = entries.find((f) => extname(f).toLowerCase() === `.${format}`)
  if (!match) return null

  return contained(join(dir, match))
}

/**
 * The book's folder, when the library holds one for it — or null.
 *
 * The lexical check is `nasPath`'s own defence: the path comes from a catalog
 * any machine can write, so a traversing entry must not turn a renderer URL
 * into arbitrary filesystem read access. The realpath half is in `contained` —
 * a symlink passes this test.
 */
async function bookFolder(bookId: string): Promise<string | null> {
  const root = nas.getLibraryRoot()
  const book = db.getBook(bookId)
  if (!root || !book?.nasPath) return null

  const dir = resolve(root, book.nasPath)
  const rel = relative(resolve(root), dir)
  if (rel.startsWith('..') || rel === '') return null
  return dir
}

/**
 * `candidate` inside the library root — realpath'd on **both** sides, or null.
 *
 * The lexical check the callers do first stops a traversing `nasPath`, but not a
 * symlink: the file, or the book folder itself, can point outside the library
 * root and still pass it. realpath resolves that, but macOS makes the library
 * root's own ancestry a symlink too (`/tmp` → `/private/tmp`, `/var` →
 * `/private/var`), so **both** sides must be realpath'd before comparing —
 * resolving only the candidate would 404 every legitimate book. The *value*
 * returned is the caller's own path and not the realpath, so the name in a
 * response is the one that was asked for; the check is the comparison, not the
 * value.
 */
async function contained(candidate: string): Promise<string | null> {
  const root = nas.getLibraryRoot()
  if (!root) return null

  let realRoot: string
  let realCandidate: string
  try {
    realRoot = await fs.realpath(root)
    realCandidate = await fs.realpath(candidate)
  } catch {
    return null
  }
  const realRel = relative(realRoot, realCandidate)
  if (realRel.startsWith('..') || realRel === '') return null

  return candidate
}

// ---------------------------------------------------------------------------
// The reflow — a derived rendering, on a route of its own (D3, D8)
// ---------------------------------------------------------------------------

const DERIVED = 'derived'
const REFLOW_NAME = 'reflow.epub'

/**
 * The `format` that asks for the derived artifact — **not a `BookFormat`** (D3,
 * AC2), which is why it is a constant here rather than a member of `FORMATS`.
 *
 * `musaeum://book/{id}/reflow` has answered to it since slice 3 and
 * `GET /api/books/{id}/file?format=reflow` since the wire's slice 4 (D8); the
 * two share this spelling so the renderer's URL and the phone's query cannot
 * drift apart. It is intercepted in `api/rest.ts` **before** `resolveBookFile`,
 * so it never becomes a format this module resolves by extension: the folder it
 * lives in is `derived/`, which is not a format (D3).
 */
export const REFLOW_FORMAT = 'reflow'

/**
 * What the artifact is served as. The reflow's output **is** an EPUB — the
 * sidecar writes EPUB 3 — so it is the EPUB media type and not a type of its
 * own; a client that already opens a book needs no branch for it.
 */
export const REFLOW_CONTENT_TYPE = BOOK_CONTENT_TYPES.epub

/**
 * The file behind `musaeum://book/{bookId}/reflow` — and, since the wire's slice
 * 4, behind `GET /api/books/{id}/file?format=reflow` too:
 * `{book}/derived/reflow.epub`.
 *
 * **Deliberately not a member of `FORMATS`, and deliberately not reachable
 * through `resolveBookFile`.** The wire reaches it through the router's own
 * arm, which owns the pass and the `202`/`422` a run can answer **before** it
 * calls this — so what is left here is a plain path decision, exactly as it is
 * for the renderer. That is the whole reason the arm is a branch in
 * `api/rest.ts` and not a fifth format in this file: a `reflow` arm in
 * `resolveBookFile` would answer a book whose pass has never run with a stale
 * artifact or a bare 404, and would have no way to say *a pass is running*.
 *
 * A *fixed* name rather than an extension scan, for the mirror-image reason:
 * `derived/` is not a format (D3, `docs/invariants/files-and-deletion.md`), so
 * there is no "which file is the book's" question here — the artifact's name is
 * the sidecar's (`reflow/produce.py`'s `EPUB_NAME`), and this is its second
 * declaration. A scan would also happily serve a stray file the pipeline never
 * wrote.
 */
export async function resolveReflowFile(bookId: string): Promise<string | null> {
  const dir = await bookFolder(bookId)
  if (!dir) return null
  return contained(join(dir, DERIVED, REFLOW_NAME))
}

// ---------------------------------------------------------------------------
// Covers — extracted from the `musaeum://cover` handler (D8, AC11)
// ---------------------------------------------------------------------------

/**
 * What resolving a cover came to. **The refusal carries its own status**, because
 * one `null` cannot: the handler this was extracted from answers **400** for a
 * traversing row (`index.ts:72`) and **404** for a missing root, book or cover
 * (`:69`), and flattening that split would change the very behaviour the
 * extraction has to preserve (AC13).
 */
export type CoverFileResult = { ok: true; path: string } | { ok: false; status: 400 | 404 }

const COVER_NOT_FOUND: CoverFileResult = { ok: false, status: 404 }
const COVER_BAD_PATH: CoverFileResult = { ok: false, status: 400 }

/**
 * The file behind `musaeum://cover/{bookId}/{size}`, or why there is none.
 *
 * **The size branch is deliberately lenient, and that is the behaviour being
 * pinned:** the handler resolves `size === 'thumb' ? coverThumbPath :
 * coverFullPath`, so any size that is not `thumb` serves the **full** cover and
 * `musaeum://cover/{id}/banana` has always answered an image (AC13b). The
 * renderer only ever asks for its two fixed strings, so nothing reaches this
 * with a third one — but the resolver keeps the branch rather than "fixing" it
 * here, because the fix would be a change to what the renderer's own covers
 * answer. `GET /api/books/{id}/cover` is the stricter caller: it validates
 * `size` before calling, which a typed wire can afford and a renderer's URL
 * cannot be trusted to (AC14).
 *
 * The traversal rule is the *same one `resolveBookFile` applies*, on both the
 * row's cover path and the book's folder: a bare filename for the first (the
 * handler's own check, kept), then the containment test — realpath on both sides
 * — for the second. **This is stricter than the handler was, on purpose.** The
 * handler joined `root + nasPath + file` with no check on `nasPath` at all, and
 * `nasPath` comes from a catalog any machine can write, so a poisoned row could
 * walk the cover host out of the library root; invariant 9's rule is what
 * closes it, and the observable difference is confined to exactly that case (a
 * row that escapes the root **or resolves back to it** — `nas_path = '.'` is the
 * same class, and `resolveBookFile` refuses the identical shape — or a cover
 * symlinked out of it, now answers 400/404 instead of bytes).
 */
export async function resolveCoverFile(bookId: string, size: string): Promise<CoverFileResult> {
  const root = nas.getLibraryRoot()
  const book = db.getBook(bookId)
  const file = size === 'thumb' ? book?.coverThumbPath : book?.coverFullPath
  if (!root || !book?.nasPath || !file) return COVER_NOT_FOUND

  // Cover paths are stored relative to the book dir; reject traversal
  if (file.includes('..') || file.includes('/')) return COVER_BAD_PATH

  const dir = resolve(root, book.nasPath)
  const rel = relative(resolve(root), dir)
  if (rel.startsWith('..') || rel === '') return COVER_BAD_PATH

  const candidate = join(dir, file)

  // Missing is 404, not 400: a cover whose file is gone — a folder deleted
  // outside the app, or half of a failed delete — is the case the handler
  // answered 404 for through `net.fetch`'s rejection. Resolving the realpath
  // decides the same thing here, and it decides the containment rule with it
  // (a symlink out of the library root resolves outside it).
  let realRoot: string
  let realCandidate: string
  try {
    realRoot = await fs.realpath(root)
    realCandidate = await fs.realpath(candidate)
  } catch {
    return COVER_NOT_FOUND
  }
  const realRel = relative(realRoot, realCandidate)
  if (realRel.startsWith('..') || realRel === '') return COVER_BAD_PATH

  return { ok: true, path: candidate }
}

// ---------------------------------------------------------------------------
// Ranges — resumable downloads (D15, AC15a)
// ---------------------------------------------------------------------------

/**
 * What a `Range` header asked for.
 *
 * `full` is no header at all; `partial` is a satisfiable single range, with
 * **inclusive** bounds; `unsatisfiable` is anything else.
 *
 * **A malformed range is `unsatisfiable`, not ignored.** HTTP allows an origin
 * to ignore a `Range` it does not understand and answer the whole entity; this
 * route deliberately does not, because the entity here is up to 528 MB over a
 * tailnet and answering it in full to a client that asked for its tail is the
 * exact failure D15 exists to prevent — the client would take minutes to
 * discover it had restarted. So the accepted grammar is exactly
 * `bytes=N-` and `bytes=N-M`: a suffix range (`bytes=-500`), a multi-range
 * (`bytes=0-1,5-6`), another unit and a non-numeric bound all answer 416, and
 * `docs/rest-api.md` states that as the contract.
 */
export type ByteRange =
  { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' }

export function parseByteRange(header: string | undefined | null, size: number): ByteRange {
  if (!header) return { kind: 'full' }

  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim())
  if (!match) return { kind: 'unsatisfiable' }

  const start = Number(match[1])
  // An open end means "to the last byte"; a closed one past the end is clamped
  // (RFC 9110 §14.1.2), because the client's idea of the length can be stale
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (!Number.isSafeInteger(start) || start >= size || end < start) {
    return { kind: 'unsatisfiable' }
  }

  return { kind: 'partial', start, end }
}
