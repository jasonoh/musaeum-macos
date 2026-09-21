# The in-app reader & reading position

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching the reader, foliate-js, book bytes, or reading position persistence.

---

## Reading in the app

`components/reader/ReaderView.tsx` over a **vendored** foliate-js (`vendor/foliate-js/`). EPUB, MOBI and AZW3; PDF is a later phase and falls through to `files.openBookFile` today, as does anything the engine rejects, so every entry point does something for every book. The entry points — double-click in either view, the detail panel's Read button, the context menu — are deliberately **not** gated on the NAS being online, unlike every sibling action in that row: reading is not a write, and the reader's error state (which offers "Open externally") explains a failure that a disabled button only hides.

**The engine is vendored, and the npm package is a trap.** Upstream publishes nothing to the registry; the `foliate-js` package there is a stale third-party republish. Provenance is recorded in `vendor/foliate-js/VENDORED.md`, and the tree is never edited — every divergence lives in our code or in `src/types/foliate-js.d.ts`.

Four places the engine's real behaviour contradicted the design and the type declarations, each found only by running it:

- `view.open()` needs a **`File`**, not a `Blob` — its format sniffing reads `file.name`, so every book failed until the fetched bytes were wrapped
- `open()` alone renders nothing; a book with no saved position needs an explicit `renderer.next()` to paint its first page
- `goTo()` returns `undefined` rather than rejecting, so a `.catch()` fallback around it is dead code — the percent fallback has to be reached another way
- page-turn keys must **also** be bound inside each section document: the book's iframe takes focus on the first click and the window listener stops hearing anything

`vendor/foliate-js/pdf.js` is **excluded from the renderer bundle** (`external` in `electron.vite.config.ts`). Vite's asset-import-meta-url plugin rewrites foliate's dynamic asset URL into a glob it then rejects, aborting the build; excluding it is safe because `readableFormat` never returns pdf, so the module is unreachable. A PDF phase that renders through foliate's own pdf.js has to revisit that line.

CSP `style-src` includes **`blob:`** because an EPUB's own stylesheets arrive as blob URLs — without it books render with none of their typography. `script-src` stays `'self'`, so book content never executes, and no directive permits a remote host, so remote `@import`, backgrounds and fonts are still refused.

