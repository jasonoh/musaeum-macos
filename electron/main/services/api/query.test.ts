import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { API_ERRORS, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './shape'
import { intParam, listParam, parseLibraryQuery, parseShelfParam, parseSort } from './query'
import { isBooksCollection, matchBookPath, matchShelfMembershipPath, refusalError } from './routes'

/**
 * The moved functions' socketless cases (slice 1c's split, D2).
 *
 * These two modules used to be ~170 lines inside `api/rest.ts`, where every one
 * of their decisions could only be made by opening a socket and asking the
 * server. D2's test is "anything that can be a pure function of inputs becomes
 * one so the suite can decide it without a socket", and this file is that
 * payoff: **no server, no `fetch`, no database, no filesystem** — a `URL` in, a
 * decision out. The socket-level cases that only a wire can decide (a 400
 * arriving as a status, an order compared against the app's own list) stay in
 * `api/rest.test.ts`, where the socket is.
 *
 * `routes.ts`'s cases live here rather than in a file of its own because the
 * split's file row is the one pair — this is "the moved functions and their
 * socketless cases", and `matchBookPath` is one of the moved functions.
 */

/** The only thing these cases need from a request: a URL. */
function url(pathAndQuery: string): URL {
  return new URL(pathAndQuery, 'http://musaeum.invalid')
}

describe('parseLibraryQuery — the parameters every client types', () => {
  it('answers the contract defaults for a bare request', () => {
    const parsed = parseLibraryQuery(url('/api/library'))

    expect(parsed).toEqual({
      ok: true,
      query: { filters: {}, query: null, limit: DEFAULT_PAGE_LIMIT, offset: 0 }
    })
  })

  it('reads limit and offset, and passes the page on unchanged', () => {
    const parsed = parseLibraryQuery(url('/api/library?limit=10&offset=250'))

    expect(parsed.ok && parsed.query.limit).toBe(10)
    expect(parsed.ok && parsed.query.offset).toBe(250)
  })

  it('clamps a limit above the cap rather than refusing it (D7)', () => {
    // The one value that is repaired instead of refused: asking for everything
    // is a request this surface can satisfy, at 500 rows — and the response
    // echoes what was actually served
    const parsed = parseLibraryQuery(url(`/api/library?limit=${MAX_PAGE_LIMIT + 400}`))

    expect(parsed.ok && parsed.query.limit).toBe(MAX_PAGE_LIMIT)
  })

  it('takes the filter lists in both spellings, comma and repeated', () => {
    const repeated = parseLibraryQuery(url('/api/library?tags=a&tags=b&authors=Ursula K. Le Guin'))
    const commas = parseLibraryQuery(url('/api/library?tags=a,b&authors=Ursula K. Le Guin'))

    expect(repeated.ok && repeated.query.filters).toEqual(commas.ok && commas.query.filters)
    expect(commas.ok && commas.query.filters).toEqual({
      tags: ['a', 'b'],
      authors: ['Ursula K. Le Guin']
    })
  })

  it('trims a blank q to no search at all', () => {
    // A `q` of spaces is not a search for spaces: the app's own FTS path would
    // find nothing, where a plain list is what the client meant
    const blank = parseLibraryQuery(url('/api/library?q=%20%20'))
    const missing = parseLibraryQuery(url('/api/library'))

    expect(blank).toEqual(missing)
    expect(parseLibraryQuery(url('/api/library?q=  Ursula  '))).toMatchObject({
      ok: true,
      query: { query: 'Ursula' }
    })
  })

  it('accepts only the formats and statuses the payload can report', () => {
    // Both lists come from the shaper (`BOOK_FILE_EXTENSIONS`, `READ_STATUSES`),
    // so a filter can never name a value the wire has no word for
    const good = parseLibraryQuery(url('/api/library?formats=epub,pdf&readStatus=reading,read'))
    expect(good.ok && good.query.filters).toEqual({
      formats: ['epub', 'pdf'],
      readStatus: ['reading', 'read']
    })
  })

  it('carries minRating as a whole number only when it is there', () => {
    expect(parseLibraryQuery(url('/api/library?minRating=5'))).toMatchObject({
      ok: true,
      query: { filters: { minRating: 5 } }
    })
    // Absent is absent — the key is not invented — while present and empty is
    // wrong, which is the read routes' own rule for an optional parameter
    const absent = parseLibraryQuery(url('/api/library'))
    expect(absent.ok && 'minRating' in absent.query.filters).toBe(false)
    expect(parseLibraryQuery(url('/api/library?minRating=')).ok).toBe(false)
  })

  it.each([
    ['limit=abc'],
    ['limit=-1'],
    ['limit=1.5'],
    ['offset=xyz'],
    ['offset=-4'],
    ['sort=athor'],
    ['sort=title&dir=sideways'],
    ['formats=sh'],
    ['readStatus=nope'],
    ['minRating=lots']
  ])('refuses a malformed parameter rather than defaulting it (%s)', (query) => {
    // A client that asked for `sort=athor` and received title order could never
    // learn it had a typo, which is why every one of these is a 400 — and the
    // decision is made here, without a socket
    expect(parseLibraryQuery(url(`/api/library?${query}`))).toEqual({ ok: false })
  })

  it('reads an empty limit or offset as absent, which is what it already did', () => {
    // `?limit=` is not a malformed number — it is a parameter with no value,
    // and `intParam` answers the fallback for it. Pinned because the split
    // moved this function and a silent change of meaning here would be a
    // different route. `?minRating=` is the case that *is* refused, and the
    // reason is its own guard rather than this one (see above).
    const empty = parseLibraryQuery(url('/api/library?limit=&offset='))

    expect(empty).toMatchObject({ ok: true, query: { limit: DEFAULT_PAGE_LIMIT, offset: 0 } })
  })
})

describe('parseSort — the field/direction rule', () => {
  it('answers "no sort asked for" for neither parameter, which is not title order', () => {
    // A search with no `sort` keeps SQLite's FTS `rank` — an ordering no field
    // name can express — so null and `{field:'title'}` are different answers
    expect(parseSort(url('/api/library').searchParams, false)).toEqual({ ok: true, sort: null })
  })

  it('defaults the field to title and, given only a field, takes its natural direction', () => {
    expect(parseSort(url('/api/library?sort=author').searchParams, false)).toEqual({
      ok: true,
      sort: { field: 'author', direction: 'asc' }
    })
    // The same rule the app's own sort control uses on a first click
    expect(parseSort(url('/api/library?sort=date_added').searchParams, false)).toEqual({
      ok: true,
      sort: { field: 'date_added', direction: 'desc' }
    })
    expect(parseSort(url('/api/library?sort=rating').searchParams, false)).toEqual({
      ok: true,
      sort: { field: 'rating', direction: 'desc' }
    })
  })

  it('reads an explicit direction, and a lone dir as a sort of titles', () => {
    expect(parseSort(url('/api/library?sort=date_added&dir=asc').searchParams, false)).toEqual({
      ok: true,
      sort: { field: 'date_added', direction: 'asc' }
    })
    expect(parseSort(url('/api/library?dir=desc').searchParams, false)).toEqual({
      ok: true,
      sort: { field: 'title', direction: 'desc' }
    })
  })

  it.each([['sort=athor'], ['sort=title&dir=sideways'], ['dir=ASC']])(
    'refuses an unusable field or direction (%s)',
    (query) => {
      // Refused rather than ignored, and case-sensitively: `ASC` is not `asc`,
      // and a sort this surface cannot honour is not a sort it may invent
      expect(parseSort(url(`/api/library?${query}`).searchParams, false)).toEqual({ ok: false })
    }
  )

  it('refuses shelf_added without a shelf, and takes it with one (D10)', () => {
    // The type grew the field for the Mac (bookshelves D8); on the wire it is a
    // sort only next to a `shelf` parameter to scope by — what `hasShelf` says —
    // and without one it stays the unknown field it was before the type grew it,
    // refused with a 400 rather than answered with a silent title order
    expect(parseSort(url('/api/library?sort=shelf_added').searchParams, false)).toEqual({
      ok: false
    })
    expect(parseSort(url('/api/library?sort=shelf_added&dir=desc').searchParams, false)).toEqual({
      ok: false
    })
    expect(parseSort(url('/api/library?sort=shelf_added').searchParams, true)).toEqual({
      ok: true,
      sort: { field: 'shelf_added', direction: 'desc' }
    })
    expect(parseSort(url('/api/library?sort=shelf_added&dir=asc').searchParams, true)).toEqual({
      ok: true,
      sort: { field: 'shelf_added', direction: 'asc' }
    })
  })
})

describe('the shelf parameter (bookshelves D10)', () => {
  it('reads shelf into the filters, trimmed', () => {
    expect(parseLibraryQuery(url('/api/library?shelf=to-read'))).toMatchObject({
      ok: true,
      query: { filters: { shelfId: 'to-read' } }
    })
    expect(parseLibraryQuery(url('/api/library?shelf=%20to-read%20'))).toMatchObject({
      ok: true,
      query: { filters: { shelfId: 'to-read' } }
    })
  })

  it('refuses a present-but-empty shelf rather than defaulting it (S4)', () => {
    // Present and wrong is refused, absent is absent — the `?minRating=` rule
    expect(parseLibraryQuery(url('/api/library?shelf='))).toEqual({ ok: false })
    expect(parseLibraryQuery(url('/api/library?shelf=%20'))).toEqual({ ok: false })
    const absent = parseLibraryQuery(url('/api/library'))
    expect(absent.ok && 'shelfId' in absent.query.filters).toBe(false)
  })

  it('takes Date Added to Shelf as the default order inside a shelf, and only there (S5)', () => {
    expect(parseLibraryQuery(url('/api/library?shelf=to-read'))).toMatchObject({
      ok: true,
      query: {
        filters: { shelfId: 'to-read', sort: { field: 'shelf_added', direction: 'desc' } }
      }
    })
    // An explicit sort wins over the default…
    expect(parseLibraryQuery(url('/api/library?shelf=x&sort=title'))).toMatchObject({
      ok: true,
      query: { filters: { sort: { field: 'title', direction: 'asc' } } }
    })
    // …and a search keeps FTS relevance: no sort key at all, so `searchRows`
    // falls back to `rank`, exactly as a Mac search inside a shelf behaves
    const search = parseLibraryQuery(url('/api/library?shelf=x&q=ursula'))
    expect(search.ok && 'sort' in search.query.filters).toBe(false)
    // The library without a shelf invents no sort either
    const plain = parseLibraryQuery(url('/api/library'))
    expect(plain.ok && 'sort' in plain.query.filters).toBe(false)
  })

  it('lets shelf_added through only when a shelf scoped the query', () => {
    expect(parseLibraryQuery(url('/api/library?shelf=x&sort=shelf_added'))).toMatchObject({
      ok: true,
      query: { filters: { sort: { field: 'shelf_added', direction: 'desc' } } }
    })
    expect(parseLibraryQuery(url('/api/library?sort=shelf_added'))).toEqual({ ok: false })
  })
})

describe('parseShelfParam — the scope, read once for both routes', () => {
  it('answers the id, null when absent, and refuses empty (S4)', () => {
    expect(parseShelfParam(url('/api/library').searchParams)).toEqual({ ok: true, shelfId: null })
    expect(parseShelfParam(url('/api/library?shelf=%20to-read%20').searchParams)).toEqual({
      ok: true,
      shelfId: 'to-read'
    })
    expect(parseShelfParam(url('/api/library?shelf=').searchParams)).toEqual({ ok: false })
    expect(parseShelfParam(url('/api/library?shelf=%20').searchParams)).toEqual({ ok: false })
  })
})

describe('intParam and listParam — the two building blocks', () => {
  it.each([
    ['7', 7],
    ['0', 0],
    ['007', 7]
  ])('reads %s as %d', (raw, expected) => {
    expect(intParam(raw, null)).toBe(expected)
  })

  it('answers the fallback for what is absent or empty', () => {
    // `fallback` may be null, which is how an optional parameter is read
    expect(intParam(null, DEFAULT_PAGE_LIMIT)).toBe(DEFAULT_PAGE_LIMIT)
    expect(intParam('', null)).toBeNull()
    expect(intParam(null, null)).toBeNull()
  })

  it.each([['abc'], ['-1'], ['1.5'], ['1e3'], [' 7'], ['0x10'], ['Infinity']])(
    'refuses %s rather than coercing it',
    (raw) => {
      // `Number()` would take several of these; a whole non-negative integer is
      // the only thing this surface accepts
      expect(intParam(raw, null)).toBeNull()
      // …and the fallback is not smuggled in instead: null means refused
      expect(intParam(raw, 99)).toBeNull()
    }
  )

  it('refuses a number beyond the safe-integer range', () => {
    expect(intParam('9007199254740993', null)).toBeNull()
  })

  it('splits, trims and drops blanks — and null when nothing is left', () => {
    const params = url('/api/library?tags=a,%20b&tags=,&tags=c').searchParams
    expect(listParam(params, 'tags')).toEqual(['a', 'b', 'c'])
    expect(listParam(params, 'authors')).toBeNull()
    expect(listParam(url('/api/library?tags=').searchParams, 'tags')).toBeNull()
  })
})

describe('matchBookPath — which book route a path is', () => {
  it('names the id and the resource for all four shapes', () => {
    expect(matchBookPath('/api/books/abc')).toEqual({ id: 'abc', resource: '' })
    expect(matchBookPath('/api/books/abc/cover')).toEqual({ id: 'abc', resource: 'cover' })
    expect(matchBookPath('/api/books/abc/file')).toEqual({ id: 'abc', resource: 'file' })
    // Slice 1c's write route: matched by path, gated on the method in the router
    expect(matchBookPath('/api/books/abc/reading')).toEqual({ id: 'abc', resource: 'reading' })
  })

  it('decodes a percent-escaped segment, so an id with a space is still an id', () => {
    expect(matchBookPath('/api/books/a%20b')?.id).toBe('a b')
    expect(matchBookPath('/api/books/6f1a%2F2e')?.id).toBe('6f1a/2e')
  })

  it('answers null for a malformed escape rather than throwing', () => {
    // `decodeURIComponent` throws on these; an id that cannot be decoded is
    // simply not a book, and the router answers 404 uniformly (D11)
    expect(matchBookPath('/api/books/%E0%A4%A')).toBeNull()
    expect(matchBookPath('/api/books/%')).toBeNull()
  })

  it.each([
    '/api/library',
    '/api/books/',
    '/api/books//cover',
    '/api/books/abc/banana',
    '/api/books/abc/cover/extra',
    '/api/books/abc/file/1'
  ])('answers null for a path that is not one of the four shapes (%s)', (pathname) => {
    expect(matchBookPath(pathname)).toBeNull()
  })

  it('reads a trailing slash on the detail route as the detail route', () => {
    // Pinned rather than endorsed: `/api/books/abc/` splits to a segment and an
    // empty resource, so it has always answered the book. The split moved this
    // function, and a route that changed shape while moving would be a contract
    // change nobody asked for.
    expect(matchBookPath('/api/books/abc/')).toEqual({ id: 'abc', resource: '' })
  })

  it('decodes a traversing id instead of treating it as a path', () => {
    // An id is a cache key and never touches the filesystem, so `..` is simply
    // an id no row has — the router answers 404 for it like any other unknown
    // book (D11). A *path* that climbs (`/api/books/../../etc/passwd`) has extra
    // segments, so it is not one of the four shapes and matches nothing at all.
    expect(matchBookPath('/api/books/..')?.id).toBe('..')
    expect(matchBookPath('/api/books/../../etc/passwd')).toBeNull()
  })
})

describe('matchShelfMembershipPath — the membership write (bookshelves D10)', () => {
  it('names both ids for the one shape it answers', () => {
    expect(matchShelfMembershipPath('/api/shelves/abc/books/def')).toEqual({
      shelfId: 'abc',
      bookId: 'def'
    })
  })

  it('decodes both segments, so an id with a space or a slash is still an id', () => {
    expect(matchShelfMembershipPath('/api/shelves/a%20b/books/c%2Fd')).toEqual({
      shelfId: 'a b',
      bookId: 'c/d'
    })
  })

  it.each([
    '/api/shelves',
    '/api/shelves/',
    '/api/shelves/abc',
    '/api/shelves/abc/books',
    '/api/shelves/abc/books/def/extra',
    '/api/shelves/abc/shelf/def',
    '/api/books/abc'
  ])('answers null for a path that is not the membership shape (%s)', (pathname) => {
    expect(matchShelfMembershipPath(pathname)).toBeNull()
  })

  it('answers null for a malformed escape rather than throwing', () => {
    // The book matcher's own rule: an id that cannot be decoded is simply not
    // this route's path, and the router answers 404 uniformly (D11)
    expect(matchShelfMembershipPath('/api/shelves/%E0%A4%A/books/b')).toBeNull()
    expect(matchShelfMembershipPath('/api/shelves/a/books/%')).toBeNull()
  })
})

describe('isBooksCollection — the collection itself, which the matcher cannot name', () => {
  it('names the bare path, and the two are disjoint by construction', () => {
    // `BOOKS_PREFIX`'s trailing slash is exactly what keeps the collection out
    // of `matchBookPath` — which is why slice 2 needed a second function rather
    // than a third `BookResource` (`BookPath` has no room for an id-less route)
    expect(isBooksCollection('/api/books')).toBe(true)
    expect(matchBookPath('/api/books')).toBeNull()
  })

  it('answers for the pathname alone — the query is the route’s parameters', () => {
    // The router hands this function `url.pathname`, and what a client appends
    // (`?format=epub&filename=…`) is that route's parameters rather than part of
    // what it matches on
    expect(isBooksCollection('/api/books?format=epub&filename=Dune.epub')).toBe(false)
  })

  it.each([
    '/api/books/',
    '/api/books/abc',
    '/api/books/abc/reading',
    '/api/book',
    '/api/bookshelf',
    '/api/booksa',
    '/api/library'
  ])('is false for a path that is not the collection (%s)', (pathname) => {
    expect(isBooksCollection(pathname)).toBe(false)
  })
})

describe('refusalError — the resolver’s split, named once', () => {
  it('maps the resolver’s two statuses to the contract’s own words', () => {
    // Not re-typed strings: the words are `API_ERRORS`' values, so the error
    // table in `docs/rest-api.md`, the shaper and this mapping are one
    // declaration with three readers
    expect(refusalError(400)).toBe('badRequest')
    expect(refusalError(404)).toBe('notFound')
    expect(API_ERRORS[refusalError(400)]).toBe(API_ERRORS.badRequest)
    expect(API_ERRORS[refusalError(404)]).toBe(API_ERRORS.notFound)
  })
})

describe('the moved modules are decidable without a socket (D2)', () => {
  it('imports no database, no NAS and no filesystem at runtime', () => {
    // The claim this whole split rests on, evidenced by the import lists
    // themselves rather than asserted: `query.ts` reads a URL and the shaper's
    // own constants, and `routes.ts` reads a path — the one cross-module import
    // it has is `import type`, which is erased at build time.
    for (const name of ['query.ts', 'routes.ts']) {
      const source = readFileSync(
        join(process.cwd(), 'electron', 'main', 'services', 'api', name),
        'utf8'
      )
      // **Every specifier, wherever it sits.** A line-based scan (`lines that
      // start with 'import '`) cannot see a specifier on a wrapped line, which
      // is exactly the hole this case exists to close — part 5a's report-only
      // review measured it as a real gap in the evidence even though today's
      // files pass it.
      const specifiers = [
        ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
        ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)
      ].map((match) => match[1])

      expect(specifiers.join('\n')).not.toMatch(/node:fs|node:http|nas-manager|\.\.\/db/)
      expect(specifiers).not.toContain('electron')
      expect(source).not.toMatch(/require\(/)
    }
  })
})
