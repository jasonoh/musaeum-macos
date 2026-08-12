# Changelog

All notable changes to Musaeum. Format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver once
the app is packaged.

## [Unreleased] — 2026-08-11

### Added
- Settings, reached from the sidebar's library-status row: the library folder
  (with the existing catalog-adoption prompt), the SMB URL used for
  auto-reconnect, the Google Books API key, and the paths to Python and
  `ebook-convert`. Until now none of these could be changed after first run —
  the library root in particular was effectively permanent.
  Each field's placeholder is the value actually in force, so its note
  distinguishes "set here" from "auto-detected" from "not found", and clearing
  a field visibly falls back to detection rather than breaking the feature.
  Bad values are rejected before anything is written (a path that doesn't
  exist, a directory where a binary belongs, a Python older than 3.11, a
  non-`smb://` URL), so a failed save leaves the previous settings intact.
- The Google Books API key can now live in `app_config` instead of the
  environment, and the sidecar receives it at spawn either way (config wins).
  A packaged, double-clicked `.app` can therefore use a key without being
  launched through `infisical run` — the last thing tying the key to a
  terminal launch.

- Metadata editor: a modal for editing a book's bibliographic fields by hand
  (title, author, series, publisher, published date, language, tags,
  description, identifiers) — the manual counterpart to hydration, for wrong
  titles baked into a file or a series the fetchers never found. Opened from
  the detail panel's pencil button or "Edit metadata…" in the right-click
  menu; ⌘↵ saves. Only changed fields are sent, so a save can't clobber a
  value hydration filled in meanwhile. Sort keys that merely match the derived
  form show as a live placeholder rather than a value, so renaming a book
  re-derives its sort title instead of stranding the old one.
- Keyboard navigation in both library views: arrows move the selection (grid
  arrows move by column, list by row), Home/End jump to the ends, PageUp/Down
  move a viewport, Escape clears the selection and closes the detail panel.
  Ignored while a modal, menu, or text field has the keyboard.
- Selection survives a grid↔list switch: the incoming view scrolls the
  selected book into the middle of the viewport instead of starting at the
  top, and keyboard moves keep the selection in view
  (`src/hooks/useBookNavigation.ts`).
- Virtualized grid and list views — only the rows overlapping the viewport are
  rendered, so library size no longer drives DOM size. New
  `src/hooks/useVirtualRows.ts` (`useScrollMetrics` + `rowWindow`) drives both
  views off the scroll container's own metrics, keeping the grid a CSS grid and
  the list a real `<table>` (react-window's absolutely positioned cells would
  have cost both). Measured against a synthetic 7000-book library: ~40 rendered
  items and ~1000 DOM nodes at any scroll offset instead of 7000, 32MB JS heap,
  115ms `getBooks`, 18ms search — inside the <2s load and 500MB targets that
  previously blocked pointing the app at the full NAS library.
