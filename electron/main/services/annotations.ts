import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ReaderFormat } from '@shared/book.types'
import type {
  Annotation,
  AnnotationArtifact,
  AnnotationsFile,
  AnnotationsRead,
  CreateAnnotationResult,
  NewAnnotationInput,
  StoredAnnotation
} from '@shared/annotation.types'
import {
  DEFAULT_ANNOTATION_COLOR,
  clipContext,
  clipQuote,
  isHighlight
} from '@shared/annotation.types'
import {
  emptyAnnotationsFile,
  readAnnotationsFile,
  writeAnnotationsFile,
  type AnnotationsReadState
} from './annotations-file'
import * as db from './db'
import * as nas from './nas-manager'

/**
 * A book's highlights and notes: the only reader and the only writer of
 * `{book}/annotations.json` (`docs/superpowers/specs/2026-10-13-annotations-design.md`,
 * slice 1; readings in `docs/superpowers/plans/2026-10-13-annotations-slice1.md`).
 *
 * No cache, no column and no broadcast, and each absence is the design rather than an
 * omission. **No cache**, because the read path is the share and the file is wanted only
 * when its book is open — which is what lets the record travel between machines with no
 * adoption step at all (D1). **No column**, because nothing else needs the notes (D1's
 * rejections). **No broadcast**, because the only consumer is the reader that made the
 * change and every mutation already answers with the file's own list (annex R1); a
 * `libraryChanged` here would reload 7,000 rows to redraw one panel.
 *
 * The failure posture is the reader's, not the library's (invariant 12): a read that fails
 * is a *state* a component renders, and a write that cannot reach the share refuses with a
 * sentence rather than parking a change nobody can see.
 */

export const ANNOTATIONS_UNREADABLE =
  'The notes for this book could not be read — note changes are paused so nothing is lost'
export const ANNOTATION_GONE = 'That highlight is no longer in this book.'
export const ANNOTATION_NO_BOOK = 'That book is not in the library.'

/**
 * `{book}/derived/reflow.json` — the pass's stamp.
 *
 * Spelled here rather than imported because the sidecar owns the name
 * (`sidecar/reflow/produce.py:75`'s `STAMP_NAME` is its first declaration) and nothing in
 * the app had needed to read it before this: `book-bytes.ts` resolves the *artifact*, and
 * the stamp was the pipeline's own business until an annotation had to say which artifact
 * its `cfi` was a path into (spec D6).
 */
const STAMP_PATH = join('derived', 'reflow.json')

/**
 * The book's folder on the share, or null.
 *
 * `join(root, book.nasPath)`, like every other write path here (`reading-state.ts` writes
 * its `metadata.json` the same way, `book-delete.ts` removes the folder the same way). The
 * containment rule that guards the renderer-facing reads (invariant 9, `book-bytes.ts`'s
 * `contained`) is deliberately **not** repeated: `nasPath` comes from a catalog any machine
 * can write, and a traversing row is a class of exposure every writer already shares — so
 * it is one fix in one place for all of them, not a second rule in this file.
 */
function bookDir(bookId: string): string | null {
  const root = nas.getLibraryRoot()
  const book = db.getBook(bookId)
  if (!root || !book?.nasPath) return null
  return join(root, book.nasPath)
}

/**
 * A reflow stamp as one comparable token (spec D6, annex R2).
 *
 * Over the stamp **whole**, not its `converter` alone. The pass caches on three terms — the
 * converter triple *and* the source's size and mtime (`sidecar/reflow/produce.py:137-141`,
 * the terms `docs/data-contracts.md` states) — so a PDF replaced in place re-runs the pass
 * and rewrites the artifact while the converter is unchanged. Comparing the converter alone
 * called that artifact fresh and drew the old `cfi` into a document it no longer indexed:
 * the silent mis-draw this record exists to prevent (measured by this slice's review, which
 * ran both halves — the sidecar's `stamp_is_current` answers False for a moved mtime with an
 * identical converter, and the service answered `stale: false` for the same stamp).
 *
 * A digest over every member rather than the members themselves, so the comparison cannot
 * fall behind the sidecar's condition: a mirror of today's three terms goes stale in the
 * *fresh* direction the day a fourth arrives, and that error has no symptom.
 *
 * The three terms are still *checked*, though, before anything is digested: a stamp the
 * pass's own condition would reject is an identity this build cannot establish, and the read
 * path treats one as a mismatch rather than a match (annex R6). Without that check a junk
 * stamp would hash to a stable identity and be drawn from, which is the same silent mis-draw
 * arriving by the other door. A future sidecar that describes its source differently lands in
 * the safe direction: every annotation reads stale (listed, never drawn) and says so.
 *
 * Keys are sorted at every level, so a hand-edited stamp whose members are in another order
 * is still the same artifact.
 */
