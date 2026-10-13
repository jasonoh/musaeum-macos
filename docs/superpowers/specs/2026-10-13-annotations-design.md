# Design: highlights and notes — a per-book record beside the book (reader, v1)

**Date:** 2026-10-13
**Status:** Proposed — not yet reviewed with Jason. Nothing built; no slice scheduled. This document settles the storage decision `tasks.md`'s reader bullet has been waiting on, and the surface above it.
**Scope:** The reader gains highlights and notes — a selection becomes a highlight, a highlight can carry a note, both survive a restart, a second Mac, and a reflow re-generate. It deliberately does **not** touch `metadata.json`'s shape, `catalog.json`, `book.formats`, the SQLite schema, the REST wire, or the Python sidecar.
**Depends on:** the in-app reader and its `musaeum://book` route (`docs/invariants/reader.md`), the reflow's derived artifact and its stamp (`docs/invariants/files-and-deletion.md`, `reader.md`), the book-folder layout (`docs/invariants/nas-and-catalog.md` → *Book Storage Structure*), the canonical-file-beside-`metadata.json` precedent (`shelves.json`, `docs/data-contracts.md` → *shelves.json*, `docs/invariants/shelves.md`)
**Interacts with:** the reader's one side slot — `ReaderToc`, `ReaderSearch` and `ReaderAsk` are its three occupants today (`src/components/reader/ReaderView.tsx:383-387`), and D8 gives it a fourth; the vendored engine's annotation surface (`vendor/foliate-js/view.js:368-430`, read and never edited); `src/lib/theme/reader-palette.ts`'s role table (D9); the `derived/` namespace (D3, D6)
**Supersedes:** the *Scheduled next* paragraph at `tasks.md:68` — this document is now the source of truth for the feature, and where the two disagree this one wins. The paragraph's recommendation (the per-book file) stands; its transport claim and its coupling claim are corrected below, and the pointer is added at the entry rather than its prose rewritten.

---

## Why now

The feature is not blocked on the engine, and it is not blocked on a fetch. Every part it needs already exists, and each was measured by reading the tree today:

- **The engine already draws annotations, and it draws two kinds.** `view.addAnnotation(annotation)` resolves the annotation's `value` to a spine index, and for a value that is **not** prefixed `foliate-search:` it removes any annotation under that key and emits `draw-annotation` with a `draw` closure the consumer calls (`vendor/foliate-js/view.js:368-398`). For a value **that is** so prefixed it draws its own outline instead (`:381`). So search — which ships, and whose highlights are the proof — uses one arm of a two-arm API, and the arm the other feature needs is the unwired one. `view.search()`'s hits are literally annotations (`:560`, `:570`); `clearSearch()` deletes the search-prefixed ones and nothing else (`:579-583`), so the two sets coexist on one page by key.
- **The vendored tree carries a reference implementation of exactly this feature, and it is Calibre's.** `vendor/foliate-js/reader.js:156-187` reads a book's embedded Calibre bookmarks, keys them by spine index, re-adds them on every section render through the engine's `create-overlay` event, draws each with `Overlayer.highlight` in the bookmark's own color, and shows its note on click. That is a working highlight layer, ~30 lines, in a file this repo never edits (`reader.md:30`) — read for its shape, never copied from.
- **A selection is already captured — the text only.** `ReaderEngine.tsx:172-175` registers a `selectionchange`/`mouseup`/`keyup` capture on every section document and reports the trimmed text (`selectionText`, `:325-329`) to `reader.store.ts`'s `selection` field, which the ask panel uses as the one thing sent verbatim. What it does **not** carry is *where* — no spine index and no CFI. The index is already in hand at that moment (`loaded.current = { index, doc }`, `:178`), and the CFI is one engine call: `view.getCFI(index, range)` = `CFI.joinIndir(sectionCfi, CFI.fromRange(range))` (`view.js:431-435`, `epubcfi.js:288-295`).
- **A canonical per-book file already has a shape to copy, and it is not `metadata.json`'s.** `shelves.json` is a versioned JSON file that is *canonical for its own kind of data* and never derived (`docs/data-contracts.md` → *shelves.json*; `shelves-file.ts:1-37`), read through one total parser that refuses an unknown version or a malformed member rather than repairing it (`shelves-file.ts:85-102`), and written through one seven-step mutation that asserts the library is writable, enters a queue, **re-reads the file**, applies the change to what it read, writes atomically through a `randomUUID()` scratch name, and only then updates anything else (`shelves.ts:15-33`, `:72-99`). This design is that shape with the cache step removed, because annotations have no cache.
- **The folder rules already skip a `.json` file, and the reason is a rule the repo states as a rule.** `renameToTitle` and `computeFileSizeBytes` both filter on `BOOK_EXTENSIONS = {.epub,.mobi,.azw3,.pdf}` (`book-files.ts:6, 37-38, 76-78`), and every other read — `findFormatFile`, `deleteFormats`, `file-access`, `book-bytes.resolveBookFile`'s `FORMATS` allowlist — resolves by a book format's extension (`files-and-deletion.md:17`; `book-bytes.ts:28, 70`). Covers and `metadata.json` are the existing fixed-name files that list names (`files-and-deletion.md:20`).
- **The one path that is not extension-keyed is the folder's removal, and it is already the right behaviour.** `deleteBook` removes the folder (`fs.rm(dir, { recursive: true, force: true })`, `book-delete.ts` → `removeFolder`), so a new file inside it goes with the book. That is a decision to state, not a rule to change.

**The thesis, and the one measurement that cuts against the easy version of it.** Because the record is a file on the share and the *read path is the share*, the feature needs no adoption, no cache, no migration and no catalog change: a highlight made on the Mac is visible on the phone the moment the wire carries it and on the other Mac the next time that book is opened. That is the whole reason a per-book file beats a column, and it is cheap.

