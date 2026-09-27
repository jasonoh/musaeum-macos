# Shelves

**Read before:** touching `shelves.json`, `services/shelves.ts`, `services/shelves-file.ts`, the shelf cache, or a shelf-scoped read.

---

## Storage

`{library_root}/shelves.json` is canonical — a second canonical file beside `catalog.json`, which stays derived (invariant 1 is untouched: _Rebuild Catalog_ neither reads nor writes `shelves.json`, and the catalog stays derived from `metadata.json` alone). It holds every shelf and every shelf's membership in one file, versioned independently of the REST `apiVersion` (`src/types/shelf.types.ts` → `ShelvesFile`).

Two storage shapes were rejected (`docs/superpowers/specs/2026-09-27-bookshelves-design.md`, D1). Per-book `shelves` arrays in `metadata.json` would turn "add 300 books to a shelf" into 300 per-book writes over SMB plus a catalog write, and would bump every member's `last_modified` for a change that is not about the book. SQLite-only storage would never leave this Mac — shelves would not follow the library the way reading state and everything else already does. A library-level file pays neither cost: one shelf write touches one file, regardless of how many books it names.

## File first, cache second, one queue

Every shelf write goes through `services/shelves.ts`'s `mutate()`, and every mutation runs the same seven steps (D3): assert the library is writable (`nas.assertOnline()`); enter the one process-wide serial queue; **re-read** `shelves.json`; apply the change to what was just read; write it atomically (`.part` then rename, `shelves-file.ts` → `writeShelvesFile`); replace the SQLite cache from what was written (`db.replaceAllShelves`); broadcast `shelvesChanged`.

One file write per operation, whatever the number of books it names — `addMembers` and `pruneBooks` both loop in memory and write once. An operation that changes nothing (`alreadyOn` on every id, a rename to the same name) writes nothing at all: `Applied.changed` gates both the file write and the cache replace.

The cache is never built independently — it is replaced wholesale from the file `services/shelves.ts` just wrote, the same `db.replaceAllShelves` call that adoption uses on the file it just read. One function, two callers, so file and cache cannot drift apart by two implementations disagreeing about what a row means. A crash between the file write and the cache replace is repaired by the next adoption (on connect or Reload), because the file is what is canonical — the cache is only ever a rendering of it.

## Never overwrite what cannot be read

A `shelves.json` that exists but does not parse, or whose top-level `version` this build does not recognize, is never rewritten in this build's shape (`shelves-file.ts` → `parseShelvesFile` returns `null` for either). Every mutation refuses instead, with the verbatim sentence `services/shelves.ts` exports as `SHELVES_UNREADABLE`:

> shelves.json could not be read — shelf changes are paused so nothing is lost

The refusal holds until someone repairs the file by hand. Overwriting it with this build's best guess would either destroy a newer build's format (an unknown `version`) or discard a hand edit that just has a typo in it — and a stranded shelf file is recoverable by a person; a silently rewritten one is not. `readShelvesFile` further treats a share-read error (anything but `ENOENT`) as a throw rather than "no shelves": adoption must not empty the cache on a network blip, and a mutation must not start from nothing and overwrite a file it only failed to read.

Unknown shelf kinds and unknown top-level keys are the same rule going the other way: `parseEntry` carries a kind other than `'manual'` through untouched (`ForeignShelfEntry`), and `parseShelvesFile` spreads the raw object before overwriting only `version` and `shelves`. A later build's smart shelf, or a field this build has never heard of, survives an older build's edit of some other shelf in the same file.

## Why no tombstones

`shelves.json` carries no record of what used to exist. Every mutation re-reads the file before it changes anything (`findShelf`), so a shelf deleted on another Mac is simply absent from what was just read — the mutation throws `SHELF_GONE` (_"That shelf no longer exists"_), and the cache is replaced from the file that no longer holds it, so the sidebar drops it too. Nothing needs to resurrect a deletion that already happened; nothing needs a marker to say so. The one case a tombstone could not fix anyway is two Macs writing inside the same SMB write window — there, a whole-file last-write-wins, tombstones or not — so the residue is identical either way, and the file stays simpler for not carrying markers that buy nothing.

