import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

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
  /** Re-read the element now. For a layout effect that has just moved the scroll itself. */
  sync: () => void
} {
  const [node, setNode] = useState<T | null>(null)
  const [metrics, setMetrics] = useState<ScrollMetrics>(ZERO)
  const ref = useCallback((el: T | null) => setNode(el), [])

  const measure = useCallback(() => {
    if (!node) return
    setMetrics((prev) =>
      prev.scrollTop === node.scrollTop &&
      prev.viewport === node.clientHeight &&
      prev.width === node.clientWidth
        ? prev // identity-stable so an unchanged scroll event can't re-render
        : { scrollTop: node.scrollTop, viewport: node.clientHeight, width: node.clientWidth }
    )
  }, [node])

  useEffect(() => {
    // No node: keep the last metrics. Nothing renders against them while the
    // container is unmounted, and remounting re-measures immediately.
    if (!node) return

    // `observe` delivers an initial notification, so there is no separate first
    // measure; it arrives before the first paint
    node.addEventListener('scroll', measure, { passive: true })
    // Flushed, not scheduled: a resize delivered here is followed by a paint
    // before a scheduled render would run, and that frame shows the old
    // geometry stretched across the new width — a flash the panel opening
    // makes visible, and `useGridFlip` cannot start from.
    const observer = new ResizeObserver(() => flushSync(measure))
    observer.observe(node)
    return () => {
      node.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [node, measure])

  return { ref, node, metrics, sync: measure }
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
 * So the anchor is a book, not a pixel. Two are kept:
 *
 * - the **focused book** (`focusId`, the selection's cursor), at the height
 *   it had in the viewport — it is the one the reader just clicked and is
 *   watching, so it stays at the same height and only the tiles around it
 *   move. Anchoring the top of the viewport instead sent the clicked tile
 *   (and, relative to it, everything else) up to 600px when the panel opened.
 *   It is a dependency, so the click that opens the panel records the
 *   book's height before the layout changes under it. The id is kept after the
 *   selection clears, because closing the panel is exactly when the selection
 *   has just gone. Only used while the book is
 *   inside the viewport; a selection scrolled out of view anchors nothing.
 * - otherwise the item at the top of the viewport, recorded on every scroll.
 *
 * `useBookNavigation`'s ensure-visible effect runs after this one (layout
 * effects precede plain effects), so a selection that this scroll pushed out of
 * view is nudged back — the two compose instead of fighting.
 *
 * `onScrolled` is how the caller's metrics learn of the move *before paint*.
 * This render's row window was computed from the old `scrollTop`, so after the
 * jump part of the viewport is spacer; waiting for the scroll event leaves that
 * frame on screen and pops the missing tiles in a commit later — measured, with
 * the detail panel opening: 20 of 40 rendered tiles swapped, none animated.
 * A state update from a layout effect is flushed before paint.
 */
export function useAnchoredScroll(
  node: HTMLElement | null,
  ids: string[],
  columns: number,
  rowHeight: number,
  contentTop: number,
  scrollTop: number,
  focusId: string | null,
  onScrolled: () => void
): void {
  const geometry = useRef({ columns: 0, rowHeight: 0 })
  const anchorId = useRef<string | null>(null)
  const focus = useRef<{ id: string; offset: number } | null>(null)
  const lastFocusId = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (!node || rowHeight <= 0 || columns <= 0 || !ids.length) return

    const previous = geometry.current
    const changed =
      previous.rowHeight > 0 &&
      (previous.columns !== columns || Math.abs(previous.rowHeight - rowHeight) > 0.5)
    geometry.current = { columns, rowHeight }

    if (changed) {
      const held = focus.current
      const heldIndex = held ? ids.indexOf(held.id) : -1
      if (held && heldIndex >= 0) {
        const row = Math.floor(heldIndex / columns)
        setScrollTop(node, Math.max(0, contentTop + row * rowHeight - held.offset))
        onScrolled()
        return
      }
      const index = anchorId.current ? ids.indexOf(anchorId.current) : -1
      if (index >= 0) {
        setScrollTop(node, contentTop + Math.floor(index / columns) * rowHeight)
        onScrolled()
        return // recording now would capture the pre-paint offset
      }
    }

    const row = Math.max(0, Math.round((node.scrollTop - contentTop) / rowHeight))
    anchorId.current = ids[Math.min(ids.length - 1, row * columns)] ?? null

    lastFocusId.current = focusId ?? lastFocusId.current
    const focusIndex = lastFocusId.current ? ids.indexOf(lastFocusId.current) : -1
    const offset =
      focusIndex >= 0
        ? contentTop + Math.floor(focusIndex / columns) * rowHeight - node.scrollTop
        : NaN
    // The tile's top edge has to be on screen for holding its height to mean anything
    focus.current =
      lastFocusId.current && offset >= 0 && offset < node.clientHeight
        ? { id: lastFocusId.current, offset }
        : null
  }, [node, ids, columns, rowHeight, contentTop, scrollTop, focusId, onScrolled])
}

/**
 * Reset the scroll container to the top when the result-set identity — the
 * query/filters/sort tuple in `library.store`, summarized by
 * `resultSetKey()` — changes. Without this, `scrollTop` is a pixel offset
 * left over from whatever was previously loaded: scroll to the bottom of a
 * 7000-book library, search down to 1072 matches, and the container is left
 * parked near the bottom of a result set it has never shown.
 *
 * Keyed on the identity, not on `books` itself or its length — a metadata
 * edit, a single-book delete, or a re-fetch of the same query all replace
 * `books` without changing the identity, and the anchor/ensure-visible
 * behavior for *that* case is deliberate (see `useAnchoredScroll` and
 * `useBookNavigation`) and must not be touched by this hook.
 *
 * A layout effect, so it runs before paint and before every other effect
 * that reads `node.scrollTop` this commit. In particular it must run before
 * `useAnchoredScroll` (call it first) so that hook's next anchor is recorded
 * against the *new* scrollTop of 0 — otherwise it would record an anchor
 * computed from a stale offset that may not even exist in the new, shorter
 * list. It intentionally does not try to out-race `useBookNavigation`'s
 * ensure-visible pass, which is a plain `useEffect` and therefore runs
 * after every layout effect in this commit: if the previously selected book
 * survives into the new result set, ensure-visible legitimately scrolls it
 * back into view after this hook resets to the top. That composes with the
 * rest of selection's behavior (selection is pruned to survivors, not
 * cleared by a narrower query — see `useLibrary`) rather than fighting it.
 * With nothing selected, or a selection that didn't survive, there is
 * nothing for ensure-visible to do and the reset to the top is final.
 */
export function useResetScrollOnResultChange(node: HTMLElement | null, resultKey: string): void {
  const previous = useRef(resultKey)

  useLayoutEffect(() => {
    if (node && previous.current !== resultKey) {
      setScrollTop(node, 0)
    }
    previous.current = resultKey
  }, [node, resultKey])
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
