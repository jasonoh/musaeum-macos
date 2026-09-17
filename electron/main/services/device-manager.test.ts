import { mkdtempSync, rmSync, type PathLike, type Stats, type StatsFs } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { closeDb, insertBook } from './db'
import {
  getConnectedDevices,
  getOnDeviceBookIds,
  noteSentFile,
  removeBookFromDevice,
  removeFilesWithStem,
  scanDocuments,
  startDeviceDetection,
  stopDeviceDetection
} from './device-manager'
import * as events from './events'

let mount: string
let documents: string

/** Write a file under documents/, creating any parent dirs. */
async function put(relPath: string, contents = 'x'): Promise<string> {
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
const realFs = { readdir: fs.readdir, access: fs.access, stat: fs.stat, statfs: fs.statfs }

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

function mountVolumesStandIn(): void {
  const readdir = realFs.readdir as unknown as (p: PathLike, o?: unknown) => Promise<unknown>
  const stat = realFs.stat as unknown as (p: PathLike, o?: unknown) => Promise<Stats>
  const statfs = realFs.statfs as unknown as (p: PathLike) => Promise<StatsFs>
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
      })
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

/** Write a file into a fake volume's documents/ folder. */
async function putOnDevice(volume: string, relPath: string, contents = 'x'): Promise<void> {
  const full = join(volumes, volume, 'documents', relPath)
  await fs.mkdir(join(full, '..'), { recursive: true })
  await fs.writeFile(full, contents)
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
})
