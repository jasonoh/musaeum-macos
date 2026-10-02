# Design: books arriving from the phone — the upload route (`POST /api/books`, v1)

**Date:** 2026-09-23
**Status:** Proposed — not yet reviewed with Jason. **Slices 1 and 2 are built** (2026-09-23): slice 1 (`dc89414`) is the import path's `duplicate` policy, the streaming body handler and the scratch-file lifecycle; **slice 2 is the route and the contract**, in the working tree at the eight files its annex names — `POST /api/books?format=&filename=` with the bytes as the raw body, the `201 import` payload, the new `413`, both `503`s, and `docs/rest-api.md` with its golden and `scripts/api-smoke.sh` moved as one artifact. Its record, the harness it stood up and the readings S5–S9 are in **`docs/superpowers/plans/2026-09-23-phone-upload-slice2.md`**. **Slice 3 — the phone — is what remains**, in the iOS repo against that landed document, and its annex is `docs/plans/2026-09-23-slice4-upload.md` there (the fourth slice of that repo's own numbering). See *Built — slice 1* at the end of this document.
**Scope:** One new write on the Musaeum REST API — the phone sends a book's bytes and the Mac imports it — plus the two entry points on the phone that reach it. It does **not** cover metadata editing, read-status marks, deletions, device sends, the phone's own metadata refresh, or picking up another instance's imports on a running machine (see *Rejected and deferred* — that last one was considered and dropped on 2026-09-23, with its reason).
**Depends on:** `docs/superpowers/specs/2026-09-22-ios-companion-design.md` (the server, the token, the contract discipline it established), `electron/main/services/importer.ts` (the import pipeline this route calls and whose every rule it inherits), `docs/invariants/nas-and-catalog.md`, `docs/invariants/settings-and-editing.md`
**Interacts with:** `docs/rest-api.md` and its goldens, which AC19 of the companion spec fixes as one artifact; the byte-transfer gate (`electron/main/api/rest.ts:250`); the duplicate gate (`electron/main/services/importer.ts:178-199`); and the transfer budget's 503 vocabulary. It does **not** interact with `EditableSettings`, the Settings row, or any `metadata.json` field.
**Supersedes:** nothing by decision. It reverses one sentence of the companion spec's **Scope** ("It does **not** cover any other write") and the matching line in `docs/rest-api.md` § *Not in this version* — both corrected in place, additively, in the slice that lands it.

---

## Why now

Measured 2026-09-23, read-only, against the live library (`/Volumes/books/musaeum`, an smbfs mount of `nas`) and the dev database.

| Fact | Reading | Where |
| --- | --- | --- |
| books in the cache / directories on the share | 7,100 / 7,102 | `app_config` + a count of `books/` |
| largest EPUB on the share | **528 MiB** | the companion spec's own D15 census (80 books over 100 MB) |
| `catalog.json` | **13,467,270 bytes**; warm read **0.03 s**, cold **1.46 s**, sha256 **0.082 s** | measured today |
| chokidar 4 on smbfs, a local write through the mount | fires — `addDir` +26 ms, `add` +4327 ms, `change` +8289 ms | standalone probe, today |
| the `imports/` inbox | **0 files**, mtime Jul 14 | `ls` — the watcher has never run |
| the importer's duplicate gate | **awaits a promise only the renderer resolves** | `services/importer.ts:188-189` |

**The thesis, in one sentence: importing a book is the one thing the phone cannot do and the one thing it is most likely to have in hand.** The companion spec measured that the phone is where the reading happens (four books read in the Mac reader since August, against a 5,324-EPUB library); the same asymmetry applies to acquisition. Today a book reaches this library through the Mac's file picker or a drop on the app's window, and neither exists when the file is on the phone — which is where a book bought or downloaded on the phone *is*.

**What follows:** one route that hands the bytes to the importer the Mac already uses, and hands nothing else — no second import pipeline, no second duplicate policy, no new metadata shape. The route's whole job is to get bytes onto a disk the importer can read and to say what happened.

**Why this is the *second* write rather than a violation of D4.** The companion spec's D4 chose read-only-plus-one-write and named four writes as absent: metadata edits, read-status marks, deletions, device sends. Its Consequence added a prediction — *"each is a new `PUT` when it is wanted, at which point the lock/override question arrives with it"*. An upload is **none of those four and not a `PUT`**: it creates a row rather than editing one. So it does not arrive with the lock/override question, and it does not supersede D4 — it is the first addition to a surface whose Scope sentence said "does not cover any other write", and that sentence is what this spec reverses. The distinction matters because D4's prediction is about *edits*, and this is not one: nothing here calls `markFromPatch`, and a field override cannot be touched by a path that never writes a field.

