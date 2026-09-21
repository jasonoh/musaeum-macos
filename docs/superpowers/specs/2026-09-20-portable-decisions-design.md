# Design: a decision travels with the book — locks, read status, and what a merge owns (metadata + reading, v1)

**Date:** 2026-09-20
**Status:** Proposed — written at Jason's direction for another session to implement. Every fork below is settled except **D3's second clause**, which is marked *open* with a recommendation and one line of his to confirm.
**Scope:** two facts this machine currently keeps to itself — which fields the *user* has claimed, and when the *user* last set a read status — move into the book's own record so the other machine can honour them; and a refresh stops treating "no source supplies this field" as "keep what was there". It does not touch what a lock means for a *value* (that is D1–D6 of `2026-09-20-field-overrides-design.md`, unchanged), and it does not make the merge smarter about *matching* — see *Rejected and deferred*.
**Depends on:** `docs/superpowers/specs/2026-09-20-field-overrides-design.md` (D1's own reversal condition, and D2/D3/D6 which stay as they are), the reading-state policy (`docs/invariants/reader.md`), the catalog ⇄ cache sync (`docs/invariants/nas-and-catalog.md`), the hydration merge (`docs/invariants/metadata-hydration.md`)
**Interacts with:** `metadata.json` — the canonical contract, documented and read by the iOS companion (`docs/data-contracts.md`) — `catalog.json`, the schema (migration 006, after `003_reading_state.sql`), `importer.hydrate`, `library:updateBook`, `metadata:resolveConflict`, `library-sync.preserveLocalReadingState`, `sidecar/pipeline/conflict.py` (see D7)
**Supersedes:** D1 of `2026-09-20-field-overrides-design.md`, **by its own written condition** — "if a second machine ever edits the same library, this becomes `metadata.json` + a `books` column, exactly as `reading_state` (migration 003) already works". Jason confirmed 2026-09-20 that the library is edited from two machines today. D1's note stays in place with a pointer here; its prose is not rewritten.

---

## Why now

The condition was written down before the fact, and the fact arrived: **"I use Musaeum on both machines already."** What that costs, concretely, is that a decision is authoritative on the machine that made it and invisible on the other — so the other machine's fetch moves a field the user has claimed, and the *first* machine then sees its own field change, which is the exact shape of the `Ctprint` incident this feature was built to end (`field-overrides-design.md`, *Why now*).

Three measurements, all taken 2026-09-20, none of them estimates:

1. **The map is real and unpruned.** `app_config.field_overrides` held an id that no `books` row matched, carrying six fields (`author`, `publisher`, `published_date`, `description`, `tags`, `identifiers`) — the override record of a book deleted from the detail panel in the same session. Fixed in the same pass (`pruneDead`, `field-overrides.ts:78`), because a dead id is exactly the garbage a second machine produces every time it deletes a book.
2. **The reading residual is live, not theoretical.** Three books at Reading, two un-marked to Unread: `metadata.json` held `unread` while `catalog.json` held `reading`, and both halves of the reading state share one clock (`reading_updated_at`), so the decision *had* to either keep the local position and take the catalog's status (the bug) or keep the status and hold an older position (the fix that shipped). `read_status_at` is what lets both be right at once.
3. **A refresh's silence is currently permanent.** A field that no source supplies any more — because the matched record changed, or because the file's own metadata was edited outside the app — keeps its stored value forever unless the user blanks it by hand. Measured on the deleted book's record: six fields held, so a fetch could move none of them, and the refresh he ran twice "did nothing" (`field-overrides-design.md`, risk 1).

Thesis: a fact about *this machine's user* is still a fact about *the book*, and the record is the only place both machines read. One sentence for the design: **the user's claims travel inside `metadata.json` with a timestamp each, the read status gets a clock of its own, and the merge — not the stored row — decides which fields have values.**

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| The reversal condition, and the shape it says to move to | `docs/superpowers/specs/2026-09-20-field-overrides-design.md:45`, `:149` |
| The precedent for "a record field + a `books` column, mirrored" — reading state, migration 003 | `electron/main/schema/migrations/003_reading_state.sql` |
| The record field documented for a reader outside this app | `docs/data-contracts.md:48` |
| The vocabulary a lock may name — `HydratedField`, shared by both sides | `src/types/metadata.types.ts:22-38` |
| The one write path for a record: everything a book has, from the `Book` row | `electron/main/services/importer.ts:521-560` |
| The mapping back, with its validators (a hand-edited file must not reach a write) | `electron/main/services/catalog.ts:296-310` |
| The whole-record replace that adoption performs, and its reconcile | `db.ts:477` → `library-sync.ts:130` |
| Which sources answered, and how well they matched — written on every hydrate | `electron/main/services/importer.ts:94`, `:331` |
| The merge's candidate collection and its reviewed/quiet split | `sidecar/pipeline/conflict.py:37-124` |
| A reviewed field queues only when two candidates *differ* | `sidecar/pipeline/conflict.py:74-85` |
| The reading-state clock, and the manual-status stamp added 2026-09-20 | `electron/main/services/reading-state.ts:67`, `db.ts:410` |
| The editor sends only what it changed — the patch *is* the user's diff | `src/components/library/BookEditor.tsx:130-140` |

**Not true today, and inside this feature rather than free:** a lock has no timestamp, so two machines cannot order their opinions (D2); the record has no place for either fact (D1, D4); `preserveLocalReadingState` merges a *record*, not per field, so a status decision and a position decision cannot be judged separately (D5); and nothing in the merge distinguishes "no source had an opinion" from "the matched record says nothing", which is the whole of D6–D7.

---

## D1 — The claims live in the book's record, not in `app_config`

**Decision:** `metadata.json` gains `owned_fields`, and `books` gains a matching column (migration 006). `app_config.field_overrides` is read once at upgrade to seed the records it can still resolve, and is then dead. `catalog.json` carries it like any other record field. The `Book` type gains `ownedFields`.
**Why:** D1's own reversal condition, verbatim: the map's *shape* moves, so the enforcement sites do not change — `importer.hydrate`'s lock list, the reply filter, and the editor's padlock all keep reading the same vocabulary. The alternative (a per-machine "seen" set reconciled between machines) was rejected because the other machine's fetch cannot know what this machine claimed without reading a shared record anyway, and a sidecar file would be a third store beside the canonical one.
**Consequence:** the contract is now the lock's home, so a change to what a lock *means* is a `docs/data-contracts.md` change and an iOS-companion change. The step that cannot be half-done is the upgrade: an unread map is "no locks", never an error (`invariant 12`).

## D2 — A claim is timestamped, and the newer one wins per field

**Decision:** `owned_fields` is a map, `{field: ISO}` — not an array. Reading, writing and the reconcile all treat the *timestamp* as the decision's authority; a release writes nothing and removes the entry, so a release on one machine beats an older claim from the other, while a claim made after that release wins again.
**Why:** without a clock, two machines' edits can only be resolved by "the record wins", which means whichever machine wrote last silently deletes the other's claims — the failure mode the reading reconcile already refuses (`library-sync.ts:114-123`). The alternative — an array plus a per-machine "authoritative writer" rule — needs a machine identity in the record, which the app does not have and does not want.
**Consequence:** `owned_fields` is the second timestamped fact about a book, so the reconcile gains one comparison per field; and a clock skew between machines becomes visible in behaviour (a claim from a machine whose clock is fast wins ties it should not), which is why the *tie* rule must be stated: equal timestamps keep the incoming record's entry, exactly as the reading reconcile does today.

## D3 — What a lock blocks (the value) and what it does not (the absence)

**Decision:** a lock blocks a **value**: a fetch may not write a candidate into a field the user owns, and the merge does not even propose one (D2–D3 of the parent spec, unchanged). A lock does **not** block the *record's* own absence rule from D6: a field that the file's metadata no longer supplies is blanked even when the user owns it — *its value is not retained against a deletion.*
**Why:** the alternative is what the tree does today, and it is how a stale value becomes immortal: the field is held, so nothing may write it, and nothing may blank it either, so the record keeps a value no source supplies any more and the user has to open the editor and blank it by hand. *Open clause:* this is the one decision in this document I could not settle from the tree or from Jason's own words — his rule was *"it should retain those while replacing the blanked-out fields"*, which reads as "locked fields are retained, unsupplied fields are replaced". If he means that a lock **outranks the deletion too**, then D3's second clause inverts and a blanking waits for a release; the sentence to confirm before slice 3 is *"a lock does not protect a field against the file deleting it"*, and the reversal condition is one line from him.
**Consequence:** the editor's padlock means "a fetch cannot change this" and not "this cannot change" — the copy beside the chip has to say so, or the lock will read as a promise it does not keep.

## D4 — Only a run that heard from a source may blank

**Decision:** the absence rule (D6) applies to a refresh whose hydrate reply carries a non-empty `metadata_sources` with at least one *remote* source. A run where every remote fetch failed writes nothing new and blanks nothing.
**Why:** the merge's output is "what the sources said this time", and a network failure says nothing at all — blanking on it would turn a rate-limited Google into data loss on every fetched-only field (a description, an ISBN). `metadata_sources` is already written on every hydrate (`importer.ts:94`, `:331`) and is exactly the record of who answered, so the guard costs no new state. The alternative — trusting the merge unconditionally — is the one shape of this feature that can destroy data silently.
**Consequence:** the guard is per *run*, not per field, so a partial answer still blanks fields that the answering source did not mention. That is deliberate (a matched record that omits a publisher is the record's opinion) and it is the residual this design accepts: see *Risks* 2.

## D5 — The read status gets its own clock, and it travels too

**Decision:** `metadata.json` gains `read_status_at` (ISO), `books` gains a `read_status_at` column, and `preserveLocalReadingState` stops comparing one clock for a record: the position and the status are judged independently — the newer position wins the position, the newer status wins the status — with the existing tie rule (incoming wins on equal or unparseable timestamps) applied per field.
**Why:** this is the residual the shipped fix recorded in `docs/invariants/reader.md` — "the two halves share one clock, so a status decision made here can keep an *older* local position against the catalog's newer one (per-field clocks would need a column of their own)". Two machines make that trade bite in both directions: a status un-marked here and a page turned there are both legitimate, and one clock cannot honour both.
**Consequence:** `db.touchReadingState` (`db.ts:410`) becomes "stamp the status clock" and its docblock's "one clock for reading state" sentence has to change with it; `noteStatusChange` (`reading-state.ts:67`) keeps its role as the only writer of that stamp.

## D6 — Absence is not silence: the merge owns the fields it supplies

**Decision:** a refresh writes the merged result **per field**: a field with candidates takes the winner; a field with **no** candidate is written as blank (null), unless D4's guard fails. Nothing is retained merely because it was in the row before.
**Why:** this is Jason's rule for the driving case: *"if, by using the available fields, supplied or not, but presuming deletions of some sort, the metadata is updated as a result of the new permutation of metadata provided, it should retain those while replacing the blanked-out fields."* The alternative — today's behaviour, where the merge only ever adds or updates — is what makes a wrong value permanent once the source that supplied it stops supplying it: the record keeps a 1990s publish date and a wrong author after the match is corrected, which is precisely what he saw and could not clear. Note what this does *not* change: a field the *file* supplies is always a candidate (the file is a source), so a file's own metadata is never blanked by the rule — only what nothing supplies any more.
**Consequence:** a hydrate's write is now destructive by design, so the guard (D4) and the per-field ACs are load-bearing rather than defensive. It also makes `hydrate` and the *editor* different in kind: the editor writes the user's diff, the fetch writes the record's shape.

## D7 — Where the rule lives, and who proves it

**Decision:** the *decision* per field stays in the merge (Python, `sidecar/pipeline/conflict.py`) because that is where candidates exist; the *blanking* is applied by the main process when it assembles the patch from the reply (`importer.applyHydration`, which already does this for the cover), because the record's shape is the main process's business and the reply is an untrusted input. The sidecar gains one output: the fields it could not supply, so the main process does not re-derive "who has an opinion" from a second source of truth.
**Why:** the alternative — blanking inside the sidecar — would make the Python merge the writer of a `Book`, which it has never been, and would put the record's completeness in a process that cannot see the previous record. The alternative — re-deriving in main from the source dicts — duplicates the vocabulary in a second place, and this repo has already paid for a two-language field-name pair diverging silently (parent spec, risk 3).
**Consequence:** the reply's shape grows a field, so `data-contracts.md`'s sidecar section and the typed reply both move; an older sidecar that omits it must degrade to today's behaviour (add/update only), never to blanking everything.

---

## Acceptance criteria

### Slice 1 — the claim travels

1. Migration 006 applies to a **copy of the live database** (`sqlite3 .backup`, then the migration file), and: `books` row count unchanged, `owned_fields` present and empty for every row, and the statement that used to fail (`SELECT owned_fields FROM books`) now succeeds.
2. `db.updateBook` round-trips `ownedFields`; `metadataJsonToBook` and `writeMetadataJson` carry it; a hand-edited record with a corrupt value degrades to "no locks" and never throws (`invariant 12`).
3. `importer.hydrate` is still passed the same lock list, and the reply filter still drops those fields — asserted by the existing tests staying green *plus* one new case: a lock that arrived **through the record** (not through `app_config`) keeps a fetch off the field.
4. Two isolated profiles (as in `musaeum-app-verification`) pointed at **one scratch library**: an edit in profile A is, after B adopts the catalog, a held field in B — the padlock chip shows it and B's own re-fetch does not move it. This is the instrument the two-machine claim needs; it does not exist yet and slice 1 writes it.
5. A release in B is visible in A after A adopts, with A's value unchanged (D2's "release beats an older claim").
6. `app_config.field_overrides` is read once and never written again; `git diff --quiet` on the file that stops using it is *not* the criterion — the criterion is a test that a pre-upgrade map becomes records on the books it can resolve.

### Slice 2 — the status clock travels

7. `read_status_at` round-trips through the record and the column; `noteStatusChange` stamps it and a patch that restates the row does not.
8. A status decision here plus a newer position from the catalog: **both** survive adoption (the residual `docs/invariants/reader.md` records, decided).
9. A newer status from the catalog beats an older local one; equal-or-unparseable timestamps keep the incoming record (the existing per-record tie rule, now per field).
10. The quit-replay case stays as decided 2026-09-20 (`reading-state.test.ts`'s "does not re-derive the status from a report it replays" stays green).

### Slice 3 — absence is not silence

11. A fixture whose OPF drops `publisher` while the store holds one: after a refresh with a source answering, the stored value is blank; with no remote source answering (D4), it is untouched. Both cases in one test file, one decider each.
12. A field no source has ever supplied is blanked on the same run; a field the *file* still supplies is never blanked by this rule.
13. A locked field is blanked when nothing supplies it (D3 as written) — or not, if D3's open clause inverts; whichever way the confirm lands, the case exists with its name on it.

Numbered continuously so a build report can say "AC1–AC13 hold".

## Slices, and why they are cut this way

**Slice 1 — the claim travels (~9 files imagined; honestly 12+).** New: `electron/main/schema/migrations/006_owned_fields.sql`, the two-profile probe (outside the repo, per the house rule). Edited: `src/types/book.types.ts`, `electron/main/services/db.ts`, `field-overrides.ts`, `importer.ts` (read + write + the upgrade seed), `catalog.ts`, `library-sync.ts` (the seed), `src/types/data-contracts`' doc, `docs/data-contracts.md`. Stops at "the lock is in the record and both machines honour it" — testable at the service level and by the probe, and the editor needs **no** change (it already reads the lock list). The walk the parent spec warns about is where the extra files come from: the type that carries it (write/read/validate), the reconcile that orders it, the migrate path (Calibre import writes records too), and the tests.

**Slice 2 — the status clock (~7 files).** Edited: `db.ts`, `reading-state.ts`, `library-sync.ts` (per-field reconcile), `importer.ts` (`read_status_at` in and out), `catalog.ts`, `docs/invariants/reader.md`, plus tests. Stops before "a reader that advances a manual unread" is revisited — that remains the documented advance rule (`reader.md`, *Known residue*), not this slice's business.

**Slice 3 — absence is not silence (~6 files).** Edited: `sidecar/pipeline/conflict.py`, `sidecar/pipeline/hydration.py` (the reply's new field), `electron/main/services/importer.ts` (apply the blanks), `docs/data-contracts.md` (the reply), plus tests on both sides. Lands **alone** and need not wait for 1 or 2: it is the merge's rule and touches neither the contract nor the schema. Slice 3 is also the one that must not ship before D3's clause is confirmed.

## Rejected and deferred, with the condition that would revive them

- **A per-machine "seen"/"mine" set reconciled between machines** — rejected: the other machine still has to learn what this one claimed, and a merge of two machine-local sets needs a machine identity in the record (D2).
- **Locks in a sidecar file** (`.musaeum/overrides.json` per book) — rejected: a third store beside a canonical one, which `metadata.json`'s invariant exists to prevent; revived only if a lock must carry something the record cannot hold.
- **Blank-on-absence with no guard** — rejected (D4). Revived only if `metadata_sources` stops being written on every hydrate.
- **Applying the absence rule inside the sidecar** — rejected (D7); revived if the main process ever stops assembling the patch.
- **Making the *match* smarter** (the reason the wrong author was fetched at all) — deliberately **not** this design, though it is the driver Jason named: it is a sidecar matching/ranking question with its own evidence (a file with no identifiers, one title+author query, a wrong record accepted at face value), and folding it in would leave both changes unmeasurable. Deferred to its own spec, revived by another wrong match on an identifier-less file.
- **A lock that also protects against deletion** (D3's open clause) — deferred to one line from Jason.

## Risks, stated plainly

1. **The contract change reaches outside this app.** `metadata.json` is documented and read by the iOS companion (`docs/data-contracts.md`); both new fields are additive and optional, so an older reader ignores them, but the *writer* must never emit a malformed one. Mitigation: the validators live in the same place the existing ones do (`catalog.ts`), and AC2 is the decider.
2. **D6 is destructive by design.** A partial answer blanks fields the answering source did not mention; a *wrong* match therefore now clears more of the record than it did before, and a fetch that matches a different book is how the original incident happened. Mitigation: D4's per-run guard, the per-field ACs, and a build-time report that prints the fields blanked (and their previous values) so the blast radius is visible in the build log — not only in the user's surprise.
3. **A mis-lock now travels.** The deleted book's record held six fields after one author edit; if the editor can lock fields the user never touched, portability propagates that mistake to the other machine instead of letting it die here. **This is a gate, not a footnote:** before slice 1 ships, one live probe decides it — open the editor, run a refresh, save only the author, read the record's `owned_fields` back. If it can, fix it in slice 1 (the diff is the user's, so the patch should be re-checked against the row the fetch just moved).
4. **Clock skew between machines** becomes behaviour under D2 and D5 (a machine whose clock is fast wins ties). Accepted: the alternative is a machine identity in the record, and the tie rule keeps the failure bounded to one book's one field.
5. **Invariants held:** 1 (`metadata.json` canonical) — this design moves facts *into* it, which is the invariant's direction of travel; 5 (reading state survives the round trip) — slice 2 is exactly it, judged per field; 8 (business logic in services) — the upgrade seed and the blanking live in services, the handlers gain nothing; 12 (failures non-fatal) — an unreadable map or an older sidecar degrades to no-locks and add-only. **Not touched:** 2, 3, 6, 7, 9, 10, 11.
