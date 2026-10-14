import { describe, expect, it } from 'vitest'
import {
  normalizeTokens,
  parseProbe,
  recallOverlap,
  RECALL_THRESHOLD,
  scoreRecall,
  SECTION_TOKEN_WINDOW
} from './recall'

/**
 * The recall scorer, on fixed fixtures.
 *
 * Every fixture below is a *kind* of reply, not a format sample: the verbatim
 * opening (the bet paying off), the near-miss from another edition, the fluent
 * invention, the honest refusal, and the reply that does not follow the
 * contract. Those five are what the verdict has to tell apart, and the design's
 * risk 1 says out loud that it tells them apart by evidence rather than proof.
 */

/** `Alice's Adventures in Wonderland` — public domain, so the "verbatim" claim is checkable. */
const SECTION = `Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it, "and what is the use of a book," thought Alice, "without pictures or conversations?"`

const VERBATIM = 'Alice was beginning to get very tired of sitting by her sister on the bank'
const NEAR_MISS =
  'Alice was starting to grow quite weary of sitting beside her sister on the riverbank'
const INVENTION =
  'The morning sun rose over the small town as Eleanor prepared for another day of lessons'

describe('parseProbe (AC16)', () => {
  it('reads the contract as written', () => {
    expect(parseProbe('RECALL: yes\nOPENING: Alice was beginning to get very tired')).toEqual({
      parsed: true,
      recall: true,
      opening: 'Alice was beginning to get very tired'
    })
  })

  it('tolerates bold, backticks, quotes, case and stray whitespace', () => {
    const reply =
      '  **RECALL:**  `Yes`  \n\n   **OPENING:**  “Alice was beginning to get very tired”   '
    expect(parseProbe(reply)).toEqual({
      parsed: true,
      recall: true,
      opening: 'Alice was beginning to get very tired'
    })
  })

  it('reads lowercase keys and a curly-colon variant', () => {
    expect(parseProbe('recall：no')).toEqual({ parsed: true, recall: false, opening: '' })
  })

  it('follows an opening that runs on to the next line', () => {
    const reply = 'RECALL: yes\nOPENING:\nAlice was beginning to get very tired'
    expect(parseProbe(reply).opening).toBe('Alice was beginning to get very tired')
  })

  it('stops the opening at the next key', () => {
    const reply = 'RECALL: yes\nOPENING: Alice was beginning\nNOTE: a guess'
    expect(parseProbe(reply).opening).toBe('Alice was beginning')
  })

  it('stops the opening at a blank line', () => {
    const reply = 'RECALL: yes\nOPENING:\nAlice was beginning\n\nThen some commentary.'
    expect(parseProbe(reply).opening).toBe('Alice was beginning')
  })

  it('gathers at most a wrapped opening, never the commentary after it', () => {
    const reply =
      'RECALL: yes\nOPENING:\nAlice was beginning\nto get very tired\nI hope that helps.'
    expect(parseProbe(reply).opening).toBe('Alice was beginning to get very tired')
  })

  it('parses a claim of recall with no opening at all', () => {
    expect(parseProbe('RECALL: yes')).toEqual({ parsed: true, recall: true, opening: '' })
  })

  it('returns no recall and no opening for a reply that does not follow the contract', () => {
    const unparsed = { parsed: false, recall: false, opening: '' }
    expect(parseProbe('I believe this is by Lewis Carroll, though I am not certain.')).toEqual(
      unparsed
    )
    expect(parseProbe('RECALL: maybe\nOPENING: something')).toEqual(unparsed)
    expect(parseProbe('')).toEqual(unparsed)
    expect(parseProbe(null)).toEqual(unparsed)
  })
})

describe('scoreRecall (AC17)', () => {
  it('a verbatim opening is strong', () => {
    const parsed = parseProbe(`RECALL: yes\nOPENING: ${VERBATIM}`)
    expect(recallOverlap(parsed, SECTION)).toBe(1)
    expect(scoreRecall(parsed, SECTION)).toBe('strong')
  })

  it('a near-miss from another edition is weak', () => {
    const parsed = parseProbe(`RECALL: yes\nOPENING: ${NEAR_MISS}`)
    const overlap = recallOverlap(parsed, SECTION) ?? 0
    expect(overlap).toBeLessThan(RECALL_THRESHOLD)
    expect(overlap).toBeGreaterThan(0)
    expect(scoreRecall(parsed, SECTION)).toBe('weak')
  })

  it('a fluent invention is weak', () => {
    const parsed = parseProbe(`RECALL: yes\nOPENING: ${INVENTION}`)
    expect(recallOverlap(parsed, SECTION)).toBe(0)
    expect(scoreRecall(parsed, SECTION)).toBe('weak')
  })

  it('an explicit refusal is weak, and needs no comparison', () => {
    expect(scoreRecall(parseProbe('RECALL: no\nOPENING: '), SECTION)).toBe('weak')
  })

  it('an unparseable reply is unknown', () => {
    expect(scoreRecall(parseProbe('Not sure, sorry.'), SECTION)).toBe('unknown')
  })

  it('is unknown when no section text is loaded to check against', () => {
    const parsed = parseProbe(`RECALL: yes\nOPENING: ${VERBATIM}`)
    expect(recallOverlap(parsed, null)).toBeNull()
    expect(scoreRecall(parsed, null)).toBe('unknown')
    expect(scoreRecall(parsed, 'a an of')).toBe('unknown')
  })

  it('is weak when the model claims recall but writes no opening', () => {
    expect(scoreRecall(parseProbe('RECALL: yes'), SECTION)).toBe('weak')
  })

  it('scores only the section’s opening window, not its whole body', () => {
    const late = `${'filler '.repeat(SECTION_TOKEN_WINDOW)}Alice was beginning to get very tired`
    const parsed = parseProbe(`RECALL: yes\nOPENING: ${VERBATIM}`)
    expect(scoreRecall(parsed, late)).toBe('weak')
  })

  it('lands on the 0.6 threshold with `>=`, so a bare majority of the claim is strong', () => {
    const section = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'
    const just = parseProbe('RECALL: yes\nOPENING: alpha bravo charlie zulu yankee')
    expect(recallOverlap(just, section)).toBe(RECALL_THRESHOLD)
    expect(scoreRecall(just, section)).toBe('strong')

    const under = parseProbe('RECALL: yes\nOPENING: alpha bravo zulu yankee')
    expect(recallOverlap(under, section)).toBeLessThan(RECALL_THRESHOLD)
    expect(scoreRecall(under, section)).toBe('weak')
  })
})

describe('normalization', () => {
  it('sees through case, punctuation, curly quotes, dashes and diacritics', () => {
    const section = 'La señora García — abrió la puerta de la casa, y miró hacia el jardín.'
    const parsed = parseProbe('RECALL: yes\nOPENING: la senora garcia abrio la puerta de la casa')
    expect(recallOverlap(parsed, section)).toBe(1)
    expect(scoreRecall(parsed, section)).toBe('strong')
  })

  it('drops stopwords and tokens shorter than three characters', () => {
    expect(normalizeTokens('It was a very long, long day — indeed!')).toEqual([
      'long',
      'long',
      'day',
      'indeed'
    ])
  })

  it('keeps non-Latin letters instead of normalizing them away', () => {
    expect(normalizeTokens('Привет, мир')).toEqual(['привет', 'мир'])
    expect(normalizeTokens(null)).toEqual([])
  })
})
