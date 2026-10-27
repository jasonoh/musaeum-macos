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

One `BookSort` in the library store drives every list: the toolbar dropdown and the clickable list-view column headers both write to it, so they can never disagree. Sort SQL lives in `db.SORT_SQL` — each field maps to an **array** of expressions and the direction is applied to every one, so descending `series` fully reverses the ordering instead of only flipping the index within a series. Entries are parameterized by table prefix because the FTS join exposes `books_fts.title`/`author` too, and an unqualified reference is ambiguous.

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

**A drop target's highlight is a shadow** (`ring-*`), never a `border` or a padding change: the ring is painted, the border is laid out, and a border that appears under the cursor moves every row below it while the drag is in flight — a screenshot shows jitter, the build shows nothing.

**The grid anchors on a book, not a pixel** (`useAnchoredScroll` in `useVirtualRows.ts`). Column count and row height are functions of container width, so the same `scrollTop` addresses different books after the detail panel opens or closes — measured: deleting a book with the panel open moved the viewport from books 105–126 to 148–168. The hook records the top-most visible book on every scroll and restores that book to the top when the geometry changes. `useBookNavigation`'s ensure-visible pass is a plain effect and so runs *after* this layout effect, letting the selection have the final say; keep that order (both hooks are called from `GridView`, anchored scroll last).

**Both scrollers must carry `.no-scroll-anchor`** (`overflow-anchor: none`, defined in `index.css`). Spacer virtualization resizes the content *above* the viewport, and Chrome's scroll anchoring answers by adjusting `scrollTop` to hold its anchor node still — which feeds back into the next window, moving the spacer again. Measured in the live app: deleting a book with the detail panel open (panel closes → grid gets 360px wider → different column count and row height at a non-zero `scrollTop`) ran the grid from 9000px to the bottom of the list in ~500ms. `rowWindow` also clamps `scrollTop` to the real maximum, so the frame where metrics still describe the old geometry shows the last rows instead of an empty window under a full-height spacer.

**The grid glides when a side panel opens or closes** (`useGridFlip`, arithmetic in `lib/flip.ts`). The panel takes 360px, the column count changes and nearly every tile lands elsewhere at once, which made the clicked book impossible to follow. The layout itself is never animated — the virtualizer computes geometry from the container width, and a width that changed every frame would re-window every frame. The grid settles at its final layout in one step and each tile is animated with a transform (translate + uniform scale, top-left origin) from where it _was_; tiles the window did not render before fade in. Two things make it followable rather than merely animated, and four rules keep it correct — all measured against the live app, because every one of them looked fine in a build:

- **The clicked book is the fixed point.** `useAnchoredScroll` anchors on the selection's cursor, at the height it had in the viewport, before it falls back to the top-of-viewport book — so the clicked tile only slides sideways and everything else moves relative to it. Anchoring the top of the viewport instead sent tiles up to ~1000px. The effect must list `focusId` as a dependency: the click that opens the panel changes no other, and without it the height is never recorded before the layout changes. The id is kept after the selection clears, because closing the panel is when the selection has just gone.
- **Duration scales with the longest trip, with a symmetric ease** (`glideDuration`: 360ms for a nudge, up to 640ms for a tile that wraps across the grid, `cubic-bezier(0.4, 0, 0.2, 1)`). The panel's own 220ms `cubic-bezier(0.16, 1, 0.3, 1)` covers ~90% of the distance in its first quarter; reused here, tiles crossed 300–600px in under 60ms and could not be tracked.
- **Boxes are viewport-relative, not content-relative.** The anchor moves `scrollTop` when the columns change, so a tile's offset into the _content_ moves by whole rows while it stays under the reader's eye.
- **Nothing is recorded or played until the render matches the node** — `useGridFlip` takes `metrics.width` and `metrics.scrollTop` and waits while either differs from the node's own. The panel reaches the DOM one commit before the metrics catch up (cards stretched across the old column count), and the anchor moves `scrollTop` after the row window was chosen (part of the viewport is spacer). It must be declared after `useAnchoredScroll`.
- **The anchor tells the metrics before paint** (`onScrolled` → `useScrollMetrics().sync`). Waiting for the scroll event left the part-spacer frame on screen and swapped the window a commit later: 20 of 40 tiles unmounted mid-glide and their replacements popped in unanimated. A state update from a layout effect flushes before paint. `useScrollMetrics` likewise flushes its `ResizeObserver` measurement (`flushSync`), or a paint lands between the resize and the render.
- **The "before" baseline is never recorded during a glide.** A snapshot reads where tiles are _drawn_, and a glide in flight displaces them; the scroll the anchor just set fires a commit mid-glide, so recording it made the next glide start from a mid-flight frame (`translate(-85px, -273px)` where the truth was `(-654px, 0)`). The baseline is taken again when the glide ends, and a new glide cancels the cards' leftover animations before measuring.

