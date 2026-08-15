# Design: Multi-book selection and bulk actions

**Date:** 2026-08-14
**Status:** Approved (brainstorming session with Jason)
**Scope:** Selection model for both library views, plus three bulk actions —
delete, send to device, and re-hydrate metadata. Bulk metadata edit is
explicitly deferred to the backlog.

Today the library can hold exactly one book at a time:
`ui.store.selectedBookId: string | null`, read directly by `BookCard`,
`ListView`'s `Row`, `BookDetail`, `BookContextMenu`, `DeleteBookDialog` and
`useBookNavigation`. Every action is therefore single-book, and deleting
twelve books is twelve trips through the same dialog.

This replaces that single id with a real selection, adds ⌘-click / ⇧-click in
both views and a checkbox column in the list, and gives the selection three
actions: delete, send to device, and re-hydrate metadata.

## What is in scope

- ⌘-click (toggle) and ⇧-click (range) in **both** views
- A checkbox column in `ListView`, always visible, with a select-all header box
- A selection panel in the detail slot when 2+ books are selected
- Bulk delete: one confirmation, one batched main-process operation
- Bulk send to device: N jobs onto the existing serial transfer queue
- Bulk re-hydrate: one sequential, cancellable main-process job
- Keyboard: ⇧+arrows extend, Escape clears, ⌘A selects all (see the caveat)

**The three actions are deliberately not symmetric**, because the services
under them are not. Delete needs a new batched main-process operation; send
needs no main-process work at all; re-hydrate needs a whole job with progress
and cancellation. Sections 9, 11 and 12 each justify their shape against what
the existing service actually does, and the differences are the design rather
than an inconsistency to be tidied away later.

## What is deliberately not in scope

- **Bulk metadata edit** (add tags / set series / set read status across a
  selection). Wanted, and the largest piece of new UI in the family; it goes to
  `tasks.md` as backlog rather than into this phase.
- **Card checkboxes in the grid.** The grid gets modifier clicks only.
- **Cross-view selection persistence beyond what already exists.** Selection
  lives in `ui.store`, so it already survives a grid↔list switch. Nothing here
  changes that, and nothing here persists selection across a restart —
  `partialize` keeps it out of `localStorage`, as it does today.

---

## 1. Selection state

`ui.store.selectedBookId` is replaced by one slice:

```ts
interface Selection {
  ids: Set<string>
  /** Range pivot. Set by plain and ⌘ clicks; ⇧ clicks leave it alone. */
  anchor: string | null
  /** Keyboard focus / ensure-visible target. Moves on every gesture. */
  cursor: string | null
}
```

**Two fields, not one, and not three.** `anchor` and `cursor` diverge the
moment a ⇧-click happens: the range must keep pivoting on the book the user
last plain-clicked, or repeated ⇧-clicks creep instead of re-ranging, which is
the classic wrong implementation of this gesture. A single "lead" field cannot
express both. A third field for "last toggled" buys nothing.

`ids` is a `Set`, replaced (never mutated) on each change. `BookCard` and
`Row` subscribe with `s.selection.ids.has(book.id)`, which returns a boolean —
zustand's `Object.is` check then re-renders only the cards whose membership
actually flipped, and virtualization means ~40 are mounted regardless.

**`selectedBookId` survives as a derived value** — `ids.size === 1 ? the one
id : null` — exported from the store as a selector. `BookDetail` and every
existing single-book call site keep working unchanged. This is what keeps the
change from touching the detail panel's 280 lines at all.

## 2. The gesture grammar lives in a pure module

`src/lib/selection.ts`, pure functions over `Selection` and an ordered
`string[]` of book ids:

| Gesture | Result |
|---|---|
| plain click | `ids = {id}`, `anchor = cursor = id` |
| ⌘ / ctrl click | toggle `id`; `anchor = cursor = id` |
| ⇧ click | `ids = range(anchor → id)`; `cursor = id`; `anchor` unchanged |
| ⌘⇧ click | `ids ∪ range(anchor → id)`; `cursor = id`; `anchor` unchanged |
| checkbox click | same as ⌘ click |
| ⇧ + arrow | `extend(cursor → next)`, same rules as ⇧ click |
| ⌘A | `ids = all loaded` |
| Escape | `ids = {}`, `anchor = cursor = null` |

