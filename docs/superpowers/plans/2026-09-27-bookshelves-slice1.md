# Bookshelves — slice 1: storage, service, IPC (main process only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shelves exist in the main process: `{library_root}/shelves.json` is read, validated and written atomically, mirrored into SQLite by migration 006, mutated only through one serial service, adopted on connect and Reload, pruned on book delete, usable as a scope by every library read, and exposed on `window.Musaeum.shelves` — with no renderer change and no REST wire change.

**Architecture:** `shelves.json` is canonical and `shelves` + `shelf_books` are a cache replaced wholesale from it. One service (`services/shelves.ts`) runs every mutation through a single promise queue: assert online → re-read the file → apply → atomic write → replace the cache from the written file → broadcast `shelvesChanged`. The shelf scope enters SQL only through `db.ts`'s one WHERE builder (`bookWhere`), and the `shelf_added` sort through `orderClause`, which now returns its bound parameters.

**Tech Stack:** Electron 44 main process, TypeScript strict, better-sqlite3, vitest run through Electron-as-Node (`npm test`).

**Spec:** `docs/superpowers/specs/2026-09-27-bookshelves-design.md`. Read D1–D7, *Error handling*, and **Slice 1's acceptance criteria (AC1–AC15)** before starting any task. Read `docs/invariants/nas-and-catalog.md` and `docs/invariants/files-and-deletion.md` too: this slice copies the first one's write-and-adopt pattern and hooks into the second one's delete paths.

---

## How the slice is cut, and why there are two parts

The spec's slice 1 list comes to **12 code files**, over CLAUDE.md's ~10-file escalation bound, and the spec asks the plan to split it if so (*Slices*, last paragraph). It splits cleanly along the one dependency inside it:

| Part | What it lands | Code files | Route |
| --- | --- | --- | --- |
| **1a — the file and the cache** (Tasks 1–4) | the types, migration 006, `shelves-file.ts` (parse/read/write), the shelf cache and the scoped reads in `db.ts`, the REST `sort` guard | `src/types/shelf.types.ts` (new), `src/types/book.types.ts`, `electron/main/schema/migrations/006_shelves.sql` (new), `electron/main/services/db.ts`, `electron/main/services/shelves-file.ts` (new), `electron/main/services/api/query.ts` — **6** | `contracts-engineer` (Tasks 1–2), `main-engineer` (Tasks 3–4) |
| **1b — the service and its wiring** (Tasks 5–9) | `services/shelves.ts`, adoption, delete pruning, IPC, preload, docs | `electron/main/services/shelves.ts` (new), `electron/main/services/library-sync.ts`, `electron/main/services/book-delete.ts`, `electron/main/ipc/shelves.ts` (new), `electron/main/ipc/library.ts`, `electron/main/index.ts`, `electron/preload/index.ts`, `src/types/api.types.ts` — **8** | `main-engineer` (Tasks 5–8), docs by the orchestrator (Task 9) |

Each part ends green (`npm run typecheck && npm run lint && npm test`) and gets its own review before the next begins. 1b depends on 1a; nothing in 1a depends on 1b.

**One file outside the spec's list, and why:** `electron/main/services/api/query.ts`. Adding `'shelf_added'` to `SortField` makes the shared guard `isBookSort` accept it, and the REST `sort=` parser is built on that guard — so without a line here, `GET /api/library?sort=shelf_added` would change from **400** to a silent title sort in *this* slice, a wire change with no document behind it. Task 1 holds it at 400; slice 5 replaces that line with its "400 unless `shelf`" rule.

**Out of scope here, and where it goes:** every renderer change (slice 2), drag (slice 3), send-to-Kindle (slice 4), every REST change beyond holding `sort=shelf_added` at 400 (slice 5). `docs/rest-api.md` does not move in this slice.

---

## Global Constraints

- Node **≥ 22.12**. Run tests **only** through `npm test` (Electron-as-Node, so the better-sqlite3 ABI matches). One file: `npm test -- <path>`.
- If working in a git worktree, it needs a `node_modules` **symlink** to the main checkout's before `npm test` runs, and `.gitignore`'s `node_modules/` does **not** match a symlink — never `git add` it.
- TypeScript strict, **no `any`**; contract types live in `src/types/`.
- The code blocks below are not guaranteed Prettier-formatted: run `npx prettier --write <the files you touched>` before `npm run lint`, which runs with `--max-warnings=0`.
- Invariant 8: IPC handlers are thin `handle()` wrappers; no file in `electron/main/ipc/` imports `fs`, `path` or `child_process` (`test/invariants.test.ts` enforces it).
- Invariant 1: the catalog stays derived. *Rebuild Catalog* **neither reads nor writes** `shelves.json`; `shelves.json` is written only by `services/shelves.ts`.
- Invariant 12: a failure to prune shelves after a book delete is **logged and swallowed**; the delete stands.
- Copy, verbatim from the spec: unreadable file → `shelves.json could not be read — shelf changes are paused so nothing is lost`; missing shelf → `That shelf no longer exists`.
- Names (D3): **trimmed; non-empty; ≤ 80 characters; unique case-insensitively among manual shelves. A clash is refused with an error, never auto-suffixed.**
- `shelves.json` is written **`.part` then rename**, and a file that exists but does not parse (or has an unknown `version`) is **never overwritten**.
- **One `shelves.json` write per operation**, whatever the number of books; an operation that changes nothing writes nothing.
- `apiVersion` stays `1`, and the REST wire is **unchanged** by this slice.
- Markdown prose is **not hard-wrapped** — one line per paragraph, bullet and table row.
- Commit after every task. Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

The five inputs the spec implies but no acceptance criterion exercises, most likely to bite first. Each has a test in the task named.

1. **A hand-edited `shelves.json` that repeats a shelf id or a member** (a copy-paste in an editor) → adoption must still succeed rather than fail on the cache's primary key; the first occurrence wins. *Task 4.*
2. **A shelf deleted on another Mac** → after the *"That shelf no longer exists"* refusal the shelf must actually leave `list()`: the cache is replaced from the file that was just read, not merely an event sent over a cache that still holds it. *Task 6.*
3. **A library whose `shelves.json` is missing** (the file deleted, or the root switched to a library that never had shelves) → adoption empties the shelf cache; the previous library's shelves must not linger. *Task 7.*
4. **A share write that fails mid-mutation** → file and cache unchanged, **and the next mutation still runs** — a rejected write must not wedge the queue. *Task 5.*
5. **Deleting books that are on no shelf, in a library that has never had shelves** → zero `shelves.json` writes and no file created: no SMB traffic and no stray file for a feature the owner never used. *Task 7.*

## Acceptance criteria → tasks

| AC | Task | | AC | Task |
| --- | --- | --- | --- | --- |
| 1 migration 006 | 2 | | 9 unknown `version` refused | 3, 6 |
| 2 one write each, file and cache agree | 5 | | 10 name rules | 5, 6 |
| 3 interleaved mutations both land | 5 | | 11 adoption, missing members | 4, 7 |
| 4 `addBooks` idempotent | 5 | | 12 delete prunes, one write | 7 |
| 5 remove → restore keeps `added_at` | 5 | | 13 scoped reads, `shelf_added` | 4 |
| 6 invalid JSON refused, bytes unchanged | 3, 6 | | 14 scoped search | 4 |
| 7 smart shelf skipped and preserved | 3, 6 | | 15 offline refusal | 6 |
| 8 absent shelf refused, file unchanged | 6 | | | |

---

# Part 1a — the file and the cache

### Task 1: Contract types, and holding the REST `sort` guard

**Files:**
- Create: `src/types/shelf.types.ts`
- Create: `src/types/shelf.types.test.ts`
- Modify: `src/types/book.types.ts` (`SortField` at `:192`, `SORT_LABELS` at `:200`, `defaultSortDirection` at `:232`, `BookFilters` at `:236`)
- Modify: `src/types/book.types.test.ts` (append one `describe`)
- Modify: `electron/main/services/api/query.ts` (`parseSort`, the `isBookSort` line)
- Modify: `electron/main/services/api/query.test.ts` (one case in `describe('parseSort — …')`)

**Interfaces:**
- Consumes: nothing.
- Produces (every later task uses these names):
  - `type ShelfKind = 'manual'`
  - `interface ShelfSummary { id: string; name: string; kind: ShelfKind; count: number }`
  - `interface ShelfMembership { bookId: string; addedAt: string }`
  - `interface ShelfAddResult { added: number; alreadyOn: number }`
  - `interface ShelfScope { shelfId?: string }`
  - `interface ShelfBookEntry { id: string; added_at: string }`
  - `interface ManualShelfEntry { id: string; name: string; kind: 'manual'; created_at: string; updated_at: string; books: ShelfBookEntry[] }`
  - `interface ForeignShelfEntry { id: string; kind: string; [key: string]: unknown }`
  - `type ShelfEntry = ManualShelfEntry | ForeignShelfEntry`
  - `interface ShelvesFile { version: 1; shelves: ShelfEntry[] }`
  - `function isManualShelf(entry: ShelfEntry): entry is ManualShelfEntry`
  - `SortField` gains `'shelf_added'`; `BookFilters` gains `shelfId?: string`

- [ ] **Step 1: Write the failing tests**

Create `src/types/shelf.types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isManualShelf } from './shelf.types'

describe('isManualShelf — the one kind this build edits (bookshelves D1)', () => {
  it('is true for a manual shelf and false for any kind this build does not know', () => {
    expect(
      isManualShelf({
        id: 'a',
        name: 'To Read',
        kind: 'manual',
        created_at: '2026-09-27T10:00:00.000Z',
        updated_at: '2026-09-27T10:00:00.000Z',
        books: []
      })
    ).toBe(true)
    expect(isManualShelf({ id: 'b', kind: 'smart', rule: { tags: ['sf'] } })).toBe(false)
  })
})
```

Append to `src/types/book.types.test.ts` (add `defaultSortDirection`, `isBookSort`, `sortLabel` to its existing `./book.types` import if they are not already there):

```ts
describe('shelf_added — the sort that only exists inside a shelf (bookshelves D8)', () => {
  it('is a sort the guard accepts, newest first on first click, with its own labels', () => {
    expect(isBookSort({ field: 'shelf_added', direction: 'desc' })).toBe(true)
    expect(defaultSortDirection('shelf_added')).toBe('desc')
    expect(sortLabel({ field: 'shelf_added', direction: 'desc' })).toBe(
      'Date Added to Shelf, Newest First'
    )
    expect(sortLabel({ field: 'shelf_added', direction: 'asc' })).toBe(
      'Date Added to Shelf, Oldest First'
    )
  })
})
```

In `electron/main/services/api/query.test.ts`, inside `describe('parseSort — the field/direction rule', …)`, after the `it.each([['sort=athor'], …])` case:

```ts
  it('refuses shelf_added, which has no shelf to order by on this surface yet', () => {
    // The type grew the field for the Mac (bookshelves D8); the wire has no
    // `shelf` parameter until slice 5, so here it is still an unknown sort
    expect(parseSort(url('/api/library?sort=shelf_added').searchParams)).toEqual({ ok: false })
    expect(parseSort(url('/api/library?sort=shelf_added&dir=desc').searchParams)).toEqual({
      ok: false
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/types/shelf.types.test.ts src/types/book.types.test.ts electron/main/services/api/query.test.ts`
Expected: FAIL — `shelf.types` cannot be resolved; `isBookSort({ field: 'shelf_added', … })` is `false`. (The `query.test.ts` case passes already — `shelf_added` is unknown today. It is there so Step 3 cannot silently widen the wire.)

- [ ] **Step 3: Write the implementation**

Create `src/types/shelf.types.ts`:

```ts
/**
 * Shelves — hand-curated, user-named, non-exclusive lists of books
 * (`docs/superpowers/specs/2026-09-27-bookshelves-design.md`).
 *
 * Two shapes live here. The first half is what crosses the preload bridge (D6):
 * camelCase, computed from the SQLite cache. The second half is the stored file,
 * `{library_root}/shelves.json` (D1): snake_case like `metadata.json`, canonical,
 * and written only by `electron/main/services/shelves.ts`.
 */

/** The one kind this build creates, lists and edits. Any other kind is preserved, never shown (D1). */
export type ShelfKind = 'manual'

/** A shelf as the sidebar and the menus see it. `count` counts only members the library holds (D6). */
export interface ShelfSummary {
  id: string
  name: string
  kind: ShelfKind
  count: number
}

/** One book's place on a shelf — what a remove hands back and an Undo restores, timestamp included (D3). */
export interface ShelfMembership {
  bookId: string
  addedAt: string
}

/** What an add did: books newly shelved, and books that were on the shelf already. */
export interface ShelfAddResult {
  added: number
  alreadyOn: number
}

/** Narrows a library read to one shelf (D7). No `shelfId` is the whole library. */
export interface ShelfScope {
  shelfId?: string
}

// --- shelves.json (D1) ---

export interface ShelfBookEntry {
  id: string
  added_at: string
}

export interface ManualShelfEntry {
  id: string
  name: string
  kind: 'manual'
  created_at: string
  updated_at: string
  books: ShelfBookEntry[]
}

/**
 * A shelf of a kind this build does not know — a later build's smart shelf. It
 * is carried through every write exactly as it was read, so an older build's
 * edit cannot destroy it (D1).
 */
export interface ForeignShelfEntry {
  id: string
  kind: string
  [key: string]: unknown
}

export type ShelfEntry = ManualShelfEntry | ForeignShelfEntry

export interface ShelvesFile {
  /** The file format's version — independent of the REST `apiVersion`. */
  version: 1
  shelves: ShelfEntry[]
}

export function isManualShelf(entry: ShelfEntry): entry is ManualShelfEntry {
  return entry.kind === 'manual'
}
```

