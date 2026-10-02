# Phone upload — slice 2: the route and the contract

**Date:** 2026-09-23
**Slice:** 2 of 3 — the route and the contract (AC8–AC15)
**Annex to:** `docs/superpowers/specs/2026-09-23-phone-upload-design.md`
**Read first:** the spec's _D1_, _D5_, _D6_, _D7_ and the Slice 2 acceptance criteria; slice 1's annex (`docs/superpowers/plans/2026-09-23-phone-upload-slice1.md`) for the readings this one inherits — they are settled and are **not** re-opened here. Slice 1 landed 2026-09-23 in **`dc89414`** (its record in `d12c859`); the numbers below are that tree's, whose baseline was `3e4696a`.

---

## What this slice is

One new write on the wire, and everything that has to move with it:

1. `POST /api/books?format=<f>&filename=<n>` — matched on the **bare** path, with the file's bytes as the raw body, answered `201` with the `import` payload (spec D1, D6; AC8).
2. The refusal vocabulary the route owns: `400` before a byte is written (AC9), `401` with `WWW-Authenticate` and a uniform `404` for every other method (AC10), `503 offline` (AC11), `503 busy` with `Retry-After: 1` from the existing transfer gate (AC12), and the **new `413`** past 1 GiB (D4).
3. The contract, in three artifacts that cannot be separated (D7, AC13–AC15): `docs/rest-api.md`'s new route section and its `json payload=import` block, the golden `shape.test.ts` parses out of that block, and the executable half in `scripts/api-smoke.sh` — plus the one-line corrections to this document's _Not in this version_ and to the iOS companion spec's **Scope**.

It is the smallest unit that can carry a route onto the wire, which is why the phone is not in it: the client is written against the landed document, in its own repo.

---

## Readings this slice inherits (settled — do not re-derive, do not re-test)

| Reading                                                                                                                | Settled by                                             | Where                                         |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| The cap (**1 GiB**) and the stall clock (**30 s**, a _stall_ clock reset by every chunk)                               | slice 1, R1's measured worst inter-chunk gap (99.7 ms) | `services/api/upload.ts:41`, `:64`            |
| The bytes land in `{userData}/uploads/{uuid}/{safe basename}` — uniqueness in the directory, the basename the client's | slice 1, S1                                            | `safeFileName`, `uploadScratchDir`            |
| A refusal at the cap resolves **at the breach** while the body keeps draining, not at `end`                            | slice 1, S2                                            | `writeBody`                                   |
| The gate's context reaches the client through the **result**, never a progress event                                   | slice 1, S3                                            | `ImportResult.duplicate`                      |
| The share is checked **before** the body is read — and again after a failed import                                     | slice 1, S4 + the review's ninth finding               | `receiveUpload`                               |
| The outcome's refusal vocabulary and what each maps to                                                                 | slice 1                                                | `UploadRefusal`                               |
| An `internal` refusal's `message` is the filesystem's own and carries this machine's paths                             | slice 1's second review                                | `upload.test.ts` / the spec's _Built_ section |

The mapping, stated once so the route is a lookup and not a judgement: `bad-request` → **400**, `too-large` → **413**, `stalled` → **400** (the reading route already calls a body that never finished arriving a 400), `offline` → **503 `library offline`** with `Retry-After: 5`, `internal` → **500 `internal`** — and **the `message` field stays in the log**. It carries an absolute path from this machine; the wire gets the fixed word, never the string.

---

## Readings this slice must settle itself, each with the alternative it beats

### S5 — what the client actually sees when a body is refused mid-flight

Slice 1's S2 fixed _where_ the refusal resolves (at the breach) and left this open on purpose: whether a `413` sent while the client is still writing its body is ever **read** by that client, or arrives as a reset, is a socket question no socketless case can decide. It is AC9/AC12's instrument — a real connection on an ephemeral port — and it is this slice's first measurement.

