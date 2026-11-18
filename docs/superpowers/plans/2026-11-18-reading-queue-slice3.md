# Reading Queue — Slice 3 (the wire) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client can see that a shelf is a queue, read it in the person's order, and move one of its books to the top or the bottom — with `docs/rest-api.md`, its goldens and `scripts/api-smoke.sh` saying exactly what the wire does, in the same commit as the code that does it.

**Architecture:** `electron/main/` only, plus the contract document and the smoke script. The sort guard and the shelf's default order are decisions, so they live in the pure `services/api/query.ts`; the path matcher goes beside its membership sibling in `services/api/routes.ts`; the body's grammar is a pure parser of its own (`services/api/position.ts`), mirroring the reading report's; the socket keeps only what needs one — the refusal order and the write. Every write stays inside `services/shelves.ts`'s `moveBooks`, which is already built and tested (slice 1).

**Tech Stack:** TypeScript strict, the existing hand-rolled `node:http` server in `electron/main/api/rest.ts`, better-sqlite3 cache reads, vitest (a socketless suite for the pure pieces and a real-socket suite for the route), bash + `curl`/`jq` for the smoke script.

**Spec:** `docs/superpowers/specs/2026-11-18-reading-queue-design.md` — **D6 in full**, and AC12–AC14. Read first, in this order: `docs/rest-api.md` (the library table, `GET /api/shelves`, the membership pair, _Failure semantics_, _Errors_, _Not in this version_), `docs/invariants/shelves.md` (_Queues_, and _The REST surface_), `CLAUDE.md` (invariants 1, 8, 12 and the iOS contract rule), `docs/invariants/settings-and-editing.md` (the `rest_api_enabled` flag and the bearer token).

## Global Constraints

- Branch `feat/reading-queue` (pushed; `origin/feat/reading-queue` tracks it). Do not merge to `main`, and do not push without asking. The "slices 1–2 must not reach `main` before the wire lands" constraint is discharged **by this slice landing**, and Task 7 removes it from `tasks.md` and `docs/invariants/shelves.md`.
- **`apiVersion` stays `1`.** Everything is additive: a new `kind` value, a new sort, a new route. The installed phone reads `kind` as a plain string and must keep working unchanged (AC15); a client that does not know the route learns nothing was added from its `404` (D6).
- **The document is edited first, in the same slice as the code, with its goldens and `scripts/api-smoke.sh`.** `docs/rest-api.md`'s ` ```json payload=<name> ` blocks _are_ the goldens — `electron/main/services/api/shape.test.ts:197-232` parses them — so a payload change that skips the document fails a test, and a document change that skips the shape fails one too.
- **No per-book position on the wire** (D6). A book payload is shelf-agnostic: `shelves` is ids only.
- All business logic in `services/`; IPC and HTTP handlers stay thin (invariant 8). No `any`.
- Tests run only via `npm test -- <path>` (the wrapper is what makes the native ABI match). Gate for every task that changes code: `npm run typecheck && npm run lint && npm test` green before the commit. Each commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Prose in `.md` is one line per paragraph, never hard-wrapped.

## Scope note — size

**5 production files** (`services/api/query.ts`, `services/api/routes.ts`, `services/api/position.ts` (new), `services/db.ts`, `api/rest.ts`), plus their four test files, the contract document, the smoke script, and two doc edits for the lifted constraint. The only file outside `electron/` that changes behaviour is a shell script and a `.md`. Comfortably inside the ~10-file boundary.

## Readings this slice settles

The spec left these to the builder. Each names the alternative it beat.

**R1 — a second path matcher, not a widened one.** `routes.ts:130-141`'s `matchShelfMembershipPath` refuses any extra segment (`rest.length`), which is what makes `/api/shelves/{id}/books/{bookId}/junk` a uniform 404 rather than a half-matched path. Slice 3 adds `matchShelfPositionPath` beside it, matching exactly `/api/shelves/{shelfId}/books/{bookId}/position` and nothing else, so both matchers keep the "extra segments are not a match" property. _Alternative rejected:_ widening the existing matcher to return a resource union — it would put a nullable resource in every reader of `ShelfBookPath` to serve one path, which is the argument `routes.ts`'s own docblock makes against a nullable `id` for the collection. _Reversal:_ a third book-level shelf sub-route.

