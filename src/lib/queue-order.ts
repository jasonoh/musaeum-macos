/**
 * The pure rules of a reading queue's view (`docs/invariants/shelves.md`, "Queues").
 * Types only: a store import here would be an import cycle with `library.store`.
 */
import type { BookSort } from '@shared/book.types'
import type { ShelfKind, ShelfSummary } from '@shared/shelf.types'

const QUEUE_ORDER: BookSort = { field: 'shelf_position', direction: 'asc' }
const ADDED_NEWEST: BookSort = { field: 'shelf_added', direction: 'desc' }
const ADDED_OLDEST: BookSort = { field: 'shelf_added', direction: 'asc' }

/** The sort a shelf opens with: a queue in its own order, a manual shelf newest-added first. */
export function defaultShelfSort(kind: ShelfKind): BookSort {
  return kind === 'queue' ? { ...QUEUE_ORDER } : { ...ADDED_NEWEST }
}

/** The sorts a shelf adds in front of the library's own. Queue Order is a queue's alone. */
export function shelfSortOptions(kind: ShelfKind): BookSort[] {
  const added = [{ ...ADDED_NEWEST }, { ...ADDED_OLDEST }]
  return kind === 'queue' ? [{ ...QUEUE_ORDER }, ...added] : added
}

/** Splits the sidebar's shelves by kind, keeping the input's order (main's is alphabetical) inside each group. */
export function groupShelves(shelves: readonly ShelfSummary[]): {
  queues: ShelfSummary[]
  manual: ShelfSummary[]
} {
  const queues: ShelfSummary[] = []
  const manual: ShelfSummary[] = []
  for (const shelf of shelves) (shelf.kind === 'queue' ? queues : manual).push(shelf)
  return { queues, manual }
}
