import { dialog, type OpenDialogOptions, type OpenDialogReturnValue } from 'electron'
import type { CoverUploadOutcome } from '@shared/api.types'
import type { ConflictChoices, CoverChoice } from '@shared/metadata.types'
import * as bulkHydrate from '../services/bulk-hydrate'
import * as conflicts from '../services/conflicts'
import * as coverChoice from '../services/cover-choice'
import * as db from '../services/db'
import { handle } from './handle'

export function registerMetadataHandlers(): void {
  handle('metadata:getConflictQueue', () => db.getConflictQueue())

  handle('metadata:resolveConflict', (conflictId: number, choices: ConflictChoices) =>
    conflicts.resolveConflict(conflictId, choices)
  )

  handle('metadata:rehydrateBook', (bookId: string) => bulkHydrate.rehydrateBook(bookId))

  handle('metadata:rehydrateBooks', (bookIds: string[]) => {
    bulkHydrate.startBulkHydrate(bookIds)
  })

  handle('metadata:coverPreviews', (urls: string[]) => conflicts.coverPreviews(urls))

  // Thin by construction (invariant 8): the pre-flight, the refusal and every
  // write belong to the service, so the picker's two entry points are the same
  // ones the UI slice will call.
  handle('metadata:coverCandidates', (bookId: string) => coverChoice.coverCandidates(bookId))

  // The wider search, the same thin shape by construction: the pre-flight, the
  // refusals and the payload belong to the service, which is what keeps this a
  // wrapper rather than a second place the answer is composed (invariant 8).
  handle('metadata:searchCovers', (bookId: string) => coverChoice.searchCovers(bookId))

  handle('metadata:setCover', (bookId: string, choice: CoverChoice) =>
    coverChoice.chooseCover(bookId, choice)
  )

  // The picker's own image (D6). The dialog is *this* side of the boundary, so
  // the renderer sends a bookId and receives `{cancelled: true}` or the updated
  // book: the absolute path a file dialog chose is never a value a renderer can
  // name, and one that could name it could ask the main process to write an
  // arbitrary file into a book's folder. Thin by construction (invariant 8) —
  // the write, the lock and the refusals are the service's.
  handle('metadata:chooseCoverFromFile', (bookId: string) => chooseCoverFromFile(bookId))

  handle('metadata:cancelRehydrate', () => {
    bulkHydrate.cancelBulkHydrate()
  })
}

/** How the upload flow asks for an image — a parameter so the suite can drive it. */
export type ShowImageDialog = (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>

const showImageDialog: ShowImageDialog = (options) => dialog.showOpenDialog(options)

/**
 * Choose an image file for a book's cover, and write it.
 *
 * The one route in this app where a cover's bytes come from a file the person
 * chose rather than from the network or from the book itself, and the reason the
 * dialog lives here: `src/types/api.types.ts` freezes the renderer's
 * `chooseCoverFromFile` as *a bookId in, a book or a cancellation out*, so the
 * path never crosses the boundary and invariant 9's `file://` rule is not
 * strained by this feature at all (D6-a).
 *
 * The filter is the dialog's convenience, not the gate: a file that slips past it
 * is refused by the sidecar's guard with a sentence — a sentence the renderer
 * prints, because `sidecar.call`'s rejection is the whole point of returning it
 * there rather than writing nothing and saying nothing (D6-d).
 *
 * **The dialog is a parameter rather than a call to `dialog` directly**, for
 * `pickLibraryRoot`'s reason: the cancel path is a decision this flow makes
 * (a cancellation writes nothing and is *not* a failure), and this is the only
 * seam a test can drive it through — `test/mocks/electron.ts` keeps `dialog` and
 * `ipcMain` inert on purpose, and no case in this repo has ever driven an
 * `ipcMain` handler. Everything *decided* here is therefore decided through this
 * entry point; the writes themselves stay in `cover-choice.ts` (invariant 8).
 */
export async function chooseCoverFromFile(
  bookId: string,
  showDialog: ShowImageDialog = showImageDialog
): Promise<CoverUploadOutcome> {
  const result = await showDialog({
    title: 'Choose Cover Image',
    message: "Select the image to use as this book's cover",
    properties: ['openFile'],
    filters: [
      // Every format the sidecar's encoder can read. Without dots, as Electron
      // takes them, and named for what the user is picking rather than for a
      // library.
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif'] }
    ]
  })
  // A cancellation is an answer, not an error: nothing was written and there is
  // no book to report, so the renderer is told which of the two it is rather than
  // checking a path it never had.
  if (result.canceled || !result.filePaths.length) return { cancelled: true }
  return coverChoice.chooseUploadedCover(bookId, result.filePaths[0])
}
