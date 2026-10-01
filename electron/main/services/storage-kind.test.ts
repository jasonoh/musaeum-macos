import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
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
  syncClientFor,
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
  '//oh@nas._smb._tcp.local/books on /Volumes/books (smbfs, nodev, nosuid, mounted by jasonoh)',
  '//oh@nas._smb._tcp.local/media on /Volumes/media (smbfs, nodev, nosuid, mounted by jasonoh)',
  '/dev/disk6s2 on /Volumes/data (hfs, local, nodev, nosuid, journaled, noowners)'
].join('\n')

/** The mounted share on this machine, where one is mounted. */
const SHARE = '/Volumes/books'

/** macOS's own File Provider directory, where a machine has one. */
const CLOUD_STORAGE = join(homedir(), 'Library', 'CloudStorage')

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
          '//oh@nas._smb._tcp.local/books on /Volumes/books (smbfs, nodev, nosuid)'
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

/**
 * D7: **a cloud-synced root is named, not refused.** Which clients are
 * recognised, and what an unrecognised one is called.
 *
 * The home directory is a **parameter** rather than `homedir()` inside the
 * function, so the table is decided without the machine's own layout — and the
 * two `runIf` cases at the end are what prove the fixture still describes a
 * real machine.
 */
describe('syncClientFor', () => {
  const home = '/Users/example'

  it('names iCloud Drive for anything under Mobile Documents', () => {
    expect(syncClientFor(join(home, 'Library/Mobile Documents/com~apple~CloudDocs'), home)).toBe(
      'iCloud Drive'
    )
    expect(syncClientFor(join(home, 'Library/Mobile Documents'), home)).toBe('iCloud Drive')
  })

  it('names the conventional folders in the home directory', () => {
    expect(syncClientFor(join(home, 'Dropbox/Books'), home)).toBe('Dropbox')
    expect(syncClientFor(join(home, 'Google Drive/Musaeum'), home)).toBe('Google Drive')
    expect(syncClientFor(join(home, 'OneDrive'), home)).toBe('OneDrive')
  })

  it('maps File Provider folder names, account suffix and all', () => {
    // The spellings below are the ones measured in ~/Library/CloudStorage on
    // this machine 2026-09-24 — a prefix test is the only one that survives an
    // account appearing in the folder name
    const providers = join(home, 'Library/CloudStorage')
    expect(syncClientFor(join(providers, 'Dropbox'), home)).toBe('Dropbox')
    expect(syncClientFor(join(providers, 'GoogleDrive-a@b.com (5-29-24 9:52 AM)'), home)).toBe(
      'Google Drive'
    )
    expect(syncClientFor(join(providers, 'iCloudDrive-iCloudDrive (9-29-25 9:55 AM)'), home)).toBe(
      'iCloud Drive'
    )
    expect(syncClientFor(join(providers, 'Box-Box'), home)).toBe('Box')
  })

  it('prints the published name where the table knows one', () => {
    // The real folder names carry the account and a date, so the *prefix* is what
    // identifies a client — measured in ~/Library/CloudStorage on this machine
    // 2026-09-24
    const providers = join(home, 'Library/CloudStorage')
    expect(syncClientFor(join(providers, 'ProtonDrive-jason.oh@proton.me-folder'), home)).toBe(
      'Proton Drive'
    )
  })

  it('reports a client it does not know by the name the path spells', () => {
    // The File Provider directory is open-ended, so a whitelist of the clients the
    // design happens to list would answer "not synced" for a folder that is — the
    // shape of claim this copy exists to avoid
    const providers = join(home, 'Library/CloudStorage')
    expect(syncClientFor(join(providers, 'AcmeSync-Acme'), home)).toBe('AcmeSync-Acme')
    expect(syncClientFor(join(providers, 'SyncThing'), home)).toBe('SyncThing')
  })

  it('is segment-aware, so a similarly named sibling is not inside a client', () => {
    expect(syncClientFor(join(home, 'DropboxArchive'), home)).toBeNull()
    expect(syncClientFor(join(home, 'Google Drive Backup'), home)).toBeNull()
    // The provider directory itself is not any client's folder
    expect(syncClientFor(join(home, 'Library/CloudStorage'), home)).toBeNull()
  })

  it('answers null for an ordinary folder, wherever it is', () => {
    expect(syncClientFor(join(home, 'Documents/Books'), home)).toBeNull()
    expect(syncClientFor(join(scratch, 'library'), home)).toBeNull()
    expect(syncClientFor('/Volumes/books/musaeum', home)).toBeNull()
    expect(syncClientFor('/', home)).toBeNull()
  })

  it('does not care about a trailing slash', () => {
    expect(syncClientFor(`${join(home, 'Dropbox')}/`, home)).toBe('Dropbox')
    expect(syncClientFor(`${join(home, 'Library/Mobile Documents')}/`, home)).toBe('iCloud Drive')
  })

  it.runIf(existsSync(join(homedir(), 'Dropbox')))('names the real folder on this machine', () => {
    expect(syncClientFor(join(homedir(), 'Dropbox'), homedir())).toBe('Dropbox')
  })

  it.runIf(existsSync(CLOUD_STORAGE))(
    'names every File Provider folder this machine actually holds',
    () => {
      // The paired half of the cases above: without it, a table that answers
      // only for the fixture's spellings passes on a machine whose real folder
      // names it has never seen. Every one of them must resolve to *something* —
      // the unknown-name fallback is what makes that true.
      const entries = readdirSync(CLOUD_STORAGE)
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(syncClientFor(join(CLOUD_STORAGE, entry), homedir())).not.toBeNull()
      }
    }
  )
})
