# Reading Queue — Slice 2 (the Mac's renderer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reading queue is visible and usable on the Mac: it has its own sidebar group and glyph, is created from the sidebar (including by drop), opens in Queue Order, can be reordered by drag when that is meaningful, and moves to the top or bottom from the context menu and selection panel.

**Architecture:** `src/` only. Pure rules live in a new `src/lib/queue-order.ts` (no store imports, so no import cycle with `library.store`). Every shelf write stays in `src/lib/shelf-membership.ts`, which gains the two move calls. The library store gains a default sort per shelf kind, a drop-indicator mark, and a generation counter that lets the view hold a pending order while a move is in flight without a stale read snapping it back. The two views and the card gain drop handlers only: attributes and handlers, no new DOM child, no geometry change.

**Tech Stack:** React + TypeScript strict, Zustand, Tailwind tokens, vitest (Node environment, no DOM harness: pure tests plus the repo's source-walk wiring tests).

**Spec:** `docs/superpowers/specs/2026-11-18-reading-queue-design.md` (D5; AC2–AC4, AC11, AC17). Read it, then `docs/invariants/shelves.md` (*The renderer*, *Queues*), `docs/invariants/library-views.md`, `docs/invariants/selection-and-keyboard.md`.

## Global Constraints

- Branch `feat/reading-queue`. Do not merge to `main`, push, or commit to `main`. The "not before slice 3 lands" constraint stands.
- `src/` only: no `electron/`, `src/types/`, preload or schema change. The IPC (`shelves.create(name, bookIds?, kind?)`, `shelves.move(id, bookIds, placement)`) and the types (`ShelfKind`, `ShelfPlacement`, `ShelfMembership.index?`) already exist.
- `ShelfPlacement` is built as **exactly** `{ to: 'top' }`, `{ to: 'bottom' }`, `{ before: id }` or `{ after: id }`: no extra key, not even one set to `undefined`. Main refuses anything else with "That move could not be read."
- `shelf-membership.ts` hands a queue membership's `index` to `restoreBooks` untouched: it must not rebuild, filter or reorder the objects `removeBooks` returned.
- Invariant 7: `ROW_HEIGHT`, `CARD_META_HEIGHT`, `CARD_META_MARGIN` and the grid constants do not change; no list cell loses its block-level child. A drop indicator is painted (a shadow or outline), never a `border` or a padding change, and adds no DOM child to a row or card.
- The shelves store stays non-optimistic. Only the open queue's **view** holds a pending order, and it is never persisted.
- No Undo for a move. Failures go through `reportShelfFailure`.
- Copy (exact): menu/panel items **Move to Top** and **Move to Bottom**; sort label **Queue Order** (already in `SORT_LABELS`).
- No `any`; icons are hand-rolled SVG in `src/components/shared/icons.tsx`; React components are functional. Prose in `.md` is one line per paragraph.
- Tests run only via `npm test -- <path>`. Gate for every task that changes code: `npm run typecheck && npm run lint && npm test` green before the commit. Each commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Scope note — size

Counted honestly, this slice touches **12 production files** (icons, `queue-order.ts`, `library.store.ts`, `Toolbar.tsx`, `ShelfList.tsx`, `shelf-membership.ts`, `BookContextMenu.tsx`, `SelectionPanel.tsx`, `book-drag.ts`, `useQueueReorder.ts`, `ListView.tsx`, `BookCard.tsx`) plus tests and three docs, over the ~10-file guard. It splits cleanly at a green, shippable seam: **Part A** (Tasks 1–6, 8 production files: everything but drag) and **Part B** (Tasks 7–10, 7 production files: drag-to-reorder; `queue-order.ts`, `shelf-membership.ts` and `library.store.ts` are re-touched from Part A, which is why the parts sum to more than 12). Each part ends on a full gate and its own commits. Execute A, gate, then B.

## Decisions to confirm at review

1. **Two `+` controls, not one menu.** Spec D5 says the sidebar "gains **New Reading Queue…** beside **New Shelf…**" and that a book dropped on "the queue **+**" starts a queue. A menu item cannot take a drop, so the sidebar gets a **Reading Queues** group header with its own **+** (a drop target, same behaviour as Shelves' **+**), above the **Shelves** header. Its tooltip and aria-label read "New reading queue". The group header shows even with no queues, so the control is always reachable.
2. **`setActiveShelf(shelfId, kind?)`** takes the shelf's kind from the caller (default `'manual'`). `library.store` cannot read the shelves store without an import cycle (`library.store → shelves.store → shelf-feedback → ui.store → library.store`).
3. **Move to Top / Bottom are offered in the multi-book menu and the selection panel** (≥2 selected) and in the single-book menu. The one-book detail panel is not a surface the spec names and gets nothing.

## Review Focus

- **A drag out of the open queue still drops on another shelf's sidebar row.** The slot's `effectAllowed` must be `copyMove` for a reorderable drag (the sidebar sets `dropEffect = 'copy'`, the list body `'move'`; a source that says only `copy` makes Chromium refuse a `move` drop). Task 7 pins the value; Task 10's manual run checks the real drop.
- **A stale or foreign drag must never reorder.** A Finder file drop, a drag that started in another view, or a slot left by a drag that ended unseen: the drop re-asks the whole gate (event types carry `BOOK_DRAG_MIME`, the slot's `reorderShelfId` equals the open shelf's id, and the queue is *currently* reorderable). Task 9.
- **Drop onto a member of the moved block, or a drop that changes nothing, makes no IPC call and no pending order.** Task 8.
- **A refusal rolls back, and a read that straddles the move cannot undo it.** `QUEUE_BOOK_GONE` (another Mac removed the anchor) restores the pre-drop order and says one sentence; an unrelated `load()` that lands mid-flight is dropped by the generation guard. Task 8.
- **Search, any facet or author chip, a non-queue sort, a manual shelf or a device view each hide the affordance** (absent, not disabled), and a sort chosen inside a queue is never written as the library's. Tasks 1, 2 and 9.

---

## Part A — the surface without drag

### Task 1: The pure rules and the glyph

**Files:**
- Create: `src/lib/queue-order.ts`, `src/lib/queue-order.test.ts`
- Modify: `src/components/shared/icons.tsx`

**Interfaces:**
- Produces, in `queue-order.ts` (imports types only, never a store):
  - `defaultShelfSort(kind: ShelfKind): BookSort` — `queue` → `{ field: 'shelf_position', direction: 'asc' }`; `manual` → `{ field: 'shelf_added', direction: 'desc' }`.
  - `shelfSortOptions(kind: ShelfKind): BookSort[]` — the options a shelf adds in front of the library's: queue → Queue Order asc, then `shelf_added` desc, `shelf_added` asc; manual → the last two.
  - `groupShelves(shelves: readonly ShelfSummary[]): { queues: ShelfSummary[]; manual: ShelfSummary[] }` — keeps the input's order inside each group (main's list is already alphabetical, case-insensitive).
- Produces, in `icons.tsx`: `QueueIcon` (`{ className }: IconProps`), a hand-rolled SVG distinct from `BookIcon`: stacked horizontal bars with a leading marker on the top one.

- [ ] **Step 1: Write the failing tests** in `queue-order.test.ts`: `defaultShelfSort('queue')` deep-equals the Queue Order sort and `('manual')` the Date-Added-to-Shelf-desc one; `shelfSortOptions('queue')[0]` is Queue Order and `.length` is 3, `('manual')` has no `shelf_position`; `groupShelves` on `[manualB, queueA, manualA, queueB]` (alphabetical as main hands them: A-queue, A-manual, B-manual, B-queue by name) returns each kind's shelves in input order and loses none.
- [ ] **Step 2: Run** `npm test -- src/lib/queue-order.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the three functions and `QueueIcon`.
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shelves): queue sort defaults, shelf grouping and the queue glyph`.

### Task 2: A queue opens on Queue Order

**Files:**
- Modify: `src/stores/library.store.ts` (`setActiveShelf`, `SHELF_ADDED_DESC` usage)
- Modify: every caller of `setActiveShelf` that opens a shelf (find with `grep -rn "setActiveShelf(" src`; today `ShelfList.tsx`)
- Test: `src/stores/library.store.test.ts`

**Interfaces:**
- Consumes: `defaultShelfSort` (Task 1).
- Produces: `setActiveShelf(shelfId: string | null, kind?: ShelfKind): void` — `kind` defaults to `'manual'`; entering a shelf sets `sort` to `defaultShelfSort(kind)`.

- [ ] **Step 1: Write the failing tests** (reuse the file's `window.Musaeum` mock): `setActiveShelf('q', 'queue')` leaves `sort` equal to `{ field: 'shelf_position', direction: 'asc' }` and `librarySort` equal to the library sort held before; `setActiveShelf('m')` still gives `shelf_added` desc; moving straight from queue `q` to manual `m` gives `shelf_added` desc and leaves `librarySort` unchanged; `setSort({ field: 'title', direction: 'asc' })` inside a queue changes `sort` and **not** `librarySort`; `persistedLibraryState(state).sort` equals `librarySort` while a queue is open (AC11); leaving the shelf restores `librarySort`.
- [ ] **Step 2: Run** `npm test -- src/stores/library.store.test.ts`. Expected: FAIL on the queue cases.
- [ ] **Step 3: Implement** the optional `kind` parameter and use `defaultShelfSort`; pass `shelf.kind` from the sidebar row's click.
- [ ] **Step 4: Run** the store tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shelves): a queue opens on Queue Order`.

### Task 3: The sort control offers Queue Order first

**Files:**
- Modify: `src/components/layout/Toolbar.tsx`
- Test: `src/components/layout/shelf-list-wiring.test.ts` (it already walks the sort control)

- [ ] **Step 1: Write the failing walk:** `Toolbar.tsx` imports `shelfSortOptions` from `@/lib/queue-order`, no longer declares its own `SHELF_SORT_OPTIONS`, and reads the open shelf's kind through `shelfById(...)?.kind` from the shelves store.
- [ ] **Step 2: Run** `npm test -- src/components/layout/shelf-list-wiring.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** While a shelf is open the offered list is `[...shelfSortOptions(kind ?? 'manual'), ...SORT_OPTIONS]`; the existing "append the current sort if it is not offered" merge stays, so a list header's Author Z–A still selects correctly.
- [ ] **Step 4: Run** the walk and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shelves): the sort control offers Queue Order first inside a queue`.

### Task 4: The sidebar — group, glyph, create

**Files:**
- Modify: `src/components/layout/ShelfList.tsx`
- Test: `src/components/layout/shelf-list-wiring.test.ts`

**Interfaces:**
- Consumes: `groupShelves`, `QueueIcon`.
- `Editing` becomes `{ mode: 'create'; kind: ShelfKind } | { mode: 'rename'; id: string } | null`; `startCreate(ids, kind)`; the commit calls `window.Musaeum.shelves.create(trimmed, pending ?? undefined, editing.kind)`.

- [ ] **Step 1: Write the failing walks:** the file imports `groupShelves` and `QueueIcon`; `shelves.create(` is called with a third argument; two `onDragOver={onCreateDragOver}` controls exist (one per group's **+**) and each has an `aria-label` (`New shelf`, `New reading queue`); the existing `/>\s*New shelf\s*</` empty-state assertion still holds for the Shelves group; the delete dialog's heading uses the kind's noun (`shelf` or `queue`): update the existing `Delete the shelf “` assertion to the new template.
- [ ] **Step 2: Run** the walk file. Expected: FAIL on the new assertions only.
- [ ] **Step 3: Implement.** Render a **Reading Queues** group (header + **+**, rows with `QueueIcon`) above the **Shelves** group, rows from `groupShelves(shelves)`. Both **+** controls reuse `onCreateDragOver`/`onCreateDrop`, with the drop target key per group (`'create'` for shelves, `'create-queue'` for queues) so only the control under the pointer rings. The inline field's placeholder and `aria-label` follow the kind (`Shelf name` / `Queue name`); a queue row's menu says **Delete Queue…**. Row drag-over, drop, rename, context menu and double-click are shared code for both kinds; nothing else about a row changes.
- [ ] **Step 4: Run** the walks, `npm run typecheck`, `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shelves): queues get a sidebar group, a glyph and their own create control`.

### Task 5: Move to Top / Bottom, and the Undo's index

**Files:**
- Modify: `src/lib/shelf-membership.ts`
- Test: `src/lib/shelf-membership.test.ts`

**Interfaces:**
- Produces: `moveToEdge(shelfId: string, bookIds: readonly string[], edge: 'top' | 'bottom'): Promise<boolean>` — one `window.Musaeum.shelves.move(shelfId, [...bookIds], { to: edge })`; resolves `true` on success; on a rejection reports through `reportShelfFailure` and resolves `false` (never throws, like its siblings). An internal `sendMove(shelfId, bookIds, placement): Promise<boolean>` carries the call and the reporting so Task 8 reuses it.

- [ ] **Step 1: Write the failing tests:** `moveToEdge('q', ['a','b'], 'top')` calls `move` once with `('q', ['a','b'], { to: 'top' })` and the placement's own keys are exactly `['to']`; `'bottom'` likewise; a rejection (`new Error('That book is no longer in the queue')`) resolves `false` and calls the reporter once; and **`undoRemove('q', removed)` hands `restoreBooks` the very objects it was given when they carry `index`** (`toBe` identity on the array, `toEqual` on an element holding `{ bookId, addedAt, index: 3 }`).
- [ ] **Step 2: Run** `npm test -- src/lib/shelf-membership.test.ts`. Expected: FAIL (the index test may already pass: keep it, it pins the carried rule).
- [ ] **Step 3: Implement** `sendMove` and `moveToEdge`; do not touch `undoRemove`/`removeFromShelf`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shelves): moveToEdge, and a test that Undo hands a queue index back untouched`.

