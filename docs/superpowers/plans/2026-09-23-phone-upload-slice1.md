# Phone upload — slice 1: the upload's own half

**Date:** 2026-09-23
**Slice:** 1 of 3 — the upload's own half (no route, no contract)
**Annex to:** `docs/superpowers/specs/2026-09-23-phone-upload-design.md`
**Read first:** the spec's *Why now*, *D2*, *D3*, *D4*, the Slice 1 acceptance criteria, and its *Not verified* list — this annex settles the two readings that list leaves open and nothing else. The spec's D1, D5, D6, D7 are slice 2's and are **not** re-opened here.

---

## What this slice is

Four things, in one coherent piece, none of which needs a socket:

1. The import path can be told `duplicate: 'add-new'` — the gate still detects and still builds its context, but does not suspend — and the context comes back on the `ImportResult` (spec D3, AC1–AC3).
2. A body handler that streams a request's bytes to a scratch file, bounded by a size cap and a **stall** clock, never holding the body in memory (spec D4, AC4–AC6).
3. The scratch-file lifecycle: a per-upload directory under `userData`, removed on every exit path (spec D2, AC7).
4. The query validation D1 fixes (`format` required and one of four, `filename` required and safe) — decided here, so the route in slice 2 is a mapping and not a second validation.

It stops before the route: no `POST /api/books` arm, no `import` payload, no document change, no change to `apiVersion`. `docs/rest-api.md` and `shape.test.ts` do not move in this slice.

---

## Readings this slice settles

The approved spec left two things unmeasured and says so. Both were discharged **before** the first line of `upload.ts` was written, as the spec's own *Not verified* list requires.

### R1 — what a Mac-bound upload costs, and therefore the stall threshold

Measured 2026-09-23, read-only, with a throwaway harness outside the repo (`~/.hermes/profiles/dev/cache/scratch/upload-probe/`: `server.mjs` + `run-probe.sh`, both retained there — the instrument is a `node:http` listener that streams each POST body to disk and reports MiB/s, chunk count and the chunk-arrival gap distribution).

| Path                                  | Payload     | Result                                                                              |
| ------------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| this Mac's tailnet address `100.125.135.108` | 64 MiB      | 67.0 MiB/s cold, 148.3 MiB/s warm; 3,790 / 8,926 chunks; gap p50 0.03 ms, p99 5.3 ms, **max 80.3 ms** |
| this Mac's tailnet address            | 320 MiB ×2  | 157.3 / 139.5 MiB/s; gap p50 0.02 ms, p99 0.43 / 0.58 ms, **max 20.8 / 99.7 ms**     |
| this Mac's LAN address `192.168.1.103` | 320 MiB     | 484.3 MiB/s, max gap 15.5 ms                                                         |
| `speed.cloudflare.com/__up` (WAN)      | 64 MiB ×2   | **1.18 / 1.48 MB/s** — this Mac's *uplink*, i.e. the wrong direction, recorded for what it is |

**What these numbers are, and what they are not.** All three local rows are **short-circuited**: 157 MiB/s and 484 MiB/s both exceed this Mac's 1 GbE ceiling, so neither traversal crossed a wire. They bound the *server side* — Node's HTTP reader plus the tailscale userspace stack plus a disk write — at ~140–160 MiB/s, and say the Mac is not the constraint. No controllable second tailnet host exists for a genuine push (the only other online Mac, `canismajoris`, refuses `:22` and every common port). So the phone's own path is **not** in this table, and the threshold is set with a margin rather than from it.

**What the topology does settle.** `tailscale ping almach` (the iPhone): **direct**, `via 192.168.1.122:41641`, **138 ms** — the phone is on this LAN and not DERP-relayed, so a phone-to-Mac upload today is a LAN path over WireGuard, not a WAN one. The 138 ms RTT is radio latency, not a throughput bound.

