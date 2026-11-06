# Design: The reader's contrast guard

**Date:** 2026-11-05
**Status:** Draft — awaiting Jason's approval. The approach (a computed-color contrast check per section that overrides only offenders) was chosen by Jason on 2026-11-05; everything marked *my call* below is the author's and unreviewed.
**Scope:** `src/` only — the reader's injected page styling. No main-process, sidecar or schema change.
**Depends on:** `docs/invariants/reader.md` (typography and page theme), `docs/superpowers/specs/theming.md` slice 5 (AC5.6, AC5.7, A55).
**Amends:** AC5.6 — "the book's own typography still wins" — by one named exception: a text color the reader cannot read.

---

## Why

*The Shadow Docket* (Basic Books, InDesign export) sets `color:#000001` on every paragraph style in `OEBPS/css/idGeneratedStyles.css`. The reader injects its stylesheet **without `!important`** on purpose (AC5.6), so the book's color beats ours, and on the `ink` and `auto` themes the text is near-black on near-black (`#14110d`): contrast ≈ 1.1:1, unreadable. Only the `paper` theme works, and only because the page turns light. Headings inside links stay legible because `a { color }` is forced. This is not a broken file: black text hardcoded by a publisher's export is common, and the reader had no answer for it.

## Goals

- A book whose text color is illegible against the page it is drawn on becomes legible, on every theme, with no user action.
- A book's deliberate color use survives: colored callouts, a light box with dark text inside a dark page, muted-but-readable captions, a red warning word. Only text that fails a contrast floor is touched.
- Switching theme with a book open re-evaluates, so the guard follows the page (the same obligation `ReaderSearch` documents in `reader.md`).

## Non-goals / anti-goals

- **Not a dark mode for books.** No inversion, no filter, no forcing `color` on everything. A fix that flattens every book's color is a failure even if it makes this book readable.
- **Not background repair.** The guard changes text color only, never a book's `background`. A book with a dark `background-image` under dark text, or text over a cover image, is out of scope (the effective background cannot be computed from CSS alone).
- **No change to `vendor/foliate-js/`** (invariant 11), to CFIs, to `sectionText`, or to search/annotation/voice drawing.
- **No user setting.** If the guard proves wrong for some book, that is a follow-up, not a toggle on day one.

## The design

**D1 — A pure decision module, and a thin DOM pass.** `src/lib/theme/reader-contrast.ts` holds the decisions with no DOM: parse a computed `rgb()/rgba()` string, WCAG relative luminance, `contrastRatio(a, b)`, and `legibleColor(textRgb, bgRgb, palette)`. The DOM pass (`guardSectionContrast(doc, palette)`) is a separate function that takes the document and the resolved `ReaderPalette`. The split exists for the reason `reader-palette.ts` gave: the rule has to be decidable under vitest, and `ReaderEngine.tsx` cannot be imported there. *My call: the DOM pass lives in the same directory, takes `getComputedStyle` from `doc.defaultView`, and is tested against a stubbed computed-style source (no jsdom in this repo — see the calls below).*

**D2 — The floor is 3:1.** *My call.* WCAG's AA for body text is 4.5:1, but this guard exists to rescue the unreadable, not to restyle the merely dim: a publisher's mid-grey caption on a dark page often sits between 3 and 4.5, and touching it overrides a deliberate choice for little gain. `#000001` on `#14110d` is ≈1.1; on `solarized` or any other dark theme it is similar. One named constant, `CONTRAST_FLOOR = 3`, so it is a one-line decision to move.

**D3 — The effective background is walked, not assumed.** For each text-bearing element, take its computed `color`, then climb ancestors to the first computed `background-color` with alpha > 0 (partially transparent colors are composited over what is beneath them, down to the page). If the chain ends with nothing opaque, the background is `palette.bg` — **not** the document's computed body background, so the result does not depend on whether the injected stylesheet has been applied yet when the section's `load` fires. A `background-image` is ignored (non-goal).

**D4 — Only elements that own text are examined, and only offenders are changed.** An element is examined if it has a direct, non-whitespace text node child; its children are examined on their own. That keeps the pass proportional to text elements, not to the DOM, and means a failing parent whose children set their own legible colors is not painted over them.

**D5 — The replacement is the page's own foreground, or the better of fg/bg when that fails locally.** An offender gets `palette.fg`. If `palette.fg` also fails the floor against *that element's* effective background (a light callout box on a dark page, with its text forced light), take whichever of `palette.fg` and `palette.bg` has the higher ratio against it. *My call:* a pair of known colors keeps the page on-theme and avoids computing an arbitrary contrast-fixing color.

