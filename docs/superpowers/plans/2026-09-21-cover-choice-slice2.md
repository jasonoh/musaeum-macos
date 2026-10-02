# Cover choice, slice 2 — the picker

**Date:** 2026-09-21
**Slice:** 2 of three (1a, 1b, 2) — **the last one, and not built**. **8 files against the row's 6** (see *Files*: the editor the row missed, and one pure rule that has nowhere else to be decided). If that crosses the bound, the split is named there too.
**Annex to:** `docs/superpowers/specs/2026-09-21-cover-choice-design.md` (the spec; D1–D7 and the acceptance criteria live there)
**Read first:** the spec's D1, D3, D4 and D6, its *Store and component shape*, its *Slice 2* criteria (AC12–AC17) — and **Built — slice 1b**, because the payload the picker reads and the write it calls already exist with their deciders. Read **Built — D7's mechanism** once: the repaint is shipped, so this slice starts with the component and not with a probe.

---

## What this slice is, in four lines

1. **One modal, two entry points.** The detail panel's cover block (`BookDetail.tsx:83-85`) and the context menu (`BookContextMenu.tsx:173-177`, the item beside *Edit metadata…*) open the same `CoverPicker`, keyed on the book id and mounted in `App.tsx` exactly as `BookEditor` is (`App.tsx:67`).
2. **It reads one payload and calls three existing methods.** `metadata.coverCandidates(bookId)` for the candidates 1b gathers — each with its `thumb`, `score`, `winner`, `applied`; `metadata.setCover(bookId, {source, url?})` to write a choice; `library.releaseFieldOverride(bookId, 'cover')` to hand the cover back to the fetcher. No new method, no new channel, no new type.
3. **Nothing below the renderer changes.** No Python, no IPC handler, no preload binding, no contract file, no CSP. This is the slice the 1b cut was made for: the payload and the write are already decidable in pytest and vitest, so everything here that *has* a unit decider is the derivation and the store — and the rest is the running-app probe.
4. **D4's lock is created here and released here.** A pick locks `cover` (1b does that, with `before = null`); the picker is where it is shown as held and where it is released. AC17 is the invariant doc learning that sentence.

## Readings this session settled — they are not open questions any more

**Inherited from 1b and D7 (do not re-derive, do not re-test):**

