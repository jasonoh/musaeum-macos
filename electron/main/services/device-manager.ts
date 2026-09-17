import { promises as fs } from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'
import type { Book } from '@shared/book.types'
import type { Device } from '@shared/device.types'
import * as db from './db'
import { broadcast } from './events'
import { isMobiFamily, readEmbeddedIdentity } from './mobi-header'
import { sanitizeTitle } from './sanitize'

const POLL_INTERVAL_MS = 5_000
const VOLUMES = '/Volumes'
const MAX_SCAN_DEPTH = 2

/**
 * How many device files have their header read at once. The mount is
 * latency-bound, not throughput-bound — one read per file costs ~400ms whether
 * or not other reads are in flight, so this bounds how long a cold pass takes
 * without pretending more parallelism would help (12 workers measured the same
 * as 8 on a real Kindle).
 */
const KEY_WORKERS = 8

/** Identities that land before the renderer is told presence moved. */
const IDENTITY_BATCH = 100

const devices = new Map<string, Device>()
/** deviceId → (lowercased file stem → absolute paths of the files with it). */
const deviceContents = new Map<string, Map<string, string[]>>()
/** deviceId → (path → what that file says about itself). Derived; rebuilt per connect. */
const deviceIdentities = new Map<string, Map<string, db.DeviceFileIdentityRecord>>()
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
  scheduleKeyPass(deviceId)
}

// --- Reading what the files on a device say about themselves ---

/** deviceId → the pass currently reading it. */
const keyPasses = new Map<string, Promise<void>>()
/** Devices whose contents moved while their pass was running. */
const keyPassQueued = new Set<string>()

/**
 * Read the books' own headers, in the background, after the scan that found
 * them.
 *
 * Deliberately not part of the scan. A cold pass measures ~72s on a real Kindle
 * — one `open` per file, the mount's per-file latency rather than the bytes —
 * and the scan runs on the 5s `/Volumes` poll, on connect, and on every send.
 * So the poll stays readdir-only (its job is to notice the file set moved), the
 * headers are read behind it by a bounded pool, and presence is allowed to
 * settle: the renderer recomputes on `deviceContentsChanged`, which is
 * broadcast as batches land.
 *
 * A running pass is never restarted; a change that arrives mid-pass re-runs it
 * once afterwards, because the second pass is the one that sees the file that
 * was just written.
 */
function scheduleKeyPass(deviceId: string): void {
  if (keyPasses.has(deviceId)) {
    keyPassQueued.add(deviceId)
    return
  }
  const pass = runKeyPass(deviceId)
    .catch((err: unknown) => {
      // Best-effort by design: the device can be unplugged mid-pass, and a
      // failed read costs a book its content rule, not its presence
      console.error(`[device] reading ${deviceId} headers failed:`, err)
    })
    .finally(() => {
      keyPasses.delete(deviceId)
      if (keyPassQueued.delete(deviceId)) scheduleKeyPass(deviceId)
    })
  keyPasses.set(deviceId, pass)
}

async function runKeyPass(deviceId: string): Promise<void> {
  const device = getDevice(deviceId)
  if (!device) return
  const candidates = [...(deviceContents.get(deviceId)?.values() ?? [])]
    .flat()
    .filter(isMobiFamily)
  if (!candidates.length) return

  const known = deviceIdentities.get(deviceId) ?? new Map<string, db.DeviceFileIdentityRecord>()
  deviceIdentities.set(deviceId, known)

  // A file that left the device must leave the reading too: this map is what
  // presence matches against, so a stale entry would keep claiming a book that
  // is no longer there
  const enumerated = new Set(candidates)
  for (const path of [...known.keys()]) if (!enumerated.has(path)) known.delete(path)

  // The cache is a report about files by path and version, so a file that was
  // replaced under the same name is read again rather than believed
  const cached = db.getDeviceFileIdentities(candidates)

  let next = 0
  let landed = 0
  let announced = 0
  const toWrite: db.DeviceFileIdentityRecord[] = []

  const flush = (): void => {
    if (toWrite.length) db.putDeviceFileIdentities(toWrite.splice(0))
  }
  const announce = (): void => {
    if (landed === announced) return
    announced = landed
    broadcast('deviceContentsChanged', deviceId)
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (!devices.has(deviceId)) return
      const path = candidates[next++]
      if (!path) return

      const read = await readKey(path, cached.get(path))
      if (read) {
        known.set(path, read.record)
        if (read.fresh) toWrite.push(read.record)
        // Only a title can move presence — a file we read and found nothing in
        // (a KFX stub, an odd header) changed no answer, so it is not news
        if (read.record.title) landed++
        if (landed - announced >= IDENTITY_BATCH) {
          flush()
          announce()
        }
      }
    }
  }

  await Promise.all(Array.from({ length: KEY_WORKERS }, () => worker()))
  flush()
  announce()

  pruneKeyCache(deviceId, candidates)
}

