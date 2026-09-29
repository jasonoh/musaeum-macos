# Bookshelves — slice 5: the REST contract Implementation Plan

> **For agentic workers:** the plan-execution sub-skills slice 2's plan names (`superpowers:subagent-driven-development`, `superpowers:executing-plans`) are **not installed in this environment** — checked 2026-09-28, `skills_list` shows none. Execute the tasks directly, per `.claude/rules/orchestration.md`: the main session is the orchestrator, and the repo agents in `.claude/agents/` sit on the layer boundaries this slice crosses. Steps use checkbox syntax for tracking. **This plan is executed in the session that wrote it** (unlike slices 2–3, which were written for a fresh one) — the *Built* record at the bottom is written from real runs, not estimates.

**Goal:** the wire gains shelves — `GET /api/shelves`; `?shelf=` on the library route and its facets; a `shelves` array on **every** book payload; and `PUT`/`DELETE /api/shelves/{id}/books/{bookId}` as the membership toggle. `apiVersion` stays **1** (D10's correction: everything is additive and the installed phone requires exactly `1`). **No preload change, no renderer change, no `src/types/` change, no IPC change** — the main process, `docs/rest-api.md`, and `scripts/api-smoke.sh` only.

**Architecture:** the existing thin socket (`electron/main/api/rest.ts`) over `services/api/*` and `services/db.ts`, with the same split slice 1c made: what can be a pure function of inputs lives in `services/api/query.ts` and `services/api/routes.ts` (socketless cases), what only a socket can decide stays in `rest.ts` (statuses, bodies, ordering). The **three contract artifacts move together, per task** (AC19): the `json payload=` blocks in `docs/rest-api.md`, the goldens in `services/api/shape.test.ts`, and the shaper itself. `scripts/api-smoke.sh` is the executable half and lands with the writes.

**Tech Stack:** Node `node:http`, TypeScript strict, better-sqlite3, vitest (`npm test` — Electron-as-Node). No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-27-bookshelves-design.md` — **D10** (the REST decision, verbatim), **D6** (`count`'s meaning), **D7** (a shelf is a scope), **AC30–AC33**, and Risk 4 (every book payload grows by a usually-empty array). Read `docs/rest-api.md` in full (it is the artifact being changed), `docs/invariants/shelves.md` (line 58's `sort=shelf_added` sentence and the closing paragraph both name this slice), and `docs/data-contracts.md`'s shelf section only to confirm nothing there changes.

---

## Where this plan sits, and why 5 before 4

Slice 5 of six. **Slices 1–3 landed** (storage/service/IPC; the renderer's shelf UI; drag and drop). **Slice 4 is *Send to Shelf to Kindle* — desktop-only, one menu item — and it stays open**; nothing here touches it and it does not gate anything. The owner's directive for this session is the iOS companion, and **the phone cannot start without this slice**: `../musaeum-ios/AGENTS.md`'s invariant 1 is categorical — *"Never restate `docs/rest-api.md` here … a field you need and the document does not name is a change to the **server** and its document, in the Mac repo, in one slice"* — and today the wire carries no shelf at all. Slice 6 (the phone's annex and implementation, in `musaeum-ios`) is written **after** this lands, from the document this slice leaves behind.

**The baseline this plan was written against:** `7bfa5ba` (2026-09-28, slice 3's last commit), Node v26, `npm run typecheck` clean, `npm run lint` clean, `npm test` = **87 files, 1843 passed, 2 skipped** — measured 2026-09-28 by this session, matching the count slice 3's record ends on. Check `git log --oneline -3` before starting; `origin/main` may have moved and that is someone else's push, not a signal.

**File counts.** Code files whose behaviour changes: `services/db.ts`, `services/shelves.ts`, `services/api/routes.ts`, `services/api/query.ts`, `services/api/shape.ts`, `api/rest.ts` — **six**, inside the ~10-file bound. Tests (`db-shelves`, `query`, `shelves`, `shape`, `rest`) and the contract artifacts (`docs/rest-api.md`, `scripts/api-smoke.sh`) ride along, as slice 3's did. The slice still splits into two parts along its one real seam: **5a** is the read surface (listable, scoped, and the member on every payload) and **5b** is the first `DELETE` in the API's life and the first write that is not about a book's own bytes — and 5b's write cases need 5a's reads to read themselves back. If a task finds itself wanting a seventh code file, that is the point to split 5b further rather than to keep going.

---

## Readings this slice must settle itself, each with the alternative it beats

The spec fixes the behaviour; these are where it stops short. Each is recorded rather than discovered mid-task, and none changes an acceptance criterion.

### S1 — `bookPayload`'s `shelves` is a **required** parameter, not an optional one defaulting to `[]`

`bookPayload(book, shelves)` — every call site must say what it knows. **Why:** a default would let a route forget to fill the member and ship a silently empty array; the field list would look right (the key is present either way, so `shape.test.ts`'s parity case cannot catch it) and the bug would be invisible until a phone showed a shelved book as unshelved. **The alternative:** `shelves: string[] = []` — one word shorter at four call sites, and the one class of drift this slice can actually introduce, unguarded. `libraryPayload` takes `shelves: Map<string, string[]>` for the same reason; `readingPayload` and `importPayload` gain a required `shelves` member in their input.

### S2 — an unreadable `shelves.json` answers **500**, with the sentence in the log

D10 names the 404 (unknown shelf or book) and the 503 (share offline) but not this one. The service refuses with the exported `SHELVES_UNREADABLE` sentence (D3: never overwrite what cannot be read). **Chosen: 500 `internal`**, the word the contract already carries for "a handler failed; the server keeps serving", with the sentence logged where a person can read it — the upload's `internal` precedent, which keeps absolute paths off the wire. **The alternative:** a new 503 word — new vocabulary for a state a client can do nothing about and may not retry, added to a contract whose error table has been deliberately stable.

### S3 — unknown shelf on a read is a **404 from the cache**, and a write pre-checks before it mutates

The read routes check `db.shelfExists(filters.shelfId)` before querying — a cache read, so it answers while offline, like every other JSON route. The write route checks `shelfExists` **and** `bookExists` before calling the service, because the service *skips* unknown book ids silently (`addMembers` — it must, for the Mac's own callers) and `addBooks` on a shelf that has gone would throw anyway. A shelf deleted between the check and the service's own re-read of the file is caught by `isShelfGone` — the writer's own answer (`SHELF_GONE`) — and answered with the same 404. **The alternative:** pre-check nothing and map the service's errors only — which answers **200** for an unknown *book* (`addBooks` reports `{added: 0, alreadyOn: 0}`), a contract lie.

### S4 — `?shelf=` (present, empty or whitespace) is a **400**, like `?minRating=`

Present-and-wrong is refused, absent is absent — the read routes' own rule, and `minRating` is the case it is written on. The parse lives in one exported helper (`parseShelfParam`) so the library route and the facets route cannot read the parameter two ways. **The alternative:** an empty `shelf` read as "no scope" — a client typo answered with the whole library, which is the wrap-around the `?limit=` case deliberately keeps for numbers and this one does not.

### S5 — the default order inside a shelf is `shelf_added desc`, set in the pure parse; `sort=shelf_added` without `shelf` is a 400

`parseLibraryQuery` gains the `shelf` parameter; when a shelf is present, no `sort` was asked for, **and there is no `q`**, it sets `{ field: 'shelf_added', direction: 'desc' }` — the Mac's own default inside a shelf (D8). With a `q` and no `sort`, the order stays SQLite's FTS `rank` (relevance, exactly as a Mac search inside a shelf behaves). `parseSort` gains a `hasShelf: boolean` and its inline `shelf_added` refusal becomes conditional — the comment it carries today says slice 5 replaces it, and this is that. **The alternative:** defaulting in `rest.ts` — refused because the rule would then be reachable only through a socket, and `query.ts`'s whole reason to exist is that its rules are not.

### S6 — `updatedAt` comes from a new db read; `ShelfSummary` is not touched

D10 puts `updatedAt` on `GET /api/shelves`, and nothing today exposes the `shelves.updated_at` column to a reader (`ShelfSummary` — the preload surface — deliberately carries `id`, `name`, `kind`, `count`). **Chosen:** `db.listShelvesWithUpdatedAt()` returns `ShelfSummary & { updatedAt: string }`, and `listShelves()` becomes a projection of it (one SQL statement, two readers). **Why not extend `ShelfSummary`:** it crosses the preload bridge and this slice may not change that surface. **Why not a wire-only query in `rest.ts`:** invariant 8 — the counts and the ordering are the cache's business.

### S7 — the payload's `shelves` ids come from **one batched read**, ordered like `listShelves`

`db.shelfIdsForBooks(ids)` answers a `Map<string, string[]>` in one `IN` query whatever the page size (D10: "the page read fills it with one batched `IN` query over the page's ids"), ordered by the shelf's name `COLLATE NOCASE`, then id — the same order `listShelves` reports, so the phone's detail chips and its shelf picker cannot disagree about which shelf comes first. The single-book routes (detail, reading, upload, the membership answer) call the same function with one id. **The alternative:** `shelvesForBook` (which exists) per book — a query per row on a 100-book page, and it carries names the wire does not want.

### S8 — the membership write answers the book **read back after the write**

`{ "book": … }` in the detail shape, with `shelves` reflecting the write that just landed — the reading report's own design (the write and the read that follows it are one round trip), which is what lets the phone toggle a checkbox, refresh its row, and hold no second request. The read-back is `db.getBook` + `shelfIdsFor(book.id)` after the service resolves (the service has already replaced the cache from the file it wrote). **The alternative:** echoing the payload from the pre-write state — which would show the old membership in the answer to the change.

### S9 — the method policy: `/api/shelves` joins the JSON routes (`GET`+`HEAD`); the membership path answers `PUT`/`DELETE` and nothing else

`GET` and `HEAD` on `/api/shelves` (it is a read, and `URLSession` probes with `HEAD` — the rule 1a learned). The membership path takes no body (an id pair is the whole request), so `HEAD` on it learns nothing a status does not, and it is **not** in the allowlist — `PUT` and `DELETE` only, everything else a known path behind a method it does not answer (404, uniformly — D11). **The alternative:** allowing `GET` on the membership path as a "is this book on this shelf" probe — a fourth route shape for a fact the detail payload already carries in its `shelves` member.

### S10 — the offline check runs **before** the 404 on the writes

`if (!nas.isOnline()) → 503` first, then the existence checks — the cover and file routes' own order (offline, then resolution), and the reason is on the client's side: the retry decision (`Retry-After: 5`) is the same regardless of whether the shelf exists, and a client that learns "404" from a machine that could not have written anything has learned the wrong fact. **The alternative:** 404 first, on the cache check — cheaper, and it tells an offline client that its shelf is gone when the machine simply cannot see.

## Global constraints

- Node ≥ 22.12. Run tests **only** through `npm test`. One file: `npm test -- <path>`.
- TypeScript strict, **no `any`**. `query.ts` and `routes.ts` stay pure — their combined case asserts no runtime import of `node:fs`, `node:http`, `nas-manager`, `../db` or `electron`; nothing in this slice may add one.
- `shape.ts`'s import list is **pinned by its own case** (the whole list, not a negative). This slice adds no import to it: the shelf row shape is a local structural interface (`ShelfRowInput`), not an import from `@shared/shelf.types`.
- **The three contract artifacts move together** (AC19): a payload change touches `docs/rest-api.md`'s `json payload=` blocks, `shape.test.ts`'s `PAYLOADS` map, and `shape.ts` in one commit. The doc is **not** Prettier-formatted — never run `prettier --write` on markdown (`npx prettier --check "docs/**/*.md"` fails 48 files); edit prose by hand. Run `npx prettier --write` on the **code and test** files touched in a task before `npm run lint` (which runs `--max-warnings=0`).
- Markdown prose is not hard-wrapped — one line per paragraph, bullet and table row.
- `apiVersion` stays **1** (`shape.test.ts` asserts it; do not touch).
- **No file under `src/`, `electron/main/ipc/`, `electron/preload`, or `sidecar/` changes.** The REST surface reads the cache through `services/db.ts` and writes through `services/shelves.ts` — the funnel is not bypassed (`docs/invariants/shelves.md`).
- Invariant 12 throughout: no path throws out of a request; a failed handler is a 500 and the server keeps serving; a shelf failure never takes the process down.
- Commit after every task, staging **by name** (never `git add -A`). Messages are `shelves slice 5: <what>`, ending with a blank line and `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Acceptance criteria → tasks

| AC | Task | | AC | Task |
| --- | --- | --- | --- | --- |
| 30 doc blocks + goldens + routes | 3, 4, 6 | | 32 `apiVersion` 1 + v1 fixtures still decode | 8 (the iOS run) |
| 31 the writes, the 404s, the 400, the 503, over a socket | 6 | | 33 `api-smoke.sh`, end to end | 7 |

---

# Part 5a — the read surface

### Task 1: the cache reads (S6, S7)

**Files:**

- Modify: `electron/main/services/db.ts`
- Modify: `electron/main/services/db-shelves.test.ts`

- [ ] **Step 1: Write the failing cases**

Append to `db-shelves.test.ts` (it already imports `replaceAllShelves`, `listShelves`, `insertBook`, `makeBook`; add `shelfExists`, `shelfIdsForBooks`, `listShelvesWithUpdatedAt` to the import):

```ts
describe('the reads the REST surface answers from (slice 5)', () => {
  const file = (): ShelvesFile => ({
    version: 1,
    shelves: [
      {
        id: 'zebra',
        name: 'Zebra',
        kind: 'manual',
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-02T00:00:00.000Z',
        books: [
          { id: 'a', added_at: '2026-09-01T00:00:00.000Z' },
          { id: 'b', added_at: '2026-09-02T00:00:00.000Z' }
        ]
      },
      {
        id: 'alpha',
        name: 'alpha',
        kind: 'manual',
        created_at: '2026-09-03T00:00:00.000Z',
        updated_at: '2026-09-04T00:00:00.000Z',
        books: [{ id: 'a', added_at: '2026-09-03T00:00:00.000Z' }]
      }
    ]
  })

  it('shelfExists answers for the cache', () => {
    for (const id of ['a', 'b', 'c']) insertBook(makeBook(id))
    replaceAllShelves(file())

    expect(shelfExists('zebra')).toBe(true)
    expect(shelfExists('alpha')).toBe(true)
    expect(shelfExists('gone')).toBe(false)
  })

  it('shelfIdsForBooks answers every id in one call, in listShelves order', () => {
    for (const id of ['a', 'b', 'c']) insertBook(makeBook(id))
    replaceAllShelves(file())

    const found = shelfIdsForBooks(['a', 'b', 'c'])
    // The order is `listShelves`'s — name COLLATE NOCASE, then id — so the wire's
    // array and the sidebar cannot disagree about which shelf comes first
    expect(found.get('a')).toEqual(['alpha', 'zebra'])
    expect(found.get('b')).toEqual(['zebra'])
    // A book on nothing is absent from the map, and the reader answers [] — the
    // map is not padded with empty arrays
    expect(found.has('c')).toBe(false)
    expect(shelfIdsForBooks([])).toEqual(new Map())
  })

  it('listShelvesWithUpdatedAt carries the file own clock, and agrees with listShelves', () => {
    for (const id of ['a', 'b']) insertBook(makeBook(id))
    replaceAllShelves(file())

    expect(listShelvesWithUpdatedAt()).toEqual([
      { id: 'alpha', name: 'alpha', kind: 'manual', count: 1, updatedAt: '2026-09-04T00:00:00.000Z' },
      { id: 'zebra', name: 'Zebra', kind: 'manual', count: 2, updatedAt: '2026-09-02T00:00:00.000Z' }
    ])
    // One SQL statement, two readers: the summary is a projection of this one
    expect(listShelves().map((s) => s.id)).toEqual(['alpha', 'zebra'])
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- electron/main/services/db-shelves.test.ts`
Expected: the three new cases fail — the functions do not exist.

- [ ] **Step 3: Write the reads**

In `db.ts`, in the shelves section (after `listShelves`), and rework `listShelves` to project from the new function so the ORDER BY/GROUP BY has one home:

```ts
/**
 * Every shelf, alphabetically and case-insensitively, then by id (D6), with the
 * file's own `updated_at` — what `GET /api/shelves` carries (bookshelves D10).
 *
 * `ShelfSummary` (the preload shape) deliberately has no clock: this is the same
 * query one reader wider, and `listShelves` is its projection, so the two cannot
 * order or count differently.
 */
export function listShelvesWithUpdatedAt(): (ShelfSummary & { updatedAt: string })[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.name, s.updated_at AS updatedAt, COUNT(sb.book_id) AS count
         FROM shelves s LEFT JOIN shelf_books sb ON sb.shelf_id = s.id
        GROUP BY s.id
        ORDER BY s.name COLLATE NOCASE, s.id`
    )
    .all() as { id: string; name: string; updatedAt: string; count: number }[]
  return rows.map((row) => ({ ...toShelfSummary(row), updatedAt: row.updatedAt }))
}

