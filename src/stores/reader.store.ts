import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Book, BookFormat } from '@shared/book.types'
import { readableFormat } from '@shared/book.types'

export interface ReaderTocItem {
  label: string
  href: string
  /** Nesting level in the book's own TOC; the panel indents by it. */
  depth?: number
}

export type ReaderStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ReaderPrefs {
  typeface: 'serif' | 'sans'
  fontSize: number // px
  lineHeight: number
  margin: number // px
  theme: 'paper' | 'ink'
}

export const DEFAULT_PREFS: ReaderPrefs = {
  typeface: 'serif',
  fontSize: 18,
  lineHeight: 1.6,
  margin: 48,
  theme: 'ink'
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

export const THEME_OPTIONS: readonly { value: ReaderPrefs['theme']; label: string }[] = [
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

function oneOf<T extends string>(
  options: readonly { value: T }[],
  value: unknown,
  fallback: T
): T {
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

  openBook(book: Book): void
  close(): void
  setStatus(status: ReaderStatus, error?: string | null): void
  setToc(toc: ReaderTocItem[]): void
  setPercent(percent: number): void
  toggleToc(): void
  togglePrefs(): void
  closePrefs(): void
  setPrefs(prefs: Partial<ReaderPrefs>): void
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

      /**
       * A book the engine can't render is handed to the OS instead of opening
       * a reader that only apologises — so PDFs land in Preview today and
       * quietly stop falling through when C2 ships.
       */
      openBook: (book) => {
        const format = readableFormat(book)
        if (!format) {
          const fallback = book.formats[0]
          if (fallback) void window.Musaeum.files.openBookFile(book.id, fallback).catch(() => {})
          return
        }
        set({
          bookId: book.id,
          format,
          status: 'loading',
          error: null,
          toc: [],
          percent: book.readingState?.percent ?? 0,
          tocOpen: false,
          prefsOpen: false
        })
      },

      // Both panels belong to the session, not to the app: a book opened next
      // starts with neither showing, however the last one was left
      close: () =>
        set({
          bookId: null,
          format: null,
          status: 'idle',
          error: null,
          toc: [],
          tocOpen: false,
          prefsOpen: false
        }),
      setStatus: (status, error = null) => set({ status, error }),
      setToc: (toc) => set({ toc }),
      setPercent: (percent) => set({ percent }),
      toggleToc: () => set((s) => ({ tocOpen: !s.tocOpen })),
      togglePrefs: () => set((s) => ({ prefsOpen: !s.prefsOpen })),
      closePrefs: () => set({ prefsOpen: false }),
      // Sanitized on the way in as well as on the way out of storage, so the
      // store's own invariant holds no matter who calls it
      setPrefs: (prefs) => set((s) => ({ prefs: sanitizePrefs({ ...s.prefs, ...prefs }) }))
    }),
    {
      // Only typography survives a restart — which book was open does not,
      // matching how the library forgets selection and search
      name: 'musaeum.reader',
      partialize: (s) => ({ prefs: s.prefs }),
      merge: (persisted, current) => {
        const { prefs } = (persisted ?? {}) as { prefs?: unknown }
        return { ...current, prefs: sanitizePrefs(prefs) }
      }
    }
  )
)
