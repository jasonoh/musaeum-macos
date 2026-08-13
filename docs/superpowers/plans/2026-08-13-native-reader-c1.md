# Native Reader C1 (EPUB/MOBI/AZW3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read EPUB, MOBI, and AZW3 books inside Musaeum, with reading position that survives a restart and follows the user to another machine.

**Architecture:** A full-window `ReaderView` overlay in the existing renderer window drives a vendored foliate-js engine. Book bytes reach it over a new `musaeum://book/{bookId}/{format}` protocol route — the renderer never touches `file://`. All persistence policy lives in one main-process service, `services/reading-state.ts`, which writes SQLite on every report, `metadata.json` on a throttle, and `catalog.json` only at session boundaries.

**Tech Stack:** Electron 37, React 18, TypeScript (strict), Zustand, better-sqlite3, Tailwind, vitest (run through Electron-as-Node), vendored foliate-js (ES modules, no build step).

**Spec:** `docs/superpowers/specs/2026-08-13-native-reader-design.md`

## Global Constraints

- **Never `npm install foliate-js`.** The registry package is a stale third-party republish. Vendor from `https://github.com/johnfactotum/foliate-js` and record the commit hash.
- **No `any` types.** TypeScript strict mode; interfaces go in `src/types/`.
- **All business logic in `electron/main/services/`** — IPC handlers in `electron/main/ipc/` are thin wrappers registered through `ipc/handle.ts`.
- **Never call NAS/file operations directly from the renderer** — always via IPC.
- **Icons** are hand-rolled inline SVG in `src/components/shared/icons.tsx`. No icon library.
- **Run `npm test` only via that script** — it sets `ELECTRON_RUN_AS_NODE=1` so the better-sqlite3 native ABI matches. Never invoke `vitest` directly.
- **`npm run typecheck && npm run lint` must stay clean.** Both pass on `main` today.
- Tests live beside the code they cover (`electron/main/services/*.test.ts`), using `test/helpers/book.ts`'s `makeBook` and the `electron` mock aliased in `vitest.config.ts`.
- Book files are always resolved **by extension**, never by canonical filename — a book renamed after import must still open.
- Commit after every task.

---

### Task 1: Vendor foliate-js and wire it into the build

**Files:**
- Create: `vendor/foliate-js/**` (upstream source copy)
- Create: `vendor/foliate-js/VENDORED.md`
- Create: `src/types/foliate-js.d.ts`
- Modify: `electron.vite.config.ts` (renderer alias)
- Modify: `eslint.config.mjs` (ignore vendored source)
- Modify: `index.html` (CSP)
- Modify: `package.json` (only if zip.js/fflate turn out to be needed)

**Interfaces:**
- Consumes: nothing.
- Produces: the module specifier `@vendor/foliate-js/view.js`, which registers the `<foliate-view>` custom element. Task 8 imports it.

- [ ] **Step 1: Clone upstream to a scratch directory and record the commit**

```bash
git clone --depth 1 https://github.com/johnfactotum/foliate-js \
  /tmp/foliate-js
git -C /tmp/foliate-js rev-parse HEAD   # record this hash for VENDORED.md
git -C /tmp/foliate-js log -1 --date=short --format=%cd
```

- [ ] **Step 2: Copy the source in, excluding git metadata and demo files**

```bash
mkdir -p vendor/foliate-js
rsync -a --exclude '.git' --exclude 'reader.html' --exclude 'demo' \
  /tmp/foliate-js/ vendor/foliate-js/
ls vendor/foliate-js
```

Expected: `view.js`, `epub.js`, `mobi.js`, `paginator.js`, `fixed-layout.js`, `epubcfi.js`, `LICENSE` among the files listed.

- [ ] **Step 3: Determine how zip.js and fflate are reached**

```bash
grep -rn "zip.js\|fflate" vendor/foliate-js/*.js | grep -i "import\|from" | head
```

If the imports are relative paths into `vendor/foliate-js/vendor/`, nothing more is needed — they came with the copy. If they are bare specifiers (`@zip.js/zip.js`, `fflate`), install them:

```bash
npm install @zip.js/zip.js fflate
```

Record which case applied in `VENDORED.md` — the spec left this open deliberately.

- [ ] **Step 4: Write the provenance record**

Create `vendor/foliate-js/VENDORED.md`:

```markdown
# foliate-js (vendored)

- **Upstream:** https://github.com/johnfactotum/foliate-js
- **Commit:** <hash from Step 1>
- **Vendored:** 2026-08-13
- **License:** MIT (see LICENSE in this directory)

## Do not install this from npm

Upstream states the library is not released on npm. The `foliate-js`
package on the registry is a single-version republish by an unrelated
maintainer, a year stale. Vendoring is upstream's own recommendation.

A committed copy was chosen over a git submodule so that a fresh clone
needs no `--recurse-submodules`, and so the exact reading engine is pinned
in our history. Updating means re-copying from the commit above.

## Dependencies

<one line: bundled with the copy, or installed as npm deps — see Step 3>

## Local modifications

None. Keep it that way — any change here makes the next update a merge.
```

- [ ] **Step 5: Add the renderer alias**

In `electron.vite.config.ts`, add to the `renderer.resolve.alias` object (alongside `'@'` and `'@shared'`):

```ts
'@vendor': resolve(__dirname, 'vendor')
```

- [ ] **Step 6: Declare the module for TypeScript**

Create `src/types/foliate-js.d.ts`. The vendored source is plain JS and must not be typechecked, so it is declared rather than inferred:

```ts
/**
 * Ambient declarations for the vendored foliate-js engine
 * (`vendor/foliate-js`, see its VENDORED.md). The upstream source is plain
 * ES modules with no types; declaring the slice we use keeps `any` out of
 * the reader without typechecking someone else's code.
 */
declare module '@vendor/foliate-js/view.js' {
  export interface FoliateTocItem {
    label: string
    href: string
    subitems?: FoliateTocItem[]
  }

  export interface FoliateRelocateDetail {
    fraction: number
    cfi?: string
    tocItem?: { label: string } | null
  }

  export interface FoliateBook {
    toc?: FoliateTocItem[]
  }

  export interface FoliateRenderer {
    setStyles(css: string): void
  }

  export class FoliateView extends HTMLElement {
    book: FoliateBook
    renderer: FoliateRenderer
    open(file: Blob | File): Promise<void>
    goTo(target: string): Promise<void>
    goToFraction(fraction: number): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    close(): void
  }
}
```

**These names must match the vendored source, which is now in the repo and is authoritative.** Before moving on, confirm each against `vendor/foliate-js/view.js` (`grep -n "^\s*\(async \)\?\(open\|goTo\|goToFraction\|next\|prev\|close\)\s*(" vendor/foliate-js/view.js` and `grep -n "relocate" vendor/foliate-js/view.js`). If a name or event-detail field differs, fix this declaration to match upstream — do not modify the vendored file.

- [ ] **Step 7: Exclude the vendored source from linting**

In `eslint.config.mjs`, add `'vendor/**'` to the `ignores` array of the global ignore entry.

- [ ] **Step 8: Widen the CSP**

In `index.html`, replace the CSP content attribute with:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' musaeum: data: blob:; font-src 'self' data: blob:; frame-src blob:; connect-src 'self' ws: musaeum:
```

`script-src` stays `'self'` — book content is never executed. `connect-src` gains `musaeum:` for the Task 6 fetch; the `blob:` entries cover resources foliate-js materializes out of the container.

- [ ] **Step 9: Prove it bundles**

Create a temporary file `src/reader-import-check.ts`:

```ts
import '@vendor/foliate-js/view.js'
```

Import it from `src/main.tsx` (temporarily, as the last import), then run:

```bash
npm run build && npm run typecheck && npm run lint
```

Expected: all three succeed. This proves alias resolution, TypeScript declaration, lint config, and rollup bundling of the vendored ESM.

- [ ] **Step 10: Remove the temporary check**

```bash
rm src/reader-import-check.ts
```

Remove the import line from `src/main.tsx`, then re-run `npm run build && npm run typecheck && npm run lint` to confirm still-clean.

- [ ] **Step 11: Commit**

```bash
git add vendor/foliate-js src/types/foliate-js.d.ts electron.vite.config.ts \
  eslint.config.mjs index.html package.json package-lock.json