**R2 — the queue's default order is decided inside `parseLibraryQuery`, from a kind the caller injects.** D6's rule is a _default order_ rule, and the place that decides default order today is `query.ts:87-92`. That function is deliberately pure — it reads no database — so it takes the kind as a **required second parameter**, a lookup `(shelfId: string) => ShelfKind | null`, exactly as `parseSort` already takes `hasShelf` as a caller-supplied fact (`query.ts:165-169`). A queue defaults to `shelf_position asc`; a manual shelf or an id the lookup does not know keeps `shelf_added desc` (the unknown id is answered 404 by the caller before any query runs, so its default never shows). _Alternative rejected:_ post-processing the parsed query in `rest.ts` — that would give the default order two homes, and the second one would be the one a later sort change forgets. _Alternative rejected:_ an optional parameter — one caller exists, and an optional one is how a new caller silently re-opens a queue on Date Added. _Reversal:_ a second default order that depends on a fact the cache cannot answer.

**R3 — the wire's body guard is its own parser, not `isPlacement`.** `services/shelves.ts`'s `isPlacement` accepts `{ before }` and `{ after }` — the Mac's own drag shapes — while D6's wire body is `{ "to": "top" | "bottom" }` and anything else is a **400**. Reusing the service's validator as the wire's guard would accept a body the contract refuses. `services/api/position.ts` is the smallest mirror of `services/api/reading.ts`: one exported `parsePositionBody(raw: unknown)`, exactly one key, and the value one of two strings. _Reversal:_ the wire growing `before`/`after`.

**R4 — the refusal order is D6's, which is the _opposite_ of the reading route's.** `handleReadingReport` (`rest.ts:655-676`) validates the body before it looks the book up, and says why in its docblock. D6 pins the other order for this route: **503 → 404 (unknown shelf or book) → 400 (a shelf that is not a queue) → 400 (a body it cannot read) → 404 (a book that is not a member)**. The plan pins it in a table test, because the file's nearest precedents invert three of those five steps and a builder copying either would ship it wrong while every single-status case stayed green. _Why that order:_ the share is refused before anything (D3's `assertOnline`); then the resources the path names; then the request the route cannot honour; then the body; then the membership, which is the one fact that requires the write's own subject to be true. _Reversal:_ none — it is the spec's.