It plays only on a panel *toggle* (`selection.ids.size > 0` flipping), so moving from one selected book to another — which shifts nothing — and a window drag-resize stay still. `prefers-reduced-motion` skips it. The list view has no glide: its rows keep their order and only their column widths change.

---

## The open shelf (bookshelves slice 2)

**The sort SQL already carried `shelf_added`** (slice 1, `orderClause`); slice 2 is what offers it. `SHELF_SORT_OPTIONS` in `Toolbar.tsx` is prepended to `SORT_OPTIONS` **only while a shelf is open**, where it is also first (D8's default inside a shelf) — at library level there is no shelf to have been added to, so the option is meaningless rather than merely unusual. The merge is `offered.some(...) ? offered : [...offered, sort]`, so a combination the header selected elsewhere (Author Z–A) is appended rather than snapping the select to a wrong option.

**The open shelf is part of the result-set identity.** `ResultSetIdentity` gains `shelfId: string | null` (`src/lib/resultSetIdentity.ts`), and both views pass `shelfId: s.activeShelfId`. This is the one member of the key that is *not* a normalization and that survives with a query active: unlike the facet filters, the scope reaches the search too (`load()` passes it to `searchBooks` as well as `getBooks`), so it is a change in both branches where the search branch's `filters: null` does not cover it. Without it, moving from *To Read* to *Sci-Fi* — same query, same filters, same sort — would leave `resultSetKey` unchanged and the reader's scroll anchor pointing into a different list.

**The empty pane has a fifth rung, and it sits below the storage gate.** `libraryViewState` returns, in order: `loading`, a query or filter that matched nothing (`no-matches`), `library-unavailable` when `storageConnected` is false, then `empty-shelf` if a scope is open and `empty-library` otherwise. The order is the whole content of the decision: an empty shelf is not an empty library, and the sentence it shows is a promise about a *write* ("drag books here"), so it takes the same gate the first-run pane takes. Returning `empty-shelf` before that gate was the alternative and is rejected for the reason the fourth case was added on 2026-09-24 — an instruction whose every affordance is refused is worse than the banner's sentence.

**What the empty-shelf pane cannot yet do, plainly:** D9's copy names two actions — drag, and *Add to Shelf* — and in slice 2 neither is reachable *from that pane*: drag arrives in slice 3, and *Add to Shelf* is a right-click on a card, of which an empty shelf has none. The sentence is rendered verbatim; the gap is recorded in `tasks.md` and in slice 2's plan rather than papered over.

## Filtering by author (the detail panel's names)

**Each name in the detail panel's author line is a button, and it applies `BookFilters.coAuthor`** (`library.store.ts` → `filterByAuthor`). The action replaces the query and every facet, leaves an open shelf (restoring `librarySort`, as `setActiveShelf(null)` does), and loads in the library's own sort — the result is "every book this person wrote", so a shelf scope or a stale query would quietly hide some. The grid and list cards do **not** link their author: `BookCard` is one button, and a link inside it needs the sibling-overlay treatment its delete control uses (nested buttons are invalid HTML). Not done, not rejected.

**`coAuthor` is not the Authors facet, and the two must stay apart.** The sidebar's `authors` is an exact match on the whole `author` column (and the REST API's `authors` parameter rides the same `bookWhere` branch, so its meaning is a wire contract). `coAuthor` matches one *name* against every name in the string: `splitAuthors` (`src/types/book.types.ts`) splits on `&`, `and`, `;`, and on commas only when a part holds three or more names — a single comma is an inverted name ("Pratchett, Terry"), the call `sortableAuthor` makes too. SQL reaches the same splitter through the registered function `musaeum_author_has`, so the names the panel renders as buttons and the rows the filter returns cannot disagree. A scan with a JS function over 7000 rows is milliseconds; if that ever shows in a profile, the fix is a name table, not a second splitter in SQL. Residual: "A, B & C" keeps "A, B" whole.

**The filter is visible and counted.** It is a member of `filterCount` (so an empty result reads `no-matches`, not `empty-library`) and the sidebar shows an "Author: Name" chip; the chip's × is `clearFilters`, so it clears any facet ticked beside it too. `coAuthor` is not exposed on the REST API.

