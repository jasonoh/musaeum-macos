import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Book } from '@shared/book.types'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import {
  BOOK_CONTENT_TYPES,
  bookContentType,
  parseByteRange,
  resolveBookFile,
  resolveCoverFile,
  resolveReflowFile
} from './book-bytes'
import { closeDb, deleteConfig, insertBook } from './db'
import * as nas from './nas-manager'

let root: string

beforeEach(async () => {
  closeDb()
  const userData = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(userData, f), { force: true })
  }
  root = mkdtempSync(join(tmpdir(), 'musaeum-bytes-'))
  await nas.setLibraryRoot(root)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

async function seed(id: string, fileName: string) {
  insertBook(makeBook(id))
  const dir = join(root, 'books', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, fileName), 'bytes')
  return join(dir, fileName)
}

/** The artifact a pass would have written, for a book folder. */
async function seedReflow(id: string, bytes = 'epub-bytes'): Promise<string> {
  const dir = join(root, 'books', id, 'derived')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'reflow.epub'), bytes)
  return join(dir, 'reflow.epub')
}

describe('resolveBookFile', () => {
  it('finds the file for a format', async () => {
    const path = await seed('b1', 'Leviathan Wakes.epub')
    expect(await resolveBookFile('b1', 'epub')).toBe(path)
  })

  it('matches by extension, so a renamed book still opens', async () => {
    // Files are named from the title at import; the title moves afterwards
    const path = await seed('b2', 'Some Older Title.epub')
    expect(await resolveBookFile('b2', 'epub')).toBe(path)
  })

  it('returns null when the book has no file of that format', async () => {
    await seed('b3', 'Book.epub')
    expect(await resolveBookFile('b3', 'mobi')).toBeNull()
  })

  it('rejects a format outside the union', async () => {
    await seed('b4', 'Book.epub')
    expect(await resolveBookFile('b4', 'sh')).toBeNull()
    expect(await resolveBookFile('b4', '../../etc/passwd')).toBeNull()
  })

  it('returns null for an unknown book', async () => {
    expect(await resolveBookFile('nope', 'epub')).toBeNull()
  })

  it('returns null when the book folder is missing', async () => {
    insertBook(makeBook('b5'))
    expect(await resolveBookFile('b5', 'epub')).toBeNull()
  })

  it('refuses a book whose nasPath escapes the library root', async () => {
    const book = { ...makeBook('b6'), nasPath: '../outside' }
    insertBook(book)
    expect(await resolveBookFile('b6', 'epub')).toBeNull()
  })

  it('refuses a symlinked file that points outside the library root', async () => {
    const outside = join(tmpdir(), `musaeum-bytes-outside-${Date.now()}`)
    await fs.writeFile(outside, 'secret')
    try {
      insertBook(makeBook('b7'))
      const dir = join(root, 'books', 'b7')
      await fs.mkdir(dir, { recursive: true })
      await fs.symlink(outside, join(dir, 'Book.epub'))
      expect(await resolveBookFile('b7', 'epub')).toBeNull()
    } finally {
      await fs.rm(outside, { force: true })
    }
  })

  it('resolves normally when the library root itself is reached through a symlink', async () => {
    const target = mkdtempSync(join(tmpdir(), 'musaeum-bytes-target-'))
    const link = join(tmpdir(), `musaeum-bytes-link-${Date.now()}`)
    await fs.symlink(target, link)
    await nas.setLibraryRoot(link)
    try {
      insertBook(makeBook('b8'))
      const dir = join(link, 'books', 'b8')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(join(dir, 'Book.epub'), 'bytes')
      expect(await resolveBookFile('b8', 'epub')).toBe(join(dir, 'Book.epub'))
    } finally {
      await fs.rm(link, { force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Covers — the extraction from the `musaeum://cover` handler (AC11, AC13, AC14)
// ---------------------------------------------------------------------------

/**
 * A book row whose folder holds the covers it claims.
 *
 * The paths are the handler's own shape — a bare filename relative to the book's
 * folder — because that is what the app writes; a row that holds something else
 * is a row another machine wrote, which is the case the traversal rules are for.
 */
async function seedCover(
  id: string,
  covers: { thumb?: boolean; full?: boolean } = { thumb: true, full: true },
  overrides: Partial<Book> = {}
): Promise<{ dir: string; thumb: string; full: string }> {
  insertBook({
    ...makeBook(id),
    coverThumbPath: covers.thumb ? 'cover_thumb.jpg' : null,
    coverFullPath: covers.full ? 'cover_full.jpg' : null,
    ...overrides
  })

  const dir = join(root, 'books', id)
  await fs.mkdir(dir, { recursive: true })
  const thumb = join(dir, 'cover_thumb.jpg')
  const full = join(dir, 'cover_full.jpg')
  if (covers.thumb) await fs.writeFile(thumb, `thumb of ${id}`)
  if (covers.full) await fs.writeFile(full, `full cover of ${id}`)
  return { dir, thumb, full }
}

describe('resolveCoverFile', () => {
  it('answers the path the protocol handler resolved: the book folder, for that size', async () => {
    const { thumb, full } = await seedCover('c1')
    expect(await resolveCoverFile('c1', 'thumb')).toEqual({ ok: true, path: thumb })
    expect(await resolveCoverFile('c1', 'full')).toEqual({ ok: true, path: full })
  })

  it('serves the full cover for any size that is not `thumb` — the handler\u2019s own branch (AC13)', async () => {
    // `musaeum://cover/{id}/banana` has always answered an image; the extraction
    // preserves that rather than "fixing" what the renderer's fixed strings ask
    // for. The HTTP route is the stricter caller and validates before it calls.
    const { full } = await seedCover('c2')
    expect(await resolveCoverFile('c2', 'banana')).toEqual({ ok: true, path: full })
    expect(await resolveCoverFile('c2', 'Thumb')).toEqual({ ok: true, path: full })
    expect(await resolveCoverFile('c2', '')).toEqual({ ok: true, path: full })
  })

  it('answers 404 for an unknown book, and for a book with no cover of that size', async () => {
    await seedCover('c3', { thumb: true, full: false })
    expect(await resolveCoverFile('nope', 'thumb')).toEqual({ ok: false, status: 404 })
    expect(await resolveCoverFile('c3', 'full')).toEqual({ ok: false, status: 404 })
  })

  it('answers 404 when the cover file is gone, and when there is no library root', async () => {
    const { thumb } = await seedCover('c4')
    await fs.rm(thumb)
    expect(await resolveCoverFile('c4', 'thumb')).toEqual({ ok: false, status: 404 })

    deleteConfig('library_root')
    expect(await resolveCoverFile('c4', 'full')).toEqual({ ok: false, status: 404 })
  })

  it('answers 404 for a book with no folder at all', async () => {
    insertBook({ ...makeBook('c5'), coverThumbPath: 'cover_thumb.jpg' })
    expect(await resolveCoverFile('c5', 'thumb')).toEqual({ ok: false, status: 404 })
  })

  it.each([['../secret.jpg'], ['sub/cover.jpg'], ['..'], ['/etc/passwd']])(
    'answers 400 for a traversing cover path (%s)',
    async (path) => {
      await seedCover('c6', { thumb: true, full: true }, { coverThumbPath: path })
      expect(await resolveCoverFile('c6', 'thumb')).toEqual({ ok: false, status: 400 })
    }
  )

  it('answers 400 for a book whose folder escapes the library root', async () => {
    // The handler joined root + nasPath + file with no check on nasPath at all,
    // and nasPath comes from a catalog any machine can write — invariant 9's
    // containment rule is what closes that, shared with `resolveBookFile`.
    await seedCover('c7', { thumb: true }, { nasPath: '../outside' })
    expect(await resolveCoverFile('c7', 'thumb')).toEqual({ ok: false, status: 400 })

    // A row that resolves back to the library root itself is the same class: the
    // folder it names is not "under" the root, and `resolveBookFile` refuses the
    // identical shape (an *empty* nasPath never gets this far — it is falsy, and
    // answers 404 above).
    await seedCover('c8', { thumb: true }, { nasPath: '.' })
    expect(await resolveCoverFile('c8', 'thumb')).toEqual({ ok: false, status: 400 })
  })

  it('answers 400 for a cover symlinked outside the library root', async () => {
    const outside = join(tmpdir(), `musaeum-cover-outside-${Date.now()}`)
    await fs.writeFile(outside, 'secret')
    try {
      // The row claims its fixed name — which is what makes the lexical check
      // pass — and the file behind it points out of the library
      const { dir } = await seedCover('c9', { thumb: true, full: false })
      const claimed = join(dir, 'cover_thumb.jpg')
      await fs.rm(claimed)
      await fs.symlink(outside, claimed)
      expect(await resolveCoverFile('c9', 'thumb')).toEqual({ ok: false, status: 400 })
    } finally {
      await fs.rm(outside, { force: true })
    }
  })

  it('resolves a cover when the library root itself is reached through a symlink', async () => {
    const target = mkdtempSync(join(tmpdir(), 'musaeum-cover-target-'))
    const link = join(tmpdir(), `musaeum-cover-link-${Date.now()}`)
    await fs.symlink(target, link)
    await nas.setLibraryRoot(link)
    try {
      insertBook({
        ...makeBook('c10'),
        coverThumbPath: 'cover_thumb.jpg'
      })
      const dir = join(link, 'books', 'c10')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(join(dir, 'cover_thumb.jpg'), 'bytes')
      expect(await resolveCoverFile('c10', 'thumb')).toEqual({
        ok: true,
        path: join(dir, 'cover_thumb.jpg')
      })
    } finally {
      await fs.rm(link, { force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('is what the `musaeum://cover` handler calls, so the rules are not re-inlined (AC13)', () => {
    // Everything above decides the *resolver*. This decides that the handler uses it: the
    // pre-extraction body read the two cover columns and joined them itself, and if it ever
    // does that again the security boundary is back in two places — with every case above
    // still passing. `index.ts` may keep using `join` for its own paths (the dock icon, the
    // preload script, the renderer); what it must not do again is resolve a cover.
    const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8')
    expect(src).toMatch(/resolveCoverFile\(/)
    expect(src).not.toMatch(/coverThumbPath|coverFullPath/)
  })
})

// ---------------------------------------------------------------------------
// Ranges — the grammar a resumable download is allowed to use (D15, AC15a)
// ---------------------------------------------------------------------------

describe('parseByteRange', () => {
  it('is the whole file when there is no Range header', () => {
    expect(parseByteRange(undefined, 100)).toEqual({ kind: 'full' })
    expect(parseByteRange(null, 100)).toEqual({ kind: 'full' })
    expect(parseByteRange('', 100)).toEqual({ kind: 'full' })
  })

  it('reads an open-ended range as the tail from its start', () => {
    // The one request a resuming client sends. A server that ignored it and
    // re-sent the head would answer 206-shaped bytes, which is why AC15a hashes
    // the *tail* rather than the header.
    expect(parseByteRange('bytes=40-', 100)).toEqual({ kind: 'partial', start: 40, end: 99 })
    expect(parseByteRange('bytes=0-', 100)).toEqual({ kind: 'partial', start: 0, end: 99 })
  })

  it('reads a closed range, and clamps an end past the file', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ kind: 'partial', start: 10, end: 19 })
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ kind: 'partial', start: 90, end: 99 })
    expect(parseByteRange('bytes=99-99', 100)).toEqual({ kind: 'partial', start: 99, end: 99 })
  })

  it('tolerates the whitespace a header may carry', () => {
    expect(parseByteRange(' bytes=10- ', 100)).toEqual({ kind: 'partial', start: 10, end: 99 })
  })

  it.each([['bytes=100-'], ['bytes=101-'], ['bytes=100-200'], ['bytes=5-4']])(
    'is unsatisfiable when the range starts past the end (%s)',
    (header) => {
      expect(parseByteRange(header, 100)).toEqual({ kind: 'unsatisfiable' })
    }
  )

  it.each([
    ['bytes=-500'],
    ['bytes=0-1,5-6'],
    ['items=0-5'],
    ['bytes=abc'],
    ['bytes='],
    ['bytes=--'],
    ['0-5'],
    ['bytes=1.5-']
  ])('refuses a malformed range rather than ignoring it (%s)', (header) => {
    // Deliberately stricter than HTTP's latitude: an ignored Range here means
    // up to 528 MB re-sent to a client that asked for a tail.
    expect(parseByteRange(header, 100)).toEqual({ kind: 'unsatisfiable' })
  })

  it('is unsatisfiable for any range against an empty file, and full without one', () => {
    expect(parseByteRange(undefined, 0)).toEqual({ kind: 'full' })
    expect(parseByteRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
  })
})

describe('bookContentType', () => {
  it('names a media type for every format the app serves', () => {
    expect(bookContentType('epub')).toBe('application/epub+zip')
    expect(bookContentType('mobi')).toBe('application/x-mobipocket-ebook')
    expect(bookContentType('azw3')).toBe('application/vnd.amazon.ebook')
    expect(bookContentType('pdf')).toBe('application/pdf')
  })

  it('answers octet-stream for anything else, which the route never reaches', () => {
    // `resolveBookFile` decides the format union first and answers 404, so this
    // is a total function's fallback rather than a case a client can hit
    expect(Object.keys(BOOK_CONTENT_TYPES)).toHaveLength(4)
    expect(bookContentType('sh')).toBe('application/octet-stream')
  })
})

describe('resolveReflowFile', () => {
  it('serves the artifact from the book’s own derived folder', async () => {
    insertBook(makeBook('r1'))
    const path = await seedReflow('r1')
    expect(await resolveReflowFile('r1')).toBe(path)
  })

  it('answers null when there is no artifact', async () => {
    insertBook(makeBook('r2'))
    await fs.mkdir(join(root, 'books', 'r2'), { recursive: true })
    expect(await resolveReflowFile('r2')).toBeNull()
  })

  it('answers null for a book the library does not hold', async () => {
    expect(await resolveReflowFile('nobody')).toBeNull()
  })

  /**
   * `book-bytes` is the security boundary between a renderer URL and the
   * filesystem, and the reflow's route is a second *path shape* through it
   * rather than a second implementation of it — which is the whole reason the
   * containment rule moved into `contained` instead of being copied.
   */
  it('refuses a folder that escapes the library root', async () => {
    insertBook({ ...makeBook('r3'), nasPath: '../outside' })
    expect(await resolveReflowFile('r3')).toBeNull()
  })

  it('refuses a derived folder that is a symlink out of the library root', async () => {
    insertBook(makeBook('r4'))
    const outside = join(root, '..', 'outside-derived')
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(join(outside, 'reflow.epub'), 'x')
    await fs.mkdir(join(root, 'books', 'r4'), { recursive: true })
    await fs.symlink(outside, join(root, 'books', 'r4', 'derived'))
    expect(await resolveReflowFile('r4')).toBeNull()
  })

  /**
   * **The wire stays closed (D8).** `GET /api/books/{id}/file` hands its
   * `format` straight to `resolveBookFile`, so an arm there would serve the
   * artifact to the phone in the same commit that no document describes. This
   * case is what fails the day someone folds the two resolvers together without
   * landing slice 4 — and the content-type half is why `'reflow'` must not be
   * added to the format union either.
   */
  it('is not reachable through resolveBookFile, even with the artifact present', async () => {
    insertBook(makeBook('r5'))
    await seedReflow('r5')
    expect(await resolveBookFile('r5', 'reflow')).toBeNull()
    expect(bookContentType('reflow')).toBe('application/octet-stream')
  })
})