In `src/types/book.types.ts`:

```ts
export type SortField =
  | 'title'
  | 'author'
  | 'series'
  | 'date_added'
  | 'rating'
  | 'read_status'
  /**
   * When a book was put on the open shelf (bookshelves D8). Offered only inside a
   * shelf; reaching main without a `shelfId` it falls back to title, like any
   * field `SORT_SQL` has no expression for.
   */
  | 'shelf_added'
```

Add to `SORT_LABELS`:

```ts
  shelf_added: { asc: 'Date Added to Shelf, Oldest First', desc: 'Date Added to Shelf, Newest First' }
```

Change `defaultSortDirection`'s body to:

```ts
  return field === 'date_added' || field === 'rating' || field === 'shelf_added' ? 'desc' : 'asc'
```

Add to `BookFilters`, after `minRating`:

```ts
  /**
   * Narrow to one shelf's books (bookshelves D7). A scope rather than a facet —
   * the UI's Clear keeps it — but it reaches SQL through the same WHERE builder
   * as the filters, so the list, the page, the count and the facets agree.
   */
  shelfId?: string
```

In `electron/main/services/api/query.ts`, `parseSort`, replace `if (!isBookSort(candidate)) return { ok: false }` with:

```ts
  // `shelf_added` is a real sort on the Mac (bookshelves D8) but means nothing
  // without a shelf, and this surface has no `shelf` parameter until the
  // bookshelves slice 5 — so until then it is exactly the unknown field it was
  // before the type grew it. Slice 5 replaces this with "400 unless `shelf`".
  if (!isBookSort(candidate) || candidate.field === 'shelf_added') return { ok: false }
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npm test -- src/types/shelf.types.test.ts src/types/book.types.test.ts electron/main/services/api/query.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean. If typecheck reports another `Record<SortField, …>` needing an entry, add the entry there with the same labels; nothing else should need one (only `SORT_LABELS` exists today).

- [ ] **Step 5: Commit**

```bash
git add src/types/shelf.types.ts src/types/shelf.types.test.ts src/types/book.types.ts src/types/book.types.test.ts electron/main/services/api/query.ts electron/main/services/api/query.test.ts
git commit -m "shelves slice 1a: contract types; shelf_added sort; REST sort guard holds at 400

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Migration 006 — drop the unused collections tables, create the shelf cache

**Files:**
- Create: `electron/main/schema/migrations/006_shelves.sql`
- Create: `electron/main/services/db-shelves.test.ts`
- Modify: `electron/main/services/db.ts` (imports + `MIGRATIONS` at `:15-21`; `deleteBook` at `:609-616`; `replaceAllBooks` at `:655-675`)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime.
- Produces: tables `shelves(id, name, kind, created_at, updated_at)` and `shelf_books(shelf_id, book_id, added_at)` with `PRIMARY KEY (shelf_id, book_id)` and `idx_shelf_books_book`; `db.deleteBook` and `db.replaceAllBooks` prune `shelf_books` instead of `book_collections`.

- [ ] **Step 1: Write the failing tests**

Create `electron/main/services/db-shelves.test.ts`:

```ts
import Database from 'better-sqlite3'
import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { closeDb, getDb, insertBook } from './db'

const dbPath = (): string => join(app.getPath('userData'), 'musaeum.db')

beforeEach(() => {
  closeDb()
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(app.getPath('userData'), f), { force: true })
  }
})

/**
 * Put a fully migrated database back to the shape it had at user_version 5:
 * the shelf cache gone, 001's collections tables back. Closing and reopening
 * then runs 006 over it exactly as it runs on a real machine's database.
 */
function rewindTo005(): void {
  const d = getDb()
  d.exec(`
    DROP TABLE shelf_books;
    DROP TABLE shelves;
    CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT);
    CREATE TABLE book_collections (
      book_id       TEXT REFERENCES books(id),
      collection_id TEXT REFERENCES collections(id),
      PRIMARY KEY (book_id, collection_id)
    );
  `)
  d.pragma('user_version = 5')
}

function schemaNames(d: Database.Database): string[] {
  return (
    d.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as {
      name: string
    }[]
  ).map((r) => r.name)
}

describe('migration 006 (bookshelves D2)', () => {
  it('replaces the collections tables with the shelf cache and leaves every book row untouched', () => {
    insertBook({ ...makeBook('a', 'Alpha'), author: 'Adams', rating: 4 })
    insertBook(makeBook('b', 'Bravo'))
    rewindTo005()
    const before = getDb().prepare('SELECT * FROM books ORDER BY id').all()
    closeDb()

    const d = getDb()
    expect(d.pragma('user_version', { simple: true })).toBe(6)
    const names = schemaNames(d)
    expect(names).toEqual(expect.arrayContaining(['shelves', 'shelf_books', 'idx_shelf_books_book']))
    expect(names).not.toContain('collections')
    expect(names).not.toContain('book_collections')
    expect(d.prepare('SELECT * FROM books ORDER BY id').all()).toEqual(before)
  })

  it('refuses to drop a collections table that holds rows, and leaves the database at 5', () => {
    insertBook(makeBook('a'))
    rewindTo005()
    getDb().prepare("INSERT INTO collections (id, name) VALUES ('c1', 'Kept')").run()
    closeDb()

    expect(() => getDb()).toThrow(/collections_must_be_empty_before_006/)
    closeDb()
    const raw = new Database(dbPath(), { readonly: true })
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(5)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM collections').get()).toEqual({ n: 1 })
    } finally {
      raw.close()
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- electron/main/services/db-shelves.test.ts`
Expected: FAIL — `no such table: shelf_books` from `rewindTo005`.

- [ ] **Step 3: Write the implementation**

Create `electron/main/schema/migrations/006_shelves.sql`:

```sql
-- Shelves (docs/superpowers/specs/2026-09-27-bookshelves-design.md, D2).
--
-- `shelves` + `shelf_books` are a cache of {library_root}/shelves.json, which is
-- canonical: every shelf write replaces them from the file it just wrote, and
-- adoption does the same on connect and on Reload. So there are no foreign keys —
-- a member may name a book this machine's catalog does not hold yet, and the rows
-- are swapped wholesale.
--
-- `collections` / `book_collections` (001) were never read or written by any
-- feature. They are dropped only when empty: the guard's named CHECK fails the
-- migration — and with it the transaction, leaving user_version at 5 — rather than
-- discard a row some other build wrote. Measured empty on the dev database (7,121
-- books) 2026-09-27; the guard is for every other machine.

CREATE TEMP TABLE migration_006_guard (
  rows INTEGER CONSTRAINT collections_must_be_empty_before_006 CHECK (rows = 0)
);
INSERT INTO migration_006_guard SELECT COUNT(*) FROM book_collections;
INSERT INTO migration_006_guard SELECT COUNT(*) FROM collections;
DROP TABLE migration_006_guard;

DROP TABLE book_collections;
DROP TABLE collections;

CREATE TABLE shelves (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'manual',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE shelf_books (
  shelf_id  TEXT NOT NULL,
  book_id   TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (shelf_id, book_id)
);

CREATE INDEX idx_shelf_books_book ON shelf_books(book_id);
```

In `electron/main/services/db.ts`:

```ts
import migration006 from '../schema/migrations/006_shelves.sql?raw'

const MIGRATIONS: string[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006
]
```

In `deleteBook`, replace the `book_collections` line with the shelf cache's, and in its doc comment replace "a conflict or a collection membership" with "a conflict or a shelf membership":

```ts
    d.prepare('DELETE FROM shelf_books WHERE book_id = ?').run(id)
```

In `replaceAllBooks`, replace the `book_collections` prune, and in its doc comment replace "Conflict/collection rows" with "Conflict and shelf-membership rows":

```ts
      d.prepare('DELETE FROM shelf_books WHERE book_id NOT IN (SELECT id FROM books)').run()
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- electron/main/services/db-shelves.test.ts electron/main/services/db.test.ts electron/main/services/book-delete.test.ts electron/main/services/library-sync.test.ts`
Expected: PASS. If the refusal test's message does not contain the constraint name, SQLite on this build is not naming CHECK constraints: stop and report it rather than loosening the regex — the whole point of the guard is a loud, self-describing failure.

- [ ] **Step 5: Commit**

```bash
git add electron/main/schema/migrations/006_shelves.sql electron/main/services/db.ts electron/main/services/db-shelves.test.ts
git commit -m "shelves slice 1a: migration 006 — shelf cache replaces the unused collections tables

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `shelves-file.ts` — parse, read and write `shelves.json`

**Files:**
- Create: `electron/main/services/shelves-file.ts`
- Create: `electron/main/services/shelves-file.test.ts`

**Interfaces:**
- Consumes: `ShelvesFile`, `ShelfEntry`, `ManualShelfEntry`, `ForeignShelfEntry`, `ShelfBookEntry` (Task 1).
- Produces:
  - `const SHELVES_FILENAME = 'shelves.json'`, `const SHELVES_FILE_VERSION = 1`
  - `function shelvesPath(root: string): string`
  - `type ShelvesReadState = { state: 'ok'; file: ShelvesFile } | { state: 'missing' } | { state: 'invalid' }`
  - `function emptyShelvesFile(): ShelvesFile`
  - `function parseShelvesFile(text: string): ShelvesFile | null` (pure)
  - `async function readShelvesFile(root: string): Promise<ShelvesReadState>` — rethrows any I/O error that is not `ENOENT`
  - `async function writeShelvesFile(root: string, file: ShelvesFile): Promise<void>` — `.part` then rename, via `promises.writeFile` / `promises.rename` from `'fs'` (tests spy on those two)

- [ ] **Step 1: Write the failing tests**

Create `electron/main/services/shelves-file.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForeignShelfEntry, ManualShelfEntry, ShelvesFile } from '@shared/shelf.types'
import {
  emptyShelvesFile,
  parseShelvesFile,
  readShelvesFile,
  shelvesPath,
  writeShelvesFile
} from './shelves-file'

const manual: ManualShelfEntry = {
  id: 's1',
  name: 'To Read',
  kind: 'manual',
  created_at: '2026-09-27T10:00:00.000Z',
  updated_at: '2026-09-27T10:05:00.000Z',
  books: [{ id: 'b1', added_at: '2026-09-27T10:05:00.000Z' }]
}
const smart: ForeignShelfEntry = {
  id: 's2',
  kind: 'smart',
  name: 'Unread SF',
  rule: { tags: ['sf'], readStatus: 'unread' },
  extra: 1
}
const text = (value: unknown): string => JSON.stringify(value)

describe('parseShelvesFile (bookshelves D1)', () => {
  it('reads a version-1 file, keeping unknown kinds and unknown keys exactly as they were', () => {
    const file = parseShelvesFile(text({ version: 1, shelves: [manual, smart], note: 'kept' }))
    expect(file).toEqual({ version: 1, shelves: [manual, smart], note: 'kept' })
  })

  it('reads an empty file of shelves', () => {
    expect(parseShelvesFile(text(emptyShelvesFile()))).toEqual({ version: 1, shelves: [] })
  })

  it.each([
    ['text that is not JSON', 'not json{'],
    ['an unknown version', text({ version: 2, shelves: [] })],
    ['no version', text({ shelves: [] })],
    ['shelves that are not a list', text({ version: 1, shelves: {} })],
    ['a top-level array', '[]'],
    ['a shelf with no id', text({ version: 1, shelves: [{ ...manual, id: undefined }] })],
    ['a shelf with an empty id', text({ version: 1, shelves: [{ ...manual, id: '' }] })],
    ['a shelf with no kind', text({ version: 1, shelves: [{ ...manual, kind: undefined }] })],
    ['a manual shelf with no name', text({ version: 1, shelves: [{ ...manual, name: 7 }] })],
    ['a manual shelf with no timestamps', text({ version: 1, shelves: [{ ...manual, created_at: undefined }] })],
    ['a manual shelf whose books are not a list', text({ version: 1, shelves: [{ ...manual, books: {} }] })],
    ['a member with no added_at', text({ version: 1, shelves: [{ ...manual, books: [{ id: 'b1' }] }] })],
    ['a member with no id', text({ version: 1, shelves: [{ ...manual, books: [{ added_at: 'x' }] }] })]
  ])('refuses %s — what it cannot understand, it must never rewrite', (_label, input) => {
    expect(parseShelvesFile(input)).toBeNull()
  })
})

