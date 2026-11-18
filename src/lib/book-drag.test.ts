import { describe, expect, it } from 'vitest'
import { EMPTY_SELECTION, type Selection } from '@/lib/selection'
import { useLibraryStore } from '@/stores/library.store'
import {
  BOOK_DRAG_MIME,
  clearDragPayload,
  dragPayload,
  dragReorderShelfId,
  dragScope,
  isBookDragTypes,
  isImportDrag,
  setDragPayload,
  startBookDrag
} from '@/lib/book-drag'

const sel = (...ids: string[]): Selection => ({
  ids: new Set(ids),
  anchor: ids[0] ?? null,
  cursor: ids[0] ?? null
})

describe('dragScope (AC24)', () => {
  it('carries the whole selection when the dragged book is inside it', () => {
    expect(dragScope('b', sel('a', 'b', 'c'))).toEqual(['a', 'b', 'c'])
  })

  it('carries the one book when the dragged book is not in the selection', () => {
    expect(dragScope('z', sel('a', 'b', 'c'))).toEqual(['z'])
    expect(dragScope('z', EMPTY_SELECTION)).toEqual(['z'])
  })

  it('carries the one book when the selection is a single other book', () => {
    // `contextMenuScope`'s boundary, mirrored: size > 1 is what makes it "a
    // selection". One book selected and a different one dragged is one book.
    expect(dragScope('z', sel('a'))).toEqual(['z'])
  })

  it('does not change the selection it was handed (AC24)', () => {
    const s = sel('a', 'b')
    dragScope('a', s)
    expect([...s.ids]).toEqual(['a', 'b'])
    expect(s.anchor).toBe('a')
    expect(s.cursor).toBe('a')
  })
})

describe('the payload slot (AC25, AC27)', () => {
  it('answers what was put in it, in the order it was put in', () => {
    setDragPayload(['b', 'a'])
    expect(dragPayload()).toEqual(['b', 'a'])
  })

  it('is a copy, so a caller cannot mutate the payload after the fact', () => {
    const ids = ['a', 'b']
    setDragPayload(ids)
    ids.push('c')
    expect(dragPayload()).toEqual(['a', 'b'])
  })

  it('clears', () => {
    setDragPayload(['a'])
    clearDragPayload()
    expect(dragPayload()).toBeNull()
  })
})

describe('the import overlay stays down (AC25)', () => {
  it('does not mistake a book drag for a file drop', () => {
    expect(BOOK_DRAG_MIME).toBe('application/x-musaeum-books')
    expect(isImportDrag([BOOK_DRAG_MIME])).toBe(false)
    // What a book drag actually carries: the MIME type and a text fallback
    expect(isImportDrag([BOOK_DRAG_MIME, 'text/plain'])).toBe(false)
  })

  it('still recognizes a real file drop', () => {
    expect(isImportDrag(['Files'])).toBe(true)
    expect(isImportDrag(['text/plain', 'Files'])).toBe(true)
  })
})

describe('the queue a drag started in (reading queue)', () => {
  // The least `startBookDrag` touches: a `dataTransfer` that records, and no
  // `currentTarget`, so the drag image (which needs a DOM) is skipped.
  const fakeHandle = () => {
    const data: Record<string, string> = {}
    const dt = {
      effectAllowed: 'uninitialized',
      setData: (type: string, value: string) => {
        data[type] = value
      },
      setDragImage: () => {}
    }
    return {
      handle: { dataTransfer: dt as unknown as DataTransfer, currentTarget: null },
      dt,
      data
    }
  }

  it('records the queue and allows copy or move, with the payload unchanged', () => {
    const { handle, dt, data } = fakeHandle()
    startBookDrag(handle, 'b', sel('a', 'b'), 'queue-1')
    expect(dt.effectAllowed).toBe('copyMove')
    expect(dragReorderShelfId()).toBe('queue-1')
    expect(dragPayload()).toEqual(['a', 'b'])
    expect(data[BOOK_DRAG_MIME]).toBe(JSON.stringify(['a', 'b']))
    expect(data['text/plain']).toBe('a\nb')
    clearDragPayload()
  })

  it('without a queue it is a plain copy and records none', () => {
    const { handle, dt } = fakeHandle()
    startBookDrag(handle, 'b', sel('a', 'b'))
    expect(dt.effectAllowed).toBe('copy')
    expect(dragReorderShelfId()).toBeNull()
    // A fresh handle for the explicit-null case: reusing `dt` would still read
    // `'copy'` from the call above, so a `startBookDrag` that skipped
    // `effectAllowed` entirely for a null queue would pass this assertion too
    const plain = fakeHandle()
    startBookDrag(plain.handle, 'b', sel('a', 'b'), null)
    expect(plain.dt.effectAllowed).toBe('copy')
    expect(dragReorderShelfId()).toBeNull()
    clearDragPayload()
  })

  it('a drag that follows one from a queue does not inherit its queue', () => {
    startBookDrag(fakeHandle().handle, 'a', EMPTY_SELECTION, 'queue-1')
    startBookDrag(fakeHandle().handle, 'a', EMPTY_SELECTION)
    expect(dragReorderShelfId()).toBeNull()
    clearDragPayload()
  })

  it('clears the queue with the payload, and the drop mark too', () => {
    startBookDrag(fakeHandle().handle, 'a', EMPTY_SELECTION, 'queue-1')
    useLibraryStore.getState().setDropMark({ bookId: 'c', side: 'before' })
    clearDragPayload()
    expect(dragPayload()).toBeNull()
    expect(dragReorderShelfId()).toBeNull()
    // A drag that ends with no drop — Escape, a release over another app — fires no
    // `dragleave` on the row it was over, so this is the only thing that clears
    // the indicator there; left behind, it repaints on that book in a later view
    expect(useLibraryStore.getState().dropMark).toBeNull()
  })

  it('recognizes a book drag by its types', () => {
    expect(isBookDragTypes([BOOK_DRAG_MIME, 'text/plain'])).toBe(true)
    expect(isBookDragTypes(['Files'])).toBe(false)
  })
})
