# Phone upload — slice 2: the route and the contract

**Date:** 2026-09-23
**Slice:** 2 of 3 — the route and the contract (AC8–AC15)
**Annex to:** `docs/superpowers/specs/2026-09-23-phone-upload-design.md`
**Read first:** the spec's *D1*, *D5*, *D6*, *D7* and the Slice 2 acceptance criteria; slice 1's annex (`docs/superpowers/plans/2026-09-23-phone-upload-slice1.md`) for the readings this one inherits — they are settled and are **not** re-opened here. Slice 1 landed 2026-09-23 in **`ddae4c0`** (its record in `1e1d9bc`); the numbers below are that tree's, whose baseline was `a2e9be9`.

---

## What this slice is

One new write on the wire, and everything that has to move with it:

1. `POST /api/books?format=<f>&filename=<n>` — matched on the **bare** path, with the file's bytes as the raw body, answered `201` with the `import` payload (spec D1, D6; AC8).
2. The refusal vocabulary the route owns: `400` before a byte is written (AC9), `401` with `WWW-Authenticate` and a uniform `404` for every other method (AC10), `503 offline` (AC11), `503 busy` with `Retry-After: 1` from the existing transfer gate (AC12), and the **new `413`** past 1 GiB (D4).
3. The contract, in three artifacts that cannot be separated (D7, AC13–AC15): `docs/rest-api.md`'s new route section and its `json payload=import` block, the golden `shape.test.ts` parses out of that block, and the executable half in `scripts/api-smoke.sh` — plus the one-line corrections to this document's *Not in this version* and to the iOS companion spec's **Scope**.

It is the smallest unit that can carry a route onto the wire, which is why the phone is not in it: the client is written against the landed document, in its own repo.

---

## Readings this slice inherits (settled — do not re-derive, do not re-test)

| Reading | Settled by | Where |
| --- | --- | --- |
| The cap (**1 GiB**) and the stall clock (**30 s**, a *stall* clock reset by every chunk) | slice 1, R1's measured worst inter-chunk gap (99.7 ms) | `services/api/upload.ts:41`, `:64` |
| The bytes land in `{userData}/uploads/{uuid}/{safe basename}` — uniqueness in the directory, the basename the client's | slice 1, S1 | `safeFileName`, `uploadScratchDir` |
| A refusal at the cap resolves **at the breach** while the body keeps draining, not at `end` | slice 1, S2 | `writeBody` |
| The gate's context reaches the client through the **result**, never a progress event | slice 1, S3 | `ImportResult.duplicate` |
| The share is checked **before** the body is read — and again after a failed import | slice 1, S4 + the review's ninth finding | `receiveUpload` |
| The outcome's refusal vocabulary and what each maps to | slice 1 | `UploadRefusal` |
| An `internal` refusal's `message` is the filesystem's own and carries this machine's paths | slice 1's second review | `upload.test.ts` / the spec's *Built* section |

The mapping, stated once so the route is a lookup and not a judgement: `bad-request` → **400**, `too-large` → **413**, `stalled` → **400** (the reading route already calls a body that never finished arriving a 400), `offline` → **503 `library offline`** with `Retry-After: 5`, `internal` → **500 `internal`** — and **the `message` field stays in the log**. It carries an absolute path from this machine; the wire gets the fixed word, never the string.

---

## Readings this slice must settle itself, each with the alternative it beats

### S5 — what the client actually sees when a body is refused mid-flight

Slice 1's S2 fixed *where* the refusal resolves (at the breach) and left this open on purpose: whether a `413` sent while the client is still writing its body is ever **read** by that client, or arrives as a reset, is a socket question no socketless case can decide. It is AC9/AC12's instrument — a real connection on an ephemeral port — and it is this slice's first measurement.

