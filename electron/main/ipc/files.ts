import type { BookFormat } from '@shared/book.types'
import * as fileAccess from '../services/file-access'
import { handle } from './handle'

export function registerFileHandlers(): void {
  handle('files:revealBook', (bookId: string, format?: BookFormat) =>
    fileAccess.revealBook(bookId, format)
  )
  handle('files:openBookFile', (bookId: string, format: BookFormat) =>
    fileAccess.openBookFile(bookId, format)
  )
}