describe('readShelvesFile / writeShelvesFile', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musaeum-shelves-file-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('answers missing when the library has no shelves.json', async () => {
    expect(await readShelvesFile(root)).toEqual({ state: 'missing' })
  })

  it('answers invalid for a file it cannot use, and leaves its bytes alone', async () => {
    await fs.writeFile(shelvesPath(root), 'not json{', 'utf8')
    expect(await readShelvesFile(root)).toEqual({ state: 'invalid' })
    expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe('not json{')
  })

  it('rethrows an I/O failure that is not a missing file, so a share blip never reads as "no shelves"', async () => {
    await fs.mkdir(shelvesPath(root)) // a directory where the file should be: EISDIR, not ENOENT
    await expect(readShelvesFile(root)).rejects.toThrow()
  })

  it('round-trips through an atomic write and leaves no .part behind', async () => {
    const file: ShelvesFile = { version: 1, shelves: [manual, smart] }
    await writeShelvesFile(root, file)
    expect(await readShelvesFile(root)).toEqual({ state: 'ok', file })
    expect(await fs.readdir(root)).toEqual(['shelves.json'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- electron/main/services/shelves-file.test.ts`
Expected: FAIL — `./shelves-file` cannot be resolved.

- [ ] **Step 3: Write the implementation**

Create `electron/main/services/shelves-file.ts`:

```ts
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  ForeignShelfEntry,
  ManualShelfEntry,
  ShelfBookEntry,
  ShelfEntry,
  ShelvesFile
} from '@shared/shelf.types'

/**
 * `{library_root}/shelves.json` — the canonical store for shelves
 * (`docs/superpowers/specs/2026-09-27-bookshelves-design.md`, D1). Not derived
 * from anything, so it sits beside `catalog.json` without touching invariant 1:
 * the catalog stays derived from `metadata.json`, and *Rebuild Catalog* neither
 * reads nor writes this file.
 *
 * This module is the file and nothing else — no queue, no cache, no NAS check.
 * `services/shelves.ts` is its only writer.
 */

export const SHELVES_FILENAME = 'shelves.json'
export const SHELVES_FILE_VERSION = 1

export function shelvesPath(root: string): string {
  return join(root, SHELVES_FILENAME)
}

export type ShelvesReadState =
  | { state: 'ok'; file: ShelvesFile }
  | { state: 'missing' } // ENOENT — this library has never had a shelf
  | { state: 'invalid' } // exists, but unparsable / unknown version / wrong shape

export function emptyShelvesFile(): ShelvesFile {
  return { version: SHELVES_FILE_VERSION, shelves: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBookEntry(value: unknown): value is ShelfBookEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.added_at === 'string'
  )
}

/**
 * One shelf, or null when it is not something this build may rewrite.
 *
 * A kind this build does not know needs only an id and a kind: it is carried
 * through untouched, so its other fields are its own business (D1). A manual
 * shelf is checked field by field, because this build will edit it — and a
 * malformed one makes the **whole file** unreadable rather than being dropped,
 * since dropping it on the next write would destroy it.
 */
function parseEntry(raw: unknown): ShelfEntry | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '') return null
  if (typeof raw.kind !== 'string') return null
  if (raw.kind !== 'manual') return raw as unknown as ForeignShelfEntry
  if (
    typeof raw.name !== 'string' ||
    typeof raw.created_at !== 'string' ||
    typeof raw.updated_at !== 'string' ||
    !Array.isArray(raw.books) ||
    !raw.books.every(isBookEntry)
  ) {
    return null
  }
  return raw as unknown as ManualShelfEntry
}

/**
 * Text → the file, or null for anything this build cannot safely rewrite.
 *
 * An unknown `version` is refused rather than read as best it can be (AC9): a
 * newer build's format written back in this build's shape would be a downgrade
 * nobody asked for. Unknown top-level keys are kept, for the same reason unknown
 * kinds are.
 */
export function parseShelvesFile(text: string): ShelvesFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.version !== SHELVES_FILE_VERSION || !Array.isArray(raw.shelves)) {
    return null
  }
  const shelves: ShelfEntry[] = []
  for (const entry of raw.shelves) {
    const parsed = parseEntry(entry)
    if (!parsed) return null
    shelves.push(parsed)
  }
  return { ...raw, version: SHELVES_FILE_VERSION, shelves }
}

