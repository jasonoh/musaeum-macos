import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mobiFile } from '../../../test/helpers/mobi'
import {
  COVER_MARKER_SUFFIX,
  deviceCoverSize,
  fillDeviceCovers,
  setCoverEncoderForTests,
  thumbnailsDir,
  writeDeviceCover,
  type DeviceCoverOwner
} from './device-covers'

/**
 * The codec is the one thing here that cannot run under vitest — `electron` is
 * aliased to an inert mock and `nativeImage` does not exist (see
 * `test/mocks/electron.ts`). Everything *else* is real: the identity is read out
 * of a real MOBI fixture by the shipped parser, the name is the shipped rule,
 * and the marker and the entry are written to a real filesystem. The codec's own
 * behaviour — the fitted size, the byte band — is decided by
 * `scripts/device-cover-probe.ts` under a real Electron.
 */

const UUID = '5f8e82e4-671f-46b8-9d7c-808c2755dc8b'
const CDETYPE = 'EBOK'
/**
 * The device's rule, spelled out. **Not** `deviceCoverName(UUID, CDETYPE)`: the
 * shape of this name is an external fact — the device looks the entry up under
 * it and nothing else — and an expectation derived from the function under test
 * cannot see a swapped argument order. The campaign caught exactly that.
 */
const NAME = 'thumbnail_5f8e82e4-671f-46b8-9d7c-808c2755dc8b_EBOK_portrait.jpg'
const OTHER_NAME = 'thumbnail_1b3e27dc-8ba1-4c74-9920-838a02c3c444_EBOK_portrait.jpg'
/** Whatever the codec returns is what must land on the device, byte for byte. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

let mount: string
let bookDir: string
let sourceFile: string
let coverPath: string

/** The entries the device's cache holds, if the directory exists at all. */
async function entries(): Promise<string[]> {
  return fs.readdir(thumbnailsDir(mount)).catch(() => [])
}

beforeEach(async () => {
  mount = mkdtempSync(join(tmpdir(), 'musaeum-mount-'))
  bookDir = mkdtempSync(join(tmpdir(), 'musaeum-book-'))
  sourceFile = join(bookDir, 'Fixture Codex.azw3')
  await fs.writeFile(sourceFile, mobiFile({ title: 'Fixture Codex', uuid: UUID, cdetype: CDETYPE }))
  coverPath = join(bookDir, 'cover_full.jpg')
  await fs.writeFile(coverPath, 'not an image — the codec is injected')
  setCoverEncoderForTests(() => JPEG)
})

afterEach(() => {
  setCoverEncoderForTests(null)
  rmSync(mount, { recursive: true, force: true })
  rmSync(bookDir, { recursive: true, force: true })
})

