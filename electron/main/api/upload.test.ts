import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { API_ERRORS } from '../services/api/shape'
import * as db from '../services/db'
import * as nas from '../services/nas-manager'
import { DEFAULT_REST_API_PORT, type ResolvedRestApiConfig } from '../services/settings'
import { createRestApiServer, type ServerOptions } from './rest'

/**
 * `POST /api/books` — the upload route, driven over a **real socket on an
 * ephemeral port** (slice 2, AC8–AC12 and the readings it settles: S5's
 * mid-flight refusal, S6's method policy and S7's shape).
 *
 * The instrument is the one the 401 and byte-route criteria already use, and for
 * these it is the only one that can decide them: a status line, a
 * `WWW-Authenticate`, a `Retry-After`, and — for S5 — whether a client that is
 * *still writing its body* ever reads the refusal. A socketless case cannot say
 * any of that, which is why slice 1 stopped where it did.
 *
 * What is **not** here, deliberately: the parameters' rules, the cap and the
 * stall clock, the scratch lifecycle and the import's duplicate policy. All four
 * are decided in `services/api/upload.test.ts` and `importer.test.ts` without a
 * port, and a second, weaker decider for them would be worse than none. What
 * lives here is the mapping from that module's refusals to HTTP, and the payload
 * a client actually receives.
 *
 * Hermetic by construction: `electron` is aliased to the suite's own mock (a
 * throwaway `userData` per worker, so the database is a scratch one), the
 * library root and the scratch directory are temp directories this file makes
 * and removes, the sidecar is stubbed so no Python starts, and **every socket
 * opened here is closed by the case that opened it**.
 */

// ---------------------------------------------------------------------------
// The fixture: a real EPUB
// ---------------------------------------------------------------------------

/**
 * A minimal but **valid** EPUB, built here rather than borrowed from the
 * library.
 *
 * The bytes that cross the socket in AC8 are the criterion's subject, and a
 * string that merely looks like a book would leave "real EPUB bytes" as a claim
 * about a comment. Forty lines buys a container a real reader accepts:
 * `mimetype` first and stored (that is what makes an EPUB an EPUB rather than a
 * zip with a file in it), `container.xml` naming the OPF, and an OPF with a
 * title.
 *
 * Nothing this route runs parses it — the sidecar is stubbed in this suite, so
 * the importer's extraction falls back to the filename, the non-fatal path slice
 * 1 documents — but the fixture is honest about what a client sends, and a later
 * session can hand the same bytes to a real sidecar without editing this file.
 */
function epubFixture(title = 'The Fixture Codex'): Buffer {
  return zip([
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8') },
    {
      name: 'META-INF/container.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><container version="1.0" ' +
          'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
          '<rootfiles><rootfile full-path="OEBPS/content.opf" ' +
          'media-type="application/oebps-package+xml"/></rootfiles></container>',
        'utf8'
      )
    },
    {
      name: 'OEBPS/content.opf',
      data: Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" ' +
          'unique-identifier="bookid"><metadata ' +
          'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' +
          title +
          '</dc:title><dc:identifier id="bookid">urn:uuid:slice-two-fixture</dc:identifier>' +
          '<dc:language>en</dc:language></metadata><manifest><item id="nav" ' +
          'href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
          '</manifest><spine><itemref idref="nav"/></spine></package>',
        'utf8'
      )
    },
    {
      name: 'OEBPS/nav.xhtml',
      data: Buffer.from(
        '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>' +
          '<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>' +
          '<li><a href="nav.xhtml">' +
          title +
          '</a></li></ol></nav></body></html>',
        'utf8'
      )
    }
  ])
}