With a null `anchor`, ⇧ degrades to a plain click. A range is computed over the
**current display order**, so a ⇧-click after a re-sort selects what the user
sees, not what was adjacent before. `⌘A` leaves `anchor` and `cursor` where
they are — it changes what is selected, not where the user is. Modifiers held
during a **checkbox** click are ignored: a checkbox always plainly toggles its
own row, because that is the one control whose meaning should never depend on
the keyboard.

Views call `select(book.id, event)` and never compute set math themselves.
This is the whole reason for approach C over spreading the logic across six
components: the grammar is subtle, and here it is testable with no React, no
Electron, and no DOM — `vitest.config.ts` already includes `src/**/*.test.ts`
(which is how `reader.store.test.ts` runs today).

The store action reads display order from `useLibraryStore.getState().books`,
the same cross-store `getState` read `BookCard` already uses to reach the
reader. Threading an id array through every call site was the alternative and
buys nothing.

## 3. Pruning is a safety rule

`library.store.load()` prunes the selection to the books it just loaded.

Select twelve books, then type in the search box: without pruning, those books
leave the screen but stay selected, and "Delete 12 books" then deletes books
the user cannot see. The cost is that narrowing a filter drops the selection —
accepted, and worth a comment at the call site so it is not "fixed" later.

This also covers books deleted on another machine and picked up by a catalog
adoption, and books that vanish under a background `libraryChanged` reload.

Single-selection behaviour changes slightly and deliberately: today a
`selectedBookId` filtered out of view stays set, and the panel reappears when
the search is cleared. After this, it is dropped.

## 4. Selection panel

At `count >= 2`, `SelectionPanel` renders in the detail slot and `BookDetail`
renders null. Both are mounted in `App.tsx`, mutually exclusive by count.

It reuses `BookDetail`'s shell — `w-[360px] shrink-0 … border-l` — so the
library's available width is identical in both modes. This matters
mechanically, not just visually: `GridView` derives its column count and row
height from container width, and a panel that changed width between modes
would re-flow the grid on every selection size change.

Contents: the count ("12 books selected"), the first ~5 titles with "+7 more",
then the actions — **Send to {device}**, **Refresh metadata**, and a
danger-styled **Delete**, separated from the other two — plus Clear.

Ordering is safety, not taste: the destructive action sits apart from the two
recoverable ones, and Delete is the only one styled as danger.

Every action is gated on the NAS being online, exactly as the detail panel's
equivalents already are. (Reading is the documented exception to that rule,
and none of these three is a read.) Send is shown only when a device is
connected, and its label carries the real device name, matching the detail
panel's existing "Send to {device}" button.

Per-book actions that have no group meaning — Read, Open in Preview, Show in
Finder, Edit metadata — are absent, not disabled. The one group-meaningful
action still missing is bulk metadata edit, which is the deferred backlog item.

## 5. ListView checkbox column

A new entry in the `COLUMNS` array (not a `<th>` bolted on beside it) so
`Spacer`'s `colSpan={COLUMNS.length}` stays correct by construction.

**The 37px row pitch is load-bearing** and this is the most likely regression
in the whole design. `ROW_HEIGHT` is assumed, not measured, so a checkbox that
grows a row by 2px produces scroll drift rather than a build error. The box is
`h-3.5 w-3.5` inside a `flex h-5 items-center` **block-level** child, matching
the rule every other cell in that table already follows.

The header cell holds a select-all box: checked when every loaded book is
selected, indeterminate when some are. It toggles over the **currently loaded
set** — that is, the active search and filters — which is the only meaning of
"all" that matches what is on screen. Cell clicks call `stopPropagation` so
they do not also fire the row's `onClick` and collapse the selection.

## 6. GridView

`BookCard`'s `onClick` passes the event through to `select`. Multi-selected
cards take the existing `ring-2 ring-gold-400` — no new selected state to
design.

The hover trash button stays single-book, always. A per-book affordance that
sometimes means "this book" and sometimes means "these twelve" is the kind of
ambiguity that costs someone a library. The same rule governs the context menu
below.

## 7. Context menu

- Right-click a book **inside** a 2+ selection → the menu is selection-scoped:
  a "12 books selected" header, "Delete 12 books…", "Clear selection". The
  single-book items are hidden rather than silently applying to one book.
