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
