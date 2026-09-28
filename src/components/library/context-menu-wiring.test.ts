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
