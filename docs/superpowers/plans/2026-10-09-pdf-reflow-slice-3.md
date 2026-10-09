# PDF Reflow Slice 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PDF-only book opens in Musaeum's own reader. The reader asks the app for a reflow, shows the pass's progress while the sidecar produces `{book}/derived/reflow.epub`, serves it over `musaeum://book/{id}/reflow` to the engine it already has, and — for a book the pass refuses — hands the book to the OS with one line saying why (D1, D6, D7, D10, AC4, AC6).

**Architecture:** Three layers, added in the order they can be tested. `services/reflow.ts` (new) is the app's one door to slice 2's `reflow_pdf` RPC: it resolves the book's PDF through `book-bytes`'s existing by-extension rule, calls the sidecar with the pass's own (long) deadline, re-broadcasts the `reflow_progress` frames as the app's `reflowProgress` event, de-duplicates concurrent opens of one book, and retries the one verdict a retry can fix. `book-bytes.ts` gains `resolveReflowFile(bookId)` — a _second path shape over the same containment rule_, deliberately not a member of `FORMATS` — because that function's second consumer is the HTTP surface and the wire is slice 4's (D8). `ipc/reader.ts` and the preload surface add one method and one event. In the renderer, `book.types.ts` grows the rule (`readerTarget`), `reader.store.ts`'s `openBook` sends a PDF-only book to `format: 'reflow'` and `beginReflow` lands the outcome, `ReaderView.tsx` shows the pass and subscribes to its frames, and `ReaderEngine.tsx`'s `format` widens to carry `'reflow'` — the artifact is a zip whose _content_ the engine sniffs, so it opens as the EPUB it is.

**Tech Stack:** TypeScript (strict) / Electron 44 / React 18 / Zustand 5 / vitest 3.2.7 under Electron-as-Node. The pass itself is slice 2's (`sidecar/reflow/produce.py`, Python 3.12) and is **not touched** — this slice adds a caller, not a converter.

**Spec:** `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` — slice 3's row, then **D1, D3, D5, D6, D7, D8, D9, D10** and **open question 5** (the boundary, approved 2026-10-07). Slice 2's record is `docs/superpowers/plans/2026-10-08-pdf-reflow-slice-2.md`, whose _What slice 3 will need_ is the RPC's contract; `docs/data-contracts.md`'s `reflow_pdf` block is the same contract from the other side.

**Working directory for every command:** this clone's root, on branch `feat/pdf-reflow-slice-3`, branched from `main` at `2a88feb`. No venv change, no new dependency in either language. The library at `/Volumes/books/musaeum` is **read-only** — the app reads it, and this slice writes nothing to it but `{book}/derived/`, which the pass owns (slice 2, AC2).

---

## Resume here (2026-10-09)

**All six tasks landed 2026-10-09** on `feat/pdf-reflow-slice-3` (Tasks 0–5 as `f15d585`, `cf62a2e`, `e02430a`, `5bf8a6b`, `1d73378`, `cc01ae7`, with `65d3c90` and `fd5e037` landing between Task 4 and Task 5's commit — the route's missing applier, and a test case the mutation campaign found could not discriminate — plus the docs-only commit after it that names them); the full record with the live-pass numbers is `tasks.md`'s C2 entry. **One file beyond this plan's own table: `electron/main/index.ts`** — the protocol handler is the caller `resolveReflowFile` never had, and without it `musaeum://book/{id}/reflow` answered **404** and every PDF-only book opened the reader and said _"This book's file could not be read."_ (measured in the running app; Task 1's table named the route but not its applier). The gates: `npm test` **1919 passed across 88 files** (1887 + 32: 6 Task 1, 14 Task 2, 4 + 8 Task 4), typecheck and eslint clean, and `pytest` **388 passed / 129 reflow — unchanged**, which is this slice's own proof that it added a caller and not a converter. Measured on this clone at 09:10, before the plan was written:

| Gate      | Command                                                   | Today                                 |
| --------- | --------------------------------------------------------- | ------------------------------------- |
| typecheck | `npm run typecheck`                                       | passes (main + renderer)              |
| lint      | `npx eslint . --max-warnings=0 --ignore-pattern '.delta'` | exits 0                               |
| tests     | `npm test`                                                | **87 files, 1887 tests, all passing** |
| bundle    | `npm run build && npx electron-builder --dir`             | `dist/mac-arm64/Musaeum.app` produced |

**`npm run lint` itself fails in this clone, and the failure is not the repo's.** ESLint walks `.delta/worktrees/*/musaeum-macos/` — worktrees another session's agent left inside the repo — and dies with `Parsing error: No tsconfigRootDir was set, and multiple candidate TSConfigRootDirs are present` (6475 errors, every one of that shape). `eslint.config.mjs:14`'s `ignores` list names `out/`, `dist/`, `node_modules/`, `sidecar/`, `vendor/**`, `.claude/` and `.obsidian/`, and not `.delta/`. **Do not delete `.delta/`** — it is another session's in-flight work, the same rule the skill gives for untracked `.claude/` files and hooks. The slice's own gate line is the `--ignore-pattern '.delta'` form above; the record says which form it ran.

**The helper is built** (`helpers/bin/musaeum-layout`, 149,040 bytes, 2026-10-09 07:53, gitignored) so `sidecar/.venv/bin/python -m pytest sidecar/tests -k reflow -q` is 129 passed; `./scripts/build-layout-helper.sh` re-makes it where it is not.

Every code block in this plan is complete. Lines marked _measured_ were taken on this machine on 2026-10-09 before the plan was written; the commands behind them are in _What was measured first_ below, so any of them can be re-taken.

## Global Constraints

- **No new dependency, in either language.** `package.json` and `sidecar/requirements.txt` are unchanged. The whole slice is TypeScript over services that already exist.
- **Nothing in the artifact's content moves.** `sidecar/reflow/*` is not touched: the pass, its gate and its stamp are slice 2's, verbatim. So `scripts/pdf-reflow-probe.py --production` must still read `gate: 4/6` with the same per-book lines, and that is a **must-not-move** criterion rather than a gate to re-take.
- **`metadata.json` and `formats` are never written by this slice** (AC2, D3). A reflow is a rendering cache, not a format: no book's `formats` gains `epub` because an artifact exists, no `metadata.json` gains a member, and the `derived/` folder stays invisible to every extension-keyed rule (`docs/invariants/files-and-deletion.md`).
- **The wire stays closed until slice 4.** `resolveBookFile`'s allowlist, `services/api/shape.ts`, `api/rest.ts`, the payload goldens and `docs/rest-api.md` are untouched: `GET /api/books/{id}/file?format=reflow` answers 404 when this slice lands, and slice 4 is what opens it — with the document first (D8, iOS invariant 1).
- **`vendor/foliate-js/` is never edited** (invariant 11, held by `test/invariants.test.ts`). Everything the reflow needs from the engine is behaviour it already has.
- **A fallback is not an error** (invariant 12, D6): a book the pass refuses leaves no artifact, opens the original, and shows one line. Nothing in this slice throws across the IPC boundary, and nothing it does can block an import, a hydration or a quit.
- **The reader's own rules are not bent for this book.** Same `ReaderEngine`, same `musaeum://` route, same panels, same typography and theme resolution, same `reading_state` schema — and the reflowed EPUB is the position of record (D5, D10). If any part of the reader has to learn about PDFs, the design has gone wrong.
- **Markdown prose is not hard-wrapped** (`CLAUDE.md`, _Markdown_): one line per paragraph in every `.md` edit, this plan included.
- **Budget:** **10 code files** — `services/reflow.ts` (new), `book-bytes.ts`, `ipc/reader.ts`, `preload/index.ts`, `types/api.types.ts`, `types/book.types.ts`, `stores/reader.store.ts`, `components/reader/ReaderView.tsx`, `components/reader/ReaderEngine.tsx`, `components/library/BookDetail.tsx` — plus their test files and four documents (`tasks.md`, `CHANGELOG.md`, `docs/data-contracts.md`, `docs/invariants/reader.md`). **The spec's slice row says ≈8 and is short by two**, and the skill's own rule is that a row counts the files the spec imagined, short by the appliers and consumers of anything new: `ReaderEngine.tsx` (the `format` union has to carry `'reflow'`; the engine is otherwise untouched) and `BookDetail.tsx` (one tooltip that would otherwise advertise "Open in the default app" for a book the reader now opens). `electron-builder.yml`'s `helpers/` entry is the opening move and is packaging rather than one of the ten. The boundary itself was **approved by the owner 2026-10-07** (open question 5) — the count against the row is a finding to state, not an escalation.
- **Escalate — stop and hand back — if:** a check fails twice; a book that passed Annex C.7 run 2 fails the production probe after this slice's changes (the pass is not touched, so that would mean something reached into it); or the live pass shows a book opening the **original** for a reason the pipeline did not actually give.

## Review Focus

1. **The artifact is never mistaken for a format.** The reflow is served by a route of its own, `resolveBookFile`'s accepted formats do not change, and AC2 holds: a pass over a PDF-only book leaves `formats` and `file_size_bytes` byte-identical. Pinned in Task 1 (`book-bytes.test.ts`: `resolveBookFile(id, 'reflow')` is null _while the artifact exists_).
2. **A book the pass refuses still opens.** D6/AC4: no artifact, the original path, one line of reason — and the line is the pipeline's own sentence, never a re-worded one. Pinned in Task 2 (`reflow.test.ts`: a fallback comes back verbatim) and Task 4 (`reader.store.test.ts`: the terminal fallback closes the reader, hands the book to the OS and notifies with that sentence).
3. **Progress is visible and cannot freeze.** AC6/D7: frames arrive on an event and land in the store, not in the promise's own closure; and a book opened twice joins the pass in flight instead of starting another. Pinned in Task 2 (two concurrent `ensure` calls → one RPC), Task 3 (the `MusaeumAPI` shape is a compile-time decider) and Task 4 (`setReflow`'s identity guard and its other-book guard).
4. **The pass is not abandoned by a timeout sized for a hydration.** `services/sidecar.ts`'s 120 s default would answer a working 535-page pass as a failure while the artifact landed anyway — the worst shape this slice could ship, because the next open would find the cache and the reader would have said otherwise. Pinned in Task 2 (the timeout on the call is asserted, and it exceeds the default).
5. **Nothing outside the reader path changes.** No `metadata.json`, no `formats`, no SQLite, no REST payload, no `vendor/`, and no reader-shell file beyond the five named. Pinned in Task 5 by `git diff --stat` and by the sidecar suite's unchanged count.

---

## The readings this slice settles (its own D-series)

The parent spec closed every product decision; these are readings it left open, each with the alternative it beat and the condition that would reverse it. They are numbered `R` so nothing here can be confused with the spec's `D`-series.

**R1 — The artifact gets its own route, not an arm in `resolveBookFile`.** `resolveBookFile`'s two consumers are `musaeum://book/…` and `GET /api/books/{id}/file` — and `electron/main/api/rest.ts:984` passes the caller's `format` straight through with no union check of its own. A `reflow` arm there would therefore open the HTTP route in the same commit that no document describes, which is the order D8 forbids ("the contract lands in this repo first", iOS invariant 1). So the artifact is served by `resolveReflowFile(bookId)`, used by the renderer's handler alone, and the containment rule is **shared rather than copied**: `resolveBookFile`'s realpath-both-sides rule moves into a helper both call, and the existing `book-bytes.test.ts` cases must pass unchanged — they are this extraction's corpus sweep, exactly as a _tightening_ while extracting is answered by a sweep rather than by the fixture that was already green. **Alternative beaten:** `'reflow'` in `FORMATS` — fewer lines, and it opens the wire early and silently. **Reversal:** slice 4 lands, `docs/rest-api.md` names the route, and the two shapes can be merged into one function then.

