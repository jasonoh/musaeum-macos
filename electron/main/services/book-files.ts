import { promises as fs } from 'fs'
import { extname, join } from 'path'
import { sanitizeTitle } from './sanitize'

/** Only format files are named after the book; covers and metadata.json are not. */
const BOOK_EXTENSIONS = new Set(['.epub', '.mobi', '.azw3', '.pdf'])

/**
 * Rename a book's format files to match its current title.
 *
 * Files are named from the title at import, but the title keeps moving after
 * that — hydration rewrites it, and so does the metadata editor — which used
 * to leave the folder holding a book under whatever it was first mistaken for.
 *
 * Idempotent and title-derived rather than diff-driven: it repairs a name that
 * drifted for any reason, not just the edit that prompted this call.
 *
 * Never throws. Nothing reads these names — every lookup is by extension — so
 * a rename that fails costs tidiness and nothing else, and must not fail an
 * edit that has already been written to the canonical record. Returns the
 * number of files renamed.
 */
export async function renameToTitle(bookDir: string, title: string): Promise<number> {
  const stem = sanitizeTitle(title)

  let entries: string[]
  try {
    entries = await fs.readdir(bookDir)
  } catch (err) {
    console.warn(`[files] cannot read ${bookDir} to rename its files:`, err)
    return 0
  }
  const existing = new Set(entries)

  let renamed = 0
  for (const entry of entries) {
    const ext = extname(entry)
    if (!BOOK_EXTENSIONS.has(ext.toLowerCase())) continue

    const target = `${stem}${ext}`
    if (entry === target) continue
    // A second file of the same format would rename onto the first and destroy
    // it. Renaming is cosmetic; losing a file is not — leave the duplicate be.
    if (existing.has(target)) continue

    try {
      await fs.rename(join(bookDir, entry), join(bookDir, target))
    } catch (err) {
      console.warn(`[files] could not rename ${entry} to ${target}:`, err)
      continue
    }
    existing.delete(entry)
    existing.add(target)
    renamed++
  }
  return renamed
}
