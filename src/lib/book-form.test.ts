import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { makeBook } from '../../test/helpers/book'
import { editsSince, toForm } from './book-form'

describe('editsSince', () => {
  const opened = {
    ...makeBook('b1', 'Dune'),
    author: 'Frank Herbert',
    publisher: null,
    description: null,
    publishedDate: null
  }

  it('sends nothing for a form nobody touched', () => {
    expect(editsSince(opened, toForm(opened))).toEqual({})
  })

  it('sends only the field the person changed', () => {
    const form = { ...toForm(opened), author: 'F. Herbert' }
    const sent = Object.keys(editsSince(opened, form))
    expect(sent).toContain('author')
    // Derived from the author, so it follows it, but nothing else does
    expect(sent.filter((k) => k !== 'author' && k !== 'authorSort')).toEqual([])
  })

  it('does not read what a fetch did to the book meanwhile as an edit (2026-10-11)', () => {
    // The panel opened on `opened`; a fetch then filled these three. The form
    // still holds the blanks it opened with, and the person only edits the author.
    const form = { ...toForm(opened), author: 'F. Herbert' }
    const sent = editsSince(opened, form)
    expect(sent).not.toHaveProperty('publisher')
    expect(sent).not.toHaveProperty('description')
    expect(sent).not.toHaveProperty('publishedDate')
  })

  it('does not treat a value the form normalises as an edit', () => {
    const odd = { ...opened, publisher: '  Ace  ', description: '' }
    expect(editsSince(odd, toForm(odd))).toEqual({})
  })

  it('sends a field the person blanked', () => {
    const held = { ...opened, publisher: 'Ace' }
    expect(editsSince(held, { ...toForm(held), publisher: '' })).toEqual({ publisher: null })
  })
})

// The component has no DOM harness (vitest here is Node), so which book the
// save is measured against is decided by reading the source, as the theme
// suite does. The helper above is the logic; this pins that the panel uses it
// with the snapshot and not with the live row.
describe('BookEditor.save', () => {
  const src = readFileSync(join(__dirname, '../components/library/BookEditor.tsx'), 'utf8')

  it('measures the form against the book as opened', () => {
    expect(src).toMatch(/editsSince\(opened, form\)/)
  })

  it('never diffs against the live store row', () => {
    expect(src).not.toMatch(/changedFields\(\s*book\b/)
    expect(src).not.toMatch(/editsSince\(\s*book\b/)
  })
})
