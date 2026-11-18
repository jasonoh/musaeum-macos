import type React from 'react'
import type { ShelfKind } from '@shared/shelf.types'
import { dragPayload, dragReorderShelfId, isBookDragTypes } from '@/lib/book-drag'
import { dropPlacement, dropSide, queueReorderable } from '@/lib/queue-order'
import { reorderInQueue } from '@/lib/shelf-membership'
import { useLibraryStore } from '@/stores/library.store'
import { shelfById, useShelvesStore } from '@/stores/shelves.store'

/**
 * A reading queue's views taking a reorder drop (`docs/invariants/shelves.md`,
 * "Queues"; `docs/invariants/library-views.md`).
 *
 * A row or a card is a drop target for a drag that began in the same open queue,
 * and for nothing else. That is decided twice: the source asks `useReorderableShelfId`
 * when the drag starts (and records the answer in the drag slot), and every handler
 * below **re-asks the whole gate** from the stores as they are now. A handler never
 * trusts that an earlier `dragover` passed, nor that the view is still the one the
 * drag began in: a search typed mid-drag, a sort change, a stale slot and a Finder
 * file all arrive here, and all of them must fall through to whatever else listens —
 * so a failed gate does nothing and calls no `preventDefault`.
 *
 * No handler calls `stopPropagation`: the window's `drop` is what clears the drag's
 * payload (`useBookDrag`), and a payload that outlived its drag is picked up by the
 * next one.
 */

function shelfKindNow(shelfId: string | null): ShelfKind | null {
  return shelfById(useShelvesStore.getState(), shelfId)?.kind ?? null
}

/** The open queue's id when the stores say a drag may reorder it right now, else null. */
function reorderableNow(): string | null {
  const { activeShelfId, sort, query, filters, activeDeviceId } = useLibraryStore.getState()
  if (!activeShelfId) return null
  const shelfKind = shelfKindNow(activeShelfId)
  return queueReorderable({ shelfKind, sort, query, filters, deviceId: activeDeviceId })
    ? activeShelfId
    : null
}

/**
 * The whole gate for one drag event: a book drag by its own types, begun in the open
 * queue, over a view that is still a queue in its own order. Answers the queue's id.
 */
function gate(e: React.DragEvent): string | null {
  if (!isBookDragTypes([...(e.dataTransfer?.types ?? [])])) return null
  const shelfId = reorderableNow()
  if (shelfId === null || dragReorderShelfId() !== shelfId) return null
  return shelfId
}

/**
 * The open queue's id while a drag from a row or card may reorder it, else null: the
 * value a source hands `startBookDrag` as its fourth argument. A primitive per
 * subscription, so a card re-renders when the answer flips and not on every change
 * of the stores it is read from.
 */
export function useReorderableShelfId(): string | null {
  const activeShelfId = useLibraryStore((s) => s.activeShelfId)
  const sort = useLibraryStore((s) => s.sort)
  const query = useLibraryStore((s) => s.query)
  const filters = useLibraryStore((s) => s.filters)
  const deviceId = useLibraryStore((s) => s.activeDeviceId)
  const shelfKind = useShelvesStore((s) => shelfById(s, activeShelfId)?.kind ?? null)
  return activeShelfId && queueReorderable({ shelfKind, sort, query, filters, deviceId })
    ? activeShelfId
    : null
}

/** Which half of its box the pointer is over, for the row or card the mark sits on. */
export function useDropSide(bookId: string): 'before' | 'after' | null {
  return useLibraryStore((s) => (s.dropMark?.bookId === bookId ? s.dropMark.side : null))
}

export function reorderDragOver(
  e: React.DragEvent,
  targetId: string,
  offset: number,
  size: number
): void {
  if (gate(e) === null) return
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  e.preventDefault()
  const side = dropSide(offset, size)
  const mark = useLibraryStore.getState().dropMark
  // The pointer fires `dragover` every few tens of ms: write only a change
  if (mark?.bookId === targetId && mark.side === side) return
  useLibraryStore.getState().setDropMark({ bookId: targetId, side })
}

/** Clears the mark only if it is still this target's: a neighbour's `dragover` may already have moved it. */
export function reorderDragLeave(targetId: string): void {
  if (useLibraryStore.getState().dropMark?.bookId === targetId) {
    useLibraryStore.getState().setDropMark(null)
  }
}

export function reorderDrop(
  e: React.DragEvent,
  targetId: string,
  offset: number,
  size: number
): void {
  const shelfId = gate(e)
  if (shelfId === null) return
  e.preventDefault()
  useLibraryStore.getState().setDropMark(null)
  const payload = dragPayload()
  if (!payload || payload.length === 0 || payload.includes(targetId)) return
  void reorderInQueue(shelfId, [...payload], dropPlacement(targetId, dropSide(offset, size)))
}
