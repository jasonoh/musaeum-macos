# Changelog

All notable changes to Musaeum. Format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver once
the app is packaged.

## [Unreleased] — 2026-09-15

### Added
- **A metadata re-fetch now says what it did.** Pressing Re-fetch metadata used
  to return instantly and report nothing: a successful fetch announced itself by
  quietly redrawing the card, and a failed one said nothing at all. The button
  spins while the fetch runs (and the book's card carries a spinner too, so a
  refresh started from one book and left behind is still visible), and the
  answer arrives when it settles — *Metadata updated* with the fields that
  actually changed, *No new metadata found* when the sources had nothing new to
  add, or the failure's own message. The last of those is the one that mattered
  most: hydration failures are non-fatal by design and were only ever logged, so
  a timeout at Google Books was indistinguishable from a book that was already
  perfect.
- **Conflicts queue a review from the report** — a refresh that found
  disagreement offers a *Review* button on the same report rather than leaving
  the queue badge to be noticed.
- **A request to re-fetch is available from the context menu** for a single
  book, matching the detail panel's button and reporting identically.
- **A small toast surface** (`components/shared/Toasts.tsx`, owned by the UI
  store) for work that finishes out of the reader's sight. It carries those
  reports, replaces the two blocking `alert()` calls the detail panel and
  context menu used for failures, and now also reports the end of a bulk
  refresh, whose status-bar counter previously vanished without a word.
- **A card says what file it is.** The only way to learn whether a book was an
  EPUB or a PDF was to open it, which is the wrong trade for something glanced
  at across 7000 covers. Each card now carries a small format chip in the
  bottom-left of its cover — the primary format, plus a count of the rest
  (*EPUB +1*), with the full list in the chip's tooltip. PDF sorts last in that
  preference but is never what gets hidden: a PDF-only book reads *PDF*, which
  is the label most worth seeing at a glance, since a PDF is never converted
  and has no in-app reader.

### Changed
- **`importer.hydrate` returns what it did** — `{ok, changed, conflicts}` or
  `{ok: false, error}` — instead of only logging it. Import still ignores the
  value (hydration is non-blocking and non-fatal), but the explicit re-fetch is
  now an awaited call: it is a user action with someone waiting on the answer,
  and the panel that started it can be gone by the time the answer arrives.
- **The single-book "changed" report is diffed, not guessed.** Only a column
  whose value really moved counts, mapped to the field a reader would name, and
  the derived sort keys deliberately do not count — a backfilled `sort_title` is
  not a title change, and reporting it would put "Title" on every refresh of
  every book that arrived without one. The cover is the interesting case: the
  files keep fixed names, so a re-download of the same artwork and a genuinely
  new one are indistinguishable from the row; the sidecar now compares the bytes
  it is about to write and says whether the cover changed.
- **`failed` in a bulk refresh is a real number.** The job counted a book as
  done whether or not the fetch inside it succeeded, so the counter never moved.
  It now distinguishes refreshed, actually-changed, skipped and failed, and
  reports why it stopped — cancelled, or the share dropping under it.
- **Errors from the detail panel and the context menu are reported on screen**
  rather than in a blocking OS alert dialog.

### Fixed
- **Resolving a title conflict now renames the book's files.** Every other path
  that settles a title (`importer.hydrate`, `library:updateBook`) keeps the
  format files named after the book; `metadata:resolveConflict` updated the
  record and left the old name on disk, so a refresh that matched an anthology
  and then a review choosing the embedded title ended with the right title in
  the library and the anthology's name in the folder.
- **The `MUSAEUM` wordmark is centred on the titlebar's own geometry.** It was
  placed by hand — 76px of left padding in an end-aligned row — which left its
  centre at x 125.5 when the space it belongs in runs from the traffic lights
  (x 74) to the column's edge (x 223); it now centres in that space (148.5), on
  the line through the dots' centres (y 25.5). The numbers come from
  `src/types/window-chrome.ts`, which the window's own `trafficLightPosition`
  reads too, because half a pixel of drift between the two is visible against a
  15px wordmark. The dots' centre is *measured*, not computed: Electron's margin
  is the corner of the close button's frame, not the centre of the 12px circle
  drawn inside it.

## [Unreleased] — 2026-08-15

### Added
- **Select many books, and act on all of them.** ⌘-click adds and removes,
  ⇧-click takes a run, ⇧+arrow extends from the keyboard, and the list view
  gains a checkbox column with a select-all header. A second ⇧-click re-ranges
  from the same pivot instead of creeping outward, which is why the selection
  carries both an anchor and a cursor rather than one "last clicked" id. Two or
  more books swap the detail panel for a selection panel of exactly the same
  width, so the grid never re-flows underneath the change.
- **Three bulk actions: delete, send to device, refresh metadata.** Deleting a
  selection is one batched operation rather than a loop — a loop would rewrite
  the whole ~10MB `catalog.json` over SMB once per book and reload the library
  in the renderer just as often. A book that can't be deleted doesn't abort the
  batch; it is named in the dialog and stays selected, so the report is also
  the retry.
- **Refreshing metadata across a selection is a real job**: sequential, because
  the sidecar would otherwise fan out concurrent hydrations at rate-limited
  APIs; batched, so the catalog is written once at the end; and cancellable,
  because a few hundred books is minutes of work. Progress and Cancel live in
  the status bar rather than the selection panel — the job outlives the
  selection, and clearing the selection must never strand it with no way to
  stop it.

### Changed
- The Edit menu's Select All is now a Musaeum command rather than the stock
  role, so ⌘A selects the loaded library. It routes by focus: inside a text
  field it still selects that field's text.

## [Unreleased] — 2026-08-13

