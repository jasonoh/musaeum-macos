import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Source walks over the two right-click entry points, in `src/components/library`.
 *
 * The owner's report (2026-09-25, the grid): a right-click on a card opened the
 * details panel *as well as* the menu. It did that through the selection — the
 * panel renders from the derived single selection — so the rule this file keeps
 * from coming back is that a right-click runs the menu and nothing else.
 *
 * The renderer has no DOM harness in this repo (the vitest environment is Node,
 * with no React testing library), so a *wiring* claim is decided by reading the
 * files: what each handler calls. What those calls then do is decided by real
 * cases — `src/lib/selection.test.ts` for the menu's scope,
 * `src/stores/ui.store.test.ts` for the action — and what is painted is the
 * running app's: a right-click over CDP, with the panels counted off the DOM.
 *
 * What this does not prove: that the browser fires nothing else on a
 * right-click. Only the live probe decides that.
 */

const read = (file: string): string =>
  readFileSync(join(process.cwd(), 'src', 'components', 'library', file), 'utf8')

/** The body of a view's `onContextMenu` — what a right-click actually runs. */
function contextMenuHandler(source: string): string {
  // Comments are removed *before* the slice, not after: a comment inside a
  // handler can name a selection call (a spurious failure of the assertions
  // below), and one containing `}}` would end the slice early and hide a real
  // one. The slice still ends at the first `}}`, so a handler whose body nests
  // an object literal that early is not covered by this walk.
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const start = bare.indexOf('onContextMenu={(e) => {')
  expect(start, 'the view must handle a right-click').toBeGreaterThan(-1)
  const end = bare.indexOf('}}', start)
  expect(end, 'the handler must be an arrow body').toBeGreaterThan(start)
  return bare.slice(start, end)
}

const VIEWS: [string, string][] = [
  ['BookCard.tsx', read('BookCard.tsx')],
  ['ListView.tsx', read('ListView.tsx')]
]

/** Selection actions, any one of which would perform the left click's job. */
const SELECTIONS = ['select(', 'selectBook(', 'toggleBookSelection(', 'applyClick(']

