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

  let bytes: Buffer | null
  try {
    bytes = encodeCover(input.coverPath)
  } catch (err) {
    console.warn(`[device] cannot encode the cover at ${input.coverPath}:`, err)
    return { ok: false, kind: 'skipped', reason: 'encode' }
  }
  if (!bytes?.length) return { ok: false, kind: 'skipped', reason: 'encode' }

  const name = deviceCoverName(identity.uuid, identity.cdetype)
  const dir = thumbnailsDir(input.mountPath)
  try {
    await fs.mkdir(dir, { recursive: true })
    // Before the write, and only this one: the marker suppresses an entry the
    // device would otherwise render, and a write that fails after this has at
    // least unhidden whatever was already there
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
