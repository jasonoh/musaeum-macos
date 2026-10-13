import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ReaderFormat } from '@shared/book.types'
import type {
  AnnotationArtifact,
  AnnotationEntry,
  AnnotationsFile,
  StoredAnnotation
} from '@shared/annotation.types'

/**
 * `{book}/annotations.json` — a book's own highlights and notes
 * (`docs/superpowers/specs/2026-10-13-annotations-design.md`, D1/D2). Canonical for its
 * own kind of data the way `shelves.json` is: nothing derives it, nothing else holds a
 * copy of it, and losing it is losing the notes.
 *
 * This module is the file and nothing else — no queue, no cache, no NAS check, no book
 * lookup. `services/annotations.ts` is its only writer, and `shelves-file.ts` is its
 * shape. Three rules are carried over from there verbatim because they are the reason
 * that file is safe to run on a share several machines write:
 *
 * - **Total, and refusing rather than repairing.** A file whose version this build does
 *   not know, or whose shape it cannot read, is refused *as a whole* and never rewritten
 *   in this build's shape: silently dropping one unreadable entry on the next write
 *   destroys it, and an older build rewriting a newer build's file is a downgrade nobody
 *   asked for.
 * - **An I/O failure is not "no annotations".** Only `ENOENT` *with the folder still
 *   present* means this book has none. Anything else — a share blip, a permissions
 *   problem, a file where the file should be — rejects, because the alternative is a
 *   mutation starting from nothing and overwriting the notes.
 * - **Atomic write.** A scratch file then a rename, and the scratch name carries a
 *   `randomUUID()` rather than a pid: several Macs share this folder, and a pid is unique
 *   only within one machine.
 */

export const ANNOTATIONS_FILENAME = 'annotations.json'
export const ANNOTATIONS_FILE_VERSION = 1

export function annotationsPath(bookDir: string): string {
  return join(bookDir, ANNOTATIONS_FILENAME)
}

export function emptyAnnotationsFile(bookId: string): AnnotationsFile {
  return { version: ANNOTATIONS_FILE_VERSION, book_id: bookId, annotations: [] }
}

export type AnnotationsReadState =
  | { state: 'ok'; file: AnnotationsFile }
  | { state: 'missing' } // ENOENT in a folder that is there — this book has never been annotated
  | { state: 'invalid' } // exists, but unparsable / unknown version / wrong shape

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * Every value `ReaderFormat` can take, at runtime — a `Record` over the union, so a new
 * format is an `npm run typecheck` failure *here* until it is named (the trick
 * `book-bytes.ts` uses for its media types). A record naming a format this build cannot open
 * is refused with the rest of the file rather than carried: the shape of the file is closed
 * over what the app can act on, which is what lets the read path trust `format` in a stale
 * comparison instead of guarding every use of it.
 */
const READER_FORMATS: Record<ReaderFormat, true> = {
  epub: true,
  mobi: true,
  azw3: true,
  pdf: true,
  reflow: true
}

function isReaderFormat(value: unknown): value is ReaderFormat {
  return typeof value === 'string' && Object.hasOwn(READER_FORMATS, value)
}

function parseArtifact(raw: unknown): AnnotationArtifact | null {
  if (!isRecord(raw)) return null
  if (raw.kind !== 'source' && raw.kind !== 'derived') return null
  if (!isReaderFormat(raw.format)) return null
  if (raw.stamp !== null && typeof raw.stamp !== 'string') return null
  return { kind: raw.kind, format: raw.format, stamp: raw.stamp }
}

/**
 * One highlight, or null when the entry is not something this build may rewrite.
 *
 * Every member is checked, and the ones a person would notice are checked for *sense*
 * rather than shape: a `percent` outside 0–1 is a corrupt record rather than a value to
 * clamp (the writer clamps; the reader refuses), because clamping on read would rewrite
 * someone's data into a different value without saying so.
 */