---

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| the whole import pipeline: extract, duplicate gate, copy into `books/{uuid}/`, insert, async hydrate | `services/importer.ts:118-273` |
| `addFiles(paths)` — the one entry point, already used by the watcher and the Mac's picker | `services/importer.ts:118-124` |
| the file has to exist on disk first: the pipeline takes *paths*, and copies with `fs.copyFile` | `services/importer.ts:140`, `:207` |
| supported formats, extension-keyed | `services/importer.ts:28` |
| the share check the pipeline makes itself | `services/importer.ts:133` |
| the renderer's progress surface, broadcast per step | `services/importer.ts:108-112` |
| the byte-transfer gate, one per server, process-wide | `electron/main/api/rest.ts:250`, `:709-713` |
| the JSON body reader, its 4 KB cap and its 10 s clock, and the two seams beside them | `electron/main/api/rest.ts:382`, `:396`, `:418-460`, `:676-691` |
| the routing switch and its method policy | `electron/main/api/rest.ts:550-664` |
| the book-path matcher, which matches `/api/books/{id}…` and never bare `/api/books` | `services/api/routes.ts:30`, `:66` |
| `bookPayload` — the shape both `GET /api/books/{id}` and the reading write answer | `services/api/shape.ts:191` |
| the contract's golden mechanism: every `json payload=` block in the document, parsed and compared | `services/api/shape.test.ts:101-104`, `:129-130` |
| the executable half of the contract | `scripts/api-smoke.sh` |

**Not true today, and inside this feature rather than free:**

- **The importer cannot be told what to do about a duplicate.** `importOne` detects one pre-copy (`:178-186`) and then *blocks* on `await new Promise<DuplicateDecision>` (`:188-189`) until something calls `resolveDuplicate`. `abortPendingDecisions()` is the only escape and it resolves **`{ action: 'skip' }`** (`:61-66`) — indistinguishable from the user's own Skip, so it cannot be the route's answer. Bypassing a decision to make that arm reachable is the slice's first job.
- **The gate fires before the copy, not after.** `:178-199` is above step 3's `fs.copyFile` (`:207`), so a refusal costs the extraction and nothing else — which is what makes a policy parameter cheap and a "refuse and let the phone resend" design expensive in bytes rather than in state.
- **`GET /api/books/{id}/file` streams *out*; nothing streams *in*.** `resolveBookFile` (`services/book-bytes.ts:55`) and `parseByteRange` (`:200`) are read-side only, and `readJsonBody` is bounded at 4 KB by construction.
- **No route accepts a body larger than 4 KB**, and the contract's error vocabulary has no status for "too large" — `API_ERRORS` (`services/api/shape.ts:46`) is the fixed table.
- **The phone has no way to pick or share a book.** No picker, no extension, no document types.

---

## D1 — `POST /api/books?format=<f>&filename=<name>`, with the bytes as the raw body

