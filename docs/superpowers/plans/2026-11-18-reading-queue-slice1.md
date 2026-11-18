# Reading Queue — Slice 1 (the record, the cache, the service) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shelf of `kind: "queue"` can be created, held in `shelves.json` in the order the user gave it, mirrored into the SQLite cache with a `position`, read back in that order, reordered with `moveBooks`, and Undo-restored to its old place — all through `services/shelves.ts` and reachable over IPC. No renderer UI, no REST change.

**Architecture:** A queue entry is a manual entry with a different `kind`; the `books` array order *is* the queue order (index 0 is the top). The cache gains `shelf_books.position` (the array index), a `shelf_position` sort reads it through the same correlated-subquery path `shelf_added` uses, and one new service write, `moveBooks`, rewrites the array through `mutate()`. Everything that said "manual shelf" meaning "a shelf this build edits" now says "list shelf" (manual or queue).

**Tech Stack:** TypeScript strict, better-sqlite3 (cache), vitest run through Electron-as-Node (`npm test`), Electron IPC via `ipc/handle.ts`.

**Spec:** `docs/superpowers/specs/2026-11-18-reading-queue-design.md` (read it first, then `docs/invariants/shelves.md`). This is spec slice 1; slices 2 (renderer), 3 (REST + docs) and 4 (iOS) follow as their own plans.

## Global Constraints

- Branch: work on `feat/reading-queue`, cut from `main`. **Do not merge to `main` before spec slice 3 lands**: slices 1–2 let a queue exist while `GET /api/shelves` and a book's `shelves` ids would already carry it, and the wire's document and goldens say otherwise until slice 3 (`docs/rest-api.md`; iOS invariant 1).
- Invariant 8: logic in `electron/main/services/`; IPC handlers stay thin wrappers through `handle()`. Invariant 12: a shelf problem never fails a catalog sync.
- Every shelf write goes through `mutate()` in `services/shelves.ts`: file first, cache second, one write, none when nothing changed.
- `src/types/` gets no `any`. Markdown prose is one line per paragraph (no hard-wrapping).
- `ShelfKind` is exactly `'manual' | 'queue'`; the file's `kind` string is `"queue"`; the SQLite migration is `009_shelf_position.sql`; the new sort field is `'shelf_position'`, label `Queue Order`, ascending only.
- Refusal sentences (exact): `SHELF_NOT_QUEUE = 'Only a reading queue can be reordered'` and `QUEUE_BOOK_GONE = 'That book is no longer in the queue'`, both exported from `services/shelves.ts`.
- Tests run only via `npm test` (e.g. `npm test -- electron/main/services/shelves.test.ts`); never invoke vitest directly (native ABI).
- Each commit message ends with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Conventional-commit prefixes, as in `git log`.

## Review Focus

- **`moveBooks` is handed junk:** duplicate ids, ids not on the shelf, an empty list, ids that are all already in place → must change nothing, write nothing, bump no `updated_at` (Task 7).
- **The anchor of a drag-drop move is the moved book itself, or was removed on another Mac:** the first is a silent no-op, the second a refusal with `QUEUE_BOOK_GONE` and no file change (Task 7).
- **Undo after the queue changed in between:** an `index` past the shelf's current length lands at the end; a book already back on the shelf is not duplicated; several removed books restore in their original relative order (Task 6).
- **`create` with an unknown kind from IPC, and an initial `bookIds` list with repeats:** the kind is refused, and the books keep the first-occurrence order given (Task 5).
- **A database already at user_version 8 holding shelves, opened by this build:** migration 009 must run, and until adoption rewrites the cache every `position` is `0` so a queue-order read is stable by the id tiebreak rather than erroring (Task 3).

---

### Task 1: The contract — kinds, memberships, the sort field

**Files:**
- Modify: `src/types/shelf.types.ts`
- Modify: `src/types/book.types.ts` (`SortField`, `SORT_LABELS`; `isBookSort` and `defaultSortDirection` follow)
- Modify: `src/stores/library.store.ts` (`restoredSort`, line ~155)
- Test: `src/types/book.types.test.ts`, `src/types/shelf.types.test.ts` (create), `src/stores/library.store.test.ts`