**The alternatives:** (a) answer at the breach and trust the client to read it; (b) drain to the end and _then_ answer, priced as a wait on bytes that are already refused — for a 1 GiB-plus body, minutes of a phone's battery spent uploading something the Mac has already thrown away. **Slice 1 chose (a)**; this slice measures whether (a) holds, and the reversal condition is a `curl --data-binary` that never sees the `413`. The fallback is not a redesign: it is the same `finish` called on `end` instead of on the breach.

### S6 — whether the collection path answers `HEAD`

The router's own sentence says the JSON routes answer `HEAD` (a `HEAD` is a `GET` with no body). This route takes a body, so a `HEAD /api/books` has nothing to answer with beyond its status. **The alternatives:** answer `405`-shaped (which this API does not speak — a known path with the wrong method is already a uniform `404`, D11), or leave the bare path out of the `HEAD` allowlist and let the policy's existing `404` cover it. **Recommendation: the latter** — one policy rule, no new status, and AC10's "every other method answers `404` uniformly" then holds for `HEAD` too. It is a decision rather than a measurement, and reversing it is one line in the allowlist.

### S7 — the book in the `import` payload is the row as the import returns it

D6 fixes the payload as **pre-hydration** — `importOne` inserts, then hydrates without awaiting. So the route reads the row after `addFiles` resolves and reports what it finds: embedded metadata, `seriesName: null`. **The alternative:** await the hydration (≤5 s by the performance target, and this route holds a transfer slot for its duration) so the phone's first look at the book is the settled one. Rejected: it makes the client wait on a network fetch, and the Mac's own contract with itself has always been "the book is in the library from this moment". **Reversal:** a phone UI that looks wrong until the next list fetch — the payload shape does not change either way, which is what makes the reversal cheap.

### S8 — the `413` word, and why it is not `badRequest`

D4 adds a status this contract has never carried, so it adds a word: `API_ERRORS` (`services/api/shape.ts:46-61`) gains one key beside the seven, `ApiError` widens, and the document's errors table gains its row. **The alternative:** answer `400 bad request` for an oversized body — rejected because `400` is defined as _a request the route cannot make sense of_, and an oversized body is a **limit**, which is a different sentence for the client and a different retry decision for a person. Note that `ApiError`'s new key does **not** disturb `REFUSAL_WORDS` (`services/api/routes.ts:91-94`), which is a `Record` over the _resolver's_ statuses and knows only 400/404.

### S9 — what the smoke script's upload check uploads, and against what

AC14 needs a real book to cross a real socket. **The alternatives:** a synthetic EPUB built in the script (no fixture to keep), or a small real book copied from the library (bytes nobody can synthesise — a real `mimetype` entry first, a real `container.xml`). **Recommendation: synthetic, and small** — the check's job is the _route_, not the parser, and a generated file is a fixture the script owns rather than one it borrows from the library. What is _not_ negotiable is the precondition: the script reads the token and port from a profile's own database and **exits** rather than defaulting to the real one, so this check must run on an isolated profile and must not be the thing that relaxes that rule.

---

## Files

| File                                                                 | What                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `electron/main/api/rest.ts` (edited)                                 | the route arm, the transfer gate around the body, and a third seam beside `transfer`/`bodyTimeoutMs` so a case decides the cap and the stall without a slow disk or a ten-second wait                              |
| `electron/main/services/api/routes.ts` (edited)                      | a matcher for the bare collection path — `BOOKS_PREFIX`'s trailing slash (`:30`) is exactly what keeps it out of `matchBookPath` today, and `BookPath`'s `{ id, resource }` shape has no room for "the collection" |
| `electron/main/services/api/shape.ts` (edited)                       | `importPayload`, and the `413` word in `API_ERRORS`                                                                                                                                                                |
| `electron/main/services/api/shape.test.ts` (edited)                  | AC19's case, **extended** — the same case that parses every `json payload=` block, not a parallel one                                                                                                              |
| `electron/main/api/upload.test.ts` (new)                             | the socket-level cases: AC8–AC12 on a real connection, ephemeral port, the instrument the 401 and byte routes already use                                                                                          |
| `docs/rest-api.md` (edited)                                          | the `## POST /api/books` section, the `json payload=import` block, the `413` row, and the _Not in this version_ correction                                                                                         |
| `scripts/api-smoke.sh` (edited)                                      | upload a book, then find it by id on `GET /api/books/{id}`                                                                                                                                                         |
| `docs/superpowers/specs/2026-09-22-ios-companion-design.md` (edited) | its **Scope** sentence reversed in place, naming what it used to say (AC15)                                                                                                                                        |

