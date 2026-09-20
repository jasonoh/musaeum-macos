# Design: Native Reader (C1 — EPUB, MOBI, AZW3)

**Date:** 2026-08-13 **Status:** Approved (brainstorming session with Jason) **Supersedes:** Section C of `2026-07-14-pdf-multimachine-reader-design.md` **Scope:** C1 — the reader shell plus the foliate-js engine. PDF (C2) builds on the same shell and is deliberately out of scope here.

Sections A (PDF format support) and B (multi-machine catalog) shipped 2026-07-27 and 2026-07-18. This is the last unbuilt section of that design, re-specified against the codebase as it stands: virtualized views, a book context menu, keyboard navigation, derived sort keys, and a packaged app all landed after the original was written.

## Why now, and what changed since the original Section C

Measured against the live library (6,906 books):

| Formats | Books |
|---------|-------|
| Has an EPUB | ~4,850 |
| PDF-only | 1,737 |
| mobi/azw3-only | 149 |

Three decisions from the original section are revised:

1. **EPUB ships before PDF.** Two rendering engines in one build is a large surface for a first cut. C1 proves the shell — overlay, protocol route, reading-state persistence, TOC, typography, keyboard — against one engine. C2 drops pdf.js into a shell that already works. PDF-only books keep the existing "Open PDF" → Preview path until then, which is a genuinely usable escape hatch.
2. **mobi and azw3 are in scope.** foliate-js ships `mobi.js` and handles KF8/AZW3, and `view.js` sniffs the format, so those 149 mobi-only books cost approximately nothing to support. This retires the original's "convert to epub to read" affordance before it was ever built.
3. **Position writes do not piggyback on the catalog.** The original spec predates the measured cost of `catalog.json`: it is a whole-file rewrite of every book record over SMB. A 30-second throttle that upserted the catalog would rewrite ~10MB every 30 seconds of reading. See Persistence policy.

### Engine provenance (read before touching dependencies)

**Do not install `foliate-js` from npm.** Upstream (`github.com/johnfactotum/foliate-js`) states the library is not released on npm and recommends vendoring. The `foliate-js@1.0.1` package on the registry is a single-version republish by an unrelated maintainer, a year stale.

foliate-js is vendored as a **committed copy** at `vendor/foliate-js/`, with a `vendor/foliate-js/VENDORED.md` recording the upstream URL, the exact commit hash, the MIT license, and the npm warning above. A git submodule was considered and rejected: it adds a `--recurse-submodules` trap to every clone and packaging checkout, and a copy pins the exact reading engine in our own history. Updating is a manual re-copy, which for a dependency this stable is a feature rather than a cost.

It is plain ES modules with no build step, so electron-vite bundles it into `out/renderer` with no packaging change — `electron-builder.yml`'s `files` allowlist already covers `out/**`.

foliate-js reaches two libraries of its own: `@zip.js/zip.js` (BSD-3-Clause, actively maintained by its author — unlike the foliate-js listing, this is the real package) for container access, and `fflate` (MIT) to decompress zlib-compressed KF8 fonts. Whether the vendored copy carries them or expects them as imports is confirmed in the first implementation task; if they must be installed, they are ordinary npm dependencies and both are legitimately published.

---

## Architecture

Three layers, following existing conventions — no business logic in IPC handlers, all shared contracts in `src/types/`.

```
Main
├── index.ts          registerMusaeumProtocol — musaeum://book/{id}/{format}
├── ipc/reader.ts     one handler, a thin wrapper
└── services/reading-state.ts   all persistence and status policy

Renderer
├── stores/reader.store.ts      open book, engine status, TOC, prefs
├── components/reader/          ReaderView + chrome, TOC, prefs popover
└── vendor/foliate-js/          vendored engine

Shared
└── types/book.types.ts         ReadingState
```

The reader is a **full-window overlay in the existing window**, not a second `BrowserWindow`. It reads from the same stores the library uses, and a second window would need its own copy of that state plus its own IPC wiring.

---

## Serving book bytes

`registerCoverProtocol` in `electron/main/index.ts` becomes `registerMusaeumProtocol` and dispatches on `url.host`:

- `musaeum://cover/{bookId}/{thumb|full}` — unchanged
- `musaeum://book/{bookId}/{format}` — new

The book route resolves the file **by extension**, the same rule `file-access.ts` and `deleteFormats` already follow, never by canonical name: a book renamed after import must still open. It rejects a format outside the `BookFormat` union, rejects any resolved path escaping the book folder, and returns 404 rather than throwing when the book, the root, or the file is missing.

The renderer `fetch`es the URL, takes a `Blob`, and hands it to foliate-js. Whole-file load is correct for EPUB/MOBI at 1–5MB; PDF's range-request needs are a C2 question and do not constrain this route's shape.

### CSP

