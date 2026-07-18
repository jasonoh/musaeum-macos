# Changelog

All notable changes to Musaeum. Format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver once
the app is packaged.

## [Unreleased] — 2026-07-18

### Added
- Multi-machine library access (Section B): `catalog.json` derived cache at
  the library root; every metadata write upserts it; cache adopted on
  connect/first-run ("Found a Musaeum library with N books"); sidebar
  "Refresh Library" and "Rebuild Catalog" actions; vitest main-process test
  suite (catalog, cache swap, sync flows).
- PDF as a first-class book format alongside epub/mobi/azw3: import,
  file-watcher, and Calibre migration scan all recognize `.pdf`
- PDF metadata extraction (`sidecar/extractors/pdf_metadata.py`, via pypdf)
  and page-1 cover rendering (via pypdfium2), wired into the hydration
  pipeline as embedded metadata / an 'embedded' cover candidate
- Kindle transfer: PDF-only books copy directly (Kindles render PDF
  natively) — `ebook-convert` is never invoked for PDFs
- Calibre PDF top-up (`sidecar/pipeline/topup.py`, RPC `topup_pdfs`):
  re-runnable tool that attaches PDFs from a Calibre library to existing
  book folders (idempotent — skips folders that already hold a PDF) or
  imports PDF-only books as new; matches by Goodreads ID → ISBN-13 →
  normalized title+author, skipping ambiguous matches rather than guessing
- Migration wizard: "Import PDFs from Calibre…" action with progress and an
  attached/added/skipped summary
- First tests in the repo: pytest suite (`sidecar/tests/`, 12 tests) covering
  PDF metadata extraction, PDF hydration, and top-up matching; dev deps in
  `sidecar/requirements-dev.txt`

### Changed
- `sidecar.onNotification` supports multiple subscribers per method and
  returns an unsubscribe function

## [0.1.0] — 2026-07-12

Initial Phase 1 (MVP) implementation.

### Added
- Electron + React + TypeScript + Tailwind scaffold (electron-vite), dark
  library visual design (ink/parchment/gold tokens, serif display type)
- SQLite cache (better-sqlite3, WAL) with FTS5 search, sync triggers, facet
  queries, and `PRAGMA user_version` migrations
- NAS manager: mount detection, `open -g smb://` auto-reconnect with
  5s/15s/60s backoff, 30s health checks, offline/read-only mode with banner
- Import pipeline: drag-drop onto window + watched `imports/` folder,
  duplicate detection (ISBN definitive, title+author warn), UUID book dirs,
  `metadata.json` writer, non-blocking async hydration
- Python sidecar (JSON-RPC over stdio, thread-pooled): OPF extraction,
  Google Books + OpenLibrary parallel fetch, Goodreads series scraping,
  conflict merge with learned source preferences, cover scoring
  (resolution/aspect/source/size formula) and resize to 600px/200px
- Metadata conflict review queue UI with per-field side-by-side resolution,
  "accept all from source", and cover-candidate resolution
- Library UI: cover grid, sortable list, detail slide-over (rating, read
  status, tags, identifiers), import progress overlay, faceted filter sidebar
- Kindle USB detection (/Volumes polling), serial transfer queue with
  on-demand azw3 conversion via `ebook-convert`, per-book copy progress,
  `device_history` logging
- Apple Books export (`open -a Books`)
- Calibre migration wizard: read-only scan, sidecar-orchestrated copy with
  streamed progress, optional rate-limited hydration, explicit cutover
- `musaeum://cover/…` protocol for sandboxed cover serving; strict CSP
- REST API stub (disabled) and iOS-companion staging per spec
- ESLint (flat) + Prettier; typecheck across main and renderer

### Fixed
- Embedded/Calibre identifiers now always override fetched identifiers —
  live testing showed Google Books matching a different edition and
  replacing the file's own ISBN
