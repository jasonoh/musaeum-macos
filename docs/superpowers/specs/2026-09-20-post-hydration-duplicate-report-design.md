# Design: the post-hydration duplicate report (metadata, v1)

**Date:** 2026-09-20
**Status:** Approved by Jason 2026-09-20 (forks settled in one batched form: report only, post-hydration only) — being built
**Scope:** A duplicate that only becomes visible *after* hydration — the ISBN a fetch finds — is reported once, on the surface that already reports hydration. It never merges, never blocks, never stores anything, and says nothing about collisions that predate it.
**Depends on:** the import duplicate gate (`docs/invariants/files-and-deletion.md` → *Duplicate Detection*) and the refresh report (`docs/invariants/refresh-feedback.md` → `HydrateOutcome`, the toast surface)
**Interacts with:** `ImportProgress.duplicate` (the gate's own field — see D5), the detail panel's re-fetch toast, the bulk-refresh summary
**Supersedes:** nothing

---

## Why now

A real re-import of *Fair Play* produced two rows sharing one ISBN, and the app said nothing. Measured on the dev database that day:

- `c7a715c5-…` — "Fair Play: A Game-Changing Solution for When You Have Too Much to Do (and More Life to Live)", Eve Rodsky, imported 15:23:41
- `48595f64-…` — "Summary of Fair Play by Eve Rodsky a Game-Changing Solution…", Ctprint, imported 15:14:28
- both carry `isbn_13 = 9781707274123`

The gate ran and could not fire. `importer.importOne` checks at step 2 (`electron/main/services/importer.ts:160`), and both of its rules read the **file**: `isbn13 = extracted.identifiers?.isbn_13 ?? null` (`importer.ts:158`) — and this EPUB carries no identifiers at all (`identifiers: {}`, read with the real extractor) — and `findByTitleAuthor(title, author)` against a stored row whose title is the spam listing's ("Summary of Fair Play by Eve Rodsky …") and whose author was then `Ctprint`. Neither matches.

The ISBN that would have matched was fetched by hydration, step 5, from Google Books — and **nothing re-checks identity once a fetch has settled it**. That is the whole gap: the gate sees only what the file says about itself, and the file is frequently wrong or silent about its own identity.

Thesis: a duplicate that the gate could not see should still be *told*, at the one moment the app knows it, using surfaces that already exist for exactly this kind of news. One sentence in the design: **detect in `importer.hydrate` after the row settles, carry the result on the payloads that already report hydration, and invent nothing else.**

A measurement that cuts against building anything larger: `idx_books_isbn13` exists (`electron/main/schema/migrations/001_initial.sql:30`), so the check is an index seek on one value, not a scan — there is no cost argument for deferring it, and no reason to make it a job.

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| The gate and its three actions (skip / add as new / add format to existing) | `electron/main/services/importer.ts:160-197` |
| `DuplicateContext { existingBookId, existingTitle, existingAuthor, matchType }` — the shape a report needs, already typed | `src/types/book.types.ts:189` |
| `ImportProgress.duplicate?: DuplicateContext` — set when the gate fires, carried to the renderer as an event | `src/types/book.types.ts:208` |
| The import overlay renders that field: "Already in library: “X” (Same ISBN)" with three buttons | `src/components/library/ImportOverlay.tsx:27-75` |
| Import cards linger 5 s after `done`/`error`/`skipped`, so a note on the final payload is visible | `src/hooks/useLibrary.ts:47-53` |
| `HydrateOutcome` — what a hydration reports (`{ ok, changed, conflicts }`) | `src/types/metadata.types.ts:61` |
| `describeHydrate` — the pure wording of the re-fetch toast | `src/lib/metadata-feedback.ts:58` |
| `BulkHydrateProgress` + `describeBulkHydrate` — the bulk job's single report | `src/types/metadata.types.ts:74`, `src/lib/metadata-feedback.ts:99` |
| ISBN lookup by index | `electron/main/services/db.ts` → `findByIsbn13` |

**Not true today, and inside this feature rather than free:** `findByIsbn13` returns a book by ISBN but cannot exclude the asking book, so a *self* match would report the book as its own duplicate — a small service-level addition rather than a free lookup. And the import overlay's note is written for a decision that has not been taken yet (three buttons calling `resolveDuplicate`); the finished-import case needs the same sentence *without* the buttons, because by then the decision was already made by copying the file.

---

## D1 — Report, never act

**Decision:** the app names the other book and stops. No merge, no auto-delete, no re-gating, no change to either row.
**Why:** chosen by Jason over one-click merge and over auto-merge, and the reason is in the data: two rows sharing an ISBN is **not** proof of the same file. In the worked example the spam listing copied the real book's ISBN, so the two rows are different works as far as a reader is concerned. An automatic merge would have silently welded a "summary" listing onto the book itself. Only a person can decide that pair.
**Consequence:** a duplicate can keep existing indefinitely, and this design deliberately does not track whether the report was seen. Any later "you were told" claim needs storage that does not exist yet (see *Rejected and deferred*).

## D2 — The check runs in `importer.hydrate`, once, on the settled row

**Decision:** immediately after `applyHydration(...)` returns (`electron/main/services/importer.ts:303`), look up the book's now-settled `isbn13` against the library, and carry the answer on this run's outcome. Not in `merge_metadata` (the sidecar has no view of the library), not in `applyHydration` (it is a diff, not a gate), and not on the read path (that is the library-wide scan he declined).
**Why:** every write path that can learn an ISBN from a fetch funnels through `hydrate` — import, the single re-fetch (`metadata:rehydrateBook`), and the bulk job — so one site covers all three and cannot drift. `applyHydration` has already written the row at that moment, so the check reads what is actually stored rather than what was about to be stored.
**Consequence:** a re-fetch of *either* row reports the pair. That is intended — it is a user action on that book — but it means the report is not strictly "new collisions only"; it is "collisions this run can see".

## D3 — The report rides the payloads that already report hydration; nothing new is built

**Decision:** the same `DuplicateContext` value is delivered by whichever surface that path already has:

| Path | Carried on | Surfaces as |
| --- | --- | --- |
| Import | `ImportProgress.duplicate` on the final `done` emit | the overlay card, in the gate's own words, without buttons |
| Single re-fetch | `HydrateOutcome.duplicate` | the existing toast, via `describeHydrate` |
| Bulk re-fetch | `BulkHydrateProgress.duplicates` (a count) | the existing end-of-job summary toast |

**Why:** no new event channel, no preload surface, no store field, no schema change, no badge. Every one of those surfaces exists because a person needs to be told something about a hydration run; a duplicate is that kind of news. A durable marker was the alternative and it is exactly what he declined (D3's reversal condition below).
**Consequence:** the report is **ephemeral** — an import's note lives on a card that clears after 5 s, and a missed toast is gone. That is the honest cost of building no storage, and it is stated again under *Risks*.

## D4 — ISBN-13 only, not the title+author rule

**Decision:** the post-hydration check reports only an `isbn_13` match. `matchType` stays `'isbn'`.
**Why:** the decisive argument is the worked example — the two rows' **titles differ** ("Fair Play: A Game-Changing Solution…" vs "Summary of Fair Play by Eve Rodsky…"), so re-running the title+author rule after hydration would not have caught this case at all, while ISBN catches it exactly. The gate keeps both rules because before the copy it has nothing better; after a fetch, the identity that the gate could not see is the one worth re-checking.
**Consequence:** a duplicate whose ISBN neither source supplies stays unreported, and after this slice nobody should read "no duplicate reported" as "no duplicate".

## D5 — A collision the gate already reported is not reported twice

**Decision:** when the job's `duplicate` is already set — i.e. the pre-copy gate fired and the user chose "Add as new" — `hydrate` does not run the check for that job.
**Why:** the gate's card is the stronger report: it names the collision *and* offers the three actions, and the user has just answered it. Repeating it seconds later, on the same card, in weaker words and with nothing to click, reads as the app losing track of the decision it just took. This is a reading rather than a fork (it changes nothing a user asked for), so it is recorded here with its reversal condition: if the gate's decision should be *re-litigated* once a fetched ISBN confirms it, that is a different feature — an affordance on the finished card, not a second note.
**Consequence:** `hydrate` reads one field of the job it is handed. It stays correct for the bulk job and the single re-fetch, which pass no job at all.

---

## Acceptance criteria

### Slice 1 — detection and the main-process report (6 files)

1. A book whose settled ISBN matches another row reports it: `hydrate`'s outcome carries `duplicate.existingBookId` and `matchType === 'isbn'` — *vitest, `importer.test.ts`*
2. A book whose ISBN matches no other row reports nothing (`duplicate` undefined) — *vitest, `importer.test.ts`*
3. The check reads the ISBN the run **settled**, not one the file carried: with an embedded ISBN the gate could not use (none) and a fetched one that exists, the collision is reported — *vitest, `importer.test.ts`, sidecar mocked*
4. A book is never reported as its own duplicate — *vitest, `db.test.ts`*
5. Nothing is written because of the report: both rows keep their fields, the book count is unchanged, and no schema file changes — *vitest assertion + `git diff --quiet electron/main/schema`*
6. A job whose gate already reported the collision stays silent for that run (D5) — *vitest, `importer.test.ts`*
7. The bulk job counts them: `BulkHydrateProgress.duplicates` reaches the renderer — *vitest, `bulk-hydrate.test.ts`*

### Slice 2 — the renderer's words and the finished-import note (3 files)

8. `describeHydrate` names the other book when `duplicate` is present and is otherwise unchanged, including the no-change and failure cases — *vitest, `metadata-feedback.test.ts`*
9. `describeBulkHydrate` says the count when it is non-zero — *vitest, `metadata-feedback.test.ts`*
10. A finished import whose collision was found after hydration shows the note on its card, with no buttons — *CDP probe, running app (no DOM harness renders components)*
11. The gate's own card is unchanged: same sentence, same three buttons, when the decision is still open — *CDP probe, running app*

## Slices, and why they are cut this way

**Slice 1 (6 files).** New: none. Edited: `electron/main/services/db.ts` (+ its test), `electron/main/services/importer.ts` (+ its test), `src/types/metadata.types.ts`, `electron/main/services/bulk-hydrate.ts` (+ its test). It stops at the boundary of the main process: everything a test can decide is decided here, and the renderer's wording is not needed for the check to be correct.

**Slice 2 (3 files).** Edited: `src/lib/metadata-feedback.ts` (+ its test), `src/components/library/ImportOverlay.tsx`. The UI last, because its only instrument is a running-app probe.

## Rejected and deferred, with the condition that would revive them

- **A library-wide duplicates review** (derived: `GROUP BY isbn_13 HAVING COUNT(*) > 1`) — declined by Jason 2026-09-20: the pairs already in the library stay invisible. Revived when a stale pair has cost someone real work — at which point the query is one index-friendly statement and the surface is a filter, not a new screen.
- **A durable marker** (badge, detail-panel line, a stored `duplicate_of`) — deferred, not rejected. It needs a stored flag and a dismissal, which is the storage this slice avoids. Revived when a missed report has been observed twice; additive as one column plus a panel line, with the derived query above as the backfill.
- **Preventing the duplicate** — declined: it means fetching identity *before* the copy, which puts a network round-trip in front of every import against the documented contract ("the book is inserted immediately after copy; hydration continues async", `docs/invariants/metadata-hydration.md`).
- **Auto-merging on an exact ISBN match** — rejected in D1: a shared ISBN is not proof of the same file, and the worked example is the proof.
- **Reading identity from the file more aggressively** (e.g. a title-only match, fuzzy containment, a Google lookup at gate time) — out of scope; it would widen the gate's false-positive surface, which is the subsystem the doc already calls out as gated deliberately.

## Risks, stated plainly

1. **The report can be missed entirely.** It is ephemeral by construction (D3): a 5-second card, or a toast on a surface that also reports "no new metadata found". A user who is not looking when either happens learns nothing, and the next run of the *same* book reports it again only if it hydrates again. This is the residual the design does not solve, and the deferred durable marker is the answer to it.
2. **The check reads a settled ISBN, so a book can be reported as a duplicate of a book the user deliberately created.** Importing a second copy with "Add as new" at the gate is covered by D5; importing a *different* file that carries the same ISBN is reported, which is correct but may read as noise to someone deliberately keeping two editions. There is no dismissal — see *Rejected and deferred*.
3. **The bulk path's number is a count, not a list.** Fifty books and two duplicates gives "· 2 possible duplicates" with no way to learn which two. Accepted for this slice because the bulk job's report is already a count of everything (`updated`, `failed`, `skipped`); naming them needs a durable list, i.e. the deferred marker.
4. **Invariants held:** 1 (`metadata.json` canonical) — nothing is written by this feature at all; 4 (sort keys) and 5 (reading state) — untouched; 8 (business logic in services) — the check is a service call from a service, and no IPC handler changes; 12 (failures non-fatal) — the check is best-effort and a failure to look up an ISBN must never fail a hydration, which is an acceptance criterion of its own in the build.
   **Not touched:** 2, 3, 6, 7, 9, 10, 11.

---

## Built — slices 1 and 2 (2026-09-20)

Both slices landed in one build; the commit split follows the design's boundary (main process, then renderer).

**Criteria, and what decided each.** AC1–AC7 hold by `vitest`: four new cases in `importer.test.ts` (the collision named; nothing reported when there is nothing to name; never itself; `gateReported` suppressing), the wiring case inside the gate's own suite (an import the gate gated, whose hydration settles the same ISBN, reports nothing — and the `copying` payload no longer carries the gate's context), two in `db.test.ts` (`findOtherByIsbn13` never returns the asking book), and one in `bulk-hydrate.test.ts` (the count reaches the progress payload). AC8–AC9 hold in `metadata-feedback.test.ts` (five new cases, including the no-action assertion). **AC10 and AC11 have no unit decider — they were run as CDP probes in the running app** (isolated profile, `MUSAEUM_USER_DATA`), against a fixture that reproduces the real collision: a library row holding ISBN 9781707274123, an import whose OPF title/author match the real *Fair Play* and which declares **no** identifier, and a second import whose OPF carries the ISBN.

- **AC11 (the gate card is unchanged):** the gated import showed its own sentence — *Already in library: "Shelf Row That Already Exists" by Nobody In Particular (Same ISBN)* — with its three buttons, `Skip`, `Add as new`, `Add format to existing`, and no post-hydration note at all.
- **AC10 (the note on a finished import):** the fetch (keyed, as below) pulled the *Ctprint* summary record in, exactly as the original incident did — the probe's second card reads "Summary of Fair Play by Eve Rodsky a Game-… / Ctprint" — and the card carried: *Possible duplicate — already in library: "Shelf Row That Already Exists" by Nobody In Particular (Same ISBN)*, with **no buttons** in the card.
- **The single re-fetch path** (D3's toast, not a criterion of its own but the same value): pressing ↻ on that book produced *Possible duplicate / No new metadata · same ISBN as "Shelf Row That Already Exists"* with a dismiss `✕` and no action button.

**What the probe taught, and a first run that proved a real limit.** The first probe attempt was launched without `GOOGLE_BOOKS_API_KEY` and produced **no note at all** — a true negative, and worth recording: unkeyed, Google Books returned nothing the fetcher could use (its `_safe` wrapper swallowed the failure), so hydration settled no ISBN and there was nothing to report. Re-run with the key taken from `app_config` (what the README's `infisical run -- npm run dev` provides), Google returns the Ctprint record at confidence 0.65 with ISBN 9781707274123 for the real title and author. **Consequence for reading this feature's reports in a dev run: without a key the check is effectively inert**, not broken.

**Deviations from the text above.**

1. The finished-import note is a second component (`DuplicateNote`), not a reuse of `DuplicateGate`: the gate's card is a *question* with three buttons calling `resolveDuplicate`, and by `done` the decision has been taken by keeping the file.
2. **A reading the design left open:** `ImportProgress.duplicate` would otherwise carry two meanings on the same field, so `importOne` now **clears** it as the import moves past the gate — the gate's context dies with the decision it carried. That is also what let D5 be enforced by the caller (`gateReported: Boolean(matchType)`) rather than by `hydrate` inspecting a field two different code paths write.
3. `describeHydrate` leads with the collision but keeps the field summary in the detail ("Title · same ISBN as …"), because the refresh report's existing promise — that only a real change counts as a change — should not be dropped on the run that also finds a duplicate. The bulk summary does the same in reverse: the count is appended to whatever the job already reported, including the "nothing new" case.

**Files.** Slice 1, seven: `services/db.ts` (+ test), `services/importer.ts` (+ test), `services/bulk-hydrate.ts` (+ test), `src/types/metadata.types.ts`. Slice 2, three: `lib/metadata-feedback.ts` (+ test), `components/library/ImportOverlay.tsx`. The spec's own budget row said six and three; the overrun is `metadata.types.ts`, which the row had folded into "the types" without counting the two new fields' home. Tests: **882 passed / 38 files** (was 869 — thirteen new). `typecheck`, `lint` and `prettier` clean on every touched file (`db.ts` and `db.test.ts` carry pre-existing prettier drift in regions this build did not touch).

