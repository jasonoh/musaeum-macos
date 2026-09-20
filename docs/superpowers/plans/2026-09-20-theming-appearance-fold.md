# Slice 8 (follow-up) — the Appearance section folds

| | |
|---|---|
| Date | 2026-09-20 |
| Slice | 8 (the follow-up `tasks.md:166` records; named for the section it fills in, not for a new feature) |
| Annex to | `docs/superpowers/specs/theming.md` — §2.4 (the picker). This annex settles **readings and wiring**; it re-opens no product decision (J1–J11, A28, AC4.5 and A45 all stand) |
| Read first | `docs/invariants/settings-and-editing.md` (the theme `app_config` keys), `CLAUDE.md` #9 / `docs/invariants/reader.md` (the renderer never gets `file://`), `docs/superpowers/plans/2026-09-19-theming-slice4.md` (the picker this compresses) |
| Asked for by the owner | 2026-09-17 (`tasks.md:166`, "compartmentalize the Appearance section"), answered 2026-09-20: *"the actual list of themes should be hidden behind 'select theme' which would then expand the theme section"* — i.e. the candidate that entry lists first, with the control named rather than a bare chevron |

## 1. What this slice is

1. The theme **list** moves behind a disclosure row whose control reads **Select theme**. The disclosure row carries the active theme (its own swatch strip, name, variant, provider), because the collapsed section must still say what the app looks like right now.
2. A picker **row** becomes one line instead of two. The provider label — not the name, not the variant, not `stale`, not the notes — is what moves off its own line and onto the name line.
3. A **filter box** appears inside the opened list once there are more than 8 rows, because the fold fixes the *rest* height and does nothing about a hundred imports in the *open* state.
4. The drop hint at the top loses its redundant tail ("…or put files in the folder below"): the drop-box row is directly under it and already says *Files put here by hand appear after a refresh*.

Nothing else in the section changes. No main-process code, no store, no contract type, no migration, no new IPC, no persisted state.

### 1.1 Measured before (isolated profile, `npx electron .` at `949c506`, port 9222)

The numbers this slice is accepted against. Instrument: `scripts/cdp.mjs` from `musaeum-app-verification`, one `eval` over the dialog's DOM.

| Measure | Before |
|---|---|
| Appearance section height | **949.9 px** |
| Theme rows | **14** |
| Row pitch | **55 px** (two lines: name+badge, then the provider) |
| Section's own chrome (heading + import row + folder row) | 108 px + 3 × 12 px gaps |
| Modal body | 698 px visible / **2300 px** scrolled |
| `Library` heading | y = **1100.6** — **292 px below** the body's visible bottom |

The owner's own screenshot is the human-readable half of this column; the section is the whole first screenful and Library / Maintenance / Metadata are all below the fold.

## 2. Readings this slice settles (the approved spec left them open)

### D1 — the fold's state is local and starts closed

`useState(false)` in `AppearanceSection`, no persistence, no store. **Alternative:** persist the open/closed state next to the view mode and sort. **Why not:** `settings-and-editing.md`'s rule for persisted UI state is that it must not be *"state whose cause the user can't see"* — a list the user finds already open (or already closed) with no explanation is exactly that, and the settings dialog is opened fresh each time. **Reversal condition:** a request to keep the list open across visits; the instrument is AC8.10 (no storage write).

### D2 — the disclosure row carries the active theme, and it reads it from `view.active`, not from the list

The swatch strip on the disclosure row is built from `view.active.tokens` (`ink.950`, `ink.800`, `parchment.parchment`, `gold.400`, `gold.500` — the same five values, in the same order, that `ThemeOption.swatches` carries by contract, `theme.types.ts:152-161`). **Alternative:** `view.options.find(o => o.active)?.swatches`. **Why not:** the stored tokens are what is *applied to the app*; the row's tuple is the picker's display copy. Reading the applied values means the collapsed section cannot disagree with the screen, and it cannot render empty when the active theme is not an option row (the `defaultId` case, or a library row a future filter hides). **Reversal condition:** the token set gaining a role the swatch strip should show instead; the strip's five are fixed by the type, so that is a `ThemeSwatches` change, not this one.

It also carries the row count as a muted label, so "did my import land?" is answerable without opening the list.

### D3 — the provider label moves onto the name line; nothing is dropped

