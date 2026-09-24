import { createHash } from 'crypto'
import { createWriteStream, mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { promises as fs } from 'fs'
import type { IncomingMessage } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable, Writable } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as importer from '../importer'
import * as nas from '../nas-manager'
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_STALL_MS,
  parseUploadQuery,
  receiveUpload,
  safeFileName
} from './upload'

/**
 * Slice 1 of the phone-upload design: the upload's own half, decided without a
 * socket. The route, the status table and the contract documents are slice 2's
 * and are deliberately absent here.
 *
 * The request is a plain `Readable`: `receiveUpload` only ever reads a stream
 * and a directory, which is exactly the property the criteria turn on — every
 * one of them is decidable without a port.
 */

vi.mock('../nas-manager', () => ({ isOnline: vi.fn(() => true) }))
// The importer is the real module (the policy under test is its own); the
// sidecar is stubbed only so importing it starts nothing.
vi.mock('../sidecar', () => ({ call: vi.fn(), assertAvailable: vi.fn(), isAvailable: () => false }))

const OK_IMPORT = [{ jobId: 'job-1', fileName: 'Dune.epub', success: true, bookId: 'book-1' }]

let root: string

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Deterministic bytes, so "the file equals what was sent" means something. */
function payload(size: number): Buffer {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff
  return buf
}

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * A request whose body arrives as the given chunks. `gapMs` delays every chunk,
 * which is how a slow-but-alive client and a stalled one are built from the same
 * helper.
 */
function request(chunks: Buffer[], gapMs = 0): { req: IncomingMessage; yielded: () => number } {
  let yielded = 0
  const stream = Readable.from(
    (async function* () {
      for (const chunk of chunks) {
        if (gapMs) await delay(gapMs)
        yielded += 1
        yield chunk
      }
    })()
  )
  return { req: stream as unknown as IncomingMessage, yielded: () => yielded }
}

function query(format?: string, filename?: string): URLSearchParams {
  const params = new URLSearchParams()
  if (format !== undefined) params.set('format', format)
  if (filename !== undefined) params.set('filename', filename)
  return params
}

/** Every path under the scratch root, at any depth — "is it empty afterwards". */
function scratchPaths(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    out.push(full)
    if (entry.isDirectory()) out.push(...scratchPaths(full))
  }
  return out
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'musaeum-upload-'))
  vi.mocked(nas.isOnline).mockReturnValue(true)
  vi.spyOn(importer, 'addFiles').mockResolvedValue(OK_IMPORT)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('parseUploadQuery — what the route accepts', () => {
  it('reads a format and a filename', () => {
    expect(parseUploadQuery(query('epub', 'Dune.epub'))).toEqual({
      format: 'epub',
      filename: 'Dune.epub'
    })
  })

  it('refuses a missing, or unknown, format rather than defaulting either', () => {
    expect(parseUploadQuery(query(undefined, 'Dune.epub'))).toBeNull()
    expect(parseUploadQuery(query('', 'Dune.epub'))).toBeNull()
    expect(parseUploadQuery(query('txt', 'Dune.txt'))).toBeNull()
    expect(parseUploadQuery(query('EPUB', 'Dune.epub'))).toBeNull()
  })

  it('refuses a missing filename', () => {
    expect(parseUploadQuery(query('epub', undefined))).toBeNull()
    expect(parseUploadQuery(query('epub', ''))).toBeNull()
  })

  it('accepts every format the library knows, and nothing beside them', () => {
    for (const format of ['epub', 'mobi', 'azw3', 'pdf']) {
      expect(parseUploadQuery(query(format, `book.${format}`))?.format).toBe(format)
    }
    // An inherited member is not a format — the check is own-property.
    expect(parseUploadQuery(query('toString', 'x'))).toBeNull()
    expect(parseUploadQuery(query('constructor', 'x'))).toBeNull()
  })
})

