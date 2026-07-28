import { randomUUID } from 'crypto'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { pipeline } from 'stream/promises'
import type { BookFormat } from '@shared/book.types'
import type { TransferJob } from '@shared/device.types'
import * as db from './db'
import { getDevice, refreshDeviceContents } from './device-manager'
import { broadcast } from './events'
import * as nas from './nas-manager'
import * as sidecar from './sidecar'

/** Kindle format preference: azw3 renders best on modern devices. */
const KINDLE_FORMAT_PREFERENCE: BookFormat[] = ['azw3', 'mobi']

const jobs = new Map<string, TransferJob>()
const queue: string[] = []
let processing = false

export function getTransferProgress(jobId: string): TransferJob | null {
  return jobs.get(jobId) ?? null
}

function emit(job: TransferJob, patch: Partial<TransferJob>): void {
  Object.assign(job, patch)
  broadcast('transferProgress', { ...job })
}

export function sendToDevice(bookId: string, deviceId: string): TransferJob {
  const book = db.getBook(bookId)
  if (!book) throw new Error('Book not found')
  const device = getDevice(deviceId)
  if (!device) throw new Error('Device is not connected')
  nas.assertOnline()

  const job: TransferJob = {
    jobId: randomUUID(),
    bookId,
    bookTitle: book.title,
    deviceId,
    deviceName: device.name,
    format: null,
    status: 'queued',
    progress: 0
  }
  jobs.set(job.jobId, job)
  queue.push(job.jobId)
  broadcast('transferProgress', { ...job })
  void processQueue()
  return job
}

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (queue.length) {
      const jobId = queue.shift()!
      const job = jobs.get(jobId)
      if (job) await runTransfer(job)
    }
  } finally {
    processing = false
  }
}

async function runTransfer(job: TransferJob): Promise<void> {
  try {
    const book = db.getBook(job.bookId)
    const device = getDevice(job.deviceId)
    if (!book || !book.nasPath) throw new Error('Book files not found')
    if (!device) throw new Error('Device disconnected before transfer')

    const libraryRoot = nas.getLibraryRoot()!
    const bookDir = join(libraryRoot, book.nasPath)

    // Pick the best cached format, or convert (and cache the result on NAS)
    let sourceFile: string | null = null
    let format: BookFormat | null = null
    for (const candidate of KINDLE_FORMAT_PREFERENCE) {
      const found = await findFormatFile(bookDir, candidate)
      if (found) {
        sourceFile = found
        format = candidate
        break
      }
    }

    if (!sourceFile) {
      const epub = await findFormatFile(bookDir, 'epub')
      if (epub) {
        const convertPath = sidecar.ebookConvertPath()
        if (!convertPath) {
          throw new Error(
            'Calibre not found — install Calibre or set the ebook-convert path in Settings'
          )
        }
        format = 'azw3'
        emit(job, { status: 'converting', format })
        const target = epub.replace(/\.epub$/i, '.azw3')
        await sidecar.call(
          'convert_format',
          { input_path: epub, output_path: target, ebook_convert_path: convertPath },
          300_000
        )
        sourceFile = target
        const formats = [...new Set([...book.formats, format])]
        db.updateBook(book.id, { formats })
        broadcast('libraryChanged')
      } else {
        // PDF-only book: Kindles render PDF natively; conversion output is
        // unacceptable, so PDFs always transfer as-is
        const pdf = await findFormatFile(bookDir, 'pdf')
        if (!pdf) throw new Error('No source file available for conversion')
        sourceFile = pdf
        format = 'pdf'
      }
    }

    emit(job, { status: 'copying', format })
    const documentsDir = join(device.mountPath, 'documents')
    await fs.mkdir(documentsDir, { recursive: true })
    await copyWithProgress(sourceFile, join(documentsDir, basename(sourceFile)), (p) =>
      emit(job, { progress: p })
    )

    db.logDeviceTransfer(job.bookId, job.deviceId, job.deviceName, format!)
    emit(job, { status: 'done', progress: 1 })
    await refreshDeviceContents(job.deviceId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.logDeviceTransfer(job.bookId, job.deviceId, job.deviceName, job.format ?? 'unknown', message)
    emit(job, { status: 'error', error: message })
  }
}

async function findFormatFile(bookDir: string, format: BookFormat): Promise<string | null> {
  try {
    const files = await fs.readdir(bookDir)
    const match = files.find((f) => extname(f).toLowerCase() === `.${format}`)
    return match ? join(bookDir, match) : null
  } catch {
    return null
  }
}

async function copyWithProgress(
  source: string,
  target: string,
  onProgress: (fraction: number) => void
): Promise<void> {
  const { size } = await fs.stat(source)
  let copied = 0
  let lastEmit = 0
  const reader = createReadStream(source)
  reader.on('data', (chunk) => {
    copied += chunk.length
    const now = Date.now()
    if (now - lastEmit > 200 || copied === size) {
      lastEmit = now
      onProgress(size ? copied / size : 1)
    }
  })
  await pipeline(reader, createWriteStream(target))
}
