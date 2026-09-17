import { mkdtempSync, rmSync, type PathLike, type Stats, type StatsFs } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { mobiFile } from '../../../test/helpers/mobi'
import { closeDb, getDeviceFileIdentities, insertBook } from './db'
import {
  getConnectedDevices,
  getOnDeviceBookIds,
  noteSentFile,
  refreshDeviceContents,
  removeBookFromDevice,
  removeFilesWithStem,
  scanDocuments,
  startDeviceDetection,
  stopDeviceDetection,
  titleKey
} from './device-manager'
import * as events from './events'

let mount: string
let documents: string

/** Write a file under documents/, creating any parent dirs. */
async function put(relPath: string, contents: string | Buffer = 'x'): Promise<string> {
  const full = join(documents, relPath)
  await fs.mkdir(join(full, '..'), { recursive: true })
  await fs.writeFile(full, contents)
  return full
}

async function exists(relPath: string): Promise<boolean> {
  return fs
    .stat(join(documents, relPath))
    .then(() => true)
    .catch(() => false)
}

beforeEach(async () => {
  mount = mkdtempSync(join(tmpdir(), 'musaeum-device-'))
  documents = join(mount, 'documents')
  await fs.mkdir(documents, { recursive: true })
})

afterEach(() => {
  rmSync(mount, { recursive: true, force: true })
})

describe('scanDocuments', () => {
  it('maps lowercased stems to every path carrying them', async () => {
    await put('Leviathan Wakes.azw3')
    await put('collection/Leviathan Wakes.mobi')
    await put('Caliban’s War.epub')

    const stems = await scanDocuments(mount)

    expect([...stems.keys()].sort()).toEqual(['caliban’s war', 'leviathan wakes'])
    expect(stems.get('leviathan wakes')).toHaveLength(2)
  })

  it('ignores .sdr sidecars, whose contents are named after the book', async () => {
    await put('Leviathan Wakes.sdr/Leviathan Wakes.apnx')

    expect(await scanDocuments(mount)).toEqual(new Map())
  })

  it('ignores dotfiles, including AppleDouble siblings', async () => {
    await put('Leviathan Wakes.azw3')
    await put('._Leviathan Wakes.azw3')

    expect(await scanDocuments(mount)).toEqual(
      new Map([['leviathan wakes', [join(documents, 'Leviathan Wakes.azw3')]]])
    )
  })

  it('stops at depth 2 and survives a missing documents/ folder', async () => {
    await put('a/b/Too Deep.epub')
    expect(await scanDocuments(mount)).toEqual(new Map())

    rmSync(documents, { recursive: true })
    expect(await scanDocuments(mount)).toEqual(new Map())
  })
})

describe('removeFilesWithStem', () => {
  it('takes the file, its AppleDouble sibling, and its .sdr folder', async () => {
    await put('Leviathan Wakes.azw3')
    await put('._Leviathan Wakes.azw3')
    await put('Leviathan Wakes.sdr/Leviathan Wakes.apnx')
    await put('Caliban’s War.epub')

    expect(await removeFilesWithStem(mount, 'leviathan wakes')).toBe(1)

    expect(await exists('Leviathan Wakes.azw3')).toBe(false)
    expect(await exists('._Leviathan Wakes.azw3')).toBe(false)
    expect(await exists('Leviathan Wakes.sdr')).toBe(false)
    // Untouched neighbour
    expect(await exists('Caliban’s War.epub')).toBe(true)
  })

  it('removes every copy of a book, including one in a subfolder', async () => {
    await put('Leviathan Wakes.azw3')
    await put('collection/Leviathan Wakes.mobi')

    expect(await removeFilesWithStem(mount, 'leviathan wakes')).toBe(2)
    expect(await scanDocuments(mount)).toEqual(new Map())
    // The folder itself is not the book's to delete
    expect(await exists('collection')).toBe(true)
  })

  it('removes nothing when no file matches', async () => {
    await put('Caliban’s War.epub')

    expect(await removeFilesWithStem(mount, 'leviathan wakes')).toBe(0)
    expect(await exists('Caliban’s War.epub')).toBe(true)
  })
})