**Eight files, and the row's ~7 is the optimistic count** — the eighth is the companion spec's Scope line, which the spec's own D7 and AC15 require in this slice. Inside the bound; no migration, no schema change, no `app_config` key, no new dependency, and nothing in the renderer.

## What must not move

- `readJsonBody`, `MAX_BODY_BYTES` (4096), `BODY_TIMEOUT_MS` (10 000) — the upload's body handler is its own function and its own bounds (slice 1's D4 decision).
- The **two-transfer budget** and its `503 busy` + `Retry-After: 1` (D5): an upload takes a slot and contends with a download.
- The method policy's uniform `404` for a known path with the wrong method (D11), and `apiVersion` at **1** (D7 — routes are additive; the version tracks payloads).
- `imports/` and `services/file-watcher.ts` (D2), and invariant 8: the route is a thin arm over `services/api/upload.ts` and `importer`, with no logic of its own.

## Acceptance criteria, each with its decider

| AC  | Decided by                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------- |
| 8   | a real socket on an ephemeral port: real EPUB bytes → `201`, then `GET /api/books/{id}` → `200` for the returned id           |
| 9   | a missing or unknown `format`, and a missing `filename` → `400`, asserted by the scratch directory being **empty** afterwards |
| 10  | no token → `401` with `WWW-Authenticate`; every other method on the path → `404` uniformly                                    |
| 11  | share unmounted → `503 {"error":"library offline"}` with `Retry-After: 5`, scratch empty                                      |
| 12  | both transfer slots held → `503 {"error":"busy"}` with `Retry-After: 1`                                                       |
| 13  | the same `shape.test.ts` AC19 case, extended to the `import` payload — and only payloads the shaper builds                    |
| 14  | `scripts/api-smoke.sh` uploads a book and finds it by id, end to end, on an isolated profile                                  |
| 15  | the two Scope sentences corrected in place, each naming what it used to say and why it changed                                |

## Verification plan

