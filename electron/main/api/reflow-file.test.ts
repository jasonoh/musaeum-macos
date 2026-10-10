import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Book, ReflowResult } from '@shared/book.types'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import * as db from '../services/db'
import * as nas from '../services/nas-manager'
import * as reflow from '../services/reflow'
import { type ResolvedRestApiConfig } from '../services/settings'
import { createRestApiServer } from './rest'

/**
 * `GET /api/books/{id}/file?format=reflow` — a PDF-only book's reflowed EPUB,
 * driven over a **real socket** (the wire's slice 4, D8).
 *
 * The route is the one place this API *runs* something on a client's behalf, so
 * what this file decides is the four things a client can meet: the file, the
 * `202` that says a pass is still going, the `422` that says the Mac looked and
 * cannot, and the `404` that says this book was never reflow's to offer.
 *
 * **Hermetic by construction.** The `electron` alias gives every worker a
 * throwaway `userData` (so the database is a scratch one), the library root is a
 * temp directory, the share is ``isOnline``'s own stub, and `services/reflow`
 * is mocked so no pass ever runs — what remains real is the path resolution, the
 * byte writer and the router, which are what the cases are about. Every socket
 * this file opens is closed by the case that opened it.
 */

const { APP_VERSION } = vi.hoisted(() => ({ APP_VERSION: '9.9.9-test' }))

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron')>()
  return { ...actual, app: { ...actual.app, getVersion: () => APP_VERSION } }
})

vi.mock('../services/nas-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/nas-manager')>()
  // `isOnline` is the only thing stubbed: `setLibraryRoot`/`getLibraryRoot` stay
  // real, because the route's own path rules resolve through them
  return { ...actual, isOnline: vi.fn(() => true) }
})

vi.mock('../services/reflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/reflow')>()
  // `ensure` and `currentProgress` are the route's two reads; the in-flight map
  // and the frame map are the *service's* and are decided by
  // `services/reflow.test.ts` — never here, where a real pass would need Python
  return { ...actual, ensure: vi.fn(), currentProgress: vi.fn(() => null) }
})

const TOKEN = 'a1b2c3d4'.repeat(8)

/** The artifact's bytes. `PK` first, the way a zip is — the smoke checks that. */
const ARTIFACT = Buffer.from('PK\u0003\u0004 a reflowed EPUB, in the sense that it starts like one')

const PRODUCED: ReflowResult = {
  status: 'produced',
  reason: '',
  verdict: 'ok',
  epub: 'derived/reflow.epub',
  stampFile: 'derived/reflow.json',
  pages: 4,
  bytes: ARTIFACT.length,
  seconds: 0.4
}

const REFUSED: ReflowResult = {
  status: 'fallback',
  reason: 'no page carries a text layer',
  verdict: 'no_text_layer',
  epub: '',
  stampFile: '',
  pages: 0,
  bytes: 0,
  seconds: 0.1
}

function config(): ResolvedRestApiConfig {
  return { enabled: true, port: 0, bind: '127.0.0.1', token: TOKEN }
}

let root: string
let server: Server
let base: string

/** The dev database is never touched: the electron mock points userData at a temp dir. */
function closeAndWipe(): void {
  db.closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
}

