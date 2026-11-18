import { describe, expect, it } from 'vitest'
import type { ShelfSummary } from '@shared/shelf.types'
import { defaultShelfSort, groupShelves, shelfSortOptions } from './queue-order'

const QUEUE_ORDER = { field: 'shelf_position', direction: 'asc' }
const ADDED_NEWEST = { field: 'shelf_added', direction: 'desc' }
const ADDED_OLDEST = { field: 'shelf_added', direction: 'asc' }

describe('defaultShelfSort', () => {
  it('opens a queue in its own order', () => {
    expect(defaultShelfSort('queue')).toEqual(QUEUE_ORDER)
  })

  it('opens a manual shelf newest-added first', () => {
    expect(defaultShelfSort('manual')).toEqual(ADDED_NEWEST)
  })
})

describe('shelfSortOptions', () => {
  it('puts Queue Order in front for a queue, then the two shelf-added sorts', () => {
    const options = shelfSortOptions('queue')

    expect(options).toHaveLength(3)
    expect(options[0]).toEqual(QUEUE_ORDER)
    expect(options.slice(1)).toEqual([ADDED_NEWEST, ADDED_OLDEST])
  })

  it('offers a manual shelf only the shelf-added sorts', () => {
    const options = shelfSortOptions('manual')

    expect(options).toEqual([ADDED_NEWEST, ADDED_OLDEST])
    expect(options.some((o) => o.field === 'shelf_position')).toBe(false)
  })
})

describe('groupShelves', () => {
  const shelf = (id: string, name: string, kind: ShelfSummary['kind']): ShelfSummary => ({
    id,
    name,
    kind,
    count: 0
  })

  it('splits by kind, keeping the input order inside each group and losing none', () => {
    const queueA = shelf('qa', 'A Queue', 'queue')
    const manualA = shelf('ma', 'A Shelf', 'manual')
    const manualB = shelf('mb', 'B Shelf', 'manual')
    const queueB = shelf('qb', 'B Queue', 'queue')

    const { queues, manual } = groupShelves([queueA, manualA, manualB, queueB])

    expect(queues).toEqual([queueA, queueB])
    expect(manual).toEqual([manualA, manualB])
    expect(queues.length + manual.length).toBe(4)
  })

  it('returns two empty groups for no shelves', () => {
    expect(groupShelves([])).toEqual({ queues: [], manual: [] })
  })
})
