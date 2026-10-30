import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import { sortableAuthor, sortableTitle } from '@shared/book.types'
import { makeBook } from '../../../test/helpers/book'
import { BUCKETS, type Bucket } from './initials'
import {
  closeDb,
  countBooks,
  countBooksByInitial,
  getBooksPage,
  getDb,
  insertBook,
  listNamesByInitial
} from './db'

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
})

const ALL = { limit: 1000, offset: 0 }
let seq = 0

function addBook(
  title: string,
  extra: { author?: string | null; authorSort?: string | null; series?: string | null } = {}
): void {
  const id = `b${++seq}`
  const author = extra.author ?? null
  insertBook({
    ...makeBook(id, title),
    sortTitle: sortableTitle(title),
    author,
    authorSort:
      extra.authorSort !== undefined ? extra.authorSort : author ? sortableAuthor(author) : null,
    seriesName: extra.series ?? null
  })
}

function countsOf(rows: { bucket: Bucket; count: number }[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.bucket, r.count]))
}

describe('musaeum_initial', () => {
  it('is callable from SQL and shares the TypeScript rule', () => {
    const row = getDb().prepare(`SELECT musaeum_initial('Éric') AS b`).get() as { b: string }
    expect(row.b).toBe('E')
  })

  it('does not choke on odd letters', () => {
    const row = getDb().prepare(`SELECT musaeum_initial('ßeta') AS b`).get() as { b: string }
    expect(BUCKETS).toContain(row.b)
  })
})

describe('titleInitial filter', () => {
  it('returns only books whose sort title buckets to the letter, with a matching total', () => {
    addBook('Dune')
    addBook('Dracula')
    addBook('The Dispossessed')
    addBook('Emma')
    addBook('The Hobbit')
    addBook('1984')
    const filters = {
      titleInitial: 'D' as const,
      sort: { field: 'title', direction: 'asc' } as const
    }
    const page = getBooksPage(filters, ALL)
    expect(page.books.map((b) => b.title)).toEqual(['The Dispossessed', 'Dracula', 'Dune'])
    expect(page.total).toBe(countBooks(filters))
    expect(page.total).toBe(3)
    const h = getBooksPage({ titleInitial: 'H' }, ALL)
    expect(h.books.map((b) => b.title)).toEqual(['The Hobbit'])
  })

  it('countBooksByInitial("title") counts books per bucket in BUCKETS order', () => {
    addBook('Dune')
    addBook('The Dispossessed')
    addBook('Emma')
    addBook('1984')
    expect(countBooksByInitial('title')).toEqual([
      { bucket: 'D', count: 2 },
      { bucket: 'E', count: 1 },
      { bucket: '#', count: 1 }
    ])
  })
})

describe('author buckets', () => {
  it('buckets by author_sort, with digits and non-Latin in #', () => {
    addBook('One', { author: 'Dickinson, Seth' })
    addBook('Two', { author: 'Éric Vuillard', authorSort: 'Vuillard, Éric' })
    addBook('Three', { author: '1984' })
    addBook('Four', { author: '東野圭吾' })
    const counts = countsOf(countBooksByInitial('author'))
    expect(counts).toEqual({ D: 1, V: 1, '#': 2 })
    expect(counts.E).toBeUndefined()
  })

  it('puts a name in exactly one bucket even when its books disagree on author_sort', () => {
    addBook('One', { author: 'Douglas', authorSort: 'Adams, Douglas' })
    addBook('Two', { author: 'Douglas', authorSort: 'Zeta, Douglas' })
    expect(countsOf(countBooksByInitial('author'))).toEqual({ A: 2 })
    expect(listNamesByInitial('author', 'A', ALL).names).toEqual([{ name: 'Douglas', count: 2 }])
    expect(listNamesByInitial('author', 'Z', ALL)).toEqual({ names: [], total: 0 })
  })

  it('excludes books with no author or series', () => {
    addBook('One', { author: null })
    addBook('Two', { author: '' })
    addBook('Three', { author: 'Adams', series: null })
    addBook('Four', { author: 'Baker', series: '' })
    expect(countsOf(countBooksByInitial('author'))).toEqual({ A: 1, B: 1 })
    expect(countBooksByInitial('series')).toEqual([])
    for (const b of BUCKETS) {
      expect(listNamesByInitial('series', b, ALL)).toEqual({ names: [], total: 0 })
      expect(listNamesByInitial('author', b, ALL).names.map((n) => n.name)).not.toContain('')
    }
  })

  it('bucket counts equal the sum of the names listed under each bucket', () => {
    addBook('1', { author: 'Adams, A' })
    addBook('2', { author: 'Adams, A' })
    addBook('3', { author: 'Abbott, B' })
    addBook('4', { author: 'Baker, C' })
    addBook('5', { author: 'Éric Vuillard', authorSort: 'Vuillard, Éric' })
    addBook('6', { author: '東野圭吾' })
    addBook('7', { author: null })
    const rows = countBooksByInitial('author')
    let total = 0
    for (const { bucket, count } of rows) {
      const sum = listNamesByInitial('author', bucket, ALL).names.reduce((s, n) => s + n.count, 0)
      expect(sum).toBe(count)
      total += count
    }
    expect(total).toBe(6)
    expect(rows.map((r) => r.bucket)).toEqual(['A', 'B', 'V', '#'])
  })

  it('pages through names exactly once', () => {
    for (const n of ['Aa', 'Ab', 'Ac', 'Ad', 'Ae']) addBook(n, { author: n })
    addBook('x', { author: 'Ae' })
    const seen: string[] = []
    for (let offset = 0; offset < 6; offset += 2) {
      const r = listNamesByInitial('author', 'A', { limit: 2, offset })
      expect(r.total).toBe(5)
      seen.push(...r.names.map((n) => n.name))
    }
    expect(seen).toEqual(['Aa', 'Ab', 'Ac', 'Ad', 'Ae'])
    expect(listNamesByInitial('author', 'A', { limit: 2, offset: 10 })).toEqual({
      names: [],
      total: 5
    })
  })
})

describe('series buckets', () => {
  it('lists series by name, case-insensitively ordered', () => {
    addBook('1', { series: 'dune' })
    addBook('2', { series: 'dune' })
    addBook('3', { series: 'Discworld' })
    addBook('4', { series: 'Earthsea' })
    expect(countsOf(countBooksByInitial('series'))).toEqual({ D: 3, E: 1 })
    expect(listNamesByInitial('series', 'D', ALL)).toEqual({
      names: [
        { name: 'Discworld', count: 1 },
        { name: 'dune', count: 2 }
      ],
      total: 2
    })
  })

  it('returns awkward names byte-identical', () => {
    const name = 'A/B %20 ? #1 & "x"'
    addBook('1', { series: name })
    expect(listNamesByInitial('series', 'A', ALL).names).toEqual([{ name, count: 1 }])
  })
})