describe('the entry’s name', () => {
  it('is built from the identity inside the file that was copied', async () => {
    const result = await writeDeviceCover({ mountPath: mount, sourceFile, coverPath })

    expect(result).toEqual({ ok: true, name: NAME, bytes: JPEG.length, markerCleared: false })
    // The device looks the entry up by this name and no other, so the name is
    // asserted on the filesystem rather than on the return value alone
    expect(await entries()).toEqual([NAME])
    expect(await fs.readFile(join(thumbnailsDir(mount), NAME))).toEqual(JPEG)
  })

  it('is the file’s, not the book’s — one book, two formats, two entries', async () => {
    const mobi = join(bookDir, 'Fixture Codex.mobi')
    await fs.writeFile(mobi, mobiFile({ title: 'Fixture Codex', uuid: UUID, cdetype: CDETYPE }))
    // The same book, converted: a conversion writes its own uuid, and that is
    // the identity the device will look the second entry up under
    const azw3 = join(bookDir, 'Fixture Codex2.azw3')
    const otherUuid = '1b3e27dc-8ba1-4c74-9920-838a02c3c444'
    await fs.writeFile(
      azw3,
      mobiFile({ title: 'Fixture Codex', uuid: otherUuid, cdetype: CDETYPE })
    )

    await writeDeviceCover({ mountPath: mount, sourceFile: mobi, coverPath })
    await writeDeviceCover({ mountPath: mount, sourceFile: azw3, coverPath })

    const written = await entries()
    expect(written).toHaveLength(2)
    expect(written).toContain(NAME)
    expect(written).toContain(OTHER_NAME)
  })

  it('writes nothing at all when the file carries no identity to name one with', async () => {
    // A PDF send is the ordinary case: nothing in it to name an entry after
    const pdf = join(bookDir, 'Fixture Codex.pdf')
    await fs.writeFile(pdf, '%PDF-1.4 not a MOBI header')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await writeDeviceCover({ mountPath: mount, sourceFile: pdf, coverPath })

    expect(result).toEqual({ ok: false, kind: 'skipped', reason: 'identity' })
    expect(await entries()).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('writes nothing when the identity is half-read', async () => {
    // Every real file measured carries both keys (4/4 on 2026-09-26), so this is
    // the defensive arm: a name the device would never look up is not written
    const half = join(bookDir, 'Half.azw3')
    await fs.writeFile(half, mobiFile({ title: 'Fixture Codex', uuid: UUID }))

    expect(await writeDeviceCover({ mountPath: mount, sourceFile: half, coverPath })).toEqual({
      ok: false,
      kind: 'skipped',
      reason: 'identity'
    })
    expect(await entries()).toEqual([])
  })
})

describe('the entry’s bytes', () => {
  it('fits a jacket into the device’s box, preserving its aspect', () => {
    // The box is 330×500 — 1:1.515 — so a 2:3 jacket uses its width and leaves
    // five pixels of height unused. Fitting is the rule; forcing both dimensions
    // would stretch (measured: ~13 % on a 1:1.336 jacket).
    expect(deviceCoverSize(600, 900)).toEqual({ width: 330, height: 495 })
    expect(deviceCoverSize(512, 684)).toEqual({ width: 330, height: 441 })
    expect(deviceCoverSize(1200, 900)).toEqual({ width: 330, height: 248 })
  })

  it('never upscales a jacket smaller than the box', () => {
    expect(deviceCoverSize(200, 300)).toEqual({ width: 200, height: 300 })
    expect(deviceCoverSize(100, 100)).toEqual({ width: 100, height: 100 })
  })

  it('refuses a degenerate size rather than dividing by it', () => {
    expect(deviceCoverSize(0, 900)).toEqual({ width: 0, height: 0 })
    expect(deviceCoverSize(600, 0)).toEqual({ width: 0, height: 0 })
  })

  it('hands the codec the jacket and writes exactly what it returned', async () => {
    const encode = vi.fn(() => JPEG)
    setCoverEncoderForTests(encode)

    await writeDeviceCover({ mountPath: mount, sourceFile, coverPath })

    expect(encode).toHaveBeenCalledWith(coverPath)
    expect(await entries()).toEqual([NAME])
  })

  it('skips a jacket the codec cannot produce, and does not create the cache', async () => {
    setCoverEncoderForTests(() => null)

    expect(await writeDeviceCover({ mountPath: mount, sourceFile, coverPath })).toEqual({
      ok: false,
      kind: 'skipped',
      reason: 'encode'
    })
    expect(await entries()).toEqual([])
  })

  it('skips (rather than throws) a codec that blows up', async () => {
    // The real codec cannot run under vitest, so this is also the case that
    // exercises the loud mock: `setCoverEncoderForTests(null)` restores it
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setCoverEncoderForTests(null)

    expect(await writeDeviceCover({ mountPath: mount, sourceFile, coverPath })).toEqual({
      ok: false,
      kind: 'skipped',
      reason: 'encode'
    })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot encode the cover'),
      expect.objectContaining({ message: expect.stringContaining('nativeImage') })
    )
    expect(await entries()).toEqual([])
  })

  it('skips a book with no jacket, and writes nothing to the device for it', async () => {
    expect(await writeDeviceCover({ mountPath: mount, sourceFile, coverPath: null })).toEqual({
      ok: false,
      kind: 'skipped',
      reason: 'cover'
    })
    expect(await entries()).toEqual([])
  })
})

describe('the marker that hides a written entry', () => {
  it('is deleted, and reported, when it is there', async () => {
    // 148 books on the measured Kindle were carrying a cover a 0-byte marker was
    // hiding, and the device leaves one every time it tries and fails to draw
    // its own — so an entry written beside a marker is an entry nobody sees
    await fs.mkdir(thumbnailsDir(mount), { recursive: true })
    const marker = join(thumbnailsDir(mount), NAME + COVER_MARKER_SUFFIX)
    await fs.writeFile(marker, '')

    const result = await writeDeviceCover({ mountPath: mount, sourceFile, coverPath })

    expect(result).toEqual({ ok: true, name: NAME, bytes: JPEG.length, markerCleared: true })
    expect(await entries()).toEqual([NAME])
  })

  it('leaves every other file in the cache alone', async () => {
    // This is the app's second path that deletes files on a mounted device, and
    // the first one already deleted a real file off a real Kindle from a passing
    // test run: the deletion is one exact name, never a sweep
    await fs.mkdir(thumbnailsDir(mount), { recursive: true })
    const foreign = ['someone_else_EBOK_portrait.jpg', 'thumbnail_stale_EBOK_portrait.jpg'].concat([
      'another_book_EBOK_portrait.jpg.tmp.partial'
    ])
    for (const name of foreign) await fs.writeFile(join(thumbnailsDir(mount), name), 'x')

    await writeDeviceCover({ mountPath: mount, sourceFile, coverPath })

    expect((await entries()).sort()).toEqual([...foreign, NAME].sort((a, b) => a.localeCompare(b)))
  })
})

describe('a device that will not take the write', () => {
  it('reports it rather than throwing, and reports it as a failure', async () => {
    // `system` is a file, so the cache directory cannot be created. The send that
    // called this must still land (invariant 12), which is why the result is a
    // value and the reason is the filesystem's own words
    await fs.writeFile(join(mount, 'system'), 'not a directory')

    const result = await writeDeviceCover({ mountPath: mount, sourceFile, coverPath })

    if (result.ok) throw new Error(`expected a refusal, got ${result.name}`)
    expect(result.kind).toBe('failed')
    expect(result.reason).toMatch(/ENOTDIR|EEXIST|not a directory/)
  })
})

/**
 * The connect pass: the entries for the files a device already holds.
 *
 * Everything here is real except the codec — the cache is a real directory, the
 * names are the shipped rule, and the owners are shaped exactly as
 * `deviceFileOwners` produces them (that view is decided in
 * `device-manager.test.ts`; this file decides what the pass does with it). The
 * one thing this suite *cannot* decide is whether a jacket read off the share
 * produces the right pixels; that is `scripts/device-cover-probe.ts`, which runs
 * the shipped writer under a real Electron.
 */
describe('the connect pass', () => {
  const OTHER_UUID = '1b3e27dc-8ba1-4c74-9920-838a02c3c444'

  /** An owner row as `deviceFileOwners` produces one. */
  function owner(
    path: string,
    bookId: string,
    uuid: string | null = UUID,
    cdetype: string | null = CDETYPE
  ): DeviceCoverOwner {
    return { path, bookId, uuid, cdetype }
  }

  /** The cache as a sorted list, so an ordering fact cannot hide a wrong set. */
  async function cache(): Promise<string[]> {
    return (await entries()).sort()
  }

  it('writes one entry per file, and reads the book’s jacket once (AC11)', async () => {
    // One book, two formats: two identities, so two entries — and one jacket,
    // because the share's latency is the pass's cost rather than the device's
    const cover = vi.fn(() => coverPath)

    const report = await fillDeviceCovers({
      mountPath: mount,
      owners: [
        owner('/Volumes/Kindle/documents/Fixture Codex.azw3', 'a', UUID),
        owner('/Volumes/Kindle/documents/Fixture Codex.mobi', 'a', OTHER_UUID)
      ],
      coverPathFor: cover
    })

    expect(await cache()).toEqual([NAME, OTHER_NAME].sort())
    expect(report).toEqual({
      written: 2,
      present: 0,
      unnamed: 0,
      coverless: 0,
      failed: 0,
      jackets: 1
    })
    expect(cover).toHaveBeenCalledTimes(1)
    expect(cover).toHaveBeenCalledWith('a')
  })

  it('leaves the entries the device already has alone, and counts them (AC15)', async () => {
    const input = {
      mountPath: mount,
      owners: [
        owner('/Volumes/Kindle/documents/Fixture Codex.azw3', 'a', UUID),
        owner('/Volumes/Kindle/documents/Other Codex.mobi', 'b', OTHER_UUID)
      ],
      coverPathFor: () => coverPath
    }

    const first = await fillDeviceCovers(input)
    expect(first.written).toBe(2)

    const second = await fillDeviceCovers(input)

    // Nothing rewritten, and no jacket read the second time: what the device can
    // already show is decided by one `readdir`, before any book is opened
    expect(second).toEqual({
      written: 0,
      present: 2,
      unnamed: 0,
      coverless: 0,
      failed: 0,
      jackets: 0
    })
    expect(await cache()).toEqual([NAME, OTHER_NAME].sort())
  })

  it('deletes the marker of the entry it is writing, and nothing else (AC14)', async () => {
    // This is the app's second path that deletes files on a mounted device, and
    // the first one already deleted a real file off a real Kindle from a passing
    // test run: the pass inherits the send's single-name rule, and a decoy for an
    // entry nobody is writing has to survive it
    await fs.mkdir(thumbnailsDir(mount), { recursive: true })
    const surviving = [
      'someone_else_EBOK_portrait.jpg',
      `${OTHER_NAME}${COVER_MARKER_SUFFIX}`,
      'a-foreign-file'
    ]
    for (const name of surviving) await fs.writeFile(join(thumbnailsDir(mount), name), 'x')
    // ...and a marker for *our* entry, which is the one deletion the pass makes
    await fs.writeFile(join(thumbnailsDir(mount), NAME + COVER_MARKER_SUFFIX), '')

    const report = await fillDeviceCovers({
      mountPath: mount,
      owners: [owner('/Volumes/Kindle/documents/Fixture Codex.azw3', 'a')],
      coverPathFor: () => coverPath
    })

    expect(report.written).toBe(1)
    expect(await cache()).toEqual([...surviving, NAME].sort())
  })

  it('gives no entry to a file two books both claim (AC17a)', async () => {
    // The file carries a name one book answers to and a title inside it that
    // another does — both are true, and choosing between their jackets is
    // choosing which book wears the wrong one
    const cover = vi.fn(() => coverPath)

    const report = await fillDeviceCovers({
      mountPath: mount,
      owners: [
        owner('/Volumes/Kindle/documents/Loose Ends.azw3', 'a'),
        owner('/Volumes/Kindle/documents/Loose Ends.azw3', 'b')
      ],
      coverPathFor: cover
    })

    expect(await cache()).toEqual([])
    expect(report).toEqual({
      written: 0,
      present: 0,
      unnamed: 1,
      coverless: 0,
      failed: 0,
      jackets: 0
    })
    expect(cover).not.toHaveBeenCalled()
  })

  it('needs both halves of the identity to name an entry with (AC11)', async () => {
    // Every real file measured carries both (4/4 on 2026-09-26), so this is the
    // defensive arm: a name the device would never look up is not written
    const report = await fillDeviceCovers({
      mountPath: mount,
      owners: [
        owner('/Volumes/Kindle/documents/No Uuid.azw3', 'a', null, CDETYPE),
        owner('/Volumes/Kindle/documents/No Cdetype.azw3', 'b', UUID, null)
      ],
      coverPathFor: () => coverPath
    })

    expect(await cache()).toEqual([])
    expect(report).toEqual({
      written: 0,
      present: 0,
      unnamed: 2,
      coverless: 0,
      failed: 0,
      jackets: 0
    })
  })

  it('counts a book with no jacket and still writes its neighbour’s (AC16)', async () => {
    const report = await fillDeviceCovers({
      mountPath: mount,
      owners: [
        owner('/Volumes/Kindle/documents/No Jacket.azw3', 'a', UUID),
        owner('/Volumes/Kindle/documents/With Jacket.azw3', 'b', OTHER_UUID)
      ],
      coverPathFor: (bookId) => (bookId === 'b' ? coverPath : null)
    })

    expect(await cache()).toEqual([OTHER_NAME])
    expect(report).toEqual({
      written: 1,
      present: 0,
      unnamed: 0,
      coverless: 1,
      failed: 0,
      jackets: 1
    })
  })

  it('counts a jacket the codec refuses, warns about it once, and throws nothing (AC16)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setCoverEncoderForTests(() => {
      throw new Error('not an image')
    })

    const report = await fillDeviceCovers({
      mountPath: mount,
      owners: [owner('/Volumes/Kindle/documents/Fixture Codex.azw3', 'a')],
      coverPathFor: () => coverPath
    })

    expect(report).toEqual({
      written: 0,
      present: 0,
      unnamed: 0,
      coverless: 1,
      failed: 0,
      jackets: 0
    })
    expect(await cache()).toEqual([])
    // The one surprise in this path is worth a line; a book with no jacket is not
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot encode the cover'),
      expect.anything()
    )
  })

  it('reports a device that refuses the writes, and leaves no partial (AC16)', async () => {
    await fs.writeFile(join(mount, 'system'), 'not a directory')

    const report = await fillDeviceCovers({
      mountPath: mount,
      owners: [
        owner('/Volumes/Kindle/documents/Fixture Codex.azw3', 'a', UUID),
        owner('/Volumes/Kindle/documents/Other Codex.mobi', 'b', OTHER_UUID)
      ],
      coverPathFor: () => coverPath
    })

    expect(report).toEqual({
      written: 0,
      present: 0,
      unnamed: 0,
      coverless: 0,
      failed: 2,
      jackets: 2
    })
    expect(await cache()).toEqual([])
  })

  it('writes into the mount path it is handed, and that is the whole of its guard (AC16)', async () => {
    // **The device-went-away case, at this layer, is not what the design
    // assumed.** `mkdir(recursive)` will *create* the chain under any parent the
    // filesystem lets it write, so a pass handed the path of a departed mount
    // writes into a directory tree that never belonged to a device. Nothing here
    // checks for a device, and nothing here should: the pass holds paths. What
    // stops it in the application is one layer up — the owners it is handed come
    // from the *current* scan, and a scan that enumerated nothing schedules no
    // pass at all (decided in `device-manager.test.ts`).
    //
    // On a real Mac the same call cannot create anything: `/Volumes` is
    // root-owned, so a mount that has gone answers `EACCES`, which lands in
    // `failed` like any other refusal — the writer's non-fatal arm. This suite
    // cannot produce that, and says so rather than pretending to.
    const report = await fillDeviceCovers({
      mountPath: join(mount, 'not-a-mount'),
      owners: [owner('/Volumes/Kindle/documents/Fixture Codex.azw3', 'a')],
      coverPathFor: () => coverPath
    })

    expect(report).toMatchObject({ written: 1, failed: 0 })
  })

  it('names an entry from the owners list alone, without asking the device (AC16)', async () => {
    // The file is not there at all, and the pass writes its entry anyway — on
    // purpose. It reads nothing off the device (one `readdir` of the cache and
    // no opens is the whole of its device cost), so a file that left is not this
    // pass's business: `deviceFileOwners` reads the current scan, so such a file
    // never reaches here in the application.
    const report = await fillDeviceCovers({
      mountPath: mount,
      owners: [owner('/Volumes/Kindle/documents/Vanished.azw3', 'a')],
      coverPathFor: () => coverPath
    })

    expect(await cache()).toEqual([NAME])
    expect(report.written).toBe(1)
  })
})