/** CRC-32, which a stored ZIP entry carries and a reader checks. */
const CRC_TABLE = ((): Int32Array => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * A ZIP container, every entry **stored** — which is what the EPUB spec requires
 * of `mimetype`, and what keeps this builder small enough to read. Enough of the
 * format for any reader: a local header per entry, a central directory, and the
 * end-of-central-directory record.
 */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0, 8) // stored
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(entry.data.length, 18)
    header.writeUInt32LE(entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)

    const index = Buffer.alloc(46)
    index.writeUInt32LE(0x02014b50, 0)
    index.writeUInt16LE(20, 4) // version made by
    index.writeUInt16LE(20, 6) // version needed
    index.writeUInt32LE(crc, 16)
    index.writeUInt32LE(entry.data.length, 20)
    index.writeUInt32LE(entry.data.length, 24)
    index.writeUInt16LE(name.length, 28)
    index.writeUInt32LE(offset, 42)

    local.push(header, name, entry.data)
    central.push(index, name)
    offset += header.length + name.length + entry.data.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...local, directory, end])
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/** The real query behind the wrapper, so a case can put it back. */
const { realGetBook } = vi.hoisted(() => ({
  realGetBook: { fn: null as unknown as typeof import('../services/db').getBook }
}))

vi.mock('../services/nas-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/nas-manager')>()
  // Only `isOnline` is replaced: `setLibraryRoot` and `assertOnline` stay real,
  // so the share check this route inherits is the shipped one and the temp
  // library below is really connected.
  return { ...actual, isOnline: vi.fn(() => true) }
})

vi.mock('../services/sidecar', () => ({
  // No Python in the suite, the same reason `importer.test.ts` stubs it: the
  // extraction is skipped by `isAvailable()`, and the fire-and-forget hydration
  // fails into its own non-fatal path — which a book surviving an import is
  // allowed to do, and does on a Mac with no sidecar.
  call: vi.fn(() => Promise.reject(new Error('no sidecar in the suite'))),
  assertAvailable: vi.fn(),
  isAvailable: vi.fn(() => false)
}))

vi.mock('../services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/db')>()
  // A wrapper, not a stub: the real query answers, and one case can make the
  // route's own read come back empty to decide the 500 guard below.
  realGetBook.fn = actual.getBook
  return { ...actual, getBook: vi.fn(actual.getBook) }
})

const TOKEN = 'a1b2c3d4'.repeat(8)
/** Held apart from the header so the token never sits beside the scheme here. */
const SCHEME = 'Bearer'
const auth = { authorization: `${SCHEME} ${TOKEN}` }

