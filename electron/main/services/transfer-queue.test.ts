import { mkdtempSync, rmSync, type PathLike } from 'fs'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransferJob } from '@shared/device.types'
import { makeBook } from '../../../test/helpers/book'
import { mobiFile } from '../../../test/helpers/mobi'
import { closeDb, getBook, insertBook, setConfig, updateBook } from './db'
import { setCoverEncoderForTests } from './device-covers'
import * as deviceManager from './device-manager'
import * as events from './events'
import * as nas from './nas-manager'
import { LIBRARY_KIND_KEY } from './storage-kind'
import * as sidecar from './sidecar'
import { getTransferProgress, sendToDevice } from './transfer-queue'

/**
 * Stubbed for the same reason as importer's suite: `ebookConvertPath` probes
 * the machine for a real Calibre install, and `call` would start a Python
 * process. Which one of the two the queue reaches — and whether it reaches
 * either — is exactly what these tests are asking about.
 */
vi.mock('./sidecar', () => ({ call: vi.fn(), ebookConvertPath: vi.fn() }))

/**
 * The device half is stubbed rather than staged: `getDevice` reads a map that
 * only the private `/Volumes` poll fills (device-manager's own suite drives
 * that), and `refreshDeviceContents` would re-scan afterwards. Everything the
 * queue itself decides — format, name, bytes — still runs for real, against a
 * temp directory standing in for the mounted Kindle.
 */
vi.mock('./device-manager', () => ({
  getDevice: vi.fn(),
  refreshDeviceContents: vi.fn(),
  noteSentFile: vi.fn()
}))

const DEVICE_ID = 'kindle:Kindle'
const TITLE = 'Leviathan Wakes'
/** The name on the NAS is deliberately not the title — see the copy tests. */
const STEM = 'leviathan-wakes-2011'

const realFs = { open: fs.open, stat: fs.stat }

/** What the injected codec returns — the entry must carry it byte for byte. */
const COVER_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03])
/** The azw3's identity, and the mobi's — different on purpose (see D1). */
const UUID = '5f8e82e4-671f-46b8-9d7c-808c2755dc8b'
const OTHER_UUID = '1b3e27dc-8ba1-4c74-9920-838a02c3c444'
const ENTRY = `thumbnail_${UUID}_EBOK_portrait.jpg`

let root: string
let mount: string
let bookDir: string

async function put(name: string, contents: string | Buffer): Promise<void> {
  await fs.writeFile(join(bookDir, name), contents)
}

/** A book with a jacket on the share, and a row that points at it. */
async function putCover(): Promise<string> {
  await put('cover_full.jpg', COVER_JPEG)
  updateBook('a', { coverFullPath: 'cover_full.jpg' })
  return join(bookDir, 'cover_full.jpg')
}

/** What the device's cover cache holds, if the app ever created it. */
async function thumbnails(): Promise<string[]> {
  return fs.readdir(join(mount, 'system', 'thumbnails')).catch(() => [])
}

async function documents(): Promise<string[]> {
  return (await fs.readdir(join(mount, 'documents'))).sort()
}

async function delivered(name: string): Promise<string> {
  return fs.readFile(join(mount, 'documents', name), 'utf8')
}

/** Queue a send and wait for the job to reach a terminal state. */
async function transfer(): Promise<TransferJob> {
  const { jobId } = sendToDevice('a', DEVICE_ID)
  await vi.waitFor(() => {
    expect(['done', 'error']).toContain(getTransferProgress(jobId)?.status)
  })
  return getTransferProgress(jobId)!
}

beforeEach(async () => {
  closeDb()
  const userData = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(userData, f), { force: true })
  }
  root = mkdtempSync(join(tmpdir(), 'musaeum-library-'))
  mount = mkdtempSync(join(tmpdir(), 'musaeum-kindle-'))
  await nas.setLibraryRoot(root)
  bookDir = join(root, 'books/a')
  await fs.mkdir(bookDir, { recursive: true })
  insertBook(makeBook('a', TITLE))

  vi.mocked(sidecar.call).mockReset()
  vi.mocked(sidecar.ebookConvertPath).mockReturnValue('/opt/homebrew/bin/ebook-convert')
  vi.mocked(deviceManager.getDevice).mockReturnValue({
    id: DEVICE_ID,
    kind: 'kindle',
    name: 'Kindle',
    mountPath: mount,
    freeBytes: 4_000_000_000
  })
  vi.mocked(deviceManager.refreshDeviceContents).mockResolvedValue()
  // The codec is Chromium's, which vitest has no access to; everything the cover
  // entry's *naming and placement* depends on stays real (see device-covers.ts)
  setCoverEncoderForTests(() => COVER_JPEG)
})

