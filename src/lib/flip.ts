/**
 * The arithmetic of a FLIP glide (First, Last, Invert, Play): given where each
 * tile was and where it now is, work out the transform that puts it back where
 * it was, so animating that transform to `none` carries it to where it is.
 *
 * Boxes are relative to the scroll container's own viewport, not to its content.
 * The grid re-anchors its scroll position when the column count changes
 * (`useAnchoredScroll`), so a tile's offset into the *content* can move by whole
 * rows while it stays under the reader's eye; the viewport is the frame the
 * reader actually watches.
 */

export interface FlipBox {
  x: number
  y: number
  w: number
}

export interface FlipMove {
  id: string
  dx: number
  dy: number
  /** Uniform: a card's height follows its width, and the origin is top-left. */
  scale: number
}

export interface FlipPlan {
  /** Tiles present both before and after whose box changed. */
  moves: FlipMove[]
  /** Tiles that were not rendered before — the window grew to include them. */
  entering: string[]
}

/** Below these a tile has not visibly moved, and animating it is just work. */
const MIN_SHIFT = 1 // px
const MIN_SCALE_DELTA = 0.005

export function planFlip(
  before: ReadonlyMap<string, FlipBox>,
  after: ReadonlyMap<string, FlipBox>
): FlipPlan {
  const moves: FlipMove[] = []
  const entering: string[] = []

  for (const [id, now] of after) {
    const was = before.get(id)
    if (!was) {
      entering.push(id)
      continue
    }
    const dx = was.x - now.x
    const dy = was.y - now.y
    const scale = now.w > 0 && was.w > 0 ? was.w / now.w : 1
    if (
      Math.abs(dx) < MIN_SHIFT &&
      Math.abs(dy) < MIN_SHIFT &&
      Math.abs(scale - 1) < MIN_SCALE_DELTA
    )
      continue
    moves.push({ id, dx, dy, scale })
  }

  return { moves, entering }
}

/**
 * How long the glide should take: the eye can follow a tile at only so many
 * pixels a second, so a tile crossing the grid needs longer than one that
 * slides a column. Scaled by the longest trip in the plan and clamped, so a
 * nudge is still quick and the worst case is not sluggish.
 */
const MIN_DURATION_MS = 360
const MAX_DURATION_MS = 640
const MS_PER_PX = 0.3

export function glideDuration(plan: FlipPlan): number {
  const longest = plan.moves.reduce((max, m) => Math.max(max, Math.hypot(m.dx, m.dy)), 0)
  return Math.round(Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, 300 + longest * MS_PER_PX)))
}
