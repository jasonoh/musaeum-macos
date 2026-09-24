import { dialog, type OpenDialogOptions, type OpenDialogReturnValue } from 'electron'
import * as catalog from '../services/catalog'
import * as librarySync from '../services/library-sync'
import * as nas from '../services/nas-manager'
import { survivingAncestor } from '../services/storage-kind'
import { handle } from './handle'

export function registerNASHandlers(): void {
  handle('nas:getStatus', () => nas.getStatus())
  handle('nas:reconnect', () => nas.reconnect())

  handle('nas:setLibraryRoot', async (path: string) => {
    await nas.setLibraryRoot(path)
    await librarySync.syncOnConnect()
  })

  // `locateAt` is D6's pre-point: a library whose folder went missing recovers
  // through this same picker, opened where the folder used to be. The renderer
  // passes it when its button says *Locate Library Folder…*; slice 1 leaves the
  // parameter wired and unpassed, because the button that sends it is slice 2's.
  handle('nas:chooseLibraryRoot', (locateAt?: string) => pickLibraryRoot(locateAt))
}

/** How the pick flow asks for a folder — a parameter so the suite can drive it. */
export type ShowFolderDialog = (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>

const showFolderDialog: ShowFolderDialog = (options) => dialog.showOpenDialog(options)

/**
 * Choose a library folder, and adopt what is in it.
 *
 * `locateAt` is the last known root (or its nearest surviving ancestor): the
 * *Locate Library Folder…* path, which is the recovery a `missing` root offers
 * (D2/D6). `showOpenDialog` ignores a `defaultPath` that does not exist and
 * opens wherever macOS likes, so the hint is resolved to something real before
 * it is passed — and a hint pointing at a *file* is equally useless to a
 * directory picker.
 *
 * **The dialog is a parameter rather than a call to `dialog` directly**, because
 * this flow is what AC6 names ("picking a root writes both `library_root` and
 * `library_kind` in one flow") and a stubbed dialog is its only instrument: no
 * case in this repo has ever driven an `ipcMain` handler, and the vitest
 * Electron mock's `ipcMain` is deliberately inert. Everything *decided* here is
 * therefore decided through this entry point — which keys are written, in what
 * order, and whether the catalog is peeked at before the root is wired in. The
 * writes themselves stay in `nas-manager` (invariant 8): this function decides
 * the interaction, not the state.
 */
export async function pickLibraryRoot(
  locateAt?: string,
  showDialog: ShowFolderDialog = showFolderDialog
): Promise<string | null> {
  const hint = locateAt ? await survivingAncestor(locateAt) : null
  const result = await showDialog({
    title: hint ? 'Locate Library Folder' : 'Choose Library Folder',
    message: 'Select the folder that holds (or will hold) your Musaeum library',
    properties: ['openDirectory', 'createDirectory'],
    ...(hint ? { defaultPath: hint } : {})
  })
  if (result.canceled || !result.filePaths.length) return null
  const root = result.filePaths[0]

  // Peek for an existing library before wiring the root in, and hold the
  // automatic on-connect apply until the user has answered
  const existing = await catalog.readCatalog(root)
  if (existing) librarySync.skipRoot(root)
  // Writes `library_root` and `library_kind` together, and re-derives the kind
  // from the folder it was just handed
  await nas.setLibraryRoot(root)

  if (existing) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: `Found a Musaeum library with ${existing.books.length} ${
        existing.books.length === 1 ? 'book' : 'books'
      }`,
      detail: 'Use this library? Your local view will be refreshed from it.',
      buttons: ['Use This Library', 'Not Now'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) await librarySync.applyCatalog(root)
  } else {
    await librarySync.syncOnConnect()
  }
  return root
}