/**
 * The presence layer sits on top of the scan, and reaching it means reaching
 * `scan()` — which is private and polls the real `/Volumes`. These tests point
 * the filesystem calls that `scan()` makes at a throwaway directory standing in
 * for `/Volumes`, so a fake Kindle can be plugged in and unplugged without
 * touching the machine's real volumes. The stand-in also decides which volumes
 * are *mounted*, because that is the whole difference between a free-space
 * reading about the device and one about the disk underneath it. Everything
 * else — the walk, the matching, the broadcasts, the database — is real code.
 */
const VOLUMES = '/Volumes'
const realFs = {
  readdir: fs.readdir,
  access: fs.access,
  stat: fs.stat,
  statfs: fs.statfs,
  open: fs.open,
  readFile: fs.readFile,
  rm: fs.rm
}

let volumes: string
/**
 * Volume names the stand-in answers as mounted, and the free space each
 * reports. A name that is not in here behaves the way a bare `/Volumes`
 * directory does on the real machine: it is a directory, so `statfs` answers
 * about the filesystem that contains it.
 */
let mountedVolumes: Set<string>
let volumeFreeBytes: Map<string, number>

function mountVolume(name: string, free: number): void {
  mountedVolumes.add(name)
  volumeFreeBytes.set(name, free)
}

/** Free space a mounted volume reports from now on — a book was sent. */
function setVolumeFreeBytes(name: string, free: number): void {
  volumeFreeBytes.set(name, free)
}

/** The volume name when `target` is a volume root itself — `/Volumes/Kindle`. */
function volumeRoot(target: PathLike): string | null {
  const p = String(target)
  if (!p.startsWith(`${VOLUMES}/`)) return null
  const rest = p.slice(VOLUMES.length + 1)
  return rest.length > 0 && !rest.includes('/') ? rest : null
}

/** Filesystem calls started through the stand-in and not yet finished. */
let inFlight = 0

function rehome(target: PathLike): PathLike {
  const p = String(target)
  if (p !== VOLUMES && !p.startsWith(`${VOLUMES}/`)) return target
  return join(volumes, p.slice(VOLUMES.length))
}

async function tracked<T>(run: () => Promise<T>): Promise<T> {
  inFlight++
  try {
    return await run()
  } finally {
    inFlight--
  }
}

/** Files opened through the stand-in — the device's header reads, and only those. */
let opens = 0

/**
 * A real file handle whose `read` and `close` are tracked like the calls around
 * them. Without this, `poll()` could settle in the gap between a header's
 * `open` and its `read`, and a presence assertion would run against a device
 * that had only been walked, never read.
 */
function trackingReads<T extends Awaited<ReturnType<typeof fs.open>>>(handle: T): T {
  return new Proxy(handle, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof value !== 'function') return value
      return (...args: unknown[]) =>
        tracked(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args))
    }
  })
}

function mountVolumesStandIn(): void {
  const readdir = realFs.readdir as unknown as (p: PathLike, o?: unknown) => Promise<unknown>
  const stat = realFs.stat as unknown as (p: PathLike, o?: unknown) => Promise<Stats>
  const statfs = realFs.statfs as unknown as (p: PathLike) => Promise<StatsFs>
  const open = realFs.open as unknown as (p: PathLike, flags?: string) => Promise<unknown>
  const readFile = realFs.readFile as unknown as (p: PathLike, o?: unknown) => Promise<unknown>
  const rm = realFs.rm as unknown as (p: PathLike, o?: unknown) => Promise<unknown>
  Object.assign(fs, {
    readdir: (p: PathLike, o?: unknown) => tracked(() => readdir(rehome(p), o)),
    access: (p: PathLike, mode?: number) => tracked(() => realFs.access(rehome(p), mode)),
    // A mounted volume lives on a different device from its parent directory;
    // an unmounted one is just a directory the parent filesystem still answers
    // for. Only `dev` is read off this, and only for volume roots.
    stat: (p: PathLike, o?: unknown) =>
      tracked(async () => {
        const real = await stat(rehome(p), o)
        const vol = volumeRoot(p)
        if (vol && mountedVolumes.has(vol)) return { dev: real.dev + 1 } as unknown as Stats
        return real
      }),
    statfs: (p: PathLike) =>
      tracked(async () => {
        const vol = volumeRoot(p)
        if (vol && mountedVolumes.has(vol)) {
          const bytes = volumeFreeBytes.get(vol) ?? 0
          // bsize 1 makes `bavail * bsize` exactly the number the test set
          return {
            type: 0,
            bsize: 1,
            frsize: 1,
            blocks: bytes,
            bfree: bytes,
            bavail: bytes,
            files: 0,
            ffree: 0
          } as unknown as StatsFs
        }
        return statfs(rehome(p))
      }),
    // Reading a book's own header is a filesystem call like the rest, and the
    // one that must never reach the real filesystem while the fake volume is a
    // temp directory
    open: (p: PathLike, flags?: string) =>
      tracked(async () => {
        opens++
        const handle = (await open(rehome(p), flags)) as Awaited<ReturnType<typeof fs.open>>
        return trackingReads(handle)
      }),
    readFile: (p: PathLike, o?: unknown) => tracked(() => readFile(rehome(p), o)),
    // Every call production code makes under /Volumes has to be rehomed, the
    // destructive ones above all: a removal this stand-in maps into the temp
    // tree is a removal that cannot reach the volume the test is standing in
    // for. (`fs.rm` was missing here, and a fixture whose name a real Kindle
    // happened to share was deleted from the real device by a passing run.)
    rm: (p: PathLike, o?: unknown) => tracked(() => rm(rehome(p), o))
  })
}

