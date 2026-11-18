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
    // Not the buttons — counted, not windowed: a `<button[\s\S]{0,600}?draggable`
    // window ends before the card's delete control four thousand characters
    // later, so it could not see a `draggable` button there whatever the file
    // said. Exactly one bare `draggable` per view is the property that is meant.
    const draggables = (source: string): number => (source.match(/^\s+draggable$/gm) ?? []).length
    expect(draggables(bare(CARD))).toBe(1)
    expect(draggables(bare(LIST))).toBe(1)
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

  it('reorders through the one hook module, on the box that is draggable (slice 2)', () => {
    for (const source of [bare(CARD), bare(LIST)]) {
      expect(source).toMatch(
        /import \{[^}]*useReorderableShelfId[^}]*\} from '@\/hooks\/useQueueReorder'/
      )
      // the open queue's id is the drag's fourth argument, so the slot knows where it began
      expect(source).toMatch(/const reorderShelfId = useReorderableShelfId\(\)/)
      expect(source).toMatch(
        /startBookDrag\(\s*e,\s*book\.id,\s*useUIStore\.getState\(\)\.selection,\s*reorderShelfId\s*\)/
      )
      // the three handlers sit between `draggable` and the end of that one opening tag
      const box = source.match(/^\s+draggable$[\s\S]*?^\s+>$/m)?.[0] ?? ''
      expect(box).toMatch(/onDragOver=\{[^}]*reorderDragOver\(/)
      expect(box).toMatch(/onDragLeave=\{[^}]*reorderDragLeave\(/)
      expect(box).toMatch(/onDrop=\{[^}]*reorderDrop\(/)
    }
  })

  it('measures the drop point on the box itself: rows by height, cards by width', () => {
    expect(bare(LIST)).toMatch(/e\.clientY - rect\.top/)
    expect(bare(LIST)).toMatch(/rect\.height/)
    expect(bare(CARD)).toMatch(/e\.clientX - rect\.left/)
    expect(bare(CARD)).toMatch(/rect\.width/)
    for (const source of [bare(CARD), bare(LIST)]) {
      expect(source).toMatch(/e\.currentTarget\.getBoundingClientRect\(\)/)
    }
  })

  it('never stops a drag event from reaching the window, which clears the payload', () => {
    for (const source of [bare(CARD), bare(LIST)]) {
      // the row's checkbox cell stops a *click*; no drag handler may stop anything
      expect(source).not.toMatch(/onDrag\w+=\{[^}]*stopPropagation/)
      expect(source).not.toMatch(/onDrop=\{[^}]*stopPropagation/)
    }
  })

  it('paints the drop point from useDropSide with a shadow, never a border or padding (invariant 7)', () => {
    for (const source of [bare(CARD), bare(LIST)]) {
      expect(source).toMatch(/const side = useDropSide\(book\.id\)/)
      // every class the mark selects is a shadow: take the ternary from its first
      // `side ===` to its empty fallback and read the quoted classes inside it
      const span = source.match(/side === 'before'[\s\S]*?: ''/)?.[0] ?? ''
      const classes = [...span.matchAll(/'([^']+)'/g)]
        .map((m) => m[1])
        .filter((c) => c !== 'before' && c !== 'after')
      expect(classes.length).toBeGreaterThanOrEqual(2)
      for (const cls of classes) {
        expect(cls).toMatch(/shadow-\[/)
        expect(cls).not.toMatch(/(?:^|[\s:])-?(?:border|outline|[pm][xytblr]?|gap|space-[xy])-/)
      }
    }
  })
})

describe('the reorder hook module (slice 2)', () => {
  const HOOK = bare(readFileSync(join(process.cwd(), 'src', 'hooks', 'useQueueReorder.ts'), 'utf8'))

  it('stops nothing and never answers a drag with a copy', () => {
    expect(HOOK).not.toMatch(/stopPropagation/)
    expect(HOOK).not.toMatch(/dropEffect = 'copy'/)
  })

  it('goes through reorderInQueue and never writes the order itself', () => {
    expect(HOOK).toMatch(/reorderInQueue\(/)
    expect(HOOK).not.toMatch(/setBookOrder/)
  })
})
