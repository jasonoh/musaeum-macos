import { exec } from 'child_process'
import { promises as fs } from 'fs'
import { dirname, join, resolve } from 'path'
import type { StorageKind } from '@shared/metadata.types'
import { getConfig, setConfig } from './db'

/**
 * What kind of storage a library root sits on — a fact recorded when the folder
 * is chosen, because that is the only moment the path necessarily exists.
 *
 * **Why this is stored and not re-derived.** The moment the answer matters is
 * the moment it is unavailable: when a share unmounts, its mount point goes
 * with it, so a root at `/Volumes/books/Musaeum` leaves an ancestor walk that
 * lands on `/Volumes` — the boot disk, which is local. Deriving the answer from
 * the *path shape* falls to the same counterexample, measured on this machine
 * 2026-09-24: `/Volumes/data` is a local HFS+ volume sitting beside
 * `//oh@ohnas…/books on /Volumes/books (smbfs, …)`. So the resolver runs at pick
 * time and its answer is written beside `library_root`
 * (`nas-manager.setLibraryRoot`), and Settings displays it so a wrong guess
 * costs one click rather than a silently wrong recovery.
 *
 * **Network only on positive evidence; local otherwise.** The asymmetry is what
 * makes the default safe: misreading a share as local costs the auto-remount
 * (the user still has the picker), while misreading a folder as a share is the
 * defect this module exists to remove — `open -g 'smb://ohnas'` three times a
 * minute against a server the user does not own.
 *
 * The mechanism is a `mount` scan, which reads a **name** (and therefore
 * survives a renumbering of anything), with `fs.statfs()` as a cheap in-process
 * pre-check. `statfs().type` is `30` for `smbfs` here, beside `25` for local
 * HFS+ and `26` for APFS — real, but a numeric whitelist of one measured
 * constant, which is why it only ever *adds* network evidence and never decides
 * against the mount table.
 */

/**
 * The `app_config` key holding the resolved kind.
 *
 * **A stored fact, so it can be wrong.** A library moved from a share to a disk
 * keeps `network` until the folder is picked again — and the symptom is the one
 * this whole design removes (an SMB mount attempted for a path on the boot
 * disk). Two things bound the damage: the picker re-derives the kind on every
 * pick, and Settings renders it, so a wrong guess costs one click rather than a
 * silently wrong recovery. **The residual is a user who moves the library in
 * Finder and never opens Settings** — and that is exactly what the SMB row's own
 * gate makes visible, because the field is drawn only for `network`: it is the
 * *presence* of a row about a server that says the stored kind is stale
 * (slice 2's criterion 9, spec's risk 1).
 */
export const LIBRARY_KIND_KEY = 'library_kind'

/**
 * Filesystem names `mount(8)` prints for a network filesystem. Only `smbfs` was
 * measured on this machine (2026-09-24); the rest are the same family and are
 * here because a name is cheap to check. A network filesystem this list misses
 * degrades to "no auto-remount, the user picks again" — a bad day, not a broken
 * library.
 */
const NETWORK_FS_TYPES = new Set(['smbfs', 'cifs', 'afpfs', 'nfs', 'nfs4', 'webdav'])

/**
 * `fs.statfs().type` for `smbfs` on macOS 26 — measured 2026-09-24, beside 25
 * (local HFS+) and 26 (APFS). Exported so the suite can decide the pre-check
 * against a real mounted share rather than against this comment.
 */
export const SMBFS_STATFS_TYPE = 30

/** One line of `mount`'s output: the filesystem mounted *at* `mountPoint`. */
export interface MountEntry {
  mountPoint: string
  fsType: string
}

/** `storage_kind` is a two-member union, and this is the only test of membership. */
export function isStorageKind(value: unknown): value is StorageKind {
  return value === 'local' || value === 'network'
}

/**
 * The stored kind, or null.
 *
 * Validated on read, like every `app_config` value a hand-edit can reach: a row
 * holding something else is treated as absent rather than trusted into a branch
 * nothing expects — the rule `theme_tokens` and `rest_api_port` already follow.
 */
