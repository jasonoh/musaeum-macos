import type { ShelfMembership } from '@shared/shelf.types'
import * as shelves from '../services/shelves'
import { handle } from './handle'

/**
 * Shelves (bookshelves D6). Thin by rule (invariant 8): the queue, the
 * file-then-cache order, the name rules and every refusal are
 * `services/shelves.ts`'s, and a refusal reaches the renderer as the envelope's
 * `error` — the sentence main composed.
 */
export function registerShelvesHandlers(): void {
  handle('shelves:list', () => shelves.list())
  handle('shelves:forBook', (bookId: string) => shelves.forBook(bookId))
  handle('shelves:create', (name: string, bookIds?: string[]) => shelves.create(name, bookIds))
  handle('shelves:rename', (id: string, name: string) => shelves.rename(id, name))
  handle('shelves:delete', (id: string) => shelves.deleteShelf(id))
  handle('shelves:addBooks', (id: string, bookIds: string[]) => shelves.addBooks(id, bookIds))
  handle('shelves:removeBooks', (id: string, bookIds: string[]) => shelves.removeBooks(id, bookIds))
  handle('shelves:restoreBooks', (id: string, memberships: ShelfMembership[]) =>
    shelves.restoreBooks(id, memberships)
  )
}
