import { promises as fs } from 'fs'
import {
  cleanRespelling,
  cleanWord,
  isLexiconEntry,
  toSpokenEntry,
  type LexiconEntry,
  type LexiconEntryView,
  type LexiconFile,
  type LexiconRead,
  type LexiconSaveInput,
  type SpokenLexiconEntry
} from '@shared/lexicon.types'
import {
  emptyLexiconFile,
  lexiconPath,
  readLexiconFile,
  writeLexiconFile,
  type LexiconFileReadState
} from './lexicon-file'
import * as nas from './nas-manager'

/**
 * The library's pronunciation list: the only reader and the only writer of
 * `{library root}/lexicon.json` (`docs/superpowers/specs/2026-10-15-voice-reader-design.md`,
 * D8; slice annex `docs/superpowers/plans/2026-10-22-voice-reader-lexicon.md`).
 *
 * Two consumers, one file. **`services/tts.ts` asks for `spokenEntries()`** on every
 * sentence, so a respelling saved mid-session is in the next sentence (AC26), and
 * **the popover asks for `list()`**, which answers a state rather than an empty list
 * because "no pronunciations" and "a pronunciation list that cannot be read" are
 * different sentences on screen.
 *
 * Three choices are worth saying out loud:
 *
 * - **The read is stat-keyed, and a failed read serves the last good copy** (annex R2).
 *   A sentence costs one `stat` on the share, not a read; a share that drops mid-book
 *   keeps the pronunciations the session already loaded (D8), which is what lets speech
 *   outlive the mount.
 * - **No cache of the *shape* and no column** (D8): the read path is the share, so a
 *   respelling saved on the other Mac is heard here by being read, with no adoption step.
 * - **No broadcast.** The reader that made the change is the only consumer, and a
 *   `libraryChanged` for a two-field popover would reload 7,000 rows (the annotation
 *   service's decision, for its reason — annex R9).
 */

export const LEXICON_UNREADABLE =
  'The pronunciation list could not be read — pronunciation changes are paused so nothing is lost'
export const LEXICON_GONE = 'That word is no longer in the pronunciation list.'
export const LEXICON_NO_WORD = 'A pronunciation needs a word.'
export const LEXICON_BAD_RESPELLING = 'A respelling is letters, spaces and hyphens — like HAY-gul.'

interface CachedFile {
  root: string
  mtimeMs: number
  size: number
  file: LexiconFile
}

let cache: CachedFile | null = null
let reportedUnreadable = false

/** Test-only: undo the module-level cache and the one-log rule between cases. */
export function resetForTests(): void {
  cache = null
  reportedUnreadable = false
}

function warnUnreadable(root: string): void {
  if (reportedUnreadable) return
  reportedUnreadable = true
  console.warn(`[lexicon] cannot read ${lexiconPath(root)}`)
}

/** The file's identity for the cache: its mtime and size, or zeros when they cannot be read. */
async function fingerprint(root: string): Promise<{ mtimeMs: number; size: number }> {
  try {
    const stat = await fs.stat(lexiconPath(root))
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    // Numbers this call could not take are numbers no later stat will match, so the
    // next call re-reads. Never wrong, at worst one extra read.
    return { mtimeMs: 0, size: 0 }
  }
}

interface Loaded {
  state: 'ok' | 'missing' | 'unreadable'
  file: LexiconFile
}

/**
 * The file as speech should use it right now. Never throws: this is on the sentence
 * path, and a library that cannot be read is a library with no respellings to apply,
 * not a book that fails to speak (invariant 12).
 *
 * The states are deliberately collapsed for speech — `missing` and `unreadable` both
 * mean "the entries you have" — while `list()` keeps them apart for the popover.
 */
async function load(): Promise<Loaded> {
  const root = nas.getLibraryRoot()
  if (!root) {
    cache = null
    return { state: 'missing', file: emptyLexiconFile() }
  }

  // Fast path: the file is the one already read.
  if (cache?.root === root) {
    try {
      const stat = await fs.stat(lexiconPath(root))
      if (stat.mtimeMs === cache.mtimeMs && stat.size === cache.size) {
        return { state: 'ok', file: cache.file }
      }
    } catch {
      // The share blipped mid-session. Speech keeps the last copy it read (D8).
      return { state: 'ok', file: cache.file }
    }
  }

  let read: LexiconFileReadState
  try {
    read = await readLexiconFile(root)
  } catch {
    // Offline, or a failure that is not "no file": the same rule as above.
    if (cache?.root === root) return { state: 'ok', file: cache.file }
    return { state: 'unreadable', file: emptyLexiconFile() }
  }

  if (read.state === 'invalid') {
    // Never rewritten, and never allowed to empty what the session was already
    // speaking — the file's own garbage is not evidence that the entries were wrong.
    warnUnreadable(root)
    if (cache?.root === root) return { state: 'unreadable', file: cache.file }
    return { state: 'unreadable', file: emptyLexiconFile() }
  }

  if (read.state === 'missing') {
    cache = null
    return { state: 'missing', file: emptyLexiconFile() }
  }

  cache = { root, ...(await fingerprint(root)), file: read.file }
  return { state: 'ok', file: read.file }
}

