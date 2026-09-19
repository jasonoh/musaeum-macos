# Plan: Theming slice 7a — the status family in the palette, and the two inversions

**Date:** 2026-09-19
**Slice:** §2.7 of `docs/superpowers/specs/theming.md`, acceptance criteria AC8.1–AC8.3
(staged 7a per the spec's J2)
**Annex to:** `docs/superpowers/specs/theming.md` — this file settles the readings §2.7 left
open. It re-opens no product decision: J1 (derive the status family *and* migrate the sites), J2
(two stages, the bound per stage), J5 (the `gold-200` remedy) and A28 (the `--status-*` names) are
fixed and are cited, not argued.
**Read first:** `CLAUDE.md` #12, `docs/invariants/library-views.md` (row geometry — nothing here may
move it), `docs/invariants/settings-and-editing.md` (`app_config`; nothing here writes it),
`docs/invariants/reader.md` (the reader's own palette is slice 5's and is untouched).
**Priced against the tree at `0481b97`**, working tree clean.

---

## 1. What this slice is

Three things, and the first is what the slice exists for:

1. **The status family becomes part of the palette in the app**, not only in the engine. Slice 2
   landed the *derivation* (`theme/derive.ts` carries `danger`/`ok`/`warn` with their `400`/`500`/
   `600` steps and `on-*` foregrounds, floors enforced and corpus-tested) — A13. What is missing is
   the **wiring**: `tailwind.config.js` has no `danger`/`ok`/`warn` colour names, so `bg-danger-500`
   emits no rule; `src/index.css`'s `:root` has no `--status-*` values, so the built-in default —
   whose token set carries no status family on purpose (A28) — would render status text as
   *nothing*. `src/lib/theme/css.ts` already writes and reconciles the twelve names (A28/A50), so
   nothing is owed there.
2. **The twelve veils migrate** `bg-ink-950/70|80` → `bg-scrim/70|80`, at the same alphas (§1.3 C3's
   twelve sites, §2.7 item 2). On the built-in default this is pixel-identical by construction
   (`--scrim: 13 11 9` is byte-equal to `ink-950`, A5) and on a light theme it is the difference
   between a dialog that recedes and a white wash — measured, §6.
3. **The cover hairline migrates** `ring-white/5` → `ring-parchment/5` at `BookCard.tsx:79` (§2.7
   item 3). `BookDetail.tsx`'s is the **named absorber** and stays for 7b.

**What this slice deliberately does not need** (the sentence that keeps it unblocked): no SQL
migration (`app_config` is `key`/`value`), no IPC change, no new `theme.types` shape, no derivation
change (the family landed with slice 2), no change to `css.ts`, `store.ts`, `useTheme.ts`,
`main.tsx` or the reader, no new dependency, no `any`, and no new file — every file below already
exists.

## 2. What the parent spec already decided (cited, not re-derived)

| Decision | What it fixes for this slice |
|---|---|
| **J2** | 7a is "the `--scrim` and status variables in `src/index.css` and `tailwind.config.js`; the twelve veils and the two hairlines; and every status site **inside the ten files 7a already owns**". Everything else status-shaped is **7b** (the 53-site sweep across the files 7a does not open). |
| **A28** | The names are frozen: `--status-<family>-<step>`, step ∈ {`400`,`500`,`600`,`on`}. 7a cannot invent a different spelling, and cannot add a step. |
| **§2.7 item 4** | The site mapping: `text-red-400`→`text-danger-400`, `bg-red-500`→`bg-danger-500`, `border-red-500`→`border-danger-500`, `bg-red-600`→`bg-danger-600`, `text-white` (on danger fills)→`text-on-danger`, `ring-white` (the two hairlines)→`ring-parchment/5`, `bg-emerald-500`→`bg-ok-500`. |
| **J5** | `gold-200`'s four sites are "their own two-file dispatch". **They are not this slice and not in its file count** — they land immediately after 7a as a separate, separately-reported piece (`tasks.md`'s "fixed by slice 7a" is corrected in place to name the two dispatches). |
| **§2.7's absorber** | `BookDetail.tsx` leaves first: its only change is the hairline at `:83` (the spec's `:81` is stale by two lines) and the cover it wraps already carries `shadow-cover`. |

## 3. The readings §2.7 left open

