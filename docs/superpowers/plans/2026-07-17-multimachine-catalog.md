# Multi-Machine Library Access (Section B — catalog.json) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any machine pointed at the NAS library root sees the full library within seconds, kept current through a `catalog.json` derived cache — implementing Section B of `docs/superpowers/specs/2026-07-14-pdf-multimachine-reader-design.md`.

**Architecture:** A `catalog.json` file at `{library_root}` holds a flattened array of every book record (the shared `Book` shape) plus `version`/`generated_at`. Every path that writes a book's `metadata.json` also upserts that book into the catalog (bulk operations batch one write at the end); on launch/connect and on manual "Refresh Library" the local SQLite `books` table is transactionally replaced from the catalog. The per-book `metadata.json` files remain canonical: a "Rebuild Catalog" recovery action walks `books/*/metadata.json` and rewrites the catalog. Last-write-wins; single-user, one-machine-at-a-time.

**Tech Stack:** Electron main process (TypeScript, better-sqlite3), vitest for main-process tests (new), React/Zustand renderer.

## Global Constraints

- TypeScript strict mode; no `any`; shared contracts live in `src/types/` (`@shared/*` alias).
- All business logic in `electron/main/services/`; IPC handlers stay thin and go through `ipc/handle.ts` (`IPCResult` envelope; never throw across IPC).
- Renderer never touches the NAS/filesystem directly — always via `window.Musaeum`.
- `npm run typecheck` and `npm run lint` must stay clean.
- better-sqlite3 is rebuilt for Electron's ABI (postinstall), so **tests must run through Electron-as-Node**: `npm test` = `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`. Never run `npx vitest` directly (ABI mismatch).
- The `electron` module is aliased to `test/mocks/electron.ts` in vitest config; tests exercise real fs (temp dirs) and real SQLite.
- Work on branch `multimachine-catalog` (create via superpowers:using-git-worktrees at execution start). Commit after every task.
- Catalog contract: `{ "version": 1, "generated_at": ISO-8601, "books": Book[] }` — `Book` is the camelCase shape in `src/types/book.types.ts`. File name: `catalog.json` at the library root. Writes are atomic (`catalog.json.part` + rename) and serialized through an in-process queue.

---

### Task 1: Vitest harness

**Files:**
- Create: `vitest.config.ts`
- Create: `src/types/book.types.test.ts`
- Modify: `package.json` (add `test` script + `vitest` devDependency)

**Interfaces:**
- Produces: `npm test` runs vitest over `src/**`, `electron/**`, `test/**` with `@shared` and `electron` aliases. Later tasks add test files and rely on this exact setup.

- [ ] **Step 1: Install vitest**

```bash
npm install --save-dev vitest@^3.2.4
```

Note: postinstall re-runs electron-rebuild for better-sqlite3 — that is expected and required.

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Tests run through Electron-as-Node (see the `test` script) because
// better-sqlite3 is rebuilt for Electron's ABI. The `electron` alias keeps
// main-process modules importable without a running Electron app.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/types'),
      electron: resolve(__dirname, 'test/mocks/electron.ts')
    }
  },
  test: {
    environment: 'node',
    pool: 'forks',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts', 'test/**/*.test.ts']
  }
})
```

(`test/mocks/electron.ts` is created in Task 4 — until then no test imports `electron`, so the dangling alias is harmless.)

- [ ] **Step 3: Add the test script to `package.json`**

In `"scripts"`, after `"lint"`:

```json
    "test": "ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run",
```

- [ ] **Step 4: Write a harness-proving test** (`src/types/book.types.test.ts`)

This is infrastructure verification, not TDD of new behavior — `seriesDisplay` already exists and is pure.

```typescript
import { describe, expect, it } from 'vitest'
import { seriesDisplay } from './book.types'

describe('seriesDisplay', () => {
  it('drops the trailing .0 on whole-number indices', () => {
    expect(seriesDisplay('The Expanse', 1.0)).toBe('The Expanse #1')
  })

  it('keeps fractional indices', () => {
    expect(seriesDisplay('The Expanse', 0.5)).toBe('The Expanse #0.5')
  })

  it('returns the bare name when index is null', () => {
    expect(seriesDisplay('The Expanse', null)).toBe('The Expanse')
  })
})
```

- [ ] **Step 5: Run and verify**

Run: `npm test` Expected: 3 passing tests, exit 0.

Also run: `npm run typecheck && npm run lint` — both clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/types/book.types.test.ts
git commit -m "test: vitest harness via Electron-as-Node (better-sqlite3 ABI)"
```

---

### Task 2: Catalog core — read/write/merge with serialized writes

