import { describe, expect, it } from 'vitest'
import {
  EMPTY_SELECTION,
  applyClick,
  clear,
  extendTo,
  modifiersFrom,
  prune,
  selectAll,
  selectedId,
  toggleOne,
  type Selection
} from './selection'

const ORDER = ['a', 'b', 'c', 'd', 'e']
const PLAIN = { toggle: false, range: false }
const TOGGLE = { toggle: true, range: false }
const RANGE = { toggle: false, range: true }
const TOGGLE_RANGE = { toggle: true, range: true }

/** Selections are compared by content; Sets don't compare structurally. */
function ids(sel: Selection): string[] {
  return [...sel.ids]
}

describe('modifiersFrom', () => {
  it('maps meta and ctrl to toggle, shift to range', () => {
    expect(modifiersFrom({ metaKey: true, ctrlKey: false, shiftKey: false })).toEqual(TOGGLE)
    expect(modifiersFrom({ metaKey: false, ctrlKey: true, shiftKey: false })).toEqual(TOGGLE)
    expect(modifiersFrom({ metaKey: false, ctrlKey: false, shiftKey: true })).toEqual(RANGE)
    expect(modifiersFrom({ metaKey: true, ctrlKey: false, shiftKey: true })).toEqual(TOGGLE_RANGE)
  })
})

describe('applyClick', () => {
  it('replaces the selection on a plain click and sets both anchor and cursor', () => {
    const sel = applyClick(EMPTY_SELECTION, 'c', PLAIN, ORDER)
    expect(ids(sel)).toEqual(['c'])
    expect(sel.anchor).toBe('c')
    expect(sel.cursor).toBe('c')
  })

  it('replaces a multi-selection on a plain click', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'c', TOGGLE, ORDER)
    sel = applyClick(sel, 'e', PLAIN, ORDER)
    expect(ids(sel)).toEqual(['e'])
  })

  it('adds with a toggle click and moves the anchor to it', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'd', TOGGLE, ORDER)
    expect(ids(sel).sort()).toEqual(['a', 'd'])
    expect(sel.anchor).toBe('d')
  })

  it('removes an already-selected book on a toggle click', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'd', TOGGLE, ORDER)
    sel = applyClick(sel, 'a', TOGGLE, ORDER)
    expect(ids(sel)).toEqual(['d'])
  })

  it('toggling the only selected book leaves nothing selected', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'a', TOGGLE, ORDER)
    expect(ids(sel)).toEqual([])
  })

  it('selects the range from the anchor on a shift click', () => {
    let sel = applyClick(EMPTY_SELECTION, 'b', PLAIN, ORDER)
    sel = applyClick(sel, 'd', RANGE, ORDER)
    expect(ids(sel)).toEqual(['b', 'c', 'd'])
  })

  it('ranges backwards too', () => {
    let sel = applyClick(EMPTY_SELECTION, 'd', PLAIN, ORDER)
    sel = applyClick(sel, 'b', RANGE, ORDER)
    expect(ids(sel)).toEqual(['b', 'c', 'd'])
  })

  it('re-ranges from the same anchor instead of creeping', () => {
    let sel = applyClick(EMPTY_SELECTION, 'b', PLAIN, ORDER)
    sel = applyClick(sel, 'd', RANGE, ORDER)
    sel = applyClick(sel, 'c', RANGE, ORDER)
    expect(ids(sel)).toEqual(['b', 'c'])
    expect(sel.anchor).toBe('b')
    expect(sel.cursor).toBe('c')
  })

  it('unions the range with the existing selection on a toggle-range click', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'd', TOGGLE, ORDER)
    sel = applyClick(sel, 'e', TOGGLE_RANGE, ORDER)
    expect(ids(sel).sort()).toEqual(['a', 'd', 'e'])
  })

  it('degrades a shift click with no anchor to a plain click', () => {
    const sel = applyClick(EMPTY_SELECTION, 'c', RANGE, ORDER)
    expect(ids(sel)).toEqual(['c'])
    expect(sel.anchor).toBe('c')
  })

  it('ranges over the given display order, so a re-sort changes what is adjacent', () => {
    let sel = applyClick(EMPTY_SELECTION, 'b', PLAIN, ORDER)
    sel = applyClick(sel, 'd', RANGE, ['e', 'd', 'c', 'b', 'a'])
    expect(ids(sel)).toEqual(['d', 'c', 'b'])
  })

  it('selects just the target when the anchor is no longer in the order', () => {
    const stale: Selection = { ids: new Set(['z']), anchor: 'z', cursor: 'z' }
    const sel = applyClick(stale, 'c', RANGE, ORDER)
    expect(ids(sel)).toEqual(['c'])
  })

  it('ranges to the first and last books', () => {
    const sel = applyClick(EMPTY_SELECTION, 'c', PLAIN, ORDER)
    expect(ids(applyClick(sel, 'a', RANGE, ORDER))).toEqual(['a', 'b', 'c'])
    expect(ids(applyClick(sel, 'e', RANGE, ORDER))).toEqual(['c', 'd', 'e'])
  })
})

describe('toggleOne', () => {
  it('adds, then removes, and always claims the anchor', () => {
    const added = toggleOne(EMPTY_SELECTION, 'b')
    expect(ids(added)).toEqual(['b'])
    expect(added.anchor).toBe('b')
    expect(ids(toggleOne(added, 'b'))).toEqual([])
  })
})

describe('extendTo', () => {
  it('extends from the anchor and moves only the cursor', () => {
    let sel = applyClick(EMPTY_SELECTION, 'b', PLAIN, ORDER)
    sel = extendTo(sel, 'd', ORDER)
    expect(ids(sel)).toEqual(['b', 'c', 'd'])
    expect(sel.anchor).toBe('b')
    expect(sel.cursor).toBe('d')
  })
})

describe('selectAll', () => {
  it('selects every book in order and leaves anchor and cursor alone', () => {
    const sel = selectAll(applyClick(EMPTY_SELECTION, 'c', PLAIN, ORDER), ORDER)
    expect(ids(sel).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(sel.anchor).toBe('c')
    expect(sel.cursor).toBe('c')
  })
})

describe('clear', () => {
  it('empties everything', () => {
    const sel = clear()
    expect(ids(sel)).toEqual([])
    expect(sel.anchor).toBeNull()
    expect(sel.cursor).toBeNull()
  })
})

describe('prune', () => {
  it('drops ids that no longer exist', () => {
    let sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    sel = applyClick(sel, 'd', TOGGLE, ORDER)
    expect(ids(prune(sel, ['a', 'b']))).toEqual(['a'])
  })

  it('nulls an anchor and cursor that no longer exist', () => {
    const sel = applyClick(EMPTY_SELECTION, 'd', PLAIN, ORDER)
    const pruned = prune(sel, ['a', 'b'])
    expect(pruned.anchor).toBeNull()
    expect(pruned.cursor).toBeNull()
  })

  it('returns the same object when nothing changed, so stores can skip a render', () => {
    const sel = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    expect(prune(sel, ORDER)).toBe(sel)
  })
})

describe('selectedId', () => {
  it('is the id when exactly one is selected, and null otherwise', () => {
    const one = applyClick(EMPTY_SELECTION, 'a', PLAIN, ORDER)
    expect(selectedId(one)).toBe('a')
    expect(selectedId(EMPTY_SELECTION)).toBeNull()
    expect(selectedId(applyClick(one, 'b', TOGGLE, ORDER))).toBeNull()
  })
})