- Right-click a book **outside** the selection → the selection is replaced by
  that book, then the normal single-book menu opens. This is Finder's rule and
  the one users already have in their fingers.

## 8. Keyboard

`useBookNavigation` gains ⇧+arrow handling. Note that `shiftKey` is *not* in
that hook's current modifier bail-out (`metaKey || ctrlKey || altKey`), so
⇧+arrow today silently behaves as a plain arrow — this is a change in
behaviour, not an addition to dead keys.

Escape clears the whole selection, as it clears the single selection today.

**⌘A carries a real unknown.** `menu.ts:58` registers `{ role: 'selectAll' }`
in the Edit submenu, so the native menu owns that accelerator. Plan:

1. Replace the role with a custom `Select All` item that broadcasts a new
   `select-all` `MenuCommand` (the same pattern as Settings and the view
   toggles, per the standing rule that menu items never act).
2. `useMenuCommands` routes by focus: a text field (reuse
   `isTypingTarget` from `useBookNavigation`) gets `select()` so ⌘A keeps
   selecting text in `BookEditor`; anything else selects all books.
3. **Verify this live** with the `verify` skill rather than assuming. If the
   accelerator behaves badly, ⌘A stays text-only and the header checkbox is
   the select-all affordance. This is a documented fallback, not a blocker.

## 9. Bulk delete is one batched operation, not a loop

This is the load-bearing main-process decision.

`book-delete.deleteBook` calls `librarySync.removeBookFromCatalog(id)`, and
each of those enqueues a **full `catalog.json` rewrite**. A renderer loop over
twelve books therefore means twelve whole-library rewrites (~10MB each, over
SMB) and twelve `libraryChanged` broadcasts, each triggering a full library
reload in the renderer. At a hundred books it is unusable.

`library-sync.ts:69` already provides the right primitive, with the doc comment
*"One batched write from the local cache — call at the end of bulk
operations."*

New `deleteBooks(ids: string[])` in `services/book-delete.ts`:

- `nas.assertOnline()` **once**
- per book: resolve via `db.getBook`, `fs.rm` the folder, `db.deleteBook` —
  and **no per-book catalog call**
- one `librarySync.writeFullCatalog()` at the end, only if at least one delete
  succeeded
- one `broadcast('libraryChanged')`
- returns `{ deleted: number; failed: { id: string; title: string; error: string }[] }`

**A single failure must not abort the rest.** One unreadable folder on a
flaky share should not leave eleven other books half-deleted and the catalog
unwritten; the loop continues and the dialog reports the partial result.

`deleteBook(id)` is left exactly as it is. For one book its targeted catalog
edit is cheaper than a full rewrite, and leaving it untouched means the single
delete path carries no regression risk from this work.

Surface: `library:deleteBooks` in `ipc/library.ts` (a thin wrapper, per the
handlers-contain-no-logic rule), `deleteBooks` in `api.types.ts` and
`preload/index.ts`.

## 10. Dialogs

`DeleteBookDialog` is untouched and keeps the per-format picker for one book.
A separate `DeleteSelectionDialog` handles 2+: count, a sample of titles, the
offline guard, busy state, and a partial-failure report.

They are not merged. The format picker is meaningless across a mixed
selection — "delete the epub of all twelve" is not a thing anyone wants — so a
merged dialog would be one component with two disjoint modes and a
conditional body. `ui.store` gains `deletingSelection: boolean` alongside the
existing `deletingBookId`.

Whole books only, and the confirmation says so.

On success the selection is cleared before the dialog closes — books that no
longer exist must not stay selected, and leaving that to `load()`'s prune
would depend on broadcast timing. Books that **failed** to delete are kept
selected, so the reported failure is also the retry.

## 11. Bulk send to device needs no main-process work

Measured rather than assumed: `transferQueue.sendToDevice(bookId, deviceId)`
(`transfer-queue.ts:31`) is **synchronous** — it returns a `TransferJob` after
enqueueing, and the queue is already serial with `transferProgress` events
driving the existing `TransferQueue` UI. Enqueueing costs no NAS I/O.