/** A book the importer left with `formats`, its folder on a temp share. */
function seedBook(id: string, formats: Book['formats']): string {
  db.insertBook({ ...makeBook(id), formats })
  const dir = join(root, 'books', id)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The pass's own output, written where `resolveReflowFile` looks for it. */
function writeArtifact(bookDir: string): void {
  mkdirSync(join(bookDir, 'derived'), { recursive: true })
  writeFileSync(join(bookDir, 'derived', 'reflow.epub'), ARTIFACT)
}

beforeEach(async () => {
  closeAndWipe()
  vi.mocked(reflow.ensure).mockReset()
  vi.mocked(reflow.currentProgress).mockReset()
  vi.mocked(reflow.currentProgress).mockReturnValue(null)

  root = mkdtempSync(join(tmpdir(), 'musaeum-reflow-route-'))
  await nas.setLibraryRoot(root)
  vi.mocked(nas.isOnline).mockReturnValue(true)

  // A five-millisecond grace: the *default* is two seconds, and a case that waited
  // for it would be a case nobody runs
  server = createRestApiServer(config(), { reflowGraceMs: 5 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

const auth = { authorization: `Bearer ${TOKEN}` }
const get = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...auth, ...init.headers } })

describe('format=reflow — the file', () => {
  it('serves the artifact as an EPUB, with an ETag and no pass re-run when it is cached', async () => {
    const dir = seedBook('pdf-1', ['pdf'])
    writeArtifact(dir)
    vi.mocked(reflow.ensure).mockResolvedValue(PRODUCED)

    const res = await get('/api/books/pdf-1/file?format=reflow')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/epub+zip')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    // The derived artifact's own identity — `<size>-<mtimeMs>` — which is the
    // thing the client's committed reading of this route names
    expect(res.headers.get('etag')).toMatch(/^"\d+-\d+"$/)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(ARTIFACT)
    expect(vi.mocked(reflow.ensure)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reflow.ensure)).toHaveBeenCalledWith('pdf-1')
  })

  it('serves a Range as 206, through the same byte writer as every other file', async () => {
    const dir = seedBook('pdf-2', ['pdf'])
    writeArtifact(dir)
    vi.mocked(reflow.ensure).mockResolvedValue(PRODUCED)

    const res = await get('/api/books/pdf-2/file?format=reflow', {
      headers: { range: 'bytes=0-1' }
    })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 0-1/${ARTIFACT.length}`)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(ARTIFACT.subarray(0, 2))
  })

  it('leaves the stored file route without an ETag — the member is opt-in', async () => {
    const dir = seedBook('pdf-3', ['pdf'])
    writeFileSync(join(dir, 'book.pdf'), '%PDF-1.4\n')

    const res = await get('/api/books/pdf-3/file?format=pdf')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('etag')).toBeNull()
  })
})

describe('format=reflow — the pass that is still running', () => {
  it('answers 202 with the last frame and Retry-After, then the file once it settles', async () => {
    const dir = seedBook('pdf-4', ['pdf'])
    let release: (result: ReflowResult) => void = () => {}
    vi.mocked(reflow.ensure).mockImplementation(
      () => new Promise<ReflowResult>((resolve) => (release = resolve))
    )
    vi.mocked(reflow.currentProgress).mockReturnValue({ phase: 'layout', completed: 12, total: 24 })

    const first = await get('/api/books/pdf-4/file?format=reflow')

    expect(first.status).toBe(202)
    expect(first.headers.get('retry-after')).toBe('2')
    expect(await first.json()).toEqual({ phase: 'layout', completed: 12, total: 24 })

    // The pass settles and the artifact lands; the *same URL* is now the file —
    // which is the whole shape of the client's poll
    release(PRODUCED)
    await Promise.resolve()
    writeArtifact(dir)
    vi.mocked(reflow.ensure).mockResolvedValue(PRODUCED)
    vi.mocked(reflow.currentProgress).mockReturnValue(null)

    const second = await get('/api/books/pdf-4/file?format=reflow')
    expect(second.status).toBe(200)
    expect(Buffer.from(await second.arrayBuffer())).toEqual(ARTIFACT)
  })

  it('answers `start 0 0` when the pass has reported nothing yet', async () => {
    seedBook('pdf-5', ['pdf'])
    vi.mocked(reflow.ensure).mockImplementation(() => new Promise<ReflowResult>(() => {}))
    vi.mocked(reflow.currentProgress).mockReturnValue(null)

    const res = await get('/api/books/pdf-5/file?format=reflow')

    expect(res.status).toBe(202)
    // The client's own default too, so a bar renders before the first frame
    expect(await res.json()).toEqual({ phase: 'start', completed: 0, total: 0 })
  })
})

describe('format=reflow — the refusals', () => {
  it('answers 422 with the pipeline’s own sentence when the pass refuses', async () => {
    seedBook('pdf-6', ['pdf'])
    vi.mocked(reflow.ensure).mockResolvedValue(REFUSED)

    const res = await get('/api/books/pdf-6/file?format=reflow')

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: 'cannot reflow',
      reason: 'no page carries a text layer'
    })
  })

  it('answers 500, and logs, when the pass cannot even start', async () => {
    seedBook('pdf-7', ['pdf'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(reflow.ensure).mockRejectedValue(new Error('Python sidecar is unavailable'))

    const res = await get('/api/books/pdf-7/file?format=reflow')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    // The runtime's own sentence is for the Mac's log, never the wire
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Python sidecar is unavailable'))
    warn.mockRestore()
  })

  it('answers 404 for a book that holds an EPUB, and starts no pass', async () => {
    const dir = seedBook('mixed-1', ['epub', 'pdf'])
    writeArtifact(dir)

    const res = await get('/api/books/mixed-1/file?format=reflow')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
    expect(vi.mocked(reflow.ensure)).not.toHaveBeenCalled()
  })

  it('answers 404 for a book with no PDF, and for an unknown id', async () => {
    seedBook('epub-only', ['epub'])

    for (const id of ['epub-only', 'no-such-book']) {
      const res = await get(`/api/books/${id}/file?format=reflow`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not found' })
    }
    expect(vi.mocked(reflow.ensure)).not.toHaveBeenCalled()
  })

  it('answers 503 library offline while the share is unmounted, before any pass', async () => {
    seedBook('pdf-8', ['pdf'])
    vi.mocked(nas.isOnline).mockReturnValue(false)

    const res = await get('/api/books/pdf-8/file?format=reflow')

    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('5')
    expect(await res.json()).toEqual({ error: 'library offline' })
    expect(vi.mocked(reflow.ensure)).not.toHaveBeenCalled()
  })
})
