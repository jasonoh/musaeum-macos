# Musaeum — Claude Code Project Brief

## Project Overview

Musaeum is a macOS Electron application for personal ebook library management,
designed to replace Calibre for a library of 7000+ books stored on
network-attached storage. It prioritizes automatic metadata hydration,
clean organization, and frictionless device delivery.

**Beauty is a first-class requirement.** The UI follows a "dark library"
aesthetic: warm near-black surfaces, amber/gold accents, serif display type
for book titles, covers as the hero element. Design tokens live in
`tailwind.config.js` (`ink`, `parchment`, `gold` palettes; `font-display`).

## Status

Phase 1 (MVP) was implemented and verified end-to-end on 2026-07-12: import →
hydration → conflict queue → covers → FTS all confirmed against live APIs.
See `tasks.md` for the roadmap and known gaps, `README.md` for setup, and
`CHANGELOG.md` for history.

Dev quickstart:

```bash
npm install                                  # postinstall rebuilds better-sqlite3
python3.12 -m venv sidecar/.venv && sidecar/.venv/bin/pip install -r sidecar/requirements.txt
npm run dev                                  # launch with hot reload
npm run typecheck && npm run lint            # keep clean; both pass on main
npm test                                     # vitest main-process suite —
                                             # runs Electron-as-Node so the
                                             # better-sqlite3 native ABI matches;
                                             # invoke only via this script
```

Dev database: `~/Library/Application Support/Musaeum/musaeum.db` (WAL — safe
to inspect with the sqlite3 CLI while the app runs).

---

## Architecture

### Stack

| Layer            | Technology                        |
|------------------|-----------------------------------|
| Shell            | Electron (latest LTS)             |
| UI               | React + TypeScript                |
| Styling          | Tailwind CSS                      |
| State            | Zustand                           |
| Main Process     | Node.js (Electron)                |
| Local Database   | SQLite via better-sqlite3         |
| Metadata/Convert | Python 3.11+ sidecar              |
| Format Conversion| Calibre CLI (ebook-convert)       |
| IPC              | Electron contextBridge + ipcMain  |

### Process Model

```
Electron Main Process (Node.js)
├── IPC handlers (all file, DB, device, NAS operations)
├── SMB mount manager + health check (30s interval)
├── File watcher (chokidar) on /imports/
├── USB device detection (Kindle)
├── SQLite cache manager (better-sqlite3)
├── Transfer queue manager
└── Python sidecar process manager

Electron Renderer Process (React)
├── Library views (Grid, List, Detail)
├── Search + filter sidebar
├── Metadata conflict resolution UI
├── Device panel
└── Migration wizard

Python Sidecar (spawned by main process)
├── EPUB internal metadata extractor
├── Calibre metadata.db reader (migration only)
├── Metadata fetchers (Google Books, OpenLibrary)
├── Cover image scorer + downloader
├── Goodreads series scraper
├── Calibre migration orchestrator
└── ebook-convert wrapper
```

### Directory Structure (as built)