/**
 * Run exactly one poll of the stand-in `/Volumes` and wait for it to finish.
 *
 * `startDeviceDetection` fires its first scan with `void`, so there is no
 * promise to await; the scan is instead a chain of filesystem calls, and it is
 * over once none are in flight and none start again for several turns of the
 * event loop. `stopDeviceDetection` clears the 5s timer before it can fire, so
 * one call here is one scan.
 */
async function poll(): Promise<void> {
  startDeviceDetection()
  for (let quiet = 0; quiet < 5;) {
    await new Promise((r) => setImmediate(r))
    quiet = inFlight === 0 ? quiet + 1 : 0
  }
  stopDeviceDetection()
}

/**
 * Write a file into a fake volume's documents/ folder.
 */
async function putOnDevice(
  volume: string,
  relPath: string,
  contents: string | Buffer = 'x'
): Promise<void> {
  const full = join(volumes, volume, 'documents', relPath)
  await fs.mkdir(join(full, '..'), { recursive: true })
  await fs.writeFile(full, contents)
}

/** The library book these tests put on a device, as its author spells it. */
const CALIBRE_NAME = 'Banks, Iain M_/Fixture Codex, The - Iain M. Banks.azw3'

/** The path the device reports for a file in the fake volume's documents/. */
function devicePath(relPath: string): string {
  return `/Volumes/Kindle/documents/${relPath}`
}

/**
 * Whether a file is there *on the fake volume*. Distinct from `exists`, which
 * reads the throwaway directory the walk tests use — and asking the wrong one
 * of the two is how a removal test passes without touching anything.
 */
async function existsOnDevice(relPath: string): Promise<boolean> {
  // The un-shimmed `stat`: this assertion is the test's own business, and it
  // must not count as a filesystem call in flight
  return realFs
    .stat(join(volumes, 'Kindle', 'documents', relPath))
    .then(() => true)
    .catch(() => false)
}

function channels(spy: { mock: { calls: [string, unknown?][] } }): string[] {
  return spy.mock.calls.map(([channel]) => channel)
}

