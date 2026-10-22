/**
 * The pronunciation lexicon — `{library root}/lexicon.json`
 * (`docs/superpowers/specs/2026-10-15-voice-reader-design.md`, D8).
 *
 * A name a book spells that the phonemizer cannot read: `Hegel` comes out
 * _HEDGE-ul_, so the library keeps a respelling a person typed (`HAY-gul`) and
 * the sidecar derives the phonemes when it speaks (`sidecar/tts/lexicon.py`).
 * The file is human-readable and portable on purpose — it never stores IPA, so
 * it does not freeze a phonemizer version into a library.
 *
 * Two shapes live here. The first half is the **stored file**, snake_case like
 * `metadata.json` and `shelves.json`, canonical and written only by
 * `electron/main/services/lexicon.ts`. The second half is what crosses the
 * preload bridge: camelCase, and the entire entry list on every answer, because
 * the file is the source of truth and another Mac may have edited it since.
 */

import type { TtsVoice } from './tts.types'

export const LEXICON_FILENAME = 'lexicon.json'
export const LEXICON_FILE_VERSION = 1
/**
 * A word, or a name with a space in it (`Van Gogh`, `Hegel Kant`) — the sidecar's
 * matcher keys on whole words, so a compound name is one entry. Not a phrase.
 */
export const LEXICON_WORD_MAX = 80
export const LEXICON_RESPELING_MAX = 60

// --- lexicon.json (D8) ---

export interface LexiconEntry {
  word: string
  /** What a person typed — `HAY-gul`. The part in CAPITALS carries the stress. Never IPA. */
  soundsLike: string
  /** ISO. `''` for an entry somebody hand-wrote into the file; stamped on the next save. */
  addedAt: string
}

/**
 * An array member this build does not know — a later build's entry with its own
 * shape, or a hand-edited one. Carried through every write exactly as it was
 * read and never spoken (D8: unknown entry shapes are carried through).
 */
export interface ForeignLexiconEntry {
  [key: string]: unknown
}

export type LexiconFileEntry = LexiconEntry | ForeignLexiconEntry

export interface LexiconFile {
  /** The file format's version — independent of the REST `apiVersion`. */
  version: 1
  entries: LexiconFileEntry[]
}

// --- the bridge ---

export interface LexiconEntryView {
  word: string
  soundsLike: string
  addedAt: string
}

/**
 * `missing` (the library has never had one) and `unreadable` (it has one this
 * build cannot read) are different sentences on screen, so the read answers a
 * state rather than an empty list — the rule `AnnotationsRead` keeps.
 */
export type LexiconReadState = 'ok' | 'missing' | 'unreadable'

export interface LexiconRead {
  state: LexiconReadState
  entries: LexiconEntryView[]
}

export interface LexiconSaveInput {
  word: string
  soundsLike: string
}

/** What Preview asks: the respelling, and the voice to hear it in. */
export interface LexiconPreviewRequest {
  word: string
  soundsLike: string
  voice: TtsVoice
  speed: number
}

/** The sidecar's own entry shape — snake_case, as `tts_synthesize` takes it. */
export interface SpokenLexiconEntry {
  word: string
  sounds_like: string
}

// --- the two validators both sides share ---

/**
 * A word is one line, non-empty after trimming, and at most `LEXICON_WORD_MAX`
 * characters (counted as characters, not UTF-16 units).
 *
 * Punctuation is allowed and expected: `C++` and `Okafor's` are both names a
 * person would fix, and the sidecar escapes every literal it compiles.
 */
export function cleanWord(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const word = raw.trim().replace(/\s+/g, ' ')
  if (!word) return null
  if ([...word].length > LEXICON_WORD_MAX) return null
  return word
}

/**
 * A respelling is letters, spaces, hyphens and apostrophes — `HAY-gul`,
 * `ko-ZHEV`, `oh KAH for`. Digits and other punctuation are refused rather
 * than handed to the phonemizer to improvise: a wrong pronunciation that comes
 * out looking fine is the failure this feature exists to remove (annex R6).
 */
export function isValidRespelling(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const value = raw.trim()
  if (!value || [...value].length > LEXICON_RESPELING_MAX) return false
  return /^[A-Za-z][A-Za-z'’-]*(?:[\s-]+[A-Za-z'’-]+)*$/u.test(value)
}

/** Trimmed, with runs of whitespace collapsed — what the phonemizer's splitter reads. */
export function cleanRespelling(raw: unknown): string | null {
  if (!isValidRespelling(raw)) return null
  return raw.trim().replace(/\s+/g, ' ')
}

/**
 * One array member of the file, as this build may use it — or null, in which
 * case the caller keeps it verbatim and never speaks it (annex R7).
 *
 * An absent or non-string `addedAt` reads as `''` rather than refusing the
 * entry: a person hand-editing this file will write the two fields they care
 * about, and the next save stamps the third.
 */
export function toLexiconEntry(raw: unknown): LexiconEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const word = cleanWord(record.word)
  if (!word) return null
  if (typeof record.soundsLike !== 'string') return null
  const soundsLike = cleanRespelling(record.soundsLike)
  if (!soundsLike) return null
  return {
    word,
    soundsLike,
    addedAt: typeof record.addedAt === 'string' ? record.addedAt : ''
  }
}

export function isLexiconEntry(entry: LexiconFileEntry): entry is LexiconEntry {
  return typeof (entry as LexiconEntry).soundsLike === 'string'
}

/** A parsed entry in the sidecar's shape. */
export function toSpokenEntry(entry: LexiconEntry): SpokenLexiconEntry {
  return { word: entry.word, sounds_like: entry.soundsLike }
}
