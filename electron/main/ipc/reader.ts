import type { ProgressReport } from '@shared/book.types'
import * as readingState from '../services/reading-state'
import { handle } from './handle'

export function registerReaderHandlers(): void {
  handle('reader:saveProgress', (report: ProgressReport) => readingState.saveProgress(report))
}
