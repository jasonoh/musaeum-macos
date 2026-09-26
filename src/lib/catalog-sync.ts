import type { CatalogSyncState } from '@shared/book.types'
import type { NASState } from '@shared/metadata.types'

export type CatalogSyncKind = 'refresh' | 'rebuild'

/**
 * The three transitions of one refresh-or-rebuild, as pure functions so each has
 * a decider — the store's own test suite has no DOM, so the store stays thin
 * glue over these (`library.store`'s `runCatalogSync`).
 */

/**
 * Whether a refresh or rebuild may start now: the library is reachable and no
 * job is already running — the gate Settings' buttons already apply, as a
 * predicate for the two doors that can be pressed at any moment (⌘R and the
 * sidebar's icon), since `runCatalogSync` does not refuse a second job over a
 * running one.
 */
export function canStartCatalogSync(
  nasState: NASState | undefined,
  sync: CatalogSyncState | null
): boolean {
  return nasState === 'connected' && sync?.outcome !== 'running'
}

/** A job that has just started: no counts yet, no result. */
export function startCatalogSync(kind: CatalogSyncKind): CatalogSyncState {
  return { kind, completed: 0, total: null, outcome: 'running', books: null }
}

/**
 * A folder tick from the walk. Also the signal that a *refresh became a
 * rebuild*: the walk is the only thing that reports folder counts, and
 * `library-sync.refreshLibrary` delegates to it whenever the catalog can't be
 * read — so this is where a user who pressed Reload learns they are in for
 * minutes rather than a second.
 *
 * Returns the state unchanged when nothing is running: the event can arrive
 * after a job whose promise already settled.
 */
export function applyRebuildProgress(
  sync: CatalogSyncState | null,
  p: { completed: number; total: number }
): CatalogSyncState | null {
  if (!sync) return sync
  return { ...sync, kind: 'rebuild', completed: p.completed, total: p.total }
}

/**
 * The job's result, in place. `kind` is carried over from the running state
 * rather than taken from the caller: a refresh that turned into a rebuild must
 * not be relabelled on its way out, or the settled line would name a job the
 * user never watched.
 */
export function settleCatalogSync(
  sync: CatalogSyncState | null,
  fallbackKind: CatalogSyncKind,
  outcome: 'done' | 'cancelled' | 'failed',
  books: number | null
): CatalogSyncState {
  return {
    kind: sync?.kind ?? fallbackKind,
    completed: 0,
    total: null,
    outcome,
    // A cancelled or failed run has no count to report — keeping one would let
    // the line claim books that were never reloaded
    books: outcome === 'done' ? books : null
  }
}

/**
 * The status bar's line for a refresh-or-rebuild. Pure so the wording has a
 * decider: this job runs for up to ~21 minutes at library scale (measured,
 * 1,281 s over SMB for 7,101 folders), which is long enough that the *verb*
 * matters — a user who pressed Reload and is watching "Rebuilding catalog…" is
 * being told something true and useful, because a refresh falls back to a
 * rebuild when the catalog cannot be read.
 */
export interface CatalogSyncLine {
  /** The steady part: what this job is, or what it did. */
  text: string
  /** The changing part while running (`412/7101`); null once settled. */
  progress: string | null
  tone: 'busy' | 'done' | 'stopped'
}

export function describeCatalogSync(sync: CatalogSyncState): CatalogSyncLine {
  if (sync.outcome === 'running') {
    return {
      text: sync.kind === 'rebuild' ? 'Rebuilding catalog' : 'Reloading library',
      // A plain refresh has nothing to count, and a rebuild whose first tick has
      // not arrived yet has no total to divide by — neither may render "0/null"
      progress: sync.total === null ? null : `${sync.completed}/${sync.total}`,
      tone: 'busy'
    }
  }

  if (sync.outcome === 'cancelled') {
    return {
      text: 'Catalog rebuild cancelled — nothing was written',
      progress: null,
      tone: 'stopped'
    }
  }

  if (sync.outcome === 'failed') {
    return {
      text: `Couldn’t reload the ${sync.kind === 'rebuild' ? 'catalog' : 'library'}`,
      progress: null,
      tone: 'stopped'
    }
  }

  const books = sync.books === null ? '' : ` — ${sync.books} ${sync.books === 1 ? 'book' : 'books'}`
  return {
    text: sync.kind === 'rebuild' ? `Catalog rebuilt${books}` : `Library reloaded${books}`,
    progress: null,
    tone: 'done'
  }
}
