import { promises as fs } from 'fs'
import { join } from 'path'
import { nativeImage } from 'electron'
import { readEmbeddedIdentity } from './mobi-header'

/**
 * The Kindle's cover cache, written by the app.
 *
 * The device stopped generating these for itself — measured 2026-09-17, against
 * 1,567 files on a real Kindle: of the 91 books copied since Calibre's last
 * connect, none got a cover, and every attempt left a 0-byte
 * `…_portrait.jpg.tmp.partial` behind. So a send has to write the entry itself.
 * Three facts decide this module's shape, and all three are measured:
 *
 * - **The entry is named after the file, not the book.** The device looks up
 *   `thumbnail_<EXTH 113>_<EXTH 501>_portrait.jpg`, keyed by the identity *inside*
 *   the file it holds. One book sent in two formats carries two uuids (measured
 *   on *Red Rising*: `5f8e82e4…` as azw3, `1b3e27dc…` as mobi), so the identity
 *   is read out of the file whose bytes were copied.
 * - **The jacket is fitted, never stretched.** Electron's `resize` scales both
 *   dimensions when it is handed both — measured, a 1:1.336 jacket forced into
 *   the 330×500 box loses ~13 % of its width — so only the binding dimension is
 *   passed and the aspect is left alone.
 * - **A stale marker hides an entry that is already there.** 148 books on that
 *   device were carrying a cover a 0-byte marker was hiding, and the device
 *   leaves one whenever it tries and fails to draw its own. So the marker beside
 *   the name we are about to write is deleted first — and *only* that one. This
 *   is the app's second path that deletes files on a mounted device; the first
 *   one already deleted a real file off a real Kindle from a passing test run.
 *
 * Two callers write entries, and they differ in exactly one place: **where the
 * name comes from.** A send reads the identity out of the file whose bytes were
 * just verified (`writeDeviceCover`); the connect pass takes the identity the
 * header pass already read and cached for each file on the device, because
 * reading it again would be an `open` per file — a cold device measures ~72 s of
 * those, and the pass adds none (`fillDeviceCovers`). Everything after the name
 * is one path: the same fitted encode, the same marker rule, the same write.
 *
 * Nothing here throws (invariant 12). A missing cover is a cosmetic device-side
 * cache miss: it must never fail a send, and it must never reach the screen.
 */

/**
 * The device's own entry shape — ~330×500, 22–47 KB, measured 2026-09-17 and
 * re-measured against three real jackets on 2026-09-26 (24,211 / 29,204 /
 * 37,370 B). It is a box, not a target: the aspect is preserved inside it, so a
 * 2:3 jacket lands at 330×495 and a 1:1.336 one at 330×441.
 */
export const DEVICE_COVER_BOX = { width: 330, height: 500 } as const

/** Lands in the device's measured byte band on real jackets. */
const JPEG_QUALITY = 85

/**
 * How many books have their jacket encoded at once during a connect pass.
 *
 * The same bound the header pass uses (`device-manager.ts`'s `KEY_WORKERS`), and
 * for the same reason: what these workers are waiting on is the share's
 * per-file latency, not its throughput, so a wider pool buys nothing.
 */
const COVER_WORKERS = 8

/** What the device leaves beside an entry when it fails to generate its own. */
export const COVER_MARKER_SUFFIX = '.tmp.partial'

/** `system/thumbnails`, under the mount point. */
export function thumbnailsDir(mountPath: string): string {
  return join(mountPath, 'system', 'thumbnails')
}

/** The name the device looks the entry up under. */
export function deviceCoverName(uuid: string, cdetype: string): string {
  return `thumbnail_${uuid}_${cdetype}_portrait.jpg`
}

/**
 * The size a source is written at: fitted into the box, never upscaled.
 *
 * A book whose jacket is already smaller than the box is written at its own
 * size — an upscaled entry would be a worse picture carrying the same bytes
 * count, and the device renders either.
 */
