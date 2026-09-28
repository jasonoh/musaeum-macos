# Bookshelves — slice 3: drag and drop Implementation Plan

> **For agentic workers:** the plan-execution sub-skills slice 2's plan names (`superpowers:subagent-driven-development`, `superpowers:executing-plans`) are **not installed in this environment** — checked 2026-09-28, `skills_list` shows none. Execute the tasks directly, per `.claude/rules/orchestration.md`: the main session is the orchestrator, and the repo agents in `.claude/agents/` sit on the layer boundaries this slice crosses. Steps use checkbox syntax for tracking.

**Goal:** Books reach a shelf by being dragged onto it. Dragging a card or a list row carries the whole selection when the dragged book is part of one and that book alone otherwise; the shelf rows in the sidebar, the **+** and the empty-state **New shelf** row are the drop targets, and dropping on either of the last two creates a shelf with the dragged books. The Finder import overlay stays down throughout, a drop while the share is unreachable is refused rather than attempted, and a drag whose source row scrolls out of the virtualized view before the drop still delivers its payload — with **no main-process change, no IPC change, no preload change, no REST change, and no `src/types/` change**.

**Architecture:** a new `src/lib/book-drag.ts` owns the whole payload contract — `dragScope` (the selection grammar, mirroring `contextMenuScope`), the MIME type, a module-level slot, and `isImportDrag`, the predicate `useDragDrop` already asks. The slot exists because Chromium protects the data store during a drag: `dataTransfer.getData()` answers `''` in `dragover`, so a target that wants to say *"3 books"* while the pointer is over it has nothing to read, and a virtualized source row can unmount mid-drag and never fire anything again. `BookCard`'s outer box and `ListView`'s `<tr>` become the sources; `ShelfList`'s rows, its **+** and its empty-state row become the targets; `src/hooks/useBookDrag.ts` is mounted once and clears the slot on the **window's** `drop`/`dragend`.

**Tech Stack:** React + TypeScript strict, Zustand, Tailwind (design tokens only), vitest in the `node` environment (`npm test`). No DOM harness — see *Global Constraints* for which of the three ways decides what.

