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

## Phase 1.5 — quality pass (2026-09-16, fixes + tests)

Plan and adjudications: `docs/superpowers/plans/2026-09-16-phase15-quality.md`.
Owner-approved scope: the user-visible correctness fixes plus the missing test
boundaries. **Landed uncommitted**; gate on main **typecheck 0 / lint 0 /
`npm test` 568 passed / 25 files** (baseline 513/23) and **pytest 64 passed**
(baseline 18).

- **Scroll reset (F1)** — `useResetScrollOnResultChange` in
  `src/hooks/useVirtualRows.ts`, keyed on a new pure `resultSetKey()` in
  `src/lib/resultSetIdentity.ts` (query + filters + sort, normalized). Measured
  in the running app against the real library (isolated profile, read-only):
  full library scrolled to the bottom (`scrollTop` = maxScroll = 296,802),
  search `the` → **230,059 before, 0 after**, same result set both runs.
  Deliberately does *not* fire on an in-place book-list mutation, and does not
  out-race the anchor: measured, the detail panel opening left `scrollTop` at
  205,345 (never 0) and closing restored it to 149,949. Selection wins over the
  reset when a selected book survives — `useBookNavigation`'s ensure-visible is
  a plain effect and therefore runs last, which is the documented precedence.
- **Stable sort ties (F2)** — `orderClause` appends `id ASC` as a pinned
  tiebreak (`electron/main/services/db.ts`); pinned rather than following the
  requested direction, so flipping a sort and flipping it back restores the
  original relative order. Formats is still unsortable.
- **`file_size_bytes` is recomputed (F3)** — the owner chose recompute over
  dropping the column. One shared helper, `computeFileSizeBytes` in
  `services/book-files.ts` (extension-resolved, non-fatal on a flaky share),
  now used by the four writers that change a format set: `deleteFormats`, the
  `add_format` branch, the Kindle conversion cache in `transfer-queue`, and the
  PDF top-up attach — plus `catalog.ts`'s read path, which had its own copy.
- **`render_pdf_cover` logs its failures (F4)** — ImportError vs render failure,
  still returning `None` (invariant 12). **`hydration.py`'s EPUB-only wording
  (F5)** corrected. Both verified by mutation.
- **New coverage (T1–T3)** — sidecar `pipeline/conflict.py` (19 cases) and
  `extractors/epub_metadata.py` (16 cases, fixture EPUBs built in-code) plus a
  hydration-never-throws case; main `sanitizeTitle` and the duplicate
  GATE (`skip`/`add_new`/`add_format`, `resolveDuplicate`,
  `abortPendingDecisions`). Every case carries a reproduced mutation.
- **Repo defect found and fixed: a live worktree broke `npm run lint`.**
  Each `.claude/worktrees/<name>/` carries its own `tsconfig.json`, so the
  type-aware parser reported "multiple candidate TSConfigRootDirs" and refused
  to parse **every** file in the main tree (695 errors, 555 of them the
  worktrees themselves). `eslint.config.mjs` now ignores `.claude/`.
- **Two corrections to the notes above, both from reading the code:**
  `extractors/epub_metadata.py` **raises** on a malformed OPF/container — it is
  `pipeline/hydration.py:37-43`'s guard that keeps hydration non-fatal — and the
  sidecar suite was 18 tests, not the 14 previously recorded here.

