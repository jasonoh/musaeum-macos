/**
 * The library's selection grammar, as pure functions.
 *
 * All of it lives here rather than in the views because the rules are subtle
 * — the anchor/cursor split below is the difference between shift-clicking
 * that re-ranges and shift-clicking that creeps — and because this way they
 * are testable with no React, no DOM and no Electron.
 *
 * `order` is always the ids of the books *as currently displayed*, so a range
 * follows what the user can see after a re-sort or a filter change.
 */

export interface Selection {
  ids: ReadonlySet<string>
  /** Range pivot. Set by plain and toggle clicks; range clicks leave it. */
  anchor: string | null
  /** Keyboard focus / ensure-visible target. Moves on every gesture. */
  cursor: string | null
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null, cursor: null }

export interface ClickModifiers {
  /** ⌘ or ctrl: add/remove one book. */
  toggle: boolean
  /** ⇧: select from the anchor to here. */
  range: boolean
}

export function modifiersFrom(e: {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}): ClickModifiers {
  return { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey }
}

/** Inclusive slice between two ids, in display order, in either direction. */
function rangeBetween(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from)
  const b = order.indexOf(to)
  // An anchor that has left the library (deleted, or filtered out) can't
  // define a range; selecting just the target is the least surprising answer.
  if (a === -1 || b === -1) return b === -1 ? [] : [to]
  return order.slice(Math.min(a, b), Math.max(a, b) + 1)
}

export function applyClick(
  sel: Selection,
  id: string,
  mods: ClickModifiers,
  order: readonly string[]
): Selection {
  if (mods.range && sel.anchor) {
    const range = rangeBetween(order, sel.anchor, id)
    // ⌘⇧ adds the range to what's already selected; ⇧ alone replaces it
    const ids = mods.toggle ? new Set([...sel.ids, ...range]) : new Set(range)
    return { ids, anchor: sel.anchor, cursor: id }
  }
  if (mods.toggle) return toggleOne(sel, id)
  return { ids: new Set([id]), anchor: id, cursor: id }
}

export function toggleOne(sel: Selection, id: string): Selection {
  const ids = new Set(sel.ids)
  if (ids.has(id)) ids.delete(id)
  else ids.add(id)
  // The anchor follows even when removing: the next ⇧-click should range from
  // the book the user last touched, which is this one either way.
  return { ids, anchor: id, cursor: id }
}

/** ⇧+arrow: the same rule as a ⇧-click, from wherever the cursor is. */
export function extendTo(sel: Selection, id: string, order: readonly string[]): Selection {
  return applyClick(sel, id, { toggle: false, range: true }, order)
}

export function selectAll(sel: Selection, order: readonly string[]): Selection {
  // Changes what is selected, not where the user is
  return { ids: new Set(order), anchor: sel.anchor, cursor: sel.cursor }
}

export function clear(): Selection {
  return EMPTY_SELECTION
}

/**
 * Drop anything that is no longer in the library. Returns the *same object*
 * when nothing changed, so a store can set it unconditionally on every load
 * without causing a render.
 */
export function prune(sel: Selection, existing: readonly string[]): Selection {
  const keep = new Set(existing)
  const ids = new Set([...sel.ids].filter((id) => keep.has(id)))
  const anchor = sel.anchor && keep.has(sel.anchor) ? sel.anchor : null
  const cursor = sel.cursor && keep.has(sel.cursor) ? sel.cursor : null
  if (ids.size === sel.ids.size && anchor === sel.anchor && cursor === sel.cursor) return sel
  return { ids, anchor, cursor }
}

/** The single-selection view of a selection: null unless exactly one. */
export function selectedId(sel: Selection): string | null {
  if (sel.ids.size !== 1) return null
  return sel.ids.values().next().value ?? null
}
