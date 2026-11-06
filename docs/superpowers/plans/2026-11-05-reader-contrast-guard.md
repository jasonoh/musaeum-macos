# Reader Contrast Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Text a book colors illegibly against the themed page (e.g. InDesign's `#000001` on `#14110d`) is overridden with a legible color, on every theme, without touching deliberate color.

**Architecture:** A pure module (`reader-contrast.ts`) decides contrast and the replacement color; a DOM pass in the same file walks a section document with an injectable computed-style source and writes marked, reversible inline `!important` overrides on offenders only. `ReaderEngine.tsx` calls it from the foliate `load` handler and from the restyle effect after `setStyles`.

**Tech Stack:** TypeScript strict, React, vitest (`environment: 'node'`, no jsdom), vendored foliate-js (never edited).

**Spec:** `docs/superpowers/specs/2026-11-05-reader-contrast-guard-design.md` (approved 2026-11-05). Read `docs/invariants/reader.md` before Task 3.

## Global Constraints

- `CONTRAST_FLOOR = 3` — one named exported constant (spec D2).
- Effective background falls back to `palette.bg`, never the document's computed body background (D3).
- Overrides are `el.style.setProperty('color', value, 'important')` plus attribute `data-musaeum-contrast`; the injected stylesheet (`readerPageCss`) stays byte-identical (D6, AC7).
- `vendor/foliate-js/` is never edited (invariant 11). No `any` types. No `file://`. Failure is silent and local; nothing throws out of the `load` handler (D8).
- Run tests only via `npm test`; keep `npm run typecheck && npm run lint` clean.
- Prose in `.md` files is not hard-wrapped.

## Review Focus

- A text color with alpha < 1 (composited over the background first).
- An element that already had an inline `color`: clearing must restore it with its priority, not delete it.
- A theme switch dark → light → dark: no stale override from the previous palette.
- `rgb()`/`rgba()` strings with spaces, percentages-free but decimal alpha (`rgba(0, 0, 0, 0.5)`), and `transparent` / `rgba(0, 0, 0, 0)` backgrounds in the ancestor chain.
- Whitespace-only text nodes, `script`/`style`/`svg` subtrees, and elements with no `defaultView` (detached doc).

---

### Task 1: The pure contrast module

**Files:**
- Create: `src/lib/theme/reader-contrast.ts`
- Test: `src/lib/theme/reader-contrast.test.ts`

**Interfaces:**
- Consumes: `ReaderPalette` from `./reader-palette` (`bg`, `fg` as `#rrggbb`).
- Produces (all exported):
  - `type Rgba = { r: number; g: number; b: number; a: number }`
  - `const CONTRAST_FLOOR = 3`
  - `parseCssColor(value: string): Rgba | null` — accepts computed `rgb(r, g, b)` / `rgba(r, g, b, a)` (comma or space syntax) and `#rrggbb`; `null` for anything else, including `transparent`.
  - `compositeOver(top: Rgba, bottom: Rgba): Rgba`
  - `contrastRatio(a: Rgba, b: Rgba): number` — WCAG 2.x relative-luminance ratio, symmetric, ≥ 1.
  - `legibleColor(text: Rgba, bg: Rgba, palette: Pick<ReaderPalette, 'fg' | 'bg'>): string | null` — `null` when `text` (composited over `bg` if translucent) already meets `CONTRAST_FLOOR`; otherwise `palette.fg`, or when `palette.fg` also fails against `bg`, whichever of `palette.fg`/`palette.bg` has the higher ratio (D5).

