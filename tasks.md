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

## Phase 1.5 — PDF support

- [x] **PDF format support shipped** — pdf is a first-class format: import,
      hydration (PDF Info dict extraction + page-1 render as an 'embedded'
      cover candidate), Kindle transfer (direct copy, never converted).
      Calibre PDF top-up (`topup_pdfs`): re-runnable, matches by Goodreads ID
      → ISBN-13 → normalized title+author (ambiguous matches skipped),
      attaches PDFs to existing book folders (idempotent) or imports
      PDF-only books as new. Migration wizard: "Import PDFs from Calibre…"
      action with progress + attached/added/skipped summary.
- [ ] Run the PDF top-up against the real Calibre library (after verifying
      on a scratch subset)

## Phase 1.5 — polish before real-library use

Blockers before pointing the app at the full 7000-book NAS library:

- [ ] **Virtualize the grid and list views** — currently all book cards render
      at once; 7000 DOM nodes will blow the <2s load / 500MB memory targets.
      (react-window or hand-rolled intersection observer.)
- [ ] **Settings UI** — there is currently *no way to change the library root
      after first configuration*, nor to set `smb_url`, `python_path`,
      `ebook_convert_path`, or the Google Books API key from the UI. A small
      settings modal writing through to `app_config` covers all five.
- [ ] **Google Books API key** — obtain and export `GOOGLE_BOOKS_API_KEY`
      before bulk migration; consider storing in `app_config` via Settings
      instead of env.
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
        conflict resolution IPC (vitest; better-sqlite3 works in plain node)
- [ ] Persist cover `source`/`width`/`height` into metadata.json (sidecar
      returns them; `importer.writeMetadataJson` currently drops them —
      the iOS contract documents them)
- [ ] `render_pdf_cover` should log on `ImportError` (silent today — a
      missing/broken PDF rendering dependency degrades invisibly)
- [ ] Test: zero-page PDF (extraction/cover-render behavior on an empty doc)
- [ ] Fix stale "EPUB" wording in `hydration.py` docstring/comments now that
      PDF is a first-class hydration input too
- [ ] Regression test: mobi/azw3 fall-through in `transfer-queue.ts`'s Kindle
      format preference logic
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
- [ ] Import progress: `duplicate_check` step currently invisible in the
      overlay step list (works, just not rendered as its own row)
- [ ] **Open the stored book file from the app** (confirmed missing
      2026-07-17) — the renderer has no `onDoubleClick`/`onContextMenu`
      handlers and no IPC action opens a book file. Covered by the approved
      design (`docs/superpowers/specs/2026-07-14-pdf-multimachine-reader-design.md`,
      Section C): double-click / detail panel opens the native ReaderView
      (foliate-js for epub, pdf.js for PDF, `musaeum://book/{id}/{format}`).
      Builds after Section B. The "Enter to open" keyboard-nav item below
      should reuse the same action.
- [ ] Keyboard navigation: arrows to move selection in grid/list, Esc to
      close detail panel, Enter to open
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

## Packaging & distribution

- [ ] App icon (dark-library mark) → `assets/icons/`
- [ ] electron-builder config: DMG, hardened runtime, notarization; bundle
      `sidecar/` into Resources (sidecar.ts already resolves
      `process.resourcesPath` when packaged; venv strategy TBD — likely
      require system Python + first-run `pip install`, or ship a pex/zipapp)
- [ ] Decide update mechanism (spec question #5): manual download vs
      electron-updater — leaning manual for a personal tool
- [ ] `npm audit` — 6 high-severity findings in the dev-dependency chain to
      review (dev-only impact, but check before distributing)

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
