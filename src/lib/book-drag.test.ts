import { describe, expect, it } from 'vitest'
import { EMPTY_SELECTION, type Selection } from '@/lib/selection'
import {
  BOOK_DRAG_MIME,
  clearDragPayload,
  dragPayload,
  dragScope,
  isImportDrag,
  setDragPayload
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

  it('still recognises a real file drop', () => {
    expect(isImportDrag(['Files'])).toBe(true)
    expect(isImportDrag(['text/plain', 'Files'])).toBe(true)
  })
})
