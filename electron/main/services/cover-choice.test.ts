import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app, type OpenDialogOptions, type OpenDialogReturnValue } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverCandidate, CoverChoice } from '@shared/metadata.types'
import { makeBook } from '../../../test/helpers/book'
import { chooseCoverFromFile, type ShowImageDialog } from '../ipc/metadata'
import { writeCatalog } from './catalog'
import { chooseCover, chooseUploadedCover, coverCandidates, searchCovers } from './cover-choice'
import { closeDb, getBook, insertBook, updateBook } from './db'
import { list } from './field-overrides'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import * as sidecar from './sidecar'

/**
 * The main process's half of choosing a cover: the boundary's refusals, the five
 * things a choice writes, and the two gestures that write them.
 *
 * The sidecar is stubbed, as it is in `conflicts.test.ts` — an unmocked
 * `assertAvailable` *starts* a live Python process, and this file is about what
 * the main process does with an answer, not about producing one. What that
 * leaves genuinely undecidable here is said out loud where it matters: the
 * *bytes* a choice writes are `write_choice`'s and `set_cover_from_file`'s,
 * decided in `sidecar/tests/test_cover_candidates.py` and
 * `sidecar/tests/test_cover_upload.py`, and the thumb on a candidate is the
 * sidecar's too. This file decides the wiring, the refusals, the row, the
 * canonical file and the lock.
 *
 * It also carries the upload *dialog*'s two cases (`chooseCoverFromFile`), for
 * `ipc/nas.test.ts`'s reason: that flow's decisions are a cancellation and a
 * one-way path, and the dialog is injected so they can be decided at all — this
 * repo has never driven an `ipcMain` handler.
 */
vi.mock('./sidecar', () => ({ call: vi.fn(), assertAvailable: vi.fn() }))

let root: string
let upsert: ReturnType<typeof vi.spyOn>

