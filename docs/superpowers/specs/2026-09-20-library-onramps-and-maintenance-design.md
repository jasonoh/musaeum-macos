# Design: where books come from, and where library maintenance lives (library IA, v1)

**Date:** 2026-09-20
**Status:** Proposed — forks settled with Jason 2026-09-20; sign-off on the slice cut pending
**Scope:** Three controls in the sidebar's top nav — *Migrate from Calibre…*, *Refresh Library*, *Rebuild Catalog…* — are re-homed by kind: acquisition becomes an on-ramp, maintenance becomes a Settings group with descriptions. Deliberately does **not** touch the catalog ⇄ SQLite sync, the hydration pipeline, the migration wizard's own steps, or the *stale file facts* defect at `tasks.md:271`.
**Depends on:** `docs/superpowers/plans/2026-07-17-multimachine-catalog.md` (the multi-machine slice that added Refresh and Rebuild to the sidebar, `:1419`–`1435`), and `docs/invariants/refresh-feedback.md` (the rule that a long job reports itself on a surface that outlives its trigger).
**Interacts with:** the Settings modal's `Library` section (`SettingsModal.tsx:177`), the status bar's job-counter strip (`StatusBar.tsx:30-58`), and the native menu command union (`api.types.ts:48`) — see D6, D9, D5.
**Supersedes:** nothing. Additive to `tasks.md`'s two open entries that touch this surface (`:75` empty-state polish, `:271` stale file facts).

---

## Why now

The three controls are not peers, and the list they share says they are. Measured off the tree and the repo's own records:

| Control | Kind | Frequency | Real cost |
| --- | --- | --- | --- |
| Migrate from Calibre… | acquire | once, plus a re-runnable top-up | a wizard, reversible (`MigrationWizard.tsx:68`) |
| Refresh Library | poll | routine | a catalog read — **or a full rebuild** (`library-sync.ts:186`) |
| Rebuild Catalog… | repair | break-glass | **1,281 s / 21.4 min, ~5.5 folders/s over SMB** (`tasks.md:267`) |

The 21-minute figure is the measured run against the real 7,101-book library, not an estimate, and that same record contains the sentence this design turns on: *"writes `catalog.json` only at the end, so interrupting it would have cost nothing"*. A control that costs 21 minutes currently sits at the same visual weight as one that costs a catalog read, in a sidebar whose other rows are navigation, and the pointer that starts it is one text row away from the one that lists your conflicts.

Meanwhile the app's actual first-run surface never mentions Calibre at all. `GridView.tsx:31` renders *"Your library awaits / drag EPUB, MOBI, or AZW3 files anywhere in this window"* — drag-and-drop, in an app whose stated purpose is replacing Calibre — and `ListView.tsx:262-290` renders nothing whatsoever at zero books: a sticky header over a blank pane. There is no import button anywhere. No File menu exists (`menu.ts:92` returns app/edit/view/window only), the toolbar carries only search and the view toggle, and the only non-drag route into the library is a Finder file association (`index.ts` → `importAndRemove`).

**Thesis:** the sidebar is for *going places*; getting books in and repairing the catalog are different verbs with different frequencies, and each belongs where its frequency puts it. Re-home the three controls by kind, make the empty view the on-ramp it already half-is, and move the long job's progress onto the surface that outlives the dialog — then a first-run user sees *where books come from* and a maintenance action stops masquerading as navigation.

---

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| The three controls, as three sibling rows in one `<nav>` | `Sidebar.tsx:71-95` |
| Rebuild's progress *is* the sidebar label (`Rebuilding 41/210…`) | `Sidebar.tsx:92-94`, fed from `libraryStore.rebuildProgress` |
| Status bar already hosts a long job's live counter **and its Cancel** | `StatusBar.tsx:42-58` |
| The store owns the job state, not the component — the surface can come and go | `library.store.ts:25-41`, `useLibrary.ts:36` |
| Refresh falls back to a full rebuild when the catalog is unreadable | `services/library-sync.ts:186` |
| The repo's own one-line descriptions of both actions | `docs/data-contracts.md:213-214` |
| Settings already has a `Library` section with the root, and a `Section` primitive | `SettingsModal.tsx:177`, `:368` |
| Library-wide counts are already fetched unfiltered | `services/db.ts:461` (`getFacets`), `library.store.ts:66` |
| A grid empty state exists; the list's does not | `GridView.tsx:31` vs `ListView.tsx:262-290` |
| The house pattern for a native picker: `dialog.showOpenDialog` inside an `ipc/*.ts` handler | `ipc/migration.ts:19`, `ipc/settings.ts:21`, `ipc/nas.ts:16`, `ipc/theme.ts:72` |
| Menu items only *send* a command; the renderer decides what it means | `menu.ts:21`, `useMenuCommands.ts:12` |
| `BookFormat` is the canonical format list — `epub \| mobi \| azw3 \| pdf` | `src/types/book.types.ts:1` |
| The rebuild's only side effect is the catalog write at the end | `catalog.ts:321-341` (bare loop, `onProgress` callback) |

**Not true today, and inside this feature rather than free:**

