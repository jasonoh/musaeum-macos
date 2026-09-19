# Design: In-book search (S1 — reader)

**Date:** 2026-09-19
**Status:** Proposed — not yet reviewed with Jason
**Scope:** searching the text of the book currently open in the reader (EPUB, MOBI, AZW3).
**Depends on:** the reader, shipped 2026-08-13 (`specs/2026-08-13-native-reader-design.md`)
**Interacts with:** theming slice 5 (reader convergence) — see D4
**Supersedes:** the `search-in-book` line in the C1 spec's "Out of scope" list
(`2026-08-13-native-reader-design.md:280-284`), which named it and left it in tasks.md without a design.

---

## Why now

`search-in-book` has sat in tasks.md as an open item since the reader shipped, on a list of
"deliberately out of C1" features that each got a reason except this one: annotations wait on a
storage decision, per-book typography is a preference not a need, and search-in-book was simply
deferred (the C1 spec says only that each _"stays in tasks.md rather than growing this build"_).

It is the cheapest remaining feature with real daily value, because **the engine already
implements it**. `vendor/foliate-js/view.js:542` exposes a public `async * search(opts)` that
walks the book's text, returns one result per hit with a CFI and an excerpt, and draws its own
inline highlights. Nothing in `vendor/` has to be edited (invariant 11), so S1 is a UI, a store
slice, and a generator loop — not a search implementation.

Three properties make it unusually cheap for the value:

1. **No index, no schema, no migration.** Hits are computed on demand from the book that is
   already open. No FTS table, no sidecar call, no `metadata.json` change.
2. **No NAS I/O at all.** `open()` already fetched the whole file into a `Blob`
   (`ReaderEngine.tsx:163-171`), so every search result comes out of the in-memory container.
   Search therefore works offline, on a dropped share, and with no latency attributable to SMB.
3. **The navigation already exists.** A hit is a CFI, and `goTo(cfi)` is exactly what the TOC
   panel already calls (`ReaderView.tsx:214`) and what position restore already calls
   (`ReaderEngine.tsx:181`). Jumping to a result is a solved problem in this codebase.

It is also the _only_ thing on the analysed "missing" list that is unspecified, cheap, and
load-bearing for the reading loop. Its expensive twin — a library-wide index of book _contents_
— is explicitly rejected in D1.

---

## What the engine actually gives us

Read off the vendored commit, not off upstream's docs (same discipline as
`src/types/foliate-js.d.ts`).

```js
async * search(opts) // view.js:542
```

**Options:** `query` (required); `index` (a section index — omit to search the whole book);
`draw` (defaults to `Overlayer.outline`); `drawOptions` (`{color, width, radius}`);
`matchCase`, `matchDiacritics`, `matchWholeWords`, `defaultLocale`, `acceptNode`.

**It yields three different shapes, interleaved** (`view.js:530-577`):

| Yield            | When                              | Shape                                            |
| ---------------- | --------------------------------- | ------------------------------------------------ |
| progress         | once per section, whole-book mode | `{ progress }` — `(index + 1) / sections.length` |
| a section's hits | once per section that has any     | `{ label, subitems: [{ cfi, excerpt }] }`        |
| terminator       | last                              | the bare string `'done'`                         |

- `label` is the TOC label for that section and **may be an empty string**
  (`view.js:564`, `#tocProgress.getProgress(index)?.label ?? ''`).
- `excerpt` is `{ pre, match, post }`, already trimmed to ~50 characters either side with
  ellipses added (`search.js:6-21`).
- The consumer **must discriminate on shape** — `typeof result === 'string'` is the end.

**Behaviour worth knowing before designing the UI:**

- `search()` calls `this.clearSearch()` on entry (`view.js:543`), so exactly one search is live
  at a time and starting a new one erases the previous highlights.
- Hits are stored as annotations under the `foliate-search:` prefix and **re-added on every
  section render** (`view.js:415-416`), so they stay outlined while you read on rather than
  vanishing as you page. This is free and is a AC1.5.
- `clearSearch()` (`view.js:579-583`) deletes them; `close()` drops the whole map
  (`view.js:303`).
- Whole-book mode calls `createDocument()` for **every section sequentially**, which is why
  progress streams. This is the one real cost, and it is why D2 and D3 exist.