**Second wave landed 2026-09-16** (owner consent: the clarify form, "All four,
T4 first") and then reviewed read-only by the repo's `reviewer` agent:

- **T4 — conflict resolution moved out of the handler.** `services/conflicts.ts`
  holds `resolveConflict` as a verbatim move; `ipc/metadata.ts` is now a thin
  wrapper (4 insertions, 67 deletions), channel/arguments/return unchanged, and
  7 cases cover it. The review confirmed no contract drift and no invariant bent;
  it is invariant 8 being *kept*, not bent.
- **T5/T6 — device presence and `transfer-queue`** (16 cases: the `keysEqual`
  self-heal, the cold-start recompute, Kindle format preference, PDF passthrough,
  and the destination size verification the 2026-08-11 EBADF fix never had).
- **F6 — the five stdout log sites** in `pipeline/topup.py` / `migrate.py` now go
  to stderr, with a case asserting the message is on stderr *and not* stdout.
- **Review repairs:** `resultSetKey` no longer counts filters during a search
  (`library.store.ts:63-65` ignores them there, so a facet click during a search
  was resetting the scroll for a control that changes nothing); the three old
  filter cases that encoded that false premise were rebuilt on a browsing base;
  and `book-delete.test.ts`'s size fixture was strengthened from `null` to a
  wrong value, because `null` could not catch a "only fill a missing value"
  implementation (measured — that mutation passes the old fixture, fails the new
  one).

**Still open, named rather than absorbed:** three of the four
`computeFileSizeBytes` call sites have no case (only `deleteFormats` does);
`conflicts.test.ts` names a broadcast it never asserts and never reads
`metadata.json` back; the renderer half of the cold-start fix needs a DOM
environment and devDeps; EBADF-on-SMB is only reproducible on real hardware.


## Phase 1.5 — quality (pre-existing backlog)

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
      broadly. (Shipped 2026-07-27.) **Content matching (2026-09-17) does not
      close this either**, and is not meant to: the copy on the device carries
      the title it was converted with, so after a retitle *both* its name and its
      own title are stale. The send receipt covers books we sent in this session;
      across an unplug the fix is still to persist the send filename or match on
      EXTH 113.
- [x] `books.file_size_bytes` is set at import and never recalculated, so it
      is wrong after `deleteFormats` removes a file (and after "Add format to
      existing"). **Fixed 2026-09-16** — owner chose recompute over dropping the
      column; one `computeFileSizeBytes` helper now serves all four
      format-changing writes plus the catalog read path. (Found 2026-07-29.)
- [x] Scroll position survives a search/filter change, so narrowing 7000 books
      to 1072 can leave you parked near the (new) bottom. **Fixed 2026-09-16**
      (`useResetScrollOnResultChange` + `resultSetKey`); measured 230,059 → 0 in
      the running app, with the anchor's own case measured unchanged. (Found
      2026-07-29.)
- [ ] The virtualized views assume uniform row height from layout constants
      (`GridView`'s `MIN_CARD_WIDTH`/`GAP_*`/`CARD_META_HEIGHT`, `ListView`'s
      `ROW_HEIGHT`/`HEADER_HEIGHT`). A style change that alters real row height
      without updating them shows up as drift, not a build error. Consider a
      dev-only assertion comparing the first rendered row's measured height
      against the constant. (Found 2026-07-29.)
- [x] Sorting gaps: **ties fixed 2026-09-16** — `orderClause` appends a pinned
      `id ASC`, so equal keys no longer fall back to SQLite's arbitrary order.
      Formats stays deliberately unsortable. (Found 2026-07-29.)
- [ ] Persist cover `source`/`width`/`height` into metadata.json (sidecar
      returns them; `importer.writeMetadataJson` currently drops them —
      the iOS contract documents them)
- [x] `render_pdf_cover` should log on `ImportError` (silent today — a
      missing/broken PDF rendering dependency degrades invisibly) — **fixed
      2026-09-16**: it distinguishes a missing `pypdfium2` from a render
      failure, logs to stderr, and still returns `None` (invariant 12).
- [ ] Test: zero-page PDF (extraction/cover-render behavior on an empty doc)
- [x] Fix stale "EPUB" wording in `hydration.py` docstring/comments now that
      PDF is a first-class hydration input too — **fixed 2026-09-16** (lines 4
      and 91; line 97 turned out to be the real `.epub` branch, not prose).
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
- [x] **Open the stored book file from the app** — shipped 2026-08-13 as the
      in-app reader (Section C1 below): double-click, the detail panel's Read
      button and the context menu all open EPUB/MOBI/AZW3 in `ReaderView`, and
      the context menu additionally opens any format in its system default app
      (`files.openBookFile` / `revealBook`, shipped 2026-08-10). PDF in the
      reader is C2; PDFs open in Preview today.
- [x] Keyboard navigation: arrows to move selection in grid/list (plus
      Home/End/PageUp/PageDown), Esc to close the detail panel; selection now
      also survives a grid↔list switch and is scrolled into view
      (`hooks/useBookNavigation.ts`, 2026-08-10). **Enter to open** is still
      open — deliberately left out of C1; it should call the same
      `reader.openBook` action the four existing entry points use.
- [x] **Multi-book selection and bulk actions** — shipped 2026-08-15.
      ⌘-click and ⇧-click in both views, a checkbox column with select-all in
      the list, a selection panel in the detail slot, and three bulk actions:
      delete (batched, one catalog write), send to device (loop onto the
      serial queue), re-hydrate (sequential cancellable job). Design:
      `docs/superpowers/specs/2026-08-14-multi-book-selection-design.md`.
      Not verified in the harness: the ⌘A **accelerator** itself (the menu
      item and its renderer routing are in place, but driving a native menu
      needs assistive access the verify sandbox doesn't have). If ⌘A ever
      fails to reach the renderer, the documented fallback is to restore
      `{ role: 'selectAll' }` and leave the header checkbox as select-all.
- [ ] **Bulk metadata edit** — apply a field across a selection: add tags, set
      series, set read status. The one group-meaningful action left out of the
      selection work above; it needs its own modal and an "only changed
      fields" write like `BookEditor`'s.
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
- [x] Atomic `writeMetadataJson` (.part + rename) — done 2026-08-13, mirroring
      `catalog.ts`'s `writeCatalog`. The reader made this reachable rather than
      theoretical: metadata.json is now rewritten every 30s of reading and
      again at quit, where the 3s flush timeout deliberately lets the process
      exit with an SMB write possibly mid-flight — and a torn file makes
      `rebuildFromBookDirs` fail `JSON.parse` and drop the book from the
      rebuilt catalog entirely
- [ ] Rebuild walk conflates a per-folder SMB blip with a broken folder —
      could yield a reduced (never empty) catalog; re-runnable + logged, fold
      into the "NAS behavior untested against real SMB" pass, along with
      catalog.json rename-replace semantics across SMB servers

## In-app reader (Section C1 of the 2026-07-14 design — shipped 2026-08-13)

Approved design: `docs/superpowers/specs/2026-07-14-pdf-multimachine-reader-design.md`.
Shipped: EPUB, MOBI and AZW3 render in a full-window `ReaderView` over a
vendored foliate-js, with reading position persisted across restarts and
machines. Verified live against an isolated instance (all four entry points,
paging, TOC, typography measured inside the book document, quit/relaunch
resume, and a genuine offline state).

- [x] Vendored engine (`vendor/foliate-js/`, provenance in its VENDORED.md) —
      never edited; the npm package of that name is a stale third-party
      republish. `vendor/foliate-js/pdf.js` is excluded from the renderer
      bundle because Vite's asset-import-meta-url plugin cannot build it.
- [x] `musaeum://book/{id}/{format}` (`services/book-bytes.ts`) — extension
      lookup, traversal- and symlink-contained, testable without Electron.
- [x] Tiered reading position (`services/reading-state.ts`): SQLite per page
      turn, metadata.json on a 30s throttle, catalog.json at session
      boundaries. Reconciled at every catalog adoption so a newer local
      position is never overwritten; flushed on quit ahead of `closeDb`.
- [ ] **C2 — PDF in the reader.** pdf.js into the existing shell (the overlay,
      TOC panel and typography popover stay; the engine swaps), page numbers as
      the opaque `position` in the same `reading_state` schema, fit-width /
      fit-page and zoom in place of font size and line height. If it routes
      through foliate's own `pdf.js` rather than pdf.js directly, the `external`
      exclusion in `electron.vite.config.ts` has to be solved rather than
      dodged.
- [ ] Reader features deliberately out of C1: no annotations, highlights or
      bookmarks; no search-in-book; no per-book typography (preferences are
      global and per machine). Annotations in particular need a storage
      decision first — metadata.json keeps the book's record small today, and
      highlights are the first thing that would grow without bound. **Search-in-book shipped
      2026-09-19** (S1 — the spec under "Specified, not scheduled" below, built and verified in
      the running app); the annotations in this list still wait on the storage decision.
- [ ] Genuine horizontal margin control. The "Spacing" slider drives foliate's
      paginator `margin` attribute, which it spends on vertical inset and column
      gutter — the left text edge does not move, which is why the control is not
      called Margin. Real side margins mean foliate's `max-column-width` / `gap`
      attributes; deliberately not attempted in C1.
- [ ] Shutdown edges around the 3s quit flush (`services/quit.ts`), all
      untested and none fatal: a second ⌘Q inside the window starts a second
      flush and a second `quit()`; a flush that outlives the timeout keeps
      writing while teardown runs, so `saveProgress` can reopen the database
      after `closeDb`; `quit.ts` would block quit forever if `flush` threw
      *synchronously* (safe today only because `flushPendingBeforeQuit` is
      async) and its `.catch().finally()` chain is floating; and the watcher,
      device poll and NAS health checks stay live for that window.
- [ ] `flushPending` re-reports without passing `now`, so a position flushed at
      quit is stamped with the quit time rather than the page turn it describes
      — and `reading_updated_at` is exactly what adoption compares, so a late
      stamp can win against a genuinely newer position from another machine.
      Also, a `saveProgress` racing the flush's awaits can strand a fresh
      pending entry (SQLite still holds it, so nothing is lost locally).
- [ ] `book-bytes.ts`'s `FORMATS` allowlist is `satisfies BookFormat[]`, which
      type-checks the literals but does not enforce completeness — a new
      `BookFormat` member would silently be unservable. Same shape of gap as
      the sort-key one: it fails as a missing feature, not a type error.
- [ ] `fs.readdir` on a stalled SMB mount has no timeout and holds a libuv
      threadpool slot, so several hung reader requests could stall other
      main-process fs work. The cover route already carries this exposure; fold
      into the "NAS behavior untested against real SMB" pass below.
- [ ] Two upstream races in the vendored paginator, non-fatal and unfixable
      without editing vendor source: an unguarded `this.#view` in a
      `requestAnimationFrame` inside `setStyles`, and a ResizeObserver firing on
      a mid-navigation document. Recorded so they are recognised, not
      re-diagnosed; revisit when the vendored copy is next updated.
- [ ] Test hygiene surfaced while building this: `library-sync.ts`'s
      module-level `pending` promise chain is not cleared by `resetForTests()`
      (benign `[catalog] upsert failed: ENOENT` on stderr in full runs), and
      `flushForTests` swallows errors via `.catch(() => undefined)`, so a real
      catalog-upsert failure inside a test is invisible rather than failing it.
      Both pre-date the reader.

## Theming (design: `docs/superpowers/specs/theming.md` — slices 1–2 landed 2026-09-15)

Approved design: `docs/superpowers/specs/theming.md` (1,776 lines, **currently untracked** — commit it
with slice 1). Seven owner-approved slices: import a colour scheme from a provider the owner already
uses (base16/base24, iTerm2 `.itermcolors`, Obsidian `theme.css` via a sandboxed CSS resolver), derive
Musaeum's **17** design values from it, and apply them to the whole app including the reader. A theme
supplies **palette only** — never geometry, typography, shadow shape or layout.

Reference prototype, **outside the repo** and nothing vendored from it: **`~/theme-probe/`** (9.8M) —
`derive.py` (pure stdlib: provider adapters → one IR → tokens, with contrast floors enforced),
`HANDOFF.md`, `preview.html`, `frames/baseline/`, `frames/after-slice1/`, `curated/` (13 candidate
schemes). **Its rules are authoritative for slice 2, which must reproduce them verbatim.** It was
measured on 8 palettes × 11 audits, 0 failures, including the two rules added for slice 7
(`scrim`, the status family).

- [x] **Slice 1 — token plumbing** (landed 2026-09-15, **uncommitted**). `tailwind.config.js` +
      `src/index.css`: 19 custom properties on `:root` (14 palette channels + `--on-accent` +
      `--scrim`, three shadow alphas, `color-scheme: dark`), colours in the
      `rgb(var(--x) / <alpha-value>)` form. That form is load-bearing rather than stylistic: **63
      opacity-modified token utilities across 20 files** silently stop being generated under a plain
      `var()`. Verified by the orchestrator — gate green (270 tests, identical to the `bdc54ec`
      baseline), all 14 hex literals convert byte-for-byte, and **0 of 1,296,000 pixels differ** on
      the library view. Named residual: 146 pixels of the settings-scrim frame differ by exactly
      1/255 — alpha-composite rounding between `rgba(13,11,9,0.8)` and `rgb(13 11 9 / 0.8)`.
      Sub-perceptual and inherent to the required form; **do not chase it as a regression**.
- [x] **Slice 2 — derivation core** (landed 2026-09-15, **uncommitted**).
      `electron/main/services/theme/` + `src/types/theme.types.ts`: colour maths, the two provider
      adapters (base16 and iTerm2 — hand-rolled, no new dependency), and a verbatim port of
      `derive.py`'s `derive_tokens()`, plus AC1.4 (moved here by J9). Verified by the orchestrator on
      the returned tree: gate typecheck 0 / lint 0 / `npm test` **321 passed, 19 files** (baseline
      270/17); a differential probe over all 15 real palettes reported **every derived value identical
      to the prototype** — every hex byte-for-byte, every audit ratio to 1e-9, every `adjusted`/`notes`
      string, 1,539 assertions; and three hand-applied mutations each reddened only their own
      criterion (deleting the terminal floor check → AC2.2; an accept-everything iTerm grey filter →
      3 AC2.4 tests; one channel step in `--ink-950` → 2 AC1.4 tests), every file restored
      byte-identical. Corpus vendored with it: 13 base16 schemes at
      `electron/main/services/theme/builtin/` — byte-identical to `tinted-theming/schemes@spec-0.11`
      (`7cda828e`) — and 2 `.itermcolors` at `test/fixtures/theme/`, value-identical to
      `mbadolato/iTerm2-Color-Schemes@master` (`1a3e1d29`). **Both provenance claims are now measured**,
      which the spec had recorded as unverified. A read-only pre-merge review then found **one BLOCK
      and ten defects**; an adversarial audit of that repair found **four more fix-now**, the last of
      which is the one worth knowing: `deriveTheme` was *still* returning `ok: true` with rows in its
      own audit table **below their floor**, because the prototype audits two placements but walks one
      score. Both rounds are in the adjudications below, and the spec carries them as A12–A20. Final
      gate: typecheck 0 / lint 0 / **356 passed, 19 files**; corpus pins (13 files, 240 audit rows, all
      meeting their floors) and every AC2.1 literal unchanged; the differential re-run after each round,
      **identical to `derive.py` both times** — neither round moved a single derived value.
- [x] **Slice 3 — persistence and apply-on-boot** (landed 2026-09-16, **uncommitted**).
      `app_config` gains `theme_id`, `theme_tokens` and — **a third key, `theme_library`** (A21) —
      because AC4.1 wants five swatches per imported theme while §2.3 itself says an imported
      `.itermcolors` may no longer be on disk: the values must be stored, and only the active
      theme's fit in `theme_tokens`. `theme/store.ts` is the only writer; it derives and validates
      *before* it opens a `getDb().transaction(...)`, then writes the pair inside it, so the only
      legal states are "both absent" (the built-in default) and "both present and agreeing".
      Every read re-validates **every value the derivation emits** and degrades to the default with
      a logged reason (`CLAUDE.md` #12); `engineVersion` rides the record, and a mismatch
      re-derives where the id is a built-in and otherwise keeps the values and reports `stale` (J3).
      `electron/main/index.ts`'s hardcoded `#0d0b09` becomes
      `windowBackgroundColor(activeTheme().tokens)`; `src/main.tsx` reads and applies the stored
      theme before `createRoot(...).render(...)`; `src/lib/theme/css.ts` emits channel triplets,
      never a hex, and deliberately leaves `--shadow-*` and `color-scheme` to slice 5 (so a light
      theme applied in slice 4 keeps dark shadow alphas until slice 5 lands — the two ship together
      in this stream). The 13 built-in schemes are inlined into the main bundle with static
      `*.yaml?raw` imports. **Measured:** `grep -c base05 out/main/index.js` went **0 → 14** after
      `npm run build` — a runtime `readFileSync` on `theme/builtin/` could never have worked, since
      main runs from `out/main/index.js` in dev *and* packaged and `electron-builder.yml` ships only
      `out/**` + `package.json`.
      **Gate:** typecheck 0 / lint 0 / build 0, and **452 passed, 22 files** at the final revision
      (431 at first landing, before the pre-merge review; baseline 356/19).
      **A read-only pre-merge review then found one BLOCK and four fix-now defects, all fixed with a
      deciding case and a mutation the orchestrator reproduced by hand.** The BLOCK: a stored
      `theme_id` naming an inherited object key (`builtin:__proto__`, `constructor`, `toString`, …)
      resolved `Object.prototype` instead of `undefined`, so the registry's miss-guard never fired and
      `loadThemeText` threw — out of `activeTheme()`, which `createWindow()` calls, meaning a
      hand-edited row **opened no window at all**. Same class, second instance: `activeRead` guarded
      return values rather than exceptions, so an unopenable database was fatal to startup where
      before slice 3 the window path touched no database. Three smaller ones: `applyTokens` could only
      *set* properties (12 stale `--status-*` survived a switch back to the default — it now
      reconciles against a frozen list of the 28 names it owns), `ThemeView.defaultId` was decided by
      nothing, and `useTheme`'s effect applied unguarded (the theme *change* was the path that could
      throw into React, not the boot). `applyTokens` is now total — it returns a reason instead of
      throwing — which is what lets both call sites be guarded by one pure case.
      **Verified by the orchestrator on the returned tree, not self-reported:** 6 mutations
      reproduced by hand — restoring the `#0d0b09` literal, dropping the transaction wrapper,
      skipping read validation, misspelling one CSS variable, retuning one `:root` channel, and
      removing the pre-paint apply each reddened its own case; and one **NO-KILL** found a real
      hole — the "every value the derivation emits" rule was implemented but asserted nowhere, and
      **two of its three family walks (parchment and gold) could be deleted with the suite green** (the
      ink walk was already caught, incidentally, by an existing uppercase-hex case; the first witness
      written for this was itself inert — a whole-family deletion degrades on the `isObject` guard
      *above* the walk — which is why the landed cases drop one step *inside* a present family). Now
      closed by three cases that each kill one walk. **AC3.5's no-flash half measured in the running app:** with a
      real derived light theme stored (`builtin:solarized-light`, `ink-950 #fdf6e3`) in an isolated
      `MUSAEUM_USER_DATA` profile, the tokens are applied **19.6 ms after document-start and the
      first paint lands at 44 ms**; a cold launch gives DOMContentLoaded 131 ms / first paint
      160 ms, so the first painted frame is already themed. AC3.1's *window*-colour clause is decided
      by its unit test plus a source walk, with a **declared residual**: Electron implements no
      `Browser.getWindowForTarget` (`-32601`, measured) and a CDP screenshot covers web contents
      only, so the native window's own colour is not observable from an automated run here.
      **Slice 3's budget is 12 code files, not the spec's 9** (A30) — over `CLAUDE.md`'s ~10-file
      bound, each addition forced and named rather than absorbed.
### Slice-3 debt handed on (2026-09-16, from the pre-merge review)

Named, with owners — none of these is a defect in what slice 3 shipped; each is a hole a *later*
slice would otherwise meet without warning.

- **~~Slice 4 (the picker is the first consumer):~~ paid by slice 4.** `theme_library` has no
  validation rule yet — slice 3 preserves it and reads nothing from it, so a hand-edited
  `theme_library` is undefined behaviour the moment slice 4 parses it. Its importer owns the rule, on
  the same storage-is-untrustworthy basis as `theme_tokens`. *(Closed 2026-09-16: `readLibrary`
  re-validates every entry and drops what `recordProblem` refuses, with the reason logged; the
  rule is recorded in `docs/invariants/settings-and-editing.md`.)*
- **Slice 4 or later (needs a renderer harness):** `src/hooks/useTheme.ts` and its `App.tsx` mount
  line are exercised only by a source walk, because the vitest environment is Node with no DOM and
  no React testing library. Subscribing once and applying on change is asserted textually.
- **Slice 7a:** the `--status-*` property names are frozen by A28 (`--status-<family>-<step>`, step ∈
  {400, 500, 600, on}) and written by the apply path, but nothing consumes them until 7a wires
  `:root` and `tailwind.config.js`. If 7a chooses other names, a themed status colour is written to a
  property nothing reads and the app silently renders `:root`'s. 7a must adopt these names or change
  them in `src/lib/theme/css.ts` in the same pass, **and** give `MUSAEUM_DEFAULT_TOKENS` a status
  family (or author the values in `:root`) — the apply path clears the 12 names when the incoming set
  has no status, so the default currently relies on `:root`'s values showing through, which today is
  a no-op because there are none.
- **Whoever next touches the theme tests:** three test files parse `src/index.css`'s `:root`
  independently (`theme/store.test.ts`, `lib/theme/css.test.ts`, and `theme/derive.test.ts`'s AC1.4
  pin). The AC1.4 pin is the authority; the other two are second reads of the same file, and a shared
  helper would remove the drift risk. Not worth a file on its own.
- **Slice 5:** `win.setBackgroundColor(...)` on a theme *change* is in §2.5's prose but carries no
  acceptance criterion in any slice — §4's promise that "the window's background changes on a theme
  switch" is therefore currently owned by nobody. Slice 5 should land it with a criterion, not just
  the sentence.

- [x] **Slice 4 — import and picker.** File import (native multi-select), a themes drop-box
      directory scanned on demand, a drop onto the Appearance section itself, and the picker in the
      settings modal. Landed 2026-09-16 from the annex in
      `docs/superpowers/plans/2026-09-16-theming-slice4.md` (13 adjudicated decisions), which is
      where the deviations from §2.4 are recorded: imported ids are **stem**-derived (`base16:<stem>`
      / `iterm:<stem>`) rather than §2.3's `base16:<slug>` — 1 of the 13 vendored files carries a
      slug — and every import answer carries the whole `ThemeView` (`ThemeImportResult.view`) so the
      rows on screen and the files just imported are one answer. **Gate:** typecheck 0 / lint 0 /
      build 0, and **508 passed, 23 files** (baseline 452/22 at slice 3). **File count: 11 code files
      + 2 test files**, one over `CLAUDE.md`'s ~10-file bound, with §5's named absorber
      (`AppearanceSection`'s rows folding into `SettingsModal.tsx`) deliberately **not** taken —
      recorded rather than absorbed silently, as A30 was. **Owed and paid here:** the `CHANGELOG`
      entry (slice 1–3 were invisible to the user; this is the first visible change), the
      `docs/architecture.md` listing, and `theme_library`'s read-validation rule (slice 3's debt).
      **Verified by the orchestrator on the running app**, not from the reports: the folder's
      contents are **hash-identical** before and after a scan (AC4.3, with a `.css` and a `README.md`
      present and silently ignored); a batch of five files with one malformed member imports **4 and
      rejects 1** by path and reason, and each of the four then applies with its own derived canvas
      (AC4.2); one click on a row repaints `--ink-950` in **19 ms** with the modal still open and no
      ⌘↵ (AC4.5); a `.yaml` dropped on the library produces **0** `importProgress` events where a
      control `.epub` produces 2 (AC4.4); and the imported library survives a restart (AC4.1's rows
      still there, still five swatches each). Four orchestrator mutations each reddened their own
      criterion.
      **A read-only pre-merge review then found one FIX-NOW defect, two undecided rules and a tail of
      nits; all but the tail are fixed** (spec amendment round 4, A41–A45). The FIX-NOW: the three
      import handlers composed their answer inline as `{ view: getThemeView(), ...importPaths(paths) }`,
      and left-to-right property evaluation read the view *before* the import — so a freshly imported
      theme was **absent from the picker**, and pressing Refresh replaced the good list with the same
      stale snapshot each time. No test could see it (the handler layer has no harness) and no live
      check caught it, because every one read the view back with a separate `theme.get()`. The
      composition moved into the service as `withThemeView(batch)`, where it has a deciding case; the
      same instrument now measures the row appearing **17 ms** after one press of the refresh control
      and applying in **21 ms**. The other two: a per-file *write* failure (reverting it left all 20
      importer cases green) and AC4.1's Obsidian arm (nothing filled a row from an `obsidian`-provider
      record) each gained a case. **Final gate: typecheck 0 / lint 0 / build 0, 513 passed / 23
      files.**
### Slice-4 debt handed on (2026-09-16)

- **Distinguish *new* from *refreshed* in an import report** (spec A39). A scan re-derives and
  re-upserts every theme file it finds, so a rescan of three unchanged themes reports "3 imported" —
  true, but it reads as if three were added, and a folder of thirty says thirty every time. The fix
  is a third array on `ThemeImportResult` (`updated`) plus one line in `AppearanceSection`'s report;
  it is a contract change, which is why it did not ride into slice 4.
- **The picker has no renderer test harness.** `AppearanceSection`'s rendering, its `onDrop` and its
  click-to-apply path are decided by source walks (the extension filter, "no `settings.save` in the
  path") plus the slice's live CDP pass — nothing renders the component in the suite, because the
  vitest environment is Node with no DOM. A refactor that keeps the strings those walks match and
  breaks the wiring would pass. Same standing as the `useTheme` note above. **This is what let the
  ordering bug through** (spec A41–A43's repair round): the handler layer is equally unharnassed, so
  anything the handlers *compose* is invisible to the suite. A recorded-handler mock for
  `test/mocks/electron.ts` would close both holes at once and is the cheapest next instrument.
- **One transaction per imported file** (spec A44). A folder of *n* themes costs *n*
  read-modify-writes over a JSON array that grows to *n* records on every Refresh. Accepted for
  D6's per-member atomicity — a batch that loses the first four files because the fifth could not be
  written is worse — and bounded by the user's own folder. The condition that would change it: a
  folder in the hundreds, or a scan the user can feel.
- **The theme-file extension set lives in four places** (spec A45): the dialog's filter, the scan's
  `SCANNABLE_EXTENSIONS`, `loadThemeText`'s dispatch, and the section's drop filter. Slice 6 adding
  `.css` must find all four, or a dropped `.css` is silently ignored by the scan and by the drop
  handler while the dialog offers it.

- [x] **Slice 5 — reader convergence and the light flip.** Landed 2026-09-19 from the annex in
      `docs/superpowers/plans/2026-09-19-theming-slice5.md` (8 adjudicated decisions). The reader's
      hand-copied `PALETTE` is gone: `src/lib/theme/reader-palette.ts` (new, pure, store-free)
      derives the page from the active theme's tokens — `ink-900` / `parchment` / `parchment_dim` /
      `gold-400`, which on the built-in default *are* the old `ink` row, value for value — and owns
      the injected stylesheet (`readerPageCss`) so §2.5's two vendored-engine constraints have a
      decider instead of a comment: no `var(` ever reaches the book document, and the `::selection`
      alpha is composed in the module (`linkAlphaHex`) rather than pasted onto a colour at the rule.
      `ReaderPrefs.theme` gains **`auto`** (the new default) beside the two authored rows.
      **The `search` role S1 owed is derived** — it is the derived link colour, and the S1 hand-off
      is paid with two measurements on a *hit-only* fixture (no links in the book, so every coloured
      pixel on the page is an outline): a run under solarized-light draws **1,784** px of that
      theme's `#cb4b16` and **0** of the old amber; under the default theme **1,783** px of
      `#d4a24e` and **0** of the orange. And the outline follows a *change*, not only a new run:
      `ReaderSearch` re-runs its own query when the resolved colour moves, because the vendor stores
      the draw options per run (`view.js:545`) — before that rule, switching themes with five hits
      up left **1,780** px orange on a page that had gone dark; after it, **1,764** px amber.
      **The flip:** `--shadow-a1/a2/a3` and `color-scheme` are now written by the apply path
      (`src/lib/theme/css.ts`, owned names 28 → 32, `aN = clamp(0,1, baseN × shadow / 0.55)` to 3 dp
      — 0.5/0.35/0.6 on the default, byte for byte what `:root` authors, and 0.145/0.102/0.175 on a
      light theme); `nativeScheme` (pure, in the theme service) drives `nativeTheme.themeSource` at
      boot **and on every change**, through a new in-process `subscribe` on `services/events.ts` —
      the same `themeChanged` broadcast the renderer follows; and the window gets
      `setBackgroundColor` on that same path, which is the criterion `tasks.md` owed from §4's
      prose. **Gate:** typecheck 0 / lint 0 / build 0, prettier clean on all 14 touched files, and
      **814 passed / 35 files** (baseline 789/34). **File count: 9 code + 4 test files** (the mock
      counted once, as shared infra), over the ~10-file bound; §5's slice-5 row said 6 code + 2 test
      and missed four of them — `css.ts` (the flip's writer, the same undercount A30 found on slice
      3), `ReaderSearch.tsx` (the `search` consumer), `events.ts` and the mock. The named absorber
      (`reader-palette.ts` + its test folding into `css.ts`) was deliberately **not** taken.
      **Verified by the orchestrator on the running app, not from the reports** (isolated
      `MUSAEUM_USER_DATA`, synthetic two-chapter EPUB, CDP): with the book open the reading pane is
      uniformly `rgb(20,18,16)` = `ink-900`, the *page* colour rather than the frame's `#0d0b09`;
      switching to `builtin:solarized-light` **with the book still open** repaints it to
      `rgb(239,233,215)` = the derived page (not the frame's `#fdf6e3`), which is AC5.7's round trip
      — the paginator's own margin gets the page colour, so the read-back branch was taken;
      `--shadow-a1` flips 0.5 ↔ 0.145 and `color-scheme` dark ↔ light with it; and
      `prefers-color-scheme` in the renderer flips on each change, which nothing but the main
      process's `nativeTheme.themeSource` can move (AC5.5, live). Eight orchestrator mutations, each
      reddening only its own criterion and every file restored byte-identically: the page mapped to
      `ink-950`, `SHADOW_REFERENCE` changed, `sanitizePrefs`' fallback changed, `color-scheme`
      dropped from `OWNED_CSS_VARS`, `linkAlphaHex` reduced to `link`, `nativeScheme` pinned,
      `var(--ink-900)` emitted into the page CSS, and the old `${c.link}44` pasted back at the rule.
      **A read-only pre-merge review found no blocking finding** and ten worth-fixing items; the
      repair round closed all ten (spec amendment round 5's repair block, A54–A59) and the mutation
      campaign is now **15/15 killed**. Two were substantive: **AC5.1's wiring had no decider** —
      the plan's own AC table promised a source walk over `ReaderEngine.tsx` and no test mentioned
      the component at all, so resolving against `null`, dropping `tokens` from the restyle deps, or
      taking the search colour from an authored row all stayed green; and **AC5.6 had no decider of
      any kind**. The rest: the `activate` arm's `adoptWindow` coupling, the broadcast handler's
      truthiness-only payload guard, `readerPalette` not being total (a malformed set could paint
      `background: undefined;`), the search highlight *not* following a live theme change, a
      vacuous test line, an exported-with-no-consumer `SHADOW_VARS`, and two comments that explained
      a rule by the wrong mechanism. **This round also corrected the first measurement's figure:**
      the round-5 "705 / 743 px" numbers were the fixture's **link line** (the link colour *is* the
      derived link colour), not the hit outlines — the clean numbers are above, and both are
      recorded in the spec rather than quietly replaced. Owed and paid here:
      `docs/invariants/reader.md` (the page-theme paragraph, the highlight-colour rule, and the new
      "a colour resolved once per run will disagree with the page after the next theme change" rule)
      and `CHANGELOG.md`.
- [ ] **Slice-5 debt handed on (2026-09-19).**
      - **AC5.2's decider is a two-link chain, not one import.** `reader-palette.test.ts` cannot
        import `MUSAEUM_DEFAULT_TOKENS`: `tsconfig.web.json` includes `src/**` and `test/**` only,
        so the cross-tree import is a `TS6307` (plus 13 `TS2307`s for the inlined `*.yaml?raw`
        corpus). The test therefore parses `src/index.css`'s `:root`, and
        `theme/store.test.ts`'s existing pin holds `MUSAEUM_DEFAULT_TOKENS` against that same block.
        The only way to make it one link is to widen `tsconfig.web.json`'s include — a config change
        that is not slice 5's to make.
      - **`subscribe` has no unit decider** (still open after the repair round, which closed the
        surrounding wiring instead). Its unsubscribe and its throw-isolation (a listener that throws
        is logged and skipped, never propagated, never stopping the renderer's push) are documented
        in `services/events.ts` but asserted nowhere — `index.ts`, its only subscriber, is not
        importable under vitest. Cheapest closure: a case that registers two listeners, has the
        first throw, and asserts the second still runs. `services/events.ts` has no test file today.
      - **AC5.7's structural half is asserted by value, not by placement.** The string tests prove the
        page colour appears in the stylesheet and that nothing is a `var(`; they do not prove *which*
        rule carries it, so a swapped `html`/`body` pair would pass. Not worth a file on its own;
        note it to whoever next extends `readerPageCss`.
      - **`win.setBackgroundColor`'s effect is not observable over CDP** (the A25 residual class): it
        shows only during a resize flash, and a screenshot covers web contents only. Its decider is
        the source walk in `theme/store.test.ts` plus `windowBackgroundColor`'s unit test — the
        wiring exists, that it *ran* is the residual.
      - **The popover's `Auto` dot is a judgement call.** It is two-tone (ink over parchment) because
        `auto` is not either row; no frame was compared against an alternative, and the same is true
        of the option's position in the list.
- [ ] **Slice 6 — Obsidian resolver.** Load `theme.css` in a sandboxed offscreen window with the
      dark/light class applied and read the variables back as computed values. It is needed rather
      than nice: a regex scrape resolves **1 of the 5** Obsidian themes installed on this machine —
      the rest compute their roles through `hsl(var(--base-h) …)`, `var()` chains and `color-mix()`.
      Security surface: arbitrary CSS, possibly a remote `@import`, network blocked, and never injected
      into the real renderer. Stored as **derived values only** plus `sourcePath` — never a copy of the
      source CSS.
- [ ] **Slice 7a — the status family and the inversions.** The *derivation* half already landed with
      slice 2 (`theme/derive.ts` + `src/types/theme.types.ts` carry `danger`/`ok`/`warn` with their
      `400`/`500`/`600` steps and `on-*` foregrounds, floors enforced and corpus-tested); what 7a owes
      is the `:root` + `tailwind.config.js` wiring for `scrim` and the status family, and then the
      migration: the **twelve veils** (`bg-ink-950/70|80` → `bg-scrim/…`) and the two
      `ring-white/5` hairlines (`BookCard.tsx:79`, `BookDetail.tsx:81`). Not optional: under a flipped
      light ramp `ink-950` is the *lightest* tone, so every modal backdrop inverts to a white wash —
      and four of the twelve are chips laid over **cover art** (`BookCard.tsx:98/114/128/167`), which
      is exactly why `scrim` is a role that darkens in both variants rather than a ramp step.
- [ ] **Slice 7b — the status sweep.** Migrate the **53 stock-palette sites across 16 files**
      (`text-red-400` ×23, `bg-red-500` ×11, `border-red-500` ×7, `text-white` ×4, `bg-red-600` ×3,
      `ring-white` ×2, `bg-emerald-500` ×1). Acceptance is a repo-wide grep reaching zero, with the
      count recorded before and after. Split out of 7a because the sweep crosses 16 files, over the
      ~10-file bound; 7a is the bounded half and lands green on its own.
- [ ] **`gold-200` defect — fixed by slice 7a** (spec J5). Four sites in two files reference a ramp
      step the config **never defined** (`gold` is 300/400/500/600), so `text-gold-200` / `bg-gold-200`
      emit no CSS rule at all. Measured in the running app: the selected-row tick computes to
      `rgb(125,114,96)` — an inherited `parchment-faint` — while the same element's `bg-gold-500/30`
      tint works correctly. Fix: the three text sites → `gold-300`, and the mark at
      `ListView.tsx:211` → `bg-gold-400`.
- [ ] **Follow-up (owner request 2026-09-17) — compartmentalize the Appearance section.**
      Settings → Appearance is now the tallest thing in the dialog and growing: the whole
      built-in corpus plus everything imported renders as rows (swatches, name, provider,
      notes disclosure), and the modal body is a single `overflow-y-auto`
      (`SettingsModal.tsx:163-165`), so the section pushes Library / Transfer / Advanced below
      the fold. Slice 6 (Obsidian) adds imports and the user's own folder can hold hundreds.
      **Two constraints this section already carries, both reasoned — a compartmentalization
      that ignores them re-breaks something deliberately decided:**
      (a) the way in comes first, because "burying [the folder] under a hundred rows is how a
      picker hides its own import" (`AppearanceSection.tsx:121-124`) — collapsing the *list* is
      fine, collapsing the *import control + drop-box row* is not; and
      (b) the drag feedback is a sentence at the top rather than a highlight on the rows panel,
      because that panel "can be a screen below the pointer while the file is over the window"
      (`:206-209`) — so anything that scrolls or folds the rows away must keep that property.
      Candidates, none decided: the active theme summarized in a collapsed header; a "Manage
      themes…" sub-view or second modal; a swatch grid rather than full rows; built-ins behind a
      disclosure (they are the fixed half — the user's imports are the variable one); a filter
      box over the rows. Acceptance must include both constraints above, AC4.5 (one click
      applies, no ⌘↵), and drop-anywhere-on-the-section. Interacts with slices 6 and 7a, both of
      which edit this component — sequence it after them, or accept the rebase.

Decisions already closed — **do not re-litigate**; each carries its rejected alternative and a reversal
condition in the spec's adjudication block (J1–J11): palette-only (never layout); scheme-native accent
rather than amber-locked; light themes supported from day one; all three providers in v1; curated
built-ins **and** file import; token names stay `ink`/`parchment`/`gold` in v1 (renaming would touch 28
files — it is a separate mechanical pass, after slice 5); and the full status sweep inside this feature
rather than as debt, staged 7a/7b.

### Slice 2 adjudications (2026-09-15 — do not re-litigate)

Porting `derive.py` forced four calls. Each carries what it beat and what would reverse it; the spec
carries the same set as its amendment round 2.

1. **`derive.py` wins over §2.2's prose wherever the two disagree** — in three places. The scrim rule:
   the prototype mixes the dark end 35% toward black and walks a luminance floor, where §2.2 described
   the dark variant's scrim as *being* the dark end. The status floors: `400` is 4.5 (not 3.0), `600` is
   a bare `adjust_light`, and `on_fill` is a `max` rather than the walk §2.2 describes. And the ladder's
   `mix(…, 'linear')`, which is a componentwise sRGB interpolation, **not** an interpolation in linear
   light — swapping it for real linear-light or for Oklab moves nine tests. *Rejected:* implementing the
   prose. The tests pin the prototype, and the prototype is what was measured over 8 palettes.
   *Reversal:* a real palette where the prototype's rule fails and the prose's would not.
2. **The status family ships inside slice 2, not 7a.** §2.2's return-key list omits it and J2 gave the
   derivation to 7a, but J6 had already landed it in the prototype, and this slice's whole burden is to
   reproduce that prototype verbatim. **7a's scope therefore shrinks**: it owns the variables and the
   site migrations, not the derivation. *Rejected:* deferring it, which splits one function across two
   slices and breaks the property J6 was executed to preserve. *Reversal:* slice 7 being dropped — the
   status block is self-contained and deletes cleanly.
3. **Terminal floor verification is the port's one addition.** The prototype's six bounded loops exit at
   their cap **without re-checking**, so a theme that never met a floor is returned as a success whose
   own audit row reads FAIL. An unmet floor now returns a value — `{ role, ratio, floor }` — and nothing
   throws (invariant 12). *Measured:* identical results on all 15 real palettes, and the synthetic
   `#808080` palette, which the prototype returns as a theme with 9 FAIL audit rows, is rejected with
   `parchment 1.0 < 4.5`. *Rejected:* keeping the silent pass — it is precisely the class of failure the
   picker would otherwise present as a working theme. *Reversal:* none foreseen.
4. **AC2.4 is amended** (spec amendment round 2). Its literal clause — every derived ladder stop within
   `hue_delta < 0.61` of its canvas, on the gruvbox iTerm fixture — is **false against the reference
   implementation**: six of the seven stops measure 1.29–2.47, because that fixture's canvas chroma
   (0.0049) sits under the filter's own 0.01 bypass, so the hue clause never applies and a near-grey's
   hue angle is numerical noise. The criterion keeps its literal clause on the **nord** fixture (where it
   holds, 0.000–0.003) and asserts the property on gruvbox: every chromatic ANSI slot excluded by the
   filter, the ladder grey and rising, and the witness that a luminance sort would have taken gruvbox's
   green. *Rejected:* deleting the criterion, or softening it to nothing — the mutation it names (an
   unfiltered luminance sort of all slots) still kills three tests. *Reversal:* if a fixture turns up for
   which the literal clause holds *and* that mutation still kills it, restore the literal form there.
   **It now has a decider:** a synthetic `.itermcolors` built inline in the test (canvas chroma 0.0351,
   above the filter's 0.01 bypass; an off-hue near-grey inside the luminance window) — measured,
   deleting the hue clause moves `bg3` from `#506070` to `#5a4a3a` and reddens exactly that case. The
   nord clause (a) survives as a **property pin that cannot discriminate**, and its comment says so.
5. **The failure reason became a discriminated union** (`kind: 'floor' | 'malformed'`, plus
   `metric: 'contrast' | 'luminance'` on the floor arm), taken deliberately before any consumer exists.
   *Rejected:* leaving `{ role, ratio, floor }` bare — a malformed IR then has no way to report itself,
   and `deriveTheme` would keep **throwing** on a missing field or returning an `ok: true` theme with
   all-NaN tokens, which is precisely what invariant 12 forbids at the one entry point that will
   receive untrusted input (slice 6's resolver, slice 3's re-derive). *Reversal:* none foreseen — the
   change is cheapest now; after slice 3 stores and slice 4 formats reasons it costs a migration.
6. **The six `Number.isFinite` guards stay, recorded as *unreachable* rather than as tested
   behaviour.** The repair round measured that deleting all six leaves the suite green, and the
   orchestrator reproduced it independently (0 of 345 cases redden — mutation M7). They are kept
   because they are what holds the totality claim if a future rule introduces a non-finite path. The
   honest statement is "unreachable given the validation fix", not "covered".
7. **A three-digit hex is expanded, not rejected.** `normalizeHex` is the one validator the contract
   named, and it accepts `#rgb`/`#rrggbbaa`; so `#fff` becomes `#ffffff` and then fails a *floor*
   rather than being called malformed. The dispatch contradicted itself (it said "six hex digits" and
   also "use `normalizeHex`"); the code follows the validator, which is the better answer for a value
   a user can see. (The first claim written for this — "a three-digit hex becomes a floor rejection" —
   holds only for the metronome fixture; on real palettes a white canvas or border is *accepted*. The
   test now pins both directions.)
8. **The audit table is verified against itself** (spec A20): **no success result may carry a row below
   its own floor.** A general sweep, added *alongside* the six precise per-loop checks, because the
   prototype audits two placements but walks one score — the status fill's guard accepts
   `max(separation from canvas, separation from panel)`, so a fill that clears the panel but not the
   canvas passed while its shipped row read FAIL, and `accent on canvas` had no guard at all.
   *Measured before the sweep:* 715 of 40,894 successful random-IR derivations (1.7%) carried a
   sub-floor row, and **1,200 single-field perturbations of the 15 palettes produced none** — which is
   why neither the corpus test nor any per-loop witness could see it. *Rejected:* leaving it, which
   ships a theme whose own table prints FAIL while the picker shows it as active. *Reversal:* none
   foreseen; the derivation's rules are untouched, which the differential re-run proves.
9. **`variant` is validated**, `muted: null` now rejects like every other required field, `ir.notes` is
   filtered to strings, and every `malformed` detail goes through a bounded, throw-proof
   `describeValue`. The last closes totality's one remaining hole (a field whose `toString` throws used
   to throw out of `deriveTheme`). *Rejected* for notes: coercing with `String()`, which would
   reintroduce the single call into a caller's own value that the round closed.
10. **`index.ts` exports the discriminated failure types and drops `FloorFailure`.** The front door
   otherwise hands slice 4 exactly the shape the discriminant was added to retire, and a cast restores
   the un-narrowed `.ratio` that the `tsc --strict` probe was written to prevent. *Reversal:* if a
   consumer genuinely needs the base shape, re-add it with a comment saying why.
11. **The sweep's finiteness arm is kept and recorded as *unreachable* today** (0 non-finite rows over
   60,000 random IRs and the whole corpus). Three lines inside a sweep the criterion already requires,
   and the arm that keeps "no success carries a bad row" true if a rule above ever produces a NaN —
   the same standing as the six `Number.isFinite` guards in adjudication 6.

Notes and named debt left by this slice:

- `deriveTheme()` **mutates the IR it is handed** (`notes`), exactly as the prototype does. Derive once
  per parse, or clone: two derivations over one IR accumulate duplicate notes in the result, which is
  where slice 3's re-derive-on-version-mismatch path (J3) would bite.
- `ThemeIr.accents` is a complete `Record<AccentSlot, string>` and both adapters reject a file that
  cannot fill every slot, so §2.2's "a provider that omits one falls back to the accent ramp" has no
  implementation. Slice 6 owns that call — Obsidian is the only provider that can legitimately miss a
  role.
- `parseItermcolors(text, name?)` takes the palette's display name as an optional second argument; the
  loader passes the file stem, which is the prototype's behaviour. Slice 4 calling the adapter directly
  must pass a name or accept an empty one.
- `THEME_ENGINE_VERSION = 1` is declared in `theme/index.ts`, next to the rules it versions (J3 consumes
  it in slice 3).
- The vendored corpus is **13** schemes (spec §5 said 10), and **4 of the 13 are light** — not the
  "deliberately half light" §6.5 claims. Both corrected in the spec; recorded here because the light
  share matters: light variants are where the derivation is least tested, and slice 2 is now the layer
  that carries that risk forward.
- `.prettierignore` (new) lists `electron/main/services/theme/builtin/` and `test/fixtures/theme/` —
  `prettier --write .` would otherwise rewrite the vendored YAML.
- **Dispatch defect, recorded so it is not repeated:** the repair contract conjectured that a *balanced*
  extra container would trip the plist scanner's stack-length guard. Measured false — the stack is empty
  at that point, the trailing container silently replaces `root`, and the rejection comes from the slot
  check instead; the input that does exercise the guard is an **unbalanced** one. Both are cases now.
  The same round's "not `#` + six hex digits" wording contradicted its own "use `normalizeHex`" (see
  adjudication 7).

## Kindle presence (design: `docs/superpowers/specs/2026-09-17-device-presence-design.md` — measured 2026-09-17)

The device half of the app, after a session that measured it end to end.
Instrument: `scripts/device-presence-census.py` (read-only, re-runnable while the
app is running).

- [x] **Send-button states + send receipt** — landed `a6d7bbc`. The button reads
      the transfer queue ("Sending to {device}…" / "On {device}" /
      "Couldn't send — retry") because `sendToDevice` resolves when the job is
      *queued*; a finished send now also records the name it wrote, so a book
      retitled afterwards stops reading as absent. That combination sent a
      byte-identical duplicate (same EXTH 113, same md5) to a real Kindle.
- [x] **Covers measured, and the device backfilled by hand (2026-09-17)** — the
      firmware no longer generates covers for new files; the entry is
      `system/thumbnails/thumbnail_<EXTH 113>_<cdetype>_portrait.jpg` and the
      stale `…jpg.tmp.partial` beside it must go too (both required — 148 books
      here were carrying a cover a 0-byte marker was hiding). Backfill: 77
      written, 224 markers cleared.
- [ ] **Write covers on send, and re-apply on connect** — nothing in the app does
      it yet, so a fresh send still lands without a cover. Amazon destroys these
      entries (Calibre keeps a restore cache for exactly that), so writing once at
      send time is not enough.
- [x] **Presence by the file's own title, not the filename** — shipped
      2026-09-17. A book is present when a device file's own title and author
      agree with it (`authorKey` is order-insensitive, so Calibre's
      "Banks, Iain M." is the library's "Iain M. Banks"), or when the file's
      title is the book's and the library holds exactly one book with it; the
      filename rule stays as the fallback for files whose header cannot be read.
      Measured on the real Kindle: the filename rule alone recognized 86 of 1,555
      files and presence answered **1,347 of 6,460 books** in the running app
      (3.9 s from launch, warm cache). Byte layout and pitfalls:
      `docs/invariants/device-transfer.md`.
- [x] **Cache the content keys in SQLite** (`path + size + mtime` → title/author)
      — shipped with the slice above (`device_file_identity`, migration 004). The
      5 s poll stays readdir-only; headers are read behind the scan by a bounded
      pool and presence settles as batches land. Measured: **3.9 s** from launch
      with a warm cache; an empty identity cache answered in ~21 s, but with the
      mount's page cache hot from this session's own reads — plan against the
      census's **73 s** for a cold mount, not 21 s.
- [ ] **A co-author the library splits, or the file names only partly.** Two
      files on this device carry one of two co-authors in EXTH 100
      (`Jason Mendelson` against a library author `Brad Feld & Jason Mendelson`),
      and both of their titles are duplicated in the library — so the uniqueness
      guard refuses them and the books read as absent. The guard is doing what it
      was designed to do (a re-send is cheap, a false positive is not), but an
      author rule that accepts *the file's author as a subset of the book's* while
      still refusing a genuinely ambiguous title would recover both. A design
      decision, not a bug — not taken here.
- [ ] **Device report / browser** — parked, deliberately. The case for it shrank
      when presence went content-based; what is left is the residual 212 files
      whose own titles match no library book (user guide, dictionaries, edition
      drift), which is a reporting question rather than a browsing one. Do not
      start it before the presence slice lands.
- [x] **The redundant Nerd Reich file** — removed 2026-09-17. The two copies were
      byte-identical (md5 `ded086345c4a…`, EXTH 113 `640e81af…`), so the
      long-titled orphan went with its `._` AppleDouble sibling — no `.sdr`
      existed, so no reading position was involved — and the survivor kept its
      bytes and the cover entry, which is keyed by the shared uuid. Presence for
      the book is unchanged: verified in the running app afterwards,
      `getOnDeviceBookIds` still answers true for it.
      The deletion was gated on the two being identical rather than on the
      filename: nothing unique could be lost by removing either one.

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
- **`text-gold-200` / `bg-gold-200` emit no CSS rule at all** — `gold-200` was never defined in
  `tailwind.config.js` (`gold` is 300/400/500/600), so the four sites that use it
  (`SelectionPanel.tsx:77`, `ListView.tsx:88, 207, 211`) get an inherited colour instead of gold.
  Live in the running app: the selected-row tick computes to `rgb(125,114,96)`
  (`parchment-faint`), while the same element's `bg-gold-500/30` tint works. Present since
  `6ed5fc7` (multi-book selection). The fix is owned by the theming work — see the Theming
  section above, J5. (Found 2026-09-15.)
- **`requirements.md` now overlaps `docs/architecture.md`** (2026-09-15). The
  485-line original spec is still the better record of *why* the pieces are
  shaped the way they are, but its architecture, schema and IPC sections
  duplicate the docs. Decide whether to fold it in so there is one architecture
  source, or annotate it as historical and leave it alone.

## Specified, not scheduled (2026-09-19)

Three features have been analysed against this file and written up as designs. **None was
scheduled when it was written**; the AI panel's first slice has since been signed off (below). Each
was specified so the decision is actionable the moment a trigger fires, and so the reasoning is not
re-derived from scratch. The analysis that produced them — what is in the roadmap, what is missing
from it entirely, and which of those are worth building — is in `docs/project-overview.md` §7–8.

- [x] **In-book search (S1)** — spec:
      `docs/superpowers/specs/2026-09-19-reader-search-design.md`. The engine already implements
      it: `view.search()` in the vendored
      foliate-js is a public async generator yielding per-section progress, CFIs and excerpts,
      and it draws its own highlights. Read off the vendored commit, not upstream's docs — the
      same discipline `src/types/foliate-js.d.ts` follows. So there is no index, no schema
      change, no sidecar call and **no NAS I/O at all**: `open()` already holds the whole file
      in memory, which means search works offline and on a dropped share. Its expensive twin — a
      library-wide index of book *contents* — is **rejected** in that spec's D1 with a reversal
      condition; do not fold it in. **Built 2026-09-19**, one slice, **9 code files** (the spec's
      `icons.tsx` row was already satisfied — `SearchIcon` existed — and
      `src/types/foliate-js.d.ts` took its place, as that spec's invariant note predicted).
      25 new tests (**789 / 34 files**), `typecheck` / `lint` / `test` green, `vendor/`
      untouched. Verified in the running app on an isolated profile: `ledger` → **4 hits in 3
      groups** in spine order with counts 1/2/1; search-hit outlines measured as gold pixels in
      the reading pane **0 → 1044**, still 1044 after a page turn, **0** again when the panel
      closed; a jump moved the stored position
      `epubcfi(/6/4!/4/2,,/10/1:53)` → `epubcfi(/6/2!/4/2,,/10/1:114)` and `metadata.json`
      carried it; the three-step Escape chain and the three-way side-slot exclusivity (D4)
      proved by clicking all three panels. **The criterion AC1.2 caught a real bug in the first
      build** — the new Escape arm swallowed every unmodified key while the panel was open, so
      page turns were dead until it was narrowed to Escape alone — and the probe found a second,
      latent one: `openBook` on the book that is *already* open stamped `loading` with nothing
      left to report ready (guarded, with a case). Three things it deliberately does **not** do:
      no index, no persisted query or results (a session-only panel), no PDF. Theming slice 5
      still owes the `search` colour in its derived palette table.
- [ ] **OPDS catalog (conditional)** — spec:
      `docs/superpowers/specs/2026-09-19-opds-catalog-design.md`. **Trigger: a second reading
      device that speaks OPDS** (a Boox, a Kobo running KOReader, a phone with KOReader or
      Librera). Do not start without one — that is the spec's first precondition, and the cost
      of this feature is not the code, it is a permanent network surface on the machine holding
      the library. Would also make the Boox Palma item below real for near-zero extra cost,
      since KOReader on a Boox reads OPDS. Two slices: **O1** (server, auth, new/all/search,
      covers, downloads) then **O2** (author/series/unread browse tree).
- [x] **Ask about what you're reading (the AI panel)** — spec:
      `docs/superpowers/specs/2026-09-19-reader-ai-panel-design.md`. Three slices, cut at the
      testability boundary. **Slice 1 — built 2026-09-19** (endpoint settings `ai_base_url` /
      `ai_model` / `ai_api_key` with a localhost default, the main-process streaming client
      `services/ai.ts`, and the `ai:getStatus` / `ai:ask` / `ai:cancel` surface + three events;
      11 code files, 44 tests, `typecheck` / `lint` / `test` green, `index.html` untouched). Nothing
      in the UI yet — that is slice 3. **Slice 2 — built 2026-09-19** (the two pure pieces: the
      prompt assembler `src/lib/ask-context.ts` and the recall scorer `src/lib/recall.ts`, 4 files,
      39 tests, gates green; the one bug the build exposed was AC16 catching `parseProbe` folding
      trailing commentary into the claimed opening, which would have scored a correctly-placed book
      `weak`). **Slice 3 — built 2026-09-19** (the panel itself: `ReaderAsk.tsx` + the store's ask
      state, `useAi.ts` one-subscription wiring, `ask-session.ts` — the pure reducer for
      probe→verdict→rung and the TOC-label citation matcher — and the engine's `tocItem.label` /
      section-text / selection threading; 9 code files + 2 test files, 50 tests, gates green).
      Verified in the running app against a **stub SSE server** on the endpoint's own default —
      no model installed, an isolated profile (`MUSAEUM_USER_DATA`) and a synthetic two-book
      library, so the real library was never opened:
      one slot with TOC proved by clicking both; Escape in the composer closes the panel and
      leaves the book; the disclosure line names endpoint + model + payload before the first
      send; tokens render mid-stream; a `weak` verdict adds the passage and says so; the
      override adds it on demand; "Go to ‹label›" jumps to the section the answer named and is
      absent when the answer names none; a sentinel answer appears nowhere on disk (0 hits in
      the library tree, the DB and its WAL). Slice 3 shares the reader's one side-panel slot
      with TOC and S1 (`ReaderView.tsx:214`) under the spec's D4 rule. Two things it deliberately
      does **not** need: no annotations or highlights storage (a live selection is enough — D5/D7)
      and **no CSP change** (the call is main-process, D2). Its third rung (adjacent sections) is
      deferred until a real book is measured weak *with* its section text sent.

## Captured, not analysed (2026-09-19)

An owner idea recorded here so it is not re-derived from one sentence later. Nothing in this
section has had the treatment the two specs above got: each entry carries only **what is already
true in this repo that touches it**, and the forks that make it a decision rather than a chore.
The bound of this section is that it stays a paragraph, not a design — with one deliberate
exception: the AI entry below stopped being a paragraph when the owner argued a thesis about its
payload, so it now carries the measurements that bear on that thesis. Everything else here is a
paragraph.

**Update (2026-09-19, same day):** the AI entry below is no longer captured-only. It has a design —
`docs/superpowers/specs/2026-09-19-reader-ai-panel-design.md`, listed under *Specified, not
scheduled* — which settles its six forks as that document's D1–D9 and carries the measurements
listed here. The entry stays as the record of the argument that produced the design and of the
things that were true in this repo before it existed; it is **not** a second source of truth for
the design itself. Where the two disagree, the spec wins.

### AI conversation about the book you are reading

**Owner's words:** *"a sidecar to the ebook reader where I can ask the AI questions and it knows
from the position or current highlight to what I'm referring to — user would have to configure an
API key or run a local model."*

**Settled by inspection — three of the pieces already exist:**

- **The "where I am" input does.** `FoliateRelocateDetail` carries `cfi`, `fraction` and
  `tocItem` (`src/types/foliate-js.d.ts:23-27`), and the current section's `Document` arrives on
  the engine's `load` event (`ReaderEngine.tsx:156-158`) — so the pointer is free, "the text being
  read" is `doc.body.innerText` of the open section when the payload ladder needs it, and "jump to a
  citation" is the `goTo(cfi)` the TOC panel and position restore already use
  (`src/types/foliate-js.d.ts:64`).
- **A highlight does not need the annotations storage decision.** Annotations/highlights/bookmarks
  are still out of the reader and still wait on storage (`tasks.md` C1 out-of-scope list) — but
  foliate's annotation mechanism is already in use and needs no persistence: `addAnnotation` /
  `deleteAnnotation` are public (`view.js:368`, `:399`), non-search annotations are *ours to draw*
  (the engine emits `draw-annotation` with `{draw, annotation, doc, range}`, `view.js:393`), and
  search re-adds its own on every section render (`view.js:416`). A **session** selection or
  highlight is therefore a live CFI plus one `draw-annotation` listener, and v1 should read that —
  **never a highlight library**. This is what stops the feature queueing behind the annotations
  decision instead of being decoupled from it.
- **Key resolution has a precedent to copy.** `resolveGoogleBooksKey()`
  (`services/sidecar.ts:51`) already implements "`app_config` wins over the environment, report
  which source won", and Settings validates a value before writing it — so an AI key is a
  settled shape, not a new question.

**Owner's position on the payload (2026-09-19) — the pointer, not the text:** *"with the latest
frontier models, entire chapters do not need to be sent over the wire at all… all we'd really need
to do is send the title, author, chapter #, and the highlight."*

The argument is right, and it is the compression argument this app already lives by: when the
decoder holds the content, the message only has to carry the residual — title, author and section
are an *index* into knowledge the model already has, and the highlight is the one piece of text
that must travel verbatim because it is the **referent**. Two consequences are worth more than the
bandwidth saved: egress drops from "a chapter of a copyrighted work to a third party" to a citation
plus one sentence, and answers become cacheable per `(book, section, question)` in the local SQLite
cache like any other local artifact.

**What this library actually says about the bet** (measured 2026-09-19, read-only against the live
dev database — 6,458 books, of which **5,080 hold an epub/mobi/azw3**, so that number is this
feature's real surface):

| Slice                            | Books | Bearing on the bet                                                                     |
| -------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| pre-1900                         | 995   | public-domain canon — the most-memorised material there is                             |
| 1900–1959                        | 43    |                                                                                        |
| 1960–1999                        | 377   |                                                                                        |
| 2000–2013                        | 3,132 | the bulk: business, self-help, technical, textbooks                                    |
| 2014–2023                        | 1,773 |                                                                                        |
| 2024+                            | 134   | **outside most models' knowledge by construction**                                     |
| Lonely Planet + Rough Guide      | 290   | travel guides — no chapter-level recall exists in any model                            |
| no description at all            | 2,602 | proxy for how weakly indexed these are anywhere                                        |
| authors / authors appearing once | 3,727 / 3,118 | 84% of authors appear exactly once — a long tail                                |

*(Rows are separate reads, not a partition — the travel-guide, no-description and author rows
overlap the year buckets. Do not sum the column.)*

The library **splits** the thesis rather than confirming it. The canon slice — pre-1900 plus the
King/Clarke/Dick/Vonnegut/Sartre/Márquez/Tolkien shelf — is exactly where pointer-only should work,
and it is a large, real fraction. The 2000–2023 non-fiction majority is where no pointer summons the
chapter: 290 travel guides, a UCC contracts textbook, a bread-baking book. And the model has no way
to know which kind it is looking at — it answers fluently either way. English is the one thing that
favours the bet strongly and it favours it almost universally here (6,274 of 6,458).

So the residual risk is not a *rate* problem, it is a **grounding** problem — and it is the kind
this app can test for free, because `open()` already holds the whole book in memory. **The design
that follows from the argument: pointer-only by default, with local verification.** Before trusting
a pointed answer for a book, ask one question whose answer is checkable against the local text (the
section's opening line, or the names that appear in it) and score it locally; if recall is weak for
this book, widen the payload for that session — the section, or a window around the CFI. Nothing
leaves the machine to do the checking, and the escalation is evidence-driven rather than a hope.
Same discipline as the device-presence census: make the assumption measurable, give the failure a
visible path.

Three smaller consequences, all real:

- **Pass the TOC label and the fraction, not the chapter number.** Section indices and chapter
  numbers drift across editions, reissues and translations, and a collection's "chapter 7" is a
  short story. `tocItem` and `fraction` are already on the relocate detail; the bare integer is the
  weakest of the three.
- **"I don't have this book" must be an answer the model is allowed to give.** For the tail above,
  a plausible invented chapter summary is the worst possible output; refusal has to be cheap.
- Prompt shape: the pointer is the *index* and the highlight is the *referent* — say which is which.

**Forks — each is a decision, none is a detail:**

1. **The call cannot come from the renderer.** `index.html:8`'s CSP is
   `connect-src 'self' ws: musaeum:`; no remote host is reachable, and that is a stated promise
   ("book content can never execute and an EPUB cannot phone home", `docs/project-overview.md`
   §3.5), not an accident to widen. So the client belongs in `electron/main/services/` with tokens
   streamed back over IPC (invariant 8) — **not** in the Python sidecar, whose job is metadata.
2. **Name collision to kill first:** "sidecar" in this repo *is* the Python metadata process. An AI
   panel is a renderer surface plus a main-process client; calling it a sidecar in code, tasks or
   specs will read as the wrong process forever.
3. **What leaves the machine is a smaller question than it looked — but not zero.** With the
   payload argued above, the standing egress is a title, an author, a section label and the
   highlight; the residual is the highlight itself and any escalation to text. So the panel still
   has to say what it is about to send, and the provider setting still has to be modelled as
   **base URL + model** with localhost first-class (Ollama, `llama-server`, LM Studio) rather than
   a cloud key with local bolted on — a local model is what makes the remaining egress exactly
   zero, which today is the app's stated posture ("no account, no service, no listener").
4. **Transcripts are the growth risk, so they are not part of a book's record.** Same class as
   highlights: the first thing that grows without bound. If conversations are kept at all, the
   local SQLite cache is the place — never `metadata.json` and never `catalog.json`, whose costs
   are one SMB write per book and a whole-library rewrite. Persisting them at all is optional; v1
   can be single-session.
5. **The reader's side panel is a one-slot resource.** `ReaderView.tsx:214` holds one panel and the
   two occupants are session-only store booleans (`reader.store.ts:100-102`); S1 (in-book search)
   claims the same slot under a TOC⇄search mutual-exclusion rule. Whichever of the two lands
   second owns settling that layout — two panels, or one slot with a rule.
6. **Named, not decided:** single-turn vs. multi-turn; **the escalation ladder's trigger and
   thresholds** (the shape is settled above — pointer first, widen on evidence — but what counts as
   weak recall, and whether the check is one probe per book or per section, is not); whether an
   answer may cite a CFI the panel jumps to; and whether the AI may be asked about the **library**
   rather than the book — that last is a different feature (a catalog query over FTS) and must not
   be absorbed into this one silently.

**Sizing guess, on the house arithmetic:** ~10 code files, at the bound. The pieces to design for
testability are both pure and both belong in `src/lib/`, since the renderer has no DOM harness (a
standing gap, recorded under slice-4 debt): the context assembler — `(book, section label,
fraction, cfi, selection) → prompt` — and the recall scorer the ladder above turns on. The
main-process client is testable today; the panel is not.

## Post-MVP (unchanged from spec — do not implement yet)

- [ ] Boox Palma WiFi transfer (feature-flagged stub only)
- [x] In-app reader — shipped 2026-08-13 for epub/mobi/azw3 (see the reader
      section above). **Annotations, highlights and bookmarks remain**, and are
      still Post-MVP: they need a storage decision before any UI.
- [ ] iOS companion app (REST API activation; contract already staged)
- [ ] Goodreads account sync
- [ ] Collections UI (schema present, UI deferred)
- [ ] REST API (stub present at `electron/main/api/rest.ts`, disabled)
- [ ] Auto-updater (pending distribution decision above)
