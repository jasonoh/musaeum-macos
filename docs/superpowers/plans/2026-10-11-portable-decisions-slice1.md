# Portable decisions, slice 1 — the claim travels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the set of fields a user has claimed (today `app_config.field_overrides`, machine-local) lives in each book's own record — `metadata.json`, `catalog.json` and a `books` column — timestamped per field, so the second machine honours it.

**Architecture:** a new `owned_fields` map `{field: ISO}` on the `Book` (column `books.owned_fields`, `metadata.json` key `owned_fields`). `services/field-overrides.ts` keeps its public API (`list`, `markFromPatch`, `release`) and moves its storage from `app_config` onto the row, so every enforcement site (`importer.hydrate`'s lock list, the reply filter, the editor's padlock) is untouched. A pure module, `services/owned-fields.ts`, holds the validator and the per-field reconcile, which `library-sync.adopt` applies beside the reading-state reconcile. `app_config.field_overrides` is read exactly once, inside the migration, to seed rows.

**Tech Stack:** Electron main (TypeScript strict), better-sqlite3, vitest (run via `npm test`, Electron-as-Node), React renderer (one guard only).

**Spec:** `docs/superpowers/specs/2026-09-20-portable-decisions-design.md` — slice 1, D1 and D2, AC1–AC6. Also read `docs/superpowers/specs/2026-09-20-field-overrides-design.md` (D1's reversal condition; D2/D3/D6 unchanged) and `docs/invariants/settings-and-editing.md`, `docs/invariants/nas-and-catalog.md`, `docs/data-contracts.md`.

## Departures from the spec — read before approving

1. **The migration is `007_owned_fields.sql`, not 006.** `006_shelves.sql` landed after the spec was written (spec line 5 says "migration 006, after `003`"). `MIGRATIONS` in `db.ts` has six entries today; this is the seventh.
2. **The spec is silent on how a release is ordered against a claim, because an absent entry has no timestamp.** Plan's rule (tombstone-free, Task 2): when the incoming record lacks a field this machine holds, keep this machine's claim only if it is **not older than the incoming record's `last_modified`** (the claim was made after the record we are adopting was written); otherwise the other machine released it. If the incoming record has no parseable `last_modified`, keep the claim (we cannot prove a release; dropping a decision is the worse error). A release therefore **bumps `last_modified`** and is **online-only**, like an edit (Task 5) — an offline release would be re-imposed by the next adoption.
3. **Two sites are persisted lazily, deliberately.** Seeded locks and reconcile wins reach `catalog.json` immediately (field-merge, as `preserveLocalReadingState` does) but reach a book's `metadata.json` on that book's next write. Invariant 1 says the catalog is never written from a path that has not written `metadata.json`; reading state already has this exception and this plan copies it. Flagged in Risks.
4. **File count is over the brief's ~10-file line** (Escalate section of `CLAUDE.md`): 8 source files, 1 SQL, 1 test helper, ~7 test files, 4 docs. The spec itself estimates "12+". The owner has seen this and asked for the plan; it still crosses `electron/main` ⇄ `src/types` ⇄ `src/components` (one guard line) — no sidecar change.

## Global Constraints

- `metadata.json` is canonical; `catalog.json` is derived (invariant 1). `owned_fields` is **additive and optional** in both files; an older reader ignores it; the writer never emits a malformed one.
- Business logic in `electron/main/services/`; IPC handlers stay thin wrappers (invariant 8).
- Failures stay non-fatal: an unreadable or corrupt `owned_fields` degrades to **no locks**, never throws (invariant 12).
- No `any`; shared types live in `src/types/` (`CLAUDE.md` → Code Style).
- `npm test` is the only way to run vitest (Electron-as-Node, native ABI). `npm run typecheck` covers main + renderer. Lint the files you changed with `npx eslint --no-warn-ignored <files>`: bare `npm run lint` fails in this checkout because `.delta/worktrees/` holds a second copy of the repo.
- Vocabulary of a claim is `HydratedField` (`src/types/metadata.types.ts`). Sort keys are never claimed (`HYDRATED_KEY_FIELD` has no entry for them).
- Prose in `.md` files is not hard-wrapped.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

Inputs the spec implies but no acceptance criterion exercises; each has a test in the named task.

1. A `metadata.json` / `catalog.json` entry whose `owned_fields` is a string, an array, `null`, or holds an unknown field name or non-string time → no locks for the bad parts, no throw (Task 2, Task 3).
2. An incoming record with **no `last_modified`** while this machine holds a claim → the claim is kept (Task 2).
3. A **claim made offline** on one machine, then adopted by the other, whose record is newer for an unrelated reason → the claim must not be silently dropped when its own timestamp is newer than the incoming `last_modified` (Task 2, Task 5).
4. Editing an already-held field again must **refresh its timestamp** (a fresh decision, orderable against a remote release) (Task 4).
5. A book deleted on one machine: its lock now dies with the row; nothing may be left behind in `app_config` or throw (Task 4, Task 5).

---

### Task 1: The column, the type, and the row round trip

**Files:**
- Create: `electron/main/schema/migrations/007_owned_fields.sql`
- Modify: `src/types/metadata.types.ts` (add `OwnedFields`), `src/types/book.types.ts` (`Book.ownedFields`), `electron/main/services/db.ts` (migrations list, `BookRow`, `rowToBook`, `insertBook`, new `setOwnedFields`), `test/helpers/book.ts`, `electron/main/services/importer.ts:291` and `electron/main/services/migration.ts:327` (the two `readingState: null` Book literals)
- Test: `electron/main/services/db.test.ts` (find the existing file; if none exists for these helpers, add the cases to the file that already tests `insertBook`/`updateBook` — `grep -ln "insertBook" electron/main/services/*.test.ts`)

**Interfaces:**
- Produces: `type OwnedFields = Partial<Record<HydratedField, string>>` in `@shared/metadata.types`; `Book.ownedFields: OwnedFields` (required); `db.setOwnedFields(id: string, owned: OwnedFields): void` (also bumps `last_modified`); `rowToBook` parses via `parseOwnedFields` from Task 2 — **so do Task 2 first if running tasks out of order; within this plan Task 1 stubs nothing: implement Task 2's `parseOwnedFields` as Task 1's Step 3** (the pure module has no dependencies and is the natural first file).

> Ordering note for the executor: do Task 2 Steps 1–4 (the pure module) **before** this task's Step 3, or just run the tasks as numbered 2 → 1. The numbering follows the spec's reading order, not the dependency order.

- [ ] **Step 1: Write the failing tests** (in the file that tests `db.insertBook`):

```ts
import { getBook, insertBook, setOwnedFields, replaceAllBooks } from './db'
import { makeBook } from '../../../test/helpers/book'

describe('owned_fields', () => {
  it('round-trips through insertBook and getBook', () => {
    insertBook({ ...makeBook('a'), ownedFields: { author: '2026-10-11T10:00:00.000Z' } })
    expect(getBook('a')?.ownedFields).toEqual({ author: '2026-10-11T10:00:00.000Z' })
  })

  it('reads a book that never had any as an empty map', () => {
    insertBook(makeBook('a'))
    expect(getBook('a')?.ownedFields).toEqual({})
  })

  it('setOwnedFields replaces the map and bumps last_modified', () => {
    insertBook({ ...makeBook('a'), lastModified: '2020-01-01T00:00:00.000Z' })
    setOwnedFields('a', { title: '2026-10-11T10:00:00.000Z' })
    const after = getBook('a')!
    expect(after.ownedFields).toEqual({ title: '2026-10-11T10:00:00.000Z' })
    expect(Date.parse(after.lastModified!)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'))
  })

  it('survives a wholesale replace, which is what adoption does', () => {
    replaceAllBooks([{ ...makeBook('a'), ownedFields: { tags: '2026-10-11T10:00:00.000Z' } }])
    expect(getBook('a')?.ownedFields).toEqual({ tags: '2026-10-11T10:00:00.000Z' })
  })

  it('reads a corrupt column as no locks instead of throwing', () => {
    insertBook(makeBook('a'))
    getDb().prepare('UPDATE books SET owned_fields = ? WHERE id = ?').run('{not json', 'a')
    expect(getBook('a')?.ownedFields).toEqual({})
  })
})
```

(Export `getDb` is already public. Use the same `beforeEach` that deletes `musaeum.db*` as `field-overrides.test.ts` does.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- electron/main/services/db.test.ts` (or the file you used)
Expected: FAIL — `setOwnedFields` is not exported / `ownedFields` is undefined.

- [ ] **Step 3: Implement**

`electron/main/schema/migrations/007_owned_fields.sql`:
```sql
-- The fields the user has claimed, as { field: ISO time } JSON, mirrored from
-- metadata.json so a second machine can honour them (portable-decisions D1/D2).
-- Not an FTS column, so the sync triggers are unaffected. NULL = no claims.
ALTER TABLE books ADD COLUMN owned_fields TEXT;
```

`src/types/metadata.types.ts` — beside `HydratedField`:
```ts
/** Fields the user has claimed, with the time of the claim. A fetch must not move them. */
export type OwnedFields = Partial<Record<HydratedField, string>>
```

`src/types/book.types.ts` — import the type (`import type { OwnedFields } from './metadata.types'`; a type-only cycle with `metadata.types` is fine) and add to `Book`, after `readingState`:
```ts
  /** { field: ISO time the user claimed it }. Travels in metadata.json (`owned_fields`). */
  ownedFields: OwnedFields
```

`db.ts`: add `import migration007 from '../schema/migrations/007_owned_fields.sql?raw'`, append `migration007` to `MIGRATIONS`; `owned_fields: string | null` on `BookRow`; in `rowToBook` after `readingState`: `ownedFields: parseOwnedFields(r.owned_fields)` (import from `./owned-fields`); in `insertBook` add `owned_fields` to the column list (now 30 columns / 30 `?`), and the last parameter `Object.keys(book.ownedFields).length ? JSON.stringify(book.ownedFields) : null`. Do **not** add it to `BOOK_COLUMN_MAP` (the generic `updateBook` path must not be able to write it). Add:
```ts
/**
 * Replace a book's claim map. Its own writer, like `setReadingState`, because
 * it is a nested value the generic column map cannot flatten — but unlike a
 * page turn, a change to what the user holds *is* a change to the record, so
 * it moves `last_modified`: that is the clock a reconcile compares a remote
 * release against (see `owned-fields.reconcileOwnedFields`).
 */
export function setOwnedFields(id: string, owned: OwnedFields): void {
  getDb()
    .prepare('UPDATE books SET owned_fields = ?, last_modified = ? WHERE id = ?')
    .run(
      Object.keys(owned).length ? JSON.stringify(owned) : null,
      new Date().toISOString(),
      id
    )
}
```
`test/helpers/book.ts`: add `ownedFields: {}` after `readingState: null`. `importer.ts:291` and `migration.ts:327`: add `ownedFields: {}` after `readingState: null`.

- [ ] **Step 4: Run to verify it passes, then fix every remaining Book literal**

Run: `npm run typecheck`
Expected: errors at every `Book` literal missing `ownedFields` (known: `catalog.ts` `metadataJsonToBook`, test files `shape.test.ts`, `catalog.test.ts`). Fix each by adding `ownedFields: {}`; `catalog.ts` is Task 3 — add `ownedFields: {}` there as a placeholder **only if** you are running this task before Task 3, and Task 3 replaces it. Then `npm test -- electron/main/services/db.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main/schema/migrations/007_owned_fields.sql src/types test electron/main
git commit -m "feat(schema): books.owned_fields — the claim map as a column on the row"
```

---

### Task 2: The pure module — validator and reconcile

**Files:**
- Create: `electron/main/services/owned-fields.ts`
- Test: `electron/main/services/owned-fields.test.ts`

**Interfaces:**
- Consumes: `OwnedFields`, `HydratedField`, `HYDRATED_FIELD_LABELS` from `@shared/metadata.types`.
- Produces: `parseOwnedFields(raw: unknown): OwnedFields`; `reconcileOwnedFields(local: OwnedFields, incoming: OwnedFields, incomingModifiedAt: string | null): OwnedFields`; `sameOwnedFields(a: OwnedFields, b: OwnedFields): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { parseOwnedFields, reconcileOwnedFields, sameOwnedFields } from './owned-fields'

const T1 = '2026-10-11T10:00:00.000Z'
const T2 = '2026-10-11T11:00:00.000Z'

describe('parseOwnedFields', () => {
  it('accepts a map of known fields to time strings', () => {
    expect(parseOwnedFields({ author: T1, tags: T2 })).toEqual({ author: T1, tags: T2 })
  })
  it('accepts the JSON text a column holds', () => {
    expect(parseOwnedFields(JSON.stringify({ author: T1 }))).toEqual({ author: T1 })
  })
  it.each([null, undefined, 7, 'not json', '[]', [], ['author'], true])(
    'reads %j as no locks',
    (bad) => expect(parseOwnedFields(bad)).toEqual({})
  )
  it('drops an unknown field and a non-string time, keeps the rest', () => {
    expect(parseOwnedFields({ author: T1, sort_title: T1, tags: 5, title: '' })).toEqual({
      author: T1
    })
  })
})

describe('reconcileOwnedFields', () => {
  it('takes a claim only the incoming record has', () => {
    expect(reconcileOwnedFields({}, { author: T1 }, T1)).toEqual({ author: T1 })
  })
  it('keeps the newer of two claims on the same field', () => {
    expect(reconcileOwnedFields({ author: T2 }, { author: T1 }, T2)).toEqual({ author: T2 })
    expect(reconcileOwnedFields({ author: T1 }, { author: T2 }, T2)).toEqual({ author: T2 })
  })
  it('keeps the incoming entry on a tie', () => {
    expect(reconcileOwnedFields({ author: T1 }, { author: T1 }, T1)).toEqual({ author: T1 })
  })
  it('lets an unparseable local time lose to the incoming one', () => {
    expect(reconcileOwnedFields({ author: 'garbage' }, { author: T1 }, T1)).toEqual({ author: T1 })
  })
  it('drops a local claim the incoming record released (record is newer than the claim)', () => {
    expect(reconcileOwnedFields({ author: T1 }, {}, T2)).toEqual({})
  })
  it('keeps a local claim made after the incoming record was written', () => {
    expect(reconcileOwnedFields({ author: T2 }, {}, T1)).toEqual({ author: T2 })
  })
  it('keeps a local claim when the incoming record has no modified time (Review Focus 2)', () => {
    expect(reconcileOwnedFields({ author: T1 }, {}, null)).toEqual({ author: T1 })
    expect(reconcileOwnedFields({ author: T1 }, {}, 'garbage')).toEqual({ author: T1 })
  })
  it('keeps a local claim whose time equals the record’s (an upgrade seeds exactly that)', () => {
    expect(reconcileOwnedFields({ author: T1 }, {}, T1)).toEqual({ author: T1 })
  })
})

describe('sameOwnedFields', () => {
  it('compares by content, not key order', () => {
    expect(sameOwnedFields({ author: T1, tags: T2 }, { tags: T2, author: T1 })).toBe(true)
    expect(sameOwnedFields({ author: T1 }, { author: T2 })).toBe(false)
    expect(sameOwnedFields({}, { author: T1 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- electron/main/services/owned-fields.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { HydratedField, OwnedFields } from '@shared/metadata.types'
import { HYDRATED_FIELD_LABELS } from '@shared/metadata.types'

/**
 * The claim map as the record carries it: `{ field: ISO time }`.
 *
 * Pure and dependency-free on purpose — `db.ts` (row ⇄ Book), `catalog.ts`
 * (both files on read) and `library-sync.ts` (adoption) all need the same
 * validator and the same ordering rule, and none of them may import another.
 */
const FIELD_NAMES = new Set<string>(Object.keys(HYDRATED_FIELD_LABELS))

/**
 * Anything → a clean map. Both files that carry it are written by us but read
 * off a share any machine can touch, and the column is JSON text, so every
 * input is `unknown`: a bad value is "no locks" (invariant 12), never a throw,
 * and a bad *member* is dropped without taking its neighbours with it.
 */
export function parseOwnedFields(raw: unknown): OwnedFields {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: OwnedFields = {}
  for (const [key, time] of Object.entries(value)) {
    if (FIELD_NAMES.has(key) && typeof time === 'string' && time !== '') {
      out[key as HydratedField] = time
    }
  }
  return out
}

/** Milliseconds, or `NaN` — every comparison below is written so NaN loses. */
function at(time: string | null | undefined): number {
  return time ? Date.parse(time) : Number.NaN
}

/**
 * Order two machines' opinions about one book, field by field (D2).
 *
 * - On both sides: the strictly newer claim wins; a tie, or a local time that
 *   does not parse, keeps the incoming entry — the same tie rule the reading
 *   reconcile uses, so the two cannot disagree about what "equal" means.
 * - Incoming only: take it. It is another machine's decision.
 * - Local only: an absent entry has no clock, so it is ordered against the
 *   incoming *record's* `last_modified`. A claim not older than that record was
 *   made after the record was written (or is what an upgrade seeded at exactly
 *   that time), so it stands; an older one means the record was rewritten
 *   without it — a release — and it goes. A record with no readable
 *   `last_modified` cannot prove a release, and dropping a decision is the
 *   worse error, so the claim stands.
 */
export function reconcileOwnedFields(
  local: OwnedFields,
  incoming: OwnedFields,
  incomingModifiedAt: string | null
): OwnedFields {
  const recordTime = at(incomingModifiedAt)
  const out: OwnedFields = {}
  const fields = new Set([...Object.keys(local), ...Object.keys(incoming)]) as Set<HydratedField>
  for (const field of fields) {
    const mine = local[field]
    const theirs = incoming[field]
    if (mine && theirs) {
      out[field] = at(mine) > at(theirs) ? mine : theirs
    } else if (theirs) {
      out[field] = theirs
    } else if (mine && !(at(mine) < recordTime)) {
      // `!(a < b)` rather than `a >= b`: NaN on either side must keep the claim
      out[field] = mine
    }
  }
  return out
}

export function sameOwnedFields(a: OwnedFields, b: OwnedFields): boolean {
  const keys = Object.keys(a) as HydratedField[]
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- electron/main/services/owned-fields.test.ts` → PASS. Then mutation-check: change `at(mine) > at(theirs)` to `>=` and confirm the tie test fails; change `!(at(mine) < recordTime)` to `at(mine) >= recordTime` and confirm the null/garbage-modified test fails. Revert both.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/owned-fields.ts electron/main/services/owned-fields.test.ts
git commit -m "feat(overrides): owned-fields validator and per-field reconcile (pure)"
```

---

### Task 3: The record — `metadata.json` and `catalog.json` carry it

**Files:**
- Modify: `electron/main/services/catalog.ts` (`MetadataJson`, `metadataJsonToBook`, `fromCatalogEntry`), `electron/main/services/importer.ts` (`writeMetadataJson`, ~line 604)
- Test: `electron/main/services/catalog.test.ts`, `electron/main/services/importer.test.ts`

**Interfaces:**
- Consumes: `parseOwnedFields` (Task 2), `Book.ownedFields` (Task 1).
- Produces: `metadata.json` key `owned_fields` (omitted when empty); both read paths yield a validated `Book.ownedFields`.

- [ ] **Step 1: Write the failing tests**

`catalog.test.ts` (use the file's existing helpers for building a `MetadataJson`/catalog on a temp dir):
```ts
it('reads owned_fields from metadata.json', async () => {
  const book = await metadataJsonToBook(
    { id: 'a', title: 'T', owned_fields: { author: '2026-10-11T10:00:00.000Z' } },
    'a',
    dir
  )
  expect(book.ownedFields).toEqual({ author: '2026-10-11T10:00:00.000Z' })
})

it.each([['a string', 'x'], ['an array', ['author']], ['null', null], ['a bad member', { author: 5, nope: 'x' }]])(
  'degrades a corrupt owned_fields (%s) to no locks (Review Focus 1)',
  async (_name, bad) => {
    const book = await metadataJsonToBook({ id: 'a', title: 'T', owned_fields: bad }, 'a', dir)
    expect(book.ownedFields).toEqual({})
  }
)

it('validates owned_fields on a catalog entry too', async () => {
  // write a catalog whose entry has ownedFields: 'garbage', then readCatalog
  await writeCatalog(root, [{ ...makeBook('a'), ownedFields: 'garbage' as never }])
  expect((await readCatalog(root))!.books[0].ownedFields).toEqual({})
})
```
`importer.test.ts` (next to the `writeMetadataJson` cases at the top):
```ts
it('writes owned_fields when the book has claims, and omits the key when it has none', async () => {
  await writeMetadataJson(bookDir, { ...makeBook('a'), ownedFields: { author: '2026-10-11T10:00:00.000Z' } })
  expect(JSON.parse(await fs.readFile(join(bookDir, 'metadata.json'), 'utf8')).owned_fields).toEqual({
    author: '2026-10-11T10:00:00.000Z'
  })
  await writeMetadataJson(bookDir, makeBook('a'))
  expect(JSON.parse(await fs.readFile(join(bookDir, 'metadata.json'), 'utf8'))).not.toHaveProperty('owned_fields')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- electron/main/services/catalog.test.ts electron/main/services/importer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`catalog.ts`: `import { parseOwnedFields } from './owned-fields'`. In `MetadataJson` add `owned_fields?: unknown`. In `metadataJsonToBook` replace any Task-1 placeholder with `ownedFields: parseOwnedFields(json.owned_fields)` after `readingState`. Change `fromCatalogEntry` to always validate:
```ts
function fromCatalogEntry(book: Book): Book {
  const normalized = withSortKeys(book)
  return {
    ...normalized,
    readingState: validateReadingState(normalized.readingState),
    ownedFields: parseOwnedFields(normalized.ownedFields)
  }
}
```
(keeps today's behaviour for reading state: `validateReadingState(null/undefined)` returns `null`; the old early return only skipped an allocation. Confirm `normalized.readingState == null` still yields `null`, not `undefined`, so existing catalog tests stay green.)

`importer.ts` `writeMetadataJson`, after `reading_state` and before `date_added`:
```ts
    ...(Object.keys(book.ownedFields).length ? { owned_fields: book.ownedFields } : {}),
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- electron/main/services/catalog.test.ts electron/main/services/importer.test.ts && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/catalog.ts electron/main/services/importer.ts electron/main/services/catalog.test.ts electron/main/services/importer.test.ts
git commit -m "feat(record): metadata.json and catalog.json carry owned_fields, validated on read"
```

---

### Task 4: `field-overrides` moves onto the row; the upgrade seeds it once

**Files:**
- Modify: `electron/main/services/field-overrides.ts`, `electron/main/services/db.ts` (`runMigrations` + a seed helper), `electron/main/services/book-delete.ts` (drop the `forget` call, line ~22)
- Test: `electron/main/services/field-overrides.test.ts` (rewrite the three describe blocks noted), `electron/main/services/book-delete.test.ts` (drop the `forget` assertion), `electron/main/services/importer.test.ts` (AC3)

**Interfaces:**
- Consumes: `db.getBook`, `db.setOwnedFields` (Task 1), `parseOwnedFields` (Task 2).
- Produces (public API unchanged): `list(bookId): HydratedField[]`; `markFromPatch(bookId, patch, before, now?: string): HydratedField[]`; `release(bookId, field): HydratedField[]`. **Removed:** `forget`. `markFromPatch` now stamps **every** marked field with `now` (default `new Date().toISOString()`), including a field already held (Review Focus 4).

- [ ] **Step 1: Write the failing tests**

Replace in `field-overrides.test.ts`: keep `locks the fields a patch changed`, `folds a series…`, `does not lock a derived sort key`, `survives the database closing and reopening`, `release` cases as they are (they use the public API). **Delete** the whole `forget` describe and the `drops an entry whose book is gone` case. **Rewrite** `an unreadable map` to corrupt the column:
```ts
describe('an unreadable claim map', () => {
  it('reads as no overrides rather than throwing', () => {
    insertBook(makeBook('a'))
    getDb().prepare('UPDATE books SET owned_fields = ? WHERE id = ?').run('{nope', 'a')
    expect(list('a')).toEqual([])
  })
})
```
**Add:**
```ts
it('stamps each claim with the time it was made', () => {
  const before = makeBook('a')
  insertBook(before)
  markFromPatch('a', { author: 'Eve' }, before, '2026-10-11T10:00:00.000Z')
  expect(getBook('a')!.ownedFields).toEqual({ author: '2026-10-11T10:00:00.000Z' })
})

it('refreshes the time when a held field is edited again (Review Focus 4)', () => {
  const before = makeBook('a')
  insertBook(before)
  markFromPatch('a', { author: 'Eve' }, before, '2026-10-11T10:00:00.000Z')
  markFromPatch('a', { author: 'Ada' }, { ...before, author: 'Eve' }, '2026-10-11T12:00:00.000Z')
  expect(getBook('a')!.ownedFields).toEqual({ author: '2026-10-11T12:00:00.000Z' })
})

it('release removes the entry and bumps last_modified, leaving the value', () => {
  const before = { ...makeBook('a'), lastModified: '2020-01-01T00:00:00.000Z' }
  insertBook(before)
  markFromPatch('a', { author: 'Eve' }, before, '2026-10-11T10:00:00.000Z')
  updateBook('a', { author: 'Eve' })
  release('a', 'author')
  const after = getBook('a')!
  expect(after.ownedFields).toEqual({})
  expect(after.author).toBe('Eve')
  expect(Date.parse(after.lastModified!)).toBeGreaterThan(Date.parse('2026-10-11T10:00:00.000Z'))
})

it('a claim for a book that is not in the cache is a no-op, not an error', () => {
  expect(markFromPatch('ghost', { title: 'x' }, null)).toEqual([])
})
```
**AC6 — the seed** (new `describe('the upgrade seed')`; needs a DB at user_version 6 with a populated `field_overrides` config, then reopen). Build it by opening a raw `better-sqlite3` file at the userData path, applying migrations 001–006 by `exec`-ing the `?raw` SQL (import each as `?raw` in the test), setting `PRAGMA user_version = 6`, inserting two books and `app_config('field_overrides', '{"a":["author","title"],"ghost":["tags"],"b":["nope"]}')`, closing it, then calling `getDb()` (which runs migration 007):
```ts
it('turns a pre-upgrade map into records on the books it can resolve (AC6)', () => {
  /* …build the v6 database as described… */
  expect(getBook('a')!.ownedFields).toEqual({
    author: '<a.last_modified>',
    title: '<a.last_modified>'
  }) // each seeded at the book's own last_modified, so a reconcile treats it as "not older than the record"
  expect(getBook('b')!.ownedFields).toEqual({})        // unknown field name dropped
  // 'ghost' has no row: nothing created, nothing thrown
  expect(getConfig('field_overrides')).not.toBeNull()  // read once, never rewritten, never deleted
})
```
`importer.test.ts` — **AC3**, in the existing hydrate describe, a case that a lock arriving **through the record** keeps a fetch off the field: insert a book with `ownedFields: { author: T }` (not via `setConfig`), script `sidecar.call('hydrate_metadata')` to reply with a different author, run `hydrate`, assert the book's author is unchanged **and** that the RPC was called with `locked_fields: ['author']`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- electron/main/services/field-overrides.test.ts electron/main/services/importer.test.ts`
Expected: FAIL (storage still in `app_config`).

- [ ] **Step 3: Implement**

`field-overrides.ts` — delete `CONFIG_KEY`, `FIELD_NAMES`, `read`, `write`, `pruneDead` and `forget`, rewrite the header comment's "Machine-local by design" paragraph to say the map is the book's own record (D1 of the portable-decisions design), and:
```ts
export function list(bookId: string): HydratedField[] {
  return Object.keys(db.getBook(bookId)?.ownedFields ?? {}) as HydratedField[]
}

export function markFromPatch(
  bookId: string,
  patch: Partial<Book>,
  before: Book | null,
  now: string = new Date().toISOString()
): HydratedField[] {
  const book = db.getBook(bookId)
  if (!book) return []
  const marked = new Set<HydratedField>()
  for (const [key, value] of Object.entries(patch) as [keyof Book, unknown][]) {
    const field = HYDRATED_KEY_FIELD[key]
    if (!field) continue
    if (before && sameBookValue(before[key], value)) continue
    marked.add(field)
  }
  if (!marked.size) return Object.keys(book.ownedFields) as HydratedField[]
  // A fresh decision about a field already held is still a decision: it takes
  // the new time, which is what orders it against another machine's release.
  const next: OwnedFields = { ...book.ownedFields }
  for (const field of marked) next[field] = now
  db.setOwnedFields(bookId, next)
  return Object.keys(next) as HydratedField[]
}

export function release(bookId: string, field: HydratedField): HydratedField[] {
  const book = db.getBook(bookId)
  if (!book || !(field in book.ownedFields)) return list(bookId)
  const next: OwnedFields = { ...book.ownedFields }
  delete next[field]
  db.setOwnedFields(bookId, next)
  return Object.keys(next) as HydratedField[]
}
```
(Import `OwnedFields` from `@shared/metadata.types`; remove the unused `parseOwnedFields`/config imports. `release` of a field that is not held must NOT bump `last_modified` — the early return above guarantees it.)

`db.ts` — change `runMigrations` so the seed runs inside the same transaction as migration 007:
```ts
/** Index in MIGRATIONS of `007_owned_fields.sql`. */
const OWNED_FIELDS_MIGRATION = 6

function runMigrations(d: Database.Database): void {
  const current = d.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    d.transaction(() => {
      d.exec(MIGRATIONS[v])
      if (v === OWNED_FIELDS_MIGRATION) seedOwnedFieldsFromConfig(d)
      d.pragma(`user_version = ${v + 1}`)
    })()
  }
}

/**
 * One-time carry of `app_config.field_overrides` (the pre-007 home of the
 * claims, an array of fields per book id) onto the rows it can still resolve.
 * A claim has no recorded time in the old store, so each is seeded at the
 * book's own `last_modified` — which `reconcileOwnedFields` reads as "not older
 * than the record", so the upgrade's own claims survive the first adoption. The
 * config key is left in place and never read again: leaving it is the rollback
 * path, deleting it would be the irreversible one. Never throws — an unreadable
 * map seeds nothing (invariant 12), and the migration still completes.
 */
function seedOwnedFieldsFromConfig(d: Database.Database): void {
  try {
    const row = d.prepare("SELECT value FROM app_config WHERE key = 'field_overrides'").get() as
      { value: string } | undefined
    if (!row) return
    const map: unknown = JSON.parse(row.value)
    if (!map || typeof map !== 'object' || Array.isArray(map)) return
    const find = d.prepare('SELECT last_modified FROM books WHERE id = ?')
    const write = d.prepare('UPDATE books SET owned_fields = ? WHERE id = ?')
    for (const [bookId, fields] of Object.entries(map)) {
      const book = find.get(bookId) as { last_modified: string | null } | undefined
      if (!book || !Array.isArray(fields)) continue
      const at = book.last_modified ?? new Date().toISOString()
      const owned = parseOwnedFields(Object.fromEntries(fields.map((f: unknown) => [f, at])))
      if (Object.keys(owned).length) write.run(JSON.stringify(owned), bookId)
    }
  } catch (err) {
    console.error('[migration 007] could not carry field_overrides, seeding nothing:', err)
  }
}
```
`book-delete.ts`: remove the `fieldOverrides.forget(id)` line and its import if unused; fix `book-delete.test.ts` accordingly (the lock now dies with the row — assert `getBook` is gone, nothing else).

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- electron/main/services/field-overrides.test.ts electron/main/services/importer.test.ts electron/main/services/book-delete.test.ts conflicts cover-choice library-edit` then `npm run typecheck`
Expected: PASS. Mutation-check: seed with `write.run` removed → AC6 case fails; `markFromPatch` stamping only newly-held fields → the refresh case fails. Revert both.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services
git commit -m "feat(overrides): the claim map moves onto the book row; the upgrade seeds it once"
```

---

### Task 5: Adoption honours the other machine's claims; release reaches the record

**Files:**
- Modify: `electron/main/services/library-sync.ts` (`adopt`, new `preserveLocalOwnedFields`), `electron/main/services/library-edit.ts` (new `releaseFieldOverride`), `electron/main/ipc/library.ts` (the `library:releaseFieldOverride` handler), `src/components/library/BookEditor.tsx` (`releaseOverride` guard)
- Test: `electron/main/services/library-sync.test.ts`, `electron/main/services/library-edit.test.ts`, `src/lib/book-form.test.ts` is unaffected — the editor guard is covered by the source walk below

**Interfaces:**
- Consumes: `reconcileOwnedFields`, `sameOwnedFields` (Task 2); `fieldOverrides.release` (Task 4); `importer.writeMetadataJson`, `librarySync.upsertCatalog`.
- Produces: `libraryEdit.releaseFieldOverride(id: string, field: HydratedField): Promise<HydratedField[]>` (asserts online; writes `metadata.json` + catalog; broadcasts `libraryChanged`).

- [ ] **Step 1: Write the failing tests**

`library-sync.test.ts` — follow the file's existing pattern for exercising `adopt` through `applyCatalog`/`syncOnConnect` against a temp library with a written catalog. Cases (the catalog on disk is "the other machine's"; the local DB is "this machine's"):
```ts
it('a claim the other machine made becomes a held field here (AC4, service half)', async () => {
  insertBook(makeBook('a'))                                  // local: no claims
  await writeCatalog(root, [{ ...makeBook('a'), ownedFields: { author: '2026-10-11T10:00:00.000Z' } }])
  await applyCatalog(root)
  expect(getBook('a')!.ownedFields).toEqual({ author: '2026-10-11T10:00:00.000Z' })
})

it('a release on the other machine drops the claim here and leaves the value (AC5, service half)', async () => {
  insertBook({ ...makeBook('a'), author: 'Eve', ownedFields: { author: '2026-10-11T10:00:00.000Z' } })
  await writeCatalog(root, [{ ...makeBook('a'), author: 'Eve', lastModified: '2026-10-11T12:00:00.000Z', ownedFields: {} }])
  await applyCatalog(root)
  const b = getBook('a')!
  expect(b.ownedFields).toEqual({})
  expect(b.author).toBe('Eve')
})

it('a claim made here after the catalog was written survives adoption (Review Focus 3)', async () => {
  insertBook({ ...makeBook('a'), ownedFields: { author: '2026-10-11T12:00:00.000Z' } })
  await writeCatalog(root, [{ ...makeBook('a'), lastModified: '2026-10-11T10:00:00.000Z', ownedFields: {} }])
  await applyCatalog(root)
  expect(getBook('a')!.ownedFields).toEqual({ author: '2026-10-11T12:00:00.000Z' })
})

it('pushes a surviving local claim back to catalog.json', async () => {
  /* same setup as above; after await librarySync.flushForTests(),
     expect((await readCatalog(root))!.books[0].ownedFields).toEqual({ author: '2026-10-11T12:00:00.000Z' }) */
})

it('adoption of a book deleted elsewhere leaves nothing behind and does not throw (Review Focus 5)', async () => {
  insertBook({ ...makeBook('gone'), ownedFields: { title: '2026-10-11T10:00:00.000Z' } })
  await writeCatalog(root, [])
  await expect(applyCatalog(root)).resolves.toBe(0)
  expect(getBook('gone')).toBeNull()
})
```
`library-edit.test.ts`:
```ts
it('releaseFieldOverride drops the claim from the row, the record and the catalog', async () => {
  /* online scratch library as the file's other cases build; book with ownedFields {author: T};
     await releaseFieldOverride('a', 'author');
     expect(getBook('a')!.ownedFields).toEqual({});
     expect(JSON.parse(readFileSync(join(bookDir,'metadata.json'),'utf8'))).not.toHaveProperty('owned_fields');
     await librarySync.flushForTests();
     expect((await readCatalog(root))!.books.find(b=>b.id==='a')!.ownedFields).toEqual({}) */
})
it('releaseFieldOverride refuses offline, so a release is never re-imposed by the next adoption', async () => {
  /* nas offline: await expect(releaseFieldOverride('a','author')).rejects.toThrow() ; claim still on the row */
})
```
Source walk (same style as `book-form.test.ts`, add to a renderer test): `BookEditor.tsx`'s `releaseOverride` must contain `!online`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- electron/main/services/library-sync.test.ts electron/main/services/library-edit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`library-sync.ts` — beside `preserveLocalReadingState`:
```ts
/**
 * Reconcile each incoming book's claim map against this machine's before a
 * wholesale replace — the second reconcile `adopt` runs, for the same reason as
 * the first: the replace would otherwise let whichever machine wrote last
 * silently delete the other's decisions. Ordered field by field
 * (`owned-fields.reconcileOwnedFields`). A book whose result differs from the
 * catalog's own entry is pushed back in one batched field-merge, like the
 * reading-state wins are. (`metadata.json` catches up on that book's next write —
 * recorded as a known residual in the portable-decisions plan.)
 */
function preserveLocalOwnedFields(incoming: Book[]): Book[] {
  const localById = new Map(db.getBooks().map((b) => [b.id, b]))
  const changed: Book[] = []
  const merged = incoming.map((book) => {
    const local = localById.get(book.id)
    if (!local || !Object.keys(local.ownedFields).length) return book
    const ownedFields = reconcileOwnedFields(local.ownedFields, book.ownedFields, book.lastModified)
    if (sameOwnedFields(ownedFields, book.ownedFields)) return book
    const withClaims: Book = { ...book, ownedFields }
    changed.push(withClaims)
    return withClaims
  })
  if (changed.length > 0) updateCatalogFields(changed, ['ownedFields'])
  return merged
}
```
and `adopt`: `db.replaceAllBooks(preserveLocalOwnedFields(preserveLocalReadingState(books)))`. Note the early return when local has no claims: a local-less book takes the incoming map as is (that is the "other machine's claim becomes held here" case, handled by the replace itself).
Check `catalog.mergeBookFields` copies an arbitrary `keyof Book` key — read it; if it special-cases fields, add `ownedFields`.

`library-edit.ts`:
```ts
/**
 * Release a held field: the value stays, a fetch may propose it again. A
 * release is a change to the book's record, so it is written where an edit is —
 * to `metadata.json` and the catalog — and, like an edit, it needs the library
 * online: an offline release would be re-imposed by the next adoption, which
 * would read the other machine's still-held claim as newer news.
 */
export async function releaseFieldOverride(id: string, field: HydratedField): Promise<HydratedField[]> {
  nas.assertOnline()
  const remaining = fieldOverrides.release(id, field)
  const book = db.getBook(id)
  if (book?.nasPath) {
    await importer.writeMetadataJson(join(nas.getLibraryRoot()!, book.nasPath), book)
    librarySync.upsertCatalog([book])
  }
  broadcast('libraryChanged')
  return remaining
}
```
(import `HydratedField` type.) `ipc/library.ts`: the handler becomes `handle('library:releaseFieldOverride', (id, field) => libraryEdit.releaseFieldOverride(id, field))` (import `* as libraryEdit` if the file does not already — it likely does for `updateBook`; reuse that import).
`BookEditor.tsx` `releaseOverride`: first line `if (!book || !online) return` (today `if (!book) return`).

- [ ] **Step 4: Run to verify they pass**

Run: `npm test` (the whole suite — this task touches adoption, which many suites exercise) and `npm run typecheck`
Expected: PASS. Mutation-check: replace `reconcileOwnedFields(...)` in `preserveLocalOwnedFields` with `book.ownedFields` → the "survives adoption" case fails; remove `nas.assertOnline()` from `releaseFieldOverride` → the offline case fails. Revert.

- [ ] **Step 5: Commit**

```bash
git add electron src
git commit -m "feat(sync): adoption orders the other machine's claims; a release reaches the record"
```

---

### Task 6: The contract, the records, and the two-profile instrument (AC1, AC4, AC5)

**Files:**
- Modify: `docs/data-contracts.md` (the `metadata.json` example and a field note), `docs/invariants/settings-and-editing.md` (the lock paragraph at ~line 75: the map is now the record), `docs/superpowers/specs/2026-09-20-field-overrides-design.md` (D1: one-line pointer "superseded by portable-decisions D1, built <date>"), `docs/superpowers/specs/2026-09-20-portable-decisions-design.md` (status line + a *Built — slice 1* section recording the departures and the measured numbers), `tasks.md`, `CHANGELOG.md`
- Create (outside the repo, in the session scratchpad): the two-profile probe script

- [ ] **Step 1: AC1 — the migration on a copy of the live database**

Run (read-only against the live DB, then a scratch copy):
```bash
LIVE="$HOME/Library/Application Support/Musaeum/musaeum.db"
S=$(mktemp -d)
sqlite3 "$LIVE" ".backup '$S/copy.db'"
sqlite3 "$S/copy.db" "SELECT COUNT(*) FROM books; PRAGMA user_version;"          # note both numbers
sqlite3 "$S/copy.db" < electron/main/schema/migrations/007_owned_fields.sql
sqlite3 "$S/copy.db" "SELECT COUNT(*) FROM books; SELECT COUNT(*) FROM books WHERE owned_fields IS NOT NULL; SELECT owned_fields FROM books LIMIT 1;"
```
Expected: row count identical before and after; `0` rows with a non-NULL `owned_fields`; the final `SELECT` succeeds (it failed before). Record the numbers in the spec's *Built* section. **Never open the live DB for write.**

- [ ] **Step 2: Docs.** `data-contracts.md`: add `"owned_fields": { "author": "2025-01-16T22:04:11Z" }` to the example, and a paragraph: optional map of claimed `HydratedField` → ISO time; absent = none; a fetch never overwrites a claimed field; an older reader ignores it; the newer claim wins per field and an absent entry is ordered against `last_modified` (cite `owned-fields.ts`). `settings-and-editing.md`: replace "one JSON map in `app_config` under `field_overrides`, keyed by book id" with the record/column description and keep the `editsSince` sentence. Update the spec status line to *Slice 1 built <date>*.

- [ ] **Step 3: AC4 and AC5 — the two-profile probe (live, isolated; this instrument does not exist yet)**

Reuse `cdp.py` from the 2026-10-11 editor probe (`/private/tmp/claude-501/-Users-oh-Projects-musaeum-macos/c62ce302-d284-4afe-8f1d-fd0db757b062/scratchpad/cdp.py`; it takes a port via `target()` — parameterise `http://127.0.0.1:{port}/json`). Procedure, following the `verify` skill's launch recipe (`env -u ELECTRON_RUN_AS_NODE MUSAEUM_USER_DATA=… npm run dev -- -- --remote-debugging-port=PORT`, and **check the listening pid's start time against your launch** before trusting a port):
1. One scratch library `$S/library`; profile `$S/A` (port 9222) and profile `$S/B` (port 9223), each with `app_config.library_root` set to `$S/library` (create each DB by a first launch, kill, set the config row, relaunch — the app creates the schema).
2. In A: drop one EPUB into `$S/library/imports/`; wait until it is a book; confirm `catalog.json` lists it.
3. B: click *Reload Library* (adoption). Confirm B has the book and `SELECT owned_fields FROM books` is NULL.
4. A: select the book, open the editor, change only the author, save (the editor probe's DOM recipe). Confirm A's `owned_fields` holds exactly `author`, and `metadata.json` and `catalog.json` carry it.
5. B: *Reload Library*. **AC4:** B's `owned_fields` holds `author` with A's timestamp; `window.Musaeum.library.getFieldOverrides(id)` over CDP on port 9223 returns `["author"]`; open B's editor and confirm the padlock chip shows. (B's *own re-fetch* cannot run — no sidecar venv in this checkout — so "B's fetch does not move it" is carried by Task 4's importer case, which is the same enforcement site; say so in the record.)
6. B: `window.Musaeum.library.releaseFieldOverride(id, 'author')` over CDP. A: *Reload Library*. **AC5:** A's `owned_fields` is empty and A's author value is unchanged.
7. Kill both apps, verify ports 9222/9223 are free, and record the observed values in the spec's *Built* section.

- [ ] **Step 4: Full gate**

Run: `npm run typecheck && npx eslint --no-warn-ignored $(git diff --name-only main -- '*.ts' '*.tsx') && npx prettier --check $(git diff --name-only main -- '*.ts' '*.tsx' '*.md') && npm test`
Expected: all green. Compare the test count against the pre-slice baseline (1950 passed | 4 skipped on 2026-10-11).

- [ ] **Step 5: Commit**

```bash
git add docs tasks.md CHANGELOG.md
git commit -m "docs: portable decisions slice 1 — the claim travels, in the contract and the record"
```

---

## Risks

1. **Lazy `metadata.json` (departure 3).** A seeded lock or a reconcile win is in SQLite and `catalog.json` at once, but a book's `metadata.json` only gains it on that book's next write. If the catalog were deleted and rebuilt from folders before that write, the claim would be lost. Bounded: a handful of books, any edit/hydrate/reading flush closes it. The alternative (write every seeded book's `metadata.json` during adoption) puts a per-book SMB write inside `adopt`; declined for slice 1.
2. **The absent-entry rule is a judgement the spec did not make** (departure 2). It is stated once, in `owned-fields.ts`, and tested at the tie boundary, the null boundary and both orderings; if the owner wants tombstones instead, that is a record-shape change and a new decision.
3. **Clock skew** behaves as the spec says (D2 risk 4): a fast clock wins ties it should not, bounded to one field of one book.
4. **A required `Book.ownedFields`** touches every `Book` literal. Typecheck finds each; the cost is paid once and prevents a path that forgets the field (the invariant-4 shape of bug).
5. **`app_config.field_overrides` is left in place.** It is dead after 007 and is the rollback path; a later cleanup may delete it.

## Self-review

- **Spec coverage:** D1 (record + column + seed + dead config) → Tasks 1, 3, 4. D2 (timestamped map, newer wins, release beats older claim, tie keeps incoming) → Tasks 2, 5. AC1 → Task 6 Step 1. AC2 (round-trips, corrupt degrades) → Tasks 1–3. AC3 → Task 4. AC4/AC5 → Task 5 service half + Task 6 Step 3 live half. AC6 → Task 4. Slices 2 and 3, D3–D7: out of scope by design.
- **Placeholders:** the `/* … */` blocks in Task 4's seed test and Task 5's catalog/edit cases describe setup the executor builds from the file's existing helpers; each states the exact assertions. No TBDs.
- **Types:** `OwnedFields`, `parseOwnedFields`, `reconcileOwnedFields(local, incoming, incomingModifiedAt)`, `sameOwnedFields`, `db.setOwnedFields(id, owned)`, `markFromPatch(bookId, patch, before, now?)`, `release(bookId, field)`, `libraryEdit.releaseFieldOverride(id, field)` are spelled identically in every task that names them.
- **Ordering:** Task 2 is the dependency root (db.ts imports it); Task 1's note says so. Run 2 → 1 → 3 → 4 → 5 → 6.
