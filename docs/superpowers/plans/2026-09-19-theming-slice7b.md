# Plan: Theming slice 7b — the status sweep, and the walk that keeps it swept

**Date:** 2026-09-19 **Slice:** §2.7 of `docs/superpowers/specs/theming.md`, the **second stage** (7b, per J2) — the sweep of the stock-palette sites the bounded stage did not open. Its own acceptance is **AC8.4** (grep-to-zero); it **completes AC8.2** (§2.7's status half: the sites, not the derivation) and **AC8.3** (the second hairline). **Annex to:** `docs/superpowers/specs/theming.md` — this file settles the readings §2.7 left open for 7b. It re-opens no product decision: J1 (derive the family *and* migrate the sites), J2 (two stages), J5/J6, A28 (the frozen names) and A69 (a filled danger surface uses `500`) are cited, not argued. **Read first:** `CLAUDE.md` #12, `docs/invariants/library-views.md` (row geometry — nothing here moves it), `docs/invariants/refresh-feedback.md` (the toast surface `Toasts.tsx` is), `docs/invariants/conflicts-and-series.md` (`ConflictResolver`), `docs/invariants/reader.md` (the reader's palette is slice 5's and is untouchable), `docs/invariants/settings-and-editing.md` (`app_config`; nothing here writes it), `docs/invariants/files-and-deletion.md` (`BookDetail`'s delete entry points). **Priced against the tree at `7b6ee3c`** (7a committed and pushed), working tree clean.

---

## 1. What this slice is

Three things:

1. **The sweep.** Every remaining stock-palette colour utility in the renderer's source moves onto the status family: **27 utility names on 15 lines across 8 files** (measured, §4 — the parent spec's "53 sites / 16 files" is the *pre-7a* inventory of the whole class, D6). The families (`danger`/`ok`/`warn`, `400`/`500`/`600`, `text-on-*`) and the twelve `:root` values already exist; this slice names them.
2. **`BookDetail.tsx:83`'s hairline** migrates `ring-white/5` → `ring-parchment/5`, discharging J2's named absorber — the one site §2.7 held back, now free because the file is open for its three danger sites anyway.
3. **A source walk in the gate** (`src/lib/theme/palette-scan.test.ts`) so AC8.4's "grep reaching zero" is a property of the repo rather than of one session's shell (D7).

**What this slice deliberately does not need** (the sentence that keeps it unblocked): no SQL migration (`app_config` untouched), no IPC change, no `preload` change, no new token, no change to `derive.ts`, `theme.types.ts`, `store.ts`, `css.ts`, `useTheme.ts`, `main.tsx`, `index.html` (its CSP included) or the reader, no new dependency, no `any`, and no consumer for the `*-600` steps (A75 still stands for those). Nothing under `electron/` changes.

## 2. What the parent spec already decided (cited, not re-derived)

| Decision | What it fixes for this slice |
|---|---|
| **J1 / J2** | The status family is derived *and* the sites migrate; the class is staged, 7a bounded (ten files) and 7b the remainder. 7b is the sweep, not a second design. |
| **§2.7 item 4** | The mapping: `text-red-400`→`text-danger-400`, `bg-red-500`→`bg-danger-500`, `border-red-500`→`border-danger-500`, `bg-emerald-500`→`bg-ok-500`, both hairlines →`ring-parchment/5`. |
| **A28** | The names are frozen at `--status-<family>-<step>`, step ∈ {`400`,`500`,`600`,`on`}. No `300`, no new step, no new spelling. |
| **A69** | A *filled* danger surface uses the `500` step and `text-on-danger`, and its hover is `bg-danger-500/90`. **No site in this sweep is a filled danger surface** (D3), so no site here takes `on-danger` — the four `text-white` sites were 7a's. |
| **A75** | `ok` ships wired but unconsumed, and `bg-emerald-500`'s only site is `Sidebar.tsx:22`. This slice is where that consumer lands (D4). |
| **AC8.3** | "the cover ring at `BookCard.tsx:79` **and `BookDetail.tsx:81`**" — 7a decided the first; the second is here, and the spec's line number is stale by two (D5). |
| **A72** | A class name has no unit decider. That stays true of the DOM; D7 changes what *is* decidable — whether the name is present at all. |

## 3. The readings §2.7 left open