/** A parsed entry as the renderer sees it: camelCase. */
function toView(entry: LexiconEntry): LexiconEntryView {
  return { word: entry.word, soundsLike: entry.soundsLike, addedAt: entry.addedAt }
}

function view(file: LexiconFile): LexiconEntryView[] {
  return file.entries.filter(isLexiconEntry).map(toView)
}

/**
 * The list, and what the read came to. Never throws — a share that dropped is a state
 * the popover renders, not a failed action (the posture `annotations.list` keeps).
 */
export async function list(): Promise<LexiconRead> {
  const loaded = await load()
  return { state: loaded.state, entries: view(loaded.file) }
}

/**
 * What every sentence is phonemized with (annex R1): the saved respellings, in the
 * sidecar's own shape. Never throws, and an empty list is the ordinary case — a
 * library nobody has taught a name to.
 */
export async function spokenEntries(): Promise<SpokenLexiconEntry[]> {
  const loaded = await load()
  return loaded.file.entries.filter(isLexiconEntry).map(toSpokenEntry)
}

// One queue for the process — two mutations interleaving their read-modify-write
// would lose one. The shape `shelves.ts`, `annotations.ts` and `catalog.ts` share.
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

interface Applied<T> {
  result: T
  changed: boolean
}

/**
 * Every write goes through here: assert the library is writable → enter the queue →
 * **re-read the file** → apply the change to what was read → write it atomically →
 * answer with the file's whole list.
 *
 * The re-read is why an answer is the whole list rather than the one entry that
 * changed: another Mac may have edited this file since this one last looked, so the
 * change applies to the file as it is now (annex R4).
 *
 * `changed: false` writes nothing — a save that saves the value already there must not
 * bump the file's mtime, which is what the speech cache keys on (the guard
 * `annotations.update` carries for `updated_at`, for the same reason).
 */
async function mutate<T>(apply: (file: LexiconFile, now: string) => Applied<T>): Promise<T> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()
  if (!root) throw new Error(LEXICON_UNREADABLE)
  return enqueue(async () => {
    let read: LexiconFileReadState
    try {
      read = await readLexiconFile(root)
    } catch (err) {
      warnUnreadable(root)
      throw new Error(LEXICON_UNREADABLE, { cause: err })
    }
    if (read.state === 'invalid') {
      warnUnreadable(root)
      throw new Error(LEXICON_UNREADABLE)
    }

    const file = read.state === 'ok' ? read.file : emptyLexiconFile()
    const applied = apply(file, new Date().toISOString())
    if (!applied.changed) return applied.result
    // A file that exists and cannot be read is never rewritten; a file that is not
    // in the library's shape any more is never written from memory.
    await writeLexiconFile(root, file)
    cache = { root, ...(await fingerprint(root)), file }
    return applied.result
  })
}

/**
 * Add or replace one respelling (annex R4). `addedAt` is stamped on add, kept on an
 * edit, and stamped the first time somebody edits an entry that was hand-written into
 * the file without one.
 */
export async function save(input: LexiconSaveInput): Promise<LexiconEntryView[]> {
  const word = cleanWord(input.word)
  if (!word) throw new Error(LEXICON_NO_WORD)
  const soundsLike = cleanRespelling(input.soundsLike)
  if (!soundsLike) throw new Error(LEXICON_BAD_RESPELLING)

  return mutate((file, now) => {
    const existing = file.entries.find(
      (entry): entry is LexiconEntry => isLexiconEntry(entry) && entry.word === word
    )
    if (existing) {
      if (existing.soundsLike === soundsLike) return { result: view(file), changed: false }
      existing.soundsLike = soundsLike
      if (!existing.addedAt) existing.addedAt = now
    } else {
      file.entries.push({ word, soundsLike, addedAt: now })
    }
    return { result: view(file), changed: true }
  })
}

/**
 * Delete one respelling. A named refusal when the word is not in the file — edited on
 * the other Mac since this one listed it — rather than a silent no-op, so the popover
 * can say so instead of appearing to have deleted something.
 */
export async function remove(word: string): Promise<LexiconEntryView[]> {
  const target = cleanWord(word)
  return mutate((file) => {
    const before = file.entries.length
    file.entries = file.entries.filter((entry) => !(isLexiconEntry(entry) && entry.word === target))
    if (file.entries.length === before) throw new Error(LEXICON_GONE)
    return { result: view(file), changed: true }
  })
}
