import { mkdtempSync, rmSync, type PathLike } from 'fs'
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
 * the three filesystem calls that `scan()` makes at a throwaway directory
 * standing in for `/Volumes`, so a fake Kindle can be plugged in and unplugged
 * without touching the machine's real volumes. Everything else — the walk, the
 * matching, the broadcasts, the database — is the real code.
 */
const VOLUMES = '/Volumes'
const realFs = { readdir: fs.readdir, access: fs.access, statfs: fs.statfs }

let volumes: string
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
  Object.assign(fs, {
    readdir: (p: PathLike, o?: unknown) => tracked(() => readdir(rehome(p), o)),
    access: (p: PathLike, mode?: number) => tracked(() => realFs.access(rehome(p), mode)),
    statfs: (p: PathLike) => tracked(() => realFs.statfs(rehome(p)))
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
  for (let quiet = 0; quiet < 5; ) {
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
    const spy = vi.spyOn(events, 'broadcast')

    await poll()

    expect(getConnectedDevices()).toEqual([
      {
        id: 'kindle:Kindle',
        kind: 'kindle',
        name: 'Kindle',
        mountPath: '/Volumes/Kindle',
        freeBytes: expect.any(Number)
      }
    ])
    // Contents are announced on connect too: the renderer has nothing to ask
    // about until it hears the device exists, and presence is a second answer
    expect(channels(spy)).toEqual(['deviceConnected', 'deviceContentsChanged'])
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