describe('on-device presence', () => {
  beforeEach(async () => {
    closeDb()
    const userData = app.getPath('userData')
    for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
      rmSync(join(userData, f), { force: true })
    }
    volumes = mkdtempSync(join(tmpdir(), 'musaeum-volumes-'))
    mountedVolumes = new Set()
    volumeFreeBytes = new Map()
    opens = 0
    mountVolumesStandIn()
  })

  afterEach(async () => {
    // Unplug everything before restoring the real filesystem, so the module's
    // device map does not leak into the next test
    rmSync(volumes, { recursive: true, force: true })
    volumes = mkdtempSync(join(tmpdir(), 'musaeum-volumes-'))
    await poll()
    Object.assign(fs, realFs)
    rmSync(volumes, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('announces a newly connected volume and the contents it scanned', async () => {
    await putOnDevice('Kindle', 'Leviathan Wakes.azw3')
    mountVolume('Kindle', 8_000_000_000)
    const spy = vi.spyOn(events, 'broadcast')

    await poll()

    expect(getConnectedDevices()).toEqual([
      {
        id: 'kindle:Kindle',
        kind: 'kindle',
        name: 'Kindle',
        mountPath: '/Volumes/Kindle',
        freeBytes: 8_000_000_000
      }
    ])
    // Contents are announced on connect too: the renderer has nothing to ask
    // about until it hears the device exists, and presence is a second answer
    expect(channels(spy)).toEqual(['deviceConnected', 'deviceContentsChanged'])
  })

  /**
   * A `/Volumes` entry with no filesystem on it — a mount point left behind by an
   * unclean unplug, or the volume in the moment before macOS has attached it —
   * is not a volume, and `statfs` answers about the filesystem that *contains*
   * it, which is the boot disk. Trusting that reading is how the device row came
   * to show 73.2 GB free for a Kindle with 21.3 GB: one number, read once, off
   * by an entire filesystem.
   */
  it('reports no free space for a /Volumes entry that is not a mounted volume', async () => {
    await putOnDevice('Kindle', 'Leviathan Wakes.azw3')

    await poll()

    expect(getConnectedDevices()).toEqual([
      {
        id: 'kindle:Kindle',
        kind: 'kindle',
        name: 'Kindle',
        mountPath: '/Volumes/Kindle',
        freeBytes: null
      }
    ])
  })

  it('re-reads free space every poll and announces the change', async () => {
    mountVolume('Kindle', 8_000_000_000)
    await putOnDevice('Kindle', 'Leviathan Wakes.azw3')
    await poll()
    expect(getConnectedDevices()[0].freeBytes).toBe(8_000_000_000)

    // A book was sent: the same device, with less room on it
    setVolumeFreeBytes('Kindle', 7_500_000_000)
    const spy = vi.spyOn(events, 'broadcast')

    await poll()

    expect(getConnectedDevices()[0].freeBytes).toBe(7_500_000_000)
    expect(channels(spy)).toEqual(['deviceChanged'])
    expect(spy.mock.calls[0][1]).toMatchObject({ id: 'kindle:Kindle', freeBytes: 7_500_000_000 })

    // An unchanged reading is not news
    spy.mockClear()
    await poll()
    expect(channels(spy)).toEqual([])
  })

  it('matches a book by its sanitized title, case-folded and extension-agnostic', async () => {
    // Sent as azw3, sitting on the device as mobi, shouting its name
    await putOnDevice('Kindle', 'LEVIATHAN WAKES.mobi')
    // The colon never survived `sanitizeTitle` on the way to the device
    await putOnDevice('Kindle', 'Hard-Boiled Wonderland The End.azw3')
    insertBook(makeBook('a', 'Leviathan Wakes'))
    insertBook(makeBook('b', 'Hard-Boiled Wonderland: The End'))
    insertBook(makeBook('c', 'Caliban’s War'))

    await poll()

    expect(getOnDeviceBookIds('kindle:Kindle').sort()).toEqual(['a', 'b'])
  })

  it('answers per device, and says nothing about one that is not connected', async () => {
    await putOnDevice('Kindle A', 'Leviathan Wakes.azw3')
    await putOnDevice('Kindle B', 'Caliban’s War.epub')
    insertBook(makeBook('a', 'Leviathan Wakes'))
    insertBook(makeBook('b', 'Caliban’s War'))

    await poll()

    expect(getOnDeviceBookIds('kindle:Kindle A')).toEqual(['a'])
    expect(getOnDeviceBookIds('kindle:Kindle B')).toEqual(['b'])
    expect(getOnDeviceBookIds('kindle:Nothing Here')).toEqual([])
  })

  /**
   * The cold-start half of presence, from the main process's side: the scan
   * fixes the device files, but the book set is read at *call* time. The
   * on-connect catalog sync can finish after the device scan, and when it does
   * the same device contents have to produce a different answer — which is why
   * the renderer recomputes on `libraryChanged` as well as on
   * `deviceContentsChanged`. A presence list computed once, at scan time, is
   * the bug this pins shut.
   */
  it('recomputes against the current book set, not the one present at scan time', async () => {
    await putOnDevice('Kindle', 'Leviathan Wakes.azw3')

    await poll()

    expect(getOnDeviceBookIds('kindle:Kindle')).toEqual([])
    insertBook(makeBook('a', 'Leviathan Wakes'))
    expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])
  })

  /**
   * The file keeps the name it was sent under, and the title keeps moving after
   * that. A book retitled since its send used to read as absent — inviting a
   * second send, which is how a byte-identical duplicate (same EXTH 113, same
   * md5) ended up on a real Kindle. The name we wrote is the one fact the device
   * cannot give back, so the send records it.
   */
  it('keeps a book present when the file still carries the name it was sent under', async () => {
    const sentAs = 'The Nerd Reich Silicon Valley Fascism and the War on Democracy.azw3'
    await putOnDevice('Kindle', sentAs)
    insertBook(makeBook('a', 'The Nerd Reich'))

    await poll()
    expect(getOnDeviceBookIds('kindle:Kindle')).toEqual([])

    noteSentFile('kindle:Kindle', 'a', sentAs)

    expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])
  })

  it('drops that claim again when the file it names is gone from the device', async () => {
    await putOnDevice('Kindle', 'Old Title.azw3')
    insertBook(makeBook('a', 'New Title'))
    noteSentFile('kindle:Kindle', 'a', 'Old Title.azw3')
    await poll()
    expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])

    rmSync(join(volumes, 'Kindle/documents/Old Title.azw3'))
    await poll()

    expect(getOnDeviceBookIds('kindle:Kindle')).toEqual([])
  })

  it('removes a book whose file is still under the title it was sent with', async () => {
    await putOnDevice('Kindle', 'Old Title.azw3')
    insertBook(makeBook('a', 'New Title'))
    noteSentFile('kindle:Kindle', 'a', 'Old Title.azw3')
    await poll()

    expect(await removeBookFromDevice('a', 'kindle:Kindle')).toEqual({ removed: 1 })
    expect(await exists('Old Title.azw3')).toBe(false)
  })

  it('stays quiet when a re-scan finds the same stems', async () => {
    await putOnDevice('Kindle', 'Leviathan Wakes.azw3')
    await poll()
    const spy = vi.spyOn(events, 'broadcast')

    await poll()

    expect(channels(spy)).toEqual([])
  })

  it('self-heals when files change on the device, even at an unchanged file count', async () => {
    await putOnDevice('Kindle', 'Leviathan Wakes.azw3')
    insertBook(makeBook('a', 'Leviathan Wakes'))
    insertBook(makeBook('b', 'Caliban’s War'))
    await poll()
    expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])

    // Swapped on the Kindle itself, outside Musaeum: one file before, one
    // after, so only comparing the stems can tell that anything happened
    rmSync(join(volumes, 'Kindle/documents/Leviathan Wakes.azw3'))
    await putOnDevice('Kindle', 'Caliban’s War.epub')
    const spy = vi.spyOn(events, 'broadcast')

    await poll()

    expect(channels(spy)).toEqual(['deviceContentsChanged'])
    expect(spy.mock.calls[0][1]).toBe('kindle:Kindle')
    expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['b'])
  })

  /**
   * Presence by what the file says about *itself*.
   *
   * The filename rule only sees books Musaeum wrote itself: every other tool
   * names its files its own way, and Calibre writes
   * `{author_sort}/{title} - {authors}.ext`. Measured on the real device, that
   * rule recognized 86 of 1,555 book files where the title inside each file
   * reaches 1,343 — so the badge was silent for most of the library, and "Send
   * to {device}" was offered for books already on the device.
   */
  describe('by the title inside the file', () => {
    it('finds a book by it, in a file another tool named (AC1)', async () => {
      await putOnDevice(
        'Kindle',
        CALIBRE_NAME,
        mobiFile({
          title: 'The Fixture Codex',
          author: 'Banks, Iain M.',
          uuid: '26ff164d-f8d1-4588-b0e7-45fffa91c871',
          cdetype: 'EBOK'
        })
      )
      insertBook({ ...makeBook('a', 'The Fixture Codex'), author: 'Iain M. Banks' })

      await poll()

      // The name alone would have missed it: Calibre's stem carries a
      // " - {author}" tail no library title has
      const stems = await scanDocuments('/Volumes/Kindle')
      expect(stems.has(titleKey('The Fixture Codex'))).toBe(false)
      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])
    })

    /**
     * The copy on a device keeps the name it was written under, so a retitle in
     * the library leaves the file answering to the old spelling while the file's
     * own title is the one the library uses now. Presence follows the file, so
     * the book stays "On {device}" instead of being offered for a second send.
     *
     * What this does *not* claim: a retitle does not rewrite the bytes of a copy
     * already on the device, so a file whose own title is the old one still
     * reads as absent. The send receipt (`noteSentFile`) covers that for books
     * we sent; for books another tool put there it stays open, which is why the
     * invariant doc still records it as a gap.
     */
    it('keeps a book present when its file was named for a title the library moved on from (AC2)', async () => {
      await putOnDevice(
        'Kindle',
        'Banks, Iain M_/Fixture Codex, The - Iain M. Banks.azw3',
        mobiFile({ title: 'The Fixture Codex', author: 'Iain M. Banks', cdetype: 'EBOK' })
      )
      insertBook({ ...makeBook('a', 'The Fixture Codex'), author: 'Iain M. Banks' })

      await poll()

      const stems = await scanDocuments('/Volumes/Kindle')
      expect(stems.has(titleKey('The Fixture Codex'))).toBe(false)
      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])
    })

    it('leaves a book absent when the file carries a different title (AC3)', async () => {
      // A real residual: the title is truncated inside the file, so it is a
      // different string from the library's and the match is refused
      await putOnDevice(
        'Kindle',
        'Pink, Daniel H_/Fixture Drive - Daniel H. Pink.azw3',
        mobiFile({
          title: 'Fixture Drive: The Surprising Truth About What Motiv',
          author: 'Daniel H. Pink'
        })
      )
      insertBook({ ...makeBook('a', 'Fixture Drive: The Surprising Truth About What Motivates Us') })

      await poll()

      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual([])
    })

    it('still matches a book by its filename when the header says nothing (AC4)', async () => {
      // What Musaeum writes itself, and what it must keep seeing: the file is
      // not a MOBI at all, so the name is all there is
      await putOnDevice('Kindle', 'Leviathan Wakes.azw3', 'not a mobi at all')
      insertBook(makeBook('a', 'Leviathan Wakes'))

      await poll()

      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])
    })

    it('falls back to the filename rule for a file it cannot read (AC4)', async () => {
      // Same unreadable file, a name no library title matches: the fallback
      // must not invent a title for it either
      await putOnDevice('Kindle', 'Banks, Iain M_/Fixture Codex, The - Iain M. Banks.azw3', '')
      insertBook({ ...makeBook('a', 'The Fixture Codex'), author: 'Iain M. Banks' })

      await poll()

      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual([])
    })

    /**
     * The one direction this rule can lie in is a false positive — the badge
     * claiming a book that is on the device when a different book is. Two
     * library books sharing a normalized title, and a file that names neither,
     * is that case: it must read as absent rather than be credited to one of
     * them. Re-sending a book costs a copy; being told it is on the device when
     * it is not costs trust in the count.
     */
    it('refuses to guess when two books share a title and the file names no author (AC5)', async () => {
      await putOnDevice(
        'Kindle',
        'Banks, Iain M_/Fixture Codex, The - Iain M. Banks.azw3',
        mobiFile({ title: 'The Fixture Codex', cdetype: 'EBOK' })
      )
      insertBook({ ...makeBook('a', 'The Fixture Codex'), author: 'Iain M. Banks' })
      insertBook({ ...makeBook('b', 'The Fixture Codex'), author: 'Someone Else' })

      await poll()

      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual([])
    })

    it('credits the book whose author the file agrees with (AC5)', async () => {
      await putOnDevice(
        'Kindle',
        'Banks, Iain M_/Fixture Codex, The - Iain M. Banks.azw3',
        // The order the other tool writes the name in is not a difference
        mobiFile({ title: 'The Fixture Codex', author: 'Banks, Iain M.', cdetype: 'EBOK' })
      )
      insertBook({ ...makeBook('a', 'The Fixture Codex'), author: 'Iain M. Banks' })
      insertBook({ ...makeBook('b', 'The Fixture Codex'), author: 'Someone Else' })

      await poll()

      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])
    })

    /**
     * Removal is the inverse of presence, and has to be: a book the app shows
     * as "On {device}" that refuses to come off is the same inconsistency the
     * send receipt had to fix, in the other direction.
     */
    it('removes the file that made a book present, whoever named it (AC6)', async () => {
      await putOnDevice(
        'Kindle',
        CALIBRE_NAME,
        mobiFile({ title: 'The Fixture Codex', author: 'Banks, Iain M.' })
      )
      await putOnDevice(
        'Kindle',
        'Banks, Iain M_/Fixture Codex, The - Iain M. Banks.sdr/Fixture Codex, The.apnx'
      )
      insertBook({ ...makeBook('a', 'The Fixture Codex'), author: 'Iain M. Banks' })
      await poll()
      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])

      expect(await removeBookFromDevice('a', 'kindle:Kindle')).toEqual({ removed: 1 })

      expect(await existsOnDevice(CALIBRE_NAME)).toBe(false)
      // Reading position and annotations go with it, as they do on the device
      expect(await existsOnDevice('Banks, Iain M_/Fixture Codex, The - Iain M. Banks.sdr')).toBe(
        false
      )
      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual([])
    })
  })

  /**
   * The poll is the one path that runs on a timer, against a mount whose
   * per-file latency — not its bytes — is the cost: a cold pass over a real
   * Kindle's 1,555 files measures ~72s. So the poll walks documents/ and
   * compares stems, and never opens a book; the headers are read behind it, and
   * the facts are cached keyed by path + size + mtime so a later pass — a
   * reconnect, a send, a scan that noticed a file appear — reads only what
   * moved.
   */
  describe('the cost of knowing', () => {
    it('reads no header on the 5s poll (AC8)', async () => {
      await putOnDevice(
        'Kindle',
        CALIBRE_NAME,
        mobiFile({ title: 'The Fixture Codex', author: 'Banks, Iain M.' })
      )

      await poll()
      const afterFirstPass = opens
      expect(afterFirstPass).toBeGreaterThan(0)

      const spy = vi.spyOn(events, 'broadcast')
      await poll()

      expect(opens).toBe(afterFirstPass)
      expect(channels(spy)).toEqual([])
    })

    it('re-reads nothing when a pass finds the same files (AC8)', async () => {
      await putOnDevice(
        'Kindle',
        CALIBRE_NAME,
        mobiFile({ title: 'The Fixture Codex', author: 'Banks, Iain M.' })
      )
      insertBook({ ...makeBook('a', 'The Fixture Codex'), author: 'Iain M. Banks' })
      await poll()
      const readOnConnect = opens
      expect(readOnConnect).toBeGreaterThan(0)

      // The facts a reconnect needs are in the database, keyed by the file's
      // path and version — which is what the second pass reads them from
      const cached = getDeviceFileIdentities([devicePath(CALIBRE_NAME)])
      // Stored as the writer padded it (`nulPadded` is the fixture's default,
      // as it is 3,788 real EXTH records'): stripping that is `sanitizeTitle`'s
      // job, at comparison time, not the reader's
      expect(cached.get(devicePath(CALIBRE_NAME))).toMatchObject({
        title: 'The Fixture Codex'
      })

      await refreshDeviceContents('kindle:Kindle')
      await poll()

      expect(opens).toBe(readOnConnect)
      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])
    })

    /**
     * The file set is compared by stem, so a book the device replaced under the
     * same name is invisible to the poll — the pass that a send or a reconnect
     * runs is what picks its new header up. Size and mtime are what make that a
     * re-read rather than a belief: the old facts are keyed to the old file.
     */
    it('re-reads a file the device replaced under the same name', async () => {
      const name = 'Banks, Iain M_/Fixture Codex, The - Iain M. Banks.azw3'
      await putOnDevice('Kindle', name, mobiFile({ title: 'The Fixture Codex', author: 'Iain M. Banks' }))
      insertBook({ ...makeBook('a', 'The Fixture Codex'), author: 'Iain M. Banks' })
      await poll()
      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])

      await putOnDevice('Kindle', name, mobiFile({ title: 'Something Else Entirely' }))
      await refreshDeviceContents('kindle:Kindle')
      await poll()

      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual([])
    })

    it('drops what it knew about a file that left the device', async () => {
      await putOnDevice(
        'Kindle',
        CALIBRE_NAME,
        mobiFile({ title: 'The Fixture Codex', author: 'Banks, Iain M.' })
      )
      await putOnDevice('Kindle', 'Pink, Daniel H_/Fixture Drive - Daniel H. Pink.azw3', mobiFile({ title: 'Drive' }))
      insertBook({ ...makeBook('a', 'The Fixture Codex'), author: 'Iain M. Banks' })
      await poll()
      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])

      rmSync(join(volumes, 'Kindle/documents/Pink, Daniel H_'), { recursive: true })
      await poll()

      // The row goes with the file, and the entry in the reading goes with it:
      // a stale one would keep claiming a book that is no longer there
      expect(getDeviceFileIdentities([devicePath('Pink, Daniel H_/Fixture Drive - Daniel H. Pink.azw3')]).size).toBe(0)
      expect(getOnDeviceBookIds('kindle:Kindle')).toEqual(['a'])
    })
  })
})
