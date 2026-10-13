# Plan: highlights and notes — slice 1, the record

**Date:** 2026-10-13
**Slice:** 1 of 2 — the file, its validator, the service, and the contracts. The reader is slice 2 and is not started.
**Annex to:** `docs/superpowers/specs/2026-10-13-annotations-design.md` (D1–D10, AC1–AC11). This document settles **readings** and **wiring**; it re-opens no product decision the spec closed.
**Read first:** the spec's *Implementation routing* block, then `electron/main/services/shelves-file.ts` and `shelves.ts` — this slice is that pair's shape with the cache step removed, and reading them in that order is what makes the new files look like they belong here.

---

## What this slice is

1. A book's highlights and notes become a **file**: `{book}/annotations.json`, versioned, parsed by one total validator that refuses rather than repairs (spec D1, D2).
2. A **service** owns every read and every write of it: the queue, the re-read, the atomic write, the refusal, and the artifact comparison that decides what is stale (spec D6, D7).
3. Four **thin IPC handlers** and the preload surface, so slice 2 has something to call and nothing to invent.
4. **Nothing else.** No reader file, no palette role, no component, no sidecar method, no migration, no `metadata.json`/`catalog.json` member, no wire change. Every acceptance criterion below is a case, and none of them needs a browser — which is why the cut is here.

## Readings this slice settles

The spec decided the product questions; these are the ones it left to the implementation, each taken with the alternative it beat and the condition that would reverse it.

**R1 — every mutation answers with the file's whole annotation list, and the renderer takes its state from that answer.** `create`, `update` and `remove` each return `Annotation[]` — the list as the file now holds it, assembled from what was just written. *Alternative beaten:* returning the one annotation that changed, or nothing, and letting the renderer append/patch locally. It loses because the write **re-reads the file** (spec D7): the file may already hold annotations this process has never seen, so a local append can show a list the file does not agree with — and the failure is invisible, because the panel would look right until the next open. *Reversal:* a book whose list is large enough that the round trip is felt on every note keystroke-save (a measured list over ~200 annotations), at which point the write answers with a diff rather than a list.
*Slice 1 decides the service half only, and says so rather than implying more:* "the renderer takes its state from that answer" is a rule for slice 2, and no case here could decide it — there is no renderer in this slice. What the cases decide is the answer itself: that it holds the file's whole list, that it is what the file now holds rather than a local append, and (from the build) that the created record travels with it, because the id is minted in main and a caller cannot look up an annotation it was never told the name of.

**R2 — the artifact identity is a digest of the reflow stamp *whole*, not its `converter` alone.** A derived annotation's `artifact.stamp` is a SHA-256 digest of `{book}/derived/reflow.json` — every member the pass wrote, canonicalized by sorting keys at every level — and a source annotation's is `null`. *Alternative beaten:* the converter triple (`generator=…,helper=…,sidecar=4`), which is what this reading settled before the slice review measured it. It loses because the pass's own cache condition compares **three** terms — the converter triple *and* the source's recorded `size` and `mtime` (`sidecar/reflow/produce.py:137-141`; `docs/data-contracts.md` states the same three) — so a PDF replaced in place under an unchanged converter **re-runs the pass and rewrites the artifact** while a converter-only comparison calls it the same one, and the stored `cfi` is then drawn into a document whose numbering it no longer indexes. That is precisely the silent mis-draw D6 exists to prevent, and the review reproduced both halves of it: `stamp_is_current` answers `False` for a moved mtime with an identical converter, and the service answered `stale: false` for the same stamp. A digest *over every member* rather than a mirror of those three terms, because a mirror goes stale in the **fresh** direction the day the sidecar's condition gains a fourth term — and that error has no symptom — while the digest costs one hash per call and cannot fall behind. The three terms are still *checked* before anything is hashed: a stamp the pass's own condition would reject is an identity this build cannot establish (R6) rather than a stable digest of nonsense, and a future sidecar that describes its source differently lands in the safe direction, with every derived annotation reading stale and listed. *Reversal:* the artifact carrying its own identity (an id inside `reflow.epub`) — then the stamp stops being the thing compared, and this becomes a stored id.

