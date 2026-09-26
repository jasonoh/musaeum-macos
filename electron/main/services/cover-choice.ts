import { join } from 'path'
import type { Book } from '@shared/book.types'
import type { CoverCandidate, CoverChoice, MetadataSource } from '@shared/metadata.types'
import * as bulkHydrate from './bulk-hydrate'
import * as db from './db'
import { broadcast } from './events'
import * as fieldOverrides from './field-overrides'
import * as importer from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import * as sidecar from './sidecar'

/**
 * Choosing a book's jacket: the candidates, and setting one.
 *
 * This is `conflicts.ts`'s cover leg given a home of its own rather than a
 * second copy, because the two gestures are the same decision. Resolving a cover
 * conflict downloads the chosen URL through the sidecar, updates the row's two
 * cover columns, marks the field as the user's, rewrites `metadata.json` and
 * upserts the catalog (`conflicts.ts:41-64`, `:64-77`); so does this, and for the
 * same reason: the next fetch must not move what a person chose.
 *
 * Nothing here touches an image or a URL. The candidate set is only computable
 * where the file is — an embedded candidate means opening the EPUB's zip and
 * decoding an image — so both calls are sidecar methods and this module is the
 * orchestration, the pre-flight, and the boundary's refusals (design D2, D6).
 *
 * Two gestures set a cover: a pick from the gather, and an image from this
 * machine (D6 of the 2026-09-25 cover-sources design). They share one tail —
 * `settleChoice` — because "an uploaded cover is held exactly as a picked one
 * is" is only true while the row, the marking, the canonical file and the
 * catalog are written in one place.
 */

/**
 * The sources a choice may name: `SOURCE_PRIORITY`'s keys (`pipeline/cover.py`),
 * which is the set the scoring step can have produced a candidate from.
 *
 * Deliberately a second copy, and the one duplication this slice accepts, because
 * D6's refusal has to sit on the main-process side of the boundary: a renderer
 * that could name its own URL would be handing the main process an arbitrary
 * egress, and a check the renderer performs is the check the CSP exists to avoid
 * trusting. `sidecar/tests/test_cover_candidates.py` pins the Python set, so a
 * change there reddens a test that sits next to this list.
 */
const CHOOSABLE_SOURCES: MetadataSource[] = ['google_books', 'openlibrary', 'embedded']

/**
 * Why a choice is refused, or null when it is one the gather could have produced.
 *
 * Three shapes, all of them things the renderer cannot be trusted about: a source
 * the scoring step never scored, an online source arriving without the url the
 * gather returned, and an embedded one arriving *with* a url — the file's own
 * jacket is re-extracted from the file, so a url beside it would turn "put the
 * file's own jacket back" into a fetch of something nobody chose.
 *
 * Pure, and called before the pre-flight, so a refused choice starts nothing and
 * reaches no network at all (AC7).
 */
function refusalFor(choice: CoverChoice): string | null {
  if (!CHOOSABLE_SOURCES.includes(choice.source)) {
    return `"${choice.source}" is not a source this app can take a cover from`
  }
  if (choice.source === 'embedded') {
    return choice.url
      ? 'The cover inside the file is re-extracted from the file: it has no url to fetch'
      : null
  }
  return choice.url
    ? null
    : `A cover from "${choice.source}" needs the url the candidates came with`
}

/**
 * Every jacket a fetch would consider for this book — the picker's gather.
 *
 * Live: the same requests a hydration makes (it works on a book that has never
 * been hydrated), and nothing is written or cached. A locked `cover` does **not**
 * stop it: the lock is the fetch's, and reopening the picker to change your mind
 * is the only way back from one.
 *
 * Rejects with the reason when it cannot run — offline, no metadata engine, no
 * EPUB/MOBI/AZW3 in the folder — because the picker has to say *why* rather than
 * show an empty grid (AC16).
 */
export async function coverCandidates(bookId: string): Promise<CoverCandidate[]> {
  nas.assertOnline()
  sidecar.assertAvailable()
  const { book, bookDir } = resolve(bookId)
  const file = await hydratableFile(bookDir)
  return sidecar.call<CoverCandidate[]>('cover_candidates', {
    book_id: bookId,
    file_path: file,
    book_dir: bookDir,
    known: importer.knownFrom(book)
  })
}

/**
 * The jackets that exist under the book's *other* identifiers — the picker's
 * wider search (D2 of the 2026-09-25 cover-sources design).
 *
 * The same row, the same file, the same `known` and the same sidecar plumbing as
 * the gather above, on purpose: a searched hit and a gathered one are the same
 * currency — a `url` a pick may name — so a second dialect here would be a
 * second answer to what a candidate is. What differs is the question, and it is
 * deliberately one only this dialog asks (D1): Google's jackets outrank
 * OpenLibrary's by construction, so a *fetch* that asked it would flip the
 * applied cover for every book whose stored ISBN misses Google, on the next
 * re-fetch, across the whole library, with no review.
 *
 * Every entry comes back with `winner: false`, forced in the sidecar: the mark
 * means "what a fetch would write", and no fetch would write a jacket it never
 * asked for. So a searched hit is never auto-applied, is never the subject of
 * the 15% review band, and carries no score-based recommendation. `applied`
 * still means byte identity with what is on disk now, and is true for whichever
 * group is wearing the book.
 *
 * Rejects with the reason when it cannot run, for the gather's three reasons —
 * offline, no metadata engine, no EPUB/MOBI/AZW3 in the folder — because the
 * picker has to say *why* rather than show an empty group.
 */
