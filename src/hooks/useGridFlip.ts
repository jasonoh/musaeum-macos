import { useLayoutEffect, useRef } from 'react'
import { glideDuration, planFlip, type FlipBox, type FlipPlan } from '@/lib/flip'

/**
 * Symmetric on purpose. The panel's own slide is a 220ms ease-out
 * (`cubic-bezier(0.16, 1, 0.3, 1)`), which covers ~90% of the distance in the
 * first quarter of its time — right for a thing that arrives, too fast for a
 * field of tiles the eye has to follow. Measured against it: tiles crossed
 * 300–600px in under 60ms, and the first run of this hook reused that curve.
 * The duration is per glide (`glideDuration`), not a constant.
 */
const EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'

interface Snapshot {
  boxes: Map<string, FlipBox>
  elements: Map<string, HTMLElement>
}

/** Every rendered card's box, relative to the container's viewport. */
function snapshot(node: HTMLElement): Snapshot {
  const origin = node.getBoundingClientRect()
  const boxes = new Map<string, FlipBox>()
  const elements = new Map<string, HTMLElement>()
  for (const el of node.querySelectorAll<HTMLElement>('[data-book-id]')) {
    const id = el.dataset.bookId
    if (!id) continue
    const rect = el.getBoundingClientRect()
    boxes.set(id, { x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width })
    elements.set(id, el)
  }
  return { boxes, elements }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Glide the grid's tiles to their new places when the side panel opens or
 * closes, instead of snapping.
 *
 * The panel takes width from the grid, so the column count changes and nearly
 * every tile lands somewhere else at once — which makes the clicked book hard
 * to find. The layout itself is never animated: the virtualizer computes its
 * geometry from the container width (`GridView`), and a width that changed
 * every frame would re-flow the window every frame. Instead the grid settles
 * at its final layout in one step, and each tile is animated with a transform
 * from where it *was*.
 *
 * `measuredWidth` and `measuredScrollTop` are what the render was computed
 * against. The panel lands in the DOM one commit before the metrics catch up
 * with it, and a snapshot taken in between would describe cards stretched across
 * the old column count; the scroll anchor likewise moves `scrollTop` after the
 * row window was chosen. While either disagrees with the node this hook neither
 * records nor plays. Pass the render's own copies, not a fresh read of the node.
 *
 * Declare it after `useAnchoredScroll`: that hook re-positions the scroll in
 * its own layout effect, and the tiles must be measured after it has.
 */
export function useGridFlip(
  node: HTMLElement | null,
  panelOpen: boolean,
  measuredWidth: number,
  measuredScrollTop: number
): void {
  const previous = useRef<Map<string, FlipBox>>(new Map())
  const wasOpen = useRef(panelOpen)
  const pending = useRef(false)
  // Counts glides, so a finished one can tell whether it is still the latest
  const glide = useRef(0)
  const gliding = useRef(false)

  // No deps on purpose: tiles move on every kind of commit, and the baseline
  // has to be the last settled frame, whatever produced it.
  useLayoutEffect(() => {
    if (!node) return
    if (wasOpen.current !== panelOpen) {
      wasOpen.current = panelOpen
      pending.current = true
    }
    // Same for the scroll: until the render has caught up with it, the tiles
    // present are the previous window's, and the viewport is part spacer
    if (node.clientWidth !== measuredWidth) return
    if (Math.abs(node.scrollTop - measuredScrollTop) > 1) return
    // A glide in flight displaces the tiles by its own transforms, so a
    // snapshot now records where they are *drawn*, not where they are. The
    // scroll `useAnchoredScroll` just set fires a commit mid-glide, and
    // recording it made the next glide start from a mid-flight frame — the
    // clicked tile jumped hundreds of px on its first frame. The baseline is
    // taken again when the glide ends.
    if (gliding.current && !pending.current) return

    if (!pending.current) {
      previous.current = snapshot(node).boxes
      return
    }
    pending.current = false
    // Back to the layout's own positions before measuring where they are now
    for (const animation of node.getAnimations({ subtree: true })) {
      // Only this hook's own, on the cards — not the cover's hover transitions
      const target = (animation.effect as KeyframeEffect | null)?.target
      if (target instanceof HTMLElement && target.dataset.bookId) animation.cancel()
    }
    const { boxes, elements } = snapshot(node)
    const plan = planFlip(previous.current, boxes)
    previous.current = boxes
    if (prefersReducedMotion()) return

    const running = play(elements, plan)
    const mine = ++glide.current
    gliding.current = running.length > 0
    void Promise.allSettled(running.map((a) => a.finished)).then(() => {
      if (mine !== glide.current) return
      gliding.current = false
      if (node.isConnected) previous.current = snapshot(node).boxes
    })
  })
}

function play(elements: Map<string, HTMLElement>, plan: FlipPlan): Animation[] {
  const timing = { duration: glideDuration(plan), easing: EASING }
  const running: Animation[] = []
  for (const { id, dx, dy, scale } of plan.moves) {
    const animation = elements.get(id)?.animate(
      [
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
        { transformOrigin: '0 0', transform: 'none' }
      ],
      timing
    )
    if (animation) running.push(animation)
  }
  for (const id of plan.entering) {
    const animation = elements.get(id)?.animate([{ opacity: 0 }, { opacity: 1 }], timing)
    if (animation) running.push(animation)
  }
  return running
}