```
Musaeum/
├── CLAUDE.md / README.md / tasks.md / CHANGELOG.md
├── package.json / tsconfig*.json / electron.vite.config.ts
├── tailwind.config.js / postcss.config.js / eslint.config.mjs
├── vitest.config.ts              # main-process test config (@shared/electron aliases)
├── test/                         # vitest suite + mocks/ (electron stub, helpers)
├── index.html                    # renderer entry (CSP: only self + musaeum:)
│
├── electron/
│   ├── main/
│   │   ├── index.ts              # app lifecycle, window, musaeum:// protocol
│   │   ├── env.d.ts              # *.sql?raw module declaration
│   │   ├── api/
│   │   │   └── rest.ts           # REST stub — disabled via rest_api_enabled
│   │   ├── ipc/
│   │   │   ├── handle.ts         # IPCResult wrapper — all handlers use this
│   │   │   ├── library.ts        # book CRUD + import handlers
│   │   │   ├── metadata.ts       # conflict queue, resolve, rehydrate
│   │   │   ├── device.ts         # devices, transfers, Apple Books
│   │   │   ├── nas.ts            # status, reconnect, choose library root
│   │   │   └── migration.ts      # scan, start, progress, cutover
│   │   ├── services/             # ALL business logic lives here
│   │   │   ├── events.ts         # main → renderer broadcast helper
│   │   │   ├── db.ts             # connection, migrations, queries, config
│   │   │   ├── nas-manager.ts    # mount detection, backoff reconnect
│   │   │   ├── file-watcher.ts   # chokidar on {root}/imports/
│   │   │   ├── importer.ts       # import pipeline + metadata.json writer
│   │   │   ├── device-manager.ts # /Volumes polling, Kindle detection
│   │   │   ├── transfer-queue.ts # serial queue, conversion, copy progress
│   │   │   ├── sidecar.ts        # python spawn, JSON-RPC, notifications
│   │   │   ├── migration.ts      # migration orchestration (node side)
│   │   │   ├── catalog.ts        # catalog.json read/write/upsert + rebuild walk
│   │   │   ├── library-sync.ts   # catalog ⇄ SQLite cache (adopt, refresh, rebuild)
│   │   │   └── apple-books.ts    # open -a Books
│   │   └── schema/migrations/
│   │       └── 001_initial.sql   # includes FTS5 sync triggers + indices
│   └── preload/
│       └── index.ts              # window.Musaeum contextBridge surface
│
├── src/                          # Renderer (React)
│   ├── main.tsx / App.tsx / index.css
│   ├── components/
│   │   ├── layout/               # Sidebar, Toolbar, StatusBar
│   │   ├── library/              # GridView, ListView, BookCard, BookDetail, ImportOverlay
│   │   ├── metadata/             # ConflictQueue, ConflictResolver
│   │   ├── device/               # DevicePanel, TransferQueue
│   │   ├── migration/            # MigrationWizard
│   │   └── shared/               # FilterSidebar, SearchBar, NASStatusBanner, icons
│   ├── stores/                   # library / device / nas / ui zustand stores
│   ├── hooks/                    # useLibrary, useDevice, useNASStatus, useDragDrop
│   └── types/                    # SHARED contracts: book / device / metadata /
│                                 # api (MusaeumAPI + IPCResult) — imported by
│                                 # main and preload via the @shared alias
│
└── sidecar/                      # Python sidecar (venv at sidecar/.venv)
    ├── requirements.txt
    ├── requirements-dev.txt      # pytest, for `sidecar/tests/`
    ├── main.py                   # JSON-RPC over stdio, thread pool dispatch
    ├── extractors/               # epub_metadata.py, pdf_metadata.py, calibre_db.py
    ├── fetchers/                 # google_books.py, openlibrary.py, goodreads.py
    ├── pipeline/                 # hydration.py, conflict.py, cover.py, migrate.py,
    │                             # topup.py (Calibre PDF top-up)
    ├── conversion/               # converter.py (ebook-convert wrapper)
    └── tests/                    # pytest — pdf_metadata, hydration_pdf, topup
```

Path aliases: `@/*` → `src/*` (renderer), `@shared/*` → `src/types/*`
(all three layers). Configured in `electron.vite.config.ts` and both tsconfigs.

---

## Key Behaviors

### NAS / Storage

- Library root is configurable; stored in `app_config` key `library_root`
- SMB share for auto-reconnect: `app_config` key `smb_url` (default `smb://ohnas`)
- On launch: check if NAS volume is mounted
  - If mounted: proceed normally (also ensures `books/`, `imports/`, `exports/` exist)
  - If not mounted: attempt auto-reconnect via `open -g smb://…`
  - If reconnect fails: enter **offline/read-only mode**
    - SQLite cache serves all browse and search operations
    - Write operations throw via `nas.assertOnline()` with clear UI feedback
    - Reconnection retried on exponential backoff: 5s → 15s → 60s
    - Non-blocking status banner shown; user can manually retry