git commit -m "chore: vendor foliate-js and widen CSP for the reader"
```

---

### Task 2: ReadingState type, migration 003, and db plumbing

**Files:**
- Modify: `src/types/book.types.ts`
- Create: `electron/main/schema/migrations/003_reading_state.sql`
- Modify: `electron/main/services/db.ts` (`MIGRATIONS`, `BookRow`, `rowToBook`, `insertBook`, new `setReadingState`)
- Modify: `test/helpers/book.ts`
- Test: `electron/main/services/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ReadingState { position: string | null; percent: number; updatedAt: string }` from `@shared/book.types`
  - `Book.readingState: ReadingState | null`
  - `db.setReadingState(bookId: string, state: ReadingState): void`

- [ ] **Step 1: Add the shared type**

In `src/types/book.types.ts`, after the `ReadStatus` type:

```ts
/**
 * Where the reader left off. `position` is opaque to Musaeum — an EPUB CFI,
 * whatever mobi.js yields for KF8, a page number for PDF — because three
 * engines have to share one schema and none of them agree on a format.
 * `percent` is the portable fallback: when a position no longer resolves,
 * the reader seeks to the fraction instead.
 */
export interface ReadingState {
  position: string | null
  percent: number
  updatedAt: string
}

/**
 * What the reader reports as the user moves through a book. `final` marks a
 * session boundary (reader closed, app quitting) — see reading-state.ts for
 * what that costs. Shared because the renderer sends it and the main process
 * consumes it.
 */
export interface ProgressReport {
  bookId: string
  position: string | null
  percent: number
  final: boolean
}
```

Add to the `Book` interface, after `readStatus`:

```ts
  readingState: ReadingState | null
```

- [ ] **Step 2: Write the migration**

Create `electron/main/schema/migrations/003_reading_state.sql`:

```sql
-- Reading position, mirrored from metadata.json so library views can show
-- progress without reading thousands of files. Not FTS columns, so the
-- existing sync triggers are unaffected.
ALTER TABLE books ADD COLUMN reading_position TEXT;
ALTER TABLE books ADD COLUMN reading_percent REAL;
ALTER TABLE books ADD COLUMN reading_updated_at TEXT;
```

- [ ] **Step 3: Write the failing test**

Add to `electron/main/services/db.test.ts`:

```ts
describe('reading state', () => {
  it('round-trips through insert and read', () => {
    const book = makeBook('rs-1')
    book.readingState = { position: 'epubcfi(/6/4!/2/10)', percent: 0.42, updatedAt: '2026-08-13T10:00:00Z' }
    insertBook(book)

    expect(getBook('rs-1')?.readingState).toEqual({
      position: 'epubcfi(/6/4!/2/10)',
      percent: 0.42,
      updatedAt: '2026-08-13T10:00:00Z'
    })
  })

  it('is null for a book that has never been opened', () => {
    insertBook(makeBook('rs-2'))
    expect(getBook('rs-2')?.readingState).toBeNull()
  })

  it('setReadingState updates in place without touching last_modified', () => {
    const book = makeBook('rs-3')
    book.lastModified = '2020-01-01T00:00:00Z'
    insertBook(book)

    setReadingState('rs-3', { position: 'p1', percent: 0.1, updatedAt: '2026-08-13T10:00:00Z' })

    const updated = getBook('rs-3')!
    expect(updated.readingState?.percent).toBe(0.1)
    // Turning a page is not a metadata edit
    expect(updated.lastModified).toBe('2020-01-01T00:00:00Z')
  })
})
```

Add `setReadingState` to the existing `import { ... } from './db'` line at the top of the file.

- [ ] **Step 4: Run it and watch it fail**

```bash
npm test -- electron/main/services/db.test.ts
```

Expected: FAIL — `setReadingState is not a function`, and `readingState` missing from `makeBook`'s return type.

- [ ] **Step 5: Register the migration**

In `electron/main/services/db.ts`, add the import beside the other two and extend the array:

```ts
import migration003 from '../schema/migrations/003_reading_state.sql?raw'

const MIGRATIONS: string[] = [migration001, migration002, migration003]
```

- [ ] **Step 6: Extend BookRow and rowToBook**

Add to the `BookRow` interface, after `nas_path`:

```ts
  reading_position: string | null
  reading_percent: number | null
  reading_updated_at: string | null
```

Add to the object `rowToBook` returns, after `nasPath`:

```ts
    // `updated_at` is the presence marker: a row with no timestamp has never
    // been opened, and reporting `percent: 0` would render as 0% progress
    // rather than as "not started"
    readingState: r.reading_updated_at
      ? {
          position: r.reading_position,
          percent: r.reading_percent ?? 0,
          updatedAt: r.reading_updated_at
        }
      : null
```

- [ ] **Step 7: Extend insertBook**

In `insertBook`, add the three columns to the SQL column list and three more `?` placeholders:

```sql
        read_status, nas_path, reading_position, reading_percent, reading_updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
```

and to the `.run(...)` arguments, after `book.nasPath`:

```ts
      book.readingState?.position ?? null,
      book.readingState?.percent ?? null,
      book.readingState?.updatedAt ?? null
```

**Do not add `readingState` to `BOOK_COLUMN_MAP`** — it is a nested object that the generic `updateBook` setter cannot flatten, and `updateBook` bumps `last_modified` on every call, which a page turn must not do.

- [ ] **Step 8: Add setReadingState**

Add after `updateBook` in `db.ts`:

```ts
/**
 * Reading position has its own writer rather than going through `updateBook`:
 * it is a nested value the generic column map can't flatten, and `updateBook`
 * bumps `last_modified` on every call — turning a page is not a metadata edit.
 */
export function setReadingState(id: string, state: ReadingState): void {
  getDb()
    .prepare(
      `UPDATE books SET reading_position = ?, reading_percent = ?, reading_updated_at = ?
       WHERE id = ?`
    )
    .run(state.position, state.percent, state.updatedAt, id)
}
```

Add `ReadingState` to the existing type import from `@shared/book.types` at the top of `db.ts`.

- [ ] **Step 9: Update the test helper**

In `test/helpers/book.ts`, add to the returned object after `readStatus: 'unread',`:

```ts
    readingState: null,
```

- [ ] **Step 10: Run the tests**

```bash
npm test -- electron/main/services/db.test.ts
```

Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 11: Full check and commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/types/book.types.ts electron/main/schema/migrations/003_reading_state.sql \
  electron/main/services/db.ts electron/main/services/db.test.ts test/helpers/book.ts
git commit -m "feat: add reading state to the book schema and cache"
```

---

### Task 3: Carry reading state through metadata.json and the catalog

**Files:**
- Modify: `electron/main/services/importer.ts` (`writeMetadataJson`)
- Modify: `electron/main/services/catalog.ts` (`MetadataJson`, `metadataJsonToBook`)
- Test: `electron/main/services/catalog.test.ts`

**Interfaces:**
- Consumes: `ReadingState`, `Book.readingState` (Task 2).
- Produces: `metadata.json` carrying a `reading_state` block; `metadataJsonToBook` reading it back.

This is the load-bearing task. `catalog.json` stores `Book` objects directly, so it inherits `readingState` for free — but `metadataJsonToBook` feeds the rebuild walk, and `replaceAllBooks` wipes the cache on every connect. A gap here silently erases progress on reconnect, exactly as it once did for sort keys.

- [ ] **Step 1: Write the failing test**

Add to `electron/main/services/catalog.test.ts`:

```ts
describe('reading state propagation', () => {
  it('survives a metadata.json round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musaeum-rs-'))
    const book = makeBook('rs-1')
    book.readingState = { position: 'epubcfi(/6/4!/2/10)', percent: 0.42, updatedAt: '2026-08-13T10:00:00Z' }

    await writeMetadataJson(dir, book)
    const json = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')) as MetadataJson
    const restored = await metadataJsonToBook(json, 'rs-1', dir)

    expect(restored.readingState).toEqual(book.readingState)
  })

  it('reads as null when metadata.json predates reading state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musaeum-rs-'))
    const restored = await metadataJsonToBook({ id: 'rs-2', title: 'Old Book' }, 'rs-2', dir)
    expect(restored.readingState).toBeNull()
  })

  it('rejects a malformed reading_state rather than trusting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musaeum-rs-'))
    const restored = await metadataJsonToBook(
      { id: 'rs-3', title: 'Broken', reading_state: { percent: 5, position: 12 } } as unknown as MetadataJson,
      'rs-3',
      dir
    )
    // percent clamps into range; a non-string position is discarded
    expect(restored.readingState).toEqual({ position: null, percent: 1, updatedAt: '' })
  })
})
```

These tests need `writeMetadataJson` from `./importer`, `MetadataJson` and `metadataJsonToBook` from `./catalog`, plus `mkdtempSync`, `promises as fs`, `tmpdir`, and `join`. Add whichever the file does not already import.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- electron/main/services/catalog.test.ts
```

Expected: FAIL — `restored.readingState` is `undefined`.

- [ ] **Step 3: Write reading_state into metadata.json**

In `electron/main/services/importer.ts`, add to the `json` object in `writeMetadataJson`, after `read_status: book.readStatus,`:

```ts
    reading_state: book.readingState
      ? {
          position: book.readingState.position,
          percent: book.readingState.percent,
          updated_at: book.readingState.updatedAt
        }
      : null,
