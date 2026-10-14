import { describe, expect, it } from 'vitest'
import { ASK_SECTION_TEXT_MAX_CHARS, parseAskRequest } from './ask'

describe('parseAskRequest', () => {
  it('accepts the smallest request and fills the defaults', () => {
    const parsed = parseAskRequest({ bookId: 'b1', mode: 'preview' })
    expect(parsed).toEqual({
      ok: true,
      request: {
        bookId: 'b1',
        mode: 'preview',
        rung: 'pointer',
        section: { label: null, text: null, offset: null, truncated: false },
        fraction: null,
        selection: null,
        question: null
      }
    })
  })

  it('carries every member of a full ask', () => {
    const parsed = parseAskRequest({
      bookId: 'b1',
      mode: 'ask',
      rung: 'passage',
      section: { label: 'Chapter 4', text: 'Body text.', offset: 5, truncated: false },
      fraction: 0.42,
      selection: 'a highlighted sentence',
      question: 'What does this mean?'
    })
    expect(parsed.ok && parsed.request).toMatchObject({
      mode: 'ask',
      rung: 'passage',
      section: { label: 'Chapter 4', text: 'Body text.', offset: 5 },
      fraction: 0.42,
      selection: 'a highlighted sentence',
      question: 'What does this mean?'
    })
  })

  it('ignores members it does not know, at both levels', () => {
    const parsed = parseAskRequest({
      bookId: 'b1',
      mode: 'probe',
      futureMember: { a: 1 },
      section: { label: 'x', futureToo: true }
    })
    expect(parsed.ok).toBe(true)
  })

  it('needs a question for an ask, and only for an ask', () => {
    expect(parseAskRequest({ bookId: 'b1', mode: 'ask' }).ok).toBe(false)
    expect(parseAskRequest({ bookId: 'b1', mode: 'ask', question: '   ' }).ok).toBe(false)
    expect(parseAskRequest({ bookId: 'b1', mode: 'probe' }).ok).toBe(true)
    expect(parseAskRequest({ bookId: 'b1', mode: 'preview' }).ok).toBe(true)
  })

  it('holds the section text to its cap: at the cap passes, one past is refused', () => {
    const at = 'x'.repeat(ASK_SECTION_TEXT_MAX_CHARS)
    expect(parseAskRequest({ bookId: 'b1', mode: 'probe', section: { text: at } }).ok).toBe(true)
    expect(
      parseAskRequest({ bookId: 'b1', mode: 'probe', section: { text: at + 'x' } }).ok
    ).toBe(false)
  })

  it.each([
    ['not an object', 'text'],
    ['an array', []],
    ['null', null],
    ['no book id', { mode: 'ask', question: 'q' }],
    ['a blank book id', { bookId: '  ', mode: 'preview' }],
    ['an over-long book id', { bookId: 'x'.repeat(201), mode: 'preview' }],
    ['an unknown mode', { bookId: 'b1', mode: 'stream' }],
    ['an unknown rung', { bookId: 'b1', mode: 'preview', rung: 'chapter' }],
    ['a non-object section', { bookId: 'b1', mode: 'preview', section: 'text' }],
    ['a non-string label', { bookId: 'b1', mode: 'preview', section: { label: 4 } }],
    ['a negative offset', { bookId: 'b1', mode: 'preview', section: { offset: -1 } }],
    ['a NaN offset', { bookId: 'b1', mode: 'preview', section: { offset: Number.NaN } }],
    ['a string offset', { bookId: 'b1', mode: 'preview', section: { offset: '5' } }],
    ['a non-boolean truncated', { bookId: 'b1', mode: 'preview', section: { truncated: 'yes' } }],
    ['a fraction above 1', { bookId: 'b1', mode: 'preview', fraction: 1.1 }],
    ['a negative fraction', { bookId: 'b1', mode: 'preview', fraction: -0.1 }],
    ['a non-string selection', { bookId: 'b1', mode: 'preview', selection: 7 }],
    ['an over-long question', { bookId: 'b1', mode: 'ask', question: 'q'.repeat(10_001) }]
  ])('refuses %s', (_name, body) => {
    expect(parseAskRequest(body)).toEqual({ ok: false })
  })
})