export async function searchCovers(bookId: string): Promise<CoverCandidate[]> {
  nas.assertOnline()
  sidecar.assertAvailable()
  const { book, bookDir } = resolve(bookId)
  const file = await hydratableFile(bookDir)
  return sidecar.call<CoverCandidate[]>('search_covers', {
    book_id: bookId,
    file_path: file,
    book_dir: bookDir,
    known: importer.knownFrom(book)
  })
}

/**
 * Choose a cover: write the bytes, settle the row, and record the decision.
 *
 * Returns the updated book, so a caller can report what the book now wears
 * rather than re-reading it. The pre-flight is this gesture's own — a picked
 * cover is described by a candidate the gather produced, and the file it may
 * have to re-extract lives in the book's folder — while everything after the
 * write is `settleChoice`, shared with the upload so the two cannot come to hold
 * a cover differently.
 *
 * Needs the book's own file: a pick is an echo of a gather that read one, so a
 * folder with no EPUB/MOBI/AZW3 has nothing to pick from (and its cover route
 * stays the conflict queue's `fetch_cover`, which needs no file). The upload
 * below deliberately does not inherit that requirement.
 */
export async function chooseCover(bookId: string, choice: CoverChoice): Promise<Book> {
  // Before any pre-flight: a refused choice starts no sidecar and reaches no
  // network (AC7)
  const refusal = refusalFor(choice)
  if (refusal) throw new Error(refusal)

  nas.assertOnline()
  sidecar.assertAvailable()
  const { bookDir } = resolve(bookId)
  const file = await hydratableFile(bookDir)

  const cover = await sidecar.call<{ full: string; thumb: string }>('set_cover', {
    book_id: bookId,
    file_path: file,
    book_dir: bookDir,
    source: choice.source,
    url: choice.url
  })

  return settleChoice(bookId, cover, bookDir)
}

/**
 * Choose an image from this machine as the book's cover (D6).
 *
 * The write path for the fallback the owner asked for before any search existed:
 * a jacket that is in no database, or in none this app can reach. `imagePath` is
 * an absolute path that arrived from a **main-process dialog** (`ipc/metadata.ts`)
 * and is never a value the renderer can name, so this function takes it as given
 * — there is no `CoverChoice` here and no source vocabulary to extend, because an
 * upload is a write rather than something the gather could have produced (D6-b).
 *
 * Deliberately **not** `hydratableFile`: an upload needs neither identifiers nor
 * an embedded jacket, so a PDF-only book — the one case the two other sources
 * cannot serve — can still be dressed (D6-e). It still needs the library, the
 * engine and the book's folder, and the sidecar's guard refuses a file that is
 * not an image, or is under 120 px on either side, with the sentence the dialog
 * prints. Nothing is written when it refuses.
 */
export async function chooseUploadedCover(bookId: string, imagePath: string): Promise<Book> {
  nas.assertOnline()
  sidecar.assertAvailable()
  const { bookDir } = resolve(bookId)

  const cover = await sidecar.call<{ full: string; thumb: string }>('set_cover_from_file', {
    book_dir: bookDir,
    image_path: imagePath
  })

  return settleChoice(bookId, cover, bookDir)
}

/**
 * Settle a cover that has just been written: the row, the marking, the canonical
 * file, the catalog, the broadcast.
 *
 * **One implementation for both gestures** (D6-c). D6 says an uploaded cover is
 * held exactly as a picked one is, and a second copy of this tail is precisely
 * how that would stop being true — an upload that forgot `markFromPatch` would
 * write a cover the next fetch could silently move. The two `db`/`fieldOverrides`
 * calls are ordered as `resolveConflict`'s are — the row first, then the marking
 * (which is why the patch and the `before` argument are written out here rather
 * than left to a re-read: after the write, every patch restates the row).
 */
async function settleChoice(
  bookId: string,
  cover: { full: string; thumb: string },
  bookDir: string
): Promise<Book> {
  db.updateBook(bookId, { coverFullPath: cover.full, coverThumbPath: cover.thumb })
  // `before = null` deliberately. The diff guard exists so a *form* cannot lock
  // every field it happens to send; this gesture *is* the decision, so choosing
  // the jacket that is already applied must still record it — otherwise the
  // half of the rule that makes a lock meaningful ("a fetch must not move what I
  // chose") would be missing for exactly the person who confirmed rather than
  // changed their mind (AC9).
  fieldOverrides.markFromPatch(
    bookId,
    { coverFullPath: cover.full, coverThumbPath: cover.thumb },
    null
  )

  const updated = db.getBook(bookId)
  if (!updated) throw new Error('Book not found')

  await importer.writeMetadataJson(bookDir, updated)
  librarySync.upsertCatalog([updated])
  // No file rename: a cover is not a title, so the third title-settling path is
  // not in play here (invariant 6 names three, and this is none of them).
  broadcast('libraryChanged')
  return updated
}

/** The book's row and its folder, or the reason there is neither. */
function resolve(bookId: string): { book: Book; bookDir: string } {
  const book = db.getBook(bookId)
  if (!book?.nasPath) throw new Error('Book not found')
  return { book, bookDir: join(nas.getLibraryRoot()!, book.nasPath) }
}

/**
 * The file a gather has to read, or the sentence that says why it cannot.
 *
 * The preference order and the format list are `bulk-hydrate.findHydratableFile`'s
 * — one list, shared with the single-book re-fetch — so what the picker gathers
 * from cannot be a different file from what a refresh would read. A folder with
 * no EPUB, MOBI or AZW3 has no embedded jacket to offer and no identifiers to
 * search on, so that is said rather than shown as nothing.
 */
async function hydratableFile(bookDir: string): Promise<string> {
  const file = await bulkHydrate.findHydratableFile(bookDir)
  if (!file) throw new Error('No EPUB, MOBI or AZW3 file in this book to gather covers from')
  return file
}
