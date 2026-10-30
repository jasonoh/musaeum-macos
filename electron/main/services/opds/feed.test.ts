import { orderedFormats } from '@shared/book.types'
import type { Book } from '@shared/book.types'
import { describe, expect, it } from 'vitest'
import { makeBook } from '../../../../test/helpers/book'
import {
  FORMAT_TYPES,
  OPDS_ACQ_TYPE,
  OPDS_NAV_TYPE,
  OPDS_PAGE_SIZE,
  OPENSEARCH_TYPE,
  SUMMARY_MAX,
  OPDS_NAV_PAGE_SIZE,
  buildAcquisitionFeed,
  buildNavigationFeed,
  buildRootFeed,
  buildSearchDescription,
  escapeXml,
  pageWindow,
  type FeedContext,
  type NavEntry
} from './feed'

const ctx: FeedContext = { baseUrl: 'http://100.64.0.1:8789', now: '2026-10-29T12:00:00Z' }

function feedOf(books: Book[], total = books.length, rawPage: string | null = null): string {
  const window = pageWindow(rawPage, total)
  if (!window) throw new Error('bad page')
  return buildAcquisitionFeed(ctx, {
    id: 'urn:test',
    title: 'All',
    selfPath: '/opds/all',
    books,
    total,
    window
  })
}

/** A well-formedness check good enough for generated markup: every open tag closes in order. */
function balanced(xml: string): boolean {
  const stack: string[] = []
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '')
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[3] === '/') continue
    if (m[1] === '/') {
      if (stack.pop() !== m[2]) return false
    } else stack.push(m[2] ?? '')
  }
  return stack.length === 0
}

describe('escapeXml', () => {
  it('round-trips & < > " \' and a non-ASCII title', () => {
    const xml = feedOf([makeBook('a', `Tom & Jerry's <"Café"> 日本`)])
    expect(xml).toContain('Tom &amp; Jerry&apos;s &lt;&quot;Café&quot;&gt; 日本')
    expect(balanced(xml)).toBe(true)
  })

  it('drops characters illegal in XML 1.0', () => {
    expect(escapeXml('a\u0000b\u0008c\ud800d')).toBe('abcd')
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd')
    expect(escapeXml('😀')).toBe('😀')
  })
})

describe('buildRootFeed', () => {
  const xml = buildRootFeed(ctx)

  it('is a navigation feed with no catalog entries', () => {
    expect(xml).toContain('kind=navigation')
    expect(xml).toContain('rel="start"')
    expect(xml).toContain('rel="self"')
    expect(xml).toContain('/opds/new')
    expect(xml).toContain('/opds/all')
    expect(xml).toMatch(
      /<link rel="http:\/\/opds-spec\.org\/sort\/new"[^>]*href="[^"]*\/opds\/new"/
    )
    expect(xml).not.toContain('<link rel="http://opds-spec.org/acquisition')
    expect(xml).toMatch(/rel="search"/)
    expect(xml).toContain(`type="${OPENSEARCH_TYPE}"`)
    expect(xml).toContain('/opds/search.xml')
    expect(balanced(xml)).toBe(true)
  })

  it('lists Newest, Unread, Authors, Series, Titles, All books in order with the right kinds', () => {
    const entries = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map((m) => m[0])
    const shape = entries.map((e) => ({
      id: /<id>([^<]*)<\/id>/.exec(e)?.[1],
      title: /<title>([^<]*)<\/title>/.exec(e)?.[1],
      rel: /<link rel="([^"]*)"/.exec(e)?.[1],
      href: /href="([^"]*)"/.exec(e)?.[1],
      kind: /kind=(\w+)"/.exec(e)?.[1]
    }))
    const base = ctx.baseUrl
    expect(shape).toEqual([
      {
        id: 'urn:musaeum:opds:new',
        title: 'Newest',
        rel: 'http://opds-spec.org/sort/new',
        href: `${base}/opds/new`,
        kind: 'acquisition'
      },
      {
        id: 'urn:musaeum:opds:unread',
        title: 'Unread',
        rel: 'subsection',
        href: `${base}/opds/unread`,
        kind: 'acquisition'
      },
      {
        id: 'urn:musaeum:opds:authors',
        title: 'Authors',
        rel: 'subsection',
        href: `${base}/opds/authors`,
        kind: 'navigation'
      },
      {
        id: 'urn:musaeum:opds:series',
        title: 'Series',
        rel: 'subsection',
        href: `${base}/opds/series`,
        kind: 'navigation'
      },
      {
        id: 'urn:musaeum:opds:titles',
        title: 'Titles',
        rel: 'subsection',
        href: `${base}/opds/titles`,
        kind: 'navigation'
      },
      {
        id: 'urn:musaeum:opds:all',
        title: 'All books',
        rel: 'subsection',
        href: `${base}/opds/all`,
        kind: 'acquisition'
      }
    ])
  })

  it('uses the exact media types', () => {
    expect(OPDS_NAV_TYPE).toBe('application/atom+xml;profile=opds-catalog;kind=navigation')
    expect(OPDS_ACQ_TYPE).toBe('application/atom+xml;profile=opds-catalog;kind=acquisition')
    expect(OPENSEARCH_TYPE).toBe('application/opensearchdescription+xml')
  })
})

