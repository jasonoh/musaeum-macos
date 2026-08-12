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

async function freeBytes(mountPath: string): Promise<number | null> {
  try {
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
        const stem = entry.name.replace(/\.[^.]+$/, '').toLowerCase()
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

/** Book IDs whose sanitized title matches a file present on the device. */
export function getOnDeviceBookIds(deviceId: string): string[] {
  const stems = deviceContents.get(deviceId)
  if (!stems || stems.size === 0) return []
  const books = db.getBooks()
  const ids: string[] = []
  for (const book of books) {
    if (stems.has(sanitizeTitle(book.title).toLowerCase())) ids.push(book.id)
  }
  return ids
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
 * The book is located the same way presence is — by sanitized title against
 * the scan's file stems — so this removes exactly what made it read as "on
 * device", and nothing a rename could have pointed at by accident.
 */
export async function removeBookFromDevice(
  bookId: string,
  deviceId: string
): Promise<{ removed: number }> {
  const device = getDevice(deviceId)
  if (!device) throw new Error('Device is not connected')
  const book = db.getBook(bookId)
  if (!book) throw new Error('Book not found')

  const removed = await removeFilesWithStem(
    device.mountPath,
    sanitizeTitle(book.title).toLowerCase()
  )
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
