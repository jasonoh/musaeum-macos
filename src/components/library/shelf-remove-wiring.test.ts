import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * AC21's other half: *with no shelf open, every entry point behaves exactly as
 * before*.
 *
 * The store cases decide which dialog opens (`src/stores/ui.store.test.ts`);
 * this decides that the five entry points still go through the two store
 * actions rather than opening a dialog themselves — which is what would break
 * the "no shelf open" case silently, in files the store suite never loads.
 *
 * What a walk cannot prove: that a click reaches the handler. That is the
 * probe's (`context-menu-wiring.test.ts` states the same limit).
 */
const read = (file: string): string =>
  readFileSync(join(process.cwd(), 'src', 'components', 'library', file), 'utf8')
const STORE = readFileSync(join(process.cwd(), 'src', 'stores', 'ui.store.ts'), 'utf8')

const ENTRY_POINTS = ['BookCard.tsx', 'BookDetail.tsx', 'SelectionPanel.tsx', 'BookContextMenu.tsx']

describe('every trash entry point (AC21)', () => {
  it.each(ENTRY_POINTS)('%s goes through the store action, not a dialog of its own', (file) => {
    const source = read(file)
    expect(source).toMatch(/requestDelete\(|requestSelectionDelete\(/)
    // The dialogs' own flags are the store's: a component that set one directly
    // would bypass the shelf question
    expect(source).not.toMatch(/deletingBookId\s*[:=]/)
    expect(source).not.toMatch(/deletingSelection\s*[:=]/)
  })

  it('asks the shelf, and only from inside a shelf', () => {
    expect(STORE).toMatch(/activeShelfId/)
    expect(STORE).toMatch(/shelfRemove: \{ shelfId, bookIds/)
  })

  it('hands over to the existing dialog from the remove dialog alone', () => {
    const dialog = read('ShelfRemoveDialog.tsx')
    expect(dialog).toContain('Delete from Library…')
    expect(dialog).toMatch(/requestLibraryDelete/)
    // The existing dialogs are untouched: the handover sets their targets and
    // they open as they always have
    expect(dialog).not.toMatch(/deleteBook\(|deleteBooks\(/)
  })

  it('focuses Remove, which is the safe answer of the two', () => {
    const dialog = read('ShelfRemoveDialog.tsx')
    const at = dialog.indexOf('Remove from Shelf')
    const open = dialog.lastIndexOf('<button', at)
    expect(dialog.slice(open, at)).toContain('data-autofocus')
  })

  it('is mounted once, from the app root', () => {
    // Mounted with no key and no guard, like RemoveFromDeviceDialog: it reads
    // its target from the store and returns null without one. A second mount
    // would be two dialogs for one ask.
    const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')
    expect(app.match(/<ShelfRemoveDialog \/>/g)?.length).toBe(1)
  })
})
