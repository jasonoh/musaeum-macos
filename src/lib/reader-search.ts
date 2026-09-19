/**
 * In-book search's decisions, as pure functions.
 *
 * The engine does the searching — `view.search()` in the vendored foliate-js
 * (`vendor/foliate-js/view.js:542`), whose signature is declared in
 * `src/types/foliate-js.d.ts` — so nothing here walks the book's text. What it
 * owns is the three things that are ours, and each is worth a test rather than
 * an eyeball:
 *
 * 1. **What the generator's yields mean.** It interleaves three shapes —
 *    `{ progress }`, `{ label, subitems }` and the bare string `'done'` — and
 *    discriminating by shape is all the engine gives us.
 * 2. **What a live run may write** (AC1.13). `search()` calls `clearSearch()`
 *    first, so a second run's highlights are the only ones on the page: a
 *    superseded run still writing into the store would show hits for a query
 *    that is no longer displayed. Hence the token guard, which is load-bearing
 *    rather than defensive, and the reason it is here instead of in the panel.
 * 3. **Where the next hit is** — Enter's job once results are showing.
 *
 * Pure: no store, no React, no DOM. The renderer has no DOM test harness
 * (`tasks.md`, slice-4 debt), so the loop lives here where vitest can decide it
 * and only layout lives in `ReaderSearch.tsx`. The engine itself is deliberately
 * not tested — it is vendored and locked (invariant #11) — which is the same
 * split `reading-state.ts` and `ask-session.ts` use.
 */

// ---------------------------------------------------------------------------
// What the engine hands back
// ---------------------------------------------------------------------------

/** One hit's context, already trimmed to ~50 characters either side (`search.js:6-21`). */
export interface SearchExcerpt {
  pre: string
  match: string
  post: string
}

/** A hit, and the place it holds in the result list. */
export interface SearchHit {
  cfi: string
  excerpt: SearchExcerpt
  /** 0-based, counted across the whole book in spine order. */
  index: number
}

/** One section that matched. Its label may be empty — see `groupLabel`. */
export interface SearchGroup {
  label: string
  hits: SearchHit[]
}

/** Everything one run produces. Session-only, never persisted (D6). */
export interface SearchState {
  /** A run is in flight. */
  searching: boolean
  /** 0..1 while searching: the engine's own section progress. */
  progress: number
  results: SearchGroup[]
}

export const EMPTY_SEARCH: SearchState = { searching: false, progress: 0, results: [] }

/** A run that has just started: the previous results are replaced, not appended to. */
export function startSearch(): SearchState {
  return { searching: true, progress: 0, results: [] }
}

/** Whole-book search, outlined in a colour the reader resolved itself (D3, D4). */
export interface SearchOptions {
  query: string
  drawOptions?: { color?: string; width?: number; radius?: number }
}

/** A section's hits as the engine yields them, before we number them. */
export interface SearchSectionHits {
  label: string
  subitems: { cfi: string; excerpt: SearchExcerpt }[]
}

/** The three shapes `view.search()` interleaves. */
export type SearchYield = { progress: number } | SearchSectionHits | 'done'

/**
 * The slice of `foliate-view` this module drives, structurally rather than by
 * importing it: the engine's own declarations live in
 * `src/types/foliate-js.d.ts`, and the call site in `ReaderSearch.tsx` is what
 * keeps the two honest — a view that stops satisfying this stops typechecking.
 */
export interface SearchSource {
  search(opts: SearchOptions): AsyncGenerator<SearchYield, void, void>
}

// ---------------------------------------------------------------------------
// Yields → events
// ---------------------------------------------------------------------------

export type SearchEvent =
  | { type: 'progress'; progress: number }
  | { type: 'hits'; label: string; hits: { cfi: string; excerpt: SearchExcerpt }[] }
  | { type: 'done' }

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toExcerpt(value: unknown): SearchExcerpt {
  const e = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return { pre: text(e.pre), match: text(e.match), post: text(e.post) }
}

/**
 * Discriminate one yield. The consumer has no other signal than its shape:
 * a string is the terminator, `progress` is the section counter, `subitems` is
 * a section's hits.
 *
 * A yield we do not recognise is ignored rather than thrown on. The engine is
 * someone else's JavaScript and an unexpected shape there is not a failure of
 * the reader (invariant #12) — the alternative throws away a whole book's
 * results over one malformed hit.
 */
export function parseSearchYield(value: unknown): SearchEvent | null {
  if (value === 'done') return { type: 'done' }
  if (typeof value !== 'object' || value === null) return null

  if ('progress' in value) {
    const { progress } = value as { progress: unknown }
    return typeof progress === 'number' ? { type: 'progress', progress } : null
  }

  if ('subitems' in value) {
    const { label, subitems } = value as { label?: unknown; subitems?: unknown }
    if (!Array.isArray(subitems)) return null
    const hits = subitems
      .filter((hit): hit is { cfi: string } => {
        const cfi = (hit as { cfi?: unknown } | null)?.cfi
        return typeof cfi === 'string'
      })
      .map((hit) => ({
        cfi: hit.cfi,
        excerpt: toExcerpt((hit as { excerpt?: unknown }).excerpt)
      }))
    return { type: 'hits', label: text(label), hits }
  }

  return null
}