### Task 6: The menu and the panel offer them

**Files:**
- Modify: `src/components/library/BookContextMenu.tsx`, `src/components/library/SelectionPanel.tsx`
- Test: `src/components/library/context-menu-wiring.test.ts`

**Interfaces:**
- Consumes: `moveToEdge` (Task 5); the open shelf's kind via `shelfById(...)?.kind`.

- [ ] **Step 1: Write the failing walks:** both files import `moveToEdge`; the labels `Move to Top` and `Move to Bottom` appear in `BookContextMenu.tsx` **twice each** (the single-book branch and the multi-book branch) and once each in `SelectionPanel.tsx`; each occurrence is guarded by a queue check (`kind === 'queue'` in the same JSX expression), so the items are absent, not disabled, outside a queue; each is `disabled={!online}`; the single-book branch passes `[book.id]` and the multi-book branch and the panel pass the selection's ids; no occurrence is guarded by the sort or by `query`/`filters` (any sort of the queue, AC3).
- [ ] **Step 2: Run** the walk file. Expected: FAIL.
- [ ] **Step 3: Implement.** In the menu each call closes the menu first (`closeContextMenu()`), then `void moveToEdge(activeShelfId, ids, edge)`. Reuse existing icons (`SortArrowIcon` up/down) rather than adding glyphs.
- [ ] **Step 4: Run** walks, then the **Part A gate**: `npm run typecheck && npm run lint && npm test`. Expected: all green.
- [ ] **Step 5: Commit** `feat(shelves): Move to Top and Move to Bottom in a queue's menu and selection panel`.

