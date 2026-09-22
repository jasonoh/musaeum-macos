import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AiChunkEvent, AiDoneEvent, AiErrorEvent } from '@shared/ai.types'
import type { Book, BookFormat } from '@shared/book.types'
import { primaryFormat, readableFormat } from '@shared/book.types'
import type { AskRung } from '@/lib/ask-context'
import {
  appendProbeDelta,
  effectiveRung,
  EMPTY_ASK_SESSION,
  probeVerdict,
  reduceAsk,
  type AskProbe,
  type AskSession
} from '@/lib/ask-session'
import type { RecallVerdict } from '@/lib/recall'
// The reader's page theme is the palette module's type, so the store, the
// resolver and the two rows cannot drift into three spellings of one union.
import type { ReaderPageTheme } from '@/lib/theme/reader-palette'
import { EMPTY_SEARCH, type SearchGroup } from '@/lib/reader-search'

export interface ReaderTocItem {
  label: string
  href: string
  /** Nesting level in the book's own TOC; the panel indents by it. */
  depth?: number
}

/**
 * The section being rendered, as the engine reports it on `load`.
 *
 * Both halves are kept rather than the text alone: the callback identifies a
 * *section*, and the spine index is what a session-keyed cache (the deferred
 * item in D8) would key on. Nothing else may derive it — `tocItem.label` is
 * the reader's index into the book, and a section index is ours.
 */
export interface ReaderSection {
  index: number
  text: string
}

export type ReaderStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ReaderPrefs {
  typeface: 'serif' | 'sans'
  fontSize: number // px
  lineHeight: number
  margin: number // px
  theme: ReaderPageTheme
}

export const DEFAULT_PREFS: ReaderPrefs = {
  typeface: 'serif',
  fontSize: 18,
  lineHeight: 1.6,
  margin: 48,
  // The app theme, by default: the reader's chrome *is* app chrome, so a page
  // that disagreed with the frame around it would be the same defect the reader's
  // z-index history warns about.
  theme: 'auto'
}

/**
 * The choices the popover offers, labelled — and, because they are the same
 * lists `sanitizePrefs` validates against, a value the UI cannot produce is
 * also a value storage cannot smuggle in.
 */
export const TYPEFACE_OPTIONS: readonly { value: ReaderPrefs['typeface']; label: string }[] = [
  { value: 'serif', label: 'Serif' },
  { value: 'sans', label: 'Sans' }
]

/**
 * `auto` first because it is the default and the one the page usually is;
 * `ink` and `paper` stay as they were, so a stored `'ink'` keeps meaning exactly
 * what it meant before this slice (AC5.3). This list and `sanitizePrefs`'s
 * validator are extended together — that is what the shared-list comment above
 * is for, and widening one without the other is how a control ends up producing
 * a value storage rejects.
 */
export const THEME_OPTIONS: readonly { value: ReaderPrefs['theme']; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'ink', label: 'Ink' },
  { value: 'paper', label: 'Paper' }
]

/** Slider bounds, shared with the popover so a control can't produce a value
 *  the validator would reject — or reject one the control still shows. */
export const PREF_RANGES = {
  fontSize: { min: 12, max: 28, step: 1 },
  lineHeight: { min: 1.2, max: 2.2, step: 0.1 },
  margin: { min: 16, max: 160, step: 8 }
} as const

function oneOf<T extends string>(options: readonly { value: T }[], value: unknown, fallback: T): T {
  return options.find((o) => o.value === value)?.value ?? fallback
}

function inRange(
  value: unknown,
  { min, max }: { min: number; max: number },
  fallback: number
): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback
}

/**
 * Every pref, checked one field at a time. `localStorage` is only as
 * trustworthy as the build that wrote it — a renamed theme or a hand-edited
 * entry can hand back a string `fontSize` or an out-of-union `theme`, and both
 * the popover and the CSS the engine injects consume these unchecked. A bad
 * field falls back to its default rather than discarding the whole object, so
 * one stale value can't cost someone the rest of their typography.
 */
export function sanitizePrefs(value: unknown): ReaderPrefs {
  const p = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof ReaderPrefs, unknown>
  >
  return {
    typeface: oneOf(TYPEFACE_OPTIONS, p.typeface, DEFAULT_PREFS.typeface),
    theme: oneOf(THEME_OPTIONS, p.theme, DEFAULT_PREFS.theme),
    fontSize: inRange(p.fontSize, PREF_RANGES.fontSize, DEFAULT_PREFS.fontSize),
    lineHeight: inRange(p.lineHeight, PREF_RANGES.lineHeight, DEFAULT_PREFS.lineHeight),
    margin: inRange(p.margin, PREF_RANGES.margin, DEFAULT_PREFS.margin)
  }
}