Gates: `npm run typecheck`, `npm run lint`, `npx prettier --check` on the touched files, `npm test` (**1379 in 58 files** as `dc89414` left it, plus this slice's cases), `bash -n scripts/api-smoke.sh`, and the smoke script itself against a live app on an **isolated profile**. Then the mutation campaign over this slice's deciders — one mutant per half of any paired assertion (the `401` and its `WWW-Authenticate` header are two claims; `503 busy` and its `Retry-After` are two), run with `scripts/mutation-campaign.py` from the `musaeum-slice-workflow` skill.

**The harness slice 1 did not need:** a live server needs a profile with `rest_api_enabled` on and a token, and the smoke script refuses to run without an isolated one. Slice 2's first act is to stand that profile up and name it in this annex's results table — value, instrument, and the pre-fix value beside it — so the next session re-runs rather than rebuilds.

## Start here

```bash
git log --oneline -3
npm run typecheck && npm run lint && npx prettier --check electron/main/api/rest.ts electron/main/services/api/routes.ts electron/main/services/api/shape.ts
npm test                      # expect 1379 in 58 files, plus this slice's cases
bash -n scripts/api-smoke.sh
```

Read, in order: `electron/main/api/rest.ts` — the routing switch and its method policy, the transfer gate, `sendBytes`, and the `ServerOptions` seams this slice extends with a third; `electron/main/services/api/upload.ts` — the module the route maps to statuses, and the only place the refusal reasons are defined; `electron/main/services/api/routes.ts` — why the bare path is invisible today (`:30`, `:66`); then `docs/rest-api.md`'s route table, errors table and _Not in this version_, the three places the document moves.

---

## Built (2026-09-23)

Landed as one working-tree change, at the eight files the table above names — the annex's count held (the roadmap row's ~7 stayed the optimistic one). Gates on the final tree: `typecheck` 0 / `lint` 0 / `prettier --check` clean on **all eight touched files, the document included** (the first pass checked only the code and missed `docs/rest-api.md` — see the review round below) / `bash -n scripts/api-smoke.sh` ok / **`npm test` 1408 passed in 59 files, 0 failed** — from **1379 in 58** as `dc89414` left it, so **+29 cases and one new file** (`electron/main/api/upload.test.ts`, 17 of them, one of those an `it.each` over the method policy). **The markdown half of that gate, measured rather than assumed:** this annex was 14 hunks dirtier than its committed copy and has been `prettier --write`'d in full (its words provably unchanged — identical after normalising whitespace, dashes and emphasis markers); the contract document was clean at `HEAD` and is clean again; `CHANGELOG.md`, `tasks.md` and the two specs this slice edits are **not** prettier-clean at `HEAD` either and were deliberately left alone — the hunk counts are unchanged by this slice (48/48, 5/5, 30/30), so nothing here added drift, and a repo-wide formatting pass is not this slice's business. `apiVersion` stays **1**, no migration, no `app_config` key, no new dependency, nothing in the renderer.

### S5 — the `413` _is_ read by a client that is still sending (option (a) holds; the fallback is not built)

The annex left this open with a stated fallback. Measured on a real socket with the cap dropped through the new seam (`upload: { maxBytes: 64 KiB }`) and a **declared** body of 8 MiB: the `413 content too large` arrived, and the client read it after sending **less than a quarter of the bytes it had declared**. That last clause is the whole measurement — it is an assertion (`sent < declared / 4`, `electron/main/api/upload.test.ts:588`) built to separate the two readings, because a handler that drained to `end` — the alternative S2 priced — could only answer once all 8 MiB had crossed. The refusal also keeps nothing: the scratch directory is asserted empty and no row exists. **The fallback is not needed and is not in the tree**, and the instrument is a case rather than a transcript, which is what makes it a decider.

### S6 — the collection does not answer `HEAD` (the policy's uniform `404`, as recommended)

`GET`/`HEAD`/`PUT`/`DELETE` on the bare path fall through to the same `404 not found` every other method gets, asserted as one parameterised case (`upload.test.ts:396`) with the `401` + `WWW-Authenticate` half beside it in the same table. One policy rule, no new status, reversal one line — as the annex predicted.

### S7 — pre-hydration, as recorded, and it has **no case of its own**, deliberately

The payload is built from the row `addFiles` resolved, so it carries embedded metadata and `seriesName: null`. **This is a recorded decision, not a measurement** — the payload's _shape_ is what a case could pin and the shape is identical either way, which is exactly the cheapness the annex's reversal condition leans on. What nothing here asserts is that the hydration then completes; that is the Mac's own import path and its own cases.

### S8 — the `413` word is `content too large`, declared once and read in three places

`API_ERRORS.tooLarge` (`services/api/shape.ts:61`), the document's errors-table row, and the golden `shape.test.ts` parses _out of that document_ — one declaration with three readers. The campaign therefore mutated all three faces of it (the word, the route's status for it, and the document's own `matchType` key) and killed each.

### S9 — synthetic, small, and **past a kilobyte** — which turned out to be a finding, not a detail