/**
 * One file's identity, and whether it had to be read to get it.
 *
 * `null` means the file could not be stat'd — it is gone, or the volume went
 * away mid-pass. A file that stats but cannot be parsed is recorded with a
 * `null` title instead, so it is not re-opened on every connect; the filename
 * rule is all it offers either way. A file that stats and then *fails to read*
 * is recorded as neither: `readEmbeddedIdentity` throws on an I/O error, this
 * returns `null`, and the next pass reads it again rather than believing the
 * failure was a fact about the book.
 */
async function readKey(
  path: string,
  cached: db.DeviceFileIdentityRecord | undefined
): Promise<{ record: db.DeviceFileIdentityRecord; fresh: boolean } | null> {
  try {
    const stats = await fs.stat(path)
    const mtimeMs = Math.floor(stats.mtimeMs)
    if (cached && cached.size === stats.size && cached.mtimeMs === mtimeMs) {
      return { record: cached, fresh: false }
    }
    const identity = await readEmbeddedIdentity(path)
    return {
      record: {
        path,
        size: stats.size,
        mtimeMs,
        title: identity?.title ?? null,
        author: identity?.author ?? null,
        uuid: identity?.uuid ?? null,
        cdetype: identity?.cdetype ?? null
      },
      fresh: true
    }
  } catch {
    return null
  }
}

/**
 * Drop cached rows for files this device no longer has. A row is keyed by
 * absolute path, so a file renamed on the device would otherwise keep its entry
 * forever.
 *
 * Skipped for a pass that enumerated nothing: an empty file list is also what a
 * volume mid-unmount looks like, and throwing the cache away there would cost a
 * full ~72s re-read on the next connect for no reason.
 */
