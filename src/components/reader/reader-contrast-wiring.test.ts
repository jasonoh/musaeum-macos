import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * AC8 of `docs/superpowers/specs/2026-11-05-reader-contrast-guard-design.md`: the
 * half of the feature a pure function cannot decide — that the engine actually
 * calls the guard, where, and in what order. A source walk, as AC5.1's was:
 * `ReaderEngine.tsx` imports the vendored custom element and cannot be loaded
 * under vitest.
 */
const ENGINE = readFileSync(
  join(process.cwd(), 'src', 'components', 'reader', 'ReaderEngine.tsx'),
  'utf8'
)

/** The text from `start` to the next `end` after it. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from, `"${start}" is in ReaderEngine.tsx`).toBeGreaterThan(-1)
  const to = source.indexOf(end, from + start.length)
  expect(to, `"${end}" follows "${start}"`).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe('the reader runs the contrast guard (AC8)', () => {
  it('imports the guard from the contrast module', () => {
    expect(ENGINE).toMatch(
      /import \{[^}]*guardSectionContrast[^}]*\} from '@\/lib\/theme\/reader-contrast'/
    )
  })

  it('guards each section as it loads, with the palette the page is using', () => {
    const load = between(ENGINE, "view.addEventListener('load'", 'void (async () => {')
    expect(load).toContain('guardSectionContrast(doc,')
    expect(load).toContain('resolveReaderPalette(prefsRef.current.theme, tokensRef.current)')
  })

  it('re-guards the live sections after setStyles, never before it', () => {
    const effect = between(
      ENGINE,
      'renderer?.setStyles?.(readerPageCss(prefs,',
      '}, [prefs, tokens, viewRef])'
    )
    const setStyles = ENGINE.indexOf('renderer?.setStyles?.(readerPageCss(prefs,')
    const guard = ENGINE.indexOf('guardSectionContrast(', setStyles)
    expect(guard).toBeGreaterThan(setStyles)
    expect(effect).toContain('liveDocs.current')
  })

  it('stays out of books whose renderer cannot style the page (fixed layout)', () => {
    // fixed-layout.js has no setStyles, so readerPageCss never paints those pages:
    // "nothing opaque in the chain" does not mean palette.bg there (review, Critical).
    const load = between(ENGINE, "view.addEventListener('load'", 'void (async () => {')
    const gate = load.indexOf("typeof view.renderer?.setStyles === 'function'")
    expect(gate).toBeGreaterThan(-1)
    expect(load.indexOf('guardSectionContrast(doc,')).toBeGreaterThan(gate)
    const effect = between(
      ENGINE,
      'renderer?.setStyles?.(readerPageCss(prefs,',
      '}, [prefs, tokens, viewRef])'
    )
    expect(effect).toContain("typeof renderer?.setStyles === 'function'")
  })

  it('forgets a detached section as the next one loads, not only on a theme change', () => {
    const load = between(ENGINE, "view.addEventListener('load'", 'void (async () => {')
    expect(load).toContain('.defaultView')
    expect(load).toContain('liveDocs.current.delete(')
  })

  it('drops detached sections and forgets them all when the book closes', () => {
    expect(ENGINE).toContain('doc.defaultView')
    const cleanup = between(ENGINE, 'disposed = true', 'view.remove()')
    expect(cleanup).toContain('docs.clear()')
  })
})
