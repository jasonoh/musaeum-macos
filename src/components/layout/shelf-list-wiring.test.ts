import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Source walks over the shelf chrome: the sidebar section, the Library row, the
 * sort control and the search placeholder.
 *
 * What a source walk can and cannot prove: see `context-menu-wiring.test.ts`.
 * There is no DOM harness in this repo (vitest runs in the Node environment), so
 * what is *wired* is read off the files and what is *painted* is the running
 * app's — the CDP probe. What a walk cannot prove: that a click reaches the
 * handler, or that the row is where the eye expects it.
 */
const read = (file: string): string =>
  readFileSync(join(process.cwd(), 'src', 'components', 'layout', file), 'utf8')

/**
 * Source with block comments removed. A comment *naming* a pattern is not the
 * pattern: this file's own explanatory comments quote `role="button"` and
 * "Drag books here", and matching either is how a walk fails spuriously. Line
 * comments are left alone — stripping `//` would also cut `musaeum://`, which
 * weakens a negative assertion rather than strengthening it.
 */
const bare = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '')

/** A file outside `layout/`, for the walks that span a component boundary. */
const readSrc = (...parts: string[]): string =>
  readFileSync(join(process.cwd(), 'src', ...parts), 'utf8')

const SOURCE = read('ShelfList.tsx')

