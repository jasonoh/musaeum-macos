import { describe, expect, it } from 'vitest'
import { isManualShelf } from './shelf.types'

describe('isManualShelf — the one kind this build edits (bookshelves D1)', () => {
  it('is true for a manual shelf and false for any kind this build does not know', () => {
    expect(
      isManualShelf({
        id: 'a',
        name: 'To Read',
        kind: 'manual',
        created_at: '2026-09-27T10:00:00.000Z',
        updated_at: '2026-09-27T10:00:00.000Z',
        books: []
      })
    ).toBe(true)
    expect(isManualShelf({ id: 'b', kind: 'smart', rule: { tags: ['sf'] } })).toBe(false)
  })
})
