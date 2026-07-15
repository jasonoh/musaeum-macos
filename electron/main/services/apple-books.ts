import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import * as db from './db'
import * as nas from './nas-manager'

/** Hand the book's epub (preferred) or pdf to Apple Books via `open -a Books`. */
export async function exportToAppleBooks(bookId: string): Promise<void> {
  const book = db.getBook(bookId)
  if (!book || !book.nasPath) throw new Error('Book not found')
  nas.assertOnline()

  const bookDir = join(nas.getLibraryRoot()!, book.nasPath)
  const files = await fs.readdir(bookDir)
  const epub = files.find((f) => extname(f).toLowerCase() === '.epub')
  const pdf = files.find((f) => extname(f).toLowerCase() === '.pdf')
  const exportFile = epub ?? pdf
  if (!exportFile) throw new Error('No EPUB or PDF available for this book')

  await new Promise<void>((resolve, reject) => {
    execFile('open', ['-a', 'Books', join(bookDir, exportFile)], (err) =>
      err ? reject(err) : resolve()
    )
  })
}
