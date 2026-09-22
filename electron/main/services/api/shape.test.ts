import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { Book } from '@shared/book.types'
import { makeBook } from '../../../../test/helpers/book'
import { BOOK_CONTENT_TYPES } from '../book-bytes'
import {
  API_ERRORS,
  API_VERSION,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  bookPayload,
  errorPayload,
  facetsPayload,
  healthPayload,
  libraryPayload
} from './shape'

/**
 * The wire's shape, decided two ways at once.
 *
 * **The golden is the contract document itself.** `docs/rest-api.md` carries one
 * `json payload=<name>` block per payload, and every case below parses those
 * blocks and compares them to what the shaper actually builds from a fixture
 * book — so a field added to the shaper and not to the document (or the
 * reverse) fails here, which is exactly the drift this pair exists to catch
 * (AC19, D10). A second copy of the payloads in this file would be a third thing
 * to keep in step, and the first one to rot.
 *
 * The rest of the file decides what a document cannot: that the fields *omitted*
 * are omitted, that a book with nothing in it carries the same field list as one
 * with everything (a key that appears only sometimes is a client's crash), and
 * that the read path's imports contain no filesystem and no NAS (AC16's
 * evidence).
 */

const ID = '6f1a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b'
const ADDED = '2026-08-13T18:04:21.000Z'
const TOUCHED = '2026-09-21T09:12:00.000Z'

/**
 * One book with every field a real row holds, and two deliberate departures
 * from the obvious fixture: `formats` is **not** in preference order (so the
 * payload's ordering is decided rather than copied), and the reading state is a
 * fraction with a CFI beside it (so the wire's omission of the CFI is visible
 * next to the member that does cross).
 */
const GOLDEN: Book = {
  ...makeBook(ID, 'Leviathan Wakes'),
  author: 'James S. A. Corey',
  authorSort: 'Corey, James S. A.',
  publisher: 'Orbit',
  publishedDate: '2011-06-15',
  language: 'en',
  description: 'Humanity has colonized the solar system — and the protomolecule is loose.',
  isbn10: '0316123266',
  isbn13: '9780316123265',
  goodreadsId: '8855321',
  openlibraryId: 'OL25167455W',
  seriesName: 'The Expanse',
  seriesIndex: 1,
  seriesTotal: 9,
  coverThumbPath: 'cover_thumb.jpg',
  coverFullPath: 'cover_full.jpg',
  formats: ['mobi', 'epub'],
  tags: ['space opera', 'science fiction'],
  rating: 5,
  dateAdded: ADDED,
  lastModified: TOUCHED,
  fileSizeBytes: 4731892,
  readStatus: 'reading',
  nasPath: 'books/Leviathan Wakes',
  readingState: {
    position: 'epubcfi(/6/14!/4/2/2[c01]/1:0)',
    percent: 0.42,
    updatedAt: TOUCHED
  }
}

/** The payloads the document must describe. Built by the shaper, never by hand. */
const PAYLOADS: Record<string, unknown> = {
  health: healthPayload({ version: '0.1.0', books: 7100, online: true }),
  book: bookPayload(GOLDEN),
  library: libraryPayload({ books: [GOLDEN], total: 1, limit: DEFAULT_PAGE_LIMIT, offset: 0 }),
  facets: facetsPayload({
    authors: [{ value: 'James S. A. Corey', count: 9 }],
    series: [{ value: 'The Expanse', count: 9 }],
    tags: [{ value: 'space opera', count: 412 }],
    formats: [{ value: 'epub', count: 5324 }],
    readStatus: [{ value: 'reading', count: 1 }]
  }),
  error: errorPayload('notFound')
}

const DOC = readFileSync(join(process.cwd(), 'docs', 'rest-api.md'), 'utf8')

/** Every `json payload=<name>` block in the contract document, parsed. */
function docPayloads(): Map<string, unknown> {
  const found = new Map<string, unknown>()
  for (const [, name, body] of DOC.matchAll(/```json payload=([a-z-]+)\n([\s\S]*?)\n```/g)) {
    found.set(name, JSON.parse(body))
  }
  return found
}

