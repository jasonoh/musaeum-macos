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
  const start = source.indexOf('onContextMenu={(e) => {')
  expect(start, 'the view must handle a right-click').toBeGreaterThan(-1)
  const end = source.indexOf('}}', start)
  expect(end, 'the handler must be an arrow body').toBeGreaterThan(start)
  return source.slice(start, end)
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