The script builds its own EPUB with `zip -0` (a stored, uncompressed `mimetype` first — that is the format, not a preference) and the first fixture was ~900 bytes. **That broke a section of the script this slice did not otherwise touch:** the download section picks the _smallest_ book in the library and its resumed-download check asked for `bytes=0-1023` unconditionally, so as soon as the upload had put a sub-kilobyte book in the library the check read `bytes 0-891/892` against an expectation of `bytes 0-1023/892` — **two reds in a healthy server**, and the first evidence that the fixture was load-bearing. Both halves are repaired: the fixture is a real EPUB with a chapter (~1.4 KB, titled by its own `dc:title`), and the range check is now **clamped to the file** (`RANGE_END = min(1024, LENGTH) - 1`, with a `note` when it bites) so the script holds over any library — including the one this slice's own upload section can now create.

### The harness this slice stood up (slice 1 needed none)

| Value                                                                                        | Instrument                                                                                               | Pre-fix value                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **70 passed, 0 failed** — the script as a whole; 14 of those checks are the upload section's | `MUSAEUM_USER_DATA=<profile> bash scripts/api-smoke.sh` against a real app on the isolated profile below | **59 passed, 9 failed** — the identical script, profile and library against a build of **`dc89414`**: all nine failures in the upload section, every one `404 not found`, the uniform unknown-path answer this route replaced |

