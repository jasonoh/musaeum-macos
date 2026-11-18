import { describe, expect, it } from 'vitest'
import type { ShelfSummary } from '@shared/shelf.types'
import {
  applyPlacement,
  defaultShelfSort,
  dropPlacement,
  dropSide,
  groupShelves,
  orderBooksBy,
  queueReorderable,
  shelfSortOptions
} from './queue-order'

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

describe('dropSide', () => {
  it('is before in the first half of the target and after from the middle on', () => {
    expect(dropSide(10, 40)).toBe('before')
    expect(dropSide(20, 40)).toBe('after')
    expect(dropSide(30, 40)).toBe('after')
  })
})

describe('dropPlacement', () => {
  it('builds exactly one key, never an extra or an undefined one', () => {
    expect(dropPlacement('x', 'before')).toEqual({ before: 'x' })
    expect(Object.keys(dropPlacement('x', 'before'))).toEqual(['before'])
    expect(dropPlacement('x', 'after')).toEqual({ after: 'x' })
    expect(Object.keys(dropPlacement('x', 'after'))).toEqual(['after'])
  })
})

describe('applyPlacement (mirrors main moveBooks)', () => {
  const order = ['a', 'b', 'c', 'd']

  it('moves the block to the top in its current relative order, not the order passed', () => {
    expect(applyPlacement(order, ['c', 'a'], { to: 'top' })).toEqual(['a', 'c', 'b', 'd'])
  })

  it('moves the block to the bottom', () => {
    expect(applyPlacement(['a', 'b'], ['a'], { to: 'bottom' })).toEqual(['b', 'a'])
    expect(applyPlacement(order, ['b', 'a'], { to: 'bottom' })).toEqual(['c', 'd', 'a', 'b'])
  })

  it('lands the block beside the anchor', () => {
    expect(applyPlacement(order, ['d'], { before: 'b' })).toEqual(['a', 'd', 'b', 'c'])
    expect(applyPlacement(order, ['a'], { after: 'c' })).toEqual(['b', 'c', 'a', 'd'])
    expect(applyPlacement(order, ['d', 'a'], { after: 'b' })).toEqual(['b', 'a', 'd', 'c'])
  })

  it('returns an equal copy when the anchor is itself moved', () => {
    const next = applyPlacement(order, ['a', 'b'], { before: 'b' })
    expect(next).toEqual(order)
    expect(next).not.toBe(order)
  })

  it('returns an equal copy when the anchor is not in the order', () => {
    const next = applyPlacement(order, ['a'], { before: 'zzz' })
    expect(next).toEqual(order)
    expect(next).not.toBe(order)
  })

  it('ignores ids the order does not hold', () => {
    expect(applyPlacement(order, ['x', 'd'], { to: 'top' })).toEqual(['d', 'a', 'b', 'c'])
    expect(applyPlacement(order, ['x'], { to: 'top' })).toEqual(order)
  })

  it('does not mutate its inputs', () => {
    const o = ['a', 'b', 'c']
    const m = ['c']
    applyPlacement(o, m, { to: 'top' })
    expect(o).toEqual(['a', 'b', 'c'])
    expect(m).toEqual(['c'])
  })
})

describe('orderBooksBy', () => {
  const b = (id: string) => ({ id, n: id.toUpperCase() })

  it('re-orders the books by the ids, keeping the same objects', () => {
    const books = [b('a'), b('b'), b('c')]
    const out = orderBooksBy(books, ['c', 'a', 'b'])
    expect(out.map((x) => x.id)).toEqual(['c', 'a', 'b'])
    expect(out[0]).toBe(books[2])
  })

  it('drops an id with no book and keeps a book with no id, at the end', () => {
    const out = orderBooksBy([b('a'), b('b'), b('c')], ['c', 'zzz', 'a'])
    expect(out.map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('queueReorderable', () => {
  const base = {
    shelfKind: 'queue' as const,
    sort: { field: 'shelf_position', direction: 'asc' } as const,
    query: '',
    filters: {},
    deviceId: null
  }

  it('is true for a queue on Queue Order with nothing narrowing it', () => {
    expect(queueReorderable(base)).toBe(true)
  })

  it.each([
    ['a manual shelf', { shelfKind: 'manual' as const }],
    ['no shelf', { shelfKind: null }],
    ['another sort', { sort: { field: 'title', direction: 'asc' } as const }],
    ['a query', { query: '  x ' }],
    ['a filter', { filters: { coAuthor: 'A' } }],
    ['a device scope', { deviceId: 'kindle-1' }]
  ])('is false with %s', (_label, patch) => {
    expect(queueReorderable({ ...base, ...patch })).toBe(false)
  })

  it('treats a whitespace-only query as no query', () => {
    expect(queueReorderable({ ...base, query: '   ' })).toBe(true)
  })
})