- NAS health checked every 30 seconds while app is running
- No hardcoded NAS paths stored in SQLite — all paths relative to library root
- Cover images are served to the renderer via the custom
  **`musaeum://cover/{bookId}/{thumb|full}`** protocol — the renderer never
  gets raw `file://` access (CSP enforces this)
- **Multi-machine**: `catalog.json` at the library root is a derived cache of
  every book's `metadata.json` (which stays canonical). Every metadata write
  upserts it (bulk ops batch one write); on connect and on "Refresh Library"
  the local SQLite cache is transactionally replaced from it; "Rebuild
  Catalog" re-walks `books/*/metadata.json` as recovery. Last-write-wins,
  one machine at a time. (`services/catalog.ts`, `services/library-sync.ts`)

### Book Storage Structure (NAS)

```
{library_root}/
  catalog.json                     # derived cache of all metadata.json (multi-machine)
  books/
    {uuid}/
      {sanitized-title}.epub
      {sanitized-title}.mobi       # cached, generated on demand
      {sanitized-title}.azw3       # cached, generated on demand
      {sanitized-title}.pdf        # original import or Calibre top-up; never converted
      cover_full.jpg               # 600px
      cover_thumb.jpg              # 200px
      metadata.json
  exports/                         # ephemeral; cleared post-transfer
  imports/                         # drag-drop landing zone (watched)
```

### Metadata Hydration Pipeline

Triggered automatically on every book import. Non-blocking: the book is
inserted into the library immediately after copy; hydration continues async
(`importer.hydrate` is fire-and-forget).

```
1. Extract embedded metadata (EPUB OPF, or PDF Info dict + page-1 render as
   an 'embedded' cover candidate)
2. Known identifiers (from Calibre during migration) merged in
3. Parallel fetch: Google Books API + OpenLibrary API
4. Series data: Goodreads scrape when a Goodreads ID is known (any source)
5. Conflict resolution (see policy below)
6. Cover fetch + scoring (formula below)
7. Write metadata.json to NAS + update SQLite cache
```

**Identifier precedence (learned in testing):** identifiers baked into the
file or seeded from Calibre are definitive and always override fetched ones —
online fetches may match a different *edition* of the same work.
(`sidecar/pipeline/hydration.py`)

**Conflict policy** (`sidecar/pipeline/conflict.py`):
- `title`, `author`, `series` — best candidate applied immediately AND a
  review conflict queued when sources disagree (book is never left blank)
- `publisher`, `published_date`, `language` — auto-resolved by source
  priority, never queued
- `description` — longest candidate wins, never queued
- `cover` — top-scored applied; a review conflict is queued when the top two
  score within 15% (candidate values are image URLs)
- Source priority: google_books > openlibrary/goodreads > calibre > embedded,
  biased by the user's past resolutions (`db.getSourcePreferences()`)

Cover scoring formula:
```
score = (resolution × 0.4) + (aspect_ratio × 0.3)
      + (source_priority × 0.2) + (file_size × 0.1)
```

Google Books API key: read from the `GOOGLE_BOOKS_API_KEY` environment
variable (optional for normal use; required before bulk migration).

### Conflict Resolution UI

- Surfaced as a review queue (badge count in sidebar → modal)
- Never blocks import flow
- Per-conflict: side-by-side candidate comparison, click to choose
- "Accept all from Source X" shortcut
- Resolutions logged (`metadata_conflicts.chosen_source`) and fed back into
  auto-resolution scoring on future hydrations

### Series Convention

```json
{
  "series_name": "The Expanse",
  "series_index": 1.0,
  "series_total": 9,
  "series_display": "The Expanse #1"
}
```

- `series_index` is float (supports 0.5, 1.5 for novellas)
- Display format: drop `.0` for whole numbers — use the shared
  `seriesDisplay()` helper in `src/types/book.types.ts`
- `series_total` from Goodreads where available

### Kindle Transfer (USB)

- Detect Kindle by polling `/Volumes` every 5s (name contains "kindle", or
  volume has both `documents/` and `system/` dirs)