- [ ] **Step 1: Write the failing tests** in `reader-contrast.test.ts`: `contrastRatio` of black/white is 21 (±0.01) and of equal colors is 1 (AC1); `#000001` on `#14110d` is `< CONTRAST_FLOOR` (AC1); `parseCssColor('rgba(0, 0, 0, 0.5)')` gives `a: 0.5`, `parseCssColor('rgb(0 0 0)')` parses, `parseCssColor('transparent')` and `'garbage'` are `null`; `legibleColor` returns `null` for `#e9e1d2` on `#14110d`; returns `'#e9e1d2'` for `#000001` on `#14110d`; on a light callout bg `#f3ece0` with light text `#e9e1d2` under the ink palette it returns `'#14110d'` (AC4); a translucent `rgba(233,225,210,0.1)` on `#14110d` is treated as offending (composited first).
- [ ] **Step 2: Run to verify it fails.** Run: `npm test -- src/lib/theme/reader-contrast.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement the module** per the signatures above. Luminance uses the sRGB linearization (`c/255 <= 0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`). Use `hexOrNull`-style strictness for palette hexes: a palette value that is not `#rrggbb` makes `legibleColor` return `null` (leave the book alone).
- [ ] **Step 4: Run to verify it passes.** Same command — Expected: PASS.
- [ ] **Step 5: Mutation check (the repo's convention).** Flip the floor comparison (`<` ↔ `<=` at the boundary pair, or `<` ↔ `>`), and make `legibleColor` skip compositing; confirm each reddens at least one test, then restore. Record the mutations in the commit body.
- [ ] **Step 6: Commit** — `git add src/lib/theme/reader-contrast.ts src/lib/theme/reader-contrast.test.ts && git commit -m "feat(reader): pure contrast decisions for the page guard"` (end with the repo's attribution line).

---

### Task 2: The DOM pass with reversible overrides

**Files:**
- Modify: `src/lib/theme/reader-contrast.ts`
- Test: `src/lib/theme/reader-contrast.test.ts`

**Interfaces:**
- Consumes: Task 1's exports.
- Produces:
  - `type ComputedSource = (el: Element) => { color: string; backgroundColor: string }`
  - `guardSectionContrast(doc: Document, palette: Pick<ReaderPalette, 'bg' | 'fg'>, computed?: ComputedSource): void` — default `computed` is `doc.defaultView.getComputedStyle`; clears this module's earlier overrides in `doc` first (restoring any saved inline `color` and its priority), then examines each element that has a direct non-whitespace text-node child, skipping `script`, `style`, `svg`, `noscript` and anything inside them; computes the effective background by climbing to the first ancestor whose `backgroundColor` parses with `a > 0` (composited over what lies beneath, down to `palette.bg`); sets the override when `legibleColor` returns a color. Never throws: a per-element failure skips that element, a section-level failure skips the section.
  - `const CONTRAST_ATTR = 'data-musaeum-contrast'` (exported so tests and the source walk can name it).
- The stub in tests builds a tiny fake document: objects exposing `childNodes` (with `nodeType`/`textContent`), `parentElement`, `tagName`, `style.setProperty/getPropertyValue/getPropertyPriority/removeProperty`, `getAttribute/setAttribute/removeAttribute`, and `querySelectorAll('*')` returning the elements in document order. Keep the fake in the test file.

- [ ] **Step 1: Write the failing tests** against the fake: a `#000001` paragraph on a transparent chain under the ink palette gets `color: #e9e1d2` with `!important` and the marker (AC2); a passing element has no inline style and no marker (AC2); dark text inside an ancestor with opaque `rgb(243, 236, 224)` background is untouched (AC3); light-on-light callout gets `#14110d` (AC4); running again with the paper palette on the same doc clears the first run's overrides and leaves `#000001`-on-paper alone (AC5); an element with a prior inline `color: red` has exactly `red` (and its priority) back after a re-run that no longer overrides it; a `computed` that throws on one element leaves that element untouched and still fixes its sibling, and `guardSectionContrast` does not throw (AC6); an unparsable color string is skipped (AC6); whitespace-only text and an element under `<svg>` are not examined.
- [ ] **Step 2: Run to verify it fails.** Run: `npm test -- src/lib/theme/reader-contrast.test.ts` — Expected: FAIL (`guardSectionContrast` not exported).
- [ ] **Step 3: Implement `guardSectionContrast`** per the interface. The marker's value stores the prior inline `color` and priority as `JSON` (`{ v: string, p: string }`) or the empty string when there was none; clearing reads it back with a guarded `JSON.parse`.
- [ ] **Step 4: Run to verify it passes.** Same command — Expected: PASS.
- [ ] **Step 5: Mutation check.** Replace `palette.bg` in the fallback with the document body's computed background; drop the marker cleanup at the top of the pass; stop restoring the saved inline color; confirm each reddens a named test, then restore. Record them in the commit body.
- [ ] **Step 6: Commit** — `git add src/lib/theme/reader-contrast.ts src/lib/theme/reader-contrast.test.ts && git commit -m "feat(reader): guardSectionContrast, a reversible per-section pass"`.

---

### Task 3: Wire it into the reader

**Files:**
- Modify: `src/components/reader/ReaderEngine.tsx` (the `load` handler at ~396; the restyle effect at ~523-527; the teardown at ~499)
- Test: `src/lib/theme/reader-palette.test.ts` (extend the existing source-walk `describe` that reads `ReaderEngine.tsx`, near line 435) or a new `src/components/reader/reader-contrast-wiring.test.ts` if that file is already crowded — follow the existing style that reads the source with `readFileSync`.

**Interfaces:**
- Consumes: `guardSectionContrast`, `resolveReaderPalette` (already imported at line 27).
- Produces: a `liveDocs` ref (`useRef<Set<Document>>`) holding section documents seen by `load`; entries with no `defaultView` are dropped on use; the set is cleared in the book effect's cleanup. No new exports.

- [ ] **Step 1: Write the failing source-walk test (AC8):** `ReaderEngine.tsx` imports `guardSectionContrast` from the module; the `load` handler's body calls it with the `doc` it was given; the restyle effect calls it **after** `renderer?.setStyles?.(` (assert index ordering within the effect's text); the book effect cleanup clears the live set. Also assert `readerPageCss` output is untouched by running the existing AC5.6 `!important` assertion (AC7 — it must already pass; do not weaken it).
- [ ] **Step 2: Run to verify it fails.** Run: `npm test -- src/lib/theme` — Expected: FAIL on the new walk only.
- [ ] **Step 3: Implement the wiring.** In `load`: register `doc` in `liveDocs` and call `guardSectionContrast(doc, resolveReaderPalette(prefsRef.current.theme, tokensRef.current))` inside a try/catch that swallows (D8) — before the `if (disposed) return` so ordering with the existing listeners is preserved. In the restyle effect: after `setStyles`, resolve the palette once and re-run the guard over every attached doc in `liveDocs`. Per D7, key the re-run on the **resolved palette's `bg`/`fg`/`scheme`**, not on every pref: compute them in the effect and skip the loop when unchanged since the last run (a ref holding the last `bg|fg` string).
- [ ] **Step 4: Run to verify it passes.** Run: `npm test` — Expected: whole suite PASS; then `npm run typecheck && npm run lint` — Expected: 0 errors.
- [ ] **Step 5: Mutation check.** Move the effect's guard call above `setStyles`; remove the `load` call; confirm the source walk reddens, then restore.
- [ ] **Step 6: Commit** — `git add src/components/reader/ReaderEngine.tsx src/lib/theme/ && git commit -m "feat(reader): run the contrast guard on section load and on palette change"`.

---

### Task 4: Live verification, docs, changelog

**Files:**
- Modify: `docs/invariants/reader.md` (one paragraph after the page-theme paragraph, line ~51), `docs/superpowers/specs/theming.md` (one-line pointer at AC5.6, line ~716), `CHANGELOG.md` (an *Added* entry under `[Unreleased]`)

- [ ] **Step 1: Run the `verify` skill** against an isolated instance with *The Shadow Docket* (`01476af5-570a-4736-9201-9109312573e1`; EPUB at `/Volumes/books/musaeum/books/01476af5-570a-4736-9201-9109312573e1/The Shadow Docket.epub`, copy it into the isolated library — do not touch the real profile). On the default theme, screenshot the open book and sample text-row pixels: they must be light, not within a few units of the page (AC9). Switch to `paper`, then back, with the book open: legible in both with no reopen (AC9). Open one book with a colored callout or light box and confirm it is unchanged (AC10; if no such book is on hand, say so rather than claiming it). Report the sampled values.
- [ ] **Step 2: Write the docs.** `reader.md`: the guard, `CONTRAST_FLOOR = 3`, why the background falls back to `palette.bg` (no dependence on stylesheet timing), why inline `!important` on offenders is compatible with AC5.6 (the stylesheet is untouched), and the re-run obligation on a palette change. `theming.md`: one line at AC5.6 pointing to the spec. `CHANGELOG.md`: "Books that hard-code black text are now readable on dark pages" in the user's terms, with the 2026-11-05 find (*The Shadow Docket*).
- [ ] **Step 3: Final gate.** Run `npm run typecheck && npm run lint && npm test` — Expected: all green. Then dispatch the repo's `reviewer` agent against the diff (it names the invariants; hand it `docs/invariants/reader.md` and the spec path), and fix what it reports.
- [ ] **Step 4: Commit** — `git add docs CHANGELOG.md && git commit -m "docs(reader): the contrast guard"`.