interface ReaderState {
  bookId: string | null
  format: BookFormat | null
  status: ReaderStatus
  error: string | null
  toc: ReaderTocItem[]
  percent: number
  tocOpen: boolean
  /** Typography panel — session state like `tocOpen`, never persisted. */
  prefsOpen: boolean
  prefs: ReaderPrefs

  /**
   * The ask panel. It shares the reader's one side slot rather than getting one
   * of its own, so it is a session flag exactly like `tocOpen` — and opening any
   * of the three occupants closes the other two (D4). The transcript is *not*
   * cleared by closing the panel: it belongs to the book, and the book's own
   * open/close are what end it (D8).
   */
  askOpen: boolean
  /** The last `tocItem.label` the engine reported — an index, never a chapter number (D5). */
  sectionLabel: string | null
  /** The section currently rendered, text and all. The passage rung's only source. */
  section: ReaderSection | null
  /** The reader's live selection — the one thing sent verbatim (D5). */
  selection: string | null
  /** The probe's verdict for this book this session. Null means "not probed yet". */
  askVerdict: RecallVerdict | null
  /** The composer's "send the passage too" switch. It can widen the payload, never narrow it. */
  askOverride: boolean
  /** What will actually be sent: `effectiveRung(askVerdict, askOverride)`. */
  askRung: AskRung
  /** The transcript and its stream. Written only through `reduceAsk`. */
  askSession: AskSession
  /** The probe in flight, or null. Its reply accumulates here and is never rendered. */
  askProbe: AskProbe | null

  /**
   * The search panel — the third occupant of the one side slot, and session
   * state like the other two. `query` is the input's text, which is *not* the
   * query that was run: the run's own results are the only record of what was
   * searched for. Nothing here is persisted (D6), so reopening a book starts
   * with an empty panel (AC1.8).
   */
  searchOpen: boolean
  query: string
  /** A run is in flight. Its progress and results arrive through `setSearchState`. */
  searching: boolean
  progress: number
  results: SearchGroup[]
  /** The hit the reader last jumped to — the anchor Enter steps on from. */
  activeCfi: string | null

  openBook(book: Book): void
  close(): void
  setStatus(status: ReaderStatus, error?: string | null): void
  setToc(toc: ReaderTocItem[]): void
  setPercent(percent: number): void
  toggleToc(): void
  togglePrefs(): void
  closePrefs(): void
  setPrefs(prefs: Partial<ReaderPrefs>): void
  toggleAsk(): void
  closeAsk(): void
  setSection(section: ReaderSection): void
  setSectionLabel(label: string | null): void
  setSelection(selection: string | null): void
  setVerdict(verdict: RecallVerdict): void
  setOverride(sendPassage: boolean): void
  /** Marks a probe in flight *before* the request goes out — see `beginProbe`. */
  beginProbe(requestId: string): void
  beginAsk(requestId: string, question: string): void
  aiChunk(event: AiChunkEvent): void
  aiDone(event: AiDoneEvent): void
  aiError(event: AiErrorEvent): void

  /** Open the search panel, or close it — either way the other two occupants go. */
  toggleSearch(): void
  closeSearch(): void
  setQuery(query: string): void
  /** The only writer of a live run's state. See `startSearch`. */
  setSearchState(patch: SearchPatch): void
  /** Drop the results and the query, and keep the panel open — Esc's first step. */
  clearSearch(): void
}

/**
 * What the running loop may write. Deliberately not `query`: the input belongs to
 * the reader, and a run that could rewrite it would fight the caret.
 */
export type SearchPatch = Partial<
  Pick<ReaderState, 'searching' | 'progress' | 'results' | 'activeCfi'>
>

/**
 * Everything the ask panel owns, at rest: a book is a new conversation.
 * `askVerdict: null` is the state that lets the panel probe again, so this is
 * also what "one probe per (book, session)" is counted against.
 */
const ASK_IDLE = {
  askOpen: false,
  askVerdict: null,
  askOverride: false,
  askRung: 'pointer',
  askSession: EMPTY_ASK_SESSION,
  askProbe: null,
  section: null,
  sectionLabel: null,
  selection: null
} satisfies Partial<ReaderState>

/**
 * A run at rest: no query, no results, no active hit, nothing left to write into.
 *
 * Two names for one reset because the panel and the *run* are separable —
 * Escape's first step clears the results and leaves the panel standing, and the
 * second closes it (AC1.6).
 */
const SEARCH_CLEARED = {
  query: '',
  searching: false,
  progress: 0,
  // The same array the lib's own empty state holds: an identity the panel's
  // "changed nothing" check can compare against
  results: EMPTY_SEARCH.results,
  activeCfi: null
} satisfies Partial<ReaderState>