## Adoption

`shelves.adopt(root)` lands the file in the SQLite cache on connect (`library-sync.syncOnConnect`) and on Reload (`library-sync.refreshLibrary`), in both cases **after** the book swap and through the same queue the writes use — an adoption that read the file just before a write landed must not replace the cache after it and undo it.

- A **missing** file (`ENOENT`) is a library that has never had a shelf, and adoption **empties** the cache — a library root switched to a different library must not keep showing the last one's shelves.
- An **unreadable** file (fails to parse, or an unknown `version`) leaves the cache exactly as it was: browsing continues from the last good view, writes keep refusing, and the problem is logged once per session rather than on every connect and Reload.
- A member whose book the cache does not (yet) hold — the local catalog may simply be behind a book imported on another Mac — is left **out of the cache and kept in the file** (`db.replaceAllShelves`'s `INSERT OR IGNORE ... WHERE EXISTS`). Dropping it from the file would destroy real membership the next write would otherwise carry forward.
- Adoption never rejects: a shelf problem must never fail a catalog sync.

## Deletion

Both delete paths (`book-delete.deleteBook`, `deleteBooks`) call `shelves.pruneBooks(ids)` after the catalog removal — one `shelves.json` write for the whole batch, never one per book, and no write at all when no shelf holds any of the deleted books. A failure to prune is logged and swallowed (invariant 12): the book is already gone from the library either way, and a delete must not fail, or half-fail, because a share write on the side did not land.

**What a failed prune leaves behind, plainly:** a member a failed prune could not remove stays in `shelves.json` — permanently, not until "the next prune or write that touches it". No write sweeps a shelf's existing membership looking for books the catalog no longer holds, and none safely can: adoption's own rule (above) is that a member whose book is missing from the catalog is _kept_, because that book may simply not have arrived on this Mac yet from another one. A write that swept every shelf clean of ids the local catalog does not currently hold would delete exactly the membership that rule exists to protect. So the stray member is invisible rather than actively cleaned up: `replaceAllShelves` only ever inserts a membership row for a book the cache currently holds, so a book that is genuinely gone never appears in `listShelves`'s count, in `shelvesForBook`, or anywhere the UI or a cache reader looks — it simply sits in the file, inert, until someone edits the file by hand or the id is coincidentally named in a future prune.

## A shelf is a scope, not a filter

A shelf narrows a read; it is not a fifth facet beside tags and formats. `BookFilters.shelfId` enters SQL through `bookWhere`, the one WHERE builder every list, page, count, and facet read shares — `EXISTS (SELECT 1 FROM shelf_books WHERE shelf_books.book_id = books.id AND shelf_books.shelf_id = ?)` — so a shelf-scoped list and a shelf-scoped count can never disagree about which books qualify. `searchBooks(query, sort, scope?)` takes the same `shelfId` and applies it the same way.

The one sort that is not a column, `shelf_added`, is a correlated read bound to the open shelf's id inside `orderClause`: `(SELECT shelf_books.added_at FROM shelf_books WHERE shelf_books.book_id = books.id AND shelf_books.shelf_id = ?)`. Without a `shelfId` it has nothing to order by and takes the same fallback every unknown sort field takes — title, ascending, never a throw. On the REST surface, `sort=shelf_added` is refused with 400 until slice 5 gives that surface a `shelf` parameter to scope by (`services/api/query.ts`'s `parseSort`); until then it is exactly the unknown field it was before the type grew it.

---

Slice 2 puts a shelf in front of a person — the sidebar, drag-and-drop's payload rule (the module-level drag slot and its `application/x-musaeum-books` MIME type land with slice 3), sending a shelf to a Kindle (slice 4), and the REST surface — `GET /api/shelves`, `shelf` scoping on the two library routes, a `shelves` array on every book payload, and the `PUT`/`DELETE` membership routes (slice 5). None of that is built yet; this document describes what slice 1 landed underneath it.
