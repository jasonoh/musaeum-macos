# Musaeum — Task Tracker

Working backlog for future development. Keep statuses current: `[ ]` open,
`[x]` done, `[~]` in progress. Add discoveries here rather than letting them
live only in conversation.

## Phase 1 — shipped 2026-07-12

Full MVP scope from CLAUDE.md: scaffold, NAS offline mode, drag-drop import,
hydration pipeline, conflict review UI, grid/list/detail views, FTS5 search +
facet filters, Kindle transfer with auto-conversion, Apple Books export,
Calibre migration wizard, Python sidecar. Verified end-to-end against live
metadata APIs (see CHANGELOG.md).

## Phase 1.5 — PDF support — shipped 2026-07-27

- [x] **PDF format support shipped** — pdf is a first-class format: import,
      hydration (PDF Info dict extraction + page-1 render as an 'embedded'
      cover candidate), Kindle transfer (direct copy, never converted).
      Calibre PDF top-up (`topup_pdfs`): re-runnable, matches by Goodreads ID
      → ISBN-13 → normalized title+author (ambiguous matches skipped),
      attaches PDFs to existing book folders (idempotent) or imports
      PDF-only books as new. Migration wizard: "Import PDFs from Calibre…"
      action with progress + attached/added/skipped summary.
- [x] Run the PDF top-up against the real Calibre library — completed
      2026-07-27; the Calibre PDFs are re-imported into the live Musaeum
      library. Phase 1.5 (PDF support) is complete.

## Phase 1.5 — polish before real-library use

Blockers before pointing the app at the full 7000-book NAS library:

- [x] **Virtualize the grid and list views** — shipped 2026-07-29. Hand-rolled
      row windowing (`src/hooks/useVirtualRows.ts`): `useScrollMetrics` watches
      the scroll container, `rowWindow` returns a slice plus top/bottom
      spacers. react-window was rejected — it wants absolutely positioned
      cells, costing the grid its CSS grid and the list its real `<table>`.
      Both views compute row geometry from layout constants instead of
      measuring, so uniform row height is now load-bearing: `BookCard`'s meta
      block is fixed-height (`CARD_META_HEIGHT`, exported for GridView) and
      every ListView cell carries explicit leading with a block-level child.
      Verified against a synthetic 7000-book library: ~40 rendered items and
      ~1000 DOM nodes at any scroll offset (was 7000), 32MB JS heap,
      `getBooks` 115ms, search 18ms, `scrollHeight` stable across offsets,
      column recount correct on resize.
- [x] **Settings UI** — shipped 2026-08-11.
      `components/settings/SettingsModal.tsx` over `services/settings.ts`,
      reached from the sidebar's library-status row: library root (via the
      existing `chooseLibraryRoot` adoption flow), `smb_url`, `python_path`,
      `ebook_convert_path`, `google_books_api_key`. Detection is asked of
      `sidecar.ts` rather than re-implemented, values are validated before
      anything is written, and clearing a field deletes the key so
      auto-detection resumes. Verified against a live isolated instance
      (real venv/Calibre detection, save + clear + rejection paths, sidecar
      restart carrying the new key into its env).
- [ ] **Google Books API key** — obtain the key and set it in Settings (or
      export `GOOGLE_BOOKS_API_KEY`) before bulk migration. The storage
      question is settled: `app_config` holds it and wins over the
      environment, so a packaged `.app` no longer needs `infisical run`.
- [ ] **Migration dry run** — migrate a ~50-book subset of the real Calibre
      library to a scratch target first; review hydration quality and the
      needs-review rate before the full run (hydrating 7000 books at the
      0.6s rate limit ≈ 90+ minutes on top of copy time).

## Phase 1.5 — quality