`index.html` is currently:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' musaeum: data:; connect-src 'self' ws:
```

Required additions: `connect-src` gains `musaeum:` (the fetch above); `img-src`, `font-src`, and `frame-src` gain `blob:`, for the resources foliate-js materializes out of the container.

**`script-src` stays `'self'`.** Book content is never executed — foliate-js does not support scripting, and upstream explicitly warns against running the library without a CSP over untrusted content. The exact minimal set is confirmed empirically in the first implementation task; widening beyond the list above is a decision, not a detail.

---

## Reading state

```jsonc
"reading_state": {
  "position": "<opaque engine string>",
  "percent": 0.42,
  "updated_at": "2026-08-13T10:30:00Z"
}
```

**`position` is opaque to Musaeum.** It is an EPUB CFI today, whatever `mobi.js` yields for KF8, and a page number in C2. `percent` is the portable fallback: when restoring `position` fails — a re-downloaded file, a different engine version, a format change — the reader seeks to `percent` instead. One schema survives all three engines because Musaeum never parses the string.

Migration `003_reading_state.sql` adds `reading_position TEXT`, `reading_percent REAL`, and `reading_updated_at TEXT` to `books`. None are FTS columns, so the existing sync triggers are unaffected.

**The load-bearing part is propagation, and it is the same lesson sort keys taught:** `metadataJsonToBook`, the catalog writer, and `replaceAllBooks` must all carry these three fields. Adoption replaces the local cache wholesale on every connect, so a catalog that drops reading state would silently erase progress each time the NAS reconnects.

---

## Persistence policy

The renderer reports progress and marks whether the report is final. **All throttling lives in `services/reading-state.ts`** — one place, testable without a browser.

| Trigger | SQLite | metadata.json | catalog.json |
|---------|--------|---------------|--------------|
| Page turn (debounced ~2s) | yes | only if >30s since the last write | no |
| Reader close, app quit | yes | yes | yes |

SQLite is in-process and free, so library views can show progress immediately. `metadata.json` is a ~2KB per-book write — cheap enough to run on a throttle, which is what makes a crash cost seconds of progress rather than a session. `catalog.json` is the whole-library rewrite and therefore fires only at session boundaries; cross-machine sync lands at session granularity, which matches the one-machine-at-a-time model the catalog already assumes.

A pending write is flushed on `will-quit`.

### read_status

Handled in the same service, and it **only ever advances**:

- `unread → reading` on the first progress save
- `reading → read` at `percent >= 0.98`
- never `read → reading`

That last rule is what makes a manual override stick: a book you marked read does not get demoted by opening it again.

### Offline

NAS writes are skipped and logged; SQLite still records position. This path deliberately does **not** call `nas.assertOnline()`. Every other write path should fail loudly, but interrupting someone mid-chapter because a share dropped is the wrong trade — the book is already in memory and reading continues fine.

---

## Reader UI

`ReaderView` mounts in `App.tsx` on `reader.store.bookId`, as a full-window overlay above the library.

- **Chrome:** close, book title, TOC toggle, typography popover, and a progress bar with percent.
- **TOC:** a side panel from `view.book.toc`; clicking an entry navigates and closes the panel.
- **Typography:** serif/sans, size, line height, margin, and two page themes — warm paper and dark-library ink, matching the app's own palette. Preferences are **per-machine**, persisted to `localStorage` under `musaeum.reader` alongside the existing `musaeum.ui` and `musaeum.library`. They are not per-book.
- **Layout:** paginated, single or double column by window width.

### Opening

Format preference: **epub → azw3 → mobi**. A book with none of those, or a file the engine fails to load, falls through to `files.openBookFile` on its first format — so PDFs open in Preview today and quietly stop falling through when C2 ships. No dead-end dialog, and every book responds to the same gesture.

Entry points: **double-click** a book in the grid or list (currently wired to nothing — `onDoubleClick` is dead code flagged in tasks.md), a **Read** button in the detail panel's action row, and a **Read** item in `BookContextMenu`.

**Enter-to-open is deliberately not included.** The tasks.md item stays open.

### Keyboard

←/→/space to page, Esc to close. `useBookNavigation`'s window listener already bails when a modal, context menu, or text field owns the keyboard; the reader joins that list. Without it, arrow keys would page the book and move the library selection underneath it simultaneously.

---

## Error handling

Failures surface in the reader, never as a blank overlay:

- Book file missing, or NAS offline at open time → an error state offering "Open externally" and "Close".
- Engine throws on a malformed or unsupported file → the same error state, and the fall-through to `files.openBookFile` described above.
- A failed `metadata.json` or catalog write is logged and does not interrupt reading; SQLite already holds the position.

---

## Testing

**vitest (main process):**

- `reading-state` throttle policy — every row of the table above, including that a page turn never writes the catalog and that `will-quit` flushes.
- `read_status` transitions, including the no-regression rule.
- Protocol resolution: by-extension match, renamed-file match, traversal rejection, unknown format, missing file, missing book.
- Migration 003 plus a catalog round-trip proving reading state survives `replaceAllBooks`.

**Manual:**

- Real EPUBs: image-heavy, fixed-layout, footnote-heavy.
- One azw3 and one mobi from the live library.
- Position surviving close and reopen; percent fallback when position is discarded.
- A mid-read NAS disconnect: reading continues, writes resume on reconnect.

---

## Out of scope for C1

PDF rendering (C2), annotations, highlights, bookmarks, search-in-book, dictionary lookup, per-book preferences, and Enter-to-open. Each stays in tasks.md rather than growing this build.
