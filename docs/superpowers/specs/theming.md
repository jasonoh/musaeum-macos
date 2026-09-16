# Design: Theming — provider-imported palettes across the whole app

**Date:** 2026-09-15
**Status:** Approved. Every product decision below was taken by Jason and is **closed**;
each is recorded with the alternative it beat and the condition that would reverse it.
This document does not re-open one.
**Scope:** six *approved* slices, in the dependency order of §2.1–§2.6, plus one **committed,
staged** seventh slice (§2.7 — committed by the owner, staged 7a/7b; it carries its own budget, its absorber, a
cheaper alternative and a recommendation), landing a palette-only theming system: import a
colour scheme from a provider the owner already uses, derive Musaeum's **17** design values
from it, and apply them to the whole app including the reader.
**Amended 2026-09-15 (amendment round 1).** The first pass understated the change surface: it
treated "the app's entire palette lives in `tailwind.config.js`" as the whole truth, and so
"config plus CSS" as a sufficient surface. The premise is **false** — seven classes of colour
consumer reach a pixel without going through a token utility (§1.3), three of them inside
slice 1's config-and-CSS scope and four needing their own edits. Every claim that changed, and
why, is in the amendment trail immediately below. Where the independent audit's figure and the
orchestrator's re-measurement differ, **the re-measurement is the figure recorded and the
audit's is noted beside it**.

**Amended 2026-09-15 (amendment round 2).** Slice 2 landed (uncommitted), and porting `derive.py`
falsified four claims in round 1's text: the scrim's rule, the status family's return key and its
floors, the ladder's `mix(…, 'linear')` naming, and — the one that matters most — **AC2.4, whose
literal clause the reference implementation cannot satisfy on the fixture it names**. Each is corrected
**in place**, with the superseded sentence kept visible at its site and the measurement that settled it
in the round-2 trail below. Nothing here re-opens a product decision: J1–J11 stand. The one scope
change is that **slice 7a no longer owns the status derivation**, because slice 2 shipped it (A13).

**Supersedes nothing.** `2026-08-13-native-reader-design.md` deliberately left the
reader's page themes as two authored rows; slice 5 changes that default and says so.
**Read before implementing:** `docs/invariants/settings-and-editing.md` (`app_config`,
persisted UI state), `docs/invariants/reader.md` (the reader, its injected page CSS,
reading position), `docs/invariants/library-views.md` (computed row geometry),
`docs/invariants/menu-and-branding.md` (the native menu is built once and never rebuilt).

**The reference implementation is `/Users/jasonoh/theme-probe/derive.py`** (pure Python,
stdlib only) with its findings in `/Users/jasonoh/theme-probe/HANDOFF.md` and its rendered
output in `preview.html`. The port must reproduce its rules and its measured numbers
verbatim, with the one hardening named in §2.2 and the one addition named in §2.5, and the
two further additions amendment round 1 makes (the `scrim` derivation and, if slice 7 lands,
the status family — both marked as this spec's own, not the prototype's).

---

## Amendment trail — 2026-09-15, amendment round 1

This round amends in place; nothing here re-opens a settled product decision (1–6 stand), and
the six approved slices keep their boundaries except where a row below says slice 1 gained a
line in a file it already owns. Each row names what changed and why, and the section it
changed.

| # | What changed | Why |
|---|---|---|
| A1 | **The change-surface premise is corrected.** "The app's entire palette lives in `tailwind.config.js`, so config + CSS is the surface" → "seven classes of colour consumer reach a pixel outside a token utility — three inside slice 1's config-and-CSS scope, four needing their own edits" (§1 opening, new §1.3). | The independent audit found the premise false, and the orchestrator's re-measurement confirms it: 63 opacity-modified token sites, 12 veils, 53 stock-palette sites, a missing root `color-scheme`, a broken `gold-200`, and the reader's two constraints (§1.4, G1–G8). |
| A2 | **The token count is 17, not 16, and not 15.** A `scrim` row is added to the derived contract (§1.1). | G3/G9. The 15 and 16 figures are recorded as superseded, not deleted. |
| A3 | **`scrim` is recorded as a derived role, with its twelve migration sites named** (§1.1, §2.2, §2.7). | G3: a veil's requirement ("darker than whatever is behind it") is not a position on the ramp, so no ramp step can supply it — and under a flipped ramp every veil inverts into a white wash. This was the audit's most important omission; the file list in the dispatch was also wrong (see A8). |
| A4 | **The root `color-scheme` declaration moves from slice 5 to slice 1.** The first pass said "deliberately NOT added here"; it is now added here, and slice 5 re-writes it from the tokens on a theme change (§2.1, §2.5, AC1.7). | G5: `color-scheme` appears exactly once in app source (`ReaderEngine.tsx:67`, inside the book's own document) and nowhere on `:root`, so a light theme is structurally incapable of being correct — the app would be light while its native controls, caret, select popups and default canvas stayed dark. It belongs with the defaults, in the file that carries them. **It is one line in `src/index.css`, which slice 1 already owns: slice 1's file budget does not change.** |
| A5 | **Slice 1's `:root` block gains `--scrim: 13 11 9`** — byte-equal to today's `ink-950` (§2.1). | So the twelve pre-migration veil sites are pixel-identical in the default theme and AC1.1's pixel gate stays a gate rather than becoming a stack of intended diffs. |
| A6 | **The 63 opacity-modified token sites are named as the reason the `<alpha-value>` form is mandatory**, where the first pass cited only the two sites in `src/index.css` (§1.3 C2, §2.1, AC1.3). | G2. A `var(--hex)` form drops declarations in **20 files slice 1 is not allowed to touch**, silently. |
| A7 | **Two hard constraints on how the reader consumes a theme become acceptance criteria on slice 5** (AC5.7, AC5.8), with the engine's read-back lines cited (§2.5). | G8: both come from the vendored engine, which may not be edited, so they are constraints on our injected CSS rather than preferences — and one of them (the alpha concatenation) is in our own file, which makes the required fix cheaper than the audit assumed. |
| A8 | **Three dispatch figures are corrected in place, with the code location named.** `BookDetail.tsx` has no scrim (the ninth file is `BookCard.tsx`, with four sites); `MigrationWizard.tsx:199` is a checkbox, not a range input; the alpha concatenation is at `ReaderEngine.tsx:104`, not in `paginator.js` (§1.3, §1.4). | The audit's error budget is a fact about the audit; a spec that repeats a wrong file will send an implementer to the wrong file. Each correction is in the section that consumes the fact, not only in the trail. |
| A9 | **The `gold-200` defect is registered** with its four sites (verified by a real Tailwind build: zero rules emitted), with a recommended remedy, and explicitly *not* fixed here (§1.3 C1, §6, open questions). | G1. It is pre-existing and independent of theming; a spec that edits code is not a spec, and a slice whose burden is "no visual change" cannot also change two components. |
| A10 | **A seventh slice is proposed** — status colours (`danger`/`ok`/`warn`) plus the scrim and hairline migrations — with a budget against the ~10-file bound, a named absorber, a cheaper alternative, and a recommendation (§2.7, AC8.1–AC8.3). | The four consumer classes outside slice 1's scope (C1, C3, C4, C7) currently have no home; C7 is slice 5's, and the other three had none. |
| A11 | **The dangling "See 'Open questions' at the end" reference in §2.6 is fixed** by actually writing that section. | The first pass pointed at a section it never wrote. |

### Amendment round 2 — 2026-09-15 (post-slice-2 reconciliation)

Slice 2's port was checked against the reference implementation rather than against round 1's prose,
and four sentences lost. Each is amended in place below with the superseded text still visible at its
site. The measurements are the orchestrator's: a differential over all 15 real palettes (every derived
value identical, 1,539 assertions) and three hand-applied mutations, each of which reddened only its
own criterion.

