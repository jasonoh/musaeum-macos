# Cover choice, slice 1b — the candidates, and setting one

**Date:** 2026-09-21
**Slice:** 1b of three (1a, 1b, 2) — **built 2026-09-21 at 10 files**, against this row's 9. Read it for the readings it settled, not as work outstanding: the spec's *Built — slice 1b* section carries the result, the criteria table, every deviation and what the build found on real data.
**Annex to:** `docs/superpowers/specs/2026-09-21-cover-choice-design.md` (the spec; D1–D7 and the acceptance criteria live there)
**Read first:** that spec's *Why now* and D1/D2/D3/D4/D6, its *Built — slice 1a* and *Built — the conflict queue's cover previews* sections, and this document's *Readings* below — they change three of the spec's assumptions.

---

## What this slice is, in four lines

1. **`cover_candidates`** — a sidecar method returning every cover the fetch would gather for one book, each with `source`, `url` (absent for embedded), `width`, `height`, `score`, `winner`, `applied` (byte-identical to what is on disk now) and a `thumb` data URL (AC4–AC6).
2. **`set_cover`** — a sidecar method that writes a chosen candidate: `source='embedded'` re-extracts the file's own jacket, any other source needs the `url` the gather itself returned and refuses everything else (AC6–AC7).
3. **`services/cover-choice.ts`** — the main-process service: pre-flight, gather, apply, lock `cover` via `fieldOverrides`, rewrite `metadata.json`, upsert the catalog, broadcast. It is `conflicts.ts`'s cover leg (`:41-64`) given a home of its own instead of a second copy (AC8–AC9).
4. **The surface** — two thin handlers, the preload binding and the shared types. **No UI**: the picker is slice 2.

## Readings this session settled — they are not open questions any more