**Files:**
- Create: `electron/main/services/catalog.ts`
- Create: `test/helpers/book.ts` (shared test fixture — never import fixtures from a `.test.ts` file: that re-registers the exporter's tests inside the importer)
- Test: `electron/main/services/catalog.test.ts`

**Interfaces:**
- Consumes: `Book` from `@shared/book.types`. No electron imports in this module — keep it that way so it stays unit-testable.
- Produces (used by Tasks 3, 5):
  - `CATALOG_FILENAME = 'catalog.json'`, `CATALOG_VERSION = 1`
  - `interface CatalogFile { version: number; generated_at: string; books: Book[] }`
  - `catalogPath(root: string): string`
  - `readCatalog(root: string): Promise<CatalogFile | null>` — null on missing/unparsable/wrong-version
  - `writeCatalog(root: string, books: Book[]): Promise<void>` — atomic, NOT queued (internal building block)
  - `mergeBooks(current: Book[], updates: Book[]): Book[]`
  - `upsertIntoCatalog(root: string, updates: Book[], fallback: () => Book[]): Promise<void>` — queued
  - `removeFromCatalog(root: string, bookId: string, fallback: () => Book[]): Promise<void>` — queued
  - `replaceCatalog(root: string, books: Book[]): Promise<void>` — queued

- [ ] **Step 1: Create the shared fixture** (`test/helpers/book.ts`)

```typescript
import type { Book } from '@shared/book.types'

export function makeBook(id: string, title = `Book ${id}`): Book {
  return {
    id,
    title,
    sortTitle: null,
    author: null,
    authorSort: null,
    publisher: null,
    publishedDate: null,
    language: null,
    description: null,
    isbn10: null,
    isbn13: null,
    goodreadsId: null,
    openlibraryId: null,
    seriesName: null,
    seriesIndex: null,
    seriesTotal: null,
    coverThumbPath: null,
    coverFullPath: null,
    formats: ['epub'],
    tags: [],
    rating: null,
    dateAdded: null,
    lastModified: null,
    fileSizeBytes: null,
    readStatus: 'unread',
    nasPath: `books/${id}`
  }
}
```

- [ ] **Step 2: Write failing tests** (`electron/main/services/catalog.test.ts`)

```typescript
import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import {
  CATALOG_VERSION,
  catalogPath,
  mergeBooks,
  readCatalog,
  removeFromCatalog,
  replaceCatalog,
  upsertIntoCatalog,
  writeCatalog
} from './catalog'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'musaeum-catalog-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readCatalog', () => {
  it('returns null when no catalog exists', async () => {
    expect(await readCatalog(root)).toBeNull()
  })

  it('round-trips books through writeCatalog', async () => {
    await writeCatalog(root, [makeBook('a'), makeBook('b')])
    const cat = await readCatalog(root)
    expect(cat?.version).toBe(CATALOG_VERSION)
    expect(cat?.generated_at).toBeTruthy()
    expect(cat?.books.map((b) => b.id)).toEqual(['a', 'b'])
  })

  it('returns null for unparsable JSON', async () => {
    await fs.writeFile(catalogPath(root), 'not json{', 'utf8')
    expect(await readCatalog(root)).toBeNull()
  })

  it('returns null for an unknown version', async () => {
    await fs.writeFile(catalogPath(root), JSON.stringify({ version: 99, books: [] }), 'utf8')
    expect(await readCatalog(root)).toBeNull()
  })

  it('leaves no .part file behind after writing', async () => {
    await writeCatalog(root, [makeBook('a')])
    await expect(fs.access(`${catalogPath(root)}.part`)).rejects.toThrow()
  })
})

describe('mergeBooks', () => {
  it('replaces entries by id and appends new ones', () => {
    const current = [makeBook('a', 'Old A'), makeBook('b')]
    const merged = mergeBooks(current, [makeBook('a', 'New A'), makeBook('c')])
    expect(merged.map((b) => b.id).sort()).toEqual(['a', 'b', 'c'])
    expect(merged.find((b) => b.id === 'a')?.title).toBe('New A')
  })
})

describe('upsertIntoCatalog', () => {
  it('creates the catalog from fallback when missing', async () => {
    await upsertIntoCatalog(root, [makeBook('new')], () => [makeBook('local')])
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id).sort()).toEqual(['local', 'new'])
  })

  it('merges into the existing catalog and ignores fallback', async () => {
    await writeCatalog(root, [makeBook('a')])
    await upsertIntoCatalog(root, [makeBook('b')], () => [makeBook('should-not-appear')])
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id).sort()).toEqual(['a', 'b'])
  })

  it('serializes concurrent upserts (none lost)', async () => {
    await writeCatalog(root, [])
    const ids = Array.from({ length: 10 }, (_, i) => `bk-${i}`)
    await Promise.all(ids.map((id) => upsertIntoCatalog(root, [makeBook(id)], () => [])))
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id).sort()).toEqual([...ids].sort())
  })
})

describe('removeFromCatalog', () => {
  it('removes the entry by id', async () => {
    await writeCatalog(root, [makeBook('a'), makeBook('b')])
    await removeFromCatalog(root, 'a', () => [])
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id)).toEqual(['b'])
  })
})

describe('replaceCatalog', () => {
  it('overwrites the whole catalog', async () => {
    await writeCatalog(root, [makeBook('a')])
    await replaceCatalog(root, [makeBook('x'), makeBook('y')])
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id)).toEqual(['x', 'y'])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test electron/main/services/catalog.test.ts` Expected: FAIL — cannot resolve `./catalog`.

- [ ] **Step 4: Implement `electron/main/services/catalog.ts`**

```typescript
import { promises as fs } from 'fs'
import { join } from 'path'
import type { Book } from '@shared/book.types'

export const CATALOG_FILENAME = 'catalog.json'
export const CATALOG_VERSION = 1

/**
 * catalog.json at the library root: a derived, regenerable cache of every
 * book's metadata.json, read on launch so a machine never has to walk
 * thousands of book folders over SMB. The per-book metadata.json files
 * remain canonical — losing or corrupting the catalog is never data loss.
 */
export interface CatalogFile {
  version: number
  generated_at: string
  books: Book[]
}

export function catalogPath(root: string): string {
  return join(root, CATALOG_FILENAME)
}

export async function readCatalog(root: string): Promise<CatalogFile | null> {
  let raw: string
  try {
    raw = await fs.readFile(catalogPath(root), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as CatalogFile
    if (parsed.version !== CATALOG_VERSION || !Array.isArray(parsed.books)) return null
    return parsed
  } catch {
    return null
  }
}

/** Atomic write: .part then rename, so a crash never leaves a torn catalog. */
export async function writeCatalog(root: string, books: Book[]): Promise<void> {
  const file: CatalogFile = {
    version: CATALOG_VERSION,
    generated_at: new Date().toISOString(),
    books
  }
  const target = catalogPath(root)
  await fs.writeFile(`${target}.part`, JSON.stringify(file), 'utf8')
  await fs.rename(`${target}.part`, target)
}

export function mergeBooks(current: Book[], updates: Book[]): Book[] {
  const byId = new Map(current.map((b) => [b.id, b]))
  for (const b of updates) byId.set(b.id, b)
  return [...byId.values()]
}

// All catalog mutations funnel through one promise chain — concurrent
// imports would otherwise interleave their read-modify-write cycles
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

/**
 * Upsert books into the catalog. When the catalog is missing or unreadable,
 * `fallback` supplies the base list (callers pass the local cache) so a
 * fresh catalog is complete rather than containing only the upserted books.
 */
export function upsertIntoCatalog(
  root: string,
  updates: Book[],
  fallback: () => Book[]
): Promise<void> {
  return enqueue(async () => {
    const current = (await readCatalog(root))?.books ?? fallback()
    await writeCatalog(root, mergeBooks(current, updates))
  })
}

export function removeFromCatalog(
  root: string,
  bookId: string,
  fallback: () => Book[]
): Promise<void> {
  return enqueue(async () => {
    const current = (await readCatalog(root))?.books ?? fallback()
    await writeCatalog(
      root,
      current.filter((b) => b.id !== bookId)
    )
  })
}

/** Wholesale rewrite (bulk operations, rebuild). */
export function replaceCatalog(root: string, books: Book[]): Promise<void> {
  return enqueue(() => writeCatalog(root, books))
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test electron/main/services/catalog.test.ts` Expected: all PASS. Then `npm test` — everything green.

- [ ] **Step 6: Commit**

```bash
git add test/helpers/book.ts electron/main/services/catalog.ts electron/main/services/catalog.test.ts
git commit -m "feat: catalog.json core — atomic, serialized read/merge/write"
```

---

### Task 3: Rebuild — metadata.json walk → Book records

**Files:**
- Modify: `electron/main/services/catalog.ts` (append)
- Test: `electron/main/services/catalog.test.ts` (append)

**Interfaces:**
- Produces (used by Task 5):
  - `interface MetadataJson` (exported, matches `importer.writeMetadataJson` output)
  - `metadataJsonToBook(json: MetadataJson, dirName: string, bookDir: string): Promise<Book>`
  - `interface RebuildProgress { completed: number; total: number }`
  - `rebuildFromBookDirs(root: string, onProgress?: (p: RebuildProgress) => void): Promise<Book[]>` — walks `{root}/books/*/metadata.json`, skips broken folders with a console.error, writes the catalog via `replaceCatalog`, returns the books.

- [ ] **Step 1: Append failing tests to `catalog.test.ts`**

```typescript
import { metadataJsonToBook, rebuildFromBookDirs, type MetadataJson } from './catalog'

function makeMetadataJson(id: string, title = `Book ${id}`): MetadataJson {
  return {
    id,
    title,
    sort_title: title,
    authors: [{ name: 'Jane Author', sort: 'Author, Jane' }],
    publisher: 'Orbit',
    published_date: '2011-06-02',
    language: 'en',
    description: 'desc',
    identifiers: { isbn_13: '9780316129084' },
    series: { name: 'The Expanse', index: 1, total: 9 },
    tags: ['sf'],
    cover: { full: 'cover_full.jpg', thumb: 'cover_thumb.jpg' },
    formats: ['epub', 'pdf'],
    rating: null,
    read_status: 'unread',
    date_added: '2025-01-15T10:30:00Z',
    last_modified: '2025-01-15T10:31:00Z'
  }
}

async function writeBookDir(id: string, json: MetadataJson | string): Promise<string> {
  const dir = join(root, 'books', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    join(dir, 'metadata.json'),
    typeof json === 'string' ? json : JSON.stringify(json),
    'utf8'
  )
  return dir
}

describe('metadataJsonToBook', () => {
  it('maps the canonical metadata.json shape onto Book', async () => {
    const dir = await writeBookDir('uuid-1', makeMetadataJson('uuid-1', 'Leviathan Wakes'))
    await fs.writeFile(join(dir, 'Leviathan Wakes.epub'), 'x'.repeat(100))
    await fs.writeFile(join(dir, 'Leviathan Wakes.pdf'), 'y'.repeat(50))
    const book = await metadataJsonToBook(makeMetadataJson('uuid-1', 'Leviathan Wakes'), 'uuid-1', dir)
    expect(book).toMatchObject({
      id: 'uuid-1',
      title: 'Leviathan Wakes',
      author: 'Jane Author',
      authorSort: 'Author, Jane',
      isbn13: '9780316129084',
      seriesName: 'The Expanse',
      seriesIndex: 1,
      seriesTotal: 9,
      coverFullPath: 'cover_full.jpg',
      coverThumbPath: 'cover_thumb.jpg',
      formats: ['epub', 'pdf'],
      tags: ['sf'],
      readStatus: 'unread',
      nasPath: join('books', 'uuid-1'),
      fileSizeBytes: 150
    })
  })

  it('tolerates minimal metadata and unknown formats', async () => {
    const dir = await writeBookDir('uuid-2', { id: 'uuid-2', title: 'Bare' })
    const book = await metadataJsonToBook(
      { id: 'uuid-2', title: 'Bare', formats: ['epub', 'cbz'] },
      'uuid-2',
      dir
    )
    expect(book.author).toBeNull()
    expect(book.formats).toEqual(['epub'])
    expect(book.readStatus).toBe('unread')
    expect(book.fileSizeBytes).toBeNull()
  })
})

describe('rebuildFromBookDirs', () => {
  it('walks book dirs, writes the catalog, reports progress, skips broken folders', async () => {
    await writeBookDir('uuid-1', makeMetadataJson('uuid-1'))
    await writeBookDir('uuid-2', makeMetadataJson('uuid-2'))
    await writeBookDir('uuid-broken', '{not json')
    const seen: number[] = []
    const books = await rebuildFromBookDirs(root, (p) => seen.push(p.completed))
    expect(books.map((b) => b.id).sort()).toEqual(['uuid-1', 'uuid-2'])
    expect(seen).toEqual([1, 2, 3])
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id).sort()).toEqual(['uuid-1', 'uuid-2'])
  })

  it('returns an empty catalog for a root with no books dir', async () => {
    const books = await rebuildFromBookDirs(root)
    expect(books).toEqual([])
    expect((await readCatalog(root))?.books).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test electron/main/services/catalog.test.ts` Expected: FAIL — `metadataJsonToBook` / `rebuildFromBookDirs` not exported.

- [ ] **Step 3: Append the implementation to `catalog.ts`**

Add `extname` and `Dirent` to the imports at the top:

```typescript
import { promises as fs } from 'fs'
import type { Dirent } from 'fs'
import { extname, join } from 'path'
import type { Book, BookFormat, ReadStatus } from '@shared/book.types'
```

Then append:

```typescript
/** The canonical per-book metadata.json shape (writer: importer.writeMetadataJson). */
export interface MetadataJson {
  id: string
  title: string
  sort_title?: string | null
  authors?: { name: string; sort?: string | null }[]
  publisher?: string | null
  published_date?: string | null
  language?: string | null
  description?: string | null
  identifiers?: {
    isbn_10?: string | null
    isbn_13?: string | null
    goodreads?: string | null
    openlibrary?: string | null
  }
  series?: { name: string; index: number | null; total?: number | null } | null
  tags?: string[]
  cover?: { full?: string | null; thumb?: string | null } | null
  formats?: string[]
  rating?: number | null
  read_status?: string
  date_added?: string | null
  last_modified?: string | null
}

const VALID_FORMATS = new Set(['epub', 'mobi', 'azw3', 'pdf'])
const READ_STATUSES = new Set(['unread', 'reading', 'read'])

export async function metadataJsonToBook(
  json: MetadataJson,
  dirName: string,
  bookDir: string
): Promise<Book> {
  // metadata.json doesn't carry file sizes — sum the book files on disk
  let fileSizeBytes: number | null = null
  try {
    let total = 0
    for (const f of await fs.readdir(bookDir)) {
      if (!VALID_FORMATS.has(extname(f).toLowerCase().slice(1))) continue
      total += (await fs.stat(join(bookDir, f))).size
    }
    fileSizeBytes = total > 0 ? total : null
  } catch {
    // unreadable dir — size stays unknown
  }

  return {
    id: json.id || dirName,
    title: json.title,
    sortTitle: json.sort_title ?? null,
    author: json.authors?.[0]?.name ?? null,
    authorSort: json.authors?.[0]?.sort ?? null,
    publisher: json.publisher ?? null,
    publishedDate: json.published_date ?? null,
    language: json.language ?? null,
    description: json.description ?? null,
    isbn10: json.identifiers?.isbn_10 ?? null,
    isbn13: json.identifiers?.isbn_13 ?? null,
    goodreadsId: json.identifiers?.goodreads ?? null,
    openlibraryId: json.identifiers?.openlibrary ?? null,
    seriesName: json.series?.name ?? null,
    seriesIndex: json.series?.index ?? null,
    seriesTotal: json.series?.total ?? null,
    coverThumbPath: json.cover?.thumb ?? null,
    coverFullPath: json.cover?.full ?? null,
    formats: (json.formats ?? []).filter((f): f is BookFormat => VALID_FORMATS.has(f)),
    tags: json.tags ?? [],
    rating: json.rating ?? null,
    dateAdded: json.date_added ?? null,
    lastModified: json.last_modified ?? null,
    fileSizeBytes,
    readStatus: (READ_STATUSES.has(json.read_status ?? '') ? json.read_status : 'unread') as ReadStatus,
    nasPath: join('books', dirName)
  }
}

export interface RebuildProgress {
  completed: number
  total: number
}

/**
 * Recovery path: walk every books/&#42;/metadata.json and rewrite the catalog.
 * Slow over SMB (minutes at library scale) — only run on user request or
 * when no catalog exists.
 */
export async function rebuildFromBookDirs(
  root: string,
  onProgress?: (p: RebuildProgress) => void
): Promise<Book[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(join(root, 'books'), { withFileTypes: true })
  } catch {
    entries = []
  }
  const dirs = entries.filter((e) => e.isDirectory())
  const books: Book[] = []
  let completed = 0
  for (const dir of dirs) {
    const bookDir = join(root, 'books', dir.name)
    try {
      const raw = await fs.readFile(join(bookDir, 'metadata.json'), 'utf8')
      const json = JSON.parse(raw) as MetadataJson
      books.push(await metadataJsonToBook(json, dir.name, bookDir))
    } catch (err) {
      console.error(`[catalog] rebuild: skipping ${dir.name}:`, err)
    }
    completed++
    onProgress?.({ completed, total: dirs.length })
  }
  await replaceCatalog(root, books)
  return books
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test electron/main/services/catalog.test.ts` Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main/services/catalog.ts electron/main/services/catalog.test.ts
git commit -m "feat: catalog rebuild — metadata.json walk with progress"
```

---

### Task 4: `db.replaceAllBooks` + the electron test mock

**Files:**
- Create: `test/mocks/electron.ts`
- Modify: `electron/main/services/db.ts` (append one function)
- Test: `electron/main/services/db.test.ts`

**Interfaces:**
- Produces: `replaceAllBooks(books: Book[]): void` in `electron/main/services/db.ts` — transactionally swaps the whole `books` table, tolerates `device_history` rows referencing vanished books (FKs disabled for the swap, restored after), and prunes `metadata_conflicts` / `book_collections` orphans. FTS stays in sync via the existing triggers.
- Produces: `test/mocks/electron.ts` — the vitest stand-in for `electron` (aliased in Task 1's config). Exports `app.getPath('userData')` → per-process temp dir; inert `ipcMain`, `dialog`, `shell`, `protocol`, `net`, `BrowserWindow`.

- [ ] **Step 1: Create `test/mocks/electron.ts`**

```typescript
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Minimal Electron surface for vitest runs (aliased in vitest.config.ts).
// Each worker process gets its own throwaway userData dir, so tests touch
// a real better-sqlite3 database without a real Electron app.
const userData = mkdtempSync(join(tmpdir(), 'musaeum-vitest-'))

export const app = {
  getPath: (name: string): string => (name === 'userData' ? userData : tmpdir()),
  setPath: (): void => undefined,
  whenReady: (): Promise<void> => Promise.resolve(),
  on: (): void => undefined
}

export const ipcMain = { handle: (): void => undefined }
export const dialog = {}
export const shell = {}
export const net = {}
export const protocol = {
  registerSchemesAsPrivileged: (): void => undefined,
  handle: (): void => undefined
}
export class BrowserWindow {}
```

- [ ] **Step 2: Write failing tests** (`electron/main/services/db.test.ts`)

```typescript
import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import {
  closeDb,
  getBooks,
  getDb,
  getUnresolvedConflictCount,
  insertBook,
  insertConflict,
  logDeviceTransfer,
  replaceAllBooks,
  searchBooks
} from './db'

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
})

