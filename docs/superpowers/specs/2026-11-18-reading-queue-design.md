# Design: The reading queue — a shelf kind that holds an order you set

**Date:** 2026-11-18
**Status:** Draft — awaiting Jason's approval. The shape (a new shelf `kind`, not a flag on a manual shelf; reorder on the Mac by drag, on the phone by Move to Top / Move to End only) was chosen by Jason on 2026-11-18. Everything marked *my call* below is the author's and unreviewed.
**Scope:** `electron/main/` (file, cache, service, IPC, REST), `src/` (sidebar, library view, drag), `src/types/`, one migration, `docs/rest-api.md` and its smoke script — and, afterwards, `musaeum-ios` from its own annex. Slices below keep each landing inside one boundary.
**Depends on:** `docs/invariants/shelves.md` (all of it), `docs/superpowers/specs/2026-09-27-bookshelves-design.md` (D1–D11), `docs/invariants/library-views.md` (sort SQL), `docs/rest-api.md`.
**Revives:** the bookshelves design's deferred item *Manual order within a shelf* — "revived when *Date Added to Shelf* stops being enough" — for one kind of shelf only.

---

## Why

Jason wants an active **to-read bucket** on the Mac and the phone: a list whose order is *his*, arbitrary, and means "next up" at the top. A manual shelf cannot be that — its only orders are the library's sorts and *Date Added to Shelf*, none of which can say "this one before that one". The queue is a place to put books in the order he intends to read them, and to change his mind.

## Goals

- A new shelf kind, `queue`, whose books keep exactly the order the user gave them, on the Mac and on the phone, surviving a restart, a Reload, and a second Mac.
- On the Mac: create a queue, drag books into any position, move a selection to the top or bottom from the context menu, and see the order hold across sessions.
- On the phone (once its slice lands — the installed build sends `sort=shelf_added` explicitly when it opens a shelf, so it keeps showing a queue in *Date Added to Shelf* order until then): open a queue and see it in the Mac's order; move a book to the top or the end from its long-press menu, and have the Mac's sidebar and view follow without a reload.
- Everything that works on a manual shelf keeps working on a queue — add, remove with Undo, rename, delete, the *Add to Shelf…* picker, drag into the shelf, the detail panel's chips — with the one addition that a queue remembers *where*.

## Non-goals / anti-goals

- **Not a single special list.** There is no limit of one: any number of queues may exist (*my default*, stated to Jason on 2026-11-18 and carried by his "proceed with … your recs"), under the shared name namespace of D3.
- **Not smart.** A queue does not fill itself, drop finished books, or reorder by rule. A queue that rearranges itself is a failure even if it looks tidy: the whole point is that the order is the user's.
- **No drag-to-reorder on the phone.** The phone's library is a paginated cover grid; SwiftUI has no native move gesture for it, and most of a long queue may not be loaded. Move to Top / Move to End only. Revived by wanting finer placement on the phone — a slice of its own.
- **No converting a manual shelf into a queue**, or back. Creating the kind afresh is the only door in v1. Revived by someone wanting their existing "to read" shelf to become one; the conversion would seed order from `added_at`.
- **No auto-removal when a book is marked read.** The obvious next feature; it is a second decision (does a *finished* book leave, and does an *abandoned* one?) and not this one. Revived on its own.
- **No *add at position* from outside the queue.** A book dropped on a queue, or added by the picker, joins the end. Drag within the open queue is the only way to place a book between two others on the Mac.
- **No per-book position on the wire** (see D6). A book payload stays shelf-agnostic.
- **No change to `vendor/foliate-js/`, to `metadata.json`, to `catalog.json`.** Invariant 1 is untouched: `shelves.json` is already the second canonical file, and a queue lives in it.
- **Not Send-to-Kindle in order.** Slice 4 of the bookshelves workstream (send a shelf to a Kindle) is still open and unaffected; when built, it sends a queue's books like any shelf's.

## Constraints

