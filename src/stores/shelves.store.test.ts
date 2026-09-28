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
  it('bumps the revision, and keeps the answers it already has', async () => {
    stubShelves({ list: async () => [READING], forBook: async () => [SCIFI] })
    await useShelvesStore.getState().loadForBook('b1')
    useShelvesStore.getState().invalidate()
    const s = useShelvesStore.getState()
    // The revision is what a consumer re-asks on — that is the whole mechanism,
    // and deleting the key alone would not re-run an effect that reads
    // `byBook[id]`
    expect(s.revision).toBe(1)
    // …and the answer already in hand is *kept* until the re-ask replaces it.
    // Emptying it here painted "Not on any shelf" on a book that is on a shelf,
    // for one round trip, on every shelf change anywhere in the app
    expect(s.byBook.b1).toEqual([SCIFI])
  })

  it('is replaced by the next answer, so nothing is kept past its change', async () => {
    stubShelves({ list: async () => [READING], forBook: async () => [SCIFI] })
    await useShelvesStore.getState().loadForBook('b1')
    useShelvesStore.getState().invalidate()
    stubShelves({ list: async () => [READING], forBook: async () => [] })
    await useShelvesStore.getState().loadForBook('b1')
    // Kept-then-replaced, not kept: the cache cannot outlive the change it was
    // invalidated by
    expect(useShelvesStore.getState().byBook.b1).toEqual([])
  })

  it('leaves the list alone — only membership is cached per book', () => {
    useShelvesStore.setState({ shelves: [READING], revision: 0 })
    useShelvesStore.getState().invalidate()
    expect(useShelvesStore.getState().shelves).toEqual([READING])
  })

  it('drops a forBook answer that was already in flight when invalidate() ran', async () => {
    /** Arrives as an array, not a `let`, so the case can resolve it later. */
    const answers: Array<(shelves: ShelfSummary[]) => void> = []
    stubShelves({
      list: async () => [READING],
      forBook: () => new Promise<ShelfSummary[]>((resolve) => answers.push(resolve))
    })
    const inFlight = useShelvesStore.getState().loadForBook('b1')
    // A `shelves:changed` has landed: the cache is dropped and the consumer
    // re-asks on the new revision
    useShelvesStore.getState().invalidate()
    answers[0]([SCIFI])
    await inFlight
    // Committing it now would put a pre-change membership back under the key and
    // leave it there — the consumer that re-asked has no reason to ask again
    expect(useShelvesStore.getState().byBook).toEqual({})
  })

  it('still commits a forBook answer nothing overtook', async () => {
    stubShelves({ list: async () => [READING], forBook: async () => [SCIFI] })
    await useShelvesStore.getState().loadForBook('b1')
    expect(useShelvesStore.getState().byBook.b1).toEqual([SCIFI])
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
