import { useEffect, useMemo, useRef, useState } from 'react'
import type { CoverCandidate, MetadataSource } from '@shared/metadata.types'
import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { coverTiles, sameCandidate, searchedCoverTiles, tileKey } from '@/lib/cover-candidate-state'
import type { CandidateTile } from '@/lib/cover-candidate-state'
import { useDialogFocus } from '@/hooks/useDialogFocus'
import { CheckIcon, CloseIcon, LockIcon, SearchIcon, SpinnerIcon } from '@/components/shared/icons'

/**
 * Choosing which jacket a book wears.
 *
 * One modal, opened from the detail panel's cover block (and from the context
 * menu), mounted in `App.tsx` under a per-book key like `BookEditor`. It reads
 * two payloads — `metadata.coverCandidates`, the gather the 2026-09-21 spec's
 * slice 1b built, and `metadata.searchCovers`, the wider search slice 3a-ii put
 * behind a press (2026-09-25 design, D2) — calls one write, and calls one
 * release. No new channel, no new type, and nothing below the renderer changes.
 *
 * Three things it is careful about, each because the alternative was a lie:
 * the candidates' images arrive as `data:` URLs from the sidecar (the renderer's
 * CSP names no remote origin, so a remote `<img>` renders blank while the DOM
 * looks right); a pick **locks** the field, because that is what stops the next
 * fetch from putting back the jacket someone just replaced; and the tiles say
 * what is on the book *now*, never "the one you chose" — the cover's source is
 * recorded nowhere, so a cover resolved from a conflict or replaced outside the
 * app reads as none of these.
 *
 * The searched group is where that care costs the most, because its tiles look
 * exactly like the gather's and mean less: a searched hit came from a question
 * no fetch asks, so it is never a `winner`, is never applied by anything but a
 * press, and the group says so in its own words. Both groups' sentences and
 * marks come from `src/lib/cover-candidate-state.ts` rather than from here, for
 * the reason every rule in this app is kept out of a `.tsx`: the renderer has no
 * DOM harness, but a rule in a plain module can still be decided by a unit test.
 */

/**
 * The picker's own vocabulary, which is deliberately not the review queue's.
 *
 * The queue's `Embedded (EPUB)` is wrong here twice over: a book can be a
 * MOBI, an AZW3 or a PDF, and — the real reason — the queue's candidate list is
 * URL-bearing only, so its `embedded` label has never been rendered for a
 * cover. The three names the two surfaces *do* share are spelled identically.
 */
const SOURCE_LABELS: Record<string, string> = {
  embedded: 'The cover inside your file',
  google_books: 'Google Books',
  openlibrary: 'OpenLibrary',
  calibre: 'Calibre',
  goodreads: 'Goodreads'
}

/**
 * One candidate as a tile. The same control for both groups on purpose: a pick
 * has to mean the same thing in either, and two near-identical blocks of markup
 * are how the two groups would drift apart.
 */
function TileButton({
  tile,
  busy,
  onPick
}: {
  tile: CandidateTile
  /** The candidate being written right now, if any: every tile waits for it. */
  busy: CoverCandidate | null
  onPick: (candidate: CoverCandidate) => void
}) {
  const { candidate, mark, label } = tile
  const onBook = mark === 'applied' || mark === 'both'
  const writing = busy !== null && sameCandidate(busy, candidate)

  return (
    <button
      disabled={busy !== null}
      onClick={() => onPick(candidate)}
      className={`group flex flex-col items-center gap-2 rounded-md border bg-ink-800 p-3 transition-colors disabled:opacity-60 ${
        onBook ? 'border-gold-500/50' : 'border-ink-600 hover:border-gold-500/60 hover:bg-ink-700'
      }`}
    >
      <span className="flex h-40 w-full items-center justify-center">
        {/* `object-contain`, not the card's `object-cover`: this is the one
            surface where seeing the whole image matters — a jacket that is a
            wraparound spread would otherwise be shown as a centre crop of
            itself */}
        <img
          src={candidate.thumb}
          alt=""
          className="max-h-40 max-w-full rounded shadow-cover"
          draggable={false}
        />
      </span>
      <span className="flex w-full items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-parchment-faint group-hover:text-gold-400">
        {writing && <SpinnerIcon className="h-3 w-3" />}
        {onBook && <CheckIcon className="h-3 w-3 text-gold-400" />}
        <span className="truncate">{SOURCE_LABELS[candidate.source] ?? candidate.source}</span>
      </span>
      <span className="w-full text-[11px] text-parchment-faint">
        {candidate.width}×{candidate.height}
        {label && <span className="text-parchment-dim"> · {label}</span>}
      </span>
    </button>
  )
}

