# File naming, deletion, bulk actions & duplicates

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching on-disk book files, deletion, bulk operations, or duplicate gating.

---

## File naming on disk

`services/book-files.ts` → `renameToTitle(bookDir, title)` keeps a book's format files named `{sanitizeTitle(title)}.{ext}`. Files are named once at import, but the title keeps moving afterwards — hydration rewrites it, and so does the metadata editor — which used to leave the folder holding a book under whatever it was first mistaken for (an EPUB with the wrong OPF metadata named its files after a different book entirely). Called from **every** place the title settles: `importer.hydrate` after `applyHydration`, the `library:updateBook` handler (implemented in `services/library-edit.ts` → `updateBook`), and `metadata:resolveConflict` (`services/conflicts.ts`) (resolving a title conflict is a settled title too — without it, renaming a book back to its embedded title left the Google-matched name on its files).

- **Title-derived, not diff-driven.** It renames anything whose stem doesn't match, so it repairs drift from any cause, not just the edit that called it. That makes it idempotent and safe to call on every update.
- **Never throws, and always runs after the canonical write.** Nothing reads these names — every lookup is by extension (`findFormatFile`, `deleteFormats`, `file-access`) — so a failed rename costs tidiness and must never cost an edit that metadata.json has already recorded.
- **It will not rename one file onto another of the same format.** Renaming is cosmetic; losing a file is not, so a same-extension collision is skipped.

Covers and metadata.json have fixed names and are untouched. Renaming does not reach a copy already sitting on a device — that keeps the name it was sent under until it is removed and re-sent.

---

## The `derived/` folder

`{book}/derived/` holds a book's **derived, fallible rendering cache** — today the PDF reflow: `reflow.epub` beside its `reflow.json` stamp, written by the sidecar's `reflow_pdf` (slice 2, 2026-10-08) and read by the reader once slice 3 routes to it. The rule the feature hangs on (spec D3) is that **a directory name carries no extension**, so every rule above skips it with no change: `renameToTitle` cannot rename it onto a format file, `computeFileSizeBytes` does not count it, `findFormatFile`/`deleteFormats` never match it, and `fs.rm` of the book's folder takes it with the book.

**A derived artifact is never added to `formats` or `file_size_bytes`.** It is not a file the book *holds*: a PDF-only book must not claim an EPUB, or the phone's `preferredFormat`, the Mac's format chips and the `formats` facet counts all inherit a rendering cache as if a device could read it (the precedent that cuts the other way is deliberate — a Calibre-free converted AZW3 *is* added, because it is a real ebook file another device reads).

Two consequences a later change has to respect, both stated because the extension-keyed rules are what make this safe today:

- **A walk that sweeps "all files" in a book folder must skip `derived/` by name.** Today nothing walks recursively; a future sweep that does is the one place this namespace can be broken.
- **A derived artifact is disposable.** Deleting `derived/` loses a cache and never a book: the pass re-runs on the next open, and a reader that finds a missing or unreadable artifact falls back to the original with one line of reason (D6/D9).

---

## Deletion

`services/book-delete.ts` owns both paths; the IPC handlers are thin wrappers.
- `deleteBook` — removes the cache row, the NAS folder, and the catalog entry, **in that order**. The row goes first because the failure modes are not symmetric: a row delete that fails after the files are gone leaves the library showing a book that cannot be opened and cannot be deleted (its folder is already missing) — the state a `device_history` FK produced on every book that had been sent to a device. A folder that fails to remove afterwards is logged and swallowed, leaving recoverable, visible junk on the share. `deleteBooks` uses the same order.
- `deleteFormats` — removes files **by extension** (not by canonical name, so a book renamed after import still matches), then rewrites metadata.json and upserts the catalog. Selecting every format is not a special UI case: it falls through to `deleteBook` and returns `bookDeleted: true`, since a book with no files left is not worth keeping. Formats the book doesn't have are ignored; an entirely non-matching selection throws.

What a delete takes with it is a schema question, not a UI one: `shelf_books` and `metadata_conflicts` rows for the book are deleted in the same transaction as the book (`services/db.ts` → `deleteBook`), while **`device_history` is kept** — it records what this machine sent, and it is the reason migration 005 dropped the FK that used to sit on `device_history.book_id`. `replaceAllBooks` honours the same rule for the swap. Both delete paths then prune the deleted books off every shelf in `shelves.json`, one write per batch, swallowing a failure — and a member a failed prune could not remove stays in `shelves.json` permanently, invisible in the cache, because no write sweeps a shelf's existing membership (that would delete exactly the membership D4's adoption rule protects) (`docs/invariants/shelves.md`).

Entry points, all funneling into one `DeleteBookDialog` (mounted in `App.tsx`, keyed on the target book so each open starts with everything selected): right-click a book in the grid or list (`BookContextMenu`), the hover trash button on `BookCard`, or the detail-panel trash button. The card's delete button is a *sibling* of the card `<button>` inside an overlay that mirrors the cover box — nested buttons are invalid HTML.