describe('the shelf section (AC16)', () => {
  it('renders main\u2019s list as it arrives, with its counts', () => {
    expect(SOURCE).toMatch(/useShelvesStore\(/)
    expect(SOURCE).toMatch(/\{shelf\.count\}/)
  })

  it('creates and renames through the one inline field', () => {
    expect(SOURCE).toMatch(/shelves\.create\(/)
    expect(SOURCE).toMatch(/shelves\.rename\(/)
    // Two expressions, deliberately: the `if` in `commit` and the render check
    // are different lines, and asserting only the first passes with the field
    // itself removed from the tree
    expect(SOURCE).toMatch(/if \(editing\.mode === 'create'\)/)
    expect(SOURCE).toMatch(/\{editing\?\.mode === 'create' && \(/)
  })

  it('names the shelf and its count before it is deleted (D9, AC16)', () => {
    // The confirmation's job is that a person cannot delete a shelf believing
    // they are deleting books
    expect(SOURCE).toContain('Delete the shelf \u201c')
    expect(SOURCE).toContain('books stay in your library')
  })

  it('deletes no book', () => {
    // The one thing this file must not reach for: shelf deletion is a file
    // write, and books are not in it
    expect(SOURCE).not.toMatch(/deleteBook|deleteBooks|deletingBookId|deletingSelection/)
  })

  it('reports a refusal through the session reporter', () => {
    expect(SOURCE).toMatch(/reportShelfFailure/)
  })

  it('gates its writes on the status the write gate reads (R7)', () => {
    expect(SOURCE).toMatch(/state === 'connected'/)
    expect(SOURCE).toMatch(/copy\.deleteBlocked/)
  })

  it('is a drop target, on the rows and on the two create controls (AC26)', () => {
    const src = bare(SOURCE)
    expect(src).toMatch(/onDragOver=/)
    expect(src).toMatch(/onDrop=/)
    expect(src).toMatch(/dragPayload\(\)/)
    // The payload is read in the target's own handler, and the window's drop
    // clears it: an `e.stopPropagation()` in a *drop* handler would leave the
    // slot populated for the next drag to pick up (S5, Review Focus 1). Scoped
    // to the handler block on purpose — the row menu stops propagation on its
    // own click, and a bare `not.toMatch` over the file would fail on that
    // instead of on a drop. The end anchor is the *next* `return (` after the
    // handler, not the file's first: that one is the menu effect's cleanup
    // (`return () => {`), which sits above these handlers.
    const start = src.indexOf('const canAcceptDrop')
    const dragBlock = src.slice(start, src.indexOf('return (', start))
    expect(dragBlock.length).toBeGreaterThan(200)
    expect(dragBlock).not.toMatch(/stopPropagation/)
  })

  it('refuses a drop while the share cannot take a write (AC28)', () => {
    expect(bare(SOURCE)).toMatch(/dropEffect = 'none'/)
    // `online`, the same status the write gate reads — not a second opinion
    expect(bare(SOURCE)).toMatch(/!online/)
  })

  it('answers a book drag only — a stale slot cannot adopt a foreign drop (S1)', () => {
    // The gate is on the *event's* types, not the slot alone: a drag the window
    // never saw end can leave the slot populated, and a Finder file drop must
    // not be answered from it (the part-3a review's S1)
    expect(bare(SOURCE)).toMatch(/includes\(BOOK_DRAG_MIME\)/)
    expect(bare(SOURCE)).toMatch(/isBookDrag\(e\) &&/) // the ring's decision asks
    expect(bare(SOURCE)).toMatch(/!isBookDrag\(e\)/) // and the drop itself re-asks
  })

  it('adds through the shared module, so the toast is the module\u2019s (AC26)', () => {
    expect(bare(SOURCE)).toMatch(/addToShelf\(/)
    expect(bare(SOURCE)).not.toMatch(/Added \$\{/)
  })

  it('rings the row it is hovering, and moves nothing (invariant 7, S6)', () => {
    expect(bare(SOURCE)).toMatch(/ring-1 ring-gold-400/)
    // A `border` in the row's class list would add 2px to the row and move every
    // shelf below the hovered one while the drag is in flight — a screenshot
    // shows jitter, the build shows nothing (S6)
    expect(bare(SOURCE)).not.toMatch(/dropTarget[\s\S]{0,200}?border/)
  })

  it('promises only actions that work, and offers them as controls', () => {
    // The spec's empty state read "Drag books here to start a shelf", and D9's
    // pane named drag too. The sentence was cut when it named an action that
    // did not exist yet, and it does not come back now that drag *does* exist:
    // its "here" was never the pane — the drop target is the sidebar row — so
    // the copy rule stands on its own. No renderer copy may say it.
    const empty = readSrc('components', 'shared', 'EmptyLibrary.tsx')
    for (const source of [SOURCE, empty]) expect(bare(source)).not.toMatch(/Drag books here/i)
    // The cover <img> stays non-draggable now that the card itself is draggable
    // (slice 3): a draggable image inside the card would start the browser's
    // own image drag from inside ours, where the card box is what should be
    // picked up (D9)
    const card = readSrc('components', 'library', 'BookCard.tsx')
    expect(bare(card)).toMatch(/<img[\s\S]{0,200}?draggable=\{false\}/)
    // The empty state is a control, not an instruction: with no shelves the
    // first thing a reader does is press the action rather than be told of one
    expect(bare(SOURCE)).toMatch(/>\s*New shelf\s*</)
  })
})

const APP = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')
const GRID = readFileSync(
  join(process.cwd(), 'src', 'components', 'library', 'GridView.tsx'),
  'utf8'
)
const LIST = readFileSync(
  join(process.cwd(), 'src', 'components', 'library', 'ListView.tsx'),
  'utf8'
)
const CARD = readFileSync(
  join(process.cwd(), 'src', 'components', 'library', 'BookCard.tsx'),
  'utf8'
)

/** The literal a numeric constant is declared with, so a drift fails a test. */
const declared = (source: string, name: string): string | undefined =>
  source.match(new RegExp(`^(?:export )?const ${name} = (\\d+)$`, 'm'))?.[1]

describe('no element is added above either view, and no geometry moves (invariant 7)', () => {
  it('leaves the toolbar row exactly as it was: toolbar, banner, view', () => {
    // A view header naming the open shelf was designed and rejected for this
    // reason; the shelf is named in the sidebar row and the search field's
    // placeholder instead.
    //
    // Every element between the two is *named* rather than counted: a count
    // would also read 2 with a lowercase element added there, which is the
    // assertion's whole job.
    const main = APP.indexOf('<main')
    const between = APP.slice(APP.lastIndexOf('<Toolbar', main), main)
    expect(between.match(/<[A-Za-z][A-Za-z0-9.]*/g)).toEqual(['<Toolbar', '<NASStatusBanner'])
  })

  it('pins the three constants the views compute their geometry from', () => {
    // `library-views.md`'s rule is that these must match real DOM geometry, and
    // there is no DOM harness here to measure it, so what this pins is that a
    // *change* to one is deliberate and arrives as a failing test rather than as
    // silent scroll jank. The measurement itself stays the doc's, made by hand
    // (a 37px list pitch is a 36px `<tr>` plus its collapsed border), and the
    // cells that carry the constants are held by the diff review, not here.
    expect(declared(LIST, 'ROW_HEIGHT')).toBe('37')
    expect(declared(CARD, 'CARD_META_HEIGHT')).toBe('68')
    expect(declared(CARD, 'CARD_META_MARGIN')).toBe('8')
  })

  it('leaves the expressions that consume them intact', () => {
    expect(GRID).toMatch(/cardWidth \* 1\.5 \+ CARD_META_MARGIN \+ CARD_META_HEIGHT/)
    expect(LIST).toMatch(/height: ROW_HEIGHT - 1/)
    expect(CARD).toMatch(/height: CARD_META_HEIGHT, marginTop: CARD_META_MARGIN/)
  })
})

const TOOLBAR = read('Toolbar.tsx')
const SEARCH = readFileSync(
  join(process.cwd(), 'src', 'components', 'shared', 'SearchBar.tsx'),
  'utf8'
)

describe('the sort control (AC18)', () => {
  it('offers Date Added to Shelf only while a shelf is open', () => {
    expect(TOOLBAR).toMatch(/SHELF_SORT_OPTIONS/)
    expect(TOOLBAR).toMatch(/activeShelfId \? \[\.\.\.SHELF_SORT_OPTIONS, \.\.\.SORT_OPTIONS\]/)
  })

  it('offers both directions of it, and nothing else new', () => {
    expect(TOOLBAR).toMatch(/\{ field: 'shelf_added', direction: 'desc' \}/)
    expect(TOOLBAR).toMatch(/\{ field: 'shelf_added', direction: 'asc' \}/)
  })
})

describe('the placeholder (AC17)', () => {
  it('names the open shelf, read from the list rather than stored', () => {
    expect(SEARCH).toMatch(/shelfById\(/)
    expect(SEARCH).toContain('Search \u201c')
  })

  it('falls back to the stock sentence rather than a substitute', () => {
    // The list is empty for the first render after a cold start (R3), and a
    // placeholder reading `Search “undefined”` would be worse than this
    expect(SEARCH).toContain('Search titles, authors, series…')
  })
})

const SIDEBAR = read('Sidebar.tsx')

describe('the Library row is navigation (AC17)', () => {
  it('leaves the open shelf through setActiveShelf(null), the one way out', () => {
    // A later slice adding a second way to leave a shelf (a shortcut, a view
    // header) must call this rather than clear `activeShelfId` itself, or the
    // library sort is not restored — the plan's own slice-3 handoff note
    expect(bare(SIDEBAR)).toMatch(/setActiveShelf\(null\)/)
    expect(bare(SIDEBAR)).not.toMatch(/activeShelfId: null/)
  })

  it('nests no control inside another', () => {
    // The plan's snippet nested the reload `<button>` inside the Library
    // `<button>`, which HTML forbids; the `role="button"` div that replaced it
    // was valid but left a control inside a control, announced as a button
    // containing a button, with two tab stops. Two sibling buttons in a layout
    // wrapper is the shape with neither problem — and no manual tab stop,
    // because a real button brings its own.
    expect(bare(SIDEBAR)).not.toMatch(/role="button"/)
    expect(bare(SIDEBAR)).not.toMatch(/tabIndex=\{0\}/)
  })

  it('carries the count only while the library is what is loaded', () => {
    // The number is `books.length` — the *current read's* — so inside a shelf it
    // is the shelf's count beside the word "Library" (measured live: an empty
    // shelf made the row read "Library 0"). The shelf's own count is on its row,
    // from main.
    expect(bare(SIDEBAR)).toMatch(/\{activeShelfId === null && \(/)
  })

  it('mounts the shelf section in the same column', () => {
    expect(SIDEBAR).toMatch(/<ShelfList \/>/)
  })
})
