# Musaeum — Data Contracts

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** changing a stored shape: `metadata.json`, the SQLite schema, a sidecar RPC payload, or the `MusaeumAPI` preload surface.

---

## metadata.json (per book, stored on NAS)

```json
{
  "id": "uuid-v4",
  "title": "Leviathan Wakes",
  "sort_title": "Leviathan Wakes",
  "authors": [
    { "name": "James S.A. Corey", "sort": "Corey, James S.A." }
  ],
  "publisher": "Orbit",
  "published_date": "2011-06-02",
  "language": "en",
  "description": "...",
  "identifiers": {
    "isbn_10": "0316129089",
    "isbn_13": "9780316129084",
    "goodreads": "8855321",
    "openlibrary": "OL24950539M"
  },
  "series": {
    "name": "The Expanse",
    "index": 1.0,
    "total": 9
  },
  "tags": ["science fiction", "space opera"],
  "cover": {
    "full": "cover_full.jpg",
    "thumb": "cover_thumb.jpg",
    "source": "google_books",
    "width": 800,
    "height": 1200
  },
  "formats": ["epub", "mobi", "pdf"],
  "rating": null,
  "read_status": "reading",
  "read_status_at": "2025-01-16T22:04:11Z",
  "reading_state": {
    "position": "epubcfi(/6/14!/4/2/8/1:0)",
    "percent": 0.42,
    "updated_at": "2025-01-16T22:04:11Z"
  },
  "owned_fields": { "author": "2025-01-16T22:04:11Z" },
  "date_added": "2025-01-15T10:30:00Z",
  "last_modified": "2025-01-15T10:31:00Z",
  "metadata_sources": {
    "google_books": {
      "fetched_at": "2025-01-15T10:30:05Z",
      "match_confidence": 0.97
    },
    "openlibrary": {
      "fetched_at": "2025-01-15T10:30:06Z",
      "match_confidence": 0.94
    }
  }
}
```

This is the canonical data contract (iOS companion depends on it). The writer is `importer.writeMetadataJson`. Known gap: cover `source`/`width`/`height` are not persisted yet (see tasks.md).

**`read_status_at` (portable decisions, slice 2, 2026-10-13)** — optional. The ISO time the book's `read_status` was last set, by the detail panel or the reader's automatic advance; absent, `null` or anything unreadable means *no clock* (a reader that does not know the field ignores it). It is the status's **own** clock, separate from `reading_state.updated_at`: on adoption the two are reconciled independently (`library-sync.preserveLocalReadingState`) — the newer position wins the position, the newer status wins the status, and a tie or an unparseable local clock keeps the incoming record. Mirrored in `catalog.json` (`readStatusAt`, like every other catalog entry key) and in the `books.read_status_at` column (migration 008, `NULL` = none); migration 008 seeds the column from `reading_updated_at`, which is the clock a status decision moved before this column existed. `metadata.json` may lag the row for a status won by a reconcile, exactly as `owned_fields` does.

**`owned_fields` (portable decisions, slice 1, 2026-10-11)** — optional. A map of the fields the user has claimed, `HydratedField` name to the ISO time the claim was made; absent, `null` or anything unreadable means *no claims*, and a reader that does not know the field ignores it. A claimed field is one a fetch never overwrites: `importer.hydrate` tells the sidecar not to propose it and filters the reply before the write. The map is the book's own record — it travels with `metadata.json`, is mirrored in `catalog.json` (as `ownedFields`, like every other catalog entry key) and in the `books.owned_fields` column (migration 007, JSON text, `NULL` = none) — so a fetch run from another machine honors it too. The writer emits it only when it holds at least one claim, and every reader validates it (`parseOwnedFields` in `electron/main/services/owned-fields.ts`): a bad value is no claims, a bad *member* is dropped without taking its neighbors. On adoption the two machines' maps are reconciled per field by `reconcileOwnedFields` (same file): where both sides hold a claim the strictly newer time wins and a tie keeps the incoming one; a claim only the other side holds is taken; a claim only this machine holds is ordered against the incoming record's `last_modified` — it stands unless it is older than that, which is how a release on the other machine (a release removes the entry and bumps `last_modified`) beats an older claim here. An unparseable or absent `last_modified` keeps the claim. A release is online-only, because it has to reach `metadata.json`. `metadata.json` may lag the row for a claim seeded by the upgrade or won by a reconcile: `catalog.json` carries it at once, `metadata.json` on that book's next write.