So the renderer loops the existing IPC, in a new
`device.store.sendBooksToDevice(ids, deviceId)` that merges the returned jobs
into `transfers` the same way the single-book action does. No new IPC, no new
service, no new progress UI — `StatusBar` already renders "Sending N to
device…" off the same `transfers` map, and will simply count higher.

Two rules:

- **Books already on the device are skipped**, using the presence map the
  device store already maintains, and the button label reflects the sendable
  count ("Send 9 to Kindle" out of a selection of twelve). Presence is derived
  from a scan of the device, so this is the same source of truth the card
  badge and the detail panel's "On {device}" state use. If every selected book
  is already there, the button is disabled and says so.
- **The loop is fire-and-forget per book but sequential in the queue.** One
  book that fails to convert or copy is logged to `device_history` with its
  error, exactly as today; it does not stop the other eleven, because the
  queue's existing per-job error handling already owns that.

Conversions triggered by a send do write `metadata.json` and upsert the
catalog per book, because a cached azw3 is a new format on that book. That is
unchanged single-book behaviour and is not batched here: an `ebook-convert`
run takes ~30 seconds, so one catalog write per conversion is nothing like the
per-book cost that shapes the delete and hydrate designs.

## 12. Bulk re-hydrate is a real job

The opposite situation from send. `metadata:rehydrateBook` is already
fire-and-forget (`void importer.hydrate(...)`), and each `hydrate` call does
its own `writeMetadataJson`, `librarySync.upsertCatalog([updated])` and
`broadcast('libraryChanged')` (`importer.ts:284–295`). Looping it in the
renderer over fifty books would mean fifty whole-catalog rewrites over SMB,
fifty full library reloads in the renderer, and fifty *concurrent* sidecar
hydrations against rate-limited APIs — the sidecar dispatches on a thread
pool, so nothing there serialises them.

New service `electron/main/services/bulk-hydrate.ts` (business logic in
services, never in a handler):

- `assertOnline()` once; refuse to start if a job is already running — one at
  a time, reported as a clear error rather than silently interleaved
- **sequential**: `await importer.hydrate(...)` per book, which is what keeps
  the API request rate at roughly the single-book rate the pipeline was built
  and rate-limited for
- broadcasts `bulkHydrateProgress` `{ completed, total, failed, running }`
  after each book
- checks a cancel flag between books, and stops early if `nas.isOnline()` goes
  false — every remaining write would fail anyway, and reporting a stop is
  better than reporting fifty failures
- on finish (or cancel, or NAS loss): one `librarySync.writeFullCatalog()`,
  one `broadcast('libraryChanged')`, one final progress event with
  `running: false`
- a book with no hydratable file is **skipped and counted**, not thrown. The
  existing single-book handler looks for `.epub`/`.mobi`/`.azw3` only, so
  PDF-only books have nothing to hydrate from; that file-finding logic is
  extracted into one helper both call sites use, so they cannot drift.

`importer.hydrate` gains an options parameter `{ batched?: boolean }`,
defaulting false so the import path is byte-for-byte unchanged. When batched
it skips its own `upsertCatalog` and its own `libraryChanged` broadcast — the
job owns both. It still writes `metadata.json` per book: that file is the
canonical store and is small and local to the book's own folder, which is
exactly what the catalog is not. `conflictQueueUpdated` still fires per book,
since it broadcasts a count and does no I/O.

**Cancellation stops the loop, not the book in flight.** A sidecar call cannot
be aborted cleanly mid-request, so the current book finishes and is counted;
everything after it is dropped. The button says "Cancel", and the honest
behaviour is that it stops within one book.

Surface: `metadata:rehydrateBooks(ids)` and `metadata:cancelRehydrate()` in
`ipc/metadata.ts` (thin wrappers), matching entries in `api.types.ts` and the
preload, and a `bulkHydrateProgress` entry in `EVENT_CHANNELS`
(`event:bulk-hydrate-progress`) alongside the existing progress channels.

Progress surfaces in `StatusBar`, which already carries transient job state in
this exact shape ("Importing 3…", "Sending 2 to device…"): a
"Refreshing metadata 12/40…" row with a Cancel control beside it. It lives
there rather than in the selection panel because the job outlives the
selection — clearing the selection, or letting a background reload prune it,
must never strand a running job with no way to stop it.

## 13. Testing

**TDD, tests first.**

