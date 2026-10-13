/**
 * Highlights and notes' decisions, as pure functions.
 *
 * The engine does the drawing — `view.addAnnotation()` in the vendored
 * foliate-js (`vendor/foliate-js/view.js:368-398`), whose two arms and whose
 * draw functions are declared in `src/types/foliate-js.d.ts` — so nothing here
 * holds a `FoliateView`. What it owns is the four things that are ours, and
 * each is worth a test rather than an eyeball (`docs/superpowers/plans/2026-10-13-annotations-slice2.md`):
 *
 * 1. **What a selection becomes** (AC13, readings R9/R10): the six members a
 *    caller may say, normalized and capped, or a refusal.
 * 2. **What the engine is offered and what it refused** (AC14, AC16, R12): the
 *    plan drives a source, keeps a stale locator off the page entirely, and
 *    turns the engine's own throw into one undrawable id rather than a dead
 *    book. That throw is real, not defensive: `addAnnotation` destructures
 *    `resolveNavigation`'s `undefined` (`view.js:385`, `:446-459`).
 * 3. **What the resolved colour buys** (AC15, R14): the rows carry the colour
 *    and the kind, so a plan is a description of a page rather than a call.
 * 4. **What the panel shows** (R17): document order, grouped the way the find
 *    panel groups, by the label the section itself reported.
 *
 * Pure: no store, no React, no DOM. The renderer has no DOM test harness
 * (`tasks.md`, slice-4 debt), so the decisions live here where vitest can decide
 * them and only layout lives in the two components — the same split
 * `src/lib/reader-search.ts` uses, including its stub-source pattern for the
 * engine (`reader-search.ts:82-90`).
 */

import type { Annotation } from '@shared/annotation.types'
import { clipContext, clipQuote } from '@shared/annotation.types'
import { groupLabel } from './reader-search'

// ---------------------------------------------------------------------------
// A selection → a locator
// ---------------------------------------------------------------------------

/**
 * One captured selection, as the engine measured it.
 *
 * `prefix`/`suffix` are the text either side of the range, read out of the
 * section document by the engine with the same `Range.toString()` model
 * `sectionOffset` uses — the store never sees them, and neither does the ask
 * panel, whose selection is the text alone.
 */
export interface SelectionCapture {
  /** The selected text, trimmed. */
  quote: string
  /** The engine's own CFI for the range: `view.getCFI(index, range)`. */
  cfi: string
  /** The page's own fraction, as the relocator reported it (R11). */
  percent: number
  /** The section's own TOC label, or null. */
  sectionLabel: string | null
  /** The text immediately before the selection, or absent. */
  prefix?: string
  /** The text immediately after it, or absent. */
  suffix?: string
}

/**
 * What a caller may say when creating a highlight (slice 1's annex R5), key for
 * key: no `id`, no `type`, no timestamps and no `artifact` — those are the
 * file's writer's to mint, and the artifact is not a fact the renderer is told
 * or may name. `bookId` and `format` ride beside it, not in it: they are the
 * call's context rather than the record's.
 */
export interface AnnotationLocator {
  cfi: string
  quote: string
  prefix: string
  suffix: string
  percent: number
  sectionLabel: string | null
}

