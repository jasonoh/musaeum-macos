import { join } from 'path'
import type { ConflictChoices } from '@shared/metadata.types'
import * as bulkHydrate from '../services/bulk-hydrate'
import * as conflicts from '../services/conflicts'
import * as db from '../services/db'
import * as importer from '../services/importer'
import * as nas from '../services/nas-manager'
import * as sidecar from '../services/sidecar'
import { handle } from './handle'

export function registerMetadataHandlers(): void {
  handle('metadata:getConflictQueue', () => db.getConflictQueue())

  handle('metadata:resolveConflict', (conflictId: number, choices: ConflictChoices) =>
    conflicts.resolveConflict(conflictId, choices)
  )

  handle('metadata:rehydrateBook', async (bookId: string) => {
    nas.assertOnline()
    // Before the fetch below, because a failure after it has no channel home
    sidecar.assertAvailable()
    const book = db.getBook(bookId)
    if (!book?.nasPath) throw new Error('Book not found')
    const bookDir = join(nas.getLibraryRoot()!, book.nasPath)
    const file = await bulkHydrate.findHydratableFile(bookDir)
    if (!file) throw new Error('No EPUB, MOBI or AZW3 file to refresh from')
    // The one awaited hydration: this call is a user action, not a background
    // chore, so the caller is told what happened rather than being left to
    // watch the card. Import and the bulk job keep the non-blocking contract —
    // there is nothing to report to, and fifty books must not hold one invoke
    // open for minutes.
    return importer.hydrate(bookId, file, bookDir)
  })

  handle('metadata:rehydrateBooks', (bookIds: string[]) => {
    bulkHydrate.startBulkHydrate(bookIds)
  })

  handle('metadata:cancelRehydrate', () => {
    bulkHydrate.cancelBulkHydrate()
  })
}