**R3 — `list` answers a discriminated state, and only the mutation paths refuse.** `list(bookId, format)` resolves `{ state: 'ok' | 'missing' | 'unreadable'; annotations: Annotation[] }`; `create`/`update`/`remove` reject with the named refusal when the file exists and cannot be read. *Alternative beaten:* `list` returning `[]` on any failure. It loses because **an empty list and an unreadable file are different sentences** and only the state can tell them apart — the panel says "your notes are still on disk, they just could not be read" for one and nothing for the other, and a `[]` would make the reader quietly claim the person never wrote a note. The read path also does not throw for a *missing* file: a book nobody has annotated is not an error (spec AC5). *Reversal:* a caller that cannot render the state — then the state is folded into an error, never into an empty list.

**R4 — a note is stored trimmed at its ends and otherwise verbatim, and a blank note is `null`.** Internal newlines and spacing are preserved; only the leading and trailing whitespace goes; a note that is empty or whitespace-only after trimming is stored as `null`, which is the "keep the highlight, drop the note" gesture, and it is **not** an error. *Alternative beaten:* normalizing the note the way the quote is normalized (`search.js:4`'s whitespace collapse). It loses because a note is prose a person typed and collapsing its line structure rewrites their paragraphs; the quote is normalized because it is compared and re-anchored, and the note is never either. *Reversal:* a note that needs re-anchoring or comparing — then it needs a normalized twin, and the normalized form is a stored field rather than a rewrite of the author's text.

**R5 — the renderer cannot see or send the artifact, and cannot supply an id or a timestamp.** `NewAnnotationInput` carries the book, the format, the locator and the color. The id, `type`, both timestamps and `artifact` are the service's; the bridge shape `Annotation` omits `artifact` entirely and carries `stale` in its place. *Alternative beaten:* a bridge shape that mirrors the stored record field for field. It loses twice: an id from the renderer makes uniqueness a claim the file's writer cannot check, and an `artifact` on the bridge is the renderer being told a `derived/` fact — the rule `docs/invariants/reader.md:20` states for the reader (D10 of the reflow spec), enforced here by a type rather than by a convention. *Reversal:* a second surface that needs to display which rendering an annotation came from — then `artifact` crosses as a token, and `stale` stops being the only thing it knows.

**R6 — when the stamp cannot be read *or* cannot be used, a derived annotation is stale; when it can, a mismatch is stale; a source annotation is never stale here.** The comparison is conservative in the only direction that is safe: an artifact whose identity cannot be *established* is treated as different from the one the CFI points into. "Cannot be used" is part of that, and the build had to say so: a stamp that is valid JSON but not a stamp the pass's own condition would accept — a `converter` that is not a record, a missing `source` term, a missing `version` — is digested to *nothing* rather than to a stable digest of nonsense, because a stable digest of an artifact that cannot exist is the same mis-draw arriving by the other door. Such a stamp is also never **minted**: an annotation created while the stamp is unusable records `stamp: null`, so it is stale from the moment it exists. *Alternative beaten:* treating an unreadable stamp as a match, on the grounds that a re-run at the same version is byte-identical (`docs/invariants/reader.md:25`'s reproducibility bar). It loses because a *missing* stamp is exactly the state in which the version is unknown, not a state in which it is known to be equal — and the cost of the conservative answer is one panel row that says "not drawn", while the cost of the other is a highlight over the wrong sentence (spec D6). *Reversal:* the artifact itself carrying the version — then a missing stamp stops meaning "unknown", because the answer is in the file being served.

**R7 — the mutation queue is one queue for the process, not one per book.** *Alternative beaten:* keying the queue by `bookId`. It loses because the operations are a few hundred bytes and per-book keying adds a map to maintain, to reap and to test, for a case — two books' annotation writes interleaving — whose worst outcome is one extra SMB round trip. *Reversal:* a measured wait. If a large book's write ever blocks another book's open, the queue is keyed by book and the reaping rule is written with it. *The alternative needed its own decider, and end state cannot be it:* a per-book queue reaches the same file contents in every case above, so the reading was undecided by the suite until the build added a case that watches the **timeline** — each book's scratch write and its rename are contiguous, never interleaved with the other book's (`annotations.test.ts`, "closes one mutation before the next begins, whatever book it touches").

