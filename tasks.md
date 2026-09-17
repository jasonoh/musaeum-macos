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
      highlights are the first thing that would grow without bound.
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

- [ ] **Slice 5 — reader convergence and the light flip.** The reader's own `PALETTE` table
      (`src/components/reader/ReaderEngine.tsx:48-50`) becomes derived, under two hard constraints: its
      injected stylesheet must carry **resolved literals, never variable references** — foliate's
      `vendor/foliate-js/paginator.js:191` reads the book document's resolved background back out and
      string-compares it against a transparent rgba, and an unresolvable `var()` falls through that
      test — and the alpha-suffix concatenation at `ReaderEngine.tsx:104` must go. Also derived
      shadows and the native window appearance.
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