export function readLibraryKind(): StorageKind | null {
  const stored = getConfig(LIBRARY_KIND_KEY)
  return isStorageKind(stored) ? stored : null
}

export function writeLibraryKind(kind: StorageKind): void {
  setConfig(LIBRARY_KIND_KEY, kind)
}

/**
 * `mount`'s own output, parsed.
 *
 * Lines read `//oh@ohnas._smb._tcp.local/books on /Volumes/books (smbfs, nodev,
 * nosuid, mounted by jasonoh)` — a source with no ` on ` in it, a mount point
 * that *may* contain spaces (so the source is cut at the first ` on ` and the
 * options at the last ` (`), and an option list whose first member is the
 * filesystem's name. `\040` is how a space inside a mount point is escaped.
 * Anything that does not parse is skipped: a table with fewer lines is less
 * evidence, never a wrong answer.
 */
export function parseMountTable(table: string): MountEntry[] {
  const entries: MountEntry[] = []
  for (const line of table.split('\n')) {
    const match = /^(.+?) on (.+) \(([^)]*)\)$/.exec(line.trim())
    if (!match) continue
    const fsType = match[3].split(',')[0].trim().toLowerCase()
    if (!fsType) continue
    entries.push({ mountPoint: match[2].replace(/\\040/g, ' '), fsType })
  }
  return entries
}

/**
 * The filesystem **containing** `path` — the longest mount point that is a
 * prefix of it, so `/Volumes/data/x` answers with `/Volumes/data` (HFS+, local)
 * rather than with `/Volumes` when both are in the table.
 */
export function containingMount(entries: MountEntry[], path: string): MountEntry | null {
  let best: MountEntry | null = null
  for (const entry of entries) {
    if (!isWithin(path, entry.mountPoint)) continue
    if (!best || entry.mountPoint.length > best.mountPoint.length) best = entry
  }
  return best
}

/**
 * Segment-aware containment, which a prefix test is not: `/Volumes/bookshelf`
 * is not inside the mount at `/Volumes/books`.
 */