**R8 — an unreadable file is reported once a session, and the report comes back when a read succeeds.** `warnUnreadable` holds one module-level flag; a read that reaches any state clears it, and a test-only reset is exported for the flag's carry-over between cases (`resetAnnotationLogForTests`, as `shelves.ts:295-298` exports its own for the same reason). *Alternative beaten:* warning on every failed read, which is what the service did before the review measured it. It loses because the rule has to survive the panel's shape: the reader lists on open and after every mutation, so a file that stays unreadable would print the same bytes on every refresh and the log would stop being a signal. *Reversal:* a per-book or per-cause log — if two books' files break in one session and one line is not enough to say which.

## Files

**New — 7 source files:**

| File | What it carries |
| --- | --- |
| `src/types/annotation.types.ts` | Both halves, as `shelf.types.ts` does: the **stored** file (snake_case, canonical) and the **bridge** shape (camelCase, `stale` instead of `artifact`, no `book_id`), plus `NewAnnotationInput` and the read state R3 settles. Its `format` members are the `ReaderFormat` union rather than `string` — the review's finding that the one untyped door was the one that persists. |
| `electron/main/services/annotations-file.ts` | The file and nothing else: the name, the version, `annotationsPath`, `emptyAnnotationsFile`, the **total** parser, and the atomic write through a `randomUUID()` scratch name. No queue, no NAS check, no book lookup — `shelves-file.ts`'s split exactly. |
| `electron/main/services/annotations.ts` | The service: `list` / `create` / `update` / `remove`, the one queue, the re-read, the refusals, the one-log rule (R8), the note and percent normalization (R4), the id and timestamp minting (R5), and `artifactFor` — the stamp digest of R2 and the staleness rule of R6. |
| `electron/main/ipc/annotations.ts` | Four handlers, thin by invariant 8, each one call into the service; every channel carries the `ReaderFormat` the reader has open. |
| `electron/main/index.ts` | One import, one `registerAnnotationHandlers()` call. |
| `electron/preload/index.ts`, `src/types/api.types.ts` | The surface and its type. |