describe('buildNavigationFeed', () => {
  const entries: NavEntry[] = [
    {
      id: 'urn:test:a&b',
      title: 'Tom & <Jerry>\ud800',
      content: 'Books by "Tom" & co',
      path: '/opds/authors/T',
      kind: 'navigation'
    },
    {
      id: 'urn:test:b',
      title: 'Plain',
      content: 'A list',
      path: '/opds/authors/T/x',
      kind: 'acquisition'
    }
  ]
  const build = (extra: Partial<Parameters<typeof buildNavigationFeed>[1]> = {}): string =>
    buildNavigationFeed(ctx, {
      id: 'urn:test:nav',
      title: 'Authors',
      selfPath: '/opds/authors',
      entries,
      ...extra
    })

  it('is a navigation feed whose entries carry subsection links typed by kind, escaped', () => {
    const xml = build()
    expect(OPDS_NAV_PAGE_SIZE).toBe(200)
    expect(xml).toContain(
      `<link rel="self" href="${ctx.baseUrl}/opds/authors" type="${OPDS_NAV_TYPE}"/>`
    )
    expect(xml).toContain('<id>urn:test:a&amp;b</id>')
    expect(xml).toContain('<title>Tom &amp; &lt;Jerry&gt;</title>')
    expect(xml).toContain('<content type="text">Books by &quot;Tom&quot; &amp; co</content>')
    expect(xml).toContain(
      `<link rel="subsection" href="${ctx.baseUrl}/opds/authors/T" type="${OPDS_NAV_TYPE}"/>`
    )
    expect(xml).toContain(
      `<link rel="subsection" href="${ctx.baseUrl}/opds/authors/T/x" type="${OPDS_ACQ_TYPE}"/>`
    )
    expect(xml).not.toContain('rel="next"')
    expect(xml).not.toContain('rel="previous"')
    expect(xml).not.toContain('opensearch:totalResults')
    expect(balanced(xml)).toBe(true)
  })

  it('carries next and previous from a window, and totalResults only when given', () => {
    const window = { page: 2, offset: 200, limit: 200, hasNext: true, hasPrev: true }
    const xml = build({ window, total: 450 })
    expect(xml).toContain(
      `<link rel="previous" href="${ctx.baseUrl}/opds/authors?page=1" type="${OPDS_NAV_TYPE}"/>`
    )
    expect(xml).toContain(
      `<link rel="next" href="${ctx.baseUrl}/opds/authors?page=3" type="${OPDS_NAV_TYPE}"/>`
    )
    expect(xml).toContain('<opensearch:totalResults>450</opensearch:totalResults>')
    const q = build({ window, selfPath: '/opds/titles?q=a' })
    expect(q).toContain('href="http://100.64.0.1:8789/opds/titles?q=a&amp;page=3"')
    expect(q).not.toContain('opensearch:totalResults')
  })

  it('carries itemsPerPage equal to the window limit', () => {
    const window = pageWindow(null, 450, OPDS_NAV_PAGE_SIZE)!
    const xml = build({ window, total: 450 })
    expect(window.limit).toBe(200)
    expect(xml).toContain('<opensearch:itemsPerPage>200</opensearch:itemsPerPage>')
  })

  it('emits an encoded path attribute-escaped and otherwise unchanged', () => {
    const xml = build({
      entries: [
        {
          id: 'urn:x',
          title: 'X',
          content: 'c',
          path: '/opds/authors/a%2Fb%26c',
          kind: 'navigation'
        }
      ]
    })
    expect(xml).toContain('href="http://100.64.0.1:8789/opds/authors/a%2Fb%26c"')
  })

  it('honours an entry rel override', () => {
    const xml = build({
      entries: [
        { id: 'urn:x', title: 'X', content: 'c', path: '/p', kind: 'acquisition', rel: 'r' }
      ]
    })
    expect(xml).toContain('<link rel="r" href="http://100.64.0.1:8789/p"')
  })
})