```

- [ ] **Step 4: Extend the MetadataJson contract**

In `electron/main/services/catalog.ts`, add to the `MetadataJson` interface after `read_status?: string`:

```ts
  reading_state?: {
    position?: string | null
    percent?: number | null
    updated_at?: string | null
  } | null
```

- [ ] **Step 5: Parse it back defensively**

Add above `metadataJsonToBook` in `catalog.ts`:

```ts
/**
 * metadata.json is written by us but read from a NAS any machine can touch,
 * so reading state is validated rather than trusted: a percent outside 0–1
 * would drive a progress bar off its track, and a non-string position would
 * be handed to the engine as a seek target.
 */
function toReadingState(raw: MetadataJson['reading_state']): ReadingState | null {
  if (!raw || typeof raw !== 'object') return null
  const percent = typeof raw.percent === 'number' && Number.isFinite(raw.percent)
    ? Math.min(1, Math.max(0, raw.percent))
    : 0
  return {
    position: typeof raw.position === 'string' ? raw.position : null,
    percent,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : ''
  }
}
```

Add `ReadingState` to the existing `import type { Book, BookFormat, ReadStatus } from '@shared/book.types'` line.

Then add to the object `metadataJsonToBook` returns, after `readStatus: ...`:

```ts
    readingState: toReadingState(json.reading_state),
```

- [ ] **Step 6: Run the tests**

```bash
npm test -- electron/main/services/catalog.test.ts
```

Expected: PASS.

- [ ] **Step 7: Prove it survives catalog adoption**

Add to `electron/main/services/library-sync.test.ts`:

```ts
it('preserves reading state across a catalog adoption', async () => {
  const book = makeBook('rs-adopt')
  book.readingState = { position: 'epubcfi(/6/4)', percent: 0.6, updatedAt: '2026-08-13T10:00:00Z' }
  await writeCatalog(root, [book])

  await librarySync.applyCatalog(root)

  expect(getBook('rs-adopt')?.readingState).toEqual(book.readingState)
})
```

Run `npm test -- electron/main/services/library-sync.test.ts`. Expected: PASS — `catalog.json` stores `Book` objects, so this should already hold. **If it fails, the catalog write path is dropping the field and must be fixed before continuing** — this test is the whole point of the task.

- [ ] **Step 8: Full check and commit**

```bash
npm test && npm run typecheck && npm run lint
git add electron/main/services/importer.ts electron/main/services/catalog.ts \
  electron/main/services/catalog.test.ts electron/main/services/library-sync.test.ts
git commit -m "feat: carry reading state through metadata.json and the catalog"
```

---

### Task 4: The reading-state service (persistence policy)

**Files:**
- Create: `electron/main/services/reading-state.ts`
- Test: `electron/main/services/reading-state.test.ts`

**Interfaces:**
- Consumes: `ProgressReport` and `ReadingState` from `@shared/book.types` (Task 2); `db.setReadingState`, `db.getBook`, `db.updateBook`, `importer.writeMetadataJson`, `librarySync.upsertCatalog`, `nas.isOnline`, `nas.getLibraryRoot`.
- Produces:
  - `saveProgress(report: ProgressReport, now?: number): Promise<void>`
  - `flushPending(): Promise<void>`
  - `nextReadStatus(current: ReadStatus, percent: number): ReadStatus`
  - `resetForTests(): void`

- [ ] **Step 1: Write the failing tests**

Create `electron/main/services/reading-state.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { readCatalog, writeCatalog } from './catalog'
import { closeDb, getBook, insertBook } from './db'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import { flushPending, nextReadStatus, resetForTests, saveProgress } from './reading-state'

let root: string

async function seed(id: string, readStatus = 'unread' as const) {
  const book = { ...makeBook(id), readStatus }
  insertBook(book)
  const dir = join(root, 'books', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'metadata.json'), JSON.stringify({ id }))
  return dir
}

async function readJson(dir: string) {
  return JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8'))
}

beforeEach(async () => {
  closeDb()
  const userData = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(userData, f), { force: true })
  }
  librarySync.resetForTests()
  resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-reading-'))
  await nas.setLibraryRoot(root)
  await writeCatalog(root, [])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('nextReadStatus', () => {
  it('starts a book reading on first progress', () => {
    expect(nextReadStatus('unread', 0.01)).toBe('reading')
  })

  it('finishes a book at 98%', () => {
    expect(nextReadStatus('reading', 0.98)).toBe('read')
  })

  it('never demotes a book already marked read', () => {
    // Manual override wins: reopening a finished book must not undo it
    expect(nextReadStatus('read', 0.05)).toBe('read')
  })
})

describe('saveProgress write tiering', () => {
  it('writes SQLite on every report but not the catalog', async () => {
    const dir = await seed('b1')
    await saveProgress({ bookId: 'b1', position: 'p1', percent: 0.1, final: false }, 1_000)

    expect(getBook('b1')?.readingState?.position).toBe('p1')
    await librarySync.flushForTests()
    expect((await readCatalog(root))?.books ?? []).toHaveLength(0)
    // First report is always past the interval, so metadata.json is written
    expect((await readJson(dir)).reading_state.position).toBe('p1')
  })

  it('does not rewrite metadata.json inside the throttle window', async () => {
    const dir = await seed('b2')
    await saveProgress({ bookId: 'b2', position: 'p1', percent: 0.1, final: false }, 1_000)
    await saveProgress({ bookId: 'b2', position: 'p2', percent: 0.2, final: false }, 6_000)

    expect(getBook('b2')?.readingState?.position).toBe('p2')
    expect((await readJson(dir)).reading_state.position).toBe('p1')
  })

  it('rewrites metadata.json once the throttle window passes', async () => {
    const dir = await seed('b3')
    await saveProgress({ bookId: 'b3', position: 'p1', percent: 0.1, final: false }, 1_000)
    await saveProgress({ bookId: 'b3', position: 'p2', percent: 0.2, final: false }, 40_000)

    expect((await readJson(dir)).reading_state.position).toBe('p2')
  })

  it('writes everything on a final report', async () => {
    const dir = await seed('b4')
    await saveProgress({ bookId: 'b4', position: 'p1', percent: 0.1, final: false }, 1_000)
    await saveProgress({ bookId: 'b4', position: 'p9', percent: 0.9, final: true }, 6_000)

    expect((await readJson(dir)).reading_state.position).toBe('p9')
    await librarySync.flushForTests()
    const catalogued = (await readCatalog(root))?.books.find((b) => b.id === 'b4')
    expect(catalogued?.readingState?.position).toBe('p9')
  })

  it('advances read status as progress is saved', async () => {
    await seed('b5')
    await saveProgress({ bookId: 'b5', position: 'p1', percent: 0.1, final: false }, 1_000)
    expect(getBook('b5')?.readStatus).toBe('reading')

    await saveProgress({ bookId: 'b5', position: 'p2', percent: 0.99, final: true }, 40_000)
    expect(getBook('b5')?.readStatus).toBe('read')
  })

  it('clamps a percent outside 0-1', async () => {
    await seed('b6')
    await saveProgress({ bookId: 'b6', position: 'p1', percent: 1.5, final: false }, 1_000)
    expect(getBook('b6')?.readingState?.percent).toBe(1)
  })

  it('ignores a report for a book that no longer exists', async () => {
    await expect(
      saveProgress({ bookId: 'ghost', position: 'p1', percent: 0.1, final: false }, 1_000)
    ).resolves.toBeUndefined()
  })
})

describe('offline', () => {
  it('keeps recording position without touching the NAS', async () => {
    const dir = await seed('b7')
    await nas.setLibraryRoot(null)

    await saveProgress({ bookId: 'b7', position: 'p1', percent: 0.3, final: false }, 1_000)

    // Reading is not interrupted by a dropped share
    expect(getBook('b7')?.readingState?.position).toBe('p1')
    expect((await readJson(dir)).reading_state).toBeUndefined()
  })
})