**Interfaces:**
- Produces, in `src/types/shelf.types.ts`:
  - `type ShelfKind = 'manual' | 'queue'`
  - `interface QueueShelfEntry { id: string; name: string; kind: 'queue'; created_at: string; updated_at: string; books: ShelfBookEntry[] }`
  - `type ListShelfEntry = ManualShelfEntry | QueueShelfEntry`; `type ShelfEntry = ListShelfEntry | ForeignShelfEntry`
  - `isListShelf(entry: ShelfEntry): entry is ListShelfEntry` (manual or queue), `isQueueShelf(entry: ShelfEntry): entry is QueueShelfEntry`; `isManualShelf` stays.
  - `interface ShelfMembership { bookId: string; addedAt: string; index?: number }` — `index` is the member's position at removal and is present only for a queue.
  - `type ShelfPlacement = { to: 'top' | 'bottom' } | { before: string } | { after: string }`
- Produces, in `book.types.ts`: `SortField` gains `'shelf_position'`.

- [ ] **Step 1: Create the branch.** `git switch -c feat/reading-queue`. The spec and this plan are untracked on `main`; they travel with the branch.

- [ ] **Step 2: Write the failing tests.**
  - `book.types.test.ts`: `isBookSort({ field: 'shelf_position', direction: 'asc' })` is `true`; `defaultSortDirection('shelf_position')` is `'asc'`; `sortLabel({ field: 'shelf_position', direction: 'asc' })` is `'Queue Order'`; and so is `direction: 'desc'` (the direction is normalized in SQL, so the label does not mislead).
  - `shelf.types.test.ts`: for `{ kind: 'manual' }` and `{ kind: 'queue' }` entries `isListShelf` is `true`; for `{ id: 'x', kind: 'smart' }` it is `false`; `isQueueShelf` is `true` only for `'queue'`.
  - `library.store.test.ts`: `restoredSort({ field: 'shelf_position', direction: 'asc' })` is `null` (alongside the existing `shelf_added` case near line 179).

- [ ] **Step 3: Run them to verify they fail.** `npm test -- src/types src/stores/library.store.test.ts` — Expected: FAIL (no such field / export).

