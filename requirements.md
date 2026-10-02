# eBook Library Manager — Full Requirements Document

## Document Metadata
```
Project:  Musaeum (working title)
Version:  0.1 — MVP Requirements
Date:     2025
Status:   Draft for Claude Code
```

---

## 1. System Overview

Musaeum is an Electron desktop application for macOS for managing a personal ebook library of 7000+ books stored on network-attached storage. It replaces Calibre as the primary library management tool, prioritizing automatic metadata hydration, clean organization, and frictionless device delivery.

---

## 2. Architecture

### 2.1 High-Level Diagram

```
┌─────────────────────────────────────────────────────┐
│                  Electron Shell                      │
│  ┌───────────────────────────────────────────────┐  │
│  │              React UI Layer                    │  │
│  │  Library View │ Detail View │ Device View      │  │
│  │  Search       │ Metadata UI │ Transfer Queue   │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │           Node.js Main Process                 │  │
│  │  - IPC bridge (UI ↔ backend)                  │  │
│  │  - SMB mount manager + health check            │  │
│  │  - File watcher (chokidar)                     │  │
│  │  - SQLite (better-sqlite3)                     │  │
│  │  - USB device detection                        │  │
│  │  - Transfer queue manager                      │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │           Python Sidecar Process               │  │
│  │  - Metadata fetching + conflict resolution     │  │
│  │  - Cover image fetching + scoring              │  │
│  │  - ebook-convert wrapper                       │  │
│  │  - Calibre metadata.db reader (import only)    │  │
│  │  - EPUB internal metadata extractor            │  │
│  └───────────────────────────────────────────────┘  │
└──────────────┬──────────────────────────────────────┘
               │
   ┌───────────┴────────────┐
   │      //nas.smb        │
   │  /Library/              │
   │    /books/{uuid}/       │
   │      book.epub          │
   │      book.mobi          ← cached conversions
   │      cover.jpg          │
   │      metadata.json      │
   │    /exports/            │← temp device staging
   │    /imports/            │← drag-drop landing zone
   └─────────────────────────┘
```

### 2.2 Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Shell | Electron (latest LTS) | packages as a macOS .app, file system access |
| UI | React + TypeScript | Component model suits library UI patterns |
| Styling | Tailwind CSS | Rapid, consistent UI development |
| State | Zustand | Lightweight, no boilerplate |
| Main process | Node.js (Electron) | IPC, file ops, USB detection |
| Local DB | SQLite via better-sqlite3 | Fast, embedded, no server |
| Metadata + conversion | Python 3.11+ sidecar | Calibre CLI, isbnlib, rich ecosystem |
| Format conversion | Calibre ebook-convert CLI | Battle-tested, comprehensive format support |
| IPC | Electron IPC + JSON | Clean boundary between UI and main process |

### 2.3 iOS Companion Staging

The following architectural decisions are made now to enable a future iOS companion app without refactoring:

- All library metadata is stored in a **well-documented JSON schema** (`metadata.json` per book + SQLite cache)
- The SQLite schema is designed as an **API-ready data model** (no UI-coupled fields)
- A **REST API module** will be stubbed in the Node layer (disabled in MVP) for future activation
- Book file paths are **UUID-based** and resolution-independent (no hardcoded NAS paths in DB)
- Cover images are stored at **multiple resolutions** (thumbnail 200px, full 600px) suitable for mobile

---

## 3. Storage & Network

### 3.1 NAS Configuration

- **Primary storage**: `//nas.smb` mounted as a macOS network volume
- **Library root**: configurable on first launch, default detected from mounted volumes
- **Library structure**:

```
{library_root}/
  books/
    {uuid}/
      {sanitized-title}.epub       ← canonical format
      {sanitized-title}.mobi       ← cached conversion (generated on demand)
      {sanitized-title}.azw3       ← cached conversion (generated on demand)
      cover_full.jpg               ← 600px
      cover_thumb.jpg              ← 200px
      metadata.json                ← source of truth
  exports/                         ← ephemeral; cleared after transfer
  imports/                         ← drag-drop staging area
```

### 3.2 Connectivity Handling

- On launch, app checks NAS mount status
- **If mounted**: proceed normally
- **If not mounted**: 
  - Attempt auto-reconnect using stored credentials/path (macOS `open smb://` or `mount_smbfs`)
  - Show non-blocking reconnection banner with retry button
  - App remains open and usable in **read-only cache mode** (browse SQLite metadata, view covers)
  - No write operations (add, edit, transfer) until NAS is confirmed available
- Mount health is checked every **30 seconds** while app is running
- Reconnection attempts use **exponential backoff** (5s, 15s, 60s intervals)

### 3.3 Local SQLite Cache

Purpose: Fast UI rendering without NAS round-trips for every view

