import type { ProgressReport } from '@shared/book.types'
import * as readingState from '../services/reading-state'
import * as reflow from '../services/reflow'
import { handle } from './handle'

export function registerReaderHandlers(): void {
  handle('reader:saveProgress', (report: ProgressReport) => readingState.saveProgress(report))
  // One call, and no file or process work of its own (invariant 8): the source's
  // resolution, the pass's deadline and the retry all live in
  // `services/reflow.ts`, where they are decided without the IPC layer.
  handle('reader:reflow', (bookId: string) => reflow.ensure(bookId))
}