**D1 — the default's status values are the derivation of a canonical default IR, authored into
`:root` and pinned by a test.** §2.7 says "the `--scrim` and status variables in `src/index.css`"
without saying where the *values* come from, and the two obvious sources both fail:

- **"Keep today's stock values"** (`text-red-400` = `#f87171`, `bg-red-500` = `#ef4444`,
  `text-white`) is not available while satisfying AC8.2: white on `#ef4444` measures **4.4:1**,
  below the family's own 4.5 floor. A whole set of values that cannot hold the floor the criterion
  asserts is a set that fails the slice's own criterion.
- **Copying the prototype's `NATIVE` row** is impossible: it carries `'status': {}`
  (`theme-probe/derive.py:720`) — the prototype never rendered a status family for the shipping
  palette, which is exactly why A28 left `:root` to 7a.

So the values are taken from the **shipped derivation** (`deriveTheme`), run once on a canonical IR
for the app's own palette — `bg`/`border`/`fg`/`muted` = `:root`'s own ink/parchment values, and the
four accents the palette's single amber hue cannot supply authored in the app's warm register:

```
accents: red #e0554a, orange #e08a3c, yellow #d9a441, green #7f9e6a
accent_hint: #d4a24e            variant: dark
```

which derives (measured, `derive-probe.test.ts` on the shipped engine — identical to the prototype's
own output on the same IR):

| | `400` (text step) | `500` (fill) | `600` (deep fill) | `on` |
|---|---|---|---|---|
| `danger` | `#e0554a` | `#e0554a` | `#9e090e` | `#0d0b09` |
| `ok` | `#7f9e6a` | `#7f9e6a` | `#466331` | `#0d0b09` |
| `warn` | `#d9a441` | `#d9a441` | `#915f00` | `#0d0b09` |

Audited by the derivation's own floors: `danger-400` on the panel 5.06 ≥ 4.5, `text on danger-500`
5.21 ≥ 4.0, and the same shape for `ok` (6.37 / 6.55) and `warn` (8.49 / 8.73). *Alternative
rejected:* authoring twelve colours by eye — the only thing that makes them usable is the floors,
and hand-authored values have no reason to hold them. *Alternative rejected:* giving
`MUSAEUM_DEFAULT_TOKENS` a `status` family — A28 says the default carries none because `:root` owns
the values, `applyTokens` removes the twelve names for a set without one, and the authored block is
what that removal re-exposes. *Reversal:* the owner looks at 7a's default-theme frames and wants a
different register — then the four **inputs** move, and the twelve values are re-derived (not
hand-edited).

**A consequence of D1 worth stating, because it looks like a bug and is not:** the family's `400`
and `500` are the **same colour** on this palette (`#e0554a`), because the authored base already
clears both floors and neither walk has anything to do. The prototype's rules are "walk *up* until
the floor holds", not "spread the ramp"; on a palette whose red is already legible the two steps
coincide.

**D2 — a filled danger surface uses the `500` step, because `500` is the step that carries a derived
foreground.** §2.7 item 4 maps `bg-red-600` → `bg-danger-600` *and* `text-white` → `text-on-danger`
— and the two do not compose: `on` is derived as the best foreground **against the 500 fill**
(`derive.py:542`), and `600` is a bare `adjustLight(base, 0.30, false)` carrying no foreground (A17).
Measured on the default palette: `on-danger` `#0d0b09` on `danger-600` `#9e090e` is **1.9:1** — the
three destructive primary buttons would have shipped *less* legible than the `red-600`/`white` pair
they replace (4.6:1), and AC8.2 as literally worded (which audits `on` against `500`) would not have
caught it. So:

- the three `bg-red-600 … text-white` sites become **`bg-danger-500 … text-on-danger`** (5.2:1 on
  the default), and their `hover:bg-red-500` becomes **`hover:bg-danger-500/90`** — the hover has to
  stay on the step whose foreground is floored, and a 90 % fill is a shape this repo already uses
  (`BookCard.tsx:167`).
- `danger-600` remains derived and consumed by nothing in 7a. *Reversal:* an owner who wants the
  deeper destructive fill needs a `600` foreground, which is a `derive.ts` change and therefore a
  slice-2 amendment with its own criteria — not a site edit here.