describe('flushPending', () => {
  it('writes an unsaved position at quit', async () => {
    const dir = await seed('b8')
    await saveProgress({ bookId: 'b8', position: 'p1', percent: 0.1, final: false }, 1_000)
    await saveProgress({ bookId: 'b8', position: 'p2', percent: 0.2, final: false }, 6_000)

    await flushPending()

    expect((await readJson(dir)).reading_state.position).toBe('p2')
    await librarySync.flushForTests()
    const catalogued = (await readCatalog(root))?.books.find((b) => b.id === 'b8')
    expect(catalogued?.readingState?.position).toBe('p2')
  })

  it('does nothing when every book was already flushed', async () => {
    await seed('b9')
    await saveProgress({ bookId: 'b9', position: 'p1', percent: 0.1, final: true }, 1_000)
    await expect(flushPending()).resolves.toBeUndefined()
  })
})
```

**Check `nas.setLibraryRoot(null)` is a valid call** before relying on it — `grep -n "export async function setLibraryRoot" -A 5 electron/main/services/nas-manager.ts`. If the signature does not accept `null`, use whatever that module exposes to enter offline state (e.g. pointing the root at a deleted directory), and keep the test's intent: SQLite still records, NAS is untouched.

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm test -- electron/main/services/reading-state.test.ts
```

Expected: FAIL — cannot resolve `./reading-state`.

- [ ] **Step 3: Write the service**

Create `electron/main/services/reading-state.ts`:

```ts
import { join } from 'path'
import type { ProgressReport, ReadStatus, ReadingState } from '@shared/book.types'
import * as db from './db'
import { writeMetadataJson } from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'

/**
 * Where reading position goes, and how often.
 *
 * The three stores cost wildly different amounts, so they are written on
 * different clocks: SQLite is in-process and free, metadata.json is a ~2KB
 * per-book write, and catalog.json is a whole-library rewrite over SMB. A
 * naive "write everything on a throttle" would rewrite ~10MB every 30
 * seconds of reading.
 *
 * | trigger        | sqlite | metadata.json    | catalog.json |
 * |----------------|--------|------------------|--------------|
 * | page turn      | yes    | if >30s since    | no           |
 * | close / quit   | yes    | yes              | yes          |
 *
 * All of it lives here rather than in the reader so the policy is testable
 * without a browser.
 */

const JSON_INTERVAL_MS = 30_000

const lastJsonWrite = new Map<string, number>()
/** Books whose latest position has not reached the NAS yet — flushed at quit. */
const pending = new Map<string, ProgressReport>()

/**
 * Read status only ever advances. A book you marked read stays read when you
 * reopen it, which is what makes a manual override stick.
 */
export function nextReadStatus(current: ReadStatus, percent: number): ReadStatus {
  if (current === 'read') return 'read'
  return percent >= 0.98 ? 'read' : 'reading'
}

export async function saveProgress(report: ProgressReport, now = Date.now()): Promise<void> {
  const book = db.getBook(report.bookId)
  if (!book) return

  const state: ReadingState = {
    position: report.position,
    percent: Math.min(1, Math.max(0, report.percent)),
    updatedAt: new Date(now).toISOString()
  }
  db.setReadingState(book.id, state)

  const status = nextReadStatus(book.readStatus, state.percent)
  if (status !== book.readStatus) db.updateBook(book.id, { readStatus: status })

  const root = nas.getLibraryRoot()
  if (!root || !nas.isOnline() || !book.nasPath) {
    // Reading is not interrupted by a dropped share: SQLite has the position
    // and the NAS catches up on the next report once the mount is back
    pending.set(report.bookId, report)
    return
  }

  const dueForJson = report.final || now - (lastJsonWrite.get(book.id) ?? 0) >= JSON_INTERVAL_MS
  if (!dueForJson) {
    pending.set(report.bookId, report)
    return
  }

  const updated = { ...db.getBook(book.id)!, readingState: state, readStatus: status }
  try {
    await writeMetadataJson(join(root, book.nasPath), updated)
    lastJsonWrite.set(book.id, now)
  } catch (err) {
    console.warn(`[reading] could not write metadata.json for ${book.id}:`, err)
    pending.set(report.bookId, report)
    return
  }

  if (report.final) {
    librarySync.upsertCatalog([updated])
    pending.delete(report.bookId)
  } else {
    pending.set(report.bookId, report)
  }
}

/** Flush every unsaved position. Called on `will-quit`. */
export async function flushPending(): Promise<void> {
  const reports = [...pending.values()]
  pending.clear()
  for (const report of reports) {
    await saveProgress({ ...report, final: true })
  }
}

export function resetForTests(): void {
  lastJsonWrite.clear()
  pending.clear()
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- electron/main/services/reading-state.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Full check and commit**

```bash
npm test && npm run typecheck && npm run lint
git add electron/main/services/reading-state.ts electron/main/services/reading-state.test.ts
git commit -m "feat: reading-state service with tiered persistence"
```

---

### Task 5: Serve book bytes over musaeum://book

**Files:**
- Create: `electron/main/services/book-bytes.ts`
- Create: `electron/main/services/book-bytes.test.ts`
- Modify: `electron/main/index.ts` (`registerCoverProtocol` → `registerMusaeumProtocol`)

**Interfaces:**
- Consumes: `db.getBook`, `nas.getLibraryRoot`.
- Produces: `resolveBookFile(bookId: string, format: string): Promise<string | null>` — an absolute path, or `null` for anything the caller should 404.

- [ ] **Step 1: Write the failing tests**

Create `electron/main/services/book-bytes.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { resolveBookFile } from './book-bytes'
import { closeDb, insertBook } from './db'
import * as nas from './nas-manager'

let root: string

beforeEach(async () => {
  closeDb()
  const userData = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(userData, f), { force: true })
  }
  root = mkdtempSync(join(tmpdir(), 'musaeum-bytes-'))
  await nas.setLibraryRoot(root)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

async function seed(id: string, fileName: string) {
  insertBook(makeBook(id))
  const dir = join(root, 'books', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, fileName), 'bytes')
  return join(dir, fileName)
}

