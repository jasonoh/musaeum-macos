import { useCallback, useEffect, useState } from 'react'

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

  return { ref, metrics }
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

  const start = Math.min(
    rowCount,
    Math.max(0, Math.floor(metrics.scrollTop / rowHeight) - overscan)
  )
  const end = Math.min(rowCount, start + Math.ceil(metrics.viewport / rowHeight) + overscan * 2 + 1)

  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (rowCount - end) * rowHeight
  }
}