export function stampToken(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const stamp = value as Record<string, unknown>
  if (typeof stamp.version !== 'number') return null
  if (!isPlainObject(stamp.converter)) return null
  const source = stamp.source
  if (!isPlainObject(source)) return null
  if (typeof source.size !== 'number' || typeof source.mtime !== 'number') return null
  return createHash('sha256').update(canonicalJson(stamp)).digest('hex')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON with object keys sorted at every level, so two spellings of one value agree. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const members = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  return `{${members.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`
}

async function stampIdentity(dir: string): Promise<string | null> {
  try {
    return stampToken(JSON.parse(await fs.readFile(join(dir, STAMP_PATH), 'utf8')))
  } catch {
    // No stamp, an unreadable one, or one this build cannot parse: the artifact's identity
    // is unknown, and an unknown identity is not a match (annex R6).
    return null
  }
}

/** The artifact this book would be served as, right now (spec D6). */
async function artifactFor(bookId: string, format: ReaderFormat): Promise<AnnotationArtifact> {
  if (format !== 'reflow') return { kind: 'source', format, stamp: null }
  const dir = bookDir(bookId)
  return { kind: 'derived', format, stamp: dir ? await stampIdentity(dir) : null }
}

/**
 * Whether a stored `cfi` points into an artifact the reader would not be served now.
 *
 * A mismatch must not be drawn: `addAnnotation` applies the `cfi` as a node path, so a
 * path that still resolves can land on a *different* sentence — silent corruption, which is
 * worse than a missing highlight because nothing on screen says so (spec D6; the furniture
 * rule's 3 → 4 bump removed 566 blocks from *Universe*, so every `cfi` after the first
 * removal shifted).
 *
 * The comparison is the whole stamp's digest, not the converter alone: the pass re-runs on a
 * moved source too (`produce.py:137-141`), and a `cfi` into a re-run artifact is exactly the
 * silent case above.
 */
export function isStale(stored: AnnotationArtifact, current: AnnotationArtifact): boolean {
  if (stored.kind !== current.kind || stored.format !== current.format) return true
  // A source file carries no identity here: the CFI is into the book's own file, and a file
  // replaced outside the app is the residual the spec names rather than something this can see.
  if (stored.kind === 'source') return false
  if (stored.stamp === null || current.stamp === null) return true
  return stored.stamp !== current.stamp
}

function highlights(file: AnnotationsFile): StoredAnnotation[] {
  return file.annotations.filter(isHighlight)
}

/** The stored record as the renderer sees it: camelCase, and `stale` where `artifact` was (R5). */
function toBridge(stored: StoredAnnotation, current: AnnotationArtifact): Annotation {
  return {
    id: stored.id,
    type: 'highlight',
    cfi: stored.cfi,
    quote: stored.quote,
    prefix: stored.prefix,
    suffix: stored.suffix,
    percent: stored.percent,
    sectionLabel: stored.section_label,
    color: stored.color,
    note: stored.note,
    createdAt: stored.created_at,
    updatedAt: stored.updated_at,
    stale: isStale(stored.artifact, current)
  }
}

function bridgeList(file: AnnotationsFile, current: AnnotationArtifact): Annotation[] {
  return highlights(file).map((stored) => toBridge(stored, current))
}