export async function readShelvesFile(root: string): Promise<ShelvesReadState> {
  let text: string
  try {
    text = await fs.readFile(shelvesPath(root), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    // A share blip must not read as "no shelves": adoption would empty the
    // cache, and a mutation would start from nothing and overwrite the file
    throw err
  }
  const file = parseShelvesFile(text)
  return file ? { state: 'ok', file } : { state: 'invalid' }
}

/**
 * Atomic write: `.part` then rename, so a crash or a dropped share never leaves
 * a torn file — the same pattern as `catalog.ts`'s `writeCatalog`. Indented,
 * because this file is canonical and a person may open it to repair it.
 */
export async function writeShelvesFile(root: string, file: ShelvesFile): Promise<void> {
  const target = shelvesPath(root)
  await fs.writeFile(`${target}.part`, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  await fs.rename(`${target}.part`, target)
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- electron/main/services/shelves-file.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/shelves-file.ts electron/main/services/shelves-file.test.ts
git commit -m "shelves slice 1a: shelves.json — strict parse, atomic write, unknown kinds preserved

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The shelf cache and the scoped reads in `db.ts`

**Files:**
- Modify: `electron/main/services/db.ts` — imports; `bookWhere` (`:239`); `selectBooks` (`:309`); `orderClause` (`:370`); `searchBooks` (`:403`); `searchRows` (`:445`); `getFacets` (`:677`); a new `// --- Shelves ---` section after `getFacets`
- Modify: `electron/main/services/db-shelves.test.ts` (append)

**Interfaces:**
- Consumes: `ShelvesFile`, `ShelfEntry`, `ManualShelfEntry`, `ShelfScope`, `ShelfSummary`, `isManualShelf` (Task 1); the tables (Task 2).
- Produces:
  - `function replaceAllShelves(file: ShelvesFile): void` — one transaction; manual shelves only; members whose book is not in `books` left out; duplicate shelf ids and duplicate members ignored (first wins)
  - `function listShelves(): ShelfSummary[]` — alphabetical, case-insensitive, then id
  - `function shelvesForBook(bookId: string): ShelfSummary[]` — same order
  - `getBooks`, `getBooksPage`, `countBooks`, `searchBooksPage` honour `filters.shelfId`; `sort.field === 'shelf_added'` orders by the open shelf's `added_at`, then `id ASC`
  - `function searchBooks(query: string, sort?: BookSort, scope?: ShelfScope): Book[]`
  - `function getFacets(scope?: ShelfScope): LibraryFacets`

- [ ] **Step 1: Write the failing tests**

Append to `electron/main/services/db-shelves.test.ts` — extend its imports to:

```ts
import type { ManualShelfEntry, ShelfEntry, ShelvesFile } from '@shared/shelf.types'
import {
  closeDb,
  countBooks,
  deleteBook,
  getBooks,
  getBooksPage,
  getDb,
  getFacets,
  insertBook,
  listShelves,
  replaceAllBooks,
  replaceAllShelves,
  searchBooks,
  searchBooksPage,
  shelvesForBook
} from './db'
```

and append:

```ts
const T = (day: number): string => `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`

function manualShelf(id: string, name: string, members: [string, string][]): ManualShelfEntry {
  return {
    id,
    name,
    kind: 'manual',
    created_at: T(1),
    updated_at: T(1),
    books: members.map(([bookId, at]) => ({ id: bookId, added_at: at }))
  }
}

function file(shelves: ShelfEntry[]): ShelvesFile {
  return { version: 1, shelves }
}

const ids = (books: { id: string }[]): string[] => books.map((b) => b.id)

/**
 * Four books. `s1` "To Read" holds b (day 2), c (day 1), d (day 3) and a book
 * this library does not have; `s2` "alpha" holds a; `s3` is a smart shelf.
 */
function seed(): void {
  insertBook({ ...makeBook('a', 'Alpha Voyage'), author: 'Adams' })
  insertBook({ ...makeBook('b', 'Bravo Voyage'), author: 'Baker' })
  insertBook({ ...makeBook('c', 'Charlie'), author: 'Carter' })
  insertBook({ ...makeBook('d', 'Delta Voyage'), author: 'Baker' })
  replaceAllShelves(
    file([
      manualShelf('s1', 'To Read', [
        ['b', T(2)],
        ['c', T(1)],
        ['d', T(3)],
        ['imported-elsewhere', T(4)]
      ]),
      manualShelf('s2', 'alpha', [['a', T(1)]]),
      { id: 's3', kind: 'smart', name: 'Smart', rule: {} }
    ])
  )
}

describe('the shelf cache (bookshelves D2, D4, D6)', () => {
  it('lists manual shelves alphabetically, case-insensitively, counting only books the library holds', () => {
    seed()
    expect(listShelves()).toEqual([
      { id: 's2', name: 'alpha', kind: 'manual', count: 1 },
      { id: 's1', name: 'To Read', kind: 'manual', count: 3 }
    ])
  })

  it('names the shelves a book is on, and none for a book on no shelf', () => {
    seed()
    expect(shelvesForBook('b')).toEqual([{ id: 's1', name: 'To Read', kind: 'manual', count: 3 }])
    expect(shelvesForBook('imported-elsewhere')).toEqual([])
    insertBook(makeBook('e'))
    expect(shelvesForBook('e')).toEqual([])
  })

  it('survives a hand-edited file that repeats a shelf or a member — the first occurrence wins', () => {
    insertBook(makeBook('a'))
    insertBook(makeBook('b'))
    expect(() =>
      replaceAllShelves(
        file([
          manualShelf('s1', 'One', [
            ['a', T(1)],
            ['a', T(2)]
          ]),
          manualShelf('s1', 'Duplicate', [['b', T(1)]])
        ])
      )
    ).not.toThrow()
    expect(listShelves()).toEqual([{ id: 's1', name: 'One', kind: 'manual', count: 1 }])
    expect(getDb().prepare('SELECT added_at FROM shelf_books WHERE book_id = ?').get('a')).toEqual({
      added_at: T(1)
    })
  })

  it('replaces the whole cache, so a file with no shelves empties it', () => {
    seed()
    replaceAllShelves(file([]))
    expect(listShelves()).toEqual([])
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM shelf_books').get()).toEqual({ n: 0 })
  })

  it('drops a deleted book from the cache, and so does a swap that no longer holds it', () => {
    seed()
    deleteBook('b')
    expect(listShelves().find((s) => s.id === 's1')?.count).toBe(2)
    replaceAllBooks([makeBook('a'), makeBook('d')])
    expect(listShelves().find((s) => s.id === 's1')?.count).toBe(1)
  })
})

describe('a shelf as a scope on every library read (bookshelves D7, D8)', () => {
  it('scopes getBooks, the page read and the count through the shared WHERE builder', () => {
    seed()
    expect(ids(getBooks({ shelfId: 's1' }))).toEqual(['b', 'c', 'd'])
    expect(countBooks({ shelfId: 's1' })).toBe(3)
    const page = getBooksPage({ shelfId: 's1' }, { limit: 1, offset: 1 })
    expect(ids(page.books)).toEqual(['c'])
    expect(page.total).toBe(3)
    // …and composes with the facet filters rather than replacing them
    expect(ids(getBooks({ shelfId: 's1', authors: ['Baker'] }))).toEqual(['b', 'd'])
  })

  it('orders shelf_added by when each book was shelved, in both directions', () => {
    seed()
    const shelfAdded = (direction: 'asc' | 'desc') =>
      ids(getBooks({ shelfId: 's1', sort: { field: 'shelf_added', direction } }))
    expect(shelfAdded('desc')).toEqual(['d', 'b', 'c'])
    expect(shelfAdded('asc')).toEqual(['c', 'b', 'd'])
  })

  it('breaks a shelf_added tie by id ascending, whatever the direction', () => {
    insertBook(makeBook('b'))
    insertBook(makeBook('c'))
    replaceAllShelves(
      file([
        manualShelf('s1', 'Tied', [
          ['c', T(1)],
          ['b', T(1)]
        ])
      ])
    )
    for (const direction of ['asc', 'desc'] as const) {
      expect(ids(getBooks({ shelfId: 's1', sort: { field: 'shelf_added', direction } }))).toEqual([
        'b',
        'c'
      ])
    }
  })

  it('binds the shelf sort ahead of the page, so a paged shelf_added read is the right slice', () => {
    seed()
    const page = getBooksPage(
      { shelfId: 's1', sort: { field: 'shelf_added', direction: 'desc' } },
      { limit: 2, offset: 1 }
    )
    expect(ids(page.books)).toEqual(['b', 'c'])
    expect(page.total).toBe(3)
  })

  it('falls back to title for shelf_added without a shelf, and never throws', () => {
    seed()
    expect(ids(getBooks({ sort: { field: 'shelf_added', direction: 'desc' } }))).toEqual(
      ids(getBooks({ sort: { field: 'title', direction: 'desc' } }))
    )
  })

  it('scopes the facets to the shelf, and leaves the unscoped facets as they were', () => {
    seed()
    const scoped = getFacets({ shelfId: 's1' })
    expect(scoped.authors).toEqual([
      { value: 'Baker', count: 2 },
      { value: 'Carter', count: 1 }
    ])
    expect(scoped.readStatus).toEqual([{ value: 'unread', count: 3 }])
    expect(scoped.formats).toEqual([{ value: 'epub', count: 3 }])
    expect(getFacets().authors).toEqual([
      { value: 'Baker', count: 2 },
      { value: 'Adams', count: 1 },
      { value: 'Carter', count: 1 }
    ])
  })

  it('searches only the shelf, in any sort, including shelf_added', () => {
    seed()
    expect(ids(searchBooks('Voyage')).sort()).toEqual(['a', 'b', 'd'])
    expect(ids(searchBooks('Voyage', undefined, { shelfId: 's1' })).sort()).toEqual(['b', 'd'])
    expect(
      ids(searchBooks('Voyage', { field: 'shelf_added', direction: 'desc' }, { shelfId: 's1' }))
    ).toEqual(['d', 'b'])
    const page = searchBooksPage(
      'Voyage',
      { limit: 1, offset: 0 },
      { shelfId: 's1', sort: { field: 'shelf_added', direction: 'desc' } }
    )
    expect(ids(page.books)).toEqual(['d'])
    expect(page.total).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- electron/main/services/db-shelves.test.ts`
Expected: FAIL — `replaceAllShelves` / `listShelves` / `shelvesForBook` are not exported.

- [ ] **Step 3: Write the implementation**

In `electron/main/services/db.ts`, add the imports:

```ts
import type { ShelfScope, ShelfSummary, ShelvesFile } from '@shared/shelf.types'
import { isManualShelf } from '@shared/shelf.types'
```

In `bookWhere`, after the `formats` block and before `return`:

```ts
  if (filters?.shelfId) {
    // A shelf is a scope (bookshelves D7), but it enters SQL here like any
    // filter, so the list, the page, the count and the facets cannot disagree.
    // `books.id` rather than `col('id')`: every caller's FROM names `books`,
    // and inside the subquery an unqualified `id` would be a guess.
    conditions.push(
      'EXISTS (SELECT 1 FROM shelf_books WHERE shelf_books.book_id = books.id AND shelf_books.shelf_id = ?)'
    )
    params.push(filters.shelfId)
  }
```

Replace `orderClause` (keep its existing doc comment, and add the paragraph shown) with:

```ts
/** An ORDER BY body and what it binds — only `shelf_added` binds anything. */
interface OrderBy {
  sql: string
  params: unknown[]
}

/**
 * …existing comment…
 *
 * `shelf_added` is the one sort that is not a column (bookshelves D8): it is
 * the open shelf's `added_at`, a correlated read bound to `shelfId`. Without a
 * shelf it has nothing to order by and takes the unknown-field fallback to
 * title, like any field `SORT_SQL` has no expression for — never a throw.
 */
function orderClause(
  sort: BookSort = { field: 'title', direction: 'asc' },
  tablePrefix = '',
  shelfId?: string
): OrderBy {
  const dir = sort.direction === 'desc' ? 'DESC' : 'ASC'
  const tiebreak = `${tablePrefix}id ASC`
  if (sort.field === 'shelf_added' && shelfId) {
    return {
      sql: `(SELECT shelf_books.added_at FROM shelf_books WHERE shelf_books.book_id = books.id AND shelf_books.shelf_id = ?) ${dir}, ${tiebreak}`,
      params: [shelfId]
    }
  }
  // Direction applies to every key, so descending 'series' fully reverses
  // series order rather than only flipping the index within each series
  const keys = (SORT_SQL[sort.field] ?? SORT_SQL.title)(tablePrefix).map((expr) => `${expr} ${dir}`)
  keys.push(tiebreak)
  return { sql: keys.join(', '), params: [] }
}
```

Replace `selectBooks`'s body (its doc comment stays true: with no shelf sort, the statement and its binds are exactly what they were):

```ts
function selectBooks(filters: BookFilters | undefined, page: BookPageRequest | null): BookRow[] {
  const where = bookWhere(filters)
  const order = orderClause(filters?.sort, '', filters?.shelfId)
  const paging = page ? ' LIMIT ? OFFSET ?' : ''
  // WHERE, then ORDER BY, then LIMIT/OFFSET — the order the placeholders appear in
  const params = [...where.params, ...order.params, ...(page ? [page.limit, page.offset] : [])]
  return getDb()
    .prepare(`SELECT * FROM books ${whereClause(where)} ORDER BY ${order.sql}${paging}`)
    .all(...params) as BookRow[]
}
```

Replace `searchBooks`:

```ts
/**
 * FTS search. Results are ordered by the given sort so the list-view headers
 * and the toolbar dropdown stay live during a search; with no sort they fall
 * back to FTS relevance rank. A `scope` searches inside one shelf (bookshelves
 * D7); the facet filters are still not applied here — widening that is not
 * this feature.
 */
export function searchBooks(query: string, sort?: BookSort, scope?: ShelfScope): Book[] {
  const filters = scope?.shelfId ? { shelfId: scope.shelfId } : undefined
  return searchRows(query, sort, filters, null).map(rowToBook)
}
```

In `searchRows`, replace the `order` and `params` lines, and use `order.sql` in the statement:

```ts
  const order: OrderBy = sort
    ? orderClause(sort, 'books.', filters?.shelfId)
    : { sql: 'rank, books.id ASC', params: [] }
  const params = [
    match,
    ...where.params,
    ...order.params,
    ...(page ? [page.limit, page.offset] : [])
  ]
```

```ts
       ORDER BY ${order.sql}${paging}`
```

Replace `getFacets`:

```ts
/**
 * The filter sidebar's counts. With a `scope` they count one shelf's books
 * (bookshelves D7) — through `bookWhere`, the one place a filter becomes SQL, so
 * a count and the list it sits beside cannot disagree.
 */
export function getFacets(scope?: ShelfScope): LibraryFacets {
  const d = getDb()
  const where = bookWhere(scope?.shelfId ? { shelfId: scope.shelfId } : undefined)
  const and = where.conditions.map((c) => ` AND ${c}`).join('')
  const p = where.params
  const authors = d
    .prepare(
      `SELECT author AS value, COUNT(*) AS count FROM books WHERE author IS NOT NULL${and} GROUP BY author ORDER BY count DESC, author`
    )
    .all(...p) as { value: string; count: number }[]
  const series = d
    .prepare(
      `SELECT series_name AS value, COUNT(*) AS count FROM books WHERE series_name IS NOT NULL${and} GROUP BY series_name ORDER BY count DESC, series_name`
    )
    .all(...p) as { value: string; count: number }[]
  const tags = d
    .prepare(
      `SELECT json_each.value AS value, COUNT(*) AS count FROM books, json_each(books.tags)
       WHERE books.tags IS NOT NULL${and} GROUP BY json_each.value ORDER BY count DESC, value`
    )
    .all(...p) as { value: string; count: number }[]
  const formats = d
    .prepare(
      `SELECT json_each.value AS value, COUNT(*) AS count FROM books, json_each(books.formats)
       WHERE books.formats IS NOT NULL${and} GROUP BY json_each.value ORDER BY count DESC, value`
    )
    .all(...p) as { value: BookFormat; count: number }[]
  const readStatus = d
    .prepare(
      // The fallback is READ_STATUS_FALLBACK, `rowToBook`'s own rule in SQL, so a row
      // the app shows as unread is counted in that bucket; the tiebreak is what makes
      // "ordered by count descending" true of this list too, as the document says of
      // all five
      `SELECT COALESCE(read_status, '${READ_STATUS_FALLBACK}') AS value, COUNT(*) AS count FROM books
       ${whereClause(where)}
       GROUP BY COALESCE(read_status, '${READ_STATUS_FALLBACK}') ORDER BY count DESC, value`
    )
    .all(...p) as { value: ReadStatus; count: number }[]
  return { authors, series, tags, formats, readStatus }
}
```

Add after `getFacets`:

```ts
// --- Shelves: a cache of shelves.json (services/shelves.ts owns every write) ---

/**
 * Replace the shelf cache with a file's view, in one transaction (bookshelves
 * D2, D4). Called by every shelf write with the file it just wrote, and by
 * adoption with the file it just read — one path, so the two cannot drift.
 *
 * - Only manual shelves: a kind this build does not know stays in the file and
 *   out of the cache (D1).
 * - A member whose book this cache does not hold is left out and **kept in the
 *   file** — the catalog may simply be behind (a book imported on another Mac).
 * - A repeated shelf id or member in a hand-edited file is ignored, first
 *   occurrence wins, rather than failing the whole adoption on a primary key.
 */
export function replaceAllShelves(file: ShelvesFile): void {
  const d = getDb()
  const insertShelf = d.prepare(
    "INSERT INTO shelves (id, name, kind, created_at, updated_at) VALUES (?, ?, 'manual', ?, ?)"
  )
  const insertMember = d.prepare(
    `INSERT OR IGNORE INTO shelf_books (shelf_id, book_id, added_at)
     SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM books WHERE id = ?)`
  )
  d.transaction(() => {
    d.prepare('DELETE FROM shelf_books').run()
    d.prepare('DELETE FROM shelves').run()
    const seen = new Set<string>()
    for (const shelf of file.shelves) {
      if (!isManualShelf(shelf) || seen.has(shelf.id)) continue
      seen.add(shelf.id)
      insertShelf.run(shelf.id, shelf.name, shelf.created_at, shelf.updated_at)
      for (const member of shelf.books) {
        insertMember.run(shelf.id, member.id, member.added_at, member.id)
      }
    }
  })()
}

interface ShelfSummaryRow {
  id: string
  name: string
  count: number
}

function toShelfSummary(r: ShelfSummaryRow): ShelfSummary {
  return { id: r.id, name: r.name, kind: 'manual', count: r.count }
}

/**
 * Every shelf, alphabetically and case-insensitively, then by id (D6). The count
 * is the cache's membership, which holds only books the library has —
 * `replaceAllShelves`, `deleteBook` and `replaceAllBooks` all keep it that way.
 */
export function listShelves(): ShelfSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.name, COUNT(sb.book_id) AS count
         FROM shelves s LEFT JOIN shelf_books sb ON sb.shelf_id = s.id
        GROUP BY s.id
        ORDER BY s.name COLLATE NOCASE, s.id`
    )
    .all() as ShelfSummaryRow[]
  return rows.map(toShelfSummary)
}

/** The shelves one book is on, in `listShelves`'s order. */
export function shelvesForBook(bookId: string): ShelfSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.name,
              (SELECT COUNT(*) FROM shelf_books c WHERE c.shelf_id = s.id) AS count
         FROM shelves s JOIN shelf_books m ON m.shelf_id = s.id AND m.book_id = ?
        ORDER BY s.name COLLATE NOCASE, s.id`
    )
    .all(bookId) as ShelfSummaryRow[]
  return rows.map(toShelfSummary)
}
```

- [ ] **Step 4: Run the whole suite, typecheck and lint**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all PASS. The existing `db.test.ts`, `rest.test.ts` and `shape.test.ts` cases must pass **untouched** — they are the proof that the unscoped statements did not move.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/db.ts electron/main/services/db-shelves.test.ts
git commit -m "shelves slice 1a: shelf cache, shelf scope through the one WHERE builder, shelf_added sort

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**— Part 1a review gate.** Everything above is green and reviewed before Task 5 starts.

---

# Part 1b — the service and its wiring

### Task 5: `services/shelves.ts` — the queue, create, add, remove, restore, reads

**Files:**
- Create: `electron/main/services/shelves.ts`
- Create: `electron/main/services/shelves.test.ts`
- Modify: `src/types/api.types.ts` — `EVENT_CHANNELS` only (`:391`): add `shelvesChanged: 'event:shelves-changed'` (the service broadcasts it; `broadcast` is typed over this object's keys)

**Interfaces:**
- Consumes: `readShelvesFile`, `writeShelvesFile`, `emptyShelvesFile` (Task 3); `db.replaceAllShelves`, `db.listShelves`, `db.shelvesForBook`, `db.bookExists` (Task 4); `nas.assertOnline`, `nas.getLibraryRoot`; `broadcast` from `./events`.
- Produces (Tasks 6–8 use these):
  - `const SHELF_NAME_MAX = 80`
  - `const SHELVES_UNREADABLE = 'shelves.json could not be read — shelf changes are paused so nothing is lost'`
  - `const SHELF_GONE = 'That shelf no longer exists'`
  - `function list(): ShelfSummary[]`, `function forBook(bookId: string): ShelfSummary[]`
  - `async function create(name: string, bookIds?: string[]): Promise<ShelfSummary>`
  - `async function addBooks(id: string, bookIds: string[]): Promise<ShelfAddResult>`
  - `async function removeBooks(id: string, bookIds: string[]): Promise<ShelfMembership[]>`
  - `async function restoreBooks(id: string, memberships: ShelfMembership[]): Promise<void>`
  - internal: `mutate`, `findShelf`, `cleanName`, `assertNameFree`, `ShelfGoneError` — Task 6 adds `rename`, `deleteShelf`, `pruneBooks`, `adopt` to the same file using them.

- [ ] **Step 1: Write the failing tests**

Create `electron/main/services/shelves.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManualShelfEntry, ShelvesFile } from '@shared/shelf.types'
import { makeBook } from '../../../test/helpers/book'
import { closeDb, getBooks, insertBook } from './db'
import * as nas from './nas-manager'
import * as shelves from './shelves'
import { readShelvesFile, shelvesPath } from './shelves-file'

let root: string

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  root = mkdtempSync(join(tmpdir(), 'musaeum-shelves-'))
  await nas.setLibraryRoot(root) // temp dir exists → state becomes 'connected'
  for (const id of ['a', 'b', 'c']) insertBook(makeBook(id))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** shelves.json as it is on the share now. */
async function onDisk(): Promise<ShelvesFile> {
  const read = await readShelvesFile(root)
  if (read.state !== 'ok') throw new Error(`shelves.json is ${read.state}`)
  return read.file
}

function manualOnDisk(file: ShelvesFile, id: string): ManualShelfEntry {
  const shelf = file.shelves.find((s) => s.id === id)
  if (!shelf || shelf.kind !== 'manual') throw new Error(`no manual shelf ${id} on disk`)
  return shelf as ManualShelfEntry
}