- [ ] **Step 4: Implement.** Add the types and predicates above; widen `ShelfKind`; add `shelf_position` to `SortField` with the doc comment pattern of `shelf_added`, add its two `SORT_LABELS` entries (both `'Queue Order'`); `restoredSort` refuses both `shelf_added` and `shelf_position` (update its doc comment's reason to cover both).

- [ ] **Step 5: Run the tests and `npm run typecheck`.** Expected: PASS. If typecheck reports a non-exhaustive `Record<SortField, …>` elsewhere, add the entry there.

- [ ] **Step 6: Commit.** `git add src/types src/stores && git commit -m "feat(shelves): the queue kind, a membership index and the shelf_position sort in the contract"`

### Task 2: The file reads a queue

**Files:**
- Modify: `electron/main/services/shelves-file.ts` (`parseEntry`, line 61)
- Test: `electron/main/services/shelves-file.test.ts`

**Interfaces:**
- Consumes: `QueueShelfEntry`, `isListShelf` (Task 1).
- Produces: `parseShelvesFile` returns a `kind: 'queue'` entry as a `QueueShelfEntry` (not foreign), validated field by field exactly as a manual entry is.

- [ ] **Step 1: Write the failing tests** (reuse the file's `text()` helper and `manual` fixture):
  - a version-1 file holding a valid queue entry parses with `file.shelves[0]` deep-equal to the input and its `books` order untouched;
  - a queue with `books` not an array, or a book entry missing `added_at`, makes `parseShelvesFile` return `null` (whole file unreadable, as for a manual shelf);
  - `kind: 'smart'` is still carried through untouched as a foreign entry.

- [ ] **Step 2: Run** `npm test -- electron/main/services/shelves-file.test.ts` — Expected: the first two FAIL (a queue is read as foreign today, so the malformed one is accepted).

- [ ] **Step 3: Implement.** In `parseEntry`, treat `kind` `'manual'` or `'queue'` through the one existing field-by-field check, returning the raw object cast to the matching entry type; every other kind stays foreign.

- [ ] **Step 4: Run the file's tests.** Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "feat(shelves): shelves.json reads a queue entry as an editable shelf"`

### Task 3: The cache keeps kind and position

**Files:**
- Create: `electron/main/schema/migrations/009_shelf_position.sql`
- Modify: `electron/main/services/db.ts` (migration import and `MIGRATIONS` at lines 17–35; `replaceAllShelves` ~line 945; `toShelfSummary`, `listShelvesWithUpdatedAt`, `listShelves`, `shelvesForBook` ~lines 975–1060)
- Test: `electron/main/services/db-shelves.test.ts`, and the `user_version` assertions in `electron/main/services/field-overrides.test.ts` (lines ~240, ~275)

**Interfaces:**
- Consumes: `isListShelf`, `ShelfKind` (Task 1).
- Produces: `shelf_books.position INTEGER NOT NULL DEFAULT 0`; `replaceAllShelves(file)` stores each list shelf's `kind` and each member's array index as `position` (a member whose book the cache lacks leaves a gap — the index is the position in the file, not a counter of rows inserted); `ShelfSummary.kind` is read from the row in `listShelves`, `listShelvesWithUpdatedAt` and `shelvesForBook`.

- [ ] **Step 1: Write the failing tests** in `db-shelves.test.ts`, following its `manualShelf` / `rewindTo005` patterns (add a `queueShelf(id, name, members)` builder beside `manualShelf`):
  - `replaceAllShelves` of a queue `[['a'],['b'],['c']]` leaves `position` 0, 1, 2 for a, b, c (`SELECT book_id, position FROM shelf_books WHERE shelf_id = ? ORDER BY position`);
  - with book `b` absent from the catalog, the rows are a→0, c→2 (a gap, `b` kept in the file by the caller, not asserted here);
  - `listShelves()` and `shelvesForBook('a')` carry `kind: 'queue'` for the queue and `'manual'` for a manual shelf; a `kind: 'smart'` foreign entry is still absent from the cache;
  - **migration:** a database rewound to `user_version = 8` with a `shelf_books` table lacking `position` and one row in it (build it the way `rewindTo005` builds its state; for 009 only `ALTER TABLE shelf_books DROP COLUMN position` plus `user_version = 8` is needed) reopens to `user_version` 9, keeps its row, and that row's `position` is `0`.
  - Update the existing `expect(...user_version...).toBe(8)` assertions to `9`.

- [ ] **Step 2: Run** `npm test -- electron/main/services/db-shelves.test.ts electron/main/services/field-overrides.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Migration file: one `ALTER TABLE shelf_books ADD COLUMN position INTEGER NOT NULL DEFAULT 0;` with a header comment in the style of `006` (what it mirrors, why the default, that adoption rewrites it). Register it in `db.ts`. `replaceAllShelves`: iterate `isListShelf` entries, insert `kind` from the entry, insert `position` from `member` index in `shelf.books` (`entries()`), keeping the `INSERT OR IGNORE … WHERE EXISTS` rule and first-occurrence-wins for a duplicated id. The three readers select `s.kind` and return it typed `ShelfKind`; their ordering (name `COLLATE NOCASE`, id) is unchanged.

- [ ] **Step 4: Run both test files, then `npm run typecheck`.** Expected: PASS.

- [ ] **Step 5: Commit.** `git add electron/main src && git commit -m "feat(shelves): cache a shelf's kind and each member's position (migration 009)"`

### Task 4: The `shelf_position` sort

**Files:**
- Modify: `electron/main/services/db.ts` (`orderClause`, ~line 545; confirm `searchBooks`'s scoped path goes through it)
- Test: `electron/main/services/db-shelves.test.ts`

**Interfaces:**
- Consumes: the `position` column (Task 3), `SortField` (Task 1).
- Produces: `getBooks`, `searchBooks` and `getBookPage` (whichever of them take a `shelfId`) ordered by the open shelf's `position` when `sort.field === 'shelf_position'` — always ascending whatever `direction` says, ties broken by `id ASC`; without a `shelfId` the unknown-field fallback (title ascending, never a throw).

- [ ] **Step 1: Write the failing tests** (cache seeded through `replaceAllShelves` with a queue whose file order is `c, a, b`):
  - `getBooks({}, { field: 'shelf_position', direction: 'asc' }, { shelfId })` returns ids `c, a, b`;
  - the same with `direction: 'desc'` returns `c, a, b` again (normalized);
  - with no `shelfId` it returns title order and does not throw;
  - two members sharing a `position` (insert a second row by hand into `shelf_books` with the same position) come back ordered by id;
  - `searchBooks('<a term all three titles contain>', sort, { shelfId })` is in queue order.

- [ ] **Step 2: Run** `npm test -- electron/main/services/db-shelves.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** A `shelf_position` branch beside `shelf_added`'s in `orderClause`: a correlated `(SELECT shelf_books.position FROM shelf_books WHERE shelf_books.book_id = books.id AND shelf_books.shelf_id = ?) ASC, <tiebreak>`, params `[shelfId]`. Update the function's doc comment.

- [ ] **Step 4: Run the file's tests.** Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "feat(shelves): order a shelf-scoped read by queue position"`

### Task 5: The service knows two kinds

**Files:**
- Modify: `electron/main/services/shelves.ts` (`findShelf`, `assertNameFree`, `addMembers`, `create`, `deleteShelf`, `pruneBooks`)
- Test: `electron/main/services/shelves.test.ts`

**Interfaces:**
- Consumes: `isListShelf`, `ListShelfEntry`, `QueueShelfEntry`, `ShelfKind` (Task 1).
- Produces:
  - `create(name: string, bookIds?: string[], kind?: ShelfKind): Promise<ShelfSummary>` — `kind` defaults to `'manual'`; any other runtime value rejects with `Error('Unknown shelf kind.')` **before** entering the queue; the returned summary and the file entry carry the kind;
  - every other write (`addBooks`, `rename`, `deleteShelf`, `pruneBooks`) works on either kind; `findShelf` returns a `ListShelfEntry`;
  - name uniqueness is **one namespace** across both kinds (case-insensitive, existing sentence).

- [ ] **Step 1: Write the failing tests** (the file's `onDisk()` helper; add `listShelfOnDisk(file, id)` returning a manual-or-queue entry beside `manualOnDisk`):
  - `create('Up Next', ['b','a','b'], 'queue')` writes a `kind: 'queue'` entry whose `books` ids are `['b','a']` (first occurrence, given order), returns `{ id, name: 'Up Next', kind: 'queue', count: 2 }`, and `shelves.list()` shows it with `kind: 'queue'`;
  - `create('X', [], 'smart' as never)` rejects `Unknown shelf kind.` and writes nothing;
  - creating a queue named `to read` after a manual shelf `To Read` rejects with the existing clash sentence, and the reverse order does too;
  - `addBooks(queueId, ['c'])` appends `c` last; re-adding it changes nothing and writes nothing (use `countWrites()`);
  - `rename` and `deleteShelf` work on a queue; `pruneBooks(['a'])` removes `a` from a queue in one write.

- [ ] **Step 2: Run** `npm test -- electron/main/services/shelves.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Replace `isManualShelf`/`ManualShelfEntry` with `isListShelf`/`ListShelfEntry` throughout the service; `create` validates `kind` first, builds the entry with it, and returns it in the summary; leave `addMembers`' append behavior alone (it is the queue's "joins the end").

- [ ] **Step 4: Run the file's tests and `npm run typecheck`.** Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "feat(shelves): create and edit a queue through the one shelf service"`

### Task 6: Undo restores a queue book to its place

**Files:**
- Modify: `electron/main/services/shelves.ts` (`removeBooks`, `restoreBooks`, `isMembership`)
- Test: `electron/main/services/shelves.test.ts`

**Interfaces:**
- Consumes: `ShelfMembership.index?` (Task 1).
- Produces: `removeBooks(id, bookIds)` on a **queue** returns memberships with `index` = the member's array index at removal (relative to the shelf **before** this removal); on a manual shelf it returns no `index`, as today. `restoreBooks(id, memberships)` on a queue re-inserts memberships that carry an `index` in **ascending index order**, each at `min(index, books.length)`; a membership with no `index` (or any membership on a manual shelf) is appended, as today. Skips (already on the shelf, book gone from the library, malformed) are unchanged.

- [ ] **Step 1: Write the failing tests** (queue `a, b, c, d` seeded through `create(..., 'queue')`):
  - `removeBooks(q, ['b','d'])` returns `[{bookId:'b',addedAt,index:1},{bookId:'d',addedAt,index:3}]`; then `restoreBooks(q, thatResult)` leaves the file order `a, b, c, d` with the original `added_at` values;
  - after removing `b` and `c`, remove `d` too and add `e`; restoring `b` (index 1) puts it at 1 and restoring `d` (index 3) on a three-book shelf lands at the end — never throws;
  - a book restored that is already back on the shelf is not duplicated;
  - on a manual shelf the removal result has no `index` key and a restore appends (existing behavior, pinned).

- [ ] **Step 2: Run** `npm test -- electron/main/services/shelves.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** `removeBooks` records the index while filtering (`shelf.books.entries()`) when the shelf is a queue. `restoreBooks` sorts the valid, not-yet-present memberships by `index` (those without one, last, in the given order) and splices each in. Extend `isMembership` to accept an optional non-negative integer `index`.

- [ ] **Step 4: Run the file's tests.** Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "feat(shelves): a queue's remove hands back each book's index and Undo restores it"`

### Task 7: `moveBooks`

**Files:**
- Modify: `electron/main/services/shelves.ts`
- Test: `electron/main/services/shelves.test.ts`

**Interfaces:**
- Consumes: `ShelfPlacement` (Task 1), `isQueueShelf`, `mutate`, `findShelf`.
- Produces:
  - `moveBooks(id: string, bookIds: string[], placement: ShelfPlacement): Promise<void>`;
  - exports `SHELF_NOT_QUEUE` and `QUEUE_BOOK_GONE` (exact sentences in Global Constraints).
  - Behavior: refuses a manual shelf with `SHELF_NOT_QUEUE`; `SHELF_GONE` as every write does; a malformed `bookIds` or `placement` (not an array / not one of the three shapes) rejects with `Error('That move could not be read.')`. Moved books are the shelf members named in `bookIds`, **in their current relative order**, moved as a block; ids not on the shelf and repeated ids are ignored. `before`/`after` name an anchor: not on the shelf in the re-read file → rejects `QUEUE_BOOK_GONE` and changes nothing; an anchor that is itself one of the moved books → no change. Writes once, and not at all (no file write, no `updated_at` bump, no cache replace) when the resulting id sequence equals the current one.

- [ ] **Step 1: Write the failing tests** (queue `a, b, c, d, e`; `countWrites()` and `onDisk()`):
  - `{ to: 'top' }` with `['d']` → `d, a, b, c, e`; `{ to: 'bottom' }` with `['b']` → `a, c, d, e, b`;
  - `['d','b']` (given out of order) with `{ to: 'top' }` → `b, d, a, c, e` (relative order is the shelf's, not the argument's);
  - `{ before: 'a' }` with `['c']` → `c, a, b, d, e`; `{ after: 'e' }` with `['a']` → `b, c, d, e, a`;
  - already in place (`['a']` to top; `['a','b']` before `'c'`) → zero writes and `updated_at` unchanged;
  - `['zzz']`, `[]`, `['a','a']` to `{ to: 'top' }` → no write, no throw (the last is a no-op because `a` is already first);
  - an anchor that is a moved book (`['a','b']`, `{ before: 'b' }`) → no write; an anchor not on the shelf → rejects `QUEUE_BOOK_GONE`, file unchanged;
  - on a manual shelf → rejects `SHELF_NOT_QUEUE`; on an unknown shelf id → rejects `SHELF_GONE`; `placement` of `{ to: 'middle' }` → rejects `That move could not be read.`;
  - a successful move broadcasts `shelvesChanged` once, and `getBooks` scoped to the queue with `shelf_position` returns the new order (cache replaced);
  - `added_at` of every member is unchanged by a move.

- [ ] **Step 2: Run** `npm test -- electron/main/services/shelves.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `moveBooks` through `mutate()`.** Validate the arguments first (so a malformed call never enters the queue). Inside `apply`: `moving` = `shelf.books` filtered to ids in the set of `bookIds`; `rest` = the others; then place — `top`: `[...moving, ...rest]`; `bottom`: `[...rest, ...moving]`; `before`/`after`: if the anchor is in `moving`, unchanged; if it is in neither list, throw `QUEUE_BOOK_GONE`; else splice `moving` into `rest` at the anchor's index (`+1` for `after`). Compare the id sequence with the original: unchanged → `{ changed: false }`; otherwise assign `shelf.books`, set `updated_at = now`, `{ changed: true }`. A hand-edited shelf with a repeated id must not lose or double a member: build `moving`/`rest` by filtering, which preserves multiplicity.

- [ ] **Step 4: Run the file's tests.** Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "feat(shelves): moveBooks reorders a queue in one write"`

### Task 8: The surface, and the slice's record

**Files:**
- Modify: `electron/main/ipc/shelves.ts`, `electron/preload/index.ts` (lines 34–44), `src/types/api.types.ts` (the `shelves` block, ~line 172)
- Modify: `docs/invariants/shelves.md`, `docs/data-contracts.md`, `tasks.md` (the Bookshelves entry)
- Test: `electron/main/ipc/shelves.test.ts`

**Interfaces:**
- Consumes: `create(..., kind)`, `moveBooks` (Tasks 5, 7); `ShelfKind`, `ShelfPlacement` (Task 1).
- Produces on `window.Musaeum.shelves`: `create(name: string, bookIds?: string[], kind?: ShelfKind): Promise<ShelfSummary>` and **`move(id: string, bookIds: string[], placement: ShelfPlacement): Promise<void>`**; IPC channel `shelves:move`.

- [ ] **Step 1: Write the failing test** in `ipc/shelves.test.ts`, in that file's existing style: `shelves:create` forwards a third `kind` argument to the service; `shelves:move` forwards `(id, bookIds, placement)` to `moveBooks` and returns the envelope's `{ success: true }`; a refusal from the service reaches the envelope as `{ success: false, error: <its sentence> }`.

- [ ] **Step 2: Run** `npm test -- electron/main/ipc/shelves.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** the handler, the preload entries (`create` gains `kind`; `move` is new) and the `api.types.ts` signatures with doc comments (a queue only; rejects as every shelf write does).

- [ ] **Step 4: Write the record.** `docs/invariants/shelves.md`: a *Queues (reading-queue slice 1)* section — the array order is the order and why no per-book field was chosen, `position` is the index and gaps are fine, `shelf_position` is ascending-only, Undo's `index`, `moveBooks`' no-write-on-no-change and anchor refusal, and that slices 1–2 must not reach `main` before the wire lands (spec D6). `docs/data-contracts.md`: `shelves.json` entry `kind: "queue"` and `shelf_books.position` (migration 009). `tasks.md`: under the Bookshelves entry, add the reading queue with its four slices and the spec path; mark slice 1 built once Step 5 passes.

- [ ] **Step 5: Run the whole gate.** `npm run typecheck && npm run lint && npm test` — Expected: all clean, no new failures versus `main` (the pre-change test count plus the new cases).

- [ ] **Step 6: Commit.** `git add -A electron src docs tasks.md && git commit -m "feat(shelves): expose queue creation and move over IPC; record the queue's rules"`

---

## Self-Review

- **Spec coverage (slice 1, D1–D4 and the main half of D3/D4):** D1 types and file → Tasks 1–2; D2 cache and migration → Task 3; D4 sort → Task 4 (and Task 1 for the type and `restoredSort`); D3 `create(kind)`, name namespace, `moveBooks`, Undo index → Tasks 5–7; IPC and preload → Task 8. Acceptance criteria 1 (file/relaunch order), 5, 6, 7, 8, 9, 10 are covered by Tasks 2, 5, 6, 7; AC10's "older build's edit preserves a queue" is the existing foreign-kind rule and needs a **mixed-file** test: Task 2's third bullet proves a foreign kind is untouched, and `shelves.test.ts`'s existing smart-shelf case (line ~313) must still pass with a queue present — covered by Step 5's full run. AC2, 3, 4, 11 (view half) are slice 2; AC12–14 slice 3; AC15–16 slice 4; AC17 slice 2. Spec D5–D8 are later slices by design.
- **Type consistency:** `ShelfPlacement`, `QueueShelfEntry`, `isListShelf`, `ShelfMembership.index`, `SHELF_NOT_QUEUE`, `QUEUE_BOOK_GONE`, `moveBooks`, `create(name, bookIds, kind)` are spelled identically everywhere above.
- **Proportion:** one plan for one slice of a four-slice spec; bodies are left to the implementer except `moveBooks`' placement algorithm, which the signature and tests do not determine.
