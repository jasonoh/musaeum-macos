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
import { resultSetKey } from '@/lib/resultSetIdentity'
import type { BulkHydrateProgress } from '@shared/metadata.types'

export type FacetKind = 'authors' | 'series' | 'tags' | 'formats' | 'readStatus'

interface LibraryState {
  books: Book[]
  facets: LibraryFacets | null
  loading: boolean
  query: string
  filters: BookFilters
  sort: BookSort
  /**
   * The open shelf, or null for the whole library (bookshelves D7). Sits above
   * the facet filters: **Clear** empties `filters` and leaves this alone.
   *
   * Not persisted, and not restored at launch — the store's existing
   * "never reopen filtered" rule, for the same reason.
   */
  activeShelfId: string | null
  /**
   * The library's *own* sort — the only one that outlives the session (D8).
   * While a shelf is open `sort` is that shelf's sort, and this is what leaving
   * restores; while the library is on screen the two are kept equal.
   */
  librarySort: BookSort
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
  /** Open a shelf, or leave it with null. Remembers and restores the library sort. */
  setActiveShelf(shelfId: string | null): void
  /** Drop a scope the shelf list no longer holds. See the docblock. */
  reconcileScope(existingShelfIds: string[]): void
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

/** D8's default inside a shelf; also what its sort control offers first. */
const SHELF_ADDED_DESC: BookSort = { field: 'shelf_added', direction: 'desc' }

/**
 * The identity of a read, in `resultSetKey`'s own terms.
 *
 * `load()` uses this to answer "is the thing I was asked for still the thing the
 * store wants?" — so "what a read reads" has one definition rather than two, and
 * it is the same one the views use to decide whether their result set changed.
 */
function readIdentity(
  s: Pick<LibraryState, 'query' | 'filters' | 'sort' | 'activeShelfId'>
): string {
  return resultSetKey({
    query: s.query,
    filters: s.filters,
    sort: s.sort,
    shelfId: s.activeShelfId
  })
}

/**
 * What outlives the session: the library's own sort, and nothing else.
 *
 * Exported rather than left inline so the rule has a decider, the `persistedUIState`
 * pattern. D8's sentence is exact — the library sort "remains the only persisted
 * sort" — so while a shelf is open this deliberately persists `librarySort`, not
 * the effective `sort`, which is then *Date Added to Shelf*.
 */
export const persistedLibraryState = (s: LibraryState): Pick<LibraryState, 'sort'> => ({
  // D8: the library sort is the only persisted sort. While a shelf is open the
  // state's `sort` is *Date Added to Shelf*, which means nothing without a shelf
  // and would come back as the library's own order on the next launch
  sort: s.librarySort
})

/**
 * A restored sort, or null when storage holds nothing this build may use.
 *
 * `isBookSort` alone is no longer enough — it accepts `shelf_added` since slice
 * 1, so a build that persisted one would restore a library sorted by a shelf's
 * membership. Exported for the same reason `persistedUIState` is: the rule gets
 * a decider instead of a case that reaches into the storage backend.
 */
export function restoredSort(value: unknown): BookSort | null {
  return isBookSort(value) && value.field !== 'shelf_added' ? value : null
}

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
        librarySort: { field: 'title', direction: 'asc' },
        activeShelfId: null,
        importJobs: {},
        catalogSync: null,
        bulkHydrate: null,

        async load() {
          const { query, filters, sort, activeShelfId } = get()
          // The identity of *this* read, so a slower earlier one cannot land on
          // top of a later one. Two shelf switches in quick succession issue two
          // scoped reads and the SQL they run is not the same cost, so the older
          // answer can arrive last — which would leave the view showing one
          // shelf's rows while `activeShelfId` names another.
          const at = readIdentity({ query, filters, sort, activeShelfId })
          set({ loading: true })
          try {
            // The scope travels on the read, not in `filters` (R4): it is not
            // one of the filter sidebar's facets, so *Clear* cannot reach it and
            // `hasActive` cannot claim it — the spec's "Clear keeps the shelf",
            // true by construction
            const scope = activeShelfId ? { shelfId: activeShelfId } : undefined
            const books = query.trim()
              ? await window.Musaeum.library.searchBooks(query, sort, scope)
              : await window.Musaeum.library.getBooks({
                  ...filters,
                  sort,
                  ...(activeShelfId ? { shelfId: activeShelfId } : {})
                })
            const facets = await window.Musaeum.library.getFacets(scope)
            // A scope, sort, query or filter that moved while this read was in
            // flight has issued a read of its own; that one owns the result set
            // and the loading flag, and this answer is stale
            if (readIdentity(get()) !== at) return
            set({ books, facets, loading: false })
          } catch (err) {
            console.error('library load failed:', err)
            if (readIdentity(get()) === at) set({ loading: false })
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

        /**
         * Entering a shelf sets its default order and remembers the library's;
         * leaving restores it. The memory is written only from *outside* a
         * shelf: switching straight from one shelf to another must not
         * overwrite it with a shelf sort, and a sort chosen inside a shelf is
         * that visit's own (R1).
         */
        setActiveShelf(shelfId) {
          const { activeShelfId, sort, librarySort } = get()
          if (shelfId === activeShelfId) return
          if (shelfId === null) {
            set({ activeShelfId: null, sort: librarySort })
          } else {
            set({
              activeShelfId: shelfId,
              librarySort: activeShelfId ? librarySort : sort,
              sort: SHELF_ADDED_DESC
            })
          }
          void get().load()
        },

        /**
         * A scope whose shelf has gone: deleted here, deleted on another Mac, or
         * a library root switched to one that never had it. Main broadcasts on
         * every adoption as well as every write, so this runs whenever the list
         * is refreshed — and without it the app would sit on a scope no list
         * holds, where every read answers nothing and every write refuses
         * ("That shelf no longer exists"). Leaving the scope keeps the query and
         * the filters: they are the user's, and they were not what vanished.
         */
        reconcileScope(existingShelfIds) {
          const { activeShelfId } = get()
          if (!activeShelfId || existingShelfIds.includes(activeShelfId)) return
          get().setActiveShelf(null)
        },

        setSort(sort) {
          set(get().activeShelfId ? { sort } : { sort, librarySort: sort })
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
      // The *open shelf* is not restored either, for the same reason.
      name: 'musaeum.library',
      partialize: persistedLibraryState,
      merge: (persisted, current) => {
        const { sort } = (persisted ?? {}) as { sort?: unknown }
        const restored = restoredSort(sort)
        return restored ? { ...current, sort: restored, librarySort: restored } : current
      }
    }
  )
)