```sql
-- Core schema (abbreviated)

CREATE TABLE books (
  id            TEXT PRIMARY KEY,  -- UUID
  title         TEXT NOT NULL,
  sort_title    TEXT,              -- "The Great Gatsby" → "Great Gatsby, The"
  author        TEXT,
  author_sort   TEXT,              -- "Lastname, Firstname"
  publisher     TEXT,
  published_date TEXT,
  language      TEXT,
  description   TEXT,
  isbn_10       TEXT,
  isbn_13       TEXT,
  goodreads_id  TEXT,
  openlibrary_id TEXT,
  series_name   TEXT,
  series_index  REAL,             -- supports 1.5, 2.0 etc
  cover_thumb_path TEXT,
  cover_full_path  TEXT,
  formats       TEXT,             -- JSON array: ["epub","mobi"]
  tags          TEXT,             -- JSON array
  rating        INTEGER,          -- 1-5, user-set
  date_added    TEXT,
  last_modified TEXT,
  file_size_bytes INTEGER,
  word_count    INTEGER,
  read_status   TEXT,             -- "unread" | "reading" | "read"
  nas_path      TEXT              -- relative to library root
);

CREATE TABLE collections (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  color TEXT                      -- hex, for UI labeling
);

CREATE TABLE book_collections (
  book_id       TEXT,
  collection_id TEXT,
  PRIMARY KEY (book_id, collection_id)
);

CREATE TABLE device_history (
  book_id     TEXT,
  device_id   TEXT,
  device_name TEXT,
  sent_at     TEXT,
  format_sent TEXT
);
```

---

## 4. Metadata System

### 4.1 Ingestion Pipeline (Auto-triggered on book add)

```
Book dropped into app
        │
        ▼
1. Extract embedded EPUB metadata (OPF)
   - title, author, ISBN, publisher, date, language, description
        │
        ▼
2. Query Calibre metadata.db (if available/imported)
   - extract: ISBN-10, ISBN-13, Goodreads ID, series info
   - use ONLY as identifier seeds, discard descriptions/covers
        │
        ▼
3. Parallel metadata fetch
   ├── Google Books API (free, no key required for basic)
   ├── OpenLibrary API
   └── (series only) Goodreads scrape via identifier
        │
        ▼
4. Conflict resolution
   - Auto-resolve where sources agree
   - Queue disagreements for Compare UI (see §4.3)
   - Non-blocking: book is added immediately, conflicts resolved async
        │
        ▼
5. Cover fetch + scoring (see §4.2)
        │
        ▼
6. Write metadata.json + update SQLite
        │
        ▼
7. Move file to /books/{uuid}/ on NAS
```

### 4.2 Cover Image Scoring

When multiple cover candidates are available, auto-select using:

```
Score = (resolution_score × 0.4) 
      + (aspect_ratio_score × 0.3)   ← penalize non-book ratios
      + (source_priority_score × 0.2) ← Google Books > OpenLibrary > embedded
      + (file_size_score × 0.1)       ← proxy for quality
```

If top two candidates score within **15% of each other**, surface the Compare UI rather than auto-selecting.

### 4.3 Metadata Conflict Resolution UI

- Triggered **asynchronously** — does not block book import
- Surfaces as a **review queue** badge in sidebar ("3 books need review")
- Per-conflict, show side-by-side comparison:
  - Cover images with pixel dimensions displayed
  - Field-by-field source comparison (title, author, description, series)
  - User selects **per-field** which source to trust
  - "Accept all from Source X" shortcut available
- Resolved decisions are **remembered per source** to improve future auto-resolution

### 4.4 Series Convention

