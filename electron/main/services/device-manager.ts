import { promises as fs } from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'
import type { Device } from '@shared/device.types'
import * as db from './db'
import { broadcast } from './events'
import { sanitizeTitle } from './sanitize'

const POLL_INTERVAL_MS = 5_000
const VOLUMES = '/Volumes'
const MAX_SCAN_DEPTH = 2

const devices = new Map<string, Device>()
/** deviceId → (lowercased file stem → absolute paths of the files with it). */
const deviceContents = new Map<string, Map<string, string[]>>()
let pollTimer: NodeJS.Timeout | null = null

export function getConnectedDevices(): Device[] {
  return [...devices.values()]
}

export function getDevice(id: string): Device | null {
  return devices.get(id) ?? null
}

/**
 * A mounted volume is treated as a Kindle when its name says so, or when it
 * has the Kindle filesystem signature (documents/ + system/ directories).
 */
async function looksLikeKindle(mountPath: string, name: string): Promise<boolean> {
  if (/kindle/i.test(name)) return true
  try {
    const [docs, system] = await Promise.all([
      fs.stat(join(mountPath, 'documents')),
      fs.stat(join(mountPath, 'system'))
    ])
    return docs.isDirectory() && system.isDirectory()
  } catch {
    return false
  }
}

/**
 * Free space on the device's own volume, or null when `mountPath` is not a
 * mounted volume.
 *
 * `statfs` answers about whichever filesystem *contains* the path, so a
 * `/Volumes/Kindle` that is a bare directory — a mount point left behind by an
 * unclean unplug, or the volume in the moment before macOS has attached it —
 * reports the free space of the boot disk. That is how the device row came to
 * show 73.2 GB free for a Kindle with 21.3 GB: `looksLikeKindle` matched the
 * name, the row was created from the directory, and one reading was all it ever
 * got. A directory is a mount point only when its device differs from its
 * parent's, which is cheap to check and the only way to know the number is
 * about the device at all.
 */
async function freeBytes(mountPath: string): Promise<number | null> {
  try {
    const [dir, parent] = await Promise.all([fs.stat(mountPath), fs.stat(dirname(mountPath))])
    if (dir.dev === parent.dev) return null

    const s = await fs.statfs(mountPath)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}

/**
 * Recursively walk {mountPath}/documents/ (max depth 2), mapping the
 * lowercased, extension-stripped basename of every file to the paths carrying
 * it — used to determine which books are physically present on the device,
 * and to find their files again when one is removed.
 *
 * `{book}.sdr` sidecar folders are skipped: the Kindle names the annotation
 * and page-index files inside them after the book, so walking into one would
 * report a book as present from its leftovers alone.
 */
export async function scanDocuments(mountPath: string): Promise<Map<string, string[]>> {
  const stems = new Map<string, string[]>()
  const documentsDir = join(mountPath, 'documents')

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isSidecarDir(entry.name)) continue
        if (depth < MAX_SCAN_DEPTH) await walk(full, depth + 1)
      } else if (entry.isFile()) {
        const stem = fileStem(entry.name)
        const paths = stems.get(stem)
        if (paths) paths.push(full)
        else stems.set(stem, [full])
      }
    }
  }

  try {
    await walk(documentsDir, 1)
  } catch {
    return new Map()
  }
  return stems
}

/** The key a device file is matched under: lowercased, extension stripped. */
function fileStem(name: string): string {
  return name.replace(/\.[^.]+$/, '').toLowerCase()
}

function isSidecarDir(name: string): boolean {
  return name.toLowerCase().endsWith('.sdr')
}

function keysEqual(a: Map<string, unknown>, b: Map<string, unknown>): boolean {
  if (a.size !== b.size) return false
  for (const k of a.keys()) if (!b.has(k)) return false
  return true
}

/** Re-scan a connected device's documents/ folder and broadcast the change. */
export async function refreshDeviceContents(deviceId: string): Promise<void> {
  const device = getDevice(deviceId)
  if (!device) return
  deviceContents.set(deviceId, await scanDocuments(device.mountPath))
  broadcast('deviceContentsChanged', deviceId)
}

/**
 * Files we wrote to the device ourselves, per device and book: the one
 * book-keeping fact a device file cannot give back once the title moves on.
 *
 * The destination name is built from the title *at send time*, and the file
 * keeps it for good — so a book retitled after a send used to read as absent
 * and invite a second one, which is how a byte-identical duplicate of "The
 * Nerd Reich" (same EXTH 113, same md5) ended up on a real device. We know the
 * pair exactly when we write it and verify the bytes, so it is recorded here.
 *
 * Only ever a *match key*: the file still has to be in the scan for the claim to
 * hold, so deleting or renaming it on the device drops the book like any other.
 * Cleared with the device — a receipt is about this connection's sends.
 */
const sentFiles = new Map<string, Map<string, string[]>>()

/** Record the name a book was written under, at the moment it is written. */
export function noteSentFile(deviceId: string, bookId: string, filename: string): void {
  const byBook = sentFiles.get(deviceId) ?? new Map<string, string[]>()
  sentFiles.set(deviceId, byBook)

  const names = byBook.get(bookId)
  if (!names) byBook.set(bookId, [filename])
  else if (!names.includes(filename)) names.push(filename)
}

/**
 * Whether this book still holds a file we sent it, under the name we sent it —
 * the match rule that survives a retitle.
 */
function holdsFileWeSent(deviceId: string, bookId: string, stems: Map<string, string[]>): boolean {
  const names = sentFiles.get(deviceId)?.get(bookId)
  if (!names) return false
  return names.some((name) => stems.get(fileStem(name))?.some((p) => basename(p) === name))
}

