# Changelog

All notable changes to Musaeum. Format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver once
the app is packaged.

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
