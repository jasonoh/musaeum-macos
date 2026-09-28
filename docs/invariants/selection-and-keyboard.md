# Selection & keyboard navigation

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching selection state or keyboard handling.

---

## Selection & keyboard navigation

Selection lives in `ui.store`, not in either view, so it survives a grid↔list switch — but scroll position doesn't, since each view mounts its own scroller. `hooks/useBookNavigation.ts` closes that gap for both views: on mount it centres the cursor book in the viewport, later moves only nudge it back into view, and arrow keys walk the same geometry the virtualizer uses (`columns` = 1 for the list; the list also passes its sticky header as `contentTop`/`stickyTop`). Home/End, PageUp/Down, ⇧+arrows (extend the range), and Escape (clear selection) are handled too. The handler is a window listener that bails when a modal, context menu, or text field owns the keyboard — those close themselves on Escape.

Selection is a `Selection` (`src/lib/selection.ts`): a `Set` of ids plus an **anchor** (the range pivot, set by plain and ⌘ clicks) and a **cursor** (the keyboard focus, moved by ⇧ clicks and ⇧ arrows). Two fields, because a single "lead" cannot express both — repeated ⇧-clicks must re-range from one pivot rather than creep. The grammar lives in that pure module and is unit-tested there; views call `select(id, modifiersFrom(event))` and never do set math. `selectedBookId` survives as a **derived** selector — the id when exactly one book is selected, null otherwise — which is why the detail panel, the metadata editor and the single-book delete dialog needed no changes.

`useLibrary` prunes the selection to the loaded books on every library change. Without it, selecting twelve books and then searching leaves them selected but invisible, and "Delete 12 books" would delete books the user cannot see. The cost — narrowing a filter drops the selection — is deliberate.

**Inside a shelf that cost is paid on entry**, deliberately (bookshelves D7). A scoped read changes `books`, so the prune runs and a selection made in the library is dropped when a shelf opens: the books are still selected, still on screen behind a filter, and no longer visible once the scope narrows. Nothing new implements this — it falls out of the existing effect — which is exactly why it is written down here. The alternative, keeping a selection whose books the current view does not contain, is the state the prune exists to make impossible.

**⌘A is a menu command, not a key listener.** The Edit menu's `{ role: 'selectAll' }` owns that accelerator, so `menu.ts` replaces it with a custom item and `useMenuCommands` routes by focus: an input or textarea gets `select()`, anything else selects every loaded book.

Both views show membership the same way (gold ring on a card, gold row tint); the list adds a **checkbox column** with a tri-state select-all header, whose cell must keep a 20px line and a block-level child like every other cell — the row pitch is still exactly `ROW_HEIGHT` (measured: 37px pitch, 36px on the `<tr>` plus the collapsed border).

**A right-click opens the context menu and nothing else.** Its scope — the whole selection when the click landed inside one of several, the clicked book alone otherwise (`contextMenuScope` in `lib/selection.ts`) — is read from the click, and no caller selects for it. Until 2026-09-25 the click first made its book the selection (Finder's rule, through an `openContextMenuFor` action in `ui.store`), which also opened the **details panel beside the menu**: `BookDetail` renders from the derived single selection, so one gesture ran its own action and the left click's, and the panel's arrival re-flowed the grid's column count on the way (reported by the owner from the grid). The ring now stays where the user left it, and the menu still offers the bulk items when the click landed in a selection they apply to — the test for that is `contextMenuScope`, not `count >= 2`, because a right-click can no longer put a book into the selection. Both entry points (`BookCard`, `ListView`) and the menu's branch are held by `src/components/library/context-menu-wiring.test.ts`; what is painted is decided by a right-click over CDP.

**A drag carries the selection and changes nothing**, on the same rule. `dragScope` (`src/lib/book-drag.ts`) mirrors `contextMenuScope` — the whole selection when the dragged book is one of several, that book alone otherwise — and no caller moves the selection for a drag: it neither selects the book it starts from (Finder's rule again, rejected for the reason the right-click was) nor clears what was selected. The sources and the payload rule are held by `src/components/library/book-drag-wiring.test.ts` and `docs/invariants/shelves.md`; what is painted is decided by a driven drag over CDP.

---