- [~] **Tests** — sidecar pytest suite now exists (`sidecar/tests/`, 14 tests:
      `pdf_metadata`, `hydration_pdf`, `topup`; dev deps in
      `requirements-dev.txt`, run via `sidecar/.venv/bin/python -m pytest
      sidecar/tests`). Still missing, highest value first:
      - sidecar: `pipeline/conflict.py` merge policy, `extractors/epub_metadata.py`
        against fixture EPUBs (pytest)
      - main: `db.ts` query/filter builder, `importer.sanitizeTitle`,
        conflict resolution IPC (vitest via npm test — runs through Electron-as-Node for the better-sqlite3 ABI; harness landed with Section B).
        `db.ts` sort/search ordering and `book-delete.ts` are covered as of
        2026-07-29; the filter builder and `sanitizeTitle` still are not
      - main: `services/settings.ts` covered as of 2026-08-11 (18 tests:
        resolution sources, validation rejections, batch atomicity, and the
        restart-only-on-real-change rule)
      - main: `services/python-env.ts` covered as of 2026-08-12 (22 tests:
        version parsing/comparison, `resolvePython` precedence, and every
        `needsBootstrap` branch including the requirements-hash marker). The
        actual venv build + `pip install` is NOT covered — it needs the
        network and ~20s — and was verified by launching the packaged app
        against a clean profile instead.
      - main: duplicate GATE — `importer` skip/add_new/add_format branches +
        `resolveDuplicate`/`abortPendingDecisions` (2026-07-27, untested)
      - main: device presence — `device-manager.scanDocuments` /
        `getOnDeviceBookIds` matching + the poll self-heal (`setsEqual`
        re-broadcast) and cold-start recompute-on-`libraryChanged`
        (2026-07-27, cold-start fix 2026-07-29; untested)
- [ ] Device-presence match misses a book renamed after import (the on-disk
      file keeps its original `sanitizeTitle` name, so the scan stem no longer
      equals `sanitizeTitle(currentTitle)`) — only self-corrects on re-send.
      Revisit if it bites; a rename-the-file-on-title-change pass would fix it
      broadly. (Shipped 2026-07-27.)