describe('replaceAllBooks', () => {
  it('swaps the whole table: removes, updates, inserts', () => {
    insertBook(makeBook('a', 'Alpha'))
    insertBook(makeBook('b', 'Beta'))
    replaceAllBooks([makeBook('b', 'Beta Revised'), makeBook('c', 'Gamma')])
    const byId = new Map(getBooks().map((bk) => [bk.id, bk]))
    expect([...byId.keys()].sort()).toEqual(['b', 'c'])
    expect(byId.get('b')?.title).toBe('Beta Revised')
  })

  it('keeps FTS in sync through the swap', () => {
    insertBook(makeBook('a', 'Distinctive Alpha Title'))
    replaceAllBooks([makeBook('c', 'Unmistakable Gamma Title')])
    expect(searchBooks('Unmistakable').map((b) => b.id)).toEqual(['c'])
    expect(searchBooks('Distinctive')).toEqual([])
  })

  it('tolerates device_history rows for books that vanish', () => {
    insertBook(makeBook('a'))
    logDeviceTransfer('a', 'kindle-1', 'Kindle', 'epub')
    expect(() => replaceAllBooks([makeBook('c')])).not.toThrow()
    const history = getDb().prepare('SELECT book_id FROM device_history').all() as {
      book_id: string
    }[]
    expect(history).toEqual([{ book_id: 'a' }])
  })

  it('prunes conflicts for removed books and keeps the rest', () => {
    insertBook(makeBook('a'))
    insertBook(makeBook('b'))
    insertConflict('a', 'title', [{ source: 'google_books', value: 'X' }])
    insertConflict('b', 'title', [{ source: 'google_books', value: 'Y' }])
    replaceAllBooks([makeBook('b')])
    expect(getUnresolvedConflictCount()).toBe(1)
  })

  it('re-enables foreign keys afterwards', () => {
    replaceAllBooks([])
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test electron/main/services/db.test.ts` Expected: FAIL — `replaceAllBooks` is not exported.

- [ ] **Step 4: Implement `replaceAllBooks` in `db.ts`** (append after `findByTitleAuthor`)

```typescript
/**
 * Replace the entire local cache with the catalog's view of the library.
 * device_history may reference books that no longer exist (they were sent
 * from this machine, then deleted elsewhere) — history is kept, so FKs are
 * disabled for the swap. Conflict/collection rows for vanished books are
 * pruned; FTS follows via the existing triggers.
 */
export function replaceAllBooks(books: Book[]): void {
  const d = getDb()
  d.pragma('foreign_keys = OFF')
  try {
    d.transaction(() => {
      d.prepare('DELETE FROM books').run()
      for (const b of books) insertBook(b)
      d.prepare(
        'DELETE FROM metadata_conflicts WHERE book_id NOT IN (SELECT id FROM books)'
      ).run()
      d.prepare(
        'DELETE FROM book_collections WHERE book_id NOT IN (SELECT id FROM books)'
      ).run()
    })()
  } finally {
    d.pragma('foreign_keys = ON')
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test electron/main/services/db.test.ts` Expected: all PASS. Then `npm test` for the full suite.

- [ ] **Step 6: Commit**

```bash
git add test/mocks/electron.ts electron/main/services/db.ts electron/main/services/db.test.ts
git commit -m "feat: db.replaceAllBooks — transactional cache swap from catalog"
```

---

### Task 5: library-sync service, IPC surface, launch wiring, adoption dialog

**Files:**
- Create: `electron/main/services/library-sync.ts`
- Test: `electron/main/services/library-sync.test.ts`
- Modify: `src/types/api.types.ts` (library methods + event channel)
- Modify: `electron/preload/index.ts`
- Modify: `electron/main/ipc/library.ts` (two new handlers)
- Modify: `electron/main/ipc/nas.ts` (adoption dialog + sync on setLibraryRoot)
- Modify: `electron/main/index.ts` (on-connect hook)

**Interfaces:**
- Consumes: Task 2/3 catalog functions, Task 4 `db.replaceAllBooks`.
- Produces (used by Tasks 6, 7) from `electron/main/services/library-sync.ts`:
  - `upsertCatalog(books: Book[]): void` — fire-and-forget, no-op when offline/unconfigured
  - `removeBookFromCatalog(bookId: string): void` — fire-and-forget
  - `writeFullCatalog(root?: string | null): void` — fire-and-forget bulk rewrite from the local cache
  - `skipRoot(root: string): void`
  - `applyCatalog(root: string): Promise<number>`
  - `syncOnConnect(): Promise<void>`
  - `refreshLibrary(): Promise<{ books: number }>`
  - `rebuildCatalog(): Promise<{ books: number }>`
  - `resetForTests(): void`, `flushForTests(): Promise<unknown>` (awaits fire-and-forget writes)
- Produces renderer API: `library.refreshLibrary(): Promise<{ books: number }>`, `library.rebuildCatalog(): Promise<{ books: number }>`, `on.catalogRebuildProgress(cb: (p: { completed: number; total: number }) => void): Unsubscribe`, `EVENT_CHANNELS.catalogRebuildProgress = 'event:catalog-rebuild-progress'`.

- [ ] **Step 1: Write failing tests** (`electron/main/services/library-sync.test.ts`)

`nas-manager` works against real paths (temp dirs mount as "connected") and `events.broadcast` is a safe no-op without a window, so this is a real integration test of the sync flows.

```typescript
import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { readCatalog, writeCatalog } from './catalog'
import { closeDb, getBooks, insertBook } from './db'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'

let root: string

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  librarySync.resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-sync-'))
  await nas.setLibraryRoot(root) // temp dir exists → state becomes 'connected'
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('syncOnConnect', () => {
  it('adopts an existing catalog into the local cache', async () => {
    await writeCatalog(root, [makeBook('a'), makeBook('b')])
    await librarySync.syncOnConnect()
    expect(getBooks().map((b) => b.id).sort()).toEqual(['a', 'b'])
  })

  it('bootstraps the catalog from a non-empty local cache when missing', async () => {
    insertBook(makeBook('local-1'))
    await librarySync.syncOnConnect()
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id)).toEqual(['local-1'])
  })

  it('runs once per root per session', async () => {
    await writeCatalog(root, [makeBook('a')])
    await librarySync.syncOnConnect()
    insertBook(makeBook('locally-added'))
    await librarySync.syncOnConnect() // must not re-apply and wipe the new book
    expect(getBooks().length).toBe(2)
  })

  it('does not apply after skipRoot', async () => {
    await writeCatalog(root, [makeBook('a')])
    librarySync.skipRoot(root)
    await librarySync.syncOnConnect()
    expect(getBooks()).toEqual([])
  })
})

describe('applyCatalog', () => {
  it('replaces the cache and returns the count', async () => {
    insertBook(makeBook('stale'))
    await writeCatalog(root, [makeBook('a'), makeBook('b')])
    const count = await librarySync.applyCatalog(root)
    expect(count).toBe(2)
    expect(getBooks().map((b) => b.id).sort()).toEqual(['a', 'b'])
  })
})

describe('refreshLibrary', () => {
  it('reloads the cache from the catalog', async () => {
    await writeCatalog(root, [makeBook('a')])
    const result = await librarySync.refreshLibrary()
    expect(result).toEqual({ books: 1 })
    expect(getBooks().map((b) => b.id)).toEqual(['a'])
  })

  it('falls back to a rebuild walk when no catalog exists', async () => {
    const dir = join(root, 'books', 'uuid-9')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'metadata.json'), JSON.stringify({ id: 'uuid-9', title: 'Walked' }))
    const result = await librarySync.refreshLibrary()
    expect(result).toEqual({ books: 1 })
    expect(getBooks()[0]?.title).toBe('Walked')
    expect((await readCatalog(root))?.books.length).toBe(1)
  })
})

describe('upsertCatalog / removeBookFromCatalog', () => {
  it('are asynchronous no-op-safe helpers that land in the catalog', async () => {
    await writeCatalog(root, [makeBook('a')])
    librarySync.upsertCatalog([makeBook('b')])
    librarySync.removeBookFromCatalog('a')
    await librarySync.flushForTests()
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id)).toEqual(['b'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test electron/main/services/library-sync.test.ts` Expected: FAIL — cannot resolve `./library-sync`.

- [ ] **Step 3: Implement `electron/main/services/library-sync.ts`**

```typescript
import type { Book } from '@shared/book.types'
import * as catalog from './catalog'
import * as db from './db'
import { broadcast } from './events'
import * as nas from './nas-manager'

/**
 * Bridges catalog.json (NAS) and the local SQLite cache. Single-book writes
 * upsert asynchronously off the critical path; launch/connect and the manual
 * refresh/rebuild actions replace the local cache wholesale.
 */

// Roots already applied (or deliberately skipped) this session — reconnects
// must not re-apply and clobber books added since the first sync
const handledRoots = new Set<string>()

// Tracks in-flight fire-and-forget writes so tests (and shutdown) can await them
let pending: Promise<unknown> = Promise.resolve()
function track(p: Promise<unknown>): void {
  pending = pending.then(() => p.catch(() => undefined))
}

export function upsertCatalog(books: Book[]): void {
  const root = nas.getLibraryRoot()
  if (!root || !nas.isOnline() || books.length === 0) return
  track(
    catalog
      .upsertIntoCatalog(root, books, () => db.getBooks())
      .catch((err) => console.error('[catalog] upsert failed:', err))
  )
}

export function removeBookFromCatalog(bookId: string): void {
  const root = nas.getLibraryRoot()
  if (!root || !nas.isOnline()) return
  track(
    catalog
      .removeFromCatalog(root, bookId, () => db.getBooks())
      .catch((err) => console.error('[catalog] remove failed:', err))
  )
}

/** One batched write from the local cache — call at the end of bulk operations. */
export function writeFullCatalog(root: string | null = nas.getLibraryRoot()): void {
  if (!root) return
  track(
    catalog
      .replaceCatalog(root, db.getBooks())
      .catch((err) => console.error('[catalog] full write failed:', err))
  )
}

/** Hold off the automatic on-connect apply for this root (user chose "Not Now"). */
export function skipRoot(root: string): void {
  handledRoots.add(root)
}

/** Adopt the catalog at root as the local cache. Returns the book count. */
export async function applyCatalog(root: string): Promise<number> {
  const cat = await catalog.readCatalog(root)
  if (!cat) throw new Error('No readable catalog.json at the library root')
  db.replaceAllBooks(cat.books)
  handledRoots.add(root)
  broadcast('libraryChanged')
  return cat.books.length
}

/**
 * Once per session per root, when the library connects: adopt the catalog if
 * one exists; otherwise bootstrap it from a non-empty local cache (first
 * launch of a pre-catalog library).
 */
export async function syncOnConnect(): Promise<void> {
  const root = nas.getLibraryRoot()
  if (!root || !nas.isOnline() || handledRoots.has(root)) return
  handledRoots.add(root)
  try {
    const cat = await catalog.readCatalog(root)
    if (cat) {
      db.replaceAllBooks(cat.books)
      broadcast('libraryChanged')
    } else if (db.getBooks().length > 0) {
      await catalog.replaceCatalog(root, db.getBooks())
    }
  } catch (err) {
    console.error('[catalog] on-connect sync failed:', err)
  }
}

/** Manual refresh: re-read the catalog; walk-and-rebuild when it is missing. */
export async function refreshLibrary(): Promise<{ books: number }> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()!
  const cat = await catalog.readCatalog(root)
  if (!cat) return rebuildCatalog()
  db.replaceAllBooks(cat.books)
  handledRoots.add(root)
  broadcast('libraryChanged')
  return { books: cat.books.length }
}

/** Recovery: walk books/&#42;/metadata.json, rewrite the catalog, reload the cache. */
export async function rebuildCatalog(): Promise<{ books: number }> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()!
  const books = await catalog.rebuildFromBookDirs(root, (p) =>
    broadcast('catalogRebuildProgress', p)
  )
  db.replaceAllBooks(books)
  handledRoots.add(root)
  broadcast('libraryChanged')
  return { books: books.length }
}

/** Test-only helpers. */
export function resetForTests(): void {
  handledRoots.clear()
}
export function flushForTests(): Promise<unknown> {
  return pending
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test electron/main/services/library-sync.test.ts` Expected: all PASS.

- [ ] **Step 5: Extend the shared API contract** (`src/types/api.types.ts`)

In `MusaeumAPI.library`, after `getFacets`:

```typescript
    /** Re-read catalog.json into the local cache; rebuilds when missing. */
    refreshLibrary(): Promise<{ books: number }>
    /** Recovery: walk books/&#42;/metadata.json, rewrite catalog.json, reload. */
    rebuildCatalog(): Promise<{ books: number }>
```

In `MusaeumAPI.on`, after `libraryChanged`:

```typescript
    catalogRebuildProgress(cb: (p: { completed: number; total: number }) => void): Unsubscribe
```

In `EVENT_CHANNELS`, after `libraryChanged`:

```typescript
  catalogRebuildProgress: 'event:catalog-rebuild-progress'
```

- [ ] **Step 6: Extend the preload** (`electron/preload/index.ts`)

In `api.library`:

```typescript
    refreshLibrary: () => invoke('library:refreshLibrary'),
    rebuildCatalog: () => invoke('library:rebuildCatalog'),
```

In `api.on`:

```typescript
    catalogRebuildProgress: (cb) => listen(EVENT_CHANNELS.catalogRebuildProgress, cb),
```

- [ ] **Step 7: Register the IPC handlers** (`electron/main/ipc/library.ts`)

Add the import:

```typescript
import * as librarySync from '../services/library-sync'
```

Add inside `registerLibraryHandlers`, after `library:getFacets`:

```typescript
  handle('library:refreshLibrary', () => librarySync.refreshLibrary())
  handle('library:rebuildCatalog', () => librarySync.rebuildCatalog())
```

- [ ] **Step 8: Wire launch/connect + the adoption dialog**

`electron/main/index.ts` — add the import:

```typescript
import * as librarySync from './services/library-sync'
```

In `app.whenReady().then(...)`, immediately **before** `nas.startHealthChecks()`:

```typescript
  nas.onStatusChange((status) => {
    if (status.state === 'connected') void librarySync.syncOnConnect()
  })
```

`electron/main/ipc/nas.ts` — replace the whole file:

```typescript
import { dialog } from 'electron'
import * as catalog from '../services/catalog'
import * as librarySync from '../services/library-sync'
import * as nas from '../services/nas-manager'
import { handle } from './handle'

export function registerNASHandlers(): void {
  handle('nas:getStatus', () => nas.getStatus())
  handle('nas:reconnect', () => nas.reconnect())

  handle('nas:setLibraryRoot', async (path: string) => {
    await nas.setLibraryRoot(path)
    await librarySync.syncOnConnect()
  })

  handle('nas:chooseLibraryRoot', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose Library Folder',
      message: 'Select the folder that holds (or will hold) your Musaeum library',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    const root = result.filePaths[0]

    // Peek for an existing library before wiring the root in, and hold the
    // automatic on-connect apply until the user has answered
    const existing = await catalog.readCatalog(root)
    if (existing) librarySync.skipRoot(root)
    await nas.setLibraryRoot(root)

    if (existing) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: `Found a Musaeum library with ${existing.books.length} ${
          existing.books.length === 1 ? 'book' : 'books'
        }`,
        detail: 'Use this library? Your local view will be refreshed from it.',
        buttons: ['Use This Library', 'Not Now'],
        defaultId: 0,
        cancelId: 1
      })
      if (response === 0) await librarySync.applyCatalog(root)
    } else {
      await librarySync.syncOnConnect()
    }
    return root
  })
}
```

- [ ] **Step 9: Verify**

Run: `npm test && npm run typecheck && npm run lint` Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add electron/main/services/library-sync.ts electron/main/services/library-sync.test.ts \
  src/types/api.types.ts electron/preload/index.ts electron/main/ipc/library.ts \
  electron/main/ipc/nas.ts electron/main/index.ts
git commit -m "feat: library-sync — catalog adoption on connect, refresh/rebuild IPC"
```

---

### Task 6: Hook every metadata write path into the catalog

**Files:**
- Modify: `electron/main/services/importer.ts` (2 call sites)
- Modify: `electron/main/ipc/library.ts` (updateBook, deleteBook)
- Modify: `electron/main/ipc/metadata.ts` (resolveConflict)
- Modify: `electron/main/services/migration.ts` (migration + top-up batch writes)

**Interfaces:**
- Consumes: `librarySync.upsertCatalog`, `removeBookFromCatalog`, `writeFullCatalog` from Task 5. All hooks are fire-and-forget and must never change existing control flow or error behavior.

These are thin glue edits over already-tested primitives (the queued catalog writers from Task 2 carry the correctness); they are exercised end-to-end in Task 8's verification run.

- [ ] **Step 1: `importer.ts`** — add the import:

```typescript
import * as librarySync from './library-sync'
```

In `importOne`, directly after `broadcast('libraryChanged')`:

```typescript
    librarySync.upsertCatalog([book])
```

In `hydrate`, inside the `if (updated)` block, after `writeMetadataJson(...)`:

```typescript
    if (updated) {
      await writeMetadataJson(bookDir, updated, result.metadata.metadata_sources)
      librarySync.upsertCatalog([updated])
    }
```

- [ ] **Step 2: `ipc/library.ts`** — in `library:updateBook`, extend the metadata-persist branch:

```typescript
    const book = db.getBook(id)
    if (book?.nasPath && nas.isOnline()) {
      await importer.writeMetadataJson(join(nas.getLibraryRoot()!, book.nasPath), book)
      librarySync.upsertCatalog([book])
    }
```

In `library:deleteBook`, after `db.deleteBook(id)`:

```typescript
    librarySync.removeBookFromCatalog(id)
```

- [ ] **Step 3: `ipc/metadata.ts`** — add the import:

```typescript
import * as librarySync from '../services/library-sync'
```

In `metadata:resolveConflict`, extend the metadata-persist branch:

```typescript
    const book = db.getBook(conflict.bookId)
    if (book?.nasPath && nas.isOnline()) {
      await importer.writeMetadataJson(join(nas.getLibraryRoot()!, book.nasPath), book)
      librarySync.upsertCatalog([book])
    }
```

(`metadata:rehydrateBook` needs no edit — it funnels into `importer.hydrate`, hooked in Step 1.)

- [ ] **Step 4: `services/migration.ts`** — add the import:

```typescript
import * as librarySync from './library-sync'
```

In `startMigration`'s success path, after `insertMigratedBooks(result.books)`:

```typescript
      librarySync.writeFullCatalog(options.targetLibraryRoot)
```

In `startPdfTopUp`'s success path, after `insertMigratedBooks(result.new_books)`:

```typescript
      librarySync.writeFullCatalog()
```

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run lint` Expected: all green (no behavior change for existing tests).

- [ ] **Step 6: Commit**

```bash
git add electron/main/services/importer.ts electron/main/ipc/library.ts \
  electron/main/ipc/metadata.ts electron/main/services/migration.ts
git commit -m "feat: upsert catalog.json on every metadata write path"
```

---

### Task 7: Renderer — Refresh Library / Rebuild Catalog actions

**Files:**
- Modify: `src/stores/library.store.ts`
- Modify: `src/hooks/useLibrary.ts`
- Modify: `src/components/layout/Sidebar.tsx`

**Interfaces:**
- Consumes: `window.Musaeum.library.refreshLibrary/rebuildCatalog` and `on.catalogRebuildProgress` from Task 5.
- Produces on `useLibraryStore`: `refreshing: boolean`, `rebuildProgress: { completed: number; total: number } | null`, `refreshLibrary(): Promise<void>`, `rebuildCatalog(): Promise<void>`, `setRebuildProgress(p): void`. (The grid reloads via the existing `libraryChanged` → `load()` wiring; these actions don't call `load()` themselves.)

- [ ] **Step 1: Extend `library.store.ts`**

Add to the `LibraryState` interface, after `importJobs`:

```typescript
  refreshing: boolean
  rebuildProgress: { completed: number; total: number } | null
```

and after `removeImportJob(jobId: string): void`:

```typescript
  refreshLibrary(): Promise<void>
  rebuildCatalog(): Promise<void>
  setRebuildProgress(p: { completed: number; total: number } | null): void
```

Add the initial state after `importJobs: {},`:

```typescript
  refreshing: false,
  rebuildProgress: null,
```

Add the actions after `removeImportJob`:

```typescript
  async refreshLibrary() {
    set({ refreshing: true })
    try {
      await window.Musaeum.library.refreshLibrary()
    } catch (err) {
      console.error('library refresh failed:', err)
    } finally {
      set({ refreshing: false, rebuildProgress: null })
    }
  },

  async rebuildCatalog() {
    set({ refreshing: true })
    try {
      await window.Musaeum.library.rebuildCatalog()
    } catch (err) {
      console.error('catalog rebuild failed:', err)
    } finally {
      set({ refreshing: false, rebuildProgress: null })
    }
  },

  setRebuildProgress(p) {
    set({ rebuildProgress: p })
  }
```

- [ ] **Step 2: Wire the progress event in `useLibrary.ts`**

Add the selector:

```typescript
  const setRebuildProgress = useLibraryStore((s) => s.setRebuildProgress)
```

Add to the `unsubs` array:

```typescript
      window.Musaeum.on.catalogRebuildProgress((p) => setRebuildProgress(p)),
```

Add `setRebuildProgress` to the effect's dependency array.

- [ ] **Step 3: Add the sidebar actions** (`src/components/layout/Sidebar.tsx`)

Update the icons import:

```typescript
import { SpinnerIcon, WarningIcon } from '@/components/shared/icons'
```

Add selectors inside `Sidebar()`:

```typescript
  const refreshing = useLibraryStore((s) => s.refreshing)
  const rebuildProgress = useLibraryStore((s) => s.rebuildProgress)
  const refreshLibrary = useLibraryStore((s) => s.refreshLibrary)
  const rebuildCatalog = useLibraryStore((s) => s.rebuildCatalog)
  const connected = nasStatus?.state === 'connected'
```

Insert after the "Migrate from Calibre…" button, inside the same `<nav>`:

```tsx
          <button
            onClick={() => void refreshLibrary()}
            disabled={!connected || refreshing}
            className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {refreshing && !rebuildProgress && <SpinnerIcon className="h-3.5 w-3.5" />}
            Refresh Library
          </button>

          <button
            onClick={() => void rebuildCatalog()}
            disabled={!connected || refreshing}
            className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {rebuildProgress
              ? `Rebuilding ${rebuildProgress.completed}/${rebuildProgress.total}…`
              : 'Rebuild Catalog…'}
          </button>
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run lint` Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/stores/library.store.ts src/hooks/useLibrary.ts src/components/layout/Sidebar.tsx
git commit -m "feat: sidebar Refresh Library / Rebuild Catalog actions"
```

---

### Task 8: End-to-end verification, docs, changelog

**Files:**
- Modify: `CLAUDE.md`, `tasks.md`, `CHANGELOG.md`

- [ ] **Step 1: End-to-end verification with the project `verify` skill**

Invoke the project's `verify` skill (isolated app profile + CDP) and confirm this scenario:

1. Launch against a scratch library root; import one epub/pdf → `catalog.json` appears at the root and contains the book (with `version: 1`).
2. Quit; wipe the isolated profile's `musaeum.db*` (simulates a second machine); relaunch pointed at the same root → the library shows the imported book without re-importing.
3. Click "Rebuild Catalog…" → completes; book still present; `generated_at` in `catalog.json` advanced.
4. Delete the book in-app → it disappears from `catalog.json`.

If any step fails: stop, use superpowers:systematic-debugging, fix with a regression test where the bug is in tested modules.

- [ ] **Step 2: Update `CLAUDE.md`**

In **Book Storage Structure (NAS)**, add directly under `{library_root}/`:

```
  catalog.json                     # derived cache of all metadata.json (multi-machine)
```

In **Key Behaviors → NAS / Storage**, append a bullet:

```markdown
- **Multi-machine**: `catalog.json` at the library root is a derived cache of
  every book's `metadata.json` (which stays canonical). Every metadata write
  upserts it (bulk ops batch one write); on connect and on "Refresh Library"
  the local SQLite cache is transactionally replaced from it; "Rebuild
  Catalog" re-walks `books/*/metadata.json` as recovery. Last-write-wins,
  one machine at a time. (`services/catalog.ts`, `services/library-sync.ts`)
```

In the **IPC API Surface** `library` block, add:

```typescript
    refreshLibrary(): Promise<{ books: number }>   // re-read catalog.json into cache
    rebuildCatalog(): Promise<{ books: number }>   // recovery: walk metadata.json files
```

and in `on`: `catalogRebuildProgress(cb): Unsubscribe`.

In **Dev quickstart**, add `npm test` with a note that it must run through the provided script (Electron-as-Node for the better-sqlite3 ABI). Update the directory structure listing: add `catalog.ts`, `library-sync.ts` under services, `vitest.config.ts` and `test/mocks/` at root.

- [ ] **Step 3: Update `tasks.md`**

Check off the five implemented items in "Multi-machine (Section B…)" (`catalog.json`, write-path upserts, launch/refresh replace, first-run adoption, rebuild recovery; the concurrency line stays as documentation). Move any discovered gaps into "Phase 1.5 — quality". Add one new known-issue line:

```markdown
- **`deleteBook` FK restriction (pre-existing)**: deleting a book that has
  `device_history` rows throws (FK has no ON DELETE and `deleteBook` doesn't
  handle history). Found while building `replaceAllBooks` (2026-07-17).
```

- [ ] **Step 4: Update `CHANGELOG.md`** (match the existing entry style, under an Unreleased/current heading)

```markdown
- Multi-machine library access (Section B): `catalog.json` derived cache at
  the library root; every metadata write upserts it; cache adopted on
  connect/first-run ("Found a Musaeum library with N books"); sidebar
  "Refresh Library" and "Rebuild Catalog" actions; vitest main-process test
  suite (catalog, cache swap, sync flows).
```

- [ ] **Step 5: Final verification + commit**

Run: `npm test && npm run typecheck && npm run lint` Expected: all green.

```bash
git add CLAUDE.md tasks.md CHANGELOG.md
git commit -m "docs: multi-machine catalog — CLAUDE.md, tasks, changelog"
```

Then follow superpowers:finishing-a-development-branch to merge `multimachine-catalog`.