/** Counts writes of shelves.json from here on — every write goes through its `.part`. */
function countWrites(): () => number {
  const spy = vi.spyOn(fs, 'writeFile')
  return () => spy.mock.calls.filter(([path]) => String(path).endsWith('shelves.json.part')).length
}

describe('writes: file first, cache second, one write each (bookshelves D3)', () => {
  it('create, addBooks and removeBooks each write once and leave file and cache agreeing (AC2)', async () => {
    const writes = countWrites()
    const shelf = await shelves.create('To Read')
    expect(writes()).toBe(1)
    expect(shelf).toEqual({ id: shelf.id, name: 'To Read', kind: 'manual', count: 0 })

    expect(await shelves.addBooks(shelf.id, ['a', 'b'])).toEqual({ added: 2, alreadyOn: 0 })
    expect(writes()).toBe(2)

    const removed = await shelves.removeBooks(shelf.id, ['a'])
    expect(writes()).toBe(3)
    expect(removed.map((m) => m.bookId)).toEqual(['a'])

    expect(manualOnDisk(await onDisk(), shelf.id).books.map((m) => m.id)).toEqual(['b'])
    expect(shelves.list()).toEqual([{ id: shelf.id, name: 'To Read', kind: 'manual', count: 1 }])
    expect(getBooks({ shelfId: shelf.id }).map((b) => b.id)).toEqual(['b'])
  })

  it('creates a shelf with books in the same single write, skipping ids the library does not hold', async () => {
    const writes = countWrites()
    const shelf = await shelves.create('Favourites', ['a', 'not-a-book', 'a'])
    expect(writes()).toBe(1)
    expect(shelf.count).toBe(1)
    expect(manualOnDisk(await onDisk(), shelf.id).books.map((m) => m.id)).toEqual(['a'])
  })

  it('serializes mutations started together, each over a fresh read, so all of them land (AC3)', async () => {
    const shelf = await shelves.create('To Read')
    await Promise.all([
      shelves.addBooks(shelf.id, ['a']),
      shelves.addBooks(shelf.id, ['b']),
      shelves.create('Second')
    ])
    const disk = await onDisk()
    expect(manualOnDisk(disk, shelf.id).books.map((m) => m.id).sort()).toEqual(['a', 'b'])
    expect(disk.shelves).toHaveLength(2)
  })

  it('addBooks is idempotent: alreadyOn the second time, the first added_at kept, no write for a no-op (AC4)', async () => {
    const shelf = await shelves.create('To Read')
    await shelves.addBooks(shelf.id, ['a'])
    const first = manualOnDisk(await onDisk(), shelf.id).books[0].added_at
    const writes = countWrites()

    expect(await shelves.addBooks(shelf.id, ['a', 'b'])).toEqual({ added: 1, alreadyOn: 1 })
    expect(await shelves.addBooks(shelf.id, ['a', 'b'])).toEqual({ added: 0, alreadyOn: 2 })
    expect(writes()).toBe(1)
    expect(manualOnDisk(await onDisk(), shelf.id).books.find((m) => m.id === 'a')?.added_at).toBe(
      first
    )
  })

  it('skips ids the library does not hold, and counts them nowhere', async () => {
    const shelf = await shelves.create('To Read')
    expect(await shelves.addBooks(shelf.id, ['not-a-book'])).toEqual({ added: 0, alreadyOn: 0 })
  })

  it('removeBooks then restoreBooks round-trips every added_at exactly (AC5)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'))
    const shelf = await shelves.create('To Read', ['a'])
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'))
    await shelves.addBooks(shelf.id, ['b'])
    const before = manualOnDisk(await onDisk(), shelf.id).books

    vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'))
    const removed = await shelves.removeBooks(shelf.id, ['a', 'b'])
    expect(removed).toEqual([
      { bookId: 'a', addedAt: '2026-09-01T00:00:00.000Z' },
      { bookId: 'b', addedAt: '2026-09-02T00:00:00.000Z' }
    ])
    await shelves.restoreBooks(shelf.id, removed)

    const byId = (list: { id: string }[]) => [...list].sort((x, y) => x.id.localeCompare(y.id))
    expect(byId(manualOnDisk(await onDisk(), shelf.id).books)).toEqual(byId(before))
    expect(
      getBooks({ shelfId: shelf.id, sort: { field: 'shelf_added', direction: 'desc' } }).map(
        (b) => b.id
      )
    ).toEqual(['b', 'a'])
  })

  it('restoreBooks keeps a member that is already back, and ignores what is not a membership', async () => {
    const shelf = await shelves.create('To Read', ['a'])
    const [original] = await shelves.removeBooks(shelf.id, ['a'])
    await shelves.addBooks(shelf.id, ['a']) // re-added before the Undo
    const readded = manualOnDisk(await onDisk(), shelf.id).books[0].added_at
    await shelves.restoreBooks(shelf.id, [
      original,
      { bookId: 'b', addedAt: '' },
      { bookId: 7, addedAt: 'x' } as unknown as { bookId: string; addedAt: string }
    ])
    const books = manualOnDisk(await onDisk(), shelf.id).books
    expect(books).toEqual([{ id: 'a', added_at: readded }])
  })

  it('leaves file and cache as they were when the share write fails, and the next change still lands', async () => {
    const shelf = await shelves.create('To Read', ['a'])
    const before = await fs.readFile(shelvesPath(root), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('share dropped'))

    await expect(shelves.addBooks(shelf.id, ['b'])).rejects.toThrow('share dropped')
    expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe(before)
    expect(shelves.list()[0].count).toBe(1)

    await expect(shelves.addBooks(shelf.id, ['b'])).resolves.toEqual({ added: 1, alreadyOn: 0 })
    expect(shelves.list()[0].count).toBe(2)
  })

  it('names the shelves a book is on', async () => {
    const one = await shelves.create('One', ['a'])
    await shelves.create('Two', ['b'])
    expect(shelves.forBook('a')).toEqual([{ id: one.id, name: 'One', kind: 'manual', count: 1 }])
    expect(shelves.forBook('c')).toEqual([])
  })
})

describe('names (bookshelves D3, AC10)', () => {
  it.each([
    ['empty', '', /needs a name/],
    ['whitespace only', '  \t ', /needs a name/],
    ['81 characters', 'x'.repeat(81), /at most 80 characters/]
  ])('refuses a name that is %s, and writes nothing', async (_label, name, message) => {
    await expect(shelves.create(name)).rejects.toThrow(message)
    await expect(fs.access(shelvesPath(root))).rejects.toThrow()
  })

  it('trims, and allows exactly 80 characters', async () => {
    expect((await shelves.create('  To Read  ')).name).toBe('To Read')
    expect((await shelves.create('y'.repeat(80))).name).toBe('y'.repeat(80))
  })

  it('refuses a case-insensitive duplicate rather than suffixing it', async () => {
    await shelves.create('To Read')
    await expect(shelves.create('to read')).rejects.toThrow('There is already a shelf named “To Read”.')
    expect(shelves.list().map((s) => s.name)).toEqual(['To Read'])
  })
})
```

In `src/types/api.types.ts`, add to `EVENT_CHANNELS`:

```ts
  /** Shelves or their membership changed — a write here, over REST, or an adoption (bookshelves D6). */
  shelvesChanged: 'event:shelves-changed',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- electron/main/services/shelves.test.ts`
Expected: FAIL — `./shelves` cannot be resolved.

- [ ] **Step 3: Write the implementation**

Create `electron/main/services/shelves.ts`:

```ts
import { randomUUID } from 'crypto'
import type {
  ManualShelfEntry,
  ShelfAddResult,
  ShelfMembership,
  ShelfSummary,
  ShelvesFile
} from '@shared/shelf.types'
import { isManualShelf } from '@shared/shelf.types'
import * as db from './db'
import { broadcast } from './events'
import * as nas from './nas-manager'
import { emptyShelvesFile, readShelvesFile, writeShelvesFile } from './shelves-file'

/**
 * Every shelf write goes through here (`docs/superpowers/specs/2026-09-27-bookshelves-design.md`,
 * D3), and each one runs the same seven steps: assert the library is writable;
 * enter the one queue; **re-read** `shelves.json`; apply the change to what was
 * read; write it atomically; replace the SQLite cache from what was written;
 * broadcast `shelvesChanged`.
 *
 * - **File first, cache second.** A failed share write leaves the cache as it
 *   was, so the UI never shows a membership the file does not hold. A crash
 *   between the two is repaired by the next adoption, because the file is
 *   canonical.
 * - **Re-read every time.** Another Mac may have written since this one last
 *   looked; the change applies to the file as it is now, which is also why no
 *   tombstones are needed (D1).
 * - **One write per operation**, whatever the number of books — and none for an
 *   operation that changes nothing.
 * - **A file that exists but cannot be read is never overwritten.** Every
 *   mutation refuses with `SHELVES_UNREADABLE` until someone repairs it.
 */

export const SHELF_NAME_MAX = 80
export const SHELVES_UNREADABLE =
  'shelves.json could not be read — shelf changes are paused so nothing is lost'
export const SHELF_GONE = 'That shelf no longer exists'

/** A mutation that found its shelf absent from the re-read file — deleted on another Mac. */
class ShelfGoneError extends Error {
  constructor() {
    super(SHELF_GONE)
  }
}

/** What applying a change to the file produced: its answer, and whether there is anything to write. */
interface Applied<T> {
  result: T
  changed: boolean
}

// One queue per process — two writes interleaving their read-modify-write would
// lose one of them. Same shape as catalog.ts's.
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

async function mutate<T>(apply: (file: ShelvesFile, now: string) => Applied<T>): Promise<T> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()!
  return enqueue(async () => {
    const read = await readShelvesFile(root)
    if (read.state === 'invalid') throw new Error(SHELVES_UNREADABLE)
    const file = read.state === 'ok' ? read.file : emptyShelvesFile()
    let applied: Applied<T>
    try {
      applied = apply(file, new Date().toISOString())
    } catch (err) {
      if (err instanceof ShelfGoneError) {
        // The file just read is canonical and no longer holds the shelf, but the
        // cache still does: replace it, or the sidebar keeps offering a shelf
        // that every action refuses. Every `apply` looks its shelf up before it
        // changes anything, so `file` is still exactly what was read.
        db.replaceAllShelves(file)
        broadcast('shelvesChanged')
      }
      throw err
    }
    if (!applied.changed) return applied.result
    await writeShelvesFile(root, file)
    db.replaceAllShelves(file)
    broadcast('shelvesChanged')
    return applied.result
  })
}

function findShelf(file: ShelvesFile, id: string): ManualShelfEntry {
  const shelf = file.shelves.find((s): s is ManualShelfEntry => isManualShelf(s) && s.id === id)
  if (!shelf) throw new ShelfGoneError()
  return shelf
}

/** Trimmed, non-empty, at most 80 characters (counted as characters, not UTF-16 units). */
function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new Error('A shelf needs a name.')
  if ([...name].length > SHELF_NAME_MAX) {
    throw new Error(`A shelf name can be at most ${SHELF_NAME_MAX} characters.`)
  }
  return name
}

const foldName = (name: string): string => name.normalize('NFC').toLocaleLowerCase()

/**
 * Unique case-insensitively among manual shelves, checked against the re-read
 * file. A clash is refused, never auto-suffixed (D3). `selfId` lets a shelf be
 * renamed to its own name in another case.
 */
function assertNameFree(file: ShelvesFile, name: string, selfId: string | null): void {
  const key = foldName(name)
  const clash = file.shelves.find(
    (s): s is ManualShelfEntry => isManualShelf(s) && s.id !== selfId && foldName(s.name) === key
  )
  if (clash) throw new Error(`There is already a shelf named “${clash.name}”.`)
}

/**
 * Put books on a shelf. An existing member keeps its `added_at` (idempotent);
 * an id the library does not hold is skipped and counted nowhere (D3).
 */
function addMembers(shelf: ManualShelfEntry, bookIds: unknown, now: string): ShelfAddResult {
  const on = new Set(shelf.books.map((m) => m.id))
  let added = 0
  let alreadyOn = 0
  for (const id of new Set(Array.isArray(bookIds) ? bookIds : [])) {
    if (typeof id !== 'string') continue
    if (on.has(id)) {
      alreadyOn++
      continue
    }
    if (!db.bookExists(id)) continue
    shelf.books.push({ id, added_at: now })
    on.add(id)
    added++
  }
  return { added, alreadyOn }
}

function isMembership(value: unknown): value is ShelfMembership {
  if (typeof value !== 'object' || value === null) return false
  const { bookId, addedAt } = value as { bookId?: unknown; addedAt?: unknown }
  return typeof bookId === 'string' && bookId !== '' && typeof addedAt === 'string' && addedAt !== ''
}

// --- Reads: from the cache, never the share ---

export function list(): ShelfSummary[] {
  return db.listShelves()
}

export function forBook(bookId: string): ShelfSummary[] {
  return db.shelvesForBook(bookId)
}

// --- Mutations ---

