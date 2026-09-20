import type { Book, DuplicateContext } from './book.types'

export type MetadataSource = 'embedded' | 'calibre' | 'google_books' | 'openlibrary' | 'goodreads'

export interface ConflictCandidate {
  source: MetadataSource
  value: string
}

export interface MetadataConflict {
  id: number
  bookId: string
  bookTitle: string
  field: string
  candidates: ConflictCandidate[]
  resolved: boolean
}

/** Map of field name → chosen source for that field. */
export type ConflictChoices = Record<string, MetadataSource>

/**
 * The fields hydration can rewrite, coarser than the `books` columns it
 * touches: `sort_title` follows `title`, and the four identifier columns are
 * one "identifiers" as far as the user is concerned. This is the unit of the
 * "what changed?" report a metadata refresh hands back.
 */
export type HydratedField =
  | 'title'
  | 'cover'
  | 'author'
  | 'series'
  | 'description'
  | 'publisher'
  | 'published_date'
  | 'language'
  | 'identifiers'
  | 'tags'

/**
 * Display labels **and their order**, most noticeable first — a refresh
 * reports its changes as "Title, cover and series", so the record's key order
 * is the reading order.
 */
export const HYDRATED_FIELD_LABELS: Record<HydratedField, string> = {
  title: 'Title',
  cover: 'Cover',
  author: 'Author',
  series: 'Series',
  description: 'Description',
  publisher: 'Publisher',
  published_date: 'Published date',
  language: 'Language',
  identifiers: 'Identifiers',
  tags: 'Tags'
}

/**
 * Which `books` columns belong to which `HydratedField`. One table, because
 * two callers now ask two different questions of it: `applyHydration` asks
 * "which field is this change", and the override store asks "which field did
 * the user just set".
 *
 * `sort_title` and `author_sort` are absent on purpose — derived companions of
 * `title` and `author`, so a change to one is a change to the field the user
 * sees, and a lock on one would be a lock on something nobody typed.
 */
export const HYDRATED_KEY_FIELD: Partial<Record<keyof Book, HydratedField>> = {
  title: 'title',
  coverFullPath: 'cover',
  coverThumbPath: 'cover',
  author: 'author',
  seriesName: 'series',
  seriesIndex: 'series',
  seriesTotal: 'series',
  description: 'description',
  publisher: 'publisher',
  publishedDate: 'published_date',
  language: 'language',
  isbn10: 'identifiers',
  isbn13: 'identifiers',
  goodreadsId: 'identifiers',
  openlibraryId: 'identifiers',
  tags: 'tags'
}

/**
 * What one hydration run did. Hydration never throws — a failure is a value
 * here, because import treats it as non-fatal (the book keeps its embedded
 * metadata and the import still succeeds).
 */
export type HydrateOutcome =
  | {
      ok: true
      /** Fields whose value actually changed; empty means "nothing new". */
      changed: HydratedField[]
      /** Review conflicts queued by this run. */
      conflicts: number
      /**
       * Another book already carries the ISBN this run settled. Reported,
       * never acted on: a shared ISBN is not proof of the same file, so the
       * pair is a person's to judge. Absent when there is no collision, and
       * when the pre-copy gate already named this one for this import.
       */
      duplicate?: DuplicateContext
    }
  | { ok: false; error: string }

export type NASState = 'connected' | 'disconnected' | 'reconnecting' | 'unconfigured'

/** Progress of a bulk re-hydration job. `running` false means it is over. */
export interface BulkHydrateProgress {
  completed: number
  total: number
  failed: number
  skipped: number
  /** Books whose metadata actually changed — the rest were already current. */
  updated: number
  /**
   * Books whose settled ISBN already existed elsewhere in the library. A
   * count, not a list: the job's report is a count of everything else too, and
   * naming them needs storage this feature deliberately does not add.
   */
  duplicates: number
  /** Why the loop ended before the last book, when it did. */
  stopped?: 'cancelled' | 'offline'
  /** Last failure's message — one line, so the summary can say why. */
  lastError?: string
  running: boolean
}

export interface NASStatus {
  state: NASState
  libraryRoot: string | null
  /** Milliseconds until next automatic reconnect attempt, if disconnected. */
  nextRetryMs: number | null
  lastCheckedAt: string | null
}

// --- Migration ---

export interface MigrationScan {
  calibrePath: string
  bookCount: number
  formatCounts: Record<string, number>
  hasMetadataDb: boolean
  estimatedSizeBytes: number
}

export interface MigrationOptions {
  calibrePath: string
  /** Where the new library is written; must differ from the Calibre path. */
  targetLibraryRoot: string
  hydrate: boolean
}

export interface MigrationJob {
  jobId: string
}

export type MigrationPhase = 'scanning' | 'copying' | 'hydrating' | 'done' | 'error'

export interface MigrationProgress {
  jobId: string
  phase: MigrationPhase
  total: number
  completed: number
  migrated: number
  needsReview: number
  noMetadata: number
  duplicates: number
  currentTitle: string | null
  /** PDF top-up runs only */
  attached?: number
  added?: number
  skipped?: number
  errors?: number
  error?: string
}
