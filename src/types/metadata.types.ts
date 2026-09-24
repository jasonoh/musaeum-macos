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
 * One cover a book could wear, as the picker receives it.
 *
 * Gathered live on every call and stored nowhere — `metadata.json` is untouched
 * by this feature, so there is no candidate list to go stale and no new member
 * in the file the iOS contract documents.
 */
export interface CoverCandidate {
  source: MetadataSource
  /**
   * Where the gather fetched this candidate from. **Absent** for `embedded`,
   * never null: the file's own jacket is re-extracted, and that absence is
   * exactly what `setCover` refuses on.
   */
  url?: string
  width: number
  height: number
  /** The shipped scoring formula's own number. The highest is the `winner`. */
  score: number
  /** What a fetch would write — the head of the scored list. */
  winner: boolean
  /**
   * Byte-identical to the book's `cover_full.jpg` **now**. Byte identity, not
   * provenance: a cover's source is recorded nowhere, so the bytes are the only
   * thing that can say "this is the one your book is wearing".
   */
  applied: boolean
  /**
   * `data:image/jpeg;base64,…`, ≤240 px, produced by the sidecar's
   * `preview_data_url` — the same function a cover conflict's tiles go through.
   * The renderer's CSP names no remote origin (`img-src 'self' musaeum: data:
   * blob:`), so this is the only form in which a candidate image can reach a
   * component at all.
   */
  thumb: string
}

/**
 * What a person chose: one candidate's `source`, plus its `url` if it had one.
 *
 * A picker only ever echoes back a pair the gather itself produced — the main
 * process refuses anything else, because a renderer that could name its own URL
 * would be handing the main process an arbitrary egress (the same reasoning that
 * keeps `file://` out of the renderer).
 */
export interface CoverChoice {
  source: MetadataSource
  url?: string
}

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

/**
 * What kind of storage a library root sits on.
 *
 * The question is not "is it reachable" — `fs.access` answers that — but "if it
 * goes away, does waiting help?". A `network` share comes back on its own, so
 * the app remounts it on a backoff; a `local` disk or folder does not come back
 * at all, and only the person who moved it can say where it went. Every write
 * gate and both failure modes are identical without this value — only the
 * *recovery* differs, and it differs completely.
 *
 * A stored fact, resolved when the folder is chosen (`services/storage-kind.ts`),
 * because that is the one moment the path necessarily exists: an unmount takes
 * the share *and its mount point* away, so the question is unanswerable later.
 */
export type StorageKind = 'local' | 'network'

/**
 * The library's reachability, as the sidebar, banner and Settings row render it.
 *
 * - `connected` — the root is there; writes are allowed.
 * - `unconfigured` — no root chosen yet.
 * - `disconnected` — a **share** is away. A retry is armed, because waiting is
 *   a strategy: shares come back.
 * - `reconnecting` — an attempt is in flight *right now*. Transient, and never
 *   the resting place of a failed attempt.
 * - `missing` — a **local** root is gone. Nothing is retrying — a folder does
 *   not come back on its own — and the recovery is to say where it went.
 */
export type NASState = 'connected' | 'disconnected' | 'reconnecting' | 'missing' | 'unconfigured'

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
  /**
   * The kind in force: the stored fact, or the one derived the first time this
   * root was reachable. Null before any health check has resolved a root.
   *
   * Carried as a fact for the surfaces to name, never as a branch for them to
   * take — which recovery a state offers is decided in the main process.
   */
  kind: StorageKind | null
  libraryRoot: string | null
  /**
   * Milliseconds until the next automatic reconnect attempt, if one is armed.
   * **Null for a `missing` root**: nothing is retrying there, and the banner's
   * "Retrying in Ns" must not render for a state that is not.
   */
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