**D3 — `text-red-300` maps to `text-danger-400`.** `DeleteBookDialog.tsx:108` is a *selected*
destructive option chip (`border-red-400 bg-red-500/30 text-red-300`) and the family has no `300`
(A28). The lightest step it does have is `400`, which is the family's text step; `text-danger-400`
on `bg-danger-500/30` is a fill at 30 % over the dialog panel, so the floor that matters is measured
against the panel — 5.06:1 on the default. *Alternative rejected:* adding a `300` step — A28 froze
the names.

**D4 — the veil alphas do not move.** The migration is a rename (`bg-ink-950/80` → `bg-scrim/80`),
so the twelve veils keep their measured strengths (§1.3 C3). Under the default theme that makes the
migration invisible: `--scrim: 13 11 9` is byte-equal to `ink-950` (A5), measured in the app as
`rgba(13, 11, 9, 0.8)` before and after.

**D5 — the hairline's dark-theme shift is accepted, as §2.7 says, and its *light*-theme half is what
AC8.3 is about.** `ring-white/5` is `rgba(255,255,255,0.05)` over a light surface — measured against
a light theme it composites to a difference under 1 % luminance. `ring-parchment/5` reuses a token
that is *by construction* the tone contrasting with the canvas, so it stays visible in both variants.

**D6 — the honest file count is 10 code files + 1 test, and `src/index.css` is one of the ten by
count but zero by §2.7's convention.** §2.7's table counts `src/index.css` as **0** ("already slice
1's file"). Walking *who writes, who reads, who wires, who proves*:

| # | File | What |
|---|---|---|
| 1 | `tailwind.config.js` | `danger`/`ok`/`warn` (400/500/600) + `on-danger`/`on-ok`/`on-warn` |
| 2 | `src/index.css` | the twelve `:root` status values (D1) — counted 0 by §2.7's row |
| 3 | `SettingsModal.tsx` | veil `:148`; status `:337` |
| 4 | `MigrationWizard.tsx` | veil `:110`; status `:177`, `:274`, `:290` |
| 5 | `ConflictQueue.tsx` | veil `:42` (no status site) |
| 6 | `RemoveFromDeviceDialog.tsx` | veil `:49`; status `:69`, `:82` |
| 7 | `ImportOverlay.tsx` | veil `:130`; status `:88` |
| 8 | `DeleteSelectionDialog.tsx` | veil `:59`; status `:92`, `:96`, `:98`, `:105`, `:125` |
| 9 | `DeleteBookDialog.tsx` | veil `:76`; status `:102`, `:108`, `:142`, `:146`, `:159` |
| 10 | `BookEditor.tsx` | veil `:195`; status `:293`, `:297`, `:353` |
| 11 | `BookCard.tsx` | four veils `:98`, `:114`, `:128`, `:167`; hairline `:79`; status `:167` |
| — | `BookDetail.tsx` | **the absorber, taken**: not in this slice |
| — | `SelectionPanel.tsx`, `ListView.tsx` | **J5's separate two-file dispatch**, not in this slice |
| 12 | `theme/derive.test.ts` | extended: the `:root` status pin (D1) and the family's floors |

Eleven code files touched, **ten by the convention §2.7's own row uses**, plus one test file. That is
at the bound, not over it — and the two things that would put it over (the absorber, J5's pair) are
named and away.

**And two absence assertions in an existing suite invert, both greppable:** `store.test.ts:107`
counts `:root`'s properties — 19 today, **31** after the twelve land (and the comment above it lists
what the 19 are) — and `store.test.ts:149` (`omits the status family (D2)`) keeps passing and must
**not** be relaxed: its subject is `MUSAEUM_DEFAULT_TOKENS`, which still carries no status family,
while `:root` gains the values. A child that "fixes" the count by deleting the assertion has removed
7a's only unit decider for the wiring.

## 4. The migration rule, exhaustively

| Today | Becomes | Where |
|---|---|---|
| `bg-ink-950/70` | `bg-scrim/70` | `ImportOverlay.tsx:130`, `BookCard.tsx:98`, `BookCard.tsx:128` |
| `bg-ink-950/80` | `bg-scrim/80` | the seven modal veils + `BookCard.tsx:114`, `:167` |
| `ring-white/5` | `ring-parchment/5` | `BookCard.tsx:79` (only; `BookDetail.tsx:83` is the absorber) |
| `text-red-400` | `text-danger-400` | 13 sites inside the ten files |
| `bg-red-500` | `bg-danger-500` | 4 sites inside the ten files (incl. `/90`, `/10`, `/30`, `/20`, `/15` alpha forms, which stay) |
| `border-red-500` | `border-danger-500` | `DeleteBookDialog.tsx:102`, `DeleteSelectionDialog.tsx:98`, `BookEditor.tsx:353` |
| `border-red-400` | `border-danger-400` | `DeleteBookDialog.tsx:108` |
| `bg-red-600` + `text-white` + `hover:bg-red-500` | `bg-danger-500` + `text-on-danger` + `hover:bg-danger-500/90` | `DeleteBookDialog.tsx:159`, `DeleteSelectionDialog.tsx:125`, `RemoveFromDeviceDialog.tsx:82` (D2) |
| `text-red-300` | `text-danger-400` | `DeleteBookDialog.tsx:108` (D3) |

**Out of scope, deliberately:** every stock-palette site in a file this slice does not open
(`StatusBar`, `Sidebar`, `BookContextMenu`, `Toasts`, `TransferQueue`, `ConflictResolver`, and
`BookDetail`'s own three) — that is 7b, and its acceptance is the repo-wide grep reaching zero.
`BookCard.tsx:167`'s `hover:text-white` **is** in scope (the file is open and the fill beside it is a
danger fill): it becomes `hover:text-on-danger`.

## 5. Acceptance criteria, and what decides each

| AC | Decider in this slice |
|---|---|
| **AC8.1 — no veil lightens** | **Running app, isolated profile** (the orchestrator's pass, §6): with a light theme active, the Settings modal backdrop's `background-color` composited over the canvas measures an `lstar` **≥ 0.25 below** the canvas's, and a `BookCard` over-cover chip's glyph keeps **≥ 3.0** against the composited chip. Before: **0.0000 below** (both, measured — the veil *is* the canvas). After: the scrim's own composite. |
| **AC8.2 — the status family holds its floors** | **Unit**: the derivation's floors on the canonical default IR (the twelve values of D1) **and** the existing corpus-wide status assertions in `derive.test.ts`; plus the running app's token read: `--status-danger-400` is non-empty on the default (it is empty today) and equals the theme's own derived value on a themed set. |
| **AC8.3 — the hairline is visible on both variants** | **Running app**: the cover ring's resolved `--tw-ring-color` under a light theme and the default — `rgb(255 255 255 / 0.05)` before, `rgb(<parchment> / 0.05)` after. |
| **The migration happened** | `git diff` over the ten files against §4's table (12 veils, 1 hairline, 21 status lines / 26 utility names — §4's "14 `text-red-400`" was one high and its "20 sites" one low, both corrected in place at §8), and the app pass's own class read (`bg-scrim/80` on the backdrop element). |
| **AC7.1's gate** | `npm run typecheck && npm run lint && npm test`, plus `npx prettier --check` on every touched file. |

No unit decider exists for a *class name* (`vitest` has no DOM and no Tailwind build), which is why
the migration's decider is the app pass — the same instrument slice 1 used for the pixel gate.

## 6. The app pass (orchestrator, not the implementer)

On an isolated `MUSAEUM_USER_DATA` profile with the synthetic Obsidian theme of slice 6's pass
(`obsidian:probe-obsidian:light`, canvas `#f5f4f0`) and one imported synthetic EPUB (so a `BookCard`
exists — a coverless fixture renders no `<img>`, and the card is matched by its title text):

| measured | before | after |
|---|---|---|
| backdrop `background-color` (light) | `rgba(245, 244, 240, 0.8)` — **the canvas itself, 0.0000 below** | `bg-scrim/80` over the same canvas |
| chip `background-color` (light) | `rgba(245, 244, 240, 0.7)`, glyph contrast 4.23 | `bg-scrim/70`, composited lstar below the canvas |
| ring (`--tw-ring-color`) | `rgb(255 255 255 / 0.05)` | `rgb(<parchment> / 0.05)` |
| backdrop (default theme) | `rgba(13, 11, 9, 0.8)` | **identical** (D4's promise) |
| `--status-danger-400` (default) | *empty* | `224 85 74` |

Plus frames, before and after, for the Settings modal (the veil) and the grid (the chip).

## 7. What must not move

- `vendor/foliate-js/**`, `src/components/reader/**` (invariant #11).
- Row geometry: `ROW_HEIGHT` / `CARD_META_HEIGHT` / `CARD_META_MARGIN` and any real row's height
  (`invariant` #7) — none of this slice's edits is a geometry class, and the app pass re-measures a
  card's height to prove it.
- `metadata.json`, the database, `app_config`: untouched (no migration, no write).
- `ThemeIr`, `DerivedTokens`, `ThemeTokens`, `THEME_ENGINE_VERSION`: unchanged. `derive.ts` is not
  edited.
- The stored values of every theme already in `theme_library`, and the built-in corpus.
- `MUSAEUM_DEFAULT_TOKENS` — it keeps **no** status family (A28); `:root` carries the values.

## 8. Built — 2026-09-19

Landed as one slice against `0481b97`, implemented by a dispatched `renderer-engineer` child and
**checked by the orchestrator on the returned tree** — gates re-run, campaign re-run, app pass run
by the orchestrator, implementer's claims re-measured rather than relayed.

**Gates** (`typecheck=0`, `lint=0`, `npm test` **852 passed / 36 files** — slice 6's baseline is
849/36, so the new pin added three cases; `npm run build=0`).

**The migration, against §4's table.** `git diff src/components` → **12** `bg-scrim/` lines (the
twelve veils, alphas preserved: seven `/80` modal backdrops, `ImportOverlay` `/70`, the four
`BookCard` chips), **1** `ring-parchment/5`, **21** status lines / **26** utility names. `grep -c -E
"red-|ink-950/|ring-white"` over the nine files returns **0** for every one of them.

**The emitted stylesheet** (`./node_modules/.bin/tailwindcss -c tailwind.config.js -i src/index.css
-o /tmp/tw-7a.css`): `.bg-scrim\/80 { background-color: rgb(var(--scrim) / 0.8) }`,
`.ring-parchment\/5 { --tw-ring-color: rgb(var(--parchment) / 0.05) }`,
`rgb(var(--status-danger-500) / 0.4)` and `/ 0.6` — the alpha-modified forms survive the
`<alpha-value>` form, which is the failure AC1.3 exists for — and **zero** `gold-200` rules.

**Mutation campaign — 3 of 5 killed, and both survivors are the finding, not a nuisance.**

| mutation | result |
|---|---|
| `--status-danger-400` one channel off the derivation | **RED** (1 failed) |
| `--status-warn-on` given parchment (breaks the on/500 floor) | **RED** (1 failed) |
| `--status-danger-600` renamed to `--status-danger-650` (A28's freeze) | **RED** (2 failed) |
| SettingsModal's veil put back on `ink-950` | **GREEN** (61 passed) — no unit decider |
| `tailwind.config.js`'s `danger.400` wired to `--status-danger-500` | **GREEN** (27 passed) — no unit decider |

Every file was restored byte-identically. The two GREEN rows were *expected*: a class name has no
DOM harness and `tailwind.config.js` has none either. Their instruments are the app pass and the
emitted-stylesheet read above — which is exactly why they are recorded rather than tuned away.

**The app pass** (isolated profile, one imported synthetic EPUB so a `BookCard` exists, the light
Obsidian theme of slice 6's pass — the same profile, so the *before* column is the same instrument):

| quantity | before | after |
|---|---|---|
| modal backdrop, light theme | `rgba(245,244,240,0.8)` — the canvas itself, **0.0000 below** | `bg-scrim/80` = `rgba(19,15,8,0.8)` → `#403d36`, **0.6063 below** (criterion 0.25) |
| over-cover chip, light theme | `rgba(245,244,240,0.7)`, glyph contrast 4.23 | `bg-scrim/70` → `#130f08`, **0.7958 below**, glyph **4.106 ≥ 3.0** |
| backdrop, default theme | `rgba(13,11,9,0.8)` | **identical** (D4's promise) |
| `--status-danger-400`, default theme | *empty* | `224 85 74`, the authored `:root` value; the family's floors 5.21 / 4.99 (danger), 6.55 / 6.28 (ok), 8.73 / 8.37 (warn) |
| cover ring, light theme | `rgb(255 255 255 / 0.05)` → contrast vs surface **1.0049** | `rgb(43 36 23 / 0.05)` (the theme's own parchment) → **1.0975**, an 18× lstar delta |
| cover ring, default theme | `rgb(255 255 255 / 0.05)` → 1.1009 | `rgb(233 225 210 / 0.05)` → 1.0859 (the shift §2.7 named) |
| selected-row tick (the `gold-200` defect) | `rgb(125,114,96)`, an inherited `parchment-faint` | `rgb(232,201,135)` = `gold-300` |
| geometry (invariant #7) | — | `tr` **37 px** (`style: 36px` + the 1 px collapsed border), card **146×294** = cover 218 + `CARD_META_MARGIN` 8 + `CARD_META_HEIGHT` 68 — unchanged |

**Deviations and escalations, each decided here (the implementer's `## Escalate` list is work items,
not footnotes):**

1. **Two more `19 → 31` counts existed than the dispatch named.** `store.test.ts` was named;
   `derive.test.ts` and `css.test.ts` each carry their own `:root` property-count assertion and both
   would have gone red. Updated with a one-line comment each, nothing else touched. The lesson is the
   instrument: *grep the count, not the file* — a budget that names one file's absence assertion
   misses its siblings, and `toHaveLength` vs `toBe` hid them from the first grep.
2. **`prettier --check` cannot go green on the touched set — and could not before this slice.**
   Measured by the orchestrator rather than taken on report: `MigrationWizard.tsx`, `BookEditor.tsx`,
   `BookCard.tsx` and `derive.test.ts` are **prettier-dirty at `HEAD`**
   (`git show HEAD:<f> | prettier --stdin-filepath <f>` reproduces the same hunks) and the residue
   sits in regions this slice did not touch (JSX prose reflow, unrelated loops). `npm run lint` is
   eslint-only, which is the repo's gate; the two hunks this slice introduced are formatted. The
   alternative — `prettier --write` over the four — reformats unrelated hunks inside a diff whose
   decider is §4's table.
3. **§4's tallies were approximate; its per-site rows were not.** 13 `text-red-400` sites (not 14 —
   the fourteenth red text site is `DeleteBookDialog.tsx:108`'s `text-red-300`, which has its own D3
   row) and 21 status lines / 26 names (not "20 sites"). Corrected in place at §4/§5, and every row
   matched a real site.
4. **`ok` ships wired but unconsumed, and the `600` step with it.** §2.7 item 4's
   `bg-emerald-500 → bg-ok-500` has no site inside the ten (its only occurrence is `Sidebar.tsx:22`,
   with its `bg-red-500` twin at `:25`) — so both go to **7b**, as does every stock site in
   `StatusBar`, `BookContextMenu`, `Toasts`, `TransferQueue`, `ConflictResolver` and
   `BookDetail.tsx`. `danger-600`/`ok-600`/`warn-600` are derived and declared and used by nothing
   yet: D2's recorded cost.
5. **J5's `gold-200` fix landed as its own two-file dispatch, after the ten** — per J5's own wording,
   and it is where this slice stops being ten files. `SelectionPanel.tsx:94`, `ListView.tsx:89`,
   `:208` → `text-gold-300`; `ListView.tsx:212` → `bg-gold-400`. `gold-300` is the ramp's
   *readable-on-a-tint* end by construction (`mix(acc, fg, 0.30)`: the light end on a dark canvas,
   the dark end on a light one), which is the argument for that step rather than `gold-400`. Measured
   live, above.
6. **The honest counts, replacing §3 D6's.** 7a's own set is **10 code files by §2.7's convention**
   (`src/index.css` counted 0) — 11 files actually edited; **3 test files**, not 1 (`derive.test.ts`
   extended, `store.test.ts` and `css.test.ts` each a one-line count) because the absence assertions
   live in three places; and J5's 2 files after it. So the session touched **13 code files**: at the
   bound for the slice, over it once J5's separate dispatch is added, and recorded rather than
   absorbed.

**Still owed after this slice** (carried to `tasks.md`): 7b's sweep; `BookDetail.tsx`'s hairline (the
absorber); the `*-600` step with no consumer; and the two GREEN campaign rows' instruments remain a
running-app pass rather than a gate.
