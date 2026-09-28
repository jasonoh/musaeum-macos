import type { Book } from '@shared/book.types'
import type { Selection } from '@/lib/selection'
import { coverUrl } from '@/lib/cover-url'
import { useLibraryStore } from '@/stores/library.store'

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

/** The least a drag handler has to carry: keep the module free of a React import. */
export interface DragHandle {
  dataTransfer: DataTransfer | null
  currentTarget: EventTarget | null
}

/**
 * Start a book drag: the payload goes to the slot *and* to `dataTransfer`, the
 * selection is left alone, and the drag image is the fan (S9).
 *
 * The `text/plain` fallback is not decoration: a drop somewhere that is not this
 * app reads it, and it must not find raw JSON. The MIME type is what our own
 * targets could read in `drop` if the slot ever disagreed with it.
 */
export function startBookDrag(e: DragHandle, bookId: string, sel: Selection): void {
  const ids = dragScope(bookId, sel)
  setDragPayload(ids)
  const dt = e.dataTransfer
  if (!dt) return
  dt.effectAllowed = 'copy'
  dt.setData(BOOK_DRAG_MIME, JSON.stringify(ids))
  dt.setData('text/plain', ids.join('\n'))
  setDragImage(dt, ids, e.currentTarget)
}

/**
 * The fan: up to three covers and a gold count badge.
 *
 * Task 1's spike could not *see* which of these two bodies paints: macOS
 * composites drag images at the window-server layer, so `Page.captureScreenshot`
 * shows nothing in either drag mode, and OS-level `screencapture` is denied to
 * that session. What it did measure is the input a snapshot needs — an `<img>`
 * pointed at a cover the grid is already showing is synchronously
 * `complete=true` at `dragstart` (a memory-cache hit) — so the fan stays
 * primary, with the source's own cover as the fallback S9 names. The residual:
 * if a human hand-drag of the *first* drag of a session shows no thumbnail, the
 * answer is to delete Body A and keep Body B — a one-function-body change,
 * deliberately cheap.
 *
 * The node is appended to `document.body`, so `:root`'s custom properties reach
 * it and the palette is written as the *tokens* the rest of the renderer uses —
 * a divergence from the plan's literal values, which did not match
 * `src/index.css`'s declared channels and would have been invisible to a stored
 * theme.
 */
function setDragImage(dt: DataTransfer, ids: readonly string[], source: EventTarget | null): void {
  // -- Body A (D9): the fanned stack ----------------------------------------
  const books = useLibraryStore.getState().books
  const covers = ids
    .map((id) => books.find((b) => b.id === id))
    .filter((b): b is Book => Boolean(b))
    .slice(0, 3)
    .map((b) => coverUrl(b, 'thumb'))
    .filter((url): url is string => Boolean(url))
  if (covers.length) {
    const node = document.createElement('div')
    node.style.cssText =
      'position:fixed;top:-1000px;left:-1000px;display:flex;padding:6px 10px;border-radius:8px;background:rgb(var(--ink-900) / 0.92)'
    for (const url of covers) {
      const img = document.createElement('img')
      img.src = url
      // `sync` because this element is created and snapshotted inside one
      // `dragstart`: the URL is the grid's own, a memory-cache hit, and the hint
      // is what makes the decode land before the snapshot rather than after it
      img.decoding = 'sync'
      img.width = 48
      img.style.cssText =
        'width:48px;height:72px;object-fit:cover;margin-right:-14px;border-radius:3px'
      node.appendChild(img)
    }
    if (ids.length > 1) {
      const badge = document.createElement('span')
      badge.textContent = String(ids.length)
      badge.style.cssText =
        'align-self:flex-end;margin-left:22px;font:600 13px system-ui;color:rgb(var(--gold-400))'
      node.appendChild(badge)
    }
    document.body.appendChild(node)
    dt.setDragImage(node, 24, 36)
    // Removed on the next task, never synchronously: Chromium has to paint it
    setTimeout(() => node.remove(), 0)
    return
  }
  // -- Body B (S9's fallback): the source's own cover ------------------------
  const img = (source as HTMLElement | null)?.querySelector?.('img')
  if (img) dt.setDragImage(img, 24, 36)
}