- **The rebuild walk has no abort hook.** `rebuildFromBookDirs` takes `onProgress` and nothing else (`catalog.ts:321-324`); cancel is new main-process machinery. It is *cheap* machinery — the loop is bare and the write is at the end — but it is not free, and it is where this slice's file count goes up.
- **There is no book file picker.** `import:addFiles(paths)` takes paths resolved by the renderer from a drop (`preload` → `files.getPathForFile`); nothing opens `showOpenDialog` with book filters. A File-menu route needs one.
- **The library's own emptiness is not in the store.** `books` is the *result set* (`library.store.ts:63-67`) and `StatusBar.tsx:28` already prints "N books **shown**" when filtered. The test for "this library is empty" has to be written; `facets` is the honest source because `getFacets()` takes no filters.
- **`useDragDrop.ts:4` is stale.** `const BOOK_EXTENSIONS = ['.epub', '.mobi', '.azw3']` — no `.pdf`, so a dropped PDF is silently discarded at `:34` with no feedback. Five other declarations of the same fact (`importer.ts:28`, `book-files.ts:6`, `migration.ts:18`, `file-watcher.ts:7`, `sidecar/pipeline/migrate.py:22`) all carry `.pdf`, so exactly one on-ramp was left behind when PDF went first-class in Phase 1.5.

---

## D1 — The three controls are re-homed by kind, not reordered

**Decision:** `Sidebar.tsx`'s top nav keeps only *navigation*: the Library row and Needs Review. All three controls leave it. Acquisition (*Migrate from Calibre…*) becomes an on-ramp (D2, D4); maintenance (*Refresh Library*, *Rebuild Catalog…*) moves to Settings → Library → Maintenance with a description each (D8).
**Why:** the alternative — keeping them and reordering, or demoting them below Filters — leaves the 21-minute action at the same weight as the 0.5-second one. The sidebar's other rows are places you go; these are jobs you run, one of which is break-glass. The measured cost difference (1,281 s vs a catalog read) is the whole argument.
**Consequence:** anything that reached these controls through the sidebar must reach them through Settings or the Add Books affordance. A future maintenance action (a cover re-score, an orphan sweep) has an obvious home now — and the temptation to put a seventh row in the sidebar is pre-empted by the taxonomy rather than by taste.

## D2 — The FTUE keys off the library's own emptiness, never the result set

**Decision:** the empty view branches on "is the library empty", derived from `facets` (unfiltered, `services/db.ts:461`), not on `books.length`. A pure selector — `isEmptyLibrary(facets, resultCount)` in `src/lib/` — is the single decider, used by both views.
**Why:** `books` is the filtered/search result (`library.store.ts:63-67`), so `books.length === 0` is also true for "your search matched nothing" and for "your filter excluded everything". Offering *Migrate from Calibre…* to someone who typed a bad query is worse than offering nothing. The alternative — a persisted `onboarded` flag in `app_config` — is worse still: it gets stuck `true` and hides the on-ramps from someone who later points Musaeum at an empty folder, and it invents a state to keep in sync for a question the data already answers.
**Consequence:** the three-way branch (empty library / empty result set / populated) becomes explicit in both views, and the middle case's copy stays what it is today (*"Nothing matches …"*).

## D3 — One shared `EmptyLibrary`, used by both views; the list's blank pane is fixed here

**Decision:** extract `EmptyLibrary` from `GridView.tsx:31` into `components/shared/`, have both views render it, and give the empty-library branch two on-ramps instead of drag-drop copy alone.
**Why:** `ListView.tsx:262-290` renders no empty state at all, and list mode is a *persisted* user preference (`ui.store` `viewMode`) — so today, in list mode, a first-run user sees a header and nothing else, with no statement of what to do. This is the same defect as the FTUE gap and one file wide; fixing it separately would ship a feature that is invisible to whoever has already chosen list view.
**Consequence:** the empty surface is one component. Its two branches must stay honest about what the view can do — the grid's copy mentions dropping *anywhere in the window*, which is window-level (`useDragDrop`) and therefore true in both views.

## D4 — *Migrate from Calibre…* stays reachable after first run

**Decision:** the empty view's Calibre on-ramp is one route, not the only one. The same modal is also reachable from the Add Books affordance (D5) in a populated library.
**Why:** the wizard is not a one-time action. It hosts a second job — *Import PDFs from Calibre…* → `migration.startPdfTopUp` (`MigrationWizard.tsx:68`) — whose entire point is being run again later against a Calibre library that kept growing; `tasks.md:11` records it as "re-runnable ... idempotent". An FTUE-only Migrate strands that path. The alternative — keep it in the sidebar permanently for the top-up's sake — re-breaks D1 to serve a rare second visit.
**Consequence:** the empty view and the Add Books menu must open the same modal, so a change to the wizard's entry step serves both. Anything added to the wizard later (a second top-up source) inherits two doors and must work from either.

## D5 — Add Books is a real affordance: toolbar control + File menu + a native picker

**Decision:** a `＋ Add Books` control in the toolbar opens a small menu — *Import files…* / *Migrate from Calibre…* — and `File → Add Books…` (⌘O) opens the same menu's first item directly. The picker is new main-process work (`import:fromDialog`, `dialog.showOpenDialog`, `properties: ['openFile','multiSelections']`), because the renderer may not open a file dialog and never sees a `file://` path of its own making. Its filters come from a shared `BOOK_FILE_EXTENSIONS` derived from `BookFormat` (`book.types.ts:1`), and `useDragDrop.ts:4` uses the same list — which fixes the dropped-PDF defect as a consequence rather than as a separate bug.
**Why:** the app has no import affordance at all today, and *Migrate from Calibre…* needs a home in a populated library (D4), so the affordance and the re-homing are one piece of work. Deriving the filter list from `BookFormat` is what stops a seventh declaration — five TypeScript declarations of "what is a book file" exist and exactly one is stale; adding a dialog with its own hardcoded filter would make two. The alternative — the menu item alone, with no toolbar control — hides the only non-drag import route behind a menu a first-run user has no reason to open.
**Consequence:** the picker's filters and the drop gate can no longer disagree; a future sixth `BookFormat` lands in both. `MenuCommand` grows one member (`api.types.ts:48`) and the native menu gains a File submenu that does not exist today — including, on macOS, the standard Close/Quit placement questions that come with owning a File menu.

