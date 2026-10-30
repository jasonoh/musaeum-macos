import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import { sortableAuthor, sortableTitle, type ReadStatus } from '@shared/book.types'
import { makeBook } from '../../../../test/helpers/book'
import { closeDb, getDb, getFacets, insertBook } from '../db'
import { matchBrowsePath, serveBrowse, type BrowseRoute } from './browse'
import { OPDS_NAV_PAGE_SIZE, type FeedContext } from './feed'

const CTX: FeedContext = { baseUrl: 'http://h:1', now: '2026-10-29T00:00:00Z' }

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
})

let seq = 0

function addBook(
  title: string,
  extra: {
    id?: string
    author?: string | null
    series?: string | null
    index?: number | null
    status?: ReadStatus
  } = {}
): string {
  const id = extra.id ?? `b${++seq}`
  const author = extra.author ?? null
  insertBook({
    ...makeBook(id, title),
    sortTitle: sortableTitle(title),
    author,
    authorSort: author ? sortableAuthor(author) : null,
    seriesName: extra.series ?? null,
    seriesIndex: extra.index ?? null,
    readStatus: extra.status ?? 'unread'
  })
  return id
}

function ok(route: BrowseRoute, page: string | null = null): string {
  const res = serveBrowse(route, CTX, page)
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
  return res.body
}

const bookIds = (xml: string): string[] =>
  [...xml.matchAll(/<id>urn:uuid:([^<]*)<\/id>/g)].map((m) => m[1]!)

function unescape(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Every `subsection` entry link's path, in document order, taken out of the XML. */
function subsectionPaths(xml: string): string[] {
  return [...xml.matchAll(/<link rel="subsection" href="([^"]+)"/g)].map((m) =>
    unescape(m[1]!).slice(CTX.baseUrl.length)
  )
}

describe('matchBrowsePath', () => {
  it('matches every route', () => {
    expect(matchBrowsePath('/opds/unread')).toEqual({ kind: 'unread' })
    expect(matchBrowsePath('/opds/authors')).toEqual({ kind: 'letters', tree: 'authors' })
    expect(matchBrowsePath('/opds/series')).toEqual({ kind: 'letters', tree: 'series' })
    expect(matchBrowsePath('/opds/titles')).toEqual({ kind: 'letters', tree: 'titles' })
    expect(matchBrowsePath('/opds/authors/D')).toEqual({
      kind: 'names',
      tree: 'authors',
      bucket: 'D'
    })
    expect(matchBrowsePath('/opds/series/Q')).toEqual({
      kind: 'names',
      tree: 'series',
      bucket: 'Q'
    })
    expect(matchBrowsePath('/opds/titles/T')).toEqual({ kind: 'titles', bucket: 'T' })
    expect(matchBrowsePath('/opds/by-author/Ann')).toEqual({ kind: 'by-author', name: 'Ann' })
    expect(matchBrowsePath('/opds/by-series/Dune')).toEqual({ kind: 'by-series', name: 'Dune' })
  })

  it('normalizes the slug: case-insensitive letters, `other` is #', () => {
    expect(matchBrowsePath('/opds/authors/d')).toEqual({
      kind: 'names',
      tree: 'authors',
      bucket: 'D'
    })
    expect(matchBrowsePath('/opds/authors/other')).toEqual({
      kind: 'names',
      tree: 'authors',
      bucket: '#'
    })
    expect(matchBrowsePath('/opds/titles/OTHER')).toEqual({ kind: 'titles', bucket: '#' })
  })

  it.each([
    '/opds/authors/dd',
    '/opds/authors/',
    '/opds/authors/D/x',
    '/opds/by-author/',
    '/opds/by-author/%E0%A4%A',
    '/opds/by-author/a/b',
    '/opds/unread/',
    '/opds/nope',
    '/opds',
    '/other/unread'
  ])('rejects %s', (path) => {
    expect(matchBrowsePath(path)).toBeNull()
  })

  it('keeps an encoded slash inside the name', () => {
    expect(matchBrowsePath(`/opds/by-author/${encodeURIComponent('A/B')}`)).toEqual({
      kind: 'by-author',
      name: 'A/B'
    })
  })
})

