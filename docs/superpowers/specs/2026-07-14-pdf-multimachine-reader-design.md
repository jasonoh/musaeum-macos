# Design: PDF Support, Multi-Machine Library Access, and Native Reader

**Date:** 2026-07-14
**Status:** Approved (brainstorming session with Jason)
**Scope:** Three sub-projects, built in order: (A) PDF format support + Calibre
PDF top-up, (B) NAS-authoritative multi-machine access, (C) Musaeum-native
epub/PDF reader.

Context: the initial Calibre migration (5,833 books) is complete. ~2,000
PDF-only books were skipped by design (`BOOK_EXTENSIONS` = epub/mobi/azw3),
and an unknown number of migrated books have a PDF twin in their Calibre
folder that was also skipped. The library lives at a NAS root; each machine
keeps a local SQLite cache that today is only populated by import/migration.

## Decisions made during brainstorming

1. **Sync model:** NAS-authoritative rescan. Any machine can write;
   `metadata.json` per book remains canonical; machines refresh their local
   cache from the NAS on launch and on demand. Last-write-wins; single-user,
   one-machine-at-a-time assumption.
2. **Reader v1 scope:** reading + cross-machine position sync. No
   annotations/highlights/bookmarks in v1.
3. **PDF top-up:** import PDF-only books as new entries AND attach skipped
   PDFs to already-migrated books.
4. **Misc formats** (doc, cbr/cbz, chm, djvu, azw, rar — ~50 books): stay in
   the Calibre archive. Musaeum's format scope is epub/mobi/azw3/pdf.

---

## Section A — PDF support

### Data model

- `pdf` joins the `BookFormat` union in `src/types/book.types.ts`.
- Every `BOOK_EXTENSIONS` set gains `.pdf`: `electron/main/services/
  migration.ts`, `importer.ts`, `file-watcher.ts`, `sidecar/pipeline/
  migrate.py`.
- No SQLite schema change (`formats` is already a JSON array).

### Import pipeline

- Drag-drop and the `imports/` watcher accept `.pdf`.
- New sidecar method `extract_pdf_metadata` (new module
  `sidecar/extractors/pdf_metadata.py`):
  - Embedded title/author via `pypdf`; filename-parse fallback (same
    behavior as epub imports when the sidecar is unavailable).
  - Cover: render page 1 via `pypdfium2`, feed the bytes to the existing
    `_write_cover` so PDFs get real `cover_full.jpg`/`cover_thumb.jpg`.
- Hydration runs unchanged; PDFs usually start from title+author since they
  rarely embed identifiers. Identifier-precedence policy is unaffected.

### Devices / export

- PDFs copy to Kindle `documents/` as-is. `ebook-convert` is never invoked
  for PDFs (output quality unacceptable). A PDF-only book transfers as PDF.
- Apple Books export works unchanged (`open -a Books` handles PDF).

### Calibre PDF top-up (one-time, re-runnable tool)

- New action surfaced alongside the migration wizard: "Import PDFs from
  Calibre". Reads `metadata.db` read-only (immutable open, as always).
- For each Calibre book that has a `.pdf` file on disk:
  - **Match against Musaeum library**, in order: Goodreads ID, ISBN-13,
    then normalized title+author (same normalization the importer's
    duplicate detection already uses). (Calibre IDs were not stored during
    migration, but identifiers were seeded from Calibre, so identifier
    matching is reliable.)
  - **Matched:** copy the PDF into the existing `books/{uuid}/` folder as
    `{sanitized-title}.pdf`, append `pdf` to formats in `metadata.json` and
    the SQLite cache. Skip when the folder already has a PDF (idempotent).
  - **Unmatched:** migrate as a new book through `_migrate_one` with PDF
    allowed — Calibre metadata seed, cover from Calibre `cover.jpg` else
    rendered page 1, `metadata.json`, cache insert.
- Progress streams over the existing `migration_progress` notification
  channel. Completion summary: attached / new / skipped counts.
- New sidecar deps in `requirements.txt`: `pypdf`, `pypdfium2`.

---

## Section B — Multi-machine library access

### Approach

A NAS-level **catalog file** at `{library_root}/catalog.json`: a flattened
array of every book record plus `version` and `generated_at`. One ~10MB read
replaces a 5,800-file SMB walk (which measured in minutes and is a
non-starter per launch). The catalog is a derived cache of the per-book
`metadata.json` files, which remain canonical — the catalog can always be
regenerated, so drift is recoverable, never data loss.