- Matching is grapheme-based by default and switches to `Intl.Segmenter` for whole-word or
  variant/accent-sensitive matching (`search.js:103-109`), with a `simpleSearch` fallback when
  `Intl.Segmenter` is unavailable.

---

## Design

### Where it lives

A `ReaderSearch` panel occupying the **same side-panel slot** as `ReaderToc`
(`ReaderView.tsx:214`), and the same store pattern as the other two panels: session state,
never persisted (`reader.store.ts:100-103`, `176-179`).

Store additions (all session-only):

```
searchOpen: boolean
query: string
searching: boolean          // a run is in flight
progress: number            // 0..1 while searching
results: SearchGroup[]      // [{ label, hits: [{ cfi, excerpt, index }] }]
activeCfi: string | null
```

Actions: `toggleSearch()`, `setQuery()`, `setSearchState()`, `clearSearch()`.

**TOC and search are mutually exclusive** — opening one closes the other, the same rule
`closePrefs` already implies for the popover. Two panels fighting for one slot would need a
layout decision this feature does not warrant (D7).

### Running a search

- **Trigger: submit (Enter or a Go control), not per keystroke.** Every run loads every
  section document; a keystroke-triggered search would fire a full book scan per character and
  cannot be usefully abandoned mid-flight (D2).
- **Whole-book only**, `index` omitted, which is the well-tested yield path. Per-section search
  is a different shape (`{cfi, excerpt}` with no `label`, `view.js:525-528`) and buys nothing
  here (D3).
- **Cancellation is a token, not an abort.** The generator has no `AbortController`; breaking
  the `for await` loop stops it. Every new search, panel close, and reader close increments a
  `searchToken` ref and breaks the live loop first. This is the same guard shape as
  `ReaderEngine`'s `disposed` flag (`ReaderEngine.tsx:138`, `151-152`, `198-199`) and it is
  **load-bearing rather than defensive**: because `search()` calls `clearSearch()` on entry, a
  second run's highlights are deleted by a third run, and a stale generation writing into the
  store would show hits for a query that is no longer displayed. AC1.13 and a dedicated case.

### Results

- Grouped by section in **book order** (the engine yields sections in spine order).
- Group header: `label || 'Part N'` — the fallback matters, because a book with no TOC labels
  yields groups with an empty label and a wall of blank headers is worse than no grouping.
- A hit row shows `excerpt.pre` + emphasised `excerpt.match` + `excerpt.post`, with the group's
  hit count in the header.
- Clicking a hit: `goTo(hit.cfi)`, set `activeCfi`, keep the panel open so the next hit is one
  click away (matching the TOC panel's behaviour of closing on navigate is _not_ wanted here —
  a search user is stepping through matches, not going somewhere once).
- Progress: while `searching`, reuse the existing thin gold progress-bar idiom for the search
  progress. The count of hits found so far is shown as it grows.
- Zero hits: an explicit "No matches" line, not an empty panel (AC1.10).

### Highlight colour

`drawOptions.color` is passed to `Overlayer.outline` (`view.js:544`, `overlayer.js:142-158`),
which builds an SVG that lives in foliate-view's closed shadow root inside the **app's**
document — not the book's iframe.

**D4: the colour comes from the reader's own palette table as a resolved literal.** The table is
`PALETTE` in `ReaderEngine.tsx:48-51`, whose comment already says it must stay in step with
`tailwind.config.js`. Two consequences the implementation must respect:

- Theming slice 5 makes that table derived. If S1 lands first, **slice 5 must add the search
  highlight colour to its derivation list** — otherwise a themed app outlines search hits in a
  hardcoded amber. This is recorded as a hand-off in both directions.
- Pass a literal, never `var(--…)`. This matches slice 5's constraint for the book-document
  stylesheet and avoids betting on custom-property inheritance across a closed shadow boundary
  (which would probably work, and is exactly the kind of "probably" this repo refuses to ship
  on). `ReaderEngine.tsx:104`'s `background: ${c.link}44` alpha-suffix concatenation is the
  existing precedent for what slice 5 has to clean up, not a pattern to extend.

