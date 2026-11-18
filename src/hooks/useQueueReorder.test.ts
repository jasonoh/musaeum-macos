import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Book } from '@shared/book.types'
import type { ShelfPlacement, ShelfSummary } from '@shared/shelf.types'
import { BOOK_DRAG_MIME, clearDragPayload, startBookDrag } from '@/lib/book-drag'
import { useLibraryStore } from '@/stores/library.store'
import { useShelvesStore } from '@/stores/shelves.store'
import { reorderDragLeave, reorderDragOver, reorderDrop } from './useQueueReorder'

/**
 * The gate every handler re-asks. There is no DOM harness here, so the events are
 * stubs carrying the three things a handler reads: `dataTransfer.types`,
 * `dataTransfer.dropEffect` and `preventDefault`.
 */
const QUEUE: ShelfSummary = { id: 'q', name: 'Next', kind: 'queue', count: 3 }
const MANUAL: ShelfSummary = { id: 'm', name: 'Misc', kind: 'manual', count: 3 }

const book = (id: string): Book => ({ id, title: id }) as unknown as Book

function open(
  shelf: ShelfSummary,
  over: Partial<ReturnType<typeof useLibraryStore.getState>> = {}
) {
  useShelvesStore.setState({ shelves: [QUEUE, MANUAL] })
  useLibraryStore.setState({
    activeShelfId: shelf.id,
    activeDeviceId: null,
    query: '',
    filters: {},
    sort: { field: 'shelf_position', direction: 'asc' },
    books: ['a', 'b', 'c'].map(book),
    loadedBooks: ['a', 'b', 'c'].map(book),
    dropMark: null,
    ...over
  })
}

function stubEvent(types: string[]) {
  const dataTransfer = { types, dropEffect: 'none' }
  const preventDefault = vi.fn()
  return {
    e: { dataTransfer, preventDefault } as unknown as React.DragEvent,
    dataTransfer,
    preventDefault
  }
}

const BOOK_TYPES = [BOOK_DRAG_MIME, 'text/plain']

/** A drag that began in `shelfId`, as the views start one. */
function startDrag(ids: string[], shelfId: string | null) {
  startBookDrag(
    { dataTransfer: null, currentTarget: null },
    ids[0] ?? '',
    {
      ids: new Set(ids)
    } as never,
    shelfId
  )
}

function stubMusaeum() {
  const move = vi.fn<(id: string, ids: string[], p: ShelfPlacement) => Promise<void>>(() =>
    Promise.resolve()
  )
  vi.stubGlobal('window', {
    Musaeum: {
      shelves: { move },
      library: {
        getBooks: async () => ['a', 'b', 'c'].map(book),
        searchBooks: async () => [],
        getFacets: async () => ({})
      }
    }
  })
  return move
}

afterEach(() => {
  clearDragPayload()
  vi.unstubAllGlobals()
  useLibraryStore.setState({ activeShelfId: null, books: [], loadedBooks: [], dropMark: null })
})

describe('dragover', () => {
  it('claims a reorder drag inside the queue it began in: move effect, default prevented, mark set', () => {
    open(QUEUE)
    startDrag(['c'], 'q')
    const { e, dataTransfer, preventDefault } = stubEvent(BOOK_TYPES)
    reorderDragOver(e, 'a', 3, 40)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(dataTransfer.dropEffect).toBe('move')
    expect(useLibraryStore.getState().dropMark).toEqual({ bookId: 'a', side: 'before' })
    reorderDragOver(e, 'a', 30, 40)
    expect(useLibraryStore.getState().dropMark).toEqual({ bookId: 'a', side: 'after' })
  })

  it.each([
    ['a Finder file', ['Files'], 'q', QUEUE],
    ['a drag from another view', BOOK_TYPES, null, QUEUE],
    ['a drag from another queue', BOOK_TYPES, 'other', QUEUE],
    ['a stale slot answering a foreign drag', ['text/plain'], 'q', QUEUE],
    ['a manual shelf', BOOK_TYPES, 'q', MANUAL]
  ])('falls through %s untouched', (_name, types, slotShelf, shelf) => {
    open(shelf)
    startDrag(['c'], slotShelf)
    const { e, dataTransfer, preventDefault } = stubEvent(types)
    reorderDragOver(e, 'a', 3, 40)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(dataTransfer.dropEffect).toBe('none')
    expect(useLibraryStore.getState().dropMark).toBeNull()
  })

  it('falls through once the view stopped being reorderable mid-drag', () => {
    open(QUEUE, { query: 'dune' })
    startDrag(['c'], 'q')
    const { e, preventDefault } = stubEvent(BOOK_TYPES)
    reorderDragOver(e, 'a', 3, 40)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(useLibraryStore.getState().dropMark).toBeNull()
  })
})

describe('dragleave', () => {
  it('clears the mark only when it is on that target', () => {
    open(QUEUE, { dropMark: { bookId: 'a', side: 'after' } })
    reorderDragLeave('b')
    expect(useLibraryStore.getState().dropMark).toEqual({ bookId: 'a', side: 'after' })
    reorderDragLeave('a')
    expect(useLibraryStore.getState().dropMark).toBeNull()
  })
})

describe('drop', () => {
  it('moves the payload before or after the target, with exactly one placement key', async () => {
    const move = stubMusaeum()
    open(QUEUE)
    startDrag(['c'], 'q')
    const { e, preventDefault } = stubEvent(BOOK_TYPES)
    reorderDrop(e, 'a', 3, 40)
    await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(1))
    expect(move).toHaveBeenCalledWith('q', ['c'], { before: 'a' })
    expect(Object.keys(move.mock.calls[0]?.[2] ?? {})).toEqual(['before'])
    expect(preventDefault).toHaveBeenCalled()
    expect(useLibraryStore.getState().dropMark).toBeNull()
  })

  it('places after the target for the lower half', async () => {
    const move = stubMusaeum()
    open(QUEUE)
    startDrag(['a'], 'q')
    const { e } = stubEvent(BOOK_TYPES)
    reorderDrop(e, 'c', 30, 40)
    await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(1))
    expect(move).toHaveBeenCalledWith('q', ['a'], { after: 'c' })
    expect(Object.keys(move.mock.calls[0]?.[2] ?? {})).toEqual(['after'])
  })

  it('makes no call for a drop on a member of the moved block, and still clears the mark', () => {
    const move = stubMusaeum()
    open(QUEUE, { dropMark: { bookId: 'b', side: 'after' } })
    startDrag(['a', 'b'], 'q')
    const { e } = stubEvent(BOOK_TYPES)
    reorderDrop(e, 'b', 3, 40)
    expect(move).not.toHaveBeenCalled()
    expect(useLibraryStore.getState().dropMark).toBeNull()
  })

  it('makes no call when the slot is empty', () => {
    const move = stubMusaeum()
    open(QUEUE)
    const { e } = stubEvent(BOOK_TYPES)
    reorderDrop(e, 'a', 3, 40)
    expect(move).not.toHaveBeenCalled()
  })

  it('falls through a foreign drop: no call, no preventDefault, no mark', () => {
    const move = stubMusaeum()
    open(QUEUE)
    startDrag(['c'], 'q')
    const { e, preventDefault } = stubEvent(['Files'])
    reorderDrop(e, 'a', 3, 40)
    expect(move).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(useLibraryStore.getState().dropMark).toBeNull()
  })
})
