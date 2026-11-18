import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShelfMembership, ShelfPlacement, ShelfSummary } from '@shared/shelf.types'
import type { Book } from '@shared/book.types'
import { reportShelfFailure } from '@/lib/shelf-feedback'
import { useLibraryStore } from '@/stores/library.store'
import {
  addToShelf,
  describeAdd,
  moveToEdge,
  removeFromShelf,
  reorderInQueue,
  undoRemove
} from './shelf-membership'

// The reporter is the session's one memory of what it has said; a case that asks
// "was it reported, and once" wants a spy, not the real set
vi.mock('@/lib/shelf-feedback', () => ({ reportShelfFailure: vi.fn() }))

const SHELF: ShelfSummary = { id: 's1', name: 'To Read', kind: 'manual', count: 9 }

/** `window.Musaeum.shelves`, reduced to the four members this module touches. */
function stubShelves(handlers: {
  addBooks?(id: string, ids: string[]): Promise<{ added: number; alreadyOn: number }>
  removeBooks?(id: string, ids: string[]): Promise<ShelfMembership[]>
  restoreBooks?(id: string, memberships: ShelfMembership[]): Promise<void>
  move?(id: string, ids: string[], placement: ShelfPlacement): Promise<void>
}) {
  const calls = {
    add: [] as unknown[],
    remove: [] as unknown[],
    restore: [] as unknown[],
    move: [] as unknown[]
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
        },
        move: (id: string, ids: string[], placement: ShelfPlacement) => {
          calls.move.push([id, ids, placement])
          return handlers.move?.(id, ids, placement) ?? Promise.resolve()
        }
      }
    }
  })
  return calls
}

