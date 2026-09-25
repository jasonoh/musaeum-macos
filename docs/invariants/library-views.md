# Library views, sorting & virtualization

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching `GridView`, `ListView`, `BookCard`, sort SQL, or any row-geometry constant.

---

## Sort keys

`books.sort_title` / `books.author_sort` drive the title and author sorts (`COALESCE(sort_title, title)`, `COALESCE(author_sort, author)`), so a book that arrives without them sorts under the wrong letter — "Seth Dickinson" under S, invisible among the D's. Only Calibre migration and some EPUBs supply them, so every other path derives them with `sortableTitle()` / `sortableAuthor()` from `book.types.ts` (shared, so main and renderer agree): import, `applyHydration`, `metadataJsonToBook`, and **catalog reads**. The catalog one is load-bearing — adoption replaces the local cache wholesale, so a catalog lacking sort keys would undo any backfill on every connect. Migration 002 backfills existing rows by calling the same two functions, registered on the connection as `musaeum_sort_title` / `musaeum_author_sort` (see `registerFunctions` in `db.ts`) rather than reimplementing them in SQL. **Patches derive too:** `db.updateBook` re-derives either key whenever a patch changes `title`/`author` without naming the key itself (so the editor's custom sort title still wins). The conflict queue depends on this — before 2026-09-24 a resolved title conflict kept its old key for good, because catalog adoption only fills a *missing* key, never a stale one.

---

## Sorting & Search

One `BookSort` in the library store drives every list: the toolbar dropdown and the clickable list-view column headers both write to it, so they can never disagree. Sort SQL lives in `db.SORT_SQL` — each field maps to an **array** of expressions and the direction is applied to every one, so descending `series` fully reverses the ordering instead of only flipping the index within a series. Entries are parameterised by table prefix because the FTS join exposes `books_fts.title`/`author` too, and an unqualified reference is ambiguous.

List-view headers: click to sort, click the active column again to flip. First-click direction comes from `defaultSortDirection()` — ascending for text, descending for `date_added`/`rating`, which is what "newest"/"best" means. Formats has no sensible ordering and is deliberately not sortable. Labels for every field/direction pair come from `sortLabel()` in `book.types.ts`, shared so the dropdown can name a combination a header produced (it appends the current sort when it isn't one of its curated shortcuts).

`searchBooks(query, sort?)` orders matches by the sort when given, falling back to FTS relevance `rank` when omitted. The renderer always passes the active sort, so the sort controls stay live during a search — the trade-off is that relevance rank no longer decides display order there, only which books match.

---

## Card format chip

`BookCard` labels every cover with the book's **primary format** — the one the reader would open — plus a count of the rest (`EPUB +1`), the full list being the chip's tooltip. It sits in the bottom-left of the cover, the one corner no other badge owns (top-left device, top-right read dot, bottom-right delete on hover) and shares that corner with the re-fetch spinner as a flex row rather than stacking on it, so neither element has to move.

`primaryFormat` / `orderedFormats` in `book.types.ts` own the preference order (epub → azw3 → mobi → pdf) and exist because **nothing may read `formats[0]` directly**: the array holds whatever order the writing source left, and the real library stores `["epub","mobi"]` and `["mobi","epub"]` in nearly equal numbers. PDF sorts last but is never dropped — a PDF-only book is the case most worth seeing from across the grid, since it is never converted and has no in-app reader.

The chip is fixed at 16px tall and absolutely positioned over the cover, so it costs the row math below nothing; making it content-sized would put card height back in the DOM.

---

## Rendering (virtualized views)

Both library views render only the rows overlapping the viewport. `hooks/useVirtualRows.ts` provides the two pieces: `useScrollMetrics` (a callback ref + scroll listener + `ResizeObserver` reporting `scrollTop` / `viewport` / `width`) and the pure `rowWindow()`, which returns `{start, end, padTop, padBottom}`. Views render a top spacer, the slice, and a bottom spacer — no absolute positioning, so the grid stays a CSS grid and the list stays a real `<table>` (spacers are `<tr>`s with a `colSpan` cell). react-window was rejected for exactly that reason.

**Row height is computed, not measured**, so it must stay uniform:
- `GridView` derives the column count the way `auto-fill`/`minmax` would, then card width → row height, from constants that mirror its Tailwind classes. `BookCard`'s meta block is therefore fixed-height (`CARD_META_HEIGHT` / `CARD_META_MARGIN`, exported for that math) rather than content-sized.
- `ListView` pins `ROW_HEIGHT` (37 = 16px padding + a 20px line + the 1px collapsed border, which sits *outside* the height set on the `<tr>`) and offsets `scrollTop` by the sticky `<thead>`. Every cell needs explicit leading and a **block-level** child — an inline child picks up the table's own line strut and silently grows the row (this is what the rating em-dash fallback did).

A style change that alters real row height without updating these constants shows up as scroll drift, not a build error.

**The grid anchors on a book, not a pixel** (`useAnchoredScroll` in `useVirtualRows.ts`). Column count and row height are functions of container width, so the same `scrollTop` addresses different books after the detail panel opens or closes — measured: deleting a book with the panel open moved the viewport from books 105–126 to 148–168. The hook records the top-most visible book on every scroll and restores that book to the top when the geometry changes. `useBookNavigation`'s ensure-visible pass is a plain effect and so runs *after* this layout effect, letting the selection have the final say; keep that order (both hooks are called from `GridView`, anchored scroll last).

**Both scrollers must carry `.no-scroll-anchor`** (`overflow-anchor: none`, defined in `index.css`). Spacer virtualization resizes the content *above* the viewport, and Chrome's scroll anchoring answers by adjusting `scrollTop` to hold its anchor node still — which feeds back into the next window, moving the spacer again. Measured in the live app: deleting a book with the detail panel open (panel closes → grid gets 360px wider → different column count and row height at a non-zero `scrollTop`) ran the grid from 9000px to the bottom of the list in ~500ms. `rowWindow` also clamps `scrollTop` to the real maximum, so the frame where metrics still describe the old geometry shows the last rows instead of an empty window under a full-height spacer.

---