---

## Bulk actions

Three, and deliberately not symmetric — the services under them are not.

- **Delete** — `book-delete.deleteBooks(ids)`. Not a loop over `deleteBook`: that removes each book from the catalog individually, and every one of those enqueues a whole-file rewrite of `catalog.json` over SMB plus a `libraryChanged` broadcast that reloads the library. This does the per-book work with no catalog contact and finishes with one `writeFullCatalog()`. A single failure never aborts the rest; the result carries `failed` and those books stay selected so the report doubles as the retry.
- **Send to device** — no main-process work at all. `sendToDevice` returns as soon as the job is enqueued and the transfer queue is already serial, so `device.store.sendBooksToDevice` loops the existing IPC and `StatusBar` counts the jobs for free. Books already on the device are skipped, using the same scanned presence map the card badge uses.
- **Re-hydrate** — `services/bulk-hydrate.ts`, a real job: sequential (the sidecar's thread pool would otherwise fan out concurrent hydrations at rate-limited APIs), cancellable, and batched via a `batched` option on `importer.hydrate` that suppresses its per-book `upsertCatalog` and `libraryChanged` so the job can write the catalog once at the end. Cancelling stops the loop, not the book in flight. Progress and Cancel live in `StatusBar`, because the job outlives the selection; the run's outcome arrives as a toast when it ends (see `docs/invariants/refresh-feedback.md`).

`findHydratableFile` is shared between the bulk job and the single-book `metadata:rehydrateBook` handler so the two cannot disagree about what a book can be hydrated from. PDF-only books have nothing, and are skipped, not failed.

The surface is `SelectionPanel` (the detail slot, same 360px width so the grid never re-flows when the selection changes size), a selection-scoped context menu, and `DeleteSelectionDialog`. Per-book actions are *absent* from the multi-selection menu rather than disabled — silently applying "Read" to one book of twelve is worse than not offering it.

---

## Duplicate Detection

On import, a duplicate **gates** the pipeline: an ISBN-13 match (checked first) OR a normalized title+author match pauses the import between the extract and copy steps and forces a decision in the import overlay (`importer.importOne` awaits a `pendingDecisions` resolver keyed by `jobId`; resolved via `import.resolveDuplicate` IPC). Three actions:
- **Skip** — abort; no book created (watched `imports/` file is still removed)
- **Add as new** — proceed with a fresh UUID + folder + hydration
- **Add format to existing** — copy the file into the matched book's folder, add the format, rewrite metadata.json + catalog; no new book, no hydration. Deletes any existing file of that extension first so `findFormatFile` can't ship a stale copy.

The pending-decision map is keyed by `jobId` because the file-watcher fans out `importOne` concurrently; `abortPendingDecisions()` (on `will-quit`) resolves any open gate as Skip so shutdown never hangs.

**The gate reads the file, and a file is frequently silent about its own identity — so the ISBN a fetch settles gets a second look.** `importer.hydrate` checks the ISBN the row now carries against the library once the row has settled (`services/importer.ts` → `duplicateFor`, `db.findOtherByIsbn13`) and **reports** the collision on the surface that path already has: an import's finished card, the single re-fetch's toast, the bulk job's summary count. Nothing is merged, nothing is deleted, nothing is stored — a shared ISBN is not proof of the same file (the real pair below share one because a summary listing copied it), so the pair is the user's to judge. A job whose gate already named the collision is not told twice, and `importProgress.duplicate` is cleared as the import moves past the gate so that field means exactly one thing afterwards. Design and its measurements: `docs/superpowers/specs/2026-09-20-post-hydration-duplicate-report-design.md`. The case that produced it: a re-import whose EPUB declared **no** identifiers and whose title/author differed from the stored row's spam title, so neither gate rule could fire — and Google Books then stamped `9781707274123` on both rows. Known residue: the report is ephemeral (a card that clears after five seconds, or a toast), the pairs already in the library stay invisible, and unkeyed Google fetches settle no ISBN at all, which makes the check inert in a dev run without `GOOGLE_BOOKS_API_KEY`.

---

## Opening files outside Musaeum

`services/file-access.ts` hands a book's files to the OS, so a PDF can be read in Preview without importing it anywhere:
- `revealBook` — `shell.showItemInFolder` on one of the book's files (the requested format, else the first), so Finder opens the book's folder with the file selected rather than the parent with a folder icon selected. Falls back to `shell.openPath` on the folder when the book has no files.
- `openBookFile` — `shell.openPath` on one format's file.

Both resolve files **by extension** (like `deleteFormats`), so a book renamed after import still opens. Surfaced in the context menu ("Open EPUB" per format
+ "Show in Finder"), and in the detail panel, where the format badges are buttons that open that file and a folder button sits in the actions row.

---
