import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, getConfig, setConfig } from './db'
import {
  LIBRARY_KIND_KEY,
  SMBFS_STATFS_TYPE,
  kindFromMountTable,
  parseMountTable,
  readLibraryKind,
  resolveStorageKind,
  statfsTypeOf,
  survivingAncestor,
  writeLibraryKind
} from './storage-kind'

/**
 * `mount`'s own output, captured on this machine 2026-09-24 — the same reading
 * the design's table records as #14, trimmed to the lines that decide anything.
 *
 * The two lines that make the whole feature necessary are both here: a **local**
 * HFS+ volume sitting under `/Volumes/` (`/Volumes/data`, `statfs().type` 25)
 * beside the share (`/Volumes/books`, 30). A `/Volumes/…` prefix test answers
 * *network* for the first one and would have shipped the bug this removes.
 */
const CAPTURED_TABLE = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  'devfs on /dev (devfs, local, nobrowse)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  '//oh@ohnas._smb._tcp.local/books on /Volumes/books (smbfs, nodev, nosuid, mounted by jasonoh)',
  '//oh@ohnas._smb._tcp.local/media on /Volumes/media (smbfs, nodev, nosuid, mounted by jasonoh)',
  '/dev/disk6s2 on /Volumes/data (hfs, local, nodev, nosuid, journaled, noowners)'
].join('\n')

/** The mounted share on this machine, where one is mounted. */
const SHARE = '/Volumes/books'

let scratch: string

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  scratch = mkdtempSync(join(tmpdir(), 'musaeum-kind-'))
})

afterEach(() => rmSync(scratch, { recursive: true, force: true }))

describe('parseMountTable', () => {
  const entries = parseMountTable(CAPTURED_TABLE)

  it('reads the filesystem name and the mount point off each line', () => {
    expect(entries).toHaveLength(7)
    expect(entries).toContainEqual({ mountPoint: '/Volumes/books', fsType: 'smbfs' })
    expect(entries).toContainEqual({ mountPoint: '/Volumes/data', fsType: 'hfs' })
    expect(entries).toContainEqual({ mountPoint: '/', fsType: 'apfs' })
  })

  it('keeps a mount point that contains a space, escaped or not', () => {
    const table = [
      '/dev/disk9s1 on /Volumes/My Disk (hfs, local)',
      '/dev/disk9s2 on /Volumes/My\\040Other Disk (hfs, local)'
    ].join('\n')
    expect(parseMountTable(table)).toEqual([
      { mountPoint: '/Volumes/My Disk', fsType: 'hfs' },
      { mountPoint: '/Volumes/My Other Disk', fsType: 'hfs' }
    ])
  })

  it('skips a line that does not parse rather than guessing at it', () => {
    expect(parseMountTable('not a mount line\n')).toEqual([])
  })
})

describe('kindFromMountTable', () => {
  it('answers local for a folder on the boot disk', () => {
    expect(kindFromMountTable('/Users/someone/Books', CAPTURED_TABLE)).toBe('local')
  })

  it('answers network for a path inside a mounted share', () => {
    expect(kindFromMountTable('/Volumes/books/musaeum', CAPTURED_TABLE)).toBe('network')
    // The mount point itself, with no trailing path
    expect(kindFromMountTable(SHARE, CAPTURED_TABLE)).toBe('network')
  })

  it('answers local for a local volume under /Volumes (reading 14)', () => {
    expect(kindFromMountTable('/Volumes/data/Musaeum', CAPTURED_TABLE)).toBe('local')
  })

  it('is segment-aware, so a sibling name is not inside the share', () => {
    // A prefix test would call this a share
    expect(kindFromMountTable('/Volumes/bookshelf', CAPTURED_TABLE)).toBe('local')
  })

  it('takes the longest mount point, not the first that matches', () => {
    // Both contain the path; the share is the longer name and therefore the
    // filesystem it is actually on
    expect(
      kindFromMountTable(
        '/Volumes/books/musaeum',
        [
          '/dev/disk3s5 on /Volumes (apfs, local)',
          '//oh@ohnas._smb._tcp.local/books on /Volumes/books (smbfs, nodev, nosuid)'
        ].join('\n')
      )
    ).toBe('network')
  })

  it('defaults to local when the table says nothing (no evidence is not evidence of a share)', () => {
    expect(kindFromMountTable('/anywhere', '')).toBe('local')
  })
})

describe('the stored kind', () => {
  it('round-trips both members', () => {
    writeLibraryKind('network')
    expect(getConfig(LIBRARY_KIND_KEY)).toBe('network')
    expect(readLibraryKind()).toBe('network')

    writeLibraryKind('local')
    expect(readLibraryKind()).toBe('local')
  })

  it('treats an unset key as absent', () => {
    expect(getConfig(LIBRARY_KIND_KEY)).toBeNull()
    expect(readLibraryKind()).toBeNull()
  })

  it('treats a hand-edited value as absent rather than trusting it into a branch', () => {
    // Storage is not trusted on the read path — the rule `theme_tokens` and
    // `rest_api_port` already follow
    setConfig(LIBRARY_KIND_KEY, 'banana')
    expect(readLibraryKind()).toBeNull()
  })
})

describe('resolveStorageKind, live on this machine', () => {
  it('answers local for a temp directory and for the boot disk', async () => {
    expect(await resolveStorageKind(scratch)).toBe('local')
    expect(await resolveStorageKind('/')).toBe('local')
  })

  it.runIf(existsSync(SHARE))('answers network for the mounted share', async () => {
    expect(await resolveStorageKind(SHARE)).toBe('network')
  })

  it.runIf(existsSync('/Volumes/data'))(
    'answers local for a local volume under /Volumes',
    async () => {
      expect(await resolveStorageKind('/Volumes/data')).toBe('local')
    }
  )

  it('still answers a gone path from the mount table alone', async () => {
    // Nothing to statfs: the parent is not there either. The table still names
    // the filesystem that *would* contain it.
    const gone = join(scratch, 'not-there', 'deeper')
    expect(await resolveStorageKind(gone)).toBe('local')
  })
})

describe('the statfs pre-check', () => {
  it('is null for a path that cannot be asked about, and never the network constant here', async () => {
    expect(await statfsTypeOf(join(scratch, 'gone'))).toBeNull()
    expect(await statfsTypeOf(scratch)).not.toBe(SMBFS_STATFS_TYPE)
  })

  it.runIf(existsSync(SHARE))('reads the measured network constant off a real share', async () => {
    // The paired half of the case above: without this, "not 30" passes for a
    // machine where the constant is wrong.
    expect(await statfsTypeOf(SHARE)).toBe(SMBFS_STATFS_TYPE)
  })
})

describe('survivingAncestor', () => {
  it('is the path itself while it is still a directory', async () => {
    expect(await survivingAncestor(scratch)).toBe(scratch)
  })

  it('walks up to the nearest survivor of a renamed-away folder', async () => {
    expect(await survivingAncestor(join(scratch, 'moved', 'deeper'))).toBe(scratch)
  })

  it('skips a file, because the picker wants a directory', async () => {
    expect(await survivingAncestor('/etc/hosts')).toBe('/etc')
  })
})