function findHighlight(file: AnnotationsFile, id: string): StoredAnnotation {
  const found = highlights(file).find((entry) => entry.id === id)
  if (!found) throw new Error(ANNOTATION_GONE)
  return found
}

/** A caller's percent, clamped: the *writer* clamps so a bad value can never be stored, and
 *  the reader refuses a stored one rather than rewriting it (both rules, one direction each). */
function clipPercent(percent: unknown): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0
  return Math.min(1, Math.max(0, percent))
}

/**
 * A note, trimmed at its ends and otherwise verbatim (annex R4).
 *
 * The ends go because a textarea hands back what was pasted; nothing else changes, because
 * this is prose a person typed — collapsing its line structure would rewrite their
 * paragraphs. Blank is `null`, which is the "keep the highlight, drop the note" gesture and
 * is not an error.
 */
function cleanNote(note: string | null): string | null {
  if (typeof note !== 'string') return null
  const trimmed = note.trim()
  return trimmed === '' ? null : trimmed
}

// One log per unreadable file per session, cleared as soon as a read succeeds — the rule
// `shelves.ts` keeps for the same file class, and for the same reason: a canonical file on a
// share stays unreadable until someone repairs it, while the panel reads on open and after
// every mutation, so an unguarded warning reports the same bytes once per refresh.
let reportedUnreadable = false

/** Test-only: undo `reportedUnreadable`'s carry-over between tests in one file (as
 *  `shelves.ts`'s `resetAdoptionLogForTests` does for its own). */
export function resetAnnotationLogForTests(): void {
  reportedUnreadable = false
}

function warnUnreadable(dir: string, err: unknown): void {
  if (reportedUnreadable) return
  reportedUnreadable = true
  console.warn(`[annotations] cannot read ${dir}:`, err)
}

/** A read that got far enough to answer — which is what clears the one-log rule above. */
async function readState(dir: string): Promise<AnnotationsReadState> {
  const state = await readAnnotationsFile(dir)
  reportedUnreadable = false
  return state
}

// One queue for the process — two mutations interleaving their read-modify-write would lose
// one (annex R7). Same shape as `shelves.ts`'s and `catalog.ts`'s.
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

/**
 * Every write goes through here, and runs `shelves.ts`'s `mutate` steps with the cache step
 * removed: assert the library is writable → enter the queue → **re-read the file** → apply
 * the change to what was read → write it atomically → answer.
 *
 * The re-read is the whole reason a mutation answers with the file's list rather than the
 * one annotation that changed (annex R1): another Mac may have annotated this book since
 * this one last looked, so the change applies to the file as it is now, and the answer is
 * what the file holds.
 *
 * A file that exists and cannot be read is never overwritten — refused with a sentence
 * until someone repairs it — and neither is a folder that has gone (the read rejects, and
 * the rejection carries the same refusal).
 */
async function mutate<T>(
  bookId: string,
  apply: (file: AnnotationsFile, now: string) => { result: T; changed: boolean }
): Promise<T> {
  nas.assertOnline()
  const dir = bookDir(bookId)
  if (!dir) throw new Error(ANNOTATION_NO_BOOK)
  return enqueue(async () => {
    let read: AnnotationsReadState
    try {
      read = await readState(dir)
    } catch (err) {
      warnUnreadable(dir, err)
      throw new Error(ANNOTATIONS_UNREADABLE, { cause: err })
    }
    if (read.state === 'invalid') throw new Error(ANNOTATIONS_UNREADABLE)

    const file = read.state === 'ok' ? read.file : emptyAnnotationsFile(bookId)
    if (file.book_id !== bookId) {
      // A folder copied or renamed by mistake. The id is not a rule — the file is found by
      // its folder — so nothing refuses; the next write repairs it (spec D2).
      console.warn(`[annotations] ${dir} says book_id ${file.book_id}, expected ${bookId}`)
      file.book_id = bookId
    }

    const applied = apply(file, new Date().toISOString())
    if (!applied.changed) return applied.result
    await writeAnnotationsFile(dir, file)
    return applied.result
  })
}

