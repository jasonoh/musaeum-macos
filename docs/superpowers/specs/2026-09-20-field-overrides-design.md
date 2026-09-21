# Design: field overrides survive a re-fetch (metadata, v1)

**Date:** 2026-09-20
**Status:** Approved by Jason 2026-09-20 (three forks settled in one batched form: `app_config`, an explicit release control, and a locked field that is not proposed) — being built
**Scope:** a field the user has set stops being a field a fetch may change. It records the user's *decision*, marks it in one service, and enforces it in the two places that ask two different questions — what may be proposed, and what may be written. It does not travel between machines.
**Depends on:** the hydration merge (`docs/invariants/metadata-hydration.md`), the conflict queue (`docs/invariants/conflicts-and-series.md`), `app_config` (`docs/invariants/settings-and-editing.md`)
**Interacts with:** `library:updateBook` (the editor's save), `metadata:resolveConflict`, the sidecar's `hydrate_metadata` params
**Supersedes:** nothing

---

## Why now

A manual edit and a resolved conflict are both **user decisions**, and both are currently overwritten by the next fetch. Measured on the dev database after the incident that prompted this: `metadata_conflicts` rows 41 and 42 for book `48595f64-…` are `resolved = 1` with `chosen_source = 'embedded'`, resolved at 15:14:59 (title) and 15:15:01 (author) — and the book's author is `Ctprint`, not the `Eve Rodsky` that resolution chose. The re-fetch in between re-merged it.

The mechanism is arithmetic, not a missing branch. `conflict.py` scores a candidate `priority + min(learned, 5) × 0.5`; `SOURCE_PRIORITY['embedded']` is 1 and `google_books` is 4, so the most the user's choices can ever add is 2.5 — **embedded peaks at 3.5 and can never win against Google**, however many times the user picks it. And a manual edit is not a resolution at all: nothing records it, so the merge has no reason to prefer it.

Thesis: "the user decided this" is the strongest source of truth the app has, and it is the one thing the merge never hears about. One sentence for the design: **record the decision where a decision already lands, pass it to the merge so the field is not even proposed, and drop it from the merged result before the write — so no path can clobber it.**

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| The vocabulary for "a field a source can disagree about" — `HydratedField`, which is documented as *the fields hydration can rewrite* and already includes `tags` | `src/types/metadata.types.ts:22-38` |
| The label map and display order for those fields | `src/types/metadata.types.ts` → `HYDRATED_FIELD_LABELS` |
| The `Book` column → `HydratedField` table this feature reuses (moving it to the shared types, since it now has two callers) | `electron/main/services/importer.ts:393-410` |
| The editor already sends **only changed fields** (`changedFields`) — the patch is the user's diff | `src/components/library/BookEditor.tsx:122-133` |
| The editor's field set, including `description` and the four identifier columns | `src/components/library/BookEditor.tsx:20-37`, `:92-120` |
| `resolveConflict` writes the chosen value through `db.updateBook` + `writeMetadataJson` + catalog | `electron/main/services/conflicts.ts:28-79` |
| `library:updateBook` — the editor's entry point, same three writes | `electron/main/ipc/library.ts:28-44` |
| `app_config` read/write, and precedent for a JSON blob in it (`theme_tokens`) | `electron/main/services/db.ts:67-88` |
| The hydrate RPC's params, where a lock list has to travel | `electron/main/services/importer.ts:281-300` |
| The merge's candidate collection and its reviewed/quiet field split | `sidecar/pipeline/conflict.py:37-124` |
| The file's own identifiers are merged in *outside* `merge_metadata`, after it | `sidecar/pipeline/hydration.py:86-89` |
| Cover selection is a separate step with its own candidate list | `sidecar/pipeline/hydration.py:91-116` |

**Not true today, and inside this feature rather than free:** nothing records a user's decision, so there is no list to pass; `app_config` has no per-book key space (a single JSON value under one key is the shape, as `theme_tokens` shows); and the sidecar has no notion of a field it must not propose, so `merge_metadata` needs the parameter threaded through `hydrate_metadata`'s call path.

---

## D1 — The decision is recorded in `app_config`, as this machine's opinion

> **Superseded 2026-09-20, by the condition below.** Jason confirmed the same day that he already uses Musaeum on two machines, so the machine-local map is now a known-broken posture rather than a deliberate trade: `docs/superpowers/specs/2026-09-20-portable-decisions-design.md` (D1–D2) moves the map into `metadata.json` + a `books` column, timestamped per field. The prose below is kept as the decision's provenance, not as a description of the app.

**Decision:** one JSON value under the key `field_overrides`, shaped `{ [bookId]: MetadataField[] }`. Chosen by Jason over a `metadata.json` + column pair (which would travel with the book) and over raising the learned bias (which covers no manual edit).
**Why:** it needs no schema change, no `metadata.json` contract change and no catalog change; `theme_tokens` already stores a JSON blob the same way; and the fact is about *this machine's* user, not about the book.
**Consequence, stated plainly:** the file on the NAS does not carry it. A re-fetch run from a second machine — or from the iOS companion's server once that exists — can still move an overridden field, and a book deleted and re-imported under a new id starts unlocked. **Reversal condition:** if a second machine ever edits the same library, this becomes `metadata.json` + a `books` column, exactly as `reading_state` (migration 003) already works; the map's *shape* is what would move, so the enforcement sites do not change.

## D2 — A release control, per field, in the editor

**Decision:** the editor shows which of its fields are overridden and lets the user release one, which clears the lock and **keeps the value**; the next fetch may then propose again. Chosen by Jason over "the lock clears when the field is emptied" and over "permanent until re-import".
**Why:** without a release the feature is a trap — a wrong edit would freeze a field forever with no way to hand it back, which is worse than the bug being fixed. Per field rather than per book, because the decision is per field: locking a title says nothing about the publisher.
**Consequence:** the editor becomes the place the override *state* is visible, so it is also the place a future "why won't this update?" question is answered. A lock the user cannot see is a support burden.

## D3 — A locked field is not proposed at all

**Decision:** the locked field is excluded from the candidate list, so no conflict is queued for it and nothing is applied to it. Chosen by Jason over "still propose it, never write it".
**Why:** the alternative keeps asking the user to re-decide something they have already decided, and the queue is a review surface for *open* questions — filling it with answered ones is how a review queue stops being read. Switching judgement stays available through D2: release the field, re-fetch.
**Consequence:** a locked field goes quiet — including in the cases where the fetch is genuinely right. The app will not tell the user that Google has a better title while their lock is on; that is the intended trade, and it is why D2's control has to be discoverable.

## D4 — The lockable vocabulary *is* `HydratedField`

**Decision:** one list — the existing `HydratedField` union, whose own doc comment already reads "the fields hydration can rewrite", mapped from `Book` keys by the existing `HYDRATED_KEY_FIELD` table (`seriesName`/`seriesIndex`/`seriesTotal` → `series`; the four identifier columns → `identifiers`; `coverFullPath`/`coverThumbPath` → `cover`; `tags` → `tags`). That table moves into `src/types/metadata.types.ts` beside the union, because it now has two callers asking two different questions of it. `sortTitle` and `authorSort` are deliberately **not** in it — derived companions, and `HYDRATED_KEY_FIELD` already leaves them out of "what a fetch changed" for the same reason.
**Why:** "what a fetch may write", "what a refresh reports as changed" and "what a user may override" are the same set asked by three callers, and three lists would drift. It also means the conflict queue's field names are the lock's field names, so a resolution can mark exactly what it resolved without a translation table — which is what the earlier draft's invented `MetadataField` union would have cost.
**Consequence:** adding a field to `HydratedField` adds it to the locks and the change report together. A field that is fetched but not in the union could not be overridden.

## D5 — One service marks; the two decision paths call it

**Decision:** `services/field-overrides.ts` owns `markFromPatch` (marks the lockable fields in a patch **whose value differs from the stored row**), `release(bookId, field)` and `list(bookId)`. `library:updateBook` and `conflicts.resolveConflict` each call `markFromPatch` with what they wrote.
**Why:** the marking rule belongs in a service (invariant 8) and needs a test that does not go through IPC. The differs-from-stored guard is what stops a future caller that sends a whole form from locking every field on a book the user only *opened* — the editor happens to send a diff today (`BookEditor.tsx:122`), and that is a property of one caller, not of the contract.
**Consequence:** a field marked once stays marked until D2 releases it; nothing auto-expires a lock, so the map only shrinks through the editor.

## D6 — Enforcement in two places, for two different questions

**Decision:** the lock list travels to the sidecar in the `hydrate_metadata` params, where `merge_metadata` (and the identifiers merge after it, and cover selection) skips those fields entirely — that answers *what may be proposed*. And `importer.hydrate` drops any locked key from the merged result and the cover before `applyHydration` — that answers *what may be written*, at the one point every hydration passes through.
**Why:** neither is a wrapper of the other, and each closes a hole the other leaves. Without the sidecar half, a locked title still queues a conflict (D3 broken). Without the main-process half, the file's own identifiers and the cover — which are merged *outside* `merge_metadata` — would still land, and any future caller of `applyHydration` would bypass the rule silently.
**Consequence:** the two must agree on field names, which D4 makes structural rather than conventional.

---

## Acceptance criteria

### Slice 1 — the store, the marking, and both enforcement points (12 files)

1. Saving an edit marks exactly the fields that changed among the lockable vocabulary; a field the user did not touch is not locked — *vitest, `field-overrides.test.ts`*
2. A patch that merely restates the stored value locks nothing (the guard in D5) — *same file*
3. The map survives a database close and reopen (`app_config`) — *same file*
4. `release` clears one field and leaves the book's other locks alone — *same file*
5. `seriesIndex`/`seriesTotal` in a patch lock the single field `series`; the four identifier columns lock `identifiers` — *same file*
6. A hydration whose fetch returns a different value for a locked field leaves the stored value alone, and reports no change for it — *vitest, `importer.test.ts`*
7. A locked key is dropped even when the reply carries it, and a locked `cover` is not applied — *same file, sidecar mocked*
8. `resolveConflict` marks the field it resolved — *vitest, `conflicts.test.ts` (or `field-overrides.test.ts` if the call is asserted there)*
9. The sidecar excludes a locked `title`/`author`/`series` from candidates, so no conflict is queued — *pytest, `test_conflict.py`*
10. A locked `identifiers` survives the file's own identifiers being merged in after the merge — *pytest, hydration-level case*
11. A locked `cover` is not selected — *pytest, hydration-level case*
12. The map is read once per hydration, not per field — *source walk over `importer.hydrate` (named so a later edit that re-reads it in a loop is visible)*

### Slice 2 — the editor's control (1 file, plus its probe)

13. An overridden field shows that it is overridden, and a field that is not overridden shows no control — *CDP probe, running app*
14. Releasing a field clears the lock **and leaves the value** — *CDP probe: the lock is gone from `app_config` while the stored value is unchanged*
15. A field with no override offers nothing to release — *CDP probe (same run)*

## Slices, and why they are cut this way

**Slice 1 (12 files).** New: `services/field-overrides.ts` (+ its test). Edited: `services/db.ts` (+ test), `services/importer.ts` (+ test), `services/conflicts.ts`, `ipc/library.ts`, `electron/preload/index.ts`, `src/types/api.types.ts`, `src/types/metadata.types.ts`, `sidecar/pipeline/hydration.py`, `sidecar/pipeline/conflict.py`, `sidecar/tests/test_conflict.py`. It is over the ~10-file bound and that is recorded rather than absorbed: the feature is one rule enforced at two boundaries, and each boundary needs its own test file. It stops where the renderer starts, because nothing before that needs a screen to be true.

**Slice 2 (1 file).** Edited: `components/library/BookEditor.tsx`. Last, because its only instrument is a running-app probe.

## Built — 2026-09-20

**The bug this slice's own criteria caught: for an hour, the feature did nothing.** The first build marked a field *after* the write —

```ts
db.updateBook(id, updates)
fieldOverrides.markFromPatch(id, updates)   // compares the patch against… the row it just wrote
```

— and since `markFromPatch` decided "did the user decide anything?" by diffing the patch against the stored row, the diff was against the row the write had *just produced*: always equal, so nothing was ever marked. A silent no-op with a green suite is the exact failure mode a criterion is for, and the one that surfaced it was the guard case (AC4's first half, "a patch that merely restates the row locks nothing"): writing it forced the question *what is the diff taken against?* `markFromPatch` now takes the pre-write row as a third parameter and both call sites pass the row they read before writing (`ipc/library.ts` reads it once for this; `conflicts.ts` already held it in the cover branch and now hoists it). It is a signature the design did not name, and it is the one change here that exists because of what the build measured rather than what it planned.

**Files: 17 code files, +3 docs and this spec — the design predicted 13, and the overshoot is mostly what the design did not see.**

- *New:* `services/field-overrides.ts` (+ test), `sidecar/tests/test_hydration_locks.py`.
- *Edited, main:* `services/importer.ts` (+ test), `services/conflicts.ts` (+ test), `ipc/library.ts`, `preload/index.ts`.
- *Edited, contracts:* `src/types/api.types.ts`, `metadata.types.ts`.
- *Edited, sidecar:* `pipeline/conflict.py`, `pipeline/hydration.py`, `main.py`.
- *Edited, renderer (slice 2):* `components/library/BookEditor.tsx`, `components/shared/icons.tsx`.
- *Docs:* `docs/invariants/metadata-hydration.md`, `docs/invariants/settings-and-editing.md`, `docs/data-contracts.md` (preload surface).

Three of the seventeen were not in the plan, and each for a reason worth keeping — and two files the plan *did* name turned out not to need touching:

1. **`src/types/book.types.ts`** (unplanned, and the one that must be recorded): the marking needs the "is this patch a change?" equality rule, which `db.updateBook` has privately and the editor has in its own `changedFields`. It is now exported as `sameBookValue` and used by the marking and by `importer`'s reply filter. `db.updateBook`'s own comparison was **not** folded into it — that would edit the DB writer for no change in behaviour, and the helper's job here is to make the *rule* shared, not to unify every copy of it.
2. **`components/shared/icons.tsx`** — the chip needs a padlock, and the repo hand-rolls its icons. No library was added.
3. **`sidecar/tests/test_hydration_locks.py`** rather than the planned additions to `test_conflict.py`: AC9 is merge-level but AC10–AC11 are hydration-level and need a fixture EPUB and stubbed fetchers, and the two halves of one rule read better in one file than appended to a file about conflicts.
4. **`services/db.ts` was planned and is untouched** — the map lives entirely behind `services/field-overrides.ts`, which reads and writes it through the existing `db.getConfig`/`db.setConfig`. No column, no migration, and the plan's `db.ts` (+test) pair never materialised. So did the planned `test_conflict.py` edit. `services/conflicts.test.ts` and `services/importer.test.ts` were *not* in the plan's list and both gained cases.

**One already-false sentence had to go** — the editor's own footer told the user "a later re-fetch can still overwrite them", which this slice makes untrue (and the file's doc comment said the same). Both now describe the override and where it is released.

**Measured.** vitest **897 tests / 39 files** (+15, one new file), pytest **84** (+8), `typecheck` / `lint` / `prettier` clean, `build` green. In the running app on an isolated profile with a one-book synthetic library, driven over CDP:

- *AC13–AC15.* A book with nothing overridden opened the editor with **no chip and no summary**; a save that changed the title produced `getFieldOverrides → ["title"]` over the real IPC and renamed the card; reopening showed **exactly one** chip (`aria-label="Release the override on Title"`) on the Title field and the summary reading *"You set these, so a metadata fetch will not change them: Title."*
- *AC14.* Clicking the chip left the form value and the stored row at `My Own Title`, took the overrides back to `[]`, and removed both the chip and the summary.
- The frames: `docs/superpowers/` carries none — the probe was a `/tmp` scratch instance, deleted afterwards. The user's own app instance and the real library were not opened by any of it.

**Slice 1 is verifiable without a screen** (AC1–AC12 are service-level or sidecar-level), which is why it went first: at the moment slice 2 started, "a fetch cannot move a field the user set" was already true in the built app.

---

## Rejected and deferred, with the condition that would revive them

- **Storing the overrides in `metadata.json` + a `books` column** — declined by Jason 2026-09-20 for the contract churn. **Revived the moment a second machine edits the same library**, because that is exactly when a machine-local opinion becomes wrong; the move is D1's reversal condition.
- **Raising the learned bias so a resolution wins** — declined: it cannot cover a manual edit at all, and it leaves the decision in a count that unrelated resolutions shift.
- **Auto-expiring a lock after N fetches** — rejected: it would silently undo a decision, which is the failure this feature exists to prevent.
- **Marking inside the sidecar** — rejected: the sidecar cannot see what the user typed; the decision is made before the RPC.
- **Re-proposing a locked field in the queue** (D3's alternative) — deferred; additive as a queue-entry kind if a user ever reports not knowing a source has something better.

## Risks, stated plainly

1. **An override is invisible outside the editor.** Nothing on the card, the detail panel or the conflict queue says "this field is yours". A user who forgets they locked a field sees a fetch that "does nothing to the title" and has to open the editor to find out why. Accepted for this slice; the obvious add is a marker on the detail panel's field rows.
2. **A lock is not portable** (D1). On one machine it is authoritative; across machines it is invisible, so the same field can be moved by the other machine's fetch and then look like a bug here. This is the residual the design does not solve, and it is the reason D1's reversal condition is written down.
3. **The enforcement is split across two languages** (D6) and the two field-name sets have to agree. `MetadataField` is one union, but Python has no type link to it: a rename on one side fails as a silently-unlocked field, not as a build error. The tests in AC9–AC11 are the deciders, and each names its field literally.
4. **Invariants held:** 1 (`metadata.json` canonical) — nothing here changes what is written to it, and the override is deliberately *not* in it; 4 (sort keys) — `sortTitle`/`authorSort` stay derivable and are not lockable; 8 (business logic in services) — the marking and the map live in `services/field-overrides.ts`, and the IPC handlers gain one call each; 12 (failures non-fatal) — a corrupt `field_overrides` value must degrade to "no overrides", never fail a hydration, which is an acceptance criterion in the build.
   **Not touched:** 2, 3, 5, 6, 7, 9, 10, 11.