export function listShelves(): ShelfSummary[] {
  return listShelvesWithUpdatedAt().map(({ id, name, count }) => ({
    id,
    name,
    kind: 'manual',
    count
  }))
}

/** Whether the cache holds this shelf — the 404 check the REST surface reads (D10). */
export function shelfExists(id: string): boolean {
  return getDb().prepare('SELECT 1 FROM shelves WHERE id = ?').get(id) !== undefined
}

/**
 * Shelf ids per book id — **one query whatever the count** (bookshelves D10: the
 * page read fills the wire's `shelves` member from a single batched `IN`). A book
 * on nothing is absent from the map rather than mapped to `[]`; the reader pads.
 *
 * Ordered like `listShelves` — name `COLLATE NOCASE`, then shelf id — and the
 * loop preserves that order within each book, so a phone's chips and its shelf
 * picker cannot disagree.
 */
export function shelfIdsForBooks(bookIds: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>()
  if (!bookIds.length) return found
  const placeholders = bookIds.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT m.book_id AS bookId, m.shelf_id AS shelfId
         FROM shelf_books m JOIN shelves s ON s.id = m.shelf_id
        WHERE m.book_id IN (${placeholders})
        ORDER BY s.name COLLATE NOCASE, s.id`
    )
    .all(...bookIds) as { bookId: string; shelfId: string }[]
  for (const row of rows) {
    const list = found.get(row.bookId)
    if (list) list.push(row.shelfId)
    else found.set(row.bookId, [row.shelfId])
  }
  return found
}
```

(`toShelfSummary` already takes `{ id, name, count }` — the row above is structurally that plus `updatedAt`.)

- [ ] **Step 4: Run the cases, then the suite**

Run: `npm test -- electron/main/services/db-shelves.test.ts`, then `npm run typecheck && npm run lint`
Expected: green; the db-shelves file's count grows by three.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/db.ts electron/main/services/db-shelves.test.ts
git commit -m "shelves slice 5: the cache reads the REST surface answers from

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 2: the parameters (S4, S5)

**Files:**

- Modify: `electron/main/services/api/query.ts`
- Modify: `electron/main/services/api/query.test.ts`

- [ ] **Step 1: Write the failing cases**

In `query.test.ts` — a new describe, and the two `parseSort` calls that refuse `shelf_added` (currently at the `'refuses shelf_added, which has no shelf to order by on this surface yet'` case) updated to the new signature and meaning:

```ts
describe('the shelf parameter (bookshelves D10)', () => {
  it('reads shelf into the filters, trimmed', () => {
    expect(parseLibraryQuery(url('/api/library?shelf=to-read'))).toMatchObject({
      ok: true,
      query: { filters: { shelfId: 'to-read' } }
    })
  })

  it('refuses a present-but-empty shelf rather than defaulting it (S4)', () => {
    // Present and wrong is refused, absent is absent — the `?minRating=` rule
    expect(parseLibraryQuery(url('/api/library?shelf='))).toEqual({ ok: false })
    expect(parseLibraryQuery(url('/api/library?shelf=%20'))).toEqual({ ok: false })
    expect(parseLibraryQuery(url('/api/library'))).toMatchObject({ ok: true, query: { filters: {} } })
  })

  it('takes Date Added to Shelf as the default order inside a shelf, and only there (S5)', () => {
    expect(parseLibraryQuery(url('/api/library?shelf=to-read'))).toMatchObject({
      ok: true,
      query: { filters: { shelfId: 'to-read', sort: { field: 'shelf_added', direction: 'desc' } } }
    })
    // An explicit sort wins; a search keeps relevance (no sort key at all)
    expect(parseLibraryQuery(url('/api/library?shelf=x&sort=title'))).toMatchObject({
      ok: true,
      query: { filters: { sort: { field: 'title', direction: 'asc' } } }
    })
    const search = parseLibraryQuery(url('/api/library?shelf=x&q=ursula'))
    expect(search.ok && 'sort' in search.query.filters).toBe(false)
    // And the library without a shelf is untouched: no sort key invented
    const plain = parseLibraryQuery(url('/api/library'))
    expect(plain.ok && 'sort' in plain.query.filters).toBe(false)
  })

  it('lets shelf_added through only when a shelf scoped the query', () => {
    expect(parseLibraryQuery(url('/api/library?shelf=x&sort=shelf_added'))).toMatchObject({
      ok: true,
      query: { filters: { sort: { field: 'shelf_added', direction: 'desc' } } }
    })
    expect(parseLibraryQuery(url('/api/library?sort=shelf_added'))).toEqual({ ok: false })
  })
})

describe('parseShelfParam — the scope, read once for both routes', () => {
  it('answers the id, null when absent, and refuses empty', () => {
    expect(parseShelfParam(url('/api/library').searchParams)).toEqual({ ok: true, shelfId: null })
    expect(parseShelfParam(url('/api/library?shelf=%20to-read%20').searchParams)).toEqual({
      ok: true,
      shelfId: 'to-read'
    })
    expect(parseShelfParam(url('/api/library?shelf=').searchParams)).toEqual({ ok: false })
  })
})
```

And in the existing `'refuses shelf_added …'` case: rename it and pass the flag —

```ts
  it('refuses shelf_added without a shelf, and accepts it with one (D10)', () => {
    // The type grew the field for the Mac (bookshelves D8); the wire owns it only
    // when a shelf scoped the read, which is what `hasShelf` says
    expect(parseSort(url('/api/library?sort=shelf_added').searchParams, false)).toEqual({ ok: false })
    expect(parseSort(url('/api/library?sort=shelf_added&dir=desc').searchParams, false)).toEqual({ ok: false })
    expect(parseSort(url('/api/library?sort=shelf_added').searchParams, true)).toEqual({
      ok: true,
      sort: { field: 'shelf_added', direction: 'desc' }
    })
  })
```

Every other `parseSort(…)` call in the file gains its `false` (no shelf) — the signature is required, not defaulted.

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- electron/main/services/api/query.test.ts`
Expected: the new cases and the renamed one fail; the other `parseSort` calls fail to compile until Step 3.

- [ ] **Step 3: Write the parameter**

In `query.ts`:

```ts
/**
 * The `shelf` parameter — one reader for both shelf-scoped routes (bookshelves
 * D10), so the list and its facets cannot scope two ways.
 *
 * Absent is `null`; **present and empty is a 400** (S4): a `shelf=` a client
 * meant to fill in is a request this surface cannot make sense of, and
 * answering it with the whole library is the wrap-around the `?limit=` case
 * deliberately keeps for numbers and this one does not.
 */
export type ParsedShelf = { ok: true; shelfId: string | null } | { ok: false }

export function parseShelfParam(params: URLSearchParams): ParsedShelf {
  const raw = params.get('shelf')
  if (raw === null) return { ok: true, shelfId: null }
  const shelfId = raw.trim()
  return shelfId ? { ok: true, shelfId } : { ok: false }
}
```

and inside `parseLibraryQuery`, after the minRating block and before the sort:

```ts
  const shelf = parseShelfParam(params)
  if (!shelf.ok) return INVALID_QUERY
  if (shelf.shelfId) filters.shelfId = shelf.shelfId
```

then the sort tail becomes:

```ts
  const sort = parseSort(params, Boolean(filters.shelfId))
  if (!sort.ok) return INVALID_QUERY
  if (sort.sort) filters.sort = sort.sort
  else if (filters.shelfId && !params.get('q')?.trim()) {
    // With a shelf and neither a sort nor a search, the order is the Mac's own
    // default inside a shelf: Date Added to Shelf, newest first (D8, D10). A
    // search keeps FTS relevance, which no field name can express.
    filters.sort = { field: 'shelf_added', direction: 'desc' }
  }
```

and `parseSort`'s signature and guard:

```ts
export function parseSort(
  params: URLSearchParams,
  hasShelf: boolean
): { ok: true; sort: BookSort | null } | { ok: false } {
  const field = params.get('sort')
  const direction = params.get('dir')
  if (field === null && direction === null) return { ok: true, sort: null }

  const candidate = { field: field ?? 'title', direction: direction ?? 'asc' }
  // `shelf_added` is a real sort on the Mac (bookshelves D8) and on the wire
  // only next to a `shelf` to order by (bookshelves D10): without one it is
  // exactly the unknown field it was before the type grew it — a 400.
  if (!isBookSort(candidate) || (candidate.field === 'shelf_added' && !hasShelf)) {
    return { ok: false }
  }
  return {
    ok: true,
    sort:
      direction === null
        ? { field: candidate.field, direction: defaultSortDirection(candidate.field) }
        : { field: candidate.field, direction: candidate.direction }
  }
}
```

(The docblock above `parseSort` gains one sentence: `hasShelf` is the shelf-scoped routes' own flag, so a `shelf_added` sort without a scope is refused rather than silently ordered by nothing.)

- [ ] **Step 4: Run the cases**

Run: `npm test -- electron/main/services/api/query.test.ts`
Expected: all green (the file grows by five cases).

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/api/query.ts electron/main/services/api/query.test.ts
git commit -m "shelves slice 5: the shelf parameter, and Date Added to Shelf on the wire

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 3: the shaper and the payload goldens (AC30, S1, S7, S8)

**Files:**

- Modify: `electron/main/services/api/shape.ts`
- Modify: `electron/main/services/api/shape.test.ts`
- Modify: `docs/rest-api.md` (**only** the `json payload=` blocks here — the prose is Tasks 4 and 6)

- [ ] **Step 1: Write the failing cases**

In `shape.test.ts`:

```ts
/** The shelf the goldens' book is on — one id, and the same one on both sides of the pair. */
const SHELF_ID = 'b2c3d4e5-6f70-4182-93a4-b5c6d7e8f901'
const SHELVES = [SHELF_ID]
```

`PAYLOADS` becomes (the changed lines marked):

```ts
const PAYLOADS: Record<string, unknown> = {
  health: healthPayload({ version: APP_VERSION, books: 7100, online: true }),
  book: bookPayload(GOLDEN, SHELVES),
  library: libraryPayload({
    books: [GOLDEN],
    total: 1,
    limit: DEFAULT_PAGE_LIMIT,
    offset: 0,
    shelves: new Map([[ID, SHELVES]])
  }),
  facets: facetsPayload({ /* unchanged */ }),
  reading: readingPayload({ applied: true, book: GOLDEN, shelves: SHELVES }),
  import: importPayload({ book: GOLDEN, duplicate: DUPLICATE, shelves: SHELVES }),
  // Slice 5's payload: the shelf list. Its `count` is the same number the book
  // member's membership implies, so the example is self-consistent.
  shelves: shelvesPayload([
    { id: SHELF_ID, name: 'To Read', kind: 'manual', count: 3, updatedAt: TOUCHED }
  ]),
  error: errorPayload('notFound')
}
```

and every other `bookPayload(GOLDEN)` / `bookPayload(makeBook(…))` call in the file gains its shelves argument (`SHELVES`, or `[]` for the empty-book case). New cases:

```ts
describe('the shelves member, on every book payload (bookshelves D10)', () => {
  it('is always present, [] on a book no shelf holds', () => {
    const bare = bookPayload(makeBook('bare'), [])
    expect(bare.shelves).toEqual([])
    // The field list is identical either way — a key that appears only sometimes
    // is a client's crash
    expect(keyPaths(bare).sort()).toEqual(keyPaths(PAYLOADS.book).sort())
  })

  it('fills a page from one map, [] for an id the map does not hold', () => {
    const page = libraryPayload({
      books: [GOLDEN, makeBook('other')],
      total: 2,
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
      shelves: new Map([[ID, SHELVES]])
    })
    expect(page.books[0].shelves).toEqual(SHELVES)
    expect(page.books[1].shelves).toEqual([])
  })

  it('is on the reading answer and the import answer too — four routes, one shape', () => {
    expect(readingPayload({ applied: false, book: GOLDEN, shelves: SHELVES }).book.shelves).toEqual(SHELVES)
    expect(importPayload({ book: GOLDEN, duplicate: null, shelves: [] }).book.shelves).toEqual([])
  })
})

describe('the shelves payload (slice 5)', () => {
  it('carries the five members and nothing else', () => {
    expect(PAYLOADS.shelves).toEqual({
      shelves: [
        { id: SHELF_ID, name: 'To Read', kind: 'manual', count: 3, updatedAt: TOUCHED }
      ]
    })
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- electron/main/services/api/shape.test.ts`
Expected: compile failures at every `bookPayload` call, then the parity case failing until the doc blocks gain the member.

- [ ] **Step 3: Write the shaper**

In `shape.ts`: `WireBook` gains `shelves: string[]` (documented as **the ids only** — names come from `/api/shelves`, so a rename changes no book payload); `bookPayload(book: Book, shelves: string[]): WireBook` adds

```ts
    // Always present, `[]` when none — and **required**, not defaulted (S1): a
    // call site that forgets it is a typecheck failure rather than a book that
    // silently reads as shelfless.
    shelves
```

`readingPayload(input: { applied: boolean; book: Book; shelves: string[] })` and `importPayload(input: { book: Book; duplicate: DuplicateContext | null; shelves: string[] })` pass it through to `bookPayload`. `libraryPayload`:

```ts
export function libraryPayload(page: {
  books: Book[]
  total: number
  limit: number
  offset: number
  /** Shelf ids per book id — one batched read over the page (bookshelves D10, S7). */
  shelves: Map<string, string[]>
}): LibraryPayload {
  return {
    books: page.books.map((book) => bookPayload(book, page.shelves.get(book.id) ?? [])),
    total: page.total,
    limit: page.limit,
    offset: page.offset
  }
}
```

and the new payload, with **no new import** (S6/Global Constraints — the row shape is local and structural):

```ts
// ---------------------------------------------------------------------------
// The shelves — the phone's browse (bookshelves D10)
// ---------------------------------------------------------------------------

/**
 * What a shelf row needs from the cache. Structurally `listShelves`'s shape
 * (`ShelfSummary`, `@shared/shelf.types`) plus the file's own clock — declared
 * here rather than imported so this module's import list — which its own case
 * pins as the whole list — gains nothing for a type the compiler already checks
 * at the call site.
 */
export interface ShelfRowInput {
  id: string
  name: string
  kind: 'manual'
  count: number
  updatedAt: string
}

export interface WireShelf {
  id: string
  name: string
  kind: 'manual'
  count: number
  updatedAt: string
}

export interface ShelvesPayload {
  shelves: WireShelf[]
}

/**
 * Every shelf, as the sidebar sees them — `count` counts only members the
 * library holds (D6), and `updatedAt` is the shelf's own clock (`shelves.json`'s
 * `updated_at`, `services/db.ts`'s `listShelvesWithUpdatedAt`). Names come from
 * here, never from a book payload: a rename changes this response and no book.
 */
export function shelvesPayload(rows: ShelfRowInput[]): ShelvesPayload {
  return {
    shelves: rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      count: row.count,
      updatedAt: row.updatedAt
    }))
  }
}
```

- [ ] **Step 4: Add the member to the document's blocks**

In `docs/rest-api.md`, append to **each** of the four book-carrying blocks — `payload=book`, `payload=library` (inside its single `books[0]`), `payload=reading` (inside `book`), `payload=import` (inside `book`) — after the `"reading"` object:

```json
    "shelves": ["b2c3d4e5-6f70-4182-93a4-b5c6d7e8f901"]
```

and add the new block after the facets block:

````
```json payload=shelves
{
  "shelves": [
    {
      "id": "b2c3d4e5-6f70-4182-93a4-b5c6d7e8f901",
      "name": "To Read",
      "kind": "manual",
      "count": 3,
      "updatedAt": "2026-09-21T09:12:00.000Z"
    }
  ]
}
```
````

- [ ] **Step 5: Run the cases, then the suite**

Run: `npm test -- electron/main/services/api/shape.test.ts`, then `npm run typecheck && npm run lint && npm test`
Expected: green — the parity cases decide the doc and the shaper field for field (a mismatch is the drift AC19 exists to catch). The whole suite's file count does not move; passed grows by the new cases.

- [ ] **Step 6: Commit**

```bash
git add electron/main/services/api/shape.ts electron/main/services/api/shape.test.ts docs/rest-api.md
git commit -m "shelves slice 5: the shelves member on every book payload, and the shelf list's shape

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 4: the read routes (AC30; S3, S4, S5, S9)

**Files:**

- Modify: `electron/main/api/rest.ts`
- Modify: `electron/main/api/rest.test.ts`
- Modify: `docs/rest-api.md` (the prose the read surface needs)

- [ ] **Step 1: Write the failing socket cases**

In `rest.test.ts`, a new describe (the seeded-shelf pattern: a temp root + the real service, like the byte-route describe sets up its root):

```ts
describe('the shelf reads', () => {
  let server: Server
  let base: string
  let root: string
  let shelfId: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'musaeum-rest-shelves-'))
    await nas.setLibraryRoot(root) // temp dir exists → the share is 'connected'
    vi.mocked(nas.isOnline).mockReturnValue(true)

    seedLibrary() // the file's own seven-book fixture
    const shelf = await shelves.create('To Read', ['lib-1', 'lib-3'])
    shelfId = shelf.id

    server = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  const auth = { authorization: `Bearer ${TOKEN}` }
  const get = (path: string) => fetch(`${base}${path}`, { headers: auth })

  it('answers the shelf list, alphabetically, with the count and the clock', async () => {
    const res = await get('/api/shelves')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { shelves: unknown[] }
    expect(body.shelves).toEqual(db.listShelvesWithUpdatedAt())
    expect(body.shelves).toHaveLength(1)
  })

  it('answers HEAD on /api/shelves with the headers and no body (the method policy)', async () => {
    const probe = await fetch(`${base}/api/shelves`, { method: 'HEAD', headers: auth })
    expect(probe.status).toBe(200)
    expect(probe.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await probe.text()).toBe('')
  })

  it('scopes the page, its total, its order and its search', async () => {
    const scoped = await get(`/api/library?shelf=${shelfId}`)
    const page = (await scoped.json()) as { books: {id: string}[]; total: number }
    expect(page.total).toBe(2)
    expect(page.books.map((b) => b.id).sort()).toEqual(['lib-1', 'lib-3'])
    // The default order inside a shelf is Date Added to Shelf, descending —
    // compared against the same query with the sort named, not re-derived here
    const named = await get(`/api/library?shelf=${shelfId}&sort=shelf_added&dir=desc`)
    expect(page.books.map((b) => b.id)).toEqual(((await named.json()) as typeof page).books.map((b) => b.id))
    // A search inside the shelf searches the shelf
    const searched = await get(`/api/library?shelf=${shelfId}&q=Charlie`)
    expect(((await searched.json()) as typeof page).total).toBe(1)
  })

  it('carries the member on the page and the detail, and [] on a book no shelf holds', async () => {
    const page = (await (await get(`/api/library?shelf=${shelfId}`)).json()) as {
      books: { id: string; shelves: string[] }[]
    }
    expect(page.books.every((b) => b.shelves.includes(shelfId))).toBe(true)

    const detail = (await (await get('/api/books/lib-1')).json()) as { shelves: string[] }
    expect(detail.shelves).toEqual([shelfId])
    const unshelved = (await (await get('/api/books/lib-2')).json()) as { shelves: string[] }
    expect(unshelved.shelves).toEqual([])
  })

  it('scopes the facets through the same builder', async () => {
    const res = await get(`/api/library/facets?shelf=${shelfId}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(db.getFacets({ shelfId }))
  })

  it('answers 404 for an unknown shelf on both routes, and writes nothing', async () => {
    for (const path of ['/api/library?shelf=no-such-shelf', '/api/library/facets?shelf=no-such-shelf']) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not found' })
    }
  })

  it('answers 400 for an empty shelf and for shelf_added with no shelf to order by (S4, S5)', async () => {
    for (const path of ['/api/library?shelf=', '/api/library/facets?shelf=', '/api/library?sort=shelf_added']) {
      const res = await get(path)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad request' })
    }
  })

  it('answers the reads from the cache while the share is unmounted (D10)', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(false)
    expect((await get('/api/shelves')).status).toBe(200)
    expect((await get(`/api/library?shelf=${shelfId}`)).status).toBe(200)
    expect((await get(`/api/library/facets?shelf=${shelfId}`)).status).toBe(200)
  })
})
```

Imports the describe needs: `mkdtempSync`, `rmSync` from `fs`, `tmpdir` from `os`, `join` from `path`, and `* as shelves from '../services/shelves'` — plus the shared `seedLibrary` helper that already exists in the file.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- electron/main/api/rest.test.ts`
Expected: every new case fails (404s for `/api/shelves`, 400 for the scoped reads once the query refusals land green, and so on).

