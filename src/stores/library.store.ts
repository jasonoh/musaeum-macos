import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  Book,
  BookFilters,
  BookFormat,
  BookSort,
  CatalogSyncOutcome,
  CatalogSyncState,
  ImportProgress,
  LibraryFacets,
  ReadStatus
} from '@shared/book.types'
import { isBookSort } from '@shared/book.types'
import { applyRebuildProgress, settleCatalogSync, startCatalogSync } from '@/lib/catalog-sync'
import type { BulkHydrateProgress } from '@shared/metadata.types'

export type FacetKind = 'authors' | 'series' | 'tags' | 'formats' | 'readStatus'

interface LibraryState {
  books: Book[]
  facets: LibraryFacets | null
  loading: boolean
  query: string
  filters: BookFilters
  sort: BookSort
  importJobs: Record<string, ImportProgress>
  /**
   * The refresh-or-rebuild the status bar is showing — live counter, then the
   * settled line. Session-only, and deliberately not the surface that
   * triggered it: the job outlives the Settings dialog.
   */
  catalogSync: CatalogSyncState | null
  /** Live bulk re-hydration progress, or null when no job is running. */
  bulkHydrate: BulkHydrateProgress | null
  setBulkHydrate(p: BulkHydrateProgress | null): void

  load(): Promise<void>
  setQuery(query: string): void
  toggleFilter(kind: FacetKind, value: string): void
  clearFilters(): void
  setSort(sort: BookSort): void
  upsertImportJob(progress: ImportProgress): void
  removeImportJob(jobId: string): void
  refreshLibrary(): Promise<void>
  rebuildCatalog(): Promise<void>
  /** Stop a running rebuild. A no-op when nothing is running. */
  cancelRefresh(): Promise<void>
  /** A folder tick from the walk, arriving as the `catalogRebuildProgress` event. */
  setCatalogRebuildProgress(p: { completed: number; total: number } | null): void
  dismissCatalogSync(): void
}

const EMPTY_FILTERS: BookFilters = {}

/**
 * How long a *successful* sync keeps its settled line. A cancelled or failed
 * one has no deadline: those are the states a user has to act on, and the
 * whole point of the line is that a job which stops reporting at the moment it
 * matters is indistinguishable from one that finished (`refresh-feedback.md`).
 */
const SETTLED_DONE_MS = 8_000

let settledTimer: ReturnType<typeof setTimeout> | null = null

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set, get) => {
      /**
       * One refresh-or-rebuild, start to settle. Both entry points funnel
       * through here so neither trigger (Settings) can leave the status bar's
       * line running, and so the two cannot drift in what they report.
       *
       * The settle reads `kind` back out of the current state rather than
       * using the argument: a Refresh whose catalog is unreadable *becomes* a
       * rebuild mid-flight (`library-sync.refreshLibrary`), and
       * `setCatalogRebuildProgress` is what notices. Overwriting with the
       * argument at the end would relabel the very run the user watched.
       */
      const runCatalogSync = async (
        kind: 'refresh' | 'rebuild',
        run: () => Promise<CatalogSyncOutcome>
      ): Promise<void> => {
        if (settledTimer) clearTimeout(settledTimer)
        settledTimer = null
        set({ catalogSync: startCatalogSync(kind) })

        let outcome: 'done' | 'cancelled' | 'failed' = 'done'
        let books: number | null = null
        try {
          const result = await run()
          books = result.books
          outcome = result.cancelled ? 'cancelled' : 'done'
        } catch (err) {
          console.error(`catalog ${kind} failed:`, err)
          outcome = 'failed'
        }

        set((s) => ({ catalogSync: settleCatalogSync(s.catalogSync, kind, outcome, books) }))
        if (outcome === 'done') {
          settledTimer = setTimeout(
            () => set((s) => (s.catalogSync?.outcome === 'done' ? { catalogSync: null } : {})),
            SETTLED_DONE_MS
          )
        }
      }

      return {
        books: [],
        facets: null,
        loading: false,
        query: '',
        filters: EMPTY_FILTERS,
        sort: { field: 'title', direction: 'asc' },
        importJobs: {},
        catalogSync: null,
        bulkHydrate: null,

        async load() {
          const { query, filters, sort } = get()
          set({ loading: true })
          try {
            const books = query.trim()
              ? await window.Musaeum.library.searchBooks(query, sort)
              : await window.Musaeum.library.getBooks({ ...filters, sort })
            const facets = await window.Musaeum.library.getFacets()
            set({ books, facets, loading: false })
          } catch (err) {
            console.error('library load failed:', err)
            set({ loading: false })
          }
        },

        setQuery(query) {
          set({ query })
          void get().load()
        },

        toggleFilter(kind, value) {
          const filters = { ...get().filters }
          const current = new Set<string>((filters[kind] as string[] | undefined) ?? [])
          if (current.has(value)) current.delete(value)
          else current.add(value)
          if (current.size === 0) delete filters[kind]
          else if (kind === 'formats') filters.formats = [...current] as BookFormat[]
          else if (kind === 'readStatus') filters.readStatus = [...current] as ReadStatus[]
          else filters[kind] = [...current]
          set({ filters })
          void get().load()
        },

        clearFilters() {
          set({ filters: EMPTY_FILTERS })
          void get().load()
        },

        setSort(sort) {
          set({ sort })
          void get().load()
        },

        upsertImportJob(progress) {
          set((s) => ({ importJobs: { ...s.importJobs, [progress.jobId]: progress } }))
        },

        removeImportJob(jobId) {
          set((s) => {
            const jobs = { ...s.importJobs }
            delete jobs[jobId]
            return { importJobs: jobs }
          })
        },

        async refreshLibrary() {
          await runCatalogSync('refresh', () => window.Musaeum.library.refreshLibrary())
        },

        async rebuildCatalog() {
          await runCatalogSync('rebuild', () => window.Musaeum.library.rebuildCatalog())
        },

        async cancelRefresh() {
          try {
            await window.Musaeum.library.cancelRefresh()
          } catch (err) {
            console.error('catalog refresh cancel failed:', err)
          }
        },

        setCatalogRebuildProgress(p) {
          // Also the signal that a Reload became a rebuild: the walk is the only
          // thing that reports folder counts (`library-sync.refreshLibrary`
          // delegates when the catalog can't be read), so this is where a user
          // who expected a second gets told they are in for minutes.
          if (p === null) return
          set((s) => ({ catalogSync: applyRebuildProgress(s.catalogSync, p) }))
        },

        dismissCatalogSync() {
          if (settledTimer) clearTimeout(settledTimer)
          settledTimer = null
          set({ catalogSync: null })
        },

        setBulkHydrate(p) {
          set({ bulkHydrate: p })
        }
      }
    },
    {
      // Sort is the only durable preference here. Query and filters are not
      // restored on purpose: reopening to a filtered library that looks like
      // a much smaller one is the kind of state a user can't see the cause of.
      name: 'musaeum.library',
      partialize: (s) => ({ sort: s.sort }),
      merge: (persisted, current) => {
        const { sort } = (persisted ?? {}) as { sort?: unknown }
        // Storage is only as trustworthy as the build that wrote it, and an
        // unknown field would reach SORT_SQL with no expression to match
        return isBookSort(sort) ? { ...current, sort } : current
      }
    }
  )
)
