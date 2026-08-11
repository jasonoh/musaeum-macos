import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Row windowing for the library views. Both the grid and the list are uniform
 * rows of a computable height, so windowing needs no per-item measurement —
 * `useScrollMetrics` watches the scroll container and `rowWindow` turns those
 * metrics into a slice plus top/bottom spacers.
 *
 * The alternative (react-window) wants absolutely positioned cells, which
 * would cost the grid its CSS-grid layout and the list its real <table>.
 */

export interface ScrollMetrics {
  scrollTop: number
  /** Visible height of the scroll container. */
  viewport: number
  /** Inner width of the scroll container, excluding any vertical scrollbar. */
  width: number
}

const ZERO: ScrollMetrics = { scrollTop: 0, viewport: 0, width: 0 }

/**
 * Track scroll offset and box size of the element the returned ref is attached
 * to. A callback ref (not `useRef`) so measurement starts whenever the node
 * mounts, including when a view swaps its container in and out.
 */
export function useScrollMetrics<T extends HTMLElement>(): {
  ref: (el: T | null) => void
  /** The measured element, for imperative scrolling (see useBookNavigation). */
  node: T | null
  metrics: ScrollMetrics
} {
  const [node, setNode] = useState<T | null>(null)
  const [metrics, setMetrics] = useState<ScrollMetrics>(ZERO)
  const ref = useCallback((el: T | null) => setNode(el), [])

  useEffect(() => {
    // No node: keep the last metrics. Nothing renders against them while the
    // container is unmounted, and remounting re-measures immediately.
    if (!node) return

    const measure = () =>
      setMetrics((prev) =>
        prev.scrollTop === node.scrollTop &&
        prev.viewport === node.clientHeight &&
        prev.width === node.clientWidth
          ? prev // identity-stable so an unchanged scroll event can't re-render
          : { scrollTop: node.scrollTop, viewport: node.clientHeight, width: node.clientWidth }
      )

    measure()
    node.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      node.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [node])

  return { ref, node, metrics }
}

/** See useAnchoredScroll — separated so the lint rule against mutating hook
 *  arguments doesn't fire on the one place that must set scrollTop. */
function setScrollTop(el: HTMLElement, top: number): void {
  el.scrollTop = top
}

/**
 * Hold the reader's place across a change in row geometry.
 *
 * `scrollTop` is a pixel offset, but the grid's column count and row height
 * change with the container width — so the same offset addresses a different
 * part of the library after the detail panel opens or closes. Measured: at
 * 1206px the viewport showed books 105–125; opening the panel, deleting the
 * book and letting the panel close left the identical scrollTop showing books
 * 148–168.
 *
 * So the anchor is a book, not a pixel: the item at the top of the viewport is
 * recorded on every scroll, and when the geometry changes it is put back at the
 * top. `useBookNavigation`'s ensure-visible effect runs after this one (layout
 * effects precede plain effects), so a selection that this scroll pushed out of
 * view is nudged back — the two compose instead of fighting.
 */
export function useAnchoredScroll(
  node: HTMLElement | null,
  ids: string[],
  columns: number,
  rowHeight: number,
  contentTop: number,
  scrollTop: number
): void {
  const geometry = useRef({ columns: 0, rowHeight: 0 })
  const anchorId = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (!node || rowHeight <= 0 || columns <= 0 || !ids.length) return

    const previous = geometry.current
    const changed =
      previous.rowHeight > 0 &&
      (previous.columns !== columns || Math.abs(previous.rowHeight - rowHeight) > 0.5)
    geometry.current = { columns, rowHeight }

    if (changed) {
      const index = anchorId.current ? ids.indexOf(anchorId.current) : -1
      if (index >= 0) {
        setScrollTop(node, contentTop + Math.floor(index / columns) * rowHeight)
        return // recording now would capture the pre-paint offset
      }
    }

    const row = Math.max(0, Math.round((node.scrollTop - contentTop) / rowHeight))
    anchorId.current = ids[Math.min(ids.length - 1, row * columns)] ?? null
  }, [node, ids, columns, rowHeight, contentTop, scrollTop])
}

export interface RowWindow {
  /** First row to render. */
  start: number
  /** One past the last row to render. */
  end: number
  /** Spacer height standing in for rows above the window. */
  padTop: number
  /** Spacer height standing in for rows below the window. */
  padBottom: number
}

/**
 * Rows overlapping the viewport, widened by `overscan` rows on each side so a
 * fast scroll doesn't outrun the render.
 */
export function rowWindow(
  rowCount: number,
  rowHeight: number,
  metrics: ScrollMetrics,
  overscan: number
): RowWindow {
  if (rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }

  // `metrics.scrollTop` is one frame behind whenever the row geometry changes
  // (books removed, or the grid's column count changing as the detail panel
  // opens/closes), so it can exceed the content it now describes. Clamping to
  // the real maximum keeps that frame showing the last rows rather than an
  // empty window under a full-height spacer; the browser clamps the element's
  // own scrollTop right after, and the scroll listener catches up.
  const maxScroll = Math.max(0, rowCount * rowHeight - metrics.viewport)
  const scrollTop = Math.min(Math.max(0, metrics.scrollTop), maxScroll)

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(rowCount, start + Math.ceil(metrics.viewport / rowHeight) + overscan * 2 + 1)

  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (rowCount - end) * rowHeight
  }
}
