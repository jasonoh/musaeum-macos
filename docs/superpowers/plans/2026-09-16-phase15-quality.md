# Phase 1.5 — quality upgrade (fixes + tests)

**OUTCOME (2026-09-16, final): all four slices landed; wave 1 is committed, wave 2
is not.** Owner consent for the second wave is recorded in the session (the
clarify form, answer "All four, T4 first"), not out of band.

- **Committed (three per-slice commits):** `d3303bc` fixes F1–F5, `76f2ec1`
  coverage T1–T3, `ec1eaa4` eslint/worktree + docs.
- **Landed uncommitted:** T4 (conflict resolution extracted to
  `services/conflicts.ts`, handler now 4 insertions/67 deletions), T5/T6
  (device presence + `transfer-queue` tests, 16 cases), F6 (five stdout log
  sites moved to stderr), and the review repairs below.
- **Gate:** typecheck 0 / lint 0 / **`npm test` 593 passed, 27 files** /
  **pytest 65 passed**. Every decider in this file was reproduced by the
  orchestrator by mutating the source and watching the named case redden, then
  restoring from a *file backup* (never `git checkout -- <file>`, which reverts
  to HEAD and silently discards the fix — that error cost F4 once here).

**Read-only review pass (2026-09-16).** Verdict: no invariant broken, no contract
drift on `metadata:resolveConflict`, no pre-existing test weakened or skipped.
Four findings acted on:
1. **FIX-NOW — this file and `tasks.md` had gone false**: they described T4/F6/T5-T6
   as parked after the slices landed. Corrected here and in `tasks.md`.
2. **A filter click during a search spuriously reset the scroll.** The reviewer
   caught that `resultSetKey` counted filters unconditionally while
   `library.store.load():63-65` passes them to `getBooks` only when *browsing*
   (`searchBooks(query, sort)` takes none during a search) — so a facet click
   that changes no rows threw away the reader's place, against the hook's own
   docstring. Fixed in the key, and the three existing filter cases that had
   encoded the false premise (`BASE` has `query: 'dune'`) were rebuilt on a
   browsing base with a new search-state case.
3. **`book-delete.test.ts`'s size case could not catch "only fill a missing
   value"** — its fixture's stored value was `null`. Now seeded with a wrong
   value (`999_999`); measured, the `?? ` mutation that the old fixture would
   have *passed* now reddens it.