/** A book on disk with one epub and a metadata.json, as `conflicts.test.ts` seeds. */
async function seed(id: string): Promise<string> {
  insertBook(makeBook(id))
  const dir = join(root, `books/${id}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, `Book ${id}.epub`), 'x')
  await fs.writeFile(join(dir, 'metadata.json'), JSON.stringify({ id }))
  return dir
}

/** What the sidecar says when it wrote the two fixed filenames. */
const WROTE = { full: 'cover_full.jpg', thumb: 'cover_thumb.jpg' }

/**
 * Every `thumb` leaf in a payload, wherever it sits.
 *
 * The criterion is about the *values* that travel, not about a field on an
 * object somebody remembered to check: a component rendering a remote `src`
 * satisfies every rendered-state assertion while the CSP blocks the image, so
 * the walk recurses through arrays and objects rather than spot-checking.
 */
function thumbsOf(value: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'thumb' && typeof child === 'string') found.push(child)
        else walk(child)
      }
    }
  }
  walk(value)
  return found
}

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  librarySync.resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-cover-choice-'))
  await nas.setLibraryRoot(root)
  await writeCatalog(root, [])
  upsert = vi.spyOn(librarySync, 'upsertCatalog')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await librarySync.flushForTests()
  rmSync(root, { recursive: true, force: true })
})

describe('coverCandidates', () => {
  it('gathers through the sidecar, on the row’s own identifiers', async () => {
    // The picker offers the jackets a *fetch of this row* would weigh (D1), and
    // that only holds while both search on the same inputs — a file that is
    // silent about its own ISBN is the common case, not the exotic one
    await seed('a')
    updateBook('a', { isbn13: '9780374715236', author: 'Melanie Mitchell' })
    vi.mocked(sidecar.call).mockResolvedValue([])

    await coverCandidates('a')

    expect(sidecar.call).toHaveBeenCalledWith('cover_candidates', {
      book_id: 'a',
      file_path: join(root, 'books/a/Book a.epub'),
      book_dir: join(root, 'books/a'),
      known: {
        title: 'Book a',
        author: 'Melanie Mitchell',
        identifiers: { isbn_13: '9780374715236' }
      }
    })
  })

  it('hands the candidate array back untouched, with a data url in every thumb', async () => {
    await seed('a')
    const candidates: CoverCandidate[] = [
      {
        source: 'embedded',
        width: 1290,
        height: 1950,
        score: 0.832,
        winner: true,
        applied: true,
        thumb: 'data:image/jpeg;base64,AAAA'
      },
      {
        source: 'openlibrary',
        url: 'https://covers.openlibrary.org/b/id/1-L.jpg',
        width: 307,
        height: 500,
        score: 0.53,
        winner: false,
        applied: false,
        thumb: 'data:image/jpeg;base64,BBBB'
      }
    ]
    vi.mocked(sidecar.call).mockResolvedValue(candidates)

    const returned = await coverCandidates('a')

    // Untouched, so the renderer sees exactly what the sidecar produced: a
    // rewrite here would be a second opinion about a candidate
    expect(returned).toEqual(candidates)
    // AC15, over the payload's leaves rather than over one array of one field
    const thumbs = thumbsOf(returned)
    expect(thumbs).toHaveLength(2)
    expect(thumbs.every((t) => t.startsWith('data:image/jpeg;base64,'))).toBe(true)
  })

  it('says why it cannot gather rather than answering with an empty list', async () => {
    // A PDF-only book has no embedded jacket to offer and no identifiers to
    // search on. The picker's job is to name that, never to show a grid with
    // nothing in it (AC16) — and the format list is `findHydratableFile`'s, so
    // this cannot disagree with what a metadata refresh would read
    insertBook(makeBook('a'))
    const dir = join(root, 'books/a')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'Deep Work.pdf'), 'x')

    await expect(coverCandidates('a')).rejects.toThrow(/No EPUB, MOBI or AZW3/)
    expect(sidecar.call).not.toHaveBeenCalled()
  })

  it('refuses before it starts anything when there is no library', async () => {
    await seed('a')
    // The safest way to drive "not reachable": an unconfigured root needs no
    // share and no reconnect timer (a *disconnected* root schedules a real
    // `open -g` against the SMB url, which no test should do)
    await nas.setLibraryRoot('')

    await expect(coverCandidates('a')).rejects.toThrow(/No library folder is configured/)
    expect(sidecar.call).not.toHaveBeenCalled()
  })

  it('refuses a book that is not in the cache', async () => {
    await expect(coverCandidates('nope')).rejects.toThrow(/Book not found/)
    expect(sidecar.call).not.toHaveBeenCalled()
  })
})

describe('searchCovers', () => {
  it('asks the wider question through the sidecar, on the row’s own identifiers', async () => {
    // The searched group is reached on exactly the inputs the gather uses — the
    // row's file and its own title/author/identifiers — because a hit it finds
    // has to be a pair `setCover` can take. What differs is the *question*, never
    // the plumbing: a search that read the file for its identifiers, or searched
    // on a different title, would offer tiles a pick cannot use.
    await seed('a')
    updateBook('a', { isbn13: '9780262345064', author: 'Byung-Chul Han' })
    vi.mocked(sidecar.call).mockResolvedValue([])

    await searchCovers('a')

    expect(sidecar.call).toHaveBeenCalledWith('search_covers', {
      book_id: 'a',
      file_path: join(root, 'books/a/Book a.epub'),
      book_dir: join(root, 'books/a'),
      known: {
        title: 'Book a',
        author: 'Byung-Chul Han',
        identifiers: { isbn_13: '9780262345064' }
      }
    })
  })

  it('hands the searched array back untouched, with no entry claiming a winner', async () => {
    // D3's `winner: false` is forced *in the sidecar*, and this is the main
    // process's half of that arrangement: it is a pass-through, so a rewrite here
    // would be a second opinion about a candidate — and the winner mark would
    // then be computed in two places that can disagree.
    await seed('a')
    const candidates: CoverCandidate[] = [
      {
        source: 'google_books',
        url: 'https://books.google.com/books/content?id=9eRVDwAAQBAJ&zoom=0',
        width: 1352,
        height: 2103,
        score: 0.9722,
        winner: false,
        applied: false,
        thumb: 'data:image/jpeg;base64,AAAA'
      }
    ]
    vi.mocked(sidecar.call).mockResolvedValue(candidates)

    const returned = await searchCovers('a')

    expect(returned).toEqual(candidates)
    expect(thumbsOf(returned).every((t) => t.startsWith('data:image/jpeg;base64,'))).toBe(true)
  })

  it('says why it cannot search rather than answering with an empty group', async () => {
    // The gather's three pre-flight refusals, unchanged — the picker has to say
    // *why*, and an empty searched group would be indistinguishable from a search
    // that ran and found nothing.
    insertBook(makeBook('a'))
    const dir = join(root, 'books/a')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'Deep Work.pdf'), 'x')

    await expect(searchCovers('a')).rejects.toThrow(/No EPUB, MOBI or AZW3/)
    expect(sidecar.call).not.toHaveBeenCalled()
  })
})

describe('chooseCover', () => {
  /**
   * A refusal is a value the user reads: no engine started, no row touched and
   * nothing recorded. The last two are the half that a "it was refused" test
   * usually forgets — a refusal that silently locked the field would take the
   * decision away from a person who never made one.
   */
  async function expectRefused(choice: CoverChoice, pattern: RegExp): Promise<void> {
    const before = getBook('a')

    await expect(chooseCover('a', choice)).rejects.toThrow(pattern)

    expect(sidecar.call).not.toHaveBeenCalled()
    expect(getBook('a')).toEqual(before)
    expect(list('a')).toEqual([])
  }

  it('refuses a source the scoring step never scores', async () => {
    await seed('a')

    await expectRefused({ source: 'calibre' }, /not a source this app can take a cover from/)
  })

  it('refuses an online source that arrives without its url', async () => {
    // The renderer echoes back a pair the gather produced; it may not name a URL
    // of its own, and it may not ask for a fetch it cannot describe
    await seed('a')

    await expectRefused({ source: 'google_books' }, /needs the url the candidates came with/)
  })

  it('refuses the file’s own cover when it arrives with a url', async () => {
    await seed('a')

    await expectRefused(
      { source: 'embedded', url: 'https://example.test/x.jpg' },
      /re-extracted from the file/
    )
  })

  it('writes the row, the canonical file and the catalog, and returns the updated book', async () => {
    const dir = await seed('a')
    vi.mocked(sidecar.call).mockResolvedValue(WROTE)

    const returned = await chooseCover('a', {
      source: 'google_books',
      url: 'https://books.google.com/books/content?id=X&zoom=0'
    })

    expect(sidecar.call).toHaveBeenCalledWith('set_cover', {
      book_id: 'a',
      file_path: join(dir, 'Book a.epub'),
      book_dir: dir,
      source: 'google_books',
      url: 'https://books.google.com/books/content?id=X&zoom=0'
    })
    expect(returned).toEqual(getBook('a'))
    expect(returned.coverFullPath).toBe('cover_full.jpg')
    expect(returned.coverThumbPath).toBe('cover_thumb.jpg')
    // The canonical record names the same two fixed filenames...
    const written = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')) as {
      cover: { full: string; thumb: string }
    }
    expect(written.cover).toEqual(WROTE)
    // ...and the derived catalog is written after it, never instead of it
    expect(upsert).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'a', coverFullPath: 'cover_full.jpg' })
    ])
    // D4: the choice is a user decision, so the next fetch must not move it
    expect(list('a')).toEqual(['cover'])
  })

  it('records the choice even when the jacket chosen is the one already applied', async () => {
    // AC9a. `before = null` at the marking is deliberate: the diff guard exists
    // to stop a *form* locking every field it sends, and this gesture *is* the
    // decision. Handing the service the pre-write row instead would leave a
    // person who confirmed rather than changed their mind with no lock at all.
    //
    // The byte half of this criterion ("changes no bytes") is not decidable
    // here — the sidecar is stubbed, so the stub is what would or would not
    // write — and it lives in `sidecar/tests/test_cover_candidates.py`, where
    // the writer compares what it is about to write against what is on disk and
    // reports `changed: false`.
    await seed('a')
    updateBook('a', { coverFullPath: 'cover_full.jpg', coverThumbPath: 'cover_thumb.jpg' })
    vi.mocked(sidecar.call).mockResolvedValue(WROTE)
    const before = getBook('a')

    const returned = await chooseCover('a', { source: 'embedded' })

    expect(returned.coverFullPath).toBe(before?.coverFullPath)
    expect(returned.coverThumbPath).toBe(before?.coverThumbPath)
    expect(list('a')).toEqual(['cover'])
  })

  it('needs the book’s own file even when the choice is an online one', async () => {
    // A recorded reading, not an accident: both entry points resolve the same
    // file, because the picker's candidates came from a file-backed gather. A
    // book with no EPUB/MOBI/AZW3 cannot be gathered for at all, so its only
    // cover route stays the conflict queue's `fetch_cover` — which needs no file.
    insertBook(makeBook('a'))
    await fs.mkdir(join(root, 'books/a'), { recursive: true })

    await expect(
      chooseCover('a', {
        source: 'openlibrary',
        url: 'https://covers.openlibrary.org/b/id/1-L.jpg'
      })
    ).rejects.toThrow(/No EPUB, MOBI or AZW3/)
    expect(sidecar.call).not.toHaveBeenCalled()
  })
})

/**
 * D6 — the third gesture: an image from this machine.
 *
 * The same five writes as a pick, and that is the assertion rather than the
 * setup for one: D6 says an uploaded cover is held *exactly* as a picked one is,
 * so the row, `metadata.json`, the catalog and the lock are checked for this
 * gesture too. What differs is the pre-flight, and one difference is the feature
 * — a book with no EPUB can still be dressed (D6-e).
 */
describe('chooseUploadedCover', () => {
  it('writes the two fixed filenames and settles the row, the file and the catalog', async () => {
    const dir = await seed('a')
    vi.mocked(sidecar.call).mockResolvedValue(WROTE)

    const returned = await chooseUploadedCover('a', join(root, 'my jacket.png'))

    expect(returned).toEqual(getBook('a'))
    expect(returned.coverFullPath).toBe('cover_full.jpg')
    expect(returned.coverThumbPath).toBe('cover_thumb.jpg')
    // The canonical record names the same two fixed filenames...
    const written = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')) as {
      cover: { full: string; thumb: string }
    }
    expect(written.cover).toEqual(WROTE)
    // ...and the derived catalog is written after it, never instead of it
    expect(upsert).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'a', coverFullPath: 'cover_full.jpg' })
    ])
    // D4/D6-c: the upload is the user's decision, so the next fetch must not
    // move it — the lock is the half that makes "held like a pick" true
    expect(list('a')).toEqual(['cover'])
  })

  it('sends the folder and the chosen path, and nothing a pick would send', async () => {
    const dir = await seed('a')
    vi.mocked(sidecar.call).mockResolvedValue(WROTE)
    const chosen = join(root, 'my jacket.png')

    await chooseUploadedCover('a', chosen)

    // Exact object equality, so "no `source`, no `file_path`, no `url`" is
    // asserted rather than assumed: an upload is a write, not a candidate the
    // gather could have produced, so there is no source vocabulary to extend and
    // no file to read (D6-b)
    expect(sidecar.call).toHaveBeenCalledWith('set_cover_from_file', {
      book_dir: dir,
      image_path: chosen
    })
  })

  it('dresses a book with no EPUB at all (D6-e)', async () => {
    // The one place the upload is *better* than the other two sources. A
    // PDF-only book cannot be gathered for, so `chooseCover` refuses it with
    // "No EPUB, MOBI or AZW3" — asserted above — and the conflict queue's
    // `fetch_cover` can only write a candidate it already offered. The upload
    // asks the folder for nothing, so it does not share that pre-flight.
    insertBook(makeBook('a'))
    const dir = join(root, 'books/a')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'Deep Work.pdf'), 'x')
    vi.mocked(sidecar.call).mockResolvedValue(WROTE)

    const returned = await chooseUploadedCover('a', join(root, 'jacket.png'))

    expect(sidecar.call).toHaveBeenCalledWith('set_cover_from_file', {
      book_dir: dir,
      image_path: join(root, 'jacket.png')
    })
    expect(returned.coverFullPath).toBe('cover_full.jpg')
    expect(list('a')).toEqual(['cover'])
  })

  it('writes nothing at all when the sidecar refuses the file', async () => {
    const dir = await seed('a')
    vi.mocked(sidecar.call).mockRejectedValue(
      new Error('That file is not an image Musaeum can read')
    )
    const before = getBook('a')
    const metadata = await fs.readFile(join(dir, 'metadata.json'), 'utf8')

    await expect(chooseUploadedCover('a', join(root, 'notes.txt'))).rejects.toThrow(/not an image/)

    // A refusal is a sentence *and* a no-op (AC12): no row moved, no lock
    // recorded, no canonical file rewritten, no catalog write. A refusal that
    // locked the field anyway would take the decision away from a person who
    // never got a cover.
    expect(getBook('a')).toEqual(before)
    expect(list('a')).toEqual([])
    expect(upsert).not.toHaveBeenCalled()
    expect(await fs.readFile(join(dir, 'metadata.json'), 'utf8')).toBe(metadata)
  })

  it('refuses before it starts anything when there is no library', async () => {
    await seed('a')
    // An unconfigured root, as `coverCandidates` uses: it needs no share and no
    // reconnect timer (a *disconnected* root schedules a real `open -g`)
    await nas.setLibraryRoot('')

    await expect(chooseUploadedCover('a', join(root, 'jacket.png'))).rejects.toThrow(
      /No library folder is configured/
    )
    expect(sidecar.call).not.toHaveBeenCalled()
  })
})

/**
 * D6-c — the marking tail has one home, checked in the source rather than called.
 *
 * A runtime case cannot see this: with the sidecar stubbed, a second copy of the
 * tail inside the upload's own body satisfies every assertion above. What this
 * walk can see is the thing the criterion is *for* — an upload that forgot
 * `markFromPatch` would write a cover the next fetch could silently move, and
 * nothing else in either suite would notice.
 */
describe('D6-c — both gestures settle a cover through one tail', () => {
  const COVER_CHOICE = 'electron/main/services/cover-choice.ts'
  const source = readFileSync(join(process.cwd(), COVER_CHOICE), 'utf8')

  /** One top-level function's source, from its signature to its closing brace. */
  function body(name: string): string {
    const start = source.indexOf(`function ${name}(`)
    if (start === -1) throw new Error(`no ${name} in ${COVER_CHOICE}`)
    return source.slice(start, source.indexOf('\n}', start))
  }

  it('calls the shared tail from both gestures rather than copying it', () => {
    for (const gesture of ['chooseCover', 'chooseUploadedCover']) {
      expect(body(gesture)).toContain('settleChoice(')
      expect(body(gesture)).not.toContain('markFromPatch(')
    }
    // ...and the rule itself is written once, in the function they both call
    expect(body('settleChoice')).toContain('fieldOverrides.markFromPatch(')
    expect(source.match(/fieldOverrides\.markFromPatch\(/g)).toHaveLength(1)
    expect(source.match(/librarySync\.upsertCatalog\(/g)).toHaveLength(1)
    expect(source.match(/importer\.writeMetadataJson\(/g)).toHaveLength(1)
  })
})

/**
 * D6-a — the dialog is the main process's, and the path travels one way.
 *
 * `ipc/nas.test.ts`'s arrangement, on this flow: the dialog is injected, because
 * no case in this repo has ever driven an `ipcMain` handler and
 * `test/mocks/electron.ts` keeps `dialog` and `ipcMain` inert on purpose. What
 * the seam decides is what the flow is about — that a cancellation is reported as
 * a cancellation and writes nothing, and that the absolute path reaches the
 * sidecar without becoming a value the renderer could name. What it does **not**
 * decide is the two lines `registerMetadataHandlers` contributes (that the
 * channel is registered and the bookId forwarded); those are the running-app
 * probe's, and they are named here so the limit is recorded rather than implied.
 */
describe('chooseCoverFromFile (the upload dialog)', () => {
  /** A dialog that answers with `chosen`, or with a cancellation when given null. */
  function stubDialog(chosen: string | null): {
    show: ShowImageDialog
    asked: OpenDialogOptions[]
  } {
    const asked: OpenDialogOptions[] = []
    const show: ShowImageDialog = vi.fn(async (options: OpenDialogOptions) => {
      asked.push(options)
      return chosen === null
        ? ({ canceled: true, filePaths: [] } as OpenDialogReturnValue)
        : ({ canceled: false, filePaths: [chosen] } as OpenDialogReturnValue)
    })
    return { show, asked }
  }

  it('reports a cancellation and writes nothing when the dialog is cancelled', async () => {
    await seed('a')
    const { show, asked } = stubDialog(null)
    const before = getBook('a')

    expect(await chooseCoverFromFile('a', show)).toEqual({ cancelled: true })

    expect(asked).toHaveLength(1)
    // One file, and only files: this dialog picks a jacket, not a folder and not
    // a batch
    expect(asked[0].properties).toEqual(['openFile'])
    // Nothing reached the engine, and the book is untouched: a cancellation is an
    // answer, not a failure and not a write
    expect(sidecar.call).not.toHaveBeenCalled()
    expect(getBook('a')).toEqual(before)
    expect(list('a')).toEqual([])
  })

  it('hands the chosen path inward, and returns an outcome that cannot name it', async () => {
    await seed('a')
    const chosen = join(root, 'my jacket.png')
    const { show } = stubDialog(chosen)
    vi.mocked(sidecar.call).mockResolvedValue(WROTE)

    const outcome = await chooseCoverFromFile('a', show)

    expect(outcome).toEqual(getBook('a'))
    // The path travelled one way only (D6-a): the sidecar was given it, and
    // nothing the renderer receives mentions it
    expect(sidecar.call).toHaveBeenCalledWith('set_cover_from_file', {
      book_dir: join(root, 'books/a'),
      image_path: chosen
    })
    expect(JSON.stringify(outcome)).not.toContain('my jacket')
  })
})

/**
 * AC5 — the search and the gather send one triple, walked in the source.
 *
 * A walk rather than a call, because the two must not *drift* and a runtime case
 * cannot see that: the sidecar is mocked here, so calling both functions would
 * only compare one mock's arguments against another's — a search that assembled
 * its own `known` a line differently would still pass. The walk compares the two
 * call sites as they are written.
 *
 * `\s*` and `[\s\S]*?` rather than literal whitespace, and the reason is the one
 * the picker's own walk records: prettier wraps these calls across lines, and a
 * pattern that assumed one line found two of four call sites (measured) — a walk
 * that fails open. What this cannot prove is that either request *succeeds*;
 * that is the sidecar's dispatch table and the running-app probe.
 *
 * It is also the case that keeps the two payloads one shape rather than two
 * dialects: the gather's own runtime case above pins its keys, so a search that
 * sent `file_path`/`book_dir`/`known` plus something else of its own would fail
 * here rather than at the point a pick is refused.
 */
describe('AC5 — searchCovers sends the same triple coverCandidates sends', () => {
  const COVER_CHOICE = 'electron/main/services/cover-choice.ts'

  /** The object literal a `sidecar.call` in the file is handed, as source. */
  function payload(method: string): string {
    const body = readFileSync(join(process.cwd(), COVER_CHOICE), 'utf8').match(
      new RegExp(`sidecar\\.call<[^>]+>\\(\\s*'${method}'\\s*,\\s*\\{([\\s\\S]*?)\\}\\s*\\)`)
    )
    if (!body) throw new Error(`no sidecar.call for ${method} in ${COVER_CHOICE}`)
    return body[1]
  }

  /** The keys a payload object sends, in source order. */
  const keys = (body: string): string[] => [...body.matchAll(/(\w+)\s*:/g)].map((match) => match[1])

  /** The three lines that carry the triple, trimmed to survive prettier. */
  const triple = (body: string): string[] =>
    body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) =>
        ['file_path', 'book_dir', 'known'].some((key) => line.startsWith(`${key}:`))
      )

  it('carries file_path, book_dir and known — the same values, spelled the same way', () => {
    expect(triple(payload('cover_candidates'))).toEqual([
      'file_path: file,',
      'book_dir: bookDir,',
      'known: importer.knownFrom(book)'
    ])
    expect(triple(payload('search_covers'))).toEqual(triple(payload('cover_candidates')))
  })

  it('is the gather’s payload shape, so a searched hit is a pair a pick can take', () => {
    expect(keys(payload('search_covers'))).toEqual(
      expect.arrayContaining(['file_path', 'book_dir', 'known'])
    )
    expect(keys(payload('search_covers'))).toEqual(keys(payload('cover_candidates')))
  })
})