Rejected alternative: full `books/*/metadata.json` walk per launch (too slow
over SMB at this library size). The walk survives as the manual "Rebuild
catalog" recovery action.

### Flows

- **Writes:** every path that writes `metadata.json` (import, metadata edit,
  conflict resolution, rehydrate, top-up, migration completion) also upserts
  that book's entry in `catalog.json`. Bulk operations batch: one catalog
  write at the end, not one per book. Catalog writes are async and off the
  import critical path (~1–2s for ~10MB over SMB).
- **Launch / manual "Refresh library":** read `catalog.json`,
  transactionally replace the local `books` table (sub-second for 5.8k rows
  in better-sqlite3); FTS stays in sync via existing triggers.
- **First run on a new machine:** choose library root → `catalog.json`
  detected → confirmation ("Found a Musaeum library with N books — use
  it?") → cache populated in seconds. No copying database files.
- **Recovery:** "Rebuild catalog" walks all `books/*/metadata.json` with a
  progress bar and rewrites the catalog.

### Concurrency and locality

- Last-write-wins. Single-user, one-machine-at-a-time assumption stated in
  CLAUDE.md. No locking or merging.
- Machine-local by design: `device_history`, unresolved conflict queue,
  UI state. Travels via `metadata.json`: rating, read status, tags, and
  (Section C) `reading_state`.
- Known trade-off: each single-book write rewrites the whole catalog. At
  ~50k+ books switch to a per-book journal; YAGNI at current scale.

---

## Section C — Native reader (epub + PDF)

### Engines

- **EPUB: foliate-js** (MIT; engine behind Foliate/Readest). Modern
  pagination, clean CSS injection for theming, active maintenance. No npm
  package — vendored into the repo. Rejected: epub.js (effectively
  unmaintained, long-standing pagination bugs).
- **PDF: pdf.js** (Mozilla), canvas-rendered.

### Architecture

- Full-window `ReaderView` overlay in the renderer, opened from the book
  detail panel or double-click on a card. New `reader` Zustand store.
- Book bytes served by extending the custom protocol:
  `musaeum://book/{bookId}/{format}`, streamed by the main process from the
  NAS. CSP already permits `musaeum:`; the renderer never sees `file://`.
- Open-format preference: epub → pdf. mobi/azw3-only books show a
  "convert to epub to read" affordance later — not in v1.

### Reading state

- New `reading_state` block in `metadata.json`:
  `{ "position": <EPUB CFI string | PDF page number>, "percent": <0–1>,
  "updated_at": <ISO 8601> }` — plus mirrored `books` columns (new SQLite
  migration) so library views can show progress.
- Saved on reader close and throttled (~30s) while reading. Catalog upsert
  piggybacks on the same write, so position follows the user across
  machines via Section B.
- `read_status` transitions automatically: → `reading` on first open,
  → `read` at ≥98% progress. Manual override still wins.

### Experience (v1)

- Paginated layout, single/double column by window width.
- Typography controls: serif/sans toggle, size, line height, margins.
  Two page themes: warm paper-light and dark-library ink. Prefs are
  per-machine (persisted UI store), not per-book.
- TOC navigation panel (both engines provide TOC data).
- Keyboard: ←/→/space to page, Esc to close.
- PDF mode: fit-width / fit-page, zoom, page navigation, same position
  persistence (page number).
- Out of scope for v1: annotations, highlights, bookmarks, dictionary,
  search-in-book, mobi/azw3 direct rendering.

---

## Testing

- **vitest (main process):** catalog load/upsert/replace logic; top-up
  matching (Goodreads ID / ISBN-13 / normalized title+author) against
  fixture data; reading-state column migration.
- **pytest (sidecar):** `extract_pdf_metadata` against fixture PDFs
  (embedded metadata, no metadata, encrypted-but-readable); top-up
  classification (matched vs new vs skip).
- **Manual:** reader against a set of real-world epubs (large images, fixed
  layout, footnote-heavy) and a scanned PDF; cross-machine position sync
  smoke test; re-run top-up to confirm idempotency.

## Build order and rationale

A → B → C. A changes the data model (formats, new books) that B must
faithfully sync; C depends on B for cross-machine reading state and on A for
PDF display targets. Each section lands as its own plan/branch.