- Sortable list-view column headers: click Title / Author / Series / Added /
  Rating to sort, click the active column again to flip direction. First click
  is ascending for text columns and descending for Added and Rating; the
  active column shows a gold arrow. Headers and the toolbar dropdown share one
  sort state, so the dropdown reflects header-driven sorts (including
  combinations it doesn't list, e.g. Author Z–A). Formats stays unsortable.
- Book deletion from the library views: right-click any book in the grid or
  list for a context menu (View details / Delete…), plus a trash button that
  appears on the book card on hover. Both open one confirmation dialog, which
  offers per-format selection for multi-format books — delete a single format
  file, several, or the whole book (selecting every format deletes the book).
  New `library.deleteFormats` IPC + `services/book-delete.ts`; the detail
  panel's two-click delete now routes through the same dialog.
- On-device presence: the connected Kindle's `documents/` folder is scanned
  and matched against the library, so books physically on the device show a
  badge on their card and an "On {device}" state on the detail-panel send
  button (refreshed on connect and after each transfer via a new
  `deviceContentsChanged` event / `devices.getOnDeviceBookIds` IPC). Replaces
  the previous no-feedback behavior after a send.
- Packaging & Infisical documentation: README "Secrets" section, expanded
  `tasks.md` Packaging & distribution backlog (electron-builder, sidecar
  bundling, signing, and the packaged-app secret-path decision).

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
- Book card and list row geometry is now fixed rather than content-sized, since
  the virtualizer computes row offsets from layout constants instead of
  measuring: the card's title/author/series block has a fixed height
  (`CARD_META_HEIGHT`), and list cells carry explicit line heights.
- Search results honor the active sort. `library.searchBooks` now takes an
  optional `BookSort` (falling back to FTS relevance `rank` when omitted) and
  the renderer always passes one, so the sort controls are no longer dead
  while a query is active. Trade-off: during a search, relevance rank decides
  which books match but no longer their display order.
- Duplicate imports now **gate** instead of warn: an ISBN-13 or normalized
  title+author match pauses the import and forces a choice in the overlay —
  Skip / Add as new / Add format to existing book (`import.resolveDuplicate`
  IPC; pending-decision map keyed by `jobId` for the watcher's concurrent
  imports; `abortPendingDecisions()` on quit). "Add format to existing"
  deletes any prior file of that extension before writing to avoid a stale
  copy being sent to a device.
- Phase 1.5 (PDF support) complete: Calibre PDF top-up run against the real
  library.
- `sidecar.onNotification` supports multiple subscribers per method and
  returns an unsubscribe function

### Fixed
- A restarted sidecar could be torn down by its predecessor: the old process's
  `exit` event fires after the replacement is already running and cleared
  `proc` unconditionally, so the new process was orphaned and every later call
  reported the sidecar unavailable. The handler now ignores an exit from a
  process it has already replaced, and `stop()` fails pending calls itself
  rather than relying on that event. Latent until Settings gained a reason to
  restart the sidecar (a changed interpreter or API key).
- Kindle transfers reported "Failed — EBADF: bad file descriptor, close" while
  actually succeeding: macOS's SMB client can fail `close()` on a file it has
  just read in full (observed on a 50MB azw3 whose copy on the device was
  byte-identical). `copyWithProgress` now owns the source fd
  (`autoClose: false`) and logs a close failure instead of raising it — a close
  error on a read-only fd cannot affect bytes already read — and verifies the
  destination size before reporting the book as sent, so a genuinely truncated
  copy still fails. Progress now counts through a Transform rather than a
  `data` listener, which put the source into flowing mode before the pipeline
  was wired up.
- Failed transfers could not be dismissed and truncated their error text —
  successful ones auto-clear after 5s, but a failure stayed in the sidebar
  forever. Each finished job now has a dismiss button, failures show the full
  message on hover, and a "Try again" action re-queues the transfer.
- The grid jumped to a different part of the library whenever its geometry
  changed — deleting a book with the detail panel open moved the viewport ~43
  books (measured), because `scrollTop` was preserved across a column-count
  change that made the same pixel offset mean something else. `useAnchoredScroll`
  now records the book at the top of the viewport and restores *it* rather than
  the pixel offset when column count or row height changes; this also covers
  window resizes.
- Books imported without an author sort key sorted under their first name — a
  newly added "Seth Dickinson" book was missing from the D's in an author
  sort, even though its series-mates were there. Sort keys are now derived
  (`sortableTitle` / `sortableAuthor` in `book.types.ts`, handling surname
  particles and generational suffixes) on every write path that lacks them:
  import, hydration, metadata.json adoption, and catalog reads. Migration 002
  backfills the existing cache through the same functions, registered as
  SQLite functions so the SQL and TypeScript can't drift. Deriving on catalog
  read matters most: adoption replaces the cache wholesale, so a catalog
  written before this would otherwise undo the backfill on every connect.
- List rows with no rating were 5px taller than the rest — the em-dash fallback
  was inline content, so the cell picked up the table's default line strut.
  Harmless before, but it broke the uniform-height assumption virtualization
  depends on.
- Descending `series` sort only reversed the index within each series — the
  direction was applied to the last ORDER BY key alone. Every key now takes
  the direction. Reachable before via the sort dropdown; more visible now that
  a header click can request it.
- On-device presence was stale after a cold restart (books showed "Send to
  Kindle" despite already being on the device). Presence depends on the book
  set as well as the device files, but was recomputed only on
  `deviceContentsChanged`; at cold start the device scan finished before the
  slow on-connect catalog sync, so the match ran against a not-yet-loaded
  library and was never redone. Now recomputed on `libraryChanged` too, and
  the 5s device poll re-scans a known device's `documents/` (re-broadcasting
  only on change) so presence self-heals.

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