- [ ] `books.file_size_bytes` is set at import and never recalculated, so it
      is wrong after `deleteFormats` removes a file (and after "Add format to
      existing"). Either recompute from the book folder on those writes or
      drop the column from the detail panel. (Found 2026-07-29.)
- [ ] Scroll position survives a search/filter change, so narrowing 7000 books
      to 1072 can leave you parked near the (new) bottom. Pre-existing, but far
      more visible now that `scrollHeight` tracks the result count — reset the
      scroll container to 0 when the result set changes. (Found 2026-07-29.)
- [ ] The virtualized views assume uniform row height from layout constants
      (`GridView`'s `MIN_CARD_WIDTH`/`GAP_*`/`CARD_META_HEIGHT`, `ListView`'s
      `ROW_HEIGHT`/`HEADER_HEIGHT`). A style change that alters real row height
      without updating them shows up as drift, not a build error. Consider a
      dev-only assertion comparing the first rendered row's measured height
      against the constant. (Found 2026-07-29.)
- [ ] Sorting gaps: Formats is deliberately unsortable, and there is no
      secondary sort key, so ties (same author, same rating) fall back to
      SQLite's arbitrary order and can shuffle between loads. Add a stable
      tiebreak (title) if it becomes noticeable. (Found 2026-07-29.)
- [ ] Persist cover `source`/`width`/`height` into metadata.json (sidecar
      returns them; `importer.writeMetadataJson` currently drops them —
      the iOS contract documents them)
- [ ] `render_pdf_cover` should log on `ImportError` (silent today — a
      missing/broken PDF rendering dependency degrades invisibly)
- [ ] Test: zero-page PDF (extraction/cover-render behavior on an empty doc)
- [ ] Fix stale "EPUB" wording in `hydration.py` docstring/comments now that
      PDF is a first-class hydration input too
- [ ] Regression test: mobi/azw3 fall-through in `transfer-queue.ts`'s Kindle
      format preference logic. `transfer-queue.ts` has no tests at all — the
      2026-08-11 EBADF fix (source fd owned by `copyWithProgress`, close errors
      logged, destination size verified) was validated by reproducing against
      the real NAS file, not by a test. Worth covering the size-verification
      path at least; the EBADF itself can't be simulated locally.
- [ ] Review `transfer-queue.ts` error message wording (found while auditing
      the "No source file available for conversion" / PDF-passthrough path)
- [ ] Handle multiple PDFs in one Calibre folder — `topup._find_pdf` and
      `migrate._migrate_one` currently take only the first (sorted) match;
      decide whether to warn, queue a conflict, or document the limitation
- [ ] Migration wizard PDF top-up: an error currently dead-ends the modal —
      wire "return to source" step, and disable the "Import PDFs from
      Calibre…" button while the folder picker is open
- [ ] Test fixture: encrypted/password-protected PDF (extraction + cover
      render should fail gracefully, not crash the sidecar)
- [ ] Scratch-subset dry-run gate: also kill the sidecar process mid-run and
      re-run against the same target to validate crash recovery (attaches
      retry as a no-op via idempotency + `.part` atomic copy; new-book
      imports from the interrupted run WILL duplicate under fresh UUIDs and
      need manual cleanup — check for duplicate folders until Section B /
      incremental inserts land)
- [x] Import duplicate handling reworked into an import-time GATE (Skip / Add
      as new / Add format to existing) — supersedes the old invisible
      `duplicate_check` warning row (2026-07-27)
- [ ] **Open the stored book file from the app** (confirmed missing
      2026-07-17) — no IPC action opens a book file, and nothing is wired to
      `onDoubleClick`. As of 2026-07-29 a right-click context menu exists
      (`BookContextMenu`, grid + list), so the Open action has a home: add it
      there alongside View details / Delete. Covered by the approved
      design (`docs/superpowers/specs/2026-07-14-pdf-multimachine-reader-design.md`,
      Section C): double-click / detail panel opens the native ReaderView
      (foliate-js for epub, pdf.js for PDF, `musaeum://book/{id}/{format}`).
      Builds after Section B. The "Enter to open" keyboard-nav item below
      should reuse the same action.
- [x] Keyboard navigation: arrows to move selection in grid/list (plus
      Home/End/PageUp/PageDown), Esc to close the detail panel; selection now
      also survives a grid↔list switch and is scrolled into view
      (`hooks/useBookNavigation.ts`, 2026-08-10). **Enter to open** is still
      open — it should reuse the ReaderView action above.
- [ ] Metadata editor follow-ups (shipped 2026-08-10,
      `components/library/BookEditor.tsx`): no cover replacement (re-hydrate is
      the only way to change a cover), no multi-author editing (the schema
      keeps one author string), and no bulk edit across a selection.
- [ ] Settings follow-ups (shipped 2026-08-11): no "test this key" button, so
      a wrong Google Books key only shows up as degraded hydration;
      `ebook_convert_path` is validated as an existing file but never run, so
      a non-Calibre binary passes; and the sidecar restart on save is silent —
      an in-flight hydration is cancelled with no UI acknowledgement.
- [ ] Empty-state + skeleton loading polish for slow NAS cover loads
- [ ] `exports/` staging dir is created but unused — either stage transfers
      through it (per spec) and clear post-transfer, or drop it from the spec

## Multi-machine (Section B of the 2026-07-14 design — shipped 2026-07-18)

Approved design: `docs/superpowers/specs/2026-07-14-pdf-multimachine-reader-design.md`.
Shipped: a second machine pointed at a populated library root now adopts the
`catalog.json` cache on connect and shows the full library without re-import
(verified end-to-end 2026-07-18).

- [x] **`catalog.json` at library root** — flattened array of all book
      records + `version`/`generated_at`; derived cache of the canonical
      per-book `metadata.json` (regenerable, drift is never data loss). The
      per-launch `metadata.json` walk was rejected (minutes over SMB); it
      survives only as the "Rebuild catalog" recovery action.
- [x] Every `metadata.json` write path (import, edit, conflict resolution,
      rehydrate, top-up, migration) also upserts the catalog; bulk operations
      batch one catalog write at the end, off the critical path.
- [x] Launch + manual "Refresh library": read catalog, transactionally
      replace the local `books` table (FTS synced via existing triggers).
- [x] First run on a new machine: choose root → catalog detected →
      "Found a Musaeum library with N books — use it?" → populate cache.
- [x] "Rebuild catalog" recovery: walk `books/*/metadata.json` with progress.
- [ ] Concurrency stays last-write-wins (single-user, one machine at a time);
      at ~50k+ books revisit with a per-book journal (YAGNI now).

Post-merge backlog (from the 2026-07-18 whole-branch review):

- [ ] `BookDetail.tsx` rating/read-status controls: add `.catch` or disable
      when offline — with `updateBook` now asserting online, an offline click
      is a silent no-op + unhandled rejection (strictly better than the
      silent-revert it replaced, still worth polish)
- [ ] Coalesce/debounce catalog upserts during multi-file drag-drop imports
      (each book currently costs two O(catalog) read-modify-writes over SMB;
      serialized and off the critical path, so it works — just wasteful)
- [ ] Tag the SQLite cache with the root it mirrors (`cache_root` config) —
      switching roots can seed a fresh root's catalog with the old root's
      records (bootstrap branch); only matters if a second library ever exists
- [ ] Atomic `writeMetadataJson` (.part + rename) — the rebuild walk gave torn
      metadata.json files a new consumer (skipped + logged today)
- [ ] Rebuild walk conflates a per-folder SMB blip with a broken folder —
      could yield a reduced (never empty) catalog; re-runnable + logged, fold
      into the "NAS behavior untested against real SMB" pass, along with
      catalog.json rename-replace semantics across SMB servers

## Packaging & distribution

Goal: a double-clickable, signed `Musaeum.app` (DMG) that runs without a
terminal or an `infisical run` wrapper. Sequenced roughly in build order.

- [x] App icon (dark-library mark) — shipped 2026-08-12 as `build/icon.icns`
      (not `assets/icons/`): `build/icon.png` is the master, `npm run icons`
      packs the iconset. electron-builder finds it with no `mac.icon` entry
      because `build/` is the default `buildResources` dir — confirmed in the
      packaged bundle.
- [x] **electron-builder config** — shipped 2026-08-12. `electron-builder.yml`
      (dmg / arm64 / `public.app-category.productivity`) + `npm run pack` and
      `npm run pack:dir`. `files` is an allowlist (`out/**`, `package.json`);
      production `dependencies` are collected separately, so better-sqlite3
      still ships and its `.node` is unpacked from the asar. Unsigned for now
      via `mac.identity: null` — without it electron-builder signs with
      whatever Developer ID is in the keychain, so the build would differ
      between machines. Produces a 117MB DMG.
      **Requires Node 20.19+** — electron-builder 26 `require()`s an ESM-only
      `@noble/hashes`, so on Node 18 `npm run pack` dies with `ERR_REQUIRE_ESM`
      *after* electron-vite has already built. `engines` now records this.
- [x] **Bundle the sidecar into Resources** — shipped 2026-08-12.
      `extraResources` copies `sidecar/` minus `.venv`, `tests/`,
      `__pycache__`, and `requirements-dev.txt`.
      Venv strategy decided: **option (a), first-run venv in `userData`**
      (`services/python-env.ts`). Option (b) — bundling a standalone CPython —
      is deliberately still reachable: `resolvePython()` checks
      `Resources/python/bin/python3` *before* the managed venv, so adopting it
      is one `extraResources` entry plus a build step, with no code change.
      Rejected (c) pex/zipapp: it still needs a host interpreter and still
      unpacks native wheels to a cache, so it keeps (a)'s constraint without
      its simplicity.
- [ ] **Signing + notarization** — Developer ID cert, hardened runtime,
      `notarize` via electron-builder `afterSign`. Needed for Gatekeeper to
      open the app on another Mac without the right-click bypass. Turning it
      on = delete `mac.identity: null`, add `hardenedRuntime` + entitlements
      (the venv bootstrap spawns a Python subprocess, so check whether
      `allow-jit` / `disable-library-validation` are needed) + an afterSign
      hook. Blocked on an Apple Developer account.
- [ ] Packaged-build follow-ups from the 2026-08-12 first cut:
      - The bootstrap has no retry button — a failure (no Python, no network)
        shows in the status bar and is only retried by relaunching. Settings
        is where a "Set up the metadata engine" action belongs.
      - `pip install` output is discarded except the last line on failure;
        a long install shows one static "Installing metadata dependencies…"
        with no percentage.
      - Nothing verifies the *bundled* sidecar actually imports on a machine
        that has never run the dev venv — verified here by launching with
        launchd's minimal `PATH`, but not by an automated check.
      - `dist/` output is untested on a second Mac (the whole point of
        packaging); the DMG has only been opened on the build machine.
- [ ] Decide update mechanism (spec question #5): manual download vs
      electron-updater — leaning manual for a personal tool
- [ ] `npm audit` — 6 high-severity findings in the dev-dependency chain to
      review (dev-only impact, but check before distributing)

### Secrets in a packaged build (Infisical)

Today the sidecar inherits `process.env` ([`services/sidecar.ts`](electron/main/services/sidecar.ts)
spawn: `env: { ...process.env, ... }`), so `GOOGLE_BOOKS_API_KEY` only arrives
when the app is launched through Infisical. Secrets live in the Infisical
project **`musaeum`**.

- Dev / from-terminal: `infisical run -- npm run dev` and
  `infisical run -- npm run build` inject the key for that process only
  (documented in README → Secrets). A CI/build step that hits the Google
  Books API should likewise be wrapped in `infisical run --`.
- [x] **Packaged-app secret path decided and shipped (2026-08-11)** — option
      (a): the key lives in `app_config` (`google_books_api_key`), set in
      Settings. `sidecar.resolveGoogleBooksKey()` prefers it and falls back to
      `process.env`, so `infisical run -- npm run dev` still works untouched
      while a double-clicked `.app` needs no wrapper. Rejected: (b) an
      `infisical run -- open -a Musaeum.app` wrapper (reintroduces the
      terminal), (c) bundling `infisical` + a machine identity (overkill for
      single-user).

## Known issues / risks

- **Goodreads scraper fragility**: `fetchers/goodreads.py` parses
  `__NEXT_DATA__` with an HTML fallback; markup drift silently disables
  series data (by design). Revisit if series coverage drops.
- **Edition mismatch on hydration**: embedded/Calibre identifiers now always
  win (fixed 2026-07-12), but fetched publisher/date can still describe a
  different edition than the file. Acceptable for now; watch during dry run.
- **Kindle path untested on hardware** — detection + transfer logic verified
  by code review only; test with a real Kindle over USB.
- **NAS behavior untested against real SMB** — offline mode was verified with
  a local folder; test mount-loss/reconnect against `//ohnas.smb`, especially
  mid-import and mid-transfer.
- **FTS tags matching**: `books_fts.tags` indexes the raw JSON string; quoted
  punctuation is tokenized away in practice, but verify tag search feels right
  with real data.
- **`deleteBook` FK restriction (pre-existing)**: deleting a book that has
  `device_history` rows throws (FK has no ON DELETE and `deleteBook` doesn't
  handle history). Found while building `replaceAllBooks` (2026-07-17).

## Post-MVP (unchanged from spec — do not implement yet)

- [ ] Boox Palma WiFi transfer (feature-flagged stub only)
- [ ] In-app reader / annotations
- [ ] iOS companion app (REST API activation; contract already staged)
- [ ] Goodreads account sync
- [ ] Collections UI (schema present, UI deferred)
- [ ] REST API (stub present at `electron/main/api/rest.ts`, disabled)
- [ ] Auto-updater (pending distribution decision above)
