import { createHash } from 'crypto'
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, type Readable } from 'node:stream'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { type InterfaceMap } from '../services/api/bind'
import * as db from '../services/db'
import * as nas from '../services/nas-manager'
import { OPDS_USERNAME } from '../services/opds/basic-auth'
import {
  OPDS_ACQ_TYPE,
  OPDS_NAV_TYPE,
  OPDS_PAGE_SIZE,
  OPENSEARCH_TYPE
} from '../services/opds/feed'
import { DEFAULT_OPDS_PORT, type ResolvedOpdsConfig } from '../services/settings'
import {
  createOpdsServer,
  getOpdsStatus,
  startOpdsIfEnabled,
  stopOpds,
  type ListenOutcome
} from './opds'

/**
 * The OPDS server (slice O1, Task 4) — the wire and the lifecycle.
 *
 * The same harness as `rest.test.ts`, for the same reasons: a scratch database
 * under the electron mock's throwaway `userData`, a mocked `isOnline`, fixture
 * interface maps, and real sockets **only on `127.0.0.1` ephemeral ports**. No
 * case here binds this machine's tailnet address or reads the dev profile's
 * config: every activation is handed its `config`, its `interfaces` and, where
 * it must not open a socket, its `listen`.
 */

vi.mock('../services/nas-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/nas-manager')>()
  return { ...actual, isOnline: vi.fn(() => false) }
})

vi.mock('../services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/db')>()
  // Wrapped, not stubbed: the real query answers, and "the 401 path ran no
  // query" is a claim about the callables the routes actually reach
  return {
    ...actual,
    getBooksPage: vi.fn(actual.getBooksPage),
    searchBooksPage: vi.fn(actual.searchBooksPage)
  }
})

const TOKEN = 'a1b2c3d4'.repeat(8)
const WRONG = 'deadbeef'.repeat(8)

const MEASURED: InterfaceMap = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
  utun9: [{ address: '100.64.0.1', family: 'IPv4', internal: false }],
  utun8: [{ address: '10.0.0.2', family: 'IPv4', internal: false }]
}

/** The same machine with Tailscale off: no CGNAT address anywhere. */
const NO_TAILNET: InterfaceMap = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }]
}

function config(overrides: Partial<ResolvedOpdsConfig> = {}): ResolvedOpdsConfig {
  return { enabled: true, port: DEFAULT_OPDS_PORT, bind: '', token: TOKEN, ...overrides }
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
}

const AUTH = { authorization: basic(OPDS_USERNAME, TOKEN) }