export async function create(name: string, bookIds: string[] = []): Promise<ShelfSummary> {
  const clean = cleanName(name)
  return mutate((file, now) => {
    assertNameFree(file, clean, null)
    const shelf: ManualShelfEntry = {
      id: randomUUID(),
      name: clean,
      kind: 'manual',
      created_at: now,
      updated_at: now,
      books: []
    }
    addMembers(shelf, bookIds, now)
    file.shelves.push(shelf)
    // Answered from what was written, not read back from the cache afterwards —
    // by then the queue may have run another change
    return {
      result: { id: shelf.id, name: shelf.name, kind: 'manual', count: shelf.books.length },
      changed: true
    }
  })
}

export async function addBooks(id: string, bookIds: string[]): Promise<ShelfAddResult> {
  return mutate((file, now) => {
    const shelf = findShelf(file, id)
    const result = addMembers(shelf, bookIds, now)
    if (result.added > 0) shelf.updated_at = now
    return { result, changed: result.added > 0 }
  })
}

/** Take books off a shelf. Returns what was removed, timestamps included, for an Undo. */
export async function removeBooks(id: string, bookIds: string[]): Promise<ShelfMembership[]> {
  return mutate((file, now) => {
    const shelf = findShelf(file, id)
    const drop = new Set(Array.isArray(bookIds) ? bookIds : [])
    const removed: ShelfMembership[] = []
    shelf.books = shelf.books.filter((m) => {
      if (!drop.has(m.id)) return true
      removed.push({ bookId: m.id, addedAt: m.added_at })
      return false
    })
    if (removed.length > 0) shelf.updated_at = now
    return { result: removed, changed: removed.length > 0 }
  })
}

/**
 * Undo a remove: put the memberships back **with their original `added_at`**,
 * so a book returns to its place under *Date Added to Shelf* (D3). A book
 * already back on the shelf keeps the membership it has; one the library no
 * longer holds is skipped, as an add would skip it.
 */
export async function restoreBooks(id: string, memberships: ShelfMembership[]): Promise<void> {
  return mutate((file, now) => {
    const shelf = findShelf(file, id)
    const on = new Set(shelf.books.map((m) => m.id))
    let restored = 0
    for (const m of Array.isArray(memberships) ? memberships : []) {
      if (!isMembership(m) || on.has(m.bookId) || !db.bookExists(m.bookId)) continue
      shelf.books.push({ id: m.bookId, added_at: m.addedAt })
      on.add(m.bookId)
      restored++
    }
    if (restored > 0) shelf.updated_at = now
    return { result: undefined, changed: restored > 0 }
  })
}
```

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `npm test -- electron/main/services/shelves.test.ts && npm run typecheck && npm run lint`
Expected: PASS, both clean.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/shelves.ts electron/main/services/shelves.test.ts src/types/api.types.ts
git commit -m "shelves slice 1b: the shelf service — one queue, file then cache, create/add/remove/restore

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: rename, delete, prune, adopt — and the refusals every mutation shares

**Files:**
- Modify: `electron/main/services/shelves.ts` (append)
- Modify: `electron/main/services/shelves.test.ts` (append)

**Interfaces:**
- Consumes: everything Task 5 produced.
- Produces (Task 7 and 8 use these):
  - `async function rename(id: string, name: string): Promise<void>`
  - `async function deleteShelf(id: string): Promise<void>` — books untouched
  - `async function pruneBooks(bookIds: string[]): Promise<void>` — one write for the batch; no write when no shelf holds any of them; may reject (the caller swallows)
  - `function adopt(root: string): Promise<void>` — never rejects

- [ ] **Step 1: Write the failing tests**

Append to `electron/main/services/shelves.test.ts`, and add `writeShelvesFile` to its `./shelves-file` import and `subscribe` from `./events`:

```ts
import { subscribe } from './events'
import { readShelvesFile, shelvesPath, writeShelvesFile } from './shelves-file'
```

```ts
const AT = '2026-09-01T00:00:00.000Z'

/** Every mutation, pointed at shelf `id` — for the refusals every one of them shares. */
function everyMutation(id: string): [string, () => Promise<unknown>][] {
  return [
    ['create', () => shelves.create('Brand New')],
    ['rename', () => shelves.rename(id, 'Renamed')],
    ['deleteShelf', () => shelves.deleteShelf(id)],
    ['addBooks', () => shelves.addBooks(id, ['c'])],
    ['removeBooks', () => shelves.removeBooks(id, ['a'])],
    ['restoreBooks', () => shelves.restoreBooks(id, [{ bookId: 'b', addedAt: AT }])],
    ['pruneBooks', () => shelves.pruneBooks(['a'])]
  ]
}

