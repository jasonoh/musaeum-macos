import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Book, BookFormat } from '@shared/book.types'
import { readableFormat } from '@shared/book.types'

export interface ReaderTocItem {
  label: string
  href: string
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

interface ReaderState {
  bookId: string | null
  format: BookFormat | null
  status: ReaderStatus
  error: string | null
  toc: ReaderTocItem[]
  percent: number
  tocOpen: boolean
  prefs: ReaderPrefs

  openBook(book: Book): void
  close(): void
  setStatus(status: ReaderStatus, error?: string | null): void
  setToc(toc: ReaderTocItem[]): void
  setPercent(percent: number): void
  toggleToc(): void
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
          tocOpen: false
        })
      },

      close: () => set({ bookId: null, format: null, status: 'idle', error: null, toc: [], tocOpen: false }),
      setStatus: (status, error = null) => set({ status, error }),
      setToc: (toc) => set({ toc }),
      setPercent: (percent) => set({ percent }),
      toggleToc: () => set((s) => ({ tocOpen: !s.tocOpen })),
      setPrefs: (prefs) => set((s) => ({ prefs: { ...s.prefs, ...prefs } }))
    }),
    {
      // Only typography survives a restart — which book was open does not,
      // matching how the library forgets selection and search
      name: 'musaeum.reader',
      partialize: (s) => ({ prefs: s.prefs }),
      merge: (persisted, current) => {
        const { prefs } = (persisted ?? {}) as { prefs?: Partial<ReaderPrefs> }
        return { ...current, prefs: { ...DEFAULT_PREFS, ...(prefs ?? {}) } }
      }
    }
  )
)