An `Overlayer.highlight` fill exists as an alternative draw (`overlayer.js:126-141`, with
`--overlayer-highlight-opacity` hooks). Rejected for v1: `outline` is the engine's own default
and reads well over both page themes without tuning opacity per theme.

### Keyboard and the native menu

- **⌘F is a menu command, not a keydown handler.** The reader's own handler returns early on any
  modifier (`ReaderView.tsx:99`), and the repo's established rule is that a menu item and its
  in-app control share one code path: the menu owns the accelerator, the renderer decides what
  the action means (`services/menu.ts`, `useMenuCommands`, `MenuCommand` in `api.types.ts:46`).
  So: add `'reader-find'` to the `MenuCommand` union, a Find item to the reader-relevant menu
  section, and a case in `useMenuCommands` that calls `toggleSearch()` — a **no-op when no book
  is open**, so ⌘F over the library does nothing rather than opening a panel with no book
  behind it (AC1.1).
- **Typing is already safe.** `isTypingTarget(e.target)` is in the reader's bail-out
  (`ReaderView.tsx:100`), so arrows and space inside the search input will not page the book
  underneath. That guard is why the input can live inside the overlay without a special case.
- **Esc precedence needs a new arm.** The existing chain gives the prefs popover ownership of
  every key while it is open, so Escape dismisses the panel rather than the book
  (`ReaderView.tsx:105-110`). Search needs the same treatment: with a query entered, Esc clears
  the results; with the panel empty, Esc closes the panel; with no panel, Esc closes the reader
  (AC1.6).
- Enter in the input runs the search; with results already showing, Enter jumps to the next hit
  from the active one.

### Reading position

**D5: jumping to a hit is reading, so it updates the stored position.** `goTo` fires `relocate`
→ `onRelocate` → the existing 2s-debounced `saveProgress` (`ReaderView.tsx:13`, `71-79`). Nothing
new is needed, and the alternative — suppressing position writes while the panel is open —
would surprise in the other direction: read on from a hit, quit, and lose the location.

The honest consequence is recorded as AC1.9: searching for something in chapter 3 and jumping
there moves your resume point to chapter 3. That is the semantics of every other reader that
implements find.

### What is never persisted

No query, no results, no `activeCfi`. Reopening a book starts with an empty panel, matching
"which book was open does not survive a restart" (`reader.store.ts:176-179`). D6.

---

## Out of scope

- **Library-wide content search** (a text index over all 7,000 books). See D1.
- **PDF.** The reader has no PDF engine until C2; PDF opens in Preview today, so there is
  nothing to search. When C2 lands, the find command's availability follows the engine's own
  ability — the spec does not pre-decide pdf.js search behaviour.
- **Annotations and highlights as saved artefacts.** S1 uses the engine's transient search
  annotations, which vanish on `clearSearch()` and are never written to `metadata.json`. Saved
  highlights still wait on the storage decision the C1 spec named.
- Search history, regex, replace, result export, a hit-count badge on library cards.
- **Fixed-layout (FXL) books:** search should still find text, but the overlayer's geometry on
  a pre-paginated page is unverified. To be measured during implementation, not assumed —
  recorded as an open question rather than a promise.

---

## Decisions