**The alternatives:** (a) answer at the breach and trust the client to read it; (b) drain to the end and *then* answer, priced as a wait on bytes that are already refused — for a 1 GiB-plus body, minutes of a phone's battery spent uploading something the Mac has already thrown away. **Slice 1 chose (a)**; this slice measures whether (a) holds, and the reversal condition is a `curl --data-binary` that never sees the `413`. The fallback is not a redesign: it is the same `finish` called on `end` instead of on the breach.

### S6 — whether the collection path answers `HEAD`

The router's own sentence says the JSON routes answer `HEAD` (a `HEAD` is a `GET` with no body). This route takes a body, so a `HEAD /api/books` has nothing to answer with beyond its status. **The alternatives:** answer `405`-shaped (which this API does not speak — a known path with the wrong method is already a uniform `404`, D11), or leave the bare path out of the `HEAD` allowlist and let the policy's existing `404` cover it. **Recommendation: the latter** — one policy rule, no new status, and AC10's "every other method answers `404` uniformly" then holds for `HEAD` too. It is a decision rather than a measurement, and reversing it is one line in the allowlist.

### S7 — the book in the `import` payload is the row as the import returns it

D6 fixes the payload as **pre-hydration** — `importOne` inserts, then hydrates without awaiting. So the route reads the row after `addFiles` resolves and reports what it finds: embedded metadata, `seriesName: null`. **The alternative:** await the hydration (≤5 s by the performance target, and this route holds a transfer slot for its duration) so the phone's first look at the book is the settled one. Rejected: it makes the client wait on a network fetch, and the Mac's own contract with itself has always been "the book is in the library from this moment". **Reversal:** a phone UI that looks wrong until the next list fetch — the payload shape does not change either way, which is what makes the reversal cheap.

### S8 — the `413` word, and why it is not `badRequest`

D4 adds a status this contract has never carried, so it adds a word: `API_ERRORS` (`services/api/shape.ts:46-61`) gains one key beside the seven, `ApiError` widens, and the document's errors table gains its row. **The alternative:** answer `400 bad request` for an oversized body — rejected because `400` is defined as *a request the route cannot make sense of*, and an oversized body is a **limit**, which is a different sentence for the client and a different retry decision for a person. Note that `ApiError`'s new key does **not** disturb `REFUSAL_WORDS` (`services/api/routes.ts:91-94`), which is a `Record` over the *resolver's* statuses and knows only 400/404.

### S9 — what the smoke script's upload check uploads, and against what

AC14 needs a real book to cross a real socket. **The alternatives:** a synthetic EPUB built in the script (no fixture to keep), or a small real book copied from the library (bytes nobody can synthesise — a real `mimetype` entry first, a real `container.xml`). **Recommendation: synthetic, and small** — the check's job is the *route*, not the parser, and a generated file is a fixture the script owns rather than one it borrows from the library. What is *not* negotiable is the precondition: the script reads the token and port from a profile's own database and **exits** rather than defaulting to the real one, so this check must run on an isolated profile and must not be the thing that relaxes that rule.

---

## Files

| File | What |
| --- | --- |
| `electron/main/api/rest.ts` (edited) | the route arm, the transfer gate around the body, and a third seam beside `transfer`/`bodyTimeoutMs` so a case decides the cap and the stall without a slow disk or a ten-second wait |
| `electron/main/services/api/routes.ts` (edited) | a matcher for the bare collection path — `BOOKS_PREFIX`'s trailing slash (`:30`) is exactly what keeps it out of `matchBookPath` today, and `BookPath`'s `{ id, resource }` shape has no room for "the collection" |
| `electron/main/services/api/shape.ts` (edited) | `importPayload`, and the `413` word in `API_ERRORS` |
| `electron/main/services/api/shape.test.ts` (edited) | AC19's case, **extended** — the same case that parses every `json payload=` block, not a parallel one |
| `electron/main/api/upload.test.ts` (new) | the socket-level cases: AC8–AC12 on a real connection, ephemeral port, the instrument the 401 and byte routes already use |
| `docs/rest-api.md` (edited) | the `## POST /api/books` section, the `json payload=import` block, the `413` row, and the *Not in this version* correction |
| `scripts/api-smoke.sh` (edited) | upload a book, then find it by id on `GET /api/books/{id}` |
| `docs/superpowers/specs/2026-09-22-ios-companion-design.md` (edited) | its **Scope** sentence reversed in place, naming what it used to say (AC15) |

