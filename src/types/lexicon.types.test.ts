import { describe, expect, it } from 'vitest'
import {
  LEXICON_RESPELING_MAX,
  LEXICON_WORD_MAX,
  cleanRespelling,
  cleanWord,
  isLexiconEntry,
  isValidRespelling,
  toLexiconEntry,
  toSpokenEntry
} from './lexicon.types'

/**
 * The lexicon's two validators, and the tolerance in its parser (voice reader D8; slice
 * annex R5, R6, R7). They live in the shared types because both processes decide by them:
 * the chip decides whether to offer **Pronounce…**, main decides whether to write, and the
 * file parser decides whether an entry is one it may speak.
 */

describe('cleanWord (annex R5)', () => {
  it('trims, and collapses runs of whitespace so one entry is one key', () => {
    expect(cleanWord('  Hegel ')).toBe('Hegel')
    expect(cleanWord('Van   Gogh')).toBe('Van Gogh')
  })

  it('keeps a compound name and a punctuated one: the sidecar escapes every literal it compiles', () => {
    // `Van Gogh` is one entry the matcher can find; `C++` and `Okafor's` are names a person fixes.
    for (const word of ['Van Gogh', 'Hegel Kant', 'C++', "Okafor's", 'Kojève']) {
      expect(cleanWord(word), word).toBe(word)
    }
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a non-string', 42],
    ['null', null],
    ['an over-long phrase', 'a'.repeat(LEXICON_WORD_MAX + 1)]
  ])('refuses %s', (_label, value) => {
    expect(cleanWord(value)).toBeNull()
  })

  it('counts characters rather than UTF-16 units, so an accented name is not cut short', () => {
    const word = 'é'.repeat(LEXICON_WORD_MAX)
    expect(cleanWord(word)).toBe(word)
  })
})

describe('isValidRespelling (annex R6)', () => {
  it.each([['HAY-gul'], ['ko-ZHEV'], ['oh KAH for'], ['HAYGUL'], ["hay'gul"]])(
    'accepts %s',
    (value) => {
      expect(isValidRespelling(value)).toBe(true)
    }
  )

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['digits, which have no phonemes', 'HAY2-gul'],
    ['punctuation', 'HAY-gul!'],
    ['an underscore', 'HAY_gul'],
    ['a leading hyphen', '-HAY-gul'],
    ['a non-string', 3],
    ['an over-long respelling', 'a'.repeat(LEXICON_RESPELING_MAX + 1)]
  ])(
    'refuses %s — a wrong pronunciation that looks fine is the failure this prevents',
    (_l, value) => {
      expect(isValidRespelling(value)).toBe(false)
    }
  )

  it('normalises whitespace, because the phonemizer splits on it', () => {
    expect(cleanRespelling('  oh   KAH  for ')).toBe('oh KAH for')
  })
})

describe('toLexiconEntry (annex R7)', () => {
  it('reads an entry, and treats a missing addedAt as a hand-written one', () => {
    expect(toLexiconEntry({ word: 'Hegel', soundsLike: 'HAY-gul', addedAt: 'x' })).toEqual({
      word: 'Hegel',
      soundsLike: 'HAY-gul',
      addedAt: 'x'
    })
    expect(toLexiconEntry({ word: 'Hegel', soundsLike: 'HAY-gul' })).toEqual({
      word: 'Hegel',
      soundsLike: 'HAY-gul',
      addedAt: ''
    })
  })

  it.each([
    ['a scalar', 'Hegel'],
    ['an array', ['Hegel']],
    ['null', null],
    ['no word', { soundsLike: 'HAY-gul' }],
    ['an empty word', { word: '  ', soundsLike: 'HAY-gul' }],
    ['no soundsLike', { word: 'Hegel' }],
    ['a soundsLike that is not a respelling', { word: 'Hegel', soundsLike: 'hˈeɪɡəl' }]
  ])('declines %s, so the caller keeps it verbatim and never speaks it', (_label, value) => {
    expect(toLexiconEntry(value)).toBeNull()
  })

  it('tells a parsed entry from a foreign one, and maps it to the sidecar’s shape', () => {
    const parsed = toLexiconEntry({ word: 'Hegel', soundsLike: 'HAY-gul' })
    expect(parsed && isLexiconEntry(parsed)).toBe(true)
    expect(isLexiconEntry({ word: 'Ghost', shape: 'ipa' })).toBe(false)
    expect(parsed && toSpokenEntry(parsed)).toEqual({ word: 'Hegel', sounds_like: 'HAY-gul' })
  })
})