**D1 — In-book search only; a library-wide content index is rejected.**
The attractive-sounding version (Calibre's full-text search across the whole library) is not
this feature scaled up. It needs full text extracted from 7,000 books (~50 of them PDFs, some
image-heavy enough to need OCR to be honest), an index in the gigabytes, invalidation on every
import/replace/delete, and either the index on the NAS — defeating the local-cache design that
keeps SMB writes cheap — or a long rebuild per new machine. It also duplicates the one Calibre
feature that stays available for exactly this need.
_Rejected:_ building it, on the grounds that it is where the real "find a passage" need lives.
_Reversal:_ Jason stops keeping a Calibre index around **and** hits the library-wide need
several times a month. The trigger is measured annoyance, not the feature's plausibility.

**D2 — Submit-triggered, not live-as-you-type.**
A whole-book run loads every section document. Debouncing does not help: each keystroke's run is
a full scan that has to be abandoned, and an abandoned run's partial highlights are already on
screen (they clear only when the next `search()` starts).
_Rejected:_ debounced progressive search, which feels faster on a short book and is visibly
wrong on a long one.
_Reversal:_ if a per-section path is ever added (`index` set), live search within the _current
section_ becomes cheap and can be revisited — that is a different feature, not a tuning of this
one.

**D3 — Whole-book only.**
The whole-book yield path is the one with `label` and `progress`; the per-section path yields a
different shape and no chapter context. One code path, one set of cases.
_Rejected:_ "search this chapter" as a second mode.
_Reversal:_ a book in the library where whole-book search is too slow to be usable _after_ the
progress/cancel UX is measured.

**D4 — Highlight colour from the reader palette, as a literal.**
_Rejected:_ a `var(--gold-400)` reference resolved by the app's CSS, betting on custom-property
inheritance into foliate-view's closed shadow root. Probably works; unverifiable by unit test;
and it would leave the colour outside slice 5's derivation.
_Reversal:_ if slice 5 lands first and its derived table already carries a search/selection role,
use that value directly and this decision becomes a no-op.

**D5 — Search-jump writes the reading position.**
_Rejected:_ suppressing position writes while the panel is open, which needs a new flag threaded
through `onRelocate` and loses the location for anyone who reads on from a hit.
_Reversal:_ if a session ends up with a stored position the reader never actually displayed
(measurable in `metadata.json`), revisit.

**D6 — Results are transient, never persisted.**
_Rejected:_ writing hit CFIs to `metadata.json` as a search history or as pseudo-annotations.
Book records are deliberately small, and the C1 spec already flagged unbounded growth as the
reason highlights need a decision first.
_Reversal:_ the annotation storage decision lands _and_ asks for search history — at which point
it is that feature, not this one.

**D7 — The panel shares the side slot with the TOC, one at a time.**
_Rejected:_ a second simultaneous panel (needs a layout decision and eats reading width), and a
floating drawer (a new overlay idiom for one feature).
_Reversal:_ a real need to cross-reference a TOC entry against a search result in the same
session.

---

## Acceptance criteria

Checkable, each with the instrument that decides it.

- **AC1.1** ⌘F with a book open focuses the search input; ⌘F with no book open does nothing
  (no panel, no error). _Instrument:_ menu command routing case + live.
- **AC1.2** Typing in the search input does not page the book; arrows/space page the book when
  focus is anywhere else. _Instrument:_ live, both directions.
- **AC1.3** A query with N>0 hits yields N result rows, grouped under their section labels, in
  spine order. _Instrument:_ pure reducer case from a recorded yield sequence + live.
- **AC1.4** Clicking a hit moves the display to that hit's CFI, marks it active, and leaves the
  panel open. _Instrument:_ live, measured against the rendered text at that CFI.
- **AC1.5** After a search, paging forward through the book keeps hits outlined. _Instrument:_
  live (this is the engine's `#searchResults` re-add, not our code — it still has to be seen).
- **AC1.6** Esc with a query showing clears the results; Esc with the panel open and empty
  closes the panel; Esc with no panel closes the reader. _Instrument:_ live, all three.
- **AC1.7** Closing the panel (or a new search) removes every outline from the page.
  _Instrument:_ live.
- **AC1.8** Nothing about the search survives close/reopen — no query, no results.
  _Instrument:_ store partialize case + live.
- **AC1.9** Jumping to a hit updates the stored reading position once the debounce fires, visible
  in the book's `metadata.json`. _Instrument:_ live, read the file back.
- **AC1.10** A query with zero hits shows an explicit "No matches" state. _Instrument:_ live.
- **AC1.11** The `overlaid` guard still wins: a modal opened over the reader with the search
  panel open takes the keyboard (typing in Settings does not search the book). _Instrument:_
  live.
- **AC1.12** `npm run typecheck` (0), `npm run lint` (0), `npm test` green; and
  `git status --porcelain vendor/` is empty — the engine was used, not patched (invariant 11).
- **AC1.13** A stale generation cannot write into the store: given two overlapping runs, only
  the later one's results are displayed. _Instrument:_ unit case on the token guard (this is the
  case that would otherwise be found by a user typing Enter twice).
- **AC1.14** A mid-run abort leaves the book readable and pageable, and a subsequent search
  works. _Instrument:_ live — this is the unverified part of the engine (what happens when a
  consumer breaks out of `search()` mid-iteration), so it is measured rather than assumed.

---

## Testing

**vitest (renderer-side pure logic — the new module is the point):**
The loop is extracted into `src/lib/reader-search.ts` with no React and no DOM, so it can be
tested directly:

- shape discrimination over a recorded yield sequence (progress / group / `'done'`), including
  a sequence that ends without `'done'`;
- the empty-label fallback;
- grouping and book-order preservation;
- the token guard (AC1.13);
- clear-on-close and clear-on-new-run.

The engine itself is deliberately not unit-tested — it is vendored and locked (invariant 11).
The extraction exists so that the _logic we own_ has a case, which is the same split
`reading-state.ts` uses (policy in a testable service, mechanics in the app).

**Manual (live, on the real library):**

- The longest book in the library with a query expected to have thousands of hits ("the"), to
  measure the worst case for D2/D3.
- An azw3 and a mobi, not just an EPUB.
- A book whose TOC has no labels (the `label` fallback).
- An aborted run mid-flight (AC1.14).
- Poetry or a heavily-marked-up book, where per-text-node matching behaves differently.
- One fixed-layout book, to answer the open question rather than assume it.

**Deliberately not covered:** PDF (no engine until C2), and the OS-level dictionary or system
find behaviour, which this feature does not touch.

---

## Implementation notes (routing for a cold session)

**Read first, per `CLAUDE.md`'s table:**

- `docs/invariants/reader.md` — the reader's rules, `musaeum://book`, position tiers.
- `docs/invariants/selection-and-keyboard.md` — keyboard precedence is decided here; the reader
  joins the same "who owns the keyboard" list.
- `docs/invariants/library-views.md` — only for the `MenuCommand` path if the menu item touches
  the library's own shortcuts.

**Invariants at risk:** #11 (never edit `vendor/`) is the one to watch — if the engine turns out
not to support something S1 needs, the answer is a divergence in our code or in
`src/types/foliate-js.d.ts`, never a patch to vendor. #9 is untouched (no new renderer file
access). #12 applies to the search loop: a failed run reports and leaves the reader usable.

