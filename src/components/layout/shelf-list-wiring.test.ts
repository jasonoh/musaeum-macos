import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Source walks over the shelf chrome: the sidebar section, the Library row, the
 * sort control and the search placeholder.
 *
 * What a source walk can and cannot prove: see `context-menu-wiring.test.ts`.
 * There is no DOM harness in this repo (vitest runs in the Node environment), so
 * what is *wired* is read off the files and what is *painted* is the running
 * app's — the CDP probe. What a walk cannot prove: that a click reaches the
 * handler, or that the row is where the eye expects it.
 */
const read = (file: string): string =>
  readFileSync(join(process.cwd(), 'src', 'components', 'layout', file), 'utf8')

const SOURCE = read('ShelfList.tsx')

describe('the shelf section (AC16)', () => {
  it('renders main\u2019s list as it arrives, with its counts', () => {
    expect(SOURCE).toMatch(/useShelvesStore\(/)
    expect(SOURCE).toMatch(/\{shelf\.count\}/)
  })

  it('creates and renames through the one inline field', () => {
    expect(SOURCE).toMatch(/shelves\.create\(/)
    expect(SOURCE).toMatch(/shelves\.rename\(/)
    expect(SOURCE).toMatch(/editing\.mode === 'create'/)
  })

  it('names the shelf and its count before it is deleted (D9, AC16)', () => {
    // The confirmation's job is that a person cannot delete a shelf believing
    // they are deleting books
    expect(SOURCE).toContain('Delete the shelf \u201c')
    expect(SOURCE).toContain('books stay in your library')
  })

  it('deletes no book', () => {
    // The one thing this file must not reach for: shelf deletion is a file
    // write, and books are not in it
    expect(SOURCE).not.toMatch(/deleteBook|deleteBooks|deletingBookId|deletingSelection/)
  })

  it('reports a refusal through the session reporter', () => {
    expect(SOURCE).toMatch(/reportShelfFailure/)
  })

  it('gates its writes on the status the write gate reads (R7)', () => {
    expect(SOURCE).toMatch(/state === 'connected'/)
    expect(SOURCE).toMatch(/copy\.deleteBlocked/)
  })

  it('is not a drop target yet \u2014 slice 3 owns drag', () => {
    expect(SOURCE).not.toMatch(/onDragOver|onDrop|dataTransfer/)
  })
})