- Format preference: azw3 → mobi; converts to azw3 via `ebook-convert` when
  neither is cached, and caches the result on the NAS. PDF-only books
  transfer as PDF — never converted (Kindles render PDF natively;
  `ebook-convert` is never invoked for PDFs)
- Copy to `/documents/` on Kindle volume with streamed progress events
- Log to `device_history` table (including failures, with error text)
- Transfers run serially through `transfer-queue.ts`

### Duplicate Detection

On import: ISBN-13 match (definitive) → title+author normalized match (warn).
Duplicates **warn but never block** — the warning travels on the import
progress event and result.

### Apple Books Export

`open -a Books {epub}` — right-click/detail-panel action. No deep integration.

---

## Data Schemas

### metadata.json (per book, stored on NAS)

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
  "read_status": "unread",
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

This is the canonical data contract (iOS companion depends on it). The writer
is `importer.writeMetadataJson`. Known gap: cover `source`/`width`/`height`
are not persisted yet (see tasks.md).

### SQLite Schema

Canonical DDL: `electron/main/schema/migrations/001_initial.sql`. Matches the
original spec plus: FTS5 sync triggers (insert/update/delete), indices on
`isbn_13` / series / author, `device_history.error` column, and a partial
index on unresolved conflicts. Schema versioning via `PRAGMA user_version`;
new migrations are appended to the `MIGRATIONS` array in `services/db.ts`.

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
  nas_path          TEXT           -- relative to library root
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
  book_id     TEXT REFERENCES books(id),
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

`app_config` keys in use: `library_root`, `smb_url`, `python_path`,
`ebook_convert_path`, `rest_api_enabled`.

---

## Python Sidecar Communication

JSON-RPC over stdio, newline-delimited JSON. All calls are async from Node's
perspective (`sidecar.call(method, params, timeoutMs)`), dispatched on a
thread pool in Python so long calls don't serialize.

### Message Format

```json
// Request (Node → Python)
{ "id": "req-123", "method": "hydrate_metadata", "params": { ... } }

// Response (Python → Node)
{ "id": "req-123", "result": { ... }, "error": null }

// Notification (Python → Node, no id) — e.g. migration progress
{ "method": "migration_progress", "params": { "job_id": "...", ... } }
```

### Sidecar Methods

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

Python resolution order: `app_config.python_path` → `sidecar/.venv/bin/python`
→ `python3.12` → `python3.11` → `python3`. The sidecar auto-restarts on crash
(max 3 attempts); when unavailable the app degrades gracefully (imports fall
back to filename metadata).

---

## IPC API Surface (preload → renderer)

Exposed via contextBridge as `window.Musaeum`. Full contract:
`src/types/api.types.ts` (`MusaeumAPI`). Every handler returns an
`IPCResult<T>` envelope which the preload unwraps — renderer code sees plain
promises that reject with the error message.

```typescript
interface MusaeumAPI {
  library: {
    getBooks(filters?: BookFilters): Promise<Book[]>
    getBook(id: string): Promise<Book>
    searchBooks(query: string): Promise<Book[]>
    updateBook(id: string, updates: Partial<Book>): Promise<void>
    deleteBook(id: string): Promise<void>
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
    rehydrateBook(bookId: string): Promise<void>
  }
  devices: {
    getConnectedDevices(): Promise<Device[]>
    sendToDevice(bookId: string, deviceId: string): Promise<TransferJob>
    getTransferProgress(jobId: string): Promise<TransferProgress | null>
    exportToAppleBooks(bookId: string): Promise<void>
  }
  nas: {
    getStatus(): Promise<NASStatus>
    reconnect(): Promise<boolean>
    setLibraryRoot(path: string): Promise<void>
    chooseLibraryRoot(): Promise<string | null>  // native folder picker
  }
  migration: {
    scanCalibreLibrary(path: string): Promise<MigrationScan>
    startMigration(options: MigrationOptions): Promise<MigrationJob>
    getMigrationProgress(jobId: string): Promise<MigrationProgress | null>
    startPdfTopUp(calibrePath: string): Promise<MigrationJob>  // re-runnable PDF attach/import
    confirmCutover(): Promise<void>
    chooseCalibrePath(): Promise<string | null>  // native folder picker
  }
  files: {
    getPathForFile(file: File): string           // dropped File → path (webUtils)
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
  }
}
```