4. **The `node_modules` symlink a worktree creates is not gitignored**
   (`.gitignore`'s `node_modules/` matches directories, not the symlink), so a
   `git add -A` inside a worktree would stage an absolute-path symlink. Two
   agents flagged it independently; the slash-less form is now added.

**Named gaps this pass did NOT close** (recorded, not absorbed):
- **Three of the four `computeFileSizeBytes` call sites are unguarded**: only
  `deleteFormats` has a case; `add_format`, the Kindle conversion cache and the
  PDF top-up attach have none (`rg fileSizeBytes` across the suite returns one
  hit). The class is implemented once, so the risk is a site forgetting the
  call, not the maths.
- **`conflicts.test.ts` names a broadcast it never asserts**, and no case reads
  `metadata.json` back after a resolution; the cover/series/tags branches
  (`conflicts.ts:38-56`) are uncovered.
- **The renderer half of the cold-start presence fix** (`useDevice.ts`) stays
  untested: covering it needs a DOM environment and React testing devDeps, which
  is a `package.json` decision, not a test-file one.
- **EBADF on SMB `close()`** has no local analogue; the handling is pinned, the
  OS behaviour is not — only real hardware closes that.

Date: 2026-09-16. Owner-approved scope: **fixes + tests**. Two adjudications taken
before any code moved (recorded here rather than in conversation):

- **A1 — `books.file_size_bytes` is recomputed, not dropped.** Owner's call. Every
  write that changes a book's format set recomputes it from the book folder.
  *Rejected:* hiding it in the detail panel (leaves a lying row in the DB), or a
  migration dropping the column (the value is genuinely useful once honest).
- **A2 — cover `source`/`width`/`height` persistence is OUT of this pass.** The
  sidecar already returns them (`sidecar/pipeline/cover.py:79-81`);
  `importer.writeMetadataJson` drops them. Persisting them needs **new columns**
  (`books` has only `cover_thumb_path` / `cover_full_path`,
  `electron/main/schema/migrations/001_initial.sql:18-19`), so it is a migration +
  a `metadata.json` contract change + a `catalog.ts` read path — a contract slice,
  not a fix. Nothing consumes the fields today (the iOS client that documents them
  does not exist), so it stays a named gap.
- **A3 — the multi-PDF-per-Calibre-folder policy is OUT.** `topup._find_pdf`
  silently takes the first sorted match (`sidecar/pipeline/topup.py:83-89`); the
  fix needs a *policy* decision (warn / queue a conflict / document), which is a
  design call this pass is not for. Recorded, not absorbed.

## In scope — the defects

| # | Defect | Site | Decider |
|---|---|---|---|
| F1 | Narrowing the library (search/filter/sort) keeps the container's pixel `scrollTop`, so 7000 → 1072 can leave you parked near the new bottom | `src/components/library/GridView.tsx:47,66`, `ListView.tsx:235`, `src/hooks/useVirtualRows.ts:71-118` | live: scroll to the bottom of the full library, search to a small result set, read `container.scrollTop` — must be 0 |
| F2 | Ties (same author, same rating) fall back to SQLite's arbitrary order and shuffle between loads | `electron/main/services/db.ts:195-202` + `orderClause` at `:242-253` | `db.test.ts`: equal keys now come back in one fixed order, twice |
| F3 | `file_size_bytes` is an import-time snapshot, wrong after `deleteFormats` / "Add format to existing" | `book-delete.ts:29-66`, `importer.ts:447` (+ the attach path at `migration.ts:250`, which already sums) | unit: a two-format book loses one → the stored size equals the surviving file's size |
| F4 | `render_pdf_cover` swallows every failure silently (`except Exception: return None`) — a broken pdfium degrades invisibly | `sidecar/extractors/pdf_metadata.py:29-50` | pytest: a render failure logs a reason and still returns `None` |
| F5 | `hydration.py`'s docstring/comments still say EPUB-only now that PDF is a first-class hydration input | `sidecar/pipeline/hydration.py:4, 91, 97` | read: no EPUB-only claim left |

**F1 must not regress the anchor.** `useAnchoredScroll` deliberately holds the
reader's place across a *geometry* change — measured: at 1206px the viewport showed
books 105–125; after opening the panel, deleting the book and letting it close, the
identical offset showed 148–168 (`useVirtualRows.ts:74-86`). So the reset keys on the
**result-set identity** (query, filters, sort) and never on a book-list mutation
(edit, delete, re-fetch). `useBookNavigation`'s ensure-visible pass runs after the
anchor hook and must keep composing.

## In scope — the missing tests

| # | Boundary | Why it is the risky one |
|---|---|---|
| T1 | sidecar `pipeline/conflict.py` merge policy | decides which fetched value overwrites which embedded one; no test file exists |
| T2 | sidecar `extractors/epub_metadata.py` vs fixture EPUBs | the other first-class input; fixtures must be built in-code (no binaries checked in) |
| T3 | main `importer.sanitizeTitle`, the duplicate GATE (`resolveDuplicate` / `abortPendingDecisions` / skip·add_new·add_format) | decides on-disk filenames and whether a second copy becomes a book; untested |
| T4 | main conflict resolution (`metadata:resolveConflict` path) | renames files and rewrites `metadata.json`; untested |
| T5 | main device presence (`getOnDeviceBookIds` matching, the `setsEqual` self-heal re-broadcast, cold-start recompute on `libraryChanged`) | only `scanDocuments` / `removeFilesWithStem` are covered |
| T6 | main `transfer-queue.ts` format preference + the size-verification path | no tests at all; the 2026-08-11 EBADF fix was validated by hand |

Each new test must come with a **decider the author reports and the orchestrator
reproduces by hand**: mutate the source, the named case reddens, restore the file
byte-identical. A case that cannot be reddened is not coverage.

- **Workflow trap found while dispatching the second wave (2026-09-16):**
  `claude -w <name>` bases its worktree on **`origin/main`, not local HEAD**. With
  the three commits of this pass unpushed, all three slices were dispatched into
  trees at `f41a51a` — `computeFileSizeBytes` and
  `useResetScrollOnResultChange` measurably absent. T4/F6 are disjoint from the
  pass's files so they land cleanly; T5/T6 read `transfer-queue.ts` and F6 was
  told `pdf_metadata.py`'s stderr convention "just changed", so both must be
  reconciled at landing rather than trusted. Check
  `git -C .claude/worktrees/<n> rev-parse --short HEAD` right after a dispatch.

## Findings recorded while executing (2026-09-16)

- **F6 — misrouted log lines in the sidecar (new; found by Q1-C's audit).**
  `topup.py:165,175,191` and `migrate.py:73,200` `print(..., flush=True)` with no
  `file=sys.stderr`, i.e. to **stdout**, which in that process carries JSON-RPC
  frames (`sidecar/main.py:30-33`). Q1-C escalated this as protocol corruption.
  **Measured false:** `electron/main/services/sidecar.ts:160-165` try/catches the
  parse and logs the stray line as `[sidecar] unparseable message: …`. So the
  effect is that a migration's "ambiguous match for X, skipped" line arrives with a
  misleading prefix and never reaches a report — observability, not corruption.
  Folded into this pass as a one-convention fix (route those five sites to stderr,
  matching F4's).
- **T4 restated — `metadata:resolveConflict` is not testable because it is not in
  the service layer.** The whole ~50-line resolution body sits in the handler:
  `electron/main/ipc/metadata.ts:27-79` (field mapping, the cover branch calling the
  sidecar, the title rename at `:73`, the metadata.json + catalog writes). That is
  invariant 8 ("business logic lives in `services/`; IPC handlers are thin
  wrappers") and it is why the path has never had a test — there is no function to
  call. So T4 is a two-part slice: extract to a service, leave the handler a thin
  wrapper through `handle()`, *then* cover it. The extraction is what the invariant
  asks for, so it protects the list rather than bending it.
- **Baseline corrections (both stale in `tasks.md`):** the sidecar suite is **18**
  tests, not 14 (19 after Q1-C); `sidecar/pipeline/hydration.py:97` is the real
  `.epub` branch, not a comment — only lines 4 and 91 carried the EPUB-only prose.

## Out of scope (named, not silently dropped)

- A2, A3 above.
- The dev-only row-height drift assertion (`tasks.md` — the uniform-height invariant).
- `exports/` staging dir, sortable "Formats", `BookDetail` offline controls, catalog
  upsert coalescing — all pre-existing backlog, none touched by this pass.

## Dispatch map

| Slice | Agent | Worktree | Files |
|---|---|---|---|
| Q1-A | `renderer-engineer` | `q1-scroll` | `src/hooks/useVirtualRows.ts`, `GridView.tsx`, `ListView.tsx` |
| Q1-B | `main-engineer` | `q1-main` | `db.ts`, `book-delete.ts`, `importer.ts`, `db.test.ts` |
| Q1-C | `sidecar-engineer` | `q1-sidecar` | `extractors/pdf_metadata.py`, `pipeline/hydration.py` |
| Q2-D | `test-author` | `q2-sidecar-tests` | `sidecar/tests/**` |
| Q2-E | `test-author` | `q2-importer-tests` | `importer.test.ts`, conflict-resolution test |
| Q2-F | `test-author` | `q2-device-tests` | `device-manager.test.ts`, `transfer-queue.test.ts` |

Invariant docs each dispatch must carry: Q1-A `library-views.md`,
`selection-and-keyboard.md`; Q1-B `library-views.md`, `files-and-deletion.md`,
`metadata-hydration.md`; Q1-C `metadata-hydration.md`; Q2-D
`metadata-hydration.md`, `conflicts-and-series.md`; Q2-E `files-and-deletion.md`,
`conflicts-and-series.md`; Q2-F `device-transfer.md`, `files-and-deletion.md`.

## Gate

Per slice: `npm run typecheck` 0 / `npm run lint` 0 / `npm test` green (baseline
**513 passed / 23 files** at `f41a51a`), sidecar `pytest` green. F1 additionally
needs the live measurement. Nothing is landed until the orchestrator has reproduced
each decider and a read-only `reviewer` pass has run against the invariants list.
