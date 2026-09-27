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