/** Book IDs whose sanitized title matches a file present on the device. */
export function getOnDeviceBookIds(deviceId: string): string[] {
  const stems = deviceContents.get(deviceId)
  if (!stems || stems.size === 0) return []
  const books = db.getBooks()
  const ids: string[] = []
  for (const book of books) {
    if (
      stems.has(sanitizeTitle(book.title).toLowerCase()) ||
      holdsFileWeSent(deviceId, book.id, stems)
    ) {
      ids.push(book.id)
    }
  }
  return ids
}

/**
 * The stems a book answers to on the device: its sanitized title, plus the
 * stems of any file we sent it under an older one. Removal matches what made the
 * book read as present, so it has to cover both — otherwise a book the app says
 * is on the device refuses to come off it.
 */
function stemsForBook(deviceId: string, bookId: string, title: string): string[] {
  const stems = new Set([sanitizeTitle(title).toLowerCase()])
  for (const name of sentFiles.get(deviceId)?.get(bookId) ?? []) stems.add(fileStem(name))
  return [...stems]
}

/**
 * Delete every file under {mountPath}/documents/ whose stem matches, together
 * with each one's `._` AppleDouble sibling (macOS writes these onto the FAT
 * volume) and its `{book}.sdr` folder — matching what deleting from the Kindle
 * itself does. Reading position and annotations go with the `.sdr`.
 *
 * Rescans rather than trusting the cached contents: that cache is up to one
 * poll interval stale, and a file added since the last scan has to go too or
 * the book stays "on device" after a successful removal.
 */
export async function removeFilesWithStem(mountPath: string, stem: string): Promise<number> {
  const documentsDir = resolve(join(mountPath, 'documents'))
  const paths = (await scanDocuments(mountPath)).get(stem) ?? []

  let removed = 0
  for (const path of paths) {
    // The paths come from our own walk of documentsDir, so this can only fail
    // on a symlink pointing off the volume — never delete through one
    const inside = relative(documentsDir, resolve(path))
    if (!inside || inside.startsWith('..')) continue

    const dir = dirname(path)
    const name = basename(path)
    await fs.rm(path, { force: true })
    await fs.rm(join(dir, `._${name}`), { force: true })
    await fs.rm(join(dir, `${name.replace(/\.[^.]+$/, '')}.sdr`), {
      recursive: true,
      force: true
    })
    removed++
  }
  return removed
}

/**
 * Delete a book's files from a connected device.
 *
 * The book is located the same way presence is — by sanitized title against the
 * scan's file stems, and by the names of files we sent it under a previous title
 * — so this removes exactly what made it read as "on device", and nothing a
 * rename could have pointed at by accident.
 */
export async function removeBookFromDevice(
  bookId: string,
  deviceId: string
): Promise<{ removed: number }> {
  const device = getDevice(deviceId)
  if (!device) throw new Error('Device is not connected')
  const book = db.getBook(bookId)
  if (!book) throw new Error('Book not found')

  let removed = 0
  for (const stem of stemsForBook(deviceId, bookId, book.title)) {
    removed += await removeFilesWithStem(device.mountPath, stem)
  }
  if (removed === 0) throw new Error(`“${book.title}” is not on ${device.name}`)

  await refreshDeviceContents(deviceId)
  return { removed }
}

async function scan(): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(VOLUMES)
  } catch {
    return
  }

  const seen = new Set<string>()
  for (const name of names) {
    const mountPath = join(VOLUMES, name)
    const id = `kindle:${name}`
    if (devices.has(id)) {
      seen.add(id)
      // Re-scan so presence self-heals: books added/removed on the device
      // outside Musaeum, or a first scan that ran before the volume settled.
      const next = await scanDocuments(mountPath)
      const prev = deviceContents.get(id)
      if (!prev || !keysEqual(prev, next)) {
        deviceContents.set(id, next)
        broadcast('deviceContentsChanged', id)
      }
      // Free space is re-read every poll, like the contents above: it is
      // measured at recognition, which is a moment the volume may not have been
      // mounted for yet, and it moves on its own as books are sent. Announced
      // only when it changes, so the renderer hears about the device and not
      // about the poll.
      const device = devices.get(id)!
      const free = await freeBytes(mountPath)
      if (free !== device.freeBytes) {
        device.freeBytes = free
        broadcast('deviceChanged', { ...device })
      }
      continue
    }
    if (await looksLikeKindle(mountPath, name)) {
      const device: Device = {
        id,
        kind: 'kindle',
        name,
        mountPath,
        freeBytes: await freeBytes(mountPath)
      }
      devices.set(id, device)
      seen.add(id)
      deviceContents.set(id, await scanDocuments(mountPath))
      broadcast('deviceConnected', device)
      broadcast('deviceContentsChanged', id)
    }
  }

  for (const [id, device] of devices) {
    if (!seen.has(id)) {
      try {
        await fs.access(device.mountPath)
        seen.add(id) // still mounted; volume just wasn't re-validated
      } catch {
        devices.delete(id)
        deviceContents.delete(id)
        // A send receipt is about this connection: the files it names may well
        // be gone with it, and the next scan decides afresh
        sentFiles.delete(id)
        broadcast('deviceDisconnected', id)
      }
    }
  }
}

export function startDeviceDetection(): void {
  if (pollTimer) return
  void scan()
  pollTimer = setInterval(() => void scan(), POLL_INTERVAL_MS)
}

export function stopDeviceDetection(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