**R5 — membership and kind are pre-checked on the cache, because `moveBooks` is deliberately permissive.** The service ignores an id the queue does not hold (the Mac's `shelves.md` rule, and correct for a drag) and returns success, so D6's non-member 404 cannot come from it; and it validates the placement _before_ `assertOnline`, so delegating the whole judgment would answer 400-before-503. Two small cache reads (`shelfKind(id)`, `shelfMemberExists(shelfId, bookId)`) are added to `db.ts` beside `shelfExists`, and the route pre-checks both — the shape `handleShelfMembership` already uses for existence (`rest.ts:836-839`), and its comment says why. _Reversal:_ `moveBooks` growing a strict mode.

**R6 — the smoke script restores a queue by construction, not by remembering.** It adds the run's own uploaded book to the chosen queue (appending), moves it to the top and checks it is first, moves it to the bottom and checks it is last, then removes the membership — so the queue's order and membership end exactly as they began, and no `added_at` was ever touched. _Alternative rejected:_ reading the book's original index and moving it back — two more requests and a comparison that can be wrong between them. A profile with no queue is a **note and a skip**, the membership pair's own behaviour (`scripts/api-smoke.sh:500-501`), because a manual shelf answers 400 by design.

## Review Focus

- **The five refusals, in order.** A body that is bad _and_ a shelf that is manual answers the **manual** 400, not the body's; an unknown book answers 404 even with a bad body. Task 5's table.
- **A queue read with no sort is the queue's order, across a page walk.** `?shelf={queue}` and no `sort`, no `q`; pages must not repeat or skip (the id tiebreak is what guarantees it, `db.ts:566-574`). Task 2 and Task 5.
- **`sort=shelf_position` is a 400 without a `shelf`** — and a 200 _with_ one, on a queue or a manual shelf, because the cache holds positions for both and nothing offers it on a manual shelf (D6).
- **The manual shelf does not move.** Its default stays `shelf_added desc`, its `shelf_added` reads are unchanged, and the membership pair's behaviour and answers are untouched.
- **The Mac follows.** A wire move writes through `services/shelves.ts`, so `shelves:changed` fires and an open queue re-reads; the socket test asserts the changed file and the cache, and the manual pass watches the open window.
- **`apiVersion` is still 1**, and the installed phone, unchanged, still lists a queue and opens it (AC15) — the reading in the manual pass.

---

## Task 1: Two cache reads the route needs

**Files:**

- Modify: `electron/main/services/db.ts` (beside `shelfExists`, `db.ts:1034`)
- Test: `electron/main/services/db-shelves.test.ts`

**Interfaces:**

- Produces `shelfKind(id: string): ShelfKind | null` — the cache's `kind` for one shelf, `null` when the cache does not hold it. Reads `shelves.kind` (migration 006 + `replaceAllShelves`); it is the cache's value, like every other shelf read here.
- Produces `shelfMemberExists(shelfId: string, bookId: string): boolean` — `SELECT 1 FROM shelf_books WHERE shelf_id = ? AND book_id = ?`. A member whose book the cache does not hold is absent from this table by construction (`INSERT OR IGNORE … WHERE EXISTS`, `db.ts:963-983`), which is consistent: `bookExists` fails first for that book.

- [ ] **Step 1: Failing tests.** In `db-shelves.test.ts`, beside the existing `shelfExists` cases: a queue returns `'queue'` and a manual shelf `'manual'`; an unknown id returns `null`; a member of a queue is `true` and a book on another shelf is `false`; a book that is on no shelf is `false` for every shelf id.
- [ ] **Step 2: Implement both**, one prepared statement each, in the module's existing style (no `any`, a docblock saying _why_ the route needs the kind rather than a list of shelves).
- [ ] **Step 3:** `npm test -- electron/main/services/db-shelves.test.ts`, then the full gate, then commit: `feat(shelves): the cache answers one shelf's kind and one membership`.

## Task 2: `shelf_position` needs a shelf, and a queue opens on it

**Files:**

- Modify: `electron/main/services/api/query.ts` (`parseSort` at `:170`; `parseLibraryQuery` at `:46`, its default at `:87-92`)
- Test: `electron/main/services/api/query.test.ts`
- Modify: `electron/main/api/rest.ts` (`parseLibraryQuery(url)` at `:1095` — the one production caller)

**Interfaces:**

- `parseSort(params, hasShelf)` — the guard becomes `candidate.field === 'shelf_added' || candidate.field === 'shelf_position'` (one predicate, both shelf-bound sorts). Nothing else about it changes: a direction still follows `defaultSortDirection` when absent, and an unknown field is still a 400.
- `parseLibraryQuery(url, shelfKindOf: (shelfId: string) => ShelfKind | null)` — **required**. With a shelf, neither `sort` nor `q`, and the lookup answering `'queue'`, `filters.sort` is `{ field: 'shelf_position', direction: 'asc' }`; every other case keeps `shelf_added desc`. A `q` still leaves the sort unset (relevance), and an explicit `sort`/`dir` still wins over the default.
- `rest.ts` passes `shelfKind` from `services/db`.

- [ ] **Step 1: Failing tests** in `query.test.ts`: `sort=shelf_position` without a shelf is `{ ok: false }`, with one is accepted (queue _and_ manual); `?shelf=q1` with a lookup answering `'queue'` yields `shelf_position asc`; `?shelf=s1` with `'manual'` yields `shelf_added desc`; an unknown id (`null`) yields `shelf_added desc`; `?shelf=q1&sort=title` yields title; `?shelf=q1&q=x` leaves `filters.sort` unset. Update the existing `parseLibraryQuery(...)` calls to the new second argument (`() => null` is the manual-shelf default they already assume), and say in one comment why the parameter is required.
- [ ] **Step 2: Implement.** Extend the `parseSort` docblock's paragraph (it currently explains `shelf_added`'s rule at `:165-169`) to name both shelf-bound sorts; extend `parseLibraryQuery`'s docblock with R2's reasoning, including that the lookup is a _fact the caller supplies_ so the module stays pure.
- [ ] **Step 3:** `npm test -- electron/main/services/api/query.test.ts electron/main/api/rest.ts` (the socket suite may redden here and must be read, not reverted), full gate, commit: `feat(shelves): a queue's order on the wire, and shelf_position refused without a shelf`.

## Task 3: The path matcher

**Files:**

- Modify: `electron/main/services/api/routes.ts`
- Test: `electron/main/services/api/routes.test.ts`

**Interfaces:**

- Produces `matchShelfPositionPath(pathname: string): ShelfPositionPath | null`, where `ShelfPositionPath` is `{ shelfId: string; bookId: string }` — the same two decoded, percent-escaped segments as `ShelfBookPath`, from exactly `/api/shelves/{shelfId}/books/{bookId}/position`.
- `SHELVES_PREFIX` and `decodeSegment` are reused; no new constant for the trailing segment beyond a local literal.

