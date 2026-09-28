# Bookshelves — slice 2: the shelf UI in the renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shelves are usable on the Mac. A sidebar section lists them with counts and creates, renames and deletes them in place; opening one scopes the view, the search and the filter counts to it and switches the sort to *Date Added to Shelf*; **Library** leaves it and restores the sort that was on screen before; books go on and come off from both context-menu scopes, the selection panel and the detail panel's chips, with a Remove-vs-Delete choice inside a shelf and an Undo that puts members back where they were — with **no main-process change, no IPC change, no preload change and no REST change**.

**Architecture:** `library.store` gains the scope (`activeShelfId`) and the library's own sort (`librarySort`), and every read in `load()` carries the scope. A new `shelves.store` holds the list, one book's shelves and a `revision` counter; `useLibrary` — the existing event hook, mounted once in `App.tsx` — is the single subscriber to `shelves:changed`, so every write (here, over REST, or by adoption) lands through one path. `src/lib/shelf-membership.ts` owns the add/remove/Undo pair so five surfaces cannot drift; `src/lib/shelf-feedback.ts` owns "one sentence, once a session". The empty pane gains a state rather than a special case, and the trash entry points funnel through two store actions that ask the shelf first.

**Tech Stack:** React + TypeScript strict, Zustand, Tailwind (design tokens only), vitest in the `node` environment (`npm test`). No DOM harness exists in this repo — see *Global Constraints* for what decides what.

**Spec:** `docs/superpowers/specs/2026-09-27-bookshelves-design.md`. Read **D7, D8, D9**, *Error handling*, and **Slice 2's acceptance criteria (AC16–AC23)** before starting any task. Read `docs/invariants/library-views.md` (invariant 7, the sort SQL, the empty-pane ladder), `docs/invariants/settings-and-editing.md` (persisted UI state — note 1 lands here), `docs/invariants/selection-and-keyboard.md` (the prune) and `docs/invariants/shelves.md` (what the service guarantees — note 2 is a claim about *its* contract) too. Slice 1's plan is at `docs/superpowers/plans/2026-09-27-bookshelves-slice1.md`; its *Handoff notes for slice 2* section is restated below in full, because a fresh session will not have read it.

---

## Where this plan sits

Slice 2 of six, and the only slice that is `src/` only. The six, with what remains: slice 3 is drag-and-drop (`src/lib/book-drag.ts`, `BookCard`, `ListView`, the shelf rows as drop targets — **the shelf rows this slice draws are what it drops onto**), slice 4 is *Send to ‹device›* (one more item in the shelf menu this slice builds), slice 5 is the REST contract, slice 6 is the phone in its own repository. Nothing here waits on 3–6, and 3 depends on this.

**The baseline this plan was written against:** `71fff98` (2026-09-27), Node v26.8.1, npm 11.19.0 — `npm run typecheck` clean, `npm run lint` clean, `npm test` = **77 files, 1723 passed, 2 skipped**. Every count below is that tree's.

**Four files are another session's uncommitted work** — a 0.1.0 → 0.5.0 version bump: `package.json`, `package-lock.json`, `docs/rest-api.md`, `electron/main/services/api/shape.test.ts`. They are **not** this slice's. Stage by name in every commit (never `git add -A`), and leave them modified.

---

## The two notes slice 1 handed forward, and where they land

These are the reason this plan exists in the shape it does. Both are stated with the evidence, because both are the kind of rule that looks like a detail until a book lands on the wrong shelf.

### Note 1 — never save *Date Added to Shelf* as the persisted library sort

**What slice 1 left behind.** `isBookSort` (`src/types/book.types.ts`) now accepts `shelf_added`, and `library.store`'s `merge` restores a persisted sort through it:

```ts
merge: (persisted, current) => {
  const { sort } = (persisted ?? {}) as { sort?: unknown }
  return isBookSort(sort) ? { ...current, sort } : current
}
```

**Why that is now a trap.** `partialize: (s) => ({ sort: s.sort })` writes *the effective sort*. With a shelf open the effective sort **is** `shelf_added desc` (D8: "Opening a shelf sets the sort to `shelf_added desc`"). So the next time the user is inside a shelf, the app writes a shelf sort into `musaeum.library` as if it were a preference — and on the next launch, with no shelf open, the library comes back sorted by a shelf's membership. D8's sentence is exact: "leaving it restores the library sort, **which remains the only persisted sort**".

**Where it lands.** Task 2, in `src/stores/library.store.ts`: the state splits into `sort` (the effective sort — what every read and the toolbar use) and `librarySort` (the library's own, the only one persisted, what leaving restores), `persistedLibraryState` becomes the exported decider (the `persistedUIState` pattern in `ui.store`), and `restoredSort` refuses a stored `shelf_added` — which is 1's own follow-on clause, "a restored `shelf_added` (from a build that did) treated as the library default". The case for it is Task 2's, and it is the one case in this slice that a reviewer should read first.

### Note 2 — check the timestamp an Undo passes back

**What slice 1 left behind.** `removeBooks` answers with what it removed, timestamps included, and the preload's own doc says so (`src/types/api.types.ts:157`):

```ts
/** Resolves to what was removed, timestamps included — hand it to `restoreBooks` to Undo. */
removeBooks(id: string, bookIds: string[]): Promise<ShelfMembership[]>
restoreBooks(id: string, memberships: ShelfMembership[]): Promise<void>
```

`ShelfMembership` is `{ bookId: string; addedAt: string }` (`src/types/shelf.types.ts:23-26`) — **camelCase** on the bridge; `added_at` is the *file's* spelling (D1). Slice 1's AC5 holds the main-process half: "`removeBooks` then `restoreBooks` round-trips the original `added_at` values exactly".

**Why it needs checking, not assuming.** Three ways the renderer can lose the position AC22 promises ("Undo restores membership and position under *Date Added to Shelf*") while every call still happens:

1. **Re-stamping.** Building the undo payload with a fresh clock (`addedAt: new Date().toISOString()`) restores the membership but moves it to the top of the shelf. Nothing errors.
2. **Key translation.** Handing back `{ bookId, added_at }` — the file's spelling, which the surrounding vocabulary uses in five other places — leaves `membership.addedAt` undefined, and `isMembership` requires it non-empty. Main **skips** such an entry (the restore is partial by design, not an error), so the Undo silently restores fewer books than it removed.
3. **Rebuilding through a filter.** `removed.map(...)`, a `Set` round-trip, or dropping an entry whose timestamp looks odd all quietly shrink the list.

In all three, `restoreBooks` resolves `void` and the toast says *"Removed 3 from To Read"* either way. So the renderer's whole job is **pass-through**, and that is what Task 11's case asserts: the argument main receives is *identical* to what main answered with — same array, same order, same values, including a timestamp that main will itself skip.

---

## The other two notes slice 1 handed forward, restated

- **`shelvesChanged` is the only shelf signal.** It is broadcast by every shelf write, by adoption, and by a book delete whose prune ran (`mutate`) — and *not* by `libraryChanged`, which is not a reason to re-read shelves. Task 5 wires exactly one subscriber.
- **The unreadable-file refusal is one sentence, surfaced once per session.** De-duplication is the renderer's (the spec's *Error handling* row); `ui.store.notify` only drops an identical pair while that toast is still on screen — 12 s later the next click says it again. Task 6 builds the session's memory, and Task 6's third case is the one that keeps it honest: main's sentence, verbatim, never reworded.

---

## How the slice is cut, and why there are three parts

The spec's slice 2 list reads as one paragraph, and counting it against CLAUDE.md's ~10-file bound shows why it does not stand as one part: the store scope, the sidebar, the sort control, the placeholder, the empty pane, the picker, the context menu, the selection panel, the chips, the remove dialog, the routing, two `src/lib` modules and the docs — **21 code files**. The spec's own instruction applies ("the plan should confirm the counts and split further if either exceeds it"). It splits along the three seams that already exist in it: *what a shelf is* (state), *what the sidebar does* (chrome), and *what happens to a book* (writes).

| Part | What it lands | Code files | Route |
| --- | --- | --- | --- |
| **2a — the scope** (Tasks 1–5) | `resultSetIdentity`'s shelf member, `library.store`'s scope/sort/persistence rule, `shelves.store`, the `shelves:changed` wiring | `src/lib/resultSetIdentity.ts`, `src/components/library/GridView.tsx`, `src/components/library/ListView.tsx`, `src/stores/library.store.ts`, `src/stores/shelves.store.ts` (new), `src/hooks/useLibrary.ts` — **6** | `renderer-engineer` |
| **2b — the sidebar and the chrome** (Tasks 6–10) | the failure reporter, the empty-shelf state, `ShelfList`, the Library row as navigation, the sort control, the placeholder | `src/lib/shelf-feedback.ts` (new), `src/lib/library-emptiness.ts`, `src/components/shared/EmptyLibrary.tsx`, `src/components/layout/ShelfList.tsx` (new), `src/components/layout/Sidebar.tsx`, `src/components/layout/Toolbar.tsx`, `src/components/shared/SearchBar.tsx` — **7** | `renderer-engineer` |
| **2c — the book paths** (Tasks 11–15) | the add/remove/Undo module, the picker, the menu entries, the chips, the Remove-vs-Delete dialog and the trash routing | `src/lib/shelf-membership.ts` (new), `src/components/library/ShelfPicker.tsx` (new), `src/stores/ui.store.ts`, `src/App.tsx`, `src/components/library/BookContextMenu.tsx`, `src/components/library/SelectionPanel.tsx`, `src/components/library/BookDetail.tsx`, `src/components/library/ShelfRemoveDialog.tsx` (new) — **8** | `renderer-engineer` |
| **docs** (Task 16) | `docs/invariants/shelves.md`, `settings-and-editing.md`, `library-views.md`, `docs/architecture.md`, `CHANGELOG.md`, `tasks.md`, the spec's *Status* line | markdown only | the orchestrator |

Each part ends green (`npm run typecheck && npm run lint && npm test`) and gets its own review before the next starts. 2b depends on 2a; 2c depends on both.

**Out of scope here, and where it goes:** drag and drop (slice 3 — including every `onDragOver`/`onDrop` and the `+`-as-drop-target that creates a shelf from a drag), *Send to ‹device›* in the shelf menu (slice 4 — Task 8 builds the menu without it, and the item slots in above *Delete Shelf…*), every REST change and `scripts/api-smoke.sh` (slice 5), the phone (slice 6). **No file under `electron/` and no file under `sidecar/` changes in this slice.** `src/types/` does not change either: D6's preload surface and `ShelfSummary`/`ShelfMembership` already carry everything these five parts need.

**Two files outside the spec's slice-2 list, and why:** `src/lib/resultSetIdentity.ts` and the two views' `resultSetKey(...)` calls. The key is what tells the virtualized views "the result set changed, reset the anchor". Switching shelves changes which rows a query, filter set and sort address while all three of those stay equal — without the shelf in the key, moving from *To Read* to *Sci-Fi* leaves the reader's scroll position pointing into a different list. `library-emptiness.ts` and `EmptyLibrary.tsx` are the spec's own ("an empty shelf's view body reads…") but were not in its file list; they are counted above.

---

## Readings this slice must settle itself, each with the alternative it beats

The spec fixes the behaviour; these are the places where it stops short, and each one is recorded here rather than discovered mid-task. None of them changes an acceptance criterion.

### R1 — inside a shelf, the sort is the shelf's own

D8 says opening a shelf sets `shelf_added desc` and "leaving it restores the library sort". It does not say what a sort change made *inside* a shelf does to the remembered library sort. **The alternatives:** (a) `librarySort` is written only while the library itself is on screen, so a sort chosen inside a shelf lasts as long as the visit; (b) every sort change also updates `librarySort`, so a shelf visit silently resets what the library opens at. **Chosen: (a)** — the user asked to sort what they were looking at, and (b) makes the library's own order a side effect of browsing a shelf, which is exactly the class of state D8's persisted-sort sentence exists to prevent. Reversal is one line in `setSort`, and the failing case is the one in Task 2 that asserts a shelf-local sort leaves `librarySort` alone.

### R2 — *Add to Shelf* is a picker dialog, not a flyout submenu