describe('acquisition entries', () => {
  it('every acquisition link carries a type, with the open-access rel', () => {
    const xml = feedOf([makeBook('a'), { ...makeBook('b'), formats: ['epub', 'pdf', 'mobi'] }])
    const links = [
      ...xml.matchAll(/<link [^>]*rel="http:\/\/opds-spec\.org\/acquisition[^>]*>/g)
    ].map((m) => m[0])
    expect(links).toHaveLength(4)
    for (const l of links) {
      expect(l).toContain('rel="http://opds-spec.org/acquisition/open-access"')
      expect(l).toMatch(/type="[^"]+"/)
    }
  })

  it('a three-format book yields links in orderedFormats order, whatever order is stored', () => {
    const order = (formats: Book['formats']): string[] => {
      const xml = feedOf([{ ...makeBook('a'), formats }])
      return [...xml.matchAll(/\/opds\/book\/a\/(\w+)"/g)].map((m) => m[1] ?? '')
    }
    const one = order(['mobi', 'epub', 'pdf'])
    expect(one).toEqual(order(['pdf', 'epub', 'mobi']))
    expect(one).toEqual(orderedFormats({ ...makeBook('a'), formats: ['mobi', 'epub', 'pdf'] }))
  })

  it('azw3 and mobi share the Mobipocket type; epub and pdf have theirs', () => {
    expect(FORMAT_TYPES.azw3).toBe('application/x-mobipocket-ebook')
    expect(FORMAT_TYPES.mobi).toBe('application/x-mobipocket-ebook')
    expect(FORMAT_TYPES.epub).toBe('application/epub+zip')
    expect(FORMAT_TYPES.pdf).toBe('application/pdf')
  })

  it('a book with no covers yields no image links; with both, the cover routes', () => {
    expect(feedOf([makeBook('a')])).not.toContain('opds-spec.org/image')
    const xml = feedOf([{ ...makeBook('a'), coverThumbPath: 't.jpg', coverFullPath: 'f.jpg' }])
    expect(xml).toMatch(/rel="http:\/\/opds-spec\.org\/image"[^>]*\/opds\/cover\/a\/full"/)
    expect(xml).toMatch(
      /rel="http:\/\/opds-spec\.org\/image\/thumbnail"[^>]*\/opds\/cover\/a\/thumb"/
    )
  })

  it('atom:updated falls back lastModified, dateAdded, epoch', () => {
    const entry = (b: Partial<Book>): string =>
      feedOf([{ ...makeBook('a'), ...b }]).split('<entry>')[1] ?? ''
    expect(
      entry({ lastModified: '2026-01-02T00:00:00Z', dateAdded: '2025-01-01T00:00:00Z' })
    ).toContain('<updated>2026-01-02T00:00:00.000Z</updated>')
    expect(entry({ dateAdded: '2025-01-01T00:00:00Z' })).toContain(
      '<updated>2025-01-01T00:00:00.000Z</updated>'
    )
    expect(entry({})).toContain('<updated>1970-01-01T00:00:00Z</updated>')
  })

  it('atom:updated skips unparseable dates and normalizes loose ones', () => {
    const entry = (b: Partial<Book>): string =>
      feedOf([{ ...makeBook('a'), ...b }]).split('<entry>')[1] ?? ''
    expect(entry({ lastModified: 'garbage', dateAdded: '2025-01-01T00:00:00Z' })).toContain(
      '<updated>2025-01-01T00:00:00.000Z</updated>'
    )
    expect(entry({ lastModified: 'garbage', dateAdded: 'nope' })).toContain(
      '<updated>1970-01-01T00:00:00Z</updated>'
    )
    expect(entry({ lastModified: '', dateAdded: '2025-01-01T00:00:00Z' })).toContain(
      '<updated>2025-01-01T00:00:00.000Z</updated>'
    )
    expect(entry({ lastModified: '2020-01-01 00:00:00+00:00' })).toContain(
      '<updated>2020-01-01T00:00:00.000Z</updated>'
    )
  })

  it('dc:issued is emitted only for W3CDTF values', () => {
    const entry = (d: string): string =>
      feedOf([{ ...makeBook('a'), publishedDate: d }]).split('<entry>')[1] ?? ''
    expect(entry('circa 1850')).not.toContain('dc:issued')
    expect(entry('1850')).toContain('<dc:issued>1850</dc:issued>')
    expect(entry('2020-03-04')).toContain('<dc:issued>2020-03-04</dc:issued>')
  })

  it('emits the full field set when present', () => {
    const xml = feedOf([
      {
        ...makeBook('a', 'T'),
        author: 'Ann',
        publisher: 'Pub',
        language: 'en',
        publishedDate: '2020-05-01',
        isbn13: '9780000000002',
        isbn10: '0000000002',
        description: 'Desc',
        tags: ['x', 'y&z']
      }
    ])
    expect(xml).toContain('<id>urn:uuid:a</id>')
    expect(xml).toContain('<author><name>Ann</name></author>')
    expect(xml).toContain('<dc:publisher>Pub</dc:publisher>')
    expect(xml).toContain('<dc:language>en</dc:language>')
    expect(xml).toContain('<dc:issued>2020-05-01</dc:issued>')
    expect(xml).toContain('<dc:identifier>urn:isbn:9780000000002</dc:identifier>')
    expect(xml).toContain('<category term="y&amp;z" label="y&amp;z"/>')
    expect(xml).toContain('<summary type="text">Desc</summary>')
  })

  it('missing author, publisher, description, language, dates and a null seriesIndex produce no empty elements', () => {
    const xml = feedOf([{ ...makeBook('a'), seriesName: 'S', seriesIndex: null }])
    const entry = xml.split('<entry>')[1]
    expect(entry).not.toMatch(/<(author|dc:\w+|summary|category)\b/)
    expect(entry).not.toMatch(/<(\w+:?\w*)>\s*<\/\1>/)
    expect(xml).not.toContain('NaN')
    expect(xml).not.toContain('null')
  })

  it('a long description is truncated and still valid text', () => {
    const xml = feedOf([{ ...makeBook('a'), description: '😀'.repeat(SUMMARY_MAX * 2) }])
    const text = xml.match(/<summary type="text">([^<]*)<\/summary>/)?.[1] ?? ''
    expect([...text].length).toBeLessThanOrEqual(SUMMARY_MAX)
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/\p{Cs}/u)
    expect(balanced(xml)).toBe(true)
  })

  it('a description with illegal characters stays well-formed', () => {
    const xml = feedOf([{ ...makeBook('a'), description: 'x\u0000y\ud800z' }])
    expect(xml).toContain('<summary type="text">xyz</summary>')
  })
})

describe('pageWindow', () => {
  it('starts at page 1 and walks forward', () => {
    expect(pageWindow(null, 1000, 50)).toEqual({
      page: 1,
      offset: 0,
      limit: 50,
      hasNext: true,
      hasPrev: false
    })
    expect(pageWindow('2', 1000, 50)).toMatchObject({
      page: 2,
      offset: 50,
      hasNext: true,
      hasPrev: true
    })
    expect(pageWindow('20', 1000, 50)).toMatchObject({ page: 20, hasNext: false })
    expect(pageWindow(null, 10, 50)?.hasNext).toBe(false)
    expect(pageWindow(null, 50, 50)?.hasNext).toBe(false)
    expect(pageWindow(null, 100)?.limit).toBe(OPDS_PAGE_SIZE)
  })

  it('rejects a present-but-invalid page', () => {
    for (const bad of ['0', '-1', 'abc', '1.5', '', ' 1', '1e3', '99999999999999999999']) {
      expect(pageWindow(bad, 100)).toBeNull()
    }
  })

  it('a page past the end is valid and empty', () => {
    expect(pageWindow('99', 100, 50)).toMatchObject({ page: 99, hasNext: false, hasPrev: true })
  })
})

describe('acquisition feed paging', () => {
  const books = [makeBook('a')]
  const build = (rawPage: string | null, total: number): string => {
    const window = pageWindow(rawPage, total, 1)!
    return buildAcquisitionFeed(ctx, {
      id: 'urn:t',
      title: 'All',
      selfPath: '/opds/all',
      books,
      total,
      window
    })
  }

  it('next link while entries remain, none on the last page', () => {
    const first = build(null, 3)
    expect(first).toMatch(/rel="next"[^>]*\/opds\/all\?page=2"/)
    expect(first).not.toContain('rel="previous"')
    expect(first).toContain('<opensearch:totalResults>3</opensearch:totalResults>')
    expect(first).toContain('<opensearch:itemsPerPage>1</opensearch:itemsPerPage>')
    const last = build('3', 3)
    expect(last).not.toContain('rel="next"')
    expect(last).toMatch(/rel="previous"[^>]*\/opds\/all\?page=2"/)
  })

  it('appends with & when selfPath already has a query', () => {
    const window = pageWindow(null, 3, 1)!
    const xml = buildAcquisitionFeed(ctx, {
      id: 'urn:t',
      title: 'S',
      selfPath: '/opds/search?q=a%20b',
      books,
      total: 3,
      window
    })
    expect(xml).toContain('/opds/search?q=a%20b&amp;page=2')
  })

  it('carries rel start and the acquisition kind', () => {
    const xml = build(null, 1)
    expect(xml).toContain('rel="start"')
    expect(xml).toContain('kind=acquisition')
    expect(balanced(xml)).toBe(true)
  })
})

describe('buildSearchDescription', () => {
  it('Url template resolves against baseUrl', () => {
    const xml = buildSearchDescription(ctx)
    expect(xml).toContain('template="http://100.64.0.1:8789/opds/search?q={searchTerms}"')
    expect(xml).toContain(`type="${OPDS_ACQ_TYPE}"`)
    expect(balanced(xml)).toBe(true)
  })
})

describe('page size', () => {
  it('a page at OPDS_PAGE_SIZE with worst-case entries stays under 500 KB', () => {
    const books = Array.from({ length: OPDS_PAGE_SIZE }, (_, i) => ({
      ...makeBook(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 'T'.repeat(80)),
      author: 'A'.repeat(60),
      publisher: 'P'.repeat(60),
      language: 'en',
      publishedDate: '2020-01-01',
      isbn13: '9780000000002',
      description: '&<>"é'.repeat(400),
      tags: Array.from({ length: 5 }, (_, t) => `tag-${t}-&`),
      formats: ['epub', 'azw3', 'mobi', 'pdf'] as Book['formats'],
      coverThumbPath: 't',
      coverFullPath: 'f',
      lastModified: '2026-01-01T00:00:00Z'
    }))
    const xml = feedOf(books, books.length * 3)
    expect(Buffer.byteLength(xml, 'utf8')).toBeLessThan(500_000)
  })
})
