import { useEffect, useRef } from 'react'
import { useLibraryStore } from '@/stores/library.store'
import { useReaderStore } from '@/stores/reader.store'
import { useUIStore } from '@/stores/ui.store'

/**
 * Keyboard selection and selection-follows-scroll for the library views.
 *
 * Selection lives in the UI store, not in either view, so it survives a
 * grid↔list switch — but the scroll position doesn't (each view mounts its own
 * scroller at the top). This hook restores the connection: on mount it brings
 * the selected book into view, and arrow keys move the selection through the
 * same geometry the virtualizer uses, so "where I was" is never lost.
 *
 * Both views are uniform rows, so the row of a book is `index / columns` —
 * the list passes `columns: 1` and its sticky header as `contentTop`/`stickyTop`.
 */

export interface BookNavigationOptions {
  /** The scroll container, from `useScrollMetrics`. */
  node: HTMLElement | null
  /** Cards per row; 1 for the list, where up/down move one book. */
  columns: number
  rowHeight: number
  /** Offset of row 0 inside the scroll content (container padding / header). */
  contentTop: number
  /** Height of the sticky region covering the top of the viewport, if any. */
  stickyTop?: number
  /**
   * False while the container hasn't been measured — the grid's column count
   * and row height are meaningless at zero width, and scrolling against them
   * would land somewhere arbitrary.
   */
  ready: boolean
}

/** Scrolling a DOM node is the whole point here; kept out of the hook body so
 *  the lint rule against mutating hook arguments doesn't fire on it. */
function scrollTo(el: HTMLElement, top: number): void {
  el.scrollTop = top
}

/** Exported so the reader's own key handler bails on the same targets. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el?.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

export function useBookNavigation({
  node,
  columns,
  rowHeight,
  contentTop,
  stickyTop = 0,
  ready
}: BookNavigationOptions): void {
  const books = useLibraryStore((s) => s.books)
  const cursorId = useUIStore((s) => s.selection.cursor)
  const selectionSize = useUIStore((s) => s.selection.ids.size)
  const selectBook = useUIStore((s) => s.selectBook)
  const extendSelectionTo = useUIStore((s) => s.extendSelectionTo)
  const clearSelection = useUIStore((s) => s.clearSelection)
  const modal = useUIStore((s) => s.modal)
  const contextMenu = useUIStore((s) => s.contextMenu)
  const deletingBookId = useUIStore((s) => s.deletingBookId)
  const deletingSelection = useUIStore((s) => s.deletingSelection)
  const editingBookId = useUIStore((s) => s.editingBookId)
  const removingFromDevice = useUIStore((s) => s.removingFromDevice)
  const readerBookId = useReaderStore((s) => s.bookId)

  // Navigation follows the cursor, not the selection: with a range selected,
  // the book the user last moved to is the one to keep in view
  const index = cursorId ? books.findIndex((b) => b.id === cursorId) : -1

  /**
   * Whether this mount has already aligned itself to the selection. The first
   * alignment centres (arriving from the other view, the book should have
   * context around it); later ones only nudge the selection back into view.
   */
  const aligned = useRef(false)

  useEffect(() => {
    if (!ready || !node || rowHeight <= 0) return
    const viewport = node.clientHeight
    if (!viewport) return
    if (index < 0) {
      aligned.current = true // nothing to align to; later clicks just ensure-visible
      return
    }

    const row = Math.floor(index / columns)
    const rowTop = contentTop + row * rowHeight
    const rowBottom = rowTop + rowHeight
    const visibleTop = node.scrollTop + stickyTop
    const visibleBottom = node.scrollTop + viewport

    if (!aligned.current) {
      aligned.current = true
      if (rowTop < visibleTop || rowBottom > visibleBottom) {
        scrollTo(node, rowTop - stickyTop - Math.max(0, (viewport - stickyTop - rowHeight) / 2))
      }
      return
    }
    if (rowTop < visibleTop) scrollTo(node, rowTop - stickyTop)
    else if (rowBottom > visibleBottom) scrollTo(node, rowBottom - viewport)
  }, [ready, node, index, columns, rowHeight, contentTop, stickyTop])

  useEffect(() => {
    // Whatever is painted over the library owns the keyboard while it's open —
    // including Escape, which each of those closes itself with. The reader is
    // the inverse of its own guard: without this, arrows would page the book
    // and walk the selection underneath it at the same time.
    if (
      !ready ||
      modal ||
      contextMenu ||
      deletingBookId ||
      deletingSelection ||
      editingBookId ||
      removingFromDevice ||
      readerBookId
    )
      return

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      if (e.key === 'Escape') {
        if (!selectionSize) return
        e.preventDefault()
        clearSelection()
        return
      }
      if (!books.length) return

      const last = books.length - 1
      const page = Math.max(1, Math.floor((node?.clientHeight ?? 0) / rowHeight)) * columns
      const clamp = (n: number) => Math.min(last, Math.max(0, n))
      // With nothing selected, any arrow starts at the top of the library
      const from = index < 0 ? null : index
      let next: number
      switch (e.key) {
        case 'ArrowDown':
          next = from === null ? 0 : clamp(from + columns)
          break
        case 'ArrowUp':
          next = from === null ? 0 : clamp(from - columns)
          break
        case 'ArrowRight':
          if (columns === 1) return
          next = from === null ? 0 : clamp(from + 1)
          break
        case 'ArrowLeft':
          if (columns === 1) return
          next = from === null ? 0 : clamp(from - 1)
          break
        case 'PageDown':
          next = from === null ? 0 : clamp(from + page)
          break
        case 'PageUp':
          next = from === null ? 0 : clamp(from - page)
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = last
          break
        default:
          return
      }
      e.preventDefault() // arrows would otherwise scroll the container away
      if (next === index) return
      // ⇧ extends the range from the anchor; a plain arrow collapses to one
      if (e.shiftKey) extendSelectionTo(books[next].id)
      else selectBook(books[next].id)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    ready,
    modal,
    contextMenu,
    deletingBookId,
    deletingSelection,
    editingBookId,
    removingFromDevice,
    readerBookId,
    books,
    index,
    selectionSize,
    selectBook,
    extendSelectionTo,
    clearSelection,
    columns,
    rowHeight,
    node
  ])
}