function parseHighlight(raw: Record<string, unknown>): StoredAnnotation | null {
  const artifact = parseArtifact(raw.artifact)
  if (!isNonEmptyString(raw.id)) return null
  if (!isNonEmptyString(raw.cfi)) return null
  if (!isNonEmptyString(raw.quote)) return null
  if (typeof raw.prefix !== 'string' || typeof raw.suffix !== 'string') return null
  if (typeof raw.percent !== 'number' || !Number.isFinite(raw.percent)) return null
  if (raw.percent < 0 || raw.percent > 1) return null
  if (raw.section_label !== null && typeof raw.section_label !== 'string') return null
  if (!isNonEmptyString(raw.color)) return null
  if (raw.note !== null && typeof raw.note !== 'string') return null
  if (!artifact) return null
  if (!isNonEmptyString(raw.created_at) || !isNonEmptyString(raw.updated_at)) return null

  return {
    id: raw.id,
    type: 'highlight',
    cfi: raw.cfi,
    quote: raw.quote,
    prefix: raw.prefix,
    suffix: raw.suffix,
    percent: raw.percent,
    section_label: raw.section_label,
    color: raw.color,
    note: raw.note,
    artifact,
    created_at: raw.created_at,
    updated_at: raw.updated_at
  }
}

/**
 * One entry, or null when this build may not carry it through.
 *
 * A `type` this build does not know is **kept verbatim** — a later build's bookmark
 * arrives inside this file's own version (spec D2), and refusing the file would lose the
 * highlights beside it. Only `id` and `type` are required of such an entry, because they
 * are what the build that wrote it needs to find it again.
 */
function parseEntry(raw: unknown): AnnotationEntry | null {
  if (!isRecord(raw)) return null
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.type)) return null
  if (raw.type === 'highlight') return parseHighlight(raw)
  return raw as unknown as AnnotationEntry
}

/**
 * Text → the file, or null for anything this build cannot safely rewrite.
 *
 * An unknown `version` is refused rather than read as best it can be, for `shelves.json`'s
 * reason. Unknown top-level keys are kept, so a key a later build added survives this
 * build's write.
 */
export function parseAnnotationsFile(text: string): AnnotationsFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  if (raw.version !== ANNOTATIONS_FILE_VERSION) return null
  if (!isNonEmptyString(raw.book_id)) return null
  if (!Array.isArray(raw.annotations)) return null

  const annotations: AnnotationEntry[] = []
  for (const entry of raw.annotations) {
    const parsed = parseEntry(entry)
    if (!parsed) return null
    annotations.push(parsed)
  }
  return { ...raw, version: ANNOTATIONS_FILE_VERSION, book_id: raw.book_id, annotations }
}

/**
 * ENOENT on `annotationsPath(bookDir)` means one of two different things, and only one of
 * them is "no annotations": the *folder* may have gone — a book folder removed outside the
 * app, a share that dropped inside the 30-second window before `nas.assertOnline()`
 * notices — in which case the file's own absence says nothing. Only a folder that is still
 * there and has no file is a book nobody has annotated.
 */
async function folderIsMissing(bookDir: string): Promise<boolean> {
  try {
    await fs.stat(bookDir)
    return false
  } catch {
    return true
  }
}

export async function readAnnotationsFile(bookDir: string): Promise<AnnotationsReadState> {
  let text: string
  try {
    text = await fs.readFile(annotationsPath(bookDir), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (await folderIsMissing(bookDir)) throw err
      return { state: 'missing' }
    }
    // A share blip must not read as "no annotations": the write path would start from
    // nothing and overwrite the file.
    throw err
  }
  const file = parseAnnotationsFile(text)
  return file ? { state: 'ok', file } : { state: 'invalid' }
}

/**
 * Atomic write: a scratch file then a rename, so a crash or a dropped share never leaves a
 * torn file — the same pattern as `shelves-file.ts`. Indented, because this file is
 * canonical and a person may open it to repair it. A failed rename removes the scratch
 * file (best-effort) and rethrows the original error, so a failed write never litters the
 * book's folder with a `.part`.
 */
export async function writeAnnotationsFile(bookDir: string, file: AnnotationsFile): Promise<void> {
  const target = annotationsPath(bookDir)
  const scratch = `${target}.${randomUUID()}.part`
  await fs.writeFile(scratch, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  try {
    await fs.rename(scratch, target)
  } catch (err) {
    await fs.rm(scratch, { force: true }).catch(() => undefined)
    throw err
  }
}