function config(overrides: Partial<ResolvedRestApiConfig> = {}): ResolvedRestApiConfig {
  return { enabled: true, port: DEFAULT_REST_API_PORT, bind: '', token: TOKEN, ...overrides }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** The fixture's bytes, built once: every case uploads the same real book. */
const BOOK = epubFixture()

describe('the upload route', () => {
  let library: string
  let scratch: string
  let base: string
  const servers: Server[] = []

  /** A server of this case's own, with this case's own seams. */
  async function start(options: ServerOptions = {}): Promise<string> {
    const server = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }), options)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  /** POST the collection. `path` carries the query, so a case can be malformed. */
  function post(path: string, body?: Buffer, target: string = base) {
    return fetch(`${target}${path}`, {
      method: 'POST',
      headers: auth,
      body: body ? new Uint8Array(body) : undefined
    })
  }

  /** The canonical call: a real book, with the two required parameters. */
  function upload(filename: string, bytes: Buffer = BOOK, target: string = base) {
    return post(`/api/books?format=epub&filename=${encodeURIComponent(filename)}`, bytes, target)
  }

  function get(path: string, target: string = base) {
    return fetch(`${target}${path}`, { headers: auth })
  }

  /** The scratch root's own answer to "was anything left behind". */
  function scratchIsEmpty(): string[] {
    return readdirSync(scratch)
  }

  beforeEach(async () => {
    // The dev database is never touched: the electron mock points userData at a
    // temp dir (the recipe `rest.test.ts` uses, and the one the suite's alias
    // exists for).
    db.closeDb()
    const profile = app.getPath('userData')
    for (const file of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
      rmSync(join(profile, file), { force: true })
    }

    library = mkdtempSync(join(tmpdir(), 'musaeum-upload-library-'))
    scratch = mkdtempSync(join(tmpdir(), 'musaeum-upload-scratch-'))
    // A real temp directory, really connected: `assertOnline` inside the
    // importer reads the module's own state, and this is what sets it.
    await nas.setLibraryRoot(library)
    vi.mocked(nas.isOnline).mockReturnValue(true)
    vi.mocked(db.getBook).mockClear()
    vi.mocked(db.getBook).mockImplementation(realGetBook.fn)

    base = await start({ upload: { scratchDir: scratch } })
  })

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    rmSync(library, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // AC8 — a book crosses the socket
  // -------------------------------------------------------------------------

  it('imports a real EPUB and answers 201 with the book, which its own id then serves (AC8)', async () => {
    const res = await upload('The Fixture Codex.epub')

    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')

    const answer = (await res.json()) as {
      book: {
        id: string
        title: string
        formats: string[]
        seriesName: string | null
        reading: unknown
        fileSizeBytes: number
      }
      duplicate: unknown
    }

    // The row — and every one of these is an independent expectation rather than
    // a comparison against the app's own shaper: the title came from the
    // filename (`titleFromFilename`, the reason D1 requires one), the format
    // from the parameter, and the reading state is a book nothing has opened.
    expect(answer.book.title).toBe('The Fixture Codex')
    expect(answer.book.formats).toEqual(['epub'])
    expect(answer.book.seriesName).toBeNull()
    expect(answer.book.reading).toEqual({ status: 'unread', percent: null, updatedAt: null })
    expect(answer.book.fileSizeBytes).toBe(BOOK.length)
    expect(answer.duplicate).toBeNull()

    // The point of AC8's second half: the id the answer names is an id the read
    // surface serves.
    const detail = await get(`/api/books/${answer.book.id}`)
    expect(detail.status).toBe(200)
    const book = (await detail.json()) as { id: string; title: string }
    expect(book.id).toBe(answer.book.id)
    expect(book.title).toBe('The Fixture Codex')

    // And the bytes that crossed the socket are the bytes on the share: the
    // criterion is about a file arriving, and a 201 with a row would be true of
    // an import that wrote nothing.
    const folder = join(library, 'books', answer.book.id)
    const written = readdirSync(folder).filter((name) => name.endsWith('.epub'))
    expect(written).toHaveLength(1)
    expect(sha256(readFileSync(join(folder, written[0])))).toBe(sha256(BOOK))

    // The scratch directory is the route's own, and it is empty on the way out
    expect(scratchIsEmpty()).toEqual([])
    expect(db.getBooks()).toHaveLength(1)
  })

  it('answers 201 for the second upload of the same book, naming the collision it answered by policy (D3, D6)', async () => {
    const first = (await (await upload('The Fixture Codex.epub')).json()) as {
      book: { id: string }
    }

    // The same bytes again. The pre-copy gate finds the title/author match, the
    // policy answers it without asking anybody, and the book is imported anyway
    // — the posture D3 chose, with the match named rather than hidden.
    const second = await upload('The Fixture Codex.epub')
    expect(second.status).toBe(201)

    const answer = (await second.json()) as {
      book: { id: string }
      duplicate: {
        existingBookId: string
        existingTitle: string
        existingAuthor: null
        matchType: string
      }
    }

    expect(answer.duplicate).toEqual({
      existingBookId: first.book.id,
      existingTitle: 'The Fixture Codex',
      existingAuthor: null,
      matchType: 'title_author'
    })
    // A second book, not an edit — and the library says so too
    expect(answer.book.id).not.toBe(first.book.id)
    expect(db.getBooks()).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // AC9–AC12 — the refusals
  // -------------------------------------------------------------------------

  it.each([
    ['a missing format', '/api/books?filename=Dune.epub'],
    ['an unknown format', '/api/books?format=sh&filename=Dune.epub'],
    ['a missing filename', '/api/books?format=epub'],
    ['a filename that names nothing', '/api/books?format=epub&filename=..'],
    ['a filename that sanitises to nothing', '/api/books?format=epub&filename=%2F'],
    ['a filename that is only an extension', '/api/books?format=epub&filename=.epub']
  ])('answers 400 for %s, before a byte is written (AC9)', async (_label, path) => {
    // **A real body on the wire, deliberately.** The earlier spelling sent no
    // bytes at all, and the reviewer was right that the ordering the criterion
    // names was then unobservable: with nothing to write, "the scratch
    // directory is empty" holds whether the query was parsed first or last (and
    // the module removes the scratch file on *every* refusal besides). With
    // `BOOK` on the wire the assertion means what its comment says — the
    // request was refused before any of these bytes were accepted.
    const res = await post(path, BOOK)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad request' })
    // The criterion's own instrument: the scratch directory is what says whether
    // the refusal happened *before* the body was accepted, and a status alone
    // cannot say it (a 400 can be sent after the damage).
    expect(scratchIsEmpty()).toEqual([])
    expect(db.getBooks()).toEqual([])
  })

  it('answers 401 with WWW-Authenticate without a token, and 404 for every other method (AC10, S6)', async () => {
    const bare = await fetch(`${base}/api/books?format=epub&filename=Dune.epub`, {
      method: 'POST'
    })
    expect(bare.status).toBe(401)
    expect(bare.headers.get('www-authenticate')).toBe(SCHEME)
    expect(await bare.json()).toEqual({ error: 'unauthorized' })
    // Auth runs before routing, so the refusal reached no route logic at all
    expect(scratchIsEmpty()).toEqual([])

    // **The method policy, which is S6's decision made visible**: this route
    // takes a body, so `HEAD` is deliberately left out of the allowlist the four
    // JSON routes share, and a known path behind a method it does not answer is
    // the same uniform 404 as no path at all (D11).
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${base}/api/books?format=epub&filename=Dune.epub`, {
        method,
        headers: auth
      })
      expect(res.status).toBe(404)
      if (method !== 'HEAD') expect(await res.json()).toEqual({ error: 'not found' })
    }

    // And none of them imported anything
    expect(db.getBooks()).toEqual([])
  })

  it('answers 503 library offline with Retry-After: 5 while the share is unmounted (AC11)', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(false)

    const res = await upload('Offline.epub')

    expect(res.status).toBe(503)
    // The byte routes' own vocabulary and their own wait: the app re-checks the
    // share on a reconnect backoff whose first step is 5 s
    expect(res.headers.get('retry-after')).toBe('5')
    expect(await res.json()).toEqual({ error: 'library offline' })

    // The check precedes the body, so the bytes were never accepted in the first
    // place — there is nothing to clean up, and the criterion asks for the empty
    // directory precisely to pin that ordering
    expect(scratchIsEmpty()).toEqual([])
    expect(db.getBooks()).toEqual([])
  })

  it('answers 503 busy with Retry-After: 1 while both transfer slots are held (AC12, D5)', async () => {
    // A book with a file on the share, so two *downloads* can hold the budget —
    // the seam and the shape the byte routes' own cap case uses
    const folder = join(library, 'books', 'held-1')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'Held.epub'), BOOK)
    db.insertBook({ ...makeBook('held-1', 'Held'), fileSizeBytes: BOOK.length })

    const releases: (() => void)[] = []
    let holding: () => void = () => undefined
    const bothHeld = new Promise<void>((resolve) => (holding = resolve))
    let started = 0
    let hold = true

    const gated = await start({
      upload: { scratchDir: scratch },
      transfer: async (_path, _start, _end, res) => {
        started += 1
        if (started === 2) holding()
        if (hold) await new Promise<void>((resolve) => releases.push(resolve))
        res.end('bytes')
      }
    })

    try {
      const file = `${gated}/api/books/held-1/file?format=epub`
      const first = fetch(file, { headers: auth })
      const second = fetch(file, { headers: auth })
      await bothHeld

      const refused = await upload('Busy.epub', BOOK, gated)

      expect(refused.status).toBe(503)
      expect(refused.headers.get('retry-after')).toBe('1')
      expect(await refused.json()).toEqual({ error: 'busy' })

      // Refused *before* the body was read: the upload took no third slot, and
      // no read of a book began
      expect(started).toBe(2)
      expect(scratchIsEmpty()).toEqual([])
      expect(db.getBooks()).toHaveLength(1)

      // Release the two the case is holding, and stop holding: what is being
      // decided is the budget, not this fake's willingness to ever finish
      hold = false
      releases.forEach((release) => release())
      expect((await first).status).toBe(200)
      expect((await second).status).toBe(200)

      // And the slot came back: an upload now gets through
      expect((await upload('After.epub', BOOK, gated)).status).toBe(201)
    } finally {
      hold = false
      releases.forEach((release) => release())
    }
  })

  it('hands the transfer slot back after an upload that succeeded, so the budget is whole again', async () => {
    // The `finally`'s own decider, and it needs a case of its own: a *refused*
    // upload never takes a slot, so the busy case above cannot see a leak. Here
    // an upload succeeds and the budget has to be two again — which two
    // simultaneous downloads decide, because a leaked slot leaves the second one
    // refused with the byte routes' own `503 busy`.
    const folder = join(library, 'books', 'held-2')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'Held.epub'), BOOK)
    db.insertBook({ ...makeBook('held-2', 'Held Two'), fileSizeBytes: BOOK.length })

    const releases: (() => void)[] = []
    let twoInFlight: () => void = () => undefined
    const both = new Promise<void>((resolve) => (twoInFlight = resolve))
    let started = 0

    const target = await start({
      upload: { scratchDir: scratch },
      transfer: async (_path, _start, _end, res) => {
        started += 1
        if (started === 2) twoInFlight()
        await new Promise<void>((resolve) => releases.push(resolve))
        res.end('bytes')
      }
    })

    try {
      expect((await upload('Slot.epub', BOOK, target)).status).toBe(201)

      const file = `${target}/api/books/held-2/file?format=epub`
      const first = fetch(file, { headers: auth })
      const second = fetch(file, { headers: auth })
      // Bounded rather than awaited outright: under a leaked slot the second
      // download is refused immediately, so the gate is never entered twice and
      // an unbounded wait would report this as a timeout instead of a finding
      await Promise.race([both, delay(2000)])

      expect(started).toBe(2)
      releases.forEach((release) => release())
      expect((await first).status).toBe(200)
      expect((await second).status).toBe(200)
    } finally {
      releases.forEach((release) => release())
    }
  })

  // -------------------------------------------------------------------------
  // The readings this slice settles (S5, and the bound's direction)
  // -------------------------------------------------------------------------

  it('reads the 413 while it is still sending the body (S5)', async () => {
    // A small cap through the seam the route passes through untouched: the
    // *criterion* is about a refusal that arrives mid-body, and the shipped
    // 1 GiB would need a gigabyte on the wire to produce one
    const cap = 64 * 1024
    const target = await start({ upload: { scratchDir: scratch, maxBytes: cap } })
    const declared = 8 * 1024 * 1024

    // A raw socket, because `fetch` cannot send a body it has not finished
    // making — and "the client is still writing when the answer arrives" is the
    // whole question (S5: whether a breach's refusal is ever *read*, or arrives
    // as a reset).
    const socket = connect(Number(new URL(target).port), '127.0.0.1')
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()))

    let answer = ''
    socket.on('data', (chunk: Buffer) => (answer += chunk.toString('utf8')))

    socket.write(
      `POST /api/books?format=epub&filename=Oversize.epub HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\n` +
        `Authorization: ${SCHEME} ${TOKEN}\r\n` +
        `Content-Type: application/epub+zip\r\n` +
        `Content-Length: ${declared}\r\n\r\n`
    )

    const chunk = Buffer.alloc(8192, 7)
    let sent = 0
    while (!answer.includes('\r\n\r\n') && sent < declared) {
      socket.write(chunk)
      sent += chunk.length
      await delay(2)
    }

    // The refusal, read by a client that still has megabytes to write
    expect(answer).toMatch(/^HTTP\/1\.1 413/)
    expect(answer).toContain('content too large')
    // …and *while* it had them: a handler that drained to `end` (the alternative
    // S2 priced) would answer only after all 8 MiB arrived, so this is the half
    // that separates the two readings
    expect(sent).toBeLessThan(declared / 4)

    // Refused at the breach means no import was attempted and nothing was kept
    expect(scratchIsEmpty()).toEqual([])
    expect(db.getBooks()).toEqual([])

    socket.destroy()
  })

  it('accepts a body at the cap and refuses one byte past it — the bound is a limit, not a ban', async () => {
    const cap = 4096
    const target = await start({ upload: { scratchDir: scratch, maxBytes: cap } })

    const atCap = await upload('At Cap.epub', Buffer.alloc(cap, 3), target)
    expect(atCap.status).toBe(201)

    const past = await upload('Past Cap.epub', Buffer.alloc(cap + 1, 3), target)
    expect(past.status).toBe(413)
    // The word is the shaper's own constant, read off the wire. The *literal* is
    // decided once, by the document pair in `shape.test.ts` (every `API_ERRORS`
    // value must appear in `docs/rest-api.md`) — stating it here as well was a
    // constant compared with its own spelling, which passes whatever the route
    // answers.
    expect(await past.json()).toEqual({ error: API_ERRORS.tooLarge })

    // One book, and the refused body left nothing behind
    expect(db.getBooks()).toHaveLength(1)
    expect(scratchIsEmpty()).toEqual([])
  })

  it('answers 500 rather than a book the cache does not hold, and says why', async () => {
    // The guard around `getBook`, decided rather than asserted away. The
    // importer's own async hydration reads the row *first* — it starts inside
    // `importOne`, before the route's read — so the count is asserted here and a
    // change to that ordering fails this case loudly instead of silently making
    // the guard unreachable.
    //
    // **The status alone is not the decider, and the mutation campaign is how
    // that was found:** removing the guard also answers 500, from the payload
    // builder throwing on a null book. The two are different events — one is
    // this module saying what it found, the other is a crash the outer handler
    // catches — and the guard's own sentence on the log is what separates them.
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const reads: string[] = []
    vi.mocked(db.getBook).mockImplementation((id: string) => {
      reads.push(id)
      return null
    })

    const res = await upload('Vanishing.epub')

    expect(reads).toHaveLength(2)
    expect(reads[0]).toBe(reads[1])
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(warnings).toHaveBeenCalledWith('[rest] upload imported a book the cache does not hold')
    warnings.mockRestore()
  })

  it('answers 400 when the body stops arriving, mapped through the stall clock', async () => {
    // The roof of the clock is 30 s and the seam is what makes the claim
    // decidable in a quarter of a second: what is under test is the *mapping*
    // (a client that went quiet is the client's own error, so 400 — the reading
    // route's own precedent), not the figure, which slice 1 measured.
    const target = await start({ upload: { scratchDir: scratch, stallMs: 250 } })

    const socket = connect(Number(new URL(target).port), '127.0.0.1')
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()))

    let answer = ''
    socket.on('data', (chunk: Buffer) => (answer += chunk.toString('utf8')))

    // A declared length the client does not honour, and an open connection: a
    // raw socket, because `fetch` cannot go quiet mid-body.
    socket.write(
      `POST /api/books?format=epub&filename=Stalled.epub HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\n` +
        `Authorization: ${SCHEME} ${TOKEN}\r\n` +
        `Content-Length: 4096\r\n\r\n` +
        'partial'
    )
    for (let i = 0; i < 60 && !answer.includes('\r\n\r\n'); i++) await delay(50)

    expect(answer).toMatch(/^HTTP\/1\.1 400/)
    expect(answer).toContain('bad request')
    // The partial scratch file is gone, and nothing was imported: a refusal
    // mid-body is not a body that gets kept
    expect(scratchIsEmpty()).toEqual([])
    expect(db.getBooks()).toEqual([])

    socket.destroy()
  })

  it('answers 500 internal when the scratch file cannot be made, and keeps the filesystem’s message off the wire', async () => {
    // A scratch root that cannot be created, because a *file* is in its place:
    // this machine's own failure rather than the client's, so a 500 — and the
    // message slice 1's review found in there carries an absolute path from this
    // machine, so it must reach the log and never the body.
    writeFileSync(join(scratch, 'not-a-directory'), 'x')
    const target = await start({
      upload: { scratchDir: join(scratch, 'not-a-directory') }
    })

    const res = await upload('Unwritable.epub', BOOK, target)

    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'internal' })
    // And not the filesystem's prose: the message carries an absolute path from
    // this machine, so the whole answer is one member and nothing else
    expect(text).not.toContain('not-a-directory')
    expect(text).not.toContain(scratch)
    expect(db.getBooks()).toEqual([])
  })
})