---

## Part B — drag to reorder

### Task 7: The drag remembers where it started

**Files:**
- Modify: `src/lib/book-drag.ts`
- Test: `src/lib/book-drag.test.ts`

**Interfaces:**
- Produces:
  - `startBookDrag(e: DragHandle, bookId: string, sel: Selection, reorderShelfId?: string | null): void` — records `reorderShelfId` in the slot; `effectAllowed` is `'copyMove'` when it is a string and `'copy'` otherwise; the payload, MIME data, `text/plain` and drag image are unchanged.
  - `dragReorderShelfId(): string | null`; `clearDragPayload()` clears it with the payload.
  - `isBookDragTypes(types: readonly string[]): boolean` — `types.includes(BOOK_DRAG_MIME)`.

- [ ] **Step 1: Write the failing tests** (the file's existing fake `DragHandle`): with a shelf id the fake's `effectAllowed` ends `'copyMove'`, `dragReorderShelfId()` returns it and `dragPayload()` still holds the selection; without one `effectAllowed` is `'copy'` and `dragReorderShelfId()` is `null`; `clearDragPayload()` empties both; `isBookDragTypes(['Files'])` is `false`.
- [ ] **Step 2: Run** `npm test -- src/lib/book-drag.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shelves): a drag records the queue it started in and allows copy or move`.

### Task 8: The order, the placement, and the pending view

**Files:**
- Modify: `src/lib/queue-order.ts`, `src/lib/shelf-membership.ts`, `src/stores/library.store.ts`
- Test: `src/lib/queue-order.test.ts`, `src/lib/shelf-membership.test.ts`, `src/stores/library.store.test.ts`

**Interfaces:**
- Produces, in `queue-order.ts` (still no store import):
  - `dropSide(offset: number, size: number): 'before' | 'after'` — `'before'` when `offset < size / 2`.
  - `dropPlacement(targetId: string, side: 'before' | 'after'): ShelfPlacement` — exactly `{ before: targetId }` or `{ after: targetId }`.
  - `applyPlacement(order: readonly string[], moved: readonly string[], placement: ShelfPlacement): string[]` — mirrors main's `moveBooks`: the moved ids that are in `order` keep their **current relative order** and move as a block; `to: 'top'` puts them first, `'bottom'` last, `before`/`after` beside the anchor; an anchor that is itself moved, or not in `order`, returns `order` unchanged.
  - `orderBooksBy<T extends { id: string }>(books: readonly T[], ids: readonly string[]): T[]`.
  - `queueReorderable(i: { shelfKind: ShelfKind | null; sort: BookSort; query: string; filters: BookFilters; deviceId: string | null }): boolean` — true only for a queue, sorted `shelf_position`, with `query.trim() === ''`, `Object.keys(filters).length === 0` (the sidebar's own `hasActive` test) and no device scope.
- Produces, in `library.store.ts`: state `dropMark: { bookId: string; side: 'before' | 'after' } | null`, `reorderGen: number`; actions `setDropMark(mark | null)`, `setBookOrder(ids: readonly string[])` (re-orders `loadedBooks` and `books` by `orderBooksBy`, bumps `reorderGen`), `settleReorder()` (bumps `reorderGen`). `load()` records `reorderGen` when it starts and **returns without setting anything** if it differs when the read lands (the same shape as its identity check).
- Produces, in `shelf-membership.ts`: `reorderInQueue(shelfId: string, moved: readonly string[], placement: ShelfPlacement): Promise<boolean>`: reads the open list's ids from the store; if the shelf is not the open one or `applyPlacement` leaves the order equal, resolves `false` **without** an IPC call; otherwise `setBookOrder(next)`, `await sendMove(...)`, on `false` `setBookOrder(previous)`, then always `settleReorder()` and `await useLibraryStore.getState().load()`; resolves the move's result.

- [ ] **Step 1: Write the failing tests.**
  - `queue-order.test.ts`: `dropSide(10, 40)` is `'before'`, `(20, 40)` and `(30, 40)` are `'after'`; `Object.keys(dropPlacement('x', 'before'))` is `['before']` and `'after'` gives `['after']`; `applyPlacement(['a','b','c','d'], ['c','a'], { to: 'top' })` is `['a','c','b','d']` (block, current relative order, not the order passed); `{ to: 'bottom' }` on `['a','b']` for `['a']` is `['b','a']`; `{ before: 'b' }` / `{ after: 'b' }` land beside `b`; an anchor inside the moved set (`moved ['a','b']`, `{ before: 'b' }`) and an anchor not in the order both return an equal copy; ids not in the order are ignored; `queueReorderable` is `true` for a queue on Queue Order with empty query and filters, and `false` for each of: manual kind, `null` kind, `title` sort, `'  x '` query, `{ coAuthor: 'A' }` filters, a device id.
  - `shelf-membership.test.ts`: with the store holding books `a,b,c` and queue `q` open, `reorderInQueue('q', ['c'], { before: 'a' })` calls `move` once with exactly `('q', ['c'], { before: 'a' })`, the store's `books` order is `c,a,b` while the call is pending and the call's rejection restores `a,b,c`, reports once, and resolves `false`; a drop that changes nothing (`['a']` before `'b'`) makes **no** `move` call and resolves `false`.
  - `library.store.test.ts`: a `load()` started before `setBookOrder` and resolved after it does not overwrite `books`; a `load()` started after `settleReorder()` does; `setDropMark` round-trips.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the three files and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shelves): reorder a queue with a pending view that rolls back on refusal`.

### Task 9: The views take the drop

**Files:**
- Create: `src/hooks/useQueueReorder.ts`
- Modify: `src/components/library/ListView.tsx`, `src/components/library/BookCard.tsx`
- Test: `src/components/library/book-drag-wiring.test.ts`

**Interfaces:**
- Consumes: `queueReorderable`, `dropSide`, `dropPlacement`, `startBookDrag` (extended), `dragPayload`, `dragReorderShelfId`, `isBookDragTypes`, `reorderInQueue`, `dropMark`.
- Produces, in `useQueueReorder.ts`:
  - `useReorderableShelfId(): string | null` — the open queue's id while `queueReorderable` holds for the current stores, else `null`. A source passes it to `startBookDrag`.
  - `reorderDragOver(e: React.DragEvent, targetId: string, offset: number, size: number): void`, `reorderDragLeave(targetId: string): void`, `reorderDrop(e: React.DragEvent, targetId: string, offset: number, size: number): void` — a plain module of functions the row and the card call; each **re-asks the whole gate** from `getState()` (event types, `dragReorderShelfId() === activeShelfId`, `queueReorderable` now) and does nothing, and calls no `preventDefault`, when it fails, so a foreign drag falls through. A passing dragover sets `dropEffect = 'move'`, `preventDefault()`, and `setDropMark`. A passing drop clears the mark, returns if `dragPayload()` contains the target, else `void reorderInQueue(shelfId, [...payload], dropPlacement(targetId, side))`. **No handler calls `stopPropagation`.**
  - `useDropSide(bookId: string): 'before' | 'after' | null` — a selector over `dropMark`, so only the marked row re-renders.

- [ ] **Step 1: Write the failing walks** in `book-drag-wiring.test.ts`: `ListView.tsx` and `BookCard.tsx` each import `useReorderableShelfId`, pass its result as the fourth argument of `startBookDrag(`, and call `reorderDragOver(`, `reorderDragLeave(` and `reorderDrop(` from handlers on the **same box that is `draggable`**; neither file contains `stopPropagation` inside those handlers; neither names `setDragImage`; neither adds a `border` or padding class conditional on the mark (the indicator is a shadow or outline class keyed on `useDropSide`); the existing `draggable` assertions (box, not button) still hold; `useQueueReorder.ts` contains no `stopPropagation` and no `dropEffect = 'copy'`.
- [ ] **Step 2: Run** `npm test -- src/components/library/book-drag-wiring.test.ts`. Expected: FAIL on the new assertions.
- [ ] **Step 3: Implement.** The row computes `offset = e.clientY - rect.top`, `size = rect.height`; the card uses `clientX`/`width` (before = left half). The list row's indicator is a top or bottom inset shadow on its cells and the card's is an outer shadow in the column gap; both are paint-only, chosen so the drop point reads at a glance (builder's look). `draggable` stays on in every state: a drag out of the queue to another shelf is the add gesture and must keep working when the reorder affordance is absent.
- [ ] **Step 4: Run** the walks, then `npm run typecheck && npm run lint && npm test`. Expected: all green.
- [ ] **Step 5: Commit** `feat(shelves): drag to reorder inside an open queue`.

### Task 10: The record, and the one manual reading

**Files:**
- Modify: `docs/invariants/shelves.md` (*Queues* gains a slice-2 paragraph), `docs/invariants/library-views.md` (a short *The open queue* section), `docs/invariants/selection-and-keyboard.md` (one sentence), `tasks.md` (slice 2 status)

- [ ] **Step 1: Write the docs.** `shelves.md`: the renderer rules this slice settled and why: the pending order and its generation guard (a straddling read is dropped; the move always ends in one authoritative `load()`), the drag slot's `reorderShelfId` and `copyMove`, the gate re-asked in the drop, Move to Top/Bottom available in any sort, no Undo, and the two-`+` decision. Keep the "must not reach `main` before the wire lands" paragraph: slice 3 removes it. `library-views.md`: Queue Order is offered first, the reorder affordance is absent unless the queue is on Queue Order with no query and no facet, and the indicator is paint-only. `selection-and-keyboard.md`: a drag inside a queue carries the selection as one block, still without moving the selection.
- [ ] **Step 2: Run `/verify`** against a synthetic 7,000-book library holding a 200-book queue (AC17), recording: a one-book drag and a multi-select drag change the order and survive a Reload; the indicator shifts no row (row pitch unchanged: 37px in the list); scrolling stays virtualized (DOM node count stays near the 1,000 the library views doc reports); the affordance is absent with a search typed, a facet ticked and a sort other than Queue Order; a queue row dragged onto a shelf's sidebar row still adds; a Finder file drag over the open queue still raises the import overlay and reorders nothing. Note the result (or the failure) in `tasks.md`.
- [ ] **Step 3: Run the Part B gate** `npm run typecheck && npm run lint && npm test`. Expected: all green.
- [ ] **Step 4: Commit** `docs(shelves): the queue's renderer rules and the AC17 reading`.

---

## Self-review

- **Spec coverage (D5):** glyph + grouping + alphabetical within each (T1, T4); New Reading Queue incl. drop-to-create (T4, decision 1); opens on `shelf_position`, Queue Order first (T2, T3); drag-to-reorder only on Queue Order with no filter/search, absent otherwise, selection as a block (T7–T9); add payload kept and source id recorded, only the open queue's list reads it (T7, T9); pending order and rollback (T8); Move to Top/Bottom in any sort (T5, T6); `reportShelfFailure`, no Undo (T5, T8); carried items: index untouched (T5), exact placement shapes (T1 global constraint, T8 key assertions), invariant-7 geometry (T9 walks). ACs: AC2 (T8, T9, manual T10), AC3 (T6), AC4 (T8's `queueReorderable`, T9), AC11 (T2), AC17 (T10).
- **Type consistency:** `ShelfPlacement`, `ShelfKind` from `@shared/shelf.types`; `sendMove` is defined in T5 and consumed in T8; `setBookOrder`/`settleReorder`/`dropMark` are defined in T8 and read in T9; `startBookDrag`'s fourth parameter is defined in T7 and passed in T9.
- **Known gap, stated:** a drop below the last row or above the first has no target; Move to Bottom/Top covers the ends. The empty-queue pane still reads the shelf copy ("Drag books here to start a shelf"); a queue-specific sentence is a wording change left for later.
