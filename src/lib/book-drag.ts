import type { Selection } from '@/lib/selection'

/**
 * The one drag in the app that is *not* a file import (D9).
 *
 * A book drag carries this MIME type, and `useDragDrop` — whose job is Finder
 * files — asks `isImportDrag` below rather than checking `'Files'` itself, so a
 * book dragged inside the window never raises the import overlay. AC25 is
 * decided by cases over that predicate, which is why it is exported rather than
 * inlined in the hook.
 */
export const BOOK_DRAG_MIME = 'application/x-musaeum-books'

/**
 * Whether a drag in flight is a file drop — the question that decides the import
 * overlay.
 */
export function isImportDrag(types: readonly string[]): boolean {
  return types.includes('Files')
}

/**
 * What a drag of `bookId` carries: the whole selection when the dragged book is
 * part of one, that book alone otherwise.
 *
 * Mirrors `contextMenuScope`, including its boundary (`size > 1`) and its rule
 * that a gesture's scope is *not* a side effect: nothing here — and no caller —
 * moves the selection for a drag (S8).
 */
export function dragScope(bookId: string, sel: Selection): string[] {
  return sel.ids.size > 1 && sel.ids.has(bookId) ? [...sel.ids] : [bookId]
}

/**
 * The drag's payload, held for the length of the drag and no longer.
 *
 * **Why a module slot as well as `dataTransfer` (S2).** Chromium protects the
 * drag data store for the duration of the drag: `getData()` answers `''` while
 * the pointer is over a target, so a target cannot read the ids to decide
 * whether to light up, or say *"3 books"* while hovering. And the source element
 * may be gone by the time anything else asks: the views are virtualized, so a
 * row scrolled out mid-drag unmounts, taking any per-element ref with it (AC27).
 *
 * The ids are written to `dataTransfer` too, at `dragstart` — a drag with no
 * data is refused as a drop on some paths — but the slot is what the targets
 * read.
 */
let payload: string[] | null = null

export function setDragPayload(ids: readonly string[]): void {
  payload = [...ids]
}

export function dragPayload(): readonly string[] | null {
  return payload
}

export function clearDragPayload(): void {
  payload = null
}