**D1 — `SelectionPanel.tsx` is the ninth file, and neither the spec's row nor `tasks.md`'s 7b entry names it.** 7a's §4 recorded `SelectionPanel.tsx` as "**J5's** separate two-file dispatch, not in this slice" — and that dispatch was the `gold-200` *ramp* fix, which left its danger sites standing: `:93` (four names), `:127` (three), `:133` (one) — **8 of the 27 remaining names**, on the selection panel's per-device *retry*, its "Delete N books…" and its offline note. A grep-to-zero criterion written without it is false at the moment it is written. *Alternative rejected:* taking the owner's file list as the scope — the list is the *starting inventory* the 7b bullet carries, and the acceptance is repo-wide by the bullet's own wording. The lesson is the one 7a's A74 already learned from the other direction: **grep for the artifact, not for the inventory row.** *Reversal:* none; the file has no other change here.

**D2 — the alpha-modified forms migrate on the migrated name, and no alpha moves.** `border-red-500/60` → `border-danger-500/60`, `bg-red-500/10|/15|/20` → `bg-danger-500/…`. 18 of the 27 names carry an alpha, and the `<alpha-value>` composition has to survive them: 7a's emission read proved `/ 0.4` and `/ 0.6`; this slice's proves `/10`, `/15`, `/20`, `/40`, `/60` (§5). *Alternative rejected:* collapsing the four tint strengths onto one step — the strengths are a deliberate hierarchy (a 10 % fill for a failed-send button, 15 % for a hover, 20 % for its hover, 40/60 % for outlines) and nothing about the migration is a re-measure.

**D3 — no site in this sweep takes `on-danger`, and every hover stays on its own step.** A69's `hover:bg-danger-500/90` rule exists because a *filled* surface carries a floored foreground; the remaining sites are tints (`/10`, `/15`, `/20`), outlines (`/40`, `/60`) and bare glyphs, whose foreground is the panel's own text ramp. Composing `bg-danger-500/90` under them, or reaching for `text-on-danger` on a 10 % tint, would be inventing a pairing the derivation never floored. So the hover forms migrate **step-for-step** (`hover:bg-red-500/20` → `hover:bg-danger-500/20`).

**D4 — the two `Sidebar` dots are fills with no glyph.** `bg-emerald-500` (`:22`) → `bg-ok-500` and `bg-red-500` (`:25`) → `bg-danger-500`: an 8×8 px `rounded-full` span carrying no text, so no `on-*` foreground is owed — `500` is the step whose *separation* from both the canvas and the panel is floored (the derivation's `score()`), which is exactly what a dot needs. This discharges A75's first half: `ok-500` has a consumer. **`warn` still has none** (nothing in the app renders a warning *surface*; the sidebar's reconnecting state uses `gold-400` deliberately — an accent, not a status), and the `*-600` steps stay derived-and-unused. Both are recorded, not silently satisfied.

**D5 — `BookDetail.tsx:83`'s hairline lands here.** §2.7 and AC8.3 say `:81`; the file is at `:83` (7a's annex recorded the same two-line staleness and left the site to this slice as the named absorber). Same substitution as `BookCard.tsx:79`, same token, same 5 % alpha; the *site* is what this slice adds, and AC8.3's decider for it is the running app on both variants (§6).

**D6 — the honest count is 27 names / 15 lines / 8 files, and the parent's "53 / 16" is not the 7b remainder.** The 53-site figure is §1.3's C4 inventory taken **before 7a ran**, and 7a's ten files held most of the class: its own §4 re-tallied to 21 lines / 26 names *inside the ten*. Measured at `7b6ee3c` with the pattern of D7, over `src/**` and `index.html`:

| Name | Sites |
|---|---|
| `text-red-400` (`hover:` included) | 12 |
| `bg-red-500` (alpha forms included) | 8 |
| `border-red-500` (alpha forms included) | 5 |
| `bg-emerald-500` | 1 |
| `ring-white/5` | 1 |
| **Total** | **27 names / 15 lines / 8 files** |

So the slice is **8 code files + 1 new test file** (`src/lib/theme/palette-scan.test.ts`) — at the bound, and one *under* the 7a stage's own 10-by-convention. Recorded in place so no later reader concludes the sweep shipped short of its own criterion, and so the next inventory is taken the same way (D7's pattern), not re-estimated.