- **D7 is answered, and 1b needs nothing from it.** The repaint question ("does a same-URL cover replacement repaint at all?") was measured and fixed on 2026-09-21: it did **not** repaint, and `src/lib/cover-url.ts` now carries the row's clock in the URL. A pick that moves `lastModified` therefore repaints by construction — the picker adds no cache-busting of its own. Slice 2's first act is no longer a probe; it is the component.
- **The thumbnail rule already exists — do not write a second one.** `pipeline/cover.py:153` (`preview_data_url`, ≤240 px JPEG q80) and `:181` (`previews_for`: deduped, `MAX_PREVIEWS`-capped, absolute `http(s)` only, a dead URL simply absent) shipped with the conflict-preview fix. `cover_candidates` should call `preview_data_url` on each candidate's bytes, exactly as `previews_for` does, so a picker thumb and a queue thumb cannot diverge.
- **The renderer cannot show a remote image, and that is settled policy, not an obstacle.** `index.html:8`'s CSP is `img-src 'self' musaeum: data: blob:`. Every candidate image must arrive as a data URL. **Never widen it.**
- **`applied` must be byte identity, not provenance.** The cover's *source* is not recorded anywhere (`tasks.md:58`), so the picker can only say "this one is what your book has now" by comparing bytes with the stored `cover_full.jpg`. Do not phrase it as "the one you chose" (spec risk 4).
- **A `cover` lock is honoured by the *fetch*, not by the picker.** `hydration.py:99-103` gathers no candidate when `cover` is locked; `cover_candidates` must **not** honour it, or a user could never change their mind after locking once.
- **Marking the override is a deliberate choice, not a diff.** `fieldOverrides.markFromPatch(bookId, {coverFullPath, coverThumbPath}, null)` — `before = null` on purpose, so that choosing the jacket that is already applied still records the decision (AC9). The guard exists to stop a *form* locking every field; this gesture *is* the decision.
- **Open, and it needs a decision before the picker is written:** a conflict's candidates come only from the sources — `select_cover` returns url-bearing candidates (`cover.py:88-92`), so the book's **own embedded jacket is never among them**. The picker must include it (that is D1's "put the file's own jacket back"), and the same gap is what makes "keep what I have" inexpressible in the *queue*. Recommendation when you build: `cover_candidates` returns the embedded candidate, and the queue is left alone until slice 2 shows what the picker's copy looks like. **Settled that way (2026-09-21):** the embedded candidate is in the picker's payload with no `url`, `select_cover`'s own returned list is still URLs-only, and a real case of what the gap costs was measured on *Star Maker* — the file's jacket lost a 0.3 % margin, inside the 15 % band, and queued nothing (the band's guard counts URL-bearing candidates only). See the spec's *Built — slice 1b*, reading 2 and the finding after it.

## Files (9, at the house bound — the spec's row, plus what the build will find)

| File | Change |
| --- | --- |
| `sidecar/pipeline/cover.py` | Extract `gather_candidates(file_path, google, openlib, book_dir)` out of `hydration.py`; add `summarise_candidates` (winner, `applied`, thumbs) and `write_choice` (`source`, `url`, embedded re-extract) |
| `sidecar/pipeline/hydration.py` | Call the extracted gather, so candidates have one home (`:104-131` today) |
| `sidecar/main.py` | Register `cover_candidates` and `set_cover` beside `cover_previews` (`:55`) |
| `electron/main/services/cover-choice.ts` **(new)** | Pre-flight (`nas.assertOnline`, `sidecar.assertAvailable`, a hydratable file), gather, apply, lock, `importer.writeMetadataJson`, `librarySync.upsertCatalog`, `broadcast` |
| `electron/main/ipc/metadata.ts` | Two thin handlers through `handle()` (invariant 8) |
| `electron/preload/index.ts` | `coverCandidates(bookId)`, `setCover(bookId, choice)` |
| `src/types/api.types.ts` | The same two, typed |
| `src/types/metadata.types.ts` | `CoverCandidate` (`source`, `url?`, `width`, `height`, `score`, `winner`, `applied`, `thumb`) |
| `sidecar/tests/test_cover_candidates.py` + `electron/main/services/cover-choice.test.ts` | AC4–AC11's deciders |

**Budget note, learned the hard way on 1a:** the row above is what a spec imagines. Walk the four questions — who *writes* the value, who *reads* it, who *wires* it across a boundary, who *proves* it — and expect the honest count to be 10–11 (1a's own row said 2 and cost 3). If it crosses the bound, split at the testability boundary (sidecar → service → surface) rather than absorbing it silently.

## Acceptance criteria

AC4–AC11 are in the spec; they are the contract. Three things they do not yet say, and the build must decide them here:

- **AC4a** — the `embedded` candidate is present whenever the file carries a cover, with `url` absent and a `thumb` whose bytes are that image. Decider: `test_cover_candidates.py` (synthetic EPUB, md5 against the fixture's own image).
- **AC4b** — `applied` is true for exactly the candidate whose bytes equal `cover_full.jpg` on disk, for a book hydrated from the file, and false for all of them after a choice that wrote a different one. Decider: the same file, round trip through `tmp_path`.
- **AC9a** — choosing the candidate that is already applied changes no bytes, records the override, and still reports success. Decider: `cover-choice.test.ts` (the guard case AC9 names, with the byte comparison asserted as well as the lock).

## What must not move

- **`metadata.json`'s shape** (invariant 1 and the iOS contract): this slice adds nothing to it. Candidates are gathered live (D1) — no `cover_candidates` member, no `books` column.
- **The four cover facts that already have one home:** the scoring formula, the review band, the fixed filenames, and the `cover` `HydratedField` mapping. Reuse them; a second copy of any is the defect this repository has already paid for twice.
- **`index.html`'s CSP**, `vendor/foliate-js/`, the `musaeum://cover` route (slice 1b adds no route), and `conflicts.ts`'s existing resolution path (the picker and the queue must converge on one writer, not two).
- **The existing gates:** typecheck 0, lint 0, `npm test` 1015 / pytest 99 before you start. Two files are prettier-dirty at HEAD (`electron/main/services/conflicts.test.ts`, `src/components/library/BookCard.tsx`) — leave them as they are.

## Verification plan

1. **pytest** for AC4–AC6, AC4a/AC4b (offline: synthetic EPUB + monkeypatched fetchers, no network).
2. **vitest** for AC7–AC11 — `sidecar.call` stubbed, the pre-write row passed explicitly to the marker, and the shape criterion over the serialized candidate array (every `thumb` a `data:` URL).
3. **Mutation campaign** — one mutation per new decider, run with the slice skill's `scripts/mutation-campaign.py` against both runners. Expect a new-file count of 6–8.
4. **Nothing in the app this slice** — the UI is slice 2, and its evidence is the running-app probe (isolated profile, `MUSAEUM_USER_DATA`, never the real library).

## Start here

```bash
cd ~/Projects/musaeum
git log --oneline -3                     # e3f9d4b is this work; origin/main is one behind
npm run typecheck && npm run lint && npm test   # 1015 / 47 files
sidecar/.venv/bin/python -m pytest sidecar/tests -q   # 99
```

Then read `sidecar/pipeline/cover.py` end to end (197 lines, all of it relevant), `docs/invariants/metadata-hydration.md`, and the spec's D1–D4. The one thing worth reading twice is `conflicts.ts:41-64` — the cover leg this slice is a second home *for*, not a copy of.
