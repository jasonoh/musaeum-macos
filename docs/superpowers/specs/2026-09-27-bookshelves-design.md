# Design: bookshelves — user-made shelves on the Mac, mapped for the phone

**Date:** 2026-09-27
**Status:** Design approved section by section with Jason on 2026-09-27; written spec reviewed and approved the same day. Nothing is built. **Next step:** `superpowers:writing-plans` against this document, producing `docs/superpowers/plans/2026-09-27-bookshelves-slice1.md` (one plan per slice, as the phone-upload work did). A fresh session should read this spec, then the invariant docs named under **Depends on**, before planning.
**Scope:** Arbitrary, user-named, non-exclusive shelves on the desktop app — create, rename, delete, browse, add by drag or by menu, remove with a Remove-vs-Delete choice and an Undo, send a whole shelf to a Kindle — plus the REST surface the phone needs to browse shelves and toggle a book's membership, and a map of the phone's implementation. It does **not** cover smart (saved-query) shelves, manual ordering within a shelf, reordering shelves in the sidebar, or creating/renaming/deleting shelves from the phone (see *Rejected and deferred*).
**Depends on:** `docs/invariants/nas-and-catalog.md` (the catalog's write-and-adopt pattern this copies), `docs/invariants/files-and-deletion.md` (the delete paths shelves hook into), `docs/invariants/selection-and-keyboard.md` (the selection grammar drag reads), `docs/invariants/library-views.md` (the one WHERE builder, virtualization), `docs/rest-api.md` and `docs/superpowers/specs/2026-09-22-ios-companion-design.md` (contract discipline, AC19).
**Interacts with:** the device transfer queue (`src/stores/device.store.ts:76`), the Finder drop overlay (`src/hooks/useDragDrop.ts`), the delete dialogs, `BookContextMenu`, `SelectionPanel`, `BookDetail`, `Sidebar`.
**Supersedes:** the unused `collections` / `book_collections` tables of migration 001 and `requirements.md`'s "Custom collections (data model present, UI deferred)" line.

---

## Intent, as agreed

- Shelves are hand-curated lists the owner names. A book may be on any number of them.
- Books reach a shelf by single- or multi-select drag onto the shelf in the sidebar, and by a menu path that also serves the keyboard.
- Deleting a book while a shelf is open asks **Remove from Shelf** (default) or **Delete from Library**.
- Shelves follow the library between Macs and to the phone, the way reading state already does.
- The phone (option **B**, chosen 2026-09-27): browse shelves and add/remove a book; shelf create/rename/delete stays on the Mac.
- Ordering (option **B**): the library's normal sorts plus **Date Added to Shelf**; manual order is deferred, and the model keeps the door open.
- Extras chosen: **Send shelf to Kindle**, **Undo on remove**. Smart shelves are wanted *later*, "if implemented in a way that's actually smart" — the model reserves room (`kind`) and nothing else.

---

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| `collections` / `book_collections` tables, never read or written by any feature | `electron/main/schema/migrations/001_initial.sql`; pruned only in `services/db.ts:612`, `:670` |
| SQLite is a cache, transactionally replaced from `catalog.json` on connect and on Reload | `services/library-sync.ts:190` (`syncOnConnect`), `:224` (`refreshLibrary`), `services/db.ts:662` (`replaceAllBooks`) |
| the catalog's atomic write — `.part` then rename | `services/catalog.ts:115` |
| migrations are appended to one array, versioned by `PRAGMA user_version` | `services/db.ts:21` |
| one WHERE builder shared by `getBooks`, the page read and the count | `services/db.ts:229-282` |
| sort SQL per field, with an unknown-field fallback to title | `services/db.ts:196`, `:371` |
| `getFacets()` takes no scope today | `services/db.ts:677` |
| both delete paths, row → folder → catalog | `services/book-delete.ts:56` (`deleteBook`), `:141` (`deleteBooks`) |
| the context-menu scope rule drag will mirror | `src/lib/selection.ts:114` (`contextMenuScope`) |
| bulk send to a device, already skipping books on it | `src/stores/device.store.ts:76-77` |
| the only drag in the app: Finder files, keyed on `dataTransfer.types` including `Files` | `src/hooks/useDragDrop.ts:23` |
| search ignores filters today | `src/stores/library.store.ts:120-125` |
| the phone requires `apiVersion` to equal exactly `1`, reads every model through `StrictObject` (absent key throws; extra keys are ignored) | `musaeum-ios/Musaeum/Core/API/MusaeumClient.swift:148`, `ContractModels.swift:10-15`, `:31` |
| the phone already queues an idempotent write for replay | `musaeum-ios/Musaeum/Core/Store/ReportQueue.swift` |

---

## D1 — Shelves are stored in `{library_root}/shelves.json`, canonical, mirrored into SQLite

**Decision:** one library-level file holds every shelf and its membership:

```json
{
  "version": 1,
  "shelves": [
    {
      "id": "uuid-v4",
      "name": "To Read",
      "kind": "manual",
      "created_at": "2026-09-27T10:00:00.000Z",
      "updated_at": "2026-09-27T10:05:00.000Z",
      "books": [{ "id": "book-uuid", "added_at": "2026-09-27T10:05:00.000Z" }]
    }
  ]
}
```

- It is canonical for shelves the way `metadata.json` is canonical for a book. It is **not** derived from anything, so invariant 1 is untouched: the catalog stays derived from `metadata.json`, and *Rebuild Catalog* neither reads nor writes `shelves.json`.
- `kind` is `"manual"` for every shelf this spec creates. The reader **skips any kind it does not know** (and preserves it on write), so a later build's smart shelf survives an older build's edit.
- **No tombstones.** Section 1 as discussed carried a `deleted` list; it was dropped while writing this spec because it protects nothing. Every mutation re-reads the file (D3), so a shelf deleted on another Mac is simply absent and a mutation against it fails with *"That shelf no longer exists"* — nothing can resurrect it. The one case left is two Macs writing within the same SMB write window, and there a whole-file last write wins with or without tombstones. Removed members need none for the same reason.
- `version` is the file format's version, independent of the REST `apiVersion`.

**Why:** chosen over per-book `shelves` arrays in `metadata.json` (approach B) and SQLite-only storage (approach C) on 2026-09-27. A shelf is a list the library owns, not a property of a book; storing it per book turns "add 300 books to a shelf" into 300 `metadata.json` writes plus a catalog write over SMB, turns "delete a shelf" into a rewrite of every member, and bumps each book's `last_modified` for a change that is not about the book. SQLite-only would never leave this Mac.

**Consequence:** a second canonical file at the root, with the same last-write-wins-between-machines posture the catalog already has — narrowed further by D3's re-read.

## D2 — SQLite mirrors it: migration 006

**Decision:** `006_shelves.sql` drops `book_collections` and `collections` (empty in every database: no path ever inserted into them) and creates:

```sql
CREATE TABLE shelves (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'manual',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE shelf_books (
  shelf_id  TEXT NOT NULL,
  book_id   TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (shelf_id, book_id)
);
CREATE INDEX idx_shelf_books_book ON shelf_books(book_id);
```

No foreign keys: membership may name a book the local catalog does not hold yet (D4), and the rows are a cache the adoption swap replaces wholesale. `deleteBook` and `replaceAllBooks` replace their `book_collections` prune with a `shelf_books` prune.

## D3 — One service writes shelves: file first, cache second, one serial queue

**Decision:** `electron/main/services/shelves.ts` owns every mutation — `create(name, bookIds?)`, `rename(id, name)`, `deleteShelf(id)`, `addBooks(id, bookIds)`, `removeBooks(id, bookIds)`, `restoreBooks(id, memberships)`, and the internal `pruneBooks(bookIds)` the delete paths call. Each mutation:

1. calls `nas.assertOnline()` (the file lives on the share);
2. enters a single serial queue (one per process);
3. **re-reads** `shelves.json` (missing → empty);
4. applies the change to what it read;
5. writes via `.part` + rename;
6. applies the same change to SQLite in one transaction;
7. broadcasts `shelves:changed`.

- **One file write per operation**, whatever the number of books.
- A file that exists but does not parse is **never overwritten**: the mutation throws a named error (*"shelves.json could not be read — shelf changes are paused so nothing is lost"*) and SQLite is left as it was.
- `addBooks` keeps an existing member's `added_at` (idempotent) and ignores ids not in `books`; it returns `{ added, alreadyOn }`.
- `removeBooks` returns the removed `{ bookId, addedAt }[]`; `restoreBooks` re-inserts them **with those timestamps**, so an Undo restores a book to its place under *Date Added to Shelf*.
- A mutation that finds its shelf absent from the re-read file (deleted elsewhere) throws *"That shelf no longer exists"* and still broadcasts `shelves:changed`, so the sidebar drops it.
- **Names:** trimmed; non-empty; ≤ 80 characters; unique case-insensitively among manual shelves. A clash is refused with an error, never auto-suffixed.

**Why file-then-cache:** a failed share write must leave the cache unchanged, so the UI never shows a membership the file does not hold. A crash between steps 5 and 6 is repaired by the next adoption (D4), because the file is canonical.

## D4 — Adoption runs beside the catalog's

**Decision:** `syncOnConnect` and `refreshLibrary` (`services/library-sync.ts`) also read `shelves.json` and, after the book swap, replace `shelves` + `shelf_books` in one transaction via a new `db.replaceAllShelves(file)`, then broadcast `shelves:changed`.

- Unknown `kind`s are skipped for the cache (they stay in the file).
- Members whose book is not in `books` are **left out of the cache and kept in the file** — the catalog may simply be behind (a book imported on another Mac), and dropping them would destroy membership the next write carries forward.
- An unreadable file leaves the shelf cache as it was and logs once; browsing continues.
- *Rebuild Catalog* does not touch shelves.

## D5 — Deleting a book takes it off every shelf, batched

**Decision:** `book-delete.deleteBook` and `deleteBooks` call `shelves.pruneBooks(ids)` after the catalog removal — one `shelves.json` write for the whole bulk delete, never per book. A failure to prune is logged and swallowed (invariant 12's posture: the book is already gone; a stale member is ignored by D4's rule and removed by the next prune or write that touches it).

## D6 — The preload surface: `window.Musaeum.shelves`

```ts
interface ShelfSummary { id: string; name: string; kind: 'manual'; count: number }
interface ShelfMembership { bookId: string; addedAt: string }

shelves: {
  list(): Promise<ShelfSummary[]>                          // alphabetical, case-insensitive
  forBook(bookId: string): Promise<ShelfSummary[]>
  create(name: string, bookIds?: string[]): Promise<ShelfSummary>
  rename(id: string, name: string): Promise<void>
  delete(id: string): Promise<void>                        // books untouched
  addBooks(id: string, bookIds: string[]): Promise<{ added: number; alreadyOn: number }>
  removeBooks(id: string, bookIds: string[]): Promise<ShelfMembership[]>
  restoreBooks(id: string, memberships: ShelfMembership[]): Promise<void>
  onChanged(cb: () => void): () => void
}
```

Types live in `src/types/shelf.types.ts`; handlers in `electron/main/ipc/shelves.ts`, each a thin `handle()` wrapper (invariant 8). `count` counts only members present in `books`. `Book` does **not** gain a shelves field — membership is not book metadata (D1).

## D7 — A shelf is a scope, not a filter

**Decision:**

- `library.store` gains `activeShelfId: string | null`, set by the sidebar. It sits above the facet filters: **Clear** empties filters and keeps the shelf.
- `BookFilters` gains `shelfId?: string`. `getBooks`, the page read, the count and `getFacets(scope?)` all apply it through the **one existing WHERE builder** as `EXISTS (SELECT 1 FROM shelf_books WHERE shelf_books.book_id = books.id AND shelf_books.shelf_id = ?)`. No second query path.
- `searchBooks(query, sort, scope?)` takes `{ shelfId }` so a search inside a shelf searches the shelf. Search still ignores the facet filters — widening that is not this feature.
- The filter sidebar's counts are scoped to the open shelf.
- `useLibrary`'s selection prune (selection-and-keyboard.md) applies unchanged: entering a shelf drops selected books that are not on it — the same deliberate cost as narrowing a filter.
- The open shelf is **not** restored at launch (the store's existing "never reopen filtered" rule, `library.store.ts:211`).

## D8 — Sort: *Date Added to Shelf*

**Decision:** `SortField` gains `'shelf_added'` (label: *Date Added to Shelf* — newest/oldest first, added to `SORT_LABELS` in `src/types/book.types.ts`). It is offered in the sort control only while a shelf is open: `Toolbar.tsx`'s `SORT_OPTIONS` gains both directions of it, filtered out when `activeShelfId` is null. The list view gets **no** new column for it — a column header click selects that column's sort as today, and `Toolbar`'s existing "append the current sort if it is not in the list" rule keeps the select honest either way. Opening a shelf sets the sort to `shelf_added desc`; leaving it restores the library sort, which remains the only persisted sort. `SORT_SQL.shelf_added` orders by the correlated `added_at` for the active shelf, then the id tiebreak every ordered query already ends with. Reaching main without a `shelfId`, it falls back to title (the existing unknown-field rule), never throws.

## D9 — Desktop UI

**Sidebar (`Sidebar.tsx`, new `ShelfList.tsx`).**
- The **Library** row becomes navigation: clicking it clears `activeShelfId`. It keeps its reload icon and count.
- A **Shelves** section follows it, before Filters: header label with a **+** (inline name field; Enter creates, Esc cancels), then one row per shelf — name, count, active highlight identical to the Library row's.
- Right-click a shelf → **Rename** (also double-click; inline), **Send to ‹device›** (one per connected Kindle; absent when none), **Delete Shelf…** → confirm: *"Delete the shelf “‹name›”? Its N books stay in your library."*
- No shelves → a muted *"Drag books here to start a shelf"* line in the section.
- **There is no view header, and this feature adds none.** The toolbar (`src/components/layout/Toolbar.tsx`) is Add Books · search · sort · grid/list, and a new bar above the virtualized views would change their geometry (invariant 7). The open shelf is named in two places that already exist: its highlighted sidebar row (with its count), and the search field's placeholder, which reads *Search “‹shelf›”* while a shelf is open (`src/components/shared/SearchBar.tsx`). An empty shelf's view body reads *"Drag books here, or use Add to Shelf."* in the empty-library slot's styling.

**Drag (`BookCard.tsx`, `ListView.tsx`, new `src/lib/book-drag.ts`).**
- Native HTML5 drag on the card button and the list row. Payload scope: `dragScope(bookId, selection)` — the whole selection when the dragged book is in it, that book alone otherwise — mirroring `contextMenuScope`; **the selection is not changed** by starting a drag.
- `dataTransfer` carries MIME type `application/x-musaeum-books` (ids as JSON). `useDragDrop` keys on `Files`, so the import overlay stays down; this is asserted by test, not assumed.
- The payload is held in a module-level slot in `book-drag.ts` and cleared on the **window's** `drop` / `dragend`, never on the source element — a virtualized row can scroll out and unmount mid-drag.
- Drag image: a fanned stack of up to three thumbs with a gold count badge, drawn into an offscreen node and handed to `setDragImage`. Cover `<img>`s keep `draggable={false}`.
- Shelf rows are drop targets: a gold ring (the filter sidebar's selected tokens) on `dragover`; drop → `addBooks` → toast *"Added 3 to To Read"* / *"Added 2 to To Read · 1 already there"*. Dropping on the open shelf is a no-op. Dropping on **+** opens the name field, and confirming creates the shelf with the dragged books.
- Offline: targets show `dropEffect = 'none'`, with the storage copy main composes as the tooltip.
- Row heights are untouched (invariant 7): drag adds attributes and handlers, no DOM geometry.

**Menu path (`BookContextMenu.tsx`, `SelectionPanel.tsx`, `BookDetail.tsx`).**
- **Add to Shelf ▸** in the context menu (both scopes) and the selection panel: shelves alphabetically, then **New Shelf…** (creates with the scope's books). For a single book, shelves it is on carry a check, and choosing a checked shelf removes it (with Undo).
- `BookDetail` gains a **Shelves** row of chips: click → open that shelf; **×** → remove (with Undo). Empty → *"Not on any shelf"*.

**Removing inside a shelf (new `ShelfRemoveDialog.tsx`).**
- The context menu gains **Remove from “‹shelf›”** while a shelf is open: immediate, Undo toast.
- The trash entry points — card hover, detail panel, selection panel, the context menu's Delete — open `ShelfRemoveDialog` first while a shelf is open: **Remove from Shelf** (focused, Enter) and **Delete from Library…**. The latter hands over to the **existing** `DeleteBookDialog` / `DeleteSelectionDialog` (per-format picker, offline notice), which stay the only place anything is deleted. With no shelf open, every entry point behaves exactly as today.
- Remove toast: *"Removed 3 from To Read"* with **Undo** → `restoreBooks`. This is the existing toast surface as it stands: `Toast.action` (`src/stores/ui.store.ts:34`, rendered at `src/components/shared/Toasts.tsx:31`) and the `success` lifetime of 6000 ms (`ui.store.ts:38`). No toast changes.

**Send shelf to Kindle.** The shelf's context menu item calls the existing `device.store.sendBooksToDevice(bookIds, deviceId)`, which already skips books on the device and enqueues into the serial transfer queue. Toast: *"Sending 14 to ‹device› · 3 already on it"*. A shelf of more than 25 books asks first (*"Send 60 books to ‹device›?"*), because the queue has no bulk cancel.

## D10 — REST: additive, and `apiVersion` stays 1

**Decision:**

- **`GET /api/shelves`** (and `HEAD`) → `{ "shelves": [{ "id", "name", "kind", "count", "updatedAt" }] }`, alphabetical, `kind: "manual"` only, `count` as D6 defines it. Like the other JSON reads it answers **200 from the cache while the library is offline** (`docs/rest-api.md` § *Failure semantics*).
- **`GET /api/library?shelf={id}`** and **`GET /api/library/facets?shelf={id}`** — scoped through the same WHERE builder. Unknown shelf → **404**. `sort=shelf_added` without `shelf` → **400**. With `shelf` and no `sort` (and no `q`), the order is `shelf_added` descending, matching the Mac.
- **Every book payload gains `"shelves": ["shelf-id", …]`** — ids only, always present (`[]` when none), on the list, the detail, the reading `PUT`'s and the upload's `book`. The page read fills it with one batched `IN` query over the page's ids; names come from `/api/shelves`, so a rename changes no book payload.
- **`PUT /api/shelves/{id}/books/{bookId}`** adds; **`DELETE`** on the same path removes. No body. Both idempotent (an existing member keeps its `added_at`; removing a non-member is 200). Both answer `200 { "book": … }` in the detail shape. Unknown shelf or book → 404; share offline → **503 `library offline`**, `Retry-After: 5`. Both run through `services/shelves.ts` (D3), so the Mac's sidebar updates live.
- `docs/rest-api.md` § *Methods* gains the first `DELETE` and states the two new writes; § *Not in this version* names what stays absent: shelf create/rename/delete and smart shelves.

**Why `apiVersion` stays 1 — a correction to the design as discussed.** The section-4 conversation proposed bumping to 2 so the phone could gate on it. Reading the client while writing this spec showed that would **lock out every installed phone**: it requires `health.apiVersion == 1` exactly (`MusaeumClient.swift:148`). Everything here is additive, and the client ignores keys it does not know, so a v1 client is unaffected — the same reasoning, and the same outcome, as the upload spec's D7. **Capability detection instead:** the phone probes `GET /api/shelves` once per connect; `404` → no shelf UI.

## D11 — The phone (map only; built in `musaeum-ios` from its own annex)

The annex lives in that repository, `../musaeum-ios/docs/plans/`, numbered in that repo's own slice sequence (the upload's was `2026-09-23-slice4-upload.md`), and is written only after slice 5 lands here — that repo's invariant 1 is that the contract lives in this one.

- **Core/API:** `Shelf` in `ContractModels.swift` (through `StrictObject`); `shelves: [String]` on the book model, **read as `[]` when absent** — `StrictObject` throws on an absent key, and a pre-shelves Mac omits it, so a required read would break the whole library against an older Mac. This is the one deliberate exception to that repo's "always present" rule, and the annex records it as such; `shelf` on `LibraryQuery`; `shelves()`, `addToShelf`, `removeFromShelf` on `MusaeumClient`.
- **Library:** a shelf picker in the library header (*All Books ▾* → shelves). A shelf scopes the list, defaults to *Date Added to Shelf*, and keeps search and filters.
- **Detail:** a *Shelves* row opening a checklist sheet; each toggle is one `PUT` or `DELETE`, and the returned `book` refreshes the row.
- **Unreachable Mac:** the writes are idempotent, so a `ReportQueue`-style replay is safe. Whether v1 queues or refuses is the annex's decision — recorded here as open, not assumed.
- **Fixtures:** the new `json payload=` blocks arrive through `scripts/vendor-contract-fixtures.sh` unchanged.

---

## Error handling

| Situation | Behaviour |
| --- | --- |
| Share offline / folder missing | Browsing a shelf works from the cache. Every mutation is refused by `assertOnline()`; drop targets refuse; menu items disable with main's storage copy. REST writes → 503. |
| Share write fails mid-mutation | The file is unchanged (atomic rename), the cache is unchanged, the toast names the failure; the drop or Undo can be retried. |
| `shelves.json` unparseable | Cache left as last adopted; mutations refused with the named error, surfaced once per session; the file is never overwritten. |
| Shelf deleted on another Mac | Mutation throws *"That shelf no longer exists"*; `shelves:changed` refreshes the sidebar. |
| Unknown book ids in an add | Skipped; excluded from `added`. |
| Crash between file write and cache write | Repaired by the next adoption. |
| Prune after a book delete fails | Logged, swallowed; the delete stands. |

---

## Acceptance criteria

### Slice 1 — storage, service, IPC (main process only)

1. Migration 006 applies to a database at `user_version` 5, drops `collections`/`book_collections`, creates `shelves`/`shelf_books`/`idx_shelf_books_book`, and leaves every `books` row untouched.
2. `create` → `addBooks` → `removeBooks` each produce exactly **one** `shelves.json` write (spy on the writer) and leave file and cache agreeing.
3. Two interleaved mutations started together both land: the queue serializes them and each re-reads, asserted over the final file.
4. `addBooks` twice with the same ids reports `alreadyOn` the second time and keeps the first `added_at`.
5. `removeBooks` then `restoreBooks` round-trips the original `added_at` values exactly.
6. A `shelves.json` containing invalid JSON makes every mutation throw the named error, and the file's bytes are unchanged afterwards.
7. A file containing a shelf of `kind: "smart"` is adopted without it in the cache, and a subsequent manual mutation writes it back byte-equivalent.
8. A shelf absent from the re-read file makes `addBooks`, `removeBooks`, `restoreBooks`, `rename` and `deleteShelf` throw *"That shelf no longer exists"* and leaves the file unchanged — the cached copy of a shelf deleted elsewhere cannot write it back.
9. A `shelves.json` with an unknown top-level `version` is treated as unreadable (criterion 6's refusal), never rewritten in the old format.
10. Name rules: empty, whitespace-only, 81-character and case-insensitive-duplicate names are refused; a rename to its own name in different case is allowed.
11. Adoption (`syncOnConnect`, `refreshLibrary`) replaces the shelf cache and keeps members whose books are missing out of the cache **and** in the file.
12. `deleteBooks` of N books performs one prune write and removes them from every shelf; `deleteBook` likewise.
13. `getBooks({ shelfId })`, the page read, the count and `getFacets({ shelfId })` return only the shelf's books through the shared WHERE builder; `shelf_added` orders by `added_at` with the id tiebreak; `shelf_added` without a shelf falls back to title.
14. `searchBooks(q, sort, { shelfId })` returns only matching books on the shelf.
15. Every mutation refuses when `assertOnline()` refuses, and neither file nor cache changes.

### Slice 2 — shelf UI (renderer)

16. The sidebar lists shelves alphabetically with counts; **+** creates inline; rename and delete work from the context menu; delete's confirmation names the book count and deletes no book.
17. Opening a shelf scopes the view, the search and the filter counts, and the search placeholder reads *Search “‹shelf›”*; **Clear** keeps the shelf; **Library** leaves it, restores the prior sort and the stock placeholder. No element is added above either view (grid and list geometry unchanged — the existing row-height tests still pass untouched).
18. *Date Added to Shelf* appears only inside a shelf and is the default there.
19. **Add to Shelf ▸** works from the context menu (both scopes) and the selection panel; checks and toggle-remove work for a single book; **New Shelf…** creates with the scope's books.
20. `BookDetail` lists the book's shelves; a chip navigates; **×** removes with Undo.
21. With a shelf open, every trash entry point opens `ShelfRemoveDialog` with Remove focused; with no shelf open, each behaves exactly as before — held by a wiring test in the style of `context-menu-wiring.test.ts`.
22. Undo restores membership and position under *Date Added to Shelf*.
23. A change made through REST updates the Mac's sidebar and open shelf without a reload (`shelves:changed`).

### Slice 3 — drag and drop (renderer)

24. `dragScope` is unit-tested over the selection grammar (in-selection → selection; outside → the one book; selection unchanged).
25. Dragging a book never raises the Finder import overlay (test over `useDragDrop`'s type check with the custom MIME type).
26. Dropping on a shelf adds and toasts; on the open shelf, nothing; on **+**, creates with the books.
27. A drag whose source row is scrolled out of the virtualized view before the drop still delivers its payload and clears on `dragend` — decided end-to-end over CDP with `/verify`.
28. Drop targets refuse while offline.

### Slice 4 — send shelf to Kindle

29. The shelf menu lists one **Send to ‹device›** per connected Kindle; the send enqueues only books not already on the device and toasts both counts; > 25 books asks first.

### Slice 5 — REST contract (no `apiVersion` change)

30. `/api/shelves`, the `shelf` parameter on both library routes, the `shelves` member on every book payload, and both writes are in `docs/rest-api.md` with `json payload=` blocks, and `shape.test.ts`'s golden case covers them (the same AC19 case, extended).
31. `PUT` twice answers 200 twice with an unchanged `added_at`; `DELETE` of a non-member answers 200; unknown shelf or book → 404; `sort=shelf_added` without `shelf` → 400; offline → 503 `library offline` with `Retry-After: 5` — over a real socket on an ephemeral port.
32. `health.apiVersion` is still `1`, and the v1 phone's vendored fixtures still decode (run in `musaeum-ios` after re-vendoring).
33. `scripts/api-smoke.sh` lists shelves, scopes the library by one, adds a book twice, reads it back on the detail, removes it, and checks the 404 and 400 — passing end to end against an isolated profile.

### Slice 6 — the phone (`musaeum-ios`, its own annex)

34. Shelves appear only against a server whose `/api/shelves` answers 200.
35. Scoping, the default sort, and the detail checklist work against a live Mac, and a toggle made on the phone appears in the Mac's sidebar.

---

## Slices, and why they are cut this way

1. **Storage, service, IPC** — main process only: `006_shelves.sql`, `services/db.ts`, `services/shelves.ts` (+ test), `services/library-sync.ts`, `services/book-delete.ts`, `ipc/shelves.ts`, the preload, `src/types/shelf.types.ts` + `api.types.ts` + `book.types.ts`. Fully decidable by vitest, no UI. Route: `contracts-engineer` for the types and migration, `main-engineer` for the rest, `test-author` for the cases.
2. **Shelf UI** — `src/` only: `library.store`, a `shelves.store` + `useShelves` hook, `Sidebar`/`ShelfList`, `BookContextMenu`, `SelectionPanel`, `BookDetail`, `ShelfRemoveDialog`, toast action. Route: `renderer-engineer`.
3. **Drag and drop** — `src/lib/book-drag.ts`, `BookCard`, `ListView`, `ShelfList` targets. Depends on 2.
4. **Send shelf to Kindle** — one menu item and a toast over the existing queue. Depends on 2; parallel with 3.
5. **REST** — `api/rest.ts`, `services/api/routes.ts`, `services/api/shape.ts` (+ test), `docs/rest-api.md`, `scripts/api-smoke.sh`, a socket test. Depends only on 1; parallel with 2–4. The three contract artifacts cannot be separated (AC19).
6. **Phone** — its own repository, after 5 lands.

Slices 1 and 5 each approach CLAUDE.md's ~10-file bound; the plan should confirm the counts and split further if either exceeds it.

**Docs, landing with the slice they describe:** a new `docs/invariants/shelves.md` (storage and its reasons, file-then-cache, why no tombstones, scope-not-filter, the drag payload rule) and its row in CLAUDE.md's routing table; `docs/data-contracts.md` (`shelves.json`, the schema change, the preload namespace) and CLAUDE.md's storage tree; `docs/invariants/files-and-deletion.md` (the prune replaces the `book_collections` sentence); `docs/rest-api.md`; `CHANGELOG.md`; `tasks.md` (the deferred items below); `requirements.md`'s collections line marked superseded.

---

## Rejected and deferred, with the condition that would revive them

- **Per-book `shelves` in `metadata.json`** — rejected (D1): per-member writes at 7,000-book scale, `last_modified` noise. **Revived** only if shelves must survive the loss of the library root's own files while per-book files survive — which no current failure mode produces.
- **SQLite-only shelves** — rejected (D1): never leaves the Mac.
- **Smart shelves** — deferred by the owner, wanted later if genuinely smart (not just a saved filter). The model reserves `kind`; the reader already skips unknown kinds. **Revived** by its own brainstorm.
- **Manual order within a shelf** — deferred (ordering option B). `added_at` gives a later manual order its seed. **Revived** when *Date Added to Shelf* stops being enough.
- **Reordering shelves in the sidebar** — not chosen; alphabetical. **Revived** by a shelf count where alphabetical stops working.
- **Shelf create/rename/delete from the phone** — out of scope by option B. **Revived** as additive `POST`/`PATCH`/`DELETE /api/shelves…` routes.
- **`apiVersion` 2** — rejected (D10): it would lock out the installed phone.
- **Search honouring facet filters** — pre-existing behaviour, not widened here. Filed in `tasks.md` if the shelf-scoped search makes the asymmetry noticeable.

## Risks, stated plainly

1. **Two Macs editing shelves at the same instant** can lose one edit — the catalog's own last-write-wins posture, narrowed by re-read-before-write to the window of one SMB write.
2. **A hand-edited or truncated `shelves.json`** pauses shelf edits until repaired. Chosen over overwriting: a silent reset would destroy every shelf.
3. **Native drag inside a virtualized list** is the least-proven part; AC27 is decided end-to-end, not by a unit test.
4. **Every book payload grows** by a (usually empty) array; the page read gains one indexed query.
5. **Invariants held:** #1 (the catalog stays derived; `shelves.json` is a separate canonical file), #7 (no geometry change), #8 (logic in `services/shelves.ts`; handlers thin), #9 (no `file://`), #12 (prune failure non-fatal; offline degrades to read-only). **Untouched:** #2, #3, #4, #5, #6, #10, #11.

## Not verified

1. **That no existing database holds a `collections` row.** Predicted empty (no insert path exists). **Answered 2026-09-27:** the dev database (7,121 books) holds **0** `collections` and **0** `book_collections` rows, read with `sqlite3 -readonly`. The residual is any *other* machine's database; slice 1's migration asserts the tables are empty before dropping them and, if not, fails loudly rather than discarding rows.
2. **Electron's `setDragImage` with an offscreen, just-rendered node** — whether the image paints on the first drag in Chromium 1xx under Electron 44. The instrument is a throwaway drag over CDP in slice 3's first task; the fallback is a static single-cover image.
