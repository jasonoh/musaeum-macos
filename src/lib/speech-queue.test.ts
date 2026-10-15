import { describe, expect, it } from 'vitest'
import { flattenSsml } from './speech-queue'
import {
  BLOCK_ABBREVIATION_SPLIT,
  BLOCK_AMPERSAND,
  BLOCK_BREAKS,
  BLOCK_EMPHASIS,
  BLOCK_HEADING,
  BLOCK_IMAGE_ONLY,
  BLOCK_LANG,
  BLOCK_LESS_THAN,
  BLOCK_PARAGRAPH,
  BLOCK_PHONEME,
  BLOCK_SUB,
  BLOCK_TRAILING_EMPTY_MARK,
  BLOCK_WHITESPACE_ONLY
} from './__fixtures__/foliate-ssml'

const wrap = (body: string): string =>
  `<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en">${body}</speak>`

describe('flattenSsml', () => {
  it('turns marks into ordered units, only the last ending the block', () => {
    const units = flattenSsml(BLOCK_PARAGRAPH)
    expect(units.map((u) => u.mark)).toEqual(['0', '1', '2', '3', '4', '5'])
    expect(units[0]?.text).toBe('What’s the problem?')
    expect(units[5]?.text).toBe('Not from mine.')
    expect(units.map((u) => u.blockEnd)).toEqual([false, false, false, false, false, true])
  })

  it('reads a heading as one unit that ends the block', () => {
    expect(flattenSsml(BLOCK_HEADING)).toEqual([{ mark: '0', text: 'WHY ROBOTS?', blockEnd: true }])
  })

  it('keeps a sentence split mid-line after an abbreviation as the engine marked it', () => {
    expect(flattenSsml(BLOCK_ABBREVIATION_SPLIT).map((u) => u.text)).toEqual([
      'Copyright © 2012 by John H.',
      'Long, Jr.'
    ])
  })

  it('reduces phoneme and sub to their inner text', () => {
    expect(flattenSsml(BLOCK_PHONEME)[0]?.text).toBe('Say Musaeum twice.')
    expect(flattenSsml(BLOCK_SUB)[0]?.text).toBe('Meet Dr. Long.')
  })

  it('treats emphasis and lang as transparent', () => {
    expect(flattenSsml(BLOCK_EMPHASIS).map((u) => u.text)).toEqual([
      'It was a very long way.',
      'Then we left.'
    ])
    expect(flattenSsml(BLOCK_LANG)[0]?.text).toBe('He said bonjour and left.')
  })

  it('turns <break/> into a single space', () => {
    expect(flattenSsml(BLOCK_BREAKS)[0]?.text).toBe(
      'BASIC BOOK A Member of the Perseus Books Group New York'
    )
    expect(flattenSsml(wrap('<mark name="0"/>a<break/>b'))[0]?.text).toBe('a b')
  })

  it('decodes the entities the engine serializes', () => {
    expect(
      flattenSsml(BLOCK_AMPERSAND).some((u) => u.text.includes('Bioinspiration & Biomimetics'))
    ).toBe(true)
    expect(flattenSsml(BLOCK_LESS_THAN)[1]?.text).toContain('p < 0.01')
    expect(
      flattenSsml(wrap('<mark name="0"/>&amp; &lt; &gt; &quot; &apos; &#x2019; &#8217;'))[0]?.text
    ).toBe('& < > " \' ’ ’')
  })

  it('leaves an unknown entity as written', () => {
    expect(flattenSsml(wrap('<mark name="0"/>a &nbsp; b &#xZZ; c'))[0]?.text).toBe(
      'a &nbsp; b &#xZZ; c'
    )
  })

  it('collapses whitespace runs and trims the edges', () => {
    expect(flattenSsml(wrap('<mark name="0"/>  a \n\t b   '))[0]?.text).toBe('a b')
  })

  it('drops an empty unit with its mark, moving blockEnd to the new last', () => {
    expect(flattenSsml(BLOCK_TRAILING_EMPTY_MARK)).toEqual([
      { mark: '0', text: 'JOHN LONG', blockEnd: true }
    ])
    expect(
      flattenSsml(wrap('<mark name="0"/>one <mark name="1"/> <mark name="2"/>two <mark name="3"/>'))
    ).toEqual([
      { mark: '0', text: 'one', blockEnd: false },
      { mark: '2', text: 'two', blockEnd: true }
    ])
  })

  it('drops text before the first mark', () => {
    expect(flattenSsml(wrap('stray <mark name="0"/>kept'))).toEqual([
      { mark: '0', text: 'kept', blockEnd: true }
    ])
  })

  it('gives [] for null, undefined, empty, an image-only block and whitespace', () => {
    expect(flattenSsml(null)).toEqual([])
    expect(flattenSsml(undefined)).toEqual([])
    expect(flattenSsml('')).toEqual([])
    expect(flattenSsml(BLOCK_IMAGE_ONLY)).toEqual([])
    expect(flattenSsml(BLOCK_WHITESPACE_ONLY)).toEqual([])
    expect(flattenSsml(wrap(''))).toEqual([])
  })

  it('ignores the xml prolog', () => {
    expect(flattenSsml('<?xml version="1.0"?>' + wrap('<mark name="0"/>hi'))).toEqual([
      { mark: '0', text: 'hi', blockEnd: true }
    ])
  })
})
