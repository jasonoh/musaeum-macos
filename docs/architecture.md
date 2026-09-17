# Musaeum — Architecture

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** changing process structure, the directory layout, path aliases, or anything that moves across the main/renderer/sidecar boundary.

---

## Stack

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

---

## Process Model

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

---

## Directory Structure (as built)

```
Musaeum/
├── CLAUDE.md / README.md / tasks.md / CHANGELOG.md / requirements.md
├── docs/
│   ├── architecture.md           # process model, layout, perf targets
│   ├── data-contracts.md         # metadata.json, SQLite, sidecar RPC, preload API
│   ├── invariants/               # one file per subsystem — rules + reasoning
│   └── superpowers/              # specs/ and plans/, one per feature
├── package.json / tsconfig*.json / electron.vite.config.ts
├── electron-builder.yml          # DMG packaging (see invariants/packaging-and-python.md)
├── tailwind.config.js / postcss.config.js / eslint.config.mjs
├── vitest.config.ts              # main-process test config (@shared/electron aliases)
├── test/                         # shared vitest fixtures only: helpers/, the
│                                 # electron mock and fixtures/theme/ (the two
│                                 # .itermcolors provider fixtures); tests are
│                                 # colocated *.test.ts
├── index.html                    # renderer entry (CSP: self + musaeum: + blob:)
├── vendor/foliate-js/            # VENDORED reader engine — never edited; see
│                                 # its VENDORED.md (the npm package is a
│                                 # stale third-party republish)
├── scripts/
│   ├── dev-app-branding.mjs      # postinstall: name + icon the dev Electron bundle
│   └── make-icons.mjs            # build/icon.png → build/icon.icns (npm run icons)
│
├── electron/
│   ├── main/
│   │   ├── index.ts              # app lifecycle, window, musaeum:// protocol
│   │   ├── env.d.ts              # *.sql?raw / *.yaml?raw module declarations
│   │   ├── api/
│   │   │   └── rest.ts           # REST stub — disabled via rest_api_enabled
│   │   ├── ipc/
│   │   │   ├── handle.ts         # IPCResult wrapper — all handlers use this
│   │   │   ├── library.ts        # book CRUD + import handlers
│   │   │   ├── metadata.ts       # conflict queue, resolve, rehydrate
│   │   │   ├── device.ts         # devices, transfers, Apple Books
│   │   │   ├── nas.ts            # status, reconnect, choose library root
│   │   │   ├── settings.ts       # get/save app_config, executable pickers
│   │   │   ├── reader.ts         # saveProgress (tiered reading-state write)
│   │   │   ├── theme.ts          # theme get/set (thin over services/theme/store)
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
│   │   │   ├── python-env.ts     # interpreter resolution + first-run venv bootstrap
│   │   │   ├── migration.ts      # migration orchestration (node side)
│   │   │   ├── catalog.ts        # catalog.json read/write/upsert + rebuild walk
│   │   │   ├── library-sync.ts   # catalog ⇄ SQLite cache (adopt, refresh, rebuild)
│   │   │   ├── settings.ts       # app_config reads/writes + validation
│   │   │   ├── menu.ts           # native application menu (⌘, ⌘1 ⌘2)
│   │   │   ├── book-bytes.ts     # musaeum://book path resolution + containment
│   │   │   ├── reading-state.ts  # tiered position writes + quit flush
│   │   │   ├── quit.ts           # before-quit handshake (flush, then teardown)
│   │   │   ├── apple-books.ts    # open -a Books
│   │   │   └── theme/            # theming (palette only, never layout)
│   │   │       ├── index.ts      #   loader + barrel; THEME_ENGINE_VERSION
│   │   │       ├── color.ts      #   colour maths — sRGB/Oklab, contrast, mixes
│   │   │       ├── derive.ts     #   palette → derived tokens, floors enforced
│   │   │       ├── store.ts      #   the app_config keys: read+validate, write in one
│   │   │       │                 #   transaction, the inlined built-in registry
│   │   │       │                 #   (store.test.ts holds its pins)
│   │   │       ├── parse/        #   base16.ts + itermcolors.ts (hand-rolled,
│   │   │       │                 #   no new dependency)
│   │   │       └── builtin/      #   vendored scheme corpus — see its VENDORED.md
│   │   └── schema/migrations/
│   │       ├── 001_initial.sql   # includes FTS5 sync triggers + indices
│   │       ├── 002_sort_keys.sql # backfills sort_title / author_sort
│   │       └── 003_reading_state.sql # reading_position/percent/updated_at
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
│   │   ├── settings/             # SettingsModal
│   │   ├── reader/               # ReaderView, ReaderEngine, ReaderToc,
│   │   │                         # ReaderPrefsPopover
│   │   └── shared/               # FilterSidebar, SearchBar, NASStatusBanner, Toasts,
│   │                             # icons
│   ├── stores/                   # library / device / nas / ui / reader / theme zustand stores
│   ├── hooks/                    # useLibrary, useDevice, useNASStatus, useDragDrop,
│   │                             # useMenuCommands, useTheme
│   ├── lib/                      # renderer-side pure logic: selection, metadata-feedback,
│   │                             # metadata-refresh, notify, theme/ (css var apply path)
│   └── types/                    # SHARED contracts: book / device / metadata /
│                                 # settings / api (MusaeumAPI + IPCResult) /
│                                 # theme (IR + derived tokens) — imported by
│                                 # main and preload via @shared
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
(all three layers), `@vendor/*` → `vendor/*` (renderer only — the reader
engine). Configured in `electron.vite.config.ts` and both tsconfigs.

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

Both library views are virtualized (see `docs/invariants/library-views.md`); measured against a
synthetic 7000-book library at ~1000 DOM nodes, 32MB heap, 115ms `getBooks`,
18ms search.

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