**The reading:** the observed worst inter-chunk gap on a real 320 MiB stream is **99.7 ms**, and the p99 across every run is **7.5 ms**. A stall clock is reset by the *first byte of the next chunk*, and TCP delivers at MTU-sized pieces as long as the link lives, so a live client at even one-fiftieth of the slowest measured rate still produces gaps ~5 s apart. **`UPLOAD_STALL_MS = 30_000`** — a 300× margin over the worst gap measured, and 3× the read surface's own total-body bound (`BODY_TIMEOUT_MS = 10_000`), which is the same failure class bounded *harder* here because this clock is reset rather than absolute.

**Reversal condition:** a real upload from `almach` on a cold radio (or any client on a distant tailnet) whose gaps approach seconds. If that shows up, the threshold moves — and the phone's own request timeout is what decides whether the feature is usable at all (spec *Risks* #1).

**The cap is unchanged at 1 GiB (spec D4).** The measurement has nothing to say about it: the census behind it (largest EPUB on the share, 528 MiB) is the constraint, and none of the sizes above exceeded it. Recorded rather than restated.

### R2 — whether the import path can carry a policy without disturbing the Mac's own gate

The spec's prediction was yes, and that the gate's detection (`services/importer.ts:165-178`) and its suspension (`:180-199`) are separable with `'ask'` staying the default. **Confirmed, and the decider is the existing case run unchanged** — `test/…`/`importer.test.ts` → *the import duplicate gate* → `blocks on an ISBN-13 match even when title and author look unrelated`, which asserts the gate emits `awaiting_dedup_decision`, that `getBooks()` is still 1 and `books/` still holds only `['existing']` while it is open, and that it does not settle. It passes **untouched** after the change (AC2), and the whole four-case `resolveDuplicate` / `abortPendingDecisions` group passes with it — so no product decision reopens and the policy stays on `addFiles` rather than moving up a level (which would have changed D3's shape).

---

## Readings settled inside the slice (the spec did not name them)

### S1 — where the arriving filename's bytes go, and why the file keeps the client's name

`titleFromFilename` (`services/importer.ts:114-116`) derives a book's title from the *path's basename*, so the scratch file has to be named what the client called it, or the book lands titled after a temp name (the exact outcome D1's "required `filename`" exists to prevent) — and yet D2 requires a unique path, because two phones uploading `book.epub` must not collide.

**Both hold with one directory per upload:** `{userData}/uploads/{uuid}/{safe basename}`. Uniqueness lives in the directory; the basename stays the client's. `safeFileName()` takes `path.basename()` (so `../../etc/passwd` is `passwd`, and a Windows-style `..\..\x` is stripped too), drops NUL and leading dots, refuses a result that is empty or extension-only, and forces the declared format's own extension if the client's name disagrees with `format`. The last clause is not cosmetic: the importer keys every lookup on the extension (invariant 2), so a name arriving as `book.txt` with `format=epub` would be a file the pipeline cannot see. A `filename` that sanitizes to nothing is a 400 the phone can fix — the same posture D1 takes for a missing one.

### S2 — the refusal at the cap resolves at the *breach*, not at `end`, and the body keeps draining

`readJsonBody` (`electron/main/api/rest.ts:398-467`) drains past its cap because breaking early would destroy the socket and answer a reset instead of a 400 — and because a 4 KB body's drain is free. Neither holds here: the body is unbounded, so "drain everything" can mean discarding 100 GiB. **The handler therefore stops writing, removes the scratch file, and answers `too-large` at the moment the cap is crossed** (so the route can answer 413 while the body is still in flight), **while leaving a drop-only `data` listener attached** — no memory, no disk, and the client's remaining bytes still flow, which is what gives the 413 the best chance of arriving rather than a reset.

**What this does not decide, and who owns it:** whether the *client actually reads* that 413 when it is still mid-body is a socket question. Slice 2 owns it, with a real connection (AC9/AC10's instrument) and one stated fallback if the delivery proves unreliable: drain-then-answer, priced as a wait on bytes that are already refused.

### S3 — the gate's context reaches the phone through the **result**, not the progress event

The spec (AC3) fixes the decider — over the return value — and the importer's own comment at `:201-204` fixes why the *progress* channel stays clean: `duplicate` on a progress payload has one meaning from the copy onward, a collision **hydration** found, and re-introducing the gate's context there would make the finished card present it as a post-hydration finding. So under `'add-new'` nothing is emitted for the gate; the Mac's import card shows the ordinary `received → extracting → copying → hydrating → done` run, which is right for an upload nobody answered by hand.

### S4 — a stall is not a destroyed socket, and an offline share is refused before a byte is accepted

On a stall the handler detaches and resolves, exactly as `readJsonBody` does at its own timeout (`:438`) — no `req.destroy()`, so slice 2 answers in the documented vocabulary (the reading route already calls a body that never finished arriving a 400). And the share check runs **before** the body is read, not after: refusing "offline" after accepting 528 MiB would put the phone's bytes across the link twice for nothing, which is the cost D2 explicitly avoids. The consequence for AC7 is stated plainly: on the offline path there is nothing to remove because nothing was written, and the criterion asserts the directory is empty precisely to pin that ordering.

---

## Files

| File                                          | What                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `electron/main/services/api/upload.ts` (new)   | `MAX_UPLOAD_BYTES`, `UPLOAD_STALL_MS`, `parseUploadQuery`, `safeFileName`, `uploadScratchDir`, `receiveUpload`       |
| `electron/main/services/api/upload.test.ts` (new) | AC4–AC7 and the validation/sanitisation cases — socketless, on a `Readable` stand-in for the request               |
| `electron/main/services/importer.ts` (edited)  | the `duplicate` policy arm; the context on the result; `ImportResult.duplicate` reached through the existing copy path |
| `electron/main/services/importer.test.ts` (edited) | AC1 and AC3's cases; AC2 is decided by the file's **existing** gate group, unchanged                                |
| `src/types/book.types.ts` (edited)             | `ImportResult.duplicate?: DuplicateContext` — additive, and the only shared-contract change                          |
| `docs/superpowers/plans/2026-09-23-phone-upload-slice1.md` (new) | this annex                                                                           |

Six files: five code/test plus this document. Inside the ~10-file bound, and the slice's own criterion set needs no socket, no schema change, no migration, no `app_config` key, no renderer file and no new dependency.

## What must not move

- `addFiles(paths)`'s one-argument call sites (`ipc/library.ts:83`, `file-watcher.ts:36`) and the preload surface (`src/types/api.types.ts:118`) — the policy is optional and its default is the existing behaviour (AC2).
- The `awaiting_dedup_decision` step and everything keyed to it: `resolveDuplicate`, `abortPendingDecisions`, the renderer's dialog.
- `readJsonBody`, `MAX_BODY_BYTES` (4096), `BODY_TIMEOUT_MS` (10 000) — the upload's handler is its own function, not a widening of that one (spec D4's Consequence).
- `imports/` and `services/file-watcher.ts` — untouched by decision (D2).
- `docs/rest-api.md`, `services/api/shape.ts`, `shape.test.ts`, `scripts/api-smoke.sh` — all slice 2.

## Acceptance criteria, each with its decider

| AC  | Decided by                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `importer.test.ts` — a new case: seed a duplicate, `addFiles([src], { duplicate: 'add-new' })`, assert a completed result and no `awaiting_dedup_decision` in the progress log |
| 2   | `importer.test.ts` — the **existing** *blocks on an ISBN-13 match* case, run unchanged, plus the existing `resolveDuplicate`/`abortPendingDecisions` group |
| 3   | `importer.test.ts` — the returned `duplicate` context, field for field, against the same seeded pair                            |
| 4   | `upload.test.ts` — a multi-chunk body larger than 4096 bytes: sha256 of the file on disk against the bytes sent, plus a chunk-count/`stat` bound (never a heap read) |
| 5   | `upload.test.ts` — past the cap: outcome is the refusal, `importer.addFiles` was **never called** (spy), scratch empty         |
| 6   | `upload.test.ts` — a prefix then silence past the threshold refuses; a slow-drip stream that outlives the threshold but never stalls is accepted |
| 7   | `upload.test.ts` — `readdir` of the scratch root after each of: success, cap breach, stall, offline, bad parameters, import failure |
| 15  | slice 2 (the document and the companion spec's Scope sentence are corrected where they land, not here)                          |

## Verification plan

Gates: `npm run typecheck`, `npm run lint`, `npx prettier --check` on the touched files, and `npm test` (baseline on `a2e9be9`: **1344 tests / 57 files, 1340 pass, 4 red in `python-env.test.ts`** — order-dependent and pre-existing; that file is 24/24 green in isolation). Then the mutation campaign over this slice's deciders, run with `scripts/mutation-campaign.py` from the `musaeum-slice-workflow` skill, with one mutant per half of any paired assertion.

Not in this slice's gates: the smoke script and any live-server check (both slice 2).

## Built (2026-09-23)

Landed in one working-tree change, at the six files the table above names — the annex's own count held (the roadmap row's ~5 was the optimistic one). `typecheck` 0 / `lint` 0 / `prettier` clean on every touched file / **`npm test` 1379 passed in 58 files, 0 failed** (from 1344 / 57 on `a2e9be9`; +35 cases, one file). Both readings above were discharged **before** the code they bear on, as the spec's *Not verified* list requires, and neither prediction was wrong: **R2**'s decider — the existing *blocks on an ISBN-13 match* case — passes untouched, so the policy sits on `addFiles` and D3's shape is unchanged.

**The mutation campaign: 23 of 23 killed** in the build round, plus 3 of 3 in the repair round after the reviews (below), every mutant restored with its hash verified. Its value is not the number — it is the three deciders it found to be **vacuous**, which a green suite had been certifying:

| Instrument as first written | Why it decided nothing | Repair |
| --- | --- | --- |
| `yielded() === 0` asserted **synchronously** after a refusal (AC9/AC11's "no byte was consumed") | A flowing stream pulls its first chunk on a *later tick*, so the count was still 0 for a handler that **had** started reading — the mutant survived | `await delay(20)` before the assertion; both mutants now die |
| `stream.destroy(new Error('late'))` after the answer | Destroying an already-ended stream emits nothing, so the case could not fail whatever the module did | `emit('error', …)` inside `expect(…).not.toThrow()` |
| A "flush failure" built from a `Writable` whose `final` errors | That reports through the `'error'` **event**, which the module already handled — so the case passed for the wrong reason and could not see the real defect | A **real `fs.WriteStream` whose open fails**, which reproduces the ordering instead of imitating it |

**The pre-merge review round, and the defect no case in this slice could see.** The reviewer was read-only by design; the fixes below are the parent's. **Blocking:** `out.end(() => finish({ ok: true, … }))` discarded the callback's error argument — and node invokes that callback with the write stream's error **before** the `'error'` event, so the success resolve won the `settled` race and the importer could be handed a **short (or absent) file**. The reviewer reproduced it twice against the unmodified module, with a real `EFBIG` (`ulimit -f 1`, a 3,145,728-byte body answered `{ ok: true, bytes: 3145728 }` while the file on disk held 1,024 bytes) and a real `ENAMETOOLONG`. That is the failure **D2/D4 exist to prevent** — a row claiming a size for bytes that are not there — and it lived one layer *below* where every criterion in this slice was looking, which is why it is recorded here rather than quietly patched. The success path now reads the callback's argument, and the third row of the table above is the case that decides it.

**Nine smaller findings, all fixed in the same pass:** an empty body refused `internal` where the vocabulary's `bad-request` is the client's own 400 (the rule `api/rest.ts` states — never a 500 for the client's mistake); **no bound on the sanitised name**, so a ~251-character `filename` produced `ENAMETOOLONG` and a 500 — now refused past 255 bytes, the filesystem's `NAME_MAX`, decided at the 255/256 boundary; a name that *is* an extension (`.epub` was accepted and became `epub.epub`, a book titled "epub"); the same docblock paragraph stated twice; **`out.write()`'s return ignored**, so the backpressure S2's docblock claimed did not exist — the request is now paused on a false return and resumed on `'drain'`, and a one-byte high-water mark makes a slow target decidable in the suite; a dead `filePath` on the outcome (the scratch file is removed by then — slice 2 needs the bytes and the result, not a path); no listener surviving the answer, so a later `'error'` on the request threw; and a share that goes away **between** the pre-body check and the copy flattened to `internal` — now `offline`, so slice 2 reaches its 503 on both paths without string-matching the importer's prose. Two decisions the build made that the spec did not name: `safeFileName` refuses a name past `NAME_MAX` (a 400 the phone can fix, not a 500 it cannot) and the same sanitisation is what slice 2's AC9 asserts; and the `UploadOptions.writeStream` seam exists **only** so a write failure is decidable without a full disk — its default is exactly `fs.createWriteStream`, so production behaviour is unchanged.

**Corrections to this annex's own text, recorded rather than rewritten:** R2 quotes the importer's pre-change line numbers (`:165-178` detection, `:180-199` suspension); this slice's edit inserts the options record and the policy arm above them, so they have moved. S1's "refuses a result that is empty or extension-only" was written as intent and was **not** true in the first build — the extension-only half was one of the review's nine findings, and it is true now, with its own case.

**Second review of the fix pass: no blocking findings** — over the frozen tree, with the write-stream lifecycle as its focus. It proved the defect closed in *both* directions, which is the only shape of evidence worth having here: with the fix reverted, a real open failure answers `{ ok: true, bytes: 4096 }` while the importer is handed a file that **does not exist**, and a real `EFBIG` answers `ok` over a 1,024-byte file; with the fix in place, both refuse, `addFiles` is never called, the scratch root is clean, and the node ordering the docblock claims is literally observed (`endcb:ENOENT → error:ENOENT → close`). It also mutation-tested this slice's new deciders rather than trusting them — the open-failure case fails against the pre-fix mutant, the backpressure case fails without the pause, and the reloaded `yielded()` assertions fail against a handler that reads before it refuses. It found no new defect and three items narrower than they claimed, all fixed: **the extension-only rule missed the dotless spelling** (`epub`, `...epub` → `epub.epub`; the test is now on the dotless stem, which is what the extension is appended to); **a pause-induced silence was answered `stalled`**, blaming the client for the local target's slowness — now `internal`, with the third case named in the clock's docblock; and **the `?? failed` fallback was unreachable** — the stream's `'error'` handler always answers first — so it is deleted. **Repair-round campaign: 3 of 3 killed**, including the blocking decider re-run against the new code. Its one reading for slice 2: an `internal` refusal's `message` is the filesystem's own and carries this machine's paths, so the route maps the status and does not echo the string.

## Start here (slice 2)

```bash
git log --oneline -3
npm run typecheck && npm run lint && npx prettier --check electron/main/services/api/upload.ts
npm test                      # expect 1379 in 58 files, 0 reds
```

Read, in order: `electron/main/api/rest.ts:266-366` (the transfer seam, the gate and `sendBytes`, whose shape the upload's route arm mirrors), `:532-673` (the routing switch and its method policy), `:675-723` (`ServerOptions` — the two seams slice 2 extends with a third), `electron/main/services/api/upload.ts` (this slice's contract: what the route maps to 400/413/503), then `docs/rest-api.md`'s route table, `errors` table and *Not in this version* (the three places the document moves).

Slice 2 inherits, settled and not to be re-derived: the cap (1 GiB), the stall clock (30 s, R1), the scratch location and per-upload directory (S1), where the refusal resolves (S2), that the gate's context travels on the result (S3), that the offline check precedes the body (S4), and the outcome's refusal vocabulary — `bad-request`, `too-large`, `stalled`, `offline`, `internal` — with a share that vanishes *mid-import* now answering `offline` too, so the 503 needs no string-matching (the review's ninth finding). Slice 2 must settle itself: what the client actually *sees* when a 1 GiB-plus body is refused mid-flight (S2's open half), and whether `POST /api/books` needs `HEAD` (the method policy's own sentence says the JSON routes answer it; this one takes a body).