export function deviceCoverSize(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(DEVICE_COVER_BOX.width / width, DEVICE_COVER_BOX.height / height, 1)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

export type CoverEncoder = (coverPath: string) => Buffer | null

/**
 * Encode a jacket into the device's entry.
 *
 * The binding dimension is the only one passed: `resize({ width, height })`
 * scales both, which squashes any jacket that is not the box's aspect.
 */
function encodeWithNativeImage(coverPath: string): Buffer | null {
  const image = nativeImage.createFromPath(coverPath)
  if (image.isEmpty()) return null

  const { width, height } = image.getSize()
  if (!width || !height) return null

  const fitted = deviceCoverSize(width, height)
  const scale = Math.min(DEVICE_COVER_BOX.width / width, DEVICE_COVER_BOX.height / height)
  let resized = image
  if (scale < 1) {
    resized =
      DEVICE_COVER_BOX.width / width <= DEVICE_COVER_BOX.height / height
        ? image.resize({ width: fitted.width, quality: 'good' })
        : image.resize({ height: fitted.height, quality: 'good' })
  }

  const jpeg = resized.toJPEG(JPEG_QUALITY)
  return jpeg.length ? jpeg : null
}

let encodeCover: CoverEncoder = encodeWithNativeImage

/**
 * Replace the codec. **Tests only.**
 *
 * `npm test` runs Electron-as-Node, so `nativeImage` does not exist there and
 * the real codec cannot run. Rather than mock this module — which would take the
 * naming, the marker and the write with it — a test swaps the codec and leaves
 * everything else real. The codec's own behaviour is decided by
 * `scripts/device-cover-probe.ts`, which runs under a real Electron against the
 * shipped function.
 */
export function setCoverEncoderForTests(encoder: CoverEncoder | null): void {
  encodeCover = encoder ?? encodeWithNativeImage
}

/**
 * The jacket as entry bytes, or `null` when there are none.
 *
 * A codec that is missing or blows up is a warning, never a throw: it is the
 * one surprise in this module's encode step, and slice 1's send path has
 * reported it exactly this way since it shipped. A jacket that is simply not
 * there (`nativeImage` answers an empty image) is ordinary and silent.
 *
 * Handed the *bytes*, the callers decide how often this runs: a send encodes
 * once, a connect pass encodes once per book however many files that book has
 * on the device.
 */
function encodeEntry(coverPath: string): Buffer | null {
  try {
    const bytes = encodeCover(coverPath)
    return bytes?.length ? bytes : null
  } catch (err) {
    console.warn(`[device] cannot encode the cover at ${coverPath}:`, err)
    return null
  }
}

export interface CoverWriteInput {
  /** The mounted device. */
  mountPath: string
  /** The file whose bytes were just verified onto the device. */
  sourceFile: string
  /** The book's jacket on the share, or null when the book has none. */
  coverPath: string | null
}

/** Why a send wrote nothing. Both are ordinary, and neither is an error. */
export type CoverSkipReason = 'identity' | 'cover' | 'encode'

export type CoverWriteResult =
  | { ok: true; name: string; bytes: number; markerCleared: boolean }
  | { ok: false; kind: 'skipped'; reason: CoverSkipReason }
  | { ok: false; kind: 'failed'; reason: string }

/**
 * Write one entry, given the name the device will look it up under.
 *
 * The whole of the write, shared by the send and the connect pass. Two rules
 * live here and nowhere else:
 *
 * - **The only file deleted is `<this entry>.tmp.partial`** — the exact name
 *   being written, because its absence is a precondition of our own write. No
 *   sweep, no heuristic: a stray marker for an entry we are not writing is left
 *   where it is.
 * - **The marker goes before the entry**, so a write that fails afterwards has
 *   at least unhidden whatever was already there.
 */
async function writeEntry(dir: string, name: string, bytes: Buffer): Promise<CoverWriteResult> {
  try {
    await fs.mkdir(dir, { recursive: true })
    const markerCleared = await fs
      .unlink(join(dir, name + COVER_MARKER_SUFFIX))
      .then(() => true)
      .catch(() => false)
    await fs.writeFile(join(dir, name), bytes)
    return { ok: true, name, bytes: bytes.length, markerCleared }
  } catch (err) {
    return { ok: false, kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Write the device's cover entry for a file that has just landed on it.
 *
 * Returns a result rather than throwing, for every cause: no identity in the
 * file to name an entry with, no jacket on the book, a jacket that cannot be
 * encoded, and a device that refuses the write.
 */
export async function writeDeviceCover(input: CoverWriteInput): Promise<CoverWriteResult> {
  const identity = await readEmbeddedIdentity(input.sourceFile).catch(() => null)
  if (!identity?.uuid || !identity.cdetype)
    return { ok: false, kind: 'skipped', reason: 'identity' }
  if (!input.coverPath) return { ok: false, kind: 'skipped', reason: 'cover' }

  const bytes = encodeEntry(input.coverPath)
  if (!bytes) return { ok: false, kind: 'skipped', reason: 'encode' }

  return writeEntry(
    thumbnailsDir(input.mountPath),
    deviceCoverName(identity.uuid, identity.cdetype),
    bytes
  )
}

// --- The connect pass: the entries the device's own library is missing ---

/** One file on the device, and the book the library attributes it to. */
export interface DeviceCoverOwner {
  /** The file on the device. */
  path: string
  /** The library book that file carries. */
  bookId: string
  /** EXTH 113, read off that file's header and cached by the identity pass. */
  uuid: string | null
  /** EXTH 501, from the same reading. */
  cdetype: string | null
}

export interface FillDeviceCoversInput {
  /** The mounted device. */
  mountPath: string
  /** What the device holds and which book each file carries (`deviceFileOwners`). */
  owners: DeviceCoverOwner[]
  /**
   * The book's jacket on the share, or null when there is none to read — no
   * path, or the library is not reachable right now. Asked **once per book**.
   */
  coverPathFor: (bookId: string) => string | null
}

/**
 * What one pass did.
 *
 * Every count is per *file* except `jackets`, which is per book: the difference
 * between the two is the pass's own cost (a book sent in two formats is one
 * jacket read and two entries). `unnamed` and `coverless` are ordinary — a PDF
 * has no identity to name an entry with and a book the library never gave a
 * jacket has none to write — and `failed` is the only count that means
 * something went wrong.
 */
export interface CoverPassReport {
  /** Entries written this pass. */
  written: number
  /** Files that wanted an entry and already had one. */
  present: number
  /** Files an entry cannot be named for: no cached identity, or two books claiming it. */
  unnamed: number
  /** Files whose book has no jacket to write. */
  coverless: number
  /** Entries that could not be produced or written. */
  failed: number
  /** Jackets read and encoded — one per book, not one per file. */
  jackets: number
}

/**
 * Fill in the cover entries for the files a device already holds.
 *
 * Runs behind the identity pass (`device-manager`'s `runKeyPass`), because its
 * input is what that pass caches: every file's own EXTH 113/501. **It reads
 * nothing off the device** — one `readdir` of `system/thumbnails/`, no stats and
 * no opens — and it re-derives no matching: which file carries which book is
 * `deviceFileOwners`'s answer, and this function only decides which of those
 * files can be *named* and which of them the device cannot already show.
 *
 * Four rules, and each is the reading of a measurement:
 *
 * - **A name already in the cache means the device has the entry.** One
 *   directory listing decides it, so a second connect is a `readdir` and no
 *   writes — that is what makes the pass idempotent.
 * - **A file two books claim gets no entry.** Presence is allowed to answer both
 *   (`getOnDeviceBookIds` does, on the same inputs); a *jacket*, chosen between
 *   two books, is a jacket on the wrong one. Ambiguity is refused, exactly as the
 *   match rule refuses a file that names no book at all.
 * - **A book's jacket is read once**, however many of its files are on the
 *   device — one encode, then one write per entry name.
 * - **Nothing here throws.** A jacket that cannot be read, a device that refuses
 *   every write: each is counted and the pass returns (invariant 12).
 */
export async function fillDeviceCovers(input: FillDeviceCoversInput): Promise<CoverPassReport> {
  const report: CoverPassReport = {
    written: 0,
    present: 0,
    unnamed: 0,
    coverless: 0,
    failed: 0,
    jackets: 0
  }
  const dir = thumbnailsDir(input.mountPath)

  // One readdir, no stats: whether the device can already show an entry is one
  // name in this list. A cache directory that does not exist is a device that
  // holds no entries, which is the first pass's own case.
  const cached = new Set(await fs.readdir(dir).catch((): string[] => []))

  // The file→book pairs, gathered by file, so a file the library attributes to
  // two books can be recognised as ambiguous before anything is written
  const byPath = new Map<string, DeviceCoverOwner[]>()
  for (const owner of input.owners) {
    const claims = byPath.get(owner.path)
    if (claims) claims.push(owner)
    else byPath.set(owner.path, [owner])
  }

  /** entry name → the one file whose identity names it. */
  const wanted = new Map<string, DeviceCoverOwner>()
  for (const claims of byPath.values()) {
    const owner = claims[0]
    if (claims.length > 1 && claims.some((claim) => claim.bookId !== owner.bookId)) {
      report.unnamed++
      continue
    }
    if (!owner.uuid || !owner.cdetype) {
      report.unnamed++
      continue
    }
    const name = deviceCoverName(owner.uuid, owner.cdetype)
    if (cached.has(name)) {
      report.present++
      continue
    }
    // Two files can share a name — the duplicate send this device has already
    // been measured carrying — and the entry is the identity's, so it is one entry
    wanted.set(name, owner)
  }

  /** bookId → the entry names its files need. One jacket, however many names. */
  const byBook = new Map<string, string[]>()
  for (const [name, owner] of wanted) {
    const names = byBook.get(owner.bookId)
    if (names) names.push(name)
    else byBook.set(owner.bookId, [name])
  }

  const books = [...byBook.keys()]
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const bookId = books[next++]
      if (!bookId) return
      const names = byBook.get(bookId)!
      const coverPath = input.coverPathFor(bookId)
      const bytes = coverPath ? encodeEntry(coverPath) : null
      if (!bytes) {
        report.coverless += names.length
        continue
      }
      report.jackets++
      for (const name of names) {
        const result = await writeEntry(dir, name, bytes)
        if (result.ok) report.written++
        else report.failed++
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(COVER_WORKERS, books.length) }, () => worker()))
  return report
}