**Decision:** one new route, matched on the bare path `/api/books` (the matcher never sees it today — `routes.ts:30`'s prefix has a trailing slash). `format` is **required** and is one of `epub`, `mobi`, `azw3`, `pdf`; `filename` is **required** and is the name the book arrives under. The body is the file's bytes, unencoded, with the format's own media type. The answer is `201` carrying the **`import` payload** (D6).

**Why:** the alternative is `multipart/form-data`, which needs a parser — a dependency, or a hand-rolled one, for one route whose whole content is a single part. Raw bytes need none: the format is a parameter (mirroring `GET /api/books/{id}/file?format=`, where a missing or unknown `format` is already refused rather than defaulted), and the filename travels as a parameter rather than inside the payload. **Required rather than optional** on both: the importer derives a title from the filename for the formats whose files are silent about their own identity (`titleFromFilename`, `importer.ts:114-116`), so a nameless upload produces a book named after a temp file — a worse outcome than a 400 the phone can fix.

**Consequence:** the route takes no `Content-Type` guarantee and does not read one, exactly as `readJsonBody`'s docblock already argues for the other write (`rest.ts:414-416`). A wrong `format` is the client's error and is refused before a byte is written.

## D2 — The bytes land in the app's own scratch directory, never `imports/` and never the library tree

**Decision:** the route writes the body to a unique file under the app's `userData` directory, calls `importer.addFiles([thatPath])`, and removes the file on every exit path — success, refusal, or failure. `{library_root}/imports/` is left exactly as it is: a landing zone for a human dropping a file through Finder.

**Why:** `imports/` is watched by `services/file-watcher.ts:15-32`, which imports **and deletes** whatever appears there. A route that wrote into it would race its own watcher: the same file imported twice, or a partial file taken mid-write (the watcher's `awaitWriteFinish` mitigates the second, not the first). One writer per landing zone is the rule; the watcher and the route both end at `importer.addFiles`, which is what keeps them from diverging. The library tree is refused for a second reason — a partially-written file inside `books/` is a row that claims a size and a format for bytes that are not there, which is the defect `tasks.md` already carries as *Stale file facts on a row whose files are gone*.

**Consequence:** the upload crosses the network **once** (phone → Mac) and the share **once** (Mac scratch → `books/{uuid}/`, where the importer's `fs.copyFile` reads locally and writes over SMB). Landing in `imports/` would have put the phone's bytes across the SMB link twice for no benefit. The cost of the decision is a disk requirement on the Mac: a 528 MiB upload needs 528 MiB free in `userData` for the length of the import.

## D3 — The duplicate gate is *answered*, never awaited: a policy parameter, defaulting to Add new, with the match reported back

**Decision:** the import path gains an explicit policy — `duplicate: 'ask' | 'add-new'` — where `'ask'` is the existing behaviour and the default for every current caller, and the route passes `'add-new'`. Under `'add-new'` the gate still **detects** the duplicate and still builds its `DuplicateContext`, but it does not suspend: it falls through to the copy, and the context travels back on the result. The response carries it (D6), so the phone is told what the Mac noticed.

**Why:** the gate's three arms (`skip`, `add_format`, `add_new`, `:191-199`) are answers a *person* gives, and a phone mid-upload has nobody to ask. The two alternatives fail on their own merits: `abortPendingDecisions` resolves as `skip` (`:61-66`), so the route could not tell "the import was aborted" from "the user skipped" — and it would abort every other pending gate in the process, which on a Mac with an import dialog open is a second bug. A "refuse with 409, let the phone resend with a resolution" design keeps all three arms but costs a **second full upload** to use any of them — 528 MiB to answer a question the phone could have been told the answer to after the first attempt.

**Consequence:** `add_format` — the arm that gives an existing book the format it lacks — is **not reachable from the phone in v1**, and neither is `skip`. A duplicate uploaded from the phone becomes a second book, visibly, with the match named in the response. That is the same posture the library already takes for the *other* duplicate class: `duplicateFor` (`importer.ts:400`) reports a shared ISBN and never acts. **Reversal:** the phone grows a duplicate sheet of its own — then `duplicate` becomes a request parameter carrying the three arms, and the resend problem returns with it.

## D4 — The body streams to disk under a size bound, and the clock is a *stall* clock, not a total one

**Decision:** the upload's body is piped to the scratch file as it arrives, never buffered whole. Two bounds: a **size cap** (1 GiB, `413` beyond it) and a **stall clock** — a timer reset on every chunk, answering on a gap of no bytes rather than on total elapsed time.

**Why:** `readJsonBody`'s 4 KB cap and its `BODY_TIMEOUT_MS = 10_000` (`:382`, `:396`) are both wrong for this route by two orders of magnitude, and neither number can simply be raised. The cap is raised once, to a figure with a census behind it: the largest EPUB in this library is 528 MiB, so 1 GiB is roughly twice the worst case the census found — and the census counted EPUBs, so a PDF book may be larger, which is the reason the answer past the cap must be a clear `413` rather than a truncated import. A total-duration clock is the subtler error: 528 MiB over a tailnet is **minutes**, so a total bound either kills a legitimate slow upload or is set so high it never fires — and the failure the 10 s timer exists to prevent goes unnoticed. A stall clock bounds exactly that failure — a client that declared more than it sent, or a link that died — without knowing the file's size in advance. **The threshold is a measurement, not a judgement: see *Not verified*.** `413` is a new status for this contract; it is added to `API_ERRORS` and to the document's errors table, because an oversized body is a *limit* rather than the malformed request `400` is defined as.

**Consequence:** the route's body handler is its own function, not a widening of `readJsonBody` — the two share a shape and no configuration, which is the honest outcome given how differently they are bounded. The route gains a third seam beside `transfer` and `bodyTimeoutMs` (`:683-690`) so a case can decide the cap and the stall without a slow disk or a ten-second wait.

## D5 — The upload takes one of the two byte-transfer slots

**Decision:** the body is written while holding a slot from the server's existing gate (`rest.ts:250`), and a request that arrives with both slots spent is answered `503 {"error":"busy"}` with `Retry-After: 1`, exactly as the cover and file routes are.

**Why:** the budget exists because a transfer is a *long-held* slot in the same four-slot libuv threadpool the app's own cover loads, catalog writes and hydration reads use (`docs/rest-api.md`, *Concurrent byte transfers are capped at 2*), and an upload is that same shape — minutes, not a burst. A phone uploading 528 MiB while the Mac serves a library grid is precisely the contention the cap was written for. The alternative — exempting the upload because it is "the user's own action" — would make the cap's own number a lie in the direction that hurts the app.

**Consequence:** an upload and a download contend, which is honest and was already true of two downloads. The slot is released on every exit path including a client that disappears mid-body, and — like the download routes — nothing here can *end* a transfer whose socket has stalled: the client's own timeout is what returns the slot (`docs/rest-api.md`, same section).

## D6 — The answer is `201` with the book, in the same shape everything else describes a book in

**Decision:** a new payload, `import`: `{ "book": <bookPayload>, "duplicate": <null | DuplicateContext> }`. The book is the row as it stands at the moment the import returns.

**Why:** reuse over invention — `bookPayload` is already the shape `GET /api/books/{id}` and the reading write answer (`shape.ts:191`), and a client that has just uploaded a book should not need a second request to see it, the same argument D10's write made for one round trip. `duplicate` is the member D3 owes: it is the only place the phone learns that the Mac saw a match, and putting it *outside* the book keeps the book's shape identical to every other route's.

**Consequence — stated, because it is the honest limit of this response:** the book in the payload is **pre-hydration**. `importOne` inserts the row (`:250`) and then starts hydration without awaiting it (`:253`, and the comment at `:248` — "the book is in the library from this moment; hydration continues async and never blocks import"). So the payload carries the embedded metadata and a null `seriesName`; a title the fetch will settle arrives on the phone's next list fetch. This is the Mac's own contract with itself, not a degradation introduced for the phone.

## D7 — The contract's three artifacts move in one slice, and `apiVersion` stays 1

**Decision:** the route, the document and the executables land together: a new `## POST /api/books` section in `docs/rest-api.md` with a `json payload=import` block (plus the `413` row in its errors table), the golden parsed from that block by `shape.test.ts`, and a new check in `scripts/api-smoke.sh` that uploads a small real book and asserts the returned id appears on `GET /api/books/{id}`. `apiVersion` stays **1**.

**Why:** the document's own first paragraph fixes the rule — "a field the document does not name, or names and the wire does not carry, is the drift this pair exists to catch" — and its § *Methods* says the version is tied to a **payload** change. Routes are additive: a v1 client is unaffected by a route it does not know, because every path it does not ask for answers `404` uniformly already. Bumping the version would force every deployed client to refuse a server it is compatible with.

**Consequence:** the smoke script's upload check is **the only thing in it that adds a book** to the profile it runs against, beside the one write that already moves a reading position. That is why it belongs on a scratch profile, which the script already insists on (it exits rather than defaulting to the real database).

---

## Acceptance criteria

### Slice 1 — the upload's own half (no route, no contract)

1. `importer` can be told `duplicate: 'add-new'`, and under it a file whose ISBN-13 matches an existing row is imported as a new book rather than suspending: the case seeds a duplicate, calls the new path, and asserts a completed result — decided by a unit case over the service, no socket.
2. The **existing** behaviour is unchanged for every current caller: `duplicate` defaults to `'ask'`, and the case that seeds a duplicate and asserts the gate emits `awaiting_dedup_decision` and **stays pending** until resolved still passes untouched.
3. The duplicate's context is carried out under `'add-new'` — `existingBookId`, `existingTitle`, `matchType` — rather than discarded, so D6 has something to put on the wire. Decided over the return value, not over the emit.
4. A body handler exists that streams to a file and never holds the body in memory: the case feeds a body larger than `MAX_BODY_BYTES` and asserts the file on disk is byte-equal to what was sent, with the in-memory high-water mark bounded by the chunk size (the instrument is a `stat` on the temp file plus a chunk-count assertion, not a heap read).
5. Past the size cap the answer is `413` and **no import is attempted** — asserted by the importer never being called, not by the status alone (a status can be sent after the damage).
6. A body that stops arriving is answered on the **stall** clock, not on a total elapsed time: the case sends a prefix, waits past the stall threshold, and asserts a refusal, while a case that streams slowly for longer than the stall threshold **but never stalls** is accepted.
7. The scratch file is removed on every exit path — success, `413`, stall, and a share that is offline — decided by the directory being empty afterwards, not by a call being made.

### Slice 2 — the route and the contract

8. `POST /api/books?format=epub&filename=X` with real EPUB bytes answers `201` and a payload whose `book.id` then answers `GET /api/books/{id}` `200` — decided over a real socket on an ephemeral port, the instrument the 401 and byte-route criteria already use.
9. A missing or unknown `format`, and a missing `filename`, each answer `400` **before any byte is written** — asserted by the scratch directory being empty.
10. The unauthenticated request answers `401` with `WWW-Authenticate`, and every other method on that path answers `404` uniformly — the method-policy rule the router already states.
11. With the share unmounted the answer is `503 {"error":"library offline"}` with `Retry-After: 5`, matching the byte routes' vocabulary, and the scratch file is gone.
12. With both transfer slots held, the answer is `503 {"error":"busy"}` with `Retry-After: 1`.
13. `shape.test.ts`'s AC19 case describes the `import` payload and only payloads the shaper builds — the same case, extended, not a parallel one.
14. `scripts/api-smoke.sh` gains a check that uploads a book and finds it by id, and the script still passes end to end against a live app on an isolated profile.
15. `docs/rest-api.md`'s § *Not in this version* and the companion spec's **Scope** sentence are corrected in place, additively, each naming what it used to say and why it changed.

### Slice 3 — the phone (the iOS repo, its own annex)

16. A book chosen from the **Files picker** uploads and appears in the phone's grid on the next list fetch, decided by a live probe against a real Musaeum.
17. The **share sheet** hands a book from another app (Files, Safari) to Musaeum, and the same holds.
18. A failed upload has a surface that names the reason it failed — not a silent no-op, and not a dialog nobody can act on (CD7's rule).

---

## Slices, and why they are cut this way

**Slice 1 — the upload's own half (5 files, comfortably inside the bound).** New: `electron/main/services/api/upload.ts` (the streaming body handler, the two bounds, the format/filename validation, the scratch-file lifecycle — all pure over a stream and a directory, so it is decidable without a socket). Edited: `services/importer.ts` (the `duplicate` policy arm and the context on the result), its test, and — if the handler needs a home for the cap and the stall threshold — `services/api/`'s constants. **It stops before the route**, which is the right stopping point for two reasons: none of its criteria need a socket, and the contract cannot move until the route exists, so the route is what makes slice 2 a *contract* slice rather than a wiring one.

**Slice 2 — the route and the contract (7 files, at the bound).** Edited: `electron/main/api/rest.ts` (the route arm, the seam, the gate), `services/api/routes.ts` (a matcher for the bare path), `services/api/shape.ts` (`importPayload`, `413` in `API_ERRORS`), `services/api/shape.test.ts`, `docs/rest-api.md`, `scripts/api-smoke.sh`, and the new route test. New: `electron/main/api/upload.test.ts` (the socket-level cases). **The document, the goldens and the executable half cannot be separated** — that is AC19's whole point, established in the companion spec's slice 1b — so this slice is the smallest unit that can carry a route onto the wire, and it is the reason the iOS work is not in it.

**Slice 3 — the phone.** A separate repository, written against the landed document, with its own annex there (`docs/plans/`). It cannot start before slice 2: invariant 1 of that repo says the contract lives in *this* one, and its fixtures are extracted from `docs/rest-api.md` by `scripts/vendor-contract-fixtures.sh`. Both entry points are in one slice because they share the upload call and differ only in how the bytes arrive; the share extension is a second target in `project.yml`, which is the larger half.

---

## Rejected and deferred, with the condition that would revive them

- **Automatic pickup of another instance's imports (a poll on `catalog.json`).** **Considered and dropped 2026-09-23**, on two independent grounds. First, the mechanism cannot tell its own writes from the other machine's: `reading-state.ts:126` rewrites `catalog.json` through `updateCatalogFields` on **every** `saveProgress`, and `catalog.ts` keeps no self-write guard (`enqueue`, `:168`, serializes writes and records nothing about them) — so any detector, timer or file watch, sees the app's own book-close as a foreign change and adopts the whole library back (7,100 rows, `replaceAllBooks`, two broadcasts) each time. Distinguishing them needs a digest of the **13,467,270-byte** file per event, measured at 0.082 s. Second, the owner's constraint on 2026-09-23: a feature that needs polling is not worth it. **What remains is manual and already exists** — *Refresh Library* (`library-sync.ts:224`) reads the one catalog and adopts it in a click, and `syncOnConnect()` (`:190`) does the same automatically on a NAS reconnect. **Revived** only by a non-polling signal that is provably not the app's own write.
- **Reaching `refreshLibrary` from the phone** (a pull-to-refresh that asks the Mac to re-adopt) — the design that replaced the poll, and it was dropped with it as the owner chose the smaller scope. It is **not** free of a trap if it is ever wanted: `refreshLibrary` falls through to `rebuildCatalog()` when the catalog is unreadable (`:228`), and that walk costs **1,281 s (21.4 min)** against the real library — so a phone-triggered path must use a non-rebuilding arm and answer "run Rebuild on the Mac" instead. **Revived** by the owner importing on the other machine often enough that walking to the Mac to click Refresh Library becomes the annoyance.
- **`multipart/form-data`** — rejected (D1) for a parser dependency the surface does not otherwise have. **Revived** when a request has to carry more than one part, which nothing on this API does.
- **Exposing `skip` and `add_format` to the phone in v1** — rejected (D3) because both need a second full upload to mean anything. **Revived** by a phone-side duplicate sheet, at which point `duplicate` becomes a request parameter.
- **Metadata refresh from the phone** — deferred by the owner's own scope call on 2026-09-23. It splits cleanly when wanted: single-book is `importer.hydrate` behind the awaited `metadata:rehydrateBook` (`ipc/metadata.ts:19-34`), ≤5 s by the performance target, so a synchronous route is defensible; library-wide is `bulkHydrate.startBulkHydrate`, which is already the house job-id-plus-events pattern. **Revived** the first time a phone-side book looks wrong.
- **Metadata editing from the phone** — deferred, and it is `docs/superpowers/specs/2026-09-20-portable-decisions-design.md`'s ground. The owner's standing choice (2026-09-23) is last-write-wins with the residual documented rather than fixed, which is the posture `docs/rest-api.md`'s reading section already records for the app's own close. **Revived** by that spec's slice 1 landing, or by a phone edit actually being lost to a Mac row.
- **Resumable uploads** (a `Range` request in the other direction) — deferred. This is the mirror of CD6's deferred `Range` resume, and its revival condition is the same measurement: one transfer large enough that restarting it hurts. The census says 80 books hold an EPUB over 100 MB, so it *will* fire; what is not built is the client half.
- **Watching `{library_root}/imports/` for a remote writer** — the watcher stays as it is (D2). It has no test in this repo and has never run (0 files in the inbox today), which is recorded rather than fixed: it silently deletes what it takes, so a bug there destroys a user's file. **Revived** as its own item — either a test or a removal — not folded into this slice.

## Risks, stated plainly

1. **The phone cannot resume an upload, so a tailnet drop costs the whole transfer.** For a 528 MiB book that is minutes of tailnet on a retry, and it is the residual this design does not solve. The bounds in D4 turn it into a clean failure rather than a corrupt book; they do not make it cheap.
2. **The Mac's scratch disk is now on the upload path.** A 528 MiB upload needs that much free in `userData`; a Mac short on disk fails the upload with a `500`, and the phone has no way to know the cause. Bounded, visible in the log, and the reason D2's landing zone is a deliberate choice rather than a convenience.
3. **A duplicate uploaded from the phone becomes a second book, and the phone is only *told*.** With `add_format` and `skip` unreachable from this route (D3), a phone user who uploads a book they already own gets two rows and a named match in the response. Accepted: it is the library's existing posture for the other duplicate class, and the alternative costs a full re-upload.
4. **The upload is the second write, and a second write is how a read surface becomes an editor.** The route's own discipline is what keeps this one narrow — it calls `importer.addFiles` and re-implements nothing — but the general risk is real, and the guard is the one D4 of the companion spec already established: every new write is its own decision with its own reversal condition, never a widening of an existing one.
5. **A criterion in slice 2 is decided by a script that adds a book.** `api-smoke.sh`'s upload check is the second thing in it that mutates the profile it runs against, and a scratch profile is the precondition. The script already refuses to run without one; the check must not be the thing that finally relaxes that.
6. **Invariants held:** #8 (business logic stays in `services/` — the route is a thin arm over `api/upload.ts` and `importer`), #12 (every failure is an answer, never a throw, and a failed import leaves no scratch file), and #2 (the file is resolved by extension, which is how the importer already finds the file it just copied). **Deliberately untouched:** #1, #3, #4, #5, #6 (this path creates a row with a filename-derived title and never renames a settled one — `renameToTitle` runs after hydration, on the existing path), #7, #9 (no renderer is involved at all), #10, #11.

---

## Not verified

Both were discharged **before** the file they bear on was written, with a throwaway harness outside the repo. Each item keeps its original text below and carries its answer beside it; the numbers live in the slice 1 annex's readings table (`docs/superpowers/plans/2026-09-23-phone-upload-slice1.md`), not in this session.

1. **What a phone-to-Mac upload actually does on this tailnet** — the throughput, and therefore the stall threshold D4 leaves as a number rather than a judgement. The document carries the *download* measurement (528 MiB in 25.64 s) and nothing in the other direction. The instrument is a plain `curl --data-binary @<a large file>` against a local listener on the tailnet address with a stopwatch, warm and cold, for a few sizes. If the answer is minutes per gigabyte, the cap and the threshold both move, and the phone's own timeout becomes the thing that decides whether the feature is usable at all. **Answered before the build (2026-09-23):** a real 320 MiB stream's worst inter-chunk gap measured **99.7 ms** (p99 7.5 ms), so `UPLOAD_STALL_MS` is **30 s** — a 300× margin — and the cap is unchanged at 1 GiB, which the measurement had nothing to say about. The residual is stated rather than hidden: no second controllable tailnet host exists, so both local paths **short-circuit** (157 and 484 MiB/s, above this Mac's 1 GbE ceiling) and bound the server stack rather than the wire; the phone is on this LAN and LAN-direct (138 ms RTT, not DERP-relayed), so its own path is the one number this harness could not produce. Reading **R1**; reversal condition recorded there.
2. **Whether `importer.addFiles` can carry a policy without disturbing the Mac's own gate.** The prediction is yes — the gate's detection (`:178-186`) and its suspension (`:188-189`) are separable, and `'ask'` stays the default — but the *decider* is the existing case that seeds a duplicate and asserts the gate stays pending, run unchanged against the modified service. If that case cannot be satisfied without changing what it observes, the policy belongs one level up (a pre-flight check in the upload service, before `addFiles` is called) and D3's shape changes with it — a **reading**, not a reopened product decision. **Answered (2026-09-23): the prediction held.** The decider was the existing case run unchanged — the importer's *blocks on an ISBN-13 match* case, which asserts the gate emits `awaiting_dedup_decision` and stays pending — and it passes untouched, together with the whole `resolveDuplicate` / `abortPendingDecisions` group. So the policy stays on `addFiles` and D3's shape is unchanged. Reading **R2**.

---

## Built — slice 1 (2026-09-23)

Landed as one change (`dc89414`), and it stops where the slice said it would: **no route, no payload, no document movement** — `docs/rest-api.md`, `services/api/shape.ts`, `shape.test.ts` and `scripts/api-smoke.sh` are untouched, and `apiVersion` is still 1.

**The file row said ~5 and the honest count is 6:** `electron/main/services/api/upload.ts` (new — `MAX_UPLOAD_BYTES`, `UPLOAD_STALL_MS`, `isUploadFormat`, `safeFileName`, `parseUploadQuery`, `uploadScratchDir`, `receiveUpload`) and `upload.test.ts` (new — 30 cases), `electron/main/services/importer.ts` (the policy arm and the context on the result), `importer.test.ts` (+4 cases), `src/types/book.types.ts` (`ImportResult.duplicate?: DuplicateContext` — additive and optional, so every existing caller typechecks unchanged), and the annex. No migration, no `app_config` key, no new dependency, nothing in the renderer, and no change to `metadata.json`'s shape.

**Gates:** `typecheck` 0 / `lint` 0 / `prettier` clean on every touched file / **`npm test` 1379 passed in 58 files, 0 failed** (from 1344 / 57 on `3e4696a`; this slice adds 35 cases and one file). The baseline's four `python-env.test.ts` reds are an order-dependent flake in full-suite order and did not recur — recorded, not folded in.

**The build's own campaign, plus the repair round that followed the review: 26 mutants, 26 killed** (23 of 23, then 3 of 3 on the fixed code), every one restored with its hash checked. What the campaign is worth reading for is not the number but the two instruments it caught, because both are about *how a case can lie*:

- **Three deciders were vacuous, and one of them was mine.** Two refusal cases asserted the request was never consumed (`yielded() === 0`) **synchronously** after the outcome resolved — and a mutant that resumed the request and read the body anyway **survived**, because a flowing stream pulls its first chunk on a *later tick*; the assertion now waits a tick and the mutant dies. The third destroyed an already-ended stream, which emits nothing at all (the case now emits the error directly). A green suite was proving nothing about any of them.
- **The blocking defect no case in the suite could see.** The reviewer proved with a real `EFBIG` (a file-size `ulimit`) and a real `ENAMETOOLONG` that `end`'s callback is invoked with the write stream's error **before** its `'error'` event — so a success folded into that callback without reading its argument answered `ok` for bytes that never reached the file, and the importer could be handed a **short** one. That is exactly the failure D2/D4 exist to prevent, one layer below where the criteria were looking. The success path now reads the callback's argument, and a case decides it with a **real `fs.WriteStream` whose open fails** (the `writeStream` seam points it one component too deep), so the ordering is reproduced rather than imitated by a stub.

**Nine smaller findings from the same review, all fixed in the same pass:** an empty body refused as `internal` where `bad-request` is the client's own 400 (`api/rest.ts`'s own rule — never a 500 for the client's mistake); no bound on the sanitised name, so a ~251-character `filename` produced `ENAMETOOLONG` and a 500 — now refused past 255 bytes, the filesystem's own `NAME_MAX`; a name that *is* an extension (`.epub` → `epub.epub`, a book titled "epub"); the same docblock paragraph stated twice; `out.write()`'s return ignored, so the backpressure the docblock claimed did not exist (the request is now paused on a false return and resumed on `'drain'`, with a one-byte high-water mark making a slow target decidable in the suite); a dead `filePath` on the outcome; no listener surviving the answer, so a later `'error'` threw; and a share that goes away *between* the pre-body check and the copy flattened to `internal` — now `offline`, so slice 2 reaches its 503 on both paths without string-matching the importer's prose.

**The second review — of the fix pass, over the frozen tree — found no blocking defect.** It reproduced the original bug *in a mutant of the fixed file* (a 4,096-byte body answered `ok: true` while the importer was handed a 1,024-byte file) and could not produce it in the code itself, which is the only shape of evidence a fix of this kind is worth; it also confirmed the new deciders discriminate rather than merely pass (the open-failure case fails against the pre-fix mutant, the backpressure case fails without the pause, and both refusal cases fail against a handler that reads the body before refusing). Three items it raised were narrower than they claimed, and all three are fixed:

- **The extension-only rule caught the dotted spelling only.** `epub` and `...epub` — the same non-name as `.epub` — still became `epub.epub`, because leading dots are stripped *after* the check. The rule now tests the **dotless stem**, which is precisely what the format's extension gets appended to, so all three spellings are refused and `my.epub` is still a name.
- **A silence the handler itself caused was blamed on the client.** While the request is paused for backpressure no chunk *can* arrive, so a slow local target and a dead client were answered identically as `stalled` — which would send the phone looking for a fault of its own. The clock now answers `internal` when the pause is the handler's, keeps the request bounded either way (a hang would be the worse failure), and its docblock names the third case.
- **The `?? failed` fallback on the flush path was unreachable** — the stream's own `'error'` handler has always answered before it could be read — so it is deleted rather than left reading as load-bearing.

**Reading for slice 2 from the same review:** the `message` on an `internal` refusal is **the filesystem's own** and carries this machine's absolute paths. Map the status; never echo the string.

**What slice 2 inherits, settled and not to be re-derived:** the cap (1 GiB) and the stall clock (30 s — reading **R1** in the annex, from a measured worst inter-chunk gap of 99.7 ms); `{userData}/uploads/{uuid}/{safe basename}`, and why uniqueness lives in the directory while the basename stays the client's (**S1**); that a refusal at the cap resolves at the **breach** while the body keeps draining, not at `end` (**S2**); that the gate's context travels on the **result**, never on a progress event (**S3**); that the offline check precedes the body and now also follows a failed import (**S4**); and the outcome's refusal vocabulary — `bad-request`, `too-large`, `stalled`, `offline`, `internal` — whose statuses slice 2 maps to the responses D4 and D5 fix.