**D7 — the sweep ships with a source walk, because AC8.4's instrument was otherwise a shell history.** AC8.4's acceptance is "the repo-wide grep reaching zero, with the count recorded before and after". A `grep` typed by hand is an instrument that exists only in the session that typed it: the next contributor who adds `text-red-400` gets no red from anywhere — which is precisely the class of decider A72 recorded 7a's two GREEN campaign rows as lacking. So `src/lib/theme/palette-scan.test.ts` walks `src/**/*.{ts,tsx,css,html}` (plus `index.html`, which is in Tailwind's own `content` globs) with the same predicate, and asserts zero. It was **written before the migration and run red against it**, so its coverage is measured rather than asserted: it named exactly the 15 lines of §4. It also carries its own anti-vacuity case — the pattern must match every retired shape and no token shape — because a pattern that matched nothing would leave the headline case green forever. *What it does not decide, stated inside the test:* that a migrated class **emits** its rule (a Tailwind build fact — the emitted-stylesheet read in §5 is that instrument), anything under `electron/` or `vendor/`, and any **colour literal** (a hex is not a utility; `src/lib/theme/reader-palette.ts` owns a documented pair of derived baselines and scanning literals would redden on the reader's own design). Test files are skipped — a class in a test is not rendered, and that exclusion is what lets the pattern's own cases live in the test instead of being assembled from fragments to dodge itself. *Alternative rejected:* record the grep in §8 and stop — the shape 7a chose for its class names, and the reason its residue is "criteria with no decider" rather than a closed criterion. *Reversal:* the walk's false-positive cost — a comment in `src/` that spells a retired class reddens a suite for prose. The pattern is built from two arrays so the test's own source cannot match it, and the remedy for a prose mention is to write "the stock red text step" rather than to loosen the pattern (deliberate friction, two lines to change).

## 4. The migration rule, exhaustively — 15 lines, 27 names

Every line below is the whole line's class list where it matters; `→` is the only change.

| File:line | Today | Becomes |
|---|---|---|
| `StatusBar.tsx:67` | `text-red-400` | `text-danger-400` |
| `Sidebar.tsx:22` | `bg-emerald-500` | `bg-ok-500` |
| `Sidebar.tsx:25` | `bg-red-500` | `bg-danger-500` |
| `BookDetail.tsx:83` | `ring-white/5` | `ring-parchment/5` |
| `BookDetail.tsx:214` | `border-red-500/60 bg-red-500/10 text-red-400 hover:bg-red-500/20` | `border-danger-500/60 bg-danger-500/10 text-danger-400 hover:bg-danger-500/20` |
| `BookDetail.tsx:242` | `hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-400` | `hover:border-danger-500/60 hover:bg-danger-500/10 hover:text-danger-400` |
| `BookDetail.tsx:312` | `hover:text-red-400` | `hover:text-danger-400` |
| `SelectionPanel.tsx:93` | `border-red-500/60 bg-red-500/10 text-red-400 hover:bg-red-500/20` | `border-danger-500/60 bg-danger-500/10 text-danger-400 hover:bg-danger-500/20` |
| `SelectionPanel.tsx:127` | `border-red-500/40 text-red-400 hover:bg-red-500/15` | `border-danger-500/40 text-danger-400 hover:bg-danger-500/15` |
| `SelectionPanel.tsx:133` | `text-red-400` | `text-danger-400` |
| `BookContextMenu.tsx:224` | `hover:bg-red-500/15 hover:text-red-400` | `hover:bg-danger-500/15 hover:text-danger-400` |
| `Toasts.tsx:7` | `border-red-500/40`, `text-red-400` | `border-danger-500/40`, `text-danger-400` |
| `TransferQueue.tsx:31` | `text-red-400` | `text-danger-400` |
| `TransferQueue.tsx:64` | `text-red-400` | `text-danger-400` |
| `ConflictResolver.tsx:106` | `text-red-400` | `text-danger-400` |

**Out of scope, deliberately:** every stock utility outside `src/` and `index.html` (there are none under `electron/` — its only occurrence is a *comment* in `theme/derive.ts:446` naming the retired class, which stays as the derivation's own provenance), and the `*-600` steps' absent consumer (A75). No site is dropped and none is added: the diff's line count is 15, its name count 27.

## 5. Acceptance criteria, and what decides each

| AC | Decider in this slice |
|---|---|
| **AC8.4 — the sweep is complete** | **The walk** (`src/lib/theme/palette-scan.test.ts`): red on the returned tree before the migration, naming the 15 lines; green after. Plus the recorded equivalent grep over `src/**` + `index.html` → **0**, with the count before recorded (27 names / 15 lines / 8 files). |
| **AC8.4's emission half — the migrated names emit the rules** | **The Tailwind build read**: `./node_modules/.bin/tailwindcss -c tailwind.config.js -i src/index.css -o /tmp/tw-7b.css` must carry `.text-danger-400`, `.text-on-…` (unchanged), `.bg-ok-500`, `.ring-parchment\/5`, and the alpha forms `.border-danger-500\/60`, `\/40`, `.bg-danger-500\/10`, `\/15`, `\/20`, `.hover\:bg-danger-500\/20`, `.hover\:text-danger-400`, `.hover\:border-danger-500\/60`; and **zero** rules for any stock hue. |
| **AC8.2 — the status colours hold their floors in the variant they render on** (completed: the derivation was 7a's, the *sites* are here) | **Unit**: the existing derivation floors, unchanged and re-run. **Live**: with a light theme active, the danger text sites resolve to the theme's own derived `--status-danger-400` (not the variant-blind literal `#f87171`), and the contrast against the panel each one lands on is recomputed there — the quantity AC8.2 names. |
| **AC8.3 — the hairline is visible on both variants** (completed: `BookCard`'s half was 7a's) | **Running app**: `BookDetail`'s cover frame's resolved `--tw-ring-color` under a light theme and under the default — `rgb(255 255 255 / 0.05)` before, `rgb(<parchment> / 0.05)` after. |
| **The migration happened, and nothing else did** | `git diff --stat` over the eight files + the walk against §4's table (15 lines / 27 names); `git diff --quiet` over §7's list (the engine, the reader, `src/index.css`, `tailwind.config.js`). |
| **AC7.1's gate** | `npm run typecheck && npm run lint && npm test`, plus `npm run build` and `npx prettier --check` on every touched file. |

No unit decider exists for what a *class renders* (no DOM in `vitest`, no Tailwind build in the suite): the walk decides the name's presence, the emission read decides the rule, and the app pass decides the pixel. All three are named above rather than one standing in for the others.

## 6. The app pass (orchestrator, not the implementer)

Same instrument as 7a's pass, so its *before* column is comparable: an isolated `MUSAEUM_USER_DATA` profile with the light synthetic Obsidian theme (canvas `#f5f4f0`-class) active and one imported synthetic EPUB. Rows:

| measured | before | after |
|---|---|---|
| a danger text site's resolved `color`, light theme | the stock literal (variant-blind by construction) | the theme's derived `--status-danger-400` |
| that site's contrast against the panel it lands on, light theme | below the family's 4.5 floor | at/above it |
| the same site, default theme | `rgb(248, 113, 113)` | the derived value (the palette's own register) |
| `BookDetail`'s cover ring `--tw-ring-color`, light / default | `rgb(255 255 255 / 0.05)` | `rgb(<parchment> / 0.05)` |
| the sidebar NAS dot's `background-color` | `rgb(16, 185, 129)` / stock red | the derived `ok-500` / `danger-500` |
| `--status-ok-500`, light theme | *n/a (the dot is the consumer)* | the theme's derived value |
| frames | grid + detail + sidebar | the same three |

Plus the geometry re-read (invariant #7): a card's height and a `tr`'s height, unchanged.

## 7. What must not move

- `vendor/foliate-js/**`, `src/components/reader/**` (invariant #11, and slice 5's palette).
- Row geometry: `ROW_HEIGHT` / `CARD_META_HEIGHT` / `CARD_META_MARGIN`, and any real row's height (invariant #7) — every edit here is a colour class.
- `metadata.json`, the database, `app_config`: untouched.
- `theme/derive.ts`, `theme/store.ts`, `src/lib/theme/css.ts`, `src/types/theme.types.ts`, `tailwind.config.js`, `src/index.css`, `THEME_ENGINE_VERSION`, `MUSAEUM_DEFAULT_TOKENS`: untouched.
- The stored values of every theme in `theme_library` and the built-in corpus.
- `index.html`: untouched (no CSP widening — nothing here reaches a remote host).
- The behaviour of every migrated control: a hover that changed nothing but its colour still changes only its colour, and no `disabled:` / `aria-*` / `title` attribute moves.

## 8. Built — 2026-09-19

Landed as one slice against `7b6ee3c`, the 15-line migration implemented by a dispatched child from §4's table and the walk written by the orchestrator **before** the migration, then **checked on the returned tree**: the diff read line by line against §4, gates re-run, campaign run, app pass run by the orchestrator, and every child claim re-measured rather than relayed.

**Gates** — `typecheck=0`, `lint=0`, `npm test` **855 passed / 37 files** (7a's baseline is 852/36, so the walk added one file and three cases), `npm run build=0`, and `npx prettier --check` over the nine touched files: **7 clean, 2 dirty at `HEAD`** — `TransferQueue.tsx` and `ConflictResolver.tsx`, each with the *same* residue before and after (`git show HEAD:<f> | prettier --stdin-filepath <f>` diffs identically: an import list and an `<img>` this slice never touched). A73's trade, re-measured.

**The acceptance — AC8.4 — reached zero, over the whole tree with no exemption:**

```
grep -rnE '(bg|text|border|ring|fill|stroke|divide|from|via|to|outline|decoration|placeholder|caret|accent|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}|(bg|text|border|ring|fill|stroke)-(white|black)' src/ index.html
→ 0 matches (exit 1)
```
**Before:** 27 utility names on 15 lines across 8 files, named by the walk's own RED run (the 15 lines of §4, each with its names — the walk's first execution is what produced the "before" column).

**The walk caught itself first, and that is this slice's headline bug.** Its first version carried its anti-vacuity samples and two prose mentions as literal stock utilities — and `src/` is inside Tailwind's own `content` globs (`index.html` + `src/**/*.{ts,tsx}`), so those literals were scanned as candidates and **emitted seven dead rules into the app's stylesheet**: `.text-red-400`, `.hover\:text-red-400:hover`, `.border-red-500\/60`, `.bg-emerald-500`, `.bg-rose-600`, `.text-white`, `.ring-white\/5`. The source walk could not see it, because it skipped test files; **the acceptance grep is what caught it** (it returned 11 matches, all inside the test file, and the emission read confirmed the rules). Two fixes, both structural: the retired spellings are now **composed** from fragments (`util('text', 'red', '400')`), and the test-file exemption is **gone** — the walk and the grep are now the same predicate over the same scope. Re-measured after: the built sheet carries **0** stock-hue rules and **0** white/black rules. *Independently corroborated:* the dispatched child met the same 11 lines from the other side — its brief's unscoped grep could not come back empty while the decider file was not editable by it, so it reported the 11 hits as an escalation and proved the migrated files with `--exclude=palette-scan.test.ts` (zero). Two readers, one artefact, and the finding survives being reached from either direction.

**The emitted stylesheet** (`./node_modules/.bin/tailwindcss -c tailwind.config.js -i src/index.css -o /tmp/tw-7b.css`): 14 migrated rules present, every alpha form intact — `border-color: rgb(var(--status-danger-500) / 0.6)` and `/ 0.4`, `background-color: rgb(var(--status-danger-500) / 0.1)`, `/ 0.15`, `/ 0.2`, `/ 0.9`, `rgb(var(--status-ok-500) / …)`, `rgb(var(--status-danger-400) / …)` for text — and zero rules for any stock hue.

**Mutation campaign — 7/7 killed** (one per new decider; every file restored byte-identically, `restored=True` on every row).

| mutation | result |
|---|---|
| `Sidebar.tsx`: the dot's fill back on the stock emerald | **RED** |
| `SelectionPanel.tsx`: the offline note back on the stock red text | **RED** |
| `BookDetail.tsx`: the absorber's hairline back on `ring-white/5` | **RED** |
| `TransferQueue.tsx`: the error line given `sky-400` (a hue that never appears in the tree) | **RED** |
| the walk's hue list loses `red` (the pattern goes blind to the family the slice existed for) | **RED** |
| the walk's extensions lose `.ts` | **RED** |
| the walk's roots lose `index.html` | **RED** |

The last three are the anti-vacuity cases doing their job: without them the first five would pass while the walk quietly ignored part of the tree. **No GREEN row** — unlike 7a, whose two survivors were the class-name and config criteria. The two criteria that *still* have no test decider are the build-shaped ones (a class's rendered colour, the emitted rule), and their instruments are the emission read and the app pass below.

**The app pass** — same isolated profile and same light synthetic Obsidian theme as 7a's pass (`/tmp/musaeum-app-pass`, canvas `245 244 240`), two synthetic EPUBs imported so the *selection* panel (the ninth file) renders, before and after on the same instrument:

| measured | before | after |
|---|---|---|
| `SelectionPanel`'s "Delete 2 books…" text (:127), light theme | `rgb(248, 113, 113)` — the stock literal, **2.4057:1** against its panel | `rgb(179, 38, 30)` = the theme's `--status-danger-400`, **5.6847:1** (criterion: 4.5) |
| its border, same site | `rgba(239, 68, 68, 0.4)` | `rgba(179, 38, 30, 0.4)` = `--status-danger-500` |
| the sidebar NAS dot (`Sidebar.tsx:22`) | `bg-emerald-500` → `rgb(16, 185, 129)` | `bg-ok-500` → `rgb(46, 107, 52)` light / `rgb(127, 158, 106)` default — the theme's own derivation |
| `BookDetail`'s cover ring (:83), light | `rgb(255 255 255 / 0.05)` → `#f2f0ea` over its panel, **1.0072** | `rgb(43 36 23 / 0.05)` → `#e7e5de`, **1.0967** |
| the same ring, default theme | `rgb(255 255 255 / 0.05)` → `#201d19`, **1.1199** | `rgb(233 225 210 / 0.05)` → `#1f1b17`, **1.1023** (the shift D5/§2.7 names) |
| what the retired classes now resolve to | `text-red-400` = `rgb(248, 113, 113)`, `bg-emerald-500` = `rgb(16, 185, 129)` | **nothing**: the stylesheet has no rule for either — the text inherits the body's `parchment` and the fill computes transparent |

Frames: `7b-before-selection-panel.png` / `7b-after-selection-panel.png` (and `-grid`, `-default`) under `/tmp/musaeum-app-pass/frames`, composited for the eye as `/tmp/musaeum-pass/frames7b-selection-panel.png`. Re-runnable harness: `/tmp/musaeum-pass/s7b-probe.py before|after <theme-id>` (7a's colour maths, imported from `veil-probe.py` so both passes agree).

**Deviations, residuals and escalations, each decided here:**

1. **`SelectionPanel.tsx` was the ninth file (D1)** — the file neither §2.7's row nor the `tasks.md` bullet named, holding 8 of the 27 names. The slice's own diff would have "reached zero" over the seven files and left a grep that does not. The `tasks.md` 7b entry is corrected in place.
2. **`ok-500` is consumed as of this slice** (the NAS dot — A75's first half discharged); **`warn` still has no consumer** and the `*-600` steps still have none. That is a deliberate, recorded non-consumption, not an oversight: nothing in the app renders a warning *surface*, and the reconnecting state is an accent (`gold-400`), not a status.
3. **A class's rendered colour still has no unit decider** (A72's class), so the two build-shaped criteria — *the migrated name emits its rule* and *the site paints the theme's value* — are decided by the emission read and the app pass, not by the gate. The walk narrows that gap to *presence of the name*, and no further.
4. **An error toast could not be raised in this profile, so `Toasts.tsx:7`'s row is decided by the name-walk and the emission read only.** Three attempts: a nonexistent path, and a malformed `.epub`, produced no `[role=alert]` card within 7 s, and the second attempt's `import.addFiles` call did not return within 120 s (the eval was not timeout-bounded, so this is a *probe* observation, not a reproduced defect — see the `tasks.md` capture). The site's colour is settled by `border-danger-500/40` + `text-danger-400` in the built sheet.
5. **`prettier` cannot go green on two of the nine files** for a reason that predates the slice (A73's rule, re-measured above). The alternative — `prettier --write` over the pair — reformats a dozen unrelated hunks inside a diff whose whole content is 15 lines.
6. **The honest counts.** 8 code files + 1 new test file = **9** — at the bound, and one *under* 7a's own ten-by-convention; no new token, no `electron/` change, no `app_config` write, no migration.

**Still owed after this slice:** `warn`'s first consumer and any consumer at all for the `*-600` steps; the two build-shaped criteria's instruments remain a build read and a probe rather than a gate; and the import-hang observation above, which belongs to the refresh-feedback surface rather than to theming.

