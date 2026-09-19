# Plan: Theming slice 5 — reader convergence and the light flip

**Date:** 2026-09-19
**Slice:** §2.5 of `docs/superpowers/specs/theming.md`, acceptance criteria AC5.1–AC5.8
**Annex to:** `docs/superpowers/specs/theming.md` (this file settles what §2.5 leaves open; the
spec's amendment trail gains the round-5 entry when the slice lands)
**Read first:** `docs/invariants/reader.md` (the reader, its injected page CSS,
`vendor/foliate-js/` never edited, `z-[45]`, reading position), `docs/invariants/settings-and-editing.md`
(`app_config`, persisted UI state), `docs/invariants/library-views.md` (computed row geometry),
`docs/invariants/menu-and-branding.md` (the menu is built once), `CLAUDE.md` #8/#9/#11/#12.

---

## 1. What this slice is

Two coupled halves, landed in this order because the second is what makes the first *correct on a
light theme* rather than merely themed:

1. **Reader convergence** — `ReaderEngine.tsx`'s hand-copied `PALETTE` (`:63-66`) stops being a
   fork and becomes **derived** from the active theme's tokens, under §2.5's two hard constraints
   (resolved literals only, no alpha suffix pasted onto a value). `ReaderPrefs.theme` gains
   `'auto'` and defaults to it.
2. **The light flip** — `--shadow-a1/a2/a3` and `color-scheme` stop being authored in `src/index.css`
   and become **derived and written by the apply path**; the platform's own chrome
   (`nativeTheme.themeSource`) and the window background follow the active theme on every change,
   not only at boot.

**This slice owes `search`.** `2026-09-19-reader-search-design.md`'s D4 added a `search` role to the
engine's table (S1 built 2026-09-19, `src/components/reader/ReaderEngine.tsx:64-65`) precisely so
that this slice has a name to derive — "a colour that is not named here is one slice 5 cannot
carry". It is derived here (§3, D1). That spec's own note is the hand-off this slice is paying.

**Already built, and built on by this slice:** `theme/store.ts` (resolve → validate → one-transaction
write, `getThemeView`, `windowBackgroundColor`, `activeTheme`), `src/lib/theme/css.ts`
(`tokensToCssVars` / `applyTokens`, which deliberately owns **28** names and *not* the four §2.5 gives
this slice — `css.test.ts:78,142-153,322-364` asserts that inversion and those assertions are **this
slice's to invert**), `src/main.tsx` (pre-paint apply) and `src/hooks/useTheme.ts` (apply on change).

## 2. The readings §2.5 left open (D-series)

**D1 — `search` is the *derived link colour*, threaded as its own palette field.** Today `search ===
link` in both rows (`ReaderEngine.tsx:64-65`), and on the default theme the derived `link` is
`gold-400`, so keeping them equal is what makes the default path a visual no-op (AC5.2's property).
It stays a **named field** of the palette rather than a second read of `link` at the call site: that
is the whole reason S1 gave the role a name. *Reversal:* a palette whose derived `gold-400` reads
badly as a hit outline over its own page — then `search` earns a rule of its own in `derive.ts`,
which is a slice-2 change, not a reader one.

**D2 — the page mapping is `ink-900` / `parchment` / `parchment_dim` / `gold-400`**, verbatim from
§2.5, and the book's own `color-scheme` comes from the palette, not from `prefs.theme`.
`pageCss()`'s current `prefs.theme === 'paper' ? 'light' : 'dark'` becomes
`palette.scheme`, resolved from `tokens.dark` on the `auto` route. Measured: those four derived
values equal today's `ink` row on the built-in default (`--ink-900: 20 17 13` → `#14110d`,
`--parchment: 233 225 210` → `#e9e1d2`, `--parchment-dim` → `#b3a78f`, `--gold-400` → `#d4a24e`),
which is AC5.2's no-op and is asserted, not assumed.

**D3 — the palette is a pure module; the store read stays in the components that already read it.**
`src/lib/theme/reader-palette.ts` exports the two authored rows (`ink`, `paper` — the literals that
exist today, kept because two of the three options are *authored* rows, not derived ones), the pure
`readerPalette(tokens)`, and the pure `resolveReaderPalette(theme, tokens)`. It imports **nothing
from `@/stores`**: the reader's components read `useThemeStore`'s active tokens themselves, exactly
where they already read the reader store. This keeps the derived rules testable with no DOM and no
store seeding. *Rejected:* a `useReaderPalette` hook in the same file — it would put a store import
inside the module whose tests are the slice's instrument.

**D4 — the derived shadows are written by the apply path, from `tokens.shadow`.**
`aN = clamp(0, 1, baseN × shadowStrength / 0.55)` with `base = { a1: 0.5, a2: 0.35, a3: 0.6 }`
(§2.5, product decision 4's bridge, already pinned by A24's `shadow === 0.55` assertion). The
alphas **and `color-scheme` join `OWNED_CSS_VARS`** — so a theme switch reconciles them like every
other property and the "stale 12 `--status-*`" class of bug cannot reappear here. `:root` keeps its
authored values as the default for the frame before JS runs (`src/index.css:31-35`).

**D5 — `tailwind.config.js` is not touched.** It already composes the shadow classes over
`var(--shadow-aN)` (`:53-56`); this slice only *writes* those variables. §5's row said "…
+ `tailwind.config.js` if the shadow vars are touched" — they are already variables, so it is not.

**D6 — native appearance is a *pure decision* in the theme service and *wiring* in the composition
root.** `nativeScheme(tokens): 'light' | 'dark'` lives in `services/theme/store.ts` beside
`windowBackgroundColor` and is decided by its unit test; `electron/main/index.ts` applies it at boot
and again on every theme change. The change signal is `services/events.ts`'s own broadcast, via a new
in-process `subscribe(fn)` registry — the same event the renderer listens to, so "what is active"
has one path and the window cannot drift from the renderer. *Rejected:* putting the two lines in
`ipc/theme.ts`'s handler (a handler is a thin wrapper, `CLAUDE.md` #8) and a second broadcast channel
(two sources of truth).

**D7 — the popover's third option is a two-tone swatch.** `ReaderPrefsPopover.tsx:44-53` branches
`o.value === 'ink' ? 'bg-ink-950' : 'bg-parchment'`, which would render `auto` as `paper`'s dot. The
third arm is a half-and-half dot (ink over parchment) — a token-only composition, no new colour.

**D8 — the stage-5a/5b cut is sequencing, not scope.** The reader half (the derived palette + the
engine + the `search` role) lands first as its own coherent, testable piece; the flip follows in the
same session. Both halves are §2.5 and the slice is not done until both are in, because a light theme
without D4/D6 is a light app with dark shadow alphas and dark native chrome — the state
`tasks.md:452-453` records as shipping together in this stream.

## 3. Files

| # | File | Owner | What |
|---|---|---|---|
| 1 | `src/lib/theme/reader-palette.ts` | renderer-engineer | **new**: the two authored rows, `readerPalette(tokens)`, `resolveReaderPalette(theme, tokens)`, `linkAlphaHex` (D1/D2/D3) |
| 2 | `src/lib/theme/reader-palette.test.ts` | renderer-engineer | **new**: AC5.2's no-op, the derived mapping, AC5.8's composed literal |
| 3 | `src/components/reader/ReaderEngine.tsx` | renderer-engineer | `PALETTE` deleted; `pageCss(prefs, palette)`; `scheme` from the palette; `searchHighlightColor` deleted (the role moves to the palette) |
| 4 | `src/components/reader/ReaderSearch.tsx` | renderer-engineer | `:96`'s colour comes from the palette (D1) |
| 5 | `src/stores/reader.store.ts` | renderer-engineer | `theme: 'auto' \| 'ink' \| 'paper'`, default `auto`, `THEME_OPTIONS` extended in the same edit as `sanitizePrefs`' validator |
| 6 | `src/components/reader/ReaderPrefsPopover.tsx` | renderer-engineer | the third swatch (D7) |
| 7 | `src/lib/theme/css.ts` | renderer-engineer | `--shadow-a1/a2/a3` + `color-scheme` owned and derived (D4) |
| 8 | `src/lib/theme/css.test.ts` | renderer-engineer | invert the four slice-5 negations + pin the derived alphas |
| 9 | `src/stores/reader.store.test.ts` | renderer-engineer | AC5.3's both-halves case |
| 10 | `electron/main/services/theme/store.ts` | main-engineer | `nativeScheme(tokens)` (D6) |
| 11 | `electron/main/services/events.ts` | main-engineer | in-process `subscribe(fn)` |
| 12 | `electron/main/index.ts` | main-engineer | boot `themeSource` + on-change `themeSource` and `win.setBackgroundColor` |
| 13 | `electron/main/services/theme/store.test.ts` | main-engineer | `nativeScheme`'s two arms |
| 14 | `test/mocks/electron.ts` | main-engineer | `nativeTheme` in the mock (additive) |

**9 code + 4 test files (the mock is shared infra), one-to-three over `CLAUDE.md`'s ~10-file bound.**
§5's slice-5 row says 6 code + 2 test and misses four of these — `css.ts` (D4's writer; the same
undercount A30 found on slice 3, where the apply path was not in the row either), `ReaderSearch.tsx`
(D1's consumer), `events.ts` and the mock (D6's wiring). The named absorber
(`reader-palette.ts` + its test folding into `css.ts` + `css.test.ts`) is **not** taken: it would
put the reader's colour vocabulary in a file about CSS variables, and both halves are inside the
bound on their own. Recorded rather than absorbed silently, as A30 and A36 were.

## 4. Acceptance criteria, and what decides each

| AC | Decider in this slice |
|---|---|
| AC5.1 — the reader follows the app theme | unit: `readerPalette(lightTokens)` differs from the `ink` row in all four colours; plus `pageCss`'s output asserted to contain **no `var(`** and no `PALETTE`-sourced literal after the change (a source walk on `ReaderEngine.tsx`: no `PALETTE`), plus the live frame |
| AC5.2 — the default is a no-op | unit: `readerPalette(MUSAEUM_DEFAULT_TOKENS)` equals the `ink` row exactly (D2's measured literals) and equals what `:root` carries |
| AC5.3 — an unknown pref falls back | unit: `sanitizePrefs({theme:'sepia'})` → `'auto'`, `sanitizePrefs({theme:'ink'})` → `'ink'` (an old stored value keeps its meaning); **`theme` is absent from the persisted shape's non-defaults** in the export-single source of truth the store already exposes |
| AC5.4 — shadows are derived | unit: light tokens (`shadow: 0.16`) → `0.145/0.102/0.175`; dark (`0.55`) → `0.5/0.35/0.6`; and the four names appear in `OWNED_CSS_VARS` (the inversion of `css.test.ts:78`) |
| AC5.5 — native appearance agrees | unit: `nativeScheme({dark:true})==='dark'`, `{dark:false}==='light'`; the *wiring* by a source walk on `main/index.ts` naming the two call sites, with the residual that `nativeTheme.themeSource` is not observable over CDP in this build (the A25 pattern) |
| AC5.6 — the book's typography still wins | `git diff` on `pageCss`'s rules: no `!important` added; `z-[45]` untouched (`git diff --quiet` on the class), `vendor/**` untouched |
| AC5.7 — resolved literals, no variable references | unit: `pageCss(palette)`'s string contains no `var(` and every interpolated colour matches `^#[0-9a-f]{6}$` on a non-default theme; live: the book document's `getComputedStyle(body).backgroundColor` is a resolved `rgb(…)` |
| AC5.8 — the selection colour is a composed literal | unit: `::selection { background: #<six hex>44; }` with the six digits equal to the derived link; mutation: paste `${c.link}44` back — the case must redden |
| AC5.5's owed sibling (`tasks.md:519-522`) — the window background follows a *change*, not only boot | source walk naming `win.setBackgroundColor(…)` on the `themeChanged` path, plus the live check that the call is reached (window-resize flash is the only visible form; recorded as a residual rather than claimed as a frame) |

## 5. What must not move

- `vendor/foliate-js/**` (invariant #11); `pageCss` keeps its unprefixed rules and the reader keeps
  `z-[45]`; `sanitizePrefs` keeps sanitizing; nothing about a search or a reading position changes
  what is persisted.
- Row geometry: `ROW_HEIGHT` / `CARD_META_HEIGHT` / `CARD_META_MARGIN` and `BookCard`'s DOM.
- The native menu: no theme item (`invariants/menu-and-branding.md`).
- `src/main.tsx` and `src/hooks/useTheme.ts`'s contract (the pre-paint read and the guarded apply).
- Number of owned CSS names: 28 → 32 (+3 shadow alphas + `color-scheme`), and the 12 `--status-*`
  names stay slice 7a's.
- No new dependency, no migration, `index.html`'s CSP untouched, no `any`.

## 6. Verification plan (orchestrator, independent of the implementers' reports)

1. `npm run typecheck && npm run lint && npm test`, plus `npx prettier --check` on the touched files.
2. Mutation checks, one per criterion with a test decider: swap the page mapping to `ink-950`
   (AC5.2), hardcode the shadow alphas in `src/index.css` and stop writing them (AC5.4), paste the
   alpha suffix back / emit `var(--gold-400)` into `pageCss` (AC5.7/AC5.8), widen `THEME_OPTIONS`
   without the validator (AC5.3), force `nativeScheme` to a constant (AC5.5).
3. Live pass on an isolated `MUSAEUM_USER_DATA` profile, driven over CDP: with a **light** theme
   active, open a book and read the book document's resolved `body` background and `color`, the
   `::selection` rule, the paginator's own background, and `documentElement.style.colorScheme`; then
   switch to a dark theme with the book open and read them again (nothing may require closing the
   book). Screenshots as evidence.
4. Pre-merge review against the invariants list (read-only).
5. Docs: `docs/invariants/reader.md` (the two-named-rows paragraph — owed by slice 5 per §4),
   `CHANGELOG.md`, `tasks.md` (slice 5 landed + the debts this creates), and the spec's amendment
   round 5 in place.

## 7. Built — 2026-09-19

Landed as one slice, both halves, in the order §2's D8 set (the reader first, the flip on top of
it). The spec's amendment round 5 carries the full trail (A46–A53); what belongs here is what the
*annex itself* got wrong or left open:

- **§3's file 2 could not be written as specified.** The annex told `reader-palette.test.ts` to
  import `MUSAEUM_DEFAULT_TOKENS` from `electron/main/services/theme/store`; `tsconfig.web.json`
  includes `src/**` and `test/**` only, so that import is a `TS6307` plus 13 `TS2307`s for the
  inlined `*.yaml?raw` corpus, i.e. a red `typecheck`. The test reconstructs the default set from
  `src/index.css`'s `:root` instead, and `theme/store.test.ts`'s existing pin keeps
  `MUSAEUM_DEFAULT_TOKENS` against that same block. The chain is two links rather than one; the
  criterion still reddens on the `ink-950` mutation, and the hole is carried in `tasks.md` rather
  than papered over.
- **§3's file count was 4 short** (9 code + 4 test landed, not 6 code + 2 test; §2.5's own row was
  corrected at its site). The missing four are named in A53; the named absorber was not taken,
  because the reader's colour vocabulary does not belong in the CSS-variable apply path.
- **§3's file 3 grew.** `pageCss` moved out of `ReaderEngine.tsx` and into the palette module with
  the palette, and `ReaderEngine` resolves through refs on the open path so a theme change while a
  book is loading colours the page it is about to show rather than re-opening the book. That was
  the one reading of D3 the annex left implicit.
- **The live pass found the flip working on a signal the annex had not named**:
  `prefers-color-scheme` in the renderer follows `theme.set` (false→true→false across two
  switches with the OS unchanged), which is a stronger decider for AC5.5 than the source walk the
  AC table proposed — and it was found by looking for a cross-process consequence rather than by
  reading the code. `win.setBackgroundColor`'s own effect remains the declared residual.
- **Recorded, not fixed:** `subscribe` in `services/events.ts` has no unit decider of its own
  (its only subscriber is `main/index.ts`, which is unimportable under vitest), and the popover's
  two-tone `Auto` dot is a judgement call rather than a measured choice. Both are in `tasks.md`
  as the slice's hand-on debt.

**Repair round (same day, after the read-only pre-merge review).** The review found no blocking
findings and ten worth-fixing items; all ten are closed in the tree (the spec's round-5 repair
block, A54–A59). Two of them were this annex's own fault and belong named here: **§4's AC table
promised a source walk over `ReaderEngine.tsx` for AC5.1 and no test mentioned the component at
all**, and §7's first live figure for the search colour measured the *fixture's link line* rather
than the hit outlines — the link colour and the search role are the same colour by design, which is
exactly why the fixture had to lose its link before that measurement meant anything. Both are
corrected in the spec; the walk now exists, the colour is measured on a hit-only fixture, and the
one thing the review could only reason about — that hits already on screen keep the colour of the
run that drew them — turned out to be true, was measured (1,780 px orange on a page that had gone
dark), and is fixed in `ReaderSearch.tsx` with a re-run keyed on the resolved colour.
