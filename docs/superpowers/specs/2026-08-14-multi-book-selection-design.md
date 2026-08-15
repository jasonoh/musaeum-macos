# Design: Multi-book selection and bulk delete

**Date:** 2026-08-14
**Status:** Approved (brainstorming session with Jason)
**Scope:** Selection model for both library views, plus one bulk action —
delete. Bulk metadata edit is explicitly deferred to the backlog.

Today the library can hold exactly one book at a time:
`ui.store.selectedBookId: string | null`, read directly by `BookCard`,
`ListView`'s `Row`, `BookDetail`, `BookContextMenu`, `DeleteBookDialog` and
`useBookNavigation`. Every action is therefore single-book, and deleting
twelve books is twelve trips through the same dialog.

This replaces that single id with a real selection, adds ⌘-click / ⇧-click in
both views and a checkbox column in the list, and gives the selection one
action: delete.

## What is in scope

- ⌘-click (toggle) and ⇧-click (range) in **both** views
- A checkbox column in `ListView`, always visible, with a select-all header box
- A selection panel in the detail slot when 2+ books are selected
- Bulk delete: one confirmation, one batched main-process operation
- Keyboard: ⇧+arrows extend, Escape clears, ⌘A selects all (see the caveat)

## What is deliberately not in scope

- **Bulk metadata edit** (add tags / set series / set read status across a
  selection). Wanted, and the largest piece of new UI in the family; it goes to
  `tasks.md` as backlog rather than into this phase.
- **Bulk send-to-device** and **bulk re-hydrate.** Both are cheap loops over
  existing services, but neither was asked for, and each carries its own
  progress-reporting question (a serial transfer queue; a rate-limited API).
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
a danger-styled Delete button, and Clear. Nothing else — per-book actions have
no meaning across a selection, and the ones that do are the deferred backlog.

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

## 11. Testing

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

Live verification with the `verify` skill: ⌘-click, ⇧-click, checkbox and
header select-all, ⌘A interception, bulk delete of several books, and
**`scrollHeight` unchanged in the list view** — the row-height regression
this design most risks.

`npm run typecheck` and `npm run lint` stay clean.

## Files

New: `src/lib/selection.ts`, `src/lib/selection.test.ts`,
`src/components/library/SelectionPanel.tsx`,
`src/components/library/DeleteSelectionDialog.tsx`

Changed: `src/stores/ui.store.ts`, `src/stores/library.store.ts`,
`src/components/library/GridView.tsx`, `ListView.tsx`, `BookCard.tsx`,
`BookDetail.tsx`, `BookContextMenu.tsx`, `src/hooks/useBookNavigation.ts`,
`src/hooks/useMenuCommands.ts`, `src/App.tsx`, `src/types/api.types.ts`,
`electron/main/services/menu.ts`, `services/book-delete.ts`,
`electron/main/ipc/library.ts`, `electron/preload/index.ts`,
`electron/main/services/book-delete.test.ts`

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