function recordingListen(
  outcome: ListenOutcome = { ok: true, address: '100.64.0.1', port: DEFAULT_OPDS_PORT }
) {
  return vi.fn(async (_server: Server, _host: string, _port: number) => outcome)
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

/** The book ids a feed carries, in document order. */
function entryIds(xml: string): string[] {
  return [...xml.matchAll(/<id>urn:uuid:([^<]*)<\/id>/g)].map((m) => m[1]!)
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function closeAndWipe(): void {
  db.closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
}

async function listenLocal(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

beforeEach(async () => {
  vi.mocked(nas.isOnline).mockReturnValue(false)
  vi.mocked(db.getBooksPage).mockClear()
  vi.mocked(db.searchBooksPage).mockClear()
  closeAndWipe()
  // A lifecycle case that listened must not leave the module's socket behind
  await stopOpds()
})

// ---------------------------------------------------------------------------
// The wire: auth first, then the feeds
// ---------------------------------------------------------------------------

/** More than two pages' worth, so a walk crosses at least two `next` links. */
const SEEDED = OPDS_PAGE_SIZE * 2 + 10

describe('the feeds', () => {
  let server: Server
  let base: string
  let root: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'musaeum-opds-feeds-'))
    await nas.setLibraryRoot(root)
    vi.mocked(nas.isOnline).mockReturnValue(true)

    for (let i = 0; i < SEEDED; i++) {
      const n = String(i).padStart(3, '0')
      db.insertBook({
        ...makeBook(`book-${n}`, `Title ${String((i * 37) % SEEDED).padStart(3, '0')}`),
        // Distinct, and not in title order, so `new` and `all` cannot agree by accident
        dateAdded: new Date(Date.UTC(2026, 0, 1) + ((i * 53) % SEEDED) * 86_400_000).toISOString()
      })
    }
    db.insertBook({ ...makeBook('alpha-1', 'Alpha Centauri'), dateAdded: '2025-01-01T00:00:00Z' })
    db.insertBook({
      ...makeBook('alpha-2', 'The Alpha Protocol'),
      dateAdded: '2025-01-02T00:00:00Z'
    })

    server = createOpdsServer(config({ port: 0, bind: '127.0.0.1' }))
    base = await listenLocal(server)
  })

  afterEach(async () => {
    await closeServer(server)
    rmSync(root, { recursive: true, force: true })
  })

  function get(path: string, headers: Record<string, string> = AUTH): Promise<Response> {
    return fetch(`${base}${path}`, { headers })
  }

  async function feed(path: string): Promise<string> {
    const res = await get(path)
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(balanced(xml)).toBe(true)
    return xml
  }

  it.each([
    '/opds',
    '/opds/new',
    '/opds/all',
    '/opds/search?q=alpha',
    '/opds/search.xml',
    '/opds/cover/book-000/thumb',
    '/opds/book/book-000/epub',
    '/opds/nothing-here',
    '/',
    '/api/health'
  ])('answers 401 with a Basic challenge and no credentials for %s (AC2.1)', async (path) => {
    const res = await get(path, {})
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="Musaeum"')
    // Auth runs before routing: nothing was queried, so an unauthenticated
    // request cannot even learn whether the route exists
    expect(vi.mocked(db.getBooksPage)).not.toHaveBeenCalled()
    expect(vi.mocked(db.searchBooksPage)).not.toHaveBeenCalled()
  })

  it('answers 401 for a wrong password, a wrong username, a Bearer token and a non-GET', async () => {
    expect((await get('/opds', { authorization: basic(OPDS_USERNAME, WRONG) })).status).toBe(401)
    expect((await get('/opds', { authorization: basic('admin', TOKEN) })).status).toBe(401)
    expect((await get('/opds', { authorization: `Bearer ${TOKEN}` })).status).toBe(401)
    expect((await fetch(`${base}/opds`, { method: 'POST' })).status).toBe(401)
  })

  it('logs the client address and never the attempted credential', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await get('/opds', { authorization: basic(OPDS_USERNAME, WRONG) })
      const logged = warn.mock.calls.flat().join(' ')
      expect(logged).toContain('127.0.0.1')
      expect(logged).not.toContain(WRONG)
      expect(logged).not.toContain(TOKEN)
    } finally {
      warn.mockRestore()
    }
  })

  it('answers the root as a navigation feed (AC2.2)', async () => {
    const res = await get('/opds')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(`${OPDS_NAV_TYPE};charset=utf-8`)
    const xml = await res.text()
    expect(balanced(xml)).toBe(true)
    expect(xml).toContain(`<link rel="self" href="${base}/opds" type="${OPDS_NAV_TYPE}"/>`)
    expect(xml).toContain(`${base}/opds/new`)
    expect(xml).toContain(`${base}/opds/all`)
    // A navigation feed carries no catalog entries
    expect(entryIds(xml)).toEqual([])
  })

  it('answers the authenticated unknown path, and every non-GET, with one uniform 404', async () => {
    const unknown = await get('/opds/nothing-here')
    const root404 = await get('/')
    const post = await fetch(`${base}/opds`, { method: 'POST', headers: AUTH })
    const head = await fetch(`${base}/opds/all`, { method: 'HEAD', headers: AUTH })
    const del = await fetch(`${base}/opds/book/book-000/epub`, { method: 'DELETE', headers: AUTH })

    const bodies = await Promise.all([unknown, root404, post, del].map((r) => r.text()))
    for (const res of [unknown, root404, post, head, del]) expect(res.status).toBe(404)
    expect(new Set(bodies).size).toBe(1)
  })

  it('serves /opds/all in getBooksPage title order, and /opds/new by date_added desc (AC2.6)', async () => {
    const all = await feed('/opds/all')
    const expectedAll = db
      .getBooksPage(
        { sort: { field: 'title', direction: 'asc' } },
        { limit: OPDS_PAGE_SIZE, offset: 0 }
      )
      .books.map((b) => b.id)
    expect(entryIds(all)).toEqual(expectedAll)

    const fresh = await feed('/opds/new')
    const expectedNew = db
      .getBooksPage(
        { sort: { field: 'date_added', direction: 'desc' } },
        { limit: OPDS_PAGE_SIZE, offset: 0 }
      )
      .books.map((b) => b.id)
    expect(entryIds(fresh)).toEqual(expectedNew)
    expect(expectedNew).not.toEqual(expectedAll)
  })

  it('carries the acquisition media type, with its charset', async () => {
    const res = await get('/opds/all')
    expect(res.headers.get('content-type')).toBe(`${OPDS_ACQ_TYPE};charset=utf-8`)
  })

  it('walking every next link of /opds/all yields every seeded book exactly once (AC2.6)', async () => {
    const seen: string[] = []
    let path: string | null = '/opds/all'
    let pages = 0
    while (path) {
      const xml = await feed(path)
      seen.push(...entryIds(xml))
      const next = /<link rel="next" href="([^"]+)"/.exec(xml)?.[1]
      path = next ? next.replace(/&amp;/g, '&').slice(base.length) : null
      pages += 1
      expect(pages).toBeLessThan(10)
    }

    const everyId = db
      .getBooksPage(undefined, { limit: 10_000, offset: 0 })
      .books.map((b) => b.id)
      .sort()
    expect(pages).toBe(Math.ceil((SEEDED + 2) / OPDS_PAGE_SIZE))
    expect(new Set(seen).size).toBe(seen.length)
    expect([...seen].sort()).toEqual(everyId)
  })

  it.each(['0', 'abc', '-1', '', '1.5', '01'])(
    'answers ?page=%s with 400 (Review Focus 3)',
    async (page) => {
      expect((await get(`/opds/all?page=${page}`)).status).toBe(400)
      expect((await get(`/opds/new?page=${page}`)).status).toBe(400)
      expect((await get(`/opds/search?q=alpha&page=${page}`)).status).toBe(400)
    }
  )

  it('answers a page past the end with 200, zero entries and no next (Review Focus 3)', async () => {
    const xml = await feed('/opds/all?page=999')
    expect(entryIds(xml)).toEqual([])
    expect(xml).not.toContain('rel="next"')
    expect(xml).toContain(`<opensearch:totalResults>${SEEDED + 2}</opensearch:totalResults>`)
  })

  it('search returns the same ids as searchBooksPage for that query (AC2.9)', async () => {
    const xml = await feed('/opds/search?q=alpha')
    const expected = db
      .searchBooksPage('alpha', { limit: OPDS_PAGE_SIZE, offset: 0 })
      .books.map((b) => b.id)
    expect(expected.sort()).toEqual(['alpha-1', 'alpha-2'])
    expect(entryIds(xml).sort()).toEqual(expected)
    expect(entryIds(xml)).toEqual(
      db.searchBooksPage('alpha', { limit: OPDS_PAGE_SIZE, offset: 0 }).books.map((b) => b.id)
    )
  })

  it.each([
    ['empty', ''],
    ['only a quote', '"'],
    ['only spaces', '   '],
    ['5,000 characters', 'a'.repeat(5000)]
  ])('answers a %s query with 200 and a well-formed feed (Review Focus 2)', async (_label, q) => {
    const xml = await feed(`/opds/search?q=${encodeURIComponent(q)}`)
    expect(xml.endsWith('</feed>\n')).toBe(true)
  })

  it('treats a blank query as the library in title order, never an empty catalog', async () => {
    const xml = await feed('/opds/search?q=')
    const expected = db
      .getBooksPage(
        { sort: { field: 'title', direction: 'asc' } },
        { limit: OPDS_PAGE_SIZE, offset: 0 }
      )
      .books.map((b) => b.id)
    expect(entryIds(xml)).toEqual(expected)
    // And a missing `q` is the same answer
    expect(entryIds(await feed('/opds/search'))).toEqual(expected)
  })

  it('answers the OpenSearch description with its own media type', async () => {
    const res = await get('/opds/search.xml')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(`${OPENSEARCH_TYPE};charset=utf-8`)
    const xml = await res.text()
    expect(xml).toContain(`template="${base}/opds/search?q={searchTerms}"`)
  })

  it('builds links from the bound address, never from a spoofed Host header', async () => {
    const port = (server.address() as AddressInfo).port
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/opds', headers: { ...AUTH, host: 'evil.example:666' } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        }
      )
      req.on('error', reject)
      req.end()
    })
    expect(body).not.toContain('evil.example')
    expect(body).toContain(`http://127.0.0.1:${port}/opds`)
  })

  it('answers the root with 503 when no library is configured', async () => {
    db.deleteConfig('library_root')
    expect(nas.getLibraryRoot()).toBeFalsy()
    const res = await get('/opds')
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBeTruthy()
  })

  it('serves the feeds from SQLite while the share is offline (AC2.12)', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(false)
    expect((await get('/opds')).status).toBe(200)
    expect(entryIds(await feed('/opds/all'))).toHaveLength(OPDS_PAGE_SIZE)
    expect((await get('/opds/new')).status).toBe(200)
    expect((await get('/opds/search?q=alpha')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// The bytes: downloads and covers
// ---------------------------------------------------------------------------

describe('the byte routes', () => {
  let server: Server
  let base: string
  let root: string
  let epub: string
  let thumb: string
  let opened: Readable[]

  const BOOK_BYTES = Buffer.alloc(4096)
  for (let i = 0; i < BOOK_BYTES.length; i++) BOOK_BYTES[i] = (i * 7 + 13) % 251
  const THUMB_BYTES = Buffer.from('cover_thumb.jpg bytes')
  const FULL_BYTES = Buffer.from('a different image for cover_full.jpg')

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'musaeum-opds-bytes-'))
    await nas.setLibraryRoot(root)
    vi.mocked(nas.isOnline).mockReturnValue(true)

    const dir = join(root, 'books', 'epub-1')
    mkdirSync(dir, { recursive: true })
    // The file's name and the row's title disagree: resolution is by extension
    epub = join(dir, 'Leviathan Wakes.epub')
    thumb = join(dir, 'cover_thumb.jpg')
    writeFileSync(epub, BOOK_BYTES)
    writeFileSync(thumb, THUMB_BYTES)
    writeFileSync(join(dir, 'cover_full.jpg'), FULL_BYTES)
    writeFileSync(join(dir, 'Leviathan Wakes.azw3'), 'kf8 bytes')

    db.insertBook({
      ...makeBook('epub-1', 'Bad "Name"/\\ Café\u0001'),
      formats: ['epub', 'azw3'],
      coverThumbPath: 'cover_thumb.jpg',
      coverFullPath: 'cover_full.jpg'
    })
    db.insertBook({ ...makeBook('no-cover'), formats: ['epub'] })
    db.insertBook({ ...makeBook('traversing'), nasPath: '../../etc', formats: ['epub'] })
    db.insertBook({ ...makeBook('bad-cover'), formats: ['mobi'], coverThumbPath: '../secret.jpg' })

    opened = []
    server = createOpdsServer(config({ port: 0, bind: '127.0.0.1' }), {
      openFile: (path) => {
        const stream = createReadStream(path)
        opened.push(stream)
        return stream
      }
    })
    base = await listenLocal(server)
  })

  afterEach(async () => {
    await closeServer(server)
    rmSync(root, { recursive: true, force: true })
  })

  function get(path: string): Promise<Response> {
    return fetch(`${base}${path}`, { headers: AUTH })
  }

  it('serves a book byte-identical to the disk, with its length, type and filename (AC2.8)', async () => {
    const res = await get('/opds/book/epub-1/epub')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/epub+zip')
    expect(res.headers.get('content-length')).toBe(String(BOOK_BYTES.length))
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="Bad Name Cafe.epub"; filename*=UTF-8''Bad%20Name%20Caf%C3%A9.epub`
    )
    // Whole files only: no Range support is advertised
    expect(res.headers.get('accept-ranges')).toBeNull()
    expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(sha256(readFileSync(epub)))
  })

  it('ignores a Range header and answers the whole file', async () => {
    const res = await fetch(`${base}/opds/book/epub-1/epub`, {
      headers: { ...AUTH, range: 'bytes=100-' }
    })
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toHaveLength(BOOK_BYTES.length)
  })

  it("labels azw3 with the feed's Mobipocket type, so the link and the response agree", async () => {
    const res = await get('/opds/book/epub-1/azw3')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-mobipocket-ebook')
    await res.arrayBuffer()
  })

  it.each([
    ['an unknown format', '/opds/book/epub-1/txt'],
    ['a format the book lacks', '/opds/book/epub-1/pdf'],
    ['a nonexistent id', '/opds/book/not-a-book/epub'],
    ['a traversing nasPath', '/opds/book/traversing/epub'],
    ['an extra segment', '/opds/book/epub-1/epub/more'],
    ['a malformed escape', '/opds/book/%E0%A4%A/epub']
  ])('answers %s with the uniform 404 (AC2.8)', async (_label, path) => {
    const res = await get(path)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(await (await get('/opds/nothing-here')).text())
  })

  it('serves a cover as image/jpeg bytes, and 404 for a book with none (AC2.7)', async () => {
    const res = await get('/opds/cover/epub-1/thumb')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(sha256(readFileSync(thumb)))

    const full = await get('/opds/cover/epub-1/full')
    expect(Buffer.from(await full.arrayBuffer())).toEqual(FULL_BYTES)

    expect((await get('/opds/cover/no-cover/thumb')).status).toBe(404)
    expect((await get('/opds/cover/not-a-book/full')).status).toBe(404)
    // A traversing cover is the same uniform 404, not the resolver's 400
    expect((await get('/opds/cover/bad-cover/thumb')).status).toBe(404)
    expect((await get('/opds/cover/epub-1/banana')).status).toBe(404)
  })

  it('answers 503 with Retry-After for bytes while the share is offline, before any resolve (AC2.12)', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(false)
    // Wiping the root proves the order: a resolve would have answered 404
    rmSync(root, { recursive: true, force: true })
    for (const path of ['/opds/book/epub-1/epub', '/opds/cover/epub-1/thumb']) {
      const res = await get(path)
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('5')
    }
    expect(opened).toHaveLength(0)
  })

  it('a client that hangs up mid-download closes the file stream and leaves the server healthy (Review Focus 5)', async () => {
    // Large enough to be many chunks, so the hang-up lands mid-transfer
    const big = Buffer.alloc(8 * 1024 * 1024, 7)
    writeFileSync(epub, big)

    const uncaught = vi.fn()
    process.on('uncaughtException', uncaught)
    process.on('unhandledRejection', uncaught)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const port = (server.address() as AddressInfo).port
      // Three hang-ups: more than the byte budget, so a leaked slot would turn
      // the request after them into a 503
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((resolve, reject) => {
          const req = request(
            { host: '127.0.0.1', port, path: '/opds/book/epub-1/epub', headers: AUTH },
            (res: IncomingMessage) => {
              expect(res.statusCode).toBe(200)
              res.once('data', () => {
                req.destroy()
                resolve()
              })
            }
          )
          req.on('error', () => undefined)
          req.on('close', () => resolve())
          req.end()
          setTimeout(() => reject(new Error('no first chunk')), 5000)
        })
        const stream = opened[opened.length - 1]!
        await vi.waitFor(() => expect(stream.destroyed).toBe(true), { timeout: 3000 })
        // Closed because the transfer failed, not because it finished: 8 MiB is
        // far past the socket buffers, so the stream cannot have been read out
        const read = (stream as unknown as { bytesRead: number }).bytesRead
        expect(read).toBeLessThan(big.length)
      }
      expect(warn.mock.calls.flat().join(' ')).toContain('transfer failed')

      const after = await get('/opds/book/epub-1/epub')
      expect(after.status).toBe(200)
      expect(Buffer.from(await after.arrayBuffer())).toHaveLength(big.length)
      expect(uncaught).not.toHaveBeenCalled()
    } finally {
      process.off('uncaughtException', uncaught)
      process.off('unhandledRejection', uncaught)
      warn.mockRestore()
    }
  })
})

describe('the byte budget', () => {
  let server: Server
  let base: string
  let root: string
  let held: PassThrough[]

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'musaeum-opds-gate-'))
    await nas.setLibraryRoot(root)
    vi.mocked(nas.isOnline).mockReturnValue(true)
    const dir = join(root, 'books', 'epub-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Book.epub'), Buffer.alloc(1024, 1))
    db.insertBook({ ...makeBook('epub-1'), formats: ['epub'] })

    held = []
    // A file that never finishes: each transfer holds its slot until the client leaves
    server = createOpdsServer(config({ port: 0, bind: '127.0.0.1' }), {
      openFile: () => {
        const stream = new PassThrough()
        stream.write(Buffer.alloc(16, 1))
        held.push(stream)
        return stream
      }
    })
    base = await listenLocal(server)
  })

  afterEach(async () => {
    await closeServer(server)
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a transfer past the cap with 503 and Retry-After, and frees the slot on hang-up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const aborts: AbortController[] = []
    try {
      const open = async (): Promise<Response> => {
        const ctl = new AbortController()
        aborts.push(ctl)
        return fetch(`${base}/opds/book/epub-1/epub`, { headers: AUTH, signal: ctl.signal })
      }
      const first = await open()
      const second = await open()
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)

      const refused = await open()
      expect(refused.status).toBe(503)
      expect(refused.headers.get('retry-after')).toBe('1')

      // The client leaves; the slot comes back
      aborts[0]!.abort()
      await vi.waitFor(() => expect(held[0]!.destroyed).toBe(true), { timeout: 3000 })
      const again = await open()
      expect(again.status).toBe(200)
    } finally {
      for (const ctl of aborts) ctl.abort()
      warn.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// The lifecycle (hermetic: injected interfaces and listen, never the tailnet)
// ---------------------------------------------------------------------------

describe('the lifecycle', () => {
  it('creates nothing when disabled (AC2.13)', async () => {
    const listen = recordingListen()
    const status = await startOpdsIfEnabled({
      config: config({ enabled: false }),
      interfaces: MEASURED,
      listen
    })
    expect(status).toEqual({ state: 'disabled', address: null, port: null, reason: null, at: null })
    expect(listen).not.toHaveBeenCalled()
    expect(getOpdsStatus()).toEqual(status)
    expect(getOpdsStatus()).not.toBe(status)
  })

  it('fails closed with the token reason when enabled with no token', async () => {
    const listen = recordingListen()
    const status = await startOpdsIfEnabled({
      config: config({ token: null }),
      interfaces: MEASURED,
      listen
    })
    expect(status.state).toBe('failed')
    expect(status.reason).toMatch(/opds_token/)
    expect(status.reason).not.toMatch(/rest_api/)
    expect(listen).not.toHaveBeenCalled()
  })

  it("fails with the resolver's reason, in opds_bind's words, when there is no tailnet", async () => {
    const listen = recordingListen()
    const status = await startOpdsIfEnabled({ config: config(), interfaces: NO_TAILNET, listen })
    expect(status.state).toBe('failed')
    expect(status.reason).toMatch(/no tailnet address/)
    expect(status.reason).toContain('opds_bind')
    expect(status.reason).not.toContain('rest_api')
    expect(listen).not.toHaveBeenCalled()
  })

  it("refuses a LAN override in opds_bind's words, with no listen attempt", async () => {
    const listen = recordingListen()
    const status = await startOpdsIfEnabled({
      config: config({ bind: '192.168.1.10' }),
      interfaces: MEASURED,
      listen
    })
    expect(status.state).toBe('failed')
    expect(status.reason).toContain('opds_bind "192.168.1.10"')
    expect(status.reason).not.toContain('rest_api')
    expect(listen).not.toHaveBeenCalled()
  })

  it("carries a failed listen's message", async () => {
    const listen = recordingListen({ ok: false, message: 'the port said no' })
    const status = await startOpdsIfEnabled({ config: config(), interfaces: MEASURED, listen })
    expect(status).toMatchObject({
      state: 'failed',
      reason: 'the port said no',
      address: '100.64.0.1',
      port: DEFAULT_OPDS_PORT
    })
  })

  it('reports listening with the address and port on success', async () => {
    const listen = recordingListen()
    const status = await startOpdsIfEnabled({ config: config(), interfaces: MEASURED, listen })
    expect(status).toEqual({
      state: 'listening',
      address: '100.64.0.1',
      port: DEFAULT_OPDS_PORT,
      reason: null,
      at: expect.any(String)
    })
    expect(listen.mock.calls[0]!.slice(1)).toEqual(['100.64.0.1', DEFAULT_OPDS_PORT])
  })

  it('records an activation that throws inside, rather than rejecting', async () => {
    const hostile = {
      get utun9(): never {
        throw new Error('the interface table is a brick')
      }
    } as unknown as InterfaceMap
    const status = await startOpdsIfEnabled({
      config: config(),
      interfaces: hostile,
      listen: recordingListen()
    })
    expect(status.state).toBe('failed')
    expect(status.reason).toContain('the interface table is a brick')
  })

  it('listens for real on loopback, serves, and the port refuses after a stop', async () => {
    const started = await startOpdsIfEnabled({
      config: config({ port: 0, bind: '127.0.0.1' }),
      interfaces: MEASURED
    })
    expect(started.state).toBe('listening')
    const base = `http://127.0.0.1:${started.port as number}`
    expect((await fetch(`${base}/opds/search.xml`, { headers: AUTH })).status).toBe(200)

    expect(await stopOpds()).toMatchObject({ state: 'disabled', address: null, port: null })
    await expect(fetch(`${base}/opds`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
  })

  it('a stop during an in-flight start wins (epoch)', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let bound = 0
    const listen = vi.fn(async (server: Server) => {
      await gate
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      bound = (server.address() as AddressInfo).port
      return { ok: true as const, address: '127.0.0.1', port: bound }
    })

    const activation = startOpdsIfEnabled({
      config: config({ port: 0, bind: '127.0.0.1' }),
      interfaces: MEASURED,
      listen
    })
    expect((await stopOpds()).state).toBe('disabled')
    release()
    const settled = await activation

    expect(bound).toBeGreaterThan(0)
    expect(settled.state).toBe('disabled')
    expect(getOpdsStatus().state).toBe('disabled')
    await expect(
      fetch(`http://127.0.0.1:${bound}/opds`, { signal: AbortSignal.timeout(2000) })
    ).rejects.toThrow()
  })

  it('is a settled no-op stopped twice, and callable with no arguments', async () => {
    expect((await stopOpds()).state).toBe('disabled')
    expect((await stopOpds()).state).toBe('disabled')
  })

  it('records a real EADDRINUSE as failed and keeps the process alive (AC2.11)', async () => {
    const held = createServer()
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve))
    const port = (held.address() as AddressInfo).port
    try {
      const status = await startOpdsIfEnabled({
        config: config({ port, bind: '127.0.0.1' }),
        interfaces: MEASURED
      })
      expect(status.state).toBe('failed')
      expect(status.reason).toContain('EADDRINUSE')
      expect(status).toMatchObject({ address: '127.0.0.1', port })
      expect(JSON.stringify(status)).not.toContain(TOKEN)
      expect(getOpdsStatus()).toEqual(status)
      expect((await stopOpds()).state).toBe('disabled')
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()))
    }
  })
})
