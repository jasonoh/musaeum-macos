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

export type NASState = 'connected' | 'disconnected' | 'reconnecting' | 'unconfigured'

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

export type MigrationPhase =
  | 'scanning'
  | 'copying'
  | 'hydrating'
  | 'done'
  | 'error'

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
  error?: string
}