function pruneKeyCache(deviceId: string, candidates: string[]): void {
  if (!candidates.length) return
  const device = getDevice(deviceId)
  if (!device) return
  const present = new Set(candidates)
  const stale = db
    .deviceFileIdentityPathsUnder(`${join(device.mountPath, 'documents')}/`)
    .filter((path) => !present.has(path))
  if (stale.length) db.deleteDeviceFileIdentities(stale)
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

/** The key a library title and a file's own title are compared under. */
export function titleKey(title: string): string {
  return sanitizeTitle(title).toLowerCase()
}

/**
 * An author as a comparison key: case, punctuation and *word order* gone, so
 * `Banks, Iain M.` and `Iain M. Banks` are one author.
 *
 * Order is the whole point. The two sides are written by different tools — the
 * library says "Iain M. Banks", Calibre's EXTH 100 for the same book says
 * "Banks, Iain M." — and an author that fails to match costs the book the
 * title+author rule, leaving it present only where its title happens to be
 * unique in the library (rule 2).
 */
export function authorKey(author: string): string {
  return sanitizeTitle(author)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ')
}

/** A device file's title-and-author, as the match rule needs to see it. */
interface DeviceFile {
  path: string
  author: string | null
}

/** Both sides of the match: what the library holds, and what the device says. */
interface DeviceLibrary {
  /** titleKey → how many library books carry that title. */
  titleCounts: Map<string, number>
  /** titleKey → the device files whose own title normalizes to it. */
  files: Map<string, DeviceFile[]>
}

/**
 * The device files that carry this book, by the design's match rule.
 *
 * `uniqueTitle` is the guard against the one direction this rule can lie in: a
 * false positive makes the badge claim a book that is on the device when a
 * different book is. When exactly one library book has this normalized title,
 * any file carrying that title is it; when two books share the title the file
 * has to say *which* one, and it does that with its author — so a file that
 * carries no author is taken as neither of them. A re-send costs one copy; a
 * false positive costs trust in the count.
 */
function filesCarryingBook(book: Book, device: DeviceLibrary): string[] {
  const key = titleKey(book.title)
  const files = device.files.get(key) ?? []
  if (!files.length) return []
  if (device.titleCounts.get(key) === 1) return files.map((f) => f.path)
  const author = book.author ? authorKey(book.author) : null
  if (!author) return []
  return files.filter((f) => f.author && authorKey(f.author) === author).map((f) => f.path)
}

/**
 * What a device says about itself, keyed the way the match rule compares it.
 * Files whose own title could not be read are absent here: the filename rule is
 * all they offer, and C/KFX files stay that way.
 *
 * Only files the current scan still holds are in here. The header pass prunes
 * too, but it runs *behind* the scan, and in between a file that was removed —
 * by the user, or on the device itself — would otherwise keep claiming a book
 * that is no longer there. Presence is `f(scan, headers)`, and the scan half
 * decides what exists.
 */
function deviceLibrary(deviceId: string, books: Book[], present: Set<string>): DeviceLibrary {
  const files = new Map<string, DeviceFile[]>()
  for (const key of deviceIdentities.get(deviceId)?.values() ?? []) {
    if (!key.title || !present.has(key.path)) continue
    const title = titleKey(key.title)
    const carrying = files.get(title)
    if (carrying) carrying.push({ path: key.path, author: key.author })
    else files.set(title, [{ path: key.path, author: key.author }])
  }

  const titleCounts = new Map<string, number>()
  for (const book of books) {
    const title = titleKey(book.title)
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
  }
  return { titleCounts, files }
}

/**
 * Book IDs the device holds.
 *
 * Three readings, and a book is present under any of them: the filename rule
 * (what Musaeum writes itself, plus the names of files we sent under a title
 * that has since moved), the title *and* author inside the file, and the
 * title inside the file alone where the library holds exactly one book with
 * that title.
 *
 * The middle pair is why this reaches a device another tool filled: matching
 * the title each file carries inside it reaches 1,343 of 1,555 files on the
 * measured Kindle, against 86 for the name alone.
 *
 * The identities arrive asynchronously — a cold device takes ~72s to read
 * through, so this answers with whatever has landed and the pass broadcasts
 * `deviceContentsChanged` as it goes, which is the event the renderer already
 * recomputes presence on.
 */
export function getOnDeviceBookIds(deviceId: string): string[] {
  const stems = deviceContents.get(deviceId)
  if (!stems || stems.size === 0) return []

  const books = db.getBooks()
  const device = deviceLibrary(deviceId, books, new Set([...stems.values()].flat()))

  const ids: string[] = []
  for (const book of books) {
    if (
      stems.has(titleKey(book.title)) ||
      holdsFileWeSent(deviceId, book.id, stems) ||
      filesCarryingBook(book, device).length > 0
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
  const stems = new Set([titleKey(title)])
  for (const name of sentFiles.get(deviceId)?.get(bookId) ?? []) stems.add(fileStem(name))
  return [...stems]
}

/**
 * Delete these files from a connected device, together with each one's `._`
 * AppleDouble sibling (macOS writes these onto the FAT volume) and its
 * `{book}.sdr` folder — matching what deleting from the Kindle itself does.
 * Reading position and annotations go with the `.sdr`.
 */
export async function removeFilesAt(mountPath: string, paths: string[]): Promise<number> {
  const documentsDir = resolve(join(mountPath, 'documents'))

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
 * Delete every file under {mountPath}/documents/ whose stem matches.
 *
 * Rescans rather than trusting the cached contents: that cache is up to one
 * poll interval stale, and a file added since the last scan has to go too or
 * the book stays "on device" after a successful removal.
 */
export async function removeFilesWithStem(mountPath: string, stem: string): Promise<number> {
  return removeFilesAt(mountPath, (await scanDocuments(mountPath)).get(stem) ?? [])
}

/**
 * Delete a book's files from a connected device.
 *
 * The book is located the same way presence is — by sanitized title against the
 * scan's file stems, by the names of files we sent it under a previous title,
 * and by the title and author inside each file — so this removes exactly what
 * made it read as "on device", and nothing a rename or a coincidence could have
 * pointed at. The content half is what lets a book Calibre wrote come off at
 * all: presence says "On {device}" for it, and without this the app would
 * refuse to remove a book it claims is there.
 *
 * Ambiguity follows the match rule, so a title two library books share removes
 * the file that made either of them read as present.
 */
export async function removeBookFromDevice(
  bookId: string,
  deviceId: string
): Promise<{ removed: number }> {
  const device = getDevice(deviceId)
  if (!device) throw new Error('Device is not connected')
  const book = db.getBook(bookId)
  if (!book) throw new Error('Book not found')

  // One rescan for both halves, taken before either is applied: the contents
  // cache is up to a poll interval stale, and a file added since it was taken
  // would otherwise survive and keep the book reading as "on device"
  const scanned = await scanDocuments(device.mountPath)
  const present = new Set([...scanned.values()].flat())

  const targets = new Set<string>()
  for (const stem of stemsForBook(deviceId, bookId, book.title)) {
    for (const path of scanned.get(stem) ?? []) targets.add(path)
  }
  // The identity cache can name a file the device no longer has; the library
  // half only ever holds what the scan above found
  const books = db.getBooks()
  for (const path of filesCarryingBook(book, deviceLibrary(deviceId, books, present))) {
    targets.add(path)
  }

  const removed = await removeFilesAt(device.mountPath, [...targets])
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
        // The file set moved, so the headers behind it may have too. This is
        // the only thing the poll does about identities: it never reads one.
        scheduleKeyPass(id)
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
      scheduleKeyPass(id)
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
        // What the files said about themselves was read over this connection,
        // and so was the volume they were read from
        deviceIdentities.delete(id)
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