describe('names round-trip (Review Focus 1)', () => {
  it.each(['A/B %20 ? #1 & "x"', 'Łukasz Ünïcode', "O'Brien"])(
    'a link out of the names feed for %s leads back to exactly that book',
    (name) => {
      const author = addBook('By Author', { author: name })
      const series = addBook('In Series', { series: name })
      addBook('Decoy', { author: `${name}x`, series: `${name}x` })

      for (const [tree, id] of [
        ['authors', author],
        ['series', series]
      ] as const) {
        const letters = ok({ kind: 'letters', tree })
        // Find the bucket that lists the name, only through links found in the XML
        let link: string | undefined
        for (const lp of subsectionPaths(letters)) {
          const route = matchBrowsePath(lp)
          expect(route).not.toBeNull()
          link = subsectionPaths(ok(route!)).find((p) => {
            const r = matchBrowsePath(p)
            return r !== null && 'name' in r && r.name === name
          })
          if (link) break
        }
        expect(link).toBeDefined()
        const route = matchBrowsePath(link!)
        expect(route).toEqual({ kind: tree === 'authors' ? 'by-author' : 'by-series', name })
        expect(bookIds(ok(route!))).toEqual([id])
      }
    }
  )
})

describe('letters (Review Focus 4)', () => {
  it('sums to the books with an author, lists only buckets that hold books, and # only when used', () => {
    addBook('One', { author: 'Alice A' })
    addBook('Two', { author: 'Alan A' })
    addBook('Three', { author: 'Dora D' })
    addBook('No author')
    const xml = ok({ kind: 'letters', tree: 'authors' })
    const counts = [...xml.matchAll(/<content type="text">(\d+) books<\/content>/g)].map((m) =>
      Number(m[1])
    )
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3)
    expect(subsectionPaths(xml)).toEqual(['/opds/authors/A', '/opds/authors/D'])
    expect(xml).not.toContain('<title>#</title>')
  })

  it('has the # bucket when something falls in it, titled "#" and linked as other', () => {
    addBook('One', { author: 'Alice A' })
    addBook('Two', { author: '2Pac' })
    const xml = ok({ kind: 'letters', tree: 'authors' })
    expect(xml).toContain('<title>#</title>')
    expect(subsectionPaths(xml)).toContain('/opds/authors/other')
  })

  it('links titles buckets as acquisition feeds and the name trees as navigation feeds', () => {
    addBook('Apple', { author: 'Ann', series: 'Orchard' })
    const titles = ok({ kind: 'letters', tree: 'titles' })
    expect(subsectionPaths(titles)).toEqual(['/opds/titles/A'])
    expect(titles).toMatch(/\/opds\/titles\/A" type="[^"]*kind=acquisition"/)
    const authors = ok({ kind: 'letters', tree: 'authors' })
    expect(authors).toMatch(/\/opds\/authors\/A" type="[^"]*kind=navigation"/)
  })

  it('an empty library has a letters feed with no entries', () => {
    expect(subsectionPaths(ok({ kind: 'letters', tree: 'series' }))).toEqual([])
  })
})

describe('unread (AC2.18)', () => {
  it('matches the facet count, and leaves out reading and read books', () => {
    const u1 = addBook('Unread One')
    const u2 = addBook('Unread Two')
    const nul = addBook('Null Status')
    getDb().prepare('UPDATE books SET read_status = NULL WHERE id = ?').run(nul)
    const reading = addBook('Reading', { status: 'reading' })
    const read = addBook('Done', { status: 'read' })

    const xml = ok({ kind: 'unread' })
    const total = Number(/<opensearch:totalResults>(\d+)</.exec(xml)?.[1])
    const facet = getFacets().readStatus.find((s) => s.value === 'unread')?.count
    expect(total).toBe(facet)
    expect(total).toBe(3)
    const ids = bookIds(xml)
    expect(ids).toEqual(expect.arrayContaining([u1, u2, nul]))
    expect(ids).not.toContain(reading)
    expect(ids).not.toContain(read)
  })
})

describe('paging', () => {
  it.each(['0', 'abc', '-1'])('answers ?page=%s with 400', (page) => {
    addBook('Anything', { author: 'Ann' })
    const routes: BrowseRoute[] = [
      { kind: 'unread' },
      { kind: 'names', tree: 'authors', bucket: 'A' },
      { kind: 'titles', bucket: 'A' },
      { kind: 'by-author', name: 'Ann' }
    ]
    for (const route of routes) expect(serveBrowse(route, CTX, page)).toEqual({ status: 400 })
  })

  it('a page past the end is a 200 with no entries and no next', () => {
    addBook('Anything', { author: 'Ann' })
    const names = ok({ kind: 'names', tree: 'authors', bucket: 'A' }, '99')
    expect(subsectionPaths(names)).toEqual([])
    expect(names).not.toContain('rel="next"')
    const books = ok({ kind: 'unread' }, '99')
    expect(bookIds(books)).toEqual([])
    expect(books).not.toContain('rel="next"')
  })

  it('walking next through a names feed of 450 names yields every name once', () => {
    getDb().transaction(() => {
      for (let i = 0; i < 450; i++) addBook(`T${i}`, { author: `Zed${String(i).padStart(3, '0')}` })
    })()
    const seen: string[] = []
    let path: string | null = '/opds/authors/Z'
    let pages = 0
    while (path) {
      const route = matchBrowsePath(path.split('?')[0]!)
      const page = new URL(path, CTX.baseUrl).searchParams.get('page')
      const xml = ok(route!, page)
      seen.push(...subsectionPaths(xml).map((p) => (matchBrowsePath(p) as { name: string }).name))
      const next = /<link rel="next" href="([^"]+)"/.exec(xml)?.[1]
      path = next ? unescape(next).slice(CTX.baseUrl.length) : null
      pages += 1
      expect(pages).toBeLessThan(10)
    }
    expect(pages).toBe(Math.ceil(450 / OPDS_NAV_PAGE_SIZE))
    expect(new Set(seen).size).toBe(450)
    expect(seen).toEqual([...seen].sort())
  })
})