**Eight files, and the row's ~7 is the optimistic count** — the eighth is the companion spec's Scope line, which the spec's own D7 and AC15 require in this slice. Inside the bound; no migration, no schema change, no `app_config` key, no new dependency, and nothing in the renderer.

## What must not move

- `readJsonBody`, `MAX_BODY_BYTES` (4096), `BODY_TIMEOUT_MS` (10 000) — the upload's body handler is its own function and its own bounds (slice 1's D4 decision).
- The **two-transfer budget** and its `503 busy` + `Retry-After: 1` (D5): an upload takes a slot and contends with a download.
- The method policy's uniform `404` for a known path with the wrong method (D11), and `apiVersion` at **1** (D7 — routes are additive; the version tracks payloads).
- `imports/` and `services/file-watcher.ts` (D2), and invariant 8: the route is a thin arm over `services/api/upload.ts` and `importer`, with no logic of its own.

## Acceptance criteria, each with its decider

| AC | Decided by |
| --- | --- |
| 8 | a real socket on an ephemeral port: real EPUB bytes → `201`, then `GET /api/books/{id}` → `200` for the returned id |
| 9 | a missing or unknown `format`, and a missing `filename` → `400`, asserted by the scratch directory being **empty** afterwards |
| 10 | no token → `401` with `WWW-Authenticate`; every other method on the path → `404` uniformly |
| 11 | share unmounted → `503 {"error":"library offline"}` with `Retry-After: 5`, scratch empty |
| 12 | both transfer slots held → `503 {"error":"busy"}` with `Retry-After: 1` |
| 13 | the same `shape.test.ts` AC19 case, extended to the `import` payload — and only payloads the shaper builds |
| 14 | `scripts/api-smoke.sh` uploads a book and finds it by id, end to end, on an isolated profile |
| 15 | the two Scope sentences corrected in place, each naming what it used to say and why it changed |

## Verification plan

Gates: `npm run typecheck`, `npm run lint`, `npx prettier --check` on the touched files, `npm test` (**1379 in 58 files** as `ddae4c0` left it, plus this slice's cases), `bash -n scripts/api-smoke.sh`, and the smoke script itself against a live app on an **isolated profile**. Then the mutation campaign over this slice's deciders — one mutant per half of any paired assertion (the `401` and its `WWW-Authenticate` header are two claims; `503 busy` and its `Retry-After` are two), run with `scripts/mutation-campaign.py` from the `musaeum-slice-workflow` skill.

**The harness slice 1 did not need:** a live server needs a profile with `rest_api_enabled` on and a token, and the smoke script refuses to run without an isolated one. Slice 2's first act is to stand that profile up and name it in this annex's results table — value, instrument, and the pre-fix value beside it — so the next session re-runs rather than rebuilds.

## Start here

```bash
git log --oneline -3
npm run typecheck && npm run lint && npx prettier --check electron/main/api/rest.ts electron/main/services/api/routes.ts electron/main/services/api/shape.ts
npm test                      # expect 1379 in 58 files, plus this slice's cases
bash -n scripts/api-smoke.sh
```

Read, in order: `electron/main/api/rest.ts` — the routing switch and its method policy, the transfer gate, `sendBytes`, and the `ServerOptions` seams this slice extends with a third; `electron/main/services/api/upload.ts` — the module the route maps to statuses, and the only place the refusal reasons are defined; `electron/main/services/api/routes.ts` — why the bare path is invisible today (`:30`, `:66`); then `docs/rest-api.md`'s route table, errors table and *Not in this version*, the three places the document moves.