afterEach(() => {
  Object.assign(fs, realFs)
  setCoverEncoderForTests(null)
  vi.restoreAllMocks()
  // The offline case schedules a reconnect, and a reconnect shells out to
  // `open smb://…` — cancel it before it can reach the real NAS
  nas.stopHealthChecks()
  rmSync(root, { recursive: true, force: true })
  rmSync(mount, { recursive: true, force: true })
})

describe('format choice', () => {
  it('prefers azw3 over a cached mobi, and names the copy from the book’s title', async () => {
    await put(`${STEM}.mobi`, 'mobi bytes')
    await put(`${STEM}.azw3`, 'azw3 bytes')

    const job = await transfer()

    expect(job).toMatchObject({ status: 'done', format: 'azw3', progress: 1 })
    // Not `${STEM}.azw3`: presence matches the current title against device
    // file stems, so a book retitled after import has to land under the title
    expect(await documents()).toEqual([`${TITLE}.azw3`])
    expect(await delivered(`${TITLE}.azw3`)).toBe('azw3 bytes')
    // And the name it went out under is remembered against the book: the file
    // keeps it whatever the title does next, and nothing on the device can say
    // which book it was once the title moves
    expect(deviceManager.noteSentFile).toHaveBeenCalledWith(DEVICE_ID, 'a', `${TITLE}.azw3`)
  })

  it('falls through to mobi when no azw3 is cached, without converting anything', async () => {
    await put(`${STEM}.mobi`, 'mobi bytes')

    const job = await transfer()

    expect(job).toMatchObject({ status: 'done', format: 'mobi' })
    expect(await documents()).toEqual([`${TITLE}.mobi`])
    expect(await delivered(`${TITLE}.mobi`)).toBe('mobi bytes')
    expect(sidecar.call).not.toHaveBeenCalled()
  })

  it('converts an epub to azw3 when neither preferred format is cached', async () => {
    await put(`${STEM}.epub`, 'epub bytes')
    vi.mocked(sidecar.call).mockImplementation(async (_method, params) => {
      await fs.writeFile(String(params.output_path), 'converted azw3 bytes')
      return {}
    })
    const spy = vi.spyOn(events, 'broadcast')

    const job = await transfer()

    expect(job).toMatchObject({ status: 'done', format: 'azw3' })
    expect(sidecar.call).toHaveBeenCalledWith(
      'convert_format',
      {
        input_path: join(bookDir, `${STEM}.epub`),
        output_path: join(bookDir, `${STEM}.azw3`),
        ebook_convert_path: '/opt/homebrew/bin/ebook-convert'
      },
      300_000
    )
    // Cached on the NAS beside the epub, and recorded, so the next send skips
    // the conversion entirely
    expect(await fs.readdir(bookDir)).toContain(`${STEM}.azw3`)
    expect(getBook('a')?.formats).toEqual(['epub', 'azw3'])
    expect(await delivered(`${TITLE}.azw3`)).toBe('converted azw3 bytes')

    const statuses = spy.mock.calls
      .filter(([channel]) => channel === 'transferProgress')
      .map(([, payload]) => (payload as TransferJob).status)
    expect(statuses).toContain('converting')
    expect(spy.mock.calls.map(([channel]) => channel)).toContain('libraryChanged')
  })

  it('sends a PDF-only book as PDF and never converts it', async () => {
    updateBook('a', { formats: ['pdf'] })
    await put(`${STEM}.pdf`, '%PDF-1.4 bytes')

    const job = await transfer()

    expect(job).toMatchObject({ status: 'done', format: 'pdf' })
    expect(await documents()).toEqual([`${TITLE}.pdf`])
    expect(await delivered(`${TITLE}.pdf`)).toBe('%PDF-1.4 bytes')
    // Kindles render PDF natively and ebook-convert's output is unacceptable,
    // so the converter is not merely skipped — it is never consulted
    expect(sidecar.call).not.toHaveBeenCalled()
    expect(sidecar.ebookConvertPath).not.toHaveBeenCalled()
    expect(getBook('a')?.formats).toEqual(['pdf'])
  })

  it('fails with an actionable message when there is nothing sendable at all', async () => {
    await put('cover_full.jpg', 'not a book')

    const job = await transfer()

    expect(job).toMatchObject({ status: 'error', error: 'No source file available for conversion' })
  })

  it('fails with an actionable message when a conversion is needed but Calibre is missing', async () => {
    await put(`${STEM}.epub`, 'epub bytes')
    vi.mocked(sidecar.ebookConvertPath).mockReturnValue(null)

    const job = await transfer()

    expect(job.status).toBe('error')
    expect(job.error).toMatch(/Calibre not found/)
    expect(sidecar.call).not.toHaveBeenCalled()
  })
})

