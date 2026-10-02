# The iOS companion, slice 1b — the read surface

**Date:** 2026-09-22
**Slice:** 1b of four (1a, 1b, 1c, 2) — **1a is built and green; 1b is not started.** **5 code files, 2 test files, 2 contract artifacts**, as the spec's row says, plus one edit the build will find (the health route's count, below — no new file, so the row's arithmetic holds).
**Annex to:** `docs/superpowers/specs/2026-09-22-ios-companion-design.md` (the spec; D1–D15 and the acceptance criteria live there)
**Read first:** the spec's D2, D7, D9, D11 and D15, its *The wire, concretely* route table, and its **Slice 1b criteria (9–19 plus 15a)** — then the code 1a landed, because this slice extends it rather than starting beside it: `electron/main/api/rest.ts` (the routing switch is the seam the routes slot into, and the auth check already runs before it), `services/api/bind.ts`, `services/api/auth.ts`, `services/settings.ts` (`resolveRestApiConfig()` is what the server runs with), `services/book-bytes.ts` (`resolveBookFile` — reuse, never re-derive).

---

## What this slice is, in four lines

1. **The read surface behind the same credential 1a shipped.** List, search, detail, cover bytes, file bytes. Nothing new listens, nothing new authenticates — the routes go inside the existing `handleRequest` switch, after the existing auth check.
2. **Every route is a thin wrapper over a query that already exists.** `db.getBooks` / `db.searchBooks` gain `limit`/`offset`/total; the byte routes call `resolveBookFile`/`resolveCoverFile`. No second SQL path, no second path-resolution rule — invariants 2 and 4 are the reason, and AC12 is the guard that the unpaginated call still behaves exactly as it does today.
3. **One document and one shaper, and they are each other's decider.** `services/api/shape.ts` holds the wire's field names; `docs/rest-api.md` names the same ones; the golden cases fail when the two drift (AC19). This pair is the whole reason a client in another repo can be built without a phone in the loop.
4. **Two byte routes and a cap of 2.** The overflow answers 503 + `Retry-After` (D9). The file route takes `Range: bytes=N-` and answers 206 with the file's **tail** (D15/AC15a).

## Readings this session settled — none of these are open questions any more

1. **The tailnet address is visible to the app.** `os.networkInterfaces()` from inside the Electron main process (Electron 37.10.3) returns `lo0 127.0.0.1 (internal)`, `en0 192.168.1.10`, `utun9 100.64.0.1`, `utun8 10.0.0.2` — identical to plain node. A CGNAT (`100.64.0.0/10`) filter therefore selects `utun9` uniquely and does **not** pick up the other tunnel. Not verified: the same read from the *packaged* build under launchd's minimal environment — the enumeration is a syscall and the address is on the interface, so the residual is that nobody has watched a packaged launch do it.
2. **The default port is 8788.** `8787` is the a local web UI on this machine and `9119` another python listener; `lsof -nP -iTCP:8788` returns nothing. **A bind test is not evidence here:** macOS is BSD, where `SO_REUSEADDR` lets a specific-address bind *succeed* under a wildcard listener (both 8787 and 9119 bound cleanly in a probe while already held) — a build that chose its port by trying to bind it would have taken traffic from the WebUI and looked correct doing it. Use `lsof`.
3. **The library's largest books are not small, so downloads are resumable (D15).** 80 books hold an EPUB over 100 MB and the largest EPUBs are 528 MB, 285 MB, 175 MB, 157 MB (*Kurashi at Home*, *Light From the Void*, *Cosmic Queries*, *Your Ticket to the Universe*) — the files themselves, checked on disk after the folder totals turned out to be ambiguous. The full EPUB census: 1,505 under 1 MB, 2,175 at 1–5 MB, 995 at 5–20 MB, 569 at 20–100 MB, 80 over 100 MB. The spec's deferred range-request item had a revival condition naming "a 6 MB mobi" — a guess, and it fired against itself. **AC15a's decider hashes the tail** (`readFileSync(path).subarray(N)`), because a server that ignores `Range` and re-sends the head still answers 206-shaped bytes.
4. **The health route's book count is the one thing 1a left for this slice.** `healthPayload()` counts with `getBooks().length`, which loads and maps all 7,100 rows on the route the phone uses as a connect check — ~115ms by the repo's own measurement of that call. Replace it with this slice's paginated total; **do not replace it with a second `COUNT(*)` carrying its own filter rules**, which is the drift invariant 4 exists to prevent.
5. **1a's shape, so nothing is rebuilt:** the status record is read with `getRestApiStatus()` (a copy) and the lifecycle is now symmetric — `stopRestApi()` closes the listener, is idempotent, and records `failed` rather than `disabled` if the close fails, because a status claiming a dead socket over a live one is the lie it exists to prevent. Tests reach the real handler over `listen(0, '127.0.0.1')` and read the assigned port back; **no case may bind this machine's real tailnet address** — the address resolver is fed fixture maps.
6. **The cover route's 400/404 split, and the spec text that had it wrong — read this before writing `resolveCoverFile`.** The handler 1b is extracting from answers **400** for a traversing `coverThumbPath`/`coverFullPath` (`electron/main/index.ts:72`) and **404** for a missing root, book or cover (`:69`), and **any size that is not `thumb` serves the full cover** (`:68`) — there is no such refusal as "a size it does not know". AC13 as first written asked for one `null` covering all three, which cannot carry that split and asserted a refusal that does not exist; it was corrected in place on 2026-09-22 **before this slice was dispatched**, and AC14's traversing-path status was corrected from 404 to 400 with it. The resolver must let the caller tell the cases apart; the route may be stricter than the handler on `size` (400 for anything but `thumb`/`full`), and the resolver keeps the handler's lenient branch for the renderer's fixed sizes.