- [ ] **Step 1: Failing tests:** the five-segment path matches and decodes an escaped id; the membership path (`…/books/{bookId}` with no trailing segment) does **not** match; a six-segment path does not; `…/position` with a missing or empty segment does not; a malformed escape answers `null`.
- [ ] **Step 2: Implement**, with the docblock stating the property both matchers keep (extra segments are not a match, so one path never has two meanings) — R1.
- [ ] **Step 3:** `npm test -- electron/main/services/api/routes.test.ts`, gate, commit: `feat(shelves): the position path, matched without widening the membership one`.

## Task 4: The body's grammar

**Files:**

- Create: `electron/main/services/api/position.ts`, `electron/main/services/api/position.test.ts`

**Interfaces:**

- Produces `parsePositionBody(raw: unknown): { ok: true; to: 'top' | 'bottom' } | { ok: false }`.
- Exactly one own key, `to`, and its value exactly `'top'` or `'bottom'`. `{ to: 'top', extra: 1 }`, `{ before: 'x' }`, `{ after: 'x' }`, `{ to: 'Top' }`, `{}`, `[]`, `"top"`, `null` and an object with no keys are all `{ ok: false }`. A `to` that is present but not a string is a refusal, not a coercion.

- [ ] **Step 1: Failing tests** — one table over the refusals above, the two successes, and a note that the service's own `isPlacement` accepting `before`/`after` is why this parser exists (R3).
- [ ] **Step 2: Implement** with a docblock that names D6 as the authority and points at `services/shelves.ts`'s `isPlacement` as the _Mac's_ wider grammar — the two are deliberately not the same function.
- [ ] **Step 3:** `npm test -- electron/main/services/api/position.test.ts`, gate, commit: `feat(shelves): the position body's grammar, which is narrower than the Mac's`.

## Task 5: The route, and its five refusals in order

**Files:**

- Modify: `electron/main/api/rest.ts` (the dispatcher at `:1177-1186`; a new handler beside `handleShelfMembership` at `:825`)
- Test: `electron/main/api/rest.test.ts` (the real-socket suite, beside _the shelf membership writes_ at `:1155`)

**Interfaces:**

- The dispatcher gains one arm, before `matchBookPath`, in the membership pair's shape:
  `const position = matchShelfPositionPath(url.pathname); if (position && req.method === 'PUT') { await handleShelfPosition(req, res, position, deps.bodyTimeoutMs); return }` — so a `GET`/`POST`/`DELETE` of the path falls through to the uniform 404 (D11), exactly as a `GET` of the membership path does.
- `handleShelfPosition(req, res, path, timeoutMs)`: answer `{ book: … }` via the existing `membershipPayload`, read back after the write.
- The order, and each answer:

| #   | Check                                                   | Answer                                                               |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | `nas.isOnline()`                                        | **503** `library offline`, `Retry-After: 5`, before the body is read |
| 2   | `shelfExists(shelfId)`, `bookExists(bookId)`            | **404** `not found`                                                  |
| 3   | `shelfKind(shelfId) !== 'queue'`                        | **400** `bad request`                                                |
| 4   | `parsePositionBody(await readJsonBody(req, timeoutMs))` | **400** `bad request`                                                |
| 5   | `shelfMemberExists(shelfId, bookId)`                    | **404** `not found`                                                  |
| —   | `await moveBooks(shelfId, [bookId], { to })`            | **200** `{ book }`                                                   |

A `QUEUE_BOOK_GONE` from the service (the anchor vanished between the checks and the write) cannot happen for a `{ to }` placement; a `SHELF_GONE` still maps to **404**, as the membership route's does (`rest.ts:846-850`), and anything else is **500** with the reason in the log and the file untouched — the membership route's own catch, unchanged.

