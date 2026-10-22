import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import {
  LEXICON_FILE_VERSION,
  LEXICON_FILENAME,
  toLexiconEntry,
  type LexiconFile,
  type LexiconFileEntry
} from '@shared/lexicon.types'

/**
 * `{library root}/lexicon.json` — the canonical store for pronunciations
 * (`docs/superpowers/specs/2026-10-15-voice-reader-design.md`, D8). Not derived
 * from anything, and nothing derives it: it is a sibling of `shelves.json` and
 * follows that file's discipline in full, because it lives on a share several
 * Macs write.
 *
 * This module is the file and nothing else — no cache, no queue, no NAS check.
 * `services/lexicon.ts` is its only reader and its only writer.
 *
 * The three rules carried over verbatim from `shelves-file.ts`, since they are
 * why that file is safe on a share:
 *
 * - **Total, and refusing rather than repairing.** A file whose version this
 *   build does not know, or that does not parse, is refused *as a whole* and
 *   never rewritten in this build's shape — an older build rewriting a newer
 *   build's file is a downgrade nobody asked for.
 * - **An I/O failure is not "no pronunciations".** Only `ENOENT` with the root
 *   still present means this library has never had one. Anything else rejects,
 *   because the alternative is a mutation starting from nothing and overwriting
 *   the file.
 * - **Atomic write by a random id.** A scratch file then a rename, and the
 *   scratch name carries a `randomUUID()` rather than a pid: several Macs share
 *   this folder, and a pid is unique only within one machine.
 */

export { LEXICON_FILENAME }

export function lexiconPath(root: string): string {
  return join(root, LEXICON_FILENAME)
}

export function emptyLexiconFile(): LexiconFile {
  return { version: LEXICON_FILE_VERSION, entries: [] }
}

export type LexiconFileReadState =
  | { state: 'ok'; file: LexiconFile }
  | { state: 'missing' } // ENOENT in a root that is there — never had one
  | { state: 'invalid' } // exists, but unparsable / unknown version / wrong shape

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Text → the file, or null for anything this build cannot safely rewrite.
 *
 * A member that is not a usable entry is **kept verbatim** rather than refusing
 * the file (annex R7; D8's "unknown entry shapes are carried through"): one
 * hand-edited or later-build entry must not take every good pronunciation with
 * it. Unknown top-level keys are kept for the same reason.
 */
export function parseLexiconFile(text: string): LexiconFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  if (raw.version !== LEXICON_FILE_VERSION) return null
  if (!Array.isArray(raw.entries)) return null

  const entries: LexiconFileEntry[] = raw.entries.map(
    (member) => toLexiconEntry(member) ?? (member as LexiconFileEntry)
  )
  return { ...raw, version: LEXICON_FILE_VERSION, entries }
}

/**
 * ENOENT on `lexiconPath(root)` means one of two different things, and only one
 * of them is "no pronunciations": the root itself may have vanished — a share
 * unmounted or a local folder moved, in the up-to-30-second window before
 * `nas.assertOnline()` notices — in which case the file's own absence says
 * nothing. Only a root that still exists with no file is a library that has
 * never had one.
 */
async function rootIsMissing(root: string): Promise<boolean> {
  try {
    await fs.stat(root)
    return false
  } catch {
    return true
  }
}

export async function readLexiconFile(root: string): Promise<LexiconFileReadState> {
  let text: string
  try {
    text = await fs.readFile(lexiconPath(root), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (await rootIsMissing(root)) throw err
      return { state: 'missing' }
    }
    // A share blip must not read as "no pronunciations": speech would lose every
    // respelling, and a mutation would start from nothing and overwrite the file.
    throw err
  }
  const file = parseLexiconFile(text)
  return file ? { state: 'ok', file } : { state: 'invalid' }
}

/**
 * Atomic write: a scratch file then a rename, so a crash or a dropped share
 * never leaves a torn file. Indented, because this file is canonical and a
 * person may open it to repair it. A failed rename removes the scratch file
 * (best-effort) and rethrows the original error, so a failed write never litters
 * the share with a `.part`.
 */
export async function writeLexiconFile(root: string, file: LexiconFile): Promise<void> {
  const target = lexiconPath(root)
  const scratch = `${target}.${randomUUID()}.part`
  await fs.writeFile(scratch, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  try {
    await fs.rename(scratch, target)
  } catch (err) {
    await fs.rm(scratch, { force: true }).catch(() => undefined)
    throw err
  }
}