- [ ] **Step 3: Wire the routes**

In `rest.ts`: add the constant beside the other three route constants

```ts
const SHELVES_ROUTE = '/api/shelves'
```

extend the imports — `shelvesPayload` from `../services/api/shape`; `parseShelfParam` from `../services/api/query`; `bookExists`, `shelfExists`, `listShelvesWithUpdatedAt`, `shelfIdsForBooks` from `../services/db` — and add the one helper every shelf-aware answer shares:

```ts
/** One book's shelf ids, through the same batched read the page uses (D10, S7). */
function shelfIdsFor(bookId: string): string[] {
  return shelfIdsForBooks([bookId]).get(bookId) ?? []
}
```

The shelves route, after the facets arm:

```ts
    if (json && url.pathname === SHELVES_ROUTE) {
      // The cache's own answer — 200 while the share is offline, like every
      // other JSON read (D10). `count` counts only members the library holds
      // (D6), and `updatedAt` is the shelf file's own clock.
      sendJson(res, 200, shelvesPayload(listShelvesWithUpdatedAt()))
      return
    }
```

the library arm gains its scope check and its batch:

```ts
      const { filters, query, limit, offset } = parsed.query
      // An unknown shelf is a 404, answered from the cache before any query runs
      // (D10/S3) — the same answer whether the share is mounted or not, because
      // this route never touches it.
      if (filters.shelfId && !shelfExists(filters.shelfId)) {
        sendJson(res, 404, errorPayload('notFound'))
        return
      }
      const page = query
        ? searchBooksPage(query, { limit, offset }, filters)
        : getBooksPage(filters, { limit, offset })
      sendJson(
        res,
        200,
        libraryPayload({
          ...page,
          shelves: shelfIdsForBooks(page.books.map((book) => book.id))
        })
      )
      return
```