**R2 — The reader's format widens to `ReaderFormat = BookFormat | 'reflow'`.** The spec calls the route `musaeum://book/{id}/reflow`, so `'reflow'` is the string that travels; `ReaderEngine` builds both the URL and the `File` name from it, and `new File([blob], 'book.reflow')` is safe — read at `vendor/foliate-js/view.js`: `isZip` decides by the first four bytes (`:8-11`), `isCBZ`/`isFBZ` are the only name reads (`:20-28`), and every other zip takes the EPUB branch (`:101-104`). The mechanism is the _opposite_ of the PDF case, where `isPDF` reads the magic and its import is externalised (`electron.vite.config.ts:51`), which is why the reader must never be handed `format: 'pdf'` (`docs/invariants/reader.md`, _Reading in the app_). **Alternative beaten:** a second `source` field beside `format` — two fields for one meaning, and `ReaderView`'s "Open externally" would then have to choose between them. **Reversal:** upstream ever branches on an extension we would have to match, or a `BookFormat` member gains a meaning `'reflow'` would collide with.

**R3 — A refused book is handed to the OS, and the reason rides the toast surface.** D6 says "no artifact, **the original path**, one line of reason", and today's path for a PDF-only book is `files.openBookFile(book.id, 'pdf')` → Preview. So on a `fallback` the reader closes, opens the original, and `useUIStore.notify` carries the pipeline's own sentence as the toast's `detail`. The reader's progress surface is where the _pass_ is shown; a refusal is not a panel but a hand-off. **Alternative beaten:** keep the overlay showing the reason with an "Open externally" button (the shape the reader's error state already has) — more visible, and it strands the book behind an extra click, which is the opposite of "the original path". **Reversal:** the owner reads it in the app and dislikes the hand-off; the change is one branch in the store, and the alternative's shape is already in `ReaderView`.

**R4 — One automatic retry, and only for `unstable_layout`.** Slice 2 measured the helper refusing a book it had laid out minutes earlier — "three of the six full runs each failed one book on a refusal … and every retry healed it" — and left "a reader-side retry is slice 3's call". So a `fallback` whose `verdict` is `unstable_layout` is asked once more, and nothing else is: `no_text_layer` (the ~10% of PDF-only books with no text at all), `unreadable`, `no_layout` and `write_failed` are deterministic verdicts about the book or the machine, and retrying them spends minutes to arrive at the same sentence. The retry is _announced_ (`reflowProgress` with `phase: 'retrying'`) so a bar that restarts has said why rather than looking stuck. **Alternative beaten:** no retry at all (a book that would have read stays in Preview for good, since a pass is never run twice by itself), or a retry on every fallback (it doubles the worst case for the population D6 exists for). **Reversal:** a corpus run shows `unstable_layout` is not the verdict a refusal actually carries.

**R5 — The progress subscription lives in `ReaderView`; the trigger lives in the store.** `CLAUDE.md` says main-process events are wired into stores once, "in the `src/hooks/use*.ts` hooks mounted by `App.tsx`" — and `App.tsx:80` renders `<ReaderView />` **unconditionally**, so an effect in `ReaderView` whose only dependency is the store's stable action is one subscription for the process's life, which is the property that convention exists to protect (`src/hooks/useAi.ts` documents the same reasoning for the ask stream). A new `src/hooks/useReflow.ts` plus an `App.tsx` import and mount line would be two more files and no more safety. The _trigger_ goes in the store's `openBook` for the same reason the store already calls `window.Musaeum.files.openBookFile` there (`reader.store.ts:321`): the decision and the door are one function, and the store is the only place the whole decision is written down. **Alternative beaten:** the `useReflow` hook + `App.tsx` edit — the letter of the convention, two files dearer. **Reversal:** a second component ever needs the frames, or `ReaderView` stops being unconditional in `App.tsx`.

**R6 — The reader asks for a reflow only for a book it cannot otherwise render.** `readerTarget` returns `{kind: 'reflow'}` for `readableFormat(book) === null && book.formats.includes('pdf')` — a PDF-only book, which is what the design's slice row and `tasks.md` both say this slice's readability rule is about ("the readability rule that lets a **PDF-only book** with a reflow open in-app").

- **What it is not.** The spec's D1 settles the _feature's_ trigger as "holds a PDF and no EPUB" (1,534 books), which is deliberately wider than the Mac's own rule. This reading does not re-open that decision — it fixes **when the Mac's reader spends a pass**, and asks only for a book the reader has no other way to show a person.
- **Why the wider rule is wrong _here_, with the residual named.** The 45 books inside D1's set that also hold a `mobi` or `azw3` are the paper shelf, where the Mac's engine reads the `mobi` perfectly well today. Spending a pass on one costs little — measured, slice 2's two corpus papers pass in ~3 s each — but the _failure_ is not symmetric: a textless or unreadable book that also holds a `mobi` (the corpus's _Molecular Cell Biology_ is one shape of it) would forfeit a view the Mac can render for **Preview**, which is a worse product than the one that shipped. The narrow rule has no such branch: the only books it reflows are the ones with nothing to fall back to but the OS, where Preview is what happened yesterday anyway.
- **Named residual, for slice 4.** Under this reading the 45 `mobi`+`pdf` books get no artifact from the Mac at all, so the phone's shelf — the population D1 argues the reflow exists for — is not closed by this slice. Whatever closes it (a "prepare for phone" action, a shelf-scoped job, or a pass triggered by the phone's own request) is slice 4's, and D8's `reflow.available` is the member it will hang on.
- **Alternative beaten:** D1's wider trigger applied to the Mac's reader as well. **Reversal:** the owner says a paper he reads on the Mac should default to the reflow too — then this is one predicate, and Task 4's rule is where it changes.

## File Structure

| File                                          | Responsibility                                                                                                                                                                | Task |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `electron-builder.yml`                        | the reflow helper's `extraResources` entry (`from: helpers/bin`, `to: helpers/bin`)                                                                                           | 0    |
| `electron/main/services/book-bytes.ts`        | the shared containment rule, extracted; `resolveReflowFile(bookId)` — the artifact's one route, outside `FORMATS`                                                             | 1    |
| `electron/main/services/book-bytes.test.ts`   | the artifact's path rules, and the route that must stay shut                                                                                                                  | 1    |
| `src/types/book.types.ts`                     | `ReflowResult`, `ReflowProgress` (the RPC's two shapes, in the app's spelling)                                                                                                | 2    |
| `src/types/api.types.ts`                      | `EVENT_CHANNELS.reflowProgress` (2); the `MusaeumAPI` members it names (3)                                                                                                    | 2, 3 |
| `electron/main/services/reflow.ts` (new)      | the app's door to `reflow_pdf`: by-extension source resolution, the pass's own deadline, the in-flight map, the `unstable_layout` retry, `reflow_progress` → `reflowProgress` | 2    |
| `electron/main/services/reflow.test.ts` (new) | those rules, against a mocked `./sidecar`                                                                                                                                     | 2    |
| `electron/main/ipc/reader.ts`                 | `reader:reflow`                                                                                                                                                               | 3    |
| `electron/preload/index.ts`                   | `reader.reflow`, `on.reflowProgress`                                                                                                                                          | 3    |
| `src/types/book.types.ts`                     | `ReaderFormat`, `readerTarget(book)` — the readability rule                                                                                                                   | 4    |
| `src/stores/reader.store.ts`                  | `openBook`'s decision, `beginReflow`, `setReflow`, `reflow` state                                                                                                             | 4    |
| `src/stores/reader.store.test.ts`             | the rule and the four outcomes                                                                                                                                                | 4    |
| `src/components/reader/ReaderView.tsx`        | the progress surface, the frame subscription, the engine's gate, `'reflow'` in the external-open path                                                                         | 4    |
| `src/components/reader/ReaderEngine.tsx`      | `format: ReaderFormat` — the union widens and nothing else moves                                                                                                              | 4    |
| `src/components/library/BookDetail.tsx`       | one tooltip that would otherwise lie                                                                                                                                          | 4    |
| `tasks.md`                                    | C2's status line: what slice 3 landed, what slice 4 is next                                                                                                                   | 5    |
| `CHANGELOG.md`                                | the user-facing entry                                                                                                                                                         | 5    |
| `docs/data-contracts.md`                      | the one-clause correction: the reader now calls `reflow_pdf`                                                                                                                  | 5    |
| `docs/invariants/reader.md`                   | the one sentence that this slice makes false                                                                                                                                  | 5    |

`src/types/book.types.test.ts` gains `readerTarget`'s cases in Task 4 rather than a file of its own — it exists and already owns the format-preference functions. `docs/invariants/reader.md` is slice 5's to rewrite (spec's slice table); Task 5 touches only the sentence that is now **false**, and says so.

Run the two suites at any point with:

```bash
npm test                                     # 87 files, 1887 tests before Task 1
sidecar/.venv/bin/python -m pytest sidecar/tests -q     # 388 passed (129 reflow) when slice 2 landed
npx eslint . --max-warnings=0 --ignore-pattern '.delta'
```

---

## What was measured first (2026-10-09, before Task 1)

1. **The packaged bundle holds the sidecar and no `helpers/`.** `ls dist/mac-arm64/Musaeum.app/Contents/Resources/` lists `sidecar/` and the `.lproj` folders and **no `helpers/`**, while `sidecar/reflow/vision.py` is in the bundle — so `find_helper()`'s `Path(__file__).resolve().parents[2] / "helpers" / "bin" / "musaeum-layout"` (`sidecar/reflow/vision.py:67-72`) resolves to `Contents/Resources/helpers/bin/musaeum-layout`, which does not exist. That is the whole of Task 0, and `docs/invariants/packaging-and-python.md:29` already records why a wrong `to:` is silent.
2. **`npm run lint` is red in this clone for a reason this slice did not cause**, and the workaround is exact: `npx eslint . --max-warnings=0 --ignore-pattern '.delta'` exits 0. See _Resume here_.
3. **The engine decides a zip by content, not by name.** `vendor/foliate-js/view.js:8-28` and `:79-123`: `isZip` reads the first four bytes; `isCBZ`/`isFBZ` are the only name reads; everything else that is a zip becomes an `EPUB`. This is what makes R2 safe. And the PDF branch is the opposite case — `isPDF` reads the magic and `./pdf.js` is `external` (`electron.vite.config.ts:51`) — so `format: 'pdf'` must never reach the reader.
4. **The sidecar's call deadline is 120 s by default** (`services/sidecar.ts:25`), and a real pass is longer: _Universe_ (535 pages) measured **176 s** through the production path on 2026-10-08, against 0.5–1.3 s per page for the helper alone. A reflow call that took the default would abandon a working pass — and because a timeout only drops the _pending call_ (`sidecar.ts:198-201`), the pass would go on, write its artifact, and the reader would have been told it failed.
5. **`reflow_pdf` is already documented as "the pipeline is in place, the reader does not call it until slice 3"** (`docs/data-contracts.md:233`) — the sentence this slice makes false, and Task 5's one-clause correction.
6. **`openBook`'s OS hand-off is one branch and it is about to narrow.** `reader.store.ts:315-323` hands a book with no readable format to `files.openBookFile(book.id, primaryFormat(book))`; after Task 4 the only books that reach it have no formats at all, which is why the branch stays and its comment changes rather than disappearing.
7. **Four entry points call `openBook`, and all four already do the right thing.** `BookCard.tsx:123` and `ListView.tsx:70` (double-click), `BookContextMenu.tsx:167` (Read), `BookDetail.tsx:327` (Read). None is gated on the NAS being online — reading is not a write (`docs/invariants/reader.md`, _Reading in the app_) — so no entry point changes in this slice.
8. **`reader.store` has no store-level importers.** `grep -rn "stores/reader.store" src/stores/` finds only the store's own test, so `reader.store` → `ui.store` → `library.store` (Task 4's `notify`) is a one-way chain and introduces no cycle.

---

### Task 0: The helper ships in the bundle