/** The engine's arithmetic is a fraction (`view.js:537`); anything else is a caller's bug. */
function clamp01(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * A selection becomes a locator, or it does not become one.
 *
 * **`null` rather than a partial record** (R9): the service refuses a blank
 * `cfi` or a whitespace-only `quote` one round trip later
 * (`electron/main/services/annotations.ts:342-345`), so a partial object here
 * would only move the refusal to a place that has to explain itself on a toast.
 * A bare caret and a folded selection are both this case.
 *
 * The quote and the context go through the file's own normalization and caps
 * (`clipQuote` / `clipContext`, `QUOTE_MAX` / `CONTEXT_MAX` in
 * `src/types/annotation.types.ts`) rather than through copies of them: the caps
 * are the file's shape, and the rule that the file is a whole-book read on open
 * is where they come from.
 */
export function annotationFromSelection(capture: SelectionCapture): AnnotationLocator | null {
  const cfi = typeof capture.cfi === 'string' ? capture.cfi.trim() : ''
  if (!cfi) return null

  const quote = clipQuote(typeof capture.quote === 'string' ? capture.quote : '')
  if (!quote) return null

  const label = typeof capture.sectionLabel === 'string' ? capture.sectionLabel.trim() : ''
  return {
    cfi,
    quote,
    prefix: clipContext(typeof capture.prefix === 'string' ? capture.prefix : ''),
    suffix: clipContext(typeof capture.suffix === 'string' ? capture.suffix : ''),
    percent: clamp01(capture.percent),
    sectionLabel: label || null
  }
}

// ---------------------------------------------------------------------------
// The draw plan
// ---------------------------------------------------------------------------

/**
 * The kinds this build's plan emits.
 *
 * One, because one is what it ships: a hit is an `outline` and is drawn by the
 * engine inside `search()` (`view.js:544`), never through `draw-annotation`, so
 * the two never share a row. The list exists as a *type's* source rather than as
 * a comment so that a second kind is a typecheck at every switch that reads one.
 */
export const ANNOTATION_DRAW_KINDS = ['highlight'] as const

export type AnnotationDrawKind = (typeof ANNOTATION_DRAW_KINDS)[number]

/** Whether a value that arrived from elsewhere is one of the kinds this build draws. */
export function isAnnotationDrawKind(value: unknown): value is AnnotationDrawKind {
  return typeof value === 'string' && (ANNOTATION_DRAW_KINDS as readonly string[]).includes(value)
}

/**
 * What the engine is handed for one annotation.
 *
 * `value` is the key the engine draws under and removes by (`view.js:389`), and
 * **the whole object rides through** into the `draw-annotation` event
 * (`view.js:392-393`), which is how the listener learns the kind and the colour
 * without a second map — the same trick the vendor's own highlight layer uses
 * with the bookmark's colour (`reader.js:178-182`).
 */
export interface DrawableAnnotation {
  value: string
  id: string
  kind: AnnotationDrawKind
  color: string
}

/**
 * The slice of `foliate-view` this module drives, structurally rather than by
 * importing it: a view that stops satisfying this stops typechecking at the call
 * site in `ReaderEngine.tsx`. `addAnnotation` resolves to `{ index, label }` and
 * **throws** when the locator does not resolve.
 */
export interface AnnotationSource {
  addAnnotation(annotation: DrawableAnnotation): Promise<unknown>
}

/** One annotation the engine accepted: the row is what the page now shows. */
export interface AnnotationDrawRow {
  id: string
  cfi: string
  kind: AnnotationDrawKind
  color: string
}

export interface AnnotationPlan {
  /** Offered *and* drawn, in document order. */
  rows: AnnotationDrawRow[]
  /** Ids the engine refused — spec D6's second guard, counted rather than swallowed. */
  undrawable: string[]
}

/** Document order: the fraction first, then the moment it was made (R17). */
export function byDocumentOrder(a: Annotation, b: Annotation): number {
  if (a.percent !== b.percent) return a.percent - b.percent
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
}

/**
 * Offer the book's highlights to the engine, once each, and report what it
 * would not take.
 *
 * **A stale one is never offered** (spec D6): it is filtered out, not caught —
 * the whole point of the identity comparison is that the `cfi` is not handed to
 * an engine that would resolve it onto a *different* sentence. A stale
 * annotation is therefore in neither list; it is the panel's to show, with its
 * quote.
 *
 * **A throw costs that annotation and never the book** (R12): the engine's own
 * re-add path calls this un-awaited and un-caught (`view.js:416`), so a single
 * unresolvable locator would otherwise take the section's whole re-add with it.
 * The id is recorded, and — the "never twice" half of AC14 — its position is
 * marked as offered, so a second record pointing at the same `cfi` does not
 * re-throw for it.
 *
 * `color` is an argument rather than a read, so the plan is a value: changing it
 * yields a different plan, which is the rule AC15 decides (R14).
 */
export async function planAnnotations(
  annotations: readonly Annotation[],
  color: string,
  source: AnnotationSource
): Promise<AnnotationPlan> {
  const rows: AnnotationDrawRow[] = []
  const undrawable: string[] = []
  const offered = new Set<string>()

  for (const annotation of [...annotations].sort(byDocumentOrder)) {
    if (annotation.stale) continue
    if (offered.has(annotation.cfi)) continue
    offered.add(annotation.cfi)
    try {
      await source.addAnnotation({
        value: annotation.cfi,
        id: annotation.id,
        kind: 'highlight',
        color
      })
      rows.push({ id: annotation.id, cfi: annotation.cfi, kind: 'highlight', color })
    } catch {
      undrawable.push(annotation.id)
    }
  }

  return { rows, undrawable }
}

/**
 * What the page is still showing that the book no longer holds.
 *
 * The one thing a re-run cannot do (R13): the engine's own re-add removes the
 * value it is about to add (`overlayer.remove(value)`, `view.js:389`), so
 * re-offering is idempotent — but a *deleted* highlight is never re-offered, and
 * its rect would sit on the page until the section was rebuilt. These are the
 * values to hand `deleteAnnotation`.
 */
export function removedValues(
  previous: readonly AnnotationDrawRow[],
  next: readonly AnnotationDrawRow[]
): string[] {
  const kept = new Set(next.map((row) => row.cfi))
  return previous.filter((row) => !kept.has(row.cfi)).map((row) => row.cfi)
}

// ---------------------------------------------------------------------------
// The panel's list
// ---------------------------------------------------------------------------

export interface AnnotationGroup {
  label: string
  items: Annotation[]
}

/**
 * The panel's list: document order, grouped by the label the section itself
 * reported.
 *
 * The grouping is the find panel's, reused rather than re-decided
 * (`groupLabel`, `reader-search.ts:154-156`): the engine reports an **empty**
 * label for a section the book's TOC does not name, and a wall of blank headers
 * is worse than no grouping, so one is named by its position among the groups.
 * `null` is that same case arriving from the file, where slice 1 stores the
 * absent label as `null` rather than as `''`.
 */
export function annotationGroups(annotations: readonly Annotation[]): AnnotationGroup[] {
  const groups: AnnotationGroup[] = []
  for (const annotation of [...annotations].sort(byDocumentOrder)) {
    const label = groupLabel(annotation.sectionLabel ?? '', groups.length + 1)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(annotation)
    else groups.push({ label, items: [annotation] })
  }
  return groups
}