describe('safeFileName — the client names the book, not the path', () => {
  it('keeps the client’s own stem, so the title is the title', () => {
    expect(safeFileName('Dune.epub', 'epub')).toBe('Dune.epub')
    expect(safeFileName('Dune Messiah.epub', 'epub')).toBe('Dune Messiah.epub')
  })

  it('takes the last segment of anything that looks like a path', () => {
    expect(safeFileName('../../etc/passwd', 'epub')).toBe('passwd.epub')
    expect(safeFileName('/tmp/Dune.epub', 'epub')).toBe('Dune.epub')
    expect(safeFileName('..\\..\\windows\\Dune.epub', 'epub')).toBe('Dune.epub')
  })

  it('replaces another book extension with the declared one', () => {
    // A client that mislabelled its own format still lands somewhere the
    // importer can find it by extension (invariant 2)
    expect(safeFileName('Dune.mobi', 'epub')).toBe('Dune.epub')
    expect(safeFileName('Dune.Messiah.azw3', 'epub')).toBe('Dune.Messiah.epub')
  })

  it('leaves a suffix the library does not know as part of the name', () => {
    expect(safeFileName('Dune.txt', 'epub')).toBe('Dune.txt.epub')
  })

  it('strips control characters and leading dots', () => {
    expect(safeFileName('Du\u0000ne\u001f.epub', 'epub')).toBe('Dune.epub')
    expect(safeFileName('...Dune.epub', 'epub')).toBe('Dune.epub')
  })

  it('refuses a name that is only an extension, dotted or not', () => {
    // Left alone each of these would become `epub.epub` and title the book
    // "epub" — the dotless spelling included, which is the one the rule has to
    // catch on the *stem* rather than on the name as it arrived.
    expect(safeFileName('.epub', 'epub')).toBeNull()
    expect(safeFileName('.MOBI', 'mobi')).toBeNull()
    expect(safeFileName('epub', 'epub')).toBeNull()
    expect(safeFileName('...epub', 'epub')).toBeNull()
    expect(safeFileName('PDF', 'pdf')).toBeNull()
    // ...while a stem that merely *ends* with one is a name
    expect(safeFileName('my.epub', 'epub')).toBe('my.epub')
  })

  it('refuses a name the filesystem cannot hold, at the 255-byte boundary', () => {
    const tooLong = `${'D'.repeat(251)}.epub`
    expect(Buffer.byteLength(tooLong, 'utf8')).toBe(256)
    expect(safeFileName(tooLong, 'epub')).toBeNull()
    // ...and one byte shorter is a name
    const justFits = `${'D'.repeat(250)}.epub`
    expect(safeFileName(justFits, 'epub')).toBe(justFits)
  })

  it('refuses a name that is not a name', () => {
    expect(safeFileName('', 'epub')).toBeNull()
    expect(safeFileName('   ', 'epub')).toBeNull()
    expect(safeFileName('..', 'epub')).toBeNull()
    expect(safeFileName('../../', 'epub')).toBeNull()
    expect(safeFileName('/', 'epub')).toBeNull()
  })
})