---

## shelves.json (library-level, stored on NAS)

One file per library, not one per book — `{library_root}/shelves.json`, canonical the way `metadata.json` is canonical, and never derived (`docs/invariants/shelves.md`). Written only by `electron/main/services/shelves.ts`; read by `services/shelves-file.ts`.

```json
{
  "version": 1,
  "shelves": [
    {
      "id": "uuid-v4",
      "name": "To Read",
      "kind": "manual",
      "created_at": "2026-09-27T10:00:00.000Z",
      "updated_at": "2026-09-27T10:05:00.000Z",
      "books": [{ "id": "book-uuid", "added_at": "2026-09-27T10:05:00.000Z" }]
    }
  ]
}
```

- `version` — the file format's own version, independent of the REST `apiVersion`. A file whose `version` this build does not recognize is treated as unreadable and never rewritten in this build's shape.
- `shelves[].id` — a UUID, stable for the shelf's life.
- `shelves[].kind` — `"manual"` for every shelf this build creates or edits. A kind this build does not know (a future smart shelf) is preserved on every write exactly as read, never edited or dropped.
- `shelves[].name` — trimmed, non-empty, at most 80 characters, unique case-insensitively among manual shelves.
- `shelves[].created_at` / `updated_at` — ISO 8601; `updated_at` moves on a rename or a membership change, never on a no-op.
- `shelves[].books[].id` / `added_at` — one row per member, `added_at` set when the book joined and preserved by an Undo (`restoreBooks`) so the book returns to its place under *Date Added to Shelf*.