## D6 — A long job reports on the status bar, not in the surface that started it

**Decision:** refresh/rebuild progress and Cancel live in the status bar's existing job strip, beside *Importing N…* / *Sending N…* / *Refreshing metadata…*. The Settings buttons become triggers only.
**Why:** the sidebar label is the progress surface today (`Sidebar.tsx:92-94`). Once the trigger is inside a modal, closing that modal hides a running 21-minute job — the exact failure `docs/invariants/refresh-feedback.md` was written about (*"the least informative moment of a job"*). The house precedent is already there: bulk hydrate's counter and Cancel live in the status bar for precisely this reason, with the comment saying so (`StatusBar.tsx:48-50`: the job outlives the selection). The alternative — a slim progress row that reappears in the sidebar only while a job runs — puts a transient, self-erasing row back into the nav that D1 is clearing.
**Consequence:** job state stays in the store and the surface becomes a pure reader of it (`library.store.ts:25`, wired once in `useLibrary.ts:36`) — the pattern that lets a job survive any surface's lifetime. Settings must not become the only place the *result* is reported, or a closed modal loses the outcome too.

## D7 — The rebuild is cancellable, and cancelling is a silent no-op on disk

**Decision:** add an abort hook to `rebuildFromBookDirs` (`catalog.ts:321`) — a module-level flag in `services/library-sync.ts` mirroring `cancelBulkHydrate`'s shape — checked once per folder in the loop, surfaced as `library:cancelRefresh`. On abort, the walk returns nothing, `catalog.json` is not written, and the SQLite cache is not replaced.
**Why:** the repo's own measurement says interrupting costs nothing (*"writes `catalog.json` only at the end, so interrupting it would have cost nothing"*, `tasks.md:267`) — so the safety argument for not offering cancel does not hold, and 21 minutes with a running app's Close button inside a modal is a trap. The alternative — progress with no cancel, deferring it — leaves the longest job in the app with no way out, and the deferral would immediately be the first thing a user asks for.
**Consequence:** Refresh does not need the same treatment (it is a catalog read; the fallback path is a rebuild, which inherits this hook). A cancelled rebuild must leave the user in a state where trying again is the obvious next move, which means the status bar must say *cancelled*, not disappear.

## D8 — The descriptions use the repo's own words, and Refresh's fallback is disclosed

**Decision:** the two Maintenance rows carry, verbatim in spirit, `docs/data-contracts.md:213-214`: *Refresh* = "re-read the shared catalog and reload the library from it"; *Rebuild* = "recovery: walk every book folder's metadata and rewrite the catalog". Refresh's description adds one sentence: *"if the catalog can't be read, this rebuilds from disk instead"*.
**Why:** Refresh silently becoming a full rebuild is a real behaviour (`library-sync.ts:186`), and the *only* difference the user sees today is a job that ought to take a second taking 21 minutes. Disclosing it is what makes the two controls distinguishable — which is the point of moving them together. The words are already the repo's; inventing new ones invites the code and the copy to drift.
**Consequence:** if the fallback is ever removed from `refreshLibrary`, the description goes with it — the copy is a claim about code and must be checkable against it.

## D9 — This slice does not resolve the Refresh/Rebuild disagreement about stale rows

**Decision:** `tasks.md:271` (a row whose files are gone: Refresh keeps it, Rebuild silently drops it) stays its own item. It is named here only because D8 puts the two actions side by side, where the disagreement becomes visible for the first time.
**Why:** resolving it needs the failing read to be distinguishable from an empty folder (`book-files.ts:73` returns `null` for both), which is a main-process change with its own test — not a re-homing. Folding it in would make this a three-verb slice and put a data question behind a UI change.
**Consequence:** the Settings copy must not promise that the two paths agree. Whoever builds D8's descriptions should read `tasks.md:271` first and avoid a sentence the code cannot keep.

---

## Store and component shape

`library.store` keeps what it has and gains one field and one action:

