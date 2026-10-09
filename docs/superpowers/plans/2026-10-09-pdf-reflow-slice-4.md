# PDF Reflow Slice 4 — The Wire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone can ask the Mac for a PDF-only book's reflowed EPUB over the REST API: `reflow` is reported on the book payload, `GET /api/books/{id}/file?format=reflow` produces the artifact on demand (202 while it runs, the bytes when done, a named refusal when the book cannot be reflowed), and the contract, its goldens and the smoke script all say so — in this repo, first.

**Architecture:** The contract document leads (D8, iOS invariant 1). `shape.ts` gains one pure rule, `isReflowEligible` (a PDF and no EPUB — D1's trigger), and one pure member, `reflow: { available }`, so the list path stays NAS-independent (AC16). `services/reflow.ts` gains a read-only view of the pass it already runs (`wireStatus`, fed by the frames it already receives) and a short-lived memory of refusals. `api/rest.ts`'s `file` branch gains a `format=reflow` arm that never goes through `resolveBookFile` (which stays closed to it); it joins or starts the pass, and answers 202 / 200 / 422 / 404 / 503.

**Tech Stack:** TypeScript (Electron main), vitest via `npm test`, bash + curl + jq for `scripts/api-smoke.sh`.

**Spec:** `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` (D1, D6, D8, D10, slice 4 row); inheritance list in `docs/superpowers/plans/2026-10-09-pdf-reflow-slice-3.md` → _What slice 4 will need from this one_. Read `docs/rest-api.md`, `docs/invariants/reader.md` and `docs/invariants/settings-and-editing.md` (the API flag) first.

**Scope boundary:** This plan is the **Mac half only**. The iOS half (`../musaeum-ios`: `ContractModels.swift`, `BookDetailScreen.swift`, `MusaeumClient.swift`, `DownloadStore.swift` + tests) crosses a repository the spec says "must be attached to the thread before it can be edited" (spec open question 5). It is the follow-on plan once this lands and `../musaeum-ios` is attached; Task 6 leaves it everything it needs.

## Owner decisions (2026-10-09) this plan implements

1. **Availability is eligibility, not presence.** `reflow.available` is true iff the book holds a PDF and no EPUB. No filesystem read, no schema change. The cost: `true` is a promise the file route keeps by *producing* the artifact, not by finding it, and it can answer a named refusal (a book with no text layer).
2. **The phone triggers the pass; the wire is 202 + poll.** This also closes slice 3's R6: the 45 `mobi`+`pdf` papers have a producer now, because the phone asks.

## Deviations from the spec's D8, for the reviewer to accept or reject

- **D8 says the member reports "availability and version". This plan ships `available` only.** The version (`converter` in `derived/reflow.json`) is a filesystem fact, and owner decision 1 keeps the payload off the filesystem. A client wanting a cache key gets one from the route: the 200 carries `ETag` derived from the artifact's size and mtime (Task 3). If the owner wants `version` on the payload anyway, that is a persisted field (a `metadata.json`/schema change, `contracts-engineer`) and a new plan.
- **The error table gains one refusal with a second member.** 422 `{"error":"cannot reflow","reason":"<the pipeline's sentence>"}`. Every other refusal is `{ "error": … }` alone; the phone needs the sentence for its toast (D6/AC4), and the Mac already has it. `API_ERRORS` gets `cannotReflow`, so the word has one home.
- **`API_VERSION` stays 1.** `shelves` was an additive member under the same rule; a client that does not know `reflow` ignores it, and the phone checks `reflow?.available`.

## Global Constraints

- Invariant 8: logic in `services/`; `rest.ts` stays a router. Invariant 9 / 2: the new arm resolves through `book-bytes.ts` (`resolveReflowFile`), by its fixed name, realpath'd on both sides — never a second resolver.
- Invariant 12: nothing throws out of a request; a pre-flight rejection (`sidecar.assertAvailable`, "no PDF file") is a 422, not a 500.
- `resolveBookFile` must **still** answer `null` for `reflow` (its `FORMATS` is untouched) — the wire opens deliberately, in `rest.ts`, not by accident in the shared resolver.
- `shape.ts` imports nothing from the filesystem, the NAS or Electron (its import list is pinned by a case).
- `docs/rest-api.md` and `shape.ts` change together; `shape.test.ts` holds them field for field (AC19). Prose in `.md` is not hard-wrapped.
- `metadata.json`, `catalog.json` and the SQLite schema are untouched.
- Byte transfers share the two-slot gate (D9); a 202 holds no slot.
- Gates after every task: `npm run typecheck && npm run lint && npm test`.

## Review Focus

1. **Two polls for one book start one pass.** The second GET during a running pass answers 202, never a second `reflow_pdf` call (`reflow.ensure`'s map already dedupes; the route must go through it, and must not call the sidecar itself). Pinned in Task 3.
2. **A refused book does not re-run on every poll.** A `fallback` result is remembered for 60 s and answered 422 without a new pass; after the TTL a GET starts a fresh one. Pinned in Task 2.
3. **An ineligible book cannot be probed.** A book with an EPUB, an unknown book and a traversing `nasPath` all answer the same uniform 404 as `format=banana`. Pinned in Task 3.
4. **The share goes away mid-pass.** Offline at request time is 503 `library offline` before any pass starts; the phone's next poll after a drop gets the same 503, not a 500. Pinned in Task 3.
5. **A pass that outlives the request.** The client hanging up must not cancel the pass or leave the in-flight entry behind; the artifact lands and the next GET is 200. Pinned in Task 3 (the route awaits nothing the client's socket owns).

---

## File Structure

- Modify `electron/main/services/api/shape.ts` — `isReflowEligible`, `WireReflow`, the `reflow` member of `WireBook`, `reflowPendingPayload`, `cannotReflowPayload`, the new `API_ERRORS` word.
- Modify `electron/main/services/api/shape.test.ts` — the golden's book gains the member; new cases.
- Modify `electron/main/services/reflow.ts` — `wireStatus(bookId)` and `recentRefusal(bookId)`; the progress subscription also records the latest frame.
- Modify `electron/main/services/reflow.test.ts` — cases for both.
- Modify `electron/main/api/rest.ts` — the `format=reflow` arm.
- Modify `electron/main/api/rest.test.ts` — the route's cases (mocks `reflow` and `book-bytes` the way the byte routes' block does, `describe('the byte routes')` at line ~1591).
- Modify `docs/rest-api.md` — the book payload block + member sentence, the file route, the errors table, failure semantics, _Not in this version_ untouched.
- Modify `scripts/api-smoke.sh` — one new section.
- Modify `tasks.md`, `CHANGELOG.md`, `docs/invariants/reader.md` (one rule: the wire's reflow arm), `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` status line — Task 6.

Eight code/doc files for the wire plus the record; the spec's "docs + 3 files + goldens + smoke script" plus `reflow.ts` (the status the route reads) — one more than the spec's count, named here rather than discovered.

---

### Task 1: The contract first — `docs/rest-api.md`

**Files:**
- Modify: `docs/rest-api.md` (the `payload=book` block at line ~267, the member list under it, `### GET /api/books/{id}/file` at line ~325, the Errors table at line ~549, Failure semantics at line ~532)

**Interfaces:**
- Produces: the wire contract Tasks 2–5 implement, verbatim: the book member `"reflow": { "available": true }`; the route's four answers; the 422 body; the 202 body `{"phase": "page", "completed": 12, "total": 24}`.

- [ ] **Step 1: Add the member to the book golden.** In the `json payload=book` block, add after `"shelves": […]`:

```json
  "shelves": ["b2c3d4e5-6f70-4182-93a4-b5c6d7e8f901"],
  "reflow": {
    "available": false
  }
```

The golden book (_Leviathan Wakes_, `["epub","mobi"]`) holds an EPUB, so `false` is the honest value. The `library` and every other payload block that embeds a book needs the same member (`grep -n '"shelves"' docs/rest-api.md` finds each; `shape.test.ts` fails on any that is missed).

- [ ] **Step 2: Add the member's sentence** to the list of members that "deserve their own sentence" (it becomes five):

```markdown
- **`reflow`** says whether the book can be read as a reflowed EPUB: `available` is true exactly when the book holds a PDF and **no EPUB** (the one rule both clients share — an EPUB is the only format both engines render). It is a statement about the book's formats, **not** about whether the file already exists: the first request for it may take minutes, and see `GET /api/books/{id}/file?format=reflow` for how that is answered. A book with `reflow.available` is read by asking for `format=reflow` instead of `formats[0]`, and `reflow` is **never** a member of `formats` — that array still means the files the book holds.
```

- [ ] **Step 3: Document the route.** Under `### GET /api/books/{id}/file?format=epub`, extend the `format` sentence to include `reflow`, add the media-type row `| reflow | application/epub+zip |`, and add a subsection:

```markdown
#### `format=reflow`

The book's PDF laid out as an EPUB (`{book}/derived/reflow.epub`, produced by the Mac on first request and cached beside the book). Only a book whose payload says `reflow.available` answers it; every other book — one with an EPUB, an unknown id, a traversing folder — is the same uniform `404` as an unknown format. Answers:

| Answer  | When                                                                                                                                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **200** | The artifact is ready (found in the cache, or produced within this request's grace of 2 s). Same headers and `Range` rules as any file, plus `ETag` (`"<size>-<mtimeMs>"`).                                                                          |
| **202** | A pass is running for this book. `{"phase": "<phase>", "completed": N, "total": M}` with `Retry-After: 2`. `completed`/`total` are pages (0/0 before the first frame). Poll the same URL; **starting is idempotent**, so two clients or two polls run one pass. |
| **422** | The pipeline refused this book: `{"error": "cannot reflow", "reason": "<one sentence>"}` — no text layer, a layout it is not confident in, or the converter being unavailable. The answer is remembered for 60 s, so a poll does not re-run a doomed pass; after that a request tries again. |
| **404** | Not eligible (see above), or the PDF is gone.                                                                                                                                                                                                         |
| **503** | The share is not mounted (`Retry-After: 5`), or the byte budget is spent (`Retry-After: 1`) — a 202 holds no byte slot.                                                                                                                              |

A pass can take minutes (a 535-page book measured 176 s); the client keeps polling. Hanging up does not cancel it.
```

- [ ] **Step 4: Errors table.** Add a row `| 422 | cannot reflow | …` (with the second-member note: "the only refusal with a `reason`") and add 202 to nothing (it is not an error). In _Failure semantics_ add: `| A reflow pass is running or has been refused | 202 while running, 422 with the reason for 60 s after a refusal (see format=reflow) |`.

- [ ] **Step 5: Fix the stale sentence.** Line 1 says a payload change bumps the version; add to the status paragraph one sentence: "`reflow` (slice 4 of the PDF-reflow workstream, 2026-10-09) is additive and does not bump `apiVersion`, as `shelves` did not."

- [ ] **Step 6: Verify it fails against the code, which is the point.** Run `npm test -- shape` — Expected: FAIL (the golden has a `reflow` member the payload lacks). This is the red for Task 2.

- [ ] **Step 7: Commit** (docs only, tests red by design — say so):

```bash
git add docs/rest-api.md
git commit -m "docs(api): the reflow member and format=reflow, contract first (D8)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The shape and the service's view of a pass

**Files:**
- Modify: `electron/main/services/api/shape.ts`, `shape.test.ts`
- Modify: `electron/main/services/reflow.ts`, `reflow.test.ts`

**Interfaces:**
- Produces (`shape.ts`):
  - `isReflowEligible(book: Pick<Book, 'formats'>): boolean`
  - `interface WireReflow { available: boolean }`; `WireBook.reflow: WireReflow` (computed by `bookPayload` — no new parameter, so no route can forget it)
  - `interface ReflowPendingPayload { phase: string; completed: number; total: number }` and `reflowPendingPayload(status: { phase: string; completed: number; total: number }): ReflowPendingPayload`
  - `interface CannotReflowPayload { error: string; reason: string }` and `cannotReflowPayload(reason: string): CannotReflowPayload`
  - `API_ERRORS.cannotReflow = 'cannot reflow'`
- Produces (`reflow.ts`):
  - `wireStatus(bookId: string): { phase: string; completed: number; total: number } | null` — non-null exactly while `ensure(bookId)` is in flight; `{ phase: 'start', completed: 0, total: 0 }` before the first frame.
  - `recentRefusal(bookId: string): string | null` — the reason of a `fallback` result in the last `REFUSAL_TTL_MS` (60_000, exported), else null.
- Consumes: `orderedFormats` (already imported in shape.ts); `ensure`, `inflight`, `subscribeOnce` (existing).

- [ ] **Step 1: Failing tests in `shape.test.ts`.** Add to the existing `describe`:

```ts
it('reflow is available for a PDF with no EPUB, and for nothing else (D1)', () => {
  expect(isReflowEligible({ formats: ['pdf'] })).toBe(true)
  expect(isReflowEligible({ formats: ['mobi', 'pdf'] })).toBe(true) // the paper shelf
  expect(isReflowEligible({ formats: ['pdf', 'epub'] })).toBe(false) // order is irrelevant
  expect(isReflowEligible({ formats: ['epub'] })).toBe(false)
  expect(isReflowEligible({ formats: ['mobi'] })).toBe(false)
  expect(isReflowEligible({ formats: [] })).toBe(false)
})

it('the book payload reports reflow without touching formats', () => {
  const pdfOnly = bookPayload({ ...GOLDEN, formats: ['pdf'] }, [])
  expect(pdfOnly.reflow).toEqual({ available: true })
  expect(pdfOnly.formats).toEqual(['pdf']) // never a synthetic 'epub'
  expect(bookPayload(GOLDEN, []).reflow).toEqual({ available: false })
})

it('the pending and refusal bodies are exactly their documented members', () => {
  expect(reflowPendingPayload({ phase: 'page', completed: 12, total: 24 })).toEqual({
    phase: 'page', completed: 12, total: 24
  })
  expect(cannotReflowPayload('no page carries a text layer')).toEqual({
    error: 'cannot reflow', reason: 'no page carries a text layer'
  })
})
```

Run: `npm test -- shape` → FAIL (symbols missing; the Task 1 golden also fails).

- [ ] **Step 2: Implement in `shape.ts`.** Add to `API_ERRORS`:

```ts
  /** 422 — the reflow pass refused this book; the body also carries `reason`. */
  cannotReflow: 'cannot reflow',
```

Add after `WireReading`:

```ts
/**
 * Whether the book can be read as a reflowed EPUB — D1's trigger, stated once.
 * **Eligibility, never presence** (owner decision, 2026-10-09): the artifact
 * is a file on the share, and this module reads no files (AC16). Order is
 * irrelevant, so no `formats[0]` (invariant 3).
 */
export function isReflowEligible(book: Pick<Book, 'formats'>): boolean {
  return book.formats.includes('pdf') && !book.formats.includes('epub')
}

export interface WireReflow {
  available: boolean
}
```

Add `reflow: WireReflow` to `WireBook` (after `shelves`), and `reflow: { available: isReflowEligible(book) },` after `shelves` in `bookPayload`. Add at the end of the file:

```ts
// ---------------------------------------------------------------------------
// The reflow route's two non-byte answers (D8)
// ---------------------------------------------------------------------------

export interface ReflowPendingPayload {
  phase: string
  completed: number
  total: number
}

/** 202's body — the three members of the pass's own progress frame, named here. */
export function reflowPendingPayload(status: ReflowPendingPayload): ReflowPendingPayload {
  return { phase: status.phase, completed: status.completed, total: status.total }
}

export interface CannotReflowPayload {
  error: string
  reason: string
}

/** 422's body — the one refusal with a second member (the pipeline's sentence). */
export function cannotReflowPayload(reason: string): CannotReflowPayload {
  return { ...errorPayload('cannotReflow'), reason }
}
```

Run `npm test -- shape` → PASS. Also fix any other test that deep-equals a `WireBook` (`grep -rn "shelves:" electron --include=*.test.ts`); add `reflow: { available: false }` there.

- [ ] **Step 3: Failing tests in `reflow.test.ts`** (follow that file's existing sidecar mock and `resetForTests()` in `beforeEach`):

```ts
it('wireStatus is null when idle, the latest frame while a pass runs, null after', async () => {
  expect(reflow.wireStatus('b1')).toBeNull()
  const pending = reflow.ensure('b1') // sidecar mock holds the call open
  expect(reflow.wireStatus('b1')).toEqual({ phase: 'start', completed: 0, total: 0 })
  emitFrame({ book_id: 'b1', phase: 'page', completed: 12, total: 24 }) // the file's existing notification helper
  expect(reflow.wireStatus('b1')).toEqual({ phase: 'page', completed: 12, total: 24 })
  releaseCall({ status: 'produced', epub: 'x', pages: 24 })
  await pending
  expect(reflow.wireStatus('b1')).toBeNull()
})

it('a refusal is remembered for 60 s and a success clears it', async () => {
  vi.useFakeTimers()
  mockCall({ status: 'fallback', reason: 'no page carries a text layer', verdict: 'no_text_layer' })
  await reflow.ensure('b1')
  expect(reflow.recentRefusal('b1')).toBe('no page carries a text layer')
  vi.advanceTimersByTime(reflow.REFUSAL_TTL_MS + 1)
  expect(reflow.recentRefusal('b1')).toBeNull()
  vi.useRealTimers()
})
```

Adapt `emitFrame`/`releaseCall`/`mockCall` to the helpers `reflow.test.ts` already has for the same purposes (read the file's first 60 lines; do not invent new mocking). Run → FAIL.

- [ ] **Step 4: Implement in `reflow.ts`.** Add module state next to `inflight`:

```ts
/** The latest frame per running pass — what the wire's 202 reports. */
const latest = new Map<string, { phase: string; completed: number; total: number }>()
/** A refused book's reason and when to forget it, so a poll does not re-run a doomed pass. */
const refusals = new Map<string, { reason: string; until: number }>()
export const REFUSAL_TTL_MS = 60_000
```

In `subscribeOnce`'s handler, before `events.broadcast`, add `if (inflight.has(bookId)) latest.set(bookId, { phase, completed: count(frame.completed), total: count(frame.total) })`. In `ensure`, set `latest.set(bookId, { phase: 'start', completed: 0, total: 0 })` when starting a run and, in the `finally`, `latest.delete(bookId)`; in the same chain record the outcome: after `pass(bookId)` resolves, `result.status === 'fallback' ? refusals.set(bookId, { reason: result.reason, until: Date.now() + REFUSAL_TTL_MS }) : refusals.delete(bookId)`. Add:

```ts
export function wireStatus(bookId: string) {
  return inflight.has(bookId) ? (latest.get(bookId) ?? null) : null
}

export function recentRefusal(bookId: string): string | null {
  const hit = refusals.get(bookId)
  if (!hit) return null
  if (Date.now() >= hit.until) {
    refusals.delete(bookId)
    return null
  }
  return hit.reason
}
```

`resetForTests` clears `latest` and `refusals` too. A pass that **rejects** (pre-flight) records nothing and is surfaced by the caller. Run `npm test -- reflow shape` → PASS. Run the whole gate.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/api/shape.ts electron/main/services/api/shape.test.ts electron/main/services/reflow.ts electron/main/services/reflow.test.ts
git commit -m "feat(api): the reflow member, and the service's view of a running pass

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The route

**Files:**
- Modify: `electron/main/api/rest.ts` (the `file` branch, line ~974)
- Modify: `electron/main/api/rest.test.ts`

**Interfaces:**
- Consumes: `isReflowEligible`, `reflowPendingPayload`, `cannotReflowPayload` (`shape.ts`); `wireStatus`, `recentRefusal`, `ensure` (`services/reflow`); `resolveReflowFile` (`book-bytes`); `sendBytes`, `sendUnavailable`, `sendJson` (existing in `rest.ts`).
- Produces: a module constant `REFLOW_GRACE_MS = 2000` in `rest.ts`, and the `ETag` header on the 200 (via a new optional `headers` field on `ByteSource`).

**Request order** (put it in a function `serveReflow(req, res, book, deps)` above `route`, called from the `file` branch when `format === 'reflow'`; the branch's existing 400-for-no-format and offline checks run first and are unchanged):

1. `const found = db.getBook(book.id)`; not found or `!isReflowEligible(found)` → 404 `notFound`.
2. Offline was already answered 503 by the branch.
3. `const running = reflow.wireStatus(id)` → if non-null, 202 `reflowPendingPayload(running)` with `Retry-After: 2`; return.
4. `const refused = reflow.recentRefusal(id)` → if non-null, 422 `cannotReflowPayload(refused)`; return.
5. Start (or join) the pass: `const pass = reflow.ensure(id)`; **attach a catch to it first** (`pass.catch(() => {})`) so a rejection after the grace window is never an unhandled rejection (invariant 12). `const winner = await Promise.race([pass.then(r => r, (e) => ({ status: 'error' as const, reason: describeError(e) })), delay(REFLOW_GRACE_MS).then(() => null)])`. The delay's timer must be cleared when the pass wins (no dangling timer).
6. `winner === null` → 202 with `reflow.wireStatus(id) ?? { phase: 'start', completed: 0, total: 0 }`.
7. `winner.status === 'fallback' | 'error'` → 422 `cannotReflowPayload(winner.reason)`.
8. `produced | cached` → `const path = await resolveReflowFile(id)`; null → 404; else `sendBytes(req, res, { path, contentType: bookContentType('epub'), headers: { etag } }, deps)` where `etag = '"' + size + '-' + Math.trunc(mtimeMs) + '"'` from `fs.stat(path)` (a failed stat → 404, like `sendBytes`'s own).

- [ ] **Step 1: Failing tests** in a new `describe('the reflow route')` inside the byte routes' harness (copy its `beforeEach` — `nas.isOnline` true, a started server, a bearer token — and add `vi.mock('../services/reflow')` and `vi.mock('../services/book-bytes', …)` the way the file already mocks `db`/`nas` with `importOriginal`). One case per row, asserting status, headers and body:

```ts
it('404s a book that holds an EPUB, an unknown book, and never calls the pass', async () => {
  vi.mocked(db.getBook).mockReturnValue(bookWith(['epub', 'pdf']))
  expect((await get('/api/books/b1/file?format=reflow')).status).toBe(404)
  vi.mocked(db.getBook).mockReturnValue(null)
  expect((await get('/api/books/nope/file?format=reflow')).status).toBe(404)
  expect(reflow.ensure).not.toHaveBeenCalled()
})

it('503s with Retry-After 5 when the share is offline, before any pass', async () => {
  vi.mocked(nas.isOnline).mockReturnValue(false)
  const res = await get('/api/books/b1/file?format=reflow')
  expect([res.status, res.headers.get('retry-after')]).toEqual([503, '5'])
  expect(reflow.ensure).not.toHaveBeenCalled()
})

it('202s with the pass\'s progress while one is running, and starts nothing', async () => {
  vi.mocked(reflow.wireStatus).mockReturnValue({ phase: 'page', completed: 12, total: 24 })
  const res = await get('/api/books/b1/file?format=reflow')
  expect([res.status, res.headers.get('retry-after')]).toEqual([202, '2'])
  expect(await res.json()).toEqual({ phase: 'page', completed: 12, total: 24 })
  expect(reflow.ensure).not.toHaveBeenCalled() // Review Focus 1: join, never double-start
})

it('422s a remembered refusal without a new pass (Review Focus 2)', async () => {
  vi.mocked(reflow.recentRefusal).mockReturnValue('no page carries a text layer')
  const res = await get('/api/books/b1/file?format=reflow')
  expect(res.status).toBe(422)
  expect(await res.json()).toEqual({ error: 'cannot reflow', reason: 'no page carries a text layer' })
  expect(reflow.ensure).not.toHaveBeenCalled()
})

it('200s the artifact when the pass finishes inside the grace, with ETag and Range', async () => {
  vi.mocked(reflow.ensure).mockResolvedValue(produced())
  vi.mocked(resolveReflowFile).mockResolvedValue(fixtureEpubPath) // a real temp file, as the byte routes' cases use
  const res = await get('/api/books/b1/file?format=reflow')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/epub+zip')
  expect(res.headers.get('etag')).toMatch(/^"\d+-\d+"$/)
  expect(Buffer.from(await res.arrayBuffer())).toEqual(readFileSync(fixtureEpubPath))
  const ranged = await get('/api/books/b1/file?format=reflow', { range: 'bytes=4-' })
  expect(ranged.status).toBe(206)
})

it('202s when the pass outlives the grace, and the pass keeps going (Review Focus 5)', async () => {
  vi.useFakeTimers()
  let finish!: (r: ReflowResult) => void
  vi.mocked(reflow.ensure).mockReturnValue(new Promise((r) => (finish = r)))
  const pending = get('/api/books/b1/file?format=reflow')
  await vi.advanceTimersByTimeAsync(REFLOW_GRACE_MS + 1)
  expect((await pending).status).toBe(202)
  finish(produced()) // settles later; must not be an unhandled rejection or throw
  vi.useRealTimers()
})

it('422s a fallback result and a pre-flight rejection, 500s neither', async () => {
  vi.mocked(reflow.ensure).mockResolvedValue({ ...produced(), status: 'fallback', reason: 'unreadable' })
  expect((await get('/api/books/b1/file?format=reflow')).status).toBe(422)
  vi.mocked(reflow.ensure).mockRejectedValue(new Error('The metadata engine is unavailable'))
  const res = await get('/api/books/b1/file?format=reflow')
  expect(res.status).toBe(422)
  expect((await res.json()).reason).toContain('unavailable')
})

it('resolveBookFile still refuses reflow, so the wire opens only here', async () => {
  expect(await resolveBookFile('b1', 'reflow')).toBeNull()
})
```

Adapt `get`, `bookWith`, `produced`, `fixtureEpubPath` to the helpers the byte routes' block already defines (read lines ~1591–1700; add only what is missing). Run `npm test -- rest` → FAIL.

- [ ] **Step 2: Implement** `serveReflow` per the order above; extend `ByteSource` with `headers?: Record<string, string>` and spread it into `sendBytes`'s `shared`; in the `file` branch, after the offline check and before `resolveBookFile`: `if (format === 'reflow') { await serveReflow(req, res, book.id, deps); return }`. The delay helper clears its timer: build it as `new Promise<null>((r) => { timer = setTimeout(() => r(null), REFLOW_GRACE_MS) })` and `clearTimeout(timer)` in a `finally`.

- [ ] **Step 3: Run** `npm run typecheck && npm run lint && npm test` → all green; `rest.test.ts`'s earlier cases that `format=reflow` was a 404 (grep `reflow` in it) are updated to the new answers, with a note in the commit.

- [ ] **Step 4: Commit**

```bash
git add electron/main/api/rest.ts electron/main/api/rest.test.ts
git commit -m "feat(api): GET /api/books/{id}/file?format=reflow — 202 while it runs, the bytes when it is done

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `scripts/api-smoke.sh`

**Files:**
- Modify: `scripts/api-smoke.sh` (a new section after the file/Range section, using the script's `check`, `request`, `header`, `BODY`, `HEADERS` helpers; copy the neighbouring section's banner style)

- [ ] **Step 1: Add the section.**

```bash
# ---------------------------------------------------------------------------
# The reflow (PDF-only books, slice 4): the member, the 404 for an ineligible
# book, and — when the profile holds an eligible one — the pass, polled to its end.
# ---------------------------------------------------------------------------
request "/api/books/$FIRST_ID" >/dev/null
check "book detail carries reflow.available as a boolean" "boolean" "$(jq -r '.reflow.available|type' "$BODY")"

# An EPUB-holding book must be the uniform 404, not a probe oracle
EPUB_ID=$(jq -r '[.books[]|select(.formats|index("epub"))][0].id // empty' "$LIBRARY_BODY")
if [ -n "$EPUB_ID" ]; then
  check "format=reflow on a book with an EPUB is 404" "404" "$(request "/api/books/$EPUB_ID/file?format=reflow")"
fi

REFLOW_ID=$(jq -r '[.books[]|select(.reflow.available)][0].id // empty' "$LIBRARY_BODY")
if [ -z "$REFLOW_ID" ]; then
  echo "NOTE  no reflow-eligible book in the first page; the pass is not exercised"
else
  deadline=$((SECONDS + 600)); status=000
  while [ "$SECONDS" -lt "$deadline" ]; do
    status=$(request "/api/books/$REFLOW_ID/file?format=reflow")
    [ "$status" = 202 ] || break
    check "202 body names a phase" "string" "$(jq -r '.phase|type' "$BODY")"
    sleep "$(header retry-after)"
  done
  if [ "$status" = 422 ]; then
    check "a refused book says why" "string" "$(jq -r '.reason|type' "$BODY")"
    echo "NOTE  $REFLOW_ID was refused by the pipeline: $(jq -r .reason "$BODY") — pick another book to see the 200"
  else
    check "the reflow answers 200 once the pass is done" "200" "$status"
    check "its type is an EPUB" "application/epub+zip" "$(header content-type)"
    check "it carries an ETag" "1" "$(header etag | grep -c '^"')"
    check "its first bytes are a zip" "PK" "$(head -c 2 "$BODY")"
  fi
fi
```

Use the script's real variable names for the library page body and the first id (read lines 203–312 and substitute; the names above are placeholders for *those two variables only* — every helper is the script's own). A 422 is a pass-through, not a FAIL: it is a legitimate answer for ~10% of PDF-only books, and the script says so rather than hiding it.

- [ ] **Step 2: Run it** against an isolated profile with the built app (`.claude/skills/verify/SKILL.md`; point at a scratch library holding one small text PDF with no EPUB, e.g. *Secrets of Lock Picking*, 4.8 s): `MUSAEUM_USER_DATA="$SCRATCH/profile" bash scripts/api-smoke.sh`. Expected: every line PASS, the new section included, exit 0. Record the observed lines (status sequence, pass duration) for Task 6.

- [ ] **Step 3: Commit**

```bash
git add scripts/api-smoke.sh
git commit -m "test(api): the smoke script exercises the reflow route

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Prove the doc and the wire agree, and the wire stays closed elsewhere

**Files:**
- Modify: `electron/main/services/api/shape.test.ts` (one case), `test/invariants.test.ts` only if it enumerates the byte routes.

- [ ] **Step 1:** Add a case that reads `docs/rest-api.md` (as the golden cases already do) and asserts it names `format=reflow`, `422`, `cannot reflow` and `reflow.available`; and that `API_ERRORS.cannotReflow` appears in the Errors table. A drifting word fails here, not on the phone.
- [ ] **Step 2:** `npm run typecheck && npm run lint && npm test` → green; `sidecar/.venv/bin/python -m pytest sidecar/tests -q` → **388 passed / 129 reflow, unchanged** (this slice added a caller, not a converter).
- [ ] **Step 3: Commit** `test(api): the document and the wire name the same reflow words`.

---

### Task 6: The record, and the hand-off to the phone

**Files:**
- Modify: `tasks.md` (C2: slice 4 landed, with the smoke run's observed numbers; R6 closed; open items re-listed), `CHANGELOG.md`, `docs/invariants/reader.md` (one rule: the wire's reflow arm lives in `rest.ts`, resolves through `resolveReflowFile`, and `resolveBookFile` must keep refusing `reflow`; the why: owner decision 1 and the refusal TTL), `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` (status line + D8 "decided in `docs/rest-api.md`": cite the deviations above), `CLAUDE.md` Status (one sentence). Not hard-wrapped.

- [ ] **Step 1:** Write the above, quoting Task 4's measured lines rather than describing them.
- [ ] **Step 2:** Write the phone's hand-off into `tasks.md` as the next entry, not as a plan: the clause (`reflow?.available` → poll `format=reflow` until 200, save as `{id}.epub`, open in `EPUBNavigatorViewController`, report the fraction), the 202/422 vocabulary, and that `../musaeum-ios` must be attached first (spec open question 5). Run `scripts/vendor-contract-fixtures.sh` in that repo as its first step — it will fail its suite on the unknown `reflow` member until the client names it, which is the contract working.
- [ ] **Step 3:** `git diff --stat main...HEAD` is the files above and nothing else. Commit `docs: slice 4 — the wire, in the record`.

---

## Self-review

- **Spec coverage:** D8 route ✔ (T3), payload member ✔ (T2, with the version deviation named), contract-first ✔ (T1), goldens ✔ (T1–2), smoke ✔ (T4), R6 ✔ (eligibility includes `mobi`+`pdf`), reflow-progress exposure ✔ (202 body), the iOS half ✘ by design (boundary, above).
- **Placeholders:** the test helpers named "adapt to the file's existing helpers" and the smoke variable names are the only indirections; each says where to read them.
- **Types:** `wireStatus`'s return shape = `ReflowPendingPayload`'s members; `recentRefusal` returns the `reason` string `cannotReflowPayload` takes; `isReflowEligible` takes `Pick<Book,'formats'>` and is called with a `Book` in both places.