What cuts against it is that a **reflowed book's text is not stable**. A highlight's position is an EPUB CFI, and a CFI is a *node path* — so it survives only while the document behind it does. The reflow's artifact is disposable and re-generated by design: its stamp carries the source's size and mtime and the converter and helper versions, and any mismatch re-runs the pass (`reader.md:24`, `sidecar/reflow/produce.py:123-141`). The converter version moved **3 → 4** on 2026-10-13, and that change removed **566** blocks of printer's furniture from *Universe* alone — 359 letter-spaced running heads and 207 footer paragraphs (`tasks.md` → C2-tail (a); `CHANGELOG.md` → *Fixed*). Every block after the first removed one shifts, so a stored CFI into the old artifact does not merely fail to resolve: it can resolve onto a **different sentence**. The design's second decision is what that means (D5, D6), and it is the reason the record stores the anchor it does.

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| The engine's two-arm annotation API: a non-search `value` emits `draw-annotation`; a `foliate-search:`-prefixed one draws an outline | `vendor/foliate-js/view.js:368-398`, `:6` |
| Re-adds happen per section render, driven by an event the consumer listens for | `view.js:406-420` (`create-overlay`) |
| A click inside a drawn annotation emits `show-annotation` with the annotation's own value | `view.js:408-412`, `:421-430` |
| The CFI for a selection: `getCFI(index, range)`, and `CFI.fromRange` under it | `view.js:431-435`; `epubcfi.js:288-295` |
| Search's highlights are annotations under `foliate-search:`, and `clearSearch()` removes only those | `view.js:543-583` |
| The draw functions available: `Overlayer.highlight` (filled, opacity'd) and `Overlayer.outline` (stroked) | `vendor/foliate-js/overlayer.js:126-141`, `:142-158` |
| A reference highlight layer, including per-section re-add and click-to-show-note | `vendor/foliate-js/reader.js:156-187` |
| The selection capture that already exists — text only, no index, no CFI | `ReaderEngine.tsx:172-175, 178, 181, 325-329` |
| The side slot and its three occupants | `ReaderView.tsx:383-387`; `stores/reader.store.ts:423-425` |
| A canonical JSON file beside `metadata.json`: versioned, total parser, refusal over repair, atomic write with a UUID scratch name | `shelves-file.ts:23-37, 85-165` |
| The mutation shape: assert writable → queue → **re-read** → apply → write → then anything else | `shelves.ts:15-33, 72-99` |
| An unreadable canonical file is never overwritten; the refusal has a name | `shelves.ts:31-37, 77` |
| The reader's palette is a pure, store-free module with one role per purpose, derived from the app theme | `reader-palette.ts:1-22, 121-153` |
| The stored-reader-state rule: `persistedReaderState` carries typography and nothing else | `stores/reader.store.ts:307-309` |
| Source-walk precedent: comment-stripped, `test/invariants.test.ts`'s `sources()` | `test/invariants.test.ts:26-56`; `src/lib/storage-copy-scan.test.ts:1-30` |
| The IPC wrapper that never throws across the boundary | `ipc/handle.ts:1-17` |
| The reflow stamp: source size + mtime + converter + helper versions | `produce.py:71, 108-110, 123-141`; `reader.md:24` |
| `CONVERTER_VERSION` moved 3 → 4 and the artifact is re-generated once per book | `produce.py:71`; `CHANGELOG.md` → *A PDF you have already opened re-prepares itself once* |

**Not true today, and inside this feature rather than free:**

- **The engine's annotation surface is undeclared.** `src/types/foliate-js.d.ts` declares `open`, `goTo`, `goToFraction`, `next`, `prev`, `search`, `clearSearch` and `close` (`:99-130`) — **not** `getCFI`, `addAnnotation`, `deleteAnnotation`, `showAnnotation`, `resolveNavigation`, nor the `Overlayer` module. Everything this feature calls on the engine is new to that file, and by invariant 11 that file is where every divergence goes.
- **`resolveNavigation` fails quietly and its caller does not.** It catches, logs `Could not resolve target …` and returns `undefined` (`view.js:446-459`) — while `addAnnotation` destructures its return on the next line (`:385`). A stale CFI handed to `addAnnotation` therefore **throws** inside the engine, and the engine's own re-add path calls it un-awaited and un-caught (`:416`). This is the single most load-bearing fact in the design: an annotation locator must be checked before it is offered, because the API's failure mode is not a miss.
- **`getCFI` needs a section index, and the selection capture throws its index away.** `sectionText`/`selectionText` are called from inside the `load` listener where `index` is in scope but unused (`ReaderEngine.tsx:165-182`).
- **Nothing reads the reflow stamp from the app side.** `derived/reflow.json`'s `converter` member is written by the sidecar and read by the sidecar (`produce.py:301`); the app's only interaction with `derived/` is resolving `reflow.epub`'s path (`book-bytes.ts:152-156`).
- **There is no per-book user-data file today.** `metadata.json` is the book's record, and it is the record this design exists to keep small.

---

## D1 — The store is `{book}/annotations.json`, canonical, and it needs no cache

**Decision:** a book's highlights and notes live in one file inside the book's own folder, `{book}/annotations.json`, beside `metadata.json` and `cover_full.jpg`. The file is **canonical** for its own kind of data in the sense `shelves.json` is (`docs/data-contracts.md` → *shelves.json*): nothing derives it, nothing else holds a copy of it, and losing it is losing the notes. It is a **fixed name** — not title-derived, like the covers and `metadata.json` (`files-and-deletion.md:20`) — and it is **not** inside `derived/`, which is disposable by definition (`files-and-deletion.md:33`).

**Why:** it is the only shape that is simultaneously (a) outside the record that must stay small, (b) on the share, so it travels, and (c) keyed to the book, so re-generating the book's *rendering* cannot take it. And it is cheap for a reason worth stating plainly: **the read path is the share, not a cache**. `shelves.json` needs an adoption step because the *library view* reads a SQLite cache; a book's annotations are wanted only when that one book is open, and the open path already goes to the share for the book's bytes (`ReaderEngine.tsx:186`, served by `book-bytes.ts`). One small `readFile` on open is the whole read path — no `books` column, no migration, no `replaceAllBooks` clause, no ordering rule between machines, and nothing in `catalog.json`.

**Rejected:**
- **An `annotations` array inside `metadata.json`.** It is unbounded growth in the one record this repo keeps small, and it is worse than it looks: `metadata.json` is rewritten on a **30-second clock** while a book is read (`reading-state.ts:26-30, 108-113`), so every page turn of a heavily annotated book would carry the whole annotation array over SMB; and it is mirrored into `catalog.json`, a whole-library rewrite at every session boundary (`reader.md:84`).
- **SQLite-only.** Machine-local by construction: a note taken on the Mac is invisible to the phone and to the other Mac, and the row dies with a catalog adoption (`replaceAllBooks`) or a database rebuild — the class of loss `owned_fields`' design removed by making the claim part of the book's own record (`settings-and-editing.md:81`, *a claim dies with its row*).
- **`derived/`.** Disposable by definition: the pass re-runs, the folder is wiped, and user data would be the casualty (`files-and-deletion.md:33`).
- **A per-book directory of its own** (e.g. `{book}/annotations/`), which buys nothing today and would need its own skip rule in every folder walk.

**Reversal:** when a per-book file's *size* or its *read* becomes measurable — a `list` over the real share above **50 ms**, or a book whose file exceeds ~256 KB — the record moves to a `book_annotations` table with the **file still canonical** and the table a cache, which is precisely the shape reading state already has (`reader.md:77-84`). That is an additive slice, not a redesign, and it is not taken on speculation.

## D2 — The file's shape, and one total validator that refuses rather than repairs

**Decision:** the file is versioned, and one parser is total over its contents. Its shape:

```json
{
  "version": 1,
  "book_id": "6f1a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  "annotations": [
    {
      "id": "b1c2d3e4-5f60-4712-8394-a5b6c7d8e9f0",
      "type": "highlight",
      "cfi": "epubcfi(/6/14!/4/2/8,/1:0,/1:41)",
      "quote": "The protomolecule is loose.",
      "prefix": "…and then ",
      "suffix": " It was not…",
      "percent": 0.42,
      "section_label": "Chapter 7",
      "color": "gold",
      "note": "the setup for book two",
      "artifact": { "kind": "source", "format": "epub", "converter": null },
      "created_at": "2026-10-13T11:02:41.000Z",
      "updated_at": "2026-10-13T11:02:41.000Z"
    }
  ]
}
```

- `version` — the file format's own version, independent of the REST `apiVersion`. A version this build does not know makes the file **unreadable and never rewritten in this build's shape**, exactly as `shelves.json`'s does (`shelves-file.ts:80-84`).
- `book_id` — written for a person opening the file by hand and for a folder that was copied or renamed by mistake. It is **not** a rule: the file is found by its folder, and a mismatch is logged, not acted on.
- `type` — `"highlight"` for everything this build writes. The member exists because the file is a contract with a future (a bookmark is a position with no range, and the shape should not have to change to hold one).
- `cfi` — the fast path; see D5.
- `quote`, `prefix`, `suffix` — the durable anchor; see D5. The quote is capped at **512 characters** and each context side at **32**, trimmed and whitespace-normalized on the way in (the same normalization `search.js:4` applies, so a quote and a hit's excerpt are comparable).
- `percent` — the position as a fraction, the portable member `reading_state` already travels by (`reader.md:86`).
- `section_label` — the section's own TOC label as the engine reported it, for the panel's grouping; nullable, like the engine's own (`reader.md` → *Searching in the book*).
- `color` — `"gold"` for every annotation this build writes. **The member exists now and the picker does not** (see *Rejected and deferred*): the record is the expensive thing to change later, the UI is not.
- `artifact` — what the `cfi` is a path into; see D6.
- `created_at` / `updated_at` — ISO 8601, `updated_at` moving only when a note actually changes.

**Why a total parser:** the file lives on a share any machine can touch and can be hand-edited, and the precedent's reasoning applies unchanged — a reader that repairs a malformed entry silently destroys it on the next write, so the file is either readable as a whole or refused as a whole (`shelves-file.ts:52-60`, `data-contracts.md:102`). A refused file is a **named refusal on the reader's surface**, not an empty list: "your notes are still on disk, they just could not be read" is a different sentence from "there are no notes", and the two must never be confused by the UI.

**Rejected:** a lenient reader that drops what it cannot parse (destroys data on the next write); JSON Lines or a per-annotation file set (many tiny files over SMB, and no atomic whole-file story); a binary or SQLite-per-book format (unreadable by hand, and the file's hand-repairability is the point).

**Reversal:** if a file in the wild is *partly* good and there is a reason to rescue it, the repair is a **one-shot action** (`annotations.repair`), never a lenient read — the reversal is for the action, not the reader.

## D3 — The folder rules: every path that touches a book folder, and what each does with the new file

**Decision:** nothing in the folder rules changes. `annotations.json` is skipped by every existing path because every existing path keys on a book format's extension or on a fixed name, and the one path that is not keyed at all — deleting the book — is *supposed* to take it. The work this feature owes is not teaching the rules but **pinning** them where they are decided, because they are exactly the kind of rule that breaks silently: a future extension-keyed rule that forgets the new file shows up as a renamed or double-counted file, not as a build error.

| Path | Where | What it does with `annotations.json` today | What this feature owes |
| --- | --- | --- | --- |
| `renameToTitle` | `book-files.ts:23-57` | **Skips it** — `extname('.json')` is not in `BOOK_EXTENSIONS` (`:6, 37-38`) | A case, with the file seeded beside the formats |
| `computeFileSizeBytes` | `book-files.ts:73-85` | **Does not count it** — same set (`:77`) | A case; `file_size_bytes` must not grow with someone's notes |
| `findFormatFile` / `deleteFormats` | `book-delete.ts:41` | **Never matches** — by extension, per `files-and-deletion.md:17` | Nothing |
| `file-access.revealBook` / `openBookFile` | `file-access.ts` | **Never matches** — by extension | Nothing |
| `book-bytes.resolveBookFile` | `book-bytes.ts:55-74` | **Refuses it** — the `FORMATS` allowlist is four literals (`:28`) | Nothing; and it must stay out of that allowlist, because its second consumer is the HTTP surface |
| `book-bytes.resolveReflowFile` | `book-bytes.ts:152-156` | **Never touches it** — a fixed path under `derived/` | Nothing |
| `importer.importOne` / `addFormatToExisting` | `importer.ts:259, 584` | **Never touches it** — both copy the *dropped* file in | Nothing |
| `catalog.rebuildFromBookDirs` | `catalog.ts` | **Reads `metadata.json` only** per folder | Nothing; and it must never learn this file, or the catalog stops being small |
| `library-sync` adoption / `replaceAllBooks` | `library-sync.ts` | **Neither carries nor erases it** — it holds no column for it | This is the design's main saving (D1), and a case asserting an adoption leaves the file byte-identical |
| The reflow pass | `services/reflow.ts`, `sidecar/reflow/` | **Writes only under `derived/`** (`data-contracts.md` → `reflow_pdf`, AC2) | Nothing; and the pass must not touch it, which the existing AC2 rule already pins |
| `deleteBook` / `deleteBooks` | `book-delete.ts` → `removeFolder` | **Takes it with the book** — `fs.rm(dir, { recursive: true, force: true })` | D4 |
| A recursive folder walk | — | **Does not exist** (`files-and-deletion.md:32`) | The rule for the first one that does: it skips `annotations.json` by name, and that is where it is recorded |

**Why the fixed name and not a title-derived one:** a title-derived name would make the file a second thing `renameToTitle` has to know about, and the repo's rule is that a rename is *cosmetic* and must never cost an edit (`files-and-deletion.md:17`). A fixed name has no rename to lose. (It also means the file's name is stable in a `git`-less backup and in a person's Finder window, which is how a folder gets rescued by hand.)

**Consequence — the invariant docs move, in the implementing slice, not here.** `docs/invariants/nas-and-catalog.md`'s *Book Storage Structure* block (`:43-62`) gains the file, and `docs/invariants/files-and-deletion.md` names it in the folder-rules list beside the covers and `metadata.json`. This document does not edit either file; an invariant doc that gains a file without its rules is how the next reader mis-infers them.

**Rejected:** making annotations a `BookFormat` or an extension the folder rules do understand (it is not a file a device reads — the same reasoning that keeps `derived/` out of `formats`); a title-derived name (D3 above); a dotfile (invisible in Finder, and macOS hides it from the very person rescuing the folder).

**Reversal:** the first recursive sweep of a book folder. When one exists, its skip list is the new owner of this rule and `files-and-deletion.md:32` is where it is recorded.

## D4 — Deleting a book takes its notes, and the dialog says so

**Decision:** `deleteBook` removes the folder, so the notes go with the book. That is the correct behaviour and it is not silent: the delete dialog's copy names them. `deleteFormats` is unchanged — selecting every format already falls through to `deleteBook` (`files-and-deletion.md:41`), so there is no third case to write.

**Why:** the alternative is an orphan store — notes for a book that no longer exists — which is the class of bug the repo removed by construction when it moved field claims onto the book's own record and deleted the side map's `forget`/`pruneDead` machinery (`settings-and-editing.md:81`). A book's notes are the book's. And the copy is a real requirement, not a courtesy: this app already says this sentence about a different store, on the device side — *"This deletes the file from the device, along with its reading position and annotations."* (`RemoveFromDeviceDialog.tsx:69`) — so a person who has seen that dialog will reasonably expect the library's delete to behave the same way.

**Rejected:** keeping notes under `{library_root}/annotations/` keyed by book id (a store nothing sweeps, which drifts from the library the moment a folder is deleted outside the app); a soft-delete/trash (an undo for book deletion is a different feature and would re-make deletion, not annotations); a confirmation *inside* the reader (the delete paths are the library's, and the reader is the wrong surface for a library-wide rule).

**Reversal:** whenever book deletion gains an undo. Deletion then has to become a tombstone rather than an `fs.rm`, and this file is inside what a tombstone has to hold.

## D5 — The locator: `cfi` is the fast path, the quote is the anchor, and both are always written

**Decision:** every annotation carries **three** locators, all written at creation and none of them optional: the **CFI** (what the engine draws from), the **quote with its context** (the durable anchor), and **`percent`** (the ordering key, and the member that means something to an engine that has never seen this book). Drawing uses the CFI. Everything else — the panel's ordering, grouping, and the "where was this" a person reads — uses the other two.

**Why:** a CFI is a node path, so it is exact and it is brittle in exactly one direction: it is exact only against the document it was made in. For a book read from its own file that document is the book, and the CFI is as good as the position store's CFI already is. For a **reflowed** book it is the derived artifact, which is regenerated whenever the source moves or the converter version moves (`reader.md:24`; `produce.py:123-141`). The repo already knows this class of failure and already has a precedent for the answer: a regenerated artifact can kill a stored CFI, and the existing percent fallback absorbs it with no new code path (`reader.md:21`). This design does the same thing one level up — the quote is the member that survives the artifact, exactly as `percent` survives the CFI.

**Rejected:**
- **CFI only.** The cheap version, and it fails *wrongly* rather than loudly: see D6 for why a stale CFI is worse than a miss.
- **Quote only, resolving every annotation by searching the book.** No fast path, an O(book) text walk on every open for every annotation, and it collides with the find panel's own runs (`search()` calls `clearSearch()` on entry, `view.js:543`).
- **A character offset into the section text** instead of a quote. It is a dependency on the tokenizer's own whitespace model — the same model `sectionText()` documents as lossy for minified XHTML (`ReaderEngine.tsx:276-281`) — so it is *less* stable than the text it indexes.
- **The reflow's source-page map** (`derived/reflow.json`, which records which PDF page each block came from) as the anchor. It is the strongest anchor for a reflowed book and it is **out of bounds**: `reader.md:22` says it is written and read by nobody yet, and *"do not build a reader feature on it without a spec"*. It is named in the reversal below because that is where its condition is.

**Reversal:** the day a reader can consume `derived/reflow.json`'s page map — a spec of its own, which `reader.md:22` already asks for — a reflowed book's anchor becomes the **source page plus the block's ordinal on it**, and the quote becomes the second fallback rather than the second of three. That anchor is independent of the converter version in a way the CFI can never be.

## D6 — The artifact identity is recorded at creation and compared before a draw, and a mismatch lists rather than draws

**Decision:** each annotation records the artifact its CFI is a path into — `{ kind: 'source', format: <epub|mobi|azw3|pdf>, converter: null }` for a book's own file, `{ kind: 'derived', format: 'reflow', converter: <the stamp's converter version> }` for the reflow artifact — and the read path compares that record against the artifact the reader **would** open now. An annotation whose identity does not match is returned **marked**, is **listed** in the panel with its quote, and is **never handed to the engine**.

**Why a mismatch must not be drawn, which is the sharpest claim in this document:** `addAnnotation` resolves the CFI and then applies it as a node path (`view.js:385-395`). A path that still resolves but points at a *different* node draws a highlight over a sentence nobody highlighted — silent corruption, which is worse than a missing highlight because nothing on screen says so. And the mismatch is not hypothetical: the converter version moved 3 → 4 on 2026-10-13 and the furniture rule removed **566 blocks** from *Universe*'s flow (`tasks.md` → C2-tail (a)), so every CFI after the first removal is shifted. Measured, not hypothesized.

Two guards, in this order, because they answer different questions:
1. **The identity comparison (main process).** Cheap, decides "the artifact behind this CFI is not the artifact I would serve". A `reflow` annotation's `converter` is compared against `{book}/derived/reflow.json`'s `converter` member (`produce.py:301, 401-406`); a source annotation's `format` against the format the reader was opened with.
2. **The engine's own resolution (renderer).** The second guard catches what the first cannot — a *source* file replaced outside the app, which keeps the identity and moves the text. Because `resolveNavigation` returns `undefined` and `addAnnotation` then destructures it (`view.js:385`), the renderer **checks before it offers** and **wraps the call anyway**: a locator that does not resolve is recorded as undrawable and skipped, and one throw from the engine costs that annotation and never the book.

**Consequence — the reader still learns nothing about PDFs.** The identity comparison needs to know which artifact is in play, and that is the *service's* fact, not the reader's: the reader asks for `{bookId, format}` and is told which annotations are current. The renderer holds no `reflow` branch — D10 of the reflow spec (`reader.md:20`) is a rule about the reader, and this design puts the one branch it needs in the main process, beside `resolveReflowFile`, where the `derived/` distinction already lives (`book-bytes.ts:126-156`).

**Rejected:** trusting the CFI (silent mis-draw); storing nothing and testing resolvability alone (a shifted-but-resolvable path passes, which is the whole failure case); recomputing the identity on every draw (a stamp read per annotation per section render); hashing the artifact (`reflow.epub` is tens of MB — a full read to answer a question a 200-byte stamp already answers).

**Reversal:** the same condition as D5's — a reader that can consume the page map. It also removes this decision's asymmetry, because a page anchor is comparable across converter versions and would not need a version gate at all.

**Residual, stated:** a **source**-format book whose file is replaced in place (a re-import onto the same book id, a hand-swapped EPUB) keeps its identity, so a CFI that happens to resolve is drawn, and it may be wrong. The identity cannot see content. What makes it visible rather than invisible is that the annotation still shows its quote in the panel, so the mismatch is one glance away.

## D7 — The write path: online-only, re-read before write, and never overwrite a file that cannot be read

**Decision:** every mutation runs the `shelves.json` shape with the cache step removed — `nas.assertOnline()`; enter one process-wide queue; **re-read the book's file**; apply the change to what was read; write the whole file atomically through a `randomUUID()` scratch name, indented; answer from what was written. A read that fails with `ENOENT` is a book with no annotations yet (an empty file, not an error). A read that fails any **other** way, or a file that parses as invalid, refuses the mutation with a named sentence and writes nothing.

**Why each half:**
- **Online-only**, for the reason a field release is (`settings-and-editing.md:77`): a highlight is a write to the book's record, and the record is on the share. The refusal uses the existing storage copy rather than a new sentence. The residual is honest and small — you cannot *read* a book whose bytes cannot be fetched either, so the window in which this bites is a share that dropped mid-book, and there the highlight is refused rather than silently parked.
- **Re-read every time**, because the file is shared: the other Mac may have annotated this book since this one last looked, and a read-modify-write from a stale copy is how a note disappears. This is the same argument as `shelves.ts:26-28`, and it is what makes a merge rule unnecessary (D1).
- **One queue, per process**, because two mutations interleaving their read-modify-write lose one (`shelves.ts:63-70`). One queue over all books rather than one per book: the operations are a few hundred bytes and the simpler invariant is the one that holds.
- **Never overwrite an unreadable file**, because the next write would otherwise turn a hand-editing mistake into data loss (`shelves.ts:31-37`).
- **The whole file, atomically**, because a torn `annotations.json` is a lost book's worth of notes and the scratch-then-rename pattern is already the repo's answer (`shelves-file.ts:138-165`). The scratch name carries a `randomUUID()` rather than a pid for the same reason `shelves.json`'s does: several Macs share one folder (`shelves-file.ts:144-153`).

**Rejected:**
- **A SQLite cache in front of the file.** It buys nothing v1 needs (the file is read once per book open) and it costs a merge rule for the cache, which is the expensive part of the shelve design and here would be machinery for a case that has never happened.
- **Holding the list in memory and writing it back.** That is the stale-copy bug: this machine's snapshot of a shared file is not a record of what is in it.
- **Writing without `assertOnline`, parking the write for a flush** (the reading-position shape, `reading-state.ts:97-101`). Defensible and rejected for v1 on cost-benefit: it needs a park-and-flush lifecycle plus a decision about what a person sees for a highlight that is on screen but not on disk, to serve a window that only opens when the share drops *while* a book is already open.

**Reversal:** offline annotation becoming a wanted feature — someone reading on a laptop away from the share. Then the write takes the `reading-state.ts` shape exactly: apply locally, park the report, flush on reconnect, and the *file* stays canonical with the parked write carrying its own `updated_at` so a last-write-wins landing is at least orderable.

## D8 — The surface: a chip at the selection, and Notes as the side slot's fourth occupant

**Decision:** two surfaces, no more.

1. **A selection chip.** While a section has a live, non-collapsed selection, a small **Highlight** control sits at the selection's own bounding rect, inside the reader's layer (`z-[45]`), and it is `app-no-drag` — the header's own rule, and the reason it is stated is that every control in that band that forgot it was unclickable for five weeks (`reader.md:45`; `src/components/reader/drag-regions.test.ts` holds it). Activating it writes a `highlight` with `note: null`.
2. **The Notes panel.** Clicking a drawn highlight — the engine emits `show-annotation` with the annotation's own value (`view.js:408-412`) — opens the panel with that annotation active. The panel lists the book's annotations in document order (by `percent`, then `created_at`), groups them by `section_label` the way the find panel groups by section, marks the active one, and gives the active one an inline note editor (a textarea and a Save that appears only when the text actually changed) and a **Delete**. Opening it closes the other three occupants, and vice versa: the reader has **one** side slot and this is its fourth claimant (`ReaderView.tsx:383-387`; `stores/reader.store.ts:423-425`).

**Why the chip is at the selection and the note editor is not:** a selection is the one gesture whose position is unambiguous (the browser knows the rect), so the gesture's affordance can be where the gesture is. Everything after that is not — a highlight's own rect lives inside the book's iframe, inside the paginator's **closed shadow root**, and mapping it back to window coordinates is a coordinate problem with a version-dependent answer, which is a cost with no product in it. The panel is where the note belongs anyway: it is also the list, the grouping, and the only place a **stale** annotation (D6) can be shown at all, since it has nothing to draw.
**Rejected:** a floating popover anchored to a highlight's rect (the coordinate problem above); the note editor as a modal (modals sit above the reader at `z-50` and the reader's own keyboard handler bails for whatever is on top of it — a modal is the wrong layer for a per-annotation edit); a highlight with no note as a *different* feature from a note (one record, one list, `note: null` is the empty case); auto-saving a note on blur (the same class of silent write the editor's diff guard exists to prevent, `settings-and-editing.md:83`).

**Reversal:** if the panel proves too far from the text on a wide window, the popover comes back — with the geometry **measured** in the running app first, and with the panel's list kept as it is either way.

## D9 — The draw: a filled highlight, its own palette role, and the color follows the theme

**Decision:** the annotation layer attaches its own listener to the view's `draw-annotation` event and draws with **`Overlayer.highlight`** (a filled rect with the vendored opacity/blend custom properties, `overlayer.js:126-141`), in a color taken from a **new `annotation` role** on the reader's derived palette. Search keeps drawing `Overlayer.outline` in the `search` role, untouched (`view.js:544`). The color is a resolved `#rrggbb` literal and **never** `var(--…)`: the overlayer lives in foliate-view's closed shadow root, where a custom property is a bet this repo does not take (`reader.md:67`). And the layer **redraws when the resolved color moves** — the same obligation, for the same reason, that `ReaderSearch` already discharges (`ReaderSearch.tsx:135-158`): the engine keeps the options it was handed and re-applies them on every section render, so a highlight drawn under one theme would keep that theme's color after a switch. That was measured once already on the search path: **1,780** orange pixels left on a page that had gone dark (`reader.md:69`).

**Why a role of its own rather than reusing `search`:** the two sets coexist on one page by construction (D-*why now*: distinct annotation keys), and the module's own reasoning is that a role exists so it can be **derived** — `search` was named for exactly this, and it is the derived link color (`reader-palette.ts:43-52`). Two purposes sharing one role is how the next theme change gets a decision nobody can find. `annotation` derives from the same link color today, so the two **are** the same value on screen — which is fine and not a collision, because they are drawn differently: a hit is an outline, a highlight is a fill. The distinctness that matters is carried by the draw function, and the role is carried by the name.

**Rejected:** reusing `search` (one role, two meanings); any hardcoded color (the bug the `search` role was created to prevent, measured at 1,783 amber / 1,784 orange pixels against the wrong theme, `reader.md:67`); a `color` role per annotation color name from day one (a picker we are not shipping, and a role table that grows per feature is not a role table); drawing highlights as outlines (search would become ambiguous, and the record already reserves the `color` member for a future picker).

**Reversal:** a reader who cannot tell a highlight from a hit at a glance. Then `annotation` derives from a different token, and *which* token is a decision for the theming work — it is a palette question, not this feature's.

## D10 — The wire carries nothing in v1, and the coupling the tracker records is not real

**Decision:** v1 is Mac-only. `docs/rest-api.md`, `shape.ts` and its goldens, and `scripts/api-smoke.sh` are **not touched**, `apiVersion` does not move, and the iOS repo gains no slice from this design.

**Why:** three reasons, in order of weight.
1. **It would have no consumer.** The client's own v1 spec lists annotations under *Not in v1* (`../musaeum-ios/docs/specs/2026-09-22-client-v1-design.md:5`), and that repo's rule is hard: its fixtures are extracted from the Mac's document, so a client slice that needs a route the document does not carry cannot start — and the converse is equally true of a route no client reads. A route with no reader is a permanent surface and a permanent liability.
2. **The payload would carry the thing the wire deliberately refuses to carry.** `reading.position` is the Mac's CFI and is omitted on purpose, *because* it "is a coordinate no other engine can consume" (`docs/rest-api.md:613`, `shape.ts:26-30`). A highlight's locator is the same kind of coordinate. A v1 payload would therefore have to carry the **quote** and the **percent** and not the CFI — which is a defensible contract, but it is a second design decision (a phone-side anchor rule, and Readium's own anchoring semantics, which this repo cannot decide), riding on a storage decision nobody has implemented yet.
3. **Nothing is lost by waiting, and that is the point of D1.** The record lives on the share in the book's own folder, so a Mac-only v1 preserves every note and a later wire slice is purely additive. This is where the tracker's paragraph is wrong: it calls the wire decision *"coupled"* to the storage decision. It is not coupled, and the reason is the storage decision itself — a per-book canonical file is transport-agnostic in a way a `metadata.json`-resident array would not have been, because the file needs no adoption path to become the other machine's record of the same book.

**Rejected:** a read-only `annotations` member on the book payload in v1 (a contract with no client, and the goldens/smoke trio is a real cost per change — `docs/rest-api.md:5`); a dedicated `GET /api/books/{id}/annotations` (the same, with a new route's 404/503 vocabulary to define); carrying the CFI on the wire (the client cannot consume it, and putting it on the wire would invite a client to try).

**Reversal:** the iOS repo's `tasks.md` gains an annotations item, or its reader gains a decorations surface. Then the payload carries `quote`, `prefix`, `suffix`, `percent`, `section_label` and `note` — and **never** the CFI, by the `reading.position` rule. The route design, the nullability of every member, and the client's own annex are that slice's work.

## What this design does not need

Named because it is what stops the feature queueing behind work it does not depend on, and because each of these was checked rather than assumed:

- **No sidecar method and no RPC.** A highlight is not extraction; nothing about it touches Python. `sidecar/` gains no file, so the Python suite is unchanged and stays a check on the change not having leaked.
- **No SQLite migration.** No column, no table, no `PRAGMA user_version` bump.
- **No change to `metadata.json`, `catalog.json`, or the payload shaper.** The catalog stays derived from `metadata.json` alone (invariant 1), and the annotation count never enters it — which is why a per-card "has notes" badge is rejected rather than deferred (see *Rejected and deferred*).
- **No change to the wire, its goldens, or the smoke script** (D10).
- **No change to `vendor/foliate-js/`** (invariant 11): the two divergences this feature needs — the annotation methods and the `Overlayer` module — are declared in `src/types/foliate-js.d.ts`, which is the file's stated purpose.
- **No new `musaeum://` host.** Annotations reach the renderer over IPC, like every other book record; the protocol stays for bytes.

## Store and component shape

`reader.store.ts` gains the fourth occupant's flag and the book's annotations as **session state**, on the same terms as the search panel's: `notesOpen: boolean` beside `tocOpen`/`askOpen`/`searchOpen` (whose three toggles already close each other, `:423-425`), the loaded list, a `loading`/`unreadable` status, and the active annotation's id. `persistedReaderState` is **not** touched — the reader still persists typography and nothing else (`:307-309`), and a case pins it (AC16). The selection chip's rect is **local component state in the engine's host**, never a store field: it is a measurement of one moment in one iframe, and a DOM rect in a store is the thing this repo's store rule exists to keep out. No DOM nodes in the store.

## Acceptance criteria

Instruments are named per criterion. **Automated** means a decider that runs in `npm test` or `pytest`; **manual** means it is a claim about the running app and is parked in the manual list below, with the frame or gesture that decides it.

### Slice 1 — the record (main process, contracts, and the folder-rule pins)

1. A highlight round-trips: `create` writes a file this build's validator accepts, and `list` returns the same id, `cfi`, `quote`, `note` and timestamps. **Automated** — `electron/main/services/annotations.test.ts`, with the written bytes re-read from disk and parsed independently of the writer.
2. The file is not a format: with `annotations.json` seeded beside a book's format files, `renameToTitle(dir, 'A New Title')` renames those and leaves this one, and `computeFileSizeBytes` equals the format files' sum. **Automated** — `book-files.test.ts`, extending the seed the existing case already builds (`book-files.test.ts:25`) and asserting the returned rename count too.
3. A settled title leaves the file's name alone, and a **same-extension collision** in `renameToTitle` is still skipped (`book-files.ts:44`). **Automated** — same file. (This is slice 1's, not a later slice's, because the pin is worthless once the name is in the tree.)
4. An unreadable file is never overwritten: given invalid JSON, `create` rejects with the named sentence and the file's bytes are identical afterwards. **Automated** — `annotations.test.ts`, comparing two buffers.
5. A book with no file: `list` answers the *missing* state, and **no file is created**. **Automated** — `fs.readdir` before and after, in the same file.
6. The write re-reads the file: an annotation appended by a direct write between two `create` calls survives the second. **Automated** — the same file. (This is the criterion that fails if the implementation caches.)
7. The artifact identity is recorded and compared: a `create` with `format: 'reflow'` records the stamp's `converter`; a `list` after the stamp's converter moves marks exactly those annotations stale, and never marks a source-format one. **Automated** — the same file, against a `derived/reflow.json` fixture written by the test.
8. `annotations.json` is named in one place: a comment-stripped source walk over `src/` and `electron/` finds no file outside `services/annotations-file.ts` (+ its tests) naming the literal. **Automated** — a describe block in `test/invariants.test.ts`, whose `sources()` helper already walks all three trees and skips `.test.` files (`:26-56`). The walk's own skip of whole-line comments is the existing one, and this criterion's subject is a *file name*, so the documentation of the rule must be written as prose that does not spell the literal — or the walk must exempt doc-comment lines, and that is the implementer's choice, stated because the trade is real either way.
9. An adoption leaves the file alone: a `replaceAllBooks` of a book whose folder holds a file with content X leaves it byte-identical, and no `book_annotations`-shaped column exists. **Automated** — `library-sync.test.ts`.
10. No IPC handler does file work: the new `ipc/annotations.ts` is inside the existing walk's directory scope. **Automated, inherited** — `test/invariants.test.ts:65`, unchanged; named here so the reviewer does not read its passing as this slice's.
11. A failed read is not an empty list: the service's read state distinguishes *missing* from *unreadable*, and a `create` with the library offline refuses rather than writing. **Automated** — `annotations.test.ts` with `nas.isOnline()`/`getLibraryRoot()` stubbed.

### Slice 2 — the reader

12. The palette has the role and it is total: `annotation` is present on both authored rows and on `readerPalette(tokens)`'s output, and its value passes the module's own hex guard. **Automated** — `reader-palette.test.ts`.
13. A selection becomes a locator, purely: `annotationFromSelection({ quote, cfi, percent, sectionLabel })` refuses a whitespace-only quote, normalizes its whitespace, caps the quote and the context, and returns every member the file's validator requires. **Automated** — `src/lib/annotations.test.ts`, no DOM.
14. A locator the engine cannot use is skipped, and never twice: given a source whose `addAnnotation` throws for one value and resolves for another, the plan reports the first as undrawable, draws the second, and returns. **Automated** — the same file, against a stub source (the structural-typing pattern `reader-search.ts:82-90` already uses to keep the engine out of the test).
15. The draw plan follows the resolved color: changing it yields a different plan (the `ReaderSearch` precedent's rule). **Automated** — the same file.
16. The plan names the draw as a *highlight*: the plan's rows carry the draw kind, and the kind is `highlight` for annotations — with the search path's own draw untouched. **Automated** for the plan; the wiring is manual (below), and the criterion says so rather than implying a test decides it.
17. The side slot has four occupants and one is showing: each toggle closes the other three, and one is showing at a time. **Automated** — `src/stores/reader.store.test.ts`.
18. Nothing about annotations is persisted by the reader: `persistedReaderState` still returns `{ prefs }` alone. **Automated** — the same file, extended from the existing search assertion.
19. The delete dialog's sentence names the notes. **Automated at the string level** — `DeleteBookDialog`'s copy case; the residue is stated: a string case proves the sentence exists, not that it is *rendered*, and the rendering is a manual frame.

### Slice 2 — manual, and why each has no automatable instrument here

20. Select text → the chip appears at the selection → activating it draws a filled highlight in the page's own color. There is no automatable instrument for a **mouse** gesture in this repo (`docs/superpowers/plans` records the synthetic-click hazard: a synthetic click reports it green regardless of the pointer path, which is the same class as the `app-drag` bug). Decided by a frame in the running app, with the highlight visible and the panel listing it.
21. Clicking a drawn highlight opens the panel with that annotation active. Same instrument and same reason.
22. A note typed and saved survives a reader close and a relaunch, and the file on the share carries it. Decided by reading the file off the share after the gesture — the artifact is the instrument.
23. Switching the app theme with highlights on screen leaves them in the new theme's color. Decided by a frame (the search path's own measurement is the precedent: 1,780 px of the wrong color, `reader.md:69`), and by the drawn-color watcher's unit case one step upstream (AC15).
24. A reflowed book whose artifact re-ran shows its highlights **listed and not drawn**, with their quotes. Decided by opening a prepared PDF-only book after bumping the converter version in its stamp — the stale path on screen, which is the one behaviour this design exists for and cannot be faked by a fixture.

**Not verified by execution, and it is a criterion this slice owes:** that a **fixed-layout** EPUB (`foliate-fxl`, which has no paginator and therefore no `setStyles`) draws an overlay at all. The engine's overlayer attaches per section document (`view.js:406-420`) and does not appear to depend on the paginator, but nothing here was run, and the reader's format rules do not exclude such a book (`readableFormat`, `book.types.ts:200-204`). The manual pass must include one, and if it fails, the annotation layer's refusal is the D6 path — listed, not drawn — rather than a crash.

## Slices, and why they are cut this way

Two slices, and the cut is the storage/surface boundary the sign-off gate names: types → main-process service → IPC surface → pure renderer library → the UI last.

**Slice 1 — the record (7 source files, inside the ~10 bound).** New: `src/types/annotation.types.ts`, `electron/main/services/annotations-file.ts` (the file and its total parser — the `shelves-file.ts` shape), `electron/main/services/annotations.ts` (the queue, the read state, and the artifact comparison), `electron/main/ipc/annotations.ts` (thin handlers). Edited, and none of the three carries logic: `src/types/api.types.ts` (an `annotations` block beside `reader`'s, `:334`), `electron/preload/index.ts` (the surface, `:107`), `electron/main/index.ts` (one import and one `registerAnnotationHandlers()` call beside `:202`). New tests: `electron/main/services/annotations.test.ts`, `electron/main/services/annotations-file.test.ts`. Extended: `book-files.test.ts`, `book-delete.test.ts`, `library-sync.test.ts`, `test/invariants.test.ts`. **It stops here because it is fully testable today**: every criterion above is a case, and none of them needs a browser. It is also the half that another surface — the phone, a future exporter — would need first, if the wire decision is ever reversed.

**Slice 2 — the reader (9 source files, inside the ~10 bound).** New: `src/lib/annotations.ts` (the pure plan: the locator, the draw list, the color rule — no store, no DOM, the `reader-search.ts` shape), `src/components/reader/ReaderNotes.tsx`, `src/components/reader/SelectionChip.tsx`. Edited: `src/components/reader/ReaderEngine.tsx` (the largest change — the selection capture's index and CFI, the three engine listeners, the palette-change redraw), `src/components/reader/ReaderView.tsx`, `src/stores/reader.store.ts`, `src/lib/theme/reader-palette.ts`, `src/types/foliate-js.d.ts`, `src/components/shared/icons.tsx` (one glyph). New test: `src/lib/annotations.test.ts`. Extended: `reader.store.test.ts`, `reader-palette.test.ts`, `drag-regions.test.ts` (the chip is a new control in the draggable band, and that file's walk is what holds it). **It stops at the UI because that is where the instruments stop** — the mouse path is a frame, and pretending otherwise is what the manual list exists to prevent.

**The third thing this design creates and does not build — the re-anchor (slice 3, deliberately unscheduled).** D5 and D6 make a stale annotation *safe* (listed, not drawn) and do not make it *findable again*: locating the quote in the section `percent` names, and rewriting the `cfi` when there is exactly one confident match, is new machinery — a text walk plus a range-to-CFI construction — and it is worth its own spec, because its confidence rule (what counts as one match) is a judgement call with a visible failure mode. It is also not urgent: the stale state is honest and costs nothing. **Its reversal condition is already written into the world**: the next `CONVERTER_VERSION` bump, which re-runs every cached artifact once (`produce.py:71`), is the moment a reflow-annotated book is stale on the next open. That is a *known* future event, not a speculation, which is why it is named here rather than in *Rejected and deferred* — it is owed work, just not this session's.

**Budget note, stated plainly:** the feature is **16 source files** plus four new test files across its two slices, which exceeds `CLAUDE.md`'s ~10-file bound *as a feature* and honours it per slice (7 and 9). The file that absorbs an overrun inside slice 2 is `ReaderEngine.tsx` — it is the engine's host, it already carries the selection capture, the load/relocate listeners and the stylesheet wiring, and the annotation layer attaches to all three of those seams. If slice 2 overruns on files, the second file to fold in is the chip (into `ReaderView.tsx`'s header/overlay area) — it is ~40 lines and the panel is where the feature's weight actually is.

## Implementation routing

**Read first, in this order:**

1. `vendor/foliate-js/view.js:368-430` and `:543-583`, and `overlayer.js:126-158` — the two arms of the annotation API and the two draw functions. Read, never edit (invariant 11).
2. `vendor/foliate-js/reader.js:156-187` — a working highlight layer in this tree: per-section re-add on `create-overlay`, `draw-annotation` → `Overlayer.highlight`, click → `show-annotation`. This design's shape is that one, plus a file.
3. `docs/invariants/reader.md` — the reader's rules that bind here: the palette's resolved-literal obligation and its measured failure (`:67-69`), the `derived/` posture and the percent fallback (`:21-24`), the `app-no-drag` rule for any control in the reader's top band (`:45`), and "nothing about a search is persisted" (`:65`).
4. `docs/invariants/files-and-deletion.md` and `nas-and-catalog.md` → *Book Storage Structure* — the folder rules this file lives among, and the block that gains it (`:43-62`) when slice 1 lands.
5. `electron/main/services/shelves-file.ts` and `shelves.ts` — the canonical-file shape being copied: the total parser, the refusal over repair, and `mutate`'s seven steps with the cache step removed.
6. `src/components/reader/ReaderEngine.tsx` (the selection capture, the `load`/`relocate` listeners, the stylesheet wiring) and `src/stores/reader.store.ts` (the side slot's toggles, `persistedReaderState`).
7. `src/lib/theme/reader-palette.ts` and `src/lib/reader-search.ts` — the two pure-module shapes the new lib and the new palette role copy, including the color-follows-the-theme watcher.

**Invariants at risk, and how this touches each** (the reasoning is in *Risks* 6; this is the routing summary):

| Invariant | How this touches it |
| --- | --- |
| **2** — lookups by extension | The only invariant that could bend: the new file must be skipped by every extension-keyed lookup. It is skipped today by construction; AC2/AC3/AC8 pin it. |
| **6** — a settled title renames its files | The new file is **not** title-derived, so the three rename call sites are untouched; AC2 pins it. |
| **8** — logic in `services/`, thin handlers | Slice 1's handler file is thin, and the existing walk (`test/invariants.test.ts:65`) covers it with no change. |
| **11** — `vendor/` never edited | Two divergences, both declared in `src/types/foliate-js.d.ts`. |
| **12** — failures stay non-fatal | A failed annotation read or write degrades to "listed, not drawn" or a named refusal — never to a book that will not open. |
| **1, 3, 4, 5, 7, 9, 10** | Not touched, with the reason for each in *Risks* 6. |

**Ownership, by the repo's agent boundaries:**

- **contracts-engineer** — `src/types/annotation.types.ts`; the `annotations` block in `src/types/api.types.ts`. `metadata.json` and `catalog.json` are untouched, which is the point of D1.
- **main-engineer** — `electron/main/services/annotations-file.ts`, `electron/main/services/annotations.ts`, `electron/main/ipc/annotations.ts`, the one registration line in `electron/main/index.ts`, the preload surface.
- **renderer-engineer** — `src/lib/annotations.ts`, `ReaderNotes.tsx`, `SelectionChip.tsx`, the three edits in `ReaderEngine.tsx`/`ReaderView.tsx`/`reader.store.ts`, the `annotation` role in `reader-palette.ts`, one glyph, and `src/types/foliate-js.d.ts` (the declared divergences are renderer-facing).
- **sidecar-engineer** — **nothing.** No sidecar file is added, and that absence is itself a check: the Python suite must come back unchanged.
- **test-author** — the two new service test files and `src/lib/annotations.test.ts`, plus the four extended files.
- **The two invariant docs** — `nas-and-catalog.md`'s layout block and `files-and-deletion.md`'s folder-rules list gain the file **in the slice that lands it**, not in this document, and not by this session.
- **`../musaeum-ios`** — **not touched**, and no slice is dispatched there (D10).

**Footprint against the ~10-file bound:** 7 source files (slice 1) and 9 (slice 2) — inside it per slice, over it as a feature (16 source + 4 new test files + 4 extended), which is why the cut is where it is. The overrun absorber is named in the budget note.

**Gate commands:** `npm run typecheck && npm run lint && npm test`, `sidecar/.venv/bin/python -m pytest sidecar/tests -q` (expected unchanged at **413** — nothing in `sidecar/` is touched), a mutation campaign over slice 1's deciders, and the manual list above. One caveat to carry: **`npm run lint` is red in this working tree for a cause outside the change** — `.delta/worktrees/**`, a locally git-excluded set of worktrees that ESLint's flat config still walks (see the ledger).

## Rejected and deferred, with the condition that would revive them

- **More than one highlight color.** The record carries `color` from day one (D2) and the UI offers exactly one. Revived by a person wanting to distinguish kinds of highlight (a quotation from an objection), which is also when the palette's role table gains its second entry.
- **A per-book "has notes" indicator in the library** (a chip on the card, a badge, a filter facet). Rejected, and not for cheapness: the count would have to enter `catalog.json` — the whole-library rewrite this design exists to keep small — or cost one NAS read per card on the grid's hottest path. Revived by a facet design that reads counts lazily, which is a `catalog.json` question rather than an annotations one.
- **Exporting annotations** (Markdown, JSON, a share sheet). Out of scope, additive, and the file's own shape is already the export. Revived by someone asking to get notes out of Musaeum.
- **Reading the Kindle's own annotations** off a mounted device's `.sdr` sidecars. `device-manager.ts` already skips those folders deliberately (`:92, 639`), and the device's store is the device's. Revived by a spec that means to merge two annotation stores, which is a much larger question than this one.
- **Annotations on the phone, and the wire** — D10.
- **A reflow's source page as the anchor** — D5's reversal.
- **Undo for a deleted highlight.** Deferred: Delete is irreversible in v1, and the gesture is a single row in a panel with the quote still readable off the file. Revived the first time someone deletes one by mistake, at which point the shape is the shelves' own `removeBooks`/`restoreBooks` pair.
- **A bookmark** (`type: 'bookmark'`, a position with no range). The record's `type` member reserves the shape; nothing writes it. Revived by a person asking for a place marker, which is a different gesture from a selection and would need its own affordance.

## Risks, stated plainly

1. **The engine's annotation API fails by throwing, not by missing.** `addAnnotation` destructures `resolveNavigation`'s return, which is `undefined` on failure (`view.js:385, 446-459`), and the engine's own re-add path calls it un-awaited (`:416`). Mitigation is D6's two guards plus a try/catch around every call this feature makes. What would show it: a book whose artifact changed, opened, with no highlight drawn and no console flood — the case AC24 exists for.
2. **A shared per-book file is a last-write-wins store, and the window is one read-modify-write.** The re-read narrows it from "a session" to "one SMB round trip" (D7) and does not close it: two Macs annotating the same book in the same second can lose one. Accepted, named, and not merged — a per-annotation merge needs ids, clocks and a reconcile, which is the portable-decisions machinery and is not warranted by a case that has never occurred.
3. **One NAS write per gesture.** A highlight is a `writeFile` of a few KB over SMB, on the user's own action rather than a page turn. If the share is slow enough that the gesture feels late, the fix is a local echo with the file as the trailing store — which is D1's reversal, and it is named there rather than discovered later.
4. **`ReaderEngine.tsx` grows.** It is already the reader's largest wiring surface (selection, load, relocate, stylesheet, three lifetimes) and slice 2 adds three listeners to it. What would show it: the file crossing ~450 lines, at which point the annotation layer moves to its own module with the engine passing it the `view` — the same shape as the palette's extraction.
5. **Repeated quote text.** A quote that occurs many times in a book is not a unique anchor, which is why the quote is a *second* locator and not the primary one, and why slice 3's confidence rule is the real work. In v1 this risk is inert (the quote is display and context, not resolution) and it becomes live exactly when slice 3 starts.
6. **Invariants held, and the ones not touched.**
   - **Touched, and held:** **2** — nothing new resolves a book file; the new file is skipped by every extension-keyed lookup, and AC2/AC3 pin it. **6** — a settled title still renames *format* files and the new file is not title-derived, so the three rename call sites (`importer.hydrate`, `library:updateBook`, `metadata:resolveConflict`) need no change; AC2 pins it. **8** — business logic in `services/`, the handler thin; AC10 (the existing walk) holds it. **11** — `vendor/` untouched, both divergences declared in `src/types/foliate-js.d.ts`. **12** — a failed annotation read or write is non-fatal to the book: it degrades to "listed, not drawn" or to a named refusal, never to a reader that will not open; AC11 and AC14.
   - **Not touched, and why:** **1** — `metadata.json` stays canonical and `catalog.json` stays derived *from it alone*; this design adds no member to either, so the catalog cannot carry annotations and cannot lose them. **3, 4** — no positional format read and no sort key is added or moved. **5** — reading state's round trip is untouched; annotations are a different record with a different file, and D1 is the reason they need no reconcile. **7** — no list or card geometry. **9** — no new renderer file access; annotations arrive over IPC. **10** — `app.isPackaged` untouched.

## Measurement ledger

**Executed, on this tree (`HEAD` = `4d4b65f`, working copy = `docs/superpowers/specs/2026-10-13-annotations-design.md` + `tasks.md`):**
- `npm run typecheck` → **0**.
- `npm run lint` → **red in this working tree, for a cause outside this change.** All **1,567** problems are `Parsing error: No tsconfigRootDir was set, and multiple candidate TSConfigRootDirs are present`, every one of them on a file under `.delta/worktrees/<id>/musaeum-macos/` — six git worktrees created 2026-10-07…10-09 and excluded through `.git/info/exclude`, which ESLint's flat config does not read (it lists `out/`, `dist/`, `node_modules/`, `sidecar/`, `vendor/**`, `.claude/`, `.obsidian/` — `eslint.config.mjs:14`). `npx eslint . --ignore-pattern '.delta/**'` → **0**. This change touches two `.md` files and no file ESLint parses. **Not fixed here** — see *DECISION NEEDED* in the report.
- `npm test` → **94 files passed, 2012 tests passed, 0 failed**, 3.36 s.
- `sidecar/.venv/bin/python -m pytest sidecar/tests -q` → **413 passed**, 15.25 s.
- **Prettier drift measured, not applied** (the brief forbids running prettier over markdown): `tasks.md` changes **16** lines under `prettier` at `HEAD` and **16** in the working copy — the appended bullet adds **none** — and the corpus's specs are in the same state as this document (`*x*` emphasis): this spec **162**, `2026-09-21-cover-choice-design.md` **166**.

**Read-only — everything the design cites, and nothing was run:** the engine's annotation API, overlayer and Calibre reference layer (`vendor/foliate-js/view.js`, `overlayer.js`, `reader.js`); the reader's engine, store and palette; `shelves-file.ts` / `shelves.ts` as the canonical-file precedent; `book-files.ts`, `book-delete.ts`, `catalog.ts`, `reading-state.ts`, `book-bytes.ts`, `library-sync.ts`; `docs/invariants/{reader,files-and-deletion,nas-and-catalog,settings-and-editing}.md`; `docs/data-contracts.md`; `docs/rest-api.md`; `sidecar/reflow/produce.py`'s stamp; `../musaeum-ios`'s `tasks.md` and its v1 spec's *Not in v1* line. Every `file:line` in this document is from that read, taken 2026-10-12/13.

**Not verified:**
1. That the engine draws an overlay in a **fixed-layout** EPUB (`foliate-fxl` — no paginator, no `setStyles`). Nothing was run; the overlayer attaches per section document rather than through the paginator, which is suggestive and is not evidence. AC24's manual pass includes one book.
2. That `addAnnotation`'s throw on an unresolvable locator is *reachable in practice* rather than only visible in the source (`view.js:385` destructures `resolveNavigation`'s `undefined`, `:446-459`). The source is unambiguous and no case was run; D6's guard assumes it, which is why the guard wraps the call rather than relying on the check alone.
3. The **size and latency** of a real annotations file over the share — the two numbers D1's reversal condition names (`50 ms`, `256 KB`) are read off the file's shape, not measured. Slice 1 should take them on the real library.
4. That the iOS client's Readium has a decorations or anchoring surface a later wire slice could build on (D10's reversal). That repo was read only for its backlog line and its v1 scope, never for its reader.

## Out of scope

There is no export of annotations, to Markdown, to JSON, or to a share sheet. There is no sync of them to a Kindle, no read of a device's own annotation store, and no merge of the two. There is no annotation surface in the iOS client, no annotations member on any wire payload, and no route serving them. There is no deletion undo, no annotation search, and no annotation filtering in the library. There is no note formatting — a note is plain text, and it is stored as it was typed. There is no multi-color highlight, no bookmark, and no per-card indicator that a book has notes. And there is no re-anchoring of a stale locator: slice 2 lists a stale annotation and does not draw it, and finding it again is a spec of its own.
