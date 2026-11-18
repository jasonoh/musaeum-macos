import { describe, expect, it } from 'vitest'
import { isListShelf, isManualShelf, isQueueShelf } from './shelf.types'

const stamps = { created_at: '2026-09-27T10:00:00.000Z', updated_at: '2026-09-27T10:00:00.000Z' }

describe('isManualShelf — the one kind this build edits (bookshelves D1)', () => {
  it('is true for a manual shelf and false for any kind this build does not know', () => {
    expect(isManualShelf({ id: 'a', name: 'To Read', kind: 'manual', ...stamps, books: [] })).toBe(
      true
    )
    expect(isManualShelf({ id: 'b', kind: 'smart', rule: { tags: ['sf'] } })).toBe(false)
  })
})

describe('isListShelf / isQueueShelf — the kinds whose books are a list (reading queue)', () => {
  const manual = { id: 'a', name: 'To Read', kind: 'manual', ...stamps, books: [] } as const
  const queue = { id: 'q', name: 'Up Next', kind: 'queue', ...stamps, books: [] } as const
  const smart = { id: 'x', kind: 'smart' }

  it('treats a manual shelf and a queue as list shelves, and a foreign kind as neither', () => {
    expect(isListShelf(manual)).toBe(true)
    expect(isListShelf(queue)).toBe(true)
    expect(isListShelf(smart)).toBe(false)
  })

  it('knows a queue from every other kind', () => {
    expect(isQueueShelf(queue)).toBe(true)
    expect(isQueueShelf(manual)).toBe(false)
    expect(isQueueShelf(smart)).toBe(false)
  })
})