describe('the copy path', () => {
  /**
   * The failure this guards against is a copy that ends without an error and
   * without all the bytes — a full device, a yanked cable, a stream torn down
   * early. None of those are reproducible on demand, so the size the copy
   * expects is inflated instead: the same arithmetic reaches the same branch.
   */
  it('reports a short copy as an error rather than a completed send', async () => {
    await put(`${STEM}.azw3`, 'azw3 bytes')
    const stat = realFs.stat as unknown as (p: PathLike) => Promise<{ size: number }>
    Object.assign(fs, {
      stat: async (p: PathLike) => {
        const stats = await stat(p)
        // Only the source measures large; the destination reports the truth
        if (String(p).startsWith(bookDir)) Object.assign(stats, { size: stats.size + 1024 })
        return stats
      }
    })

    const job = await transfer()

    expect(job.status).toBe('error')
    expect(job.error).toMatch(/^Copy incomplete: 10 of 1034 bytes reached the device\./)
    // The bytes that did land are left for the retry to overwrite, but the
    // book must not be reported as sent
    expect(job.progress).not.toBe(1)
  })

  /**
   * macOS's SMB client returns EBADF from `close()` on a file it has just read
   * in full. That cannot be reproduced on a local filesystem, and this test
   * does not try: it injects a rejecting `close()` at the `fs` boundary, which
   * is the shape the transfer has to survive. What it pins is the handling —
   * the source handle is owned here, its close failure is logged rather than
   * raised, and the destination is still verified byte-for-byte.
   */
  it('completes a transfer whose source close() fails, and logs the failure', async () => {
    await put(`${STEM}.azw3`, 'azw3 bytes')
    Object.assign(fs, {
      open: async (p: PathLike, flags?: string | number) => {
        const handle = await realFs.open(p, flags)
        const close = handle.close.bind(handle)
        handle.close = async () => {
          // The descriptor really is released; only the report of it fails
          await close()
          throw Object.assign(new Error('EBADF: bad file descriptor, close'), { code: 'EBADF' })
        }
        return handle
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const job = await transfer()

    expect(job).toMatchObject({ status: 'done', format: 'azw3', progress: 1 })
    expect(await delivered(`${TITLE}.azw3`)).toBe('azw3 bytes')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ignoring close() failure'),
      expect.objectContaining({ code: 'EBADF' })
    )
  })
})

describe('the device cover entry', () => {
  it('is named from the identity inside the file that was copied', async () => {
    // Two formats of one book, with different identities — measured on the real
    // library (Red Rising: 5f8e82e4… as azw3, 1b3e27dc… as mobi). The azw3 wins
    // the preference order, so the entry must carry the azw3's identity: this is
    // what makes "the book's uuid" the wrong answer.
    await put(`${STEM}.mobi`, mobiFile({ title: TITLE, uuid: OTHER_UUID, cdetype: 'EBOK' }))
    await put(`${STEM}.azw3`, mobiFile({ title: TITLE, uuid: UUID, cdetype: 'EBOK' }))
    await putCover()

    const job = await transfer()

    expect(job).toMatchObject({ status: 'done', format: 'azw3' })
    expect(await thumbnails()).toEqual([ENTRY])
    expect(await fs.readFile(join(mount, 'system', 'thumbnails', ENTRY))).toEqual(COVER_JPEG)
    // The book itself still landed, and under the name presence looks for
    expect(await documents()).toEqual([`${TITLE}.azw3`])
  })

  it('is on the device by the time the job reports done', async () => {
    // "Sent" has to mean the cover too, or the button reports a finished send
    // while the device is still showing a blank tile. The instrument is the
    // broadcast the renderer reacts to: the file is checked at that instant.
    await put(`${STEM}.azw3`, mobiFile({ title: TITLE, uuid: UUID, cdetype: 'EBOK' }))
    await putCover()
    const atDone: boolean[] = []
    const entry = join(mount, 'system', 'thumbnails', ENTRY)
    vi.spyOn(events, 'broadcast').mockImplementation((event: string, payload?: unknown) => {
      if (event === 'transferProgress' && (payload as TransferJob).status === 'done') {
        atDone.push(existsSync(entry))
      }
    })

    const job = await transfer()

    expect(job.status).toBe('done')
    expect(atDone).toEqual([true])
  })

  it('touches nothing on the device or the share but the cover cache', async () => {
    await put(`${STEM}.azw3`, mobiFile({ title: TITLE, uuid: UUID, cdetype: 'EBOK' }))
    await putCover()
    const shareBefore = (await fs.readdir(bookDir)).sort()

    await transfer()

    expect((await fs.readdir(mount)).sort()).toEqual(['documents', 'system'])
    expect(await fs.readdir(join(mount, 'system'))).toEqual(['thumbnails'])
    expect(await thumbnails()).toEqual([ENTRY])
    // The library is the canonical record and this path never writes to it
    expect((await fs.readdir(bookDir)).sort()).toEqual(shareBefore)
    expect(existsSync(join(bookDir, 'metadata.json'))).toBe(false)
  })

  it('sends a book with no jacket, writes no cache at all, and says nothing', async () => {
    await put(`${STEM}.azw3`, mobiFile({ title: TITLE, uuid: UUID, cdetype: 'EBOK' }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const job = await transfer()

    expect(job).toMatchObject({ status: 'done', format: 'azw3' })
    expect(await thumbnails()).toEqual([])
    expect(existsSync(join(mount, 'system'))).toBe(false)
    // A book without a jacket is not news: a line per send would be noise
    expect(warn).not.toHaveBeenCalled()
  })

  it('sends a PDF with a jacket and no entry, because there is no identity to name one with', async () => {
    updateBook('a', { formats: ['pdf'] })
    await put(`${STEM}.pdf`, '%PDF-1.4 bytes')
    await putCover()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const job = await transfer()

    expect(job).toMatchObject({ status: 'done', format: 'pdf' })
    expect(await thumbnails()).toEqual([])
    // Likewise ordinary — every PDF send would log one otherwise
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports the send as done when the jacket cannot be encoded', async () => {
    await put(`${STEM}.azw3`, mobiFile({ title: TITLE, uuid: UUID, cdetype: 'EBOK' }))
    await putCover()
    setCoverEncoderForTests(() => null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const job = await transfer()

    expect(job.status).toBe('done')
    expect(await thumbnails()).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('encode'))
  })

  it('reports the send as done when the device refuses the entry, and says why', async () => {
    // The book's bytes are verified onto the device before any of this runs, so
    // the send is a success whatever the cache does — invariant 12
    await put(`${STEM}.azw3`, mobiFile({ title: TITLE, uuid: UUID, cdetype: 'EBOK' }))
    await putCover()
    await fs.writeFile(join(mount, 'system'), 'not a directory')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const job = await transfer()

    expect(job.status).toBe('done')
    expect(await documents()).toEqual([`${TITLE}.azw3`])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no cover entry'))
  })
})

describe('the queue’s preconditions', () => {
  it('refuses to queue a send while the library folder is gone', async () => {
    // A folder, so the refusal names the folder. This case pinned the word
    // "offline" until the local-library spec split the vocabulary: an
    // unavailable *folder* is missing — something moved it and only the user can
    // say where — while only a share that dropped is offline. The gate is
    // unchanged; the sentence is not.
    await nas.setLibraryRoot(join(root, 'gone'))

    expect(() => sendToDevice('a', DEVICE_ID)).toThrow(/library folder is missing/i)
    expect(() => sendToDevice('a', DEVICE_ID)).not.toThrow(/NAS/)
  })

  it('refuses to queue a send while a share is away', async () => {
    await nas.setLibraryRoot(join(root, 'gone'))
    // The picker derives a kind from the folder it is handed, so the share is
    // what a previous pick on a share would have recorded
    setConfig(LIBRARY_KIND_KEY, 'network')
    await nas.checkHealth()

    expect(() => sendToDevice('a', DEVICE_ID)).toThrow(/offline/)
    // A real retry would shell `open -g smb://…` on the machine running this
    // suite, so the ladder is disarmed before the case ends
    nas.stopHealthChecks()
  })

  it('refuses to queue a send to a device that is not connected', () => {
    vi.mocked(deviceManager.getDevice).mockReturnValue(null)

    expect(() => sendToDevice('a', DEVICE_ID)).toThrow('Device is not connected')
  })
})
