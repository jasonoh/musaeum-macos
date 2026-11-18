/**
 * The pure rules of a reading queue's view (`docs/invariants/shelves.md`, "Queues").
 * Types only: a store import here would be an import cycle with `library.store`.
 */
import type { BookFilters, BookSort } from '@shared/book.types'
import type { ShelfKind, ShelfPlacement, ShelfSummary } from '@shared/shelf.types'

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

/** Which half of a drop target the pointer is over: the first half is before, the rest after. */
export function dropSide(offset: number, size: number): 'before' | 'after' {
  return offset < size / 2 ? 'before' : 'after'
}

/** The placement a drop on a target means. Exactly one key: main refuses an extra one, an undefined one included. */
export function dropPlacement(targetId: string, side: 'before' | 'after'): ShelfPlacement {
  return side === 'before' ? { before: targetId } : { after: targetId }
}

/**
 * The order main's `moveBooks` will write, so the view can show it before main
 * answers. The moved ids the order holds keep their **current relative order** and
 * move as a block (not the order passed); an id the order lacks is ignored. An
 * anchor that is itself moved, or absent, changes nothing — an equal copy.
 */
export function applyPlacement(
  order: readonly string[],
  moved: readonly string[],
  placement: ShelfPlacement
): string[] {
  const movedSet = new Set(moved)
  const block = order.filter((id) => movedSet.has(id))
  if (block.length === 0) return [...order]
  const rest = order.filter((id) => !movedSet.has(id))
  if ('to' in placement) return placement.to === 'top' ? [...block, ...rest] : [...rest, ...block]
  const anchor = 'before' in placement ? placement.before : placement.after
  const at = rest.indexOf(anchor)
  if (movedSet.has(anchor) || at < 0) return [...order]
  const insertAt = 'before' in placement ? at : at + 1
  return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)]
}

/**
 * `books` in the order `ids` gives. An id with no book is dropped; a book with no
 * id keeps its place after the listed ones, so a list that moved under the caller
 * loses nothing.
 */
export function orderBooksBy<T extends { id: string }>(
  books: readonly T[],
  ids: readonly string[]
): T[] {
  const byId = new Map(books.map((b) => [b.id, b]))
  const listed = new Set<string>()
  const out: T[] = []
  for (const id of ids) {
    const book = byId.get(id)
    if (book && !listed.has(id)) {
      listed.add(id)
      out.push(book)
    }
  }
  for (const book of books) if (!listed.has(book.id)) out.push(book)
  return out
}

/**
 * Whether the open view is a queue in its own order with nothing narrowing it: the
 * only view whose rows are the queue, so the only one a drag may reorder. The
 * filters test is the sidebar's own `hasActive`.
 */
export function queueReorderable(i: {
  shelfKind: ShelfKind | null
  sort: BookSort
  query: string
  filters: BookFilters
  deviceId: string | null
}): boolean {
  return (
    i.shelfKind === 'queue' &&
    i.sort.field === 'shelf_position' &&
    i.query.trim() === '' &&
    Object.keys(i.filters).length === 0 &&
    i.deviceId === null
  )
}