**D6 — The override is an inline `!important`, marked and reversible.** `el.style.setProperty('color', value, 'important')` plus a `data-musaeum-contrast` attribute (a flag, plus the element's prior inline `color` if it had one — see the calls below). Inline `!important` is the one thing that beats a book's own `!important` and its specificity, and the marker lets a re-run clear exactly the overrides it made before recomputing, so a theme change from dark to paper restores the book's original color instead of leaving our dark-theme override behind. This is the only `!important` the feature adds, and it is on offenders only — AC5.6's "no `!important` in the injected stylesheet" still holds, because the stylesheet is untouched.

**D7 — When it runs.** On every foliate `load` event (`ReaderEngine.tsx`, the existing handler at the section-load site), and again for every still-attached section document whenever the restyle effect applies a new palette (`ReaderEngine.tsx`, the effect keyed on `[prefs, tokens]`) — *after* `setStyles`, so the re-run sees the new page. The engine keeps a set of live section docs for that; stale ones (no `defaultView`) are dropped on use and the set is emptied at teardown. A typography-only change (size, line height) does not alter colors, so *my call:* the re-run is keyed on the resolved palette, not on every pref.

**D8 — Failure is silent and local.** A color the parser cannot read, a `getComputedStyle` that throws, a detached document: that element (or section) is skipped and the book keeps its own color. The guard never throws out of the `load` handler (invariant 12 in spirit: a reader nicety must not stop a book from opening).

## Calls settled after the builder check

The check found nothing blocking; these three were small enough to decide here. All are *my calls*.

- **No jsdom.** Vitest runs with `environment: 'node'` and jsdom is not installed, and adding it is not this slice's to do. The DOM pass therefore takes its computed-style source as a parameter (defaulting to `doc.defaultView.getComputedStyle`), and AC2–AC6 run against a stub. The source walk (AC8) and the live check (AC9, AC10) cover the real-document wiring the stub cannot.
- **Clearing restores, not just removes.** An element that already had an inline `color` before the guard touched it gets that value (and priority) back when overrides are cleared; the marker attribute records it. Otherwise a theme switch would delete a book's own inline color.
- **A translucent text color is composited first.** A text color with alpha below 1 is composited over the effective background (D3's chain) before its contrast is measured, the same rule D3 applies to backgrounds.

## What the builder owns

- File and test layout beyond D1's two names; whether to use jsdom (D1).
- The exact text-node and element filtering (skip `script`, `style`, `svg`, `noscript`, hidden elements).
- Whether to batch work across frames for a very large section (measure first; a typical section is a few thousand elements and should be one synchronous pass well under 16 ms of style work — if it is not, say so and propose chunking rather than shipping jank).

## Acceptance criteria

| # | Case | Decided by |
|---|---|---|
| AC1 | `contrastRatio` is correct on known pairs (black/white = 21, equal colors = 1) and `#000001` on `#14110d` is below `CONTRAST_FLOOR`. | vitest, pure module |
| AC2 | An element whose computed color fails the floor against `palette.bg` gets `palette.fg` and the marker; one that passes is untouched (no inline style, no marker). | vitest, DOM pass |
| AC3 | Dark text inside an element with an opaque light `background-color`, on a dark page, is **not** modified. | vitest, DOM pass |
| AC4 | Light forced text on a light callout, on a dark page, gets the better of `fg`/`bg` (D5). | vitest, DOM pass |
| AC5 | Re-running under a light palette clears the previous overrides and leaves a book-colored element at its own color (D6 reversibility). | vitest, DOM pass |
| AC6 | An unparsable color or a throwing `getComputedStyle` leaves the element and the rest of the section untouched and throws nothing (D8). | vitest |
| AC7 | The injected stylesheet is unchanged: `readerPageCss` output is byte-identical and AC5.6's existing decider still passes. | existing `reader-palette.test.ts` |
| AC8 | `ReaderEngine.tsx` calls the guard from the `load` handler and from the restyle effect after `setStyles` (a source walk, as AC5.1 was decided). | vitest source walk |
| AC9 | **Live, on the real book:** open *The Shadow Docket* on the default theme; the body text renders in the page foreground, not near-black (sampled pixels in the text rows are light, not within a few units of the page). Switch to `paper`: text is dark on light, as before. Switch back with the book still open: legible again with no reopen. | `verify` skill, CDP + screenshot |
| AC10 | The same live check on one book with deliberate color (any book with a colored callout or a light box) shows that element unchanged. | `verify` skill |

Each unit criterion names its mutation in the plan, per the repo's mutation-killed convention (e.g. flip `<` to `>` in the floor test; drop the marker cleanup; read the document's body background instead of `palette.bg`).

## Documentation

`docs/invariants/reader.md` gains one paragraph after the page-theme paragraph: the guard, the floor, why the effective background falls back to `palette.bg`, why inline `!important` on offenders is compatible with AC5.6, and the re-run obligation on a palette change. `docs/superpowers/specs/theming.md` AC5.6 gets a one-line pointer to this document. `CHANGELOG.md` gets an *Added* entry in the user's terms ("Books that hard-code black text are now readable on dark pages").

## Known limits

- Text over a `background-image`, or inside an SVG/canvas, is not examined.
- A book that sets a *light* background on `body` with dark text keeps it only as far as `readerPageCss`'s own `body { background }` lets it; this guard does not change that.
- A mid-contrast color between 3:1 and 4.5:1 is left as the publisher wrote it (D2).