**Files:**

- Modify: `electron-builder.yml`

**Interfaces:**

- Consumes: nothing.
- Produces: `Musaeum.app/Contents/Resources/helpers/bin/musaeum-layout`, which is the path `sidecar/reflow/vision.py`'s `find_helper()` resolves in a packaged app.

- [ ] **Step 1: Add the `extraResources` entry**

In `electron-builder.yml`, after the existing `extraResources` block's last filter line (`'!requirements-dev.txt'`), add:

```yaml
# The reflow's page-layout helper (spec D4R, Annex C.5). It is a compiled Swift
# binary rather than Python source, so it travels as an entry of its own — and
# `to:` is `helpers/bin`, not `helpers`, because that is the path
# `find_helper()` resolves: `sidecar/reflow/vision.py`'s
# `parents[2] / "helpers" / "bin"` is `Contents/Resources/helpers/bin` in a
# packaged app (measured 2026-10-09: `Contents/Resources/sidecar/` is there and
# `helpers/` is not). A wrong `to:` is silent — every book answers `no_layout`
# and nothing in the code is wrong. Built by `scripts/build-layout-helper.sh`
# (Xcode toolchain); gitignored, so a build from a fresh clone fails here until
# it is run. 149 KB against AC9's ≤ 1 MB.
- from: helpers/bin
  to: helpers/bin
```

- [ ] **Step 2: Prove the helper lands where the sidecar looks**

```bash
./scripts/build-layout-helper.sh
npm run build && npx electron-builder --dir
test -x "dist/mac-arm64/Musaeum.app/Contents/Resources/helpers/bin/musaeum-layout" && echo HELPER-BUNDLED
```

Expected: the script's `built …/musaeum-layout` line, then `HELPER-BUNDLED`.

The other half — that the _sidecar_ finds it **from that path** — is the Python side's to decide, and no vitest case can see a bundle. Run it against a copy of the packaged layout rather than inside the app:

```bash
sidecar/.venv/bin/python - <<'PY'
import os, shutil, sys, tempfile
from pathlib import Path

root = Path(tempfile.mkdtemp()) / "Resources"
# The packaged layout: Resources/{sidecar,helpers}, sidecar as source.
shutil.copytree("sidecar", root / "sidecar", ignore=shutil.ignore_patterns(".venv", "__pycache__", "tests"))
(root / "helpers" / "bin").mkdir(parents=True)
shutil.copy2("helpers/bin/musaeum-layout", root / "helpers" / "bin" / "musaeum-layout")

os.environ.pop("MUSAEUM_LAYOUT_HELPER", None)
sys.path.insert(0, str(root))
from sidecar.reflow.vision import find_helper
found = find_helper()
print("find_helper() ->", found)
assert found and Path(found).is_file(), "the sidecar cannot find the helper at the packaged path"
print("OK")
PY
```

Expected: `find_helper() -> …/Resources/helpers/bin/musaeum-layout`, then `OK`, with no `AssertionError`. This is the invariant's own rule (`docs/invariants/packaging-and-python.md:29`) turned into a command, and it is a _file-layout_ check on purpose: what it decides is the path, which is exactly what a wrong `to:` breaks.

```bash
git add electron-builder.yml
git commit -m "build: the reflow's layout helper ships in the bundle

electron-builder.yml had no helpers/ entry, so a packaged build answered
no_layout for every PDF-only book with no code defect to find: the helper is a
compiled Swift binary rather than Python source, so it needs an entry of its
own. to: helpers/bin is the path sidecar/reflow/vision.py's find_helper()
resolves in a packaged app (measured: Contents/Resources holds sidecar/ and no
helpers/). 149 KB against AC9's 1 MB.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 1: The artifact's route

**Files:**

- Modify: `electron/main/services/book-bytes.ts`
- Modify: `electron/main/services/book-bytes.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `resolveReflowFile(bookId: string): Promise<string | null>` — `{book}/derived/reflow.epub` when it exists inside the library root, else `null`.
  - The module's two path halves as constants (`DERIVED`, `REFLOW_NAME`), so Task 5's record and any later reader names the artifact once.

- [ ] **Step 1: Extract the containment rule**

`resolveBookFile` does four things: gate the format, resolve the book's folder, find a file by extension, and prove both ends of the path resolve inside the library root. `resolveReflowFile` needs the first, second and fourth verbatim and a different third — so the shared three move into helpers rather than being copied, because the module's own docstring forbids the copy ("A second resolver written beside this one would be a second place to get the realpath rule wrong, and the wrong copy would be the network-facing one").

Replace `resolveBookFile`'s body from its `const root = nas.getLibraryRoot()` line to the end of the function with:

```ts
export async function resolveBookFile(bookId: string, format: string): Promise<string | null> {
  if (!FORMATS.has(format)) return null

  const dir = await bookFolder(bookId)
  if (!dir) return null

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }

  // By extension, not by canonical name — same rule as file-access and
  // deleteFormats, so a book renamed after import still opens
  const match = entries.find((f) => extname(f).toLowerCase() === `.${format}`)
  if (!match) return null

  return contained(join(dir, match))
}
```

and add, just above it:

```ts
/**
 * The book's folder, when the library holds one for it — or null.
 *
 * The lexical check is `nasPath`'s own defence: the path comes from a catalog
 * any machine can write, so a traversing entry must not turn a renderer URL into
 * arbitrary filesystem read access. The realpath half is in `contained`: a
 * symlink passes the lexical test.
 */
async function bookFolder(bookId: string): Promise<string | null> {
  const root = nas.getLibraryRoot()
  const book = db.getBook(bookId)
  if (!root || !book?.nasPath) return null
  const dir = resolve(root, book.nasPath)
  const rel = relative(resolve(root), dir)
  if (rel.startsWith('..') || rel === '') return null
  return dir
}

/**
 * `candidate` inside the library root — realpath'd on **both** sides, or null.
 *
 * Resolving only the candidate 404s every legitimate book: macOS makes the
 * library root's own ancestry a symlink (`/tmp` → `/private/tmp`), which is
 * where every test's library lives. The *value* returned is the caller's own
 * path and not the realpath, so the name in the response is the one the URL
 * asked for; the check is the comparison, not the value.
 */
async function contained(candidate: string): Promise<string | null> {
  const root = nas.getLibraryRoot()
  if (!root) return null
  try {
    const realRoot = await fs.realpath(root)
    const realCandidate = await fs.realpath(candidate)
    const rel = relative(realRoot, realCandidate)
    return rel.startsWith('..') || rel === '' ? null : candidate
  } catch {
    return null
  }
}
```

`resolveCoverFile` is deliberately left alone: it carries its own 400/404 split with a comment explaining why one `null` cannot, and this slice has no reason to touch it.

- [ ] **Step 2: The artifact's route**

Insert between `resolveBookFile` and the `// Covers —` separator block:

```ts
// ---------------------------------------------------------------------------
// The reflow — a derived rendering, on a route of its own (D3, D8)
// ---------------------------------------------------------------------------

const DERIVED = 'derived'
const REFLOW_NAME = 'reflow.epub'

/**
 * The file behind `musaeum://book/{bookId}/reflow` — `{book}/derived/reflow.epub`.
 *
 * **Deliberately not a member of `FORMATS`, and deliberately not reachable
 * through `resolveBookFile`.** That function's second consumer is the HTTP
 * surface (`api/rest.ts` passes the caller's `format` straight through), so a
 * `reflow` arm there would open `GET /api/books/{id}/file?format=reflow` in the
 * same commit that no document describes — and D8 puts the contract first, in
 * this repo, in slice 4. This route is therefore the renderer's alone, and the
 * wire stays closed until slice 4 opens it on purpose.
 *
 * A *fixed* name rather than an extension scan, for the mirror-image reason:
 * `derived/` is not a format (D3, `docs/invariants/files-and-deletion.md`), so
 * there is no "which file is the book's" question here — the artifact's name is
 * the sidecar's (`reflow/produce.py`'s `EPUB_NAME`), and this is its second
 * declaration. A scan would also happily serve a stray file the pipeline never
 * wrote.
 */
export async function resolveReflowFile(bookId: string): Promise<string | null> {
  const dir = await bookFolder(bookId)
  if (!dir) return null
  return contained(join(dir, DERIVED, REFLOW_NAME))
}
```

- [ ] **Step 3: Pin it — including the route that must stay shut**

In `electron/main/services/book-bytes.test.ts`, add `resolveReflowFile` to the import list from `./book-bytes`, add this helper beside the existing `seed`:

```ts
/** The artifact a pass would have written, for a book folder. */
async function seedReflow(id: string, bytes = 'epub-bytes'): Promise<string> {
  const dir = join(root, 'books', id, 'derived')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'reflow.epub'), bytes)
  return join(dir, 'reflow.epub')
}
```

and append:

```ts
describe('resolveReflowFile', () => {
  it('serves the artifact from the book’s own derived folder', async () => {
    insertBook(makeBook('r1'))
    const path = await seedReflow('r1')
    expect(await resolveReflowFile('r1')).toBe(path)
  })

  it('answers null when there is no artifact', async () => {
    insertBook(makeBook('r2'))
    await fs.mkdir(join(root, 'books', 'r2'), { recursive: true })
    expect(await resolveReflowFile('r2')).toBeNull()
  })

  it('answers null for a book the library does not hold', async () => {
    expect(await resolveReflowFile('nobody')).toBeNull()
  })

  /**
   * `book-bytes` is the security boundary between a renderer URL and the
   * filesystem, and the reflow's route is a second *path shape* through it
   * rather than a second implementation of it — which is the whole reason the
   * containment rule moved into `contained` instead of being copied.
   */
  it('refuses a folder that escapes the library root', async () => {
    insertBook({ ...makeBook('r3'), nasPath: '../outside' })
    expect(await resolveReflowFile('r3')).toBeNull()
  })

  it('refuses a derived folder that is a symlink out of the library root', async () => {
    insertBook(makeBook('r4'))
    const outside = join(root, '..', 'outside-derived')
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(join(outside, 'reflow.epub'), 'x')
    await fs.mkdir(join(root, 'books', 'r4'), { recursive: true })
    await fs.symlink(outside, join(root, 'books', 'r4', 'derived'))
    expect(await resolveReflowFile('r4')).toBeNull()
  })

  /**
   * **The wire stays closed (D8).** `GET /api/books/{id}/file` hands its
   * `format` straight to `resolveBookFile`, so an arm there would serve the
   * artifact to the phone in the same commit that no document describes. This
   * case is what fails the day someone folds the two resolvers together without
   * landing slice 4 — and the content-type half is why 'reflow' must not be
   * added to the format union either.
   */
  it('is not reachable through resolveBookFile, even with the artifact present', async () => {
    insertBook(makeBook('r5'))
    await seedReflow('r5')
    expect(await resolveBookFile('r5', 'reflow')).toBeNull()
    expect(bookContentType('reflow')).toBe('application/octet-stream')
  })
})
```

```bash
npm test -- electron/main/services/book-bytes.test.ts
npm test
```

Expected: the first command green **with every pre-existing case in the file unchanged** — that is the extraction's sweep — and the second at **1893 tests** (measured; the _file_ count is unchanged, because `book-bytes.test.ts` already existed), up by exactly 6.

```bash
git add electron/main/services/book-bytes.ts electron/main/services/book-bytes.test.ts
git commit -m "feat(main): the reflow artifact gets a route of its own

resolveBookFile's second consumer is the HTTP surface, which passes the
caller's format straight through — so a reflow arm in its allowlist would open
GET /api/books/{id}/file?format=reflow in the same commit that no document
describes, and D8 puts the contract first (slice 4). resolveReflowFile is the
renderer's route: {book}/derived/reflow.epub, a fixed name rather than an
extension scan, because derived/ is not a format.

