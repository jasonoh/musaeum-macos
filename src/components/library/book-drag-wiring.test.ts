import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Source walks over the two drag sources, in `src/components/library` (AC25).
 *
 * The spec decided the drag lives on the card's outer box and the list's `<tr>`,
 * not on the buttons inside them (S1): the buttons own the click gestures, and
 * a press over one routes to its nearest draggable ancestor — the live probe
 * confirmed `dragstart` firing with the target on `DIV.group.relative` and on
 * `TR` (Task 1). Invariant 7 is this file's other subject: the drag adds
 * attributes and handlers and no DOM child; the geometry constants themselves
 * are pinned in `shelf-list-wiring.test.ts`.
 *
 * What a source walk can and cannot prove: see `context-menu-wiring.test.ts`.
 * There is no DOM harness in this repo (vitest runs in the Node environment), so
 * what is *wired* is read off the files and what is *painted* is the running
 * app's — the CDP probe, which is also where "a drag starts at all" was
 * decided. What this file does not prove: that the browser raises `dragstart`
 * from the elements these files mark draggable, or where the drag image lands.
 */
const read = (file: string): string =>
  readFileSync(join(process.cwd(), 'src', 'components', 'library', file), 'utf8')

/** Block comments stripped before matching — see `bare()` in `shelf-list-wiring.test.ts`. */
const bare = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '')

const CARD = read('BookCard.tsx')
const LIST = read('ListView.tsx')

describe('the drag sources (AC25, invariant 7)', () => {
  it('makes the card box and the list row draggable, not the buttons inside them', () => {
    // The card's button is its click target and the row's <tr> owns its own
    // clicks; the drag belongs to the box that covers both the artwork and the
    // meta lines (S1)
    expect(bare(CARD)).toMatch(/^\s+draggable$/m) // a bare `draggable` on the card's root div
    expect(bare(LIST)).toMatch(/^\s+draggable$/m)
    // Not the buttons: `[\s\S]{0,600}` rather than `[^>]*`, because a button's
    // props are one per line and `[^>]*` would sail past its opening tag and
    // match nothing whatever the file said
    expect(bare(CARD)).not.toMatch(/<button[\s\S]{0,600}?draggable/)
    expect(bare(LIST)).not.toMatch(/<button[\s\S]{0,600}?draggable/)
  })

  it('starts the drag through the one module, and ends it by clearing the payload', () => {
    for (const source of [bare(CARD), bare(LIST)]) {
      expect(source).toMatch(/startBookDrag\(/)
      expect(source).toMatch(/clearDragPayload/)
    }
  })

  it('builds no drag image and adds no child in either view (invariant 7)', () => {
    // The fan is constructed offscreen, in the module, precisely so it is not a
    // node in a view: `setDragImage` is the only way a view could grow one, and
    // neither box may name it
    for (const source of [bare(CARD), bare(LIST)]) {
      expect(source).not.toMatch(/setDragImage|dragImage/)
    }
  })
})