**Spec:** `docs/superpowers/specs/2026-09-27-bookshelves-design.md`. Read **D9's *Drag* block**, **D7** (what the open shelf means), **Slice 3's acceptance criteria (AC24–AC28)**, **Risk 3** and **Not verified 2** before starting any task. Read `docs/invariants/shelves.md` (the renderer rules slice 2 landed — this slice adds the drag payload rule beside them), `docs/invariants/library-views.md` (invariant 7 and the virtualization both source types live inside), `docs/invariants/selection-and-keyboard.md` (the selection grammar `dragScope` reads), `docs/invariants/nas-and-catalog.md` (what `assertOnline` refuses) and `docs/invariants/files-and-deletion.md` (nothing here deletes anything; the shelf row's trash icon already routes). `docs/superpowers/plans/2026-09-27-bookshelves-slice2.md` is the plan this one follows; its *Handoff notes for slice 3* section is restated below in full, because a fresh session will not have read it.

---

## Where this plan sits

Slice 3 of six, and the second and last `src/`-only slice. Slice 4 is *Send to ‹device›* (one menu item in the shelf menu slice 2 built, plus a >25 confirmation), slice 5 is the REST contract, slice 6 is the phone. **3 depends on 2** (the rows it drops onto are slice 2's); 4 is parallel with 3; nothing here waits on 5 or 6.

**The baseline this plan was written against:** `d7825c7` (2026-09-28 00:07 EDT), Node v26.8.1, npm 11.19.0 — `npm run typecheck` clean, `npm run lint --max-warnings=0` clean, `npm test` = **84 files, 1820 passed, 2 skipped**. Every count below is that tree's. Twelve of those cases are slice 2's review fixes and two are its false-affordance fix; nothing in this plan assumes any of them can be removed.

**`origin/main` is at `9591da1` — 18 of slice 2's commits, pushed 2026-09-27 23:54 by someone other than the session that wrote this plan.** The two commits after it (`988a1b7` the empty-state fix, `d7825c7` the copy record) are local only. So: check `git log --oneline -3` before you start, and if `origin/main` has moved again, that is someone else's push, not a signal about this slice.

**One tree hazard, hit twice on the night this plan was written.** If `npm run build` fails with `Failed to resolve ./assets/index-*.js from /Users/oh/Projects/musaeum/index.html`, the tree's `index.html` has been rewritten outside the build (replacing `<script type="module" src="/src/main.tsx">` with the hashed bundle references `electron-vite` emits). Nothing in this repo generates that. Restore it — `git checkout -- index.html` — and say so in the commit message; do not build around it, and do not "fix" it by pointing the source at a bundle name.

---

## What slice 2 handed forward, and the two things this slice must flip

Stated here because a fresh session has not read slice 2's plan. The first two are the ones that make this slice's shape what it is.

1. **The shelf rows are plain buttons with no drag attributes, and a test says so.** `src/components/layout/shelf-list-wiring.test.ts` carries:

   ```ts
   it('is not a drop target yet \u2014 slice 3 owns drag', () => {
     expect(SOURCE).not.toMatch(/onDragOver|onDrop|dataTransfer/)
   })
   ```

   **This slice must replace that case, not delete it.** Its replacement asserts the rows *are* targets and still asserts the thing that mattered underneath — that the drop wiring lives on the rows and not on something that re-renders the list. Deleting it would leave invariant-7's neighbourhood unguarded in exactly the file slice 2 built the guard in.

   The neighbouring case is the other half: **`promises only actions that work, and offers them as controls`** asserts no renderer file contains `Drag books here` while `BookCard` is still `draggable={false}`. Once the sources are draggable, that case's second assertion is obsolete — flip it in the same commit as Task 3, and keep the first (the copy rule stands on its own: see *Copy decisions for the owner*).

2. **`ShelfList`'s docblock names this slice.** Its last paragraph reads *"Slice 3 makes the rows drop targets. Neither is stubbed here."* — update it when it lands, or the file lies about its own state.

3. **`library.store`'s `reconcileScope(existingShelfIds)` is wired**, and `setActiveShelf(null)` — not clearing `activeShelfId` — is the one way to leave a shelf. This slice adds no new way to leave one, so it does not call either: dropping books *onto a shelf row* navigates nowhere.

4. **The failure reporter is a session-wide singleton by design** (`reportShelfFailure`), and `addToShelf` already routes every refusal through it. A drop has no error path of its own: it calls `addToShelf` and is done. If a task here ever wants *"and say it again"*, that is a new decision, not a `Set.delete`.

5. **`addToShelf(shelf, bookIds)` already toasts** — `Added 3 to To Read`, `Added 2 to To Read · 1 already there`, `Already on To Read`, and *nothing* when both counts are zero (`src/lib/shelf-membership.ts`, R9). A drop must not add copy: the toast is the module's, and `describeAdd` is the only place those strings live.

6. **`shelves.create(name, bookIds?)` already takes the books**, and `ShelfList.commit` currently passes only the name. Dropping on **+** is the first caller of the second argument.

7. **Slice 4 adds *Send to ‹device›* above *Delete Shelf…*** in the row menu. This slice touches the row's drag attributes only — do not open the menu code.

---

## How the slice is cut

The spec's slice 3 list is four files (`src/lib/book-drag.ts`, `BookCard`, `ListView`, `ShelfList` targets) — inside CLAUDE.md's ~10-file bound on its own, and it stays inside it with the two helpers this plan adds. It still splits along the one seam that matters, because the first part can be **wrong in a way only the running app reveals** (the drag may not start at all), and the second part cannot be started until that is decided.

| Part | What it lands | Code files | Route |
| --- | --- | --- | --- |
| **3a — the payload and the sources** (Tasks 1–3) | the spike's answers, `src/lib/book-drag.ts` (new), `src/hooks/useBookDrag.ts` (new), `src/hooks/useDragDrop.ts`, `src/components/library/BookCard.tsx`, `src/components/library/ListView.tsx`, `src/App.tsx` (one mount line) — **7** | `renderer-engineer`; the spike is the orchestrator's |
| **3b — the drop targets** (Tasks 4–6) | the shelf rows, the **+**, the empty-state row, the empty-shelf copy, and the docs | `src/components/layout/ShelfList.tsx`, `src/components/shared/EmptyLibrary.tsx` — **2** | `renderer-engineer` |

Each part ends green (`npm run typecheck && npm run lint && npm test`) and gets its own review. 3b depends on 3a's *decisions*, not its code, so 3b's tasks can be written against Part 3a's interfaces (this plan names them).

**Out of scope here, and where it goes:** everything in the context menu's *Add to Shelf ▸* path (slice 2 landed it; drag is the second route to the same store actions, not a third vocabulary), *Send to ‹device›* (slice 4), every REST change (slice 5), the phone (slice 6), and dropping *out* of a shelf to remove (nowhere in the spec — a drag out of a shelf does nothing, and *Remove from “‹shelf›”* remains the only remove gesture). **No file under `electron/`, `sidecar/` or `src/types/` changes.** No keyboard shortcut to add a book to a shelf: the spec's keyboard path is the context menu, and `selection-and-keyboard.md` stays as it is.

---

## Readings this slice must settle itself, each with the alternative it beats

The spec fixes the behaviour; these are where it stops short. Each is recorded rather than discovered mid-task, and none changes an acceptance criterion.

### S1 — the drag lives on the card's outer box and the list's `<tr>`, not on the buttons inside them

`BookCard`'s root is a plain `div.group.relative` holding a `<button>` (the card face: select on click, open on double-click) and a sibling delete button in a pointer-events-none overlay. `ListView`'s row is a `<tr>` with `onClick`/`onDoubleClick`/`onContextMenu` on it and a button in the title cell. **The alternative:** `draggable` on the inner buttons, so the drag cannot start from the meta text. **Chosen: the outer box and the `<tr>`** — the click gestures and the drag gesture then belong to different elements, the drag box covers the artwork *and* the title/author lines, and neither element gains a child (invariant 7 is untouched: attributes and handlers only). This is also what Task 1's spike measures, because "a `draggable` button competes with its own click" is a claim about Chromium that this plan asserts from the shape of the code, not from a measurement.

### S2 — the payload is a module slot *and* `dataTransfer`, and the slot is what the targets read

D9 says the payload sits in a module-level slot, cleared on the window's `drop`/`dragend`, never on the source element. It does not say what `dataTransfer` carries or why both exist. **Chosen: both.** `setData(BOOK_DRAG_MIME, JSON.stringify(ids))` and `setData('text/plain', ids.join('\n'))` at `dragstart`, plus the slot. **Why the slot is not redundant:** Chromium's drag data store is *protected* during the drag — `getData()` answers `''` while the pointer is over a target, and only `types` is readable — so the hover state (*"3 books"*, the ring's decision about whether to appear at all) has nothing to read without it. And why `setData` is not redundant either: a drag with no data is refused as a drop on some paths, and `text/plain` is what a drop into another app's field would find (it must not receive JSON). **The alternative:** `dataTransfer` alone, reading it in `drop` only — which works for the drop and loses the very thing D9's fanned drag image and every hover decision depend on.

### S3 — a drop on the open shelf is refused, with no ring and no toast

D9 says *"Dropping on the open shelf is a no-op."* Read literally, a no-op could still call `addBooks` and toast *Already on To Read*. **Chosen: refused before the call** — `dropEffect = 'none'`, no ring, and `onDrop` returns without touching the shelf. **Why:** the payload coming out of a shelf *is* that shelf's rows, so *"Already on X"* is the toast for dragging a book onto the shelf it is already displayed on — the single most likely repeat of any gesture in this feature, and a sentence nobody asked to read. **The alternative:** let it through and let `addBooks`'s `alreadyOn` count answer — honest, one line, and noisy in exactly the case that repeats.

### S4 — the pending books for a create live in `ShelfList`'s state, not in the module slot

D9: *"Dropping on **+** opens the name field, and confirming creates the shelf with the dragged books."* The slot is cleared on drop (D9's own rule), so the ids must survive *past* the drop, through however long the user takes to type a name. **Chosen: `ShelfList` gains `pending: string[] | null`, set by the drop, read by `commit`, cleared with `editing`.** **The alternative:** keep the slot alive until the field commits — rejected because the slot's lifetime is the drag's, and a slot that outlives one drag is a slot that can leak into the next one. **The cost, accepted:** a drop on **+** followed by Escape loses the pending books (the field is abandoned, so nothing is created — the books were never anywhere but in that field).

### S5 — the drop is read in the row's `onDrop` and cleared by the window, so `stopPropagation` must not be called

D9 puts the clear on the **window's** `drop`/`dragend`. The row's `onDrop` runs during the target phase, before the event bubbles to the window, so the order is: row reads the slot → row calls `addToShelf` → window clears. **That order is a contract, and `e.stopPropagation()` in the row's drop breaks it** — the window never sees the drop, the slot keeps its payload, and the next drop of a *different* drag can carry stale ids. So the row's handlers stop nothing, and a walk case asserts it. **The alternative:** clear in the row and treat `stopPropagation` as ordinary hygiene — one line, and it removes the only thing guaranteeing a cancelled or failed drop leaves no payload behind.

### S6 — the ring is a `ring`, never a `border` or a `padding`

Invariant 7 makes the shelf row's height real geometry (`ROW_HEIGHT`-style constants are the views'; the row's own box is content-plus-padding and every row below it shifts when one grows). So the drag highlight is a Tailwind `ring-*` utility — a box-shadow, which occupies no layout — and the transition is a colour, not a size. **The alternative:** a `border` (which would add 2px to the row and move every shelf below it down, mid-drag) or a `scale`/`translate` (which moves the hit target under the cursor). Both are what a screenshot would show as jitter rather than a build failure, which is why this is written down here.

### S7 — `isImportDrag` is extracted from the hook so AC25 is a real case, not a walk

AC25 says *"Dragging a book never raises the Finder import overlay (test over `useDragDrop`'s type check with the custom MIME type)."* `useDragDrop`'s check is inline (`e.dataTransfer?.types.includes('Files')`), and this repo has no DOM harness, so the alternatives are a source walk over the hook or a predicate the hook imports. **Chosen: the predicate** — `isImportDrag(types)` in `book-drag.ts`, one line in the hook, and AC25 becomes two real cases (`isImportDrag([BOOK_DRAG_MIME]) === false`, `isImportDrag(['Files']) === true`) over the production code path rather than over its text. **The alternative:** a walk asserting the hook mentions `'Files'` and the constant is not `'Files'` — which passes while the hook checks something else. **The cost, accepted:** the Finder-import hook is touched, so the part gate reviews that diff first.

### S8 — the drag does not change the selection, and does not require one

`contextMenuScope`'s docblock is explicit that a right-click's scope is *"the menu's scope and nothing more — no caller moves the selection for a right-click."* `dragScope` mirrors it: `sel.ids.size > 1 && sel.ids.has(bookId) ? [...sel.ids] : [bookId]`, and nothing is written back. **The alternatives:** select the dragged book first (Finder's rule) — rejected for the reason the owner reported on 2026-09-25, that a gesture which also performs the *other* gesture's action is what opened the details panel beside the context menu; or refuse to drag an unselected book — rejected because dragging the one book under the cursor is the commonest single-book gesture there is. A payload of exactly one book from a selection of one is the same answer either way, which is why `> 1` and `>= 1` cannot be told apart by a case and the boundary is documented instead.

### S9 — the drag image is D9's fan, with the source card's own cover as the stated fallback

D9: *"a fanned stack of up to three thumbs with a gold count badge, drawn into an offscreen node and handed to `setDragImage`."* The spec's *Not verified 2* says the risk is whether that node paints on the **first** drag of a session, and names the fallback as *"a static single-cover image."* **Chosen: build both, in that order, and let Task 1's spike decide which body stays** — the fan behind a small `setDragImage` helper, and the fallback being the source element's own `<img>` (already laid out, so nothing about first-frame timing applies). The thumbs come from `coverUrl(book, 'thumb')` over `useLibraryStore.getState().books`, so the drag image and the grid agree by construction and nothing new is fetched.

---

## Copy decisions for the owner

Two sentences are slice 3's to revisit because slice 3 is what makes them true or false. Both are one-line changes; both are flagged here so they are not made silently in a component.

1. **The empty-shelf pane.** It currently reads *"Add books from the library — right-click a book, then Add to Shelf…"* (slice 2 replaced D9's *"Drag books here, or use Add to Shelf."*, whose first half named an action that did not exist). After this slice there are **two** working routes from that pane: drop onto the shelf's sidebar row, or go to the Library and use the menu. The plan's default is to name the drag as well: *"Add books from the library — drag them onto this shelf in the sidebar, or right-click a book."* D9's original sentence stays wrong even now, because *"here"* was never the pane: the pane is not a drop target, the sidebar row is. Task 4 changes the string; the owner may prefer shorter.
2. **The sidebar's empty state.** Slice 2 replaced D9's *"Drag books here to start a shelf"* with a labelled **New shelf** row, because the sentence named the one action slice 2 could not perform. The row stays — a control beats an instruction about one, and it is now also a drop target — so the plan does **not** restore D9's line. If the owner wants the affordance taught in words as well as by the ring, the place for it is the row's `title`, not a paragraph above it.

---

## Global Constraints

- Node **≥ 22.12**. Run tests **only** through `npm test` (Electron-as-Node, so the native ABI matches). One file: `npm test -- <path>`.
- **The renderer has no DOM harness**: vitest runs in the `node` environment with no React testing library. A claim is decided one of three ways, and every task says which: **(1)** an *action* gets a real case — a `src/lib` module or a store, driven with `vi.stubGlobal('window', { Musaeum: … })`; **(2)** a *wiring* claim gets a **source walk** over the files (`src/components/library/context-menu-wiring.test.ts` is the pattern, including its statement of what a walk cannot prove — and note that both of this slice's new walks must strip block comments before matching, because the files they read contain comments that quote the very strings they match: see `bare()` in `shelf-list-wiring.test.ts`); **(3)** what is *painted* — including whether a drag starts at all — is the running app's, decided over CDP, which is Task 1's whole job.
- TypeScript strict, **no `any`**. Handler params are typed as what they use: a structural `{ dataTransfer: DataTransfer | null }` rather than `React.DragEvent` in `book-drag.ts`, so the module keeps no React import and stays unit-testable.
- The code blocks below are not guaranteed Prettier-formatted: run `npx prettier --write <the code files you touched>` before `npm run lint`, which runs with `--max-warnings=0`. **Never `prettier --write` the markdown** — the docs tree is deliberately not Prettier-formatted (`npx prettier --check "docs/**/*.md"` fails 48 files) and doing it churns ~400 unrelated lines. Edit prose by hand.
- Invariant 7: **nothing added above either view, and no geometry moves.** The drag adds attributes, handlers and a `ring` class (S6); it adds no DOM child to a card or a row, and no element between `<Toolbar />` and `<main>`. The guard is `shelf-list-wiring.test.ts`'s existing invariant-7 block (which pins `ROW_HEIGHT = 37`, `CARD_META_HEIGHT = 68`, `CARD_META_MARGIN = 8` and their consuming expressions) plus a diff that shows no change to those constants or to the cells that carry them.
- **Renderer colours come from design tokens** (`src/lib/theme/palette-scan.test.ts` fails the build otherwise): the ring is `ring-gold-400`, the same token the selection ring on a card already uses.
- **No renderer file restates a sentence the main process composes** (`src/lib/storage-copy-scan.test.ts`). A refused drop shows the storage copy through `nasStatus.copy.label` — a label, not an instruction (slice 2's R7, settled with the owner 2026-09-24) — and the add/remove sentences stay in `shelf-membership.ts` where slice 2 put them.
- Every shelf write still goes through the funnel: a component calls `addToShelf`/the store action, never `window.Musaeum.shelves.*` inline. `ShelfList`'s own create/rename/delete remain the stated exception (slice 2's docblock, unchanged).
- The MIME type has **one definition** (`BOOK_DRAG_MIME` in `book-drag.ts`) and no second string literal anywhere, including in tests: the cases import the constant.
- Markdown prose is **not hard-wrapped** — one line per paragraph, bullet and table row.
- Commit after every task, and stage **by name** (never `git add -A`). Commit messages are `shelves slice 3: <what>` and end with a blank line and `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

The five inputs the spec implies but no acceptance criterion exercises, most likely to bite first. Each has a case or a step in the task named.

1. **A cancelled drag (Escape) leaves no payload.** `dragend` fires on the source for a cancelled drag in Chromium, but the source may have been unmounted by then — so the payload's clear cannot depend on the source element. If it is, a later drop adds the *previous* drag's books. *Task 2's slot cases, Task 4's window-clear walk.*
2. **A drop with nothing in the slot** — a drag that started in another app, or a `dragover` that arrives after a cleared slot — must not act: no ring, no toast, and above all no `addBooks(id, [])`. *Task 4.*
3. **The rows refresh mid-drag.** `shelves:changed` can land (a REST write from the phone, an adoption) while the pointer is over a row, so the drop must act on the **id** it was rendered with and re-look-up the shelf, never on a captured `ShelfSummary` object. *Task 4.*
4. **A multi-book drag counts what was carried, not what is selected at drop time.** The toast is `addToShelf`'s and its number comes from main's answer, so the risk is not the toast but the *refusal* decisions (`!ids.length`, the open-shelf check) being made from the live selection instead of the payload. *Tasks 2, 4.*
5. **Dropping onto a shelf while a *different* shelf is open.** Both shelves are in play; the open one is refused (S3) and the other accepts. Nothing here leaves the open shelf, and nothing navigates — a drop is not a way to open a shelf. *Task 4.*

## Acceptance criteria → tasks

| AC | Task | | AC | Task |
| --- | --- | --- | --- | --- |
| 24 `dragScope` over the selection grammar | 2 | | 27 payload survives the source scrolling out | 1, 2, 6 |
| 25 dragging never raises the import overlay | 2, 3 | | 28 drop targets refuse while offline | 4, 5 |
| 26 drop adds and toasts; open shelf nothing; + creates | 4, 5 | | | |

**Task 1 → 24, 25, 26, 27, 28** in the sense that its answers decide whether any of them can be decided the way this plan says: it is the instrument, and it comes first for that reason.

---

# Part 3a — the payload and the sources

### Task 1: the spike — does a drag even start (throwaway, no repo files)

Nothing is committed in this task, and **no file in the repo is modified**. Its output is four answers and a decision about the drag image, recorded for Task 6 to write into the plan's record.

**Files:** none in the repo. Probes go to the session scratch directory (`$TMPDIR` points at it), never into `musaeum/`.

The four questions, in the order that matters:

1. **Does `dragstart` fire from `BookCard`'s outer div and from a `<tr>` in `ListView`** when a real press-and-move happens over them? Neither is `draggable` yet, so set it **from the probe** without editing code (`document.querySelector('tr').draggable = true`), and listen from the probe too (`document.addEventListener('dragstart', (e) => window.__spike.push([e.target.tagName, [...e.dataTransfer.types]]), true)`). This is the one answer that can invalidate Part 3a's whole shape; if a `<tr>` does not start a drag, the source moves to the button in the title cell and S1 is rewritten.
2. **Does `setDragImage` with an offscreen, just-created node paint on the first drag of a session** (spec, *Not verified 2*)? The instrument: `Input.setInterceptDrags({ enabled: true })`, then a driven drag, a `Page.captureScreenshot` while the drag is in flight, and the eyes on the thumbnail. If the fan does not paint, S9's fallback body is what ships.
3. **Does a driven drag-and-drop land on a shelf row**, with `dragenter → dragover → drop` in that order and `dataTransfer.getData(BOOK_DRAG_MIME)` readable in `drop` — and **empty in `dragover`**? The second half is S2's premise and it is worth confirming in this build rather than trusting the spec text.
4. **Does the drop still land if the source row is scrolled out mid-drag** (AC27)? After `dragstart`, set `scrollTop` on the virtualized container from the probe, then drop. If the row is unmounted and the drop still lands, AC27's mechanism is the module slot and Task 2's case is its unit half.

The instrument, as a starting hypothesis — **not verified by the session that wrote this plan**, which is exactly why this task exists:

```js
// Press, then move: Blink starts a drag after a small threshold, not on press.
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 12, y: y + 12, button: 'left', buttons: 1 })
await sleep(60)
console.log(await evaluate('window.__spike'))       // dragstart should have fired by now
// ... more moves toward the sidebar row, then:
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', buttons: 0 })
```

Launch the built app for it (`npm run build`, then `electron . --remote-debugging-port=9223`), **use a fresh port per run**, and kill every instance you started by pid when you are done — a stale instance holding the port answers `/json/list` from the **old** bundle and reports the opposite of the truth (this cost the slice-2 session one false verdict). If `setInterceptDrags` turns out to *suppress* the page's own drag events, that is itself an answer: drop it and decide questions 1–4 from drag-event listeners plus screenshots.

**If a driven drag cannot start at all**, the honest fallback for AC26/AC28 is `Runtime.evaluate`-dispatched synthetic `DragEvent`s (`new DragEvent('dragover', { bubbles: true, dataTransfer })`), which decides the *handlers* and not the browser; AC27 is then stated as blocked in the record rather than claimed. Do not report a synthetic drag as an end-to-end check.

**— No commit. Record the four answers in your own notes; Task 6 writes them into the plan.**

### Task 2: `book-drag.ts` — the payload, the scope and the import predicate (AC24, AC25)

**Files:**

- Create: `src/lib/book-drag.ts`
- Create: `src/lib/book-drag.test.ts`
- Modify: `src/hooks/useDragDrop.ts` (the `Files` check becomes a call to the new predicate)

- [ ] **Step 1: Write the failing cases**

`src/lib/book-drag.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { EMPTY_SELECTION, type Selection } from '@/lib/selection'
import {
  BOOK_DRAG_MIME,
  clearDragPayload,
  dragPayload,
  dragScope,
  isImportDrag,
  setDragPayload
} from '@/lib/book-drag'

const sel = (...ids: string[]): Selection => ({
  ids: new Set(ids),
  anchor: ids[0] ?? null,
  cursor: ids[0] ?? null
})

describe('dragScope (AC24)', () => {
  it('carries the whole selection when the dragged book is inside it', () => {
    expect(dragScope('b', sel('a', 'b', 'c'))).toEqual(['a', 'b', 'c'])
  })

  it('carries the one book when the dragged book is not in the selection', () => {
    expect(dragScope('z', sel('a', 'b', 'c'))).toEqual(['z'])
    expect(dragScope('z', EMPTY_SELECTION)).toEqual(['z'])
  })

  it('carries the one book when the selection is a single other book', () => {
    // `contextMenuScope`'s boundary, mirrored: size > 1 is what makes it "a
    // selection". One book selected and a different one dragged is one book.
    expect(dragScope('z', sel('a'))).toEqual(['z'])
  })

  it('does not change the selection it was handed (AC24)', () => {
    const s = sel('a', 'b')
    dragScope('a', s)
    expect([...s.ids]).toEqual(['a', 'b'])
    expect(s.anchor).toBe('a')
    expect(s.cursor).toBe('a')
  })
})

describe('the payload slot (AC25, AC27)', () => {
  it('answers what was put in it, in the order it was put in', () => {
    setDragPayload(['b', 'a'])
    expect(dragPayload()).toEqual(['b', 'a'])
  })

  it('is a copy, so a caller cannot mutate the payload after the fact', () => {
    const ids = ['a', 'b']
    setDragPayload(ids)
    ids.push('c')
    expect(dragPayload()).toEqual(['a', 'b'])
  })

  it('clears', () => {
    setDragPayload(['a'])
    clearDragPayload()
    expect(dragPayload()).toBeNull()
  })
})

describe('the import overlay stays down (AC25)', () => {
  it('does not mistake a book drag for a file drop', () => {
    expect(BOOK_DRAG_MIME).toBe('application/x-musaeum-books')
    expect(isImportDrag([BOOK_DRAG_MIME])).toBe(false)
    // What a book drag actually carries: the MIME type and a text fallback
    expect(isImportDrag([BOOK_DRAG_MIME, 'text/plain'])).toBe(false)
  })

  it('still recognises a real file drop', () => {
    expect(isImportDrag(['Files'])).toBe(true)
    expect(isImportDrag(['text/plain', 'Files'])).toBe(true)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- src/lib/book-drag.test.ts`
Expected: the module does not resolve — every case fails to import.

- [ ] **Step 3: Write the module**

`src/lib/book-drag.ts`:

```ts
import type { Selection } from '@/lib/selection'

/**
 * The one drag in the app that is *not* a file import (D9).
 *
 * A book drag carries this MIME type, and `useDragDrop` — whose job is Finder
 * files — asks `isImportDrag` below rather than checking `'Files'` itself, so a
 * book dragged inside the window never raises the import overlay. AC25 is
 * decided by cases over that predicate, which is why it is exported rather than
 * inlined in the hook.
 */
export const BOOK_DRAG_MIME = 'application/x-musaeum-books'

/**
 * Whether a drag in flight is a file drop — the question that decides the import
 * overlay.
 */
export function isImportDrag(types: readonly string[]): boolean {
  return types.includes('Files')
}

/**
 * What a drag of `bookId` carries: the whole selection when the dragged book is
 * part of one, that book alone otherwise.
 *
 * Mirrors `contextMenuScope`, including its boundary (`size > 1`) and its rule
 * that a gesture's scope is *not* a side effect: nothing here — and no caller —
 * moves the selection for a drag (S8).
 */
export function dragScope(bookId: string, sel: Selection): string[] {
  return sel.ids.size > 1 && sel.ids.has(bookId) ? [...sel.ids] : [bookId]
}

/**
 * The drag's payload, held for the length of the drag and no longer.
 *
 * **Why a module slot as well as `dataTransfer` (S2).** Chromium protects the
 * drag data store for the duration of the drag: `getData()` answers `''` while
 * the pointer is over a target, so a target cannot read the ids to decide
 * whether to light up, or say *"3 books"* while hovering. And the source element
 * may be gone by the time anything else asks: the views are virtualized, so a
 * row scrolled out mid-drag unmounts, taking any per-element ref with it (AC27).
 *
 * The ids are written to `dataTransfer` too, at `dragstart` — a drag with no
 * data is refused as a drop on some paths — but the slot is what the targets
 * read.
 */
let payload: string[] | null = null

export function setDragPayload(ids: readonly string[]): void {
  payload = [...ids]
}

export function dragPayload(): readonly string[] | null {
  return payload
}

export function clearDragPayload(): void {
  payload = null
}
```

- [ ] **Step 4: Run the cases**

Run: `npm test -- src/lib/book-drag.test.ts`
Expected: nine pass.

- [ ] **Step 5: Point the hook at the predicate**

In `src/hooks/useDragDrop.ts`, import it and replace the inline check in `onDragEnter` (line 23):

```ts
      if (isImportDrag([...(e.dataTransfer?.types ?? [])]) && ++depth === 1) {
```

Add the import beside the existing ones:

```ts
import { isImportDrag } from '@/lib/book-drag'
```

Leave the file's docblock as it is and add one sentence to it, because the gate is now shared:

```ts
 * The gate is `isImportDrag` (`src/lib/book-drag.ts`) — the same predicate the
 * book drag's MIME type is tested against, so the overlay's answer and the
 * drag's MIME cannot drift apart. It is `isBookFile` from `@shared/book.types`
```

- [ ] **Step 6: Add the AC25 case to the hook's own walk**

`src/hooks/useDragDrop.test.ts` is a source walk over the hook (it asserts the hook names no extension list of its own). Add:

```ts
  it('asks the shared predicate rather than naming a type itself (AC25)', () => {
    // The two halves of AC25 are decided over `isImportDrag` itself, in
    // `book-drag.test.ts`; this one holds the wiring — the hook must *ask*.
    expect(SOURCE).toMatch(/isImportDrag\(/)
    expect(SOURCE).not.toMatch(/includes\('Files'\)/)
  })
```

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: whole suite green — **85 files, 1829 passed, 2 skipped** (nine new cases, one new file).

```bash
git add src/lib/book-drag.ts src/lib/book-drag.test.ts src/hooks/useDragDrop.ts src/hooks/useDragDrop.test.ts
git commit -m "shelves slice 3: the drag payload, and the one predicate that keeps the import overlay down

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 3: the sources — `BookCard` and `ListView`'s row (AC25)

**Files:**

- Modify: `src/lib/book-drag.ts` (the drag start and the drag image)
- Modify: `src/components/library/BookCard.tsx`
- Modify: `src/components/library/ListView.tsx`
- Create: `src/components/library/book-drag-wiring.test.ts`
- Modify: `src/components/layout/shelf-list-wiring.test.ts` (the false-affordance case's second assertion — see handoff 1)

- [ ] **Step 1: Write the failing walk**

`src/components/library/book-drag-wiring.test.ts`, in the shape of `context-menu-wiring.test.ts` (including its statement of what a walk cannot prove — copy that paragraph, adapted):

```ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const read = (file: string): string =>
  readFileSync(join(process.cwd(), 'src', 'components', 'library', file), 'utf8')

const CARD = read('BookCard.tsx')
const LIST = read('ListView.tsx')

describe('the drag sources (AC25, invariant 7)', () => {
  it('makes the card box and the list row draggable, not the buttons inside them', () => {
    // The card's button is its click target and the row's <tr> owns its own
    // clicks; the drag belongs to the box that covers both the artwork and the
    // meta lines (S1)
    expect(CARD).toMatch(/^\s+draggable$/m)       // a bare `draggable` on the card's root div
    expect(LIST).toMatch(/^\s+draggable$/m)
    // Not the buttons: `[\s\S]{0,600}` rather than `[^>]*`, because a button's
    // props are one per line and `[^>]*` would sail past its opening tag and
    // match nothing whatever the file said
    expect(CARD).not.toMatch(/<button[\s\S]{0,600}?draggable/)
    expect(LIST).not.toMatch(/<button[\s\S]{0,600}?draggable/)
  })

  it('starts the drag through the one module, and ends it by clearing the payload', () => {
    for (const source of [CARD, LIST]) {
      expect(source).toMatch(/startBookDrag\(/)
      expect(source).toMatch(/clearDragPayload/)
    }
  })

  it('adds no child to either box (invariant 7)', () => {
    // A drag image is built offscreen precisely so it is not a node in the view
    expect(CARD).not.toMatch(/<span[^>]*dragImage/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/components/library/book-drag-wiring.test.ts`
Expected: three fail.

- [ ] **Step 3: Add the drag start to the module**

In `src/lib/book-drag.ts`:

```ts
/** The least a drag handler has to carry: keep the module free of a React import. */
export interface DragHandle {
  dataTransfer: DataTransfer | null
  currentTarget: EventTarget | null
}

/**
 * Start a book drag: the payload goes to the slot *and* to `dataTransfer`, the
 * selection is left alone, and the drag image is the fan (S9).
 *
 * The `text/plain` fallback is not decoration: a drop somewhere that is not this
 * app reads it, and it must not find raw JSON. The MIME type is what our own
 * targets could read in `drop` if the slot ever disagreed with it.
 */
export function startBookDrag(e: DragHandle, bookId: string, sel: Selection): void {
  const ids = dragScope(bookId, sel)
  setDragPayload(ids)
  const dt = e.dataTransfer
  if (!dt) return
  dt.effectAllowed = 'copy'
  dt.setData(BOOK_DRAG_MIME, JSON.stringify(ids))
  dt.setData('text/plain', ids.join('\n'))
  setDragImage(dt, ids, e.currentTarget)
}

/**
 * The fan: up to three covers and a gold count badge.
 *
 * **Task 1's spike decides which of these two bodies ships** (spec, *Not
 * verified* 2). The offscreen node is D9's; Chromium takes the snapshot for
 * `setDragImage` in the same task, and whether a node that has never been laid
 * out paints on the *first* drag of a session is not something a unit case can
 * answer. The fallback is the source element's own cover, which is already laid
 * out and therefore has no first-frame question at all.
 */
function setDragImage(
  dt: DataTransfer,
  ids: readonly string[],
  source: EventTarget | null
): void {
  // -- Body A (D9): the fanned stack ----------------------------------------
  const books = useLibraryStore.getState().books          // import: '@/stores/library.store'
  const covers = ids
    .map((id) => books.find((b) => b.id === id))
    .filter((b): b is Book => Boolean(b))
    .slice(0, 3)
    .map((b) => coverUrl(b, 'thumb'))                     // import: '@/lib/cover-url'
    .filter((url): url is string => Boolean(url))
  if (covers.length) {
    const node = document.createElement('div')
    // No design tokens here: this node is painted outside the React tree, and
    // `document.body`-level styles do not reach it. The palette's values are
    // written literally, with the same hexes `src/index.css` declares.
    node.style.cssText =
      'position:fixed;top:-1000px;left:-1000px;display:flex;padding:6px 10px;border-radius:8px;background:rgba(20,17,14,.92)'
    for (const url of covers) {
      const img = document.createElement('img')
      img.src = url
      img.width = 48
      img.style.cssText = 'width:48px;height:72px;object-fit:cover;margin-right:-14px;border-radius:3px'
      node.appendChild(img)
    }
    if (ids.length > 1) {
      const badge = document.createElement('span')
      badge.textContent = String(ids.length)
      badge.style.cssText =
        'align-self:flex-end;margin-left:22px;font:600 13px system-ui;color:rgb(212,171,88)'
      node.appendChild(badge)
    }
    document.body.appendChild(node)
    dt.setDragImage(node, 24, 36)
    // Removed on the next task, never synchronously: Chromium has to paint it
    setTimeout(() => node.remove(), 0)
    return
  }
  // -- Body B (S9's fallback): the source's own cover ------------------------
  const img = (source as HTMLElement | null)?.querySelector?.('img')
  if (img) dt.setDragImage(img, 24, 36)
}
```

If the spike says Body A does not paint, **delete Body A** and keep Body B alone — with the count badge dropped from the drag image, which is a note for the record rather than a silent loss: `setDragImage` takes one node, and the source's cover has no badge on it.

- [ ] **Step 4: Wire the two sources**

In `BookCard.tsx`, on the root `div` (lines 92–100) — and note what moves and what does not:

```tsx
    <div
      className="group relative"
      // The drag lives on this box rather than on the button inside it: the
      // button is the card's click target (select, open) and a `draggable`
      // button competes with its own click in Chromium, where the outer box
      // covers the same artwork plus the meta lines (S1). Measured by Task 1's
      // spike, not assumed.
      draggable
      onDragStart={(e) => startBookDrag(e, book.id, useUIStore.getState().selection)}
      // Clearing on the source is not enough — a virtualized card can unmount
      // mid-drag — but this is where a *cancelled* drag ends, and the payload
      // must not outlive it (Review Focus 1)
      onDragEnd={clearDragPayload}
      onContextMenu={(e) => {
```

In `ListView.tsx`, on `Row`'s `<tr>` (line 63), the same three props, reading the book from the row's own prop:

```tsx
    <tr
      draggable
      onDragStart={(e) => startBookDrag(e, book.id, useUIStore.getState().selection)}
      onDragEnd={clearDragPayload}
      onClick={(e) => select(book.id, modifiersFrom(e))}
```

`useUIStore.getState()` rather than a subscription, for the reason `BookCard`'s existing `useReaderStore.getState()` line gives: nothing here *renders* from the selection, and both files are memoized per book. Imports: `startBookDrag`, `clearDragPayload` from `@/lib/book-drag`.

- [ ] **Step 5: Flip the false-affordance case**

In `src/components/layout/shelf-list-wiring.test.ts`, the case `promises only actions that work, and offers them as controls` asserts `expect(bare(card)).toMatch(/draggable=\{false\}/)`. The card is draggable now. Replace that one assertion with the fact that replaced it — the `<img>`s keep `draggable={false}` (D9: *"Cover `<img>`s keep `draggable={false}`"*), because a cover that is itself draggable would start the browser's *image* drag instead of ours:

```ts
    // The card is draggable now (slice 3); what must stay false is the cover
    // <img>, or the browser starts its own image drag from inside our card
    expect(bare(card)).toMatch(/<img[\s\S]{0,200}?draggable=\{false\}/)
```

Leave the case's two `Drag books here` assertions alone: they are the copy rule, and they still hold.

- [ ] **Step 6: Mount the payload's lifecycle once**

Create `src/hooks/useBookDrag.ts`:

```ts
import { useEffect } from 'react'
import { clearDragPayload } from '@/lib/book-drag'

/**
 * The other end of a book drag: the payload is cleared when the drag is over.
 *
 * On the **window**, not on the source element (D9). The source cannot be
 * trusted to be there at the end: both views are virtualized, so a row scrolled
 * out mid-drag unmounts and its `dragend` never fires — and a payload that
 * outlives its drag is a payload the *next* drop can pick up (Review Focus 1).
 *
 * Mounted once, from `App.tsx`, beside `useDragDrop` — which is the same shape
 * of concern (a window-level drag listener) for the other kind of drag.
 */
export function useBookDrag(): void {
  useEffect(() => {
    const clear = () => clearDragPayload()
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    return () => {
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
    }
  }, [])
}
```

In `src/App.tsx`, call it beside the existing `useDragDrop()`.

**Why the window's `drop` is safe to clear on, given a target reads the slot in its own `onDrop`:** the row's handler runs during the target phase, the window's during the bubble phase, so the target always reads before the window clears. That ordering is a contract — see S5, and Task 4's walk case that forbids `stopPropagation` in a drop handler.

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: whole suite green — **86 files, 1833 passed, 2 skipped** (three new walk cases plus the hook's wiring case).

Live: `npm run build`, launch the app, and confirm with the Task 1 probe that a drag over a card and over a list row now fires `dragstart` with `types` = `[BOOK_DRAG_MIME, 'text/plain']`, and that the import overlay never appears. That is AC25's other half and it is not a unit case.

```bash
git add src/lib/book-drag.ts src/components/library/BookCard.tsx src/components/library/ListView.tsx \
        src/components/library/book-drag-wiring.test.ts src/hooks/useBookDrag.ts src/App.tsx \
        src/components/layout/shelf-list-wiring.test.ts
git commit -m "shelves slice 3: cards and list rows start a book drag

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**— Part 3a review gate.** Green and reviewed before Task 4. The reviewer's list: `isImportDrag` is the only `'Files'` check left in the renderer; the `draggable` attribute is on the card box and the `<tr>` and on nothing else; no `<img>` inside a card or row is draggable; `startBookDrag` writes the slot *before* `dataTransfer` (so a `dataTransfer`-less drag in a test still lands); invariant 7 (no new child, no geometry change); and that `useBookDrag` is mounted exactly once. **Ask the reviewer the one question a walk cannot answer:** does the payload survive the source unmounting — which Task 2's slot cases and Task 1's question 4 answer together, and which the reviewer should re-derive rather than take on trust.

---

# Part 3b — the drop targets

### Task 4: the shelf rows accept a drop (AC26, AC28)

**Files:**

- Modify: `src/components/layout/ShelfList.tsx`
- Modify: `src/components/layout/shelf-list-wiring.test.ts` (the drop-target walk that replaces the slice-2 case)

- [ ] **Step 1: Replace the slice-2 case with its successor**

In `src/components/layout/shelf-list-wiring.test.ts`, the case `is not a drop target yet — slice 3 owns drag` asserts `expect(SOURCE).not.toMatch(/onDragOver|onDrop|dataTransfer/)`. Replace it with:

```ts
  it('is a drop target, on the rows and on the two create controls (AC26)', () => {
    expect(SOURCE).toMatch(/onDragOver=/)
    expect(SOURCE).toMatch(/onDrop=/)
    expect(SOURCE).toMatch(/dragPayload\(\)/)
    // The payload is read in the target's own handler, and the window's drop
    // clears it: an `e.stopPropagation()` in a *drop* handler would leave the
    // slot populated for the next drag to pick up (S5, Review Focus 1). Scoped
    // to the handler block on purpose — the row menu stops propagation on its
    // own click at line 198, and a bare `not.toMatch` over the file would fail
    // on that instead of on a drop.
    const dragBlock = SOURCE.slice(SOURCE.indexOf('const canAcceptDrop'), SOURCE.indexOf('return ('))
    expect(dragBlock.length).toBeGreaterThan(200)
    expect(dragBlock).not.toMatch(/stopPropagation/)
  })

  it('refuses a drop while the share cannot take a write (AC28)', () => {
    expect(SOURCE).toMatch(/dropEffect = 'none'/)
    // `online`, the same status the write gate reads — not a second opinion
    expect(SOURCE).toMatch(/!online/)
  })

  it('adds through the shared module, so the toast is the module's (AC26)', () => {
    expect(SOURCE).toMatch(/addToShelf\(/)
    expect(SOURCE).not.toMatch(/Added \$\{/)
  })

  it('rings the row it is hovering, and moves nothing (invariant 7, S6)', () => {
    expect(SOURCE).toMatch(/ring-1 ring-gold-400/)
    // A `border` in the row's class list would add 2px to the row and move every
    // shelf below the hovered one while the drag is in flight — a screenshot
    // shows jitter, the build shows nothing (S6)
    expect(SOURCE).not.toMatch(/dropTarget[\s\S]{0,200}?border/)
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/components/layout/shelf-list-wiring.test.ts`
Expected: the four new cases fail; the file's case count nets +3, since one case (slice 2's `is not a drop target yet`) is replaced by four.

- [ ] **Step 3: Add the row's handlers**

In `ShelfList.tsx`, beside the existing state:

```ts
  const [dropTarget, setDropTarget] = useState<string | null>(null)
```

and the two handlers, above `commit`:

```ts
  /**
   * Whether a drag in flight may land on this row.
   *
   * Refused — no ring, and `dropEffect = 'none'`, which is what turns the cursor
   * into a refusal — when the share cannot take a write (AC28), when nothing is
   * being carried, and for the shelf that is already open: the books in the
   * payload are that shelf's own rows, so "adding" them is a no-op and the toast
   * would read *Already on To Read* for the one gesture most likely to repeat
   * (S3).
   */
  const canAcceptDrop = (shelfId: string): boolean => {
    const ids = dragPayload()
    return Boolean(ids?.length) && online && shelfId !== activeShelfId
  }

  const onRowDragOver = (e: React.DragEvent, shelf: ShelfSummary) => {
    // `dropEffect` has to be set on every dragover: Chromium resets it
    if (!e.dataTransfer) return
    if (!canAcceptDrop(shelf.id)) {
      e.dataTransfer.dropEffect = 'none'
      setDropTarget((t) => (t === shelf.id ? null : t))
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropTarget(shelf.id)
  }

  const onRowDrop = async (e: React.DragEvent, shelfId: string) => {
    e.preventDefault()
    setDropTarget(null)
    const ids = dragPayload()
    if (!ids?.length || !online) return
    // The id, re-looked-up: `shelves:changed` can land between the ring
    // appearing and the drop, and a captured object would be the old shelf
    // (Review Focus 3)
    const shelf = useShelvesStore.getState().shelves.find((s) => s.id === shelfId)
    if (!shelf) return
    await addToShelf(shelf, [...ids])
  }
```

and on the row button (line 167):

```tsx
              <button
                onClick={() => setActiveShelf(shelf.id)}
                onDragOver={(e) => onRowDragOver(e, shelf)}
                onDragLeave={() => setDropTarget((t) => (t === shelf.id ? null : t))}
                onDrop={(e) => void onRowDrop(e, shelf.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ shelf, x: e.clientX, y: e.clientY })
                }}
                onDoubleClick={() => startRename(shelf)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ring-inset ${
                  dropTarget === shelf.id ? 'ring-1 ring-gold-400' : ''
                } ${
                  active
                    ? 'bg-ink-800 font-medium text-parchment'
                    : 'text-parchment-dim hover:bg-ink-800 hover:text-parchment'
                }`}
              >
```

`ring-inset` so the ring paints inside the row's box rather than a hair outside it, and `ring-1 ring-gold-400` is the same token pair the card's selection ring uses. **No `stopPropagation` anywhere in these handlers** (S5) — the drop must reach the window so the payload is cleared.

Imports: `addToShelf` from `@/lib/shelf-membership`, `dragPayload` from `@/lib/book-drag`.

- [ ] **Step 4: Update the file's own docblock**

Its last line reads *"Slice 4 adds *Send to ‹device›* above *Delete Shelf…*; slice 3 makes the rows drop targets. Neither is stubbed here."* — the second clause has landed:

```
 * Slice 3 landed: the rows are drop targets, the **+** and the empty-state row
 * create with the dragged books. Slice 4 adds *Send to ‹device›* above *Delete
 * Shelf…* and is not stubbed here.
```

- [ ] **Step 5: Run the walks**

Run: `npm test -- src/components/layout/shelf-list-wiring.test.ts`
Expected: all pass (the file's total grows by four).

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: whole suite green.

```bash
git add src/components/layout/ShelfList.tsx src/components/layout/shelf-list-wiring.test.ts
git commit -m "shelves slice 3: the shelf rows accept a drop

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 5: **+** and the empty-state row create with the dragged books (AC26)

**Files:**

- Modify: `src/components/layout/ShelfList.tsx`
- Modify: `src/components/layout/shelf-list-wiring.test.ts`

- [ ] **Step 1: Write the failing walks**

```ts
  it('creates a shelf from a drop on + and on the empty-state row (AC26)', () => {
    // Both create controls take a drop, and both go through the same
    // `startCreate`, which is where the pending books are handed over
    expect(SOURCE).toMatch(/onDrop=\{\(e\) => onCreateDrop\(e\)\}/)
    expect(SOURCE.match(/onCreateDrop\(e\)/g)).toHaveLength(2)
    expect(SOURCE).toMatch(/startCreate\(\[\.\.\.ids\]\)/)
  })

  it('creates with the books the drag carried, and with none on a click', () => {
    // `create(name, bookIds?)`: the second argument is slice 1's and this is its
    // first caller (handoff 6)
    expect(SOURCE).toMatch(/shelves\.create\(trimmed, pending \?\? undefined\)/)
    // A plain click must not inherit the last drop's books
    expect(SOURCE).toMatch(/setPending\(null\)/)
  })
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- src/components/layout/shelf-list-wiring.test.ts`
Expected: two fail.

- [ ] **Step 3: Carry the pending books through the create**

```ts
  const [pending, setPending] = useState<string[] | null>(null)

  const startCreate = (ids: string[] | null = null) => {
    setName('')
    setPending(ids)
    setEditing({ mode: 'create' })
    setMenu(null)
  }

  /**
   * A drop on either create control: the books are held here, not in the drag's
   * slot, because the slot's lifetime is the drag and the field outlives it
   * (S4). An abandoned field drops them on the floor with it — nothing was
   * created, so nothing was added.
   */
  const onCreateDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const ids = dragPayload()
    if (!ids?.length || !online) return
    startCreate([...ids])
  }
```

and `commit`:

```ts
      if (editing.mode === 'create') await window.Musaeum.shelves.create(trimmed, pending ?? undefined)
```

and clear `pending` wherever `setEditing(null)` ends a field — the refusal path keeps the field open, so it keeps them too, which is what makes a retry after a name clash still carry the books.

- [ ] **Step 4: Make the two controls accept the drop**

The **+** button (line 118) and the empty-state button (line 135) each gain:

```tsx
          onDragOver={(e) => {
            if (!e.dataTransfer) return
            if (!online || !dragPayload()?.length) {
              e.dataTransfer.dropEffect = 'none'
              return
            }
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={(e) => onCreateDrop(e)}
```

Both create controls take the same ring a shelf row takes under a drag — **set through state, never by reading the slot in `className`**. `dragPayload()` read during render is not reactive: no render happens when a drag begins, so that class would appear only if something else happened to re-render, and the affordance would be intermittent in the one moment it exists to teach. So the ring rides the `dropTarget` state the rows already use, with a sentinel for the two controls:

```tsx
          onDragOver={(e) => {
            if (!e.dataTransfer) return
            if (!online || !dragPayload()?.length) {
              e.dataTransfer.dropEffect = 'none'
              setDropTarget((t) => (t === 'create' ? null : t))
              return
            }
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setDropTarget('create')
          }}
          onDrop={(e) => onCreateDrop(e)}
```

in both controls' class lists:

```tsx
          ${dropTarget === 'create' ? 'ring-1 ring-gold-400 ring-inset' : ''}
```

and `onCreateDrop` clears it, since the drop is the end of the drag:

```ts
    setDropTarget(null)
```

The same applies to the rows' `dropTarget` values: a `dragleave` clears them, and a drop clears the whole state rather than only its own key — the pointer can only be over one target.

- [ ] **Step 5: Run the walks, then the suite**

Run: `npm test -- src/components/layout/shelf-list-wiring.test.ts`
Expected: all pass.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: whole suite green.

Live (AC26's "on **+**, creates with the books" and AC27): with the Task 1 probe, drag two selected books onto **+**, type a name, press Enter, and read back the new row's count — it must be 2. Then the AC27 case: start a drag on a row near the top of a long list, `scrollTop` the container so the source unmounts, and drop on a shelf row — the drop must still land and the toast must count what was carried.

```bash
git add src/components/layout/ShelfList.tsx src/components/layout/shelf-list-wiring.test.ts
git commit -m "shelves slice 3: dropping on + creates a shelf with the dragged books

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 6: the docs that land with this slice

**Files:** markdown only.

- [ ] **Step 1: `docs/invariants/shelves.md` — the drag payload rule**

Add a sixth rule to *The renderer (bookshelves slice 2)* section, renaming that heading's parenthetical if it reads oddly (the spec asks for this rule by name):

```
- **A drag's payload lives in the slot for the length of the drag, and the window clears it.** `src/lib/book-drag.ts` holds the ids in a module-level slot; `useBookDrag` (mounted once, in `App.tsx`) clears it on the **window's** `drop` and `dragend`. Two reasons, both mechanical: Chromium protects the drag data store, so `dataTransfer.getData()` answers `''` in `dragover` and a target cannot read the ids to decide whether to light up; and the views are virtualized, so a source row scrolled out mid-drag unmounts and fires nothing. A target therefore reads the slot in its own `drop` — which runs before the event reaches the window — and **no drop handler may call `stopPropagation`**: doing so breaks the clear, and a payload that outlives its drag is a payload the next drop picks up.
```

- [ ] **Step 2: `docs/invariants/library-views.md` — one sentence on the ring**

In invariant 7's section, beside the row-height rule:

```
A drop target's highlight is a **shadow** (`ring-*`), never a `border` or a padding change: the ring is painted, the border is laid out, and a border that appears under the cursor moves every row below it while the drag is in flight.
```

- [ ] **Step 3: `docs/invariants/selection-and-keyboard.md` — the drag is scope without side effect**

```
`dragScope` (`src/lib/book-drag.ts`) mirrors `contextMenuScope`: it reads the selection and changes nothing. A drag neither selects the book it starts from nor clears what was selected.
```

- [ ] **Step 4: the copy, `CHANGELOG.md`, `tasks.md` and the spec's Status**

`src/components/shared/EmptyLibrary.tsx`'s empty-shelf sentence becomes the one in *Copy decisions for the owner*; `CHANGELOG.md` gains its *Added* line; `tasks.md`'s bookshelves entry moves slice 3 from open to landed and drops its *drag* bullet; the spec's **Status** line names slice 4 as the next step.

- [ ] **Step 5: the plan's own record**

Append `## Built — slice 3` with: the commit list, the real counts (`git diff --stat`, not this plan's estimates), **Task 1's four answers**, the drag-image decision (which of S9's two bodies shipped and why), every divergence from this plan, and what the live checks measured. State the counts as measured; if a task's predicted number was wrong, the record says the real one.

- [ ] **Step 6: Verify and commit**

Run: `npm test` (the docs change no behaviour, but the source walks read these files' neighbours — this catches a stray edit).

```bash
git add docs/invariants/shelves.md docs/invariants/library-views.md \
        docs/invariants/selection-and-keyboard.md src/components/shared/EmptyLibrary.tsx \
        CHANGELOG.md tasks.md docs/superpowers/specs/2026-09-27-bookshelves-design.md \
        docs/superpowers/plans/2026-09-28-bookshelves-slice3.md
git commit -m "shelves slice 3: the drag rules, the copy, and the record

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**— Part 3b review gate, and the slice's last one.** The reviewer's list, against CLAUDE.md's invariants and the fact that this is the last code change of the slice: invariant 7 (the ring is a shadow; no new child in the card or the row; `shelf-list-wiring.test.ts`'s geometry block untouched — and its pinned constants still 37 / 68 / 8); invariant 9 (nothing builds a `file://` URL; the drag image's `<img src>` comes from `coverUrl`, which is `musaeum://`); invariant 8 (no IPC or service change at all — this slice's diff has no file under `electron/`); the palette scan (`ring-gold-400` is a token, and the drag-image node's literals are the two hexes `src/index.css` declares — a third colour there is a finding); and that the funnel holds (every add goes through `addToShelf`; `ShelfList`'s direct `window.Musaeum.shelves.create` is slice 2's stated exception and now takes a second argument). **Live check, end to end:** drag one book onto a shelf row (toast counts 1, the row's count grows by 1), drag a two-book selection onto the same row (toast counts 2), drop onto the open shelf (nothing at all — no ring, no toast), drop onto **+** and name it (the new shelf holds them), stop the share and try again (refused, with the storage label as the tooltip), and the AC27 scroll case.

---

## Self-review

**File counts, against the table's own numbers.** Part 3a: 7 — `src/lib/book-drag.ts` (new), `src/hooks/useBookDrag.ts` (new), `src/hooks/useDragDrop.ts`, `src/components/library/BookCard.tsx`, `src/components/library/ListView.tsx`, `src/App.tsx`, plus `src/lib/book-drag.test.ts` and `src/components/library/book-drag-wiring.test.ts` as test files. Part 3b: 2 — `src/components/layout/ShelfList.tsx`, `src/components/shared/EmptyLibrary.tsx`. **Nine code files, one short of CLAUDE.md's bound**, and no file outside `src/` except the docs in Task 6. If a task finds itself wanting a tenth code file, that is the point to split Part 3b rather than to keep going.

**AC coverage.** AC24 → Task 2's four cases. AC25 → Task 2's slot pair (action), Task 6's flip of the false-affordance assertion plus the new walk (wiring), and Task 3 Step 7's live check (painted). AC26 → Tasks 4 and 5 (walk + live). AC27 → Task 1 question 4 (instrument), Task 2's slot cases (the unit half), Task 6's live check (end to end). AC28 → Task 4's refusal case and its live step. Nothing in AC24–AC28 is left to a single method.

**What would make this plan wrong.** Three things, in order of likelihood: **(1)** a driven drag cannot start in this Electron build, in which case Tasks 4–5's live checks become synthetic-event checks and AC27 is stated as blocked rather than done; **(2)** `draggable` on a `<tr>` or the card's outer box does not start a drag, which moves the sources onto the inner buttons and rewrites S1 and Task 3 Step 4 — Task 1 exists to find this before any code is written; **(3)** the offscreen fan does not paint, which is S9's fallback and one deleted function body.

## Not verified in this plan

Stated plainly, because this plan's first task exists to settle them and a reader should not mistake the confidence of the prose above for measurement:

1. **The CDP drag instrument itself.** `Input.dispatchMouseEvent` with a press-then-move is *expected* to start a native HTML5 drag in a headed Chromium window; the session that wrote this plan did not run it. If it does not, the fallbacks are in Task 1.
2. **That `draggable` on a `<tr>` starts a drag**, and that the card's outer `div` does while the `<button>` inside it would compete with its own click (S1's claim).
3. **That `dataTransfer.getData()` is empty during `dragover` in this build.** Documented Chromium behaviour and the reason the slot exists (S2); confirming it is what makes S2 a measurement rather than a citation.
4. **That `scrollTop` set mid-drag unmounts the source row *and* the drop still lands** (AC27). Both halves are needed for the criterion to mean anything, and only the app can show it.
5. **Nothing about slice 4's menu work** — the row menu is untouched here and *Send to ‹device›* is not stubbed.

## Handoff notes for slice 4 (*Send to ‹device›*)

- The shelf row now carries drag handlers. The context menu is unchanged: `onContextMenu` still opens it, and the drag attributes do not interfere with a right-click.
- `ShelfList`'s row menu is still deliberately open-ended — *Rename*, the comment marking where *Send to ‹device›* goes, *Delete Shelf…*. One `MenuItem` plus the >25 confirmation, and no other change to this file.
- Slice 4 sends `bookIds`, and while a shelf is open the natural source is the scope's loaded rows (`useLibraryStore.getState().books.map((b) => b.id)`), not the shelf's membership in SQL — the one place the two differ is a book on the shelf whose file is missing, which is in `books` but not in `count`.
- If slice 4 ever wants "say it again" from the failure reporter, that is a new decision, not a `Set.delete`.
- The send's own bug surface is `device.store.sendBooksToDevice`, which already skips books on the device and enqueues into the serial queue; nothing in slice 3 touched it.
