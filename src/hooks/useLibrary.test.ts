import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * A source walk over the one hook that subscribes to main-process events.
 *
 * What a source walk can and cannot prove: see `context-menu-wiring.test.ts`.
 * The hook needs React to run and this repo has no DOM harness — the vitest
 * environment is Node — so "there is exactly one subscriber, and it does these
 * four things" is decided by reading the file. What those four calls *do* is
 * decided by real cases (`src/stores/shelves.store.test.ts`,
 * `src/stores/library.store.test.ts`). What is painted is the running app's.
 */
const SOURCE = readFileSync(join(process.cwd(), 'src', 'hooks', 'useLibrary.ts'), 'utf8')
const APP = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')

describe('shelves:changed (AC23)', () => {
  it('is subscribed exactly once, in the hook mounted at app root', () => {
    expect(SOURCE).toMatch(/shelves\.onChanged\(/)
    expect(APP).toMatch(/useLibrary\(\)/)
  })

  it('is inside the same subscription list as the other main-process events', () => {
    // Bounded by the array literal itself — from its declaration to the cleanup
    // it precedes — so a second `useEffect` mentioning the call later cannot
    // satisfy this, which an open-ended slice would allow
    const start = SOURCE.indexOf('const unsubs = [')
    const list = SOURCE.slice(start, SOURCE.indexOf('return () =>', start))
    expect(list).toContain('shelves.onChanged')
    expect(list).toContain('window.Musaeum.on.libraryChanged')
    // A second listener would be a second reload path — and the first place a
    // change would be applied twice
    expect(SOURCE.match(/onChanged\(/g)?.length).toBe(1)
  })

  it('refreshes the list, drops the per-book cache, and re-reads a scoped view', () => {
    const handler = SOURCE.slice(SOURCE.indexOf('shelves.onChanged'))
    expect(handler).toMatch(/invalidateShelves\(\)/)
    expect(handler).toMatch(/loadShelves\(\)/)
    // The scope's own rows only move when a shelf is open; reconciling is what
    // clears a scope whose shelf has gone (Review Focus 1)
    expect(handler).toMatch(/reconcileScope\(/)
  })

  it('reconciles against the list it just read, not the one already in the store', () => {
    const handler = SOURCE.slice(SOURCE.indexOf('shelves.onChanged'))
    // Sequencing matters: the store's list at this moment is the *previous*
    // change's, and reconciling against it would clear a scope whose shelf was
    // created a moment ago
    expect(handler.indexOf('loadShelves()')).toBeLessThan(handler.indexOf('reconcileScope('))
  })
})

describe('startup', () => {
  it('reads the list once, so the sidebar is not empty on first paint', () => {
    expect(SOURCE).toMatch(/void loadShelves\(\)/)
  })
})
