# Portable decisions — slice 2: the status clock travels

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `read_status` a clock of its own (`read_status_at`) and judge it, at adoption, independently of the reading position — so a status decision on one machine and a newer position from the other both survive.

**Architecture:** The status clock travels exactly where `owned_fields` does: a nullable record field (`read_status_at`) mirrored by a `books` column (migration 008), read and written at the same three seams (`db.ts` row ⇄ Book, `catalog.ts` record ⇄ Book, `importer.ts`'s record writer). Two writers stamp it — the manual decision (`reading-state.noteStatusChange`) and the automatic reader advance (`reading-state.saveProgress`) — and `library-sync.preserveLocalReadingState` stops carrying both reading fields as one record and reconciles each against its own clock. No new store, no new IPC, nothing on the HTTP wire (`bookPayload` picks its members explicitly; verified).

**Tech Stack:** TypeScript strict (main + renderer via `tsconfig.{node,web}.json`), better-sqlite3 + raw SQL migrations, vitest run through Electron-as-Node, Python sidecar untouched.

**Spec:** `docs/superpowers/specs/2026-09-20-portable-decisions-design.md` — this plan implements **D5** and **AC7–AC10** (slice 2, the status clock travels). Read it with this plan; where they disagree, the spec's decision wins (see "Decisions taken where the spec is silent" for the two places the spec is silent).

## Global Constraints

- **No behavior change to any value's meaning.** Slice 1's lock rule (`owned-fields.ts`) and slice 3's blanking (D6) are not in play; a field's *value* semantics do not move.
- **Invariant 5** (`docs/invariants/reader.md`) — reading state (position *and* read status) survives the round trip. Slice 2 is precisely this invariant, judged per field.
- **Invariant 1** — `metadata.json` is canonical; the catalog is derived. The new field travels in the record; the catalog mirrors it.
- **Invariant 12** — a failure is non-fatal: an unreadable or absent `read_status_at` degrades to "no clock", never a throw.
- **Migration counts are load-bearing.** The next migration is **008** (007 is `007_owned_fields.sql`). Any `rewindToNNN` test helper that already existed must drop this column too, or replaying 008 fails on a duplicate column (a lesson slice 1 recorded).
- **Gates at HEAD (`ac96152`, 2026-10-13):** `npm run typecheck` 0, `npm run lint` 0, `npm test` = **2,122 passed / 97 files**; `sidecar/.venv/bin/python -m pytest sidecar/tests -q` = **413 passed** (must stay 413 — no sidecar file moves); `npx prettier --check <touched file>` 0. Never `npm run format` (it rewrites vendored files). `npm test` only ever as `npm test` (Electron-as-Node keeps the better-sqlite3 native ABI matched); a single file is `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run <path>`.
- **The app is not launched.** Every AC7–AC10 decider here is a service/unit case. Slice 1's two-profile probe (AC4/AC5) is not repeated.
- Stage named paths only, never `git add -A` (`.obsidian/workspace.json` churns on its own). No merge, push or PR unasked.

## Decisions taken where the spec is silent

Two forks the spec does not settle. Both are called out here so the reviewer can reverse either without reading the diff.

1. **The automatic advance stamps `read_status_at` too.** D5's consequence says `noteStatusChange` "keeps its role as the only writer of that stamp". Taken literally, `saveProgress`'s automatic advance (`nextReadStatus`, unread → reading → read) would leave `read_status_at` null, and the reconcile's tie rule (incoming wins on unparseable) would then let an older catalog status beat a status this machine advanced by reading — reintroducing, for automatic advances, the exact bug slice 2 exists to fix. There is also a test that cannot even be *written* under the literal reading (`library-sync.test.ts`'s "still loses to a reading event the catalog recorded later" needs the incoming status to carry a clock). **Decision:** `read_status_at` is stamped by **every** change to `read_status`, manual or automatic; D5's sentence is read as "`noteStatusChange` is the only writer of the *manual decision*, as opposed to the editor writing it". Reversal: one line — say the automatic advance should not stamp, and Task 3's `saveProgress` step is deleted.
2. **Migration 008 seeds `read_status_at` from `reading_updated_at`.** Before this column, a status decision moved `reading_updated_at` (that was `touchReadingState`'s whole job) — so every pre-upgrade decision on this machine already has a usable time in that column. Without the seed, every pre-upgrade decision reads as "no clock" and the catalog's status wins on the next adoption: a decision the user made is silently reverting at upgrade. The seed is one SQL statement, the same shape as slice 1's `seedOwnedFieldsFromConfig` departure (which the owner approved). Caveat, accepted: the seed over-states the clock for a book whose last *page turn* is newer than its last status change, so a seeded status can win against a catalog status newer than the decision but older than the last page turn — bounded to one book's one field, and no worse than the shared clock it replaces. Reversal: delete the `UPDATE …` line from the migration file.

Both decisions live in Task 1 (seed) and Task 3 (auto-advance).

## Review Focus

The five conditions most likely to bite a person using this, none of which the ACs name directly; each gets its test in the task that owns the code.

1. **A pre-slice-2 catalog.json (`readStatusAt` absent) on the other machine.** A reasonable person expects their status not to flap during the upgrade window. Pinned by Task 4's "an incoming status with no clock loses to a local clock that parses".
2. **A hand-edited `metadata.json` whose `read_status_at` is a number, object or empty string.** Expect "no clock" and no crash, never a `Date.parse` on a non-string. Pinned by Task 2's validator case.
3. **Equal instants spelled differently** (`…T10:00:00Z` vs `…T10:00:00.000Z`) on the *status* clock — the quirk slice 1 learned the hard way. Expect the incoming record's status. Pinned by Task 4's tie case.
4. **`read_status` present but `read_status_at` absent on both sides.** Expect the incoming record (adoption is otherwise authoritative), not a retained local status. Pinned by Task 4.
5. **A status change in the detail panel that changes nothing** (saving the row with the same status). Expect no clock movement — that is the half this slice pins; a restating save still rewrites `metadata.json` and whole-record-upserts the catalog, which is pre-existing `library-edit.updateBook` behavior this slice does not change (the whole-branch review's finding). Pinned by Task 3's restating-patch case.

---

### Task 1: The field, the column, and the migration

The type that carries the clock reaches every full `Book` literal; the compiler finds them all once `readStatusAt` is required. This task lands the field end to end (type, schema, row ⇄ Book, both record *sources*) and the migration-replay upkeep, so the tree compiles and the two migration tests are honest again.

**Files:**
- Modify: `src/types/book.types.ts:178-181` (the `Book` interface, beside `readStatus`/`readingState`)
- Create: `electron/main/schema/migrations/008_read_status_at.sql`
- Modify: `electron/main/services/db.ts` (import + `MIGRATIONS` at `:17-33`; `BookRow` at `:180-186`; `rowToBook` at `:188-228`; `insertBook` at `:597-641`; `touchReadingState` at `:725`)
- Modify: `electron/main/services/importer.ts:292` (the new-book literal)
- Modify: `electron/main/services/migration.ts:328` (the Calibre-import new-book literal)
- Modify: `electron/main/services/catalog.ts:316` (`metadataJsonToBook` return)
- Modify: `test/helpers/book.ts:32`
- Modify: `electron/main/services/db-shelves.test.ts:45-59` (`rewindTo005`), `:78`, `:86-88`
- Test: `electron/main/services/db.test.ts`

**Interfaces:**
- Produces: `Book.readStatusAt: string | null`; the `books.read_status_at` column; `db.touchReadStatusAt(id: string, at: string): void` (renamed from `touchReadingState`, now writes `read_status_at` — Task 3 calls it).

- [ ] **Step 1: Write the failing column round-trip test**

In `electron/main/services/db.test.ts`, add a describe (the file already imports `insertBook`, `getBook`, `makeBook`):

```ts
describe('read status clock', () => {
  it('round-trips readStatusAt through the row', () => {
    insertBook({ ...makeBook('clock'), readStatusAt: '2026-10-13T09:00:00.000Z' })
    expect(getBook('clock')?.readStatusAt).toBe('2026-10-13T09:00:00.000Z')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run electron/main/services/db.test.ts -t "read status clock"`
Expected: FAIL — `getBook(...)?.readStatusAt` is `undefined` (the field does not exist yet).

- [ ] **Step 3: Add the type, the migration, and the row plumbing**

`src/types/book.types.ts` — beside `readStatus` (line 176):

```ts
  readStatus: ReadStatus
  /** ISO time the user (or the reader's automatic advance) last set `readStatus`. `null` = no clock recorded; travels in metadata.json (`read_status_at`). */
  readStatusAt: string | null
  nasPath: string | null
```

`electron/main/schema/migrations/008_read_status_at.sql`:

```sql
-- When a read status was last set, mirrored from metadata.json so the status
-- can be ordered on a clock of its own rather than reading state's shared one
-- (portable-decisions D5). Not an FTS column, so the sync triggers are
-- unaffected. NULL = no status decision recorded yet.
ALTER TABLE books ADD COLUMN read_status_at TEXT;

-- Upgrade seed: before this column, a status decision moved `reading_updated_at`
-- (touchReadingState's whole job), so that clock is this machine's record of
-- when the status last changed. Carrying it over keeps an already-made decision
-- orderable against the other machine's instead of reading as "no clock" and
-- letting the catalog's status win on the next adoption.
UPDATE books SET read_status_at = reading_updated_at WHERE reading_updated_at IS NOT NULL;
```

`electron/main/services/db.ts` — import and register (mirroring `:23` and `:33`):

```ts
import migration008 from '../schema/migrations/008_read_status_at.sql?raw'
```
```ts
const MIGRATIONS: string[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008
]
```

`BookRow` (add after `owned_fields: string | null` at `:185`):

```ts
  read_status_at: string | null
```

`rowToBook` (add beside `readStatus`, `:214`):

```ts
    readStatus: (r.read_status ?? READ_STATUS_FALLBACK) as ReadStatus,
    readStatusAt: r.read_status_at,
```

`insertBook` — add the column to the list (`:605-606`) and its value (after `book.readStatus,` at `:634`), keeping the placeholder count equal to the column count:

```ts
        read_status, nas_path, reading_position, reading_percent, reading_updated_at,
        owned_fields, read_status_at
```
```ts
      book.readStatus,
      book.nasPath,
      book.readingState?.position ?? null,
      book.readingState?.percent ?? null,
      book.readingState?.updatedAt ?? null,
      Object.keys(book.ownedFields).length ? JSON.stringify(book.ownedFields) : null,
      book.readStatusAt
```

Rename `touchReadingState` → `touchReadStatusAt` and point it at the new column (`:725-727`), rewriting its docblock's "one clock for reading state" sentence:

```ts
/**
 * Move a book's read-status clock without touching where it is.
 *
 * `read_status` is the field this stamp orders: `library-sync.ts` compares it
 * to the catalog's `read_status_at` to decide whether this machine's *status*
 * is newer, independently of the position's own clock (`reading_updated_at`).
 * A status change the user made in the detail panel once moved the position
 * clock instead — one clock for both halves — so a status decision could keep
 * an older local position against the catalog's newer one (the residual
 * `docs/invariants/reader.md` recorded); this column ends that.
 */
export function touchReadStatusAt(id: string, at: string): void {
  getDb().prepare('UPDATE books SET read_status_at = ? WHERE id = ?').run(at, id)
}
```

- [ ] **Step 4: Fix the four remaining `Book` literals and the helper**

Add `readStatusAt: null` to each full literal the compiler now flags (these all represent a book with no status clock yet):

- `electron/main/services/importer.ts:292` (beside `ownedFields: {}`)
- `electron/main/services/migration.ts:328` (beside `ownedFields: {}`)
- `electron/main/services/catalog.ts:316` — this one reads the record, so it is not `null`; see Task 2. For now, to compile, set `readStatusAt: null` and Task 2 replaces it with the record read.
- `test/helpers/book.ts:32` (beside `ownedFields: {}`)

- [ ] **Step 5: Write the failing migration-seed test**

In `electron/main/services/db.test.ts`, add (it needs `Database` from `better-sqlite3` and the migration text — import `migration008 from '../schema/migrations/008_read_status_at.sql?raw'`):

```ts
import Database from 'better-sqlite3'

describe('migration 008 — the read-status clock', () => {
  it('adds the column and seeds it from the old shared clock', () => {
    const d = new Database(':memory:')
    d.exec('CREATE TABLE books (id TEXT PRIMARY KEY, reading_updated_at TEXT)')
    d.prepare('INSERT INTO books (id, reading_updated_at) VALUES (?, ?)').run('opened', '2026-08-13T10:00:00Z')
    d.prepare('INSERT INTO books (id, reading_updated_at) VALUES (?, ?)').run('never', null)

    d.exec(migration008)

    expect(d.prepare('SELECT read_status_at FROM books WHERE id = ?').get('opened')).toEqual({
      read_status_at: '2026-08-13T10:00:00Z'
    })
    expect(d.prepare('SELECT read_status_at FROM books WHERE id = ?').get('never')).toEqual({
      read_status_at: null
    })
    d.close()
  })
})
```

- [ ] **Step 6: Run both new tests**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run electron/main/services/db.test.ts`
Expected: PASS (both describes).

- [ ] **Step 7: Update the migration-replay upkeep**

`electron/main/services/db-shelves.test.ts` — the replay lands at 008 now, and `rewindTo005` must drop the new column or replaying 008 fails on a duplicate column:

```ts
    ALTER TABLE books DROP COLUMN owned_fields;
    ALTER TABLE books DROP COLUMN read_status_at;
```
```ts
    expect(d.pragma('user_version', { simple: true })).toBe(8)
```
```ts
    // 007 and 008 run after 006 on this path and add their columns, empty
    expect(d.prepare('SELECT * FROM books ORDER BY id').all()).toEqual(
      before.map((row) => ({ ...(row as object), owned_fields: null, read_status_at: null }))
    )
```

- [ ] **Step 8: Run the whole main suite to find leftover literals**

Run: `npm run typecheck && npm test`
Expected: typecheck 0; `npm test` green with the case count up by the two new cases (2,124 if no other case moves). If typecheck flags another full `Book` literal, add `readStatusAt: null` there — do not add it to a `Partial<Book>` patch.

- [ ] **Step 9: Commit**

```bash
git add src/types/book.types.ts electron/main/schema/migrations/008_read_status_at.sql electron/main/services/db.ts electron/main/services/importer.ts electron/main/services/migration.ts electron/main/services/catalog.ts electron/main/services/db-shelves.test.ts electron/main/services/db.test.ts test/helpers/book.ts
git commit -m "audit(PD2): give read_status a clock of its own — the column and the migration"
```

---

### Task 2: The clock round-trips through the record

`metadata.json` is the canonical carrier; `catalog.json` mirrors the resolved `Book`. This task makes the field survive both directions and guards a hand-edited value.

**Files:**
- Modify: `electron/main/services/importer.ts:601-642` (`writeMetadataJson`)
- Modify: `electron/main/services/catalog.ts:231-261` (`MetadataJson`), `:276-318` (`metadataJsonToBook`), `:85-93` (`fromCatalogEntry`)
- Test: `electron/main/services/catalog.test.ts`

**Interfaces:**
- Consumes: `Book.readStatusAt` (Task 1).
- Produces: `metadata.json`'s `read_status_at` member; `MetadataJson.read_status_at?: string | null`.

- [ ] **Step 1: Write the failing round-trip and validator tests**

In `electron/main/services/catalog.test.ts` (imports already present: `metadataJsonToBook`, `writeMetadataJson`, `peekNextScratchId`, `makeBook`):

```ts
describe('read_status_at', () => {
  it('reads the record member, and reads an absent one as no clock', async () => {
    const withClock = await metadataJsonToBook(
      { id: 'a', title: 'A', read_status: 'read', read_status_at: '2026-10-13T09:00:00.000Z' },
      'a',
      root
    )
    expect(withClock.readStatusAt).toBe('2026-10-13T09:00:00.000Z')

    const without = await metadataJsonToBook({ id: 'b', title: 'B', read_status: 'read' }, 'b', root)
    expect(without.readStatusAt).toBeNull()
  })

  it('reads a hand-edited non-string as no clock, never a throw', () => {
    const bad = { id: 'c', title: 'C', read_status_at: 42 } as unknown as MetadataJson
    return expect(metadataJsonToBook(bad, 'c', root)).resolves.toMatchObject({ readStatusAt: null })
  })

  it('writes the clock the book carries, and round-trips it back', async () => {
    const dir = join(root, 'books', 'rt')
    await fs.mkdir(dir, { recursive: true })
    await writeMetadataJson(dir, { ...makeBook('rt'), readStatus: 'reading', readStatusAt: '2026-10-13T09:00:00.000Z' })

    const written = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8'))
    expect(written.read_status_at).toBe('2026-10-13T09:00:00.000Z')

    const back = await metadataJsonToBook(written as MetadataJson, 'rt', dir)
    expect(back.readStatusAt).toBe('2026-10-13T09:00:00.000Z')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run electron/main/services/catalog.test.ts -t "read_status_at"`
Expected: FAIL — `MetadataJson` has no `read_status_at` (a `tsc` error inside the test) and/or `readStatusAt` is `null` where a value is expected.

- [ ] **Step 3: Implement the record read and write**

`catalog.ts` — the `MetadataJson` interface, after `reading_state` (`:256`):

```ts
  /** ISO time a read status was last set, mirrored by the `books.read_status_at` column (portable-decisions D5). */
  read_status_at?: string | null
```

`metadataJsonToBook` (`:316`) — replace the Task 1 placeholder `readStatusAt: null`:

```ts
    readStatusAt: typeof json.read_status_at === 'string' ? json.read_status_at : null,
```

`fromCatalogEntry` (`:85-93`) — normalize the mirror on read, the same guard `ownedFields` gets:

```ts
function fromCatalogEntry(book: Book): Book {
  const normalized = withSortKeys(book)
  const ownedFields = parseOwnedFields(normalized.ownedFields)
  const readStatusAt = typeof normalized.readStatusAt === 'string' ? normalized.readStatusAt : null
  const readingState = validateReadingState(normalized.readingState)
  if (readingState === null && normalized.readingState == null) {
    return { ...normalized, ownedFields, readStatusAt }
  }
  return { ...normalized, readingState, ownedFields, readStatusAt }
}
```

`importer.ts` — `writeMetadataJson`'s JSON object, after `read_status` (`:628`):

```ts
    read_status: book.readStatus,
    read_status_at: book.readStatusAt,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run electron/main/services/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/importer.ts electron/main/services/catalog.ts electron/main/services/catalog.test.ts
git commit -m "audit(PD2): read_status_at round-trips through metadata.json and the catalog"
```

---

### Task 3: Both writers stamp the clock

The clock is only useful if every change to `read_status` moves it. Two writers: the manual decision (`noteStatusChange`) and the reader's automatic advance (`saveProgress`). This task also makes `saveProgress` push the clock to the catalog.

**Files:**
- Modify: `electron/main/services/reading-state.ts:36` (`READING_FIELDS`), `:67-71` (`noteStatusChange`), `:93-94` (`saveProgress`)
- Modify: `electron/main/services/library-edit.ts:26-30` (comment only — the call itself is unchanged)
- Test: `electron/main/services/reading-state.test.ts:266-286` (the `noteStatusChange` describe) and a new case in `saveProgress write tiering`

**Interfaces:**
- Consumes: `db.touchReadStatusAt` (Task 1).
- Produces: `read_status_at` is stamped on any status change; `READING_FIELDS` includes `readStatusAt`.

- [ ] **Step 1: Rewrite the failing `noteStatusChange` cases**

`electron/main/services/reading-state.test.ts` — the describe at `:266-286` asserts the old shared clock. Assert the new column instead:

```ts
describe('noteStatusChange', () => {
  /**
   * `read_status_at` is what adoption orders the status by, so a decision that
   * does not move it is a decision adoption cannot see — and moving the
   * *position* clock instead is what let a status decision drag an older
   * position with it (the residual slice 2 ends).
   */
  it('stamps the status clock, so adoption can order the decision', () => {
    insertBook(makeBook('nsc'))
    noteStatusChange('nsc', { readStatus: 'reading' }, makeBook('nsc'))

    const stamped = getBook('nsc')?.readStatusAt
    expect(stamped).toBeTruthy()
    expect(Number.isNaN(Date.parse(stamped!))).toBe(false)
    // The position clock is untouched: this was a status decision, not a page turn
    expect(getBook('nsc')?.readingState).toBeNull()
  })

  it('stamps nothing when the patch restates the row', () => {
    insertBook(makeBook('nsc-same')) // readStatus is 'unread'
    noteStatusChange('nsc-same', { readStatus: 'unread' }, makeBook('nsc-same'))

    expect(getBook('nsc-same')?.readStatusAt).toBeNull()
  })
})
```

- [ ] **Step 2: Add the failing automatic-advance case**

In the `saveProgress write tiering` describe (`:146` onward):

```ts
  it('stamps the status clock when it advances the status', async () => {
    await seed('b-clock')
    await saveProgress({ bookId: 'b-clock', position: 'p1', percent: 0.1, final: false }, 1_000)

    const book = getBook('b-clock')
    expect(book?.readStatus).toBe('reading')
    expect(book?.readStatusAt).toBe(book?.readingState?.updatedAt)
  })
```

- [ ] **Step 3: Run them to verify they fail**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run electron/main/services/reading-state.test.ts`
Expected: FAIL — `readStatusAt` is null after a decision/advance (nothing stamps it yet).

- [ ] **Step 4: Implement both writers**

`reading-state.ts` — the catalog push list (`:36`) gains the clock:

```ts
const READING_FIELDS: readonly (keyof Book)[] = ['readingState', 'readStatus', 'readStatusAt']
```

`noteStatusChange` (`:67-71`) — stamp the new column, and correct the docblock's reference to `reading_updated_at`:

```ts
export function noteStatusChange(bookId: string, patch: Partial<Book>, before: Book | null): void {
  if (!('readStatus' in patch)) return
  if (before && before.readStatus === patch.readStatus) return
  db.touchReadStatusAt(bookId, new Date().toISOString())
}
```

(Update the function's docblock: replace "`reading_updated_at` is that state's clock" with "`read_status_at` is that field's clock", keeping the rest.)

`saveProgress` — stamp on the automatic advance, at the same instant the position is written (`:93-94`):

```ts
  const status = advanceStatus ? nextReadStatus(book.readStatus, state.percent) : book.readStatus
  if (status !== book.readStatus) {
    db.updateBook(book.id, { readStatus: status })
    db.touchReadStatusAt(book.id, state.updatedAt)
  }
```

The `const updated = { ...db.getBook(book.id)!, readingState: state, readStatus: status }` line below re-reads the row, so the stamp `db.getBook` now carries reaches `metadata.json` and the catalog push — no further change there.

`library-edit.ts:26-29` — the comment says the status change "moves that state's clock"; correct it to name the status clock:

```ts
  // A read-status change is a decision about the status, so it moves the
  // status clock — before the `getBook` below, so the metadata.json written
  // after it carries the same clock. Without it the decision is one adoption
  // cannot order, and the next launch's catalog wins (`CLAUDE.md` #5).
```

- [ ] **Step 5: Run the reading-state file, then the whole suite**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run electron/main/services/reading-state.test.ts`
Expected: PASS, including the untouched quit-replay case "does not re-derive the status from a report it replays" (AC10).

Then Run: `npm run typecheck && npm test`
Expected: EXIT 0, 0; every file green.

- [ ] **Step 6: Commit**

```bash
git add electron/main/services/reading-state.ts electron/main/services/library-edit.ts electron/main/services/reading-state.test.ts
git commit -m "audit(PD2): every read_status change stamps read_status_at"
```

---

### Task 4: Adoption judges the status on its own clock

The whole point: `preserveLocalReadingState` stops carrying both reading fields as one record and reconciles each against its own clock. This task also reconciles the tests that encoded the shared clock.

**Files:**
- Modify: `electron/main/services/library-sync.ts:132-155` (`preserveLocalReadingState`) and its docblock `:104-131`
- Test: `electron/main/services/library-sync.test.ts` — the "a read status the user set" describe (`:140-211`), plus new cases

**Interfaces:**
- Consumes: `Book.readStatusAt` (Task 1), the stamped clock (Task 3).
- Produces: `preserveLocalReadingState` takes the newer position by `readingState.updatedAt` and the newer status by `readStatusAt`, independently, pushing the won fields (`readingState`, `readStatus`, `readStatusAt`) back to the catalog.

- [ ] **Step 1: Update the existing cases that encoded the shared clock**

`electron/main/services/library-sync.test.ts` — "still loses to a reading event the catalog recorded later" (`:192`) means the incoming *record* is newer, so its status must carry a clock too. Set it (the position's `updatedAt` is already `2099-01-01T00:00:00Z` at `:202`):

```ts
      incoming.readStatus = 'reading'
      incoming.readStatusAt = '2099-01-01T00:00:00Z'
      incoming.readingState = {
        position: 'cfi-elsewhere',
        percent: 0.4,
        updatedAt: '2099-01-01T00:00:00Z'
      }
```

Leave "survives adoption of a catalog whose reading event is older" (`:160`) as it is — its incoming carries no `readStatusAt`, so the local decision (a real clock) wins, which is now the seed case from Review Focus 1.

- [ ] **Step 2: Write the failing AC8 and AC9 cases**

Add to the same describe (or a sibling describe on `applyCatalog`; `insertBook`, `writeCatalog`, `readCatalog`, `getBook` are already imported):

```ts
    /** AC8 — a status decision here and a newer position from the catalog both survive. */
    it('keeps this machine’s status and takes the catalog’s newer position', async () => {
      const local = makeBook('rs-both')
      local.readStatus = 'unread'
      local.readStatusAt = '2026-08-13T12:00:00Z' // the decision
      local.readingState = { position: 'cfi-old', percent: 0.1, updatedAt: '2026-08-13T09:00:00Z' }
      insertBook(local)

      const incoming = makeBook('rs-both')
      incoming.readStatus = 'reading'
      incoming.readStatusAt = '2026-08-13T11:00:00Z' // older than the decision
      incoming.readingState = { position: 'cfi-new', percent: 0.4, updatedAt: '2026-08-13T11:00:00Z' }
      await writeCatalog(root, [incoming])

      await librarySync.syncOnConnect()
      await librarySync.flushForTests()

      expect(getBook('rs-both')?.readStatus).toBe('unread') // local status clock newer
      expect(getBook('rs-both')?.readingState?.position).toBe('cfi-new') // catalog position clock newer
    })

    /** AC9 — a newer catalog status beats an older local one. */
    it('takes a status the catalog recorded later than this machine’s', async () => {
      const local = makeBook('rs-cat-status')
      local.readStatus = 'unread'
      local.readStatusAt = '2026-08-13T09:00:00Z'
      insertBook(local)

      const incoming = makeBook('rs-cat-status')
      incoming.readStatus = 'read'
      incoming.readStatusAt = '2026-08-13T12:00:00Z'
      await writeCatalog(root, [incoming])

      await librarySync.syncOnConnect()

      expect(getBook('rs-cat-status')?.readStatus).toBe('read')
    })
```

- [ ] **Step 3: Run them to verify they fail**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run electron/main/services/library-sync.test.ts -t "status"`
Expected: FAIL — the AC8 case's position stays `cfi-old` (the local record wins wholesale), or the AC9 case's status stays `unread`.

- [ ] **Step 4: Implement the per-field reconcile**

`library-sync.ts` — replace `preserveLocalReadingState` (`:132-155`) and rewrite its docblock (`:104-131`) to state the two clocks:

```ts
/**
 * Reconcile incoming books' reading state against the local cache before a
 * wholesale `db.replaceAllBooks` — call immediately before every one of them.
 * Reading position is written to SQLite on every page turn but reaches the NAS
 * on a trailing clock: a 30s throttle for the former, session boundaries for
 * the latter, and neither at all while offline (`reading-state.ts` parks the
 * report in memory instead, so quitting offline loses it if nothing here
 * restores it). A wholesale replace with the incoming (stale) catalog view
 * would silently erase the newer local state.
 *
 * **The two halves are judged on clocks of their own** (portable-decisions D5):
 * the position by `readingState.updatedAt`, the status by `readStatusAt`. They
 * were one record on one clock, so a status decision made here kept an *older*
 * local position against the catalog's newer one — the residual
 * `docs/invariants/reader.md` recorded, and the thing this splits. Each field
 * keeps the local value only when the local clock is *strictly* newer and
 * parses; equal or unparseable-local keeps the incoming record, since adoption
 * is otherwise authoritative. Books whose local value won are pushed back to
 * catalog.json in one batched field-merge so the NAS catches up.
 *
 * Reads the local cache once — this runs on every connect/refresh over the
 * whole library (~6,900 books), not per book.
 */
function preserveLocalReadingState(incoming: Book[]): Book[] {
  const localById = new Map(db.getBooks().map((b) => [b.id, b]))
  const changed: Book[] = []
  const merged = incoming.map((book) => {
    const local = localById.get(book.id)
    if (!local) return book
    let out = book

    const localPosition = parseUpdatedAt(local.readingState?.updatedAt)
    if (local.readingState && localPosition !== null) {
      const incomingPosition = parseUpdatedAt(book.readingState?.updatedAt)
      if (incomingPosition === null || incomingPosition < localPosition) {
        out = { ...out, readingState: local.readingState }
      }
    }

    const localStatus = parseUpdatedAt(local.readStatusAt ?? undefined)
    if (localStatus !== null) {
      const incomingStatus = parseUpdatedAt(book.readStatusAt ?? undefined)
      if (incomingStatus === null || incomingStatus < localStatus) {
        out = { ...out, readStatus: local.readStatus, readStatusAt: local.readStatusAt }
      }
    }

    if (out !== book) changed.push(out)
    return out
  })
  if (changed.length > 0) {
    updateCatalogFields(changed, ['readingState', 'readStatus', 'readStatusAt'])
  }
  return merged
}
```

- [ ] **Step 5: Run the file, then the whole suite**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run electron/main/services/library-sync.test.ts`
Expected: PASS — including the untouched position-only cases and the updated "still loses to a reading event the catalog recorded later".

Then Run: `npm run typecheck && npm run lint && npm test`
Expected: EXIT 0, 0, 0; 97 files green.

- [ ] **Step 6: Add the remaining Review Focus cases (tie, both-absent) into this test file**

```ts
    it('keeps the incoming status on a differently-spelled tie of instants', async () => {
      const local = makeBook('rs-status-tie')
      local.readStatus = 'read'
      local.readStatusAt = '2026-08-13T12:00:00Z'
      insertBook(local)

      const incoming = makeBook('rs-status-tie')
      incoming.readStatus = 'unread'
      incoming.readStatusAt = '2026-08-13T12:00:00.000Z' // the same instant
      await writeCatalog(root, [incoming])

      await librarySync.syncOnConnect()
      expect(getBook('rs-status-tie')?.readStatus).toBe('unread')
    })

    it('keeps the incoming status when neither side has a status clock', async () => {
      const local = makeBook('rs-no-clock')
      local.readStatus = 'read'
      insertBook(local)

      const incoming = makeBook('rs-no-clock')
      incoming.readStatus = 'unread'
      await writeCatalog(root, [incoming])

      await librarySync.syncOnConnect()
      expect(getBook('rs-no-clock')?.readStatus).toBe('unread')
    })
```

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run electron/main/services/library-sync.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add electron/main/services/library-sync.ts electron/main/services/library-sync.test.ts
git commit -m "audit(PD2): adoption judges the read status on its own clock (D5)"
```

---

### Task 5: The record and the invariant

The residual `docs/invariants/reader.md` records is now decided; the contract documents the new optional field.

**Files:**
- Modify: `docs/invariants/reader.md:94` (the "Known residue" sentence and the same-clock claim)
- Modify: `docs/data-contracts.md` (the `metadata.json` member table)
- Modify: `tasks.md` (the Portable decisions entry — mark slice 2 built) and `docs/superpowers/specs/2026-09-20-portable-decisions-design.md` (the `Status` line and a `Built — slice 2` section)

- [ ] **Step 1: Correct the residual in `reader.md`**

Replace the "Known residue: the two halves share one clock …" tail of `:94` with a sentence that records the shipped split (name `read_status_at`, the two clocks, and that a status decision no longer drags the position). Keep the second half of the sentence — "opening a book in the reader still advances a manual Unread to Reading" — as it is; that remains the documented advance rule.

- [ ] **Step 2: Document the member**

In `docs/data-contracts.md`, add `read_status_at` beside the existing `reading_state`/`read_status` row: optional, ISO-8601 or absent, "when a read status was last set; absent or unreadable reads as no clock".

- [ ] **Step 3: Record the slice**

In `docs/superpowers/specs/2026-09-20-portable-decisions-design.md`, update the `**Status:**` line (slice 2 built) and add a `## Built — slice 2` section with the gate numbers this run prints; in `tasks.md`, update the Portable decisions bullet (slice 2 built, slices 3 remains open).

- [ ] **Step 4: Run the doc-touching gates and commit**

Run: `npm run typecheck && npm run lint && npm test` → EXIT 0, 0, 0
Run: `sidecar/.venv/bin/python -m pytest sidecar/tests -q` → 413 passed (unchanged — no sidecar file moved)

```bash
git add docs/invariants/reader.md docs/data-contracts.md docs/superpowers/specs/2026-09-20-portable-decisions-design.md tasks.md
git commit -m "docs(PD2): slice 2 built — the status clock travels"
```

---

## Self-Review

**Spec coverage.**
- **D5** (own clock; per-field reconcile; tie rule per field) → Tasks 1–4.
- **AC7** (`read_status_at` round-trips; `noteStatusChange` stamps it; a restating patch does not) → Task 1 (column), Task 2 (record), Task 3 (both stamp cases).
- **AC8** (a status decision here + a newer catalog position both survive) → Task 4, Step 2.
- **AC9** (a newer catalog status wins; equal/unparseable keeps incoming) → Task 4, Steps 2 and 6.
- **AC10** (the quit-replay case stays green) → Task 3, Step 5 (explicit), untouched by Tasks 1–4.
- **D5's "`touchReadingState` becomes stamp-the-status-clock"** → Task 1, Step 3 (renamed `touchReadStatusAt`).
- **Files the spec names** — `db.ts`, `reading-state.ts`, `library-sync.ts`, `importer.ts`, `catalog.ts`, `docs/invariants/reader.md`, plus tests — all present. **Two the spec did not list** and this plan adds, named rather than silent: `src/types/book.types.ts` and `test/helpers/book.ts` (the spec under-counts the type reach exactly as slice 1 did), `migration.ts` (a third full-`Book` literal), and `docs/data-contracts.md` (Risk 1's contract, documented where the sibling field is). **File count is 11 source/doc files plus tests — over the "~10" escalation line the spec's "~7" did not anticipate; slice 1 landed 24 and recorded the same.**

**Placeholder scan.** No "TBD"/"add validation"/"similar to Task N" — every step carries the code or the exact edit.

**Type consistency.** `Book.readStatusAt: string | null` (Task 1) is read by `metadataJsonToBook` (Task 2), stamped by `touchReadStatusAt` (Tasks 1/3), and reconciled by `preserveLocalReadingState` (Task 4) — one name, one type, throughout. `READING_FIELDS` (Task 3) matches the `updateCatalogFields` field list (Task 4).

**Review Focus coverage.** 1 → Task 4 Step 1 (the untouched "older" case). 2 → Task 2 Step 1 (the non-string case). 3 → Task 4 Step 6 (the tie). 4 → Task 4 Step 6 (both-absent). 5 → Task 3 Step 1 (the restating patch).