describe.each(VIEWS)("%s's right-click", (_file, source) => {
  it('opens the context menu', () => {
    expect(contextMenuHandler(source)).toMatch(/openContextMenu\(/)
  })

  it('runs no selection action, so no selection-derived panel opens with it', () => {
    const handler = contextMenuHandler(source)
    for (const call of SELECTIONS) {
      expect(handler, `a right-click must not run ${call}`).not.toContain(call)
    }
  })
})

describe('the menu', () => {
  const MENU = read('BookContextMenu.tsx')

  it('reads its scope through the rule, not off the selection size', () => {
    // The click no longer moves the selection, so `count` alone cannot say
    // whether the bulk items apply — it would offer them for a book outside the
    // selection they would delete
    expect(MENU).toContain('contextMenuScope(book.id, selection)')
    expect(MENU).not.toContain('count >= 2')
  })
})

describe('the shelf entries (AC19)', () => {
  const MENU = read('BookContextMenu.tsx')
  const PANEL = read('SelectionPanel.tsx')

  it('offers Add to Shelf… in both scopes and in the panel', () => {
    // Two scopes in one file, so this counts rather than matches once
    expect(MENU.match(/label="Add to Shelf…"/g)?.length).toBe(2)
    expect(PANEL).toContain('Add to Shelf…')
  })

  it('opens the picker through the store, in both scopes', () => {
    expect(MENU.match(/requestShelfPicker\(/g)?.length).toBe(2)
    // The selection scope is the same list the bulk delete uses: the selection
    // itself, read at the moment of the click
    expect(MENU).toMatch(/selection\.ids/)
  })

  it('offers Remove from “shelf” only while a shelf is open, and does it immediately', () => {
    expect(MENU).toMatch(/Remove from “/)
    expect(MENU).toMatch(/removeFromShelf\(/)
    // It does not open a dialog: D9 makes this one immediate, with the Undo
    // standing in for the confirmation
    expect(MENU).not.toMatch(/requestShelfRemove/)
  })

  it('omits the shelf item when the shelf name is not loaded rather than guessing one', () => {
    // A menu item reading Remove from “undefined” is worse than no item; the
    // trash path still offers the shelf's own remove
    expect(MENU).toMatch(/shelfName &&/)
  })

  it('disables rather than hides when the share is away (R7)', () => {
    // The items are shelf writes, so they take the write gate's own question —
    // and the tooltip is the status row's label, not a delete-shaped sentence
    expect(MENU).toMatch(/disabled=\{!online\}/)
    expect(MENU).toMatch(/copy\.label/)
    expect(MENU).not.toMatch(/copy\.deleteBlocked/)
  })
})

describe('the detail panel\u2019s shelves row (AC20)', () => {
  const DETAIL = read('BookDetail.tsx')

  it('lists the book\u2019s shelves from the store, re-asking on every change', () => {
    expect(DETAIL).toMatch(/loadForBook\(/)
    // The deps array, not the bare name: `revision` is also a local `const` near
    // the top of the file, so matching the name alone passes with the effect
    // that makes it matter stripped of its dependency
    expect(DETAIL).toMatch(/\[bookId, revision, loadForBook\]/)
  })

  it('navigates on the chip and removes on the ×, with the shared Undo', () => {
    expect(DETAIL).toMatch(/setActiveShelf\(/)
    expect(DETAIL).toMatch(/removeFromShelf\(/)
  })

  it('says so when there are none', () => {
    expect(DETAIL).toContain('Not on any shelf')
  })
})

describe('Move to Top and Move to Bottom (reading queue, slice 2 — AC3)', () => {
  // Comments are dropped first: a comment explaining the guard must not satisfy a
  // walk that is asking whether the guard is there
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const MENU = strip(read('BookContextMenu.tsx'))
  const PANEL = strip(read('SelectionPanel.tsx'))

  const GUARD = "{kind === 'queue'"

  const occurrences = (source: string, needle: string): number[] => {
    const found: number[] = []
    for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
      found.push(at)
    }
    return found
  }

  /** The JSX expression opened by the nearest queue guard before `at`, up to `at`
   *  — or null when `at` is not still inside it (the guard closed first, or there
   *  is none), which is how a removed guard shows up. */
  const guardedBy = (source: string, at: number): string | null => {
    const start = source.lastIndexOf(GUARD, at)
    if (start === -1) return null
    let depth = 0
    for (let i = start; i < at; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
      if (depth <= 0) return null
    }
    return source.slice(start, at)
  }

  /** One menu item: the `<MenuItem …/>` or `<button …>…</button>` around `at`. */
  const itemAround = (source: string, at: number, tag: 'MenuItem' | 'button'): string => {
    const start = source.lastIndexOf(`<${tag}`, at)
    const end = tag === 'MenuItem' ? source.indexOf('/>', at) : source.indexOf('</button>', at)
    expect(start, 'the label sits inside an item').toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(at)
    return source.slice(start, end)
  }

  /** `void moveToEdge(activeShelfId, <ids>, '<edge>')`, however Prettier wraps it;
   *  `ids` is a regex source, and the default is any array literal */
  const callOf = (edge: 'top' | 'bottom', ids = String.raw`\[[^\]]*\]`): RegExp =>
    new RegExp(String.raw`void moveToEdge\(\s*activeShelfId,\s*${ids},\s*'${edge}',?\s*\)`)

  /** The arrow is the item's own meaning: up for the top, down for the bottom.
   *  Asserting only that *a* `SortArrowIcon` is there lets the two swap unnoticed. */
  const expectArrow = (item: string, edge: 'top' | 'bottom'): void => {
    if (edge === 'top') expect(item).toMatch(/<SortArrowIcon up\b/)
    else expect(item).not.toMatch(/<SortArrowIcon up\b/)
  }

  const EDGES: [string, string, 'top' | 'bottom'][] = [
    ['Move to Top', 'up', 'top'],
    ['Move to Bottom', 'down', 'bottom']
  ]

  it('both files import moveToEdge and read the open shelf’s kind as a primitive', () => {
    for (const source of [MENU, PANEL]) {
      expect(source).toMatch(/import \{[^}]*\bmoveToEdge\b[^}]*\} from '@\/lib\/shelf-membership'/)
      expect(source).toMatch(/shelfById\(s, activeShelfId\)\?\.kind/)
    }
  })

  describe.each(EDGES)('%s', (label, _arrow, edge) => {
    it('is offered once in each menu branch and once in the panel', () => {
      expect(occurrences(MENU, `label="${label}"`).length).toBe(2)
      expect(occurrences(PANEL, label).length).toBe(1)
    })

    it('is absent, not disabled, outside a queue — every occurrence sits in the queue guard', () => {
      expect(occurrences(MENU, `label="${label}"`).length).toBe(2)
      expect(occurrences(PANEL, label).length).toBe(1)
      for (const at of occurrences(MENU, `label="${label}"`)) {
        expect(guardedBy(MENU, at), `${label} in the menu`).not.toBeNull()
      }
      for (const at of occurrences(PANEL, label)) {
        expect(guardedBy(PANEL, at), `${label} in the panel`).not.toBeNull()
      }
    })

    it('is not gated by the sort, the query or the filters — it is a position in the whole queue', () => {
      const guards = [
        ...occurrences(MENU, `label="${label}"`).map((at) => guardedBy(MENU, at)),
        ...occurrences(PANEL, label).map((at) => guardedBy(PANEL, at))
      ]
      expect(guards.length).toBe(3)
      for (const guard of guards) {
        expect(guard).not.toBeNull()
        // The icon is *named* for a sort; what is asked is whether anything reads one
        expect(guard?.replace(/SortArrowIcon/g, '')).not.toMatch(/sort|query|filters/i)
      }
    })

    it('is disabled with the share, like its neighbours, and says why', () => {
      const items = [
        ...occurrences(MENU, `label="${label}"`).map((at) => itemAround(MENU, at, 'MenuItem')),
        ...occurrences(PANEL, label).map((at) => itemAround(PANEL, at, 'button'))
      ]
      expect(items.length).toBe(3)
      for (const item of items) {
        expect(item).toMatch(/disabled=\{!online\}/)
        expect(item).toMatch(/title=\{online \? undefined : label\}/)
      }
    })

    it('moves to the edge, closing the menu first, with the scope the click was read for', () => {
      const items = occurrences(MENU, `label="${label}"`).map((at) =>
        itemAround(MENU, at, 'MenuItem')
      )
      for (const item of items) {
        expect(item).toMatch(callOf(edge))
        expect(item.indexOf('closeContextMenu()')).toBeGreaterThan(-1)
        expect(item.indexOf('closeContextMenu()')).toBeLessThan(item.indexOf('moveToEdge('))
        expectArrow(item, edge)
      }
      // The single-book branch moves the clicked book; the multi-book branch the selection
      expect(items.filter((i) => i.includes('[book.id]')).length).toBe(1)
      expect(items.filter((i) => i.includes('[...selection.ids]')).length).toBe(1)
    })

    it('moves the selection from the panel', () => {
      const at = occurrences(PANEL, label)[0] ?? -1
      expect(at, `${label} is in the panel`).toBeGreaterThan(-1)
      const item = itemAround(PANEL, at, 'button')
      expect(item).toMatch(callOf(edge, String.raw`selected\.map\(\(b\) => b\.id\)`))
      expectArrow(item, edge)
    })
  })

  it('reads no sort, query or filters at all, so nothing can gate them by accident', () => {
    for (const source of [MENU, PANEL]) {
      expect(source.replace(/SortArrowIcon/g, '')).not.toMatch(/\b(sort\w*|query|filters)\b/i)
    }
  })
})
