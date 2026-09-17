# Plan: Theming slice 4 — import and picker

**Date:** 2026-09-16
**Slice:** §2.4 of `docs/superpowers/specs/theming.md`, acceptance criteria AC4.1–AC4.5
**Annex to:** `docs/superpowers/specs/theming.md` (this file settles what §2.4 leaves open;
the spec's amendment trail gains the round-4 entry when the slice lands)
**Read first:** `docs/invariants/settings-and-editing.md` (`app_config`, the one-transaction
rule, the read-validation rule), `docs/invariants/menu-and-branding.md` (no theme item in the
native menu), `docs/invariants/reader.md` (invariant #9 — the renderer never gets `file://`),
`docs/invariants/library-views.md` (computed row geometry), `CLAUDE.md` #8/#12.

---

## 1. What this slice is

Two ways in for a provider file, one list to pick from, and applying on click:

1. **File picker** — `theme.importFromDialog()`, native, multi-select.
2. **Drop-box directory** — `userData/themes`, scanned on demand by `theme.scanFolder()`,
   shown in the section with a *Reveal in Finder* control. No watcher.
3. **Drop onto the section** — the section owns its own `onDrop`; paths resolve through the
   existing preload `files.getPathForFile`. `src/hooks/useDragDrop.ts` is **not** touched
   (AC4.4).
4. **The Appearance section** in `SettingsModal.tsx` — swatch strip, name, provider label,
   variant badge, the row's lossy notes, and the active/default marks.
5. **Clicking a row applies immediately** — no Save button, no ⌘↵ (AC4.5).

Slice 3's shape is what this builds on: the engine derives, `store.ts` owns the storage, and
`theme_library` already exists and is preserved byte-identically — **this slice is its only
writer and its first reader** (A21).

## 2. The frozen contract (already written — do not edit these three files)

Written by the orchestrator so both workstreams compile against one seam:

| File | What changed |
|---|---|
| `src/types/theme.types.ts` | new `ThemeSwatches`, `ThemeOption`, `ImportedTheme`, `RejectedTheme`, `ThemeImportResult`; `ThemeView` gains `options` and `folder` |
| `src/types/api.types.ts` | `theme` gains `importPaths`, `importFromDialog`, `scanFolder`, `openFolder` |
| `electron/preload/index.ts` | the four `invoke(...)` one-liners, channels `theme:importPaths`, `theme:importFromDialog`, `theme:scanFolder`, `theme:openFolder` |

No new `EVENT_CHANNELS` entry: an import answers on its own call, and the view it returns is the
same view `theme:get` would give. One window, one renderer.

## 3. Decisions this annex settles (D-series)

**D1 — Imported ids are stem-derived, uniform with the built-ins.** `base16:<stem>` and
`iterm:<stem>`, where `stem` is the file name without its extension, directories stripped.
*Deviation from §2.3's `base16:<slug>`*: the vendored corpus carries a `slug:` key in **1 of 13**
files (measured — `grep -l '^slug:' builtin/*.yaml`), so a slug-keyed id would be a branch that
is dead for essentially every file the owner has, would need a new meta key in slice 2's parser
(one more file in this slice's budget), and would split one scheme into two ids when someone
imports both a slugged and an unslugged copy. Stem-keyed ids are also exactly how
`BUILTIN_THEME_SOURCES` is keyed, so "an id names a file" stays one rule.
*Reversal:* if renaming files in place turns out to be common, adopt slug-when-present.

**D2 — Imported ids cannot collide with built-ins.** Every imported id starts `base16:` or
`iterm:`; every built-in starts `builtin:`. So the registry is never shadowed, and a file named
`musaeum.yaml` cannot replace the default. This is why the id scheme is safe as a *lookup key*
and not merely a label.

**D3 — `theme_library` is an array of `StoredTheme`, validated on every read, written by one
path.** Read: not an array → treated as empty with a warning; each entry re-validated by
`recordProblem` (id against itself); an invalid entry is **dropped with a warning**, because
storage is not trusted (`settings-and-editing.md`) and a row the reader would reject can never be
applied. Write: read-modify-write **inside one transaction**, upsert by id (replace in place,
append when new). A write failure throws out of the transaction and leaves the library as it was.

**D4 — `resolveId` gains a library arm, and it is the only way an imported theme becomes
active.** Ladder: default → `builtin:` → library. On a library hit the entry is re-validated,
then:
- `engineVersion === THEME_ENGINE_VERSION` → use the stored values.
- mismatch → the source file is re-read and re-derived **only if `sourcePath` is still
  readable**; the rewrite goes through the same one-transaction write path. Otherwise the stored
  values are kept and the result is flagged `stale` (J3).

Rationale: `theme.set` must not depend on a file that may have moved (J4), and applying is on the
interaction's critical path (AC4.5) — an imported theme can be applied with the file gone.

**D5 — Import never activates.** `importPaths` / `importFromDialog` / `scanFolder` add and update
rows; the active theme changes only when the user clicks a row. Importing three themes leaves the
app on the theme it was on.

**D6 — A batch never aborts on a member.** Each file is independent: read → parse → derive →
validate → upsert. Failures become `{ path, reason }` rows carrying the engine's own reason
string verbatim (AC4.2). Nothing is partially written for a failed member.

**D7 — The folder scan is read-only and extension-scoped.** `readdirSync` (non-recursive), take
entries that are files whose extension is `.yaml`, `.yml` or `.itermcolors`; anything else — a
directory, `.DS_Store`, `README.md` — is ignored silently. The app never creates, renames, copies
or normalizes a file in the folder; the only thing it may do *to* it is create the directory
itself when absent, so *Reveal in Finder* works before first use (D8). A supported-extension file
that fails to parse **is** reported (D6) — the scan's rejections surface in the section.
*Recorded interpretation* of §2.4's "the app never writes into this folder": it never writes a
file into it. *Reversal:* if the owner would rather the app not create it, the control becomes
disabled until the folder exists. `.css` is ignored in this slice: Obsidian is slice 6, and a
folder listing must not fill with reasons about files the app cannot read yet.

**D8 — `openFolder()` creates the directory when absent, then `shell.openPath`.**
`mkdirSync(recursive: true)` first; a `shell.openPath` that returns an error string throws, which
`handle()` reports as an IPC failure (the one place a shell error is worth surfacing — the user
pressed a button).

**D9 — Per-row staleness is `ThemeOption.stale`; `ThemeView.stale` stays the active theme's.**
A non-active library row derived by an older engine whose source is gone is still perfectly
usable; the picker flags it rather than hiding it (J3).

**D10 — `ThemeImportResult.view` is the whole view, always.** So the list cannot disagree with
what was just imported, and the renderer needs one round trip, not two. *Deviation from §2.3's
`importPaths → ImportResult` and `scanFolder → ThemeView`*, recorded because it changes the IPC
surface: the picker's post-import state is the same `ThemeView` the boot path applies, and a
scan's rejects have somewhere to be displayed.

**D11 — Built-in option rows are derived once per process and memoized.** `theme:get` is awaited
on the boot path before first paint (`src/main.tsx`, AC3.5 measured 19.6 ms for that call), and
building 14 rows means 14 derivations. The memo key is the stem; nothing in this slice can
invalidate it (the corpus is inlined and immutable). The default's row is the authored constant.

**D12 — The picker is not in the native menu and nothing here rebuilds it.**
`invariants/menu-and-branding.md` — no theme item, no checkmark; the menu stays built once
(§2.3's invariant, restated because this is the slice that adds the visible picker).

**D13 — `useDragDrop.ts` is untouched** (AC4.4). Its `BOOK_EXTENSIONS` filter already ignores
`.yaml`/`.yml`/`.itermcolors`, so a theme dropped on the library grid is a no-op today and stays
one. The section's own drop handler is what receives a theme drop.

## 4. Files

| # | File | Owner | What |
|---|---|---|---|
| 1 | `src/types/theme.types.ts` | **orchestrator (done)** | the contract above |
| 2 | `src/types/api.types.ts` | **orchestrator (done)** | the four IPC members |
| 3 | `electron/preload/index.ts` | **orchestrator (done)** | the four channels |
| 4 | `electron/main/services/theme/importer.ts` | main-engineer | new: read → parse → derive → validate → upsert, the folder scan, the option-row builders |
| 5 | `electron/main/services/theme/store.ts` | main-engineer | library read/write, the `resolveId` library arm, `options`/`folder` in the view |
| 6 | `electron/main/ipc/theme.ts` | main-engineer | four thin handlers (the dialog, `shell`, `mkdir`) |
| 7 | `electron/main/services/theme/importer.test.ts` | test-author | new |
| 8 | `electron/main/services/theme/store.test.ts` | test-author | extended: the library arm, the options, the folder |
| 9 | `src/components/settings/AppearanceSection.tsx` | renderer-engineer | new: rows, drop zone, folder line, per-row reasons |
| 10 | `src/components/settings/SettingsModal.tsx` | renderer-engineer | mount the section above the existing fields |
| 11 | `src/stores/theme.store.ts` | renderer-engineer | the import actions and the row-reason state |
| 12 | `src/stores/theme.store.test.ts` | renderer-engineer | extended for the new actions |

**11 code files + 2 test files, 1 over `CLAUDE.md`'s ~10-file bound.** The named absorber
(`AppearanceSection`'s row rendering folds into `SettingsModal.tsx`) is **not** taken: the section
owns a drop zone, a folder control, 14+ rows and a disclosure, and folding it into an already
404-line modal would put 550 lines of two concerns in one file. Recorded rather than absorbed
silently — same handling as A30. **Slice 5's row is unaffected.**

## 5. Acceptance criteria, and what decides each

| AC | Decider in this slice |
|---|---|
| AC4.1 — three provider types import, each with name / provider / variant / five swatches | base16 + iTerm2 by test through the real importer, on real fixture files (`test/fixtures/theme/*.itermcolors`, `builtin/*.yaml`); the *rows* by asserting `getThemeView().options` carries five `#rrggbb` swatches, a provider label and a variant per imported id. Obsidian is slice 6 — its row shape is proven by the same builder, so this slice's obligation is that the shape exists and is filled from a `StoredTheme`. |
| AC4.2 — validated before stored; five files, one malformed → 4 imported, 1 rejected, four usable | a test that imports five real files with one malformed member and asserts `{ imported.length: 4, rejected.length: 1 }`, a per-path reason, and that the four are then resolvable by `setTheme` |
| AC4.3 — the drop-box works and is never written to | a test that writes three `.itermcolors` into a temp folder, hashes the directory (names + sizes + mtimes), calls `scanFolder`, asserts three new rows and an identical hash. Live check in the running app too (the folder is `userData/themes`). |
| AC4.4 — a theme drop does not become a book import | a source-walk assertion that `useDragDrop.ts`'s `BOOK_EXTENSIONS` is unchanged and still excludes themes, **plus** the live no-op check (drop a `.yaml`, assert no `importProgress`, no job row) |
| AC4.5 — applying is immediate | live CDP: `window.Musaeum.theme.set(id)` (and the row click) changes `documentElement`'s `--ink-950` and the window background with no second interaction; the renderer half is a source-walk assertion that the row's click path does not route through `settings.save` |

## 6. What must not move

- `useDragDrop.ts` (AC4.4), `src/main.tsx` and `src/hooks/useTheme.ts` (slice 3's boot contract).
- Row geometry: `ROW_HEIGHT` / `CARD_META_HEIGHT` / `CARD_META_MARGIN` and `BookCard`'s DOM
  (`invariants/library-views.md`) — this slice's UI lives inside the settings modal.
- The native menu (`invariants/menu-and-branding.md`).
- The renderer's file access: paths cross the boundary, bytes never do; `musaeum://` gains no
  host for themes (`CLAUDE.md` #9).
- Business logic in `electron/main/services/`; IPC handlers stay thin (`CLAUDE.md` #8).
- Non-fatal degradation: an unreadable theme is a value with a reason, never a throw
  (`CLAUDE.md` #12).
- No new dependency (`package.json`), no migration (`MIGRATIONS` stays at three).
- Colours in the new UI come from existing token utilities only (`ink`/`parchment`/`gold`).
  A stock Tailwind hue here would be slice 7b's sweep arriving early, in new code.

## 7. Verification plan (orchestrator, independent of the implementers' reports)

1. `npm run typecheck && npm run lint && npm test && npm run build`.
2. A temporary vitest file (added, run, deleted) that reproduces AC4.2 and AC4.3 through the real
   service on real files — an end-to-end walk, not a re-run of the slice's own tests.
3. Mutation checks, one per criterion whose decider is a test: e.g. make the batch abort on the
   first failure (AC4.2 must redden); copy the source file into the folder (AC4.3 must redden).
4. Live app, isolated profile (`MUSAEUM_USER_DATA`) per `.claude/skills/verify/SKILL.md`, driven
   over CDP: the section renders rows with swatches, a row click repaints `--ink-950` with no
   second interaction, `scanFolder` after dropping files into the scratch `themes/` dir produces
   rows, `importPaths` with a bad file reports and imports nothing, and the folder hash is
   unchanged. Screenshots as evidence.
5. Pre-merge review against the invariants list (read-only).
6. Docs: `CHANGELOG.md` (slice 4 is user-visible — §4 records it as owed from slice 4),
   `tasks.md`, `docs/invariants/settings-and-editing.md` (the library's read/write rules),
   `docs/architecture.md` (the new files), and the spec's amendment round 4 in place.