the facets arm gains the scope (and the comment keeps its "not narrowed by the list route's filters" sentence, now with the shelf exception):

```ts
    if (json && url.pathname === FACETS_ROUTE) {
      const shelf = parseShelfParam(url.searchParams)
      if (!shelf.ok) {
        sendJson(res, 400, errorPayload('badRequest'))
        return
      }
      if (shelf.shelfId && !shelfExists(shelf.shelfId)) {
        sendJson(res, 404, errorPayload('notFound'))
        return
      }
      // Computed once over the whole library — or one shelf, when `shelf` is
      // given — and deliberately not narrowed by the list route's filters: a
      // facet count that followed the current filter would tell a client
      // nothing about what it could filter *to* (bookshelves D7/D10).
      sendJson(res, 200, facetsPayload(getFacets(shelf.shelfId ? { shelfId: shelf.shelfId } : undefined)))
      return
    }
```

and the three book-answering arms fill the member:

```ts
        sendJson(res, 200, bookPayload(found, shelfIdsFor(found.id)))            // detail
        sendJson(res, 200, readingPayload({ applied: outcome.applied, book: outcome.book, shelves: shelfIdsFor(outcome.book.id) }))   // the reading write
        sendJson(res, 201, importPayload({ book, duplicate: outcome.result.duplicate ?? null, shelves: shelfIdsFor(book.id) }))       // the upload
```

