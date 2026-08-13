import { promises as fs } from 'fs'
import { extname, join, relative, resolve } from 'path'
import type { BookFormat } from '@shared/book.types'
import * as db from './db'
import * as nas from './nas-manager'

/**
 * Resolving a book's bytes for the `musaeum://book/{id}/{format}` route.
 *
 * Kept out of the protocol handler so the path rules — which are the security
 * boundary between a renderer URL and the filesystem — are testable without a
 * running Electron app. Every failure returns null; the caller answers 404
 * rather than leaking which of the reasons applied.
 */

const FORMATS = new Set<string>(['epub', 'mobi', 'azw3', 'pdf'] satisfies BookFormat[])

export async function resolveBookFile(bookId: string, format: string): Promise<string | null> {
  if (!FORMATS.has(format)) return null

  const root = nas.getLibraryRoot()
  const book = db.getBook(bookId)
  if (!root || !book?.nasPath) return null

  // nasPath comes from a catalog any machine can write; a traversing entry
  // must not turn a renderer URL into arbitrary filesystem read access
  const dir = resolve(root, book.nasPath)
  const rel = relative(resolve(root), dir)
  if (rel.startsWith('..') || rel === '') return null

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }

  // By extension, not by canonical name — same rule as file-access and
  // deleteFormats, so a book renamed after import still opens
  const match = entries.find((f) => extname(f).toLowerCase() === `.${format}`)
  return match ? join(dir, match) : null
}