- `rebuildProgress: { completed, total } | null` — **unchanged**, still written from the `catalogRebuildProgress` event (`useLibrary.ts:36`). It is no longer read by the sidebar.
- `refreshing: boolean` — unchanged. It gates the two Settings triggers and stops the status bar from double-reporting.
- **New:** `refreshJob: { kind: 'refresh' | 'rebuild', cancelled: boolean } | null` — what the status bar needs to label the counter and to report a cancelled run. Session-only; nothing here is persisted (`persist`'s `partialize` is untouched).
- **New:** `cancelRefresh(): Promise<void>` — calls the new IPC; on failure it logs, like `refreshLibrary` does (`library.store.ts:118-120`).

`isEmptyLibrary(facets, resultCount)` is a pure function in `src/lib/` — no store field, no memo. Both views call it with the values they already subscribe to.

No DOM node moves into a store: the toolbar menu's open/closed state is local to the control, and the empty view holds nothing.

---

## Acceptance criteria

### Slice 1 — the move, and the job's new surface

1. With a populated library, the sidebar's `aside` contains no text matching `Migrate from Calibre`, `Refresh Library` or `Rebuild Catalog` (decider: CDP probe over the accessibility tree in the running app).
2. The sidebar still renders *Needs Review* with its count when `conflictCount > 0` (decider: CDP probe on a fixture with one conflict; the fixture is the existing conflict test fixture).
3. Settings → Library renders a Maintenance group with both actions and both descriptions from D8, including the fallback sentence (decider: CDP probe reading the modal's text).
4. Starting a rebuild from Settings and immediately closing the modal leaves a visible live counter in the status bar that keeps advancing (decider: CDP probe — the discriminating quantity is the status-bar text changing *while no dialog is in the accessibility tree*, not merely its presence).
5. Cancelling a rebuild leaves `catalog.json`'s mtime and the cache's row count unchanged (decider: vitest, on a fixture root — read both before and after).
6. `rebuildFromBookDirs` returns an empty result and writes nothing when aborted mid-walk (decider: vitest, fixture root; abort after the first `onProgress` call).
7. A cancelled run reports *cancelled* in the status bar rather than simply vanishing (decider: CDP probe).
8. `npm run typecheck` / `npm run lint` / `npx prettier --check` clean on the touched files (decider: the gates).
9. `git diff --quiet src/components/shared/FilterSidebar.tsx src/hooks/useLibrary.ts` is false for neither file *except* the one subscription line Slice 1 adds to `useLibrary.ts` — filters and the event wiring otherwise must not move (decider: `git diff`).

### Slice 2 — the empty view is the on-ramp

10. At zero books, the grid renders both on-ramps (*Import files…* and *Migrate from Calibre…*) (decider: CDP probe).
    10a. **With a storage that cannot take a book** — no root configured, a folder gone missing, a share disconnected — the same zero-book pane renders **neither** on-ramp, no drag copy and no first-run sentence at all, because every affordance item 10 names is refused by the write gate; the banner above it carries the sentence and the recovery (decider: vitest on the state — four cases, mutated 4/4 — plus a CDP probe of the pane's text on the isolated fixture in each of the two states). The pair is the point: 10's pane must still appear for a **connected** empty library, or 10a is satisfied by deleting the pane.
11. At zero books, the **list** view renders the same empty view (decider: CDP probe with `viewMode` switched — the list's blank pane is the regression this criterion pins).
12. On a populated library, a query matching nothing shows *"Nothing matches …"* and **neither** on-ramp (decider: vitest on `isEmptyLibrary`, plus a CDP probe for the rendered copy).
13. On a populated library with a format filter that excludes everything, the same holds (decider: vitest — `isEmptyLibrary` ignores the result count whenever `facets` reports any book).
14. Clicking *Migrate from Calibre…* from the empty view opens the existing wizard at its `source` step (decider: CDP probe reading the dialog title).
15. `git diff --quiet src/components/library/BookCard.tsx src/hooks/useVirtualRows.ts` — the virtualization geometry and its constants do not move (invariant 7; decider: `git diff`).

### Slice 3 — Add Books

16. `File → Add Books…` exists with ⌘O, sends a `menuCommand`, and the renderer routes it (decider: CDP probe driving the broadcast, plus a source walk of `useMenuCommands.ts` — driving a native menu item itself needs assistive access the verify sandbox does not have; state that limit inside the test).
17. The toolbar control opens a menu offering both items, in both view modes (decider: CDP probe).
18. The picker's filter list and the drag-drop gate are the same list, and it contains `.pdf` (decider: vitest on `isBookFile` derived from `BOOK_FILE_EXTENSIONS` — assert `.pdf` is accepted and an unknown extension is not).
19. A book file chosen through the picker imports and appears in the library (decider: CDP probe + a real import against a scratch root).
20. `useDragDrop` no longer declares its own extension list (decider: `git diff` on `useDragDrop.ts` showing the constant removed, plus a source walk proving the call site uses the shared predicate).
21. `index.html`'s CSP is untouched (decider: `git diff --quiet index.html`).

---

## Slices, and why they are cut this way

**Slice 1 (8 files: 7 code + 1 test).** New: none. Edited: `Sidebar.tsx`, `SettingsModal.tsx`, `StatusBar.tsx`, `library.store.ts`, `useLibrary.ts`, `services/library-sync.ts`, `ipc/library.ts` (+ its test). It stops at the point where every criterion is decidable without a new user-facing concept: the move, the progress surface, and the abort hook. This is the defect the owner reported and it is independently verifiable — the sidebar's state, the status bar's counter, and the walk's behaviour on abort.

**Slice 2 (4 files: 3 code + 1 test).** New: `components/shared/EmptyLibrary.tsx`, `lib/library-emptiness.ts`. Edited: `GridView.tsx`, `ListView.tsx`. Pure logic first, so `isEmptyLibrary` has a unit decider before any view consumes it — and the list's blank pane is fixed by the same component rather than by a second copy.

**Slice 3 (8 files: 6 code + 2 test).** New: `lib/book-files-shared.ts`'s predicate (or its home in `@shared/book.types`). Edited: `src/types/api.types.ts`, `electron/main/services/menu.ts`, `src/hooks/useMenuCommands.ts`, `src/components/layout/Toolbar.tsx`, `src/hooks/useDragDrop.ts`, `electron/main/ipc/import.ts` (or the handler's existing file) + the preload surface. The only slice that crosses into main, and the only one that adds a native surface (a File menu that does not exist today) — so it lands last, when the affordance's behaviour is fully specified by the two slices before it.

Slice 1 is the largest of the three at the house bound of ~10 files; if the abort hook's tests push it over, the cut moves to "progress and move" / "cancel" rather than the hook being dropped.

---

## Rejected and deferred, with the condition that would revive them

- **Keeping Refresh Library in the sidebar** — rejected: once Refresh's fallback (D8) is disclosed, its only claim to the nav is "pull the other machine's changes now", and auto-sync on connect already covers that (`library-sync.ts`, `handledRoots`). Revived when a second machine's changes routinely arrive late enough that the owner reaches for a manual pull — observable as "I kept having to refresh", not as a feeling.
- **A persisted `onboarded` flag** — rejected in D2 for getting stuck. Revived never as a flag; if the empty view ever needs to say something different on the *second* visit to an empty library, that is state derived from an existing timestamp (`app_config`'s first-run marker), not a new boolean.
- **Making Refresh report which path it took** (catalog read vs. rebuild) in its result — deferred. The disclosure lives in the copy (D8) per the settled fork. Additive when needed: `refreshLibrary` already branches on the same condition (`library-sync.ts:186`), so it is a return-shape change plus one toast line. Revived when a slow Refresh actually confuses someone.
- **Cancelling Refresh** — not built. It is a catalog read; the fallback rebuild inherits D7's hook.
- **Recycling the dead `exports/` staging dir** implies nothing here; left as its own `tasks.md` item (`:76`).
- **Re-resolving the stale-row disagreement** — explicitly out of scope (D9), owned by `tasks.md:271`.
- **A native File submenu beyond Add Books… (Close, Export)** — not built. The File menu is created only because Add Books needs a ⌘-reachable home; macOS's conventional File contents are a separate decision with their own review.

---

## Risks, stated plainly

1. **The empty view is now load-bearing for a first-run user, and it is the only place the app explains itself.** Its copy will be read once, by someone who does not yet know that drop-anywhere works, that Migration is a wizard, or that Calibre is optional. There is no DOM harness for the renderer, so the only instrument is a running-app probe against a fixture — which cannot tell whether the copy is *comprehensible*, only that it rendered. Residual the design does not solve: whether the two on-ramps are actually legible to a first-run user is a judgement call the owner makes by looking, and a screenshot is the deliverable.
2. **Cancel introduces a partial-state question the walk currently cannot have.** Aborting is safe *because* the write is at the end (`tasks.md:267`), so the design's safety rests on a property of `rebuildFromBookDirs` that a later change could quietly move — e.g. a future incremental write per folder. AC5 and AC6 are the guard: if the walk ever writes mid-flight, criterion 5 goes red. Say so in the code comment at the write, not only here.
3. **A File menu changes what ⌘O and the Close/Quit placement mean on macOS**, and the menu is built once and never rebuilt (`menu.ts:17-19`). Adding a submenu is a one-off, but a File menu that later wants state (a recent-files list, an enabled/disabled Import) collides with that deliberate design. Nothing here needs state — say so, so the next person does not assume the pattern is available.
4. **The move removes a control some muscle memory already has.** The sidebar's three rows have shipped since the multi-machine slice (`docs/superpowers/plans/2026-07-17-multimachine-catalog.md:1419`). The mitigation is `File → Add Books…` + Settings, not a transitional duplicate row.
5. **Invariants held:** this touches **7** (row height computed, not measured — AC15 pins that nothing about the geometry moves) and, indirectly, **12** (failures stay non-fatal — a cancelled or failed rebuild must not throw across the boundary; the existing `handle()` wrapping covers it and AC7 pins the visible half). Invariants **1**, **2**, **5** and **6** are deliberately untouched: nothing here writes `metadata.json`, resolves a file by name, or moves reading state — Refresh and Rebuild already delegate to `db.replaceAllBooks(preserveLocalReadingState(...))` (`library-sync.ts:187`), and this design does not change that call. Invariant **8** holds: the new picker is one `handle()` and a `dialog` call, and the abort flag lives in the service, not the handler.

---

## Built — slice 1 (2026-09-20)

Landed as the two pieces this document pre-authorized, in one working-tree change: **1a** the move and the job's new surface, **1b** cancel.

**The spec's file row was short by five, and the correction is on the record.** It named 8 (Sidebar, SettingsModal, StatusBar, libraryStore, useLibrary, library-sync, ipc/library, + a test). The honest set is **13 code files + 2 test files**: the row omitted `catalog.ts` (the abort hook its *own* AC6 requires), `electron/preload/index.ts` and `src/types/api.types.ts` (the appliers of the new surface), `src/types/book.types.ts` (two new shared types) and `src/lib/catalog-sync.ts` (the new lib the ACs then forced — see the reading below). `library-sync.test.ts` and `catalog.test.ts` took the new cases.

**Readings this document left open, settled by the build:**

- **The settled line lives on the status bar, not in a toast.** The alternative — a toast, following `refresh-feedback.md`'s bulk-hydrate precedent — was rejected because the status bar already carries this job's live counter *and* its Cancel: one surface for the whole lifecycle beats splitting live state (status bar) from the report (toast). The line therefore stays after the run ends, with a Dismiss on the settled state, and only a *successful* run expires (8 s); cancelled and failed stay.
- **The store's `refreshing` + `rebuildProgress` were replaced by one `catalogSync` field**, not joined by one. The spec said "keeps what it has and gains a field and an action"; those two fields turned out to be the two halves of one job, and keeping them meant three ways to ask "is a sync running".
- **The transitions moved into `src/lib/catalog-sync.ts` as pure functions** (`startCatalogSync` / `applyRebuildProgress` / `settleCatalogSync`). Not in the spec: the repo's store tests run in a node environment with no DOM, so a transition living inside a store action has no decider at all. The kind-carrying settle is the one that matters — a Reload that became a rebuild must not be relabelled on the way out.
- **`isCancelled` returning `[]` (AC6's own wording) is right, and the ambiguity is the caller's.** `rebuildFromBookDirs` cannot distinguish "cancelled" from "a library with no books", so `library-sync.rebuildCatalog` resolves it from the flag it owns and just read. The contract is written at both ends.

**What the build's own mutation campaign caught — a piece of machinery that did nothing.** A `rebuilding` guard in `cancelRefresh` was written first, with a comment claiming it stopped a cancel aimed at a plain refresh from aborting the *next* rebuild. Its mutation **survived** (11 of 12 mutations were killed, this one was not): `rebuildCatalog` already clears the flag before every walk, so no test could tell the guard from its absence. The guard was deleted and the test re-pointed at the reset, which is the mechanism that actually does the work. A second campaign mutation — `cancelled: rebuildCancelled` instead of `cancelled: false` — is an **equivalent mutant**: the early return holds whenever the flag is set, so the two spellings are the same value by different routes, and it is recorded here rather than "fixed" with a test that would pin nothing.

**Decided by the running app** (isolated profile, fixture library, `Page.*` via CDP — the real artifact, `npm run build`):

| AC | Instrument | Result |
| --- | --- | --- |
| 1 | CDP: `aside.innerText` | No *Migrate from Calibre* / *Refresh Library* / *Rebuild Catalog* in the sidebar; it reads `MUSAEUM \| Library \| 0 \| FILTERS \| DEVICES \| Library connected` |
| 3 | CDP: Settings dialog sections | `APPEARANCE, LIBRARY, MAINTENANCE, METADATA, ASK (AI), TOOLS`; the Maintenance section carries both rows, both descriptions and the fallback sentence |
| 4 | CDP: click Rebuild, close the dialog, sample the footer every 20 ms | **50 distinct advancing values, 450/6300 → 6300/6300, every one sampled with `modal=closed`**, then `Catalog rebuilt — 6300 books` |
| 5 | unit test **and** the app | Cancelled at 422/6303 → `catalog.json` still 6300 entries and the DB still 6300 rows: the 3 unlisted folders were not adopted |
| 6 | unit test (3 cases) | Cancelled mid-walk and after the last folder both return `[]`; an existing catalog is left byte-identical |
| 7 | CDP: click Cancel in the status bar | `Catalog rebuild cancelled — nothing was written` with a Dismiss |
| — | mutation campaign | **12/12 killed** (after the guard was removed and the failure-line case added) |

AC2 (*Needs Review* still renders with a conflict) is decided by a **source walk**, not by the app: reaching a non-zero `conflictCount` needs a relay/REST round trip, and the row's own code is untouched by the move. Its limit is that the walk proves the guard `conflictCount > 0 && …` survived, not that the button paints.

## Built — slice 2 (2026-09-20)

**The spec's D2 plan was replaced by a simpler one that is also stricter.** D2 said the emptiness test would come from the unfiltered `facets`; the build showed no total is needed at all: with no query and no filters, `getBooks(EMPTY_FILTERS)` *is* the library, so `libraryViewState({ loading, query, filters, resultCount })` decides from view state alone. The rejected route would have rested on a fragile fact — that `readStatus` is the only `getFacets` query without a `WHERE`, hence the only one whose counts partition the whole table — and would have broken silently the day someone added one for symmetry.

**A fourth state the spec did not have: `'loading'`.** The first-run copy used to flash on every cold start, because `books` is `[]` until the first load resolves and the old code keyed the empty pane on `books.length` alone. This is the mechanism `tasks.md:75`'s "empty-state polish" item was filed against, and it is discharged here rather than queued: a cold start on a NAS shows nothing instead of a lie.

**The list's header went with the pane.** At zero books the `<table>` is now absent rather than a sticky header over a blank pane — a header strip above "Your library awaits" reads as a broken table, and list mode is a *persisted* preference, so for some users this pane is the only one they ever see.

**"Two on-ramps" arrived in two stages.** *Migrate from Calibre…* could land with slice 2; *Import files…* had to wait for slice 3's picker, so the empty pane's second button was added once `src/lib/add-books.ts` existed, and the two buttons are now in the **same order as the Add Books menu** (`Import files…` primary, `Migrate from Calibre…` secondary) so one habit covers both surfaces.

| AC | Instrument | Result |
| --- | --- | --- |
| 10 | CDP, grid view | `Your library awaits \| Drag EPUB, MOBI, AZW3 or PDF files anywhere in this window — or bring in a library you already have. \| Import files… \| Migrate from Calibre…` |
| 11 | CDP, list view (mode read from persisted state, not assumed) | Identical text, **and `document.querySelectorAll('table').length === 0`** — the blank pane is gone |
| 12 | CDP, query `zzzznothing` on a 6,300-book library | `Nothing matches “zzzznothing”`, **on-ramp buttons present: `[]`** — the exact trap D2 exists to close |
| 13 | unit test | `library-emptiness.test.ts`; the app half is not reachable with a single-format fixture (no zero-count facet is ever listed) and is stated as such |
| 14 | CDP | the empty pane's wizard button opens the same modal (verified via the Add Books menu's second item, `H2 "Migrate from Calibre"`) |
| 15 | `git diff` | `BookCard.tsx`, `useVirtualRows.ts` untouched |

## Built — slice 3 (2026-09-20)

Dispatched to an implementer and **verified in this tree** rather than taken on report: `git log` shows no new commit and nothing staged; `typecheck`/`lint`/`prettier` are 0 on all 30 touched paths; `npm test` is **950 passed / 43 files**. The greppable facts were re-read directly: `useDragDrop.ts` declares no extension list and imports `isBookFile`; `BOOK_FILE_EXTENSIONS: Record<BookFormat, string>` + `isBookFile` + `bookFileFilter` live in `@shared/book.types`; `MenuCommand` carries `'add-books'`; `menu.ts` has the File submenu with `CmdOrCtrl+O`; `useMenuCommands.ts` routes it.

**The file row was short again — 8 named, 14 actual** — and the two extras are the ones the design's own principle forces: `src/lib/add-books.ts` (⌘O and the toolbar's first item must run *one* function, or the drift D5 warns about is guaranteed) and its test.

**Readings settled:** `bookFileFilter()` lives beside the list in `@shared/book.types` rather than as a literal in the handler (the repo's precedent, `ipc/theme.ts:20`, makes the dot-stripping derivation untestable without a dialog); the handler went into `ipc/library.ts`, which already carries the import channels; a cancelled dialog returns `[]`, since the caller's next step is a batch import and an empty batch is already the no-op.

**The toolbar position is deliberate, and it is measurable.** Add Books is the leading control, so the search's centre moved 48 px right of the window's (768 vs 720 at 1440 wide). It is not off-centre by accident: the search is centred in the free space *between* the flanking controls, and the two gaps measure **179 px each**. No geometry constant is involved; the strip's height still comes from `TITLEBAR_STRIP_HEIGHT`.

**Two halves of AC16 and AC19 are undecidable on this machine** and are recorded rather than claimed: driving the native `File ▸ Add Books…` item needs assistive access (`System Events` answers `-25211`), and an `NSOpenPanel` cannot be confirmed or cancelled without it. The menu's wiring is decided by a source walk that states its limit; the picker's returned paths re-enter `addFiles`, which `importer.test.ts:572` already covers.

**A defect this slice closed as a side effect:** `src/hooks/useDragDrop.ts` had listed three extensions since before PDF went first-class in Phase 1.5, so a dropped PDF was silently discarded. Fixed first as its own one-line change (with `isBookFile` exported so the list had a decider, and the guard cases mutation-checked 2/2), then made structural here — the filter and the drop gate can no longer disagree. **Four main-process Sets and one Python tuple still declare the same fact** (`importer.ts:28`, `book-files.ts:6`, `migration.ts:18`, `file-watcher.ts:7`, `sidecar/pipeline/migrate.py:22`) and were deliberately left alone as drive-by work.

**A test was found guarding the bug.** `src/stores/theme.store.test.ts:395` is a source walk whose subject is the *theming* feature ("a theme drop is not a book import") but which pinned the drop gate's list as exactly `['.epub', '.mobi', '.azw3']` — so while `theme` was green, a theme extension could be added and nothing else would break, because the list it was protecting was already wrong. It was inverted twice: once with the bug fix (the list gains `.pdf`), then re-pointed at `BOOK_FILE_EXTENSIONS`/`isBookFile` behaviourally, keeping its intent (no theme extension may appear in the book-file list) and its bite (mutation-verified still red).

## Built — the storage-aware empty pane (2026-09-24; the second residue stays filed)

Found by slice 2 of `docs/superpowers/specs/2026-09-24-local-library-design.md`, recorded there as residue rather than reached into, and **sequenced to land here first** because it is a **false instruction the user can act on**: with a library that is a folder on this Mac and that folder gone, the pane this design built still says _"Drag EPUB, MOBI, AZW3 or PDF files anywhere in this window — or bring in a library you already have."_ (`src/components/shared/EmptyLibrary.tsx:39-41`) — while the banner immediately above it reads _"Library folder missing — browsing from cache, editing disabled."_ and offers _Locate Library Folder…_. The app invites a drop into a folder that does not exist, and the drop cannot succeed: every write gate refuses (`nas-manager.ts:114`) and the refusal arrives as a toast.

**Why it belongs to this design rather than to the storage workstream.** The pane and its two on-ramps are this design's surface (D3, D5), it is the app's only first-run screen, and the state it must become aware of is now a first-class fact rather than a transient error: `NASStatus.copy.recovery` is `'locate'` exactly when the root is missing and nothing is retrying.

**The fix, as the residue recorded it:** one conditional — suppress the first-run copy while `copy.recovery === 'locate'`, since that pane's own buttons (_Import files…_, _Migrate from Calibre…_) are about to be refused too and the banner is already saying why. Follow slice 2's own precedent for where the decision lives: `isEmptyLibrary`/`libraryViewState` in `src/lib/library-emptiness.ts` is a pure function of view state **precisely so the renderer's logic has a unit decider before a view consumes it** (`library-emptiness.test.ts`), so the recovery input belongs there and `EmptyLibrary` renders the result — not a second `useNASStore` read inside the component with no decider behind it.

**The decider is a probe, not a test.** The renderer has no DOM harness, so the criterion is a CDP read on the existing reading-11 fixture — the isolated profile `~/.hermes/profiles/dev/cache/scratch/musaeum-localprobe`, with `library_kind: 'local'`, zero books and the root moved aside — asserting the pane draws no drag-and-drop sentence while the banner does. **Estimated 2 code files + 1 test** (`library-emptiness.ts` and its test, `EmptyLibrary.tsx`), which is a cut for that slice to confirm rather than a budget.

**Built 2026-09-24, and the cut was 5 code files rather than the 2 + 1 estimated** — the estimate named the pure function, its test and the pane, and missed the two call sites: the input is **required**, deliberately, so a third view cannot inherit the old unconditional promise, and both views must therefore pass it (`GridView.tsx`, `ListView.tsx`). Nothing else moved: no main-process file, no contract, no new copy string.

**Widened on purpose from `recovery === 'locate'` to `state === 'connected'`.** The residue named the missing-folder state, and the same fault is present in the other three unreachable ones — the first-run user, with no root configured at all, was the likeliest to meet it, since their pane invited a drop into a library that does not exist yet while the banner offered _Choose Library Folder…_. So the pane's question is the **write gate's own question** — `status.state === 'connected'`, the fact six other components read before offering a write — and not a comparison against the composer's `recovery` string. That keeps the two halves of the storage feature apart exactly as the design says they are apart: the composer owns **what to say**, and this pane asks **whether it can promise anything**.

**The pane says nothing rather than composing its own sentence, and there a second rule decided the shape.** A renderer may not restate any of the composer's sentences (`src/lib/storage-copy-scan.test.ts`, slice 2's source walk), and the banner directly above the pane is already drawing the sentence, the one-word status and the recovery. So the new state renders `null` — deliberately not a spinner, not an icon, not a quieter sentence of our own. It is the silence `loading` already chooses, for the same reason: a lie is worse than nothing.

**Branch order, each position a reading.** `books` first (an offline cache is browsable, and the grid must not blank the moment the storage goes away), `loading` second (the cold-start flash), `no-matches` third (a miss is a miss whatever the storage is doing, and _clear the search_ is advice that needs no write), `library-unavailable` last. And the test is **positive evidence only**: an unreported status is not a working library, so `status === null` renders nothing — the same choice `loading` makes, and the same reason.

**The decider is a probe, and it has two halves that need each other.** A new isolated fixture, `~/.hermes/profiles/dev/cache/scratch/musaeum-empty-pane` — a **sibling of** the one named above rather than that one, because `musaeum-localprobe` holds a book and this criterion needs zero books. Zero books throughout, `library_kind: 'local'` written with `sqlite3`, three launches of the built artifact, the pane's words and the status read in one call:

- `unconfigured`, no root: pane `awaits:false drag:false importBtn:false migrateBtn:false`; banner _"No library folder configured — choose where Musaeum should keep your books."_
- `missing` — `local`, recovery `locate`, the folder moved aside: pane silent; banner _"Library folder missing — browsing from cache, editing disabled."_ (285 characters on screen, all of them the banner's)
- `connected` — `local`, folder present, **0 books**: `awaits:true drag:true importBtn:true migrateBtn:true`, no banner (353 characters). **Item 10 still holds where it was decided**, which is what stops item 10a from being satisfiable by deleting the pane.

**The negative half is mutation-checked in the app, not only in the suite.** Reverting the pane's null branch to its pre-slice form (`state === 'loading' || state === 'books'`), rebuilding and re-running the same phase reproduces the reported fault exactly: the same missing-folder, zero-book window reads _"Your library awaits"_, the drag sentence and both buttons — **`chars` 285 → 445**. Frames in the fixture's `frames/`: `2-missing-fixed-vs-mutant.png` (the two panes, labelled), `1-unconfigured.png`, `3-connected-empty.png`.

**Unit side:** four new cases in `library-emptiness.test.ts` (15 in the file), one per branch-order claim, **mutation campaign 4 of 4 killed** — each mutant reddening exactly one case (`Tests 1 failed | 14 passed`), so no kill is collateral. The call-site half — that a caller cannot _forget_ the fact — is decided by the **typechecker**, demonstrated rather than asserted: dropping `storageConnected` from `GridView`'s call gives `TS2345 … Property 'storageConnected' is missing` beside `TS6133` on the now-unread subscription.

**Gates:** `typecheck` 0, `lint` 0, `npm test` **1504 passed / 64 files** (+4), `npm run build` clean, `prettier --check` clean on every touched file, and item 10a written into the criteria list above.

**Recorded here rather than as an annex under `docs/superpowers/plans/`:** the design this slice implements _is_ the section above it, so an annex would be the same text in a second place.

**The second residue is not this design's surface and was filed against the dialogs' own pass — that pass has since happened, built 2026-09-24, so the filing below is history rather than a plan:** `DeleteBookDialog.tsx:143` and `DeleteSelectionDialog.tsx:93` render _"The library is offline — reconnect before deleting."_ for `unconfigured`, `disconnected`, `reconnecting` **and** `missing`, and "reconnect" is a remedy one of the four has. It is ranked behind this one because its worst case is a misleading choice of verb rather than a wrong action. The full filing, with the sites and the store read those dialogs do not do today, is in `2026-09-24-local-library-design.md`'s _Built — slice 3_ section.