function isWithin(path: string, mountPoint: string): boolean {
  if (path === mountPoint) return true
  if (mountPoint === '/') return path.startsWith('/')
  return path.startsWith(mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`)
}

/**
 * The decision, over a mount table's own text — the seam the suite decides
 * against a captured table, so the parse, the longest-prefix rule and the local
 * default are all decidable without a share on this machine.
 */
export function kindFromMountTable(path: string, table: string): StorageKind {
  const containing = containingMount(parseMountTable(table), path)
  return containing && NETWORK_FS_TYPES.has(containing.fsType) ? 'network' : 'local'
}

/**
 * Resolve the kind for a path.
 *
 * The pre-check runs first and can only ever *answer* network: anything else
 * falls through to the mount scan, so the name is what decides a local answer
 * and an unmeasured filesystem lands on the conservative side.
 *
 * A missing path is not a failure here — `statfs` throws and the mount table
 * still answers, which is why this is correct for a root that has been renamed
 * away while its parent is still mounted.
 */
export async function resolveStorageKind(root: string): Promise<StorageKind> {
  const path = await realpathOrSelf(root)
  if ((await statfsTypeOf(path)) === SMBFS_STATFS_TYPE) return 'network'
  return kindFromMountTable(path, await readMountTable())
}

/**
 * The filesystem's numeric type, or null when the path cannot be asked about
 * (it is gone, or the platform has no such call).
 */
export async function statfsTypeOf(path: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(path)
    return typeof stats.type === 'number' ? stats.type : null
  } catch {
    return null
  }
}

/**
 * The folder to open a picker at when the root is gone: the last known path if
 * it is still a directory, else its nearest surviving ancestor.
 *
 * `showOpenDialog`'s `defaultPath` is ignored when it does not exist, so a hint
 * that has vanished is worse than none — the dialog would open wherever macOS
 * likes. A *file* is not a hint either: the picker wants a directory.
 */
export async function survivingAncestor(path: string): Promise<string | null> {
  let candidate = path
  for (;;) {
    if (await isDirectory(candidate)) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) return null
    candidate = parent
  }
}

// ---------------------------------------------------------------------------
// Cloud-synced roots (D7)
// ---------------------------------------------------------------------------

export const ICLOUD_DRIVE = 'iCloud Drive'

/** Where the clients that put a folder in the home directory live. */
const CONVENTIONAL_SYNC_FOLDERS = ['Dropbox', 'Google Drive', 'OneDrive']

/**
 * The folder names macOS's own File Provider directory reports, mapped to the
 * client's published name. `~` is not the test — the *prefix* is, because the
 * real folder names carry the account: measured on this machine 2026-09-24,
 * `~/Library/CloudStorage/` holds `GoogleDrive-jason@repeatmd.com (5-29-24
 * 9:52 AM)` and `iCloudDrive-iCloudDrive (9-29-25 9:55 AM)` beside a plain
 * `Dropbox`.
 */
const CLOUD_STORAGE_CLIENTS: [RegExp, string][] = [
  [/^iCloudDrive/i, ICLOUD_DRIVE],
  [/^GoogleDrive/i, 'Google Drive'],
  [/^OneDrive/i, 'OneDrive'],
  [/^Dropbox/i, 'Dropbox'],
  [/^Box/i, 'Box'],
  [/^ProtonDrive/i, 'Proton Drive']
]

/**
 * The name of the client that syncs the folder `root` sits in, or null.
 *
 * **Why this is a name and not a verdict.** Two hazards are real for a synced
 * root — a second machine writing the same catalog, and iCloud evicting a
 * file's contents — and neither is cheaply verifiable from here, so the app
 * names the client and stops: it does not refuse the folder, and the sentence
 * built from this answer claims only what is known (D7, fork F2; the refusal's
 * revival condition is a measurement, not a taste).
 *
 * **Anything the table does not name is reported as the path spells it.** The
 * File Provider directory is open-ended — `Box-Box` and
 * `ProtonDrive-…-folder` sit in it on this machine — so a whitelist of the
 * three clients the design names would answer "not synced" for folders that
 * are. The table exists to print the *published* name where one is known
 * (`GoogleDrive-jason@repeatmd.com (5-29-24 9:52 AM)` is `Google Drive`), not
 * to decide whether a folder is synced at all.
 */
export function syncClientFor(root: string, home: string): string | null {
  const path = stripTrailingSlash(resolve(root))

  // The File Provider directory is asked about first and wins where both match,
  // the way the mount table's longest-prefix rule works: it is more specific
  // than the home-directory spellings below, and a client can appear in both
  // forms.
  const providers = join(home, 'Library', 'CloudStorage')
  if (isWithin(path, providers)) {
    return providerFolderClient(path.slice(providers.length + 1).split('/')[0] ?? '')
  }

  if (isWithin(path, join(home, 'Library', 'Mobile Documents'))) return ICLOUD_DRIVE

  for (const name of CONVENTIONAL_SYNC_FOLDERS) {
    if (isWithin(path, join(home, name))) return name
  }
  return null
}

/** The client a `~/Library/CloudStorage/<folder>` name belongs to. */
function providerFolderClient(folder: string): string | null {
  if (!folder) return null
  for (const [pattern, client] of CLOUD_STORAGE_CLIENTS) {
    if (pattern.test(folder)) return client
  }
  return folder
}

/** `/a/b/` and `/a/b` are the same folder to every reader here. */
function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** The mount table, as text. A failure is not fatal: an empty table means "no
 * evidence", and the caller's default is local (invariant 12). */
async function readMountTable(): Promise<string> {
  return new Promise((resolveTable) => {
    exec('mount', (err, stdout) => resolveTable(err ? '' : stdout))
  })
}

/** The real path where the kernel knows one, the resolved absolute path where
 * it does not — a root may be a symlink (`/tmp` → `/private/tmp`) or gone. */
async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await fs.realpath(path)
  } catch {
    return resolve(path)
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}