The reader sits at **`z-[45]`**: above the library chrome (ImportOverlay's drop overlay is `z-40`) and below every modal, dialog and context menu (`z-50`). It shared `z-50` with them at first and painted *through* an open Settings panel — observed on screen, not theorised. Correct painting must not depend on mount order in `App.tsx`. Its keyboard handler bails for whatever is on top of it, via the same `isTypingTarget` guard `useBookNavigation` uses.

**Painting above the chrome is not the same as being free of it, and the difference ate every mouse click in this header for five weeks.** Every chrome strip here declares `-webkit-app-region: drag` so the window can be moved by its own furniture, and **draggable regions ignore pointer events** — the browser process collects them from the whole document, and an overlay does *not* subtract the regions of the chrome it covers (Electron, *Custom Window Interactions*: "a button element that overlaps a draggable region will not emit mouse clicks or mouse enter/exit events within that overlapping area… if you're only setting a custom title bar as draggable, you also need to make all buttons in title bar non-draggable"). The library's sidebar strip and toolbar both span the top 52px of the window and stay mounted behind the reader, so the reader's close, contents, find, ask and typography controls sat inside a draggable rectangle: **no hover, no click — while Escape and the arrow keys worked perfectly**, `element.click()` opened every panel, and `document.elementFromPoint` at each button returned the button itself. The owner reported it 2026-09-20 as "none of the controls are activated — they're unclickable", and every automated check this repo had was blind to it, because synthetic clicks never pass through the region check. The fix is the documented pairing, in both directions: the header declares `app-drag` itself (the strip must still move the window — until then that drag came only by accident, borrowing the library's region underneath) and each control declares `app-no-drag`. `src/components/reader/drag-regions.test.ts` holds it with a mutation-killed walk. Every *other* control in that band — Add Books, the search box, Sort, grid/list — had been marked `app-no-drag` since the first commit, and a band audit over CDP (every interactive element in the top band, requiring a `no-drag` self-or-ancestor) reports zero exposed with the reader, the Settings modal, the typography popover and the ask panel each open. Two residuals: the reader's own drag region exists only because it declares one (a boolean to check whenever a new overlay grows a titlebar), and a real-mouse confirmation is not automatable on this machine — assistive access is refused, so the standing instrument is the band audit plus a human click.

Book bytes reach the renderer over **`musaeum://book/{bookId}/{format}`**, resolved by `services/book-bytes.ts` — **by extension**, like every other file lookup, so a book renamed after import still opens. The path rules live in that service rather than in the protocol handler so they can be tested without Electron. They realpath **both** the library root and the candidate before comparing: resolving only one side 404s every book under a symlinked root, which on macOS is the common case (`/tmp` is a symlink to `/private/tmp`, which is where every test builds its library).

Typography lives in `stores/reader.store.ts`, persisted per machine like the other remembered UI state and re-validated on read (`sanitizePrefs`) rather than trusted: typeface, size, line height, page theme, and a control labelled **Spacing**. It is not called Margin because foliate spends the value on vertical inset and column gutter — the left text edge does not move — and a label that promises what the control doesn't do is worse than a vaguer one. The underlying field is still `prefs.margin`; genuine side margins need foliate's `max-column-width`/`gap` attributes and are a follow-up in tasks.md.

**The page theme is three options and the default follows the app's theme** (`'auto' | 'ink' | 'paper'`, `auto` by default since theming slice 5). `auto` is not a third palette: it resolves the app's derived values to the page — `ink-900` / `parchment` / `parchment_dim` / `gold-400` — so the page and the frame around it are the same theme, and on the built-in default those four values *are* the `ink` row. `ink` and `paper` are the two authored rows the reader shipped with, kept because a stored preference has to keep meaning what it meant. The whole resolution and the stylesheet it feeds live in `src/lib/theme/reader-palette.ts`, pure and store-free (`resolveReaderPalette`, `readerPageCss`); `ReaderEngine` reads the theme store beside the reader store and hands it two values. Nothing may write a `var(--…)` into that stylesheet, and the alpha for `::selection` is composed in the module rather than pasted onto the colour at the rule — both are constraints from the vendored engine, recorded under *Searching in the book* below.

Two races in the vendored paginator are known and not ours to fix without editing vendor source: an unguarded `this.#view` inside a `requestAnimationFrame` in `setStyles`, and a ResizeObserver firing on a mid-navigation document. Both are non-fatal, and recorded here so they are recognised rather than re-diagnosed.

---

## Searching in the book

`view.search()` in the vendored engine **is** the feature: a public async generator over the book's own text that yields per-section progress, then a CFI and an excerpt per hit, and draws its own highlights. So there is no index, no schema, no sidecar call and **no NAS I/O at all** — `open()` already holds the whole file in memory, which is why search works offline and on a dropped share. The reference for what that generator actually yields is `src/types/foliate-js.d.ts` (read off the vendored commit), never upstream's docs.

The loop we own lives in `src/lib/reader-search.ts`, testable without a browser; `ReaderSearch.tsx` is layout only, and `reader.store.ts` holds the run as session state. Three rules are load-bearing:

- **The token guard, not an abort.** The generator has no `AbortController`; breaking the `for await` is what stops it. It matters because `search()` calls `clearSearch()` on entry — so a second run's highlights are the only ones on the page, and a superseded run still writing would show hits for a query that is no longer displayed. Every new run, panel close and reader close bumps a token first.
- **One side slot, three occupants** (D4 of the AI-panel spec): `ReaderToc`, `ReaderSearch` and `ReaderAsk` are mutually exclusive session flags. Opening any one closes the other two.
- **Nothing about a search is persisted** — no query, no results, no active hit. `persistedReaderState()` in the store is the single thing that reaches storage, and it carries typography only.

**The highlight colour is a resolved literal from the reader's derived palette** (`resolveReaderPalette(theme, tokens).search` in `src/lib/theme/reader-palette.ts`, the `search` role), never `var(--…)`: the overlayer lives in foliate-view's closed shadow root, and a custom property crossing that boundary is a bet this repo does not take. Theming slice 5 made that table derived and **derived `search` with it** — the role exists to be derived, and it is the derived link colour, exactly as both authored rows already had it. Measured in the running app on a hit-only fixture (no links in the book, so every coloured pixel on the page is an outline): a search under `builtin:solarized-light` (whose `gold-400` derives to a burnt orange) drew **1,784** px of `#cb4b16` and **zero** of the previous hardcoded amber `#d4a24e`; under the default theme the same run drew **1,783** px of `#d4a24e` and none of the orange. A hardcoded amber here is not a style choice, it is the bug this role was named to prevent.

**And the colour has to follow a change, not only a new run.** The vendor draws annotations per run and keeps the options it was handed (`view.js:545`'s `#searchDrawOptions`, re-applied on every section render), so without a rule the outlines keep the colour of the run that drew them: measured, switching the app theme with five hits up left **1,780** orange px orange on a page that had gone dark. So `ReaderSearch` watches the *resolved colour* and re-runs its own query when it moves — safe because `search()` clears its own annotations on entry and the run token unwinds whatever this supersedes, and cheap because the search is in memory over the book that is already open. Measured after: the same switch leaves **1,764** amber px on the dark page. Anything added to that panel which reads the palette has the same obligation: a colour resolved once per run is a colour that will disagree with the page after the next theme change.

**Keyboard.** ⌘F is a menu command (`'reader-find'`, Edit ▸ Find in Book) routed through `useMenuCommands` to `toggleSearch()`, and it is a **no-op with no book open**. It toggles rather than opens, so the key that opened the panel closes it. Escape steps back out one layer at a time — results, then the panel, then the book — and `ReaderView`'s window handler intercepts **Escape only** while the panel is open: the panel already owns the keys while focus is inside it (its own `stopPropagation`), and swallowing everything else there killed page turns for as long as the panel stood, which was measured rather than reasoned.

---

## Reading position

**Tiered, because the three stores cost wildly different amounts** (`services/reading-state.ts`, which owns the whole policy):

| trigger | SQLite | metadata.json | catalog.json |
|---|---|---|---|
| page turn (debounced 2s) | yes | if >30s since last | no |
| reader close, app quit | yes | yes | yes |

`catalog.json` is a whole-library rewrite, so piggybacking it on the 30s throttle would push ~10MB over SMB every half minute of reading. Position is therefore machine-local between sessions and syncs at session boundaries, which is what the one-machine-at-a-time model already assumes.

`position` is **opaque** — an EPUB CFI, whatever mobi.js yields, a page number for a future PDF engine — and `percent` is the portable fallback for when a position no longer resolves. That is what lets one schema serve every engine.

`read_status` **only ever advances by itself** (`unread → reading` on the first save, `reading → read` at ≥98%, never back) — the automatic path never demotes a book, which is what keeps it from fighting a manual override. A manual change may move it either way, and it is a decision the app has to be able to *order*: see *A decision is reading state* below.

Offline is deliberately **not** an error here: NAS writes are skipped and the report is held in memory while SQLite keeps recording. Unlike `updateBook`, this path does not `assertOnline()` — interrupting someone mid-chapter because a share dropped is the wrong trade.

That tolerance is only safe because **adoption reconciles instead of overwriting**. Every `db.replaceAllBooks` in `library-sync.ts` first keeps local reading state that is strictly newer than the incoming record's, and pushes those books back to the catalog. Without it, quitting while the NAS was offline lost the session outright: the position existed only in SQLite, and the next launch's catalog adoption replaced the row wholesale. The same helper stops another machine's stale catalog from overwriting fresher local progress, which last-write-wins otherwise permits. **`rebuildCatalog` preserves too** — metadata.json is deliberately the trailing store for position, so letting a recovery walk win would turn "Rebuild Catalog" into a position-eraser.

**A decision is reading state, and it is ordered like one.** `read_status` is one of the two fields this subsystem calls reading state (`READING_FIELDS`), and `reading_updated_at` is that state's clock — so a status change the user makes from the detail panel moves the clock too (`reading-state.noteStatusChange`, gated on the value *actually* changing, the same guard `field-overrides.markFromPatch` uses). Without that the decision was invisible to adoption: measured on the real library, three books stood at Reading, two were un-marked to Unread, and after a restart all three were Reading again — SQLite **and** the canonical `metadata.json` held the user's Unread, the *derived* `catalog.json` still held the old Reading, and the reconcile kept the position from the catalog while silently taking the catalog's status with it. Two consequences are deliberate. `preserveLocalReadingState` carries **both** fields when the local record wins, and pushes both back to the catalog, because a local win is a win for the record rather than for one field of it. And the quit flush no longer re-derives a status from the report it replays: a parked report's status implication was applied when it first arrived (every report runs `nextReadStatus`, whatever its write tier), so recomputing it at quit applied a *stale* reading event to a status the user may have decided since — which is how a manual Unread came back Reading through all three stores. Known residue: the two halves share one clock, so a status decision made here can keep an *older* local position against the catalog's newer one (per-field clocks would need a column of their own); and opening a book in the reader still advances a manual Unread to Reading, which is the documented advance rule rather than a defect, but it is the same class and worth knowing about.

**Quitting flushes before the database closes** (`services/quit.ts`). `before-quit` fires *before* `will-quit` and used to call `closeDb()`, so the flush ran against a closed database and, on a synchronous handler, could not finish its write in any case. The handshake is now explicit: `preventDefault()` → await the flush → set a guard flag → `quit()` again → teardown. The flag is the whole trick — `quit()` re-fires `before-quit`, and without it the handler would `preventDefault` forever. It is bounded by a **3s timeout**, because the flush writes over SMB and a dead share must never wedge the app on exit; losing that write is recoverable (SQLite holds the position and the adoption reconcile brings it back), a hang is not.

Reading state rides in `metadata.json` and therefore through `catalog.json`, so `metadataJsonToBook` and `replaceAllBooks` must carry it — the same load-bearing propagation the sort keys need, and with the same failure mode if missed: silent erasure on the next connect.

---

## Apple Books Export

`open -a Books {epub}` — right-click/detail-panel action. No deep integration.

---
