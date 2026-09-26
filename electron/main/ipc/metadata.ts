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

  handle('metadata:cancelRehydrate', () => {
    bulkHydrate.cancelBulkHydrate()
  })
}
