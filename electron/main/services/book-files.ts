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

/**
 * Sum the sizes of a book's surviving format files in its NAS folder.
 *
 * `file_size_bytes` is set once at import and never revisited otherwise, so it
 * silently goes stale the moment a format is added or removed — this is the
 * single source of truth every such write recomputes from. Resolves files by
 * extension, like every other lookup here, not by canonical name, so a book
 * renamed after import is still measured correctly.
 *
 * Non-fatal: a `readdir`/`stat` failure (a flaky share) logs and returns `null`
 * rather than throwing. Callers that need to preserve a previous value fall back
 * to it themselves, since "unknown" and "genuinely empty" need different
 * fallbacks depending on the call site.
 */
export async function computeFileSizeBytes(bookDir: string): Promise<number | null> {
  try {
    let total = 0
    for (const entry of await fs.readdir(bookDir)) {
      if (!BOOK_EXTENSIONS.has(extname(entry).toLowerCase())) continue
      total += (await fs.stat(join(bookDir, entry))).size
    }
    return total > 0 ? total : null
  } catch (err) {
    console.warn(`[files] cannot recompute size for ${bookDir}:`, err)
    return null
  }
}