describe('receiveUpload — the body, streamed under its bounds', () => {
  it('streams a body larger than the JSON reader’s 4 KB cap to disk, byte for byte', async () => {
    // 3 MiB in 64 KiB pieces: seven hundred times the cap `readJsonBody` reads
    // under, and the case's point is that the file, not the heap, holds it.
    const chunkSize = 64 * 1024
    const chunks = Array.from({ length: 48 }, () => payload(chunkSize))
    const whole = Buffer.concat(chunks)
    const { req } = request(chunks, 2)

    // The scratch file's own lifetime is the importer's window: it is removed on
    // the way out (D2, AC7), so what the file *held* has to be read while the
    // import is running. This is the byte-for-byte half of the criterion.
    let handed: { size: number; digest: string } | null = null
    vi.mocked(importer.addFiles).mockImplementation((async (paths: string[]) => {
      handed = { size: statSync(paths[0]).size, digest: sha(await fs.readFile(paths[0])) }
      return OK_IMPORT
    }) as typeof importer.addFiles)

    const settled = receiveUpload(req, query('epub', 'Dune.epub'), { scratchDir: root })

    // Mid-flight: the bytes are already on disk while the request is still open.
    // This is the streaming claim — a handler that buffered the body would show
    // an empty (or absent) file here, and the assertion is a `stat`, not a heap
    // read.
    let midFlight = 0
    await vi.waitFor(() => {
      const files = scratchPaths(root).filter((p) => p.endsWith('Dune.epub'))
      expect(files).toHaveLength(1)
      midFlight = statSync(files[0]).size
      expect(midFlight).toBeGreaterThan(0)
    })
    expect(midFlight).toBeLessThan(whole.length)

    const outcome = await settled
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.bytes).toBe(whole.length)
    // The chunk-count assertion: the handler answered the arrived total, and it
    // is the sum of the pieces it was handed — not the file's size read back.
    // It does *not* decide streaming on its own (a buffering handler would count
    // the same); the mid-flight `stat` above is that decider.
    expect(outcome.bytes).toBe(chunks.length * chunkSize)
    expect(handed).not.toBeNull()
    expect(handed!.size).toBe(whole.length)
    expect(handed!.digest).toBe(sha(whole))
    expect(scratchPaths(root)).toEqual([])
  })

  it('pauses the client when the target falls behind, and lets it go again', async () => {
    // The docblock claims at most one chunk is held. Without backpressure that
    // claim is false: `fs.WriteStream`'s buffer would grow with the body, up to
    // the cap. A one-byte high-water mark makes the target "slow" on demand.
    let release: () => void = () => undefined
    const held = new Promise<void>((r) => {
      release = r
    })
    const slow = new Writable({
      highWaterMark: 1,
      write: async (_chunk, _enc, cb) => {
        await held
        cb()
      }
    })

    const { req } = request([payload(64 * 1024), payload(64 * 1024)])
    const settled = receiveUpload(req, query('epub', 'Dune.epub'), {
      scratchDir: root,
      writeStream: () => slow
    })

    await vi.waitFor(() => {
      expect((req as unknown as Readable).isPaused()).toBe(true)
    })
    release()
    expect((await settled).ok).toBe(true)
  })

  it('hands the importer a file that already exists, named what the client called it, under the app’s own scratch dir', async () => {
    const seen: { paths: string[]; options: unknown }[] = []
    vi.mocked(importer.addFiles).mockImplementation((async (paths: string[], options: unknown) => {
      // The file is there and non-empty at the moment the import runs — the
      // ordering D2's whole landing-zone choice depends on.
      seen.push({ paths, options })
      expect(statSync(paths[0]).size).toBeGreaterThan(0)
      return OK_IMPORT
    }) as typeof importer.addFiles)

    const { req } = request([payload(2048)])
    const outcome = await receiveUpload(req, query('epub', 'Dune Messiah.epub'), {
      scratchDir: root
    })

    expect(outcome.ok).toBe(true)
    expect(seen).toHaveLength(1)
    // The client's own name is kept (the importer titles the book from the
    // basename), the uuid is the *directory* — so two phones sending
    // `book.epub` at the same moment cannot collide.
    expect(seen[0].paths[0].startsWith(root + '/')).toBe(true)
    expect(seen[0].paths[0].endsWith(join('Dune Messiah.epub'))).toBe(true)
    expect(seen[0].paths[0]).not.toBe(join(root, 'Dune Messiah.epub'))
    // D3: the gate is answered by policy, never awaited — a phone mid-upload has
    // nobody to ask.
    expect(seen[0].options).toEqual({ duplicate: 'add-new' })
  })

  it('answers too-large at the cap, and never calls the importer', async () => {
    const { req } = request([payload(64 * 1024), payload(64 * 1024), payload(64 * 1024)])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), {
      scratchDir: root,
      maxBytes: 64 * 1024
    })

    expect(outcome).toEqual({ ok: false, reason: 'too-large', message: undefined })
    // The status alone would not decide it: a 413 can be sent after the damage.
    expect(importer.addFiles).not.toHaveBeenCalled()
    expect(scratchPaths(root)).toEqual([])
  })

  it('accepts a body exactly at the cap', async () => {
    const { req } = request([payload(32 * 1024), payload(32 * 1024)])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), {
      scratchDir: root,
      maxBytes: 64 * 1024
    })
    expect(outcome.ok).toBe(true)
    expect(importer.addFiles).toHaveBeenCalledTimes(1)
  })

  it('refuses a body that stops arriving, on the stall clock', async () => {
    // A prefix, then silence: the request never ends.
    const never = new Readable({ read: () => undefined })
    never.push(payload(1024))
    const outcome = await receiveUpload(
      never as unknown as IncomingMessage,
      query('epub', 'Dune.epub'),
      {
        scratchDir: root,
        stallMs: 150
      }
    )

    expect(outcome).toEqual({ ok: false, reason: 'stalled', message: undefined })
    expect(importer.addFiles).not.toHaveBeenCalled()
    expect(scratchPaths(root)).toEqual([])
  })

  it('accepts a slow client that outlives the threshold but never stalls', async () => {
    // Five pieces at 60 ms apart is 300 ms of transfer under a 150 ms clock —
    // longer than the bound in total, and never silent for it. A total-duration
    // clock would refuse this; the stall clock must not.
    const chunks = Array.from({ length: 5 }, () => payload(512))
    const { req } = request(chunks, 60)
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), {
      scratchDir: root,
      stallMs: 150
    })

    expect(outcome.ok).toBe(true)
    expect(importer.addFiles).toHaveBeenCalledTimes(1)
  })

  it('refuses an empty body rather than importing a 0-byte book', async () => {
    const { req } = request([])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), { scratchDir: root })
    // The *client's* mistake, so the vocabulary the route answers 400 with —
    // never the 500 an internal failure would carry.
    expect(outcome).toEqual({ ok: false, reason: 'bad-request', message: 'empty body' })
    expect(importer.addFiles).not.toHaveBeenCalled()
    expect(scratchPaths(root)).toEqual([])
  })
})