- **Invariants 1, 8 and 12** carry over as `shelves.md` states them: the file is canonical, every write goes through `services/shelves.ts`'s `mutate()`, and a shelf problem never fails a catalog sync.
- **The file is a whole-file, last-write-wins record shared by several Macs.** A reorder races exactly as an add does. Nothing in this design makes that worse and nothing tries to make it better (`shelves.md` → *Why no tombstones*).
- **`apiVersion` stays 1.** Everything on the wire is additive: the installed phone reads `kind` as a plain string and must not break on a value it has not seen.
- **No `any`, no class components, icons are the hand-rolled SVG set** (`src/components/shared/icons.tsx`) — a queue glyph is a new entry there.

## Approaches considered

- **A. A new `kind: "queue"` (chosen).** The `books` array in the shelf's entry is the order. A distinct thing you create, with its own sidebar presence and its own default sort. Cost: every place that says `kind === 'manual'` or `isManualShelf` must learn a second kind, and an older Mac build skips the shelf (it is preserved through that build's writes, never shown).
- **B. An `ordered` flag on a manual shelf.** Any shelf could become a queue, and an older Mac would still show it as a normal shelf. Rejected: Jason asked for a *type*, and a flag leaves a shelf that is neither obviously a queue nor a shelf. The conversion it makes cheap is the one non-goal above.
- **C. A per-book fractional `position` field** (so a drag writes one book's number). Rejected: a shelf's whole membership is one file written once per operation either way, the array is already ordered and already appended to, and fractional keys need rebalancing code for no gain.

## The design

**D1 — Storage: the array order is the order.** A queue entry in `shelves.json` has the manual entry's exact shape with `kind: "queue"`: `{ id, name, kind, created_at, updated_at, books: [{ id, added_at }] }`. **Index 0 is the top** — the book to read next. No new field. `added_at` keeps its meaning (when the book joined) and is never re-stamped by a move. `ShelfKind` becomes `'manual' | 'queue'`; `ManualShelfEntry` gains a sibling type or its `kind` widens (builder's call), with one predicate (`isListShelf`, name the builder's) true for both and used wherever `isManualShelf` meant "a shelf this build edits". `parseEntry` must stop treating `queue` as foreign. An unknown kind is still carried through untouched.

**D2 — The cache gains `position`.** Migration `009_shelf_position.sql` adds `position INTEGER NOT NULL DEFAULT 0` to `shelf_books`. `replaceAllShelves` writes each member's **array index within its shelf** as `position`, for every shelf, and inserts `kind` from the entry instead of the literal `'manual'`. Members the cache skips (a book not yet in the local catalog) leave a gap in the numbers; the sort orders by `position`, never assumes density. No backfill is needed: the cache is rebuilt wholesale from the file on the next adoption, and the migration's defaults make an un-adopted row sort stably by the book-id tiebreak until then.

**D3 — The service: one new write, three adjusted.** `services/shelves.ts` gains `moveBooks(shelfId, bookIds, placement)` through `mutate()`, with `placement` one of `{ to: 'top' }`, `{ to: 'bottom' }`, `{ before: bookId }`, `{ after: bookId }`. It applies in memory and writes once, and **writes nothing when the resulting order equals the current one** (`Applied.changed` is the gate, as for every other mutation). The books it is given move **as a block, keeping their relative order as they currently stand on the shelf** (not the order of the ids passed). An id not on the shelf is skipped. An **anchor** (`before`/`after`) that is not on the shelf in the re-read file — another Mac removed it — is a refusal with no change, never a guess at a position; the renderer reports it through `reportShelfFailure`. Moving applies to a queue only; on a manual shelf it refuses. `moveBooks` bumps `updated_at` when it changes anything.

The three adjusted writes: `create` takes a `kind` (default `'manual'`); `addMembers` is unchanged (it already appends, which is the queue's "joins the end"); and **Undo restores a queue book to its place** — `removeBooks` on a queue returns each `ShelfMembership` with an additional `index` (its position at removal), and `restoreBooks` re-inserts at `min(index, length)` in ascending-index order, so a remove-and-Undo leaves the queue as it was. A manual shelf's memberships carry no `index` and restore as today. `assertNameFree` treats manual and queue shelves as **one namespace** — a queue and a shelf may not share a name. `pruneBooks`, `deleteShelf` and `rename` apply to both kinds.

**D4 — Reads: `shelf_position` is a sort.** `BookSort.field` gains `shelf_position`. `orderClause` binds it to the open shelf exactly as `shelf_added` is: a correlated `(SELECT position FROM shelf_books WHERE book_id = books.id AND shelf_id = ?)`, ascending only (a descending queue is not offered, and a `desc` passed is normalized to ascending), tiebreak by id. Without a `shelfId` it takes the unknown-sort fallback like `shelf_added` does. `searchBooks` and `getFacets` are unchanged. `ShelfSummary.kind` and `listShelves` stop hard-coding `'manual'` and read the cache's `kind`.

**D5 — The Mac's surface.**
- **Creating.** The sidebar's **+** gains a second entry, **New Reading Queue…** (*my call on the words*), beside **New Shelf…**; the same name sheet, the same drop-to-create behaviour (a book dropped on the queue **+** starts a queue with it).
- **Sidebar.** Queues take their own glyph and sit **above** the manual shelves, alphabetical within each group (*my call*: the queue is the "active" list, and alphabetical placement would bury it).
- **Opening one.** The scope store opens a queue on `shelf_position` — the way a manual shelf opens on `shelf_added desc` (D8 of the bookshelves design) — and the sort control offers **Queue order** first for a queue, with the library sorts and *Date Added to Shelf* after it. The `shelf_added`-refusal rule extends: `restoredSort` refuses a stored `shelf_position` for the same reason it refuses `shelf_added` (`shelves.md` → renderer rule 2), and the persisted library sort is still written only from outside a shelf.
- **Reordering.** In a queue, on **Queue order**, with **no filter and no search active**, rows and cards can be dragged to a new place; a drag carrying a selection moves the selection as a block (D3). Outside those conditions the reorder affordance is absent rather than disabled — a position among a filtered subset has no meaning. The context menu (and the selection panel) gains **Move to Top** and **Move to Bottom** inside a queue, available in *any* sort of the queue because they are positions in the whole queue, not in the view.
- **Mechanics owed to the existing rules.** Virtualization: row and card geometry is computed (invariant 7) — a drop indicator adds no layout and the grid/list cells keep their block-level child. Drag (*my call*): a drag that starts in an open, reorderable queue **always carries the normal add payload** (`BOOK_DRAG_MIME` and the slot), so a book can still be dragged out of the queue onto another shelf in the sidebar, exactly as from any view. It **additionally** records the source queue's id in the slot (a `reorderShelfId`, name the builder's). Only the open queue's own list reads that field, and only when it equals the open shelf's id; every other target ignores it and behaves as today. The rule "the open shelf refuses an add drop" is unchanged — the reorder drop is a different gate on the list's own body, not a loosening of the sidebar's. The slot, the window-clears-it rule, no `stopPropagation`, and the event-types gate (`isBookDrag`) all hold; a drop re-asks the whole gate, and a stale slot must never turn a foreign drag into a reorder.
- **Between the drop and the write (*my call*).** The shelves store's no-optimism rule stands for the *shelves store*; the open queue's **view** holds a pending order from the moment of the drop until the `shelves:changed` reload lands, so the dropped rows do not snap back and jump over an SMB write. A refused move (anchor gone, file unreadable, offline) discards the pending order and the view returns to what the cache holds, with the one reported sentence. The pending order is view state only and is never persisted.
- **No Undo for a move in v1 (*my call*).** Remove has an Undo because it destroys a membership; a move destroys nothing, and Move to Top / Move to Bottom are their own inverse for the common case. `moveBooks` therefore returns nothing beyond success. Revived by a lost-place complaint after real use.
- **Failure.** A move refused (anchor gone, file unreadable, share offline) reports through `reportShelfFailure` once per sentence per session, like every shelf write.

**D6 — The wire (additive, `apiVersion` 1).** `docs/rest-api.md` is edited first, with its goldens and `scripts/api-smoke.sh`, in the same slice.
- `GET /api/shelves`: a queue appears with `kind: "queue"`. The wire's current rule — "`manual` for every shelf this build creates; a shelf of a kind this build does not know is not on the wire" — becomes "`manual` and `queue`". Ordering of the list on the wire stays alphabetical; the phone groups queues itself if it wants to.
- `sort=shelf_position` is accepted **only with a `shelf`** (400 without, like `shelf_added`), and with a `shelf` that is a queue **and no `sort` or `q`, the default order is `shelf_position`** (a manual shelf's default stays `shelf_added` descending). It is valid on a manual shelf too, because the cache holds positions for every shelf, but nothing offers it.
- **No per-book position field.** A book payload is shelf-agnostic (`shelves` is ids only, so a rename touches no book); a per-shelf position would break that. The rank is the order of the page walk. A client wanting "3 of 12" has the shelf's `count` and the list order.
- **One new write:** `PUT /api/shelves/{id}/books/{bookId}/position` with a JSON body `{ "to": "top" | "bottom" }`. It is a **PUT** because it sets a state and is idempotent. It answers `{ "book": … }` read back after the write, the same detail shape as the membership routes. It goes through `services/shelves.ts` (`moveBooks`) and its `shelves:changed` broadcast, so the Mac follows. Failure semantics are the membership routes': **503** `library offline` with `Retry-After: 5` refused before anything is written; **404** for an unknown shelf, an unknown book, a book not on the shelf, or any other method on the path; **500** for an unreadable `shelves.json` (the file is never overwritten). A move on a **manual** shelf is a **400** (*my call*: it is a well-formed request to a real resource that cannot honour it, which the 404's reason-free uniformity should not hide). **Order of refusals (*my call*, pinned by the goldens and the smoke script):** the share first (**503**, before anything is written); then an unknown shelf or unknown book (**404**); then a shelf that is not a queue (**400**); then a body that is not `{ "to": "top" | "bottom" }` (**400**); then a book that is not on the shelf (**404**). The wire carries no `before`/`after`.
- The paragraph in `rest-api.md` that says shelf create, rename and delete are "not on the wire, and are not planned" is **amended** to name this route as the one shelf write beyond membership.
- The phone's capability probe for the queue is `GET /api/shelves` itself: a `kind: "queue"` entry means queues exist; whether the Mac has the **move route** is learned from the first `404` on it, which the phone reads as "no Move menu", the way a pre-shelves Mac's `404` already reads as "no shelf UI".

**D7 — The phone (`musaeum-ios`, its own annex).** Specified here only as the contract it consumes; built from its own plan once the wire has landed.
- A queue appears in the scope control and in the book's shelf picker like any shelf. Adding through the picker uses the existing `PUT` and so appends.
- Opening a queue sends no `sort`, so the Mac's default (`shelf_position`) applies; the phone's sort menu inside a queue offers the library sorts only if the builder wants them — the queue order is the phone's default and is never persisted as the phone's sort (the same rule as `shelf_added`: *a sort chosen inside a shelf is the scope's own order*).
- Inside a queue, a book's long-press menu gains **Move to Top** and **Move to End**, calling the new route and refreshing the list (the list must keep its position, as the existing shelf re-query rules require).
- `AGENTS.md` invariant 4's three exceptions are untouched: `kind` is already a plain string.

**D8 — The older-build story, stated.** A Mac running a build from before this change **skips** a queue (never shown, never counted) and **preserves** it through its own writes, as `shelves.md` guarantees for any unknown kind. A queue may therefore be edited only by this build or later; an older Mac that deletes the *last* known shelf still writes the queue back. The installed phone shows the queue as a shelf (`kind` is a string), opens it under whatever sort it sends explicitly, and has no Move menu.

## Slices

1. **The record and the cache (main, contracts).** `shelf.types.ts`, `shelves-file.ts` (`parseEntry`), migration 009, `db.ts` (`replaceAllShelves`, `listShelves*`, `orderClause`, `BookSort`), `services/shelves.ts` (`create` kind, `moveBooks`, `removeBooks`/`restoreBooks` index, name namespace), IPC + preload for the new calls. Tests beside the code.
2. **The Mac's surface (renderer).** Sidebar group and glyph, New Reading Queue, the scope's default sort, the sort control, drag-to-reorder and its payload, Move to Top / Bottom in the context menu and selection panel, the Undo through the renderer's `shelf-membership.ts`.
3. **The wire (main REST + docs).** The shelf list's `kind`, `sort=shelf_position`, the default order, the `PUT …/position` route, `docs/rest-api.md`, its goldens, `scripts/api-smoke.sh`. Lands before the phone is touched (iOS invariant 1).
4. **The phone (`musaeum-ios`).** Its own annex and plan: the two menu items, the sort rule, the capability reading.

Slices 1–3 are each inside one boundary; none should exceed about ten files, and one that does is an escalation.

## Acceptance criteria

1. A queue created on the Mac appears in `shelves.json` as `kind: "queue"` with an ordered `books` array, and a relaunch or Reload shows the same order. (A)
2. Dragging one book, and a multi-selection, to a new place in an open queue changes the file's array once, keeps `added_at` untouched, and the view follows. A selection moves as a block in its existing relative order. (A)
3. **Move to Top** and **Move to Bottom** work from the context menu and the selection panel in any sort of the queue, and are absent outside a queue. (A)
4. The reorder affordance is absent (not disabled) when a filter or a search is active or the sort is not **Queue order**. (A)
5. Adding a book (picker, drag from the library, the REST `PUT`) to a queue puts it **last**. Re-adding an existing member changes nothing. (A)
6. Remove from a queue and **Undo** restores the book to its prior index, and a book restored after the queue shrank lands at the end. (A)
7. A move whose anchor was removed on another Mac refuses with no change to the file, and reports one sentence once. (A)
8. A move that does not change the order writes no file and bumps no `updated_at`. (A)
9. A queue and a manual shelf cannot share a name (case-insensitive); a rename to a clashing name is refused. (A)
10. A queue survives an older build's edit of some other shelf byte-equivalent, and an unknown kind survives this build's. (A)
11. `shelf_position` is refused as a restored persisted sort, and a sort chosen inside a queue is never written as the library's. (A)
12. `GET /api/shelves` carries `kind: "queue"`; `?shelf={queue}` with no sort answers in queue order across a page walk with no repeats; `sort=shelf_position` without `shelf` is a **400**. (A)
13. `PUT /api/shelves/{id}/books/{bookId}/position {"to":"top"}` puts the book first and `"bottom"` last, answers `{ "book": … }`, and is idempotent; the failure table of D6 holds, including **400** on a manual shelf. The Mac's sidebar and open view follow without a reload. (A)
14. `scripts/api-smoke.sh` exercises the new route and restores the queue's order before it ends, and a profile with no queue skips it, as the membership pair does. (A)
15. The installed phone, unchanged, lists a queue and opens it without error. (A — against a Mac carrying slice 3, with the existing phone build.)
16. On the phone, **Move to Top** and **Move to End** on a book in a queue take effect and the list shows it; against a Mac that 404s the route the menu is absent. (A — slice 4, in the iOS repo's own evidence.)
17. A first reading of the drag with **7,000 books in the library and a queue of 200**: the drop indicator adds no layout shift, the row/card geometry constants are unchanged, and scrolling stays virtualized. (M — one run in the built app.)

(A) automated, (M) a manual check in the running app.

## Left to the builder

- The names of the predicate and the sibling entry type in D1, and whether the entry type widens or splits.
- The drag payload's exact shape and the drop indicator's look, within the rules in D5.
- Whether the phone's sort menu inside a queue lists library sorts at all (D7).
- The queue glyph.
- How the SQL asserts `position` ordering stays stable when two members of one shelf somehow share a number (a hand-edited file) — by the id tiebreak the sort already ends with.

## Risks and what is not verified

- **Two Macs reordering at once** overwrite each other whole-file, last write winning. Stated, accepted, unchanged from every other shelf write.
- **An older Mac build** hides the queue entirely (D8). Jason's two Macs should run the new build before a queue is relied on.
- **Drag inside the virtualized list** is the one genuinely new interaction; the `book-drag.ts` rules were measured for *adding* and AC17 is the reading for *reordering*.