**Ownership:** `renderer-engineer` for everything except the menu item, which is
`main-engineer` + `renderer-engineer` touching `services/menu.ts` and `useMenuCommands.ts`
together — one slice, because a menu item without its renderer case is a dead shortcut.

**Expected footprint: 10 code files, at `CLAUDE.md`'s ~10-file bound.**

| File                                     | Change                                                       |
| ---------------------------------------- | ------------------------------------------------------------ |
| `src/lib/reader-search.ts`               | new — the loop, the token guard, the reducer (pure)          |
| `src/lib/reader-search.test.ts`          | new — the cases above                                        |
| `src/components/reader/ReaderSearch.tsx` | new — panel, input, groups, progress, empty state            |
| `src/components/reader/ReaderView.tsx`   | panel slot, Esc precedence arm, find-command case            |
| `src/components/reader/ReaderEngine.tsx` | export the palette/its search-highlight colour for the panel |
| `src/stores/reader.store.ts`             | session search state + actions + mutual exclusion with TOC   |
| `src/components/shared/icons.tsx`        | one search glyph (hand-rolled SVG set, no icon library)      |
| `electron/main/services/menu.ts`         | the Find item + ⌘F                                           |
| `src/types/api.types.ts`                 | `'reader-find'` in the `MenuCommand` union                   |
| `src/hooks/useMenuCommands.ts`           | route `'reader-find'` → `toggleSearch()`                     |

Any eleventh file is named as forced (the A30/A41 precedent in `tasks.md`), not absorbed
silently. `docs/invariants/reader.md` gains the search rules once they land — documentation is
not counted in the bound but is owed by the slice that changes the invariants.

**Gate before hand-back:** `npm run typecheck`, `npm run lint`, `npm test`, plus the live
manual list above with the measurements recorded in the CHANGELOG entry (this is the first
visible reader feature since C1, so it earns one).

**Suggested sequencing:** land S1 as one slice. Do not attempt it in the same slice as theming
slice 5 — they both edit `ReaderEngine.tsx`'s palette table, and D4's hand-off is easier to
verify when only one of them is moving.