describe('receiveUpload — refusals that must not cost the phone its bytes', () => {
  it('refuses a bad request before reading a single byte of the body', async () => {
    const { req, yielded } = request([payload(1024)])
    const outcome = await receiveUpload(req, query('txt', 'Dune.txt'), { scratchDir: root })

    expect(outcome).toEqual({ ok: false, reason: 'bad-request' })
    // Not merely "no file": the body was never even consumed. The wait matters —
    // a flowing stream pulls its first chunk on a later tick, so asserting
    // synchronously here would pass for a handler that had started reading.
    await delay(20)
    expect(yielded()).toBe(0)
    expect(importer.addFiles).not.toHaveBeenCalled()
    expect(scratchPaths(root)).toEqual([])
  })

  it('refuses an unmounted share before reading a single byte of the body', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(false)
    const { req, yielded } = request([payload(1024)])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), { scratchDir: root })

    expect(outcome).toEqual({ ok: false, reason: 'offline' })
    // 528 MiB would otherwise cross the link twice for nothing — the cost D2
    // exists to avoid. The wait is the same instrument note as the case above.
    await delay(20)
    expect(yielded()).toBe(0)
    expect(importer.addFiles).not.toHaveBeenCalled()
    expect(scratchPaths(root)).toEqual([])
  })

  it('answers rather than throws when the import fails, and leaves no scratch behind', async () => {
    vi.mocked(importer.addFiles).mockResolvedValue([
      { jobId: 'job-1', fileName: 'Dune.epub', success: false, error: 'The library is offline.' }
    ])
    const { req } = request([payload(2048)])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), { scratchDir: root })

    expect(outcome).toEqual({ ok: false, reason: 'internal', message: 'The library is offline.' })
    expect(scratchPaths(root)).toEqual([])
  })

  it('answers rather than throws when the importer itself throws, and leaves no scratch behind', async () => {
    vi.mocked(importer.addFiles).mockRejectedValue(new Error('share went away'))
    const { req } = request([payload(2048)])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), { scratchDir: root })

    expect(outcome).toEqual({ ok: false, reason: 'internal', message: 'share went away' })
    expect(scratchPaths(root)).toEqual([])
  })

  it('leaves the scratch root empty after a success', async () => {
    const { req } = request([payload(2048)])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), { scratchDir: root })

    expect(outcome.ok).toBe(true)
    // Decided by the directory, not by a call having been made.
    expect(scratchPaths(root)).toEqual([])
  })

  it('names an offline share when it goes away between the check and the copy', async () => {
    // The pre-body check sees it mounted; the import that follows does not. The
    // reason is named here rather than flattened into the importer's prose, so
    // slice 2 can answer its own 503 without string-matching a message.
    vi.mocked(nas.isOnline).mockReturnValueOnce(true).mockReturnValue(false)
    vi.mocked(importer.addFiles).mockResolvedValue([
      { jobId: 'job-1', fileName: 'Dune.epub', success: false, error: 'The library is offline.' }
    ])
    const { req } = request([payload(2048)])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), { scratchDir: root })

    expect(outcome).toEqual({ ok: false, reason: 'offline' })
    expect(scratchPaths(root)).toEqual([])
  })
})