/** Every object key in a value, dotted — the field list, however nested. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    if (!prefix) return []
    // An empty array is still a field that is present, and a client decodes it
    // unconditionally — so the *path* is a key even when nothing is in it.
    if (!value.length) return [prefix]
    return [...new Set(value.flatMap((item) => keyPaths(item, prefix)))]
  }
  if (value === null || typeof value !== 'object') return prefix ? [prefix] : []
  return [
    ...new Set(
      Object.entries(value).flatMap(([key, inner]) =>
        keyPaths(inner, prefix ? `${prefix}.${key}` : key)
      )
    )
  ]
}

describe('the contract document and the goldens (AC19)', () => {
  it('describes every payload, and only payloads the shaper builds', () => {
    expect([...docPayloads().keys()].sort()).toEqual(Object.keys(PAYLOADS).sort())
  })

  it.each(Object.keys(PAYLOADS))('matches the document field for field: %s', (name) => {
    // Deep equality rather than a key-set comparison: the document's example is
    // the golden, so a changed type, a renamed field or a dropped value all fail
    expect(docPayloads().get(name)).toEqual(PAYLOADS[name])
  })

  it('names every route this surface matches, with the paths a client types', () => {
    for (const path of [
      '/api/health',
      '/api/library',
      '/api/library/facets',
      '/api/books/{id}',
      '/api/books/{id}/cover',
      '/api/books/{id}/file'
    ]) {
      expect(DOC).toContain(path)
    }
  })

  it('names every refusal word, every media type and the page bounds', () => {
    for (const word of Object.values(API_ERRORS)) expect(DOC).toContain(word)
    for (const type of Object.values(BOOK_CONTENT_TYPES)) expect(DOC).toContain(type)
    expect(DOC).toContain(String(DEFAULT_PAGE_LIMIT))
    expect(DOC).toContain(String(MAX_PAGE_LIMIT))
  })

  it('states the HTTP method policy instead of leaving HEAD unstated', () => {
    // 1a's health route matched GET only, so a URLSession probe — HEAD — met a
    // 404 where the connect check belongs. Whatever the policy is, the document
    // has to say it, which is what this asserts.
    expect(DOC).toMatch(/HEAD/)
    expect(DOC).toMatch(/GET-only/)
  })
})

describe('the health payload', () => {
  it('carries the contract version the client checks (D12)', () => {
    expect(API_VERSION).toBe(1)
    expect(healthPayload({ version: 'x', books: 0, online: false }).apiVersion).toBe(API_VERSION)
  })

  it('maps the share to exactly two words, and counts what it is given', () => {
    expect(healthPayload({ version: '1.2.3', books: 7100, online: true })).toEqual({
      apiVersion: 1,
      version: '1.2.3',
      books: 7100,
      library: 'online'
    })
    expect(healthPayload({ version: '1.2.3', books: 3, online: false }).library).toBe('offline')
  })
})

describe('what the wire does not carry (D10)', () => {
  const FORBIDDEN = [
    'nasPath',
    'sortTitle',
    'authorSort',
    'coverThumbPath',
    'coverFullPath',
    'position'
  ]

  const mentions = (keys: string[]): string[] =>
    keys.filter((key) => FORBIDDEN.some((name) => key === name || key.endsWith(`.${name}`)))

  it('omits the derived sort keys, the library path and the CFI', () => {
    expect(mentions(keyPaths(PAYLOADS.book))).toEqual([])
    // The document is the other half of the same claim: a field it names that
    // the shaper does not build would pass the parity case above and still be a
    // field a client would look for and never find.
    const docKeys = [...docPayloads().values()].flatMap((payload) => keyPaths(payload))
    expect(mentions(docKeys)).toEqual([])
  })

  it('reports formats in preference order, not the row order', () => {
    // invariant 3: the row's array is whatever the writing source left
    expect((PAYLOADS.book as { formats: string[] }).formats).toEqual(['epub', 'mobi'])
    expect(GOLDEN.formats).toEqual(['mobi', 'epub'])
  })

  it('carries the cover as two booleans and the row clock, not as filenames', () => {
    expect((PAYLOADS.book as { cover: unknown }).cover).toEqual({
      thumb: true,
      full: true,
      version: TOUCHED
    })

    const noCover = bookPayload({ ...makeBook('bare'), lastModified: null })
    expect(noCover.cover).toEqual({ thumb: false, full: false, version: null })
  })

  it('keeps the same field list for a book with nothing in it', () => {
    // A field present only on some books is the shape a client reads as
    // undefined and crashes on; the field list is the contract, so it is
    // identical for an empty row.
    const empty = bookPayload(makeBook('empty'))
    expect(keyPaths(empty).sort()).toEqual(keyPaths(PAYLOADS.book).sort())
    // …and the never-opened distinction survives as nulls rather than as zeros
    expect(empty.reading).toEqual({ status: 'unread', percent: null, updatedAt: null })
  })
})

describe('the read path does not touch the NAS (AC16)', () => {
  it('is evidenced by its imports: no filesystem, no nas-manager', () => {
    // D9's decision is that list, detail and search answer from SQLite and never
    // touch the share. This module is where those payloads are built, so its
    // import list is the evidence — asserted as the whole list, not as a
    // negative, because a new import is what the claim is about.
    const source = readFileSync(
      join(process.cwd(), 'electron', 'main', 'services', 'api', 'shape.ts'),
      'utf8'
    )
    const imports = source.split('\n').filter((line) => line.startsWith('import '))

    expect(imports).toEqual([
      "import type { Book, LibraryFacets, ReadStatus } from '@shared/book.types'",
      "import { orderedFormats } from '@shared/book.types'"
    ])
  })
})