A hand-edited or corrupted file — invalid JSON, or a manual shelf missing a required field — makes the **whole file** unreadable rather than dropping the one bad entry: every mutation refuses with a named sentence until it is repaired by hand, because silently discarding an entry on the next write would destroy it. See `docs/invariants/shelves.md` for the full reasoning (storage choice, the write queue, adoption, and deletion's residue).

---

## annotations.json (per book, stored on NAS)

One file per book, beside its `metadata.json` — `{library_root}/books/{uuid}/annotations.json`, canonical for its own kind of data and never derived (annotations design D1). Written only by `electron/main/services/annotations.ts`; the name, the parser and the atomic write live in `services/annotations-file.ts`, and `test/invariants.test.ts` enforces both halves of that (one module spells the name, and only the service imports it).

```json
{
  "version": 1,
  "book_id": "book-uuid",
  "annotations": [
    {
      "id": "uuid-v4",
      "type": "highlight",
      "cfi": "epubcfi(/6/14!/4/2/8,/1:0,/1:41)",
      "quote": "The protomolecule is loose.",
      "prefix": "and then",
      "suffix": "It was not",
      "percent": 0.42,
      "section_label": "Chapter 7",
      "color": "gold",
      "note": null,
      "artifact": { "kind": "source", "format": "epub", "stamp": null },
      "created_at": "2026-10-13T11:02:41.000Z",
      "updated_at": "2026-10-13T11:02:41.000Z"
    }
  ]
}
```

- `version` — the file format's own version, independent of the REST `apiVersion`. A file whose `version` this build does not recognize is unreadable and is never rewritten in this build's shape.
- `book_id` — the folder's own id. Not a rule: the file is found by its folder, so a file naming another book is repaired on the next write rather than refused.
- `annotations[].id` / `type` / `created_at` / `updated_at` — minted by the writer, never taken from a caller. `type` is `"highlight"` for everything this build writes, and an entry whose `type` this build does not know is preserved verbatim on every write.
- `annotations[].cfi` — a position in _the artifact the reader had open_, and `quote` / `prefix` / `suffix` / `percent` / `section_label` are what the panel shows and what a later re-anchor needs. The quote and its context are capped (512 and 32 code points) because the whole file is read when a book opens.
- `annotations[].artifact` — what the `cfi` is a path into: `kind` `"source"` (the book's own file, `stamp` null) or `"derived"` (the reflow, carrying a digest of `derived/reflow.json` **whole** — its converter triple and the source size and mtime the pass recorded, which is the condition the pass itself caches on). A `format` this build cannot open is refused with the whole file. **This member never crosses the preload bridge**: the renderer is told `stale` instead, so no renderer can read or name a `derived/` fact.
- Staleness is computed per call and never stored. An annotation is `stale` when the artifact the reader would be served now is not the one the record names — and a stale annotation is listed, never drawn, because `addAnnotation` applies the `cfi` as a node path and a path that still resolves can land on a _different_ sentence.
- A file that exists and cannot be read is never overwritten, by any of the three mutations; a failed read is a state the panel renders rather than an empty list.

Deleting a book removes its folder, and the notes go with it. See `docs/superpowers/specs/2026-10-13-annotations-design.md` for the storage decision, the three rejected alternatives, and the wire's position.

---

## SQLite Schema

Canonical DDL: `electron/main/schema/migrations/001_initial.sql`. Matches the original spec plus: FTS5 sync triggers (insert/update/delete), indices on `isbn_13` / series / author, `device_history.error` column, and a partial index on unresolved conflicts. Schema versioning via `PRAGMA user_version`; new migrations are appended to the `MIGRATIONS` array in `services/db.ts`. `device_history.book_id` lost its `REFERENCES books(id)` in migration 005 — history outlives the book it was sent for, and the constraint made a sent book undeletable (`docs/invariants/files-and-deletion.md`). Migration 006 dropped the never-used `collections` / `book_collections` tables — guarded to fail the migration rather than discard rows if either ever held any — and added `shelves` / `shelf_books` as a cache of `shelves.json`, with no foreign keys, because a member may name a book this machine's catalog does not hold yet and the rows are replaced wholesale on every write and on adoption (`docs/invariants/shelves.md`).

```sql
CREATE TABLE books (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  sort_title        TEXT,
  author            TEXT,
  author_sort       TEXT,
  publisher         TEXT,
  published_date    TEXT,
  language          TEXT,
  description       TEXT,
  isbn_10           TEXT,
  isbn_13           TEXT,
  goodreads_id      TEXT,
  openlibrary_id    TEXT,
  series_name       TEXT,
  series_index      REAL,
  series_total      INTEGER,
  cover_thumb_path  TEXT,
  cover_full_path   TEXT,
  formats           TEXT,          -- JSON array
  tags              TEXT,          -- JSON array
  rating            INTEGER,       -- 1-5, user-set
  date_added        TEXT,
  last_modified     TEXT,
  file_size_bytes   INTEGER,
  read_status       TEXT DEFAULT 'unread',
  nas_path          TEXT,          -- relative to library root
  reading_position  TEXT,          -- opaque to us: CFI, engine locator, page
  reading_percent   REAL,          -- 0–1; the portable fallback
  reading_updated_at TEXT,         -- compared on adoption; newer local wins
  owned_fields      TEXT,          -- JSON { field: ISO time } of user claims, NULL = none (migration 007)
  read_status_at    TEXT           -- when read_status was last set; NULL = no clock (migration 008)
);

CREATE VIRTUAL TABLE books_fts USING fts5(
  title, author, series_name, tags, description,
  content='books', content_rowid='rowid'
);

-- shelves / shelf_books replace the never-used collections / book_collections
-- tables (migration 006) — a cache of shelves.json, no foreign keys.
CREATE TABLE shelves (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'manual',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE shelf_books (
  shelf_id  TEXT NOT NULL,
  book_id   TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (shelf_id, book_id)
);

CREATE INDEX idx_shelf_books_book ON shelf_books(book_id);

CREATE TABLE device_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     TEXT,                -- provenance only: the row outlives the book (migration 005)
  device_id   TEXT,
  device_name TEXT,
  sent_at     TEXT,
  format_sent TEXT,
  error       TEXT
);

CREATE TABLE metadata_conflicts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id       TEXT REFERENCES books(id),
  field         TEXT,
  candidates    TEXT,    -- JSON array of {source, value} objects
  resolved      INTEGER DEFAULT 0,
  resolved_at   TEXT,
  chosen_source TEXT
);

CREATE TABLE app_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

`app_config` keys in use: `library_root`, `smb_url`, `python_path`, `google_books_api_key`, the Ask trio `ai_base_url` / `ai_model` / `ai_api_key`, the API's four `rest_api_enabled` / `rest_api_port` / `rest_api_bind` / `rest_api_token` (slice 2 of the iOS companion, 2026-09-22), `field_overrides` (**dead since migration 007**: the pre-portable map of user claims, read once by the upgrade to seed `books.owned_fields` and never written again; the row is left in place as the rollback path), and the theming trio `theme_id` / `theme_tokens` / `theme_library` (slice 3, 2026-09-16). **Everything but the last two groups is editable in Settings — the API's three included, its token generated and read-only** (corrected 2026-09-22: this sentence used to exclude them, which was true only until slice 2 gave them a row in the Phone access section — `docs/superpowers/specs/2026-09-22-ios-companion-design.md` D13); a key is deleted rather than blanked when cleared (see Settings above), and for `rest_api_port` and `rest_api_bind` that deletion *is* what "blank" means: the compiled-in port and this machine's tailnet address respectively. `rest_api_token` is the one key nothing types — it is generated when the API is enabled and survives disabling, and the UI never sends it. The theming trio is the exception to that editability: a theme is not a path and has no auto-detection, so it keeps its own keys and its own save path (§2.3 — no theme key in `EditableSettings`), and the Appearance picker (slice 4) is what writes `theme_id`. `ebook_convert_path` is the one key deliberately **no longer read**: an install that has one keeps an orphan row, because nothing migrates or deletes it, and the Settings field left with the Calibre-free conversion (spec slice 3, 2026-10-09).

The theme keys are the first *main-process-visible* preference of this kind — `createWindow()` reads them to color the window before the renderer exists — and they carry three rules the rest of `app_config` does not: both keys are written in one transaction by `theme/store.ts` (the only legal states are "both absent" and "both present and agreeing"), `theme_tokens` is re-validated on *every* read with a failure degrading to the built-in default rather than throwing, and `theme_library` is preserved untouched until the picker (slice 4) becomes its only writer. `docs/invariants/settings-and-editing.md` carries the reasoning.

---

## Python Sidecar Communication

JSON-RPC over stdio, newline-delimited JSON. All calls are async from Node's perspective (`sidecar.call(method, params, timeoutMs)`), dispatched on a thread pool in Python so long calls don't serialize.

---

## Message Format

```json
// Request (Node → Python)
{ "id": "req-123", "method": "hydrate_metadata", "params": { ... } }

// Response (Python → Node)
{ "id": "req-123", "result": { ... }, "error": null }

// Notification (Python → Node, no id) — e.g. migration progress
{ "method": "migration_progress", "params": { "job_id": "...", ... } }
```

---

## Sidecar Methods

| Method                  | Description                                      |
|-------------------------|--------------------------------------------------|
| `extract_epub_metadata` | Parse OPF from EPUB file                         |
| `extract_pdf_metadata`  | Parse PDF Info dict (title/author)               |
| `read_calibre_db`       | Extract records from Calibre metadata.db (read-only, immutable open) |
| `hydrate_metadata`      | Full pipeline: fetch, merge, score, write covers |
| `fetch_cover`           | Download a specific cover URL (conflict resolution path) |
| `convert_format`        | Convert EPUB → AZW3 with the in-house writer     |
| `migrate_library`       | Full Calibre migration; streams `migration_progress` notifications |
| `topup_pdfs`            | Re-runnable Calibre PDF top-up; streams `migration_progress` |
| `reflow_pdf`            | Reflow a book's PDF into `{book}/derived/reflow.epub` + `reflow.json` (cached; temp-write-and-rename); streams `reflow_progress` notifications |

Python resolution order (`services/python-env.ts`, and see `docs/invariants/packaging-and-python.md`): `app_config.python_path` → bundled runtime → `sidecar/.venv/bin/python` → `userData/sidecar-venv/bin/python` → a system `python3.12`/`3.11`/`3` found by name *or absolute path* and version-checked against 3.11. The sidecar auto-restarts on crash (max 3 attempts); when unavailable the app degrades gracefully (imports fall back to filename metadata).

**`reflow_pdf` in detail** (spec D7/D9; slice 2, 2026-10-08; called by the Mac's reader since slice 3, 2026-10-09). Parameters: `book_dir`, `pdf_path`, and optionally `book_id` (echoed on every progress frame) and `force`. The pass is cached: it runs only when `{book}/derived/reflow.epub` is missing or unreadable, or when the source's recorded size or mtime or the converter version in `{book}/derived/reflow.json` no longer matches the file on disk. The answer is `{status, reason, verdict, epub, stamp_file, bytes, pages, text_pages, toc_entries, toc_from, figures, plates, words, page_map, layout_errors, vision_regions, seconds}`; `status` is `"produced"`, `"cached"`, or D6's `"fallback"` — and a fallback wrote nothing, with `reason` the one line to show and `epub`/`stamp_file` empty. While it runs it streams `reflow_progress` notifications, `{book_id, phase, completed, total}` with `phase` one of `start`, `layout`, `reading`, `writing`, `done`, `cached`, `fallback`; the two page phases share one page count, so a bar can show either or their sum. Nothing outside `{book}/derived/` is written (AC2), and two calls for one book run one pass (the sidecar locks per artifact).

---

## IPC API Surface (preload → renderer)

Exposed via contextBridge as `window.Musaeum`. Full contract: `src/types/api.types.ts` (`MusaeumAPI`). Every handler returns an `IPCResult<T>` envelope which the preload unwraps — renderer code sees plain promises that reject with the error message.

```typescript
interface MusaeumAPI {
  library: {
    getBooks(filters?: BookFilters): Promise<Book[]>
    getBook(id: string): Promise<Book>
    searchBooks(query: string, sort?: BookSort, scope?: ShelfScope): Promise<Book[]>  // sort ?? rank; scope narrows to one shelf
    updateBook(id: string, updates: Partial<Book>): Promise<void>
    getFieldOverrides(id: string): Promise<HydratedField[]>   // fields a fetch must not touch
    releaseFieldOverride(id: string, field: HydratedField): Promise<HydratedField[]>
    deleteBook(id: string): Promise<void>
    deleteFormats(id: string, formats: BookFormat[]): Promise<{ bookDeleted: boolean }>
    deleteBooks(ids: string[]): Promise<BulkDeleteResult>  // batched; partial-tolerant
    getFacets(scope?: ShelfScope): Promise<LibraryFacets>  // filter sidebar counts; one shelf's, when scoped
    refreshLibrary(): Promise<{ books: number }>   // re-read catalog.json into cache
    rebuildCatalog(): Promise<{ books: number }>   // recovery: walk metadata.json files
  }
  shelves: {                                     // user-made shelves; see docs/invariants/shelves.md
    list(): Promise<ShelfSummary[]>              // alphabetical, case-insensitive
    forBook(bookId: string): Promise<ShelfSummary[]>
    create(name: string, bookIds?: string[]): Promise<ShelfSummary>  // names: trimmed, ≤80 chars, unique
    rename(id: string, name: string): Promise<void>
    delete(id: string): Promise<void>            // books stay in the library
    addBooks(id: string, bookIds: string[]): Promise<ShelfAddResult>  // { added, alreadyOn }
    removeBooks(id: string, bookIds: string[]): Promise<ShelfMembership[]>  // for an Undo
    restoreBooks(id: string, memberships: ShelfMembership[]): Promise<void>
    onChanged(cb): Unsubscribe                   // shelf or membership changed
  }
  import: {
    addFiles(filePaths: string[]): Promise<ImportResult[]>
    getImportProgress(jobId: string): Promise<ImportProgress | null>
  }
  metadata: {
    getConflictQueue(): Promise<MetadataConflict[]>
    resolveConflict(conflictId: number, choices: ConflictChoices): Promise<void>
    /**
     * Re-fetch one book's metadata and report what it did (`HydrateOutcome`).
     * Rejects only for the pre-flight failures — offline, no metadata engine,
     * nothing hydratable in the book's folder.
     */
    rehydrateBook(bookId: string): Promise<HydrateOutcome>
    rehydrateBooks(bookIds: string[]): Promise<void>  // sequential job; events report
    cancelRehydrate(): Promise<void>             // stops after the book in flight
  }
  devices: {
    getConnectedDevices(): Promise<Device[]>
    sendToDevice(bookId: string, deviceId: string): Promise<TransferJob>
    getTransferProgress(jobId: string): Promise<TransferProgress | null>
    exportToAppleBooks(bookId: string): Promise<void>
    getOnDeviceBookIds(deviceId: string): Promise<string[]>
    removeFromDevice(bookId, deviceId): Promise<{ removed: number }>  // deletes off device
  }
  nas: {
    getStatus(): Promise<NASStatus>
    reconnect(): Promise<boolean>
    setLibraryRoot(path: string): Promise<void>
    chooseLibraryRoot(): Promise<string | null>  // native folder picker
  }
  settings: {
    get(): Promise<SettingsView>                 // values + what each resolves to
    save(updates: Partial<EditableSettings>): Promise<void>  // validates, may restart sidecar
    chooseExecutable(kind: ExecutableKind): Promise<string | null>
  }
  migration: {
    scanCalibreLibrary(path: string): Promise<MigrationScan>
    startMigration(options: MigrationOptions): Promise<MigrationJob>
    getMigrationProgress(jobId: string): Promise<MigrationProgress | null>
    startPdfTopUp(calibrePath: string): Promise<MigrationJob>  // re-runnable PDF attach/import
    confirmCutover(): Promise<void>
    chooseCalibrePath(): Promise<string | null>  // native folder picker
  }
  theme: {                                      // slice 3
    get(): Promise<ThemeView>                   // { active, defaultId, stale }
    set(id: string): Promise<ThemeView>         // derive → validate → write → broadcast
  }                                             // options/folder + import arrive in slice 4
  files: {
    getPathForFile(file: File): string           // dropped File → path (webUtils)
    revealBook(bookId, format?): Promise<void>   // Finder, file selected
    openBookFile(bookId, format): Promise<void>  // system default app
  }
  reader: {
    saveProgress(report: ProgressReport): Promise<void>  // tiered write; see docs/invariants/reader.md
  }
  on: {                                          // all return an Unsubscribe fn
    nasStatusChanged(cb): Unsubscribe
    deviceConnected(cb): Unsubscribe
    deviceDisconnected(cb): Unsubscribe
    importProgress(cb): Unsubscribe
    conflictQueueUpdated(cb): Unsubscribe        // payload: unresolved count
    transferProgress(cb): Unsubscribe
    libraryChanged(cb): Unsubscribe              // any book data changed → reload
    catalogRebuildProgress(cb): Unsubscribe      // {completed, total} during rebuild
    bulkHydrateProgress(cb): Unsubscribe         // bulk re-hydrate; running:false ends it
    menuCommand(cb): Unsubscribe                 // native menu → UI action
    pythonEnvProgress(cb): Unsubscribe           // first-run venv bootstrap
    themeChanged(cb): Unsubscribe                // the active theme changed (slice 3)
  }
}
```

---