The traversal and realpath rules move into bookFolder and contained, shared by
both resolvers — one boundary, two path shapes. The existing cases in
book-bytes.test.ts are the extraction's sweep and are unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The pass, called from the app

**Files:**

- Modify: `src/types/book.types.ts` (the RPC's two shapes)
- Modify: `src/types/api.types.ts` (the event channel's name)
- Create: `electron/main/services/reflow.ts`
- Create: `electron/main/services/reflow.test.ts`

**Interfaces:**

- Consumes: `book-bytes.resolveBookFile` (Task 1, unchanged), `services/sidecar.ts`'s `call` / `onNotification` / `assertAvailable`, `services/events.ts`'s `broadcast`.
- Produces:
  - `book.types.ReflowResult`, `book.types.ReflowProgress` — shared, because the main process produces them and the store consumes them.
  - `api.types.EVENT_CHANNELS.reflowProgress` (`'event:reflow-progress'`).
  - `reflow.ensure(bookId): Promise<ReflowResult>`, `reflow.REFLOW_TIMEOUT_MS`, `reflow.RETRY_VERDICTS`, `reflow.resetForTests()`.

- [ ] **Step 1: The RPC's two shapes**

In `src/types/book.types.ts`, after `ProgressReport`, add:

```ts
/**
 * What one reflow came to, in the app's spelling rather than the sidecar's.
 *
 * `status` is the pipeline's own three answers (D2/D9): `produced` wrote an
 * artifact on this call, `cached` found a current one, `fallback` wrote nothing
 * and `reason` is the one sentence to show (D6). `epub` and `stampFile` are
 * relative to the book folder and `''` when nothing was written; `pages`,
 * `bytes` and `seconds` are the pass's own measurements.
 */
export interface ReflowResult {
  status: 'produced' | 'cached' | 'fallback'
  reason: string
  verdict: string
  epub: string
  stampFile: string
  pages: number
  bytes: number
  seconds: number
}

/**
 * One `reflow_progress` frame, in the app's spelling.
 *
 * `phase` is the pipeline's — `start`, `layout`, `reading`, `writing`, `done`,
 * `cached`, `fallback` — plus one this app adds, `retrying` (R4), and the two
 * page phases carry `completed` of `total` against the same page count. The
 * sidecar sends `book_id`; this is `bookId`, because it crosses into the
 * renderer here and every renderer type in this repo is camelCase.
 */
export interface ReflowProgress {
  bookId: string
  phase: string
  completed: number
  total: number
  /** The pipeline's own sentence — on `fallback`, and on this app's `retrying`. */
  reason?: string
}
```

- [ ] **Step 2: The channel's name**

In `src/types/api.types.ts`, add to `EVENT_CHANNELS` (beside `themeChanged`):

```ts
  /**
   * A reflow pass's progress for one book (D7). Carried as an event rather than
   * through the call's own promise because the frames arrive whether or not
   * anyone is awaiting the result — and because the bar must not freeze when
   * React re-renders the component that started the pass.
   */
  reflowProgress: 'event:reflow-progress',
```

- [ ] **Step 3: The service**

Create `electron/main/services/reflow.ts`:

```ts
import { dirname } from 'path'
import type { ReflowProgress, ReflowResult } from '@shared/book.types'
import { resolveBookFile } from './book-bytes'
import * as events from './events'
import * as sidecar from './sidecar'

/**
 * The app's one door to the reflow pipeline — slice 2's `reflow_pdf` RPC.
 *
 * Four rules sit between the RPC and the reader, and each one was measured on
 * the way in:
 *
 * - **The source is resolved by extension**, through `book-bytes`'s own rule
 *   (invariant 2), so a book renamed after import still reflows — and the
 *   folder the pass writes `derived/` into is *that file's* folder, so no
 *   caller can aim the artifact at a folder the app does not own (slice 2's
 *   AC2, pinned there by `test_the_source_must_live_in_the_book_folder`).
 * - **The call carries its own deadline.** A pass is minutes: *Universe* (535
 *   pages) measured 176 s on 2026-10-08 and the helper runs 0.5–1.3 s per page.
 *   `services/sidecar.ts`'s 120 s default would answer a working pass as a
 *   failure — and because a timeout only drops the *pending call*, the pass
 *   would go on and write its artifact, so the next open would find a cache the
 *   reader had already been told did not exist.
 * - **One call per book.** The sidecar takes its own per-artifact lock (slice
 *   2, D7/AC6), so two opens cannot run two passes; this map is what stops the
 *   app *making* a second call for a pass already in flight, which is what
 *   AC6's "does not start a second pass" means from this side.
 * - **A refusal is retried once, and only when a retry can help** (R4).
 *
 * Progress is re-broadcast on the app's own channel rather than handed to the
 * caller: the frames arrive on the sidecar's notification stream whether or not
 * anything is awaiting the result.
 */

/**
 * Twenty minutes. Not a guess: the pass is O(pages) at 0.2–1.3 s per page per
 * half (slice 2's measurement), so the corpus's largest book is a few minutes
 * and D4R's own estimate for a 1,247-page textbook is 5–10. A pass that has not
 * answered in twenty is one to report rather than to wait on.
 */
export const REFLOW_TIMEOUT_MS = 20 * 60_000

/**
 * The one verdict a second attempt can fix.
 *
 * `unstable_layout` is the helper failing pages on a *later* run of a book it
 * laid out before — measured in slice 2 as three refusals across six full
 * corpus runs, every one healed by a retry. The rest are facts about the book
 * or the machine: `no_text_layer` (the ~10% of PDF-only books with no text at
 * all, which is D6's whole justification), `unreadable` (a PDF no parser
 * opens), `no_layout` (the helper missing or unsupported) and `write_failed`
 * (the share). Retrying those spends minutes to arrive at the same sentence.
 */
export const RETRY_VERDICTS = new Set(['unstable_layout'])

/**
 * What the sidecar answers, spelled as `reflow/produce.py` writes it.
 * `docs/data-contracts.md`'s `reflow_pdf` block is the same list from the
 * document's side.
 */
interface SidecarReflow {
  status?: unknown
  reason?: unknown
  verdict?: unknown
  epub?: unknown
  stamp_file?: unknown
  pages?: unknown
  bytes?: unknown
  seconds?: unknown
}

const inflight = new Map<string, Promise<ReflowResult>>()
let subscribed = false

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Subscribe to the sidecar's frames once, for the process, and re-broadcast
 * them in the app's spelling.
 *
 * Subscribed lazily rather than at import: `services/sidecar.ts`'s registry is
 * process-lifetime, so one subscription is the right number, and a per-call one
 * would leak a listener per open — the mistake `src/hooks/useAi.ts` documents
 * for the renderer's half of the same idea. A frame carries its own `book_id`,
 * so two books' passes on the sidecar's four threads are told apart by payload
 * and neither needs its own listener.
 */
function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  sidecar.onNotification('reflow_progress', (params) => {
    const frame = (params ?? {}) as Record<string, unknown>
    const bookId = text(frame.book_id)
    const phase = text(frame.phase)
    if (!bookId || !phase) return
    const reason = text(frame.reason)
    events.broadcast('reflowProgress', {
      bookId,
      phase,
      completed: count(frame.completed),
      total: count(frame.total),
      ...(reason ? { reason } : {})
    } satisfies ReflowProgress)
  })
}

/** Drop the in-flight map and the subscription. For tests only. */
export function resetForTests(): void {
  inflight.clear()
  subscribed = false
}

/**
 * Produce — or find — a book's reflow, or say why not (D6).
 *
 * Rejects only for the **pre-flight** failures, the same contract
 * `metadata.rehydrateBook` documents: the metadata engine is unavailable, or the
 * book has no PDF to reflow. A pass that runs and refuses **resolves**, with
 * `status: 'fallback'` and the pipeline's own sentence — because that is a
 * normal outcome (D6, invariant 12) and not an error the renderer should have to
 * tell apart from a crash.
 */
export function ensure(bookId: string): Promise<ReflowResult> {
  const existing = inflight.get(bookId)
  if (existing) return existing
  const run = pass(bookId).finally(() => inflight.delete(bookId))
  inflight.set(bookId, run)
  return run
}

async function pass(bookId: string): Promise<ReflowResult> {
  subscribeOnce()
  sidecar.assertAvailable()

  const pdf = await resolveBookFile(bookId, 'pdf')
  if (!pdf) throw new Error('This book has no PDF file to reflow')

  const bookDir = dirname(pdf)
  const first = await ask(bookDir, pdf, bookId)
  if (first.status !== 'fallback' || !RETRY_VERDICTS.has(first.verdict)) return first

  // Announced, so a bar that restarts has said why rather than looking stuck.
  events.broadcast('reflowProgress', {
    bookId,
    phase: 'retrying',
    completed: 0,
    total: 0,
    reason: first.reason
  } satisfies ReflowProgress)
  return ask(bookDir, pdf, bookId)
}

async function ask(bookDir: string, pdf: string, bookId: string): Promise<ReflowResult> {
  const raw = await sidecar.call<SidecarReflow>(
    'reflow_pdf',
    { book_dir: bookDir, pdf_path: pdf, book_id: bookId },
    REFLOW_TIMEOUT_MS
  )
  return {
    status:
      raw.status === 'produced' ? 'produced' : raw.status === 'cached' ? 'cached' : 'fallback',
    reason: text(raw.reason),
    verdict: text(raw.verdict),
    epub: text(raw.epub),
    stampFile: text(raw.stamp_file),
    pages: count(raw.pages),
    bytes: count(raw.bytes),
    seconds: count(raw.seconds)
  }
}
```

- [ ] **Step 4: Pin the rules against a mocked sidecar**

Create `electron/main/services/reflow.test.ts`:

```ts
import { promises as fs } from 'fs'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReflowProgress, ReflowResult } from '@shared/book.types'
import { makeBook } from '../../../test/helpers/book'
import { closeDb, deleteConfig, insertBook } from './db'
import * as events from './events'
import * as nas from './nas-manager'
import { REFLOW_TIMEOUT_MS, RETRY_VERDICTS, ensure, resetForTests } from './reflow'
import * as sidecar from './sidecar'

/**
 * The sidecar is mocked as a **whole module**: `vi.mock` replaces it, so every
 * export `reflow.ts` reaches for has to be named here. `assertAvailable` is the
 * one that would otherwise *start* a live Python process against
 * `sidecar/.venv` (`getAppPath()` is the repo root under vitest), which is the
 * same reason `bulk-hydrate.test.ts` mocks it.
 */
vi.mock('./sidecar', () => ({
  assertAvailable: vi.fn(),
  call: vi.fn(),
  onNotification: vi.fn(() => () => {})
}))

/** The mocked `call` is generic (`call<T>` → `Promise<T>`); one shape serves every case. */
function answerWith(value: Record<string, unknown> | Error): void {
  if (value instanceof Error) vi.mocked(sidecar.call).mockRejectedValue(value)
  else vi.mocked(sidecar.call).mockResolvedValue(value as never)
}

let root: string

beforeEach(async () => {
  closeDb()
  resetForTests()
  vi.mocked(sidecar.call).mockReset()
  vi.mocked(sidecar.onNotification).mockClear()
  vi.mocked(sidecar.assertAvailable).mockReset()
  vi.restoreAllMocks()

  root = mkdtempSync(join(tmpdir(), 'musaeum-reflow-'))
  await fs.mkdir(join(root, 'books'), { recursive: true })
  nas.setLibraryRootForTests(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  deleteConfig('library_root')
})

/** A PDF-only book, seeded the way the importer leaves one. */
async function seedPdf(id: string, name = 'Some Old Title.pdf'): Promise<string> {
  insertBook({ ...makeBook(id), formats: ['pdf'] })
  const dir = join(root, 'books', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, name), '%PDF-1.4\n')
  return dir
}

const PRODUCED = {
  status: 'produced',
  reason: '',
  verdict: 'ok',
  epub: 'derived/reflow.epub',
  stamp_file: 'derived/reflow.json',
  pages: 12,
  bytes: 4096,
  seconds: 3.5
}

describe('ensure', () => {
  it('resolves the source by extension and hands the pass its own folder', async () => {
    const dir = await seedPdf('b1')
    answerWith(PRODUCED)

    const result = await ensure('b1')

    const [method, params, timeout] = vi.mocked(sidecar.call).mock.calls[0] as [
      string,
      Record<string, string>,
      number
    ]
    expect(method).toBe('reflow_pdf')
    // Invariant 2: the folder is found by extension, so a book renamed after
    // import still reflows — and `book_dir` is *that file's* folder.
    expect(params.pdf_path).toBe(join(dir, 'Some Old Title.pdf'))
    expect(params.book_dir).toBe(dir)
    expect(params.book_id).toBe('b1')
    expect(timeout).toBe(REFLOW_TIMEOUT_MS)
    expect(result).toBeDefined()
  })

  /**
   * The measured gotcha this rule exists for: the sidecar's default is 120 s
   * and a 535-page pass is 176 s, so the default would report a working pass as
   * a failure while its artifact landed anyway.
   */
  it('gives the pass longer than the sidecar default', async () => {
    await seedPdf('b2')
    answerWith(PRODUCED)
    await ensure('b2')
    const timeout = vi.mocked(sidecar.call).mock.calls[0][2] as number
    expect(timeout).toBeGreaterThan(120_000)
  })

  it('speaks the app’s spelling, not the pipeline’s', async () => {
    await seedPdf('b3')
    answerWith(PRODUCED)
    const result: ReflowResult = await ensure('b3')
    expect(result).toEqual({
      status: 'produced',
      reason: '',
      verdict: 'ok',
      epub: 'derived/reflow.epub',
      stampFile: 'derived/reflow.json',
      pages: 12,
      bytes: 4096,
      seconds: 3.5
    })
  })

  it('answers an unknown status as a fallback rather than trusting it', async () => {
    await seedPdf('b4')
    answerWith({ status: 'exploded' })
    const result = await ensure('b4')
    expect(result.status).toBe('fallback')
    expect(result.pages).toBe(0)
    expect(result.epub).toBe('')
  })

  it('joins a pass already in flight instead of asking twice (AC6)', async () => {
    await seedPdf('b5')
    let release: (value: Record<string, unknown>) => void = () => {}
    vi.mocked(sidecar.call).mockImplementation(
      () => new Promise((resolve) => (release = resolve)) as never
    )

    const both = Promise.all([ensure('b5'), ensure('b5')])
    release(PRODUCED)
    const [one, two] = await both

    expect(vi.mocked(sidecar.call)).toHaveBeenCalledTimes(1)
    expect(one).toBe(two)
  })

  it('forgets the pass when it settles, so the next open asks again', async () => {
    await seedPdf('b6')
    answerWith(PRODUCED)
    await ensure('b6')
    await ensure('b6')
    // Twice asked, deliberately: the *cache* is the sidecar's (slice 2's stamp),
    // and it answers `cached` — this module holds nothing across calls.
    expect(vi.mocked(sidecar.call)).toHaveBeenCalledTimes(2)
  })

  it('rejects when the metadata engine is unavailable', async () => {
    await seedPdf('b7')
    vi.mocked(sidecar.assertAvailable).mockImplementation(() => {
      throw new Error('Python sidecar is unavailable')
    })
    await expect(ensure('b7')).rejects.toThrow('Python sidecar is unavailable')
    expect(vi.mocked(sidecar.call)).not.toHaveBeenCalled()
  })

  it('rejects when the book holds no PDF', async () => {
    insertBook({ ...makeBook('b8'), formats: ['epub'] })
    await fs.mkdir(join(root, 'books', 'b8'), { recursive: true })
    await fs.writeFile(join(root, 'books', 'b8', 'Book.epub'), 'x')
    await expect(ensure('b8')).rejects.toThrow('no PDF')
  })
})

describe('the retry (R4)', () => {
  it('asks again once when the helper failed pages on a later run', async () => {
    await seedPdf('b9')
    vi.mocked(sidecar.call)
      .mockResolvedValueOnce({
        status: 'fallback',
        verdict: 'unstable_layout',
        reason: '3 of 5 text pages could not be laid out'
      } as never)
      .mockResolvedValueOnce(PRODUCED as never)
    const broadcast = vi.spyOn(events, 'broadcast')

    const result = await ensure('b9')

    expect(vi.mocked(sidecar.call)).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('produced')
    // A bar that restarts has to have said why.
    expect(broadcast).toHaveBeenCalledWith(
      'reflowProgress',
      expect.objectContaining({ phase: 'retrying', bookId: 'b9' })
    )
    broadcast.mockRestore()
  })

  it('never retries a verdict that is a fact about the book', async () => {
    expect(RETRY_VERDICTS.has('no_text_layer')).toBe(false)
    expect(RETRY_VERDICTS.has('unreadable')).toBe(false)
    expect(RETRY_VERDICTS.has('write_failed')).toBe(false)
    expect(RETRY_VERDICTS.has('no_layout')).toBe(false)

    await seedPdf('b10')
    answerWith({
      status: 'fallback',
      verdict: 'no_text_layer',
      reason: 'no page carries a text layer'
    })
    const result = await ensure('b10')
    expect(vi.mocked(sidecar.call)).toHaveBeenCalledTimes(1)
    expect(result.reason).toBe('no page carries a text layer')
  })
})

describe('the frames', () => {
  it('re-broadcasts a reflow_progress frame in the app’s spelling', async () => {
    await seedPdf('b11')
    answerWith(PRODUCED)
    const broadcast = vi.spyOn(events, 'broadcast')
    await ensure('b11')

    const handler = vi.mocked(sidecar.onNotification).mock.calls[0][1] as (params: unknown) => void
    handler({ book_id: 'b11', phase: 'layout', completed: 3, total: 9 })

    const frame: ReflowProgress = {
      bookId: 'b11',
      phase: 'layout',
      completed: 3,
      total: 9
    }
    expect(broadcast).toHaveBeenCalledWith('reflowProgress', frame)
    broadcast.mockRestore()
  })

  it('drops a frame that names no book', async () => {
    await seedPdf('b12')
    answerWith(PRODUCED)
    const broadcast = vi.spyOn(events, 'broadcast')
    await ensure('b12')

    const handler = vi.mocked(sidecar.onNotification).mock.calls[0][1] as (params: unknown) => void
    broadcast.mockClear()
    handler({ phase: 'layout' })
    handler({ book_id: 'b12' })
    handler(undefined)

    expect(broadcast).not.toHaveBeenCalled()
    broadcast.mockRestore()
  })
})
```

Three things to expect while making this pass. The first two are the harness talking rather than the code; the third was found by running the case, which hung for its full 5 s timeout before it was fixed:

- The library root is set with **`nas.setLibraryRoot(root)`** — read `book-bytes.test.ts`'s `beforeEach`/`afterEach` pair and copy it verbatim (it also deletes the three `musaeum.db*` files first), rather than inventing a test-only setter.
- **Mock `./events` as a whole module too** (`vi.mock('./events', () => ({ broadcast: vi.fn() }))`), rather than `vi.spyOn(events, 'broadcast')`: `reflow.ts` imports the namespace, and a spy on an ESM namespace is the fragile path.
- **The AC6 case needs `await vi.waitFor(() => expect(call).toHaveBeenCalled())` before `release(…)`.** The first `ensure` reaches the mocked `call` only after an `fs.readdir`/`realpath` await, so releasing synchronously after building the `Promise.all` fires the initial no-op `release` and the pair never settles. (This is also why the case is worth having: it is the only place the in-flight map's _timing_ is exercised rather than its bookkeeping.)

```bash
npm test -- electron/main/services/reflow.test.ts
npm test
npm run typecheck
```

Expected: green, then the whole suite at **1907 tests / 88 files** (measured: 1893 after Task 1, plus this file's 14), and typecheck clean.

```bash
git add src/types/book.types.ts src/types/api.types.ts electron/main/services/reflow.ts electron/main/services/reflow.test.ts
git commit -m "feat(main): the app's door to the reflow pass

ensure(bookId) resolves the book's PDF through book-bytes' by-extension rule
(invariant 2), asks the sidecar for reflow_pdf with the pass's own twenty-minute
deadline — the default 120 s would report a working 535-page pass (measured 176
s) as a failure while its artifact landed anyway — joins a pass already in
flight instead of starting a second (AC6), and re-broadcasts the
reflow_progress frames as the app's reflowProgress event in the app's spelling.
A refusal whose verdict is unstable_layout is retried once (R4), announced by a
retrying frame; every other verdict is a fact about the book and is returned
verbatim with the pipeline's own sentence (D6).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The wire to the renderer

**Files:**

- Modify: `electron/main/ipc/reader.ts`
- Modify: `electron/preload/index.ts`
- Modify: `src/types/api.types.ts`

**Interfaces:**

- Consumes: `reflow.ensure` (Task 2), `EVENT_CHANNELS.reflowProgress` (Task 2), `ReflowResult` / `ReflowProgress` (Task 2).
- Produces: the `reader.reflow` method and the `on.reflowProgress` subscription on `window.Musaeum`.

- [ ] **Step 1: The handler**

Replace `electron/main/ipc/reader.ts`'s body:

```ts
import type { ProgressReport } from '@shared/book.types'
import * as readingState from '../services/reading-state'
import * as reflow from '../services/reflow'
import { handle } from './handle'

export function registerReaderHandlers(): void {
  handle('reader:saveProgress', (report: ProgressReport) => readingState.saveProgress(report))
  // One call, no file or process work of its own (invariant 8): the source's
  // resolution, the pass's deadline and the retry all live in
  // `services/reflow.ts`, where they can be decided without the IPC layer.
  handle('reader:reflow', (bookId: string) => reflow.ensure(bookId))
}
```

- [ ] **Step 2: The bridge**

In `electron/preload/index.ts`, inside the `reader` group, after `saveProgress`:

```ts
reflow: (bookId) => invoke('reader:reflow', bookId)
```

and inside `on`, after `aiError`:

```ts
reflowProgress: (cb) => listen(EVENT_CHANNELS.reflowProgress, cb)
```

- [ ] **Step 3: The API surface**

In `src/types/api.types.ts`, replace the `reader` group's declaration with:

```ts
  reader: {
    saveProgress(report: ProgressReport): Promise<void>

    /**
     * Produce — or find — this book's reflowed EPUB (D2, D7).
     *
     * Resolves with the pass's answer; progress arrives as `on.reflowProgress`
     * frames, not through this promise, because the frames are emitted whether
     * or not anything is awaiting it.
     *
     * **Rejects only for the pre-flight failures** — the metadata engine is
     * unavailable, or the book holds no PDF — which is `metadata.rehydrateBook`'s
     * own contract and the reason this is not `{ ok: false }`. A pass that runs
     * and refuses the book **resolves** with `status: 'fallback'` and the
     * pipeline's one sentence (D6): a book that cannot be laid out confidently is
     * a normal outcome, not an error.
     */
    reflow(bookId: string): Promise<ReflowResult>
  }
```

add `ReflowProgress` and `ReflowResult` to the `./book.types` import block at the top of that file, and add to the `on` group, after `aiError`:

```ts
    reflowProgress(cb: (progress: ReflowProgress) => void): Unsubscribe
```

- [ ] **Step 4: Gate**

```bash
npm run typecheck
npm run lint 2>/dev/null; npx eslint . --max-warnings=0 --ignore-pattern '.delta'
npm test
```

Expected: typecheck clean, eslint exit 0, `npm test` unchanged in count — there is no new test here, and that is deliberate: `const api: MusaeumAPI = { … }` in the preload is an **exact-shape assignment**, so a member the interface names and the object omits (or spells differently) is a `typecheck` failure, not a case. The two channel strings — `'reader:reflow'` here and in the handler, `EVENT_CHANNELS.reflowProgress` in the preload and in `services/reflow.ts` — are decided by the live pass in Task 5, which is the only instrument that can see both processes at once.

```bash
git add electron/main/ipc/reader.ts electron/preload/index.ts src/types/api.types.ts
git commit -m "feat(ipc): reader.reflow and the reflowProgress event reach the renderer

One handler, returning services/reflow.ts's promise untouched (invariant 8),
and the two bridge lines the renderer needs: reader.reflow for the pass and
on.reflowProgress for its frames. The API's contract states the two things the
renderer has to know — progress does not come back through the promise, and only
the pre-flight failures reject, because a refused pass is D6's normal outcome
and not an error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The rule, the store and the surface

**Files:**

- Modify: `src/types/book.types.ts`
- Modify: `src/types/book.types.test.ts`
- Modify: `src/stores/reader.store.ts`
- Modify: `src/stores/reader.store.test.ts`
- Modify: `src/components/reader/ReaderView.tsx`
- Modify: `src/components/reader/ReaderEngine.tsx`
- Modify: `src/components/library/BookDetail.tsx`

**Interfaces:**

- Consumes: `ReflowProgress` / `ReflowResult` (Task 2), `window.Musaeum.reader.reflow` and `window.Musaeum.on.reflowProgress` (Task 3).
- Produces:
  - `book.types.ReaderFormat` and `book.types.readerTarget(book)`.
  - `reader.store`'s `format: ReaderFormat | null`, `reflow: ReflowProgress | null`, `beginReflow(bookId)`, `setReflow(progress)`.

- [ ] **Step 1: The rule**

In `src/types/book.types.ts`, after `readableFormat` (and before `FORMAT_ORDER`), add:

```ts
/**
 * A format the in-app reader can be asked for.
 *
 * `'reflow'` is not a `BookFormat` and never becomes one (D3, AC2): it names a
 * *rendering* of the book's PDF, served from `{book}/derived/reflow.epub`, and
 * adding it to `formats` would make a PDF-only book claim an EPUB — changing its
 * format chip, its facet count, the phone's `preferredFormat` and what a Kindle
 * is offered.
 */
export type ReaderFormat = BookFormat | 'reflow'

/**
 * Whether the reader opens this book itself, and as what — or `null`, meaning
 * nothing the reader or the OS can open.
 *
 * The order is the feature (D1): a book with an EPUB, AZW3 or MOBI is read
 * exactly as it always was, and **a PDF-only book** opens the reader, which
 * produces a reflowed EPUB on demand (D7) and hands the book to the system
 * opener only if the pass refuses (D6).
 *
 * Deliberately narrower than the *feature's* trigger, which D1 sets at "holds a
 * PDF and no EPUB" (1,534 books) for the wire's benefit. This is the rule for
 * **when this Mac spends a pass**, and it asks only for a book the reader has no
 * other way to show: reflowing a `mobi`+`pdf` paper costs seconds and reads
 * worse when it fails, because a textless book that also holds a `mobi` would
 * forfeit a view this engine can render for Preview. The residual — those 45
 * books need an artifact before the phone can read them — is slice 4's, and R6
 * of `plans/2026-10-09-pdf-reflow-slice-3.md` records the trade.
 */
export function readerTarget(
  book: Book
): { kind: 'format'; format: BookFormat } | { kind: 'reflow' } | null {
  const readable = readableFormat(book)
  if (readable) return { kind: 'format', format: readable }
  return book.formats.includes('pdf') ? { kind: 'reflow' } : null
}
```

- [ ] **Step 2: Pin the rule**

Append to `src/types/book.types.test.ts`:

```ts
describe('readerTarget', () => {
  const book = (formats: BookFormat[]): Book => ({ ...makeBook('b1'), formats })

  it('reads a book the engine can open as it always did', () => {
    expect(readerTarget(book(['epub']))).toEqual({ kind: 'format', format: 'epub' })
    expect(readerTarget(book(['mobi', 'pdf']))).toEqual({ kind: 'format', format: 'mobi' })
    // Preference order, not array order (invariant 3)
    expect(readerTarget(book(['pdf', 'azw3']))).toEqual({ kind: 'format', format: 'azw3' })
  })

  it('reflows a book the reader has no other way to show', () => {
    expect(readerTarget(book(['pdf']))).toEqual({ kind: 'reflow' })
  })

  /**
   * R6's boundary: the feature's trigger is wider than this rule, and the
   * comment above `readerTarget` says why. If this case is ever the *other*
   * answer, D1's trigger has been adopted for the Mac's reader and that is a
   * decision rather than a refactor.
   */
  it('does not spend a pass on a book that already has a readable file', () => {
    expect(readerTarget(book(['mobi', 'pdf']))?.kind).toBe('format')
    expect(readerTarget(book(['azw3', 'pdf']))?.kind).toBe('format')
  })

  it('is null for a book with nothing to open', () => {
    expect(readerTarget(book([]))).toBeNull()
  })
})
```

with `readerTarget` and `BookFormat` in that file's imports (and `makeBook` from `../../test/helpers/book`, if it is not already there).

- [ ] **Step 3: The store**

In `src/stores/reader.store.ts`:

1. import `readerTarget`, `type ReaderFormat`, `type ReflowProgress`, `type ReflowResult` from `@shared/book.types`, and `useUIStore` from `@/stores/ui.store` (measured: no store imports `reader.store`, so this is a one-way chain — `reader.store` → `ui.store` → `library.store`);
2. change `format: BookFormat | null` to `format: ReaderFormat | null` in `ReaderState`;
3. add to `ReaderState`, beside `percent`:

```ts
/**
 * The reflow pass, while one is running for the open book.
 *
 * `null` is how the view knows there is nothing to wait for — either this is
 * not a reflow book, or the artifact is in hand and the engine may mount. Kept
 * as state rather than as a ref because the progress surface reads it, and
 * written only by `setReflow` so the identity guard below is the single place
 * a frame can or cannot move it.
 */
reflow: ReflowProgress | null
```

4. add the actions to the interface, beside `openBook`:

```ts
  /** Ask the app for the open book's reflow and land what comes back (D6, D7). */
  beginReflow(bookId: string): Promise<void>
  /** One progress frame, or `null` when the artifact is in hand. */
  setReflow(progress: ReflowProgress | null): void
```

5. change the creator's signature from `(set) => ({` to `(set, get) => ({`, and initialise `reflow: null` beside `percent: 0`;
6. replace `openBook` with:

```ts
      /**
       * The readability rule, and the two doors it opens (D1, D6, D7).
       *
       * A book with a format the engine can open is unchanged. A **PDF-only**
       * book opens the reader and the reader asks for a reflow — which is the
       * whole of C2 on this side. A book with no format at all is still handed
       * to the OS, because there is nothing here to read and nothing to
       * reflow — and that is now the *only* branch that reaches
       * `openBookFile` synchronously, which is why the branch stays rather than
       * disappearing with the PDF case.
       */
      openBook: (book) => {
        const target = readerTarget(book)
        if (!target) {
          // By preference, not by array position (invariant 3)
          const fallback = primaryFormat(book)
          if (fallback) void window.Musaeum.files.openBookFile(book.id, fallback).catch(() => {})
          return
        }
        const format: ReaderFormat = target.kind === 'reflow' ? 'reflow' : target.format
        set((s) => {
          // A book that is already open is not a load (see the note this
          // replaced): the engine keys its effect on `(bookId, format)`.
          const reload = s.bookId !== book.id || s.format !== format
          return {
            bookId: book.id,
            format,
            status: reload ? 'loading' : s.status,
            error: null,
            toc: [],
            percent: reload ? (book.readingState?.percent ?? 0) : s.percent,
            tocOpen: false,
            prefsOpen: false,
            reflow:
              target.kind === 'reflow' ? { bookId: book.id, phase: 'start', completed: 0, total: 0 } : null,
            // A book is a new conversation: transcript, verdict, pointer and all
            ...ASK_IDLE,
            // …and a new search: results for another book's text are not results
            ...SEARCH_IDLE
          }
        })
        if (target.kind === 'reflow') void get().beginReflow(book.id)
      },
```

7. add `reflow: null` to `close()`'s reset object, beside `toc: []`;
8. add the two actions at the end of the creator, before `setPrefs`:

```ts
      /**
       * Ask for the open book's reflow and land what comes back.
       *
       * The waiting lives here rather than in a component for the same reason the
       * trigger does: the answer decides three different things — the book
       * becomes readable, or it goes to the system opener with a sentence, or
       * nothing happens because the reader has moved on — and one function that
       * reads all three is the only place that can be seen to agree with itself.
       *
       * Progress does **not** come through here. The frames are broadcast and
       * land in `setReflow`, because a bar fed by this closure would freeze the
       * moment React re-rendered anything (R5).
       */
      beginReflow: async (bookId) => {
        const book = useLibraryStore.getState().books.find((b) => b.id === bookId) ?? null
        let result: ReflowResult
        try {
          result = await window.Musaeum.reader.reflow(bookId)
        } catch (err) {
          // A pre-flight failure — no metadata engine, or no PDF on disk. The
          // book is still a book: it goes to the system opener, and the sentence
          // is the app's own (`metadata.rehydrateBook`'s contract, same shape).
          if (get().bookId === bookId) handOffToSystem(book, err, get().close)
          return
        }
        // The reader may have been closed, or another book opened, while the
        // pass ran: the answer is about a session that is over.
        if (get().bookId !== bookId) return
        if (result.status !== 'fallback') {
          // The artifact is there: the engine may mount and fetch it.
          set({ reflow: null })
          return
        }
        // D6: no artifact, the original path, one line of reason (R3).
        handOffToSystem(book, result.reason, get().close)
      },

      /**
       * One progress frame, or the artefact's arrival.
       *
       * Two guards, both of which are the difference between a bar and a bug: a
       * frame for another book is dropped (the sidecar's four threads can be
       * running two passes), and a repeat of the frame already held is returned
       * as *the same state*, so a long `reading` phase does not notify a
       * subscriber per page. `null` always clears — that is the terminal signal.
       */
      setReflow: (progress) =>
        set((s) => {
          if (progress === null) return s.reflow === null ? s : { reflow: null }
          if (s.reflow?.bookId !== progress.bookId) return s
          const same =
            s.reflow.phase === progress.phase &&
            s.reflow.completed === progress.completed &&
            s.reflow.total === progress.total
          return same ? s : { reflow: progress }
        }),
```

and add the module-level helper above the store's `create`:

```ts
/**
 * The original path (D6, AC4): the reader closes, the book goes to the OS's own
 * app for its format, and the pipeline's own sentence goes on screen.
 *
 * `notify` rather than `notifyError`: a refused reflow is a normal outcome — the
 * ~10% of PDF-only books with no text layer are D6's whole justification — and
 * the toast kind is what says so. The message is short and the measurement is
 * the `detail`, so a long reason reads as detail rather than as a wall.
 *
 * Deliberately does not touch `book.readingState` or `reading_state`: a book that
 * fell back was never read here, and the reader's own position rules are not this
 * path's to bend.
 */
function handOffToSystem(book: Book | null, reason: unknown, close: () => void): void {
  const format = book ? primaryFormat(book) : null
  const detail =
    typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : String(reason)
  close()
  if (book && format) void window.Musaeum.files.openBookFile(book.id, format).catch(() => {})
  useUIStore.getState().notify({
    kind: 'info',
    message: 'This book could not be prepared as a reflowed book.',
    detail
  })
}
```

`close()` is passed in rather than reached for so this helper holds no reference to the store — the actions are the only things that set state.

- [ ] **Step 4: The view**

In `src/components/reader/ReaderView.tsx`:

1. import `primaryFormat` from `@shared/book.types` (beside `ReadingState`), and `ReflowProgress` from the same module;
2. read the two new store fields and the action:

```ts
const reflow = useReaderStore((s) => s.reflow)
const setReflow = useReaderStore((s) => s.setReflow)
```

3. subscribe **once for the process** (R5 — `App.tsx:80` renders `<ReaderView />` unconditionally, so this effect's only dependency is a stable action):

```ts
/**
 * The pass's frames, wired once. `ReaderView` is mounted unconditionally by
 * `App.tsx`, so this is one subscription for the process — the property
 * `src/hooks/useAi.ts` documents for the ask stream — without a hook of its
 * own and without an `App.tsx` mount line. A frame for a book that is not
 * open is dropped by `setReflow`'s own guard, not by this listener.
 */
useEffect(() => window.Musaeum.on.reflowProgress(setReflow), [setReflow])
```

4. gate the engine on the artifact, beside the existing `resumeState` gate:

```tsx
              {resumeState === undefined ? null : reflow ? (
                <ReflowProgressPanel progress={reflow} />
              ) : (
                <ReaderEngine
                  …unchanged…
                />
              )}
```

5. in the error state's "Open externally", the format may now be `'reflow'`, which `openBookFile` does not accept:

```tsx
void window.Musaeum.files
  .openBookFile(book.id, format === 'reflow' ? (primaryFormat(book) ?? 'pdf') : format)
  .catch(() => {})
```

6. add the panel and its one-line labeller at the bottom of the file:

```tsx
/**
 * The pass, while it runs (D7, AC6).
 *
 * A pane of its own rather than a spinner over the book: the artifact is not
 * there yet, so there is no page to sit a spinner on — and the two page phases
 * share one page count (slice 2), so the bar is the same measure in both.
 */
function ReflowProgressPanel({ progress }: { progress: ReflowProgress }) {
  const fraction = progress.total > 0 ? progress.completed / progress.total : 0
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <p className="font-display text-[15px] text-parchment">Preparing this book…</p>
      <div className="h-1 w-64 overflow-hidden rounded bg-ink-800">
        <div
          className="h-full bg-gold-500 transition-[width] duration-200"
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
      <p className="text-[12px] text-parchment-faint">{reflowLabel(progress)}</p>
    </div>
  )
}

/** The line under the bar — pages when the phase has them, the phase otherwise. */
function reflowLabel(progress: ReflowProgress): string {
  if (progress.phase === 'retrying') return 'Trying again…'
  if (progress.phase === 'start') return 'Measuring the book…'
  if (progress.phase === 'writing') return 'Writing the book…'
  if (progress.phase === 'cached') return 'Already prepared'
  if (progress.total > 0) return `${progress.completed} of ${progress.total} pages`
  return 'Working…'
}
```

- [ ] **Step 5: The engine's union**

In `src/components/reader/ReaderEngine.tsx`:

1. import the widened type: `import type { ReadingState, ReaderFormat } from '@shared/book.types'` (replacing `BookFormat` in that import — `BookFormat` is not otherwise named in the file);
2. change `format: BookFormat` to `format: ReaderFormat` in `Props`, with the reason beside it:

```ts
/**
 * The format the URL carries, and the extension the `File` is named with.
 * `'reflow'` is not a `BookFormat` (D3): it is the route segment for the
 * book's derived EPUB, which `book-bytes.resolveReflowFile` serves.
 *
 * `book.reflow` is safe as a *name* because `makeBook` decides a zip by its
 * content — `isZip` reads the first four bytes, and the name is consulted
 * only to exclude `.cbz`/`.fb2` (`vendor/foliate-js/view.js:8-28`, `:101`).
 * The PDF branch is the opposite case (`isPDF` reads the magic and `./pdf.js`
 * is external), which is why `'pdf'` must never reach here.
 */
format: ReaderFormat
```

Nothing else in that file changes: the URL, the `File` name, the `open()` call and the TOC all read `format` and behave identically.

- [ ] **Step 6: The tooltip that would otherwise lie**

In `src/components/library/BookDetail.tsx`, swap the import of `readableFormat` for `readerTarget` and change the Read button's title:

```tsx
          title={readerTarget(book) ? 'Read in Musaeum' : 'Open in the default app'}
```

With the rule in place the reader opens every book that has a format, so "Read in Musaeum" is now the honest label for the PDF-only case too; only a book with no formats falls through to the OS, and the button is disabled for those (`:326`).

- [ ] **Step 7: The store's own cases**

Append to `src/stores/reader.store.test.ts`. The existing file has no `window` stub (its books all hold an `epub`), so the new block brings its own:

```ts
/**
 * The reflow path (D1, D6, D7). `window.Musaeum` is stubbed because there is no
 * preload under vitest — the pattern `src/lib/add-books.test.ts` uses.
 */
describe('openBook — the reflow path', () => {
  let opened: [string, string][]
  let asked: string[]
  let answer: ReflowResult | Error
  let reflow = (id: string) => {
    asked.push(id)
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  }

  const pdfBook = (id = 'b1', formats: BookFormat[] = ['pdf']) => ({
    ...makeBook(id),
    formats
  })

  beforeEach(() => {
    opened = []
    asked = []
    answer = {
      status: 'cached',
      reason: '',
      verdict: 'ok',
      epub: 'derived/reflow.epub',
      stampFile: 'derived/reflow.json',
      pages: 3,
      bytes: 10,
      seconds: 0.1
    }
    vi.stubGlobal('window', {
      Musaeum: {
        reader: { reflow: (id: string) => reflow(id) },
        files: {
          openBookFile: (id: string, format: string) => {
            opened.push([id, format])
            return Promise.resolve()
          }
        }
      }
    })
    vi.spyOn(useUIStore.getState(), 'notify')
    useReaderStore.getState().close()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('opens a PDF-only book as a reflow and asks for one', () => {
    useReaderStore.getState().openBook(pdfBook())
    expect(useReaderStore.getState().format).toBe('reflow')
    expect(useReaderStore.getState().reflow).toMatchObject({ bookId: 'b1', phase: 'start' })
    expect(asked).toEqual(['b1'])
  })

  it('leaves a book the engine can read alone', () => {
    useReaderStore.getState().openBook({ ...makeBook('b2'), formats: ['mobi', 'pdf'] })
    expect(useReaderStore.getState().format).toBe('mobi')
    expect(useReaderStore.getState().reflow).toBeNull()
    expect(asked).toEqual([])
  })

  it('leaves the reader on the artifact a cached pass found', async () => {
    useReaderStore.getState().openBook(pdfBook('b3'))
    await vi.waitFor(() => expect(useReaderStore.getState().reflow).toBeNull())
    expect(useReaderStore.getState().bookId).toBe('b3')
    expect(opened).toEqual([])
  })

  it('hands the book to the system opener, with the reason, when the pass refuses', async () => {
    answer = {
      status: 'fallback',
      reason: '3 of 5 text pages could not be laid out',
      verdict: 'unstable_layout',
      epub: '',
      stampFile: '',
      pages: 5,
      bytes: 0,
      seconds: 1.2
    }
    useReaderStore.getState().openBook(pdfBook('b4'))
    await vi.waitFor(() => expect(useReaderStore.getState().bookId).toBeNull())
    expect(opened).toEqual([['b4', 'pdf']])
    expect(useUIStore.getState().notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'info', detail: '3 of 5 text pages could not be laid out' })
    )
  })

  it('hands the book over when the pre-flight fails, too', async () => {
    answer = new Error('Python sidecar is unavailable')
    useReaderStore.getState().openBook(pdfBook('b5'))
    await vi.waitFor(() => expect(useReaderStore.getState().bookId).toBeNull())
    expect(opened).toEqual([['b5', 'pdf']])
    expect(useUIStore.getState().notify).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'Python sidecar is unavailable' })
    )
  })

  it('drops an answer for a book the reader has left', async () => {
    useReaderStore.getState().openBook(pdfBook('b6'))
    useReaderStore.getState().close()
    await Promise.resolve()
    await Promise.resolve()
    expect(opened).toEqual([])
    expect(useUIStore.getState().notify).not.toHaveBeenCalled()
  })

  it('keeps a frame for another book out of this session', () => {
    useReaderStore.getState().openBook(pdfBook('b7'))
    const before = useReaderStore.getState().reflow
    useReaderStore
      .getState()
      .setReflow({ bookId: 'other', phase: 'layout', completed: 1, total: 2 })
    expect(useReaderStore.getState().reflow).toBe(before)
    useReaderStore.getState().setReflow({ bookId: 'b7', phase: 'layout', completed: 1, total: 2 })
    expect(useReaderStore.getState().reflow).toMatchObject({ phase: 'layout', completed: 1 })
  })

  it('holds identity for a repeated frame', () => {
    useReaderStore.getState().openBook(pdfBook('b8'))
    const frame = { bookId: 'b8', phase: 'reading', completed: 4, total: 9 }
    useReaderStore.getState().setReflow(frame)
    const held = useReaderStore.getState().reflow
    useReaderStore.getState().setReflow({ ...frame })
    expect(useReaderStore.getState().reflow).toBe(held)
  })
})
```

with `ReflowResult` and `BookFormat` added to that file's type imports and `useUIStore` imported from `@/stores/ui.store`.

```bash
npm run typecheck && npx eslint . --max-warnings=0 --ignore-pattern '.delta'
npm test
```

Expected: green, with the count up by `readerTarget`'s 4 and the store's 8.

**What this task's cases cannot decide, and what does.** `ReaderView`'s panel, its subscription and the engine's gate are renderer components, and the vitest environment is Node with no DOM (`vitest.config.ts:20`) — so those three are decided by a **source walk** (the strings are greppable: `on.reflowProgress`, `ReflowProgressPanel`, `primaryFormat(book)`) plus Task 5's live pass, which is the only instrument that can see the frames arrive. Say so in the record rather than letting a walk read as a rendering test.

```bash
git add src/types/book.types.ts src/types/book.types.test.ts src/stores/reader.store.ts src/stores/reader.store.test.ts src/components/reader/ReaderView.tsx src/components/reader/ReaderEngine.tsx src/components/library/BookDetail.tsx
git commit -m "feat(reader): a PDF-only book opens the reader, and the reader asks for a reflow

readerTarget is the rule (D1): a book the engine can open is unchanged, a
PDF-only book opens the reader, and a book with no format still goes to the OS.
openBook sends it to format 'reflow', beginReflow awaits the pass and lands the
three outcomes — the artifact in hand, or the original plus the pipeline's own
sentence (D6/R3), or nothing because the reader moved on — and setReflow holds
the frames with the two guards that make a bar a bar rather than a bug.
ReaderView shows the pass, subscribes once (App.tsx mounts it unconditionally,
so no new hook), and gates the engine on the artifact; ReaderEngine's format
widens to ReaderFormat, which is safe because makeBook sniffs a zip's content
and reads the name only to exclude .cbz/.fb2; BookDetail's tooltip stops
advertising the system opener for a book the reader now opens.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The record, and the live pass

**Files:**

- Modify: `tasks.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/data-contracts.md`
- Modify: `docs/invariants/reader.md`

- [ ] **Step 1: The live pass — the only instrument that sees both processes**

```bash
npm run dev
```

Open a **PDF-only** book (a card's double-click, the detail panel's Read, or the context menu's Read). Watch for, in this order:

1. the reader opens and the pane says _Preparing this book…_ with a bar that moves and a page count;
2. the pass finishes and the reflowed book renders — with a TOC in the panel, find-in-book (⌘F) working, and the typography popover still applying;
3. close and reopen: it is instant (`cached`), because slice 2's stamp is current;
4. open an **image-only** book (_The Complete Guide to Asterix_ is the corpus's): the same pane appears, then Preview opens the PDF and a toast carries the pipeline's sentence — _no artifact, the original path, one line of reason_ (D6/AC4);
5. from the same rows, `Open PDF` still opens the original in Preview, and the format chips still read `PDF` — the artifact is not a format (AC2/AC3).

Record the four measured things rather than the adjectives: the book, the phase sequence observed, the wall time to first page, and the fallback's sentence verbatim. A criterion whose evidence is a live probe is decided for the session and undecided for the tree, so the numbers go in the record below (the value, the instrument, and the pre-slice value beside it) — here the pre-slice value is the reader's own honest one, _"Open externally" only_, because PDF-only books have never opened in-app before.

- [ ] **Step 2: `docs/data-contracts.md` — the sentence this slice makes false**

Line 233 begins ``**`reflow_pdf` in detail** (spec D7/D9; slice 2, 2026-10-08 — the pipeline is in place, the reader does not call it until slice 3).`` Replace that parenthesis with:

```markdown
(spec D7/D9; slice 2, 2026-10-08; called by the Mac's reader since slice 3, 2026-10-TBD)
```

Nothing else in that block changes: the parameters, the cache rule and the answer's shape are slice 2's and are exactly what `services/reflow.ts` sends and reads.

- [ ] **Step 3: `docs/invariants/reader.md` — the one sentence that is now false**

In _Reading in the app_, the first sentence reads "`components/reader/ReaderView.tsx` over a **vendored** foliate-js (`vendor/foliate-js/`). EPUB, MOBI and AZW3; PDF is a later phase and falls through to `files.openBookFile` today, as does anything the engine rejects, so every entry point does something for every book." Correct it in place, additively:

```markdown
A **PDF-only** book now opens the reader too (slice 3): the app produces a reflowed EPUB on demand through the sidecar's `reflow_pdf` (spec D2/D7, `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md`), serves it from `{book}/derived/reflow.epub` over `musaeum://book/{id}/reflow`, and hands the book to `files.openBookFile` with one line of reason only when the pass refuses it (D6). The rest of this document's reflow rules — the fallback's posture, `derived/`'s standing, the source-page map — are slice 5's to write; the paragraph above the one you are reading is the only sentence this slice changes.
```

The rest of the file is slice 5's (the spec's slice table assigns it), and this slice deliberately does not rewrite it.

- [ ] **Step 4: `tasks.md` — C2's status line**

C2's entry currently hands slice 3 over in three sentences: the one beginning "**Then slice 3 — the Mac reader:**" and running to "…at sign-off.", the one beginning "**First step: the `helpers/` entry in `electron-builder.yml`**" and running to "…no code defect to find.", and the one beginning "**Slice 3 starts here:**" and running to "…the signal to stop for."). Replace all three with the landed record, filling every `NUM` from the live pass and the git log:

```markdown
**Slice 3 — the Mac reader — landed 2026-10-TBD** on `feat/pdf-reflow-slice-3`: a PDF-only book opens in the app. `resolveReflowFile` serves `{book}/derived/reflow.epub` over `musaeum://book/{id}/reflow` — a route of its own rather than a member of `book-bytes`'s format allowlist, because that function's second consumer is the HTTP surface and the wire is slice 4's (D8) — `services/reflow.ts` is the app's door to `reflow_pdf` (by-extension source resolution, the pass's own 20-minute deadline rather than the sidecar's 120 s, one call per book, and one retry for `unstable_layout` alone), and the reader shows the pass while it runs. The rule is `readerTarget`: a book the engine can open is unchanged, a PDF-only book opens the reader, and a book the pass refuses is handed to Preview with the pipeline's own sentence on the toast surface (D6/AC4). Measured in the running app: NUM s to first page for a NUM-page book (cached: NUM s), the frames NUM through NUM pages then NUM, and the image-only book falls back with _NUM_ — against a pre-slice reader that had no in-app path at all for these books. Four things this slice deliberately did not do: the wire is untouched (`GET /api/books/{id}/file?format=reflow` still answers 404, and slice 4 documents it first); `metadata.json`, `formats` and the SQLite schema are untouched (AC2); the spec's D1 trigger is wider than the Mac's rule — the 45 `mobi`+`pdf` papers still have no Mac-side producer of an artifact, which is slice 4's to close; and the two content rules slice 1R's review left (`outline.is_junk`'s Roman-folio over-reach and the 80-character furniture cap) are **still open**, now placed with the owner's two gate questions 7–9 rather than with a reader slice, because the same re-measurement answers all three. The helper now ships (`electron-builder.yml`'s `helpers/bin` entry), so a packaged build no longer answers `no_layout` for every book — the one defect class that had no code defect to find.
```

- [ ] **Step 5: `CHANGELOG.md`**

Add a `## [Unreleased] — 2026-10-TBD` section (or extend today's if one exists — check with `head -20 CHANGELOG.md` first) with one user-facing bullet, written from this slice's own CHANGED line:

```markdown
### Added

- **PDF-only books now open in Musaeum's own reader.** The app prepares a reflowed book once, showing progress while it works, and a book it cannot lay out opens in Preview with a line saying why.
```

- [ ] **Step 6: The slice's own gate, and the record of it**

```bash
npm run typecheck
npx eslint . --max-warnings=0 --ignore-pattern '.delta'
npm test
sidecar/.venv/bin/python -m pytest sidecar/tests -q
git diff --stat main...feat/pdf-reflow-slice-3
```

Expected: typecheck clean; eslint exit 0; `npm test` green with the count up by 20 over the 1887 baseline (6 in Task 1, 14 in Task 2 — measured — plus 4 + 8 for Task 4); pytest **unchanged** at 388 passed / 129 reflow — a Python change here means the pass was touched, which this slice forbids; and a `--stat` that names exactly the ten code files, their tests, this plan, and the four documents — nothing else, and no `.md` file hard-wrapped.

```bash
git add tasks.md CHANGELOG.md docs/data-contracts.md docs/invariants/reader.md
git commit -m "docs: C2 records slice 3 — a PDF-only book reads in the app

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand the slice back**

Report, in this order: the plan's path; per task the commit, the tests and the measured numbers; the live pass's five observations from Step 1; what slice 4 needs (below); and the two decisions the owner still owes, plus the one new one this plan raises (R6). Do not push.

---

## Carried in, and where each one goes

C2's entry lists the carries from slice 1R's reviews, and slice 2's plan placed each. This is where they stand after slice 3.

| Carried in                                                                                                                             | Where it goes, and why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helpers/bin` ships in no bundle: `electron-builder.yml` has no `helpers/` entry, so a packaged build falls back on every book         | **Fixed, Task 0.** The one thing with no code defect behind it — every book answers `no_layout` and nothing looks wrong — which is why it is the slice's first step and its own commit. 149 KB against AC9's ≤ 1 MB                                                                                                                                                                                                                                                                                                                |
| A pass occasionally _refuses_ a book it laid out minutes earlier (three of six full corpus runs, one book each, every retry healed it) | **Fixed, Task 2 (R4).** One retry, for `unstable_layout` alone, announced as a `retrying` frame. The verdicts that are facts about the book are not retried, because a retry spends minutes to reach the same sentence                                                                                                                                                                                                                                                                                                             |
| A reader-side retry "is slice 3's call" (slice 2's own record)                                                                         | **Answered, Task 2.** Yes, once, on the one verdict a retry can fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `outline.is_junk`'s `^[ivxlcdm]+$` also drops real titles (`Civil`, `Mild`, `DIM`) — slice 2 placed it "for slice 3"                   | **Re-placed — not this slice.** It is a **content** rule of the pass, and this slice does not touch `sidecar/`: taking it would change the TOC of the artifact the owner accepted in slice 1R, in a slice whose whole job is the reader, and it would need a corpus re-run to say what moved. It belongs with the owner's two gate decisions (open questions 7–9), because the same re-measurement answers all three. **This is a re-placement of slice 2's own assignment and is called out as such** rather than quietly dropped |
| The 80-character furniture cap leaves _Universe_'s `Copyright … Cengage` footer in the flow on 323 of 530 text pages                   | **Not this slice — the owner's, alongside open questions 7–9.** Unchanged from slice 2's placement: it is a threshold rule of the gate, and question 9 is where its bar is decided                                                                                                                                                                                                                                                                                                                                                 |
| `derived/` is on disk and no invariant doc says what it is                                                                             | **Slice 5's (the spec's table).** Task 5 corrects the one sentence in `docs/invariants/reader.md` that this slice makes false and says the rest is slice 5's; `docs/invariants/files-and-deletion.md` is untouched                                                                                                                                                                                                                                                                                                                 |

## What slice 4 will need from this one

- **The artifact's route, which the renderer already uses:** `book-bytes.resolveReflowFile` and its two constants (`DERIVED`, `REFLOW_NAME`). The wire's clause is slice 4's to add _deliberately_, after `docs/rest-api.md` names it — and the path constant now has two declarations in two languages (Python's `produce.EPUB_NAME`, TypeScript's `REFLOW_NAME`) **plus a third reader** once the iOS client learns it from the document.
- **The result's shape, which the payload is a projection of:** `ReflowResult` (`status`, `reason`, `verdict`, `epub`, `stampFile`, `pages`, `bytes`, `seconds`). D8's payload member is "availability and version"; the version is `converter` in `derived/reflow.json`, which slice 2 writes and this slice does not read — slice 4's `shape.ts` is the first consumer that needs it.
- **The progress channel:** `reflowProgress` with `{bookId, phase, completed, total, reason?}` and the phase vocabulary (the pipeline's seven plus this app's `retrying`). A phone cannot watch a pass it did not start, so slice 4 has to decide whether the wire exposes it at all.
- **The residual this slice leaves open (R6):** the 45 books that hold a PDF **and** a `mobi`/`azw3` have no Mac-side producer — the Mac's reader renders their `mobi` and never asks for a reflow. That is the paper shelf D1 argues the whole feature exists for, so closing it is slice 4's, and D8's `reflow.available` is the member it hangs on.
- **The two channel strings and one handler** (`reader:reflow`, `event:reflow-progress`) — the phone's upload and reading routes already share this shape, so a wire-level trigger, if slice 4 adds one, has an existing pattern to follow.

## Review Focus for the reviewer of this plan (dispatch/close-out)

1. Each _Review Focus_ item above, pinned by the test or command it names.
2. Every commit's message says what changed and, where a measurement forced it, names the measurement.
3. `git diff --stat main...feat/pdf-reflow-slice-3` is the ten code files, their tests, this plan and the four documents — nothing else, and no `.md` hard-wrapped.
4. The sidecar suite's count **unchanged** (388 passed / 129 reflow) — the strongest single proof that this slice added a caller and not a converter.
5. The live pass's five observations, quoted with their numbers, before the slice is called done.

---

## Start here (for the session that picks this up)

```bash
git log --oneline -3
npm test                                     # expect 87 files / 1887 + this slice's cases
sidecar/.venv/bin/python -m pytest sidecar/tests -q   # expect 388 passed, 129 reflow
```

Read in this order, and read the first two before writing anything:

1. **`docs/superpowers/plans/2026-10-08-pdf-reflow-slice-2.md`, its _What slice 3 will need_** — the RPC's contract is described there from the caller's side, and it is one page rather than the whole plan.
2. **`electron/main/services/sidecar.ts`** (the call/notification surface, and the 120 s default this slice overrides) and **`electron/main/services/book-bytes.ts`** (the boundary the artifact's route goes through) — between them they are every main-process decision this slice makes.
3. **`src/stores/reader.store.ts`'s `openBook`** and **`src/components/reader/ReaderView.tsx`'s `resume` effect** — the two patterns this slice's renderer half is built out of: a store action that calls the preload, and a component that owns one async per open book.
4. **`docs/invariants/reader.md`** — read the _Reading in the app_ section before touching anything in the reader, and note that its reflow rules are slice 5's while its one stale sentence is Task 5's.

Then: run `./scripts/build-layout-helper.sh` if `helpers/bin/musaeum-layout` is missing, and start at Task 0.