`src/lib/selection.test.ts` — the grammar, with no React:

- each modifier combination against a known order
- anchor stability: two successive ⇧-clicks re-range from one pivot rather
  than creeping
- a range computed after a re-sort follows display order
- ⌘-click removing the last selected book
- ⇧-click with a null anchor degrades to a plain click
- range endpoints in either direction, and at the first/last book
- `prune` drops missing ids and nulls an `anchor`/`cursor` that no longer exist
- `selectAll` / `clear`

`electron/main/services/book-delete.test.ts` — extend the existing suite,
which already builds a real library root and flushes `librarySync`:

- a batch of N deletes writes `catalog.json` **once** (the point of the change)
- one failing book leaves the rest deleted and is reported in `failed`
- unknown ids are reported, not thrown
- an empty selection is a no-op that writes nothing

`electron/main/services/bulk-hydrate.test.ts` — new, with the sidecar stubbed:

- books are hydrated **sequentially**, not concurrently (the rate-limit
  guarantee, asserted by overlapping call timestamps)
- `catalog.json` is written **once** for the whole job, not per book
- cancelling stops the loop, counts the in-flight book, and still writes the
  catalog once
- a book with no hydratable file (PDF-only) is skipped and counted, not thrown
- NAS going offline mid-job stops it and reports
- starting a second job while one runs is refused

Send-to-device gets no new main-process test, because it adds no
main-process code — the loop is a store method over an IPC call already
covered by the transfer queue's own behaviour. Its verification is live.

Live verification with the `verify` skill: ⌘-click, ⇧-click, checkbox and
header select-all, ⌘A interception, bulk delete of several books, a bulk send
that skips books already on the device, a bulk re-hydrate with cancel, and
**`scrollHeight` unchanged in the list view** — the row-height regression
this design most risks.

`npm run typecheck` and `npm run lint` stay clean.

## Files

New: `src/lib/selection.ts`, `src/lib/selection.test.ts`,
`src/components/library/SelectionPanel.tsx`,
`src/components/library/DeleteSelectionDialog.tsx`,
`electron/main/services/bulk-hydrate.ts`,
`electron/main/services/bulk-hydrate.test.ts`

Changed: `src/stores/ui.store.ts`, `src/stores/library.store.ts`,
`src/stores/device.store.ts`, `src/components/library/GridView.tsx`,
`ListView.tsx`, `BookCard.tsx`, `BookDetail.tsx`, `BookContextMenu.tsx`,
`src/components/layout/StatusBar.tsx`, `src/hooks/useBookNavigation.ts`,
`src/hooks/useMenuCommands.ts`, `src/App.tsx`, `src/types/api.types.ts`,
`electron/main/services/menu.ts`, `services/book-delete.ts`,
`services/importer.ts` (the `batched` option on `hydrate`),
`electron/main/ipc/library.ts`, `electron/main/ipc/metadata.ts`,
`electron/preload/index.ts`, `electron/main/services/book-delete.test.ts`

Docs: `CLAUDE.md` (a Selection section, and the `MusaeumAPI` surface),
`tasks.md` (this phase, plus the bulk-metadata-edit backlog item),
`CHANGELOG.md`

## Risks

1. **ListView row height.** Covered above; the reason `scrollHeight` is an
   explicit verification step.
2. **⌘A accelerator.** Unknown until measured; documented fallback.
3. **Selection pruning changes single-select behaviour** under a filter
   change. Deliberate, and commented at the call site.
4. **A partially failed bulk delete** leaves the library correct but the user
   informed of less than they asked for — which is the intended trade against
   an all-or-nothing transaction across N independent NAS folders.
5. **The `batched` option on `importer.hydrate`** is the one change in this
   design that touches the import path. It defaults to false and the import
   call site is not modified, but a mistake here is silent: a batched hydrate
   that forgot to write the catalog at the end would leave the other machine
   with stale records, which is the same failure mode the reading-position
   work had to fix. The "catalog written exactly once" test exists precisely
   to pin this down.
6. **A long bulk re-hydrate is minutes of API traffic.** It is sequential by
   design, and the Google Books key matters more here than anywhere else in
   the app — an unkeyed run of a few hundred books is the fastest way to meet
   a rate limit. Cancellation is the mitigation, and it stops within one book,
   not instantly.