- [ ] **Step 1: Failing tests** in `rest.test.ts`, in one table over the five steps plus the two successes:
  - `top` puts the book first and `bottom` last, in a queue the case created with `shelves.create(name, ids, 'queue')`; the answer is `{ book }` with `shelves` including the queue; the file on disk and the cache agree.
  - idempotence: a second `{to:'top'}` for the book already at the top answers 200 and writes nothing (assert the file's md5 and `updated_at` are unchanged — the service's `Applied.changed`).
  - **the order**: offline answers 503 with `Retry-After: 5` _with a malformed body_ (proving the body is not read first); an unknown shelf with a malformed body answers 404; an unknown book answers 404; a **manual** shelf with a malformed body answers 400 (proving kind is checked before the body); a malformed body on a queue answers 400; a non-member of a queue with a valid body answers 404.
  - `GET`, `POST` and `DELETE` of the path answer 404.
  - a page walk of `?shelf={queue}` with no `sort` and `limit=1` returns the queue's order, no repeats, `total` unchanged.
  - `?sort=shelf_position` with no shelf answers 400; with the queue answers 200 in queue order.
- [ ] **Step 2: Implement** the handler and the dispatch arm. The handler's docblock carries D6's order as a table and one sentence saying _why_ it is not the reading route's order (R4) — a builder who copies the neighbour must be told, in the file, that the neighbour is wrong here.
- [ ] **Step 3:** `npm test -- electron/main/api/rest.test.ts`, full gate, commit: `feat(shelves): PUT a book's place in a queue, with the five refusals in the spec's order`.

## Task 6: The contract document, its goldens, and the lifted constraint

**Files:**

- Modify: `docs/rest-api.md` (the library table `:96-99`; `GET /api/shelves` `:198-224`; a new `### PUT /api/shelves/{id}/books/{bookId}/position` section after the membership pair; _Failure semantics_ `:674-692`; _Errors_ `:692-714`; _Not in this version_ `:715-726`; the smoke paragraph `:727-741`)
- Modify: `electron/main/services/api/shape.test.ts` (the golden pair at `:197-232`)
- Modify: `tasks.md` (the reading-queue bullet) and `docs/invariants/shelves.md` (the _Slices 1–2 must not reach `main`_ bullet, `:92`)

**Interfaces (document):**

- `kind` — the field table's row becomes `manual` or `queue`; a shelf of a kind this build does not know is still not on the wire at all.
- `sort` — `shelf_position` joins `shelf_added` as "only with a `shelf`", and the row says what each default is: a queue opens on `shelf_position` ascending, a manual shelf stays `shelf_added` descending.
- The new section carries: the body, `{ "book": … }`, the five-row refusal table, idempotence, `apiVersion` unchanged, and one sentence on _what the phone does with it_ (its capability probe is the 404, D6).
- `payload=shelves` gains a **second** entry — a queue — so the golden shows both kinds, and `shape.test.ts`'s fixture rows gain it. The membership and book goldens do not change; say so in the commit.
- _Failure semantics_ gains the two rows a reader looks for ("a position move on a manual shelf" → 400; "a position move for a non-member" → 404) and the errors table's 400 row names the new body.
- The _not in this version_ paragraph stops saying shelf create/rename/delete is the whole story: it names this route as the one shelf write beyond membership, and keeps create/rename/delete out.
- **The lifted constraint:** `tasks.md`'s bullet and `shelves.md:92` both say slices 1–2 must not reach `main` before the wire lands. This slice _is_ the wire, so both become a statement of what landed, not a freeze; `shelves.md:92`'s sentence about `rest-api.md` contradicting the surface is now false and is replaced by the rule the wire actually keeps.

- [ ] **Step 1:** Edit `docs/rest-api.md` first — everything above — then run `npm test -- electron/main/services/api/shape.test.ts` and watch it fail against the new golden until the fixture rows are updated. That failure is the proof the document and the shaper decide each other.
- [ ] **Step 2:** Update the fixture, keep the other goldens byte-identical, and run `npx prettier --check docs/rest-api.md` — measuring this file's drift at `HEAD` first if it already drifts (`docs/rest-api.md`'s tables are wide; do not reformat the file).
- [ ] **Step 3:** Lift the freeze in both places, with the dates. Commit: `docs(shelves): the queue on the wire, and slices 1-2 no longer held back`.

## Task 7: `scripts/api-smoke.sh`

**Files:**

- Modify: `scripts/api-smoke.sh` (the shelf section `:480-557`)

**Interfaces:** three new checks, plus a note when the profile holds no queue:

- the shelf list's first `kind` value is read and reported in a `note` (`manual` or `queue`), because every later check depends on which it is;
- with a queue: add the run's uploaded book, `PUT …/position {"to":"top"}`, then `GET /api/library?shelf={id}&limit=1` names that book; `{"to":"bottom"}`, then `offset={count-1}` names it; then the membership `DELETE` — and one check that a `{to:"top"}` on the now-removed book answers **404** (the non-member rule, and the cheapest proof the route pre-checks membership rather than trusting the service);
- with only a manual shelf: the same route answers **400**, which is the manual-shelf rule proved against a real one — the pair's own "borrow the upload" trick, without the write.

