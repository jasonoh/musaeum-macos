/**
 * Highlights and notes — a book's own record
 * (`docs/superpowers/specs/2026-10-13-annotations-design.md`, slice 1).
 *
 * Two halves in one file, as `shelf.types.ts` has. The first is what the file on
 * the share holds: `{book}/annotations.json`, snake_case like `metadata.json`,
 * canonical, and written only by `electron/main/services/annotations.ts`. The
 * second is what crosses the preload bridge: camelCase, and deliberately **not**
 * a mirror of the stored record — it carries `stale` where the file carries the
 * artifact the `cfi` points into, so no renderer can read, or name, a `derived/`
 * fact (the reader's D10, via annex R5).
 */

import type { ReaderFormat } from './book.types'

/** A quote is capped because a highlight is a sentence, not a paragraph — and because the
 *  file is a whole-book read on open, so its size is on the reader's critical path (D1's
 *  reversal names 256 KB as the ceiling). */
export const QUOTE_MAX = 512

/** Context kept either side of the quote — the shape a search hit's excerpt already has
 *  (`vendor/foliate-js/search.js:2`'s `CONTEXT_LENGTH`), so a stored quote and a hit read
 *  the same way. Stored for the panel and for the re-anchor a later slice owes (spec D5). */
export const CONTEXT_MAX = 32

/** The color this build writes. The record carries the member so a picker is additive; the
 *  UI offers exactly one value (spec D2, *Rejected and deferred*). */
export const DEFAULT_ANNOTATION_COLOR = 'gold'

/** Every whitespace run becomes one space, and the ends go — the normalization a search
 *  excerpt gets (`search.js:4`), so a stored quote and a hit's `match` are comparable
 *  rather than differently spaced. */
export function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Normalized, then capped by code point so a cap never splits a surrogate pair. */
export function clipQuote(text: string): string {
  return [...normalizeQuote(text)].slice(0, QUOTE_MAX).join('')
}

/** Context is normalized and capped too, and it carries no ellipsis: it is a fragment of
 *  the sentence, not a display string. */
export function clipContext(text: string): string {
  return [...normalizeQuote(text)].slice(0, CONTEXT_MAX).join('')
}

/** What an annotation's `cfi` is a path into (spec D6). */
export type AnnotationArtifactKind = 'source' | 'derived'

/**
 * The artifact behind a stored `cfi`.
 *
 * `stamp` is a digest of the reflow stamp **whole** — its `converter` triple *and* the
 * `source` size and mtime the stamp recorded — because that is the condition the pass itself
 * caches on: `sidecar/reflow/produce.py:137-141` re-runs when the converter, the source's
 * size *or* its mtime has moved, and `docs/data-contracts.md` states the same three terms.
 * Comparing the converter alone — which this field did until the review measured it — called
 * a re-run artifact fresh and handed it the old `cfi`: the silent mis-draw spec D6 exists to
 * prevent. A digest rather than the members themselves, so the record is closed over *every*
 * term the sidecar compares now or gains later; the dangerous error is calling a moved
 * artifact fresh, and a mirror of today's three terms fails in exactly that direction the
 * day a fourth arrives.
 *
 * `null` for a source file — and for a derived annotation `null` means the stamp could not
 * be read, which the read path treats as a mismatch, never as a match (annex R6).
 */
export interface AnnotationArtifact {
  kind: AnnotationArtifactKind
  /** The `ReaderFormat` the annotation was made against — `'reflow'` for the derived artifact. */
  format: ReaderFormat
  stamp: string | null
}

/** One highlight, as stored (spec D2). */
export interface StoredAnnotation {
  id: string
  /** Only `'highlight'` today. See `ForeignAnnotation` for what another build's entry does here. */
  type: 'highlight'
  cfi: string
  quote: string
  prefix: string
  suffix: string
  percent: number
  section_label: string | null
  color: string
  note: string | null
  artifact: AnnotationArtifact
  created_at: string
  updated_at: string
}

/**
 * An entry of a `type` this build does not know — a later build's bookmark, which spec D2
 * says the shape "should not have to change to hold".
 *
 * Carried through every write exactly as it was read and never drawn, which is the rule
 * `shelves.json` set for an unknown shelf kind (D1 there): refusing the whole file would
 * lose the person's highlights, and dropping the entry would lose the other build's data.
 * Only `id` and `type` are required of it, because those are what a later build needs to
 * find it again.
 */
export interface ForeignAnnotation {
  id: string
  type: string
  [key: string]: unknown
}

export type AnnotationEntry = StoredAnnotation | ForeignAnnotation

export interface AnnotationsFile {
  /** The file format's version — independent of the REST `apiVersion`. */
  version: 1
  /** The book whose folder this file sits in. Written for a person, and compared on read;
   *  a mismatch is logged and repaired on the next write, never a refusal (D2 — it is not a rule). */
  book_id: string
  annotations: AnnotationEntry[]
}

export function isHighlight(entry: AnnotationEntry): entry is StoredAnnotation {
  return entry.type === 'highlight'
}

// --- What crosses the preload bridge ---

/** A highlight as the renderer sees it. `artifact` is deliberately absent (annex R5). */
export interface Annotation {
  id: string
  type: 'highlight'
  cfi: string
  quote: string
  prefix: string
  suffix: string
  percent: number
  sectionLabel: string | null
  color: string
  note: string | null
  createdAt: string
  updatedAt: string
  /** True when the `cfi` points into an artifact the reader would not be served now (spec D6). */
  stale: boolean
}

/**
 * What a read came to (annex R3).
 *
 * `missing` and `unreadable` are separate on purpose: an empty list and a file that could
 * not be read are different sentences on screen, and only the state can tell them apart —
 * a bare `[]` would have the panel quietly claim the person never wrote a note.
 */
export type AnnotationsState = 'ok' | 'missing' | 'unreadable'

export interface AnnotationsRead {
  state: AnnotationsState
  annotations: Annotation[]
}

/**
 * What creating a highlight answers: the book's whole list as the file now holds it, **and**
 * the record that was minted.
 *
 * The list is the answer because the write re-reads the file — another Mac may have
 * annotated this book since, so a local append could show a list the file does not agree
 * with (annex R1). The record rides along because its id was minted in the service and a
 * caller cannot look up an annotation it was never told the name of.
 */
export interface CreateAnnotationResult {
  annotations: Annotation[]
  created: Annotation
}

/**
 * What a caller may say when creating a highlight (annex R5). No `id`, no timestamps, no
 * `type` and no `artifact`: those are the file's writer's to mint, and the artifact in
 * particular is not a fact the renderer is told or may name.
 */
export interface NewAnnotationInput {
  bookId: string
  /** The `ReaderFormat` the reader has open — what the artifact is resolved against. */
  format: ReaderFormat
  cfi: string
  quote: string
  prefix: string
  suffix: string
  percent: number
  sectionLabel: string | null
  /** Defaults to `DEFAULT_ANNOTATION_COLOR` when omitted. */
  color?: string
}