- **D7 is answered and shipped.** A same-URL cover replacement did **not** repaint; `src/lib/cover-url.ts` now carries the row's clock (`?v=lastModified`) and every path that rewrites the cover moves that clock, so a pick repaints by construction. The picker adds no cache-busting of its own, and the spec's *Not verified* item 1 is discharged.
- **The candidates' images arrive with them — do not call `cover_previews`, and do not write a second thumbnail rule.** `cover_candidates` returns each candidate's `thumb` as a `data:` URL (≤240 px JPEG q80, made by `preview_data_url` — the *same* helper the conflict queue's previews use). `cover_previews` (`ConflictResolver.tsx:104-133`) exists for a conflict's **stored URLs**, whose payload carries no thumbs; the picker has no URL of its own to fetch, so that whole effect — the URL-keyed map, the stale-key dance — has no counterpart here. `index.html:8`'s CSP stays as it is: `img-src 'self' musaeum: data: blob:`.
- **`applied` is byte identity, and it can be true for *none* of the candidates.** Measured on a real book, not constructed: for *Star Maker* the stored 134,855 B `cover_full.jpg` matched neither the file's own jacket (389×616) nor OpenLibrary's (307×475), so every candidate read `applied: false`. The picker therefore needs a stated "none of these is what your book has now" state — the alternative (marking nothing and letting the grid look broken) is the defect this slice exists to avoid. And phrase it as *what is on disk*, never as "the one you chose" (spec risk 4).
- **A refusal arrives as the service's own sentence.** `cover-choice.ts` decides all three refusals before anything starts, and AC16 is that message. The picker renders `err.message` in its own error slot; it must not build a second vocabulary for the same three cases.
- **Releasing the lock already exists.** `library:releaseFieldOverride` (`electron/main/ipc/library.ts:31`, preload `:25`) → `fieldOverrides.release(bookId, 'cover')` (`electron/main/services/field-overrides.ts:127`). The editor's padlock is its existing caller. The picker is the *second* caller of one channel — not a second path.
- **A locked book still gathers.** 1b deliberately left `cover_candidates` out of the lock's reach, so the picker opens normally on a held cover, shows it as held, and can change it. Do not filter the payload by the lock.

**Settled by this session, and they are the row's two shortfalls:**

7. **The editor is a 7th file, and the row never mentions it.** `HYDRATED_KEY_FIELD` maps `coverFullPath`/`coverThumbPath` → `'cover'` (`src/types/metadata.types.ts:120-121`), and `BookEditor.tsx:252-264` prints *every* overridden field by label: *"You set these, so a metadata fetch will not change them: **Cover**. The padlock beside a field hands it back to Musaeum — its value stays."* But the padlock is rendered per *editable* field (`overriddenFor(key)`, `:185-189`) and the editor has no cover input — so the moment the picker locks `cover`, the editor instructs a person to click a padlock that does not exist for Cover. **Settled: the summary paragraph gains one clause saying where a cover is released (the picker).** It is the same paragraph, so the rest of the sentence must survive the edit. Alternative: leave it and accept a sentence that is untrue for exactly one field — rejected, because AC17's whole point is that the release's home is legible, and the editor is where a person looks for it. Reversal: a cover field in the editor, which D4 refuses.
8. **The tile's state is a pure rule, and it belongs in `src/lib/`.** AC12 wants the applied one marked and the winner marked when it differs; with the held state and the all-false state, that is a derivation over the payload — and the renderer has no DOM harness, so decided inline it would have a probe and nothing else. The repo's own precedent is the same shape (`cover-url.ts`'s comment: a pure rule about URLs is only decidable in `src/lib/`). **Settled: `src/lib/cover-candidate-state.ts` (+ its test), with the component importing it.** Alternative: inline, probe-only. Reversal: a DOM harness for the renderer.
9. **The review band is not this slice's to change.** *Star Maker*'s 0.3 % margin queued no conflict because the band's guard counts URL-bearing candidates only, so a book's own jacket never counts (spec, *Built — slice 1b*, the finding). That is `select_cover`/`hydration.py` behaviour and a Python change; **the picker must not paper over it** by marking something the fetcher would not have queued. Recommendation: leave it, and let the picker's own "the best one is not the one you have" marking be the visible half. Widening the band to count the embedded jacket is its own small change (`cover.py` + a pytest case) and **gates nothing here**.

## Files (8, plus 2 test files — against the row's 6)

| File | Change |
| --- | --- |
| `src/components/library/CoverPicker.tsx` **(new)** | The modal: one `coverCandidates` call on open, the tiles from `thumb`, a spinner, the refusal sentence, the applied/winner/held markings from the lib, `setCover` on a pick, the release affordance |
| `src/lib/cover-candidate-state.ts` **(new)** | The derivation: for each candidate, the state the tile shows (applied / winner / both / neither) and the sentence for the all-false case (reading 8) |
| `src/stores/ui.store.ts` | `coverPickerBookId: string \| null` + `requestCoverPicker(bookId \| null)`, modelled on `editingBookId`/`requestEdit` (`:97, :134, :167, :201`); **session-only**, never persisted |
| `src/App.tsx` | `{coverPickerBookId && <CoverPicker key={coverPickerBookId} />}` beside `BookEditor` (`:67`) |
| `src/components/library/BookDetail.tsx` | The control on the cover block (`:83-85`) — the block is already `aspect-[2/3] w-44` |
| `src/components/library/BookContextMenu.tsx` | One `MenuItem` beside *Edit metadata…* (`:173-177`), opening the same modal |
| `src/components/library/BookEditor.tsx` | The one clause in the overridden-summary paragraph (`:252-264`) — reading 7 |
| `docs/invariants/settings-and-editing.md` | AC17's sentence: a `cover` lock's release lives in the cover picker, not in the editor (the *Editing metadata by hand* section, `:59-63`) |
| `src/lib/cover-candidate-state.test.ts` **(new)** + the store's case | AC12/AC12a's deciders, and the session-only rule |

**Budget note.** The row said 6 and named `BookEditor.tsx` nowhere; it also assumed the picker's logic could live in the component. Both are the classes a row built by listing *names* is short by — a **consumer** of the value the slice creates (the editor's summary reads the lock the picker writes) and the file the **decider** needs. If 8 files must come down: the first three rows (the picker, the lib, the store) plus the mount are one coherent piece — the modal that works from the detail panel alone — and the context-menu item, the editor clause and the invariant sentence are a second, each independently reviewable. Do not cut the lib to stay inside the row.

## Acceptance criteria

AC12–AC17 are in the spec and they are the contract. Three things they do not yet say, and the build must decide them here:

- **AC12a** — a book where **no** candidate is applied opens with a sentence saying so (reading 3's real case), and the winner is still marked. Decider: `cover-candidate-state.test.ts` (the derivation, offline).
- **AC14a** — the release goes through the **existing** channel: the picker calls `releaseFieldOverride` and adds no `invoke` of its own. Decider: source walk over `CoverPicker.tsx` (the call site is present; no new channel name appears in the file).
- **AC17a** — the editor's summary paragraph names the picker as where a cover lock is released, and still reads as one sentence for every other field. Decider: a source walk over `BookEditor.tsx` — the same instrument AC17 names — with its limit stated in the case's own comment (it proves the sentence, not that a person can see it; that is the probe's half).

**AC15 is already decided and must not be re-asserted in the renderer.** `cover-choice.test.ts` walks the assembled payload's leaves and asserts every `thumb` is a `data:` URL; the picker inherits it by rendering `thumb` verbatim. A rendered-state assertion in the renderer would prove nothing the CSP does not decide, and there is no DOM to assert it in.

## What must not move

- **The sidecar.** `git diff --quiet sidecar/` must be empty: this slice writes no Python and pytest stays at **113**. The same for `src/types/metadata.types.ts`, `src/types/api.types.ts`, `electron/preload/index.ts`, `electron/main/services/cover-choice.ts` and the two IPC handlers — 1b built the surface the picker consumes, so a diff there means the surface was wrong.
- **`index.html`'s CSP**, `metadata.json`'s shape, the `musaeum://cover` route, and `conflicts.ts`'s resolution path (the picker and the queue converge on one writer — `cover-choice.ts` — not two).
- **The four cover facts with one home each:** the scoring formula, the review band, the fixed filenames, the `cover` `HydratedField` mapping. Read them; copy none.
- **The editor's other behaviour.** One clause joins a paragraph that every other field's padlock depends on; the diff there should be one line, not a rewrite.
- **The gates before you start:** typecheck 0, lint 0, `npm test` **1026 / 48 files**, pytest **113**. Two files are prettier-dirty at HEAD and neither is this slice's (`electron/main/services/conflicts.test.ts` `:115`/`:141`, `src/components/library/BookCard.tsx`'s format badge) — leave them.

## Verification plan

1. **vitest** for the derivation and the store — `cover-candidate-state.test.ts` for reading 8's states, and one case for the session-only rule. The store case has a pitfall: the vitest environment is `node` with no `localStorage`, so if `ui.store` persists at all, assert over the exported `partialize` function rather than reaching for `.persist`.
2. **A running-app probe on an isolated profile**, never the library. **`/tmp/probe-cover` still holds the harness** and needs no rebuilding: `app_config.library_root = /tmp/probe-cover/library`, one book `probe-cover-book` (*Artificial Intelligence*) with `cover_full.jpg` (46,412 B) and `cover_thumb.jpg` (20,614 B), one **unresolved** cover conflict (id 1, `google_books`), and an **empty** `field_overrides` — so AC14 runs in the direction that matters: not held → pick → held → release. Launch with `MUSAEUM_USER_DATA=/tmp/probe-cover`. The CDP recipe, the frame capture and the traps are in `musaeum-app-verification`.
3. **Three probes, in this order:** AC12 (the tiles exist, the applied one is marked, the winner is marked where it differs), AC13 (**the pixels** in the panel and on the grid card, before and after, with no relaunch — the criterion is the pixels, not the row, because that is what D7 was about), AC14 (`getFieldOverrides` before and after the release, then a re-fetch whose outcome names the cover). Hand back the frames as `MEDIA:` paths: this owner judges pixels, and a picker that lists the right sources with the wrong image is the failure mode nobody sees in a table.
4. **A mutation campaign over the new JS deciders** — one runner (`--runner "npm test"`), one mutation per decider: the applied-marking dropped, the winner-marking dropped, the all-false sentence replaced by an empty grid, the session-only slot made persistable, the release call removed. The two prettier-dirty files above are not in it.
5. **The "touches nothing below the renderer" claim is proved, not asserted:** `git diff --quiet sidecar/ src/types/` and the two handler files, quoted in the report.

## Start here

```bash
cd ~/Projects/musaeum
git log --oneline -3                        # 214f394 carries 1a, 1b and the two defects 1a exposed
npm run typecheck && npm run lint && npm test   # 1026 / 48 files
sidecar/.venv/bin/python -m pytest sidecar/tests -q   # 113
```

Then read, in this order: `src/components/metadata/ConflictResolver.tsx` (the candidate tiles to imitate — and the URL-keyed preview fetch the picker must **not** copy), `src/components/library/BookDetail.tsx:83-85` (the cover block the control lands on), `src/stores/ui.store.ts:97,134,167,201` (the modal pattern to copy, including the `contextMenu: null` in the setter), and `src/lib/cover-url.ts` (why a pick repaints by itself). The one thing worth reading twice is `electron/main/services/cover-choice.ts`: the picker is a consumer of that service, and every refusal it can display is decided there.

---

## Built — slice 2, the picker (2026-09-25)

**Nine code/doc files and three test files.** The row said 6, this annex said 8, and both counts were short by one thing each: the icon (below) and the walks' home.

| File | Change |
| --- | --- |
| `src/components/library/CoverPicker.tsx` (new) | as the row wrote it — one gather on open, the tiles from `thumb`, the spinner, the refusal sentence, the marks from the lib, `setCover` on a pick, the release affordance |
| `src/lib/cover-candidate-state.ts` (new) | the derivation, **plus `coverTiles(candidates \| null)`** — see defect 1 |
| `src/stores/ui.store.ts` | `coverPickerBookId` + `requestCoverPicker` (modelled on `editingBookId`/`requestEdit`, including the `contextMenu: null`), and the persist rule extracted to an exported `persistedUIState` so "session-only" has a decider |
| `src/App.tsx` | `{coverPickerBookId && <CoverPicker key={coverPickerBookId} />}` beside `BookEditor` |
| `src/components/library/BookDetail.tsx` | the control, **under** the cover block rather than on it |
| `src/components/library/BookContextMenu.tsx` | `Choose cover…`, the item beside *Edit metadata…* |
| `src/components/library/BookEditor.tsx` | the clause (reading 7) |
| `docs/invariants/settings-and-editing.md` | AC17's paragraph, at the end of *Editing metadata by hand* |
| `src/components/shared/icons.tsx` | **the 9th file, unplanned**: `ImageIcon`. `MenuItem` requires an `icon` (`BookContextMenu.tsx:208-218`) and the hand-rolled set had no picture glyph; the alternative was one iconless row among four that have one |
| `src/components/library/cover-picker-wiring.test.ts` (new) | **the 3rd test file, unplanned**: AC14a and AC17a are both source walks, and neither the lib's case nor the store's is their home |

**Gates, frozen tree, after the campaign.** `typecheck` 0, `lint` 0, `prettier --check` clean on all eleven touched files, **`npm test` 1561 passed / 70 files** (+17 over the session's opening 1544: 10 lib + 4 store + 3 wiring), **pytest 117**. **Mutation campaign 12 of 12 killed**, every file restored. It was re-run twice — the first pass was 8 rows over the lib and the store, the second added the four that cover the walks and the editor's clause.

**Three defects the build found, each with the instrument that found it.**

1. **A gather still in flight announced that it had found nothing.** The component derived its tiles with `candidateTiles(candidates ?? [])`, so the *loading* state and the *empty payload* state were the same array — and the panel printed "The gather came back with no cover candidates for this book" over every gather, then replaced it with the tiles a few seconds later. Measured in the running app on the first probe: 400 ms after the click the dialog read *"Looking for covers…"* **and** that sentence, with zero tiles. The fix is a rule, not a condition: `coverTiles(null)` returns `{ tiles: [], notice: null }` and only a payload that really arrived empty gets the sentence, with its own case in the lib. The mutation that restores `notice: NO_CANDIDATES` for `null` reddens it. *(Alternative considered: keep the `?? []` and gate the notice on `candidates === null` in the component. Rejected — the renderer has no DOM harness, so the rule would have gone back to having only a probe.)*
2. **The held sentence said the opposite of what the release does.** It read *"…the padlock hands it back… Hand it back to Musaeum — the cover stays as it is."* Releasing a cover lock is exactly what lets the next fetch replace the cover; the clause now reads *"and the next one may replace it."* Found by reading the dialog's own text off the screen, not by a case — the copy has no decider, which is why the probe reads it.
3. **A walk that failed open.** The AC14a walk's pattern was `/window\.Musaeum\.(\w+)\.(\w+)/`; prettier wraps `window.Musaeum.metadata` and `.coverCandidates(bookId)` onto two lines, so it found **2 of the 4** call sites and the case passed for the wrong reason until the expected set was written out. Now `\s*` before each dot, with the reason in the case's own comment. This is the class worth keeping: a walk whose pattern is narrower than the code will report agreement for a call it never saw.

**Readings this build settled** (each with what it beat):

1. **The control sits under the jacket, not on it.** The alternative — a *Choose cover* badge pinned to the cover's bottom edge, the shape a hover control usually takes — hides part of the artwork on every book, permanently, to save one line of layout; the detail panel is where covers are the hero. The chosen control is a muted caption-scale button directly below the block.
2. **`coverTiles` is the lib's, and `candidateTiles` stays pure over an array.** Two functions rather than one with a sentinel: a caller that has `null` cannot accidentally ask for the empty-payload sentence, because the function that returns it does not accept `null`.
3. **The session-only rule is decided by a source walk.** The annex warned that `.persist` may be unreachable; measured, `useUIStore.persist` is **`undefined`** in the vitest `node` environment (`getOptions()` → TypeError). The rule is asserted as the *output* of `persistedUIState` (an exact key set: `['viewMode']`), and separately as a walk that the store's persist option still names that function — otherwise a whole-state `partialize` inlined at the option would leave every case green.
4. **After a pick the marks are re-derived in place, not re-gathered.** The write is byte identity, so the candidate just written *is* what `cover_full.jpg` holds; a second gather would be a network round trip to learn what the code already knows. The lock, by contrast, is re-read from the release's reply rather than assumed.
5. **The tiles' thumbs are rendered verbatim**, at their own aspect (measured in the app: 240×377, 240×363, 240×391 for three candidates of different shapes — one thumbnail rule, the sidecar's, not a second one here).
6. **The gather is not instant** — the first probe waited ~2.5–4 s for three thumbs over the network. That is why defect 1 was visible on every open, and it is why the spinner is a state and not a decoration.

**Verified in the running app** — isolated profile `/tmp/probe-cover`, never the library, three launches of the built artifact with a CDP port. *(One staging addition, on the profile only: the harness book had no book file, so a real EPUB was copied into `/tmp/probe-cover/library/books/probe-cover-book/` — without it the gather correctly refuses and there are no tiles to probe.)*

- **AC12 — the tiles exist and are marked.** Three tiles, in the sidecar's order: `GOOGLE BOOKS 2164×3398 · A fetch would write this`, `THE COVER INSIDE YOUR FILE 1290×1950` (unmarked), `OPENLIBRARY 307×500 · On your book now`. The applied one is **not** the winner — which is the whole point of the surface. No book-level sentence (a candidate is on the book).
- **AC13 — the pixels, with no relaunch.** In the detail panel: the same URL with a moved clock — `?v=2026-09-21T11:45:43.884Z`, **307×500** → `?v=2026-09-25T17:39:09.199Z`, **600×907**. The disk agrees (`cover_full.jpg` 600×907, `cover_thumb.jpg` 200×302, `metadata.json`'s `last_modified` moved with it), so this is not the paint lagging the row. On the grid card, from a **second, independent** action through the context menu: **200×302 → 200×326** and **41,666 of 60,288 cropped pixels differ** — the card repaints by itself.
- **AC14 — the lock, both directions.** `getFieldOverrides` read `[]` before the pick, `['cover']` after it, and `[]` again after *Hand it back to Musaeum* (with the held line disappearing). The held line and the "…is now the cover on this book" confirmation render beside the tiles.
- **Both entry points.** The detail panel's control and the context menu's *Choose cover…* open the same modal — and the menu is gone the moment the dialog appears (the setter's `contextMenu: null`, which the store's case also decides).
- **AC17's legibility half**, read off the editor's screen for a book whose cover is held: *"You set these, so a metadata fetch will not change them: **Cover**. The padlock beside a field hands it back to Musaeum — its value stays. **Cover** is released from **Choose cover** on the detail panel instead."* — with the field list (TITLE … OPENLIBRARY) confirming there is no cover input.

**What must not have moved, checked rather than asserted** (`git diff --quiet`, quoted from the frozen tree): `sidecar/`, `src/types/`, `electron/preload/index.ts`, `electron/main/services/cover-choice.ts`, `electron/main/ipc/metadata.ts`, `electron/main/ipc/library.ts` and `index.html` — **all unchanged**. The picker calls exactly four pre-existing methods (`metadata.coverCandidates`, `metadata.setCover`, `library.getFieldOverrides`, `library.releaseFieldOverride`), each asserted present in the preload by the AC14a walk.

**What this slice does not do — and why it does not fix the book that opened it.** The picker offers what the gather gathered. For *Topology of Violence* that is the Spanish Herder jacket OpenLibrary returns for its ISBN and the file's own 800×514 landscape spread; Google's English jacket exists but never enters, because `fetchers/google_books.py` queries **by ISBN only** and that ISBN returns `totalItems: 0`. So the picker makes the situation legible and lets a person choose among the real candidates — and **the owner's answer when this was raised was "if the covers are unacceptable by user's determination, user should be able to upload their own option instead"**, which is the next slice: a file-picker source that writes the chosen image through the same `write_choice` path, with the Google ISBN-miss fallback and an in-picker edition search explicitly out. Reading 9's band gap (a 15 % band that counts URL-bearing candidates only, so a book's own jacket never triggers a review) stays open, unpapered-over, as it should.

**Found after landing, fixed the same evening — the control could not be read.** Reported from the app as *"there's no way for me to initiate a cover change directly"*, on the very book this feature was opened for: the Spanish jacket came back after a metadata update, and the person who wanted to overrule it could not find the way. The control was there — directly under the jacket, 11px, uppercase, `parchment-faint` — at **2.35:1** on the owner's own theme (Tokyo Night Dark) and **3.99:1** on this repo's defaults, against AA's 4.5:1 for text that size. The placement comment above it argued for *under* the jacket rather than over it, to keep the artwork whole, and that call stands (the badge alternative is still rejected); what was wrong was the tier — this palette's audit floors `faint` at **2.2:1** and `dim` at **3.5:1**, floors meant for decoration, and a labelled control is not decoration. It now reads `parchment` inside the panel's small-control border — **7.9:1** on that theme — and deliberately keeps no background of its own, so the surface its contrast is measured against is the surface it actually rests on. **Pinned by a case that does the arithmetic rather than a source walk:** `cover-picker-wiring.test.ts` reads the token pair off the component, resolves both through `src/index.css` and computes the WCAG ratio, requiring 4.5:1 — it **failed at 3.99:1 on the shipped code**, and the same paint on the owner's theme measures 2.35:1. One class and one comment in `BookDetail.tsx` is the whole fix. The lesson worth keeping is about *how this was verified the first time*: the probe for this control clicked it by DOM query — `find(x => x.textContent.trim() === 'Choose cover')` — so a build can pass a probe for a control no person can see. Look at the frame, not only at the state.