| # | What changed | Why |
|---|---|---|
| A12 | **The scrim's rule is the prototype's, not §2.2's.** §2.2 described the dark variant's scrim as *the dark end itself* (byte-equal to `ink-950`); what J6 landed in `derive.py` is `mix(deep, black, 0.35)` plus a `relLuminance < 0.06` walk, which derives `#0b0d0d` for gruvbox where its `ink-950` is `#1d2021`. The prototype is authoritative. | J6 and `tasks.md` both say the prototype's rules are what slice 2 reproduces verbatim. Nothing is lost: the *default* theme keeps slice 1's **authored** `--scrim: 13 11 9`, because the built-in default is authored rather than derived — exactly as `derive.py`'s own `NATIVE` row is hand-authored. A5's pixel-identity promise is therefore untouched. |
| A13 | **The status family ships inside slice 2, not 7a.** §2.2's return-key sentence omitted it and J2 assigned the derivation to 7a; the prototype has it (J6 landed it), so the verbatim port carries it. **7a's scope shrinks**: variables and site migrations, not the derivation. | A port that drops a function body present in the reference is not a port, and splitting one function across two slices is what J6 was executed to prevent. |
| A14 | **AC2.4 is amended in place.** Its literal clause is unsatisfiable against the reference implementation. | Measured on the prototype's own output: six of the iTerm gruvbox ladder's seven stops sit 1.29–2.47 from their canvas by `hue_delta`, not under 0.61 — because that fixture's canvas chroma (0.0049) is under the filter's own 0.01 bypass, so the hue clause never applies and a near-grey's hue angle is numerical noise. The iTerm nord ladder satisfies it (0.000–0.003). A criterion the reference cannot satisfy is a criterion the next reader deletes. |
| A15 | **The corpus is 13 schemes, not 10; and it is not half light.** §5's data cell and §6.5's claim are both corrected in place. | Four of the thirteen are light (`catppuccin-latte`, `gruvbox-light-soft`, `solarized-light`, `tokyo-night-light`). The set was vendored whole rather than cut to an arbitrary ten. |
| A16 | **The curated set's provenance is verified — in the strict direction.** §7's "Not verified" entry is superseded. | On 2026-09-15 all thirteen committed files compared **byte-identical** to `tinted-theming/schemes@spec-0.11` (`7cda828e…`), and both `.itermcolors` fixtures compared **value-identical** (27 and 26 colour slots, zero differing components) to `mbadolato/iTerm2-Color-Schemes@master` (`1a3e1d29…`). The per-scheme copyright carve-out stands, and each file's own `author:` header carries the attribution. |
| A20 | **The terminal verification gained two things the round-1 text did not have**: the failure reason is a **discriminated union** (`kind: 'floor' | 'malformed'`, with `metric` distinguishing a contrast ratio from the scrim's absolute luminance), and a **sweep over the assembled audit table** — no success result may carry a row below its own floor — because the prototype audits two placements but walks one score. | The audit of the first repair diff measured that the entry point was still returning `ok: true` with its own audit rows reading FAIL: 715 of 40,894 successful random-IR derivations carried a sub-floor row, and neither the corpus test nor any per-loop witness could see it (1,200 perturbations of the 15 palettes: 0 hits). A criterion whose subject is "the theme is readable" has to verify the table it prints. The interface half was taken before slice 3 or 4 consumed the shape, which is the cheapest moment it will ever be. |
| A19 | **AC2.4 takes its landed form: the criterion is decided by a *synthetic* fixture, and both vendored fixtures are property pins only.** Three cases now: (a) the nord literal clause, which is a pin (measured to hold with the hue half of the filter deleted as well); (b) gruvbox's property assertions; (c) a synthetic `.itermcolors` built inline in the test, whose canvas chroma (0.0351) clears the filter's 0.01 bypass and which ships an off-hue near-grey inside the luminance window. | The pre-merge review's only BLOCK: A14's amendment created a clause with no deciding test, and its stated reversal condition could not be met by either vendored fixture. (c) is the case the clause actually discriminates on, so the criterion keeps a decider instead of softening its prose. |
| A18 | **Two sentences the pre-merge review found undecidable as written, corrected in place**: §2.2's fail-closed paragraph cited `docs/invariants/refresh-feedback.md`, which carries no theming rule (the rule is `CLAUDE.md` #12; the doc is the *precedent* for the shape); and AC2.6's second clause — "nothing lands in `app_config` and the app's active theme is unchanged" — has no decider in slice 2, which owns no storage, and belongs to **AC3.3**. | Same defect class as A14: a sentence a reader takes for coverage that nothing decides. Naming the owning criterion is cheaper than leaving an untested claim standing. |
| A17 | **Three prose defects in §2.2's derivation table, annotated in place**: the ladder's `mix(…, 'linear')` is a componentwise sRGB interpolation, *not* an interpolation in linear light; the status `400` floor is 4.5, not 3.0; and `600` is a bare `adjust_light(base, 0.30, false)` carrying no foreground, while `on_fill` is a `max` rather than a walk. | Each is a sentence an implementer could follow *instead of* the reference implementation — and the reference is what the tests pin. Swapping the ladder's mix for Oklab, or for real linear-light, moves nine tests. |

---

## 1. The problem, and what is true today

Musaeum's palette is compiled in. `tailwind.config.js` holds every *token* as a hex
literal (`ink` 950/900/850/800/700/600/500, `parchment` DEFAULT/dim/faint, `gold`
300/400/500/600), and 28 files under `src/` consume those values as Tailwind utility
classes. Nothing can change a colour without editing that config and rebuilding, and
there is no path for a user to say "make this look like Gruvbox".

**Amended (A1): "the app's entire palette lives in `tailwind.config.js`" is false, and
therefore "config plus CSS is the change surface" is an insufficient one.** The config holds
every token — but a token utility is only one of the ways a colour reaches a pixel. Seven
classes of colour consumer sit outside it (§1.3), and for four of them no config or CSS change
reaches the site at all. The 28-file figure above is still true (F3): it counts *token-utility*
consumers, and it is a floor for the change surface, not the surface.

Consequences, all measured — three from the first pass, one added in amendment round 1:

1. **The reader carries a second, hand-copied palette.**
   `src/components/reader/ReaderEngine.tsx:48-50` holds a `PALETTE` const with 8 hex
   values — `ink` and `paper` rows — consumed at line 62 and interpolated into an
   injected stylesheet at lines 64–106. Its own comment (line 46) states the `paper` row
   "has no token counterpart — the app has no light theme to borrow from", and line 45
   says "a palette change has to update this table too". It is a fork waiting to drift.
2. **Main process paints a colour the renderer may not agree with.**
   `electron/main/index.ts:94` is `backgroundColor: '#0d0b09'` — the only hex literal
   anywhere under `electron/` — so any light theme flashes near-black at window creation.
3. **The token names are shape, not role.** `ink` / `parchment` / `gold` describe today's
   particular aesthetic. They keep their names in v1 (product decision 6), which is
   fortunate for a different reason: the CSS variable names and the derived-value keys can
   then be the same words, so the derivation output maps to the stylesheet with no
   translation table.
4. **Seven classes of colour consumer are not token utilities at all** (amendment round 1;
   enumerated with file and line in §1.3): an undefined palette step used 4 times, 63
   opacity-modified token utilities across 20 files, 12 veil sites across 9 files, 53
   stock-palette utilities across 16 files, a root `color-scheme` that does not exist while
   two native controls already consume the accent token, 2 gradient sites, and the reader's
   injected stylesheet under two hard constraints from the vendored engine. Separately, a
   token *rename* would reach 543 token-utility sites across 28 files (G7) — which is the
   number product decision 6 is protecting.

### 1.1 The derived contract — 17 values, and how many the brief calls it

A theme supplies a palette. It does not supply the structure Musaeum needs. The values
that must exist for a theme to be a theme:

| Group | Values | Count |
|---|---|---|
| Surface ladder | `ink` 950, 900, 850, 800, 700, 600, 500 | 7 |
| Text ramp | `parchment`, `parchment_dim`, `parchment_faint` | 3 |
| Accent ramp | `gold` 300, 400, 500, 600 | 4 |
| On-accent | `on-accent` — the foreground that sits on a filled accent surface | 1 |
| Scrim (added in amendment round 1, A2/A3) | `scrim` — the veil that *darkens* what is behind it (modal backdrops, over-cover chips) | 1 |
| Shadow | a derived shadow *strength* | 1 |
| **Total** | | **17** |

**Three counting figures, and why two of them are superseded.** The dispatch brief calls this
"the 15 derived tokens" and then lists 16 values; `theme-probe/derive.py:11` calls it
"Musaeum's 14 design tokens"; the first pass of this spec recorded 16. **The figure for the
set as amended is 17** — 7 ink steps + 3 parchment steps + 4 gold steps + `on-accent` +
`scrim` + the derived `shadow` strength. The **15** and **16** are recorded here as superseded
rather than overwritten, so anyone holding an older number finds out here why it moved. (The
seventeen are the *core* set. If §2.7's slice 7 lands it adds a status *family*
— `danger`/`ok`/`warn` with their `on-*` foregrounds — which is a new family, not a
retroactive eighteenth core value; §2.3's validation rule is written as "every value the
derivation emits" precisely so it grows with the family instead of being wrong about it.)

**Why `scrim` is a role and not a ramp step** — this is G3, and it is the reason the figure
moved at all. `ink-950` is already doing two unrelated jobs: *canvas* (`src/index.css:14` body
background, `ReaderView.tsx:166` the reader's full-screen frame, `ReaderToc.tsx:12` the TOC
sidebar, `ReaderPrefsPopover.tsx:48` a theme swatch) and *veil* (`bg-ink-950/70` and `/80` in
twelve places, §1.3 C3). Those two jobs want **opposite** luminance under a flip. The ramp
carries "how far from the canvas along the palette's own bg→fg axis" — so on a light provider
palette, `ink-950` *is* the canvas and therefore becomes the **lightest** tone in the set. Every
one of the twelve veils then inverts from a darkening curtain into a white wash, and the
`text-gold-400` glyphs on the four over-cover chips (`BookCard.tsx:98, 114, 128, 167`) become
gold on near-white. No ramp step can supply a veil, because a veil's requirement — "darker than
whatever is behind it" — is not a position on the axis. It is the same class of role as
`on-accent`: a value the app needs that no provider supplies, so it must be derived and
floored like the others (§2.2), and it is the second such role this app has had to invent.

### 1.2 What is true today, as measured

Every line below was executed or read on **clean HEAD `bdc54ec`** ("agent config + cc
optimization"), working tree clean, on 2026-09-15. The dispatch brief's fact numbers are
kept so a disagreement is traceable.

| # | Claim | Measured | Method |
|---|---|---|---|
| F1 | Baseline gate: typecheck 0, lint 0, `npm test` = 270 passed / 17 files | **TRUE** | `npm run typecheck` → exit 0; `npm run lint` → exit 0; `npm test` → "Test Files 17 passed (17), Tests 270 passed (270)" |
| F2 | `tailwind.config.js` holds the entire palette as hex literals + fontFamily, boxShadow, animation, keyframes. Tailwind 3.4.17 | **TRUE** | read of `tailwind.config.js` (68 lines); `package.json` devDependency `"tailwindcss": "^3.4.17"` |
| F3 | 28 files under `src/` reference `ink`/`parchment`/`gold` via utility classes; slice 1 edits none of them | **TRUE, with a boundary note** | strict class-utility grep (`(bg\|text\|border\|ring\|fill\|…)-(ink\|parchment\|gold)(-[0-9]+)?`) → 28 files: **27 `.ts`/`.tsx` components plus `src/index.css`**. A broader grep that counts comment-only mentions adds `ReaderEngine.tsx` for 28 non-CSS files. Zero of the 27 components are touched by slice 1; `src/index.css` is, because it *is* half of slice 1 |
| F4 | Opacity modifiers are used on token colours, so the config must emit `rgb(var(--channels) / <alpha-value>)`; a plain `var(--hex)` form silently kills every `/opacity` utility | **TRUE — highest-risk fact in slice 1** | `src/index.css:18` `bg-gold-500/40`; `src/index.css:43` `focus-visible:ring-gold-400/70`; `src/index.css:30` `bg-ink-600`; `src/index.css:35` `bg-ink-500` |
| F5 | `electron/main/index.ts:94` `backgroundColor: '#0d0b09'` is the only hex literal under `electron/`; line 95 is `titleBarStyle: 'hiddenInset'` | **TRUE** | `grep -rnE '#[0-9a-fA-F]{3,8}' electron` → exactly one hit, `index.ts:94`; read of lines 87–103 confirms `titleBarStyle: 'hiddenInset'` at 95 |
| F6 | `ReaderEngine.tsx:48-50` `PALETTE` const (8 hex), consumed line 62, injected ~64–106, `color-scheme` at line 67, comment at line 46 | **TRUE** | read of `ReaderEngine.tsx:40-106`. `PALETTE` at 48–51; `const c = PALETTE[prefs.theme]` at 62; `color-scheme:` at 67; the "no light theme to borrow from" comment at 46 |
| F7 | No code reads a Tailwind token value at runtime; every inline `style={{…}}` is geometry only | **TRUE** | grep for `getComputedStyle\|resolveConfig\|PALETTE\|theme(` across `src/` → 2 hits, both `ReaderEngine.tsx`'s own const. All 15 `style={{…}}` sites are `paddingLeft`, `width`, `height`, `marginTop`, `left`/`top`/`right`, `transform`, or `padding:0;border:0` |
| F8 | `icons.tsx` uses `fill="currentColor" at 3 sites`, so the icon set is token-driven | **Count wrong; conclusion true** — 5 literal `fill="currentColor"` attributes (lines 31, 32, 33, 101, 110), plus `stroke: 'currentColor'` in the shared `base()` at line 9 and a conditional `fill={filled ? 'currentColor' : 'none'}` at line 60 | grep `currentColor` in `src/components/shared/icons.tsx` |
| F9 | `app_config` is `key TEXT PRIMARY KEY, value TEXT`; `getConfig`/`setConfig`/`deleteConfig` exist; a new key needs no SQL migration | **TRUE** | `001_initial.sql:91-94` (`key` on 92); `db.ts:66` / `:73` / `:85`; `settings.ts:26` `CONFIG_KEYS`; `MIGRATIONS` array at `db.ts:19` is append-only so no new entry is needed |
| F10 | Reader prefs persist via zustand `persist` to `localStorage` key `musaeum.reader`, validated on read and write by `sanitizePrefs` | **TRUE** | `reader.store.ts:80-91` `sanitizePrefs`; `:173` sanitizes in `setPrefs` too; `:178` `name: 'musaeum.reader'`; `:180-183` `merge` re-sanitizes |
| F11 | The prototype measured 7 palettes × 6 audits with zero failures, and established that a regex scrape resolves 1 of the 5 installed Obsidian themes | **TRUE** | re-ran `python3 derive.py`: gruvbox-dark-hard / nord / solarized-dark / catppuccin-latte / iterm gruvbox / iterm nord / obsidian halcyon each print 6 audits, all `OK`. `Things`, `Tokyo Night`, `Blue Topaz`, `Dracula + LYT` each print `roles unresolvable by scraping` |
| F12 | tinted-theming/schemes default branch is `spec-0.11` with 340 files in `base16/`, MIT; mbadolato/iTerm2-Color-Schemes has 450+ schemes and its licence was not verified | **First half TRUE; second half now resolved (an upgrade, not a contradiction)** | GitHub API: `tinted-theming/schemes` → `default_branch: spec-0.11`, `license.spdx_id: MIT`, `base16/` at that ref → **340 entries** (339 `.yaml` + 1 `.yml`). `mbadolato/iTerm2-Color-Schemes` → `default_branch: master`, `license.spdx_id: NOASSERTION`, `schemes/` → **614** `.itermcolors` files (so "450-plus" is true but understated). I then fetched the repo's `LICENSE`: it **is MIT** ("Copyright (c) 2011 to Present Mark Badolato"), with an explicit carve-out — *"The copyright/license for each individual theme belongs to the author of that theme."* The collection licence therefore does **not** cover the schemes inside it; per-scheme attribution is required if any of them is ever vendored. Nothing in this spec vendors from that collection (see §2.3) |

Facts F1–F12: **none false.** F8's count is the only wrong number; F12's second half moved
from unverified to verified in the direction of a *stricter* constraint.

Two more things read but not asserted as facts: `vitest.config.ts` runs
`environment: 'node'`, `pool: 'forks'`, and includes `src/**/*.test.ts`,
`electron/**/*.test.ts`, `test/**/*.test.ts` — **there is no jsdom and no component test
runner**, so anything that needs a DOM cannot be unit-tested (this shapes §3 and §5). And
`test/mocks/electron.ts` exports `class BrowserWindow {}` — an empty class, so no existing
test can observe window-construction options (slice 3 needs it to).

### 1.3 The seven classes of colour consumer that live outside token-in-Tailwind-utilities

"Outside" means the colour reaches a pixel through something that is not a token utility class
— either because the class **does not exist**, or because the utility **resolves but carries
the wrong role**, or because the value is **not a Tailwind class at all**. All figures
re-measured on HEAD `bdc54ec` in amendment round 1 (§1.4 carries the raw numbers and what was
found false).

| # | Class | Sites / files | Inside slice 1's config-and-CSS scope? |
|---|---|---|---|
| C1 | A palette step that does not exist (`gold-200`) | 4 / 2 | **No** — needs a text edit in two components |
| C2 | Opacity-modified token utilities (`…-ink-950/80`, `…-gold-500/60`) | 63 / 20 | **Yes** — and only because of the `<alpha-value>` form |
| C3 | Scrim sites: `bg-ink-950/<alpha>` used as a veil | 12 / 9 | **No** for the semantics — a derived role (§1.1, §2.7) |
| C4 | Stock-palette colour utilities (Tailwind's red/emerald/white) | 53 / 16 | **No** — no token swap reaches them (§2.7) |
| C5 | Native-control appearance: `color-scheme` absent from `:root` | 1 missing declaration / 1 file owns it | **Yes** — one line in `src/index.css` |
| C6 | Token gradients | 2 / 1 line | **Yes** — both stops are utilities, no file changes |
| C7 | The reader's injected stylesheet, plus the engine's read-back | 2 files, 8 interpolation sites | **No** — slice 5's, under two hard constraints |

**C1 — a palette step that does not exist.** Four sites in two files, all naming `gold-200`:
`src/components/library/SelectionPanel.tsx:77` (`text-gold-200`), and
`src/components/library/ListView.tsx:88`, `:207` (`text-gold-200`) and `:211` (`bg-gold-200`).
`tailwind.config.js:24-29` defines `gold` 300/400/500/600 — there is no `gold-200`.
**Executed, not inferred:** a real Tailwind build (`./node_modules/.bin/tailwindcss -c
tailwind.config.js -i src/index.css -o /tmp/tw-out.css`) contains **zero** rules matching
`gold-200`, while `.text-gold-300` and `.bg-ink-950` are present as controls. The four classes
therefore paint nothing at all: the selection panel's "Select" button (`SelectionPanel.tsx:77`)
falls back to its inherited parchment on a gold tint instead of gold, and the list view's
checkbox row and tri-state mark lose their gold. **This is a live pre-existing bug, independent
of theming** — it exists at HEAD, before any slice. *Scope:* **not** slice 1. The config cannot
fix it (inventing a `gold-200` step changes the ramp's shape and every theme's contrast
relationships), and editing the two components changes pixels, which slice 1's AC1.1/AC1.2
forbid. Registered, remedy recommended, and deliberately not fixed by this spec (§6, open
questions).

**C2 — opacity-modified token utilities.** 63 sites across 20 files. Most frequent, measured:
`bg-ink-950/80` 9, `focus:border-gold-500/60` 4, `placeholder:text-parchment-faint/50` 3,
`focus:ring-gold-500/30` 3, `hover:border-gold-400/60` 3, `bg-ink-950/70` 3,
`hover:bg-gold-500/10` 3, `focus-visible:ring-gold-400/70` 2, `text-gold-400/80` 2,
`bg-gold-500/20` 2, `bg-ink-850/95` 2, and a tail of twos and ones down to
`bg-gold-500/40` and `border-ink-800/60` (the full breakdown is recorded in the amendment
round's measurement ledger, §7). The audit's broader count of **78** also swept in
stock-palette opacity sites such as `bg-red-500/40` and `ring-white/5`; those are C4, not C2.
**63 is the token-class figure and is the one this spec uses.** *Scope:* **yes, and only
because of the form.** No file changes; but if the config emits a plain `var(--hex)`, all 63
become invalid CSS in 20 files slice 1 is not permitted to touch — silently (§2.1, AC1.3).

**C3 — scrim sites: `bg-ink-950` with a slash alpha, used as a veil.** Twelve sites in nine
files: `src/components/settings/SettingsModal.tsx:137` (`/80`),
`src/components/migration/MigrationWizard.tsx:110` (`/80`),
`src/components/metadata/ConflictQueue.tsx:42` (`/80`),
`src/components/library/RemoveFromDeviceDialog.tsx:49` (`/80`),
`src/components/library/ImportOverlay.tsx:130` (`/70`),
`src/components/library/DeleteSelectionDialog.tsx:59` (`/80`),
`src/components/library/DeleteBookDialog.tsx:76` (`/80`),
`src/components/library/BookEditor.tsx:195` (`/80`), and
`src/components/library/BookCard.tsx:98` (`/70`), `:114` (`/80`), `:128` (`/70`),
`:167` (`/80`). *(Correction, A8: the dispatch's file list named `BookDetail.tsx` — which
contains no `bg-ink-950` at all — and omitted `BookCard.tsx`, which has four of the twelve.)
Two jobs are mixed in this set and a slice must serve both: **eight are modal veils** (a `/80`
or `/70` panel behind a dialog) and **four are over-cover legibility chips** — gold and
`parchment-dim` glyphs on an `ink-950` chip laid over cover art, where the chip is the only
thing keeping them readable. On a light theme all twelve invert: the modal backdrop goes from
a darkening curtain to a white wash, and the chips become gold on near-white. *Scope:* **no.**
The class itself keeps resolving (C2's form), and slice 1 leaves the pixels unchanged because
`--scrim` defaults to `13 11 9` (A5) — but the *role* is wrong the moment the ramp flips, which
is why `scrim` is a derived token (§1.1) and the twelve sites are a named migration (§2.7).
The alphas stay as authored: the migration is a rename (`bg-ink-950/80` → `bg-scrim/80`), not a
re-design, so the veils keep their measured strengths. Note the *other* meaning of the same
class, which is exactly why a ramp step cannot be reused: `bg-ink-950` with **no** alpha means
*canvas* at `src/index.css:14`, `ReaderView.tsx:166`, `ReaderToc.tsx:12` and
`ReaderPrefsPopover.tsx:48` (a theme swatch) — one class, two roles, opposite requirements.

**C4 — stock-palette colour utilities (Tailwind's own colours, not app tokens).** 53 sites
across 16 files: 23 `text-red-400`, 11 `bg-red-500`, 7 `border-red-500`, 4 `text-white`,
3 `bg-red-600`, 2 `ring-white`, 1 `text-red-300`, 1 `border-red-400`, 1 `bg-emerald-500`
(counted by colour-utility *prefix*, so variants and alpha forms are included: e.g. 23 = 20
`text-red-400` + 3 `hover:text-red-400`; the nine rows sum to 53). A token-only swap leaves
every one of them exactly as it is today: they are not tokens, so nothing in slice 1's config
or CSS touches them. Two are load-bearing for legibility: `ring-white/5` is the hairline that
separates a cover from the surface at `src/components/library/BookCard.tsx:79` and
`src/components/library/BookDetail.tsx:81` — a 5% white ring over a light surface is invisible.
*Scope:* **no** — they need their own edits (§2.7). The derived half is nearly free, which is
the point worth carrying: **the prototype already produces red, green and yellow accents from
any provider palette** (`derive.py`'s `accents` map), so `danger`/`ok`/`warn` reuse slice 2's
existing floors and walks rather than introducing a subsystem.

**C5 — native-control appearance, which no utility reaches.** `color-scheme` appears **exactly
once** in all app source: `src/components/reader/ReaderEngine.tsx:67`, inside the stylesheet
injected into the *book's* document. It is set **nowhere on `:root`**. Everything the platform
paints for itself therefore follows the OS scheme: the two `<select>` popup lists
(`src/components/layout/Toolbar.tsx:41`, `src/components/library/BookDetail.tsx:139`), the
checkbox body at `src/components/migration/MigrationWizard.tsx:199`, the range-input body at
`src/components/reader/ReaderPrefsPopover.tsx:164`, the text caret, and the default canvas.
Those last two controls are also the only places in the app where a native control already
consumes the accent token (`accent-gold-500`) — the visible proof that the accent reaches
native UI at all. *(Correction, A8: the dispatch calls these "two range inputs";
`ReaderPrefsPopover.tsx:164` is a `type="range"`, `MigrationWizard.tsx:199` is a
`type="checkbox"`. Both carry `accent-gold-500`, so the substance stands and the count of
"native controls consuming the accent token" is still two.)* *Scope:* **yes** — one
declaration in `src/index.css`, which slice 1 already owns, so **slice 1's file budget does not
change** (A4, §2.1, AC1.7). One precision, because the dispatch's consequence over-counts: its
list includes "scrollbars", and the app already paints its own scrollbar thumb with the ink
ramp (`src/index.css:22-38` — `bg-ink-600` at `:30`, `bg-ink-500` at `:35`), so the thumb is
themed, the track is deliberately transparent, and only the scrollbar corner/overlay path is
still the platform's.

**C6 — token gradients.** Two sites, both on one line: `src/components/library/BookCard.tsx:28`,
`bg-gradient-to-b from-ink-700 to-ink-800` (the no-cover placeholder card). *Scope:* **yes** —
both stops are token utilities and resolve from the ladder, so no file changes. It is recorded
because a gradient is the one place where the *distance between two ramp steps* is visible as a
value: a provider palette with a compressed ladder (measured: the iTerm path can infer the ramp
from as few as three greys) renders the placeholder flat instead of shaded. Cosmetic; never a
correctness failure, and not worth a criterion.

**C7 — the reader's injected stylesheet, which is not a utility and cannot become one.** Two
files, and neither may simply be "converted to tokens": `src/components/reader/ReaderEngine.tsx`
holds a hand-copied `PALETTE` (lines 48-51, 8 hex values) that the first pass already records
as a fork; it is consumed at `:62` and interpolated into the injected page CSS at `:64-105` —
`color-scheme` at `:67`, `background` at `:69` and `:74`, `color` at `:70` and `:75`, the link
colour at `:101`, and the selection colour at `:104`. `vendor/foliate-js/paginator.js` then
reads that stylesheet's *effect* back off the book document at `:191` and re-applies it at
`:626`, `:685` and `:1113`. *Scope:* **no** — slice 5's, under the two hard constraints recorded
there (§2.5, AC5.7, AC5.8).

**Separately — the rename blast radius, which is not a consumer class.** 543 token-utility
sites of any shape across 28 files (§1.4 G7). Nothing is wrong with any of them today; the
number matters only because it is what a token *rename* would have to touch, which is product
decision 6's protection and stays deferred past v1.

### 1.4 Amendment round 1 — the re-measurements, verified against the shipped code

Nine facts (G1–G9) were re-measured on HEAD `bdc54ec`, working tree clean apart from this file,
2026-09-15. **Six are true as stated; three carry a correction, one of which is a
whole-file misattribution.** For every correction the measured value is recorded with the code
location, so the correction is checkable rather than asserted.

| # | Claim | Verdict | Measured |
|---|---|---|---|
| G1 | `gold-200` is not defined; used at four sites in two files; those classes emit no CSS | **TRUE — verified by build, not only by grep** | `gold` = 300/400/500/600 at `tailwind.config.js:24-29`; sites at `SelectionPanel.tsx:77`, `ListView.tsx:88, 207, 211`; a real Tailwind build emits **0** `gold-200` rules |
| G2 | 63 opacity-modified token sites across 20 files; the audit's broader count is 78 | **Headline TRUE; the per-class breakdown is NOT reproducible** | 63 sites / 20 files reproduce exactly. The breakdown does not: measured `bg-ink-950/80` 9 ✓, `border-gold-500/60` **6** (not 7), `bg-gold-500/30` **3** (not 7), `border-gold-500/50` **3** (not 5), `ring-gold-400/70` **2** (not 5), `bg-gold-500/40` **1** (not 4), `bg-gold-500/10` 4 ✓, `text-parchment-faint/50` 3 ✓, `bg-ink-950/70` 3 ✓, `border-gold-400/60` 3 ✓. This spec uses the measured breakdown (§2.1's list, §7's ledger). G4's breakdown reproduces exactly under the same counting convention, so the divergence is in G2's list, not in the rule used to count |
| G3 | 12 `bg-ink-950` veil sites across 9 files; under a flip ink-950 is the lightest tone so every scrim inverts | **TRUE in count and in consequence; the file list is wrong** | 12 sites / 9 files confirmed. **`BookDetail.tsx` contains no `bg-ink-950` at all**; the ninth file is **`BookCard.tsx`, with four sites** (`:98`, `:114`, `:128`, `:167`). Corrected list in §1.3 C3. The inversion follows from the derivation: on a light palette stop 0.0 of the ladder is the canvas, i.e. the lightest tone, so a veil built from it brightens instead of darkening |
| G4 | 53 stock-palette sites across 16 files, breakdown as listed | **TRUE, exactly** | 53 / 16 confirmed, breakdown reproduces site for site (23+11+7+4+3+2+1+1+1 = 53). The two hairlines confirmed at `BookCard.tsx:79` and `BookDetail.tsx:81` |
| G5 | `color-scheme` appears exactly once, at `ReaderEngine.tsx:67`, and nowhere on `:root`; two **range inputs** consume the accent token | **TRUE; one control mislabelled** | `color-scheme` grepped across `src/`, `electron/` and `index.html` → exactly one hit, `ReaderEngine.tsx:67`, inside the book-iframe stylesheet; none on `:root`. **`ReaderPrefsPopover.tsx:164` is the range input; `MigrationWizard.tsx:199` is a `type="checkbox"`.** Both carry `accent-gold-500`, so "two native controls consume the accent token" holds. The scrollbar half of the consequence is qualified in §1.3 C5 |
| G6 | Exactly 2 token gradient sites, both on one line, `BookCard.tsx:28` | **TRUE** | `BookCard.tsx:28`, `from-ink-700 to-ink-800`; the only token gradient anywhere in `src/` |
| G7 | 543 token utility sites of any shape across `src/` | **TRUE** | 543 sites, 28 files |
| G8 | (a) `paginator.js:191` string-compares the resolved background against a transparent literal and `:624`, `:685`, `:1113` re-apply it; (b) **the same file** builds its selection colour by concatenating a two-digit alpha onto the link hex | **(a) TRUE with a line correction; (b) TRUE in substance, FALSE in file** | (a) `:191` is `bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'` ✓ — but the re-application inside the media-query listener is at **`:626`**, not `:624` (`:624` is `this.#mediaQueryListener = () => {`); `:685` and `:1113` are exact. (b) The concatenation is **not in `paginator.js`** — it is our own source: **`src/components/reader/ReaderEngine.tsx:104`, `::selection { background: ${c.link}44; }`**. Nothing in `vendor/foliate-js/` concatenates an alpha onto a colour (grepped for `link`, `'44'`, `::selection`). So the required fix is cheaper than the audit assumed — the site is editable — and the constraint is no weaker: it is still the *engine* that consumes the injected CSS and reads values back out of the book document |
| G9 | 17 tokens as amended; 15 and 16 superseded | **TRUE** | 7 + 3 + 4 + 1 (`on-accent`) + 1 (`scrim`) + 1 (`shadow`) = 17 |

Facts F1–F12 in §1.2 are untouched by this round: none of them was contradicted (F3's 28-file
count still holds, because it counts token-utility consumers, which §1.3 does not dispute).

---

## 2. The approach, and the alternatives it beat

```
provider file ──▶ adapter ──▶ one IR ──▶ derived 17 values ──▶ CSS variables ──▶ Tailwind
   (yaml /                    (palette-      (structure ours,      (channel        (utilities
    plist / css)               shaped)        hue theirs)          triplets)       resolve)
```

The finding that shapes everything: **the hard part is not parsing — every provider is
trivially parseable. It is that no provider carries Musaeum's roles.** A scheme gives you
16 terminal slots (base16), the same in a plist (iTerm2), or a role ontology with no
palette (Obsidian); Musaeum needs a 7-step surface ladder, a 3-step text ramp, one accent
ramp and an on-accent foreground. So the architecture is a decompression: adapters
normalize to one IR, and one pure function invents the structure on top of the palette it
was given.

**The one rule that does the work: every ramp slides along the palette's own bg→fg axis,
and only chroma comes from elsewhere.** A provider supplies canvas, ink and accent. It does
not supply how many surface steps the app needs, so those are invented — and contrast
floors are enforced rather than assumed.

### 2.0 Where each piece lives, and why the derivation is main-side

| Piece | Home | Why there |
|---|---|---|
| Contracts (IR, derived values, resolved theme, provider ids) | `src/types/theme.types.ts` | `@shared` is the only alias both processes have (`tsconfig.node.json` `paths` and `tsconfig.web.json` `paths`), and it already carries real logic (`book.types.ts`'s `sortableTitle`, `window-chrome.ts`) |
| Colour maths + derivation + adapters | `electron/main/services/theme/` | Provider files are on disk, and the renderer has no `fs` — splitting parse (main) from derive (renderer) would put the pipeline on both sides of the IPC boundary for no gain. The renderer needs the *values*, not the function |
| Applying values | `src/lib/theme/css.ts` (pure map) + a 3-line DOM write | Pure part is unit-testable under the existing vitest include; the DOM part is not (no jsdom) and is verified live |
| Reading/writing the active theme | `app_config`, via `electron/main/services/theme/store.ts` | Main must know one colour before the window exists (§2.3) |
| Consuming it | `src/stores/theme.store.ts` projected through `src/hooks/useTheme.ts` | Matches the standing rule that main-process events are wired into stores once, in a `src/hooks/use*.ts` mounted by `App.tsx` |

### 2.1 Slice 1 — Token plumbing

`tailwind.config.js` moves to CSS-variable channel triplets, and today's palette becomes
the `:root` default in `src/index.css`.

```js
// tailwind.config.js — shape, both files are in the file budget
colors: {
  ink: {
    950: 'rgb(var(--ink-950) / <alpha-value>)',
    /* … 900, 850, 800, 700, 600, 500 */
  },
  parchment: {
    DEFAULT: 'rgb(var(--parchment) / <alpha-value>)',
    dim: 'rgb(var(--parchment-dim) / <alpha-value>)',
    faint: 'rgb(var(--parchment-faint) / <alpha-value>)'
  },
  gold: { 300: 'rgb(var(--gold-300) / <alpha-value>)' /* … 400, 500, 600 */ },
  scrim: 'rgb(var(--scrim) / <alpha-value>)'    /* A2/A5 — a role, not a ramp step */
},
boxShadow: {
  cover: '0 2px 8px rgb(0 0 0 / var(--shadow-a1)), 0 8px 24px rgb(0 0 0 / var(--shadow-a2))',
  'cover-lift': '0 4px 12px rgb(0 0 0 / var(--shadow-a3)), 0 16px 40px rgb(0 0 0 / var(--shadow-a1))',
  panel: '-8px 0 32px rgb(0 0 0 / var(--shadow-a1))'
}
```

The `<alpha-value>` form is **not stylistic** — it is what keeps `bg-gold-500/40`
(`src/index.css:18`) and `ring-gold-400/70` (`:43`) working. `rgb(var(--gold-500))` with a
hex-valued custom property produces invalid CSS at computed-value time, the declaration is
dropped, and the app renders a transparent (i.e. white) body with **no build error**. That
is the silent failure this slice exists to avoid, and AC1.3 pins it.

**Amended (A6): the two sites in this file are two of 63.** `bg-gold-500/40` and
`ring-gold-400/70` are the ones *slice 1 itself* writes, which is why the first pass cited them
— but the same form is what keeps **63 opacity-modified token utilities across 20 files**
working (§1.3 C2, §1.4 G2: `bg-ink-950/80` ×9, `focus:border-gold-500/60` ×4,
`placeholder:text-parchment-faint/50` ×3, `focus:ring-gold-500/30` ×3,
`hover:border-gold-400/60` ×3, `bg-ink-950/70` ×3, `hover:bg-gold-500/10` ×3, and a tail of
twos and ones). A `var(--hex)` form drops **every one of them**, in 20 files this slice is
forbidden to touch, with the build still green. That combination — silent *and* wide — is why
this is the highest-risk fact in slice 1 and why AC1.3 asserts on the resolved CSS rather than
on a class-name diff.

Today's values become the defaults, converted to space-separated channels (computed, not
transcribed by eye):

```css
/* src/index.css — @layer base, before `body` */
:root {
  --ink-950: 13 11 9; --ink-900: 20 17 13; --ink-850: 25 21 17; --ink-800: 32 27 21;
  --ink-700: 43 36 28; --ink-600: 59 50 38; --ink-500: 79 68 51;
  --parchment: 233 225 210; --parchment-dim: 179 167 143; --parchment-faint: 125 114 96;
  --gold-300: 232 201 135; --gold-400: 212 162 78; --gold-500: 192 143 58;
  --gold-600: 156 112 40;
  --on-accent: 13 11 9;
  --scrim: 13 11 9;                 /* A5: byte-equal to today's ink-950 by design */
  --shadow-a1: 0.5; --shadow-a2: 0.35; --shadow-a3: 0.6;
  color-scheme: dark;               /* A4: added here, not in slice 5 */
}
```

Two lines here are new in amendment round 1 and each has a job:

- **`--scrim` (A5).** It defaults to today's `ink-950` so that the twelve veil sites
  `bg-ink-950/70` and `/80` (§1.3 C3) are **pixel-identical** before they are migrated: the
  token exists from slice 1, the sites move to `bg-scrim/…` in slice 7, and the default theme
  cannot tell the difference. The scrim's *derived* rule — different in a light variant — is in
  §2.2; the token is what makes the migration a rename rather than a re-measure.
- **`color-scheme: dark` (A4)** — see the paragraph below, which reverses the first pass.

**`color-scheme` IS added here — amended (A4), reversing the first pass.** The first pass
deferred this to slice 5 to keep slice 1's "no visual change" burden of proof clean, and that
was the wrong trade. G5: `color-scheme` appears **exactly once** in all app source —
`src/components/reader/ReaderEngine.tsx:67`, inside the stylesheet injected into the *book's*
document — and **nowhere on `:root`**. So the app's chrome declares no scheme at all, and every
surface the platform paints for itself follows the OS: the `<select>` popup lists
(`Toolbar.tsx:41`, `BookDetail.tsx:139`), the checkbox body (`MigrationWizard.tsx:199`), the
range-input body (`ReaderPrefsPopover.tsx:164`), the text caret, and the default canvas. A light
theme is structurally incapable of being correct without a root declaration — it would be a
light app rendering dark OS controls — and the declaration belongs with the *defaults*, in the
file that carries them. So slice 1 emits it in the same `:root` block as the dark palette: the
variables and the platform's idea of the scheme become one statement.

Three consequences of putting it here, stated so they are not discovered later:

- **Slice 1's file budget does not change.** `src/index.css` is already slice 1's file and AC1.2
  already asserts the touched set is exactly `tailwind.config.js` + `src/index.css`; the
  declaration is one line inside a block this slice is writing anyway. **No fourth file, and no
  change to §5's slice-1 row.**
- **The pixel gate is scoped, not weakened.** On a machine whose OS appearance is light, this is
  the one *intended* pixel change in slice 1 (native control bodies). AC1.1's capture therefore
  runs with the OS in dark appearance — the state in which it is a no-op — and AC1.7 asserts the
  declaration exists, is not the reader's, and flips with the palette in slice 5. Claiming it is
  a no-op on every machine would be exactly the kind of claim that makes a pixel gate
  untrustworthy.
- The two `accent-gold-500` controls (`ReaderPrefsPopover.tsx:164` range,
  `MigrationWizard.tsx:199` checkbox) are today the only places a native control consumes the
  accent token, so they are the visible proof that the accent reaches native UI at all — and the
  first place a wrong `color-scheme` will be visible in a screenshot.

The three shadow alphas reproduce `tailwind.config.js`'s current values exactly
(`cover` 0.5/0.35, `cover-lift` 0.6/0.5, `panel` 0.5 — three classes, reused), which is why
slice 1's dark default and slice 5's derived light value differ only by a scale factor.

**The first pass's claim here is superseded — quoted, not asserted.** It read: "**`color-scheme`
is deliberately NOT added here.** … It lands in slice 5, with the flip, where the change is
intended and visible." That deferral is reversed above (A4) for the reason G5 gives: the
declaration is not a *flip*, it is the app's missing statement of which scheme it is, and
omitting it means the default build has **no declared scheme anywhere on `:root`** — the state
that makes a light theme unable to be correct. Slice 5 still *re-writes* it from the tokens
whenever a theme is applied (§2.5), so the two slices agree about who owns it: slice 1 owns the
default value, slice 5 owns the transition.

**Invariant it must not bend:** `docs/invariants/library-views.md` — row height is computed,
not measured. This slice must not move `ROW_HEIGHT`, `CARD_META_HEIGHT` or
`CARD_META_MARGIN`. A malformed channel triplet is exactly the kind of change that shows up
as scroll drift rather than a build error, which is why AC1.1 is a pixel capture and not a
class-name diff.

**Reversal condition:** if the pixel capture cannot be made identical for a reason that is
*not* a channel-triplet bug (e.g. Tailwind's own output order changes a cascade result),
then the indirection is not worth it and this slice should be replaced by a build-time
palette swap (regenerate the config) instead. That would be a real regression in
capability — no runtime switching — so it is the last resort, not the fallback.

### 2.2 Slice 2 — Derivation core

Adapters take a provider file to one IR; one pure function takes the IR to the 17 values
with contrast floors enforced.

**The IR** keeps `derive.py`'s field names verbatim (`bg`, `bg2`, `bg3`, `border`, `muted`,
`fg`, `fg_bright`, `accents`, `accent_hint`, `on_acc_hint`, `name`, `author`, `variant`,
`source`, `notes`) so the port is a transliteration rather than a re-derivation, and
`derive_tokens()`'s return keys stay `ink` / `parchment` / `gold` / `on_acc` / `shadow` —
which are also the CSS variable names (product decision 6 paying for itself twice) — with
**`scrim` added in amendment round 1** (A2/A3). No new file: `derive.ts` and
`theme.types.ts` are already in this slice's budget, and the status family (§2.7) is three
more rows in the same function if it lands. **[A13 — it landed, and it landed in slice 2: `theme/derive.ts`
carries the status family because J6 had already put it in the prototype, so 7a owns only the
`tailwind.config.js`/`:root` variables and the site migrations.]**

**Adapters, and the lossy step each one owns:**

| Provider | Detection | Read | Lossy step |
|---|---|---|---|
| base16/base24 | `.yaml` / `.yml` | `base00`–`base0F` → IR directly (`bg`=00, `bg2`=01, `bg3`=02, `border`=03, `muted`=04, `fg`=05, `fg_bright`=07, accents 08–0F, `accent_hint`=09) | none of consequence: base16 already carries the semantics |
| iTerm2 | `.itermcolors` | Apple XML plist → 16 ANSI slots + `Background Color` / `Foreground Color`; `accent_hint` = Ansi 11 (bright yellow); `variant` from `lstar(bg) < lstar(fg)` | **the surface ramp is reconstructed.** Terminal files carry no base01–03, so the stops are inferred: greys only from the background's own hue family (`chroma < 0.035` and either `chroma(bg) < 0.01` or `hue_delta(v, bg) < 0.61`), interior = strictly between `lstar(bg)` and `lstar(fg)`; ≥2 interior → lowest/median/highest become `bg2`/`bg3`/`border`; otherwise synthesize `mix(bg, fg, 0.10/0.18/0.28)`; `muted = mix(bg, fg, 0.62)`. A luminance sort alone gives a warm scheme a green sidebar — this filter is why the IR exists |
| Obsidian | `theme.css` | slice 6 | computed values need a live cascade |

**No new dependencies.** base16 YAML and `.itermcolors` are both machine-generated and
shape-stable: the base16 adapter reads `key: "value"` lines (the prototype's regex, which
handles the comments and the `slug:` key the curated corpus actually contains), and the
iTerm adapter scans the flat `<key>Name Color</key><dict><key>Red Component</key><real>…`
shape. Both are ~40 lines, both get fixtures, and both fail closed with a named reason.
Rationale: the prototype's whole claim is that derivation is dependency-free, and a parsing
dependency is supply-chain surface for a file the user picked. Reversal condition: a real
provider file that the narrow parser rejects. Then add `js-yaml` / `plist` — which is a
`package.json` change, i.e. an escalation, not a decision for an implementer to make.

**The derivation, verbatim from `derive.py` (constants are part of the contract):**

| Step | Rule |
|---|---|
| Surface ladder | stops `[0.0, 0.10, 0.19, 0.30, 0.42, 0.58, 0.80]` → `ink` 950→500, mixed **bg→span in linear sRGB** (not Oklab; the prototype's asymmetry is deliberate). **[A17 — `'linear'` is the prototype's name for
a *componentwise sRGB* mix, not an interpolation in linear light; `derive.py:89` never linearises.
The port keeps it. Swapping this one call for the default Oklab mix reddens 9 tests.]** |
| Ladder span | `span = border`, unless `border` is off-axis (`lstar(border) < lstar(bg)` when dark) or over-chromatic (`chroma > max(0.06, chroma(bg)*3)`), in which case `span = mix(mix(bg, fg, 0.30), border, 0.35)` and a note is recorded |
| Text ramp | `parchment = fg`; `dim = mix(fg, bg, 0.42)`; `faint = mix(fg, bg, 0.62)` — Oklab; floors **4.5** (on `bg`), **3.5** and **2.2** (on the `ink-900` panel), raised by `mix(c, fg, 0.06)` up to 24 iterations and recorded as an adjustment |
| Accent choice | declared `accent_hint` if it holds `contrast(hint, ink-900) ≥ 3.0`, else the more chromatic of `accents.orange` / `accents.yellow` |
| Accent ramp | `400 = accent`; `300 = mix(acc, fg, 0.30)`; `500 = mix(acc, bg, 0.14)`; `600 = mix(acc, bg, 0.34)`. 400 is nudged toward `fg` by 0.06 (≤20×) until it holds 3:1 on `ink-900`; audited at 3.0 on both `ink-900` and `ink-950` |
| On-accent | a declared `on_acc_hint` (Obsidian's `--text-on-accent`) is accepted if it holds 4:1 against `gold-500` or `gold-400` — an observed role beats a derived one. Otherwise pick the better of `ink-950` / `parchment` on a `gold-500` fill and walk the *fill* 0.08 at a time toward whichever of `fg`/`bg` improves the pair, ≤24×, until 4:1 holds; a moved fill becomes the new `gold-500` and is recorded |
| Shadow | `0.55` dark, `0.16` light |
| **Scrim** — added in amendment round 1, this spec's rule, not the prototype's | `dark_end` = whichever of `{bg, fg}` has the lower `lstar`. `variant === 'dark'` → `scrim = dark_end` (**byte-equal to today's `ink-950`, so the twelve pre-migration sites are pixel-identical and the default theme is a no-op**). `variant === 'light'` → `scrim = mix(dark_end, light_end, -0.35)` — one further step *past* the dark end along the same bg↔fg axis, because a light palette's dark end is its **text** colour, and a text-coloured veil over cover art reads as a bruise rather than a shadow. Floors, verified terminally like every other role: `contrast(scrim, bg) ≥ 3.0` and `lstar(scrim) ≤ lstar(dark_end)`. Unmet → step the extrapolation 0.08 further, ≤24 iterations, then **reject** per the terminal-verification rule below. **[A12 — superseded: `derive.py` *does* now carry a scrim rule, because J6 ported it into the prototype before slice 2; the sentence that stood here is preserved in the round-2 trail.]** The case the derivation must still be shown to handle is a light palette whose `fg` is mid-grey, since that is where the extrapolation has the least room: **[A12 — superseded in part: the rule that landed in `derive.py` is `mix(deep, black, 0.35)` plus a `relLuminance < 0.06` walk, *not* `scrim = dark_end`. The port follows the prototype; the dark-variant byte-equality with `ink-950` no longer applies to a derived theme, only to the authored default.]** |
| **Status family** — added in amendment round 1, nearly free (only if §2.7 lands) | `danger = accents.red`, `ok = accents.green`, `warn = accents.yellow` — the prototype **already derives all three from every provider palette**, so this reuses the accent ramp's rule rather than adding a subsystem; a provider that omits one falls back to the accent ramp. Each gets the accent ramp's own two placements and floors: a `400` holding `3.0` on `ink-900`, and a `500`/`600` pair holding `4.5` against a derived `on-*` foreground chosen by the same better-of-`fg`/`bg` walk `on-accent` uses. These are a separate *family*, not part of the seventeen (§1.1). **[A17 — the landed floors differ from the sentence above: `400` holds 4.5, not 3.0; `600` is a bare `adjust_light(base, 0.30, false)` with no foreground and no audit; and `on_fill` is a `max` over the ends, not a walk. The prototype is what slice 2 reproduces.]** |

**The rules the port adds, and why neither is optional.** The prototype's floor loops are
bounded and exit at the cap **without re-checking**. A bounding loop that runs out is a
theme that failed its floors while claiming success. So the port must verify the floor after
each loop and **reject the theme** if it is unmet. **[A20 — the failure is a discriminated
value, not the bare `{ role, ratio, floor }` this sentence first specified:
`kind: 'floor'` carries `{ role, ratio, floor, metric }` (with `metric: 'contrast' | 'luminance'`,
because the scrim's floor is an absolute luminance and the others are contrast ratios) and
`kind: 'malformed'` carries `{ role, detail }` for an IR the derivation cannot read at all.
Rendering the interface this way was deliberate and cheap — no consumer existed yet — and the
`tsc --strict` probe the audit ran errors on every un-narrowed `reason.ratio` read.]**

**And the port must verify the audit table it assembles, not only the six loops (A20).** The
prototype audits *two placements* but *walks one score*: the status fill's guard satisfies
`min(max-on / 4.0, max(separation from canvas, separation from panel) / 3.0) >= 1.0`, so a fill
that separates from the panel but not from the canvas passes the walk while the shipped row
`'<family>-500 vs canvas'` (floor 3.0) reads FAIL; and `'accent on canvas'` has no guard at all.
Measured on the port before this rule: of 300,000 random IRs, 40,894 returned `ok: true` and
**715 of them carried a row below its own floor** (509/480/470 across the three `X-500 vs canvas`
rows, 51 on `accent on canvas`) — and 1,200 single-field perturbations of the 15 vendored
palettes produced none, which is why neither the corpus test nor the per-loop witnesses can see
it. So the last check before a success return is a sweep over the assembled audit table: **no
success result may carry a row below its own floor.** *Rejected:* leaving it, which ships a theme
whose own audit table prints FAIL while the picker shows it as active — the exact defect AC2.2
and AC8.1 exist to prevent. The derivation's *rules* are untouched by this; only the check is
added, and it rejects nothing the 15 vendored palettes produce.

The prototype has no fixture for the floor case; the test-author must synthesize the worst case
(a canvas and text at the same luminance).

**Invariant it must not bend:** `CLAUDE.md` #12 — failures stay non-fatal where the doc says so. An
unparseable file, an unresolvable role, an unsatisfiable floor: all are **reported**, never thrown to
the top, and the app keeps the palette it already had. **[A18 — this sentence also cited
`docs/invariants/refresh-feedback.md`, and the review that opened that doc found it carries no theming
rule: it is the *precedent* for this shape (a failed refresh reports and degrades rather than throwing
the process), while the rule itself is `CLAUDE.md` #12's. The citation now names the rule and the
precedent distinctly, so a reader who opens the doc expecting a theming invariant is not misled.]**

**File budget:** 9 code files + 2 fixture data files (§5). Overrun absorber:
`parse/base16.ts` and `parse/itermcolors.ts` collapse into one `parse.ts`.

### 2.3 Slice 3 — Persistence and apply-on-boot

Two `app_config` keys, no migration (F9), and one window colour.

| Key | Value |
|---|---|
| `theme_id` | the active theme's stable id (`builtin:musaeum`, `builtin:gruvbox-dark-hard`, `base16:<slug>`, `iterm:<stem>`, `obsidian:<folder>`); **absent means the built-in default**, which is slice 1's `:root` block |
| `theme_tokens` | JSON: the resolved theme — `{ id, name, provider, author, variant, sourcePath, tokens: { ink{…}, parchment{…}, gold{…}, onAccent, scrim, shadowStrength }, audits[], adjustments[], notes[] }` (`scrim` added in amendment round 1, A2) |

**Storing the derived values rather than re-deriving at boot is the load-bearing decision.**
Main needs one colour *before* the window exists and cannot await a derivation (which for an
Obsidian theme means an offscreen resolve that may fail, and for an imported `.itermcolors`
may not be on disk any more at all — the owner's collection lives in ProtonDrive). Both keys
are written in one `better-sqlite3` transaction by `theme/store.ts`. `theme_id` is what the
picker shows as active; `theme_tokens` is what the CSS variables and the window background
are built from. Because they can disagree, one write path owns both — and it validates
before it writes anything, mirroring `settings.ts`'s "a failed save changes nothing".

**Read validation, on the storage-is-untrustworthy rule** (`settings-and-editing.md`):
`theme_tokens` is parsed and re-validated on every read — **17 values as amended (A2)**, each
matching `^#[0-9a-f]{6}$`, `variant ∈ {dark, light}`, `shadowStrength` a finite number in
`[0,1]`. The rule is deliberately written as *"every value the derivation emits"* rather than a
hardcoded 17, so the status family (§2.7) is covered by the same rule when it lands instead of
quietly bypassing validation.
Anything short of that is treated as *no theme*: `:root` defaults apply, the app keeps
running, and the reason is logged. A hand-edited or half-written row must never be able to
render an unreadable app.

**Apply-on-boot, in two places, because one is not enough:**

- `electron/main/index.ts` `createWindow()` sets `backgroundColor` from the stored tokens'
  `ink-950` via a pure `windowBackgroundColor(tokens)` in the theme service — one function,
  unit-tested, so the "it's still hardcoded" mutation is visible to a test.
- `src/main.tsx` awaits `window.Musaeum.theme.get()` **before** `createRoot(...).render()`
  and applies the variables to `document.documentElement`. One IPC round trip delays first
  paint by ~1 ms and removes the flash where React paints the default palette and then
  swaps it. The window background covers the frame before any JS runs.

**The IPC surface** (`src/types/api.types.ts`, `electron/preload/index.ts`,
`electron/main/ipc/theme.ts` — thin handlers through `handle()`, business logic in
`services/theme/`):

```ts
theme: {
  get(): Promise<ThemeView>                    // { active, options, defaultId, folder }
  set(id: string): Promise<ThemeView>          // derive → validate → write both keys → broadcast
  importPaths(paths: string[]): Promise<ImportResult>   // { imported[], rejected[{path, reason}] }
  importFromDialog(): Promise<ImportResult>    // native picker, multi-select
  scanFolder(): Promise<ThemeView>             // re-read ~/Library/Application Support/Musaeum/themes/
  openFolder(): Promise<void>                  // shell.openPath — nothing is ever written into it
}
// EVENT_CHANNELS gains: themeChanged: 'event:theme-changed'
```

`ThemeView.active` is the resolved theme (or the built-in default descriptor);
`ThemeView.options` is the merged list — built-ins first, imported second, each with
`{ id, name, author, provider, variant, swatches: string[5], active, notes[] }`. Swatches
are five hex values taken from the derived set (`ink-950`, `ink-800`, `parchment`, `gold-400`,
`gold-500`) — enough to tell two dark themes apart in a list without rendering a preview.

**No theme key in `EditableSettings`.** `settings.ts`'s `saveSettings` treats blank as "back
to auto-detection" and validates paths; a theme is not a path and has no auto-detection, so
it keeps its own keys and its own save path. Adding it to `CONFIG_KEYS` would import that
path's semantics where they do not apply.

**Invariant it must not bend:** `docs/invariants/menu-and-branding.md` — "the menu is built
once and never rebuilt; nothing in it reflects renderer state". **There is no theme item in
the native menu.** A checked active theme, or a View→Theme submenu, would be exactly the
renderer-state-in-the-native-menu the doc forbids. The picker lives in the Settings modal's
Appearance section (slice 4). The same doc's `app.isPackaged` rule is untouched: nothing
here reads `app.isPackaged`; `services/runtime.ts` stays the one answer.

**Reversal condition:** if `theme_id`/`theme_tokens` drift in practice (two rows, one stale,
in a way a test did not catch), collapse to one key holding both, written atomically. The
two-key shape is chosen because `theme_id` is a *selector* the UI must show even when
`theme_tokens` is unreadable, but that benefit is not worth a class of state bug.

### 2.4 Slice 4 — Import and picker

**Two ways in, and the folder is the one that matters.** The owner's `.itermcolors`
collection lives in ProtonDrive, not in iTerm's preset store, so auto-discovery of a preset
directory would have found nothing. So:

- **A file picker** — `theme.importFromDialog()`, multi-select, native.
- **A drop-box directory** — `~/Library/Application Support/Musaeum/themes/` (i.e.
  `app.getPath('userData') + '/themes'`), scanned on demand by `scanFolder()`, no watcher
  (`file-watcher.ts` is bound to the NAS `imports/` dir and stays that way). The Appearance
  section shows the path, with a "Reveal in Finder" control. **The app never writes into
  this folder** — a theme that needs deriving is derived and its *values* are stored, so a
  missing or moved source file is not an error (`sourcePath` is recorded for display only).
- **A drop onto the Appearance section** — the section owns its own `onDrop`, resolving
  paths through the existing preload `files.getPathForFile` (`useDragDrop.ts:35` is the
  precedent for that call). `useDragDrop.ts` itself needs **no change**: its
  `BOOK_EXTENSIONS` filter (line 4, `.epub`/`.mobi`/`.azw3`) already ignores a `.yaml`,
  `.itermcolors` or `.css`, so dropping a theme on the library is a no-op today and stays
  one (AC4.4).

**The Appearance section** — `AppearanceSection.tsx`, mounted inside `SettingsModal.tsx`
above the existing fields. Rows: swatch strip, name, provider label (`base16` / `iTerm2` /
`Obsidian` / built-in), variant badge, and — for an imported theme with lossy notes — a
disclosure showing them ("ramp inferred from 3 greys; no base01-03 in source", "accent
nudged toward fg for 3:1 on panels"). The divergence between the same scheme via two
providers (gruvbox's base16 `base05` `#d5c4a1` vs its iTerm `Foreground Color` `#ebdbb2`) is
a real property of the corpora, and the provider label is what makes it visible instead of
confusing.

**Applying is immediate, not batched.** Clicking a row derives, validates, writes, and
broadcasts. There is no Save button for the theme: a colour choice is its own feedback loop,
and burying it behind ⌘↵ (the modal's save chord, `SettingsModal.tsx:104`) is how a settings
dialog hides the thing the user is looking at. A rejected theme shows its reason in the row
and changes nothing.

**Invariant it must not bend:** `CLAUDE.md` #9 / `docs/invariants/reader.md` — the renderer
never gets `file://`. The renderer passes paths, main reads bytes. `musaeum://` stays the
renderer's only route to files, and it serves books and covers only — no host is added for
themes.

**File budget:** 8 code files (§5). Overrun absorber: `AppearanceSection`'s row rendering
folds into `SettingsModal.tsx`.

### 2.5 Slice 5 — Reader convergence and the light flip

`ReaderEngine.tsx`'s `PALETTE` const disappears. The reader's page colours come from the
same derived values as the app chrome, through a pure `readerPalette(tokens)` in
`src/lib/theme/` — mapping the page to **`ink-900` / `parchment` / `parchment_dim` /
`gold-400`**, which is exactly today's `ink` row when the active theme is the built-in dark
default. That choice is deliberate: it makes the default path a visual no-op, and it is
theme-agnostic — on a light theme those same roles give a light page with dark text, which
is what a page *is*.

`ReaderPrefs.theme` becomes **`'auto' | 'ink' | 'paper'`**, default `'auto'`:

- `auto` — follow the app theme (above).
- `ink` — force today's dark row. Existing stored `'ink'` keeps meaning what it meant.
- `paper` — the authored warm-paper row, unchanged.

`sanitizePrefs` already validates against `THEME_OPTIONS` (F10), so an unknown value falls
back — extend the option list and the validator together, as the store's own comment
requires (`reader.store.ts:31-35`).

**A deliberate deviation from the handoff.** `HANDOFF.md` says the reader's "binary becomes
a list". It does not: the app has one theme, and the reader's chrome *is* app chrome. A
second, independent theme list for the reader would let the page disagree with the frame
around it, which is the failure the reader's own z-index history warns about
(`docs/invariants/reader.md`, the `z-[45]` note). Reversal condition: a request for
per-book or per-reader palettes. That is a different feature (page styling, not app
theming) and belongs in `tasks.md`, not here.

**Derived shadows and native appearance:**

- The three shadow alphas become derived: `aN = clamp(0, 1, baseN × shadowStrength / 0.55)`
  with `base = { a1: 0.5, a2: 0.35, a3: 0.6 }`. This is this spec's addition (the prototype
  derives one strength, 0.55 dark / 0.16 light) and it exists to satisfy product decision 4:
  a theme supplies *amplitude*, never shadow shape. Dark derives to 0.50/0.35/0.60 — byte
  equal to today; light derives to 0.145/0.102/0.175.
- `nativeTheme.themeSource = variant === 'light' ? 'light' : 'dark'`, set at boot from the
  stored tokens and on every theme change, so native scrollbars, traffic lights and menus
  agree with the app. `color-scheme` is **re-written** on `:root` in the same pass — slice 1
  owns its default value (§2.1, A4); this slice owns the transition, so that the declared
  scheme can never drift from the tokens.
- `backgroundColor` at window creation already follows slice 3. A *change* of theme applies
  `win.setBackgroundColor(...)` so a resize does not flash the old canvas.

**Two hard constraints on how the reader consumes a theme — added in amendment round 1 (A7).**
Both come from the vendored engine, so neither is a preference: they are conditions on what
`pageCss()` may emit, and both are acceptance criteria (AC5.7, AC5.8).

**(a) The injected stylesheet must carry resolved literals, never variable references.**
`vendor/foliate-js/paginator.js:191` reads the *book document's resolved* background back out —
`bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'`, a string comparison against a fully
transparent literal, with a fallback to the document element's background — and `:626` (inside
the media-query listener opened at `:624`), `:685` and `:1113` re-apply whatever it returns to
the paginator's **own** background element, because the book's iframe does not fill that element
and the margin around the page has to be painted with the page's colour. So the colour in the
book document must be a *literal*, resolved to hex at injection time. A `var(--ink-900)`
reference is not defined inside the book's document — the custom properties live on the app's
`:root`, and the book is a separate document — so it computes to nothing, `:191`'s comparison
takes its fallback branch, and the engine paints its own margin transparent: the page colour
stops at the iframe edge and the reader's frame shows through. `readerPalette(tokens)` therefore
returns hex, and `pageCss()` may interpolate only literals. (The mechanism, read in full:
`ReaderEngine.tsx:40-110` — `PALETTE` at 48-51, `const c = PALETTE[prefs.theme]` at 62, the
stylesheet from 64, `color-scheme` at 67, `background`/`color` at 69-70 and 74-75, the link at
101, the selection at 104.)

**(b) The selection colour must not be a literal with an alpha suffix glued on.**
`ReaderEngine.tsx:104` is `::selection { background: ${c.link}44; }` — a two-digit alpha appended
to the link colour's hex string. That is valid today only because `c.link` *is* a hex literal,
and it becomes an invalid declaration the moment the link colour is anything else (`var(…)`, or
a `color-mix()` expression): the rule is dropped and the book's selection falls back to the UA
default blue, in the one place the app's accent is most visible. **The fix this spec chooses is
a pre-composed alpha literal:** `readerPalette()` returns the link colour *and* a `linkAlphaHex`
(the resolved hex with `44` composed onto it), so `pageCss()` interpolates two literals and
nothing else. Chosen over `color-mix(in srgb, #d4a24e 27%, transparent)` because (i) it keeps
every value in the injected stylesheet a plain literal, which makes constraint (a)'s "no `var(`"
property assertable in one place instead of rule by rule, and (ii) the alpha then sits in the
source next to the rule it belongs to rather than as arithmetic the engine evaluates.
*Reversal condition:* if a future rule has to blend two **derived** colours — say a selection
tint that is a mix of accent and canvas — then `color-mix()` over two literals is the right form
and this choice should be revisited rather than worked around with a second suffix.

One correction to the audit's framing: the dispatch attributes (b) to
`vendor/foliate-js/paginator.js`, and it is not there — nothing under `vendor/foliate-js/`
concatenates an alpha onto a colour (§1.4 G8). **The fix site is our own file**, which makes this
constraint cheap to satisfy and no less necessary: constraint (a)'s literal requirement is what
makes the pattern feel tempting in the first place.

**Invariant it must not bend:** `docs/invariants/reader.md` — `vendor/foliate-js/` is never
edited, and the injected page CSS stays unprefixed (a book that ships its own typography
keeps it; the engine's stylesheet only fills in what the book left unsaid). Every change here
is in `pageCss()`'s colour expressions, not in its rules. The reader stays at `z-[45]`, and
`sanitizePrefs` keeps sanitizing.

**File budget:** 10 code + test files (§5) — at the bound. Overrun absorber:
`src/lib/theme/reader-palette.ts` folds into `src/lib/theme/css.ts` (both are "derived values
out", and together they are ~60 lines).

### 2.6 Slice 6 — The Obsidian resolver

The observation that makes Obsidian worth having: **its variable vocabulary is closer to
Musaeum's tokens than base16's is** (`--background-primary/secondary/tertiary`,
`--text-normal/muted/faint`, `--interactive-accent`, `--text-on-accent`). Its values,
however, are frequently computed — `hsl(var(--base-h), var(--base-s), calc(var(--base-l) - 80%))`,
`var()` chains, `color-mix(in hsl, …)` — and a CSS regex resolves **1 of the 5 themes
installed on this machine** (F11). Computed values only resolve inside a live cascade, and
we ship Chromium, so the general answer is to *run* the stylesheet.

**Design: a sandboxed offscreen window that is read for values only.**

```
BrowserWindow({
  show: false,
  webPreferences: {
    offscreen: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    partition: 'musaeum-theme-resolver'     // own session, cache: false
  }
})
```

1. `session.fromPartition('musaeum-theme-resolver', { cache: false })` gets
   `webRequest.onBeforeRequest((_d, cb) => cb({ cancel: true }))` — **every** request
   cancelled, unconditionally, before the document loads. This is the primary control.
2. The document is created from a data URL whose own CSP is
   `default-src 'none'; style-src 'unsafe-inline'` — a second layer: `@import` and
   `url()`-bearing declarations resolve to blocked fetches even if the session rule were
   ever relaxed. The theme is injected as a `<style>` **text node** (`document.head.append`)
   so no fetch is needed to load the file at all; the bytes come from `fs.readFile` in main.
3. `document.body.classList.add('theme-dark' | 'theme-light')` before reading — Obsidian
   themes key their two palettes off that class. The variant is chosen from the file's own
   `theme.css` folder for the user's installed theme (both are resolved when needed: the
   picker shows two entries, dark and light, when the file defines both).
4. `getComputedStyle(document.body).getPropertyValue(name)` for the role list, then
   `window.close()`/`destroy()` and a hard timeout (proposed 3 s) that destroys the window
   and rejects the theme with a reason.
5. **What crosses back is hex strings only.** The resolver returns
   `Record<ObsidianRole, string>`; every value is validated against `^#[0-9a-f]{6}$` (after
   normalizing `#rgb`/`#rrggbbaa`) in `services/theme/` **before** it becomes part of an IR.
   A payload that can only be a hex colour cannot carry CSS, a URL, or a selector.

Roles read (`derive.py`'s `OBSIDIAN_ROLE_MAP`, with its fallback chain preserved): canvas
`--background-secondary`, panel `--background-primary`, raised `--background-primary-alt`,
border `--background-modifier-border`, text `--text-normal`, muted `--text-muted`, faint
`--text-faint`, accent `--interactive-accent`, `on_acc` `--text-on-accent`; accents from
`--color-red`/`-orange`/`-yellow`/`-green`/`-cyan`/`-blue`/`-purple` where present. A role
that is empty, non-hex, or missing after the fallback chain → the theme is **rejected with
the unresolved role named**, never partially applied.

**Security surface, stated explicitly because it is arbitrary CSS from a user-installed
theme.** Three properties the design must have, and each has an acceptance criterion:

- the stylesheet is **never** injected into the real renderer — not as a `<style>`, not as a
  `link`, not via `insertCSS`. The renderer only ever receives derived hex values;
- the resolver session can make **no network request** — remote `@import`, remote fonts,
  `url()` beacons, `musaeum://` — the session cancels all of them, and the CSP is a second
  layer;
- the resolver window has **no preload, no Node, no opened windows** (`setWindowOpenHandler`
  → deny) and is destroyed after one read.

**Invariant it must not bend:** `CLAUDE.md` #9 — the renderer never gets `file://`. The
resolver runs in main, reads the theme file itself, and hands the renderer hex values. If a
future implementation concludes the renderer should receive the CSS text, that is a stop and
hand back, not a judgement call.

**Open decision, flagged for the owner:** whether a resolved Obsidian theme is stored
**derived-values-only** (plus `sourcePath` for display) or **alongside a copy of the source
CSS**. Recommendation — derived-only. It is also what slice 3's storage already assumes; the
handoff's own reading is that "licensing only bites on redistribution", and a copy in
`userData` is precisely the redistribution-shaped act that a theme the user already has
installed is not. A copy buys nothing for the stated use case, because the derived values are
what the app renders and they survive the source moving. See "Open questions" at the end.

**File budget:** 5 code files + 1 test file (§5). Overrun absorber: `parse/obsidian.ts` folds
into `theme/index.ts`. This slice does **not** get a separate resolver module if that would
push it past the bound — the resolver and the role map belong together.

### 2.7 Slice 7 — COMMITTED by the owner, and staged 7a/7b: status colours, and the two migrations that invert

**Status: committed, at its widest, and staged** — see the adjudication block at the end of this
file (J1, J2). The owner took the option §2.7a recommended against, so the honest file count is 15+
code files, over the bound: rather than shrink the scope, the slice is cut into two stages, each of
which fits the bound on its own. Its criteria are numbered **AC8.x** to avoid colliding with the
cross-slice **AC7.x** block in §3.

**Why it exists.** Of the seven consumer classes in §1.3, three fall outside every approved
slice: C1 (`gold-200`), C3 (the twelve veils), C4 (the 53 stock-palette sites). C1 is a
pre-existing defect (§6) and C7 is slice 5's. That leaves C3 and C4 — and both fail on a light
theme *visibly and wrongly*, not merely off-palette:

| Failure | Sites | What a user sees under a light theme |
|---|---|---|
| C3 modal veils | 8 files, 8 sites | the backdrop of the migration wizard, the delete dialogs and the settings modal is a **white wash** over a bright app — a dialog that no longer recedes has stopped being a dialog |
| C3 over-cover chips | `BookCard.tsx:98, 114, 128, 167` | `gold-400` and `parchment-faint` glyphs on a near-white chip, laid over arbitrary cover art — the on-device and format badges become unreadable and the delete button's hover state disappears |
| C4 hairlines | `BookCard.tsx:79`, `BookDetail.tsx:81` | the cover's edge vanishes: a 5% white ring on a light surface |
| C4 status colours | 53 sites, 16 files | `text-red-400` on a light panel measures **≈2.3:1** — below 4.5 for body text and below 3.0 even for large text. The danger styling is not off-palette, it is illegible |

**What it contains.**

1. **Derive the status family** (§2.2): `danger`/`ok`/`warn` from the palette's own red/green/
   yellow accents with `on-danger`/`on-ok`/`on-warn` foregrounds, reusing slice 2's floors and
   walks. Cheap by construction — the prototype already derives all three, so this is three rows
   in `derive.ts`, not a subsystem.
2. **Migrate the twelve veils**: `bg-ink-950/70` and `/80` → `bg-scrim/70` and `/80` at every
   site named in §1.3 C3. A rename, not a re-measure — the authored alphas stay (§1.1).
3. **Migrate the two hairlines**: `ring-white/5` → `ring-parchment/5`, reusing an existing token
   rather than adding a role. Justification: `parchment` is *by construction* the tone chosen to
   contrast with the canvas — light on a dark surface, dark on a light one — so it is the one
   existing token that stays visible in both variants, and `scrim` cannot do this job (a scrim
   derived as the dark end is near-black, which is invisible over dark cover art). Cost: the dark
   default shifts from neutral white at 5% to the palette's parchment at 5%, an invisible but
   real pixel change in the dark theme.
4. **Migrate the status sites**: 23 `text-red-400` → `text-danger-400`, 11 `bg-red-500` →
   `bg-danger-500`, 7 `border-red-500` → `border-danger-500`, 3 `bg-red-600` → `bg-danger-600`,
   4 `text-white` (all of them on danger fills) → `text-on-danger`, 2 `ring-white` (item 3),
   1 `bg-emerald-500` → `bg-ok-500`.

**File budget** (§5's table carries the row):

| Component of the slice | Files | Note |
|---|---|---|
| Core | 5 | `theme/derive.ts`, `src/types/theme.types.ts`, `theme/store.ts`, `src/lib/theme/css.ts`, `tailwind.config.js` |
| Components that invert | 10 | `SettingsModal.tsx`, `MigrationWizard.tsx`, `ConflictQueue.tsx`, `RemoveFromDeviceDialog.tsx`, `ImportOverlay.tsx`, `DeleteSelectionDialog.tsx`, `DeleteBookDialog.tsx`, `BookEditor.tsx`, `BookCard.tsx`, `BookDetail.tsx` |
| Status sites | 0 new | the 16 files holding the 53 sites are largely these ten, but not entirely — **this is where the bound breaks** |
| Tests | 1 | `theme/derive.test.ts` extended (scrim floors, status contrast) — no new test file |
| `src/index.css` | 0 | the `:root` defaults for the new variables — **already slice 1's file** (§2.1), so no new file |

**Total: 15 code files + 1 test — five over the ~10-file bound.** That is the honest count, and
it is the whole reason this slice needs a decision rather than a plan.

**Overrun absorber, named: `src/components/library/BookDetail.tsx`.** Its only change is the
hairline at `:81`, and the cover it wraps is already edged by `shadow-cover` (that element's own
class list), so this is the one site in the slice whose absence is cosmetic rather than a
legibility failure. It leaves first, folding into the same `parchment/5` sweep whenever that file
is next opened for any other reason. Second absorber: the status sites in files slice 7 does not
otherwise open leave as debt (§2.7a). With both taken, slice 7 is **10 code files + 1 test** —
at the bound.

#### 2.7a The cheaper alternative, and the recommendation

**The cheaper alternative, stated plainly:** derive the new tokens *inside the slices that
already own those files* (scrim + status derivations are rows in `derive.ts` and `:root` lines in
`src/index.css` — **zero extra files**), migrate only the sites that **break** as those files are
opened for other reasons, and record everything else as **named debt with an owner** in
`tasks.md`.

Which sites break, measured rather than guessed:

- **Inversion — a dark veil becoming a white wash, or a glyph vanishing:** the 8 modal veils, the
  4 BookCard chips, the 2 hairlines. Non-negotiable; a white-washed modal is a broken screen, not
  an off-palette one.
- **Contrast — off-palette becoming illegible:** the 23 `text-red-400` sites, at ≈2.3:1 on a light
  panel. Uniform and greppable (`text-red-400` → `text-danger-400`), but 16 files wide.
- **Neither:** the danger *fills* — `bg-red-500` (11), `bg-red-600` (3), `text-white` (4),
  `border-red-500` (7) — hold ≥3.8:1 (red-500 against white) and ≥4.8:1 (red-600), so they are
  off-palette rather than unreadable. These are the honest debt candidates.

**Recommendation: the hybrid — OVERRULED by the owner on 2026-09-15, retained for its rationale.**
The owner chose the widest option: derive the status family *and* migrate all 53 sites in this
feature. See the adjudication block (J1, J2) for the decision, its consequence (a staged slice), and
its reversal condition. What follows is what this spec argued before that call, kept because the
reasoning behind the staging cut comes from it: Land the derivations and the seventeenth token inside the
existing slices, since they cost no files; ship the **inversion** migrations as slice 7 proper
(ten files, at the bound, `BookDetail.tsx` as the absorber); and record the status-site sweep as
debt owned by whoever lands slice 7, swept file by file as those files are next touched. The
reason is the shape of the two changes: inversion is a *correctness* failure with no workaround —
nothing about a light theme makes a backdrop that brightens acceptable — while the status sweep
is a one-class-per-site substitution whose only design content is the tokens, and 16 files of
mechanical substitution inside a theming slice is exactly how the ~10-file bound gets blown for
no design gain. I record the third and narrower option (slice 7 absorbing all 53 sites) as
available but not recommended: it is 15+ files plus the sweep, and its extra content is the
lowest-value third of the change.

**Reversal condition:** if a **light theme is ever the shipped default**, the debt stops being
debt — then the sweep gets its own dispatch and its own budget, and the question below is
answered by "do the whole thing".

---

## 3. Acceptance criteria

Every criterion names a case and a mutation that fails it. Slice numbers match §2. A
criterion whose mutation does not fail it is not a criterion; delete it rather than soften it.

### Slice 1 — token plumbing

**AC1.1 — pixel identity.** *Case:* build at HEAD before the change, launch with
`npx electron . --remote-debugging-port=9222` (the procedure in the `musaeum-app-verification`
skill), capture the grid view with a seeded library, the detail panel open, and the Settings
modal open; repeat on the changed build with no theme configured; compare frames with the
Pillow script (the agent venv is the only interpreter on this machine with PIL).
*Mutation that fails it:* change one hex by one step in the `:root` block (e.g.
`--gold-400: 212 162 78` → `213 162 78`); the diff must be non-empty in the swatch/ring
region. If a one-step change is invisible the capture is not measuring what it claims.

**AC1.2 — no class names change.** *Case:* `git diff --name-only` over the slice;
the touched set is exactly `tailwind.config.js` and `src/index.css`.
*Mutation that fails it:* any edit under `src/components/**` or `src/stores/**` — the change
is confined to the config because Tailwind resolves utilities at build time.

**AC1.3 — slash-opacity survives.** *Case:* in the running app,
`getComputedStyle(document.querySelector('::selection'))`-equivalents are not reachable, so
assert on the resolved CSS instead: the built stylesheet contains a rule for the selection
background whose computed alpha is 0.4, and a focused button renders a gold ring at 0.7
alpha.
*Mutation that fails it:* change one entry to `'var(--gold-500)'` (a plain var, no
`<alpha-value>`) — `bg-gold-500/40` then produces invalid CSS, the declaration is dropped,
and the selection background reads `rgba(0, 0, 0, 0)` with the build still green. **This is
the mutation the slice exists to prevent.**

**AC1.4 — the defaults are the old palette.** *Case:* a unit test asserts the hex→channel
conversion of all **17** `:root` defaults equals the literals in
`git show HEAD:tailwind.config.js` plus the three shadow alphas **and `--scrim`** (which is
`ink-950`'s value by construction — this assertion is what keeps that "by construction" honest
rather than hopeful, A5).
*Mutation that fails it:* transcribe a triplet by hand with one digit wrong (e.g.
`--parchment-faint: 125 114 96` → `125 114 69`); the assertion must fail. Without this test
AC1.1's pixel diff is the only detector, and it is a human judgement.

**AC1.5 — geometry does not move.** *Case:* in the list view, `document.querySelector('table').scrollHeight`
and a rendered row cell's `getBoundingClientRect().height` are identical before and after
(37 and 20+16 respectively, per `ListView.tsx:67` and `library-views.md`).
*Mutation that fails it:* give the shadow variables a fallback that changes box-shadow
spread (e.g. `0 2px 8px rgb(0 0 0 / var(--shadow-a1))` → `0 3px 8px …`); scroll drift, not a
build error.

**AC1.6 — a missing variable fails loudly on screen.** *Case:* with `--shadow-a1` deleted
from `:root`, the app must visibly lose cover shadows — the point is that this is *visible*,
not silent.
*Mutation that fails it:* if removing `--shadow-a1` leaves covers looking identical, the
shadow utility is not consuming the variable and slice 5's derived shadows are fiction.

**AC1.7 — the root scheme is declared, and it is not the reader's one** (amendment round 1, A4).
*Case:* on the unthemed build, `getComputedStyle(document.documentElement).colorScheme` returns
`dark` — read in the running app, not from the source — and after a light theme's tokens are
applied (slice 5) it returns `light`. A second half of the same case: the declaration is on
`:root`, so the *book's* document is unaffected and `ReaderEngine.tsx:67` still owns the
iframe's own scheme.
*Mutation that fails it:* delete the line from `src/index.css` (restoring the first pass's
deferral) — the property reads `''`, and every native control body, the caret and the default
canvas follow the machine instead of the app; the assertion fails. A second mutation: leave the
value pinned at `dark` when a light theme is active — the second half fails, which is exactly the
state the deferral would have shipped.

### Slice 2 — derivation core

**AC2.1 — the prototype's numbers reproduce.** *Case:* a unit test derives the four base16
fixtures and the two `.itermcolors` fixtures and asserts the exact derived values from
`derive.py`'s output (e.g. gruvbox-dark-hard iTerm `ink-950 = #1d2021`, `gold-400 = #fabd2f`,
`shadow = 0.55`; nord `parchment = #d8dee9`; and every audit ratio to one decimal place).
*Mutation that fails it:* swap the surface ladder's linear mix for Oklab — the stop values
move and the assertion fails; the asymmetry is deliberate and load-bearing.

**AC2.2 — floors are enforced, and a failure is a rejection.** *Case:* a fixture palette
whose text and canvas are at the same luminance derives either an adjusted value that
records `parchment raised to meet 4.5:1` **or** is rejected with `{ role, ratio, floor }`
**[A20 — plus the discriminant that landed with it: `kind: 'floor'` and `metric: 'contrast'`;
the three fields the criterion names are all still there, and the test's comment says the
discriminant was added to the shape rather than replacing it. The criterion's general form is
now the audit-table sweep: no success result may carry a row below its own floor.]**
*Mutation that fails it:* remove the terminal verification step — a palette that cannot meet
the floor is then returned as a theme, with an audit row reading `0.99:1 (min 4.0) FAIL` in
the picker. The prototype's bounded loops exit without re-checking; that is the bug this
criterion pins.

**AC2.3 — on-accent is never unreadable.** *Case:* for all seven prototype palettes,
`contrast(onAccent, gold-500) ≥ 4.0` and `contrast(gold-400, ink-900) ≥ 3.0`.
*Mutation that fails it:* delete the fill-walk loop so `gold-500` stays the raw accent —
catppuccin-latte then fails 4:1 (measured: the prototype needed the walk for the light
scheme) and the assertion fails.

**AC2.4 — the iTerm grey filter does its job.** **[Amended 2026-09-15, A14 — the superseded clause is
kept below the replacement.]** *Case, in three fixtures, because the round-1 wording is not satisfiable on
the one it named:*
(a) **on the iTerm nord fixture**, which satisfies it exactly: every derived surface-ladder stop has
`hue_delta(stop, bg) < 0.61` — measured 0.000–0.003. This is a **property pin, not a discriminator**,
and the test says so: measured, nord satisfies the clause with the hue half of the filter deleted
too, because every slot the filter rejects there is rejected for chroma alone.
(b) **on the iTerm gruvbox fixture**, the property the criterion protects, asserted three ways: the
filter excludes **every** chromatic ANSI slot under both clauses (no `accents` member is admitted as a
surface candidate); the derived ladder is grey at every stop (`chroma < 0.035`, the filter's own
threshold) and rises monotonically from the canvas; and gruvbox's green (Ansi 2) sits inside the
bg→fg luminance window, so an unfiltered luminance sort has it available for `bg2` — a warm scheme with
a green sidebar.
(c) **on a synthetic `.itermcolors` built inline in the test** — no fixture file, nothing vendored —
the *separating* witness for the hue half, since (a) cannot discriminate and (b) does not exercise it:
a canvas of `#1b2b3a` whose Oklab chroma is **0.0351**, above the filter's own 0.01 bypass, plus an
off-hue near-grey (`#5a4a3a`: chroma 0.0333 < 0.035, `hue_delta` 3.1264 >= 0.61) placed at an interior
luminance — strictly between the canvas and the foreground, and between the two in-family greys, so a
luminance sort would put it in the middle of the ladder. With the real filter the ladder is
`#3a4b57`/`#506070`/`#506070`; with the hue clause deleted, `bg3` becomes `#5a4a3a` and exactly one
case reddens.

*Mutation that fails it:* replace the chroma/hue filter with a luminance sort of all ANSI slots; on
gruvbox the ladder then picks up the green and **three** assertions redden (measured: the candidate
exclusion, the grey-ladder check, and the IR equality), and on the synthetic file of (c) the hue clause
alone is what excludes the off-hue grey — **one more** case reddens. The prototype measured the
luminance-sort failure on gruvbox specifically, and gruvbox still carries that mutation — it just
cannot carry the literal `hue_delta` clause, because the fixture's own canvas chroma (0.0049) is under
the filter's 0.01 bypass, so its hue clause never engages and the near-grey stops' hue angles are
numerical noise (measured 1.294–2.471 across six of the seven stops).

*Superseded clause, kept visible (A14):* "the iTerm gruvbox fixture derives a surface ladder whose every
stop has `hue_delta(stop, bg) < 0.61` — no green sidebar."

*Reversal condition:* if a fixture appears for which the literal clause holds **and** the luminance-sort
mutation still reddens it, restore the literal wording on that fixture. Otherwise the synthetic case of
(c) is what decides the clause, and the nord pin of (a) documents the property without deciding it.

**[A19 — landed form, 2026-09-15.** All three halves are asserted in
`electron/main/services/theme/parse.test.ts`, and the mutation was applied by both the implementer and
the orchestrator: `isGrey` reduced to `chroma(slot) < 0.035` reddens exactly the synthetic case, and
M7/M8 of the orchestrator's campaign show the nord pin staying green under the same mutation (as its
comment claims). The clause is inert on both vendored fixtures and live on a constructed one — which is
the honest limit, and the reason the synthetic case exists.]**

**AC2.5 — adaptation is lossless where base16 has the semantics.** *Case:* the base16
adapter's IR for a scheme reads `bg`=base00, `fg`=base05, `accent_hint`=base09, no notes.
*Mutation that fails it:* re-derive `bg2`/`bg3` from the ladder instead of reading base01/02
— the base16 row then disagrees with its source file and the assertion fails.

**AC2.6 — a bad file is reported, never thrown.** *Case:* pointing the loader at a truncated
`.itermcolors`, a base16 YAML missing `base0A`, and a plain text file returns
`{ ok: false, reason }` three times; nothing lands in `app_config` and the app's active theme
is unchanged. *Mutation that fails it:* let the parse error propagate — the IPC envelope
turns it into an error toast instead of a per-row reason, and an import of five files with
one bad member reports nothing about the other four. **[A18 — the case's second clause, "nothing lands
in `app_config` and the app's active theme is unchanged", has no decider in slice 2 and cannot have
one: slice 2 owns no storage. It is **AC3.3**'s assertion ("a rejected theme changes nothing"), which
is where it is decided; slice 2's half is the three rejection *values*, and all three are asserted.
Recorded so the clause is not read as an untested claim about this slice.]**

### Slice 3 — persistence and apply-on-boot

**AC3.1 — the window background follows the theme.** *Case:* with a light theme's tokens
stored, the pure `windowBackgroundColor(tokens)` returns that theme's `ink-950`, and the
window constructed by `createWindow()` carries it. Since the test electron mock's
`BrowserWindow` is an empty class, extend it to record constructor options (additively — the
existing 17 suites must stay green) and assert on the recorded `backgroundColor`.
*Mutation that fails it:* restore `backgroundColor: '#0d0b09'` — a light-theme user gets a
near-black frame at every launch and the assertion fails.

**AC3.2 — one write path, both keys, atomically.** *Case:* `theme.set(id)` writes `theme_id`
and `theme_tokens` in one transaction; `getConfig('theme_id')` and a parsed
`getConfig('theme_tokens')` agree on `id` after every call, including after a rejection.
*Mutation that fails it:* write only `theme_tokens` — the picker then shows the *previous*
theme as active while the app renders the new one, and the assertion on `id` fails.

**AC3.3 — a rejected theme changes nothing.** *Case:* `theme.set('obsidian:Broken')` where
the theme's roles do not resolve returns a reason, and both `theme_id` and `theme_tokens` are
byte-identical to their values before the call.
*Mutation that fails it:* write `theme_id` first and derive second (the natural order) — a
bad theme then leaves the app pointing at a theme it cannot render, and the assertion fails.

**AC3.4 — storage is not trusted.** *Case:* with `theme_tokens` set to each of `''`,
`'not json'`, `'{"tokens":{"ink":{"950":"#0d0b09"}}}'` (15 values missing) and a record whose
`variant` is `'sepia'`, `theme.get()` returns the built-in default and the app renders today's
pixels.
*Mutation that fails it:* skip read validation — the second case throws inside the renderer's
apply path and the app renders a blank body, which is the same class of failure
`sanitizePrefs` exists to prevent.

**AC3.5 — no flash.** *Case:* launching with a light theme stored, a frame captured as early
as CDP allows shows a light canvas and the window's own background is light.
*Mutation that fails it:* move the pre-paint apply out of `src/main.tsx` into a `useEffect` in
`useTheme` — one or more frames render the default dark palette first. (The window background
from AC3.1 masks the *window*, not the body, so both halves of §2.3 are needed.)

### Slice 4 — import and picker

**AC4.1 — the three provider types import.** *Case:* importing a base16 `.yaml`, an
`.itermcolors`, and (from slice 6) an Obsidian folder each yields a row in the appearance list
with a name, a provider label, a variant badge and five swatches.
*Mutation that fails it:* route by directory instead of by extension/content — the owner's
`.itermcolors` files live in ProtonDrive, so nothing is discovered and the list stays empty.

**AC4.2 — import is validated before it is stored.** *Case:* a batch of five files with one
malformed returns `{ imported: 4, rejected: [{ path, reason }] }`, and the four are usable.
*Mutation that fails it:* abort the batch on the first failure — the count is `0` and the
four good themes are lost.

**AC4.3 — the drop-box directory works and is never written to.** *Case:* dropping three
`.itermcolors` into `~/Library/Application Support/Musaeum/themes/` and pressing the refresh
control shows three new rows; a directory hash taken before and after the scan is unchanged.
*Mutation that fails it:* copy or normalize the source files into the folder during import —
the hash changes and the assertion fails. The app derives and stores values; the folder is
the user's.

**AC4.4 — a theme drop does not become a book import.** *Case:* dropping a `.yaml` on the
library grid leaves the import pipeline idle (no `importProgress` event, no job row in
`StatusBar`) and starts no hydration.
*Mutation that fails it:* add `.yaml`/`.itermcolors` to `useDragDrop`'s extension filter — the
import job starts, `import:addFiles` receives a path it cannot read, and the assertion on the
absence of a progress event fails.

**AC4.5 — applying is immediate.** *Case:* clicking a theme row — with no ⌘↵ and without
closing the modal — changes the document's `--ink-950` and the window background in the same
interaction.
*Mutation that fails it:* route the theme through `settings.save`'s batched save — the row
highlights and nothing repaints until save, and the assertion fails.

### Slice 5 — reader convergence and the light flip

**AC5.1 — the reader follows the app theme.** *Case:* with a light theme active, opening a
book renders light page background and dark body text; the injected `pageCss` contains no
literal hex from `PALETTE`.
*Mutation that fails it:* leave one branch on `PALETTE[prefs.theme]` — the page stays dark
inside a light app, and the assertion fails.

**AC5.2 — the default is a no-op for the built-in theme.** *Case:* with no theme configured
and `prefs.theme = 'auto'`, the derived page palette equals today's `ink` row
(`#14110d` / `#e9e1d2` / `#b3a78f` / `#d4a24e`) exactly.
*Mutation that fails it:* map the page to `ink-950` instead of `ink-900`; the frame differs
from the pre-change capture and the assertion fails. (Settled deliberately in §2.5; the
mutation is what proves the choice was made rather than happened.)

**AC5.3 — an unknown pref falls back.** *Case:* `sanitizePrefs({ theme: 'sepia' })` returns
the default, and `sanitizePrefs({ theme: 'ink' })` returns `'ink'` (an old stored value keeps
its meaning).
*Mutation that fails it:* widen `THEME_OPTIONS` but not `sanitizePrefs`' validator (or the
reverse) — the popover can then produce a value storage rejects, which is the drift
`reader.store.ts:31-35` says the shared list exists to prevent.

**AC5.4 — shadows are derived, not authored.** *Case:* for a light theme,
`shadowStrength = 0.16` yields alphas `0.145 / 0.102 / 0.175`; for a dark theme,
`0.500 / 0.350 / 0.600`.
*Mutation that fails it:* hardcode `--shadow-aN` in the stylesheet instead of writing them
from the tokens — the light theme keeps the dark alpha and covers turn to mud on a light
canvas (the prototype's measured complaint).

**AC5.5 — native appearance agrees.** *Case:* `nativeTheme.themeSource` is `'light'` with a
light theme stored and `'dark'` otherwise, read back after `theme.set`.
*Mutation that fails it:* set it once at boot only — switching to a light theme leaves native
scrollbars and menus dark, and the assertion after `theme.set` fails.

**AC5.6 — the book's own typography still wins.** *Case:* a book whose stylesheet sets
`font-family` and `background` keeps them; the injected CSS adds no `!important` and does not
move the reader's `z-[45]`.
*Mutation that fails it:* prefix the injected rules with `!important` — the book's own
typography is overridden and the visual check fails.

**AC5.7 — the injected stylesheet carries resolved literals, not variable references**
(amendment round 1, A7 — constraint (a) of §2.5, from `paginator.js:191/626/685/1113`).
*Case:* with a non-default theme active, open a book and read three things: the string
`pageCss()` returns contains **no `var(`**; the book document's
`getComputedStyle(document.body).backgroundColor` is the derived `ink-900` as a resolved
`rgb(…)`, not `rgba(0, 0, 0, 0)`; and the paginator's own background element — the element the
vendored code writes at `:626`, `:685` and `:1113` — computes to that same colour rather than to
transparent. (Read the paginator's own element via the reader's DOM, or assert on the three
source lines being reached with a non-transparent value; the point is that the *resolved* value
survives the round trip.)
*Mutation that fails it:* make `pageCss()` emit `var(--ink-900)` (the natural thing to write,
once the variables exist in the app). The custom property is defined on the *app's* `:root` and
the book renders in its own document with no access to it, so the value is unresolved: `body`
computes `rgba(0, 0, 0, 0)`, `paginator.js:191`'s string comparison then takes its fallback
branch (the document element, equally unresolved), the engine writes that into its own background
element, and the margin around the page stops being painted with the page's colour. The
assertion fails on the `rgba(0, 0, 0, 0)` read, before any human looks at the frame.

**AC5.8 — the selection colour is not an alpha suffix pasted onto a token** (amendment round 1,
A7 — constraint (b) of §2.5, from `ReaderEngine.tsx:104`).
*Case:* `pageCss()`'s output matches `::selection { background: #[0-9a-f]{6}44; }`, the six hex
digits equal the derived link colour, and in the app a book's selected text paints gold-tinted
rather than UA blue.
*Mutation that fails it:* change `pageCss()`'s link expression to `var(--gold-400)` while leaving
`${c.link}44` in place — the declaration becomes `var(--gold-400)44`, which is not a valid
`<color>`, so the rule is dropped and `::selection` falls back to the UA default; the assertion
on the rule fails. The fix is the composed literal (`linkAlphaHex` from `readerPalette()`,
§2.5(b)), chosen so that AC5.7's "no `var(`" property and this criterion hold for the same
reason.

### Slice 6 — the Obsidian resolver

**AC6.1 — one theme resolves that a scrape cannot.** *Case:* the resolver returns hex values
for all nine roles for a theme whose declarations are computed (`hsl(var(--base-h), …)`,
`var()` chains, `color-mix()`).
*Mutation that fails it:* replace the offscreen read with the regex scrape — the same theme
returns `roles unresolvable` (measured: 4 of the 5 installed themes fail this way) and the
assertion fails.

**AC6.2 — no network.** *Case:* a theme.css containing
`@import url("https://example.com/track.css")`, `--x: url("http://example.com/beacon.png")`
and an `url(https://…woff2)` `@font-face` resolves with the request counter at **0**
(instrument `onBeforeRequest`: every invocation must be cancelled, and no request may reach
the network).
*Mutation that fails it:* remove the session's `onBeforeRequest` cancel-all — the counter
becomes non-zero and the assertion fails. Relying on the CSP alone also fails this, because
the criterion counts *attempts*, not responses.

**AC6.3 — the stylesheet never reaches the renderer.** *Case:* after a resolve, the renderer's
`document.styleSheets` count is unchanged, and the IPC payload for the theme contains no
value outside `^#[0-9a-f]{6}$` (grep the serialized payload for `{`, `url(`, `@`, `#`+non-hex).
*Mutation that fails it:* have the resolver return the CSS text so the renderer can apply it
directly — `document.styleSheets.length` grows and the payload assertion fails. This is also
the mutation that models the security failure the slice's design exists to prevent.

**AC6.4 — a non-hex role is rejected, not coerced.** *Case:* a theme whose
`--text-normal: none` (or an `rgba()` value) is rejected with the role named; no partial theme
is stored.
*Mutation that fails it:* accept any non-empty string and pass it through — the payload
assertion in AC6.3 fails on the first such theme, and an unvalidated value would reach the
CSS variable write in the renderer.

**AC6.5 — the resolver cannot escape.** *Case:* the resolver window has no preload, no
`nodeIntegration`; a theme.css that tries `window.open('https://…')` opens nothing
(`setWindowOpenHandler` denies) and a theme that never resolves is destroyed within the
timeout.
*Mutation that fails it:* give the resolver window a preload or `sandbox: false` — the
escape surface exists and the test that asserts the `webPreferences` shape fails.

**AC6.6 — timeouts and cleanup.** *Case:* a theme.css of 5 MB, and a theme with 2000
declarations, both resolve within the timeout and the window is destroyed afterwards
(no orphaned `BrowserWindow` in `BrowserWindow.getAllWindows()`).
*Mutation that fails it:* drop the destroy — the assertion on the window count fails, and a
long session accumulates hidden windows holding a partition cache.

### Cross-slice

**AC7.1 — the gate stays clean.** *Case:* `npm run typecheck`, `npm run lint`, `npm test` all
exit 0 on the slice branch.
*Mutation that fails it:* leave an orphan `parse` export or an `any` — typecheck or lint
fails, which is the whole point of a cheap gate. (Baseline: 270 tests / 17 files.)

**AC7.2 — no invariant bends.** *Case:* a diff review against the invariant list: no
`vendor/foliate-js/**` change; no `file://` reaching the renderer; no new native-menu item;
`ROW_HEIGHT`/`CARD_META_HEIGHT`/`CARD_META_MARGIN` untouched in slice 1; `app.isPackaged`
never read outside `services/runtime.ts`.
*Mutation that fails it:* add a "Theme" submenu to `services/menu.ts` so the item can carry a
checkmark; `menu-and-branding.md`'s "built once and never rebuilt" is then false and the
review fails.

**AC7.3 — nothing is written to the library.** *Case:* after importing three themes and
switching between them, no `metadata.json`, `catalog.json` or book file has a new mtime.
*Mutation that fails it:* store the theme inside the library root (an obvious temptation, since
the library is where "settings" would sync) — the mtime assertion fails, and every theme
change would then be a NAS write and a cross-machine surprise.

**AC7.4 — the `gold-200` defect is registered, not silently fixed** (amendment round 1, A9/G1).
*Case:* a diff review shows `SelectionPanel.tsx` and `ListView.tsx` untouched by slice 1 (AC1.2
already asserts the touched set is two files), and the four sites are listed in `tasks.md` with
the chosen remedy and an owner.
*Mutation that fails it:* "fix it while you're in there" — the pixel gate then has an undefined
baseline (two components change under a slice whose whole burden is *no* visual change), so
AC1.1 and AC1.2 fail together, and the remedy is chosen by whoever is nearest rather than
decided. The mutation is the temptation; the criterion exists so the temptation is visible.

### Slice 7 (committed — 7a) — status colours, scrim, hairline

Numbered AC8.x so they cannot be confused with the cross-slice AC7.x block above. Slice 7 is
**approved and staged** (J1, J2), so every criterion below applies, and 7b adds its own
grep-to-zero acceptance. These criteria were written while the slice was still a proposal, and a proposal that keeps its
criteria is a proposal someone can resume.

**AC8.1 — no veil lightens** (the criterion the slice exists for).
*Case:* with a light theme active, every one of the twelve scrim sites computes a
`background-color` that composites **below** the canvas behind it — specifically, the modal
backdrop element at `SettingsModal.tsx:137` and the chip at `BookCard.tsx:114` each composite to
an `lstar` at least 0.25 under `lstar(canvas)` — and the glyph on the chip keeps
`contrast(glyph, composited chip) ≥ 3.0`.
*Mutation that fails it:* alias `scrim` to `ink-950` (or leave the twelve sites on
`bg-ink-950/80`) — under a light palette `ink-950` *is* the canvas and the lightest tone, so the
backdrop composites *above* the canvas luminance, the chip's gold glyph sits on near-white, and
both halves of the assertion fail. This is why `scrim` is derived rather than aliased (§1.1).

**AC8.2 — status colours hold their floors in the variant they render on.**
*Case:* for the seven prototype palettes plus one light fixture, `contrast(on-danger, danger-500)
≥ 4.5` and `contrast(danger-400, ink-900) ≥ 3.0`, with the same shape for `ok` and `warn`; and in
the app, the danger text in the delete confirmation reads at ≥ 4.5 against the themed panel under
a light theme.
*Mutation that fails it:* leave the status sites on Tailwind's literals (`text-red-400`) — against
a light panel that measures ≈2.3:1, so the assertion fails. That measurement is the entire
justification for the slice's status half, and it is the number to re-take if anyone proposes
keeping the literals.

**AC8.3 — the hairline is visible on both variants.**
*Case:* the cover ring at `BookCard.tsx:79` and `BookDetail.tsx:81` composites to a non-zero
contrast against both the cover art and the surface behind it, under a light theme and a dark one.
*Mutation that fails it:* leave `ring-white/5` — on a light surface the ring composites to a
difference under 1% luminance and the assertion fails. The fix is `ring-parchment/5`: `parchment`
is by construction the tone that contrasts with the canvas, so it needs no eighteenth token
(and `scrim` cannot serve, being near-black in both variants). The dark-theme pixel shift this
costs — white at 5% to parchment at 5% — is accepted here and named in §2.7, not hidden.

---

## 4. Impact

**What moves**

- `tailwind.config.js` and `src/index.css` stop being the palette and become the palette's
  *default*. Every utility keeps its name and its meaning; none of the 27 component files
  that use them changes in slice 1.
- The reader's page colours stop being a hand-copied table and become derived
  (`ReaderEngine.tsx:48-50` and its "a palette change has to update this table too" comment
  go away). `ReaderPrefs.theme` gains `'auto'` and defaults to it; stored `'ink'`/`'paper'`
  keep their meaning.
- `electron/main/index.ts` stops hardcoding a colour; `backgroundColor` becomes a function of
  the stored theme, and the window's background changes on a theme switch.
- A new `app_config` pair (`theme_id`, `theme_tokens`) is the app's first *main-process-visible*
  user preference of this kind. Nothing about `app_config`'s shape changes; no migration runs
  (F9), and `MIGRATIONS` in `db.ts:19` stays at three entries.
- New IPC namespace `theme` + one event channel. `MusaeumAPI` grows; `src/types/musaeum.d.ts`
  needs no change (it only re-exports `MusaeumAPI`).
- An imported theme's *lossy steps are visible in the UI* (notes/adjustments), which is new
  surface for honesty rather than a behaviour change.
- **Amended (A4/A6): the app gains a declared scheme on `:root`.** `color-scheme` was previously
  absent from the renderer entirely — only the book iframe declared one — so on a
  light-appearance machine the native control bodies, the caret and the default canvas follow the
  app's scheme from slice 1 onward. This is the one *intended* pixel change in slice 1, and it is
  what makes a light theme possible at all (§2.1, AC1.7).
- **Amended (A2/A5): the derived set is 17 values, and `scrim` is one of them.** Slice 1 defines it
  (defaulting to today's `ink-950`), so nothing moves until slice 7 renames the twelve veil sites.
- **Amended (A3/G3): a light theme is not "the same layout in different colours".** Under a
  flipped ramp the twelve veils and the two cover hairlines invert or vanish unless they are
  migrated (§2.7, AC8.1/AC8.3). That is the change surface the first pass missed and the audit was
  right about: the palette is not the whole of what a theme decides.

**What must not move**

- Row geometry (`library-views.md`): nothing in any slice is allowed to change
  `ROW_HEIGHT` / `CARD_META_HEIGHT` / `CARD_META_MARGIN` or a real row's height.
- The native menu (`menu-and-branding.md`): no theme item, no checkmark, no rebuild.
- `vendor/foliate-js/**`: untouched (invariant #11).
- `app.isPackaged` honesty (invariant #10): untouched; `services/runtime.ts` remains the only
  answer.
- The reader's z-order contract (`z-[45]`) and its focus/keyboard guards: untouched.
- The renderer's file access (invariant #9): paths cross the boundary; bytes never do.
- Non-fatal degradation (invariant #12): a broken theme is reported, never thrown.
- **The four `gold-200` sites** (amendment round 1, G1): they are a pre-existing defect, not a
  theming one, and slice 1's pixel gate depends on them being unchanged (AC7.4). Correcting them
  is its own two-file change, listed as debt.
- **`vendor/foliate-js/paginator.js`'s read-back path** (G8): the engine keeps reading the book
  document's resolved background and re-applying it to its own element. Nothing in this feature
  may "fix" that by reaching into the vendor tree; the constraint is absorbed by making the
  injected stylesheet literal-valued (AC5.7).

**Documentation debts this spec creates and cannot pay** (I may write only this file):

- **`CLAUDE.md`** — "Design tokens live in `tailwind.config.js`" and the Project Overview's
  fixed "warm near-black surfaces, amber/gold accents" become *partially* false once the
  palette is a default rather than the identity. It also has no invariant covering theming.
  **This needs an owner-visible edit.** Amended (A1): that first line is *already* incomplete at
  HEAD — 63 opacity-modified token utilities, 12 veils, 53 stock-palette utilities and a missing
  root `color-scheme` are all colour decisions living outside that file (§1.3) — so the edit
  should say where a colour decision lives, not only where the palette does.
- **`docs/invariants/settings-and-editing.md`** — should gain the `theme_id` /
  `theme_tokens` keys, the one-transaction rule and the read-validation rule, next to
  `app_config`.
- **`docs/invariants/reader.md`** — says the reader offers "two page themes — warm paper and
  dark-library ink". After slice 5 the default follows the app theme and the two named rows
  are overrides. The paragraph becomes stale.
- **`docs/architecture.md`** — its directory listing gains `electron/main/services/theme/`
  and `src/lib/theme/`.
- **`tasks.md`** — the six approved slices **plus slice 7 as proposed** (§2.7), the deferred token
  rename (product decision 6), the Obsidian-storage decision if it goes the other way, the
  "per-reader/per-book palette" item §2.5 defers, the **`gold-200` defect with its owner and the
  decided remedy** (AC7.4), and — if slice 7 ships in the bounded shape — the **53-site status
  sweep as named debt with an owner** (§2.7a).
- **`CHANGELOG.md`** — per shipped slice.
- **`electron-builder.yml`** — **no change needed**, and that is a design choice, not luck:
  built-in schemes are imported `?raw` into the main bundle (the precedent is
  `db.ts:15-17` importing the SQL migrations the same way), so `files: [out/**, package.json]`
  already covers them. If someone instead ships them as `extraResources`, that file changes
  and packaging docs change with it.
- **`package.json`** — no new dependency is planned (§2.2). If a real provider file breaks the
  narrow parsers, adding `js-yaml`/`plist` is a `package.json` edit and therefore an
  escalation.

---

## 5. File budget

`CLAUDE.md` escalates at "roughly 10 files". Tests are **counted** here (they are code, and
the repo's own specs count them). Vendor data is not: `builtin/*.yaml` are third-party files
with their own licences, the same category as `vendor/foliate-js/` — and they double as
slice 2's base16 fixture corpus so no second copy exists in the repo.

| Slice | Code files | Test files | Data | Overrun absorber |
|---|---|---|---|---|
| 1. Token plumbing | 2 (`tailwind.config.js`, `src/index.css`) — **unchanged by A4/A5, and this is the point**: the root `color-scheme` declaration and the `--scrim` default are both lines inside `src/index.css`, a file this slice already owns, so slice 1 gains no third file | 1 (default-conversion assertion, AC1.4 — may live in an existing renderer test file) | — | none needed; a third CSS file folds into `src/index.css` |
| 2. Derivation core | 6 (`src/types/theme.types.ts`, `theme/color.ts`, `theme/derive.ts`, `theme/parse/base16.ts`, `theme/parse/itermcolors.ts`, `theme/index.ts`) | 2 (`theme/derive.test.ts`, `theme/parse.test.ts`) | `test/fixtures/theme/*.itermcolors` (2) + `builtin/*.yaml` (**13**, vendored — A15; the round-1 figure of 10 was the curated set's size as counted then) | `parse/base16.ts` + `parse/itermcolors.ts` → one `parse.ts` |
| 3. Persistence + boot | 9 (`theme/store.ts`, `ipc/theme.ts`, `main/index.ts`, `src/types/api.types.ts`, `electron/preload/index.ts`, `src/stores/theme.store.ts`, `src/hooks/useTheme.ts`, `src/lib/theme/css.ts`, `src/main.tsx`) | 2 (`theme/store.test.ts`, `src/lib/theme/css.test.ts`) + `test/mocks/electron.ts` extended (shared infra) | — | `src/main.tsx` merges into `src/lib/theme/css.ts` (8) |
| 4. Import + picker | 7 (`theme/importer.ts`, `ipc/theme.ts`, `preload/index.ts`, `src/types/api.types.ts`, `src/components/settings/AppearanceSection.tsx`, `SettingsModal.tsx`, `src/stores/theme.store.ts`) | 1 (`theme/importer.test.ts`) | — | `AppearanceSection` row rendering folds into `SettingsModal.tsx` |
| 5. Reader + flip | 6 (`src/lib/theme/reader-palette.ts`, `ReaderEngine.tsx`, `src/stores/reader.store.ts`, `ReaderPrefsPopover.tsx`, `main/index.ts`, `theme/store.ts`) + `tailwind.config.js` if the shadow vars are touched | 2 (`reader-palette.test.ts` new, `reader.store.test.ts` extended) | — | `reader-palette.ts` folds into `src/lib/theme/css.ts` |
| 6. Obsidian resolver | 3 (`theme/resolve-css.ts`, `theme/parse/obsidian.ts`, `theme/index.ts`) + `theme/importer.ts` | 1 (`theme/obsidian.test.ts`, with synthetic CSS fixtures inline — **do not vendor a user's theme file**) | — | `parse/obsidian.ts` folds into `theme/index.ts` |
| **7. Status + scrim + hairline — COMMITTED, staged 7a (bounded) and 7b (the sweep) (§2.7)** | **15 at its widest**, **10 with the named absorber** (`theme/derive.ts`, `src/types/theme.types.ts`, `theme/store.ts`, `src/lib/theme/css.ts`, `tailwind.config.js` + the ten components that invert: the eight modal files, `BookCard.tsx`, `BookDetail.tsx`) | 1 (`theme/derive.test.ts` extended — no new test file) | — | **`src/components/library/BookDetail.tsx`**: its single hairline site leaves first (cosmetic — the cover is already edged by `shadow-cover`), then the status sites in files the slice does not otherwise open leave as debt (§2.7a) |

Every *approved* slice is inside the bound, and slices 3 and 5 sit right at it.
**Amended (A10): the committed slice 7 is the exception** — drawn at its widest (every one of the
53 status sites) it is 15 code files + 1 test, five past the bound, which is exactly why it is
**staged into 7a (10 files, at the bound once the named absorber is taken) and 7b (the status sweep)**
rather than shrunk or folded into the approved list — see the adjudication block (J1, J2). `/Users/jasonoh/theme-probe`
is a scratch prototype outside the repo; nothing there is copied in except the two
`.itermcolors` fixtures, the four base16 fixtures and the curated set — all provider files the
port needs to be testable against real corpora.

---

## 6. Known weak spots

Expected, not only observed. Each is here so it is recognised rather than re-diagnosed.

1. **The silent CSS failure is the whole slice 1 risk.** A missing or malformed channel
   triplet does not fail a build, a lint, or a test — it drops a declaration and renders the
   wrong colour, in the worst case a transparent body over a white canvas. AC1.3 and AC1.4
   exist because neither `npm test` nor a code review reliably catches it.
2. **The pixel gate needs a seeded app.** `musaeum-app-verification` warns that dev and
   packaged builds share the real library and that a clicked button is a real write. The
   before/after captures must use a seeded library with no writes, and persisted UI state
   (`musaeum.ui`, `musaeum.library` in `localStorage`) must be identical across both captures
   or the diff is noise. Getting this wrong makes AC1.1 pass for the wrong reason.
3. **iTerm ramp reconstruction is the lossy step, and it will be seen.** A terminal file has
   no base01–03, so the ladder is invented from greys that may number 3 (measured: "ramp
   inferred from 3 greys"). Some schemes will have a sidebar that is a guess. The IR's `notes`
   and the picker's disclosure are the mitigation; expect at least one scheme to look wrong,
   and that is a corpus property, not a bug.
4. **The same scheme via two providers does not converge** (gruvbox base16 `base05` `#d5c4a1`
   vs iTerm `Foreground Color` `#ebdbb2`). Two defensible readings of one palette; the UI
   names the provider so this reads as a choice rather than a defect. Anyone who "fixes" it
   by hardcoding a preference is re-introducing the thing the IR exists to avoid.
5. **Light themes are where the derivation is least tested.** The prototype needed the
   on-accent fill walk specifically for catppuccin-latte, and the shadow strength flips
   0.55→0.16. Every light theme in the corpus is a first-class risk. **[A15 — corrected: the curated set is not
   half light. Four of its thirteen schemes are light (`catppuccin-latte`, `gruvbox-light-soft`,
   `solarized-light`, `tokyo-night-light`), so light variants are exercised, but thinly — and slice 2
   is now the layer carrying that risk.]**
6. **Blanking out the reader default is a visible change if `auto` maps wrong.** AC5.2 pins
   `ink-900`; if a reviewer later decides `ink-950`, that is a real one-step page-background
   change that should be made on purpose.
7. **Slice 6 is the largest new security surface in the app**, and its safety rests on
   "hex-only payload" plus "cancel every request". Both are testable and both must be
   asserted (AC6.2, AC6.3); a reviewer who accepts the design on its prose is accepting the
   only thing in this feature that executes third-party input in a Chromium context.
8. **`test/mocks/electron.ts` is shared infrastructure.** Slice 3 extends `BrowserWindow` to
   record constructor options; an edit that changes the mock's shape rather than adding to it
   breaks suites that have nothing to do with theming. Make it additive, and run the full
   suite.
9. **The two-key storage can drift** (§2.3's reversal condition). The mitigation is one write
   path plus AC3.2; if a drift bug appears anyway, collapse to one key rather than adding a
   third reconciliation step.
10. **A theme is not versioned.** A future change to the derivation (a floor, a stop, an
    accent rule) leaves stored tokens derived by the old rules, and nothing will notice. The
    honest fix is a `theme_engine_version` key and a re-derive on mismatch; it is *not* in
    scope, and the weak spot is recorded so that the first time a rule changes, whoever
    changes it knows stored themes are stale rather than broken.
11. **The `gold-200` defect is live and will look like a theming bug.** Four sites name a step
    that does not exist (§1.3 C1), so they paint nothing — and the first person to try a light
    theme will see a selection panel that "lost its gold" and blame the theme. It is not the
    theme: it is broken today, on the dark default, before this feature exists. Registered and
    kept out of slice 1 by AC7.4 for that exact reason.
12. **The status colours are the honest debt, and the debt has a symptom.** 23 `text-red-400`
    sites measure ≈2.3:1 on a light panel (§2.7a). If slice 7 ships in the bounded shape, that
    number is what a light-theme user sees. The mitigation is that it is uniform and greppable
    (`text-red-400` → `text-danger-400`), not that it is invisible.
13. **`scrim` has two jobs and one derivation.** §2.7 assumes one scrim role serves both the
    eight modal veils and the four over-cover chips — but a veil is a large translucent field
    where a palette-tinted dark end is fine, while a chip is tiny and sits over arbitrary art,
    where a hue-cast veil can read as mud against a saturated cover. Expect the chips to want a
    neutralised scrim (a change to one constant, not to the role). This is why AC8.1 asserts on
    composited luminance and on contrast over the chip, rather than on the token's own value.
14. **The literal requirement in `pageCss()` is easy to break, and breaking it is silent.**
    AC5.7/AC5.8 pin the two shapes that break it today (`var(`, an appended alpha suffix), but
    any future edit that *computes* a colour (template arithmetic, `color-mix()`) reintroduces
    the failure in a third shape. The mitigation is that a single assertion — "the returned
    string contains no `var(`" — covers the whole stylesheet, which is exactly why that form was
    chosen for the fix in §2.5(b) rather than a `color-mix()` expression.
15. **Slice 1's `color-scheme` line is a real pixel change on a light-OS machine**, and AC1.1's
    scoping is the only thing keeping the gate honest. If an implementer takes the before/after
    captures in light OS appearance and sees a diff, the correct response is *not* to drop the
    declaration — it is to re-take the capture in the state the criterion names (§2.1, AC1.7).

---

## 7. Measurement ledger

### Executed (I ran it, on this machine, 2026-09-15)

- `git log --oneline -3` → HEAD `bdc54ec` "agent config + cc optimization", tree clean.
- `npm run typecheck` → exit 0. `npm run lint` → exit 0.
- `npm test` → **270 passed, 17 files** ("Test Files 17 passed (17)", "Tests 270 passed
  (270)").
- Greps for token utilities, runtime token reads, `currentColor`, inline styles, hex literals
  under `electron/` — the counts in §1.2 (F3, F7, F8, F5).
- Reads: `tailwind.config.js`, `src/index.css`, `ReaderEngine.tsx:1-120`,
  `src/stores/reader.store.ts`, `ReaderPrefsPopover.tsx` (theme usage), `reader.store.test.ts`,
  `electron/main/index.ts` (all 195 lines), `services/db.ts:1-110`, `services/settings.ts`,
  `ipc/handle.ts`, `ipc/settings.ts`, `preload/index.ts`, `src/types/api.types.ts`,
  `src/types/settings.types.ts`, `settings.types.ts`/`musaeum.d.ts`, `window-chrome`
  consumers, `SettingsModal.tsx:1-120`, `useDragDrop.ts`, `vitest.config.ts`,
  `test/mocks/electron.ts`, `electron-builder.yml`, `electron.vite.config.ts`, both tsconfigs,
  `index.html`, `nas-manager.ts:1-70`, `001_initial.sql:85-96`, `docs/architecture.md:1-80`,
  the three existing specs, and the four invariant docs named at the top.
- `python3 derive.py` in `/Users/jasonoh/theme-probe` → 7 palettes × 6 audits, all `OK`;
  `Things`, `Tokyo Night`, `Blue Topaz`, `Dracula + LYT` → `roles unresolvable by scraping` (F11).
- GitHub API: `tinted-theming/schemes` → `spec-0.11`, MIT, `base16/` = 340 entries
  (339 `.yaml` + 1 `.yml`). `mbadolato/iTerm2-Color-Schemes` → `master`, `schemes/` = 614
  `.itermcolors`, and its `LICENSE` fetched and read (MIT collection, per-theme copyright
  carved out) — F12's "not verified" half is now resolved.
- Hex→channel conversion of all 16 defaults plus the shadow alpha scale, computed with node
  (`--shadow` light: 0.145 / 0.102 / 0.175). (Amendment round 1 adds a seventeenth default,
  `--scrim`, which is a *copy* of `--ink-950`'s channels rather than a new conversion — A5 — so
  this row's arithmetic is unchanged.)

### Executed — amendment round 1 (2026-09-15, same machine)

- `git log --oneline -1` → HEAD `bdc54ec`; `git status --porcelain` → exactly one entry, the
  untracked `docs/superpowers/specs/theming.md`. Every count below was taken on that tree.
- **A real Tailwind build** (the executed half of G1):
  `./node_modules/.bin/tailwindcss -c tailwind.config.js -i src/index.css -o /tmp/tw-out.css` →
  "Done in 147ms", output written to `/tmp` (nothing in the repo touched) → `grep -c 'gold-200'`
  = **0**, while `.bg-ink-950` (×3) and `.text-gold-300` (×1) are present as controls. So the four
  `gold-200` classes emit no rule; this is measured, not inferred from the config's key list.
- **Token-utility scans** over `src/**/*.{ts,tsx,css}`, variant- and alpha-aware: **543** token
  utility sites across **28** files (G7); **63** opacity-modified token sites across **20** files
  (G2's headline), whose per-class breakdown is recorded in §1.3 C2 (top rows: `bg-ink-950/80` 9,
  `focus:border-gold-500/60` 4, `placeholder:text-parchment-faint/50` 3,
  `focus:ring-gold-500/30` 3, `hover:border-gold-400/60` 3, `bg-ink-950/70` 3,
  `hover:bg-gold-500/10` 3, then a tail of twos and ones); **53** stock-palette colour sites across
  **16** files (G4), reproducing the dispatch's breakdown site for site.
- **Veil scan** (`bg-ink-950` followed by a slash-alpha, over `src/`): **12** sites in **9** files
  (G3's count) — the sites are listed in §1.3 C3. Two findings from the same scan:
  `BookDetail.tsx` contains no `bg-ink-950` at all, and `BookCard.tsx` contains four of the twelve.
- `grep -rn 'color-scheme' src/ electron/ index.html` → exactly one hit,
  `src/components/reader/ReaderEngine.tsx:67` (G5).
- `grep -rn 'from-|to-|via-'` filtered to token colours over `src/` → exactly one line,
  `BookCard.tsx:28` (G6).
- Reads this round: `vendor/foliate-js/paginator.js` lines 185-200, 618-630, 680-690 and
  1108-1120 (G8a — `:191`, `:626`, `:685`, `:1113`), plus a grep of that file for `link`, `'44'`
  and `::selection` which returns **nothing** (G8b's attribution); `src/components/reader/ReaderEngine.tsx:36-115`;
  all 68 lines of `src/index.css`; `tailwind.config.js:1-35`; `src/components/library/BookCard.tsx`
  lines 25-32, 79 and 96-170; `src/components/library/BookDetail.tsx:81`;
  `src/components/reader/ReaderPrefsPopover.tsx:158-168`;
  `src/components/migration/MigrationWizard.tsx:195-203`.

### Read-only (files read, nothing executed)

Everything else in §1.2's method column, including `derive.py` (read in full, and also run —
see above), `HANDOFF.md`, `preview.html` (listed, not opened in a browser),
`docs/invariants/{settings-and-editing,reader,library-views,menu-and-branding}.md`, and the
three shipped specs read for register.

### Not verified

- **The pixel-identity claim itself (AC1.1).** It is a criterion for the implementer, not a
  measurement I took: I did not build, launch, or capture frames. Nothing in this spec has
  been validated in a running app.
- **Electron 37's exact offscreen/`executeJavaScript` behaviour** under
  `webPreferences.offscreen + sandbox: true`, and whether a cancelled-request session can
  still complete a `data:` document's inline `<style>`. The design assumes both; the first
  implementation task in slice 6 must confirm them before building on them.
- **Whether `onBeforeRequest`'s cancel-all interferes with the data-URL document itself** —
  it must not, but that is an assumption about Electron's ordering, not a measurement.
- **Whether a 10-scheme `?raw` import set survives `electron-vite build` into
  `out/main/**`** — the precedent (`db.ts` importing `.sql?raw`) says yes; I did not run the
  build.
- ~~**The curated set's per-scheme licence status.**~~ **[Resolved 2026-09-15 — A16.** The 13 files
  and the 2 `.itermcolors` are now committed, and every one was checked against its upstream ref:
  thirteen byte-identical to `tinted-theming/schemes@spec-0.11`, the two iTerm files value-identical
  to `mbadolato/iTerm2-Color-Schemes@master`. The collection licences are MIT with a per-scheme
  copyright carve-out, so attribution lives in each file's own `author:` header and in
  `electron/main/services/theme/builtin/VENDORED.md`.**]**
- **Any claim about how a real imported theme *looks*.** Every visual statement here comes
  from the prototype's rendered cards, not from Musaeum.

**Added by amendment round 1, same standing:**

- **The two reader constraints are read, not executed.** I read `paginator.js:191/626/685/1113`
  and `ReaderEngine.tsx:64-105`; I did not launch the app, inject a stylesheet, or observe which
  branch `getBackground()` takes. AC5.7's proposed read (`body` computing `rgba(0, 0, 0, 0)` under
  a `var()`-valued stylesheet) follows from the source path, not from a Chromium measurement.
- **The `scrim` derivation rule is this spec's invention and is unmeasured.** The prototype has no
  scrim, no fixture and no audit for one; the light-variant extrapolation and both floors are a
  *proposed* contract, and AC8.1 is the criterion that decides whether the constant works. The
  dark-variant half is the one part that is checkable today, and it is checkable exactly: byte
  equality with `--ink-950`.
- **The ≈2.3:1 figure for `text-red-400` on a light panel** is a computed estimate from the two
  literals involved, not a measurement of a rendered frame.
- **Whether `ring-parchment/5` is visible *enough* over cover art** is a judgement about a 5%
  hairline, not a measurement; the dark-theme pixel shift it costs (neutral white → parchment at
  5%) is likewise analytic.
- **The file list in §1.3 C3 and the twelve-site count are greps, not runtime observations** — no
  modal was opened in the running app during this round.

---

## Documentation this spec implies but does not write

Per the spec-writer role: the files listed in §4 ("Documentation debts this spec creates and
cannot pay") — `CLAUDE.md`, three invariant docs, `docs/architecture.md`, `tasks.md`,
`CHANGELOG.md` — must be edited by whoever dispatches the slices. I have not touched them,
and this spec is not authority to do so.

---

## Open questions

Decisions this spec does not settle. Each carries my recommendation, labelled as a guess, per the
spec-writer role. §2.6's reference to "Open questions at the end" resolves here (A11).

**Q1 — Does a stored theme carry an engine version?** A theme's derived values are stored, not
re-derived (§2.3), and they are unversioned: the day a floor, a stop or an accent rule changes,
every stored theme silently keeps rendering by the old rules, and nothing notices. This is §6.10.
*Recommendation:* **add `theme_engine_version` to the `theme_tokens` payload when slice 3 lands**
— it needs no SQL migration (F9: `app_config` is `key`/`value`), and on a mismatch **re-derive if
the source is still readable, otherwise keep the stored values and flag the theme as derived by an
older engine in the picker row.** Re-deriving unconditionally is the tempting half-measure and it
fails for exactly the two providers that motivated storing values at all (an Obsidian theme whose
resolve needs a live window, an `.itermcolors` that lives in ProtonDrive).

**Q2 — Is an Obsidian theme stored as derived values only, or alongside a copy of its source
CSS?** §2.6 flags this for the owner. *Recommendation (unchanged from the first pass):*
**derived values only**, plus `sourcePath` for display. It is what slice 3's storage already
assumes; a copy in `userData` is the redistribution-shaped act that a theme the user already has
installed is not; and the copy buys nothing, because the derived values are what the app renders
and they survive the source moving.

**Q3 — Is there a seventh slice, and at which width?** §2.7 proposes three shapes: the widest
(slice 7 plus all 53 status sites, 15+ files), the bounded slice (10 files: the scrim and hairline
migrations plus the status *derivations*), and the cheapest (derivations inside the existing
slices, only-breaking sites migrated opportunistically, the rest as named debt). This is a scope
call, so it is the owner's. *Recommendation:* **the hybrid of the second and third** — derivations
and the seventeenth token inside slices 1–3 (zero extra files), the inversion migrations as slice 7
proper (ten files, `BookDetail.tsx` as the absorber), and the 53-site status sweep as named debt
with an owner, swept as those files are next opened. Rationale and reversal condition in §2.7a:
inversion is a correctness failure with no workaround; the sweep is mechanical with no design
content.

**Q4 — What happens to the four `gold-200` sites?** §1.3 C1/G1: they reference a step that does
not exist and therefore paint nothing — a live defect, independent of theming. The options are to
correct them to a defined step, or to re-express them as `on-accent`/accent tokens.
*Recommendation:* **correct the three text sites to `gold-300`** (the ramp's lightest step is the
one that stays legible on the `bg-gold-500/20`–`/30` tints those rows already use, and it is the
step the design reaches for elsewhere on dark surfaces), **and the mark at `ListView.tsx:211`
(`bg-gold-200`) to `bg-gold-400`**, matching the checkbox border in the same row so the tri-state
mark and the row's selection read as one colour. **Not `on-accent`**: that role is the foreground
*on a filled accent surface*, and every one of the four sites sits on a tint (`/20`–`/30`), not on
a fill — using it would put a near-canvas-coloured glyph on a tinted panel, which is a misreading
of the role, not a fix. **Not `gold-400` as text either**: the accent is the fill colour, and using
it as the foreground on its own tint collapses the pair's contrast. Reversal condition: if the
owner would rather the four sites stop existing, dropping the emphasis and letting the tint carry
the selected state is cheaper and defensible — it just costs the selected row its checkmark's
clarity. Either way this is a **two-file change with its own dispatch** (AC7.4), never a
slice-1 edit.

**Q5 — Does the derivation's new `scrim` rule belong in the prototype first?** The `scrim` rule
(§2.2) and the status family are this spec's own additions; the prototype has neither, and the
prototype's whole claim to trust is that its numbers were measured. *Recommendation:* **port them
into `theme-probe/derive.py` and re-run its seven-palette audit before slice 2's implementation
freezes** — cheap (two rules, no new fixtures) and it keeps the port's "reproduce the prototype
verbatim" property true rather than approximately true. If that is refused for time, the fallback
is that the two rules ship with their own tests and are labelled in `derive.ts` as post-prototype,
which is honest but leaves the prototype no longer the single source of derived behaviour.

---

## Orchestrator adjudication — decisions closed (2026-09-15)

Read this before §2.7, §2.7a or the open questions above: it **supersedes** them. The owner ruled on
all five questions and took the widest option §2.7a recommended against. Nothing here is open to
re-argument. Each ruling carries the alternative it beat and the condition that reverses it.

**J1 — Slice 7 is committed, at its widest: derive the status family *and* migrate all 53 sites.**
Owner's call, 2026-09-15. §2.7a's hybrid recommendation (inversions now, the status sweep as named
debt) is the **rejected alternative**, kept above with its rationale intact. Consequence: the honest
count is 15+ code files, **over the ~10-file bound** — so slice 7 is staged rather than shrunk (J2).
Reversal condition: if the sweep surfaces no light-theme legibility failure at any remaining status
site — every one holding ≥3:1 on a light surface — the un-swept remainder may be re-declared debt.

**J2 — Slice 7 ships in two stages; the file bound is per stage, not per slice.**

- **7a — derivations and inversions (10 code files + 1 test, at the bound).** **[A13 — the
  derivation half of this bullet already shipped with slice 2: `theme/derive.ts` and
  `src/types/theme.types.ts` carry `danger`/`ok`/`warn` with their `400`/`500`/`600` steps and their
  `on-*` foregrounds, floors enforced and corpus-tested. What 7a owes is the rest of the bullet.]**
  The `--scrim` and status variables in `src/index.css` and `tailwind.config.js`; the twelve veils and the
  two hairlines; and every status site **inside the ten files 7a already owns**. Absorber unchanged:
  `src/components/library/BookDetail.tsx`.
- **7b — the status sweep (the files 7a does not otherwise open).** Mechanical substitution only:
  §2.7 item 4's inventory applied to the remaining sites. No new token, no derivation change. Its own
  acceptance: a repo-wide grep for stock-palette colour utilities reaching **zero**, with the count
  recorded before and after.

This is the cut a re-cut into two plan items would use. 7a needs no new toolchain and no new
instrument, so it lands green under today's gate; 7b is grep-verifiable and independent of it.

**J3 — Q1 accepted: `theme_engine_version` joins the `theme_tokens` payload in slice 3.** On mismatch,
re-derive where the source is still readable; otherwise keep the stored values and flag the theme in
the picker row as derived by an older engine. No SQL migration — `app_config` is key/value (F9).

**J4 — Q2 accepted: a resolved Obsidian theme is stored as derived values plus `sourcePath`, never
alongside a copy of its source CSS.** The copy is the redistribution-shaped act; the derived values
are what renders, and they survive the source moving or being deleted.

**J5 — Q4 accepted: the four `gold-200` sites become `gold-300` (the three text sites) and
`bg-gold-400` (the mark at `ListView.tsx:211`), as their own two-file dispatch — never a slice-1
edit, whose pixel gate depends on those sites being unchanged (AC7.4).** Not `on-accent` (all four
sit on a tint, not a fill), and not `gold-400` as text (the accent is the fill colour).

**J6 — Q5 accepted: port the `scrim` rule and the status family into `theme-probe/derive.py` and
re-run its seven-palette audit before slice 2's implementation freezes.** This keeps the port's
"reproduce the prototype verbatim" property true rather than approximately true. Fallback if time
is refused: ship the two rules with their own tests and label them post-prototype in `derive.ts`.

**J7 — a correction to the orchestrator's own amendment dispatch, recorded so that nobody later
"fixes" the right numbers back into the wrong ones.** That dispatch listed per-class breakdowns of
the opacity-modified sites — seven `border-gold-500/60`, seven `bg-gold-500/30`, five
`border-gold-500/50`, five `ring-gold-400/70`, four `bg-gold-500/40`. Those were per-**suffix** totals
mislabelled as per-**class** counts. The per-class breakdown recorded in §1.4 is correct and must not
be changed; the suffix totals decompose as: `gold-500/60` = 6 `border-` + 1 `text-`; `gold-500/30` =
3 `ring-` + 3 `bg-` + 1 `border-`; `gold-500/50` = 3 `border-` + 2 `bg-`; `gold-400/70` = 2 `ring-` +
2 `text-` + 1 `border-`; `gold-500/40` = 3 `border-` + 1 `ring-` + 1 `bg-`. Both methods agree on the
headline: **63 sites across 20 files.**

**J8 — the scrim role is darkening in *both* variants, and the cover-art badges are the reason.**
Four of the twelve veil sites are `BookCard.tsx:98, 114, 128, 167` — chips laid over arbitrary cover
art, not modal backdrops. A light theme must not turn those into light washes any more than it may
wash out a dialog. So "scrim" means *darkens what it covers*, whichever variant it is derived under;
this is a constraint on the derivation (§2.2), not an observation about today's values.

---

## Slice 1 adjudication — landed and verified (2026-09-15)

**Measured by the orchestrator on the returned tree, not self-reported by the implementer.**

| Check | Result |
|---|---|
| Scope | exactly `tailwind.config.js` + `src/index.css` modified; the only untracked path is this spec. No out-of-scope edits. |
| Gate | `typecheck` 0, `lint` 0, `npm test` 270 passed / 17 files — identical to the bdc54ec baseline. `npm run build` 0. |
| Token conversion | all 14 palette hex literals in `git show HEAD:tailwind.config.js` convert byte-for-byte to the emitted channels; `--scrim == --ink-950` (`13 11 9`), shadow alphas `0.5 / 0.35 / 0.6`. |
| **AC1.1 pixel identity** | **grid frame: 0 differing pixels of 1,296,000.** |
| AC1.1 residual | settings-scrim frame: 146 pixels differ (0.011%), **maximum channel delta 1**, in a 77×36 box at (1346,10). 31 distinct before→after pairs, every one a single-channel ±1 in mixed directions. |
| AC1.7 | `color-scheme: dark` present on `:root`; the host OS is in Dark appearance, so it is a no-op for the capture, as §2.1's caveat anticipated. |

**The AC1.1 residual, characterized rather than waved through.** The scrim's colour moved from a
literal `rgba(13,11,9,0.8)` to the required `rgb(13 11 9 / 0.8)` variable form. Chromium's
alpha-composite rounding differs between those two spellings, so only the pixels whose blend result
lands exactly on an 8-bit boundary flip — hence 146 of roughly a million, at delta ≤1, in mixed
directions. It is sub-perceptual, its cause is inherent to the `<alpha-value>` form that §1.2's 63
opacity sites require, and it is recorded here so no later reader chases it as a regression.
Reversal condition: if a future slice ever needs the scrim's alpha to be bit-exact, the fix is to
carry the scrim as a pre-multiplied opaque colour at its authored alphas, not to abandon the
variable form.

**J9 — AC1.4 moves to slice 2.** AC1.4 required a unit test asserting the `:root` defaults against
`git show HEAD:tailwind.config.js`, while AC1.2 fixes slice 1's touched set at exactly two files — a
test file is a third, so the two criteria could not both hold. The implementer correctly wrote no
third file and ran the assertion as a throwaway script (all 14 literals verified). Resolution: slice
2 owns that assertion, in the test file it already budgets, where it doubles as the pin that the
derivation reproduces today's palette as its default. This is the "add the walk" arm of the rule —
the criterion is kept, not retired, and it no longer contradicts AC1.2.

**J10 — two dispatch facts of the orchestrator's were wrong; the corrections are authoritative.**
(a) Tailwind's installed version is **3.4.19**; `package.json`'s `^3.4.17` is a caret range, not the
resolved compiler. (b) The class named in the dispatch as `text-parchment-faint/50` ships as
**`placeholder:text-parchment-faint/50`** at all three of its sites — the count of 3 was right, the
class string was not. The headline (63 sites / 20 files / 30 distinct class strings) reproduces
exactly, and J7's suffix decomposition reproduces site-for-site under the implementer's independent
measurement, which is the corroboration that matters.

**J11 — one dispatch acceptance bullet was unsatisfiable by construction.** It asked for the
generated rule for `bg-gold-500/40`. No such class rule is emitted, before or after this change:
that class's only site is an `@apply` in `src/index.css`, which Tailwind inlines into the
`::selection` rule, and class rules are emitted only for names found in `content` — which is
`index.html` and `src/**/*.{ts,tsx}`, not `.css`. The implementer proved the alpha survives
(`background-color: rgb(var(--gold-500) / 0.4)` on `::selection`, plus a separate probe build with
the class name in `content` that did emit the rule) and refused to report the absence as the slice's
failure. That was the right call: the bullet was a defect in the dispatch, not in the work.
