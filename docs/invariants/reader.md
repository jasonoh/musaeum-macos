# The in-app reader & reading position

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching the reader, foliate-js, book bytes, or reading position persistence.

---

## Reading in the app

`components/reader/ReaderView.tsx` over a **vendored** foliate-js
(`vendor/foliate-js/`). EPUB, MOBI and AZW3; PDF is a later phase and falls
through to `files.openBookFile` today, as does anything the engine rejects, so
every entry point does something for every book. The entry points — double-click
in either view, the detail panel's Read button, the context menu — are
deliberately **not** gated on the NAS being online, unlike every sibling action
in that row: reading is not a write, and the reader's error state (which offers
"Open externally") explains a failure that a disabled button only hides.

**The engine is vendored, and the npm package is a trap.** Upstream publishes
nothing to the registry; the `foliate-js` package there is a stale third-party
republish. Provenance is recorded in `vendor/foliate-js/VENDORED.md`, and the
tree is never edited — every divergence lives in our code or in
`src/types/foliate-js.d.ts`.

Four places the engine's real behaviour contradicted the design and the type
declarations, each found only by running it:

- `view.open()` needs a **`File`**, not a `Blob` — its format sniffing reads
  `file.name`, so every book failed until the fetched bytes were wrapped
- `open()` alone renders nothing; a book with no saved position needs an
  explicit `renderer.next()` to paint its first page
- `goTo()` returns `undefined` rather than rejecting, so a `.catch()` fallback
  around it is dead code — the percent fallback has to be reached another way
- page-turn keys must **also** be bound inside each section document: the
  book's iframe takes focus on the first click and the window listener stops
  hearing anything

`vendor/foliate-js/pdf.js` is **excluded from the renderer bundle** (`external`
in `electron.vite.config.ts`). Vite's asset-import-meta-url plugin rewrites
foliate's dynamic asset URL into a glob it then rejects, aborting the build;
excluding it is safe because `readableFormat` never returns pdf, so the module
is unreachable. A PDF phase that renders through foliate's own pdf.js has to
revisit that line.

CSP `style-src` includes **`blob:`** because an EPUB's own stylesheets arrive as
blob URLs — without it books render with none of their typography. `script-src`
stays `'self'`, so book content never executes, and no directive permits a
remote host, so remote `@import`, backgrounds and fonts are still refused.

The reader sits at **`z-[45]`**: above the library chrome (ImportOverlay's drop
overlay is `z-40`) and below every modal, dialog and context menu (`z-50`). It
shared `z-50` with them at first and painted *through* an open Settings panel —
observed on screen, not theorised. Correct painting must not depend on mount
order in `App.tsx`. Its keyboard handler bails for whatever is on top of it, via
the same `isTypingTarget` guard `useBookNavigation` uses.

Book bytes reach the renderer over **`musaeum://book/{bookId}/{format}`**,
resolved by `services/book-bytes.ts` — **by extension**, like every other file
lookup, so a book renamed after import still opens. The path rules live in that
service rather than in the protocol handler so they can be tested without
Electron. They realpath **both** the library root and the candidate before
comparing: resolving only one side 404s every book under a symlinked root, which
on macOS is the common case (`/tmp` is a symlink to `/private/tmp`, which is
where every test builds its library).

Typography lives in `stores/reader.store.ts`, persisted per machine like the
other remembered UI state and re-validated on read (`sanitizePrefs`) rather than
trusted: typeface, size, line height, page theme, and a control labelled
**Spacing**. It is not called Margin because foliate spends the value on vertical
inset and column gutter — the left text edge does not move — and a label that
promises what the control doesn't do is worse than a vaguer one. The underlying
field is still `prefs.margin`; genuine side margins need foliate's
`max-column-width`/`gap` attributes and are a follow-up in tasks.md.

Two races in the vendored paginator are known and not ours to fix without
editing vendor source: an unguarded `this.#view` inside a `requestAnimationFrame`
in `setStyles`, and a ResizeObserver firing on a mid-navigation document. Both
are non-fatal, and recorded here so they are recognised rather than re-diagnosed.

---

## Reading position

**Tiered, because the three stores cost wildly different amounts**
(`services/reading-state.ts`, which owns the whole policy):

| trigger | SQLite | metadata.json | catalog.json |
|---|---|---|---|
| page turn (debounced 2s) | yes | if >30s since last | no |
| reader close, app quit | yes | yes | yes |

`catalog.json` is a whole-library rewrite, so piggybacking it on the 30s
throttle would push ~10MB over SMB every half minute of reading. Position is
therefore machine-local between sessions and syncs at session boundaries, which
is what the one-machine-at-a-time model already assumes.

`position` is **opaque** — an EPUB CFI, whatever mobi.js yields, a page number
for a future PDF engine — and `percent` is the portable fallback for when a
position no longer resolves. That is what lets one schema serve every engine.

`read_status` **only ever advances** (`unread → reading` on the first save,
`reading → read` at ≥98%, never back), which is what makes a manual override
stick.

Offline is deliberately **not** an error here: NAS writes are skipped and the
report is held in memory while SQLite keeps recording. Unlike `updateBook`, this
path does not `assertOnline()` — interrupting someone mid-chapter because a
share dropped is the wrong trade.

That tolerance is only safe because **adoption reconciles instead of
overwriting**. Every `db.replaceAllBooks` in `library-sync.ts` first keeps local
reading state that is strictly newer than the incoming record's, and pushes
those books back to the catalog. Without it, quitting while the NAS was offline
lost the session outright: the position existed only in SQLite, and the next
launch's catalog adoption replaced the row wholesale. The same helper stops
another machine's stale catalog from overwriting fresher local progress, which
last-write-wins otherwise permits. **`rebuildCatalog` preserves too** —
metadata.json is deliberately the trailing store for position, so letting a
recovery walk win would turn "Rebuild Catalog" into a position-eraser.

**Quitting flushes before the database closes** (`services/quit.ts`).
`before-quit` fires *before* `will-quit` and used to call `closeDb()`, so the
flush ran against a closed database and, on a synchronous handler, could not
finish its write in any case. The handshake is now explicit: `preventDefault()`
→ await the flush → set a guard flag → `quit()` again → teardown. The flag is
the whole trick — `quit()` re-fires `before-quit`, and without it the handler
would `preventDefault` forever. It is bounded by a **3s timeout**, because the
flush writes over SMB and a dead share must never wedge the app on exit; losing
that write is recoverable (SQLite holds the position and the adoption reconcile
brings it back), a hang is not.

Reading state rides in `metadata.json` and therefore through `catalog.json`, so
`metadataJsonToBook` and `replaceAllBooks` must carry it — the same load-bearing
propagation the sort keys need, and with the same failure mode if missed: silent
erasure on the next connect.

---

## Apple Books Export

`open -a Books {epub}` — right-click/detail-panel action. No deep integration.

---
