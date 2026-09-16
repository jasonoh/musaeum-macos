# Selection & keyboard navigation

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching selection state or keyboard handling.

---

## Selection & keyboard navigation

Selection lives in `ui.store`, not in either view, so it survives a grid↔list
switch — but scroll position doesn't, since each view mounts its own scroller.
`hooks/useBookNavigation.ts` closes that gap for both views: on mount it centres
the cursor book in the viewport, later moves only nudge it back into view, and
arrow keys walk the same geometry the virtualizer uses (`columns` = 1 for the
list; the list also passes its sticky header as `contentTop`/`stickyTop`).
Home/End, PageUp/Down, ⇧+arrows (extend the range), and Escape (clear selection)
are handled too. The handler is a window listener that bails when a modal,
context menu, or text field owns the keyboard — those close themselves on
Escape.

Selection is a `Selection` (`src/lib/selection.ts`): a `Set` of ids plus an
**anchor** (the range pivot, set by plain and ⌘ clicks) and a **cursor** (the
keyboard focus, moved by ⇧ clicks and ⇧ arrows). Two fields, because a single
"lead" cannot express both — repeated ⇧-clicks must re-range from one pivot
rather than creep. The grammar lives in that pure module and is unit-tested
there; views call `select(id, modifiersFrom(event))` and never do set math.
`selectedBookId` survives as a **derived** selector — the id when exactly one
book is selected, null otherwise — which is why the detail panel, the metadata
editor and the single-book delete dialog needed no changes.

`useLibrary` prunes the selection to the loaded books on every library change.
Without it, selecting twelve books and then searching leaves them selected but
invisible, and "Delete 12 books" would delete books the user cannot see. The
cost — narrowing a filter drops the selection — is deliberate.

**⌘A is a menu command, not a key listener.** The Edit menu's
`{ role: 'selectAll' }` owns that accelerator, so `menu.ts` replaces it with a
custom item and `useMenuCommands` routes by focus: an input or textarea gets
`select()`, anything else selects every loaded book.

Both views show membership the same way (gold ring on a card, gold row tint);
the list adds a **checkbox column** with a tri-state select-all header, whose
cell must keep a 20px line and a block-level child like every other cell — the
row pitch is still exactly `ROW_HEIGHT` (measured: 37px pitch, 36px on the
`<tr>` plus the collapsed border).

---