(The file's own docblock — the "Route by route" list — gains `/api/shelves` with its `shelf`-scoped neighbours.)

- [ ] **Step 4: The document's prose for the read surface**

In `docs/rest-api.md`:

1. The **Status** line: `**Version 1** … **Status:** the read surface, the one write, and the upload — slices 1b, 1c and 2 of the iOS companion workstream …, and the shelf surface — slice 5 of the bookshelves workstream (`docs/superpowers/specs/2026-09-27-bookshelves-design.md`).`
2. **Methods**: "**Every read route answers `GET`; two routes are writes.** The four JSON routes — …" becomes "**Every read route answers `GET`; four routes are writes.** The five JSON routes — `/api/health`, `/api/library`, `/api/library/facets`, `/api/books/{id}` and `/api/shelves` — also answer **`HEAD`** …" and the closing sentence "A client may use either method on those four routes." becomes "…on those five routes."
3. **Routes table**: three new rows —

   `| GET /api/shelves | the shelves, alphabetically | 200, 401, 500 |`
   `| PUT /api/shelves/{id}/books/{bookId} | the book, after adding it to the shelf | 200, 401, 404, 500, 503 |`
   `| DELETE /api/shelves/{id}/books/{bookId} | the book, after removing it | 200, 401, 404, 500, 503 |`

   (The write rows land here with the read row; their section is Task 6's.)
4. **`GET /api/library`**: a `shelf` parameter row — *"Scopes the page to one shelf (bookshelves D10). With `shelf` and no `sort` (and no `q`), the order is `shelf_added` descending — **Date Added to Shelf**, the Mac's own default inside a shelf. An unknown shelf is a **404**; a present-but-empty `shelf` and a `sort=shelf_added` with no shelf are **400**s."* — and the walking paragraph's 400 list gains `shelf` values and the `shelf_added` rule.
5. **`GET /api/library/facets`**: one sentence — *"`?shelf={id}` scopes the counts to one shelf, through the same builder the list route scopes its page with; an unknown shelf is a 404."*
6. A new section after the facets section:

```markdown
### `GET /api/shelves`

Every shelf, alphabetically (case-insensitively), each with the count of books the library holds for it and the shelf file's own clock. **Names are here and nowhere else** — a book payload carries shelf ids, so a rename changes this response and no book.

```json payload=… (already added in Task 3)
```

| Field       | Meaning                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`        | The shelf's id — opaque, and what every other shelf route takes.                                                    |
| `name`      | As the Mac's sidebar shows it.                                                                                      |
| `kind`      | `manual` for every shelf this build creates; a shelf of a kind this build does not know is not on the wire at all.  |
| `count`     | Books on the shelf **that the library holds** (D6) — a member whose file is missing everywhere is counted nowhere.   |
| `updatedAt` | The shelf file's `updated_at`: the last write that changed the shelf (a no-op write does not move it).              |

Answers **200 from the cache while the library is offline**, like every other JSON read.
```

7. The book field list (under `GET /api/books/{id}`): "Three members deserve their own sentence" → **four**, with — *"**`shelves`** is the ids of the shelves this book is on — always present, `[]` when none. Ids only: names come from `/api/shelves`, so a rename changes no book payload, and the list's order is the shelf list's own."*
8. **Failure semantics**: the first row's cache sentence gains `/api/shelves`; two new rows — *"A shelf-scoped read for an unknown shelf | **404**, the uniform refusal"* and *"A shelf write while the share is not mounted | **503** `library offline` with `Retry-After: 5` — refused before anything is written (the shelf service's own `assertOnline`, D3 of the bookshelves design)."*
9. **Errors** table: the 400 row gains "an empty `shelf` or a `sort=shelf_added` with no `shelf`"; the 404 row gains "an unknown shelf".

- [ ] **Step 5: Run the socket cases, then the suite**

Run: `npm test -- electron/main/api/rest.test.ts`, then `npm run typecheck && npm run lint && npm test`
Expected: green. Then `npx prettier --write` on `electron/main/api/rest.ts` and `electron/main/api/rest.test.ts` before the lint run (the constraint above).

- [ ] **Step 6: Commit**

```bash
git add electron/main/api/rest.ts electron/main/api/rest.test.ts docs/rest-api.md
git commit -m "shelves slice 5: the shelf list, the scope, and the member on the wire

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**— Part 5a review gate.** Green suite, then a review (report only, modify nothing) against: `shape.ts`'s pinned import list still exactly two lines; `query.ts`/`routes.ts` still pure (the combined case); `apiVersion` still 1; no file outside `electron/main/`, `docs/`, `scripts/` in the diff; the doc↔goldens parity case actually deciding the new member (not vacuously passing — check it fails if the doc block's `shelves` is changed); and that the batch read is one query, not one per book. The live check for 5a is deferred to Task 7's single run, because the smoke script is the instrument and it needs the writes — said plainly rather than faked with a curl pass that would not be the script.

---

# Part 5b — the two writes

### Task 5: the membership matcher, and the gone-shelf predicate (S3, S9)

**Files:**

- Modify: `electron/main/services/api/routes.ts`
- Modify: `electron/main/services/shelves.ts`
- Modify: `electron/main/services/api/query.test.ts`
- Modify: `electron/main/services/shelves.test.ts`

- [ ] **Step 1: Write the failing cases**

In `query.test.ts`, after the `matchBookPath` describe:

```ts
describe('matchShelfMembershipPath — the membership write (bookshelves D10)', () => {
  it('names both ids for the one shape it answers', () => {
    expect(matchShelfMembershipPath('/api/shelves/abc/books/def')).toEqual({
      shelfId: 'abc',
      bookId: 'def'
    })
  })

  it('decodes both segments, so an id with a space is still an id', () => {
    expect(matchShelfMembershipPath('/api/shelves/a%20b/books/c%2Fd')).toEqual({
      shelfId: 'a b',
      bookId: 'c/d'
    })
  })

  it.each([
    '/api/shelves',
    '/api/shelves/',
    '/api/shelves/abc',
    '/api/shelves/abc/books',
    '/api/shelves/abc/books/def/extra',
    '/api/shelves/abc/shelf/def',
    '/api/books/abc'
  ])('answers null for a path that is not the membership shape (%s)', (pathname) => {
    expect(matchShelfMembershipPath(pathname)).toBeNull()
  })

  it('answers null for a malformed escape rather than throwing', () => {
    expect(matchShelfMembershipPath('/api/shelves/%E0%A4%A/books/b')).toBeNull()
    expect(matchShelfMembershipPath('/api/shelves/a/books/%')).toBeNull()
  })
})
```

In `shelves.test.ts` (it already imports `* as shelves` and `SHELF_GONE` is exported):

```ts
describe('the gone-shelf predicate the REST surface reads (slice 5)', () => {
  it('recognises the writer own refusal, and nothing else', async () => {
    const shelf = await shelves.create('To Read')
    await shelves.deleteShelf(shelf.id)

    const err: unknown = await shelves.addBooks(shelf.id, ['a']).catch((e: unknown) => e)
    expect((err as Error).message).toBe(shelves.SHELF_GONE)
    expect(shelves.isShelfGone(err)).toBe(true)
    expect(shelves.isShelfGone(new Error('something else'))).toBe(false)
    expect(shelves.isShelfGone('not an error')).toBe(false)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- electron/main/services/api/query.test.ts electron/main/services/shelves.test.ts`
Expected: compile failures — neither function exists.

- [ ] **Step 3: Write both**

In `routes.ts`, beside `isBooksCollection`:

```ts
/** Only `/api/shelves/`-prefixed paths reach the membership matcher below. */
export const SHELVES_PREFIX = '/api/shelves/'

export interface ShelfBookPath {
  shelfId: string
  bookId: string
}

/**
 * `/api/shelves/{shelfId}/books/{bookId}` — the membership write (bookshelves
 * D10), and the API's first `DELETE`.
 *
 * Matched on the **pathname only**, never on a query (the path takes none), and
 * deliberately not on the method: matching says what a client aimed at, and the
 * router answers a known path behind a method it does not take with the same
 * uniform 404 as a path that is nothing at all (D11).
 */
export function matchShelfMembershipPath(pathname: string): ShelfBookPath | null {
  if (!pathname.startsWith(SHELVES_PREFIX)) return null

  const [shelfSegment, books, bookSegment, ...rest] =
    pathname.slice(SHELVES_PREFIX.length).split('/')
  if (rest.length || books !== 'books' || !shelfSegment || !bookSegment) return null

  const shelfId = decodeSegment(shelfSegment)
  const bookId = decodeSegment(bookSegment)
  return shelfId && bookId ? { shelfId, bookId } : null
}
```

In `shelves.ts`, beside the error class:

```ts
/**
 * Whether a mutation refused because its shelf was gone from the re-read file
 * (`SHELF_GONE`) — the REST surface's 404 (bookshelves D10, S3). A predicate
 * rather than the class: the class stays private and the wire's mapping stays
 * one call.
 */
export function isShelfGone(err: unknown): boolean {
  return err instanceof ShelfGoneError
}
```

- [ ] **Step 4: Run the cases, then the suite**

Run: `npm test -- electron/main/services/api/query.test.ts electron/main/services/shelves.test.ts`, then `npm run typecheck && npm run lint`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/api/routes.ts electron/main/services/shelves.ts \
        electron/main/services/api/query.test.ts electron/main/services/shelves.test.ts
git commit -m "shelves slice 5: the membership matcher and the gone-shelf predicate

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 6: the two write routes (AC31; S2, S8, S10)

**Files:**

- Modify: `electron/main/api/rest.ts`
- Modify: `electron/main/api/rest.test.ts`
- Modify: `docs/rest-api.md` (the writes' prose)

- [ ] **Step 1: Write the failing socket cases**

In `rest.test.ts`, a second new describe (same root/service setup as Task 4's, plus the file on disk read back):

```ts
describe('the shelf membership writes', () => {
  // …the same root + seedLibrary + shelves.create('To Read', ['lib-1']) setup;
  // `readfile` reads {root}/shelves.json through the real reader:
  //   const disk = async () => (await readShelvesFile(root)) — a case reads its members.

  it('adds on PUT and answers the book with the shelf on it, after the write (S8)', async () => {
    const res = await fetch(`${base}/api/shelves/${shelfId}/books/lib-2`, { method: 'PUT', headers: auth })
    expect(res.status).toBe(200)
    const { book } = (await res.json()) as { book: { id: string; shelves: string[] } }
    expect(book.id).toBe('lib-2')
    expect(book.shelves).toContain(shelfId)
    // The write reached the canonical file, not only the cache
    const members = (await readShelvesFile(root)).file?.shelves[0]… // the manual shelf's books
    expect(members).toContain('lib-2')
  })

  it('is idempotent: a second PUT answers 200 and keeps the first added_at (AC31)', async () => {
    await put('/api/shelves/' + shelfId + '/books/lib-2')
    const first = addedAtOf('lib-2')
    const again = await put(…)
    expect(again.status).toBe(200)
    expect(addedAtOf('lib-2')).toBe(first)
  })

  it('removes on DELETE and it, too, is idempotent (AC31)', async () => {
    // lib-1 is on the shelf from the setup: DELETE takes it off, the answer says
    // so, the file agrees, and a second DELETE of the removed book is still 200
  })

  it('answers 404 for an unknown shelf and an unknown book, and writes nothing (AC31)', …)

  it('answers 503 library offline with Retry-After: 5 before anything is written (AC31, S10)', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(false)
    const res = await put(`/api/shelves/${shelfId}/books/lib-2`)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('5')
    expect(await res.json()).toEqual({ error: 'library offline' })
    // Nothing was attempted and nothing was written — the file holds what it did
  })

  it('answers 404 to GET, HEAD, POST and PATCH on the membership path (S9)', …)

  it('answers 500 and never overwrites a shelves.json that cannot be read (S2)', async () => {
    writeFileSync(join(root, 'shelves.json'), 'not json at all')
    const before = readFileSync(join(root, 'shelves.json'))
    const res = await put(`/api/shelves/${shelfId}/books/lib-2`)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(readFileSync(join(root, 'shelves.json'))).toEqual(before)
  })

  it('broadcasts shelvesChanged, so the Mac sidebar follows a phone write (D10)', …)
})
```

(The shapes above name every assertion; the case bodies follow the file's existing style — `put`/`get` helpers, `rawRow`-style direct reads where a column is the claim. `readShelvesFile` comes from `../services/shelves-file`; `subscribe` from `../services/events` for the broadcast case.)

Also extend `shape.test.ts`'s route-names case with the membership path, since the document names it from this task on:

```ts
    expect(DOC).toContain('/api/shelves')
    // The membership path is a *write*, so it is asserted in its method+path
    // form — a bare path would also match the read route's prefix
    expect(DOC).toContain('/api/shelves/{id}/books/{bookId}')
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- electron/main/api/rest.test.ts`
Expected: every case in the new describe fails with 404 (the path matches nothing yet).

- [ ] **Step 3: Wire the route**

In `rest.ts`: imports gain `addBooks`, `removeBooks`, `isShelfGone` from `../services/shelves` and `matchShelfMembershipPath`, `type ShelfBookPath` from `../services/api/routes`; the arm sits after the upload's, before `matchBookPath`:

```ts
    // **The third and fourth writes** (bookshelves D10): the membership toggle,
    // and the API's first `DELETE`. The path matches; the method decides — and
    // anything but PUT or DELETE falls through to the uniform 404, because a
    // known path behind a method it does not answer is not distinguished from
    // no path at all (D11).
    const membership = matchShelfMembershipPath(url.pathname)
    if (membership) {
      if (req.method === 'PUT' || req.method === 'DELETE') {
        await handleShelfMembership(req, res, membership, req.method === 'PUT')
        return
      }
    }
```

and the handler, beside `handleReadingReport`:

```ts
/**
 * `PUT|DELETE /api/shelves/{shelfId}/books/{bookId}` — the membership toggle
 * (bookshelves D10).
 *
 * **Idempotent by the service's own rules, not by a check here:** an add of an
 * existing member keeps its `added_at` and writes nothing (`Applied.changed`),
 * and a remove of a non-member is the same no-op — both answer 200. **The
 * answer is the book read back after the write** (S8), in the detail shape: the
 * write and the read that follows it are one round trip, exactly as the reading
 * report's answer is.
 *
 * The order is S10's: the share (503, `Retry-After: 5`) before the resources
 * (404) — the cover and file routes' own order, kept because the client's retry
 * decision does not depend on whether the shelf exists. The existence checks run
 * on the **cache**, before anything is attempted, because the service skips
 * unknown book ids silently (it must — the Mac's own callers rely on that) and
 * would otherwise answer 200 for a book that is not there (S3).
 */
async function handleShelfMembership(
  req: IncomingMessage,
  res: ServerResponse,
  path: ShelfBookPath,
  add: boolean
): Promise<void> {
  if (!nas.isOnline()) {
    sendUnavailable(res, 'offline')
    return
  }

  if (!shelfExists(path.shelfId) || !bookExists(path.bookId)) {
    sendJson(res, 404, errorPayload('notFound'))
    return
  }

  try {
    if (add) await addBooks(path.shelfId, [path.bookId])
    else await removeBooks(path.shelfId, [path.bookId])
  } catch (err) {
    if (isShelfGone(err)) {
      // Deleted between the check above and the mutation's own re-read of the
      // file (D3's *That shelf no longer exists*) — the same 404, from the
      // writer's own answer (S3)
      sendJson(res, 404, errorPayload('notFound'))
      return
    }
    // An unreadable `shelves.json` lands here (S2): refused, never overwritten
    // (D3), with the service's own sentence in the log where a person can read
    // it — the wire gets the fixed word, as the upload's `internal` does
    console.warn(`[rest] ${req.method} ${req.url} — shelf write failed: ${describeError(err)}`)
    sendJson(res, 500, errorPayload('internal'))
    return
  }

  const book = getBook(path.bookId)
  if (!book) {
    // Unreachable by construction — the id was checked above and nothing in this
    // path deletes a book — so it is answered as this module's own failure
    // rather than asserted away (invariant 12), the upload handler's own shape
    console.warn('[rest] shelf write answered for a book the cache does not hold')
    sendJson(res, 500, errorPayload('internal'))
    return
  }

  sendJson(res, 200, bookPayload(book, shelfIdsFor(book.id)))
}
```

- [ ] **Step 4: The document's prose for the writes**

In `docs/rest-api.md`:

1. **Methods** — after the `POST /api/books` paragraph:

> `PUT` and `DELETE` on `/api/shelves/{id}/books/{bookId}` are the **third and fourth writes**, and the API's **first `DELETE`**: they take **no body**, and the path answers 404 to a `GET`, a `HEAD` and every other method. Each is **idempotent** — a book already on the shelf keeps the place it has, and removing one that was never on it is a success — because the shelf file's own rules are (D3 of the bookshelves design). The answer is the book **as it stands after the write**, in the detail shape, so a toggle and its confirmation are one round trip.

2. The reads sentence "Every other method, and every path that is not one of the routes below…" stays untouched.

3. A new section after `GET /api/shelves`:

```markdown
### `PUT` and `DELETE /api/shelves/{id}/books/{bookId}`

**The membership toggle** (bookshelves D10). `PUT` puts the book on the shelf; `DELETE` takes it off. Neither takes a body, and both answer the book **as it stands after the write** — the same shape `GET /api/books/{id}` answers, `shelves` member included — so a client that has just toggled a checkbox holds its refreshed row.

Both are **idempotent**: putting a book on a shelf it is already on keeps its original place (an existing member's `added_at` is never re-stamped), removing one that is not on the shelf succeeds, and neither writes anything to the share. That, and the two ids in the path, is what makes a queued or replayed toggle safe.

| Answer | When |
| ------ | ---- |
| **200** | The membership stands as asked, and the body is the book. |
| **400** | — never: the path takes no parameters and no body. A malformed percent-escape in either segment is not this route's path at all, and answers the uniform 404. |
| **404** | An unknown shelf, an unknown book, or any method but `PUT` and `DELETE` on the path. Uniform and reason-free (D11). |
| **500** | A handler failed — **or the shelf file cannot be read**: a `shelves.json` that does not parse (or carries an unknown `version`) refuses every shelf write rather than being overwritten, and the reason is in the Mac's log (bookshelves D3). The file is left exactly as it was. |
| **503** | The share is not mounted: `{"error":"library offline"}` with `Retry-After: 5`, **refused before anything is written** — the shelf service's own `assertOnline` (D3). |

The write goes through `electron/main/services/shelves.ts` — the same single writer the Mac's own sidebar, menus and drag targets use — so a phone's toggle lands in `shelves.json` atomically, updates the Mac's sidebar through `shelves:changed`, and is repaired by the next adoption if a crash falls between the file and the cache.
```

4. **Not in this version** gains: *"Shelf create, rename and delete are **not** on the wire and are not planned — the phone browses shelves and toggles membership, by decision (bookshelves D10/D11). Smart shelves do not exist yet; the file format carries a `kind` for them and the reader skips an unknown one."*

5. **Checking a live server** section: the new checks are described in Task 7.

- [ ] **Step 5: Run it, then the suite**

Run: `npm test -- electron/main/api/rest.test.ts`, then `npm run typecheck && npm run lint && npm test`, with `npx prettier --write` on the two code files first.
Expected: green — the file grows by the membership describe's cases (eight or so).

- [ ] **Step 6: Commit**

```bash
git add electron/main/api/rest.ts electron/main/api/rest.test.ts docs/rest-api.md electron/main/services/api/shape.test.ts
git commit -m "shelves slice 5: the membership writes, and the first DELETE on the wire

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 7: the contract's executable half, and the live run (AC33)

**Files:**

- Modify: `scripts/api-smoke.sh`

- [ ] **Step 1: The header comment**

The paragraph beginning *"**Two sections write — slice 1c's reading report and slice 2's upload — and they are the only ones that do."* becomes a three-section sentence: the shelves section's `PUT`/`DELETE` pair adds a membership to the first shelf and removes it again, **restoring the profile's state**, and it is skipped with a note when the profile holds no shelf or the run's own upload is already on one.

- [ ] **Step 2: The section** (placed after the upload section, before the cover bytes — `UPLOAD_ID` exists by then)

```bash
printf '\n--- shelves (slice 5)\n'

code=$(request /api/shelves)
check 'GET /api/shelves answers 200' 200 "$code"
check 'the payload carries a shelves array' 'array' "$(jq -r '.shelves | type' "$BODY")"

SHELF_ID="$(jq -r '.shelves[0].id // empty' "$BODY")"

code=$(request '/api/library?shelf=no-such-shelf')
check 'scoping by an unknown shelf answers 404' 404 "$code"

code=$(request '/api/library?sort=shelf_added')
check 'sort=shelf_added without a shelf answers 400' 400 "$code"

code=$(request '/api/library?shelf=')
check 'a present-but-empty shelf answers 400' 400 "$code"

HEAD_RESULT="$(curl -sS --head --max-time "$TIMEOUT" -D "$HEADERS" -o /dev/null \
  -w '%{http_code} %{size_download}' "${AUTH[@]}" "$BASE/api/shelves" 2>/dev/null)"
check 'HEAD /api/shelves answers 200' 200 "${HEAD_RESULT%% *}"
check 'the HEAD downloads no body' 0 "${HEAD_RESULT##* }"

if [ -z "$SHELF_ID" ]; then
  note 'the profile holds no shelf — the scoped and membership checks were not exercised'
else
  SHELF_COUNT="$(as_number "$(jq -r --arg id "$SHELF_ID" '.shelves[] | select(.id == $id) | .count' "$BODY")")"

  code=$(request "/api/library?shelf=$SHELF_ID&limit=5")
  check 'GET /api/library?shelf={id} answers 200' 200 "$code"
  check 'the scoped total equals the count /api/shelves reports' "$SHELF_COUNT" \
    "$(as_number "$(jq -r '.total' "$BODY")")"
  check 'every book on the page declares the shelf it was scoped to' 'yes' \
    "$(jq -r --arg id "$SHELF_ID" 'if all(.books[]; (.shelves | index($id)) != null) then "yes" else "no" end' "$BODY")"

  DEFAULT_ORDER="$(jq -c '[.books[].id]' "$BODY")"
  request "/api/library?shelf=$SHELF_ID&limit=5&sort=shelf_added&dir=desc" >/dev/null
  check 'the default order inside a shelf is Date Added to Shelf, descending' \
    "$DEFAULT_ORDER" "$(jq -c '[.books[].id]' "$BODY")"

  code=$(request "/api/library/facets?shelf=$SHELF_ID")
  check 'GET /api/library/facets?shelf={id} answers 200' 200 "$code"

  if [ -z "${UPLOAD_ID:-}" ]; then
    note 'the run imported no book — the membership pair was not exercised'
  else
    request "/api/books/$UPLOAD_ID" >/dev/null
    if [ "$(jq -r --arg id "$SHELF_ID" '.shelves | index($id) != null' "$BODY")" = true ]; then
      note "the run's own upload is already on the first shelf — the membership pair was not exercised"
    else
      code=$(request "/api/shelves/$SHELF_ID/books/$UPLOAD_ID" -X PUT)
      check 'PUT /api/shelves/{id}/books/{bookId} answers 200' 200 "$code"
      check 'the answer carries the book with the shelf now on it' 'yes' \
        "$(jq -r --arg id "$SHELF_ID" 'if .book.id == $bid and ((.book.shelves | index($id)) != null) then "yes" else "no" end' --arg bid "$UPLOAD_ID" "$BODY")"

      code=$(request "/api/shelves/$SHELF_ID/books/$UPLOAD_ID" -X PUT)
      check 'a second PUT answers 200 — the write is idempotent' 200 "$code"

      code=$(request "/api/books/$UPLOAD_ID")
      check 'the membership reads back on the detail route' 'yes' \
        "$(jq -r --arg id "$SHELF_ID" 'if (.shelves | index($id)) != null then "yes" else "no" end' "$BODY")"

      code=$(request "/api/shelves/$SHELF_ID/books/$UPLOAD_ID" -X DELETE)
      check 'DELETE /api/shelves/{id}/books/{bookId} answers 200' 200 "$code"
      check 'the answer carries the book with the shelf off it' 'yes' \
        "$(jq -r --arg id "$SHELF_ID" 'if .book.id == $bid and ((.book.shelves | index($id)) == null) then "yes" else "no" end' --arg bid "$UPLOAD_ID" "$BODY")"

      code=$(request "/api/shelves/$SHELF_ID/books/$UPLOAD_ID" -X DELETE)
      check 'a DELETE of a non-member answers 200 — also idempotent' 200 "$code"
    fi

    code=$(request "/api/shelves/not-a-shelf/books/$UPLOAD_ID" -X PUT)
    check 'a membership write for an unknown shelf answers 404' 404 "$code"

    code=$(request "/api/shelves/$SHELF_ID/books/not-a-book" -X PUT)
    check 'a membership write for an unknown book answers 404' 404 "$code"

    code=$(request "/api/shelves/$SHELF_ID/books/not-a-book")
    check 'a GET of the membership path answers 404' 404 "$code"
  fi
fi

note 'the offline 503 on a shelf write is not exercised here — it needs the share taken down; its rules are decided over a socket in electron/main/api/rest.test.ts'
```

(The `--arg bid` hoisting above is a sketch: `jq` takes both `--arg id` and `--arg bid` in one invocation — write it that way.)

- [ ] **Step 3: Prepare a profile that holds a shelf, and run it**

The script cannot create a shelf (shelf create/rename/delete stay on the Mac by decision), so this step is the operator's: on a **scratch profile**, write a `shelves.json` with one shelf into the profile's library root *before* the app starts (the canonical format, hand-authored — exactly what another Mac's write looks like to this one), start the app on that profile, run

```bash
MUSAEUM_USER_DATA=<scratch profile> bash scripts/api-smoke.sh
```

Expected: **every line PASS, 0 FAIL** — the old 70 checks plus this section's, and the membership pair restoring the shelf it borrowed (the uploaded book, off the shelf again, at the end of the run). Record the real passed count in the plan's record.

- [ ] **Step 4: Commit**

```bash
git add scripts/api-smoke.sh
git commit -m "shelves slice 5: the smoke script learns the shelf routes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 8: the docs that land with this slice, and the v1 phone's decode (AC32)

**Files:** markdown only, plus the cross-repo verification run.

- [ ] **Step 1: `docs/invariants/shelves.md`**

- Line 58's REST sentence (*"On the REST surface, `sort=shelf_added` is refused with 400 until slice 5 gives that surface a `shelf` parameter to scope by…"*) becomes the settled rule: refused with 400 **without** a `shelf`, allowed and ordered by the correlation **with** one, and the default order inside a scoped read when neither a sort nor a search was asked for.
- A short new section, `## The REST surface (slice 5)`, after *A shelf is a scope*: `GET /api/shelves` answers the cache whatever the share is doing; every book payload carries `shelves` (ids only — names come from the list route, so a rename touches no book); the two membership routes are the same funnel as every other write (`services/shelves.ts`, one serial queue, file then cache), pre-checked on the cache for a 404 with `isShelfGone` as the re-read race's backstop; an unreadable file answers 500 and is never overwritten; a share that is down answers 503 before anything is attempted.
- The closing paragraph's "What remains" sentence: slices 3 and 5 landed; what remains is **sending a shelf to a Kindle (slice 4)** and **the phone (slice 6, in `musaeum-ios`)**.

- [ ] **Step 2: `CHANGELOG.md`, `tasks.md`, the spec's Status, and CLAUDE.md's count**

- `CHANGELOG.md` gains its *Added* line for the shelf routes (the doc, the two writes, the scope, the member).
- `tasks.md`: the bookshelves entry moves slice 5 to landed, names slice 6 (the phone) as what it unblocks, and keeps slice 4 open as the one desktop item left.
- The spec's **Status** line: slice 5 landed 2026-09-28 — plan `docs/superpowers/plans/2026-09-28-bookshelves-slice5.md`; **Next step:** slice 6, the phone — its annex is written in `musaeum-ios/docs/plans/` only now that this lands; slice 4 remains open and desktop-only.
- `CLAUDE.md`'s iOS Companion bullet 3 (*"six read routes and two writes (the reading report and a book upload)"*) becomes the true count: **seven read routes and four writes** (the reading report, a book upload, and the shelf membership's `PUT`/`DELETE`).

- [ ] **Step 3: AC32's second half — re-vendor and decode in the phone's own repo**

```bash
cd ../musaeum-ios
scripts/vendor-contract-fixtures.sh          # re-extracts every json payload= block
git -C . status --short                       # the diff is the new blocks, nothing else
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
DEV=DE0B5601-7874-455E-A965-9AD80567C30E     # iPhone 17 Pro, iOS 26.1
xcodebuild -project Musaeum.xcodeproj -scheme Musaeum -destination "id=$DEV" -derivedDataPath ./DD test
```

Expected: the fixture timer recounts (the new `shelves` block is one more file), and the suite is **green without source changes** — `ContractDecodeTests` decoding the re-vendored fixtures is the "v1 phone still decodes" claim, and the additive fields (`shelves` on every book payload) are ignored by `StrictObject`. **If a prompt appears asking to install a newer SDK or the device has gone, stop and say so rather than editing that repo** — no file in `musaeum-ios` may change in this slice; the re-vendored `Tests/Fixtures/contract/*.json` are regenerated output, and whether to commit them is slice 6's call (its annex re-runs the script anyway). Record what the run measured.

- [ ] **Step 4: the plan's own record**

Append `## Built — slice 5` with: the commit list, the real counts (`git diff --stat` against `7bfa5ba`, and the suite's own totals after each task — state the real numbers, not this plan's guesses), the live smoke run's passed count and profile setup, the iOS decode run's result, every divergence from this plan, and **what was not exercised** (stated plainly).

- [ ] **Step 5: Verify and commit**

Run: `npm test` (the docs change no behaviour, but the walks and the goldens read these neighbours).

```bash
git add docs/invariants/shelves.md CHANGELOG.md tasks.md CLAUDE.md \
        docs/superpowers/specs/2026-09-27-bookshelves-design.md \
        docs/superpowers/plans/2026-09-28-bookshelves-slice5.md
git commit -m "shelves slice 5: the wire's rules, the status lines, and the record

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**— Part 5b review gate, and the slice's last.** The reviewer's list, against the invariants: no file under `src/`, `electron/main/ipc/`, the preload or `sidecar/` in the diff (the brief's staging claims 3 and 6 intact); `apiVersion` still 1; the funnel holds (both writes call `services/shelves.ts` — no second `shelves.json` writer anywhere); the doc's three artifacts agree (the parity case is not vacuous — change one field in a doc block and watch it go red); `shape.ts`'s import list is still its pinned two lines; `query.ts`/`routes.ts` still import no db/NAS/filesystem; the smoke script's membership pair leaves the profile as it found it. **And the one question a walk cannot answer:** does a phone write reach the Mac's sidebar — which the `shelves:changed` socket case answers, and which the reviewer should re-derive rather than take on trust.

---

## Not verified in this plan

1. **That the smoke profile used for AC33 holds a shelf.** The script cannot create one by decision, so the run needs a profile whose root carries a hand-written `shelves.json` — named as a step, and a run against a shelf-less profile is honest with a note rather than red.
2. **The iOS decode run's environment.** `xcodebuild` on this machine has moved once already (the iPhone 18 Pro device is gone; the gates run on iPhone 17 Pro / iOS 26.1). If the toolchain refuses, AC32's second half is **blocked**, stated as such — not inferred from the fixture count alone.
3. **The phone's behaviour itself** — every claim about `musaeum-ios`'s screens, its capability probe and its checklist is slice 6's, in that repo's annex, against *this* document.

## Handoff notes for slice 6 (the phone)

- The annex is `musaeum-ios`'s, in `docs/plans/`, numbered in that repo's own sequence (the share-out was `2026-09-24-slice5-share-out.md`; the reader polish was `slice6`), and is written **now that this document exists** — it takes its fixtures from `docs/rest-api.md`'s blocks by script, never by restating them.
- **Capability detection is `GET /api/shelves` → 404 means no shelf UI** (D10's correction: `apiVersion` stays 1, so an installed phone must not be locked out).
- **`shelves` on the book model is the one deliberate exception to that repo's strict decoding**: an older Mac omits the member, so it must read as `[]` when absent (`StrictObject` throws on a missing key). The annex records it as the exception it is.
- The writes are **idempotent**, so a `ReportQueue`-style replay is safe (D11); whether v1 queues or refuses is the annex's decision, recorded there.
- `count` is the cache's membership; a shelf member whose file is missing counts nowhere, and the phone should not invent a second count.

---

## Built — slice 5

Landed 2026-09-28, main process + the contract artifacts + docs, in nine commits before this record:

| Commit | What |
| --- | --- |
| `353d124` | the plan itself, executed in the session that wrote it |
| `d009b07` | Task 1 — the cache reads (`shelfExists`, `shelfIdsForBooks`, `listShelvesWithUpdatedAt`) and their cases |
| `6527734` | Task 2 — the `shelf` parameter, `parseSort(params, hasShelf)`, the Date-Added-to-Shelf default |
| `966969e` | Task 3 — the `shelves` member on every book payload, the shelf list's shape, the document's blocks (incl. `payload=shelves`), and `rest.ts`'s four call sites |
| `5a90d18` | Task 4 — `GET /api/shelves`, the scope on both read routes, the member filled at every call site, the read surface's prose, the socket cases |
| `3f3ef69` | Task 5 — `matchShelfMembershipPath` and `isShelfGone` |
| `d234368` | Task 6 — the membership `PUT`/`DELETE`, `membershipPayload`, the writes' document prose, their socket cases |
| `ebc59df` | Task 7 — the smoke script's shelf section |
| `e8a5fd9` | the live run's own find: the smoke script read the shelf count after later requests had clobbered the body, so its scoped-total check always compared against 0 |
| (this commit) | Task 8 — the rules in `shelves.md`, the status lines, this record, and the iOS decode run |

**Real counts, as measured.** `git diff --stat 7bfa5ba..HEAD` before this record: **14 files, +2646 / −85** — six code files (`services/db`, `services/shelves`, `services/api/routes`, `services/api/query`, `services/api/shape`, `api/rest`), five test files, `scripts/api-smoke.sh`, the plan, and the contract document. Suite, task by task: baseline **87 files / 1843 passed / 2 skipped**; Task 1 → **1846**; Task 2 → **1851**; Task 3 → **1856**; Task 4 → **1864**; Task 5 → **1875**; Task 6 → **1884**; the shell-only commits move no case count. **Final: 87 files / 1884 passed / 2 skipped** (+41 cases), with `typecheck` and `lint` clean at every commit. **The 5b amendment adds one socket case** (the share-drops window below), so the tree's current total is **1885** — the 1884 is what Part 5b verified, and the difference is named rather than folded in.

### The live run, as measured

An isolated scratch profile (the path above; scratch is pruned when idle, so it is described rather than committed) — hand-configured (`library_root`, `rest_api_port` 8791, a fresh token) — with two seed EPUBs **built by the throwaway instrument with embedded jackets**, uploaded through the app's own `POST /api/books`, and one **hand-authored `shelves.json`** (the canonical format; exactly what another Mac's write looks like) adopted on connect.

- **The smoke script: 92 passed, 0 failed, exit 0.** The shelf section green end to end: the list, the scope (the scoped `total` equalling the shelf's own `count`; every page book declaring the shelf), the default order matching explicit `sort=shelf_added&dir=desc`, facets scoped, the membership pair (PUT → detail read-back → PUT again → DELETE → DELETE again, all 200 and idempotent), the 404s (unknown shelf, unknown book, a `GET` of the membership path) and the 400s (a present-but-empty `shelf`, `sort=shelf_added` without a shelf), and `HEAD /api/shelves` 200 with no body. The pair **restored the shelf** it borrowed (post-run count 2; the file's members unchanged).
- **What the live passes found — and it is the reason the run exists.** The first — a shelf-less, coverless profile, before the seeds carried jackets — read **72 passed / 1 failed**, that failure being the **cover** section's own check, with the membership pair noted-skipped because adoption had not landed yet; its evidence is what produced the instrument's second version (embedded jackets on the seeds, and a poll for the adopted shelf instead of an assumption). The second, with shelf and covers working, read **91 passed / 1 failed**, and **that** failure was not the server: the smoke script's own `SHELF_COUNT` was read from `$BODY` *after* later requests had overwritten it, so the scoped-total check compared a real total against 0 (`expected 0, got 2`). Fixed in `e8a5fd9`; the third pass is the 92/0 above.
- **Not exercised live, stated as such:** the offline 503 on a shelf write (it needs the share taken down; the socket case decides it), an unreadable `shelves.json` over REST (the socket case decides it), and the Mac sidebar repainting after a phone write (the `shelves:changed` socket case decides the broadcast; no UI frame was taken).
- **The instrument, for the next session.** The dev app's shelf adoption fires on the NAS manager's `connected` status (`index.ts:246`) and can land *seconds to tens of seconds after* the REST server is up — poll `/api/shelves` for the state, never assume it. A foreground timeout above the 600 s cap is auto-promoted to a background process and the script's stdout goes with it, so **write run output to a file**. `pkill -9` is the stop that works for `npm run dev`'s tree (a plain SIGTERM leaves the Electron process alive); its pattern is `musaeum/node_modules/electron`. And the dev profile's own REST server (8788) may be up at any time — the scratch profile used **8791** so the two never meet.

### Divergences from this plan, each measured or justified

- **Task 3 absorbed `api/rest.ts`'s four call sites**, because S1's required parameter makes every caller a `typecheck` failure in the same commit — and a placeholder `[]` would have shipped a lie for one commit. For the same reason the document's `### GET /api/shelves` section landed in Task 3 and not Task 4: its `payload=shelves` block cannot ship without the shaper (the parity case forces the pair), and a block without its route's prose is a document that does not say where a payload comes from.
- **The membership answer is wrapped, per D10, and got its own golden.** The socket cases found the handler sending a **bare book** where D10 says `200 { "book": … }` (`Cannot read properties of undefined (reading 'id')`); the fix added `membershipPayload` to the shaper and a `payload=membership` block to the document (AC30 asks for blocks on both writes), so all three writes answer through one `book` member — `{applied, book}`, `{book, duplicate}`, `{book}`.
- **Task 4's library arm had to put `limit`/`offset` back explicitly** — the patch that introduced the batch read dropped them from the payload call, and `typecheck` caught it before the suite ran. Recorded because the same patch shape (spread a page, add a field) is what a later hand will repeat.
- **Task 4's `shape.test.ts` route-names edit rode in Task 6**, since the membership path enters the document with the writes' prose.
- **Two runtime slips worth naming rather than burying.** A scripted in-session edit ran with cwd = the scratch dir and wrote to a copy, not the repo — every file edit in this slice is recorded with absolute paths from that point on. And two edits to the same test file left a duplicate `ManualShelfEntry` import that only `typecheck` (not a vitest run) caught; every task's real gate is `typecheck && lint && npm test`, and the runs that skipped `typecheck` are the ones that let it through for a while.
- **CLAUDE.md's route count is stale, and the edit is blocked.** The brief's iOS bullet still reads *"six read routes and two writes"*; updating it means writing an agent-instruction file, which is approval-gated — the prompt timed out without an answer and the write was not retried (silence is not consent). The one-line replacement is `seven read routes and four writes (the reading report, a book upload, and the shelf membership's PUT/DELETE)`; it wants the owner's approval or the next session's, and it is left **out of context rather than guessed at**.

### Schedule, and what this unblocks

### AC32's second half — the v1 phone's vendored fixtures

Run in `musaeum-ios` after re-vendoring, as the criterion asks (2026-09-28): `scripts/vendor-contract-fixtures.sh` re-extracted **9 payloads** — four existing fixtures gained the additive `shelves` member (`book.json`, `library.json`, `import.json`, `reading.json`), two are new (`shelves.json`, `membership.json`) — and the suite then read **191 cases across 24 suites, 0 failures**, the same total as its own baseline, so nothing the phone already decoded stopped decoding.

**One finding, and it was not shelves.** The re-vendor also refreshed `health.json`, whose `version` had been `0.1.0` in the fixtures while the document has said `0.5.0` (the app's own version, which moved after the fixtures were last vendored) — the client's `testHealthDecodes` asserted the stale literal, and it was the only red line in the first run. Fixed by asserting the document's own value: the client's half of a re-vendor, not a contract change. **The gates' device had moved too:** the iOS brief's `DE0B5601-…` (iPhone 17 Pro / iOS 26.1) no longer exists — that runtime is gone from this machine — and the run takes `39D29C73-…` (iPhone 18 Pro / iOS 27.0), the id the repo's own history names. Both are carried into the phone slice's annex rather than left for the next session to rediscover.

**Slice 4 (*Send to ‹device›*) remains open and desktop-only** — it was not on the phone's path, and this slice took neither its file nor its menu item. **Slice 6 (the phone) is now unblocked**: its annex is written in `musaeum-ios/docs/plans/`, against this document, with the handoff notes below.

### The part-5a review's findings, and what happened to each

Report-only, against `7bfa5ba..5a90d18`, reviewed on an extracted copy of that commit — the working tree moved under the reviewer mid-read (it noticed, and extracting was the right answer). It verified **all nine** of the claims it was asked to check: the two pinned imports, the two modules' purity, `API_VERSION` still 1, the touched paths, the doc↔goldens parity (**non-vacuous, and measured rather than reasoned**: it broke the shelf id in `payload=book`, renamed the member, and renamed the fence, and watched the right case fail each time), the one-query batch read, S1's four call sites, and S3/S4/S5's behaviours. It found **no blocker**; its two should-fixes were gaps in the contract's *prose*, not in the code or the payloads.

| Finding | Disposition |
| --- | --- |
| **1 (should-fix)** — the Status line named the membership writes while the routes table had no `PUT`/`DELETE` row and line 25 still said *two* routes are writes | **Closed by Task 6** (`d234368`): both rows are in the table, line 25 reads *four routes are writes*, and the smoke run exercised both writes live (92/0). The reviewer saw it as transient, and it was. |
| **2 (should-fix)** — the payloads' own paragraph said *Three members deserve their own sentence* and had never gained the `shelves` one | **Fixed in this amendment**: it reads *Four*, and the member's sentence says what a client relies on — ids only, always present, `[]` when the book is on none. |
| **3 (nit)** — the `sort` row enumerated six fields, so read alone it implied `shelf_added` is always a 400 | **Fixed in this amendment**: the row names the seventh and its inside-only rule. |
| **4 (nit)** — the purity case built its import list from lines that `startsWith('import ')`, so a specifier on a wrapped line was invisible to it | **Fixed in this amendment**: the case now extracts **specifiers** (a `from '…'` match over the whole source, plus side-effect imports) and asserts over those — the same claims, a scan formatting cannot dodge. Pre-existing, and worth closing while found. |
| **5 (nit)** — `?shelf=x&q=%22` (a quoted but empty term) comes back in *title* order: a `q` is present, so no default sort is set, and the search fallback runs with none | **Recorded, not changed.** The document conditions the default on "no `q`", so this is not a breach; the corner needs a hand-made request (this client trims its term before sending), and pinning a sort inside the search fallback would be a behaviour change the contract does not ask for. Named here so it is a known corner rather than a rediscovery. |

Its verdict, for the record: *"Part 5a is sound: the wire change, the S1/S3/S4/S5 behaviours and the three contract artifacts agree."* The things it could not verify were the ones the slice's later tasks owned, and each is closed: live behaviour (Task 7's smoke run, 92/0), the full suite on a settled tree (`d234368` onward, **1884/0**), the iOS decode (AC32, **191/0** in the other repo), and `docs/invariants/shelves.md`'s then-stale `shelf_added` sentence (Task 8). ### The part-5b review's findings, and what happened to each

Report-only, against `5a90d18..HEAD`, on extracted copies of the commits it needed (`7bfa5ba`, `3f3ef69`, `d234368` — the repo untouched, `git status` clean at its end). It verified **all eight** of its claims — the funnel, the wrapped read-back with its parity case, the idempotence cases over a real socket, the refusal ladder, the matcher (pure *and* wired), the smoke script's restore and the count fix, this record's counts (**1884 / 87 files / 2 skipped**; `+2646/−85`) and invariants 8 and 12 — and found **no overclaim**: the section you are reading checked out against the tree. No blocker; four prose/comment findings and one race window.

| Finding | Disposition |
| --- | --- |
| **1 (should-fix)** — `docs/rest-api.md`'s "Checking a live server" still described the script as exercising "the read surface, and the two writes", and as touching only those | **Fixed in this amendment**: the section now names the shelf checks and the membership pair, says which change lasts (the upload and the report) and which is transient (the pair, which restores), and the per-route enumeration carries them. |
| **2 (nit)** — `rest.ts`'s own comments had drifted: "the four JSON routes also answer `HEAD`" (five), "every route except the one write is a `GET`" (four writes), "the one write" in three more places, and the route-by-route list without the membership path | **Fixed in this amendment** — every sentence now names the count it has. |
| **3 (nit)** — the `isShelfGone`→404 mapping and the unreadable-file log sentence were **code-read, not case-decided** | **Half-fixed, half-disclosed**: the unreadable case now **asserts** the log line carries the service's own `SHELVES_UNREADABLE` sentence (it was silenced before, not checked). The re-read race's mapping stays code-read — staging it needs a seam into the service's re-read that this slice does not have — and is named here as the case's gap rather than implied away. |
| **4 (nit)** — a share that drops **between** the handler's pre-check and the service's own `assertOnline` answered **500**, where the contract's answer is 503 | **Fixed and case-decided**: the generic catch re-checks `nas.isOnline()` and answers the pre-check's own `sendUnavailable(res, 'offline')` — nothing was written in that window either way, and only the retry decision differed. A socket case stages the window (the nas mock's `assertOnline` is now *wrapped*, the db mock's own idiom, so one case can make it throw while `isOnline` flips after the pre-check) and pins 503 + `Retry-After: 5` + the untouched shelf. **It failed as written before the fix (200, then 500 without the mapping), so the case decides the finding rather than decorating it.** |

Its verdict: *"Part 5b: sound — the funnel, the wrapped read-back, the idempotence, the refusal order, the matcher and the smoke script all hold as documented; the only defects are prose."* What it could not verify — the live smoke run (it verified the script statically instead: **92 `check` sites = 70 outside the shelf section + 22 inside**), AC32's iOS run (it confirmed the nine fixtures are in place), the intermediate per-task counts, and this record's process narratives — are each owned elsewhere in this plan, and each is stated there rather than assumed.