**The profile, and the state it starts in** — so the next session re-runs rather than rebuilds: `~/.hermes/profiles/dev/cache/scratch/phone-upload-slice2/profile`, a scratch profile **outside the repo**, created by a first launch (the migrations call functions `db.ts` registers, so the schema is built by the app and never by hand) and then given `library_root` (four real books copied from `/Volumes/books/musaeum`, ~750 KB), `rest_api_enabled=true`, `rest_api_bind=127.0.0.1`, `rest_api_port=8799` and a fresh token in `app_config`. Launch: `env -u ELECTRON_RUN_AS_NODE MUSAEUM_USER_DATA=<profile> ./node_modules/electron/dist/Musaeum.app/Contents/MacOS/Electron . --remote-debugging-port=9223`; the library is seeded by `window.Musaeum.library.refreshLibrary()` over CDP. It **holds six books now** — the four copies plus the two the smoke runs uploaded, which is also the proof the script is re-runnable (its second pass was 70/0, with no collision against the first run's book). The pre-fix column was taken in a **detached worktree of `dc89414`** (`git worktree add --detach`, `node_modules` symlinked, `npm run build`), against the same profile and library, and the worktree was removed afterwards.

### The mutation campaign: **15 of 15 killed**

One mutant per criterion and per half of a paired assertion, each naming its file, its anchor and the single test file that must redden, run with `scripts/mutation-campaign.py`. Every row printed the runner's own count line (so every kill is an assertion failing, not a transform error or a missing file), and every touched file was restored with its pre-mutation blob verified by the runner. The value is not the number — it is the two deciders it found that a green suite had been certifying:

| Instrument as first written                                                                  | Why it decided nothing                                                                                                                                                                                                 | Repair                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _answers 500 rather than a book the cache does not hold_ — asserting the status and the body | Removing the guard produces the **same** 500: the payload builder throws on a null book and the outer handler answers `internal` too. Two different events, one indistinguishable response, so the case could not fail | The guard's own sentence on the log is now the decider (`vi.spyOn(console, 'warn')`, the exact wording), and the mutant dies                                                 |
| _hands the transfer slot back_ — folded into the `503 busy` case                             | A **refused** upload never takes a slot, so a leaked slot is invisible to the case that produces one; the mutant survived                                                                                              | A case of its own: an upload **succeeds**, then two downloads must be holdable at once (bounded by `Promise.race`, so a leak reads as `started === 1` rather than a timeout) |

Both repairs were then re-run against their mutants: the second campaign is the 15/15 above, and the count includes the two rows the repairs added.

### The pre-merge review round: one blocking finding, six worth fixing, all fixed in the same pass

The repo's own `reviewer` agent, dispatched against the frozen tree (read-only on code, its scratch outside the repo), found **no invariant break and no wire, status-code or shaper-versus-document drift** — and the one blocking item was the _slice's own named gate_:

**Blocking — `npx prettier --check` failed on `docs/rest-api.md`, while the record's gate line said "prettier clean".** Every table this slice adds was padded to a width its widest cell does not have, and one new row wrote `_read the response_` where the file uses `*emphasis*`. The reviewer proved it was this slice's own drift rather than a tool artefact (`git show HEAD:docs/rest-api.md`, checked with the same config, is clean) and proved the fix safe **before** it was applied — the formatter's diff contains **zero** lines inside any fenced block (`grep -c 'payload='` → 0), so the `import` golden still parses. Fixed with `prettier --write`, verified afterwards: 9 hunks, all inside this slice's own sections, no `payload=` line moved, `prettier --check docs/rest-api.md` clean, and `shape.test.ts` — the AC19 golden that parses this document — green. **The gate line had been written as "clean on every touched `.ts`", which was true and beside the point: a `.ts`-only formatting check cannot fail on the artifact this slice is half about.** The line is corrected above rather than quietly.

**Two more vacuous deciders, and one of them was in the criterion's own instrument:**

| Instrument                                                                 | Why it decided nothing                                                                                                                                                                                                                         | Repair                                                                                                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC9's `it.each` sent **no body** (`post(path)`)                            | With nothing to write, "the scratch directory is empty" holds whether the query was parsed before or after the body — and the module removes the scratch file on _every_ refusal besides, so the ordering the criterion names was unobservable | the same matrix now puts the real `BOOK` bytes on the wire, so the assertion means what its comment says                                                       |
| `shape.test.ts`'s `keyPaths(payload.book)` vs `keyPaths(PAYLOADS.book)`    | Both sides are `bookPayload(GOLDEN)` on the same input — the same call compared with itself                                                                                                                                                    | deleted; its neighbour `.toEqual(bookPayload(GOLDEN))` is _not_ tautological and stays (it would catch an `importPayload` that stopped delegating)             |
| `upload.test.ts`'s `expect(API_ERRORS.tooLarge).toBe('content too large')` | A constant compared with its own spelling: it passes whatever the route answers                                                                                                                                                                | replaced by reading that constant **off the wire** (`{ error: API_ERRORS.tooLarge }`), so the literal is decided once, by the document pair in `shape.test.ts` |

**Three corrections to the contract itself, the third of which a client would have hit.** (a) Two sentences still said the API has **one** write and that every route answers `GET` — the Methods section, the first thing a client author reads, in exactly the staleness class this slice fixed elsewhere; both now say _the first of the two_ and _the second write_. (b) The route's own section claimed the bytes are "checked, and only then moved into the book's folder": **nothing inspects a body** (`format` is a trusted query parameter whose only effect on the bytes is to force the stored extension) and the importer **copies** while the route deletes its own copy. It now says that, including what a client gets for sending something that is not an EPUB at all. (c) **`duplicate.existingAuthor` is `string | null` on the wire** (`src/types/book.types.ts:273`, and `upload.test.ts` asserts a `null` for an authorless match) and the document did not say so — the golden's duplicate carries a non-null author, so the document-versus-golden pair _cannot_ catch it, and a client decoding that field as non-optional would lose the **entire `201` body** on an ordinary collision with an authorless book. The table now names the nullability, and slice 3's annex carries the same sentence because its Swift model is the reader this was fixed for.

**What the reviewer checked and found clean** — recorded, because silence is otherwise ambiguous: all twelve invariants against the diff, including that a book created by this route has **no shortcut of its own** (the route writes no catalog, no row and no `metadata.json`; it calls `importer.addFiles` with `duplicate: 'add-new'` exactly as the picker and the watcher do, so sort-key derivation, `metadata.json`-after-insert and the settled-title rename are all the import path's own); the arm's thinness, with `UPLOAD_REFUSALS` a `Record` over the module's refusal union minus `offline`, so a sixth reason is a typecheck failure here until its status is named; the gate acquired once, before anything else, released in an unconditional `finally`, and never taken on the busy arm; that the offline refusal precedes `mkdir` and `writeBody` — **measured on the wire**, where a probe sending an 8 MiB body read the `503` + `Retry-After: 5` after 16 KB had gone out with the socket still open; every status and word against the document, including that `API_VERSION` is still 1 and that `readJsonBody`, `MAX_BODY_BYTES`, `BODY_TIMEOUT_MS` and `MAX_BYTE_TRANSFERS` are untouched; the three contract artifacts moving together; and no leaked handle (the file's servers are closed in `afterEach`, the 59-file suite runs in 2.9 s, and node's `server.close()` was measured resolving in 1 ms against an idle keep-alive connection). It also **ran the gates independently rather than trusting this record**: typecheck 0, lint 0, `npm test` **1408 in 59 files, 0 failed**, and it checked the +29 arithmetic. **What it could not verify, it says so:** AC14's live smoke run, because its brief forbade launching the app — that reading is the table above — and it flagged that it had read this annex _before_ the results section existed rather than assuming otherwise.

**The repair round's own campaign: 15/15 again** over the changed deciders, every file restored with its hash verified. One item has **no expressible mutant** and is recorded as such rather than dressed up: AC9's ordering cannot be broken by a one-line mutation, because the scratch path is _built from_ the parsed filename — so the case's value is that it would catch a reordering, and no mutant proves it today.

### Corrections to this annex's own text, recorded rather than rewritten

- **S5** asked whether a mid-flight refusal is ever read and named a fallback. It is read, and the fallback is not built — see above.
- **S6**'s recommendation (leave the bare path out of the `HEAD` allowlist) is what landed, so the sentence now describes the tree rather than a preference.
- **S9**'s "synthetic, and small": synthetic **and small — past a kilobyte.** "Small" was doing silent work in a _different_ section's assumption, which is the finding recorded above.
- The **`Files`** table's `rest.ts` line says "a third seam beside `transfer`/`bodyTimeoutMs`" and that is exact: `RouteDeps` gains `upload` (third), `ServerOptions` gains `upload?`, and `bodyTimeoutMs` was already there and untouched.
- **This annex's own gates line** said `prettier --check` clean on _every touched `.ts`_ — true, and it hid that the artifact this slice is half about was not formatted. Corrected above; the review round is why.

## Start here (slice 3)

```bash
git log --oneline -3
npm run typecheck && npm run lint && npx prettier --check electron/main/api/rest.ts
npm test                      # expect 1408 in 59 files, 0 reds
```

Read, in order: `docs/rest-api.md`'s `## POST /api/books` section (**the landed contract** — it is the client's only description of the upload, and the client never restates it); `docs/superpowers/specs/2026-09-22-ios-companion-design.md` (**its Scope now includes the upload**, AC15); `electron/main/api/upload.test.ts` (the socket-level evidence of what a real client sees, including the `413` read mid-flight); then the harness note above, which is what slice 3's end-to-end check starts from.

Slice 3 inherits, settled and not to be re-derived: the route and its whole refusal vocabulary (400/401/404/413/503-offline/503-busy, each with its word and its `Retry-After`), the `import` payload's shape and its pre-hydration timing, that a second upload of the same book is answered by policy rather than refused, that the body's cap is a _limit_ (the boundary case is `at the cap` → `201`), the fixture recipe for a synthetic EPUB (`zip -0`, a stored `mimetype` first), and the isolated profile's own address, keys and launch line. Slice 3 must settle itself: what the phone does with a `503 busy`'s `Retry-After` versus a `413` (both are refusals, one is worth retrying), where a queued upload's bytes live while the phone is backgrounded, and how the client learns the id it just created when its own list is a page behind.