### Added
- **Books open inside Musaeum.** A full-window reader renders EPUB, MOBI and
  AZW3 through a vendored foliate-js; double-click a book in either view, use
  the detail panel's Read button, or the context menu. PDFs still open in
  Preview, and so does anything the engine can't render, so every book responds
  to the same gesture. Typography — typeface, size, line height, spacing, and a
  paper or ink page theme — is remembered per machine. Reading is the one action
  that is *not* disabled when the NAS is offline: it is not a write, and the
  reader explaining that it can't reach the file is better than a dead button
  that doesn't say why.
- **Reading position follows you.** Where you left off is stored in the book's
  metadata.json and travels through catalog.json to any other machine. The three
  stores are written on different clocks, because they cost very different
  amounts: SQLite on every page turn, metadata.json on a 30-second throttle, and
  the whole-library catalog only when you close the reader or quit. Piggybacking
  the catalog on the throttle, as the original design had it, would have pushed
  ~10MB over SMB every half minute of reading.
- Books mark themselves read: opening one starts it, passing 98% finishes it.
  The transition only ever moves forward, so marking a book read by hand sticks
  even if you open it again.

### Changed
- Adopting `catalog.json` — on connect, on "Refresh Library", and on "Rebuild
  Catalog" — now **keeps local reading state that is newer than the catalog's**
  instead of replacing the row wholesale. Without it, reading a book while the
  share was down and then quitting lost the session: the position existed only
  in SQLite, and the next launch's adoption overwrote it. It also stops a stale
  catalog written by another machine from rewinding fresher local progress.
- Quitting now flushes the pending position **before** the database closes.
  `before-quit` fires ahead of `will-quit` and already closed the DB, so the
  flush was writing into a closed handle; the shutdown handshake moved into
  `services/quit.ts` and is bounded by a 3-second timeout, because a wedged SMB
  mount must never hold the app open on exit.

### Notes
- foliate-js is **vendored** (`vendor/foliate-js/`, never edited) rather than
  installed: upstream publishes nothing to npm, and the package sitting on the
  registry under that name is a stale third-party republish.
- The reader renders the book's own stylesheets, which arrive as `blob:` URLs,
  so CSP `style-src` had to admit `blob:`. `script-src` stays `'self'` — book
  content never executes — and no directive permits a remote host, so an EPUB
  still cannot phone home through an `@import`, a background image or a font.

## [Unreleased] — 2026-08-12

### Added
- **Musaeum packages into a double-clickable `.app`.** `npm run pack` produces
  a DMG via electron-builder; `npm run pack:dir` an unpacked bundle for faster
  iteration. The build is unsigned for now, so macOS wants a right-click →
  Open the first time — signing and notarization are the next step and need a
  Developer ID.
- The packaged app **builds its own Python environment on first launch**. The
  bundle ships the sidecar as source but not its venv, which is built against
  one machine's interpreter and could not live inside a signed bundle anyway;
  instead the app finds a system Python 3.11+, creates a venv in Application
  Support, and installs the sidecar's dependencies into it (~20s, once, with
  progress in the status bar). Later launches skip it, and editing
  `requirements.txt` re-runs it — the check is a hash recorded in the venv, so
  a normal launch costs one file read.

  Before this, a packaged build fell through to whatever bare `python3` it
  could find, and the sidecar crash-looped on `import PIL` three times before
  giving up: every metadata feature silently unavailable, with the reason only
  visible in a terminal nobody was running. Interpreters are now searched by
  absolute path as well as by name, because a double-clicked app inherits
  launchd's minimal `PATH` and cannot see a Homebrew Python otherwise.

  Bundling a self-contained CPython instead stays open: `resolvePython()`
  checks a bundled runtime *before* the managed venv, so that path is one
  packaging entry rather than a rewrite.

### Changed
- Interpreter resolution moved to `services/python-env.ts`, which now also
  owns the minimum-version rules that `services/settings.ts` validates against
  — so a hand-picked interpreter and an auto-detected one are judged by the
  same standard. `sidecar.ts` re-exports `resolvePython`, so Settings still
  asks the module that spawns the process. A bare system `python3` is now
  version-checked before being offered, instead of being handed over on the
  strength of running at all.

### Notes
- Packaging requires **Node 20.19+**: electron-builder 26 reaches an ESM-only
  dependency through `require`, and older Node refuses. It fails *after*
  electron-vite has finished building, which makes it look like a build error
  rather than a toolchain one. `engines` in package.json now records the floor.

## [Unreleased] — 2026-08-11

### Added
- A native application menu (`electron/main/services/menu.ts`), replacing
  Electron's default one. It carries **⌘,** for Settings — the shortcut macOS
  users reach for, previously reachable only via the sidebar's gear — plus
  ⌘1/⌘2 for grid and list. Items send a `menuCommand` event and the renderer
  decides what it means, so a menu item and its in-app control can't drift
  apart. The Edit submenu is re-declared explicitly: replacing the default
  menu would otherwise have taken ⌘C/⌘V/⌘Z away from the metadata editor.
- The view mode and sort are remembered across restarts (persisted per
  machine in `localStorage` via zustand's `persist`; filters and the search
  query deliberately are not). A restored sort is validated on rehydrate —
  a field from an older build would otherwise reach `db.SORT_SQL` with no
  matching expression.

### Fixed
- The menu bar said "Electron" in development. macOS takes that title from
  the running bundle's `CFBundleName`, not `app.name`, so a new postinstall
  step (`scripts/dev-app-name.mjs`) names the dev Electron bundle after
  `productName`; the About panel is set from `app.name` too. Packaged builds
  already take the name from `package.json`.
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
