import { describe, expect, it } from 'vitest'
import { descriptionText } from './description'

/**
 * The display half of the rule in `sidecar/extractors/html_text.py`. These
 * cases are deliberately the same as that module's, because they are the same
 * rule: whatever a description holds, the panel shows plain text whose
 * paragraph breaks are newlines.
 */
describe('descriptionText', () => {
  it('turns block boundaries into paragraph breaks', () => {
    expect(descriptionText('<p>First para.</p><p>Second para.</p>')).toBe(
      'First para.\nSecond para.'
    )
  })

  it('treats br as a line break and drops inline tags', () => {
    expect(descriptionText('Line one<br/>Line <b>two</b><br />Line <i>three</i>')).toBe(
      'Line one\nLine two\nLine three'
    )
  })

  it('renders a Calibre comment as plain text', () => {
    // Verbatim shape from the library, where 2,781 rows hold a `<p>`: Calibre's
    // `comments` column is HTML and it was written through as-is
    const stored =
      '<div>\n<p><strong>#BreakIntoVC: How to Break Into Venture Capital</strong> gives ' +
      'you the insight</p>\n<p>Second paragraph.</p></div>'
    expect(descriptionText(stored)).toBe(
      '#BreakIntoVC: How to Break Into Venture Capital gives you the insight\n\nSecond paragraph.'
    )
  })

  it('decodes entities', () => {
    expect(descriptionText('Reese Witherspoon&#8212;and more&nbsp;&amp;&nbsp;more')).toBe(
      'Reese Witherspoon—and more & more'
    )
  })

  it('resolves double-escaped markup', () => {
    expect(descriptionText('&lt;p&gt;A blurb&lt;/p&gt;&lt;br&gt;More')).toBe('A blurb\n\nMore')
  })

  it('resolves triple-escaped markup', () => {
    // The deepest escape measured in the real library, verbatim: the inner
    // tag only surfaces on the third pass
    expect(descriptionText('<p>&amp;lt;p&amp;gt;Award-winning cookbook author')).toBe(
      'Award-winning cookbook author'
    )
  })

  it('leaves arithmetic alone', () => {
    expect(descriptionText('Cheaper than 5 < 6 and 7 > 2, honestly')).toBe(
      'Cheaper than 5 < 6 and 7 > 2, honestly'
    )
  })

  it('keeps a plain description exactly as stored', () => {
    const plain = 'A blurb with no markup.\n\nA second paragraph.'
    expect(descriptionText(plain)).toBe(plain)
  })

  it('does not invent breaks out of a separator run', () => {
    // The colon runs a fetched description can carry are data, not markup —
    // this function has no opinion about them
    expect(descriptionText('A summary.::::: SYNOPSIS: what it argues.')).toBe(
      'A summary.::::: SYNOPSIS: what it argues.'
    )
  })

  it('reads null and undefined as empty', () => {
    expect(descriptionText(null)).toBe('')
    expect(descriptionText(undefined)).toBe('')
    expect(descriptionText('')).toBe('')
  })
})
