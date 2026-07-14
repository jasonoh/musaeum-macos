import { create } from 'zustand'
import type {
  Book,
  BookFilters,
  BookFormat,
  BookSort,
  ImportProgress,
  LibraryFacets,
  ReadStatus
} from '@shared/book.types'

export type FacetKind = 'authors' | 'series' | 'tags' | 'formats' | 'readStatus'

interface LibraryState {
  books: Book[]
  facets: LibraryFacets | null
  loading: boolean
  query: string
  filters: BookFilters
  sort: BookSort
  importJobs: Record<string, ImportProgress>

  load(): Promise<void>
  setQuery(query: string): void
  toggleFilter(kind: FacetKind, value: string): void
  clearFilters(): void
  setSort(sort: BookSort): void
  upsertImportJob(progress: ImportProgress): void
  removeImportJob(jobId: string): void
}

const EMPTY_FILTERS: BookFilters = {}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  books: [],
  facets: null,
  loading: false,
  query: '',
  filters: EMPTY_FILTERS,
  sort: { field: 'title', direction: 'asc' },
  importJobs: {},

  async load() {
    const { query, filters, sort } = get()
    set({ loading: true })
    try {
      const books = query.trim()
        ? await window.Musaeum.library.searchBooks(query)
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
  }
}))