## Files

| File | New/Edit | Why |
|---|---|---|
| `electron/main/services/api/shape.ts` | New | The wire's field names, in one place — the payload shaper the goldens pin. **It also takes `healthPayload()`** (pre-merge review, 2026-09-22): 1a composes that payload inside the thin layer while D10 assigns response shaping to this file, so 1b moves it rather than shaping one payload in two places. |
| `docs/rest-api.md` | New | The contract document the client repo is written against. **It must state the HTTP-method policy explicitly** — 1a's health route matches `GET` only, so `HEAD /api/health` answers 404 today, and a client that probes with `HEAD` (URLSession will) meets a 404 where a connect check belongs. Either the table says GET-only or the routes answer `HEAD`; do not leave it unstated, which is how it is now. |
| `scripts/api-smoke.sh` | New | End-to-end PASS/FAIL per route against a live app on an isolated profile. **This is AC2's second decider** — the unit half landed in 1a, so the criterion is half-discharged by design. |
| `electron/main/api/rest.ts` | Edit | The routes in the existing switch; `healthPayload()`'s count |
| `electron/main/services/db.ts` | Edit | `limit`/`offset`/total on the two existing builders |
| `electron/main/services/book-bytes.ts` | Edit | `+resolveCoverFile` (the extraction AC11 pins) |
| `electron/main/index.ts` | Edit | The `musaeum://` handler calls the extracted resolver |
| `electron/main/services/api/shape.test.ts` | New | The golden payloads |
| `electron/main/services/book-bytes.test.ts` | Edit | The extraction's cases |

Nine files, as the row says; the tenth thing to change is the health count inside `api/rest.ts`, which the row already counts.

## What must not move

- **Invariant 9:** the renderer never gets `file://`, and both the library root and the candidate get `realpath`ed. The byte routes call `resolveBookFile` — they do not re-implement the rule, and a "small" path check in the HTTP layer is the finding to reject.
- **Invariant 2:** every file lookup resolves by extension. `?format=` selects a format the book *has*, and a book renamed after import must still serve.
- **Invariant 4:** sort keys are derived at every write path; sorting stays in the existing SQL (D7), and the routes add no ordering of their own.
- **Invariant 8:** the HTTP layer stays thin. A route decides nothing — the query, the shaper and the path rules all live in `services/`.
- **Invariant 12:** a failed read, an offline NAS and a stalled transfer are statuses, never throws out of a request. The NAS-offline answer is 503.
- **The auth check stays before the routing switch**, so an unauthenticated request reaches no route logic and cannot learn a route exists.
- **No credential in any payload, log or status record.** The token is in `values` for the Settings row and in `resolveRestApiConfig()` for the server, and nowhere else.
- **`getBooks()` with no `limit` behaves exactly as today** (AC12) — the existing suite is the decider.
- **No CSP change** (AC7: `git diff --quiet index.html`), no new dependency, no new `musaeum://` host.

## Start here

```bash
git log --oneline -3        # 2477944 — 1a landed there; this spec, the roadmap entry and this annex are in d06f402
npm run typecheck && npm run lint      # both 0
npm test                    # 51 files / 1101 tests (1a added 3 files and 75 cases to the 1,026 baseline)
sidecar/.venv/bin/python -m pytest -q sidecar/tests   # 113 passed
```

**Then read, in this order:** the spec's route table, then D15, then the readings above, then `rest.ts`'s `handleRequest` — and start with `git log` rather than this conversation, because everything 1a did is in the tree and not in the chat.