D9 writes the item as **Add to Shelf ▸** and lists what is inside it: the shelves alphabetically, a check per shelf the book is already on, choosing a checked shelf removes it (with Undo), then **New Shelf…**. A `▸` in this codebase means a second positioned element inside a hand-rolled menu (`BookContextMenu`'s items are buttons in one absolutely-positioned box, with edge flipping computed by `getBoundingClientRect` and no submenu machinery at all). **The alternatives:** (a) a flyout — a second box, its own hover-intent, its own edge flipping, and no focus trap (the menu is not a `useDialogFocus` dialog); (b) **a dialog** — the same list, every clause of AC19 satisfied, opening via `useDialogFocus` (so Escape, Tab containment and first-focus come free), mounted once in `App.tsx` beside `RemoveFromDeviceDialog`. **Chosen: (b)**, and the label becomes **Add to Shelf…**, the codebase's own convention for "this opens a dialog" (`Edit metadata…`, `Choose cover…`, `Delete book…`). The spec's four behavioural clauses are all held; the glyph is not. Reversal is a component change only — the store slot, the writes and the checks do not move.

### R3 — the scope is an id, and every name is read from the list

`activeShelfId` is what D7 names; the *name* is needed in three places (the placeholder, the chips' labels — no, the chips carry their own names — and the *Remove from “‹shelf›”* menu item). **The alternative:** keep `activeShelfName` beside the id, written on entry. Rejected: a rename (here or on another Mac) would then need a second write path to stay true, and the placeholder would keep the old name until the shelf was re-opened. So the name is looked up through `shelfById(state, activeShelfId)` at render time, and a rename follows for free. The cost is real and accepted: for the first render after a cold start the list is empty, so the placeholder reads its stock sentence and the menu omits the item (Task 13) until `list()` lands.

### R4 — the scope is not one of the renderer's filters

D7 puts `shelfId` on `BookFilters` — for the **wire and the SQL**, where one WHERE builder must see it. In the renderer, `useLibraryStore.filters` stays the filter sidebar's own state, and the scope is spliced into the three read calls instead. **The alternative:** `filters.shelfId`, which reads as the obvious symmetry. Rejected for two mechanical reasons: `FilterSidebar`'s Clear button is `hasActive = Object.keys(filters).length > 0`, so a scope living there would make *Clear* appear while a shelf is open and do nothing visible when clicked — and `toggleFilter`'s `delete filters[kind]` bookkeeping has no business carrying a value the user cannot toggle. The spec's requirement ("**Clear** empties filters and keeps the shelf") is then true by construction rather than by special case.

### R5 — where the empty shelf sits in the ladder

`libraryViewState` is the one decider for the main pane (`library-emptiness.ts`), and its four cases are ordered deliberately. The new one is `'empty-shelf'`, **after** the query/filter rung and **after** the storage gate: an empty shelf is not an empty library, and the sentence it shows is a promise about a *write* ("drag books here"), so it takes the same `storageConnected` gate the first-run pane does — one rung either side of it. **The alternative:** return `'empty-shelf'` before the gate, on the reasoning that the shelf exists whether the share does. Rejected for the reason the fourth case was added on 2026-09-24: an instruction whose every affordance is refused is worse than the banner's sentence.

### R6 — one sentence, once a session

Slice 1's third note, and the spec's *Error handling* row. The reporter keys on the **sentence**, not on the error object or the call site: `shelves.json could not be read …` is the same news whichever mutation hit it. **The alternative:** key on the mutation, so each surface gets to say it once — rejected, because the second surface's sentence is the same sentence, and what the user needs told once is that shelf editing is paused. It is a factory (`createShelfFailureReporter`) rather than a module-level `Set` with a test-only reset, so a case owns its own session and the production instance is a one-line export.

### R7 — how a shelf write behaves while the library is unreachable

The spec's *Error handling* row says "menu items disable with main's storage copy". Read against the code that composes that copy, only one of the two sentences fits: `DELETE_BLOCKED` is action-shaped on purpose, and its own docblock says a surface that is not deleting something is not meant to read it (`storage-copy.ts:64-66`, settled with the owner 2026-09-24). So: **everything that deletes a shelf disables with `copy.deleteBlocked`; every other shelf write disables with `copy.label`** — a label, not an instruction, and the renderer already renders that exact value in two places (the sidebar's status row, Settings). **The alternative:** leave the non-deleting writes enabled and let `assertOnline` refuse them into the failure reporter. Rejected as the *default* because the status the renderer holds is the same fact the write gate reads (`state === 'connected'`, the sixth-and-counting write-gating component's question), so a disabled control is accurate rather than pessimistic. The reporter still covers the refusals that arrive anyway: a status that turned stale between render and click, and every Undo.

### R8 — the shelf delete confirmation lives in `ShelfList`

Exactly one surface opens it. `DeleteBookDialog` and `RemoveFromDeviceDialog` live in `ui.store` because five and two surfaces open *them*; a store flag for a dialog with one door is state that exists to be kept in sync with a component that already owns the row. So the confirmation is `ShelfList`'s local state, rendered inside it, and `ui.store` gains only the two targets this slice has real cross-surface need for (`shelfPicker`, `shelfRemove`) in Tasks 12 and 15. **Reversal:** if slice 4's *Send to ‹device›* ever grows a confirmation of its own, or the phone grows a shelf-delete the Mac mirrors, it moves to `ui.store` then.

### R9 — two strings D9's examples do not cover

D9 gives the add toast as *"Added 3 to To Read"* / *"Added 2 to To Read · 1 already there"*. Two states have no example: **everything was already on the shelf** (`added: 0`) and **nothing happened at all** (both counts 0 — the unknown-ids row, which main skips silently). Chosen: `Already on To Read` for the first, and **no toast** for the second — adding a book that is already there is the single most likely repeat of any click in this feature, and *"Added 0 to To Read · 3 already there"* is a sentence no one should read. Both live in `describeAdd`, both are one line to change.

### A gap this plan does not close

D9's empty-shelf body is *"Drag books here, or use Add to Shelf."* — and in slice 2 **neither of the two actions it names can be performed from that pane**: drag arrives in slice 3, and *Add to Shelf* is a right-click on a card, of which an empty shelf has none. The only working path is: click **Library**, right-click the books, *Add to Shelf…*. The sentence is D9's and is rendered verbatim (Task 7); the gap is recorded here rather than papered over, because it is a copy decision the spec's author should make, not this plan. Options, for whoever decides: (a) leave it — slice 3 makes the first half true, and the second half has been true all along for a shelf that has books; (b) name the route in the pane ("Add books from the library"); (c) put the picker in the pane, listing the *library's* books rather than a shelf's — a new surface, and the only one of the three that costs work.

---

## Global Constraints

- Node **≥ 22.12**. Run tests **only** through `npm test` (Electron-as-Node, so the native ABI matches). One file: `npm test -- <path>`.
- **The renderer has no DOM harness**: vitest runs in the `node` environment with no React testing library. So a claim is decided one of three ways, and every task says which: **(1)** an *action* gets a real case — a `src/lib` module or a store, driven with `vi.stubGlobal('window', { Musaeum: … })` (`src/lib/add-books.test.ts` is the pattern); **(2)** a *wiring* claim gets a **source walk** over the files (`src/components/library/context-menu-wiring.test.ts` is the pattern, including its own statement of what a walk cannot prove); **(3)** what is *painted* is the running app's, decided over CDP with the `musaeum-app-verification` probe — see each part's review gate.
- TypeScript strict, **no `any`**; contract types live in `src/types/` and **do not change** in this slice.
- The code blocks below are not guaranteed Prettier-formatted: run `npx prettier --write <the files you touched>` before `npm run lint`, which runs with `--max-warnings=0`.
- Invariant 7: **no element is added above either view.** There is no *row-height test* in the tree — the spec's phrase ("the existing row-height tests still pass untouched") has no file behind it; what is real is the geometry constants (`ROW_HEIGHT`, `CARD_META_HEIGHT`, `CARD_META_MARGIN`, each with its matching DOM shape) in `GridView.tsx`, `ListView.tsx` and `BookCard.tsx`, and `docs/invariants/library-views.md`'s rule that they must match real geometry. So the guard this slice uses is **a walk plus a diff**: `git diff` must show no change to those constants or the cells that carry them, and Task 9's walk cases assert nothing new sits between `<Toolbar />` and `<main>`. If a geometry constant or a cell's block-level child has to move to make this slice work, the slice is wrong.
- Invariant 9 stays whole: covers and bytes still arrive over `musaeum://`; nothing in this slice builds a `file://` URL or touches `window.Musaeum.files`' paths.
- **Renderer colours come from design tokens** (`src/lib/theme/palette-scan.test.ts` fails the build otherwise): the new surfaces reuse the tokens already on screen — the sidebar row pair, the dialog card, the chip, the gold primary, the danger ghost.
- **No renderer file restates a sentence the main process composes** (`src/lib/storage-copy-scan.test.ts`). Shelf failures render `Error.message` verbatim; the storage status is rendered through `nasStatus.copy.*`; and a renderer *test* does not quote main's sentences as fixtures either.
- Every mutation goes through one funnel: components call the store action or the `src/lib` module the task names — never `window.Musaeum.shelves.*` inline from a component, except in `ShelfList`, whose create/rename/delete are single-surface actions with no shared vocabulary to drift from (and its failures still go through `reportShelfFailure`).
- `shelves:changed` is subscribed **once**, in `useLibrary` (Task 5). No second subscriber, no component that reloads the list itself.
- Markdown prose is **not hard-wrapped** — one line per paragraph, bullet and table row.
- Commit after every task, and stage **by name** (four files in the tree belong to another session — see *Where this plan sits*). Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

The five inputs the spec implies but no acceptance criterion exercises, most likely to bite first. Each has a case in the task named.

1. **The open shelf is deleted** — here, or on another Mac while the user is browsing it → the scope must clear itself and the view must be the library again, not a scoped view of nothing that refuses every write. *Task 5.*
2. **A stored sort a build wrote as `shelf_added`** → refused on restore, and the library opens at its own default rather than sorted by a shelf's membership. *Task 2.*
3. **A rename field open while `shelves:changed` lands** (a REST edit on the phone, an adoption) → the field is not clobbered and the typed name is not lost. *Task 8.*
4. **An Undo pressed after the shelf has been deleted** → main's *"That shelf no longer exists"* reaches the toast, once, and the toast is not a lie about what was restored. *Tasks 11, 6.*
5. **Entering a shelf with a query active, then leaving it** → the search was scoped while inside, and both the query and the filters survive the round trip. *Tasks 3, 5.*

## Acceptance criteria → tasks

| AC | Task | | AC | Task |
| --- | --- | --- | --- | --- |
| 16 sidebar lists, counts, create/rename/delete | 8, 9 | | 20 detail chips, navigate, × removes | 14 |
| 17 scoped view + search + facets, placeholder, Clear keeps, Library leaves | 2, 3, 7, 9, 10 | | 21 trash entry points → Remove-vs-Delete, wiring test | 15 |
| 18 *Date Added to Shelf* only inside a shelf, and its default | 2, 10 | | 22 Undo restores membership and position | 11, 15 |
| 19 Add to Shelf (both scopes, panel), checks, New Shelf… | 12, 13 | | 23 REST change updates sidebar and open shelf | 4, 5 |

**Note 1 → Task 2. Note 2 → Task 11** (its decider) and Task 15 (its call site).

---

# Part 2a — the scope

### Task 1: `resultSetIdentity` gains the open shelf

**Files:**

- Modify: `src/lib/resultSetIdentity.ts`
- Modify: `src/lib/resultSetIdentity.test.ts`
- Modify: `src/components/library/GridView.tsx`
- Modify: `src/components/library/ListView.tsx`

- [ ] **Step 1: Write the failing cases**

In `src/lib/resultSetIdentity.test.ts`, the shared fixture gains the new member, and a new describe block is appended:

```ts
const BASE: ResultSetIdentity = {
  query: 'dune',
  filters: { authors: ['Herbert'], tags: ['sci-fi', 'classic'] },
  sort: { field: 'title', direction: 'asc' },
  shelfId: null
}
```

```ts
describe('the open shelf is part of the result set', () => {
  const SHELF = withIdentity({ shelfId: 'shelf-1' })

  it('changes when a shelf opens, even with a query active', () => {
    // Unlike the facet filters, the scope reaches the *search* too: `load()`
    // passes it to `searchBooks` as well as `getBooks`, so this is a change in
    // both branches and the search branch's `filters: null` does not cover it
    expect(resultSetChanged(BASE, withIdentity({ shelfId: 'shelf-1' }))).toBe(true)
    expect(resultSetChanged(withIdentity({ query: '' }), SHELF)).toBe(true)
  })

  it('changes when one shelf replaces another', () => {
    // The rows differ, and the reader's place in the shelf they left means
    // nothing in the one they arrived at
    expect(resultSetChanged(SHELF, withIdentity({ shelfId: 'shelf-2' }))).toBe(true)
  })

  it('changes when the shelf is left', () => {
    expect(resultSetChanged(SHELF, withIdentity({ shelfId: null }))).toBe(true)
  })

  it('does not change when the shelf does not', () => {
    expect(resultSetChanged(SHELF, withIdentity({ shelfId: 'shelf-1' }))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/lib/resultSetIdentity.test.ts`
Expected: the four new cases fail (`shelfId` is not a property of the type — typecheck is part of `npm test`'s run in this repo only via `npm run typecheck`; run that too: `npm run typecheck` fails first with `Object literal may only specify known properties`).

- [ ] **Step 3: Add the member and read it into the key**

In `src/lib/resultSetIdentity.ts`, the interface:

```ts
export interface ResultSetIdentity {
  query: string
  filters: BookFilters
  sort: BookSort
  /**
   * The open shelf, or null for the whole library (bookshelves D7). Part of the
   * identity, and unlike the filters it applies whether or not a query is
   * active — a shelf scopes the search too.
   */
  shelfId: string | null
}
```

and in `resultSetKey`, one line after `sort`:

```ts
  return JSON.stringify({
    query,
    filters: query ? null : normalizeFilters(identity.filters),
    sort: { field: identity.sort.field, direction: identity.sort.direction },
    shelfId: identity.shelfId
  })
```

Extend the docblock's own list of normalizations with the third: *"The open shelf is not a normalization but the store's other real behaviour: it scopes a search as well as a browse, so it stays in the key in both branches."*

- [ ] **Step 4: Pass it from both views**

In `src/components/library/GridView.tsx` and `src/components/library/ListView.tsx`, the selector is identical in both:

```tsx
  const resultKey = useLibraryStore((s) =>
    resultSetKey({ query: s.query, filters: s.filters, sort: s.sort, shelfId: s.activeShelfId })
  )
```

(`activeShelfId` does not exist yet — this step does not typecheck until Task 2 has added it. That is why this task's *commit* runs `npm run typecheck` only after Step 5, below, or the task order is swapped: **if you prefer a green commit at every step, do Task 2's Steps 1–3 first and this task second.** The tests are independent; only the type is shared.)

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test -- src/lib/resultSetIdentity.test.ts`
Expected: clean; the four new cases pass and the eleven existing cases are untouched.

```bash
git add src/lib/resultSetIdentity.ts src/lib/resultSetIdentity.test.ts src/components/library/GridView.tsx src/components/library/ListView.tsx
git commit -m "shelves slice 2: the open shelf is part of the result set

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `library.store` — the scope, the sort, and the one sort that is persisted (note 1)

**Files:**

- Modify: `src/stores/library.store.ts`
- Create: `src/stores/library.store.test.ts`

- [ ] **Step 1: Write the failing cases**

Create `src/stores/library.store.test.ts`. The stub is `add-books.test.ts`'s pattern; the three reads are what `load()` calls, and the facets answer is whatever the store would have received:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Book, BookSort, LibraryFacets } from '@shared/book.types'
import { persistedLibraryState, restoredSort, useLibraryStore } from './library.store'

const TITLE_ASC: BookSort = { field: 'title', direction: 'asc' }
const SHELF_DESC: BookSort = { field: 'shelf_added', direction: 'desc' }

/** Read once, and keep it true: every facet kind empty. */
const NO_FACETS: LibraryFacets = { authors: [], series: [], tags: [], formats: [], readStatus: [] }

/** `window.Musaeum`, reduced to the three reads `load()` makes. */
function stubLibrary(calls: { getBooks: unknown[]; searchBooks: unknown[]; getFacets: unknown[] }) {
  vi.stubGlobal('window', {
    Musaeum: {
      library: {
        getBooks: (filters: unknown) => {
          calls.getBooks.push(filters)
          return Promise.resolve([] as Book[])
        },
        searchBooks: (query: string, sort: unknown, scope: unknown) => {
          calls.searchBooks.push({ query, sort, scope })
          return Promise.resolve([] as Book[])
        },
        getFacets: (scope: unknown) => {
          calls.getFacets.push(scope)
          return Promise.resolve(NO_FACETS)
        }
      }
    }
  })
}

function emptyCalls() {
  return { getBooks: [], searchBooks: [], getFacets: [] }
}

afterEach(() => {
  vi.unstubAllGlobals()
  useLibraryStore.setState({ activeShelfId: null, sort: TITLE_ASC, librarySort: TITLE_ASC })
})
```

> **Read `LibraryFacets` in `src/types/book.types.ts` before writing `NO_FACETS`** — if a member is not an array, give it that member's own empty value. The plan could not read it while being written; the literal is the one guess in this file and it is a ten-second check.

Then the cases:

```ts
describe('the scope (AC17)', () => {
  it('travels on the browse read, next to the filters it is not part of', async () => {
    const calls = emptyCalls()
    stubLibrary(calls)
    useLibraryStore.setState({ activeShelfId: 'shelf-1', filters: { authors: ['Herbert'] } })
    await useLibraryStore.getState().load()
    // One object, one WHERE builder: the scope rides with the filters rather
    // than being folded into them (R4)
    expect(calls.getBooks).toEqual([{ authors: ['Herbert'], sort: TITLE_ASC, shelfId: 'shelf-1' }])
    expect(calls.getFacets).toEqual([{ shelfId: 'shelf-1' }])
  })

  it('travels on the search read, which filters never do', async () => {
    const calls = emptyCalls()
    stubLibrary(calls)
    useLibraryStore.setState({ activeShelfId: 'shelf-1', query: 'dune' })
    await useLibraryStore.getState().load()
    expect(calls.searchBooks).toEqual([
      { query: 'dune', sort: TITLE_ASC, scope: { shelfId: 'shelf-1' } }
    ])
    expect(calls.getBooks).toEqual([])
  })

  it('is absent — not null — with no shelf open', async () => {
    const calls = emptyCalls()
    stubLibrary(calls)
    await useLibraryStore.getState().load()
    // `undefined`, because the preload's optional parameters and the SQL guard
    // both read absence; a `shelfId: null` would be a value nothing expects
    expect(calls.getBooks).toEqual([{ sort: TITLE_ASC }])
    expect(calls.getFacets).toEqual([undefined])
  })
})

describe('entering and leaving (AC17, AC18)', () => {
  it('enters with Date Added to Shelf, newest first, and remembers the library sort', () => {
    useLibraryStore.setState({ sort: { field: 'author', direction: 'desc' }, librarySort: { field: 'author', direction: 'desc' } })
    useLibraryStore.getState().setActiveShelf('shelf-1')
    const s = useLibraryStore.getState()
    expect(s.activeShelfId).toBe('shelf-1')
    expect(s.sort).toEqual(SHELF_DESC)
    expect(s.librarySort).toEqual({ field: 'author', direction: 'desc' })
  })

  it('leaves to the library sort, whatever the shelf was sorted by', () => {
    useLibraryStore.setState({ activeShelfId: 'shelf-1', sort: SHELF_DESC, librarySort: { field: 'series', direction: 'asc' } })
    useLibraryStore.getState().setActiveShelf(null)
    const s = useLibraryStore.getState()
    expect(s.activeShelfId).toBeNull()
    expect(s.sort).toEqual({ field: 'series', direction: 'asc' })
  })

  it('switching straight between two shelves cannot overwrite the library sort (R1)', () => {
    useLibraryStore.setState({ sort: TITLE_ASC, librarySort: TITLE_ASC })
    useLibraryStore.getState().setActiveShelf('a')
    useLibraryStore.getState().setActiveShelf('b')
    // The second entry would otherwise remember `shelf_added`, and leaving
    // would restore a sort the library never had
    expect(useLibraryStore.getState().librarySort).toEqual(TITLE_ASC)
  })

  it('a sort chosen inside a shelf is the shelf\u2019s own (R1)', () => {
    useLibraryStore.setState({ activeShelfId: 'shelf-1', sort: SHELF_DESC, librarySort: TITLE_ASC })
    useLibraryStore.getState().setSort({ field: 'author', direction: 'asc' })
    expect(useLibraryStore.getState().sort).toEqual({ field: 'author', direction: 'asc' })
    expect(useLibraryStore.getState().librarySort).toEqual(TITLE_ASC)
  })

  it('a sort chosen in the library is remembered', () => {
    useLibraryStore.getState().setSort({ field: 'rating', direction: 'desc' })
    expect(useLibraryStore.getState().librarySort).toEqual({ field: 'rating', direction: 'desc' })
  })
})

describe('what outlives the session (note 1)', () => {
  it('persists the library sort, never the shelf sort', () => {
    useLibraryStore.setState({ activeShelfId: 'shelf-1', sort: SHELF_DESC, librarySort: TITLE_ASC })
    // The whole of the rule, in the shape `persistedUIState` is tested in
    expect(persistedLibraryState(useLibraryStore.getState())).toEqual({ sort: TITLE_ASC })
  })

  it('refuses a stored shelf_added and keeps the library default', () => {
    // A build that persisted one would otherwise open the library sorted by a
    // shelf's membership, which it has none of
    expect(restoredSort(SHELF_DESC)).toBeNull()
    expect(restoredSort({ field: 'title', direction: 'asc' })).toEqual(TITLE_ASC)
    expect(restoredSort({ field: 'nonsense', direction: 'asc' })).toBeNull()
    expect(restoredSort(null)).toBeNull()
    expect(restoredSort('title')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run typecheck && npm test -- src/stores/library.store.test.ts`
Expected: typecheck fails on `persistedLibraryState`, `restoredSort` and the two new state members.

- [ ] **Step 3: Add the state, the two actions and the persistence rule**

In `src/stores/library.store.ts`, the interface — after `sort: BookSort`:

```ts
  /**
   * The open shelf, or null for the whole library (bookshelves D7). Sits above
   * the facet filters: **Clear** empties `filters` and leaves this alone.
   *
   * Not persisted, and not restored at launch — the store's existing
   * "never reopen filtered" rule, for the same reason.
   */
  activeShelfId: string | null
  /**
   * The library's *own* sort — the only one that outlives the session (D8).
   * While a shelf is open `sort` is that shelf's sort, and this is what leaving
   * restores; while the library is on screen the two are kept equal.
   */
  librarySort: BookSort
```

and the two actions beside `setSort`:

```ts
  /** Open a shelf, or leave it with null. Remembers and restores the library sort. */
  setActiveShelf(shelfId: string | null): void
  /** Drop a scope the shelf list no longer holds. See the docblock. */
  reconcileScope(existingShelfIds: string[]): void
```

Initial state, beside `sort`:

```ts
        sort: { field: 'title', direction: 'asc' },
        librarySort: { field: 'title', direction: 'asc' },
        activeShelfId: null,
```

and the two implementations, replacing the current `setSort`:

```ts
        /**
         * Entering a shelf sets its default order and remembers the library's;
         * leaving restores it. The memory is written only from *outside* a
         * shelf: switching straight from one shelf to another must not
         * overwrite it with a shelf sort, and a sort chosen inside a shelf is
         * that visit's own (R1).
         */
        setActiveShelf(shelfId) {
          const { activeShelfId, sort, librarySort } = get()
          if (shelfId === activeShelfId) return
          if (shelfId === null) {
            set({ activeShelfId: null, sort: librarySort })
          } else {
            set({
              activeShelfId: shelfId,
              librarySort: activeShelfId ? librarySort : sort,
              sort: SHELF_ADDED_DESC
            })
          }
          void get().load()
        },

        /**
         * A scope whose shelf has gone: deleted here, deleted on another Mac, or
         * a library root switched to one that never had it. Main broadcasts on
         * every adoption as well as every write, so this runs whenever the list
         * is refreshed — and without it the app would sit on a scope no list
         * holds, where every read answers nothing and every write refuses
         * ("That shelf no longer exists"). Leaving the scope keeps the query and
         * the filters: they are the user's, and they were not what vanished.
         */
        reconcileScope(existingShelfIds) {
          const { activeShelfId } = get()
          if (!activeShelfId || existingShelfIds.includes(activeShelfId)) return
          get().setActiveShelf(null)
        },

        setSort(sort) {
          set(get().activeShelfId ? { sort } : { sort, librarySort: sort })
          void get().load()
        },
```

with, above the store:

```ts
/** D8's default inside a shelf; also what its sort control offers first. */
const SHELF_ADDED_DESC: BookSort = { field: 'shelf_added', direction: 'desc' }
```

Then the persistence block, replacing `partialize` and `merge`:

```ts
export const persistedLibraryState = (s: LibraryState): Pick<LibraryState, 'sort'> => ({
  // D8: the library sort is the only persisted sort. While a shelf is open the
  // state's `sort` is *Date Added to Shelf*, which means nothing without a shelf
  // and would come back as the library's own order on the next launch
  sort: s.librarySort
})

/**
 * A restored sort, or null when storage holds nothing this build may use.
 *
 * `isBookSort` alone is no longer enough — it accepts `shelf_added` since slice
 * 1, so a build that persisted one would restore a library sorted by a shelf's
 * membership. Exported for the same reason `persistedUIState` is: the rule gets
 * a decider instead of a case that reaches into the storage backend.
 */
export function restoredSort(value: unknown): BookSort | null {
  return isBookSort(value) && value.field !== 'shelf_added' ? value : null
}
```

```ts
    {
      // Sort is the only durable preference here. Query and filters are not
      // restored on purpose: reopening to a filtered library that looks like
      // a much smaller one is the kind of state a user can't see the cause of.
      // The *open shelf* is not restored either, for the same reason.
      name: 'musaeum.library',
      partialize: persistedLibraryState,
      merge: (persisted, current) => {
        const { sort } = (persisted ?? {}) as { sort?: unknown }
        const restored = restoredSort(sort)
        return restored ? { ...current, sort: restored, librarySort: restored } : current
      }
    }
```

The storage key stays `sort`, so an existing install keeps the sort the user last chose — and the `shelf_added` guard is what makes accepting that key safe.

- [ ] **Step 4: Run the cases**

Run: `npm test -- src/stores/library.store.test.ts`
Expected: all twelve pass.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test -- src/stores/library.store.test.ts`
Expected: clean. If `src/lib/resultSetIdentity.ts` was done first (Task 1), this is also where those two views' edits start typechecking.

```bash
git add src/stores/library.store.ts src/stores/library.store.test.ts
git commit -m "shelves slice 2: library.store — the scope, and the one sort that is persisted

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `load()` carries the scope (AC17)

**Files:**

- Modify: `src/stores/library.store.ts`
- Modify: `src/stores/library.store.test.ts`

- [ ] **Step 1: Write the failing case that pins the shape of the call**

The three cases under *the scope* in Task 2 were written before `load()` was changed — this task is what makes them pass. Add the one case they do not cover, the query branch's scope:

```ts
  it('does not scope the search when no shelf is open', async () => {
    const calls = emptyCalls()
    stubLibrary(calls)
    useLibraryStore.setState({ query: 'dune' })
    await useLibraryStore.getState().load()
    // The preload's `scope` is optional; passing `{ shelfId: undefined }` would
    // be a second shape for the same absence
    expect(calls.searchBooks).toEqual([{ query: 'dune', sort: TITLE_ASC, scope: undefined }])
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/stores/library.store.test.ts`
Expected: the four scope cases fail (`getBooks` receives no `shelfId`).

- [ ] **Step 3: Splice the scope into the three reads**

```ts
        async load() {
          const { query, filters, sort, activeShelfId } = get()
          set({ loading: true })
          try {
            // The scope travels on the read, not in `filters` (R4): it is not
            // one of the filter sidebar's facets, so *Clear* cannot reach it and
            // `hasActive` cannot claim it — the spec's "Clear keeps the shelf",
            // true by construction
            const scope = activeShelfId ? { shelfId: activeShelfId } : undefined
            const books = query.trim()
              ? await window.Musaeum.library.searchBooks(query, sort, scope)
              : await window.Musaeum.library.getBooks({
                  ...filters,
                  sort,
                  ...(activeShelfId ? { shelfId: activeShelfId } : {})
                })
            const facets = await window.Musaeum.library.getFacets(scope)
            set({ books, facets, loading: false })
          } catch (err) {
            console.error('library load failed:', err)
            set({ loading: false })
          }
        },
```

Three things are deliberate and each is why a case exists: `scope` is `undefined` rather than `{ shelfId: null }`; the browse call spreads the scope **after** the filters so a stale `filters.shelfId` could never win (it cannot exist — R4 — but the order states which one is authoritative); and the search call ignores the filters entirely, as before.

- [ ] **Step 4: Run the cases**

Run: `npm test -- src/stores/library.store.test.ts`
Expected: all sixteen pass.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test -- src/stores/library.store.test.ts src/lib/resultSetIdentity.test.ts`
Expected: clean.

```bash
git add src/stores/library.store.ts src/stores/library.store.test.ts src/components/library/GridView.tsx src/components/library/ListView.tsx
git commit -m "shelves slice 2: every library read carries the open shelf

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `shelves.store` — the list, one book's shelves, and a revision (AC16, AC23)

**Files:**

- Create: `src/stores/shelves.store.ts`
- Create: `src/stores/shelves.store.test.ts`

- [ ] **Step 1: Write the failing cases**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShelfSummary } from '@shared/shelf.types'
import { shelfById, useShelvesStore } from './shelves.store'

const READING: ShelfSummary = { id: 's1', name: 'Reading now', kind: 'manual', count: 3 }
const SCIFI: ShelfSummary = { id: 's2', name: 'Sci-fi', kind: 'manual', count: 12 }

function stubShelves(handlers: {
  list(): Promise<ShelfSummary[]>
  forBook?(bookId: string): Promise<ShelfSummary[]>
}) {
  const asked: string[] = []
  const say = vi.fn()
  vi.stubGlobal('window', {
    Musaeum: {
      shelves: {
        list: () => handlers.list(),
        forBook: (bookId: string) => {
          asked.push(bookId)
          return handlers.forBook?.(bookId) ?? Promise.resolve([])
        }
      }
    }
  })
  return { asked, say }
}

afterEach(() => {
  vi.unstubAllGlobals()
  useShelvesStore.setState({ shelves: [], byBook: {}, revision: 0 })
})

describe('the list', () => {
  it('replaces on every read, so a rename or a delete needs no second path', async () => {
    stubShelves({ list: async () => [READING, SCIFI] })
    await useShelvesStore.getState().load()
    expect(useShelvesStore.getState().shelves).toEqual([READING, SCIFI])
    stubShelves({ list: async () => [SCIFI] })
    await useShelvesStore.getState().load()
    expect(useShelvesStore.getState().shelves).toEqual([SCIFI])
  })

  it('keeps what it has when the read fails', async () => {
    useShelvesStore.setState({ shelves: [READING] })
    stubShelves({ list: async () => Promise.reject(new Error('Library is offline')) })
    await useShelvesStore.getState().load()
    // A share blip must not empty the sidebar — and the failure is reported
    // once by the reporter, which is Task 6's
    expect(useShelvesStore.getState().shelves).toEqual([READING])
  })
})

describe('invalidate (AC16, AC23)', () => {
  it('bumps the revision and drops every cached answer', async () => {
    stubShelves({ list: async () => [READING], forBook: async () => [SCIFI] })
    await useShelvesStore.getState().loadForBook('b1')
    expect(useShelvesStore.getState().byBook.b1).toEqual([SCIFI])
    useShelvesStore.getState().invalidate()
    const s = useShelvesStore.getState()
    // The revision is what a consumer re-asks on: deleting the key alone would
    // not re-run an effect that reads `byBook[id]`
    expect(s.revision).toBe(1)
    expect(s.byBook).toEqual({})
  })
})

describe('shelfById', () => {
  it('finds the open shelf, and answers null for nothing', () => {
    const state = { ...useShelvesStore.getState(), shelves: [READING, SCIFI] }
    expect(shelfById(state, 's2')).toEqual(SCIFI)
    expect(shelfById(state, 'gone')).toBeNull()
    expect(shelfById(state, null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/stores/shelves.store.test.ts`
Expected: the module does not exist.

- [ ] **Step 3: Write the store**

```ts
import { create } from 'zustand'
import type { ShelfSummary } from '@shared/shelf.types'

/**
 * The shelves the app knows about: the list the sidebar draws, one book's
 * membership for the places that show it, and a revision that says "what you
 * cached is stale".
 *
 * It holds no opinion about *which* shelf is open. That is the library store's
 * `activeShelfId` (D7) — the scope is a property of the library view, and the
 * reads that apply it are the library store's.
 *
 * Every write lives in main (`services/shelves.ts`) and reports back through
 * `shelves:changed`; this store never updates itself optimistically, so the
 * sidebar cannot show a shelf the share refused to write. `useLibrary` is the
 * one subscriber.
 *
 * A failed *read* is logged and kept quiet here (the `console.error` idiom
 * `library.store`'s own `load()` uses); Task 6 replaces both of these with the
 * session reporter, which is where "once, and in the user's words" belongs.
 */
interface ShelvesState {
  /** Alphabetical, case-insensitive — main's own order. */
  shelves: ShelfSummary[]
  /** Bumped by every `invalidate()`; a consumer re-asks on a change of it. */
  revision: number
  /** `forBook` answers, keyed by book id. Emptied by every `invalidate()`. */
  byBook: Record<string, ShelfSummary[]>

  load(): Promise<void>
  loadForBook(bookId: string): Promise<void>
  /** Main says shelves or membership changed: here, over REST, or by adoption. */
  invalidate(): void
}

export const useShelvesStore = create<ShelvesState>()((set) => ({
  shelves: [],
  revision: 0,
  byBook: {},

  async load() {
    try {
      const shelves = await window.Musaeum.shelves.list()
      set({ shelves })
    } catch (err) {
      // Deliberately not `set({ shelves: [] })`: a failed read is not an empty
      // library, and a sidebar that empties itself on a blip teaches the user
      // their shelves are gone
      console.error('shelf list failed:', err)
    }
  },

  async loadForBook(bookId) {
    try {
      const shelves = await window.Musaeum.shelves.forBook(bookId)
      set((s) => ({ byBook: { ...s.byBook, [bookId]: shelves } }))
    } catch (err) {
      console.error('shelves for book failed:', err)
    }
  },

  invalidate() {
    set((s) => ({ revision: s.revision + 1, byBook: {} }))
  }
}))

/** The shelf with this id, or null — the one lookup the placeholder needs (R3). */
export function shelfById(state: ShelvesState, id: string | null): ShelfSummary | null {
  if (!id) return null
  return state.shelves.find((shelf) => shelf.id === id) ?? null
}
```

- [ ] **Step 4: Run the cases**

Run: `npm test -- src/stores/shelves.store.test.ts`
Expected: all six pass. (The two failure cases assert what the *store* does — keep what it has — and Task 6 adds the reporting on top.)

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test -- src/stores/shelves.store.test.ts`
Expected: clean.

```bash
git add src/stores/shelves.store.ts src/stores/shelves.store.test.ts
git commit -m "shelves slice 2: the shelf store

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `useLibrary` is the one subscriber to `shelves:changed` (AC23, Review Focus 1)

**Files:**

- Modify: `src/hooks/useLibrary.ts`
- Create: `src/hooks/useLibrary.test.ts`

- [ ] **Step 1: Write the failing cases as a walk**

The hook cannot run without React, so its claim is a source walk plus the store cases above — the split `context-menu-wiring.test.ts` states in its own docblock:

```ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/** What a source walk can and cannot prove: see context-menu-wiring.test.ts. */
const SOURCE = readFileSync(join(process.cwd(), 'src', 'hooks', 'useLibrary.ts'), 'utf8')
const APP = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')

describe('shelves:changed (AC23)', () => {
  it('is subscribed exactly once, in the hook mounted at app root', () => {
    expect(SOURCE).toMatch(/shelves\.onChanged\(/)
    expect(APP).toMatch(/useLibrary\(\)/)
  })

  it('is inside the same subscription list as the other main-process events', () => {
    const list = SOURCE.slice(SOURCE.indexOf('const unsubs = ['))
    expect(list).toContain('shelves.onChanged')
    // A second listener would be a second reload path — and the first place a
    // change would be applied twice
    expect(SOURCE.match(/onChanged\(/g)?.length).toBe(1)
  })

  it('refreshes the list, drops the per-book cache, and re-reads a scoped view', () => {
    const handler = SOURCE.slice(SOURCE.indexOf('shelves.onChanged'))
    expect(handler).toMatch(/invalidate\(\)/)
    expect(handler).toMatch(/load\(\)/)
    // The scope's own rows only move when a shelf is open; reconciling is what
    // clears a scope whose shelf has gone (Review Focus 1)
    expect(handler).toMatch(/reconcileScope\(/)
  })
})

describe('startup', () => {
  it('reads the list once, so the sidebar is not empty on first paint', () => {
    expect(SOURCE).toMatch(/void loadShelves\(\)|void useShelvesStore/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/hooks/useLibrary.test.ts`
Expected: three of four fail.

- [ ] **Step 3: Wire it**

In `src/hooks/useLibrary.ts`, add the selectors:

```ts
  const loadShelves = useShelvesStore((s) => s.load)
  const invalidateShelves = useShelvesStore((s) => s.invalidate)
  const reconcileScope = useLibraryStore((s) => s.reconcileScope)
  const activeShelfId = useLibraryStore((s) => s.activeShelfId)
```

into the mount effect:

```ts
  useEffect(() => {
    void load()
    void loadShelves()
    // …
  }, [/* existing deps */, loadShelves])
```

and one entry in `unsubs`:

```ts
      /**
       * One shelf signal, one path (D9, slice 1's second handoff note). The list
       * is re-read because the sidebar draws it; every cached per-book answer is
       * dropped because membership just moved; the open shelf's own rows are
       * re-read — nothing outside a shelf changes, and `libraryChanged` (which
       * re-reads unconditionally) is not this event; and a scope whose shelf has
       * gone clears itself, which is the one thing standing between a delete on
       * another Mac and a view that answers nothing and refuses every write.
       *
       * The reconcile waits for the read rather than running beside it: the list
       * in the store at this moment is the one from the *previous* change, and
       * reconciling against it would clear a scope whose shelf was created a
       * moment ago.
       */
      window.Musaeum.shelves.onChanged(() => {
        invalidateShelves()
        void loadShelves().then(() => {
          reconcileScope(useShelvesStore.getState().shelves.map((s) => s.id))
          if (useLibraryStore.getState().activeShelfId) void load()
        })
      }),
```

This shape is deliberate and the reviewer should check it: **one network call, sequenced correctly.** The alternative — a `loadShelves()` and a separate `list()` for the reconcile — costs a second round trip to answer a question the first call just answered, and makes the two answers able to disagree.

- [ ] **Step 4: Run the walk and the store cases**

Run: `npm test -- src/hooks/useLibrary.test.ts src/stores/shelves.store.test.ts src/stores/library.store.test.ts`
Expected: all pass.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 79–80 files; the whole suite green, the new counts included.

```bash
git add src/hooks/useLibrary.ts src/hooks/useLibrary.test.ts
git commit -m "shelves slice 2: one subscriber to shelves:changed

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**— Part 2a review gate.** Green and reviewed before Task 6. The reviewer's list: note 1's rule in `library.store` (the persisted sort and the refusal), R4's scope-not-filter decision at all three read sites, `reconcileScope` reachable from the one subscriber, and that nothing in 2a touches a file under `electron/`. **Live check (part 1):** `npm run dev`, then `/verify` — with a shelf created by hand over IPC (or via slice 5's REST later), opening and closing the scope must change the rows and the sort control; this half is what the CDP probe is for, and it stays open until Task 10 gives the scope a clickable door.

---

# Part 2b — the sidebar and the chrome

### Task 6: `shelf-feedback.ts` — one sentence, once a session (slice 1's third note)

**Files:**

- Create: `src/lib/shelf-feedback.ts`
- Create: `src/lib/shelf-feedback.test.ts`
- Modify: `src/stores/shelves.store.ts` (the two catches Task 4 left as `console.error`)

- [ ] **Step 1: Write the failing cases**

```ts
import { describe, expect, it } from 'vitest'
import { createShelfFailureReporter } from './shelf-feedback'

/** A fixture sentence on purpose: main's own sentences live in main, and a copy
 *  of one in a renderer test is the drift storage-copy-scan exists to prevent. */
const UNREADABLE = 'the share says no this time'
const MISSING_SHELF = 'that shelf is not in the file'

function reporter() {
  const said: string[] = []
  return { said, report: createShelfFailureReporter((m) => said.push(m)) }
}

describe('one sentence, once a session', () => {
  it('says the same sentence the first time and never again', () => {
    const { said, report } = reporter()
    report(new Error(UNREADABLE))
    report(new Error(UNREADABLE))
    report(new Error(UNREADABLE))
    expect(said).toEqual([UNREADABLE])
  })

  it('says a second, different sentence — a session is not one report', () => {
    const { said, report } = reporter()
    report(new Error(UNREADABLE))
    report(new Error(MISSING_SHELF))
    expect(said).toEqual([UNREADABLE, MISSING_SHELF])
  })

  it('renders the error\u2019s own text, verbatim', () => {
    // Main writes these for a person to read; re-wording one here is how the
    // sentence in the log and the sentence on screen drift apart
    const { said, report } = reporter()
    report(new Error('That shelf no longer exists'))
    expect(said).toEqual(['That shelf no longer exists'])
  })

  it('takes a non-Error rejection, because a bridge that throws a string does', () => {
    const { said, report } = reporter()
    report('boom')
    expect(said).toEqual(['boom'])
  })

  it('keeps two sessions apart', () => {
    const first = reporter()
    const second = reporter()
    first.report(new Error(UNREADABLE))
    second.report(new Error(UNREADABLE))
    expect(first.said).toEqual([UNREADABLE])
    expect(second.said).toEqual([UNREADABLE])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/lib/shelf-feedback.test.ts`
Expected: the module does not exist.

- [ ] **Step 3: Write the module**

```ts
import { useUIStore } from '@/stores/ui.store'

/**
 * The session's memory of what it has already said about shelves.
 *
 * Slice 1's third handoff note: every mutation that finds `shelves.json`
 * unreadable rejects with the *same* sentence, and the spec wants it surfaced
 * once per session rather than once per click. The toast's own de-duplication
 * (`ui.store.notify` drops an identical message+detail pair) only covers a toast
 * that is still on screen — 12 s later the next click would say it again.
 *
 * The identity is the **sentence**, not the error or the call site: two
 * different failures carrying the same words are the same news, and that
 * sentence is the whole of what a person can act on.
 *
 * A factory rather than a module-level Set with a test-only reset: the memory is
 * the behaviour, so a case holds its own session and the app's instance is one
 * exported line.
 */
export function createShelfFailureReporter(say: (message: string) => void): (err: unknown) => void {
  const said = new Set<string>()
  return (err) => {
    const message = err instanceof Error ? err.message : String(err)
    if (said.has(message)) return
    said.add(message)
    say(message)
  }
}

/**
 * The app's one reporter, for every shelf path: create, rename, delete, add,
 * remove, restore, and the reads behind the sidebar.
 *
 * It renders the error's own text and never a rewording of it — the sentence
 * comes from main, and `src/lib/storage-copy-scan.test.ts` fails the build if a
 * renderer writes its own version of one.
 */
export const reportShelfFailure = createShelfFailureReporter((message) =>
  useUIStore.getState().notify({ kind: 'error', message })
)
```

- [ ] **Step 4: Run the cases**

Run: `npm test -- src/lib/shelf-feedback.test.ts`
Expected: five pass.

- [ ] **Step 5: Wire it into the two reads that fail quietly**

In `src/stores/shelves.store.ts`, add the import and replace both catches Task 4 left:

```ts
import { reportShelfFailure } from '@/lib/shelf-feedback'
```

```ts
    } catch (err) {
      // Deliberately not `set({ shelves: [] })`: a failed read is not an empty
      // library, and a sidebar that empties itself on a blip teaches the user
      // their shelves are gone. The sentence is main's, and the session says it
      // once — the sidebar's rows here, the phone's toggles and every menu
      // write all end up in the same reporter.
      reportShelfFailure(err)
    }
```

```ts
    } catch (err) {
      reportShelfFailure(err)
    }
```

Run: `npm test -- src/stores/shelves.store.test.ts src/lib/shelf-feedback.test.ts`
Expected: all eleven pass, unchanged — the store's two failure cases assert what it *keeps*, not what it says.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test -- src/lib/shelf-feedback.test.ts src/stores/shelves.store.test.ts`
Expected: clean.

```bash
git add src/lib/shelf-feedback.ts src/lib/shelf-feedback.test.ts src/stores/shelves.store.ts
git commit -m "shelves slice 2: shelf failures are reported once a session

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: the empty shelf is its own state (AC17)

**Files:**

- Modify: `src/lib/library-emptiness.ts`
- Modify: `src/lib/library-emptiness.test.ts`
- Modify: `src/components/shared/EmptyLibrary.tsx`
- Modify: `src/components/library/GridView.tsx`
- Modify: `src/components/library/ListView.tsx`

- [ ] **Step 1: Write the failing cases**

In `src/lib/library-emptiness.test.ts`, every existing input gains `shelfId: null` (they are built through one helper — if they are not, that is the edit this task makes), and:

```ts
describe('an empty shelf (AC17)', () => {
  it('is its own state, not an empty library', () => {
    expect(libraryViewState({ ...BASE, shelfId: 's1' })).toBe('empty-shelf')
  })

  it('loses to a query or a filter that matched nothing on it', () => {
    expect(libraryViewState({ ...BASE, query: 'dune', shelfId: 's1' })).toBe('no-matches')
    expect(libraryViewState({ ...BASE, filters: { tags: ['epic'] }, shelfId: 's1' })).toBe(
      'no-matches'
    )
  })

  it('renders nothing when the library cannot take a write (R5)', () => {
    // The shelf's own copy is a write instruction ("drag books here"), so it
    // takes the same gate the first-run pane takes — the banner above carries
    // the sentence and the recovery instead
    expect(
      libraryViewState({ ...BASE, shelfId: 's1', storageConnected: false })
    ).toBe('library-unavailable')
  })

  it('loses to books and to loading, like every other state', () => {
    expect(libraryViewState({ ...BASE, shelfId: 's1', resultCount: 3 })).toBe('books')
    expect(libraryViewState({ ...BASE, shelfId: 's1', loading: true })).toBe('loading')
  })

  it('leaves the library\u2019s own states alone', () => {
    expect(libraryViewState({ ...BASE, shelfId: null })).toBe('empty-library')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/lib/library-emptiness.test.ts`
Expected: typecheck fails on the unknown property, and the new cases fail.

- [ ] **Step 3: Add the state and the rung**

In `src/lib/library-emptiness.ts`:

```ts
export type LibraryViewState =
  | 'loading'
  | 'empty-library'
  | 'empty-shelf'
  | 'no-matches'
  | 'library-unavailable'
  | 'books'
```

the input gains:

```ts
  /**
   * The open shelf's id, or null for the whole library (bookshelves D7).
   * Required, like `storageConnected`: a scope is not a detail a second view can
   * silently drop.
   */
  shelfId: string | null
```

and the ladder's last two lines become:

```ts
  if (!input.storageConnected) return 'library-unavailable'
  // An empty shelf is not an empty library, and the promise it makes is the
  // shelf's own — which is why it sits *below* the storage gate rather than
  // above it (R5): "drag books here" is a write, and with the share gone the
  // banner's sentence is the honest one.
  return input.shelfId ? 'empty-shelf' : 'empty-library'
```

Extend the docblock with the fifth case, in the same voice as the fourth's entry: *"The fifth case, added with bookshelves slice 2: an empty shelf, which is not an empty library and whose copy names two actions — so it shares the fourth case's gate, and exists because the sidebar can now put the user somewhere the library is not."*

- [ ] **Step 4: Render it, in the empty library's slot**

In `src/components/shared/EmptyLibrary.tsx`, the branch chain gains one arm — the sentence is D9's, verbatim:

```tsx
      ) : state === 'empty-shelf' ? (
        <>
          <p className="font-display text-lg text-parchment-dim">This shelf is empty</p>
          {/* D9's sentence, word for word. In slice 2 neither action it names
              can be performed from this pane — drag arrives in slice 3, and the
              menu path needs a card to right-click — which is recorded as an
              open copy question in the plan, not patched over here. */}
          <p className="max-w-sm text-sm">Drag books here, or use Add to Shelf.</p>
        </>
      ) : (
```

and extend the component's docblock with the state's own paragraph, naming the gap explicitly: *"'empty-shelf' takes the first-run block's slot and styling and none of its controls: nothing here offers Import or Migrate, because those fill the library and not the shelf. What it does offer is a sentence the owner chose (D9), whose two affordances arrive with slice 3 and with a shelf that has books."*

- [ ] **Step 5: Pass the scope from both views**

In `GridView.tsx` and `ListView.tsx`, the state call gains one line, and the selector for it:

```tsx
  const shelfId = useLibraryStore((s) => s.activeShelfId)
  const view = libraryViewState({
    loading,
    query,
    filters,
    resultCount: books.length,
    storageConnected,
    shelfId
  })
```

(The views were already touched in Task 1 for `resultSetKey`; this is the second and last time.)

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test -- src/lib/library-emptiness.test.ts`
Expected: clean, all cases pass.

```bash
git add src/lib/library-emptiness.ts src/lib/library-emptiness.test.ts src/components/shared/EmptyLibrary.tsx src/components/library/GridView.tsx src/components/library/ListView.tsx
git commit -m "shelves slice 2: an empty shelf is its own empty state

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `ShelfList` — the section, its rows, its field, its confirm (AC16)

**Files:**

- Create: `src/components/layout/ShelfList.tsx`
- Create: `src/components/layout/shelf-list-wiring.test.ts`

- [ ] **Step 1: Write the failing walk**

```ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(
  join(process.cwd(), 'src', 'components', 'layout', 'ShelfList.tsx'),
  'utf8'
)

describe('the shelf section (AC16)', () => {
  it('renders main\u2019s list as it arrives, with its counts', () => {
    expect(SOURCE).toMatch(/useShelvesStore\(/)
    expect(SOURCE).toMatch(/\{shelf\.count\}/)
  })

  it('creates and renames through the one inline field', () => {
    expect(SOURCE).toMatch(/shelves\.create\(/)
    expect(SOURCE).toMatch(/shelves\.rename\(/)
    expect(SOURCE).toMatch(/editing\.mode === 'create'/)
  })

  it('names the shelf and its count before it is deleted (D9, AC16)', () => {
    // The confirmation's job is that a person cannot delete a shelf believing
    // they are deleting books
    expect(SOURCE).toContain('Delete the shelf \u201c')
    expect(SOURCE).toContain('books stay in your library')
  })

  it('deletes no book', () => {
    // The one thing this file must not reach for: shelf deletion is a file
    // write, and books are not in it
    expect(SOURCE).not.toMatch(/deleteBook|deleteBooks|deletingBookId|deletingSelection/)
  })

  it('reports a refusal through the session reporter', () => {
    expect(SOURCE).toMatch(/reportShelfFailure/)
  })

  it('gates its writes on the status the write gate reads (R7)', () => {
    expect(SOURCE).toMatch(/state === 'connected'/)
    expect(SOURCE).toMatch(/copy\.deleteBlocked/)
  })

  it('is not a drop target yet \u2014 slice 3 owns drag', () => {
    expect(SOURCE).not.toMatch(/onDragOver|onDrop|dataTransfer/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/components/layout/shelf-list-wiring.test.ts`
Expected: `ENOENT` — the component does not exist.

- [ ] **Step 3: Write the component**

```tsx
import { useEffect, useState } from 'react'
import type { ShelfSummary } from '@shared/shelf.types'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useShelvesStore } from '@/stores/shelves.store'
import { CheckIcon, CloseIcon, PencilIcon, PlusIcon, TrashIcon } from '@/components/shared/icons'
import { reportShelfFailure } from '@/lib/shelf-feedback'
import { useDialogFocus } from '@/hooks/useDialogFocus'

/** Which row's name is being typed. Local: it is about this column, not the app. */
type Editing = { mode: 'create' } | { mode: 'rename'; id: string } | null

/**
 * The Shelves section of the sidebar (D9).
 *
 * Three things about its shape are deliberate:
 *
 * - **Its writes are attempted, not synced.** Nothing here updates the list
 *   after a create, rename or delete: main broadcasts `shelves:changed` and
 *   `useLibrary` re-reads, so the sidebar cannot show a shelf the share refused
 *   to write. The cost is one round trip of latency after Enter; the benefit is
 *   one source of truth.
 * - **A refusal keeps the field open, with the text in it.** Main's sentence
 *   says what was wrong with the name (empty, too long, already taken); a field
 *   that closed on refusal would make the user type it again to find out.
 * - **The confirmation is local.** Exactly one surface opens it, so it does not
 *   belong in `ui.store` beside the dialogs that five surfaces share (R8).
 *
 * Slice 4 adds *Send to ‹device›* above *Delete Shelf…*; slice 3 makes the rows
 * drop targets. Neither is stubbed here.
 */
export function ShelfList() {
  const dialogRef = useDialogFocus()
  const shelves = useShelvesStore((s) => s.shelves)
  const activeShelfId = useLibraryStore((s) => s.activeShelfId)
  const setActiveShelf = useLibraryStore((s) => s.setActiveShelf)
  const online = useNASStore((s) => s.status?.state === 'connected')
  const label = useNASStore((s) => s.status?.copy.label ?? undefined)
  const deleteBlocked = useNASStore((s) => s.status?.copy.deleteBlocked ?? undefined)

  const [editing, setEditing] = useState<Editing>(null)
  const [name, setName] = useState('')
  const [menu, setMenu] = useState<{ shelf: ShelfSummary; x: number; y: number } | null>(null)
  const [confirming, setConfirming] = useState<ShelfSummary | null>(null)

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null)
    const onScroll = () => setMenu(null)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [menu])

  const startCreate = () => {
    setName('')
    setEditing({ mode: 'create' })
    setMenu(null)
  }

  const startRename = (shelf: ShelfSummary) => {
    setName(shelf.name)
    setEditing({ mode: 'rename', id: shelf.id })
    setMenu(null)
  }

  /**
   * Enter commits, Escape and blur cancel, and an empty name is a cancel rather
   * than a refusal: an abandoned field is not an error to report.
   */
  const commit = async () => {
    if (!editing) return
    const trimmed = name.trim()
    if (!trimmed) {
      setEditing(null)
      return
    }
    try {
      if (editing.mode === 'create') await window.Musaeum.shelves.create(trimmed)
      else await window.Musaeum.shelves.rename(editing.id, trimmed)
      setEditing(null)
      // A create selects nothing: the new row appears and the view stays where
      // the user put it (the sheet's `+` does not jump either)
    } catch (err) {
      reportShelfFailure(err)
    }
  }

  const remove = async (shelf: ShelfSummary) => {
    setConfirming(null)
    try {
      await window.Musaeum.shelves.delete(shelf.id)
    } catch (err) {
      reportShelfFailure(err)
    }
  }

  return (
    <div className="mb-4 px-2">
      <div className="flex items-center gap-1 px-2 pb-1">
        <span className="font-display text-[11px] uppercase tracking-wider text-parchment-faint">
          Shelves
        </span>
        <button
          onClick={startCreate}
          disabled={!online}
          title={online ? 'New shelf' : label}
          aria-label="New shelf"
          className="ml-auto rounded p-0.5 text-parchment-faint transition-colors hover:text-gold-400 disabled:pointer-events-none disabled:opacity-40"
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {shelves.length === 0 && !editing && (
        <p className="px-2 py-1 text-[12px] text-parchment-faint">Drag books here to start a shelf</p>
      )}

      {editing?.mode === 'create' && (
        <NameField value={name} onChange={setName} onCommit={commit} onCancel={() => setEditing(null)} />
      )}

      {shelves.map((shelf) => {
        const active = shelf.id === activeShelfId
        return (
          <div key={shelf.id}>
            {editing?.mode === 'rename' && editing.id === shelf.id ? (
              <NameField
                value={name}
                onChange={setName}
                onCommit={commit}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <button
                onClick={() => setActiveShelf(shelf.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ shelf, x: e.clientX, y: e.clientY })
                }}
                onDoubleClick={() => startRename(shelf)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
                  active
                    ? 'bg-ink-800 font-medium text-parchment'
                    : 'text-parchment-dim hover:bg-ink-800 hover:text-parchment'
                }`}
              >
                <span className="truncate">{shelf.name}</span>
                <span className="ml-auto text-[11px] tabular-nums text-parchment-faint">
                  {shelf.count}
                </span>
              </button>
            )}
          </div>
        )
      })}

      {menu && (
        <div className="fixed inset-0 z-50" onClick={() => setMenu(null)} onContextMenu={() => setMenu(null)}>
          <div
            role="menu"
            onClick={(e) => e.stopPropagation()}
            style={{ left: menu.x, top: menu.y }}
            className="absolute w-44 animate-fade-in overflow-hidden rounded-lg border border-ink-700 bg-ink-850 py-1 shadow-cover-lift"
          >
            <button
              role="menuitem"
              disabled={!online}
              title={online ? undefined : label}
              onClick={() => startRename(menu.shelf)}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:pointer-events-none disabled:opacity-40"
            >
              <PencilIcon className="h-3.5 w-3.5" />
              Rename
            </button>
            {/* Slice 4's Send to ‹device› slots in here. */}
            <button
              role="menuitem"
              disabled={!online}
              title={deleteBlocked}
              onClick={() => {
                setConfirming(menu.shelf)
                setMenu(null)
              }}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-danger-500/15 hover:text-danger-400 disabled:pointer-events-none disabled:opacity-40"
            >
              <TrashIcon className="h-3.5 w-3.5" />
              Delete Shelf…
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
          onClick={() => setConfirming(null)}
        >
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-cover-lift"
          >
            <h2 className="font-display text-lg leading-snug text-parchment">
              Delete the shelf “{confirming.name}”?
            </h2>
            <p className="mt-2 text-[12px] leading-relaxed text-parchment-dim">
              Its {confirming.count} books stay in your library.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                data-autofocus
                onClick={() => setConfirming(null)}
                className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment"
              >
                Cancel
              </button>
              <button
                onClick={() => void remove(confirming)}
                className="flex items-center gap-2 rounded-md bg-danger-500 px-3 py-1.5 text-[13px] font-semibold text-on-danger hover:bg-danger-500/90"
              >
                <TrashIcon className="h-4 w-4" />
                Delete shelf
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The inline name field: Enter commits, Escape cancels, blur cancels, and the
 * field is what holds focus from the moment it opens, so `+` then a name then
 * Enter is one uninterrupted gesture.
 */
function NameField({
  value,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  onChange(next: string): void
  onCommit(): void
  onCancel(): void
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void onCommit()
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={onCancel}
      maxLength={80}
      placeholder="Shelf name"
      aria-label="Shelf name"
      className="mb-0.5 w-full rounded-md border border-gold-500/60 bg-ink-850 px-2 py-1 text-[13px] text-parchment placeholder:text-parchment-faint focus:border-gold-500"
    />
  )
}
```

Two notes on the code, both deliberate: **the `+` is disabled while the status is not `connected`** (R7) — the rename *menu item* likewise, and **Delete Shelf… carries `copy.deleteBlocked`** while the others carry `copy.label`, because only one of those sentences is delete-shaped. And **`CloseIcon` is imported but unused in the sketch above** — drop it, or use it for the field's cancel affordance if you add one; `npm run lint` will say.

- [ ] **Step 4: Run the walk**

Run: `npm test -- src/components/layout/shelf-list-wiring.test.ts`
Expected: seven pass.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint`
Expected: clean. (`npm test` runs at the end of Task 9, when the component is mounted — an unmounted component is fine, but its own walk is what this task's commit needs.)

```bash
git add src/components/layout/ShelfList.tsx src/components/layout/shelf-list-wiring.test.ts
git commit -m "shelves slice 2: the sidebar's shelf section

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Review Focus 3 lives here:** a rename field open while `shelves:changed` lands must not be clobbered. This component reads the list from the store on every render but holds `name` in local state, so an arriving list cannot overwrite what is being typed — the new row set is drawn, the field stays, and the shelf being renamed either is still there (normal) or is not (the field commits into *"That shelf no longer exists"*). Check that in review: **no effect in this file writes `name`.**

---

### Task 9: the Library row becomes navigation (AC17)

**Files:**

- Modify: `src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Make the Library row a button with an honest highlight**

The row's own comment block stays; the element and its classes change:

```tsx
  const activeShelfId = useLibraryStore((s) => s.activeShelfId)
  const setActiveShelf = useLibraryStore((s) => s.setActiveShelf)
  const libraryActive = activeShelfId === null
```

```tsx
        <nav className="mb-4 px-2">
          {/* Navigation, not a label: clicking it leaves whatever shelf is open
              (D9). The highlight is the same pair the shelf rows use, which is
              what makes "where am I" one glance rather than two rules. */}
          <button
            onClick={() => setActiveShelf(null)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
              libraryActive
                ? 'bg-ink-800 font-medium text-parchment'
                : 'text-parchment-dim hover:bg-ink-800 hover:text-parchment'
            }`}
          >
            Library
            {/* …the reload button and the count, unchanged… */}
          </button>
```

`<ShelfList />` is mounted between the `nav` and `<FilterSidebar />`:

```tsx
        <ShelfList />
        <FilterSidebar />
```

with the import added at the top, and one sentence added to the file's own comments where the `nav` block discusses what belongs in this column: shelves are places, so they are navigation — the same argument that moved Migration out.

- [ ] **Step 2: Decide the geometry claim (invariant 7)**

There is no row-height *test* in this tree — the spec's phrase has no file behind it (a check made while writing this plan: `grep ROW_HEIGHT` finds the three components, and no `.test.ts` mentions it). So the claim is decided the two ways that are real: **a diff** and **a walk**. Add the walk cases to `src/components/layout/shelf-list-wiring.test.ts`:

```ts
const APP = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')
const GRID = readFileSync(
  join(process.cwd(), 'src', 'components', 'library', 'GridView.tsx'),
  'utf8'
)
const LIST = readFileSync(
  join(process.cwd(), 'src', 'components', 'library', 'ListView.tsx'),
  'utf8'
)

describe('no element is added above either view (invariant 7)', () => {
  it('leaves the toolbar row exactly as it was: toolbar, banner, view', () => {
    // A view header naming the open shelf was designed and rejected for this
    // reason; the shelf is named in the sidebar row and the search field's
    // placeholder instead
    const main = APP.indexOf('<main')
    const between = APP.slice(APP.lastIndexOf('<Toolbar', main), main)
    expect(between.match(/<[A-Z]/g)?.length).toBe(2) // Toolbar, NASStatusBanner
  })

  it('leaves the two views\u2019 geometry constants and cells alone', () => {
    // The constants are computed, not measured (library-views.md); they are the
    // thing this slice must not touch, and the cells that carry them are
    // asserted by their own block-level shape rather than here
    expect(GRID).toMatch(/cardWidth \* 1\.5 \+ CARD_META_MARGIN \+ CARD_META_HEIGHT/)
    expect(LIST).toMatch(/ROW_HEIGHT/)
  })
})
```

and read the diff:

Run: `git diff --stat src/components/library/GridView.tsx src/components/library/ListView.tsx src/components/library/BookCard.tsx`
Expected: `GridView.tsx` and `ListView.tsx` show **3 + 3 insertions, no deletions** — the `shelfId` in the result-set key (Task 1) and the one line feeding `libraryViewState` (Task 7). `BookCard.tsx` shows **nothing at all**: the card's hover trash button routes through the store action Task 15 changes, so the component does not move. A deletion in any of the three is the thing to stop on.

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: everything green.

```bash
git add src/components/layout/Sidebar.tsx
git commit -m "shelves slice 2: Library is a door, and the shelves are places

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: the sort control and the placeholder (AC17, AC18)

**Files:**

- Modify: `src/components/layout/Toolbar.tsx`
- Modify: `src/components/shared/SearchBar.tsx`

- [ ] **Step 1: Write the failing walk**

Beside Task 8's file (or in it — it is the same claim family, and one file per surface is the repo's habit; **put these in `src/components/layout/shelf-list-wiring.test.ts` to keep the file count down**, and rename nothing):

```ts
describe('the sort control (AC18)', () => {
  it('offers Date Added to Shelf only while a shelf is open', () => {
    expect(TOOLBAR).toMatch(/SHELF_SORT_OPTIONS/)
    expect(TOOLBAR).toMatch(/activeShelfId \? \[\.\.\.SHELF_SORT_OPTIONS, \.\.\.SORT_OPTIONS\]/)
  })

  it('offers both directions of it, and nothing else new', () => {
    expect(TOOLBAR).toMatch(/\{ field: 'shelf_added', direction: 'desc' \}/)
    expect(TOOLBAR).toMatch(/\{ field: 'shelf_added', direction: 'asc' \}/)
  })
})

describe('the placeholder (AC17)', () => {
  it('names the open shelf, read from the list rather than stored', () => {
    expect(SEARCH).toMatch(/shelfById\(/)
    expect(SEARCH).toContain('Search \u201c')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/components/layout/shelf-list-wiring.test.ts`
Expected: four fail.

- [ ] **Step 3: Add the two options and the placeholder**

In `Toolbar.tsx`, beside `SORT_OPTIONS`:

```ts
/**
 * *Date Added to Shelf* — D8's default inside a shelf, and meaningless outside
 * one: at library level there is no shelf to have been added to. So it is
 * offered only while a shelf is open, where it is also first.
 */
const SHELF_SORT_OPTIONS: BookSort[] = [
  { field: 'shelf_added', direction: 'desc' },
  { field: 'shelf_added', direction: 'asc' }
]
```

and in the component:

```tsx
  const activeShelfId = useLibraryStore((s) => s.activeShelfId)
  const sortValue = key(sort)
  const offered = activeShelfId ? [...SHELF_SORT_OPTIONS, ...SORT_OPTIONS] : SORT_OPTIONS
  // A list-view header can select a combination this list doesn't carry (e.g.
  // Author Z–A); append it so the select never falls back to a wrong option
  const options = offered.some((o) => key(o) === sortValue) ? offered : [...offered, sort]
```

In `SearchBar.tsx`:

```tsx
  const activeShelfId = useLibraryStore((s) => s.activeShelfId)
  // The name is looked up in the list rather than kept beside the id (R3), so a
  // rename — here, from the phone, by an adoption — follows without a second
  // write path. Empty until the first list lands, which is why the stock
  // sentence is the fallback rather than a substitute.
  const shelfName = useShelvesStore((s) => shelfById(s, activeShelfId)?.name ?? null)
```

```tsx
        placeholder={shelfName ? `Search “${shelfName}”` : 'Search titles, authors, series…'}
```

- [ ] **Step 4: Run the walks**

Run: `npm test -- src/components/layout/shelf-list-wiring.test.ts`
Expected: eleven pass.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: whole suite green.

```bash
git add src/components/layout/Toolbar.tsx src/components/shared/SearchBar.tsx src/components/layout/shelf-list-wiring.test.ts
git commit -m "shelves slice 2: the sort control and the placeholder know the shelf

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**— Part 2b review gate.** Green and reviewed before Task 11. The reviewer's list: R7's two-copy rule at every disabled control in `ShelfList`; invariant 7 (a geometry constant touched, a cell's block-level child changed, or an element added between `<Toolbar />` and `<main>` is a failure, not a fix — the check is Task 9's walk plus the diff); the empty-shelf sentence verbatim against D9; and that `ShelfList` has no effect writing `name`. **Live check (part 2):** `/verify` over CDP — create a shelf with `+`, rename it by double-click, delete it through the confirmation, and read the two sentences off the DOM (the placeholder text and the empty-shelf copy). The probe's own frames decide what is painted; the walks above only prove what is wired.

---

# Part 2c — the book paths

### Task 11: `shelf-membership.ts` — the writes and the Undo (AC19, AC20, AC22, note 2)

**Files:**

- Create: `src/lib/shelf-membership.ts`
- Create: `src/lib/shelf-membership.test.ts`

- [ ] **Step 1: Write the failing cases — note 2's first**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShelfMembership, ShelfSummary } from '@shared/shelf.types'
import { describeAdd, removeFromShelf, undoRemove } from './shelf-membership'

const SHELF: ShelfSummary = { id: 's1', name: 'To Read', kind: 'manual', count: 9 }

/** `window.Musaeum.shelves`, reduced to the four members this module touches. */
function stubShelves(handlers: {
  addBooks?(id: string, ids: string[]): Promise<{ added: number; alreadyOn: number }>
  removeBooks?(id: string, ids: string[]): Promise<ShelfMembership[]>
  restoreBooks?(id: string, memberships: ShelfMembership[]): Promise<void>
}) {
  const calls = { add: [] as unknown[], remove: [] as unknown[], restore: [] as unknown[] }
  vi.stubGlobal('window', {
    Musaeum: {
      shelves: {
        addBooks: (id: string, ids: string[]) => {
          calls.add.push([id, ids])
          return handlers.addBooks?.(id, ids) ?? Promise.resolve({ added: 0, alreadyOn: 0 })
        },
        removeBooks: (id: string, ids: string[]) => {
          calls.remove.push([id, ids])
          return handlers.removeBooks?.(id, ids) ?? Promise.resolve([])
        },
        restoreBooks: (id: string, memberships: ShelfMembership[]) => {
          calls.restore.push([id, memberships])
          return handlers.restoreBooks?.(id, memberships) ?? Promise.resolve()
        }
      }
    }
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())
```

The note-2 cases, which are the point of this task:

```ts
describe('the Undo hands back exactly what main gave it (note 2, AC22)', () => {
  const REMOVED: ShelfMembership[] = [
    { bookId: 'a', addedAt: '2026-09-01T10:00:00.000Z' },
    { bookId: 'b', addedAt: '2026-09-02T11:30:00.000Z' }
  ]

  it('passes the array through untouched', async () => {
    const calls = stubShelves({ removeBooks: async () => REMOVED })
    const removed = await removeFromShelf(SHELF, ['a', 'b'])
    expect(calls.remove).toEqual([['s1', ['a', 'b']]])
    // Not "a restore happened" but *this* restore: the same array, in the same
    // order, with the same timestamps. A re-stamped `addedAt` would put both
    // books at the top of the shelf while every call still succeeded
    expect(calls.restore).toEqual([]) // the Undo is offered, not run, until pressed
    undoRemove(SHELF.id, removed)()
    expect(calls.restore).toEqual([['s1', REMOVED]])
  })

  it('does not drop an entry whose timestamp main will itself skip', () => {
    // Main skips a membership with no `addedAt` and restores the rest, silently
    // — a partial restore is not an error. If this module *also* filtered, the
    // two silences would compound and nothing on screen would say a book is
    // missing from the shelf
    const odd: ShelfMembership[] = [{ bookId: 'a', addedAt: '' }]
    const calls = stubShelves({})
    undoRemove(SHELF.id, odd)()
    expect(calls.restore).toEqual([['s1', odd]])
  })

  it('never consults a clock', () => {
    const calls = stubShelves({})
    const frozen = new Date('2030-01-01T00:00:00.000Z')
    vi.setSystemTime(frozen)
    undoRemove(SHELF.id, REMOVED)()
    const [, handed] = calls.restore[0] as [string, ShelfMembership[]]
    expect(handed).toEqual(REMOVED)
    expect(handed).not.toEqual(handed.map((m) => ({ ...m, addedAt: frozen.toISOString() })))
    vi.useRealTimers()
  })

  it('reports a refused restore once, and does not throw into the toast', async () => {
    const calls = stubShelves({
      restoreBooks: async () => Promise.reject(new Error('That shelf no longer exists'))
    })
    expect(() => undoRemove(SHELF.id, REMOVED)()).not.toThrow()
    await Promise.resolve()
    expect(calls.restore).toHaveLength(1)
  })
})
```

and the reporting cases:

```ts
describe('describeAdd (R9)', () => {
  it('counts what landed and what was already there', () => {
    expect(describeAdd('To Read', { added: 3, alreadyOn: 0 })).toBe('Added 3 to To Read')
    expect(describeAdd('To Read', { added: 2, alreadyOn: 1 })).toBe(
      'Added 2 to To Read · 1 already there'
    )
  })

  it('says the plain truth when nothing landed', () => {
    expect(describeAdd('To Read', { added: 0, alreadyOn: 3 })).toBe('Already on To Read')
  })

  it('says nothing when nothing happened', () => {
    // The unknown-ids row: main skips them, so both counts are zero and there is
    // no news — "Added 0 to To Read" is a sentence nobody should read
    expect(describeAdd('To Read', { added: 0, alreadyOn: 0 })).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/lib/shelf-membership.test.ts`
Expected: the module does not exist.

- [ ] **Step 3: Write the module**

```ts
import type { ShelfAddResult, ShelfMembership, ShelfSummary } from '@shared/shelf.types'
import { useUIStore } from '@/stores/ui.store'
import { reportShelfFailure } from '@/lib/shelf-feedback'

/**
 * Putting books on a shelf and taking them off, and the two reports that go with
 * them (D9).
 *
 * One module rather than a call at each surface, because there are five of them
 * — the context menu in both scopes, the selection panel, the picker and the
 * detail panel's chips — and the remove/Undo pair is too easy to get subtly
 * wrong to leave to each.
 *
 * **The timestamps are the point.** `removeBooks` answers with the memberships
 * it removed, `{ bookId, addedAt }` (camelCase on the bridge; `added_at` is the
 * *file's* spelling), and `restoreBooks` puts them back **with those values**,
 * which is what returns a book to its place under *Date Added to Shelf* rather
 * than to the top of it. So they travel untouched: nothing here re-stamps,
 * rebuilds, reorders, filters or renames them — including a membership main will
 * itself skip, because a partial restore is by design and silent, and a second
 * silent filter here would hide a book with nothing on screen saying so.
 *
 * Every function reports its own failure once (through the session reporter) and
 * answers null rather than throwing, so a caller cannot forget — the picker's
 * rows are buttons, and an unhandled rejection behind one is a click that looks
 * like it did nothing.
 */

/** What an add says, or null when it has nothing to report (D9, R9). */
export function describeAdd(shelfName: string, result: ShelfAddResult): string | null {
  if (result.added === 0 && result.alreadyOn === 0) return null
  if (result.added === 0) return `Already on ${shelfName}`
  return result.alreadyOn > 0
    ? `Added ${result.added} to ${shelfName} · ${result.alreadyOn} already there`
    : `Added ${result.added} to ${shelfName}`
}

/** Add books to a shelf, and say what landed. */
export async function addToShelf(
  shelf: ShelfSummary,
  bookIds: string[]
): Promise<ShelfAddResult | null> {
  try {
    const result = await window.Musaeum.shelves.addBooks(shelf.id, bookIds)
    const message = describeAdd(shelf.name, result)
    if (message) useUIStore.getState().notify({ kind: 'success', message })
    return result
  } catch (err) {
    reportShelfFailure(err)
    return null
  }
}

/** The Undo's work: hand main back exactly what main handed over. */
export function undoRemove(shelfId: string, removed: ShelfMembership[]): () => void {
  return () => {
    void window.Musaeum.shelves
      .restoreBooks(shelfId, removed)
      .catch((err) => reportShelfFailure(err))
  }
}

/** Take books off a shelf, report it, and offer the Undo. */
export async function removeFromShelf(
  shelf: ShelfSummary,
  bookIds: string[]
): Promise<ShelfMembership[] | null> {
  try {
    const removed = await window.Musaeum.shelves.removeBooks(shelf.id, bookIds)
    if (removed.length > 0) {
      useUIStore.getState().notify({
        kind: 'success',
        message: `Removed ${removed.length} from ${shelf.name}`,
        action: { label: 'Undo', run: undoRemove(shelf.id, removed) }
      })
    }
    return removed
  } catch (err) {
    reportShelfFailure(err)
    return null
  }
}
```

`notify`'s `success` lifetime (6000 ms) and `Toast.action` are the existing surface — D9: "No toast changes".

- [ ] **Step 4: Run the cases**

Run: `npm test -- src/lib/shelf-membership.test.ts`
Expected: all pass. If the `vi.setSystemTime` case needs `vi.useFakeTimers()` first, add it and restore in `afterEach`.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test -- src/lib/shelf-membership.test.ts`
Expected: clean.

```bash
git add src/lib/shelf-membership.ts src/lib/shelf-membership.test.ts
git commit -m "shelves slice 2: the add, the remove, and the Undo that keeps its timestamps

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: the picker (AC19)

**Files:**

- Create: `src/components/library/ShelfPicker.tsx`
- Modify: `src/stores/ui.store.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the store target**

In `src/stores/ui.store.ts`, beside `deletingBookId`:

```ts
  /**
   * Books the *Add to Shelf…* picker is open for — the scope of the click or of
   * the selection. A list rather than a single id because the picker is the same
   * dialog for one book and for twelve: what changes is which shelves are
   * ticked, and only a single book is ever ticked (D9).
   */
  shelfPicker: { bookIds: string[] } | null
```

beside `requestDelete`:

```ts
      // Same rule as every other dialog: the menu that opened it goes
      requestShelfPicker: (shelfPicker) => set({ shelfPicker, contextMenu: null }),
```

and the initial `shelfPicker: null`. **Do not** add it to `persistedUIState` — it is what is on screen right now, which is what that function's docblock says it is the whole of.

- [ ] **Step 2: Write the picker**

```tsx
import { useEffect, useState } from 'react'
import type { ShelfSummary } from '@shared/shelf.types'
import { useNASStore } from '@/stores/nas.store'
import { useShelvesStore } from '@/stores/shelves.store'
import { useUIStore } from '@/stores/ui.store'
import { CheckIcon, PlusIcon, SpinnerIcon } from '@/components/shared/icons'
import { useDialogFocus } from '@/hooks/useDialogFocus'
import { addToShelf, removeFromShelf } from '@/lib/shelf-membership'
import { reportShelfFailure } from '@/lib/shelf-feedback'

/**
 * *Add to Shelf…* (D9, AC19) — a dialog rather than a flyout submenu (R2), so
 * Escape, Tab containment and first focus come from `useDialogFocus` instead of
 * hand-rolled hover intent.
 *
 * For **one** book the shelves it is already on carry a check and choosing one
 * takes it off (with Undo); for a **selection** there is nothing to tick — the
 * shelves are actions, and the click adds every book of the scope. *New Shelf…*
 * creates with the scope's books and closes: the shelf exists, the sidebar shows
 * it, and nothing else about the view changes.
 *
 * The checks come from `forBook`, which is per book and cached in the shelves
 * store; `revision` is what makes them re-ask when membership moves.
 */
export function ShelfPicker() {
  const dialogRef = useDialogFocus()
  const target = useUIStore((s) => s.shelfPicker)
  const requestShelfPicker = useUIStore((s) => s.requestShelfPicker)
  const shelves = useShelvesStore((s) => s.shelves)
  const revision = useShelvesStore((s) => s.revision)
  const byBook = useShelvesStore((s) => s.byBook)
  const loadForBook = useShelvesStore((s) => s.loadForBook)
  const online = useNASStore((s) => s.status?.state === 'connected')
  const label = useNASStore((s) => s.status?.copy.label ?? undefined)

  const [busy, setBusy] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const bookIds = target?.bookIds ?? []
  const one = bookIds.length === 1 ? bookIds[0] : null

  useEffect(() => {
    if (one) void loadForBook(one)
  }, [one, revision, loadForBook])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestShelfPicker(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestShelfPicker])

  if (!target) return null

  const on = new Set(one ? (byBook[one] ?? []).map((s) => s.id) : [])

  const act = async (shelf: ShelfSummary) => {
    if (!online || busy) return
    setBusy(shelf.id)
    try {
      if (on.has(shelf.id)) await removeFromShelf(shelf, bookIds)
      else await addToShelf(shelf, bookIds)
    } finally {
      setBusy(null)
    }
  }

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setCreating(false)
      return
    }
    try {
      await window.Musaeum.shelves.create(trimmed, bookIds)
      requestShelfPicker(null)
    } catch (err) {
      reportShelfFailure(err)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
      onClick={() => requestShelfPicker(null)}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Add to Shelf"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-cover-lift"
      >
        <h2 className="font-display text-lg leading-snug text-parchment">Add to Shelf</h2>
        <p className="mt-0.5 text-[12px] text-parchment-faint">
          {bookIds.length} book{bookIds.length === 1 ? '' : 's'}
        </p>

        <div className="mt-4 max-h-72 space-y-0.5 overflow-y-auto">
          {shelves.map((shelf) => (
            <button
              key={shelf.id}
              disabled={!online || busy !== null}
              title={online ? undefined : label}
              onClick={() => void act(shelf)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:pointer-events-none disabled:opacity-40"
            >
              <span className="w-4">
                {busy === shelf.id ? (
                  <SpinnerIcon className="h-3.5 w-3.5" />
                ) : on.has(shelf.id) ? (
                  <CheckIcon className="h-3.5 w-3.5 text-gold-400" />
                ) : null}
              </span>
              <span className="truncate">{shelf.name}</span>
              <span className="ml-auto text-[11px] tabular-nums text-parchment-faint">
                {shelf.count}
              </span>
            </button>
          ))}

          {creating ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create()
                if (e.key === 'Escape') setCreating(false)
              }}
              onBlur={() => setCreating(false)}
              maxLength={80}
              placeholder="Shelf name"
              aria-label="Shelf name"
              className="w-full rounded-md border border-gold-500/60 bg-ink-850 px-2 py-1.5 text-[13px] text-parchment placeholder:text-parchment-faint focus:border-gold-500"
            />
          ) : (
            <button
              disabled={!online}
              title={online ? undefined : label}
              onClick={() => {
                setName('')
                setCreating(true)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:pointer-events-none disabled:opacity-40"
            >
              <span className="w-4">
                <PlusIcon className="h-3.5 w-3.5" />
              </span>
              New Shelf…
            </button>
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            onClick={() => requestShelfPicker(null)}
            className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
```

Mount it in `src/App.tsx` beside `RemoveFromDeviceDialog` (no key: it reads its target from the store, and returns null without one):

```tsx
      <RemoveFromDeviceDialog />
      <ShelfPicker />
```

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green. The picker has no walk of its own yet; Task 13 gives its two doors theirs, and that is when the whole path is checkable.

```bash
git add src/components/library/ShelfPicker.tsx src/stores/ui.store.ts src/App.tsx
git commit -m "shelves slice 2: the Add to Shelf picker

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: the two menu scopes and the selection panel (AC19)

**Files:**

- Modify: `src/components/library/BookContextMenu.tsx`
- Modify: `src/components/library/SelectionPanel.tsx`
- Modify: `src/components/library/context-menu-wiring.test.ts`

- [ ] **Step 1: Write the failing walk cases**

Append to `src/components/library/context-menu-wiring.test.ts` (it already reads these two files plus `BookContextMenu`):

```ts
describe('the shelf entries (AC19)', () => {
  const MENU = read('BookContextMenu.tsx')
  const PANEL = read('SelectionPanel.tsx')

  it('offers Add to Shelf… in both scopes and in the panel', () => {
    // Two scopes in one file, so this counts rather than matches once
    expect(MENU.match(/label="Add to Shelf…"/g)?.length).toBe(2)
    expect(PANEL).toContain('Add to Shelf…')
  })

  it('opens the picker through the store, in both scopes', () => {
    expect(MENU.match(/requestShelfPicker\(/g)?.length).toBe(2)
    // The selection scope is the same list the bulk delete uses: the selection
    // itself, read at the moment of the click
    expect(MENU).toMatch(/selection\.ids/)
  })

  it('offers Remove from “shelf” only while a shelf is open, and does it immediately', () => {
    expect(MENU).toMatch(/Remove from “/)
    expect(MENU).toMatch(/removeFromShelf\(/)
    // It does not open a dialog: D9 makes this one immediate, with the Undo
    // standing in for the confirmation
    expect(MENU).not.toMatch(/requestShelfRemove/)
  })

  it('omits the shelf item when the shelf name is not loaded rather than guessing one', () => {
    // A menu item reading Remove from “undefined” is worse than no item; the
    // trash path still offers the shelf's own remove
    expect(MENU).toMatch(/shelfName &&|shelfName \?/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/components/library/context-menu-wiring.test.ts`
Expected: the four new cases fail.

- [ ] **Step 3: Add the entries**

In `BookContextMenu.tsx`, the imports and the two readings:

```tsx
import { shelfById, useShelvesStore } from '@/stores/shelves.store'
import { removeFromShelf } from '@/lib/shelf-membership'
import { useNASStore } from '@/stores/nas.store'
```

```tsx
  const activeShelfId = useLibraryStore((s) => s.activeShelfId)
  const setActiveShelf = useLibraryStore((s) => s.setActiveShelf)
  const shelfName = useShelvesStore((s) => shelfById(s, activeShelfId)?.name ?? null)
  const online = useNASStore((s) => s.status?.state === 'connected')
  const label = useNASStore((s) => s.status?.copy.label ?? undefined)
```

in the **selection** branch, above the Delete item:

```tsx
          <MenuItem
            icon={<BookIcon className="h-3.5 w-3.5" />}
            label="Add to Shelf…"
            disabled={!online}
            title={online ? undefined : label}
            onClick={() => requestShelfPicker({ bookIds: [...selection.ids] })}
          />
```

and in the **single-book** branch, after *Re-fetch metadata* and before the device items:

```tsx
        <MenuItem
          icon={<BookIcon className="h-3.5 w-3.5" />}
          label="Add to Shelf…"
          disabled={!online}
          title={online ? undefined : label}
          onClick={() => requestShelfPicker({ bookIds: [book.id] })}
        />
        {shelfName && (
          // Immediate, with the Undo standing in for a confirmation (D9). Only
          // while a shelf is open, and only once its name is known (R3).
          //
          // This scope and not the selection's: the bulk answer already exists
          // one step away — the selection menu's Delete N books… opens
          // `ShelfRemoveDialog`, whose first button is this same remove. Two
          // doors to one action, which is what D9 asks for.
          <MenuItem
            icon={<CloseIcon className="h-3.5 w-3.5" />}
            label={`Remove from “${shelfName}”`}
            disabled={!online}
            title={online ? undefined : label}
            onClick={() => {
              closeContextMenu()
              const shelf = useShelvesStore.getState().shelves.find((s) => s.id === activeShelfId)
              // This branch *is* the single-book scope — the file resolves the
              // scope once, with `contextMenuScope`, and the selection scope
              // returns above — so the payload is the book alone
              if (shelf) void removeFromShelf(shelf, [book.id])
            }}
          />
        )}
```

(The item sits in the single-book branch only — see the comment in the snippet for why the bulk case is served by the dialog's own first button.) `MenuItem` gains two optional props:

```tsx
function MenuItem({
  icon,
  label,
  danger,
  disabled,
  title,
  onClick
}: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  disabled?: boolean
  title?: string
  onClick(): void
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] ${
        danger
          ? 'text-parchment-dim hover:bg-danger-500/15 hover:text-danger-400'
          : 'text-parchment-dim hover:bg-ink-800 hover:text-parchment'
      } disabled:pointer-events-none disabled:opacity-40`}
    >
      {icon}
      {label}
    </button>
  )
}
```

In `SelectionPanel.tsx`, one button above the delete button, in the same ghost style as *Refresh metadata*:

```tsx
        <button
          disabled={!online}
          title={online ? undefined : label}
          onClick={() => requestShelfPicker({ bookIds: selected.map((b) => b.id) })}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-ink-600 px-3 py-2 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
        >
          <BookIcon className="h-4 w-4" />
          Add to Shelf…
        </button>
```

(`label` from `useNASStore((s) => s.status?.copy.label ?? undefined)`, matching R7. `useNASStore` is already imported in this file; **`BookIcon` is not** — it joins the icon import list at the top, which currently reads `CloseIcon, RefreshIcon, SendIcon, SpinnerIcon, TrashIcon, WarningIcon`.)

- [ ] **Step 4: Run the walks**

Run: `npm test -- src/components/library/context-menu-wiring.test.ts`
Expected: all pass, the pre-existing right-click cases included.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green.

```bash
git add src/components/library/BookContextMenu.tsx src/components/library/SelectionPanel.tsx src/components/library/context-menu-wiring.test.ts
git commit -m "shelves slice 2: Add to Shelf from both menu scopes and the panel

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: the detail panel's chips (AC20)

**Files:**

- Modify: `src/components/library/BookDetail.tsx`
- Modify: `src/components/library/context-menu-wiring.test.ts`

- [ ] **Step 1: Write the failing walk cases**

```ts
describe('the detail panel\u2019s shelves row (AC20)', () => {
  const DETAIL = read('BookDetail.tsx')

  it('lists the book\u2019s shelves from the store, re-asking on every change', () => {
    expect(DETAIL).toMatch(/loadForBook\(/)
    expect(DETAIL).toMatch(/revision/)
  })

  it('navigates on the chip and removes on the ×, with the shared Undo', () => {
    expect(DETAIL).toMatch(/setActiveShelf\(/)
    expect(DETAIL).toMatch(/removeFromShelf\(/)
  })

  it('says so when there are none', () => {
    expect(DETAIL).toContain('Not on any shelf')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/components/library/context-menu-wiring.test.ts`
Expected: three fail.

- [ ] **Step 3: Add the row**

In `BookDetail.tsx`, the readings:

```tsx
  const setActiveShelf = useLibraryStore((s) => s.setActiveShelf)
  const revision = useShelvesStore((s) => s.revision)
  const byBook = useShelvesStore((s) => s.byBook)
  const loadForBook = useShelvesStore((s) => s.loadForBook)
```

an effect beside the file's other per-book effects:

```tsx
  // Membership is per book and cached in the shelves store; `revision` moves
  // whenever main says it moved, which is what makes a REST toggle on the phone
  // show up here without a reload (AC23)
  useEffect(() => {
    if (bookId) void loadForBook(bookId)
  }, [bookId, revision, loadForBook])
```

and the row itself — placed **after the tags block and before the `<dl>`** (the chip block ends at what is currently line 195 and the metadata list begins at 197):

```tsx
        {/* Shelves (D9, AC20). Chips rather than a list, because a book is on
            several; the same chip tokens as the tags above, and a button rather
            than a span because each one goes somewhere. */}
        <div className="mt-4 flex flex-wrap justify-center gap-1.5">
          {bookShelves.length === 0 ? (
            <span className="text-[12px] text-parchment-faint">Not on any shelf</span>
          ) : (
            bookShelves.map((shelf) => (
              <span
                key={shelf.id}
                className="flex items-center gap-1 rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-parchment-faint"
              >
                <button
                  onClick={() => setActiveShelf(shelf.id)}
                  className="max-w-[10rem] truncate transition-colors hover:text-gold-300"
                >
                  {shelf.name}
                </button>
                <button
                  aria-label={`Remove from ${shelf.name}`}
                  title="Remove from shelf"
                  onClick={() => void removeFromShelf(shelf, [book.id])}
                  className="transition-colors hover:text-danger-400"
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </span>
            ))
          )}
        </div>
```

with `const bookShelves = byBook[book.id] ?? []` beside the other derived values (after the early return that guards `book`). The file already imports `CloseIcon`? If not, add it to the icon import list.

- [ ] **Step 4: Run the walks**

Run: `npm test -- src/components/library/context-menu-wiring.test.ts`
Expected: all pass.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green.

```bash
git add src/components/library/BookDetail.tsx src/components/library/context-menu-wiring.test.ts
git commit -m "shelves slice 2: a book's shelves, on the detail panel

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Remove-vs-Delete, and the one place anything is deleted (AC21, AC22)

**Files:**

- Modify: `src/stores/ui.store.ts`
- Create: `src/components/library/ShelfRemoveDialog.tsx`
- Modify: `src/App.tsx`
- Modify: `src/stores/ui.store.test.ts`
- Create: `src/components/library/shelf-remove-wiring.test.ts`

- [ ] **Step 1: Write the failing store cases**

`src/stores/ui.store.test.ts` drives the store directly in the `node` environment and holds **no `window` stub** — and none is needed for these cases: the routing between the trash entry points and the two dialogs is pure state, and the first IPC happens when a dialog's own confirm button is pressed, which is not this task. (That is also why this half of AC21 is decidable at all.) Add:

```ts
import { useLibraryStore } from '@/stores/library.store'

describe('the trash entry points ask the shelf first (AC21)', () => {
  afterEach(() => {
    useLibraryStore.setState({ activeShelfId: null })
    useUIStore.setState({ shelfRemove: null, deletingBookId: null, deletingSelection: false })
  })

  it('with no shelf open, opens exactly the dialog it always did', () => {
    useUIStore.getState().requestDelete('b1')
    expect(useUIStore.getState().deletingBookId).toBe('b1')
    expect(useUIStore.getState().shelfRemove).toBeNull()

    useUIStore.getState().requestSelectionDelete(true)
    expect(useUIStore.getState().deletingSelection).toBe(true)
  })

  it('with a shelf open, opens the shelf's dialog for one book', () => {
    useLibraryStore.setState({ activeShelfId: 's1' })
    useUIStore.getState().requestDelete('b1')
    expect(useUIStore.getState().shelfRemove).toEqual({ shelfId: 's1', bookIds: ['b1'] })
    // Nothing is deleted until the second answer is given
    expect(useUIStore.getState().deletingBookId).toBeNull()
  })

  it('with a shelf open, carries the whole selection for the bulk entry point', () => {
    useLibraryStore.setState({ activeShelfId: 's1' })
    useUIStore.setState({ selection: { ids: new Set(['a', 'b']), anchor: null, cursor: null } })
    useUIStore.getState().requestSelectionDelete(true)
    expect(useUIStore.getState().shelfRemove).toEqual({ shelfId: 's1', bookIds: ['a', 'b'] })
  })

  it('hands over to the dialog that has always owned deletion (D9)', () => {
    useUIStore.setState({ shelfRemove: { shelfId: 's1', bookIds: ['b1'] } })
    useUIStore.getState().requestLibraryDelete()
    expect(useUIStore.getState().shelfRemove).toBeNull()
    expect(useUIStore.getState().deletingBookId).toBe('b1')

    useUIStore.setState({ shelfRemove: { shelfId: 's1', bookIds: ['a', 'b'] } })
    useUIStore.getState().requestLibraryDelete()
    expect(useUIStore.getState().deletingSelection).toBe(true)
  })

  it('cancelling closes the shelf dialog and changes nothing else', () => {
    useUIStore.setState({ shelfRemove: { shelfId: 's1', bookIds: ['b1'] } })
    useUIStore.getState().requestShelfRemove(null)
    expect(useUIStore.getState().shelfRemove).toBeNull()
    expect(useUIStore.getState().deletingBookId).toBeNull()
  })
})
```

> The literal is `Selection`'s own shape (`src/lib/selection.ts:13-19`): `ids` is a `ReadonlySet<string>` and `anchor`/`cursor` are both required. No cast — the `no any` rule covers tests too.

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- src/stores/ui.store.test.ts`
Expected: `shelfRemove` and `requestLibraryDelete` do not exist; the first case passes already (which is the point of it).

- [ ] **Step 3: Route, and hand over**

In `src/stores/ui.store.ts`, the state:

```ts
  /**
   * What the shelf's own remove dialog is open for: the shelf, and the books the
   * trash entry point was pressed for (D9). Set by the two trash actions below
   * *only* while a shelf is open; its second button hands over to
   * `deletingBookId`/`deletingSelection`, which stay the only place anything is
   * deleted.
   */
  shelfRemove: { shelfId: string; bookIds: string[] } | null
```

the actions:

```ts
  requestShelfRemove(target: { shelfId: string; bookIds: string[] } | null): void
  /** The remove dialog's second answer: the library delete, as it always was. */
  requestLibraryDelete(): void
```

and the implementations, replacing the two existing request actions:

```ts
      /**
       * The trash entry points, shelf-aware (D9, AC21).
       *
       * With no shelf open these are the two lines they have always been. With
       * one open they open the shelf's dialog instead — which asks the question
       * the user actually meant, and whose *second* answer hands over to the
       * dialog below, so `deletingBookId`/`deletingSelection` remain the only
       * road to a deletion. The cross-store read is the same one-way
       * `bookOrder()` already makes from here.
       */
      requestDelete: (bookId) => {
        const shelfId = useLibraryStore.getState().activeShelfId
        if (bookId !== null && shelfId) {
          set({ shelfRemove: { shelfId, bookIds: [bookId] }, contextMenu: null })
          return
        }
        set({ deletingBookId: bookId, contextMenu: null })
      },
      requestSelectionDelete: (open) => {
        const shelfId = useLibraryStore.getState().activeShelfId
        const bookIds = [...get().selection.ids]
        if (open && shelfId && bookIds.length > 0) {
          set({ shelfRemove: { shelfId, bookIds }, contextMenu: null })
          return
        }
        set({ deletingSelection: open, contextMenu: null })
      },
      requestShelfRemove: (shelfRemove) => set({ shelfRemove }),
      requestLibraryDelete: () => {
        const { shelfRemove } = get()
        if (!shelfRemove) return
        const single = shelfRemove.bookIds.length === 1
        set({
          shelfRemove: null,
          deletingBookId: single ? shelfRemove.bookIds[0] : null,
          deletingSelection: !single
        })
      },
```

- [ ] **Step 4: Write the dialog**

```tsx
import { useEffect, useState } from 'react'
import { useShelvesStore } from '@/stores/shelves.store'
import { useUIStore } from '@/stores/ui.store'
import { TrashIcon } from '@/components/shared/icons'
import { useDialogFocus } from '@/hooks/useDialogFocus'
import { removeFromShelf } from '@/lib/shelf-membership'

/**
 * The trash entry points' first question while a shelf is open (D9, AC21).
 *
 * Inside a shelf, "delete" is ambiguous: it can mean *off the shelf* (the thing
 * the user is looking at) or *out of the library* (irreversible). This asks, and
 * keeps both answers honest — Remove is immediate and carries the Undo; Delete
 * from Library… hands over to `DeleteBookDialog`/`DeleteSelectionDialog`, which
 * stay the only place anything is deleted, per-format picker and offline notice
 * included.
 *
 * `Remove from Shelf` takes the initial focus, which inverts the usual rule
 * (`useDialogFocus` puts `data-autofocus` on Cancel for a destructive dialog):
 * here the irreversible button is the *other* one.
 */
export function ShelfRemoveDialog() {
  const dialogRef = useDialogFocus()
  const target = useUIStore((s) => s.shelfRemove)
  const requestShelfRemove = useUIStore((s) => s.requestShelfRemove)
  const requestLibraryDelete = useUIStore((s) => s.requestLibraryDelete)
  const shelves = useShelvesStore((s) => s.shelves)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestShelfRemove(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestShelfRemove])

  // A shelf deleted while this dialog is open closes it rather than failing on
  // confirm — the same posture RemoveFromDeviceDialog takes to a device that has
  // been unplugged
  const shelf = shelves.find((s) => s.id === target?.shelfId)
  if (!target || !shelf) return null

  const count = target.bookIds.length
  const what = count === 1 ? `${count} book` : `${count} books`

  const remove = async () => {
    setBusy(true)
    await removeFromShelf(shelf, target.bookIds)
    setBusy(false)
    requestShelfRemove(null)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
      onClick={() => !busy && requestShelfRemove(null)}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Remove from ${shelf.name}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-cover-lift"
      >
        <h2 className="font-display text-lg leading-snug text-parchment">
          Remove {what} from “{shelf.name}”?
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-parchment-dim">
          They stay in your library, and you can undo this.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          {/* The irreversible one, set apart — and deliberately not focused */}
          <button
            disabled={busy}
            onClick={requestLibraryDelete}
            className="flex items-center gap-2 rounded-md border border-danger-500/40 px-3 py-1.5 text-[13px] text-danger-400 hover:bg-danger-500/15 disabled:opacity-40"
          >
            <TrashIcon className="h-4 w-4" />
            Delete from Library…
          </button>
          <button
            data-autofocus
            disabled={busy}
            onClick={() => void remove()}
            className="rounded-md bg-gold-500 px-3 py-1.5 text-[13px] font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40"
          >
            Remove from Shelf
          </button>
        </div>
      </div>
    </div>
  )
}
```

Mount it in `App.tsx` beside the other store-driven dialogs:

```tsx
      <ShelfRemoveDialog />
```

(no key: it returns null without a target, like `RemoveFromDeviceDialog`).

- [ ] **Step 5: Write the wiring walk**

`src/components/library/shelf-remove-wiring.test.ts`:

```ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * AC21's other half: *with no shelf open, every entry point behaves exactly as
 * before*. The store cases decide which dialog opens; this decides that the five
 * entry points still go through the two actions rather than opening a dialog
 * themselves — which is what would break the "no shelf open" case silently, in
 * files this suite never loads.
 *
 * What a walk cannot prove: that a click reaches the handler. That is the probe's
 * (context-menu-wiring.test.ts states the same limit).
 */
const read = (file: string) => readFileSync(join(process.cwd(), 'src', 'components', 'library', file), 'utf8')
const STORE = readFileSync(join(process.cwd(), 'src', 'stores', 'ui.store.ts'), 'utf8')

const ENTRY_POINTS = ['BookCard.tsx', 'BookDetail.tsx', 'SelectionPanel.tsx', 'BookContextMenu.tsx']

describe('every trash entry point (AC21)', () => {
  it.each(ENTRY_POINTS)('%s goes through the store action, not a dialog of its own', (file) => {
    const source = read(file)
    expect(source).toMatch(/requestDelete\(|requestSelectionDelete\(/)
    // The dialogs' own flags are the store's: a component that set one directly
    // would bypass the shelf question
    expect(source).not.toMatch(/deletingBookId\s*[:=]/)
    expect(source).not.toMatch(/deletingSelection\s*[:=]/)
  })

  it('asks the shelf, and only from inside a shelf', () => {
    expect(STORE).toMatch(/activeShelfId/)
    expect(STORE).toMatch(/shelfRemove: \{ shelfId, bookIds/)
  })

  it('hands over to the existing dialog from the remove dialog alone', () => {
    const dialog = read('ShelfRemoveDialog.tsx')
    expect(dialog).toContain('Delete from Library…')
    expect(dialog).toMatch(/requestLibraryDelete\(\)/)
    // The existing dialogs are untouched: the handover sets their targets and
    // they open as they always have
    expect(dialog).not.toMatch(/deleteBook\(|deleteBooks\(/)
  })

  it('focuses Remove, which is the safe answer of the two', () => {
    const dialog = read('ShelfRemoveDialog.tsx')
    const at = dialog.indexOf('Remove from Shelf')
    const open = dialog.lastIndexOf('<button', at)
    expect(dialog.slice(open, at)).toContain('data-autofocus')
  })
})
```

- [ ] **Step 6: Run everything**

Run: `npm run typecheck && npm run lint && npm test`
Expected: everything green — this is the slice's last code commit, so the whole suite is the gate.

```bash
git add src/stores/ui.store.ts src/stores/ui.store.test.ts src/components/library/ShelfRemoveDialog.tsx src/components/library/shelf-remove-wiring.test.ts src/App.tsx
git commit -m "shelves slice 2: inside a shelf, the trash asks first

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**— Part 2c review gate**, then the whole-branch review: `reviewer` against CLAUDE.md's invariants list (**7** no geometry, **9** no `file://`, and 2/3/4/5/11 as "untouched and provably so"), plus note 2's case read line by line — *the renderer's only job is pass-through* — and AC21's wiring walk against the five real entry points. **Live check (part 3):** `/verify` over CDP — with a shelf open, right-click a card and press each of the four routes (card hover trash, detail panel trash, selection panel, the menu's Delete) and read `ShelfRemoveDialog` off the DOM with focus on *Remove from Shelf*; then confirm *Delete from Library…* opens the existing dialog with the right scope. Then press the Undo and read the shelf's order back.

---

### Task 16: the docs that land with this slice

**Files:**

- Modify: `docs/invariants/shelves.md` (the renderer's rules)
- Modify: `docs/invariants/settings-and-editing.md` (note 1's sentence, in the persisted-UI-state section)
- Modify: `docs/invariants/library-views.md` (the empty-shelf state, the sort control, the result-set identity)
- Modify: `docs/invariants/selection-and-keyboard.md` (the prune's cost inside a shelf, D7's sentence)
- Modify: `docs/architecture.md` (the renderer tree: `shelves.store`, `ShelfList`, `ShelfPicker`, `ShelfRemoveDialog`, `shelf-membership`, `shelf-feedback`)
- Modify: `CHANGELOG.md`
- Modify: `tasks.md`
- Modify: `docs/superpowers/specs/2026-09-27-bookshelves-design.md` (**the *Status* line**)
- Modify: this plan (a `## Built — slice 2` record)

- [ ] **Step 1: The invariant docs.** In `shelves.md`, a *The renderer* section carrying the four rules this slice added, each with its failure: the scope is not a filter (so *Clear* cannot break it); the library sort is the only persisted sort, and a stored `shelf_added` is refused; the Undo hands main's `addedAt` values back untouched (and why a partial restore is silent); shelf failures are one sentence per session. In `settings-and-editing.md`, one sentence where the persisted-UI-state rule lives: *"the library's own sort is persisted; a shelf's sort never is"* — that is where a future reader looking for "what does this app remember" will look.

- [ ] **Step 2: The status line.** The spec's *Status* now reads:

```markdown
**Status:** … Slice 1 (storage, service, IPC) landed 2026-09-27 — plan `docs/superpowers/plans/2026-09-27-bookshelves-slice1.md`. Slice 2 (the shelf UI in the renderer) landed **<date>** — plan `docs/superpowers/plans/2026-09-27-bookshelves-slice2.md`. **Next step:** slice 3, drag and drop, against this document (AC24–AC28); the shelf rows slice 2 drew are its drop targets. …
```

Keep the sentences before and after it as they are; replace the *Next step* and add the slice 2 clause.

- [ ] **Step 3: `CHANGELOG.md` and `tasks.md`.** The changelog gets its own entry in the file's established voice. `tasks.md` gets the deferred residue this slice leaves: the empty-shelf pane's two-named-actions gap (*A gap this plan does not close*, with the three options), and anything the review turned up.

- [ ] **Step 4: The plan's own record.** Append `## Built — slice 2` to this file: the commits, the file counts as built against the table above, the test numbers before and after, and every place the build diverged from the plan (there will be some — the picker's copy, a case that had to move).

- [ ] **Step 5: Verify and commit**

Run: `npm run lint && git status --short`
Expected: only the files above. **`package.json`, `package-lock.json`, `docs/rest-api.md` and `electron/main/services/api/shape.test.ts` must still be modified and un-staged** — they belong to another session.

```bash
git add docs/invariants/shelves.md docs/invariants/settings-and-editing.md docs/invariants/library-views.md docs/invariants/selection-and-keyboard.md docs/architecture.md CHANGELOG.md tasks.md docs/superpowers/specs/2026-09-27-bookshelves-design.md docs/superpowers/plans/2026-09-27-bookshelves-slice2.md
git commit -m "shelves slice 2: docs — the renderer's shelf rules, and the spec's next step

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage:** D7 → Tasks 2, 3, 5 (store scope, the three reads, the one subscriber), 7 (the empty pane), 9 (Library as navigation), 10 (the placeholder), 15 (the prune's deliberate cost is unchanged — `useLibrary`'s existing prune effect runs on `books`, and a scoped read changes `books`, so entering a shelf drops invisible selections exactly as D7 says). D8 → Tasks 2 (default, memory, the persisted rule), 10 (the control). D9 → sidebar and rows Task 8, Library row Task 9, the two named surfaces Task 10, the empty-shelf body Task 7, the menu path Tasks 12–14, the remove dialog and its routing Task 15. *Error handling* rows: offline (R7, Tasks 8, 12, 13), share write fails (11: the toast, and the Undo can be retried), unparseable file (6: once per session), deleted on another Mac (5, 8: the scope clears, the mutation's refusal is reported), unknown ids (11, R9: no toast). AC16–AC23 → the table above. Docs the spec says land with the slice → Task 16.
- **Not in this slice, and named where it would have gone:** drag (slice 3 — Task 8's walk asserts its absence), *Send to ‹device›* (slice 4 — Task 8 leaves the seam commented), REST and the smoke script (slice 5), the phone (slice 6).
- **Placeholders:** none. Every code step carries its code, except three things the plan states openly: `NO_FACETS` in Task 2 (a four-line literal to read off `LibraryFacets`), the same in Task 15's selection fixture, and Task 8's unused `CloseIcon` import (which lint will catch). Each is named where it is.
- **Type consistency:** `activeShelfId: string | null` and `librarySort: BookSort` (Task 2) are used by Tasks 3, 5, 8, 9, 10, 13, 14, 15 with those names; `shelves.store`'s `shelves` / `revision` / `byBook` / `load` / `loadForBook` / `invalidate` and the `shelfById` selector (Task 4) are used by Tasks 5, 8, 10, 12, 13, 14; `createShelfFailureReporter` / `reportShelfFailure` (Task 6) everywhere a shelf write can fail; `describeAdd` / `addToShelf` / `removeFromShelf` / `undoRemove` (Task 11) by Tasks 12, 13, 14, 15; `shelfPicker` / `requestShelfPicker` (Task 12) and `shelfRemove` / `requestShelfRemove` / `requestLibraryDelete` (Task 15) by the components named there. `LibraryViewState`'s new `'empty-shelf'` (Task 7) is rendered by `EmptyLibrary` and nowhere else.
- **Review Focus:** each of the five has a case in the task named — 1 (Task 5, `reconcileScope` in the subscriber), 2 (Task 2, `restoredSort`), 3 (Task 8, the review line about `name`), 4 (Tasks 11 and 6), 5 (Tasks 3 and 5, the scope-on-search cases).
- **The two notes:** note 1 → Task 2's *what outlives the session* case, plus `settings-and-editing.md` in Task 16. Note 2 → Task 11's four `Undo hands back exactly what main gave it` cases, read against slice 1's AC5.

## Handoff notes for slice 3 (drag) and slice 4 (Send to ‹device›)

- The shelf rows in `ShelfList` are plain buttons with no drag attributes (Task 8's walk asserts it). Throw targets, `dragover` ring and the `+`-opens-the-name-field behaviour are slice 3's, which is why the `+` here creates on click and does nothing on a drop.
- `ShelfList`'s row menu is deliberately open-ended: *Rename*, a comment marking where *Send to ‹device›* goes, *Delete Shelf…*. Slice 4 adds one `MenuItem` and the >25 confirmation.
- Slice 4 sends `bookIds` — and while a shelf is open the natural source is the scope's loaded rows, `useLibraryStore.getState().books.map((b) => b.id)`, not the shelf's membership in SQL. That is a decision for slice 4's plan; noted here because it is the one place the two differ (a book on the shelf whose file is missing is in `books` but not in `count`).
- `library.store`'s `reconcileScope(existingShelfIds)` already exists and is wired: a slice that adds a second way to leave a shelf (a keyboard shortcut, a view header) should call `setActiveShelf(null)`, not clear `activeShelfId` directly, or the sort will not be restored.
- The failure reporter is a session-wide singleton by design. If a slice ever needs "and now say it again" (a manual Retry button, say), that is a new decision, not a `Set.delete`.

---

## Built — slice 2

**Status:** landed 2026-09-27, `src/` only. Green at every commit (`typecheck`, `lint --max-warnings=0`, `prettier` on code files, full suite).

**Commits** (in order, `71fff98` → tip):

| | | |
| --- | --- | --- |
| `a8ba2a9` | library.store — the scope, the one persisted sort, and the reads that carry it | Tasks 2 + 3, merged |
| `9987936` | the open shelf is part of the result set | Task 1 |
| `c5ced9f` | the shelf store | Task 4 |
| `281e0f6` | one subscriber to `shelves:changed` | Task 5 |
| `bddd55d` | shelf failures are reported once a session | Task 6 |
| `6453d31` | an empty shelf is its own empty state | Task 7 |
| `5db481e` | the sidebar's shelf section | Task 8 |
| `0b997a7` | Library is a door, and the shelves are places | Task 9 |
| `0dc2c48` | the sort control and the placeholder know the shelf | Task 10 |
| `8afa15a` | the add, the remove, and the Undo that keeps its timestamps | Task 11 |
| `b1102fd` | the Add to Shelf picker | Task 12 |
| `5520562` | Add to Shelf from both menu scopes and the panel | Task 13 |
| `e970144` | a book's shelves, on the detail panel | Task 14 |
| `13e1f2d` | inside a shelf, the trash asks first | Task 15 |
| *tip* | docs — the renderer's shelf rules, and the spec's next step | Task 16 |

**Counts, as built against the table at the top.** 2a's 6 files, 2b's 7, 2c's 8 — **21 code files, exactly as budgeted** — plus **11 test files** (7 of them new): **32 `src/` files touched, 13 new**, and 9 docs. `src/types/` unchanged, and **no file under `electron/` or `sidecar/` in any of the 18 commits** (`git diff --name-only a3f5d35..HEAD` → 0). The four files the plan flagged as another session's uncommitted work were already committed at `a3f5d35` by the time this slice ran — nothing needed leaving modified, and every commit staged by name anyway.

**Tests.** `npm test` **1723 passed / 77 files / 2 skipped** → **1819 passed / 84 files / 2 skipped**: +96 cases, +7 files. Eleven of them are the two reviews' (below), and **every new guard was confirmed to fail without its fix before being committed** — a guard that has never been seen red is not a guard.

**Where the build diverged from the plan, all recorded rather than quietly fixed:**

1. **Task 2 landed before Task 1**, and **Tasks 2 and 3 landed as one commit** (`a8ba2a9`). The plan allows the reorder ("if you prefer a green commit at every step…") and acknowledges the coupling: Task 2's four scope cases cannot pass until `load()` carries the scope, so the split would have been red. The commit message names both.
2. **The Library row is not a single button.** The plan's snippet nests the Reload button *inside* the Library button — invalid HTML, and it makes reloading also navigate. It was built as a `role="button"` div with `aria-pressed`, `tabIndex={0}` and an Enter/Space handler, which is valid but left a control inside a control with two tab stops; after the whole-branch review it is a layout wrapper holding **two sibling buttons** (the name, which navigates, and the reload icon, which does not) with `aria-current` carrying the highlight. Measured live: the wrapper has no role, no tab stop and no click; two buttons; the highlight follows the scope. This is the one component shape that changed twice, and the reviewer should look at it.
3. **`shelf-remove-wiring.test.ts` asserts `requestLibraryDelete` without parens.** The dialog passes the reference (`onClick={requestLibraryDelete}`), so the plan's `/requestLibraryDelete\(\)/` never matched. The assertion still reddens if the handover is removed.
4. **`ShelfRemoveDialog`'s docblock does not contain the literal `Remove from Shelf`.** The plan's own wording did, which put that string in the file earlier than the button and made the plan's "focus is on the safe answer" assertion walk backwards to the wrong `<button>`. The assertion is unchanged; the docblock says *"Its primary action takes the initial focus"*.
5. **Task 9's and Task 10's walk cases both live in `shelf-list-wiring.test.ts`** (the plan asked for Task 10's there "to keep the file count down"; Task 9's invariant-7 walks joined them).
6. **Extra cases beyond the plan's list**, each because a real shape was uncovered: R7's *disabled with `copy.label`, not `deleteBlocked`* in `context-menu-wiring.test.ts`; the no-shelf-open bulk case and the "hands over to the dialog that always owned deletion" case in `ui.store.test.ts`; "is mounted once, from the app root" in `shelf-remove-wiring.test.ts`; and the plan's `useLibrary.test.ts` walk gained a case pinning that `loadShelves()` is sequenced *before* `reconcileScope` (the plan described that order only in prose).
7. **`library-emptiness.ts`'s `shelfId` is required**, matching `storageConnected`'s precedent — a scope is not a detail a second view may silently drop. This is what makes the plan's "do Task 2's Steps 1–3 first" note load-bearing in a second way.

**Do not run Prettier over the markdown.** Task 16 says to run `prettier --write` on "the files you touched"; done literally, it rewrote ~400 lines of unrelated formatting across seven already-committed docs (emphasis markers, table padding) — the docs tree is deliberately *not* Prettier-formatted (`npx prettier --check "docs/**/*.md"` fails 48 files). The churn was reverted and the edits re-applied by hand. Format code files; leave prose alone.

**The live check (all three review gates), over CDP against the built app and the real library.** Not a description — DOM reads, with the app launched as `electron . --remote-debugging-port=9223` (a second instance; the user's own `dist/` build was left running and untouched). What was measured:

- *Part 2a* — with a shelf open, the rows changed and the sort control offered *Date Added to Shelf* first; `localStorage`'s `musaeum.library` read `{"sort":{"field":"title","direction":"asc"}}` **while the shelf was open on `shelf_added desc`**, which is note 1 confirmed against a real persisted value rather than a unit case.
- *Part 2b* — `+` → the inline field → Enter created the shelf and the sidebar drew it with its count; double-click opened the rename field prefilled; the row menu's *Delete Shelf…* opened the confirmation naming the shelf; the two sentences were read off the DOM (the placeholder read `Search "Slice 2 probe"`, the empty pane read *This shelf is empty* / *Drag books here, or use Add to Shelf.*).
- *AC17's search scoping, and Review Focus 5* — with `the` typed in the library (5509 matches), entering the empty shelf showed **Nothing matches "the"**: the scope really reaches the search, and the query survived entering and leaving.
- *Part 2c* — menu → *Add to Shelf…* → picker → `Added 1 to Slice 2 probe`; the card's trash inside the shelf opened `ShelfRemoveDialog` with **focus on *Remove from Shelf***; *Delete from Library…* handed over to the real `DeleteBookDialog` (cancelled, never confirmed); *Remove from Shelf* produced the toast and its Undo put the book back.
- **The library was left as found**: `shelves.json` is `{"version":1,"shelves":[]}` (it had no shelves before the probe and has none after), 7121 books in the DB, and the book the delete dialog offered is still there.

**Review findings, and what was done with each.** The 2a review (a `delegate_task` reviewer) found **no blocker and no functional defect**, with five named checks passing against the real code and a pristine copy of `281e0f6` typechecking clean on both tsconfigs with 42/42 on the four 2a test files. Four nits:

1. **`shelves.store.loadForBook` could commit a pre-change answer after `invalidate()` cleared the cache** — the revision exists precisely to prevent this, and the write path bypassed it. **Fixed**: the revision is captured before the read and the write is skipped if it moved, with a case that fails without the guard.
2. **`load()` had no staleness guard** — and this slice gave it a new way to be asked twice at once (two sidebar clicks → two scoped reads whose SQL is not the same cost). **Fixed**, using the same `resultSetKey` the views use so "what a read reads" has one definition, with a case that fails without the guard.
3. **`settings-and-editing.md` still described the old single-validator persisted rule** — it named `isBookSort` and did not say the persisted sort is the library's own. **Fixed** in Task 16 (and the note that `library-views.md` never mentioned `shelf_added` was fixed by the same task).
4. An operational note that the working tree was mid-flight when the review ran (HEAD had moved past `281e0f6`). Nothing to do; the review was correct to evaluate its gate at its own tip.

**The whole-branch review** (a second `delegate_task` reviewer, against CLAUDE.md's invariants list) found **no blocker** and every invariant in scope clean — 7 (both view diffs are selector-only; `App.tsx`'s new mounts are *after* `<main>`, so nothing sits between `<Toolbar />` and the view), 9 (no added line builds a `file://` URL or touches `Musaeum.files`), 2/3/4/5/11 as diff-absence proofs, 1/6/8/10/12 untouched, note 2 read line by line and holding (including that the renderer must pass `addedAt: ''` through, since main's skip is silent), and no conditional hook, missing dependency, stale closure, unhandled rejection or invalid nesting anywhere in the new code. Five worth-fixing items and eight notes; what was done:

1. **Invariant 7's only guard was near-vacuous, and its comment claimed a test that does not exist** (`grep 'block-level' src --include=*.test.ts` returned only that comment). **Fixed**: the walk now pins the three constants' values and the three consuming expressions, and the comment states what a walk cannot prove.
2. **"No element is added above either view" counted upper-case tags only**, so a lowercase element added there also read 2. **Fixed** — the assertion now names the two elements it expects.
3. **AC21's direct-set guard had holes in both directions** — it missed the `{ deletingBookId }` shorthand and false-positived on the legitimate read `App.tsx` performs. **Fixed**, assignment-shaped.
4. **Note 1 had no wiring assertion**, unlike its sibling in `ui.store.test.ts`. **Fixed** — the same walk over `partialize`/`merge`.
5. **Its scope finding — that the range `a3f5d35..HEAD` is not `src/`-only — is correct but not this slice's.** The four version-bump files live in `a3f5d35` ("shelve plan"), the plan commit that was already on `main` at session start; every commit this slice made is `src/`-only, which is the check the record above states. Recorded here so the next reader does not re-open it.

Of its eight notes, four were acted on: the comment-in-handler slice (both walks now strip block comments *before* slicing — the first new attempt at this failed against its own comment, which is the same class of spurious match), the detail panel's `revision` matcher (now the deps array), the `if (shelf)` silent no-op in `BookContextMenu` (documented as deliberate: a shelf that has gone has no membership to remove, and inventing a sentence for it would be a renderer restating copy main owns), and the `byBook` flash (below). Three remain as accepted, recorded limits: the `contextMenuHandler` slice still ends at the first `}}`; `useLibrary.test.ts`'s subscription-list slice is bounded by the cleanup rather than by brace matching; and `ShelfList`'s create-field assertion now checks both expressions rather than one.

**The one defect neither review found, because it needed the app running:** the Library row's count is `books.length` — the *current read's* — so while a shelf was open the row labelled "Library" carried the shelf's number, and an empty shelf made it read **"Library 0"**. **Fixed**: the count is rendered on that row only while the library is what is loaded, and each shelf carries its own count on its own row (from main). Measured live after the fix: `Library7121` unscoped, `Library` under a shelf, `Library7121` on leaving.

**Still open, handed to slice 3:** the empty-shelf pane's sentence names two actions neither of which works from that pane (*A gap this plan does not close*, now in `tasks.md` with the three options). Everything else in the plan's scope landed.
