import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The picker's wiring, walked in the source — the criteria these slices name as
 * source walks, in the one place a component's wiring can be decided at all
 * (the renderer has no DOM harness: `vitest` runs `environment: 'node'`).
 *
 * Each case states its limit where it states its rule. A walk proves the
 * sentence and the call site; it does not prove a person can see the sentence
 * or that the call succeeds — that half is the running-app probe's, recorded in
 * the slice's annex.
 */
const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')

const PICKER = 'src/components/library/CoverPicker.tsx'
const PRELOAD = 'electron/preload/index.ts'

describe('AC14a — the picker calls the existing surface and adds no channel', () => {
  it('reaches the main process only through methods the preload already exposes', () => {
    // Its limit: this proves the *call sites* and their names. It cannot prove
    // the calls resolve at runtime — an unbound name in the preload would pass
    // here and fail in the app — so the probe opens the dialog and picks.
    const picker = read(PICKER)
    const preload = read(PRELOAD)

    // `\s*` before each dot on purpose: prettier wraps `window.Musaeum.metadata`
    // and `.coverCandidates(bookId)` onto two lines, and a pattern that assumed
    // one line found two of the four calls (measured) — a walk that fails open.
    const calls = [...picker.matchAll(/window\.Musaeum\.(\w+)\s*\.\s*(\w+)/g)].map(
      (m) => `${m[1]}.${m[2]}`
    )
    const distinct = [...new Set(calls)].sort()

    // Exactly the five the picker needs: the gather, the write, the lock's
    // read, the lock's release, and — as of slice 3a-ii — the wider search. A
    // sixth name means a new surface rode in with the picker, which is what this
    // criterion forbids; `searchCovers` is the one addition that was decided in
    // a design (`2026-09-25-cover-sources-design.md`, D2) rather than slipping in.
    expect(distinct).toEqual([
      'library.getFieldOverrides',
      'library.releaseFieldOverride',
      'metadata.coverCandidates',
      'metadata.searchCovers',
      'metadata.setCover'
    ])
    for (const call of distinct) {
      const method = call.split('.')[1]
      expect(preload).toContain(`${method}:`)
    }
  })

  it('names no IPC channel of its own', () => {
    const picker = read(PICKER)
    // The renderer never sees a channel; one appearing here means the picker
    // reached past the preload
    expect(picker).not.toMatch(/ipcRenderer/)
    expect(picker).not.toMatch(/\.invoke\(/)
    expect(picker).not.toMatch(/['"]library:[a-zA-Z]+['"]/)
  })
})

describe('AC8b — the wider search is asked about this book, and only on a press', () => {
  it('calls searchCovers with the book id and nothing else', () => {
    // Its limit: this decides the call's *argument*, which is the half a walk
    // can decide. That the search reaches the sidecar and comes back is the
    // service test's and the probe's (AC7); that the tiles arrive labelled is
    // `cover-candidate-state.test.ts`'s.
    const picker = read(PICKER)

    // `\s*` between the dots for the same measured reason as the walk above:
    // prettier wraps `window.Musaeum.metadata` onto its own line when the call
    // is part of a chain, and a pattern that assumed one line found too few.
    const call = picker.match(
      /window\.Musaeum\s*\.\s*metadata\s*\.\s*searchCovers\s*\(\s*([^)]*)\)/
    )
    expect(call).not.toBeNull()

    // The argument is the book's id and only that. The service resolves the
    // file, the book dir and `known` from the row itself, so a second argument
    // here would be a value the renderer decided — and the renderer decides
    // none of those three (the rule AC5 holds the service to, from this side).
    expect(call?.[1].trim()).toBe('book.id')
  })

  it('asks it once, from the press, and derives the group through the pure rule', () => {
    const picker = read(PICKER)

    // One call site and no other: a fetch must not ask this question (D1), and
    // neither may the dialog on open — the press is the whole trigger.
    expect(picker.match(/searchCovers\s*\(/g)).toHaveLength(1)

    // The rule that keeps "still asking" and "came back with nothing" apart is
    // the module's, where a unit case can decide it; the JSX renders its answer
    // rather than writing a sentence of its own.
    expect(picker).toContain('searchedCoverTiles(')

    // And the group says what it is. `\s+`, not a space: prettier reflows JSX
    // text, so the sentence arrives split across two lines in the source.
    expect(picker).toContain('Look for more covers')
    expect(picker).toContain('From a wider search')
    expect(picker).toMatch(/A fetch would not\s+write any of them/)
  })
})

describe('AC17a — the editor says where a cover lock is released', () => {
  it('keeps the sentence every other field depends on, and adds the cover clause', () => {
    // Its limit: it proves the paragraph's text, not its legibility — the probe
    // opens the editor on a book with a cover override and reads the paragraph
    // off the screen.
    const editor = read('src/components/library/BookEditor.tsx')

    // The sentence that was already true for every other field survives
    expect(editor).toMatch(
      /The padlock beside a field hands it back to Musaeum — its value stays\./
    )
    // …and the one field without a padlock now says where its release is
    expect(editor).toMatch(/is released from/)
    expect(editor).toMatch(/Choose cover/)
    // The instruction must not survive in a form that sends the reader looking
    // for a padlock beside Cover: the summary is the *only* place the lock is
    // named per field, and it must not claim a control that does not exist
    expect(editor).not.toMatch(/padlock beside Cover/)
  })
})
