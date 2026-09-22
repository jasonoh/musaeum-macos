import { shell } from 'electron'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import type { BookFormat } from '@shared/book.types'
import { primaryFormat } from '@shared/book.types'
import * as db from './db'
import * as nas from './nas-manager'

/**
 * Handing a book's files to the host OS — reveal the folder in Finder, or open
 * a format in whatever app owns that extension (Preview for PDFs, etc.). This
 * is the escape hatch for reading a book without importing it anywhere.
 */

async function bookDir(bookId: string): Promise<string> {
  const book = db.getBook(bookId)
  if (!book?.nasPath) throw new Error('Book not found')
  nas.assertOnline()

  const dir = join(nas.getLibraryRoot()!, book.nasPath)
  await fs.access(dir).catch(() => {
    throw new Error(`Book folder is missing: ${book.nasPath}`)
  })
  return dir
}

/** Files are matched by extension, not by canonical name, so a book renamed
 *  after import still resolves. */
async function formatFile(dir: string, format: BookFormat): Promise<string | null> {
  const files = await fs.readdir(dir)
  const match = files.find((f) => extname(f).toLowerCase() === `.${format}`)
  return match ? join(dir, match) : null
}

/**
 * Open the book's folder in Finder. When the book has a file, reveal that file
 * so it lands selected inside the folder rather than as a folder icon in the
 * parent.
 */
export async function revealBook(bookId: string, format?: BookFormat): Promise<void> {
  const dir = await bookDir(bookId)
  const book = db.getBook(bookId)!
  const preferred = format ?? primaryFormat(book)
  const file = preferred ? await formatFile(dir, preferred) : null

  if (file) {
    shell.showItemInFolder(file)
    return
  }
  const error = await shell.openPath(dir)
  if (error) throw new Error(error)
}

/** Open one of the book's files with the system default application. */
export async function openBookFile(bookId: string, format: BookFormat): Promise<void> {
  const dir = await bookDir(bookId)
  const file = await formatFile(dir, format)
  if (!file) throw new Error(`No ${format.toUpperCase()} file for this book`)

  const error = await shell.openPath(file)
  if (error) throw new Error(error)
}
