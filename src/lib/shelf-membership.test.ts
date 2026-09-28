import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShelfMembership, ShelfSummary } from '@shared/shelf.types'
import { addToShelf, describeAdd, removeFromShelf, undoRemove } from './shelf-membership'

const SHELF: ShelfSummary = { id: 's1', name: 'To Read', kind: 'manual', count: 9 }

/** `window.Musaeum.shelves`, reduced to the three members this module touches. */
function stubShelves(handlers: {
  addBooks?(id: string, ids: string[]): Promise<{ added: number; alreadyOn: number }>
  removeBooks?(id: string, ids: string[]): Promise<ShelfMembership[]>
  restoreBooks?(id: string, memberships: ShelfMembership[]): Promise<void>
}) {
  const calls = {
    add: [] as unknown[],
    remove: [] as unknown[],
    restore: [] as unknown[]
  }
  vi.stubGlobal('window', {
    Musaeum: {
      shelves: {
        addBooks: (id: string, ids: string[]) => {
          calls.add.push([id, ids])
          return handlers.addBooks?.(id, ids) ?? Promise.resolve({ added: 0, alreadyOn: 0 })
        },
        removeBooks: (id: string, ids: string[]) => {
          calls.remove.push([id, ids])
          return handlers.removeBooks?.(id, ids) ?? Promise.resolve([])
        },
        restoreBooks: (id: string, memberships: ShelfMembership[]) => {
          calls.restore.push([id, memberships])
          return handlers.restoreBooks?.(id, memberships) ?? Promise.resolve()
        }
      }
    }
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the Undo hands back exactly what main gave it (note 2, AC22)', () => {
  const REMOVED: ShelfMembership[] = [
    { bookId: 'a', addedAt: '2026-09-01T10:00:00.000Z' },
    { bookId: 'b', addedAt: '2026-09-02T11:30:00.000Z' }
  ]

  it('passes the array through untouched', async () => {
    const calls = stubShelves({ removeBooks: async () => REMOVED })
    const removed = await removeFromShelf(SHELF, ['a', 'b'])
    expect(calls.remove).toEqual([['s1', ['a', 'b']]])
    // Not "a restore happened" but *this* restore: the same array, in the same
    // order, with the same timestamps. A re-stamped `addedAt` would put both
    // books at the top of the shelf while every call still succeeded
    expect(calls.restore).toEqual([]) // the Undo is offered, not run, until pressed
    undoRemove(SHELF.id, removed!)()
    expect(calls.restore).toEqual([['s1', REMOVED]])
  })

  it('does not drop an entry whose timestamp main will itself skip', () => {
    // Main skips a membership with no `addedAt` and restores the rest, silently
    // — a partial restore is not an error. If this module *also* filtered, the
    // two silences would compound and nothing on screen would say a book is
    // missing from the shelf
    const odd: ShelfMembership[] = [{ bookId: 'a', addedAt: '' }]
    const calls = stubShelves({})
    undoRemove(SHELF.id, odd)()
    expect(calls.restore).toEqual([['s1', odd]])
  })

  it('never consults a clock', () => {
    const calls = stubShelves({})
    const frozen = new Date('2030-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(frozen)
    undoRemove(SHELF.id, REMOVED)()
    const [, handed] = calls.restore[0] as [string, ShelfMembership[]]
    expect(handed).toEqual(REMOVED)
    expect(handed).not.toEqual(handed.map((m) => ({ ...m, addedAt: frozen.toISOString() })))
  })

  it('reports a refused restore once, and does not throw into the toast', async () => {
    const calls = stubShelves({
      restoreBooks: async () => Promise.reject(new Error('That shelf no longer exists'))
    })
    expect(() => undoRemove(SHELF.id, REMOVED)()).not.toThrow()
    await Promise.resolve()
    expect(calls.restore).toHaveLength(1)
  })
})

describe('describeAdd (R9)', () => {
  it('counts what landed and what was already there', () => {
    expect(describeAdd('To Read', { added: 3, alreadyOn: 0 })).toBe('Added 3 to To Read')
    expect(describeAdd('To Read', { added: 2, alreadyOn: 1 })).toBe(
      'Added 2 to To Read · 1 already there'
    )
  })

  it('says the plain truth when nothing landed', () => {
    expect(describeAdd('To Read', { added: 0, alreadyOn: 3 })).toBe('Already on To Read')
  })

  it('says nothing when nothing happened', () => {
    // The unknown-ids row: main skips them, so both counts are zero and there is
    // no news — "Added 0 to To Read" is a sentence nobody should read
    expect(describeAdd('To Read', { added: 0, alreadyOn: 0 })).toBeNull()
  })
})

describe('what a mutation reports (D9)', () => {
  it('answers the add result, having said what landed', async () => {
    stubShelves({ addBooks: async () => ({ added: 2, alreadyOn: 1 }) })
    await expect(addToShelf(SHELF, ['a', 'b', 'c'])).resolves.toEqual({ added: 2, alreadyOn: 1 })
  })

  it('answers null and reports, rather than throwing at the click', async () => {
    stubShelves({ removeBooks: async () => Promise.reject(new Error('Library is offline')) })
    await expect(removeFromShelf(SHELF, ['a'])).resolves.toBeNull()
  })

  it('answers null when an add is refused', async () => {
    stubShelves({ addBooks: async () => Promise.reject(new Error('Library is offline')) })
    await expect(addToShelf(SHELF, ['a'])).resolves.toBeNull()
  })

  it('offers no Undo when nothing was removed', async () => {
    stubShelves({ removeBooks: async () => [] })
    await expect(removeFromShelf(SHELF, ['a'])).resolves.toEqual([])
  })
})