/**
 * This book's highlights, and what the read came to (annex R3).
 *
 * Never throws: a share that dropped mid-session is a state the panel renders, not a
 * failure of the book (invariant 12) — and it is deliberately not an empty list, because
 * "no notes" and "notes that could not be read" are different sentences on screen.
 */
export async function list(bookId: string, format: ReaderFormat): Promise<AnnotationsRead> {
  const dir = bookDir(bookId)
  if (!dir) return { state: 'unreadable', annotations: [] }

  let read: AnnotationsReadState
  try {
    read = await readState(dir)
  } catch (err) {
    warnUnreadable(dir, err)
    return { state: 'unreadable', annotations: [] }
  }
  if (read.state === 'invalid') return { state: 'unreadable', annotations: [] }
  if (read.state === 'missing') return { state: 'missing', annotations: [] }

  return {
    state: 'ok',
    annotations: bridgeList(read.file, await artifactFor(bookId, format))
  }
}

/**
 * Add one highlight (spec D8's chip, and the only creation path this build has).
 *
 * The id, the `type`, both timestamps and the `artifact` are minted here and never taken
 * from the caller (annex R5) — the last of those because a renderer that could name an
 * artifact would be a renderer told a `derived/` fact. Because the *id* is minted here too,
 * the answer carries the record as well as the list: a caller cannot look up an annotation
 * it was never told the name of (the same reason `shelves.create` answers with the shelf it
 * made, minted id and all).
 */
export async function create(input: NewAnnotationInput): Promise<CreateAnnotationResult> {
  const cfi = input.cfi.trim()
  if (!cfi) throw new Error('A highlight needs a position.')
  const quote = clipQuote(input.quote)
  if (!quote) throw new Error('A highlight needs the text it covers.')
  const color = input.color?.trim() || DEFAULT_ANNOTATION_COLOR

  const current = await artifactFor(input.bookId, input.format)
  return mutate(input.bookId, (file, now) => {
    const stored: StoredAnnotation = {
      id: randomUUID(),
      type: 'highlight',
      cfi,
      quote,
      prefix: clipContext(input.prefix),
      suffix: clipContext(input.suffix),
      percent: clipPercent(input.percent),
      section_label: input.sectionLabel?.trim() || null,
      color,
      note: null,
      artifact: current,
      created_at: now,
      updated_at: now
    }
    file.annotations.push(stored)
    return {
      result: { annotations: bridgeList(file, current), created: toBridge(stored, current) },
      changed: true
    }
  })
}

/**
 * Change one highlight's note.
 *
 * `changed: false` when the note is already the one being saved, so `updated_at` moves only
 * for a real change and no write happens for a re-save — the guard
 * `field-overrides.markFromPatch` and `reading-state.noteStatusChange` both carry, for the
 * same reason: a field that stamps itself on every call makes its own clock meaningless.
 */
export async function update(
  bookId: string,
  id: string,
  note: string | null,
  format: ReaderFormat
): Promise<Annotation[]> {
  const current = await artifactFor(bookId, format)
  return mutate(bookId, (file, now) => {
    const stored = findHighlight(file, id)
    const next = cleanNote(note)
    if (stored.note === next) return { result: bridgeList(file, current), changed: false }

    stored.note = next
    stored.updated_at = now
    return { result: bridgeList(file, current), changed: true }
  })
}

/**
 * Delete one highlight.
 *
 * A named refusal when the id is not in the file — deleted on the other Mac since this one
 * listed it — rather than a silent no-op, so the panel can say so instead of appearing to
 * have deleted something (`shelves.ts`'s `SHELF_GONE` is the same call). An entry of a kind
 * this build does not know cannot be asked for here at all: the renderer never sees one.
 */
export async function remove(
  bookId: string,
  id: string,
  format: ReaderFormat
): Promise<Annotation[]> {
  const current = await artifactFor(bookId, format)
  return mutate(bookId, (file) => {
    const before = file.annotations.length
    file.annotations = file.annotations.filter((entry) => !(isHighlight(entry) && entry.id === id))
    if (file.annotations.length === before) throw new Error(ANNOTATION_GONE)
    return { result: bridgeList(file, current), changed: true }
  })
}
