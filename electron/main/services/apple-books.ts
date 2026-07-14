import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import * as db from './db'
import * as nas from './nas-manager'

/** Hand the book's epub to Apple Books via `open -a Books`. */
export async function exportToAppleBooks(bookId: string): Promise<void> {
  const book = db.getBook(bookId)
  if (!book || !book.nasPath) throw new Error('Book not found')
  nas.assertOnline()

  const bookDir = join(nas.getLibraryRoot()!, book.nasPath)
  const files = await fs.readdir(bookDir)
  const epub = files.find((f) => extname(f).toLowerCase() === '.epub')
  if (!epub) throw new Error('No EPUB available for this book')

  await new Promise<void>((resolve, reject) => {
    execFile('open', ['-a', 'Books', join(bookDir, epub)], (err) =>
      err ? reject(err) : resolve()
    )
  })
}