- [ ] **Step 1:** Add the checks to the existing shelf block, after the membership pair, in the file's own `request`/`check`/`note` idioms. `jq` reads the book id from the detail route's answer, never from a URL the script built.
- [ ] **Step 2:** `bash -n scripts/api-smoke.sh`; then the run in Task 8's manual pass.
- [ ] **Step 3:** Commit: `test(shelves): the smoke script moves a book in a queue and puts it back`.

---

## Acceptance criteria and their deciders

| AC  | Claim                                                                                                                                                                               | Decider                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 12  | `GET /api/shelves` carries `kind: "queue"`; `?shelf={queue}` with no sort answers in queue order across a page walk with no repeats; `sort=shelf_position` without `shelf` is a 400 | `rest.test.ts` (the page walk at `limit=1`, the 400/200 pair); `shape.test.ts` (the golden's second entry) |
| 13  | `{to:"top"}` is first and `{to:"bottom"}` last; the answer is `{ book: … }`; idempotent; D6's failure table holds including 400 on a manual shelf; the Mac follows without a reload | `rest.test.ts` (the refusal table, the two successes, the md5/`updated_at` no-op) + the manual pass below  |
| 14  | `api-smoke.sh` exercises the route and restores the queue's order before it ends; a profile with no queue skips it                                                                  | the smoke run against the isolated profile, in the manual pass                                             |
| 15  | The installed phone, unchanged, lists a queue and opens it                                                                                                                          | the manual pass, with the phone build already installed                                                    |

## What must not move

- `apiVersion` stays `1`; `GET /api/health`, `/api/library`, `/api/library/facets`, `/api/books/{id}`, the cover and file routes, the reading report, the upload and the ask relay answer exactly as they do now. Their goldens must be byte-identical after Task 6 except for the shelves block.
- A manual shelf's default order stays `shelf_added` descending, and its `shelf_added` reads are unchanged.
- The membership pair's answers and order (503 → 404 → write → `{book}`) are untouched; `handleShelfMembership` is not edited.
- `services/shelves.ts` and `moveBooks` are not edited: this slice reads their behaviour, it does not change it. If a test here seems to need a service change, that is an escalation, not a judgment call.
- The Mac's renderer is not touched (`src/` unchanged).

## Verification plan

1. **Gate**, per task and once at the end: `npm run typecheck && npm run lint && npm test`.
2. **Mutation-check the four claims that have a decider**: the `shelf_position`-without-a-shelf guard (delete the clause → the 400 case reds); the queue default (make the lookup answer `'manual'` → the page-walk order case reds); the kind-before-body step (move step 3 after step 4 → the manual-shelf-with-a-bad-body case reds); the non-member step (drop it → the 404 case reds and the route answers 200, which is the bug this step exists for). One script, one JSON list of mutations, killed-vs-survived quoted.
3. **The manual pass** on an isolated profile (the `verify` skill; `MUSAEUM_USER_DATA` pointed at a scratch directory, `rest_api_enabled` on): `bash scripts/api-smoke.sh --profile …` green including the new checks; then, with the app's own window open on a queue, run the smoke's move by hand (`curl`) and watch the sidebar and the rows follow without a reload — AC13's second half, which no unit test can see.
4. **The phone**, unchanged: list a queue, open it, confirm the order and that no Move menu appears (its build has none). AC15's reading.
5. **Record** in `tasks.md`: slice 3 built, what the wire now carries, and the two things it still does not (no per-book position; no create/rename/delete).

## Start here

```bash
git log --oneline -3                     # HEAD is the review's two commits on feat/reading-queue
git status --short                       # clean
npm run typecheck && npm run lint && npm test   # 127 files / 3051 tests, all green
```

Then read, in this order: `docs/superpowers/specs/2026-11-18-reading-queue-design.md` **D6** (the contract, pinned line by line), `electron/main/services/api/query.ts` (where the default order already lives), `electron/main/api/rest.ts:802-880` (`handleShelfMembership` — the shape to copy, and the refusal order that must _not_ be copied from the reading route), `docs/rest-api.md:198-282` (what the shelves routes already promise), and `scripts/api-smoke.sh:480-557` (the idioms the new checks go into).