/**
 * A group's header. The engine yields the section's TOC label and an **empty
 * string** when the book's TOC has none (`view.js:564`), and a wall of blank
 * headers is worse than no grouping — so a label-less section is named by its
 * position among the sections that matched.
 */
export function groupLabel(label: string, ordinal: number): string {
  return label.trim() || `Part ${ordinal}`
}

/** How many hits a set of groups holds — the panel's count while a run streams. */
export function countHits(results: readonly SearchGroup[]): number {
  return results.reduce((total, group) => total + group.hits.length, 0)
}

/** The engine's own arithmetic is `(index + 1) / sections.length` (`view.js:534`). */
function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * Fold one event into the run.
 *
 * Identity is preserved whenever an event changes nothing — a section with no
 * hits, a second terminator — so a subscriber is not notified for a state it
 * already has. That is the same rule the ask stream's reducer follows, and here
 * it is what keeps a run over a 400-section book from re-rendering the panel for
 * the ~390 sections that matched nothing.
 */
export function applySearchEvent(state: SearchState, event: SearchEvent): SearchState {
  switch (event.type) {
    case 'progress': {
      const progress = clamp01(event.progress)
      return progress === state.progress ? state : { ...state, progress }
    }
    case 'hits': {
      if (event.hits.length === 0) return state
      // Numbered from the whole run so a hit's `index` means the same thing in
      // the list and in the store, however the groups are sliced for display.
      const offset = countHits(state.results)
      const hits = event.hits.map((hit, i) => ({ ...hit, index: offset + i }))
      return {
        ...state,
        results: [
          ...state.results,
          { label: groupLabel(event.label, state.results.length + 1), hits }
        ]
      }
    }
    case 'done':
      return state.searching ? { ...state, searching: false } : state
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface SearchRunOptions {
  query: string
  /** The resolved outline colour (D4) — a literal from the reader's palette. */
  color: string
  /**
   * True once this run has been superseded: by a newer search, the panel
   * closing, or the reader closing. Checked between yields; a stale run stops
   * emitting, and unwinds the generator it is inside.
   */
  isStale: () => boolean
  /** The whole run's state after every change, starting with `startSearch()`. */
  onState: (state: SearchState) => void
}

export type SearchRunResult =
  { outcome: 'done' } | { outcome: 'stale' } | { outcome: 'failed'; message: string }

/**
 * Drive one whole-book search (D3 — `index` is never set).
 *
 * **Cancellation is a token, not an abort.** The generator has no
 * `AbortController`; breaking the `for await` is what stops it — including the
 * section `createDocument()` it is in the middle of, which is the part of AC1.14
 * that is measured rather than assumed.
 *
 * A run that ends any way other than stale leaves the state settled, so a
 * failure cannot leave the panel claiming to search forever.
 */
export async function runSearch(
  source: SearchSource,
  opts: SearchRunOptions
): Promise<SearchRunResult> {
  const query = opts.query.trim()
  // An empty query is not a search: the matcher would match at every position in
  // the book. Refused here, before a generator exists at all.
  if (!query) return { outcome: 'done' }

  let state = startSearch()
  opts.onState(state)

  try {
    for await (const value of source.search({ query, drawOptions: { color: opts.color } })) {
      if (opts.isStale()) return { outcome: 'stale' }
      const event = parseSearchYield(value)
      if (!event) continue
      const next = applySearchEvent(state, event)
      if (next !== state) {
        state = next
        opts.onState(state)
      }
      if (event.type === 'done') return { outcome: 'done' }
    }

    // The engine always ends with `'done'`; a sequence that does not is still the
    // end of the run, and the panel must stop saying "searching" either way.
    if (opts.isStale()) return { outcome: 'stale' }
    if (state.searching) opts.onState({ ...state, searching: false })
    return { outcome: 'done' }
  } catch (err) {
    if (opts.isStale()) return { outcome: 'stale' }
    opts.onState({ ...state, searching: false })
    return { outcome: 'failed', message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The next hit after the active one, wrapping to the first. Enter's job with
 * results showing.
 *
 * Wrapping is the reading the spec left open: without it, Enter on the last hit
 * silently does nothing, which reads as a broken key rather than as the end of
 * the list. The panel's own count is what says where you are.
 */
export function nextHit(
  results: readonly SearchGroup[],
  activeCfi: string | null
): SearchHit | null {
  const hits = results.flatMap((group) => group.hits)
  if (hits.length === 0) return null
  const at = activeCfi ? hits.findIndex((hit) => hit.cfi === activeCfi) : -1
  return hits[(at + 1) % hits.length]
}