/** The cleared run *and* the panel gone (AC1.8). */
const SEARCH_IDLE = { searchOpen: false, ...SEARCH_CLEARED } satisfies Partial<ReaderState>

/** The verdict and the rung move together: the rung is derived, never set. */
function verdictState(
  verdict: RecallVerdict | null,
  override: boolean
): Pick<ReaderState, 'askVerdict' | 'askRung'> {
  return { askVerdict: verdict, askRung: effectiveRung(verdict, override) }
}

/**
 * What survives a restart: typography, and nothing else (AC1.8).
 *
 * Exported because it is handed to the persist middleware as `partialize`, and
 * the criterion "nothing about a search is persisted" is decided against *this
 * function* rather than a copy of it — the middleware cannot use another one.
 */
export function persistedReaderState(s: ReaderState): Partial<ReaderState> {
  return { prefs: s.prefs }
}

export const useReaderStore = create<ReaderState>()(
  persist(
    (set) => ({
      bookId: null,
      format: null,
      status: 'idle',
      error: null,
      toc: [],
      percent: 0,
      tocOpen: false,
      prefsOpen: false,
      prefs: DEFAULT_PREFS,
      ...ASK_IDLE,
      ...SEARCH_IDLE,

      /**
       * A book the engine can't render is handed to the OS instead of opening
       * a reader that only apologises — so PDFs land in Preview today and
       * quietly stop falling through when C2 ships.
       */
      openBook: (book) => {
        const format = readableFormat(book)
        if (!format) {
          // By preference, not by array position (invariant 3): the array holds
          // whatever order the writer left, so `formats[0]` is not a preference
          const fallback = primaryFormat(book)
          if (fallback) void window.Musaeum.files.openBookFile(book.id, fallback).catch(() => {})
          return
        }
        set((s) => {
          // A book that is already open is not a load. The engine keys its effect
          // on `(bookId, format)`, so a second `openBook` for the same book runs
          // nothing that could report ready — and stamping `loading` here left the
          // reader under "Opening…" with a blank percentage, permanently (measured
          // by opening the same book twice from a probe). Unreachable from the UI
          // today: the overlay covers every other entry point. The guard is here so
          // the first entry point that is *not* covered cannot strand it.
          const reload = s.bookId !== book.id || s.format !== format
          return {
            bookId: book.id,
            format,
            status: reload ? 'loading' : s.status,
            error: null,
            toc: [],
            percent: reload ? (book.readingState?.percent ?? 0) : s.percent,
            tocOpen: false,
            prefsOpen: false,
            // A book is a new conversation: transcript, verdict, pointer and all
            ...ASK_IDLE,
            // …and a new search: results for another book's text are not results
            ...SEARCH_IDLE
          }
        })
      },

      // Every panel belongs to the session, not to the app: a book opened next
      // starts with none of them showing, however the last one was left
      close: () =>
        set({
          bookId: null,
          format: null,
          status: 'idle',
          error: null,
          toc: [],
          tocOpen: false,
          prefsOpen: false,
          ...ASK_IDLE,
          ...SEARCH_IDLE
        }),
      setStatus: (status, error = null) => set({ status, error }),
      setToc: (toc) => set({ toc }),
      setPercent: (percent) => set({ percent }),
      // One side slot, three claimants: opening any one closes the other two (D4)
      toggleToc: () => set((s) => ({ tocOpen: !s.tocOpen, askOpen: false, ...SEARCH_IDLE })),
      toggleAsk: () => set((s) => ({ askOpen: !s.askOpen, tocOpen: false, ...SEARCH_IDLE })),
      closeAsk: () => set({ askOpen: false }),
      togglePrefs: () => set((s) => ({ prefsOpen: !s.prefsOpen })),
      closePrefs: () => set({ prefsOpen: false }),

      /**
       * The section text arrives on every `load`, so the write is guarded by
       * identity: a re-report of the section already held is not a state
       * change, and zustand skips notification when the updater hands back the
       * state it was given. Same rule for the label and the selection — a
       * `selectionchange` fires for every caret move.
       */
      setSection: (section) =>
        set((s) =>
          s.section?.index === section.index && s.section.text === section.text ? s : { section }
        ),
      setSectionLabel: (label) =>
        set((s) => (s.sectionLabel === label ? s : { sectionLabel: label })),
      setSelection: (selection) => set((s) => (s.selection === selection ? s : { selection })),

      /**
       * ⌘F, the header's button and the menu item all land here — one code path,
       * which is the repo's rule for a command and its in-app control.
       *
       * It toggles rather than opens, for the same reason ⌘F does in every other
       * reader: the key that opened the panel is the one a reader presses to get
       * rid of it. Closing takes the run with it, so ⌘F ⌘F leaves no results
       * behind for the next open to show (AC1.8).
       */
      toggleSearch: () =>
        set((s) =>
          s.searchOpen ? { ...SEARCH_IDLE } : { searchOpen: true, tocOpen: false, askOpen: false }
        ),
      closeSearch: () => set({ ...SEARCH_IDLE }),
      setQuery: (query) => set({ query }),

      /**
       * The running loop's only writer (see `runSearch`). Identity is preserved
       * when the patch changes nothing, so a scan of a book where hundreds of
       * sections match nothing does not notify a subscriber per section.
       */
      setSearchState: (patch) =>
        set((s) => {
          const keys = Object.keys(patch) as (keyof SearchPatch)[]
          return keys.every((key) => s[key] === patch[key]) ? s : patch
        }),

      /**
       * Escape's first step: the results go and the **query goes with them**,
       * because that is what makes the second Escape's "panel open and empty"
       * true. Three steps, one key (AC1.6).
       *
       * Stopping a live run is not this action's job — a run in flight is stopped
       * by the caller's token, and a store that also had to know about tokens
       * would be two places deciding the same thing.
       */
      clearSearch: () => set({ ...SEARCH_CLEARED }),

      setVerdict: (verdict) => set((s) => verdictState(verdict, s.askOverride)),
      setOverride: (sendPassage) =>
        set((s) => ({ askOverride: sendPassage, ...verdictState(s.askVerdict, sendPassage) })),

      /**
       * `askProbe` is set *synchronously*, before the request goes out. That is
       * what makes the panel's probe effect idempotent: React's StrictMode runs
       * an effect twice in development, and the second run sees a probe already
       * in flight rather than starting a second one.
       */
      beginProbe: (requestId) => set({ askProbe: { requestId, reply: '' } }),
      beginAsk: (requestId, question) =>
        set((s) => ({
          askSession: reduceAsk(s.askSession, { type: 'open', requestId, question })
        })),

      /**
       * One reader for three event channels (D9), routed by the `requestId` the
       * caller minted. The probe's reply never lands in the transcript; an
       * event for a superseded question cannot touch the current one; and a
       * chunk the reducer does not want is returned as *the same state*, so a
       * cancelled stream cannot notify a subscriber either.
       */
      aiChunk: (event) =>
        set((s) => {
          if (s.askProbe?.requestId === event.requestId) {
            const probe = appendProbeDelta(s.askProbe, event.requestId, event.delta)
            return probe === s.askProbe ? s : { askProbe: probe }
          }
          const askSession = reduceAsk(s.askSession, {
            type: 'chunk',
            requestId: event.requestId,
            delta: event.delta
          })
          return askSession === s.askSession ? s : { askSession }
        }),

      aiDone: (event) =>
        set((s) => {
          if (s.askProbe?.requestId === event.requestId) {
            // Whatever arrived is scored, even a reply cut short — `RECALL: no`
            // followed by a dropped connection is still the model saying it
            // cannot place the book. Both sides of that comparison are local.
            const verdict = probeVerdict(s.askProbe.reply, s.section?.text ?? null)
            return { askProbe: null, ...verdictState(verdict, s.askOverride) }
          }
          const askSession = reduceAsk(s.askSession, {
            type: 'settle',
            requestId: event.requestId,
            reason: event.reason
          })
          return askSession === s.askSession ? s : { askSession }
        }),

      aiError: (event) =>
        set((s) => {
          if (s.askProbe?.requestId === event.requestId) {
            // A probe that fails is not a failure of the feature (D6, invariant
            // 12): the reader keeps the panel, and `unknown` is the honest
            // verdict — unverified, which is exactly what we now know.
            return { askProbe: null, ...verdictState('unknown', s.askOverride) }
          }
          const askSession = reduceAsk(s.askSession, {
            type: 'fail',
            requestId: event.requestId,
            message: event.message
          })
          return askSession === s.askSession ? s : { askSession }
        }),

      // Sanitized on the way in as well as on the way out of storage, so the
      // store's own invariant holds no matter who calls it
      setPrefs: (prefs) => set((s) => ({ prefs: sanitizePrefs({ ...s.prefs, ...prefs }) }))
    }),
    {
      // Only typography survives a restart — which book was open does not,
      // matching how the library forgets selection and search. The search panel's
      // query and results are session state by the same rule, and partialize is
      // what enforces it rather than the panel remembering to clean up (AC1.8).
      name: 'musaeum.reader',
      partialize: persistedReaderState,
      merge: (persisted, current) => {
        const { prefs } = (persisted ?? {}) as { prefs?: unknown }
        return { ...current, prefs: sanitizePrefs(prefs) }
      }
    }
  )
)
