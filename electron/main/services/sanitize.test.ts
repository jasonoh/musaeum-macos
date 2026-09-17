import { describe, expect, it } from 'vitest'
import { sanitizeTitle } from './sanitize'

/**
 * `sanitizeTitle` decides the on-disk name of every book file — at import, at
 * `renameToTitle` after a settled title, and at the name a copy is sent to a
 * device under (`docs/invariants/files-and-deletion.md`). Nothing reads those
 * names back (every lookup is by extension), so the cost of a change here is
 * not a broken lookup: it is a library whose filenames quietly stop matching
 * the titles, and device presence detection — which compares device file stems
 * against `sanitizeTitle(book.title)` — silently missing books.
 *
 * These cases pin what the function does today, derived from the
 * implementation, not from what a filename sanitizer ought to do.
 */
describe('sanitizeTitle', () => {
  describe('what it strips', () => {
    it('removes the nine filesystem-hostile characters', () => {
      // Exactly the set in the first character class: / \ : * ? " < > |
      expect(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij')
    })

    it('deletes them rather than substituting a separator', () => {
      // No '-' or '_' stand-in: "Dune: Part One" loses the colon and keeps the
      // space that already followed it, rather than gaining one.
      expect(sanitizeTitle('Dune: Part One')).toBe('Dune Part One')
    })

    it('strips C0 control characters outright, so a tab joins the words it separated', () => {
      // The control-character pass runs *before* the whitespace collapse, and
      // tab/newline/carriage return are all inside \u0000-\u001f — so they are
      // removed, not turned into a space.
      expect(sanitizeTitle('Hello\tWorld')).toBe('HelloWorld')
      expect(sanitizeTitle('Line\nBreak')).toBe('LineBreak')
      expect(sanitizeTitle('Carriage\rReturn')).toBe('CarriageReturn')
      expect(sanitizeTitle('nul\u0000and\u001funit')).toBe('nulandunit')
    })

    it('leaves the first character above the control range alone', () => {
      // \u001f is the last stripped code point; the space at \u0020 is not
      // stripped by that pass — it is whitespace, and survives as a space.
      expect(sanitizeTitle('a\u001fb')).toBe('ab')
      expect(sanitizeTitle('a b')).toBe('a b')
    })
  })

  describe('whitespace', () => {
    it('collapses runs of whitespace to a single space', () => {
      expect(sanitizeTitle('A    B')).toBe('A B')
      expect(sanitizeTitle('one  two   three')).toBe('one two three')
    })

    it('collapses non-breaking space to an ordinary space', () => {
      // \s in JS matches \u00a0, so an nbsp pasted from a web page does not
      // survive into the filename as an nbsp.
      expect(sanitizeTitle('Dune\u00a0Messiah')).toBe('Dune Messiah')
      expect(sanitizeTitle('a\u00a0\u00a0b')).toBe('a b')
    })

    it('trims leading and trailing whitespace', () => {
      expect(sanitizeTitle('   padded   ')).toBe('padded')
      expect(sanitizeTitle('\u00a0Dune\u00a0')).toBe('Dune')
    })

    it('trims whitespace that only appears once the hostile characters are gone', () => {
      // The strip runs first, so '"  Dune  "' has nothing left to protect its
      // padding and comes back trimmed.
      expect(sanitizeTitle('"  Dune  "')).toBe('Dune')
    })
  })

  describe('the degenerate cases that would otherwise produce an extensionless file', () => {
    it('falls back to "untitled" for an empty string', () => {
      expect(sanitizeTitle('')).toBe('untitled')
    })

    it('falls back to "untitled" when the input is only whitespace', () => {
      expect(sanitizeTitle('   ')).toBe('untitled')
      expect(sanitizeTitle('\t\n')).toBe('untitled')
    })

    it('falls back to "untitled" when every character was stripped', () => {
      expect(sanitizeTitle('///')).toBe('untitled')
      expect(sanitizeTitle('<>:"|?*')).toBe('untitled')
    })

    it('does not fall back for a title that merely looks degenerate', () => {
      // '.' is not in the strip set, so these survive as themselves — the
      // fallback is reached only when nothing at all is left.
      expect(sanitizeTitle('..')).toBe('..')
      expect(sanitizeTitle('0')).toBe('0')
    })
  })

  describe('the length cap', () => {
    it('caps the result at 80 characters', () => {
      const long = 'a'.repeat(200)
      expect(sanitizeTitle(long)).toHaveLength(80)
      expect(sanitizeTitle(long)).toBe('a'.repeat(80))
    })

    it('leaves anything at or under 80 characters untouched', () => {
      const exact = 'b'.repeat(80)
      expect(sanitizeTitle(exact)).toBe(exact)
      expect(sanitizeTitle('c'.repeat(79))).toHaveLength(79)
    })

    it('measures the cap after stripping and collapsing, not on the raw input', () => {
      // 90 'a's separated by colons: the colons go first, so what is measured
      // is the 90-character cleaned string.
      expect(sanitizeTitle('a'.repeat(90).split('').join(':'))).toBe('a'.repeat(80))
    })

    it('cuts at exactly 80 with no word-boundary awareness, so the cut can land mid-word', () => {
      expect(sanitizeTitle(`${'a'.repeat(75)} ${'b'.repeat(20)}`)).toBe(`${'a'.repeat(75)} bbbb`)
    })

    it('applies the cut after the trim, so a cut title can end with a space', () => {
      // Pinning real behaviour, not endorsing it: `.trim()` runs before
      // `.slice(0, 80)`, so a title whose 80th character is a space keeps it.
      const cut = sanitizeTitle(`${'a'.repeat(79)} bbbb`)
      expect(cut).toBe(`${'a'.repeat(79)} `)
      expect(cut.endsWith(' ')).toBe(true)
    })
  })

  describe('what it deliberately leaves alone', () => {
    it('keeps punctuation that is legal on the filesystem', () => {
      const title = "L'Étranger & Co. (Vol. 1) [rev] #2 100% ~ok! {x} ,;=+^@$"
      expect(sanitizeTitle(title)).toBe(title)
    })

    it('keeps the hyphen, the dot and the underscore', () => {
      expect(sanitizeTitle('Anti-Oedipus_v2.final')).toBe('Anti-Oedipus_v2.final')
    })

    it('keeps a trailing dot and a leading dot', () => {
      // Hostile on Windows and invisible on macOS, but not stripped here.
      expect(sanitizeTitle('Who Goes There.')).toBe('Who Goes There.')
      expect(sanitizeTitle('.hidden')).toBe('.hidden')
    })

    it('preserves case', () => {
      expect(sanitizeTitle('The Left Hand of Darkness')).toBe('The Left Hand of Darkness')
    })

    it('preserves accented Latin, CJK and typographic dashes', () => {
      expect(sanitizeTitle('Café Ünïcødé 日本語 — em—dash')).toBe('Café Ünïcødé 日本語 — em—dash')
    })

    it('preserves an already-clean title exactly', () => {
      // Idempotence matters: renameToTitle re-derives the stem on every title
      // change and skips files whose stem already matches.
      const clean = sanitizeTitle('Dune: Part One?')
      expect(sanitizeTitle(clean)).toBe(clean)
    })
  })
})