export function CoverPicker() {
  const dialogRef = useDialogFocus()
  const bookId = useUIStore((s) => s.coverPickerBookId)
  const requestCoverPicker = useUIStore((s) => s.requestCoverPicker)
  const books = useLibraryStore((s) => s.books)
  const load = useLibraryStore((s) => s.load)

  const book = useMemo(() => books.find((b) => b.id === bookId) ?? null, [books, bookId])

  /**
   * The gather's payload, or null while it is on its way. Live and stored
   * nowhere: it is recomputed on every open, so a jacket URL that has rotted
   * since the last fetch cannot be offered as a choice.
   */
  const [candidates, setCandidates] = useState<CoverCandidate[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * The searched group — the wider search's payload, and **component** state on
   * purpose: the dialog mounts keyed per book, so no second book can inherit a
   * search and nothing outside the dialog needs the list (2026-09-25 design,
   * "Store and component shape"). `null` is "not asked, or still asking", which
   * is exactly how the derivation reads it: `searchedCoverTiles` gives it no
   * sentence at all, because "nothing asked", "still asking" and "came back
   * empty" are the same empty array (the slice-2 defect, one level down).
   */
  const [searched, setSearched] = useState<CoverCandidate[] | null>(null)
  /** True only while the search is in flight — the one thing `null` cannot say. */
  const [searching, setSearching] = useState(false)
  /**
   * A search that refused, in the service's own words. Kept apart from the
   * gather's `error` because they are different findings: a search that could
   * not run must not read as a gather that found nothing, and the group's
   * "no covers came back" sentence is reserved for a search that really ran.
   */
  const [searchError, setSearchError] = useState<string | null>(null)
  /**
   * Every search this dialog started. Bumping it is what makes a late answer
   * harmless — the instrument `ReaderSearch` uses for its runs, needed here for
   * the same reason: the dialog is closed by unmounting, so a search landing
   * after the close would set state on a component that is gone. It also lets a
   * second press win outright over the first.
   */
  const searchRun = useRef(0)

  /**
   * The candidate being written right now, or the one being reported — held as
   * the candidate itself, not as its `source`, because one source can answer
   * twice in the searched group (see `sameCandidate`).
   */
  const [busy, setBusy] = useState<CoverCandidate | null>(null)
  /** True once a choice of this session landed, for the confirmation line. */
  const [chosen, setChosen] = useState<MetadataSource | null>(null)
  /**
   * The candidate this session wrote, if it wrote one — and why no tile is
   * marked from a payload's own `applied` once a pick has landed: both payloads
   * were scored against the bytes that were on disk *before* the write, so every
   * one of their flags is stale at that moment, and byte identity is not
   * something this component can recompute.
   */
  const [picked, setPicked] = useState<CoverCandidate | null>(null)
  /**
   * Whether `cover` is one of the fields this book's fetches must not touch.
   * Read when the panel opens (it is mounted under a per-book key, so each book
   * reads its own) and the release is the only thing that changes it from here.
   */
  const [held, setHeld] = useState(false)

  useEffect(() => {
    if (!bookId) return
    let live = true
    // No reset of the local state here: the dialog is mounted under a per-book
    // key (`App.tsx`) and unmounted when it closes, so every open starts from
    // the initial values — and a `setState` in an effect body would cascade a
    // render for a state that cannot be stale.

    void window.Musaeum.metadata
      .coverCandidates(bookId)
      .then((found) => {
        if (live) setCandidates(found)
      })
      .catch((err: unknown) => {
        // The service's own sentence: offline, no metadata engine, no readable
        // file in the folder. A gather that cannot run says *why* — an empty
        // grid would read as a book with no options (AC16)
        if (live) setError(err instanceof Error ? err.message : String(err))
      })

    void window.Musaeum.library
      .getFieldOverrides(bookId)
      .then((fields) => {
        // Losing this only costs the marker: the override itself is enforced in
        // the main process, not here
        if (live) setHeld(fields.includes('cover'))
      })
      .catch(() => {
        if (live) setHeld(false)
      })

    return () => {
      live = false
    }
  }, [bookId])

  const close = () => requestCoverPicker(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /**
   * Closing the dialog ends any search in flight: the run token moves, so the
   * answer that arrives afterwards is dropped instead of setting state on a
   * component that is gone. A *write* is the other way round — Escape waits for
   * it (above), because a write is a filesystem operation and a search is only a
   * question.
   */
  useEffect(
    () => () => {
      searchRun.current += 1
    },
    []
  )

  const choose = async (candidate: CoverCandidate): Promise<void> => {
    if (!book) return
    setBusy(candidate)
    setError(null)
    try {
      await window.Musaeum.metadata.setCover(book.id, {
        source: candidate.source,
        // Absent for `embedded`, and the main process refuses a url beside it:
        // the file's own jacket is re-extracted, never fetched
        url: candidate.url
      })
      // The write is byte identity, so the payload's own rule can be applied
      // here without a second gather: the candidate just written *is* what
      // `cover_full.jpg` holds now. It is remembered as the candidate, not as
      // its source, and both groups then read `applied` off it — which is what
      // keeps a pick in one group from checking a tile in the other, or the
      // second volume under the same source (see `sameCandidate`).
      setPicked(candidate)
      setChosen(candidate.source)
      // A choice is the user's decision: the service marks the field, and this
      // is the surface that shows it held and hands it back (AC14)
      setHeld(true)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Ask the wider question (D2): the ISBNs the row is known by, then the work's
   * other ISBNs, then the title and author. Press-triggered and never on open,
   * because this is the question a *fetch* must not ask (D1) — Google's jackets
   * outrank OpenLibrary's by construction, so a fetch that asked it would flip
   * the applied cover for every book whose stored ISBN misses Google, on the
   * next re-fetch, across the library, with no review.
   *
   * Every press re-asks the network: nothing is cached and nothing is persisted
   * (D4), so what the group shows is a function of the book and not of this
   * dialog's history.
   */
  const lookFurther = async (): Promise<void> => {
    if (!book || searching) return
    const run = ++searchRun.current
    const stale = () => searchRun.current !== run
    setSearching(true)
    setSearchError(null)
    // Dropped rather than kept under the spinner: the group has three states to
    // keep apart (still asking / nothing answered / tiles), and a stale list
    // with a spinner over it is none of them.
    setSearched(null)
    try {
      const hits = await window.Musaeum.metadata.searchCovers(book.id)
      if (!stale()) setSearched(hits)
    } catch (err) {
      // The service's own sentence, as the gather's refusal is: offline, no
      // metadata engine, no readable file in the folder. It goes in its own
      // line rather than in the group's notice, because it is not the finding
      // that no covers exist — the app cannot know that.
      if (!stale()) setSearchError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!stale()) setSearching(false)
    }
  }

  const release = async (): Promise<void> => {
    if (!book) return
    try {
      const fields = await window.Musaeum.library.releaseFieldOverride(book.id, 'cover')
      setHeld(fields.includes('cover'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * A candidate as this session leaves it: once a pick has landed, what it wrote
   * is what the book wears — whatever the payload that carried it said when it
   * arrived. Identity is the pair, never the source (see `sameCandidate`).
   */
  const withPick = (candidate: CoverCandidate): CoverCandidate =>
    picked === null ? candidate : { ...candidate, applied: sameCandidate(candidate, picked) }

  // Above the early return: a hook below it would be conditional. No `useMemo`
  // either — a handful of candidates and one sentence recomputed per render is
  // cheaper than the dependency bookkeeping.
  const { tiles, notice } = coverTiles(candidates?.map(withPick) ?? null)
  const { tiles: searchTiles, notice: searchNotice } = searchedCoverTiles(
    searched?.map(withPick) ?? null
  )

  if (!book) return null

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
      onClick={() => !busy && close()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Choose a cover for ${book.title}`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-cover-lift"
      >
        <div className="flex shrink-0 items-start justify-between border-b border-ink-800 px-5 py-4">
          <div className="min-w-0">
            <h2 className="font-display text-lg leading-snug text-parchment">Choose a cover</h2>
            <p className="mt-0.5 truncate text-[12px] text-parchment-faint">{book.title}</p>
          </div>
          <button
            onClick={close}
            className="rounded p-1 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
            aria-label="Close"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {candidates === null && !error && (
            <p className="flex items-center justify-center gap-2 py-10 text-[13px] text-parchment-dim">
              <SpinnerIcon className="h-4 w-4" />
              Looking for covers…
            </p>
          )}

          {notice && (
            <p className="mb-3 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-[12px] leading-relaxed text-parchment-dim">
              {notice}
            </p>
          )}

          {tiles.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {tiles.map((tile) => (
                <TileButton
                  key={tileKey(tile.candidate)}
                  tile={tile}
                  busy={busy}
                  onPick={(candidate) => void choose(candidate)}
                />
              ))}
            </div>
          )}

          {held && (
            <p className="mt-3 flex items-start gap-2 rounded-md border border-gold-500/25 bg-gold-500/5 px-3 py-2 text-[12px] leading-relaxed text-parchment-dim">
              <LockIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold-400" />
              <span>
                Held: a metadata fetch will not change this cover.{' '}
                <button
                  onClick={() => void release()}
                  className="text-gold-400 underline decoration-gold-500/40 hover:decoration-gold-400"
                >
                  Hand it back to Musaeum
                </button>{' '}
                and the next one may replace it.
              </span>
            </p>
          )}

          {chosen && (
            <p className="mt-3 text-[12px] text-parchment-dim">
              <span className="text-parchment">{SOURCE_LABELS[chosen] ?? chosen}</span> is now the
              cover on this book.
            </p>
          )}

          {error && <p className="mt-3 text-[12px] text-danger-400">{error}</p>}

          {/*
            The second source: the wider search (2026-09-25 design, D2), asked by
            this button and by no fetch — which is the whole of D1. It sits after
            the gather's tiles and shows in both of the gather's states, because
            the state it exists for is the one where the gather offered nothing
            the book should wear.
          */}
          <div className="mt-4 border-t border-ink-800 pt-3">
            <button
              onClick={() => void lookFurther()}
              disabled={busy !== null || searching}
              className="flex items-center gap-2 rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim transition-colors hover:border-gold-500/60 hover:text-parchment disabled:opacity-60"
            >
              {searching ? (
                <SpinnerIcon className="h-3.5 w-3.5" />
              ) : (
                <SearchIcon className="h-3.5 w-3.5" />
              )}
              Look for more covers
            </button>
            <p className="mt-1.5 text-[12px] leading-relaxed text-parchment-faint">
              Searches this book’s other editions — by their ISBNs, then by title and author.
            </p>

            {/* A search in flight gets a spinner and nothing else: `null` is
                "not back yet", and "not back yet" must never read as "found
                nothing" — the rule `searchedCoverTiles` holds to as well */}
            {searching && (
              <p className="mt-2 flex items-center gap-2 text-[12px] text-parchment-dim">
                <SpinnerIcon className="h-3.5 w-3.5" />
                Searching this book’s other editions…
              </p>
            )}

            {searched !== null && (
              <div className="mt-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-parchment-faint">
                  From a wider search
                </h3>
                {/* The group's standing, said where the group is: these came from
                    a question no fetch asks, so a fetch would not write one of
                    them. The gather's tiles carry a mark for that; these cannot
                    carry one, so they say it in words (D3) */}
                <p className="mt-1 text-[12px] leading-relaxed text-parchment-dim">
                  Found by asking this book’s other editions, not by the gather. A fetch would not
                  write any of them — nothing changes unless you pick one.
                </p>
                {searchNotice && (
                  <p className="mt-2 text-[12px] leading-relaxed text-parchment-dim">
                    {searchNotice}
                  </p>
                )}
                {searchTiles.length > 0 && (
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    {searchTiles.map((tile) => (
                      <TileButton
                        key={tileKey(tile.candidate)}
                        tile={tile}
                        busy={busy}
                        onPick={(candidate) => void choose(candidate)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {searchError && <p className="mt-2 text-[12px] text-danger-400">{searchError}</p>}
          </div>
        </div>

        <div className="shrink-0 border-t border-ink-800 px-5 py-3 text-right">
          <button
            onClick={close}
            className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim transition-colors hover:border-gold-500/60 hover:text-parchment"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