describe('resolveBookFile', () => {
  it('finds the file for a format', async () => {
    const path = await seed('b1', 'Leviathan Wakes.epub')
    expect(await resolveBookFile('b1', 'epub')).toBe(path)
  })

  it('matches by extension, so a renamed book still opens', async () => {
    // Files are named from the title at import; the title moves afterwards
    const path = await seed('b2', 'Some Older Title.epub')
    expect(await resolveBookFile('b2', 'epub')).toBe(path)
  })

  it('returns null when the book has no file of that format', async () => {
    await seed('b3', 'Book.epub')
    expect(await resolveBookFile('b3', 'mobi')).toBeNull()
  })

  it('rejects a format outside the union', async () => {
    await seed('b4', 'Book.epub')
    expect(await resolveBookFile('b4', 'sh')).toBeNull()
    expect(await resolveBookFile('b4', '../../etc/passwd')).toBeNull()
  })

  it('returns null for an unknown book', async () => {
    expect(await resolveBookFile('nope', 'epub')).toBeNull()
  })

  it('returns null when the book folder is missing', async () => {
    insertBook(makeBook('b5'))
    expect(await resolveBookFile('b5', 'epub')).toBeNull()
  })

  it('refuses a book whose nasPath escapes the library root', async () => {
    const book = { ...makeBook('b6'), nasPath: '../outside' }
    insertBook(book)
    expect(await resolveBookFile('b6', 'epub')).toBeNull()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npm test -- electron/main/services/book-bytes.test.ts
```

Expected: FAIL — cannot resolve `./book-bytes`.

- [ ] **Step 3: Write the service**

Create `electron/main/services/book-bytes.ts`:

```ts
import { promises as fs } from 'fs'
import { extname, join, relative, resolve } from 'path'
import type { BookFormat } from '@shared/book.types'
import * as db from './db'
import * as nas from './nas-manager'

/**
 * Resolving a book's bytes for the `musaeum://book/{id}/{format}` route.
 *
 * Kept out of the protocol handler so the path rules — which are the security
 * boundary between a renderer URL and the filesystem — are testable without a
 * running Electron app. Every failure returns null; the caller answers 404
 * rather than leaking which of the reasons applied.
 */

const FORMATS = new Set<string>(['epub', 'mobi', 'azw3', 'pdf'] satisfies BookFormat[])

export async function resolveBookFile(bookId: string, format: string): Promise<string | null> {
  if (!FORMATS.has(format)) return null

  const root = nas.getLibraryRoot()
  const book = db.getBook(bookId)
  if (!root || !book?.nasPath) return null

  // nasPath comes from a catalog any machine can write; a traversing entry
  // must not turn a renderer URL into arbitrary filesystem read access
  const dir = resolve(root, book.nasPath)
  const rel = relative(resolve(root), dir)
  if (rel.startsWith('..') || rel === '') return null

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }

  // By extension, not by canonical name — same rule as file-access and
  // deleteFormats, so a book renamed after import still opens
  const match = entries.find((f) => extname(f).toLowerCase() === `.${format}`)
  return match ? join(dir, match) : null
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- electron/main/services/book-bytes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire the protocol route**

In `electron/main/index.ts`, rename `registerCoverProtocol` to `registerMusaeumProtocol` and dispatch on host. Replace the whole function with:

```ts
/**
 * musaeum:// — the renderer's only path to library files. Two hosts:
 *   cover/{bookId}/{thumb|full}   cover images
 *   book/{bookId}/{format}        book bytes for the reader
 * CSP forbids file://, so everything the renderer displays comes through here.
 */
function registerMusaeumProtocol(): void {
  protocol.handle('musaeum', async (request) => {
    const url = new URL(request.url)
    const [bookId, rest] = url.pathname.replace(/^\//, '').split('/')
    if (!bookId || !rest) return new Response(null, { status: 400 })

    if (url.host === 'book') {
      const file = await resolveBookFile(bookId, rest)
      return file
        ? net.fetch(pathToFileURL(file).toString())
        : new Response(null, { status: 404 })
    }

    if (url.host !== 'cover') return new Response(null, { status: 400 })

    const root = nas.getLibraryRoot()
    const book = getBook(bookId)
    const file = rest === 'thumb' ? book?.coverThumbPath : book?.coverFullPath
    if (!root || !book?.nasPath || !file) return new Response(null, { status: 404 })

    // Cover paths are stored relative to the book dir; reject traversal
    if (file.includes('..') || file.includes('/')) return new Response(null, { status: 400 })
    return net.fetch(pathToFileURL(join(root, book.nasPath, file)).toString())
  })
}
```

Add the import: `import { resolveBookFile } from './services/book-bytes'`, and update the call in `app.whenReady()` from `registerCoverProtocol()` to `registerMusaeumProtocol()`.

- [ ] **Step 6: Verify nothing regressed**

```bash
npm test && npm run typecheck && npm run lint
npm run dev
```

In the running app, confirm cover images still load in the grid — the cover route was rewritten and is the regression risk here. Quit the app.

- [ ] **Step 7: Commit**

```bash
git add electron/main/services/book-bytes.ts electron/main/services/book-bytes.test.ts \
  electron/main/index.ts
git commit -m "feat: serve book bytes over musaeum://book"
```

---

### Task 6: IPC surface and quit flush

**Files:**
- Create: `electron/main/ipc/reader.ts`
- Modify: `electron/main/index.ts` (register handlers, `will-quit`)
- Modify: `electron/preload/index.ts`
- Modify: `src/types/api.types.ts`

**Interfaces:**
- Consumes: `saveProgress`, `flushPending` (Task 4); `ProgressReport` from `@shared/book.types` (Task 2).
- Produces: `window.Musaeum.reader.saveProgress(report: ProgressReport): Promise<void>`.

- [ ] **Step 1: Write the IPC handler**

Create `electron/main/ipc/reader.ts`:

```ts
import type { ProgressReport } from '@shared/book.types'
import * as readingState from '../services/reading-state'
import { handle } from './handle'

export function registerReaderHandlers(): void {
  handle('reader:saveProgress', (report: ProgressReport) => readingState.saveProgress(report))
}
```

- [ ] **Step 2: Register it and flush at quit**

In `electron/main/index.ts`:

```ts
import { registerReaderHandlers } from './ipc/reader'
import * as readingState from './services/reading-state'
```

Add `registerReaderHandlers()` alongside the other `register*Handlers()` calls in `app.whenReady()`, and extend the existing `will-quit` handler:

```ts
app.on('will-quit', () => {
  importer.abortPendingDecisions()
  void readingState.flushPending()
})
```

- [ ] **Step 3: Extend the preload bridge**

In `electron/preload/index.ts`, add after the `files: { ... },` block:

```ts
  reader: {
    saveProgress: (report) => invoke('reader:saveProgress', report)
  },
```

- [ ] **Step 4: Extend the API contract**

In `src/types/api.types.ts`, add to the `MusaeumAPI` interface after the `files` block:

```ts
  reader: {
    saveProgress(report: ProgressReport): Promise<void>
  }
```

Add `ProgressReport` to the existing type import from `./book.types`.

- [ ] **Step 5: Verify**

```bash
npm test && npm run typecheck && npm run lint
```

Expected: all pass. `typecheck` is the real check here — the preload object is typed against `MusaeumAPI`, so a mismatch fails the build.

- [ ] **Step 6: Commit**

```bash
git add electron/main/ipc/reader.ts electron/main/index.ts electron/preload/index.ts \
  src/types/api.types.ts src/types/book.types.ts electron/main/services/reading-state.ts
git commit -m "feat: reader IPC surface and quit flush"
```

---

### Task 7: Reader store and open-format resolution

**Files:**
- Modify: `src/types/book.types.ts` (`readableFormat`)
- Create: `src/types/book.types.test.ts`
- Create: `src/stores/reader.store.ts`

**Interfaces:**
- Consumes: `Book`, `BookFormat`.
- Produces:
  - `readableFormat(book: Book): BookFormat | null` from `@shared/book.types`
  - `useReaderStore` with `{ bookId, format, status, error, toc, percent, tocOpen, prefs }` and actions `openBook(book)`, `close()`, `setStatus`, `setToc`, `setPercent`, `toggleToc`, `setPrefs`

- [ ] **Step 1: Write the failing test**

Create `src/types/book.types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeBook } from '../../test/helpers/book'
import { readableFormat } from './book.types'

describe('readableFormat', () => {
  it('prefers epub', () => {
    expect(readableFormat({ ...makeBook('a'), formats: ['pdf', 'mobi', 'epub'] })).toBe('epub')
  })

  it('falls back to azw3 before mobi', () => {
    expect(readableFormat({ ...makeBook('a'), formats: ['mobi', 'azw3'] })).toBe('azw3')
  })

  it('reads a mobi-only book', () => {
    expect(readableFormat({ ...makeBook('a'), formats: ['mobi'] })).toBe('mobi')
  })

  it('returns null for a pdf-only book, which C1 cannot render', () => {
    expect(readableFormat({ ...makeBook('a'), formats: ['pdf'] })).toBeNull()
  })

  it('returns null for a book with no files', () => {
    expect(readableFormat({ ...makeBook('a'), formats: [] })).toBeNull()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npm test -- src/types/book.types.test.ts
```

Expected: FAIL — `readableFormat` is not exported.

- [ ] **Step 3: Implement it**

Add to `src/types/book.types.ts`:

```ts
/**
 * The format the in-app reader should open, in preference order. PDF is
 * deliberately absent until C2 ships — a PDF-only book falls through to the
 * system opener, where Preview handles it well.
 */
const READABLE_FORMATS: BookFormat[] = ['epub', 'azw3', 'mobi']

export function readableFormat(book: Book): BookFormat | null {
  return READABLE_FORMATS.find((f) => book.formats.includes(f)) ?? null
}
```

- [ ] **Step 4: Run the test**

```bash
npm test -- src/types/book.types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the store**

Create `src/stores/reader.store.ts`:

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Book, BookFormat } from '@shared/book.types'
import { readableFormat } from '@shared/book.types'

export interface ReaderTocItem {
  label: string
  href: string
}

export type ReaderStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ReaderPrefs {
  typeface: 'serif' | 'sans'
  fontSize: number // px
  lineHeight: number
  margin: number // px
  theme: 'paper' | 'ink'
}

export const DEFAULT_PREFS: ReaderPrefs = {
  typeface: 'serif',
  fontSize: 18,
  lineHeight: 1.6,
  margin: 48,
  theme: 'ink'
}

interface ReaderState {
  bookId: string | null
  format: BookFormat | null
  status: ReaderStatus
  error: string | null
  toc: ReaderTocItem[]
  percent: number
  tocOpen: boolean
  prefs: ReaderPrefs

  openBook(book: Book): void
  close(): void
  setStatus(status: ReaderStatus, error?: string | null): void
  setToc(toc: ReaderTocItem[]): void
  setPercent(percent: number): void
  toggleToc(): void
  setPrefs(prefs: Partial<ReaderPrefs>): void
}

export const useReaderStore = create<ReaderState>()(
  persist(
    (set, get) => ({
      bookId: null,
      format: null,
      status: 'idle',
      error: null,
      toc: [],
      percent: 0,
      tocOpen: false,
      prefs: DEFAULT_PREFS,

      /**
       * A book the engine can't render is handed to the OS instead of opening
       * a reader that only apologises — so PDFs land in Preview today and
       * quietly stop falling through when C2 ships.
       */
      openBook: (book) => {
        const format = readableFormat(book)
        if (!format) {
          const fallback = book.formats[0]
          if (fallback) void window.Musaeum.files.openBookFile(book.id, fallback).catch(() => {})
          return
        }
        set({
          bookId: book.id,
          format,
          status: 'loading',
          error: null,
          toc: [],
          percent: book.readingState?.percent ?? 0,
          tocOpen: false
        })
      },

      close: () => set({ bookId: null, format: null, status: 'idle', error: null, toc: [], tocOpen: false }),
      setStatus: (status, error = null) => set({ status, error }),
      setToc: (toc) => set({ toc }),
      setPercent: (percent) => set({ percent }),
      toggleToc: () => set((s) => ({ tocOpen: !s.tocOpen })),
      setPrefs: (prefs) => set((s) => ({ prefs: { ...s.prefs, ...prefs } }))
    }),
    {
      // Only typography survives a restart — which book was open does not,
      // matching how the library forgets selection and search
      name: 'musaeum.reader',
      partialize: (s) => ({ prefs: s.prefs }),
      merge: (persisted, current) => {
        const { prefs } = (persisted ?? {}) as { prefs?: Partial<ReaderPrefs> }
        return { ...current, prefs: { ...DEFAULT_PREFS, ...(prefs ?? {}) } }
      }
    }
  )
)
```

Note the `merge` validator: like `ui.store` and `library.store`, persisted state was written by whatever build ran last and is spread over the defaults rather than trusted wholesale.

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/types/book.types.ts src/types/book.types.test.ts src/stores/reader.store.ts
git commit -m "feat: reader store and open-format resolution"
```

---

### Task 8: ReaderView — engine host, TOC, progress, keyboard

**Files:**
- Create: `src/components/reader/ReaderView.tsx`
- Create: `src/components/reader/ReaderEngine.tsx`
- Create: `src/components/reader/ReaderToc.tsx`
- Modify: `src/components/shared/icons.tsx` (two new icons)
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useReaderStore` (Task 7), `window.Musaeum.reader.saveProgress` (Task 6), `musaeum://book/{id}/{format}` (Task 5), `@vendor/foliate-js/view.js` (Task 1).
- Produces: `<ReaderView />`, mounted at app root.

This task is verified by running the app, not by unit tests — it is a rendering-engine integration. The testable policy already has coverage in Tasks 4, 5, and 7.

- [ ] **Step 1: Add the icons**

In `src/components/shared/icons.tsx`, following the existing hand-rolled inline-SVG style (copy the props signature from a neighbouring icon):

```tsx
export function ReaderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4.5A1.5 1.5 0 0 1 3 15.5v-10Z" />
      <path d="M21 5.5A1.5 1.5 0 0 0 19.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h5.5a1.5 1.5 0 0 0 1.5-1.5v-10Z" />
    </svg>
  )
}

export function ListIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
    </svg>
  )
}
```

If an equivalent icon already exists under another name, use it rather than adding a duplicate.

- [ ] **Step 2: Write the engine host**

Create `src/components/reader/ReaderEngine.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { FoliateView, FoliateRelocateDetail, FoliateTocItem } from '@vendor/foliate-js/view.js'
import '@vendor/foliate-js/view.js'
import type { BookFormat, ReadingState } from '@shared/book.types'
import type { ReaderPrefs, ReaderTocItem } from '@/stores/reader.store'

interface Props {
  bookId: string
  format: BookFormat
  initial: ReadingState | null
  prefs: ReaderPrefs
  onReady(toc: ReaderTocItem[]): void
  onRelocate(detail: { position: string | null; percent: number }): void
  onError(message: string): void
  /** Set by the parent so chrome buttons and keys can drive the engine. */
  viewRef: MutableRefObject<FoliateView | null>
}

/** Flatten foliate's nested TOC — the panel renders one level. */
function flattenToc(items: FoliateTocItem[] | undefined, depth = 0): ReaderTocItem[] {
  return (items ?? []).flatMap((item) => [
    { label: `${'  '.repeat(depth)}${item.label}`.trim(), href: item.href },
    ...flattenToc(item.subitems, depth + 1)
  ])
}

function pageCss(prefs: ReaderPrefs): string {
  const paper = prefs.theme === 'paper'
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { color-scheme: ${paper ? 'light' : 'dark'}; }
    body {
      background: ${paper ? '#f6f0e4' : '#14110d'};
      color: ${paper ? '#241f18' : '#e8e0d2'};
      font-family: ${prefs.typeface === 'serif' ? 'Georgia, serif' : 'system-ui, sans-serif'};
      font-size: ${prefs.fontSize}px;
      line-height: ${prefs.lineHeight};
    }
    a { color: ${paper ? '#8a5a1a' : '#d6a95f'}; }
  `
}

/**
 * Wraps foliate-js's <foliate-view> custom element. The engine owns its own
 * DOM, so React only mounts the host and hands it a Blob — book bytes arrive
 * over musaeum://, never file://.
 */
export function ReaderEngine({
  bookId, format, initial, prefs, onReady, onRelocate, onError, viewRef
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)

  // Re-open only when the book changes; pref changes restyle in place
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false

    const view = document.createElement('foliate-view') as FoliateView
    host.append(view)
    viewRef.current = view

    view.addEventListener('relocate', (event) => {
      const detail = (event as CustomEvent<FoliateRelocateDetail>).detail
      onRelocate({ position: detail.cfi ?? null, percent: detail.fraction ?? 0 })
    })

    void (async () => {
      try {
        const response = await fetch(`musaeum://book/${bookId}/${format}`)
        if (!response.ok) throw new Error('This book’s file could not be read.')
        const blob = await response.blob()
        if (disposed) return

        await view.open(blob)
        view.renderer.setStyles(pageCss(prefs))

        // A stored position may no longer resolve — a re-downloaded file, a
        // different engine version — so percent is the fallback
        if (initial?.position) {
          await view.goTo(initial.position).catch(() => view.goToFraction(initial.percent))
        } else if (initial?.percent) {
          await view.goToFraction(initial.percent)
        }
        if (disposed) return
        onReady(flattenToc(view.book.toc))
      } catch (err) {
        if (!disposed) onError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      disposed = true
      viewRef.current = null
      view.close?.()
      view.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, format])

  useEffect(() => {
    viewRef.current?.renderer.setStyles(pageCss(prefs))
  }, [prefs, viewRef])

  return <div ref={hostRef} className="h-full w-full" />
}
```

**Verify the engine API against the vendored source rather than trusting this file:** if `relocate`'s detail fields or the `open`/`goTo`/`goToFraction`/`next`/`prev`/`close` names differ in `vendor/foliate-js/view.js`, update both this component and `src/types/foliate-js.d.ts` to match upstream. Never edit the vendored file.

- [ ] **Step 3: Write the TOC panel**

Create `src/components/reader/ReaderToc.tsx`:

```tsx
import { useReaderStore } from '@/stores/reader.store'

export function ReaderToc({ onNavigate }: { onNavigate: (href: string) => void }) {
  const toc = useReaderStore((s) => s.toc)
  const toggleToc = useReaderStore((s) => s.toggleToc)

  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-r border-ink-700 bg-ink-850">
      <div className="px-4 py-3 text-xs uppercase tracking-wider text-parchment-500">Contents</div>
      {toc.length === 0 ? (
        <p className="px-4 py-2 text-sm text-parchment-500">This book has no table of contents.</p>
      ) : (
        <ul className="pb-4">
          {toc.map((item, i) => (
            <li key={`${item.href}-${i}`}>
              <button
                onClick={() => {
                  onNavigate(item.href)
                  toggleToc()
                }}
                className="w-full px-4 py-1.5 text-left text-sm leading-5 text-parchment-300 hover:bg-ink-800 hover:text-gold-400"
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
```

Check the palette class names against an existing component (e.g. `BookDetail.tsx`) and correct them if these differ — `tailwind.config.js` is the authority.

- [ ] **Step 4: Write the overlay**

Create `src/components/reader/ReaderView.tsx`:

```tsx
import { useCallback, useEffect, useRef } from 'react'
import type { FoliateView } from '@vendor/foliate-js/view.js'
import { useLibraryStore } from '@/stores/library.store'
import { useReaderStore } from '@/stores/reader.store'
import { ReaderEngine } from './ReaderEngine'
import { ReaderToc } from './ReaderToc'
import { CloseIcon, ListIcon } from '@/components/shared/icons'

/** Position reports are debounced: a page turn is cheap, a NAS write is not. */
const REPORT_DEBOUNCE_MS = 2_000

export function ReaderView() {
  const bookId = useReaderStore((s) => s.bookId)
  const format = useReaderStore((s) => s.format)
  const status = useReaderStore((s) => s.status)
  const error = useReaderStore((s) => s.error)
  const percent = useReaderStore((s) => s.percent)
  const tocOpen = useReaderStore((s) => s.tocOpen)
  const prefs = useReaderStore((s) => s.prefs)
  const { close, setStatus, setToc, setPercent, toggleToc } = useReaderStore.getState()

  const books = useLibraryStore((s) => s.books)
  const book = books.find((b) => b.id === bookId) ?? null

  const viewRef = useRef<FoliateView | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<{ position: string | null; percent: number } | null>(null)

  const flush = useCallback(
    (final: boolean) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      const report = latest.current
      if (!report || !bookId) return
      void window.Musaeum.reader.saveProgress({ bookId, ...report, final }).catch(() => {})
      if (final) latest.current = null
    },
    [bookId]
  )

  const onRelocate = useCallback(
    (detail: { position: string | null; percent: number }) => {
      latest.current = detail
      setPercent(detail.percent)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => flush(false), REPORT_DEBOUNCE_MS)
    },
    [flush, setPercent]
  )

  const closeReader = useCallback(() => {
    flush(true)
    close()
  }, [flush, close])

  useEffect(() => {
    if (!bookId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return closeReader()
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault()
        void viewRef.current?.next()
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        void viewRef.current?.prev()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bookId, closeReader])

  // A close that skips the button — window closing, book deleted — still reports
  useEffect(() => () => flush(true), [flush])

  if (!bookId || !format || !book) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-900">
      <header className="flex items-center gap-3 border-b border-ink-700 px-4 py-3">
        <button onClick={closeReader} aria-label="Close reader" className="rounded p-1.5 text-parchment-400 hover:bg-ink-800 hover:text-gold-400">
          <CloseIcon className="h-5 w-5" />
        </button>
        <button onClick={toggleToc} aria-label="Table of contents" className="rounded p-1.5 text-parchment-400 hover:bg-ink-800 hover:text-gold-400">
          <ListIcon className="h-5 w-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate font-display text-lg text-parchment-200">{book.title}</h1>
        <span className="tabular-nums text-sm text-parchment-500">{Math.round(percent * 100)}%</span>
      </header>

      <div className="flex min-h-0 flex-1">
        {tocOpen && <ReaderToc onNavigate={(href) => void viewRef.current?.goTo(href)} />}
        <main className="relative min-w-0 flex-1">
          {status === 'error' ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
              <p className="max-w-md text-parchment-300">{error}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    void window.Musaeum.files.openBookFile(book.id, format).catch(() => {})
                    closeReader()
                  }}
                  className="rounded border border-ink-600 px-4 py-2 text-sm text-parchment-200 hover:border-gold-500 hover:text-gold-400"
                >
                  Open externally
                </button>
                <button onClick={closeReader} className="rounded border border-ink-600 px-4 py-2 text-sm text-parchment-200 hover:border-gold-500">
                  Close
                </button>
              </div>
            </div>
          ) : (
            <>
              {status === 'loading' && (
                <p className="absolute inset-0 flex items-center justify-center text-parchment-500">Opening…</p>
              )}
              <ReaderEngine
                bookId={book.id}
                format={format}
                initial={book.readingState}
                prefs={prefs}
                viewRef={viewRef}
                onReady={(toc) => {
                  setToc(toc)
                  setStatus('ready')
                }}
                onRelocate={onRelocate}
                onError={(message) => setStatus('error', message)}
              />
            </>
          )}
        </main>
      </div>

      <div className="h-0.5 bg-ink-800">
        <div className="h-full bg-gold-500 transition-[width]" style={{ width: `${percent * 100}%` }} />
      </div>
    </div>
  )
}
```

Use whatever the existing close/X icon is actually named in `icons.tsx` rather than assuming `CloseIcon`.

- [ ] **Step 5: Mount it**

In `src/App.tsx`, add the import and render it last inside the root `<div>`, after `<RemoveFromDeviceDialog />`:

```tsx
import { ReaderView } from '@/components/reader/ReaderView'
```

```tsx
      <ReaderView />
```

- [ ] **Step 6: Verify it builds**

```bash
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 7: Verify it reads (manual)**

```bash
npm run dev
```

Temporarily wire an opener so the reader is reachable before Task 9 lands the real entry points: in `src/components/library/BookDetail.tsx`, add a button calling `useReaderStore.getState().openBook(book)`. Then confirm, against the real library:

1. An EPUB opens, paginates, and ←/→/space turn pages.
2. The TOC panel lists chapters and navigating works.
3. The percent readout and bottom progress bar advance.
4. Esc closes the reader.
5. Reopen the same book — it resumes where you left off.
6. Open an **azw3** and a **mobi** book (filter the library by format).
7. Widen the window until the page splits into two columns, then narrow it back — foliate's paginator does this on its own, so this is a check that nothing in the host CSS is fighting it.
8. Check the DevTools console for CSP violations. If any appear, widen the specific directive in `index.html` and note it in the commit message — do not relax `script-src`.

Keep the temporary button; Task 9 replaces it with the real one.

- [ ] **Step 8: Commit**

```bash
git add src/components/reader src/components/shared/icons.tsx src/App.tsx \
  src/components/library/BookDetail.tsx index.html
git commit -m "feat: reader overlay over the vendored foliate-js engine"
```

---

### Task 9: Typography controls, entry points, and the navigation guard

**Files:**
- Create: `src/components/reader/ReaderPrefsPopover.tsx`
- Modify: `src/components/reader/ReaderView.tsx`
- Modify: `src/components/library/BookCard.tsx`
- Modify: `src/components/library/ListView.tsx`
- Modify: `src/components/library/BookDetail.tsx`
- Modify: `src/components/library/BookContextMenu.tsx`
- Modify: `src/hooks/useBookNavigation.ts`

**Interfaces:**
- Consumes: `useReaderStore.openBook` (Task 7), `ReaderPrefs`.
- Produces: nothing new — this is the last wiring task.

- [ ] **Step 1: Write the preferences popover**

Create `src/components/reader/ReaderPrefsPopover.tsx`:

```tsx
import { useReaderStore } from '@/stores/reader.store'

const TYPEFACES = [
  { value: 'serif', label: 'Serif' },
  { value: 'sans', label: 'Sans' }
] as const

const THEMES = [
  { value: 'paper', label: 'Paper' },
  { value: 'ink', label: 'Ink' }
] as const

/** Typography is per-machine, not per-book — it describes the reader, not the text. */
export function ReaderPrefsPopover({ onClose }: { onClose: () => void }) {
  const prefs = useReaderStore((s) => s.prefs)
  const setPrefs = useReaderStore((s) => s.setPrefs)

  return (
    <div className="fixed inset-0 z-10" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute right-4 top-14 w-64 space-y-4 rounded-lg border border-ink-700 bg-ink-850 p-4 shadow-cover-lift"
      >
        <Segmented
          label="Typeface"
          options={TYPEFACES}
          value={prefs.typeface}
          onChange={(typeface) => setPrefs({ typeface })}
        />
        <Segmented
          label="Theme"
          options={THEMES}
          value={prefs.theme}
          onChange={(theme) => setPrefs({ theme })}
        />
        <Slider label="Size" min={12} max={28} step={1} value={prefs.fontSize} onChange={(fontSize) => setPrefs({ fontSize })} />
        <Slider label="Line height" min={1.2} max={2.2} step={0.1} value={prefs.lineHeight} onChange={(lineHeight) => setPrefs({ lineHeight })} />
        <Slider label="Margin" min={16} max={160} step={8} value={prefs.margin} onChange={(margin) => setPrefs({ margin })} />
      </div>
    </div>
  )
}

function Segmented<T extends string>({
  label, options, value, onChange
}: {
  label: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs uppercase tracking-wider text-parchment-500">{label}</div>
      <div className="flex gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded border px-2 py-1 text-sm ${
              value === o.value
                ? 'border-gold-500 text-gold-400'
                : 'border-ink-600 text-parchment-400 hover:border-ink-500'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Slider({
  label, min, max, step, value, onChange
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs uppercase tracking-wider text-parchment-500">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-gold-500"
      />
    </label>
  )
}
```

- [ ] **Step 2: Add the margin to the engine's page CSS**

`prefs.margin` is in the popover but not yet applied. In `src/components/reader/ReaderEngine.tsx`, add to the `body` rule inside `pageCss`:

```css
      margin: 0 auto;
      max-width: calc(100% - ${prefs.margin * 2}px);
```

- [ ] **Step 3: Mount the popover in the reader header**

In `ReaderView.tsx`, add `const [prefsOpen, setPrefsOpen] = useState(false)` (importing `useState`), a header button before the percent readout:

```tsx
        <button onClick={() => setPrefsOpen((v) => !v)} aria-label="Typography" className="rounded p-1.5 text-parchment-400 hover:bg-ink-800 hover:text-gold-400">
          <span className="font-display text-base leading-none">Aa</span>
        </button>
```

and, just before the closing `</div>` of the overlay:

```tsx
      {prefsOpen && <ReaderPrefsPopover onClose={() => setPrefsOpen(false)} />}
```

Import it at the top.

- [ ] **Step 4: Wire double-click in the grid**

In `src/components/library/BookCard.tsx`, add to the card `<button>` alongside its existing `onClick`:

```tsx
        onDoubleClick={() => useReaderStore.getState().openBook(book)}
```

Import the store. Single click still selects — double-click opens.

- [ ] **Step 5: Wire double-click in the list**

In `src/components/library/ListView.tsx`, find the row element carrying the existing `onClick={() => selectBook(book.id)}` and add the same `onDoubleClick` handler.

- [ ] **Step 6: Replace the temporary detail-panel button**

In `src/components/library/BookDetail.tsx`, replace the temporary button from Task 8 Step 7 with a real primary action in the actions row (matching the styling of its siblings), using `ReaderIcon` and the label "Read":

```tsx
          <button
            onClick={() => useReaderStore.getState().openBook(book)}
            className="flex items-center gap-2 rounded border border-ink-600 px-3 py-2 text-sm text-parchment-200 hover:border-gold-500 hover:text-gold-400"
          >
            <ReaderIcon className="h-4 w-4" />
            Read
          </button>
```

- [ ] **Step 7: Add the context-menu item**

In `src/components/library/BookContextMenu.tsx`, add a "Read" item as the first entry. Copy the `className` string verbatim from the existing "View details" item in that file so the new item is styled identically — the menu items share one long Tailwind string, and retyping it from memory is how a single item ends up subtly different:

```tsx
        <button
          role="menuitem"
          onClick={() => {
            useReaderStore.getState().openBook(book)
            closeContextMenu()
          }}
          className="<paste the View details item's className here>"
        >
          <ReaderIcon className="h-4 w-4" />
          Read
        </button>
```

- [ ] **Step 8: Stop library navigation while the reader is open**

In `src/hooks/useBookNavigation.ts`, the guard at line ~103 bails when a modal or dialog owns the keyboard. The reader must join it, or arrow keys would page the book and move the library selection underneath simultaneously.

Add near the other store reads:

```ts
  const readerBookId = useReaderStore((s) => s.bookId)
```

Extend the guard:

```ts
    if (!ready || modal || contextMenu || deletingBookId || editingBookId || readerBookId) return
```

and add `readerBookId` to that effect's dependency array (alongside `modal`, `contextMenu`, `deletingBookId`, `editingBookId`).

- [ ] **Step 9: Verify (manual)**

```bash
npm run typecheck && npm run lint && npm test
npm run dev
```

Confirm, in the running app:

1. Double-click a book in the grid, and in the list — the reader opens; single click still only selects.
2. The detail panel's Read button and the context menu's Read item both open it.
3. Double-click a **PDF-only** book — Preview opens, no reader, no error.
4. Typography: changing typeface, size, line height, margin, and theme all restyle the page live, and survive quitting and relaunching the app.
5. With the reader open, arrow keys page the book and do **not** move the library selection behind it.
6. Close the reader, reopen the same book — it resumes.

- [ ] **Step 10: Commit**

```bash
git add src/components/reader src/components/library src/hooks/useBookNavigation.ts
git commit -m "feat: reader entry points and typography controls"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `tasks.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a Reader section to CLAUDE.md**

Insert after the "Opening files outside Musaeum" section, matching the surrounding voice — these sections explain *why*, not *what*:

```markdown
### Reading in the app

`components/reader/ReaderView.tsx` over a **vendored** foliate-js
(`vendor/foliate-js/`, see its VENDORED.md — do not install the npm package,
which is a stale third-party republish). EPUB, MOBI, and AZW3; PDF is C2 and
falls through to `files.openBookFile` today, as does any file the engine
rejects, so every entry point does something for every book.

Book bytes reach the renderer over **`musaeum://book/{bookId}/{format}`**,
resolved by `services/book-bytes.ts` — **by extension**, like every other file
lookup, so a book renamed after import still opens. The path rules live in
that service rather than the protocol handler so they can be tested without
Electron.

**Reading position is tiered, because the three stores cost different
amounts** (`services/reading-state.ts`, which owns the whole policy):

| trigger | SQLite | metadata.json | catalog.json |
|---|---|---|---|
| page turn (debounced 2s) | yes | if >30s since last | no |
| reader close, app quit | yes | yes | yes |

`catalog.json` is a whole-library rewrite, so piggybacking it on a 30s
throttle would push ~10MB over SMB every half minute of reading. Position is
therefore machine-local between sessions and syncs at session boundaries,
which is what the one-machine-at-a-time model already assumes. `will-quit`
flushes anything outstanding.

`position` is **opaque** — an EPUB CFI, whatever mobi.js yields, a page number
in C2 — and `percent` is the portable fallback when a position no longer
resolves. That is what lets one schema serve three engines.

`read_status` **only ever advances** (`unread → reading` on first save,
`reading → read` at ≥98%, never back), which is what makes a manual override
stick.

Offline is deliberately **not** an error here: NAS writes are skipped and
logged while SQLite keeps recording. Unlike `updateBook`, this path does not
`assertOnline()` — interrupting someone mid-chapter because a share dropped
is the wrong trade.

Reading state rides in `metadata.json` and therefore through `catalog.json`,
so `metadataJsonToBook` and `replaceAllBooks` must carry it — the same
load-bearing propagation the sort keys need, and with the same failure mode
if missed: silent erasure on the next connect.
```

- [ ] **Step 2: Update the IPC surface listing in CLAUDE.md**

Add to the `MusaeumAPI` block, after the `files` group:

```typescript
  reader: {
    saveProgress(report: ProgressReport): Promise<void>   // tiered write; see above
  }
```

Also add `reading_state` to the documented `metadata.json` shape, and the three `reading_*` columns to the `books` DDL in the SQLite Schema section.

- [ ] **Step 3: Update tasks.md**

- Mark the "Open the stored book file from the app" item `[x]`, noting the reader shipped for epub/mobi/azw3 and that PDF is C2.
- Under Post-MVP, change "In-app reader / annotations" to note the reader shipped and only annotations remain.
- Add a **C2 — PDF in the reader** entry describing what is left: pdf.js into the existing shell, page-number positions in the same `reading_state` schema, fit-width/fit-page and zoom.
- Add follow-ups found in this build: no search-in-book, no bookmarks, no per-book typography, and the "Enter to open" item stays open (deliberately excluded).

- [ ] **Step 4: Update CHANGELOG.md**

Add a dated `## [Unreleased] — 2026-08-13` section above the 2026-08-12 entry, in the established voice — what changed and why it mattered, not a list of files:

```markdown
### Added
- **Books open inside Musaeum.** A full-window reader renders EPUB, MOBI, and
  AZW3 through a vendored foliate-js; double-click a book, use the detail
  panel's Read button, or the context menu. PDFs still open in Preview, and so
  does anything the engine can't render, so every book responds to the same
  gesture. Typography — typeface, size, line height, margin, and a paper or
  ink page theme — is remembered per machine.
- **Reading position follows you.** Where you left off is stored in the book's
  metadata.json and travels through catalog.json to any other machine. The
  three stores are written on different clocks, because they cost very
  different amounts: SQLite on every page turn, metadata.json on a 30-second
  throttle, and the whole-library catalog only when you close the reader.
  Piggybacking the catalog on the throttle, as the original design had it,
  would have pushed ~10MB over SMB every half minute of reading.
- Books mark themselves read: opening one starts it, passing 98% finishes it.
  The transition only ever moves forward, so marking a book read by hand
  sticks even if you open it again.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md tasks.md CHANGELOG.md
git commit -m "docs: record the native reader"
```

---

## Final verification

- [ ] `npm test` — all suites pass
- [ ] `npm run typecheck && npm run lint` — clean
- [ ] `npm run build` — succeeds
- [ ] Manual pass against the real library: an image-heavy EPUB, a fixed-layout EPUB, a footnote-heavy EPUB, one azw3, one mobi, and a PDF-only book (falls through to Preview)
- [ ] Position survives close/reopen, and survives quitting and relaunching the app
- [ ] Disconnect the NAS mid-read: reading continues, no error dialog, and position still advances in the library view
- [ ] No CSP violations in the DevTools console