describe('ordering and unknown names', () => {
  it('by-series orders by series index, by-author by title', () => {
    const third = addBook('Alpha', { author: 'Ann', series: 'S', index: 3 })
    const first = addBook('Zulu', { author: 'Ann', series: 'S', index: 1 })
    const second = addBook('Mike', { author: 'Ann', series: 'S', index: 2 })
    expect(bookIds(ok({ kind: 'by-series', name: 'S' }))).toEqual([first, second, third])
    expect(bookIds(ok({ kind: 'by-author', name: 'Ann' }))).toEqual([third, second, first])
  })

  it('titles lists the books under a letter in title order', () => {
    const b = addBook('Bravo')
    const a2 = addBook('Apple')
    const a1 = addBook('The Aardvark')
    expect(bookIds(ok({ kind: 'titles', bucket: 'A' }))).toEqual([a1, a2])
    expect(bookIds(ok({ kind: 'titles', bucket: 'B' }))).toEqual([b])
  })

  it('an unknown name is a 200 with zero entries', () => {
    addBook('Something', { author: 'Ann' })
    for (const route of [
      { kind: 'by-author', name: 'Nobody' },
      { kind: 'by-series', name: 'Nothing' }
    ] as const) {
      const res = serveBrowse(route, CTX, null)
      expect(res.status).toBe(200)
      expect(bookIds((res as { body: string }).body)).toEqual([])
    }
  })
})