describe('rename and delete', () => {
  it('lets a shelf take its own name in another case, and refuses another shelf’s (AC10)', async () => {
    const shelf = await shelves.create('To Read')
    const other = await shelves.create('Later')
    await shelves.rename(shelf.id, 'TO READ')
    expect(shelves.list().find((s) => s.id === shelf.id)?.name).toBe('TO READ')
    await expect(shelves.rename(other.id, '  to read ')).rejects.toThrow(
      'There is already a shelf named “TO READ”.'
    )
  })

  it('deletes the shelf and leaves every book in the library', async () => {
    const shelf = await shelves.create('To Read', ['a', 'b'])
    await shelves.deleteShelf(shelf.id)
    expect(shelves.list()).toEqual([])
    expect((await onDisk()).shelves).toEqual([])
    expect(getBooks().map((b) => b.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('refusals every mutation shares', () => {
  it.each([
    ['invalid JSON', 'not json{'],
    ['an unknown version', JSON.stringify({ version: 2, shelves: [] })]
  ])(
    'refuses every mutation over %s, and never rewrites the file (AC6, AC9)',
    async (_label, text) => {
      await fs.writeFile(shelvesPath(root), text, 'utf8')
      for (const [name, call] of everyMutation('s1')) {
        await expect(call(), name).rejects.toThrow(shelves.SHELVES_UNREADABLE)
      }
      expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe(text)
    }
  )

  it('refuses every change to a shelf deleted on another Mac, drops it from the cache, and leaves the file alone (AC8)', async () => {
    const shelf = await shelves.create('Doomed', ['a'])
    await writeShelvesFile(root, { version: 1, shelves: [] }) // another Mac deleted it
    const before = await fs.readFile(shelvesPath(root), 'utf8')
    const events: string[] = []
    const unsubscribe = subscribe((event) => {
      events.push(event)
    })

    const onShelf = everyMutation(shelf.id).filter(([name]) =>
      ['rename', 'deleteShelf', 'addBooks', 'removeBooks', 'restoreBooks'].includes(name)
    )
    for (const [name, call] of onShelf) {
      await expect(call(), name).rejects.toThrow(shelves.SHELF_GONE)
    }
    unsubscribe()

    expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe(before)
    expect(shelves.list()).toEqual([])
    expect(events.filter((e) => e === 'shelvesChanged')).toHaveLength(5)
  })

  it('refuses every mutation while the library is unreachable, changing neither file nor cache (AC15)', async () => {
    const shelf = await shelves.create('To Read', ['a'])
    const before = await fs.readFile(shelvesPath(root), 'utf8')
    const cached = shelves.list()
    await nas.setLibraryRoot(join(root, 'does-not-exist'))

    for (const [name, call] of everyMutation(shelf.id)) {
      await expect(call(), name).rejects.toThrow(/missing|offline/)
    }
    expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe(before)
    expect(shelves.list()).toEqual(cached)
  })
})

describe('pruneBooks (bookshelves D5)', () => {
  it('takes books off every shelf in one write', async () => {
    const one = await shelves.create('One', ['a', 'b'])
    const two = await shelves.create('Two', ['b', 'c'])
    const writes = countWrites()
    await shelves.pruneBooks(['a', 'b'])
    expect(writes()).toBe(1)
    const disk = await onDisk()
    expect(manualOnDisk(disk, one.id).books).toEqual([])
    expect(manualOnDisk(disk, two.id).books.map((m) => m.id)).toEqual(['c'])
  })

  it('writes nothing when no shelf holds the books, and creates no file where there was none', async () => {
    const writes = countWrites()
    await shelves.pruneBooks(['a'])
    expect(writes()).toBe(0)
    await expect(fs.access(shelvesPath(root))).rejects.toThrow()
  })
})

describe('adopt (bookshelves D4)', () => {
  it('skips a kind it does not know for the cache, and a later write carries it back unchanged (AC7)', async () => {
    const smart = {
      id: 'smart-1',
      kind: 'smart',
      name: 'Unread SF',
      rule: { tags: ['sf'], readStatus: 'unread' },
      future: [1, 2, 3]
    }
    const manual: ManualShelfEntry = {
      id: 'manual-1',
      name: 'To Read',
      kind: 'manual',
      created_at: AT,
      updated_at: AT,
      books: []
    }
    await writeShelvesFile(root, { version: 1, shelves: [smart, manual] })
    await shelves.adopt(root)
    expect(shelves.list().map((s) => s.id)).toEqual(['manual-1'])

    await shelves.addBooks('manual-1', ['a'])
    const carried = (await onDisk()).shelves.find((s) => s.id === 'smart-1')
    expect(JSON.stringify(carried)).toBe(JSON.stringify(smart))
  })

  it('never rejects, and keeps the cache when the file is unreadable', async () => {
    await shelves.create('To Read', ['a'])
    const cached = shelves.list()
    await fs.writeFile(shelvesPath(root), 'not json{', 'utf8')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(shelves.adopt(root)).resolves.toBeUndefined()
    expect(shelves.list()).toEqual(cached)
    expect(error).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- electron/main/services/shelves.test.ts`
Expected: FAIL — `shelves.rename` / `deleteShelf` / `pruneBooks` / `adopt` are not functions.

- [ ] **Step 3: Write the implementation**

Append to `electron/main/services/shelves.ts`:

```ts
export async function rename(id: string, name: string): Promise<void> {
  const clean = cleanName(name)
  return mutate((file, now) => {
    const shelf = findShelf(file, id)
    assertNameFree(file, clean, id)
    if (shelf.name === clean) return { result: undefined, changed: false }
    shelf.name = clean
    shelf.updated_at = now
    return { result: undefined, changed: true }
  })
}

/** Remove a shelf. Its books stay in the library — a shelf is a list, not a container. */
export async function deleteShelf(id: string): Promise<void> {
  return mutate((file) => {
    findShelf(file, id)
    file.shelves = file.shelves.filter((s) => !(isManualShelf(s) && s.id === id))
    return { result: undefined, changed: true }
  })
}

/**
 * Take deleted books off every shelf — **one** write for the whole batch, never
 * one per book (D5). No write at all when no shelf holds any of them, so a
 * library that has never used shelves never gets a `shelves.json` from a
 * delete. May reject; `book-delete.ts` logs and swallows that, because the book
 * is already gone (invariant 12).
 */
export async function pruneBooks(bookIds: string[]): Promise<void> {
  if (bookIds.length === 0) return
  return mutate((file, now) => {
    const gone = new Set(bookIds)
    let changed = false
    for (const shelf of file.shelves) {
      if (!isManualShelf(shelf)) continue
      const kept = shelf.books.filter((m) => !gone.has(m.id))
      if (kept.length === shelf.books.length) continue
      shelf.books = kept
      shelf.updated_at = now
      changed = true
    }
    return { result: undefined, changed }
  })
}

// Adoption logs an unreadable file once a session, not on every connect and Reload
let reportedUnreadable = false

/**
 * Land `shelves.json` in the cache — on connect and on Reload, after the book
 * swap (D4). Through the same queue as the writes: an adoption that read the
 * file just before a write landed must not replace the cache after it and undo
 * it.
 *
 * - A missing file is a library with no shelves, and **empties** the cache — a
 *   root switched to another library must not keep showing the last one's.
 * - An unreadable file leaves the cache as it was: browsing continues from the
 *   last good view, and the writes refuse until it is repaired.
 * - Never rejects: a shelf problem must not fail a catalog sync.
 */
export function adopt(root: string): Promise<void> {
  return enqueue(async () => {
    try {
      const read = await readShelvesFile(root)
      if (read.state === 'invalid') {
        if (!reportedUnreadable) {
          console.error(`[shelves] ${SHELVES_UNREADABLE}; keeping the last adopted shelves`)
          reportedUnreadable = true
        }
        return
      }
      db.replaceAllShelves(read.state === 'ok' ? read.file : emptyShelvesFile())
      broadcast('shelvesChanged')
    } catch (err) {
      console.error('[shelves] could not read shelves.json — keeping the last adopted shelves:', err)
    }
  })
}
```

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `npm test -- electron/main/services/shelves.test.ts && npm run typecheck && npm run lint`
Expected: PASS, both clean.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/shelves.ts electron/main/services/shelves.test.ts
git commit -m "shelves slice 1b: rename, delete, prune, adopt; unreadable/gone/offline refusals

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Adoption beside the catalog's, and pruning on delete

**Files:**
- Modify: `electron/main/services/library-sync.ts` (`syncOnConnect` at `:189`; `refreshLibrary` at `:224`)
- Modify: `electron/main/services/book-delete.ts` (`deleteBook` at `:56`; `deleteBooks` at `:141`)
- Modify: `electron/main/services/library-sync.test.ts` (append a `describe`)
- Modify: `electron/main/services/book-delete.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `shelves.adopt(root)`, `shelves.pruneBooks(ids)`, `shelves.list()`, `shelves.create(...)` (Tasks 5–6); `readShelvesFile`, `writeShelvesFile`, `shelvesPath` (Task 3).
- Produces: `syncOnConnect` and `refreshLibrary` adopt shelves after the book swap; `rebuildCatalog` does not; `deleteBook` / `deleteBooks` prune once, swallow a failure, and broadcast `shelvesChanged` on that failure.

- [ ] **Step 1: Write the failing tests**

Append to `electron/main/services/library-sync.test.ts` (add the imports shown to its existing import block):

```ts
import type { ManualShelfEntry, ShelvesFile } from '@shared/shelf.types'
import * as shelves from './shelves'
import { readShelvesFile, shelvesPath, writeShelvesFile } from './shelves-file'
```

```ts
describe('shelf adoption beside the catalog’s (bookshelves D4)', () => {
  const AT = '2026-09-27T10:00:00.000Z'
  const shelvesFile = (members: string[]): ShelvesFile => ({
    version: 1,
    shelves: [
      {
        id: 's1',
        name: 'To Read',
        kind: 'manual',
        created_at: AT,
        updated_at: AT,
        books: members.map((id) => ({ id, added_at: AT }))
      }
    ]
  })

  it('adopts on connect, keeping a member the catalog lacks out of the cache and in the file (AC11)', async () => {
    await writeCatalog(root, [makeBook('a'), makeBook('b')])
    await writeShelvesFile(root, shelvesFile(['a', 'imported-elsewhere']))
    await librarySync.syncOnConnect()

    expect(shelves.list()).toEqual([{ id: 's1', name: 'To Read', kind: 'manual', count: 1 }])
    const read = await readShelvesFile(root)
    if (read.state !== 'ok') throw new Error(`shelves.json is ${read.state}`)
    expect((read.file.shelves[0] as ManualShelfEntry).books.map((m) => m.id)).toEqual([
      'a',
      'imported-elsewhere'
    ])
  })

  it('re-adopts on Reload after the book swap, so a member whose book has arrived is counted (AC11)', async () => {
    await writeCatalog(root, [makeBook('a')])
    await writeShelvesFile(root, shelvesFile(['a', 'b']))
    await librarySync.syncOnConnect()
    expect(shelves.list()[0].count).toBe(1)

    await writeCatalog(root, [makeBook('a'), makeBook('b')])
    await librarySync.refreshLibrary()
    expect(shelves.list()[0].count).toBe(2)
  })

  it('empties the shelf cache when the library has no shelves.json', async () => {
    await writeCatalog(root, [makeBook('a')])
    await writeShelvesFile(root, shelvesFile(['a']))
    await librarySync.syncOnConnect()
    expect(shelves.list()).toHaveLength(1)

    await fs.rm(shelvesPath(root))
    await librarySync.refreshLibrary()
    expect(shelves.list()).toEqual([])
  })

  it('keeps the last adopted shelves when shelves.json is unreadable, and never rewrites it', async () => {
    await writeCatalog(root, [makeBook('a')])
    await writeShelvesFile(root, shelvesFile(['a']))
    await librarySync.syncOnConnect()
    await fs.writeFile(shelvesPath(root), 'not json{', 'utf8')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await librarySync.refreshLibrary()
    expect(shelves.list()).toEqual([{ id: 's1', name: 'To Read', kind: 'manual', count: 1 }])
    expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe('not json{')
    vi.restoreAllMocks()
  })

  it('tells the renderer the shelves changed', async () => {
    await writeCatalog(root, [makeBook('a')])
    const events: string[] = []
    const unsubscribe = subscribe((event) => {
      events.push(event)
    })
    await librarySync.syncOnConnect()
    unsubscribe()
    expect(events).toContain('shelvesChanged')
  })

  it('leaves shelves.json alone on Rebuild Catalog — it neither reads nor writes it', async () => {
    await fs.mkdir(join(root, 'books'), { recursive: true })
    await writeShelvesFile(root, shelvesFile([]))
    const read = vi.spyOn(fs, 'readFile')
    const write = vi.spyOn(fs, 'writeFile')
    await librarySync.rebuildCatalog()
    const touched = [...read.mock.calls, ...write.mock.calls].filter(([path]) =>
      String(path).includes('shelves.json')
    )
    expect(touched).toEqual([])
    vi.restoreAllMocks()
  })
})
```

Append to `electron/main/services/book-delete.test.ts` (add the imports shown):

```ts
import type { ManualShelfEntry } from '@shared/shelf.types'
import * as shelves from './shelves'
import { readShelvesFile, shelvesPath } from './shelves-file'
```

```ts
describe('deleting a book takes it off every shelf (bookshelves D5)', () => {
  function countShelfWrites(): () => number {
    const spy = vi.spyOn(fs, 'writeFile')
    return () => spy.mock.calls.filter(([path]) => String(path).endsWith('shelves.json.part')).length
  }

  async function membersOnDisk(): Promise<Record<string, string[]>> {
    const read = await readShelvesFile(root)
    if (read.state !== 'ok') throw new Error(`shelves.json is ${read.state}`)
    return Object.fromEntries(
      read.file.shelves.map((s) => [(s as ManualShelfEntry).name, (s as ManualShelfEntry).books.map((m) => m.id)])
    )
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prunes a bulk delete from every shelf with one write (AC12)', async () => {
    for (const id of ['a', 'b', 'c']) await seed(id, ['epub'])
    const one = await shelves.create('One', ['a', 'b'])
    const two = await shelves.create('Two', ['b', 'c'])
    const writes = countShelfWrites()

    await deleteBooks(['a', 'b'])

    expect(writes()).toBe(1)
    expect(await membersOnDisk()).toEqual({ One: [], Two: ['c'] })
    expect(shelves.list()).toEqual([
      { id: one.id, name: 'One', kind: 'manual', count: 0 },
      { id: two.id, name: 'Two', kind: 'manual', count: 1 }
    ])
  })

  it('prunes a single delete the same way (AC12)', async () => {
    await seed('a', ['epub'])
    await seed('b', ['epub'])
    await shelves.create('One', ['a', 'b'])
    const writes = countShelfWrites()

    await deleteBook('a')

    expect(writes()).toBe(1)
    expect(await membersOnDisk()).toEqual({ One: ['b'] })
  })

  it('writes nothing for books on no shelf, and creates no shelves.json', async () => {
    await seed('a', ['epub'])
    await seed('b', ['epub'])
    const writes = countShelfWrites()

    await deleteBooks(['a'])
    await deleteBook('b')

    expect(writes()).toBe(0)
    await expect(fs.access(shelvesPath(root))).rejects.toThrow()
  })

  it('keeps the delete when the shelves cannot be pruned, and says the shelves changed', async () => {
    await seed('a', ['epub'])
    await shelves.create('One', ['a'])
    await fs.writeFile(shelvesPath(root), 'not json{', 'utf8')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const events: string[] = []
    const unsubscribe = subscribe((event) => {
      events.push(event)
    })

    await expect(deleteBook('a')).resolves.toBeUndefined()
    unsubscribe()

    expect(getBook('a')).toBeNull()
    expect(shelves.list()[0].count).toBe(0)
    expect(error).toHaveBeenCalled()
    expect(events).toContain('shelvesChanged')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- electron/main/services/library-sync.test.ts electron/main/services/book-delete.test.ts`
Expected: FAIL — `shelves.list()` is empty after `syncOnConnect`; the prune tests see zero writes and stale members.

- [ ] **Step 3: Write the implementation**

In `electron/main/services/library-sync.ts`, add `import * as shelves from './shelves'`, and at the end of `syncOnConnect`, after its `try { … } catch { … }`:

```ts
  // Shelves are their own canonical file (bookshelves D1, D4), adopted after the
  // book swap so a member whose book just arrived is counted. Outside the
  // catalog's try: a missing or unreadable catalog says nothing about
  // shelves.json, and `adopt` never rejects.
  await shelves.adopt(root)
```

Replace `refreshLibrary`'s body after `const result = …`:

```ts
export async function refreshLibrary(): Promise<CatalogSyncOutcome> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()!
  const result = await catalog.readCatalogDetailed(root)
  let outcome: CatalogSyncOutcome
  if (result.state !== 'ok') {
    outcome = await rebuildCatalog()
  } else {
    adopt(result.file.books)
    handledRoots.add(root)
    outcome = { books: result.file.books.length, cancelled: false }
  }
  // Reload re-reads shelves.json too (bookshelves D4) — here, after the swap,
  // and not in `rebuildCatalog`, which the spec keeps away from shelves. A
  // cancelled walk changed no books, so the shelves have nothing to catch up on.
  if (!outcome.cancelled) await shelves.adopt(root)
  return outcome
}
```

In `electron/main/services/book-delete.ts`, add `import * as shelves from './shelves'`, and after `removeFolder`:

```ts
/**
 * Take deleted books off every shelf — one shelves.json write for the batch,
 * never one per book (bookshelves D5). Logged and swallowed (invariant 12): the
 * book is already gone, and a stale member is left out of the cache by adoption
 * and dropped by the next write that touches its shelf. The cache already lost
 * the membership with the row (`db.deleteBook`), so the renderer is told even
 * though the file could not be.
 */
async function pruneFromShelves(ids: string[]): Promise<void> {
  try {
    await shelves.pruneBooks(ids)
  } catch (err) {
    console.error('[delete] could not take deleted books off their shelves:', err)
    broadcast('shelvesChanged')
  }
}
```

In `deleteBook`, after `librarySync.removeBookFromCatalog(id)`:

```ts
  await pruneFromShelves([id])
```

In `deleteBooks`, add `const deletedIds: string[] = []` beside `let deleted = 0`, push `id` where `deleted++` happens, and inside `if (deleted > 0) {`, after `librarySync.writeFullCatalog()`:

```ts
    await pruneFromShelves(deletedIds)
```

- [ ] **Step 4: Run the whole suite, typecheck and lint**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all PASS, including every pre-existing `library-sync.test.ts` and `book-delete.test.ts` case unchanged.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/library-sync.ts electron/main/services/book-delete.ts electron/main/services/library-sync.test.ts electron/main/services/book-delete.test.ts
git commit -m "shelves slice 1b: adopt shelves on connect and Reload; prune on delete, one write per batch

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: IPC, preload and `MusaeumAPI`

**Files:**
- Create: `electron/main/ipc/shelves.ts`
- Create: `electron/main/ipc/shelves.test.ts`
- Modify: `electron/main/ipc/library.ts` (`library:searchBooks` at `:31`, `library:getFacets` at `:33`)
- Modify: `electron/main/index.ts` (import beside `:8-17`; register beside `:184-193`)
- Modify: `electron/preload/index.ts` (`library.searchBooks`, `library.getFacets`; a new `shelves` namespace after `library`)
- Modify: `src/types/api.types.ts` (`MusaeumAPI.library.searchBooks` at `:105`, `getFacets` at `:122`; a new `shelves` namespace after `library`)

**Interfaces:**
- Consumes: every export of `services/shelves.ts`; `db.searchBooks(query, sort, scope)`, `db.getFacets(scope)` (Task 4).
- Produces (slice 2 builds on this surface exactly):

```ts
shelves: {
  list(): Promise<ShelfSummary[]>
  forBook(bookId: string): Promise<ShelfSummary[]>
  create(name: string, bookIds?: string[]): Promise<ShelfSummary>
  rename(id: string, name: string): Promise<void>
  delete(id: string): Promise<void>
  addBooks(id: string, bookIds: string[]): Promise<ShelfAddResult>
  removeBooks(id: string, bookIds: string[]): Promise<ShelfMembership[]>
  restoreBooks(id: string, memberships: ShelfMembership[]): Promise<void>
  onChanged(cb: () => void): Unsubscribe
}
library.searchBooks(query: string, sort?: BookSort, scope?: ShelfScope): Promise<Book[]>
library.getFacets(scope?: ShelfScope): Promise<LibraryFacets>
```

Channels: `shelves:list`, `shelves:forBook`, `shelves:create`, `shelves:rename`, `shelves:delete`, `shelves:addBooks`, `shelves:removeBooks`, `shelves:restoreBooks`; event `event:shelves-changed`.

- [ ] **Step 1: Write the failing test**

No case in this repo drives a registered `ipcMain` closure (`electron/main/ipc/nas.test.ts` records why), and the handlers are one line each over services Tasks 5–7 decide. What *can* break silently is the channel spelling shared by two processes, so that is what this test pins. Create `electron/main/ipc/shelves.test.ts`:

```ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The preload invokes a channel by string and main registers it by string; a
 * typo in either is a promise that rejects with "No handler registered" and no
 * type error anywhere. So the two spellings are compared here.
 */
describe('shelves IPC — the preload and the handlers name the same channels', () => {
  const channels = (file: string): string[] =>
    [...readFileSync(join(process.cwd(), file), 'utf8').matchAll(/'(shelves:[A-Za-z]+)'/g)]
      .map((m) => m[1])
      .sort()

  it('registers exactly the eight channels the preload invokes', () => {
    const registered = channels('electron/main/ipc/shelves.ts')
    expect(registered).toEqual([
      'shelves:addBooks',
      'shelves:create',
      'shelves:delete',
      'shelves:forBook',
      'shelves:list',
      'shelves:removeBooks',
      'shelves:rename',
      'shelves:restoreBooks'
    ])
    expect(channels('electron/preload/index.ts')).toEqual(registered)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- electron/main/ipc/shelves.test.ts`
Expected: FAIL — `ENOENT` reading `electron/main/ipc/shelves.ts`.

- [ ] **Step 3: Write the implementation**

Create `electron/main/ipc/shelves.ts`:

```ts
import type { ShelfMembership } from '@shared/shelf.types'
import * as shelves from '../services/shelves'
import { handle } from './handle'

/**
 * Shelves (bookshelves D6). Thin by rule (invariant 8): the queue, the
 * file-then-cache order, the name rules and every refusal are
 * `services/shelves.ts`'s, and a refusal reaches the renderer as the envelope's
 * `error` — the sentence main composed.
 */
export function registerShelvesHandlers(): void {
  handle('shelves:list', () => shelves.list())
  handle('shelves:forBook', (bookId: string) => shelves.forBook(bookId))
  handle('shelves:create', (name: string, bookIds?: string[]) => shelves.create(name, bookIds))
  handle('shelves:rename', (id: string, name: string) => shelves.rename(id, name))
  handle('shelves:delete', (id: string) => shelves.deleteShelf(id))
  handle('shelves:addBooks', (id: string, bookIds: string[]) => shelves.addBooks(id, bookIds))
  handle('shelves:removeBooks', (id: string, bookIds: string[]) =>
    shelves.removeBooks(id, bookIds)
  )
  handle('shelves:restoreBooks', (id: string, memberships: ShelfMembership[]) =>
    shelves.restoreBooks(id, memberships)
  )
}
```

In `electron/main/ipc/library.ts`, import `ShelfScope` (`import type { ShelfScope } from '@shared/shelf.types'`) and replace the two handlers:

```ts
  handle('library:searchBooks', (query: string, sort?: BookSort, scope?: ShelfScope) =>
    db.searchBooks(query, sort, scope)
  )

  handle('library:getFacets', (scope?: ShelfScope) => db.getFacets(scope))
```

In `electron/main/index.ts`, `import { registerShelvesHandlers } from './ipc/shelves'` (alphabetically after `./ipc/settings`) and call `registerShelvesHandlers()` after `registerSettingsHandlers()`.

In `src/types/api.types.ts`, import the shelf types:

```ts
import type { ShelfAddResult, ShelfMembership, ShelfScope, ShelfSummary } from './shelf.types'
```

change the two `library` members:

```ts
    /**
     * Sorted by `sort` when given, otherwise by FTS relevance rank. A `scope`
     * searches inside one shelf; the facet filters are not applied to a search.
     */
    searchBooks(query: string, sort?: BookSort, scope?: ShelfScope): Promise<Book[]>
```

```ts
    /** The filter sidebar's counts — one shelf's, when a `scope` is given. */
    getFacets(scope?: ShelfScope): Promise<LibraryFacets>
```

and add after the `library` block:

```ts
  /**
   * User-made shelves (bookshelves D6). Every write lands in
   * `{library_root}/shelves.json` first and the cache second, so each rejects
   * while the library is unreachable, while shelves.json is unreadable, and for
   * a shelf deleted on another Mac — with main's sentence as the message.
   */
  shelves: {
    /** Alphabetical, case-insensitive. `count` counts only books the library holds. */
    list(): Promise<ShelfSummary[]>
    forBook(bookId: string): Promise<ShelfSummary[]>
    /** Names are trimmed, non-empty, ≤ 80 characters and unique case-insensitively. */
    create(name: string, bookIds?: string[]): Promise<ShelfSummary>
    rename(id: string, name: string): Promise<void>
    /** Removes the shelf; its books stay in the library. */
    delete(id: string): Promise<void>
    /** Idempotent: a book already on the shelf keeps its place and counts as `alreadyOn`. */
    addBooks(id: string, bookIds: string[]): Promise<ShelfAddResult>
    /** Resolves to what was removed, timestamps included — hand it to `restoreBooks` to Undo. */
    removeBooks(id: string, bookIds: string[]): Promise<ShelfMembership[]>
    restoreBooks(id: string, memberships: ShelfMembership[]): Promise<void>
    /** Shelves or membership changed — here, over REST, or by adoption. */
    onChanged(cb: () => void): Unsubscribe
  }
```

In `electron/preload/index.ts`, change the two `library` lines:

```ts
    searchBooks: (query, sort, scope) => invoke('library:searchBooks', query, sort, scope),
```

```ts
    getFacets: (scope) => invoke('library:getFacets', scope),
```

and add after the `library` block:

```ts
  shelves: {
    list: () => invoke('shelves:list'),
    forBook: (bookId) => invoke('shelves:forBook', bookId),
    create: (name, bookIds) => invoke('shelves:create', name, bookIds),
    rename: (id, name) => invoke('shelves:rename', id, name),
    delete: (id) => invoke('shelves:delete', id),
    addBooks: (id, bookIds) => invoke('shelves:addBooks', id, bookIds),
    removeBooks: (id, bookIds) => invoke('shelves:removeBooks', id, bookIds),
    restoreBooks: (id, memberships) => invoke('shelves:restoreBooks', id, memberships),
    onChanged: (cb) => listen(EVENT_CHANNELS.shelvesChanged, () => cb())
  },
```

- [ ] **Step 4: Run the whole suite, typecheck and lint**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all PASS — including `test/invariants.test.ts`'s invariant-8 case (the new IPC file imports no `fs`/`path`; the `.test.ts` beside it is excluded from that scan by name).

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/shelves.ts electron/main/ipc/shelves.test.ts electron/main/ipc/library.ts electron/main/index.ts electron/preload/index.ts src/types/api.types.ts
git commit -m "shelves slice 1b: window.Musaeum.shelves; shelf scope on search and facets over IPC

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Docs that land with slice 1

**Files:**
- Create: `docs/invariants/shelves.md`
- Modify: `CLAUDE.md` (routing table — one row)
- Modify: `docs/data-contracts.md` (a `shelves.json` section after `## metadata.json …`; the SQLite schema paragraph at `:74`; the `IPC API Surface` block)
- Modify: `docs/invariants/nas-and-catalog.md` (`## Book Storage Structure` tree)
- Modify: `docs/invariants/files-and-deletion.md` (`## Deletion`, the "What a delete takes with it" paragraph)
- Modify: `docs/architecture.md` (the `services/` tree near `:116`)
- Modify: `CHANGELOG.md`, `tasks.md` (`:375`), `requirements.md` (`:474`)
- Modify: `docs/superpowers/specs/2026-09-27-bookshelves-design.md` (the **Status** line)

**Interfaces:** none — documentation of what Tasks 1–8 built. Prose is **not hard-wrapped**.

- [ ] **Step 1: Write `docs/invariants/shelves.md`** with these sections, each carrying its reason:
  - **Read before:** touching `shelves.json`, `services/shelves.ts`, `services/shelves-file.ts`, the shelf cache, or a shelf-scoped read.
  - **Storage:** `{library_root}/shelves.json` is canonical (a second canonical file beside `catalog.json`, which stays derived — invariant 1 untouched; *Rebuild Catalog* neither reads nor writes it). Why not per-book `metadata.json` (300 writes to shelve 300 books over SMB, `last_modified` noise) and why not SQLite-only (never leaves this Mac) — from spec D1.
  - **File first, cache second, one queue:** the seven steps (D3); one write per operation and none for a no-op; the cache is replaced wholesale from the written file, the same path adoption takes, so the two cannot drift; a crash between file and cache is repaired by the next adoption.
  - **Never overwrite what cannot be read:** a malformed manual shelf or an unknown `version` makes the whole file unreadable, and every mutation refuses with the verbatim sentence until it is repaired. Unknown kinds and unknown keys are carried through untouched.
  - **Why no tombstones:** every mutation re-reads; a shelf deleted elsewhere is absent and the mutation refuses (and the cache drops it); the residue is two Macs inside one SMB write window, where last write wins either way.
  - **Adoption:** on connect and Reload, after the book swap, through the same queue; a missing file empties the cache; an unreadable one keeps it; members whose book is not in the catalog stay in the file and out of the cache.
  - **Deletion:** one prune write per delete batch; none when no shelf holds the books; a failure is logged and swallowed (invariant 12).
  - **A shelf is a scope, not a filter:** `BookFilters.shelfId` through `bookWhere`, the one WHERE builder; `shelf_added` through `orderClause`, which binds the shelf id; without a shelf it falls back to title. The REST `sort=shelf_added` is held at 400 until slice 5 adds `shelf`.
  - A closing line naming what slices 2–5 add here later (the drag payload rule arrives with slice 3).
- [ ] **Step 2: CLAUDE.md** — add a routing-table row after `docs/invariants/files-and-deletion.md`'s: `| \`docs/invariants/shelves.md\` | \`shelves.json\`, the shelf service and cache, a shelf-scoped read or sort |`.
- [ ] **Step 3: `docs/data-contracts.md`** — a `## shelves.json (library-level, stored on NAS)` section with D1's JSON example, the field meanings, the version rule, and the unknown-kind rule; in the SQLite paragraph, one sentence: migration 006 dropped the never-used `collections` / `book_collections` (guarded to refuse if either held rows) and added the `shelves` / `shelf_books` cache with no foreign keys, and why; in the IPC block, the `shelves` namespace and the two `library` signature changes exactly as Task 8 typed them.
- [ ] **Step 4: `docs/invariants/nas-and-catalog.md`** — in the storage tree, add `shelves.json                     # canonical: every shelf and its members (see docs/invariants/shelves.md)` under `catalog.json`.
- [ ] **Step 5: `docs/invariants/files-and-deletion.md`** — replace "`book_collections` and `metadata_conflicts` rows for the book are deleted in the same transaction" with `shelf_books` and `metadata_conflicts`, and add one sentence: both delete paths then take the books off every shelf in `shelves.json` with one write per batch, swallowing a failure (`docs/invariants/shelves.md`).
- [ ] **Step 6: `docs/architecture.md`** — in the `services/` tree, after `library-sync.ts`: `shelves.ts        # every shelf write: one queue, file then cache` and `shelves-file.ts   # shelves.json parse (strict) + atomic write`; in the `ipc/` tree, `shelves.ts`.
- [ ] **Step 7: `CHANGELOG.md`** — a new `## [Unreleased] — 2026-09-27` section at the top with `### Added`: shelves' storage, service and IPC (slice 1 of the bookshelves design) — no UI yet. `tasks.md:375` — replace the collections line with a bookshelves entry naming slices 2–6 as open, and add the deferred items from the spec's *Rejected and deferred* (smart shelves, manual order within a shelf, sidebar reorder, phone create/rename/delete, search honouring facet filters) each with its revival condition. `requirements.md:474` — mark the collections line superseded by `docs/superpowers/specs/2026-09-27-bookshelves-design.md`.
- [ ] **Step 8: The spec's Status line** — replace "Nothing is built." with "Slice 1 (storage, service, IPC) landed 2026-09-27 — plan `docs/superpowers/plans/2026-09-27-bookshelves-slice1.md`."
- [ ] **Step 9: Verify and commit**

Run: `npm run lint && git diff --stat`
Expected: lint clean; only the files listed above changed in this task.

```bash
git add docs/invariants/shelves.md CLAUDE.md docs/data-contracts.md docs/invariants/nas-and-catalog.md docs/invariants/files-and-deletion.md docs/architecture.md CHANGELOG.md tasks.md requirements.md docs/superpowers/specs/2026-09-27-bookshelves-design.md
git commit -m "shelves slice 1: docs — shelves invariant, data contracts, deletion, storage tree

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**— Part 1b review gate**, then the whole-branch review: `reviewer` against CLAUDE.md's invariants list (1, 8, 12 are the ones this slice touches).

---

## Handoff notes for slice 2 (renderer) — found while planning, not built here

- `isBookSort` now accepts `shelf_added`, and `library.store.ts:220` restores a persisted sort through it. D8 says the library sort is the only persisted sort, so slice 2 must never persist `shelf_added` — and should treat a restored `shelf_added` (from a build that did) as the library default.
- `shelvesChanged` is broadcast by every shelf write, by adoption, and by a delete whose prune failed. A delete whose prune **succeeded** broadcasts it too (through `mutate`). `libraryChanged` alone is not a reason to re-read shelves.
- The unreadable-file refusal is the same sentence on every mutation; the spec wants it surfaced **once per session** — that de-duplication is the renderer's.
- Every mutation rejects with main's sentence as the `Error.message`; the offline/missing wording is `assertOnline()`'s, not `storage-copy.ts`'s.

## Self-review

- **Spec coverage:** D1 → Tasks 1, 3; D2 → Task 2 (+ the cache in 4); D3 → Tasks 5–6; D4 → Tasks 6–7; D5 → Tasks 6–7; D6 → Tasks 1, 4, 8; D7 → Tasks 1, 4, 8 (main half; the store is slice 2); D8 → Tasks 1, 4 (main half). *Error handling* rows: offline (6), share write fails (5), unparseable (3, 6, 7), deleted elsewhere (6), unknown ids (5), crash between writes (by construction: the next adoption replaces the cache from the file — 7), prune failure (7). AC1–AC15 mapped in the table above. Docs the spec says land with this slice → Task 9.
- **Placeholders:** none; every code step carries its code.
- **Type consistency:** `ShelfSummary`, `ShelfMembership`, `ShelfAddResult`, `ShelfScope`, `ShelvesFile`, `ManualShelfEntry`, `isManualShelf` defined in Task 1 and used unchanged; `replaceAllShelves` / `listShelves` / `shelvesForBook` (Task 4) are what Tasks 5–7 call; `deleteShelf` is the service name and `delete` the preload name, as D6 spells both.
- **Review Focus:** each of the five has its test in the task named.
