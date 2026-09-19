import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MutableRefObject } from 'react'
import type { FoliateView } from '@vendor/foliate-js/view.js'
import { countHits, nextHit, runSearch, type SearchHit } from '@/lib/reader-search'
import { resolveReaderPalette } from '@/lib/theme/reader-palette'
import { useReaderStore } from '@/stores/reader.store'
import { useThemeStore } from '@/stores/theme.store'
import { CloseIcon, SearchIcon } from '@/components/shared/icons'

/**
 * In-book search — the third occupant of the reader's one side slot (D4).
 *
 * Thin on purpose, the same shape `ReaderAsk` has: what the engine's yields mean
 * and what a live run may write are decided in `src/lib/reader-search.ts`, where
 * vitest can decide them; the engine draws the hits; this file lays out the
 * input, the groups and the states, and owns the one thing that is genuinely
 * local — the run token that makes a superseded run stop writing.
 *
 * The engine is reached through the `viewRef` the parent already holds, because
 * a search is not a navigation: it *reads the whole book*, and only then does it
 * navigate. Passing a callback per action would have hidden that.
 */

type PanelKeyEvent = KeyboardEvent<HTMLElement>

export function ReaderSearch({ viewRef }: { viewRef: MutableRefObject<FoliateView | null> }) {
  const query = useReaderStore((s) => s.query)
  const searching = useReaderStore((s) => s.searching)
  const progress = useReaderStore((s) => s.progress)
  const results = useReaderStore((s) => s.results)
  const activeCfi = useReaderStore((s) => s.activeCfi)
  const theme = useReaderStore((s) => s.prefs.theme)
  /**
   * The app theme's tokens, read here because this is where the reader store is
   * already read — the resolver is a pure module and holds no store of its own
   * (D3). Resolved at *click* time rather than held: the handler is a callback,
   * so the palette it hands the run is the one the app is showing when the run
   * starts.
   */
  const tokens = useThemeStore((s) => s.view?.active.tokens ?? null)
  const setQuery = useReaderStore((s) => s.setQuery)
  const setSearchState = useReaderStore((s) => s.setSearchState)
  const clearSearch = useReaderStore((s) => s.clearSearch)
  const closeSearch = useReaderStore((s) => s.closeSearch)

  /** The run failed, as a sentence. Local, because a failed search is not a state of the book. */
  const [failure, setFailure] = useState<string | null>(null)
  /** The query the visible results belong to — what "No matches" is measured against. */
  const [ranQuery, setRanQuery] = useState<string | null>(null)

  const input = useRef<HTMLInputElement>(null)
  /**
   * Every run this panel started. Bumping it is what stops a run: the token
   * guard in `runSearch` breaks the generator's `for await` on the section it is
   * in the middle of, which is the only cancellation the engine offers (AC1.13).
   */
  const runToken = useRef(0)

  useEffect(() => {
    input.current?.focus()
  }, [])

  /**
   * The panel going away ends the run *and* the outlines: `search()` re-adds its
   * annotations on every section render, so anything still holding them would
   * come back the next time the reader turned the page (AC1.7).
   */
  useEffect(
    () => () => {
      runToken.current += 1
      try {
        viewRef.current?.clearSearch()
      } catch {
        /* nothing to clear — a torn-down view has dropped the map already */
      }
    },
    [viewRef]
  )

  /** Drop the run and its outlines, keep the panel. Escape's first step (AC1.6). */
  const clear = useCallback(() => {
    runToken.current += 1
    setRanQuery(null)
    setFailure(null)
    clearSearch()
    try {
      viewRef.current?.clearSearch()
    } catch {
      /* see above */
    }
  }, [clearSearch, viewRef])

  /**
   * The colour a run draws its hit outlines in — the derived link colour (D1),
   * resolved from the app's live tokens. Hoisted out of `start` so the watcher
   * below can tell when it moves.
   */
  const searchColour = resolveReaderPalette(theme, tokens).search

  const start = useCallback(async () => {
    const view = viewRef.current
    const text = query.trim()
    if (!view || !text) return

    const token = ++runToken.current
    const stale = () => runToken.current !== token
    setFailure(null)
    setRanQuery(text)

    const result = await runSearch(view, {
      query: text,
      // A resolved literal, never `var(--…)`: the outline is drawn in
      // foliate-view's closed shadow root, where a custom property is not
      // something this repo bets on.
      color: searchColour,
      isStale: stale,
      // A run that has been superseded must not write, even for its own state
      onState: (state) => {
        if (!stale()) setSearchState(state)
      }
    })
    if (result.outcome === 'failed') setFailure(result.message)
  }, [query, searchColour, viewRef, setSearchState])

  /**
   * The latest `start`, read through a ref: its identity changes with every
   * keystroke in the query box, and the watcher below has no business re-running
   * on those.
   */
  const startRef = useRef(start)
  useEffect(() => {
    startRef.current = start
  })

  /**
   * A theme change **with results on screen re-runs the search**, so the outlines
   * follow the theme the way the page and the links already do.
   *
   * The vendor draws annotations per run and keeps the options it was handed
   * (`view.js:545`'s `#searchDrawOptions`, re-applied on every section render), so
   * the outlines otherwise keep the colour of the run that drew them: measured,
   * flipping the app theme with five hits up left all ~1,780 orange pixels orange
   * against a page that had gone dark. That mismatch could not happen while the
   * reader's page palette was a pair of constants — it is a consequence of the
   * page now following the app theme, so the highlighting has to follow it too.
   *
   * Cheap and safe: the search runs in memory over the book that is already open
   * (which is why it works offline), `search()` clears its own annotations on
   * entry, and the token guard unwinds a run that is superseded by this one.
   * Keyed on the resolved colour rather than on the tokens, so a theme change
   * that leaves the link alone redraws nothing.
   */
  const drawnColour = useRef(searchColour)
  useEffect(() => {
    if (drawnColour.current === searchColour) return
    drawnColour.current = searchColour
    if (ranQuery) void startRef.current()
  }, [searchColour, ranQuery])

  const jumpTo = useCallback(
    (hit: SearchHit | null) => {
      if (!hit) return
      setSearchState({ activeCfi: hit.cfi })
      // The panel stays open: a search user is stepping through matches, not
      // going somewhere once — which is why this is not the TOC panel's
      // navigate-and-close behaviour
      void viewRef.current?.goTo(hit.cfi)
    },
    [setSearchState, viewRef]
  )

  /**
   * Enter and the button are one code path, the repo's rule for a control and
   * its shortcut. Its meaning depends on whether the results in front of the
   * reader answer the query in the box: an edited query re-runs (the old results
   * are for text nobody asked about any more), an unchanged one steps.
   */
  const submit = useCallback(() => {
    if (results.length > 0 && ranQuery === query.trim()) jumpTo(nextHit(results, activeCfi))
    else void start()
  }, [results, ranQuery, query, activeCfi, jumpTo, start])

  /**
   * The panel owns the keys while focus is inside it. Escape goes back out the
   * way the reader came in — results, then the panel, then the book (AC1.6) —
   * and every other unmodified key stops here, so Space on one of the panel's
   * own controls is a press rather than also a page turn underneath.
   */
  const onKeyDown = (e: PanelKeyEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (query.trim()) clear()
      else closeSearch()
      return
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation()
  }

  const hits = countHits(results)
  const noMatches = ranQuery !== null && !searching && !failure && results.length === 0
  const stepped = results.length > 0 && ranQuery === query.trim()

  return (
    <aside
      onKeyDown={onKeyDown}
      className="flex w-72 shrink-0 flex-col border-r border-ink-800 bg-ink-950"
    >
      <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-4">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
          Search
        </span>
        <button
          onClick={closeSearch}
          title="Close (Esc)"
          aria-label="Close search"
          className="rounded p-1 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="shrink-0 px-4 pb-2">
        <div className="flex items-center gap-1.5">
          <span className="text-parchment-faint">
            <SearchIcon className="h-3.5 w-3.5" />
          </span>
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            spellCheck={false}
            placeholder="Find in this book…"
            aria-label="Search this book"
            className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-[13px] text-parchment placeholder:text-parchment-faint focus:border-gold-500/50 focus:outline-none"
          />
          <button
            onClick={submit}
            disabled={!query.trim()}
            className="shrink-0 rounded-md border border-ink-600 px-2.5 py-1.5 text-[11px] text-parchment-dim transition-colors hover:border-gold-500/50 hover:text-gold-300 disabled:cursor-not-allowed disabled:border-ink-800 disabled:text-parchment-faint"
          >
            {stepped ? 'Next' : 'Find'}
          </button>
        </div>

        {/* The run's own progress, in the reader's thin gold idiom — and its
            count, which grows as sections are read */}
        {searching ? (
          <div className="pt-2">
            <div className="h-0.5 w-full overflow-hidden rounded bg-ink-800">
              <div
                className="h-full bg-gold-500 transition-[width] duration-200"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="pt-1 text-[11px] tabular-nums text-parchment-faint">
              {hits === 1 ? '1 match so far…' : `${hits} matches so far…`}
            </p>
          </div>
        ) : stepped ? (
          <p className="pt-2 text-[11px] tabular-nums text-parchment-faint">
            {hits === 1 ? '1 match' : `${hits} matches`}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {failure && (
          <p className="mx-4 mt-1 rounded-md border border-ink-700 px-2.5 py-1.5 text-[11px] leading-snug text-parchment-dim">
            {failure}
          </p>
        )}

        {noMatches && (
          <p className="px-5 pt-1 text-[13px] italic text-parchment-faint">
            No matches for “{ranQuery}”.
          </p>
        )}

        {results.map((group, i) => (
          <div key={`${group.label}-${i}`}>
            <div className="flex items-baseline justify-between gap-2 px-5 pb-1 pt-3">
              <span className="truncate text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
                {group.label}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-parchment-faint">
                {group.hits.length}
              </span>
            </div>
            <ul>
              {group.hits.map((hit) => (
                <li key={`${hit.cfi}-${hit.index}`}>
                  <button
                    onClick={() => jumpTo(hit)}
                    title={hit.excerpt.match}
                    className={`w-full border-l-2 px-4 py-1.5 text-left text-[12px] leading-snug transition-colors ${
                      hit.cfi === activeCfi
                        ? 'border-gold-500 bg-ink-900 text-parchment'
                        : 'border-transparent text-parchment-dim hover:bg-ink-900 hover:text-parchment'
                    }`}
                  >
                    {hit.excerpt.pre}
                    <span className="font-medium text-gold-300">{hit.excerpt.match}</span>
                    {hit.excerpt.post}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </aside>
  )
}
