export type BookFormat = 'epub' | 'mobi' | 'azw3' | 'pdf'

export type ReadStatus = 'unread' | 'reading' | 'read'

export interface Book {
  id: string
  title: string
  sortTitle: string | null
  author: string | null
  authorSort: string | null
  publisher: string | null
  publishedDate: string | null
  language: string | null
  description: string | null
  isbn10: string | null
  isbn13: string | null
  goodreadsId: string | null
  openlibraryId: string | null
  seriesName: string | null
  seriesIndex: number | null
  seriesTotal: number | null
  coverThumbPath: string | null
  coverFullPath: string | null
  formats: BookFormat[]
  tags: string[]
  rating: number | null
  dateAdded: string | null
  lastModified: string | null
  fileSizeBytes: number | null
  readStatus: ReadStatus
  nasPath: string | null
}

export type SortField =
  | 'title'
  | 'author'
  | 'series'
  | 'date_added'
  | 'rating'
  | 'read_status'

export interface BookSort {
  field: SortField
  direction: 'asc' | 'desc'
}

export interface BookFilters {
  authors?: string[]
  series?: string[]
  tags?: string[]
  formats?: BookFormat[]
  readStatus?: ReadStatus[]
  minRating?: number
  sort?: BookSort
}

/** Facet values with counts, for the filter sidebar. */
export interface LibraryFacets {
  authors: { value: string; count: number }[]
  series: { value: string; count: number }[]
  tags: { value: string; count: number }[]
  formats: { value: BookFormat; count: number }[]
  readStatus: { value: ReadStatus; count: number }[]
}

export type ImportStep =
  | 'received'
  | 'extracting'
  | 'duplicate_check'
  | 'copying'
  | 'hydrating'
  | 'cover'
  | 'done'
  | 'error'

export interface ImportProgress {
  jobId: string
  fileName: string
  bookId: string | null
  step: ImportStep
  /** Set when step === 'error' */
  error?: string
  /** Set when a probable duplicate was detected (import continues). */
  duplicateWarning?: string
}

export interface ImportResult {
  jobId: string
  fileName: string
  success: boolean
  bookId?: string
  error?: string
  duplicateWarning?: string
}

/** Format "The Expanse #1" — drops trailing .0 on whole-number indices. */
export function seriesDisplay(name: string, index: number | null): string {
  if (index == null) return name
  // JS number formatting already drops the trailing .0 (String(1.0) === '1')
  return `${name} #${index}`
}