afterEach(() => {
  vi.mocked(reportShelfFailure).mockClear()
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

describe('the Undo hands a queue membership back with its index', () => {
  it('passes the very objects removeBooks returned, `index` and all', async () => {
    // A queue's membership carries `index` (its position at removal) and main
    // re-inserts at it. Nothing here may rebuild, filter or strip an element, so
    // the array handed to restoreBooks is the array main handed over (this pins a
    // rule the module already carries; it passes before any move helper exists)
    const removed: ShelfMembership[] = [
      { bookId: 'a', addedAt: '2026-09-01T10:00:00.000Z', index: 3 },
      { bookId: 'b', addedAt: '2026-09-02T11:30:00.000Z', index: 0 }
    ]
    const calls = stubShelves({})
    undoRemove('q', removed)()
    const [id, handed] = calls.restore[0] as [string, ShelfMembership[]]
    expect(id).toBe('q')
    expect(handed).toBe(removed)
    expect(handed[0]).toEqual({ bookId: 'a', addedAt: '2026-09-01T10:00:00.000Z', index: 3 })
  })
})

describe('moveToEdge (reading queue)', () => {
  it.each(['top', 'bottom'] as const)(
    'sends one move to the %s, and nothing else',
    async (edge) => {
      const calls = stubShelves({})
      await expect(moveToEdge('q', ['a', 'b'], edge)).resolves.toBe(true)
      expect(calls.move).toEqual([['q', ['a', 'b'], { to: edge }]])
      // Main refuses a placement with any extra key — an undefined one included
      const [, , placement] = calls.move[0] as [string, string[], ShelfPlacement]
      expect(Object.keys(placement)).toEqual(['to'])
      expect(reportShelfFailure).not.toHaveBeenCalled()
    }
  )

  it("hands main a copy of the ids, not the caller's own array", async () => {
    const ids: readonly string[] = ['a']
    const calls = stubShelves({})
    await moveToEdge('q', ids, 'top')
    expect((calls.move[0] as [string, string[]])[1]).not.toBe(ids)
  })

  it('answers false and reports once when main refuses, rather than throwing', async () => {
    const refusal = new Error('That book is no longer in the queue')
    stubShelves({ move: async () => Promise.reject(refusal) })
    await expect(moveToEdge('q', ['a'], 'top')).resolves.toBe(false)
    expect(reportShelfFailure).toHaveBeenCalledTimes(1)
    expect(reportShelfFailure).toHaveBeenCalledWith(refusal)
  })
})

describe('reorderInQueue (reading queue)', () => {
  const book = (id: string) => ({ id, title: id }) as Book
  const open = (ids: string[]) => {
    const books = ids.map(book)
    useLibraryStore.setState({
      activeShelfId: 'q',
      books,
      loadedBooks: books,
      reorderGen: 0
    })
  }
  const ids = () => useLibraryStore.getState().books.map((b) => b.id)

  /** `window.Musaeum` with the shelves stub plus the reads the final `load()` makes. */
  function stubWithLibrary(
    move: (id: string, ids: string[], p: ShelfPlacement) => Promise<void>,
    served: () => string[]
  ) {
    const calls = stubShelves({ move })
    const win = (globalThis as unknown as { window: { Musaeum: Record<string, unknown> } }).window
    win.Musaeum.library = {
      getBooks: () => Promise.resolve(served().map(book)),
      searchBooks: () => Promise.resolve(served().map(book)),
      getFacets: () => Promise.resolve({})
    }
    return calls
  }

  afterEach(() => {
    useLibraryStore.setState({ activeShelfId: null, books: [], loadedBooks: [], loading: false })
  })

  it("shows the new order while the move is pending, then settles on main's answer", async () => {
    open(['a', 'b', 'c'])
    let release!: () => void
    let served = ['a', 'b', 'c']
    const calls = stubWithLibrary(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            served = ['c', 'a', 'b']
            resolve()
          }
        }),
      () => served
    )
    const pending = reorderInQueue('q', ['c'], { before: 'a' })
    expect(calls.move).toEqual([['q', ['c'], { before: 'a' }]])
    expect(ids()).toEqual(['c', 'a', 'b'])
    expect(useLibraryStore.getState().loadedBooks.map((b) => b.id)).toEqual(['c', 'a', 'b'])
    release()
    await expect(pending).resolves.toBe(true)
    expect(ids()).toEqual(['c', 'a', 'b'])
    expect(useLibraryStore.getState().loading).toBe(false)
    expect(reportShelfFailure).not.toHaveBeenCalled()
  })

  it('rolls back, reports once and resolves false when main refuses', async () => {
    open(['a', 'b', 'c'])
    const refusal = new Error('That book is no longer in the queue')
    let reject!: (e: Error) => void
    stubWithLibrary(
      () => new Promise<void>((_, r) => (reject = r)),
      () => ['a', 'b', 'c']
    )
    const pending = reorderInQueue('q', ['c'], { before: 'a' })
    expect(ids()).toEqual(['c', 'a', 'b'])
    reject(refusal)
    await expect(pending).resolves.toBe(false)
    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(reportShelfFailure).toHaveBeenCalledTimes(1)
    expect(reportShelfFailure).toHaveBeenCalledWith(refusal)
    expect(useLibraryStore.getState().loading).toBe(false)
  })

  it('makes no call and resolves false for a drop that changes nothing', async () => {
    open(['a', 'b', 'c'])
    const calls = stubWithLibrary(
      () => Promise.resolve(),
      () => ['a', 'b', 'c']
    )
    const gen = useLibraryStore.getState().reorderGen
    await expect(reorderInQueue('q', ['a'], { before: 'b' })).resolves.toBe(false)
    expect(calls.move).toEqual([])
    expect(useLibraryStore.getState().reorderGen).toBe(gen)
  })

  it('makes no call for a shelf that is not the open one', async () => {
    open(['a', 'b', 'c'])
    const calls = stubWithLibrary(
      () => Promise.resolve(),
      () => ['a', 'b', 'c']
    )
    await expect(reorderInQueue('other', ['c'], { to: 'top' })).resolves.toBe(false)
    expect(calls.move).toEqual([])
    expect(ids()).toEqual(['a', 'b', 'c'])
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
