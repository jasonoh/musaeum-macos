import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app, type OpenDialogOptions, type OpenDialogReturnValue } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, deleteConfig, getConfig, getDb } from '../services/db'
import * as nas from '../services/nas-manager'
import { LIBRARY_KIND_KEY } from '../services/storage-kind'
import { pickLibraryRoot, type ShowFolderDialog } from './nas'

/**
 * AC6: **picking a root writes `library_root` and `library_kind` in one flow,
 * and a later launch reports the stored kind.**
 *
 * This is the one criterion in slice 1 whose named decider is a handler, and it
 * is decided here through `pickLibraryRoot` — the flow `registerNASHandlers`
 * registers, with the dialog injected. Driving the *registered closure* is not
 * possible in this suite and not because of a shortcut: no case in this repo has
 * ever driven an `ipcMain` handler, and `test/mocks/electron.ts` keeps `ipcMain`
 * inert on purpose. What the seam buys is everything the criterion is about —
 * which keys are written, in what order, and whether the folder is peeked at
 * before the root is wired in. What it does **not** decide is the two lines
 * `registerNASHandlers` contributes (that the channel is registered and the
 * argument forwarded); those are the slice-2 probe's, and they are named here so
 * the limit is recorded rather than implied.
 *
 * The kind is resolved by the real resolver against the real `mount` table —
 * no `child_process` mock in this file — which is why a temp directory gives
 * `local` without a fixture.
 */
let root: string

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  deleteConfig('library_root')
  root = mkdtempSync(join(tmpdir(), 'musaeum-pick-'))
})

afterEach(() => {
  nas.stopHealthChecks()
  rmSync(root, { recursive: true, force: true })
})

/** The whole `app_config` key set, so "and nothing else" is decidable. */
const configKeys = (): string[] =>
  (getDb().prepare('SELECT key FROM app_config').all() as { key: string }[])
    .map((row) => row.key)
    .sort()

/** A dialog that answers with `root`, or with a cancellation when given null. */
function stubDialog(chosen: string | null): {
  show: ShowFolderDialog
  asked: OpenDialogOptions[]
} {
  const asked: OpenDialogOptions[] = []
  const show: ShowFolderDialog = vi.fn(async (options: OpenDialogOptions) => {
    asked.push(options)
    return chosen === null
      ? ({ canceled: true, filePaths: [] } as OpenDialogReturnValue)
      : ({ canceled: false, filePaths: [chosen] } as OpenDialogReturnValue)
  })
  return { show, asked }
}

describe('pickLibraryRoot', () => {
  it('writes both keys in one flow, and nothing else (AC6)', async () => {
    const before = configKeys()
    const { show } = stubDialog(root)

    expect(await pickLibraryRoot(undefined, show)).toBe(root)

    expect(getConfig('library_root')).toBe(root)
    // The kind, resolved from the folder it was just handed — a real temp
    // directory on the boot disk, so `local`
    expect(getConfig(LIBRARY_KIND_KEY)).toBe('local')
    // By set, not by name: four reads by name pass while a fifth key is written
    // beside them, and this criterion's whole content is "these two"
    expect(configKeys()).toEqual([...before, 'library_kind', 'library_root'].sort())
  })

  it('reports that stored kind to the app immediately (AC6, second half)', async () => {
    const { show } = stubDialog(root)
    await pickLibraryRoot(undefined, show)

    const status = await nas.checkHealth()
    expect(status).toMatchObject({ state: 'connected', kind: 'local' })
    // And the read path Settings renders
    expect(getConfig(LIBRARY_KIND_KEY)).toBe('local')
  })

  it('opens the picker at the last known folder when asked to locate one (D6)', async () => {
    const { show, asked } = stubDialog(null)

    expect(await pickLibraryRoot(root, show)).toBeNull()

    expect(asked).toHaveLength(1)
    // The folder is still there, so the hint is the folder itself
    expect(asked[0].defaultPath).toBe(root)
    expect(asked[0].title).toBe('Locate Library Folder')
  })

  it('pre-points at the nearest surviving parent when the folder has moved (D6)', async () => {
    const gone = join(root, 'renamed-away')
    const { show, asked } = stubDialog(null)

    await pickLibraryRoot(gone, show)

    // `showOpenDialog` ignores a `defaultPath` that does not exist, so a hint
    // that has vanished is worse than none
    expect(asked[0].defaultPath).toBe(root)
  })

  it('offers no hint, and says so in the title, on the ordinary path', async () => {
    const { show, asked } = stubDialog(null)

    await pickLibraryRoot(undefined, show)

    expect(asked[0].defaultPath).toBeUndefined()
    expect(asked[0].title).toBe('Choose Library Folder')
  })

  it('writes nothing when the dialog is cancelled', async () => {
    const before = configKeys()
    const { show } = stubDialog(null)

    expect(await pickLibraryRoot(undefined, show)).toBeNull()

    expect(configKeys()).toEqual(before)
  })
})
