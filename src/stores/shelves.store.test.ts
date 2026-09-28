import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShelfSummary } from '@shared/shelf.types'
import { shelfById, useShelvesStore } from './shelves.store'

const READING: ShelfSummary = { id: 's1', name: 'Reading now', kind: 'manual', count: 3 }
const SCIFI: ShelfSummary = { id: 's2', name: 'Sci-fi', kind: 'manual', count: 12 }

function stubShelves(handlers: {
  list(): Promise<ShelfSummary[]>
  forBook?(bookId: string): Promise<ShelfSummary[]>
}) {
  const asked: string[] = []
  vi.stubGlobal('window', {
    Musaeum: {
      shelves: {
        list: () => handlers.list(),
        forBook: (bookId: string) => {
          asked.push(bookId)
          return handlers.forBook?.(bookId) ?? Promise.resolve([])
        }
      }
    }
  })
  return { asked }
}

afterEach(() => {
  vi.unstubAllGlobals()
  useShelvesStore.setState({ shelves: [], byBook: {}, revision: 0 })
})

describe('the list', () => {
  it('replaces on every read, so a rename or a delete needs no second path', async () => {
    stubShelves({ list: async () => [READING, SCIFI] })
    await useShelvesStore.getState().load()
    expect(useShelvesStore.getState().shelves).toEqual([READING, SCIFI])
    stubShelves({ list: async () => [SCIFI] })
    await useShelvesStore.getState().load()
    expect(useShelvesStore.getState().shelves).toEqual([SCIFI])
  })

  it('keeps what it has when the read fails', async () => {
    useShelvesStore.setState({ shelves: [READING] })
    stubShelves({ list: async () => Promise.reject(new Error('Library is offline')) })
    await useShelvesStore.getState().load()
    // A share blip must not empty the sidebar. The sentence is said by
    // `reportShelfFailure` (shelf-feedback.test.ts), which is a session-wide
    // singleton and so not asserted here.
    expect(useShelvesStore.getState().shelves).toEqual([READING])
  })

  it('keeps what it has when a forBook read fails', async () => {
    stubShelves({
      list: async () => [READING],
      forBook: async () => Promise.reject(new Error('Library is offline'))
    })
    await useShelvesStore.getState().loadForBook('b1')
    expect(useShelvesStore.getState().byBook).toEqual({})
  })
})

describe('invalidate (AC16, AC23)', () => {
  it('bumps the revision and drops every cached answer', async () => {
    stubShelves({ list: async () => [READING], forBook: async () => [SCIFI] })
    await useShelvesStore.getState().loadForBook('b1')
    expect(useShelvesStore.getState().byBook.b1).toEqual([SCIFI])
    useShelvesStore.getState().invalidate()
    const s = useShelvesStore.getState()
    // The revision is what a consumer re-asks on: deleting the key alone would
    // not re-run an effect that reads `byBook[id]`
    expect(s.revision).toBe(1)
    expect(s.byBook).toEqual({})
  })

  it('leaves the list alone — only membership is cached per book', () => {
    useShelvesStore.setState({ shelves: [READING], revision: 0 })
    useShelvesStore.getState().invalidate()
    expect(useShelvesStore.getState().shelves).toEqual([READING])
  })
})

describe('shelfById', () => {
  it('finds the open shelf, and answers null for nothing', () => {
    const state = { ...useShelvesStore.getState(), shelves: [READING, SCIFI] }
    expect(shelfById(state, 's2')).toEqual(SCIFI)
    expect(shelfById(state, 'gone')).toBeNull()
    expect(shelfById(state, null)).toBeNull()
  })
})