describe('a write that fails is never an ok', () => {
  it('refuses when the write stream cannot even open, rather than answering ok', async () => {
    // The failure D2/D4 exist to prevent, and the one this suite was blind to:
    // on an **open** failure node invokes `end`'s callback with the stream's
    // error *before* the `'error'` event, so a success folded into that callback
    // without reading its argument hands the importer a short (here absent) file.
    // The instrument is a real `fs.WriteStream` pointed one component too deep,
    // which is an open failure of exactly that class — not a stub's imitation.
    const { req } = request([payload(4096)])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), {
      scratchDir: root,
      writeStream: (path) => createWriteStream(join(path, 'nested'))
    })

    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ reason: 'internal' })
    expect(importer.addFiles).not.toHaveBeenCalled()
    expect(scratchPaths(root)).toEqual([])
  })

  it('refuses when a mid-body write fails', async () => {
    let writes = 0
    const { req } = request([payload(2048), payload(2048)])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), {
      scratchDir: root,
      writeStream: () =>
        new Writable({
          write: (_chunk, _enc, cb) => {
            writes += 1
            cb(writes === 2 ? new Error('ENOSPC') : undefined)
          }
        })
    })

    expect(outcome).toMatchObject({ ok: false, reason: 'internal', message: 'ENOSPC' })
    expect(importer.addFiles).not.toHaveBeenCalled()
    expect(scratchPaths(root)).toEqual([])
  })

  it('blames itself, not the client, for a silence its own backpressure caused', async () => {
    // A target that never drains pauses the request, so no further chunk *can*
    // arrive and the clock fires on a silence this module asked for. The request
    // is still bounded — a hang would be the worse failure — but the reason is
    // ours, and `stalled` would send the phone looking for a fault of its own.
    const stuck = new Writable({ highWaterMark: 1, write: () => undefined })
    const { req } = request([payload(64 * 1024), payload(64 * 1024)])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), {
      scratchDir: root,
      stallMs: 150,
      writeStream: () => stuck
    })

    expect(outcome).toMatchObject({ ok: false, reason: 'internal' })
    expect((req as unknown as Readable).isPaused()).toBe(true)
    expect(importer.addFiles).not.toHaveBeenCalled()
    expect(scratchPaths(root)).toEqual([])
  })
})

describe('a request that misbehaves after the answer', () => {
  it('reports a late error rather than throwing, because a listener stays attached', async () => {
    const { req } = request([payload(1024)])
    const outcome = await receiveUpload(req, query('epub', 'Dune.epub'), { scratchDir: root })
    expect(outcome.ok).toBe(true)

    // `readJsonBody` keeps a listener for the same reason: an emitter with none
    // throws synchronously on a later `'error'`, and this module's own cases
    // hand it a plain `Readable` rather than a real `IncomingMessage`.
    expect(() => (req as unknown as Readable).emit('error', new Error('late'))).not.toThrow()
    await delay(20)
  })
})

describe('the bounds themselves', () => {
  it('reads a cap and a stall with a census, a measurement and no drift from it', () => {
    // Pinned because both numbers are load-bearing for the phone's client: the
    // cap is twice the largest EPUB this library was measured to hold (528 MiB),
    // and the stall is a ~300× margin over the worst inter-chunk gap measured
    // (99.7 ms) on a real 320 MiB stream. A silent change to either is a
    // contract change, and `docs/rest-api.md` says so in slice 2.
    expect(MAX_UPLOAD_BYTES).toBe(1024 * 1024 * 1024)
    expect(UPLOAD_STALL_MS).toBe(30_000)
  })
})