**New — 2 test files:** `electron/main/services/annotations-file.test.ts` (the parser's refusal table, as `shelves-file.test.ts` has, plus the round trip, the scratch-file cleanup and the ENOENT-vs-I/O split) and `electron/main/services/annotations.test.ts` (the service: the round trip, the re-read, the refusal, the notes, and the artifact/stale cases).

**Extended — 4 existing test files:** `book-files.test.ts` (the seed gains `annotations.json`, plus a `computeFileSizeBytes` case — that file had none), `book-delete.test.ts` (the seeded file goes with the book, and survives a partial delete), `library-sync.test.ts` (an adoption and a rebuild leave it byte-identical), `test/invariants.test.ts` (the one-reader walk, AC8 — now two-sided: the literal is spelled by exactly one module, and only the service imports the module that spells it).

**Extended — 3 documents, where the routing block named two.** `docs/invariants/nas-and-catalog.md`'s layout block and `docs/invariants/files-and-deletion.md`'s folder-rules paragraph are the two the routing names, and they were edited in this slice as it says. The third is `docs/data-contracts.md`, which the routing does **not** name: a canonical file's contents belong in the document that already holds `metadata.json`'s and `shelves.json`'s, and leaving it out would put the only description of what `annotations.json` holds inside a spec. Recorded here as a deviation rather than made silently.

**Deliberately untouched:** everything under `sidecar/`, `vendor/`, `src/components/`, `src/lib/`, `docs/rest-api.md`, `electron/main/services/api/`, and the wire.

## Acceptance criteria, each with its decider

| AC | Criterion | Decider |
| --- | --- | --- |
| 1 | A highlight round-trips; the written bytes parse independently | `annotations.test.ts` — a plain `JSON.parse` of `readFile`'s bytes, then the same object through `list`; the parser's own round trip is `annotations-file.test.ts` |
| 2 | `renameToTitle` renames the format files and leaves this one; the returned count is 2 | `book-files.test.ts`, seed extended |
| 2b | `computeFileSizeBytes` sums the format files only | `book-files.test.ts` (a new case — no such case existed) |
| 3 | `deleteBook` takes the folder and the file with it | `book-delete.test.ts`, the folder assertion extended — **entailed** by that assertion (the file is inside the folder), so the discriminating half is the *partial* delete, which leaves it |
| 4 | An unreadable file is never overwritten: the refusal, and the bytes byte-identical after | `annotations.test.ts`, two `readFile` buffers compared |
| 5 | A book with no file answers `missing` and creates nothing | `annotations.test.ts` — `readdir` before and after |
| 6 | The write re-reads: an annotation written on disk between two creates survives the second | `annotations.test.ts` |
| 7 | `create` with `format: 'reflow'` records a digest of the stamp **whole**; a moved converter *or* a moved source marks those stale, never a source one, and a stamp the pass could not use records no identity at all | `annotations.test.ts`, against a `derived/reflow.json` fixture (5 moved stamps, 4 unusable ones, and one annotation minted against an unusable stamp) |
| 8 | `annotations.json` is spelled by exactly one module, and imported only by the service (comments stripped, trailing ones included) | `test/invariants.test.ts`, over the existing `sources()` walk — **rewritten in the build**: the literal half alone let a second reader through `annotationsPath()` |
| 9 | An adoption leaves the file byte-identical | `library-sync.test.ts` — and mutated in the campaign (writing the file from the rebuild walk reddens it, 5 of 44) |
| 10 | No IPC handler does file work | `test/invariants.test.ts:65` — **inherited, unchanged**; named so its green is not read as this slice's. It decides a *literal-import* proxy (`from 'fs'`/`'path'`/`'child_process'`), not the criterion's full claim: `node:path`, a `require`, or `shell.openPath` inside a handler would pass it. No handler does any of those today |
| 11 | `missing` ≠ `unreadable` ≠ `[]`; a failed read is not an empty list | `annotations-file.test.ts` + `annotations.test.ts` |
| R1–R8 | Each reading above | `annotations.test.ts` (R1, R4, R5, R6, R7, R8), `annotations-file.test.ts` (R3) |

## What must not move

- `npm test`'s count is expected to **rise by the new cases and nothing else**, and `pytest` to stay at **413** — no Python file is touched, and that is the check on the boundary rather than a hope.
- `metadata.json`, `catalog.json`, the SQLite schema, and every payload in `docs/rest-api.md` are byte-identical in shape. A diff touching `importer.writeMetadataJson`, `catalog.ts`, or `services/api/shape.ts` is a slice that has gone wrong.
- `book-files.ts`, `book-delete.ts`, `catalog.ts`, `library-sync.ts`, and `book-bytes.ts` take **no edit**: this slice adds cases that pin their existing behaviour, and a change to any of them means the pin found a real defect, which is a finding to report rather than to fix inside this slice.

## Verification plan

1. `npm run typecheck && npm run lint && npm test` and `sidecar/.venv/bin/python -m pytest sidecar/tests -q`.
2. A mutation campaign over the deciders that have one: the parser's version check, its per-member checks, the percent range, the `ENOENT`-vs-I/O split, the re-read, the `ENOENT`-means-empty rule, and the staleness comparison each get a mutation and a named test that must redden.
3. The pins (AC2, 2b, 3, 9) are behavioural cases over existing code, so their mutants live in **the pinned files**, not in this slice's — those mutants are run and reported, and a survivor there is a **finding about the pin**, to be reported rather than repaired here.

## Start here

```bash
git log --oneline -3          # slice 1's commits: docs (the spec + this annex), then the feature
npm run typecheck && npm run lint && npm test   # 0, 0, 2084 passed (96 files) — after slice 1
sidecar/.venv/bin/python -m pytest sidecar/tests -q   # 413 passed, changed by nothing in this slice
```

Read, in this order: `electron/main/services/shelves-file.ts` (the file layer to copy, including the refusal-over-repair comment), `electron/main/services/shelves.ts:15-99` (the mutation shape, whose **re-read** is this slice's whole reason for R1), `test/invariants.test.ts:26-56` (the walk AC8 joins, and its comment-skip rule), and `test/helpers/book.ts` (`makeBook`'s `nasPath` is `books/<id>`, which is how a service test reaches a real folder).

---

## Built — slice 1, 2026-10-13

**Gates, all green, and the boundary held:** `npm run typecheck` **0**; `npm run lint` **0** (the `.delta/` red the spec's ledger recorded was fixed first, as its own commit — `lint: ignore .delta/`); `npm test` **96 files, 2084 passed, 0 failed** (baseline 2012 — **+72**); `sidecar/.venv/bin/python -m pytest sidecar/tests -q` **413 passed**, unchanged, with no file under `sidecar/` touched.

**The campaign: 26 deciders, 26 killed, 0 survived**, in one artifact (`annotations-slice1-campaign-merged.json`, outside the repo), every mutant restored by hash. Three rows need their shape said out loud rather than counted:

- Two are **blunt** rather than isolated — the "an entry of a foreign type is carried" inversion (16 of 34 red) and the "re-read" removal (14 of 35) — because each reddens the whole family its mechanism serves. They are legitimate kills and they are not per-case coverage.
- One was **wrong on its first aim**: removing the queue by rewriting `return enqueue(async () => {` leaves the arrow uncalled, so 23 cases fell for a reason unrelated to serialization. Pointed at the queue itself (`const next = queue.then(fn, fn)` → `const next = fn()`), it kills exactly the two cases that decide R7.
- One **survived** its first aim (the stamp's `version` check) because the case's unusable stamp was unusable for a second reason. The case was corrected to a stamp unusable *only* by the version rule, and it then killed.

**Defects the cases caught during the build:** `converterToken` treated an array as a record — `Object.entries` numbered its indices, so a converter that was a list compared as `0=4,1=1`; refused now. `create` answered with the list but not the record, leaving a caller no way to learn the id main had minted; R1 was refined to answer both.

**Defects the slice review caught after the build** (two independent reviewers: one adversarial read of the code, one audit of the criteria's deciders):

1. **The stale rule compared one term of three.** `isStale` compared the converter triple, while the pass's own cache condition compares the converter *and* the source's recorded `size` and `mtime` (`sidecar/reflow/produce.py:137-141`) — so a PDF replaced in place re-ran the pass and rewrote the artifact while the app called the old `cfi` fresh: the silent mis-draw D6 exists to prevent. Reproduced from both halves (the sidecar's `stamp_is_current` answering `False` for a moved mtime with an identical converter, and the service answering `stale: false` for the same stamp). **Fixed** by digesting the stamp whole, with the three terms still checked so an unusable stamp is an unknown identity rather than a stable digest of nonsense (R2, R6) — five new cases, two campaign rows.
2. **`create`'s `format` was the one untyped door** — `string`, while the other three channels took `ReaderFormat`, and `artifactFor` stored whatever arrived verbatim, so the loosest input was the one that persisted. **Fixed**: the union is the type at every door, the parser refuses a stored format the app cannot open, and the handler signatures carry it too.
3. **The one-reader walk could not see a second reader.** It matched the literal only, so a badge or an exporter calling `annotationsPath()` — which needs no literal — would have passed; and it reddened on a *reworded user-facing sentence*, because the refusal message spelled the file name. **Fixed**: exactly one module may spell it, no module but the service may import it, and the refusal sentence no longer names the file.
4. **The precedent's log-once rule had been dropped.** `shelves.ts` reports an unreadable canonical file once a session; this service warned on every failed read, and the panel reads on open and after every mutation. **Fixed** (R8), with its decider and the test-only reset the precedent carries too.
5. **Two invariant docs sat in no slice.** The routing assigns them to "the slice that lands it", while this annex listed them as deliberately untouched and called them slice-landing work — so the doc update was owned by nobody. **Fixed**: both were edited here, plus `docs/data-contracts.md`, which the routing did not name and which is the only other place a canonical file's shape is described (recorded as a deviation in *Files* above).
6. **One thing the review could not break, and that is the point of the slice:** the folder-rules thesis. Fifteen sites that touch a book folder were enumerated and read; every one keys on a format extension or a fixed name, so the file is skipped by the renames, never counted into `file_size_bytes`, never served, and taken only with the folder (D4).

**What the build settled beyond R2/R6/R7/R8:** the artifact member is named `stamp` now that it carries a digest rather than a token; the parser validates `format` against the union with a `Record<ReaderFormat, true>`, so a new format is a `typecheck` failure there until it is named; and the walk's comment skip had to cover *trailing* comments, which the first version did not.

**Still not verified:** the file's real size and latency over the share — the two numbers D1's reversal condition names (`50 ms`, `256 KB`) are read off the shape, never measured, because slice 1 is offline-testable by design; they want the live pass slice 2's reader makes. And AC10's second half stays a proxy (see its row).
