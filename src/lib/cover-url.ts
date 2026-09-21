import type { Book } from '@shared/book.types'

/**
 * The URL a cover is served from — with the row's own clock as its version.
 *
 * `cover_full.jpg` / `cover_thumb.jpg` are **fixed** names (the row records the
 * filename, not a revision), so this URL used to be constant for a book's whole
 * life: the same string served a re-fetched cover, a resolved cover conflict or
 * a replaced file, and **Chromium caches it**. Measured 2026-09-21 in the
 * running app on an isolated profile with the same book, after the file on disk
 * had been replaced with a different image (307×500, solid):
 *
 * | `src` | `naturalWidth` | pixels |
 * | --- | --- | --- |
 * | same URL, new `<img>` | **600** (the *old* file) | byte-identical to before |
 * | same URL `?v=<now>` | **307** (the new file) | the new image |
 *
 * That is the reported defect it fixes: *"it displayed both cover photos, i
 * selected the 2nd, and it set the 1st"* — the write had landed (the book's
 * `cover_full.jpg` was the chosen jacket and `metadata_json` agreed) while the
 * window kept painting the cover hydration had put there, because no URL had
 * changed to make it look again.
 *
 * So the URL carries a version. The row's `lastModified` is the one clock every
 * path that can rewrite those bytes already moves (a hydration's `applyHydration`,
 * `library:updateBook`, `metadata:resolveConflict`), and the `musaeum://` route
 * parses **only the pathname** (`electron/main/index.ts`), so the query costs
 * nothing on the wire and busts only the one book. A cover that changes under a
 * row whose clock did *not* move — a file replaced outside the app, a folder
 * restored from a backup — stays stale until something else touches the row;
 * that residual is worth stating rather than pretending this is airtight.
 */
export function coverUrl(book: Book, size: 'thumb' | 'full'): string | null {
  const path = size === 'thumb' ? book.coverThumbPath : book.coverFullPath
  if (!path) return null
  const version = book.lastModified ? `?v=${encodeURIComponent(book.lastModified)}` : ''
  return `musaeum://cover/${book.id}/${size}${version}`
}