Adopting the following as canonical standard (exceeds Calibre's convention):

```json
{
  "series_name": "The Expanse",
  "series_index": 1.0,
  "series_total": 9,
  "series_display": "The Expanse #1"
}
```

- `series_index` is a float to support 0.5 (prequel novellas), 1.5 (interstitial novellas)
- `series_total` fetched from Goodreads where available
- Display format: `{series_name} #{series_index}` (drop `.0` for whole numbers)

### 4.5 metadata.json Schema

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
  "formats": ["epub", "mobi"],
  "rating": null,
  "read_status": "unread",
  "date_added": "2025-01-15T10:30:00Z",
  "last_modified": "2025-01-15T10:31:00Z",
  "metadata_sources": {
    "google_books": { "fetched_at": "2025-01-15T10:30:05Z", "match_confidence": 0.97 },
    "openlibrary": { "fetched_at": "2025-01-15T10:30:06Z", "match_confidence": 0.94 }
  }
}
```

---

## 5. Library UI

### 5.1 Views

| View | Description |
|------|-------------|
| **Grid** | Cover-dominant, 4–6 columns, title + author below |
| **List** | Tabular, sortable columns (title, author, series, date added, format, rating) |
| **Detail** | Full metadata panel, format badges, send-to-device button |

### 5.2 Filtering & Search

- **Full-text search**: title, author, series, tags, description
- **Filter sidebar**:
  - By tag (multi-select)
  - By series
  - By author
  - By format (epub/mobi/azw3)
  - By read status
  - By rating
  - By date added range
- Search is **local SQLite FTS5** — instant, no network dependency
- Active filters shown as dismissible chips above grid/list

### 5.3 Sorting Options

- Title (A–Z, Z–A)
- Author (A–Z)
- Series (grouped, ordered by `series_index`)
- Date added (newest/oldest)
- Rating
- Read status

### 5.4 Drag and Drop

- User drags `.epub`, `.mobi`, or `.azw3` files onto app window or dock icon
- Import overlay appears showing per-file progress:
  ```
  ✓ File received
  ✓ Metadata extracted
  ⟳ Fetching online metadata...
  ✓ Cover downloaded
  ✓ Added to library
  ```
- Multiple files accepted simultaneously
- Duplicate detection: warn if ISBN or title+author already exists

---

## 6. Device Management

### 6.1 Kindle (USB)

- App detects Kindle mount via USB (watch for known Kindle volume names / vendor ID)
- On detection: Kindle icon appears in sidebar with device name
- **Transfer flow**:
  1. User selects book(s) → "Send to Kindle"
  2. App checks if `.mobi` or `.azw3` exists in book folder
  3. If not: invoke `ebook-convert` to generate, cache result on NAS
  4. Copy to `/documents/` on Kindle volume
  5. Log transfer in `device_history`
- **Format preference order**: azw3 → mobi (azw3 renders better on modern Kindles)
- Batch transfer supported with queue UI showing progress per book

### 6.2 Boox Palma (Post-MVP)

- WiFi transfer via Boox built-in HTTP server
- Device discovery via mDNS or manual IP entry
- Transfer format: epub (Boox reads epub natively)
- Stub interface in sidebar: "Boox Palma (coming soon)" — hidden behind feature flag

### 6.3 Apple Books

- Export to Apple Books via `open -a "Books" file.epub` (macOS shell)
- Available as a right-click action on any book
- No deep integration required

---

## 7. Migration from Calibre

### 7.1 Migration Flow (One-Time)

```
Launch migration wizard
        │
        ▼
1. Point to Calibre library root (//nas.smb/calibre or similar)
        │
        ▼
2. Scan all book folders
   - Collect all epub/mobi/azw3 files
   - Read existing metadata.opf files
        │
        ▼
3. Parse Calibre metadata.db
   - Extract: ISBN-10, ISBN-13, Goodreads ID, series info
   - Map to book files by Calibre ID
        │
        ▼
4. For each book:
   - Assign new UUID
   - Merge OPF metadata + Calibre DB identifiers
   - Queue for online metadata hydration
   - Copy file to new /books/{uuid}/ structure
        │
        ▼
5. Run metadata hydration pipeline (§4.1) for all books
   - Batched with rate limiting (respect API limits)
   - Progress shown: "Hydrating 7,432 books... 1,203 complete"
        │
        ▼
6. Migration report:
   - Successfully migrated: N
   - Needs manual review (low confidence match): N
   - Could not find metadata: N
   - Duplicate files found: N
```

### 7.2 Migration Safety

- Original Calibre library is **never modified** during migration
- New library is written to a separate NAS path until migration is confirmed complete
- User explicitly confirms cutover: "Switch to new library"
- Calibre library retained as archive until user manually removes it

---

## 8. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Library load time (7000 books) | < 2 seconds (SQLite cache) |
| Metadata hydration per book | < 5 seconds typical |
| Search response time | < 100ms (FTS5) |
| App cold start | < 3 seconds |
| NAS reconnection attempt | Within 5 seconds of detection |
| Format conversion (epub→mobi) | < 30 seconds per book |
| Memory footprint | < 500MB typical |
| Offline usability | Full browse + search; no write ops |

---

## 9. MVP Scope (Phase 1)

### In Scope
- [ ] Electron app scaffold (macOS)
- [ ] NAS mount detection + graceful offline mode
- [ ] Drag-and-drop book import
- [ ] Automatic metadata hydration pipeline
- [ ] Conflict resolution UI
- [ ] Library grid + list views
- [ ] Full-text search + filter sidebar
- [ ] Book detail view
- [ ] Kindle USB detection + transfer with auto-conversion
- [ ] Apple Books export
- [ ] Calibre library migration wizard
- [ ] SQLite local cache
- [ ] UUID-based NAS file structure

### Explicitly Post-MVP
- [ ] Boox WiFi transfer
- [ ] Annotations
- [ ] iOS companion app (architecture staged)
- [ ] Reading mode (in-app reader)
- [ ] Goodreads sync
- [ ] Custom collections (data model present, UI deferred) — superseded by `docs/superpowers/specs/2026-09-27-bookshelves-design.md`; the unused `collections` / `book_collections` tables this line referred to were dropped in migration 006
- [ ] REST API (stubbed, disabled)

---

## 10. Open Questions for Future Decisions

1. **App name**: "Musaeum"
2. **Goodreads scraping**: legally grey; confirm acceptable for personal use
3. **Calibre dependency**: app assumes `ebook-convert` is installed; should we bundle it or require user installation?
4. **Google Books API key**: obtain key and store in Infisical under `GOOGLE_BOOKS_API_KEY` before running the migration wizard. The 7000-book migration will exceed free tier limits.
5. **Update mechanism**: Electron auto-updater or manual?