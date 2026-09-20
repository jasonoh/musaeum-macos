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
  "reading_state": {
    "position": "epubcfi(/6/14!/4/2/8/1:0)",
    "percent": 0.42,
    "updated_at": "2025-01-16T22:04:11Z"
  },
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

---

## SQLite Schema

Canonical DDL: `electron/main/schema/migrations/001_initial.sql`. Matches the original spec plus: FTS5 sync triggers (insert/update/delete), indices on `isbn_13` / series / author, `device_history.error` column, and a partial index on unresolved conflicts. Schema versioning via `PRAGMA user_version`; new migrations are appended to the `MIGRATIONS` array in `services/db.ts`. `device_history.book_id` lost its `REFERENCES books(id)` in migration 005 — history outlives the book it was sent for, and the constraint made a sent book undeletable (`docs/invariants/files-and-deletion.md`).

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
  reading_updated_at TEXT          -- compared on adoption; newer local wins
);

CREATE VIRTUAL TABLE books_fts USING fts5(
  title, author, series_name, tags, description,
  content='books', content_rowid='rowid'
);

CREATE TABLE collections (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  color TEXT
);

CREATE TABLE book_collections (
  book_id       TEXT REFERENCES books(id),
  collection_id TEXT REFERENCES collections(id),
  PRIMARY KEY (book_id, collection_id)
);

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

`app_config` keys in use: `library_root`, `smb_url`, `python_path`, `ebook_convert_path`, `google_books_api_key`, `rest_api_enabled`, and the theming trio `theme_id` / `theme_tokens` / `theme_library` (slice 3, 2026-09-16). All but `rest_api_enabled` are editable in Settings; a key is deleted rather than blanked when cleared (see Settings above). The theming trio is the exception to that editability: a theme is not a path and has no auto-detection, so it keeps its own keys and its own save path (§2.3 — no theme key in `EditableSettings`), and the Appearance picker (slice 4) is what writes `theme_id`.

The theme keys are the first *main-process-visible* preference of this kind — `createWindow()` reads them to colour the window before the renderer exists — and they carry three rules the rest of `app_config` does not: both keys are written in one transaction by `theme/store.ts` (the only legal states are "both absent" and "both present and agreeing"), `theme_tokens` is re-validated on *every* read with a failure degrading to the built-in default rather than throwing, and `theme_library` is preserved untouched until the picker (slice 4) becomes its only writer. `docs/invariants/settings-and-editing.md` carries the reasoning.

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
| `convert_format`        | Wrap ebook-convert for format conversion         |
| `migrate_library`       | Full Calibre migration; streams `migration_progress` notifications |
| `topup_pdfs`            | Re-runnable Calibre PDF top-up; streams `migration_progress` |

Python resolution order (`services/python-env.ts`, and see `docs/invariants/packaging-and-python.md`): `app_config.python_path` → bundled runtime → `sidecar/.venv/bin/python` → `userData/sidecar-venv/bin/python` → a system `python3.12`/`3.11`/`3` found by name *or absolute path* and version-checked against 3.11. The sidecar auto-restarts on crash (max 3 attempts); when unavailable the app degrades gracefully (imports fall back to filename metadata).

---

## IPC API Surface (preload → renderer)

Exposed via contextBridge as `window.Musaeum`. Full contract: `src/types/api.types.ts` (`MusaeumAPI`). Every handler returns an `IPCResult<T>` envelope which the preload unwraps — renderer code sees plain promises that reject with the error message.

```typescript
interface MusaeumAPI {
  library: {
    getBooks(filters?: BookFilters): Promise<Book[]>
    getBook(id: string): Promise<Book>
    searchBooks(query: string, sort?: BookSort): Promise<Book[]>  // sort ?? rank
    updateBook(id: string, updates: Partial<Book>): Promise<void>
    deleteBook(id: string): Promise<void>
    deleteFormats(id: string, formats: BookFormat[]): Promise<{ bookDeleted: boolean }>
    deleteBooks(ids: string[]): Promise<BulkDeleteResult>  // batched; partial-tolerant
    getFacets(): Promise<LibraryFacets>          // filter sidebar counts
    refreshLibrary(): Promise<{ books: number }>   // re-read catalog.json into cache
    rebuildCatalog(): Promise<{ books: number }>   // recovery: walk metadata.json files
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