---

## Performance Targets

| Metric                              | Target       |
|-------------------------------------|--------------|
| Library load (7000 books)           | < 2 seconds  |
| Search response time                | < 100ms      |
| App cold start                      | < 3 seconds  |
| Metadata hydration per book         | < 5 seconds  |
| NAS reconnection detection          | < 5 seconds  |
| Format conversion (epub → mobi)     | < 30 seconds |
| Memory footprint (typical use)      | < 500MB      |

Note: the grid is not virtualized yet — this must land before pointing the
app at the full 7000-book library (tasks.md).

---

## External Dependencies

- **Calibre** (host install) — for `ebook-convert` only; detected at
  `/Applications/calibre.app/Contents/MacOS/ebook-convert`, overridable via
  `app_config.ebook_convert_path`. No Calibre GUI is launched.
- **Python 3.11+** — sidecar venv at `sidecar/.venv` (see README).
- Sidecar deps: `sidecar/requirements.txt` (isbnlib, requests, bs4, lxml, Pillow,
  pypdf, pypdfium2). Dev deps: `sidecar/requirements-dev.txt` (pytest).
- Node deps: see `package.json`.

---

## iOS Companion — Architecture Staging

In place as of Phase 1:

1. SQLite schema contains no UI-coupled fields
2. `metadata.json` is the canonical data contract (documented above)
3. REST API module stubbed at `electron/main/api/rest.ts` — disabled via
   `app_config` flag `rest_api_enabled = false`
4. All book file paths stored as relative paths from library root
5. Covers at two resolutions: `cover_thumb.jpg` (200px), `cover_full.jpg` (600px)
6. All data access goes through the service layer (IPC handlers contain no
   business logic) so extraction to a standalone API server stays cheap

---

## Conventions

### Code Style

- TypeScript strict mode; `npm run typecheck` covers main + renderer
- ESLint (flat config, `eslint.config.mjs`) + Prettier — keep both clean
- No `any` types — define interfaces in `src/types/`
- All IPC handlers in `electron/main/ipc/` — one file per domain, registered
  through `ipc/handle.ts`
- All business logic in `electron/main/services/` — never in IPC handlers
- React components are functional only — no class components
- Zustand stores are the single source of truth for UI state; main-process
  events are wired into stores once, in the `src/hooks/use*.ts` hooks mounted
  by `App.tsx`
- Never call NAS/file operations directly from renderer — always via IPC
- Icons are the hand-rolled inline SVG set in `components/shared/icons.tsx` —
  no icon library

### Error Handling

- All IPC handlers wrapped via `handle()` → `{ success, data | error }`;
  never throw across the IPC boundary
- Python sidecar errors returned in JSON-RPC `error` field
- NAS errors are non-fatal — degrade to offline mode, log, surface in UI
- Hydration failures are non-fatal — book keeps embedded metadata
- Format conversion failures are logged to `device_history` with error field

### File Naming

- React components: PascalCase (`BookCard.tsx`)
- Services, hooks, stores: camelCase / kebab (`nas-manager.ts`, `useLibrary.ts`)
- Python modules: snake_case (`epub_metadata.py`)

---

## Resolved Decisions (formerly Open Questions)

1. **App name**: **Musaeum** — confirmed 2026-07-12
2. **Goodreads scraping**: accepted for personal use; best-effort with silent
   degradation, never exposed as a networked service
3. **Calibre CLI**: require user installation; path detected, configurable,
   clear error when missing (no bundling)
4. **Google Books API key**: `GOOGLE_BOOKS_API_KEY` env var; obtain before
   running the 7000-book migration
5. **Update mechanism**: still open — tracked in tasks.md (manual for now)