`PROVIDER_LABEL[option.provider]` renders after the variant badge on the same line, at `text-[11px] text-parchment-faint`, and the name keeps `flex-1 min-w-0 truncate` so a long name truncates *before* the provider does. **Alternative:** drop the provider for built-ins (they are all `base16`/`Built-in`) and show it only for imports. **Why not:** §2.4 added the label to explain a real property of the corpora — the same scheme from two providers is two different palettes (gruvbox's base16 `base05` `#d5c4a1` against its iTerm `Foreground Color` `#ebdbb2`) — and that explanation is worth least where the user is most likely to be confused between two rows of the same name, which is *both* halves of the list. The saving this slice is after is the *line break*, not the string. **Reversal condition:** a row set large enough that the provider label costs a column the name needs.

### D4 — the filter appears above 8 rows, and carries no key handling

Threshold 8, counted on `view.options.length` before filtering. **Alternative:** always render it; or never (the fold is the compression). **Why not always:** below ~8 rows it is a row of chrome that cannot pay for itself on a corpus the user can see whole — today's 14 rows is the first case where it earns its 30 px. **Why not never:** the fold caps the section at rest and does nothing for the opened state, and the user's own folder can hold hundreds (§2.4's premise).

The input deliberately carries **no `onKeyDown`** — no Escape-to-clear, no ⌘F focus, nothing. AC4.5's source walk (`src/stores/theme.store.test.ts`, "needs no second interaction") asserts this file contains no key machinery at all, and that walk is right for the wrong reason: what it protects is that the picker grows no second interaction path, and a key handler is the same class of thing whether or not it saves. **Alternative:** Escape clears the query. **Why not:** it reddens a criterion whose *spirit* it would also violate; a keyboard affordance in this file is a decision, and this slice is not the one to make it. **Reversal condition:** the picker gaining real keyboard navigation (arrow keys over rows), which is its own slice with its own criteria.

### D5 — the drop hint is shortened, and the four extensions stay named

`DROP_HINT` becomes *"Drop a .yaml, .yml, .itermcolors or an Obsidian theme.css anywhere on this section"* — one line at this width instead of two. **Alternative:** keep the sentence and accept 16 px. **Why not:** its tail ("or put files in the folder below") is already stated by the row directly beneath it (*Files put here by hand appear after a refresh*), which is also the row that carries the folder's path — the sentence was duplicating the control under it.

A45's rule is that the four extension sites must agree; the hint is the site that *tells the user* what the filter accepts, so this slice makes the agreement mechanical instead of reader-visible: every member of `THEME_EXTENSIONS` must appear in `DROP_HINT` (AC8.7). `.css` matches inside `theme.css`, which is the exact file name an Obsidian theme uses. **Reversal condition:** none foreseen — the assertion is the point.

### D6 — the opened list is not capped and does not scroll inside itself

**Alternative (offered to the owner as its own option):** cap the opened list at ~6 rows with its own scroller, so even a hundred imports cannot grow the section past ~380 px. **Why not:** the modal body already scrolls, and a scroll region nested inside it means the wheel behaves differently depending on which pixel the pointer is over. The owner chose the fold, not the cap. **Reversal condition:** a corpus large enough that scrolling the dialog to reach Library becomes the complaint, or the filter proving insufficient — the cap is then one `max-h` and one `overflow-y-auto` on the opened list.

### D7 — "the import control stays visible" becomes a positional assertion

`tasks.md:166`'s constraint (a) is that the way in must not fold. As a criterion it is `indexOf('<ImportControl') < indexOf('listOpen &&')` over the component's own source — plus the same for the folder row and the drop sentence. **Alternative:** assert only that the elements exist. **Why not:** existence is satisfied by the exact mutation the constraint forbids (move them inside the fold and they still exist). The positional form fails when they move under the disclosure, which is what the constraint is about. **Reversal condition:** the file being split so that the fold is no longer a `&&` in it — then the criterion moves to the file that owns the fold, and the assertion stays positional.

## 3. The file table

| # | File | Who | What |
|---|---|---|---|
| 1 | `src/components/settings/AppearanceSection.tsx` | renderer | the disclosure state + row, one-line rows, the filter, `DROP_HINT`/`THEME_EXTENSIONS` hoisted as values |
| 2 | `src/stores/theme.store.test.ts` | test | the fold's five source walks (D7, D1, D4, D5) added to the existing picker describes |
| 3 | `docs/superpowers/plans/2026-09-20-theming-appearance-fold.md` | — | this annex |
| 4 | `docs/superpowers/specs/theming.md` | — | the amendment-trail entry, **when the slice lands** |
| 5 | `tasks.md` | — | the follow-up entry's outcome, additively (its argument stays) |
| 6 | `CHANGELOG.md` | — | the user-visible line |

**6 files, inside `CLAUDE.md`'s ~10-file bound.** No absorber needed, and none named: the section stays its own file (slice 4's A36 decided that, and this slice makes the file smaller in what it renders, not in how many concerns it holds).

## 4. Acceptance criteria, each with its decider

| AC | Criterion | Decider |
|---|---|---|
| AC8.1 | The section is **≤ 250 px** at rest with the list closed (before: 949.9), and `Library` is inside the first screenful of the modal body (before: 292 px below it) | live CDP measure of the dialog's DOM, before/after on one isolated profile |
| AC8.2 | A row click still applies with no ⌘↵: `--ink-950` on `documentElement` changes after one click in the opened list | live CDP (slice 4's instrument, re-run) |
| AC8.3 | Constraint (a): the import control, the folder row and the drop sentence are rendered **outside** the fold | source walk, positional (D7) + live rects all inside the body viewport while collapsed |
| AC8.4 | Constraint (b): the drop sentence is the first line of the section and stays visible while collapsed; the drag state still swaps it for *Release to import* | source walk (paragraph below) + live DOM text |
| AC8.5 | A theme dropped anywhere on the section is still the theme importer's, never a book import | existing AC4.4 walk (`theme.store.test.ts`), unchanged and green |
| AC8.6 | Row pitch in the opened list is **≤ 38 px** (before: 55) | live CDP row rects |
| AC8.7 | Every extension in `THEME_EXTENSIONS` is named in `DROP_HINT`, and there are four of them | source walk (D5) |
| AC8.8 | The opened list's filter narrows the rows by name, and a query matching nothing says so instead of rendering an empty panel | live CDP (type into the input, count `li`s; then a no-match query) |
| AC8.9 | The fold's default is **closed on every open**, and nothing about it is persisted | source walk (`useState(false)`, no `localStorage`) + live CDP: close and reopen the dialog, the list is closed and `localStorage` is byte-identical |
| AC8.10 | The renderer still reads no file: `AppearanceSection` names `files.getPathForFile` and nothing else on `window.Musaeum` | source walk (existing) |
| AC8.11 | The active theme's summary row exists while collapsed and shows that theme's own swatches | live CDP: the five swatch colours equal `--ink-950`/`--ink-800`/`--parchment`/`--gold-400`/`--gold-500` as resolved on `:root` |

## 5. What must not move

- **The four extension sites** (A45): `THEME_EXTENSIONS` keeps its four members; the hint names them.
- **The drop handler stays the section's**, and its filter stays the extension filter (AC4.4's two halves).
- **No key handling in this file** (AC4.5's walk).
- **The theme request path** — `setTheme` on click, never `settings.save`.
- **Everything the row already carries**: the notes disclosure, the per-row failure reason, `stale`, the active tick, the import report lines, the itemized rejections.
- **Colour**: every value stays on a token. The one literal is the swatch strip's `backgroundColor` (the swatch *is* the data — slice 4's own note).
- **`docs/invariants/library-views.md`'s geometry** (`ROW_HEIGHT`, `CARD_META_HEIGHT`, `CARD_META_MARGIN`): a different subsystem, untouched. Nothing here is virtualized.

## 6. Verification plan

1. `npm run typecheck && npm run lint && npx prettier --check <the files touched>`; then `npm test`.
2. A mutation campaign (`musaeum-slice-workflow` → `scripts/mutation-campaign.py`), one mutation per new decider: the import control moved inside the fold (AC8.3), `useState(false)` → `useState(true)` (AC8.9), `aria-expanded` dropped, an `onKeyDown` added to the filter (AC4.5), `.css` deleted from `THEME_EXTENSIONS` (AC8.7), a `localStorage` write added (AC8.9).
3. The app pass on an isolated profile, **before and after on the same instrument**: the before column is §1.1's table, taken at `949c506`; the after column re-runs the same `eval` and the same crop geometry, plus a frame of the collapsed section and one of the opened list, and the AC8.8 filter cases.
4. The search is for a **pixel** claim here, so the frames are cropped to the modal and read with Pillow (`~/.hermes/hermes-agent/venv/bin/python`), never judged from the DOM.

## 7. Returned — 2026-09-20

All eleven criteria are decided; the numbers are the spec's round-9 trail (A82–A90) and are not restated here. Three things this plan did **not** anticipate, each now recorded where a later session will meet it:

- **Constraint (a)'s assertion had to count every call site, not find the first one.** The section renders `<ImportControl>` from two branches, so `indexOf` finds the `!view` branch's render however the view branch is arranged — and the mutation the constraint exists to forbid survived the first campaign because of it (A88).
- **Constraint (b)'s first assertion compared two indexes that live in different scopes** and was therefore false on a correct file; the criterion's own full-suite run caught it, not the focused one (A90).
- **One always-red assertion makes a campaign report deciders it does not have.** The campaign's first round said 8/8 killed; the honest second round said 7/8 (A88). A campaign is only worth its wall clock if every row's failure is attributable.
