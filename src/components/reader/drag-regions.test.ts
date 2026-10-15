import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The reader's titlebar and the window's drag regions.
 *
 * **Draggable regions ignore pointer events, and they are collected from the
 * whole document** — an overlay does *not* subtract the regions of the chrome
 * it paints over (Electron, *Custom Window Interactions*: "a button element
 * that overlaps a draggable region will not emit mouse clicks or mouse
 * enter/exit events within that overlapping area"). The library's sidebar
 * strip and toolbar both declare `app-drag` across the top of the window and
 * stay mounted behind the reader, so while a book is open they are still
 * dragging under it — over exactly the band this header's controls occupy.
 *
 * The consequence is a failure no other instrument in this repo can see: the
 * keyboard worked (Escape closed the book, arrows turned pages), the DOM was
 * perfect, `document.elementFromPoint` at each button returned the button, and
 * `element.click()` opened every panel — while a *real* mouse click did
 * nothing at all, because the browser process ate it before the renderer ever
 * saw it. Reported by the owner 2026-09-20: "none of the controls are
 * activated — they're unclickable".
 *
 * So the pairing is load-bearing in both directions, and both halves are here:
 * the header declares `app-drag` (the strip must still move the window — before
 * this it did so only by accident, borrowing the library's region underneath),
 * and **every** control inside it declares `app-no-drag` (the documented
 * requirement for a custom title bar).
 *
 * What this file does not prove: that the *rendered* regions are clear. That
 * needs a real mouse, and this machine refuses assistive access (the same
 * standing gap as the native menu item). The band can be audited over CDP —
 * enumerate every interactive element whose rect falls in the top band and
 * require a `no-drag` self-or-ancestor — and was, before and after this fix.
 */
const SOURCE = readFileSync(
  join(process.cwd(), 'src', 'components', 'reader', 'ReaderView.tsx'),
  'utf8'
)

const HEADER = SOURCE.slice(SOURCE.indexOf('<header'), SOURCE.indexOf('</header>'))

/** Every `<button …>` opening tag inside the header, as text. */
function headerButtonTags(): string[] {
  return HEADER.split('<button')
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf('>')))
}

describe("the reader's titlebar against the window's drag regions", () => {
  it('declares the header draggable, so the strip moves the window on purpose', () => {
    const className = /className="([^"]*)"/.exec(HEADER)?.[1] ?? ''
    expect(className.split(/\s+/)).toContain('app-drag')
  })

  it('keeps the drag handle in front of the traffic lights', () => {
    const firstDiv = HEADER.split('<div')[1]?.slice(0, 200) ?? ''
    expect(firstDiv).toContain('app-drag')
  })

  it('excludes every control in the header from the drag regions', () => {
    const tags = headerButtonTags()
    // Anti-vacuity: a walk that finds no buttons would pass by finding nothing
    expect(tags.length).toBeGreaterThanOrEqual(5)
    for (const tag of tags) {
      const label = /aria-label="([^"]*)"/.exec(tag)?.[1] ?? tag.slice(0, 40)
      expect(tag, `${label} must be app-no-drag or its clicks are swallowed`).toContain(
        'app-no-drag'
      )
    }
  })
})

/**
 * The selection chip (D8.1) is the reader's one **floating** control, which is
 * what makes it this file's business: its rect is computed at runtime from the
 * selection, so it can land anywhere — including over the reader's own header
 * (which declares `app-drag`) and over the library's two strips still mounted
 * behind the overlay, both of which span the top of the window.
 *
 * Wherever it lands, the rule is the one above: a control inside a draggable
 * region takes no mouse input at all (`docs/invariants/reader.md:45`). A static
 * check cannot say *where* the chip lands — only the running app can, and that is
 * AC20's frame — but it can say that the marker is on it.
 *
 * **The chip's source is read with its comments stripped, and that is load-bearing
 * rather than tidy.** The comment that explains the marker sits *inside* the
 * button's own opening tag, so a walk over the raw text finds `app-no-drag` in the
 * prose and passes with the attribute deleted — measured: the first version of
 * this walk survived exactly that mutation. Stripping comments is the same
 * technique `src/lib/storage-copy-scan.test.ts` uses for the same reason.
 */
const CHIP = readFileSync(
  join(process.cwd(), 'src', 'components', 'reader', 'SelectionChip.tsx'),
  'utf8'
)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|\s)\/\/[^\n]*/gm, '$1')

describe('the selection chip against the window’s drag regions', () => {
  it('marks every chip button as no-drag, so a rect in the top band is still clickable', () => {
    const [, ...rest] = CHIP.split('<button')
    // Highlight and Read from here: a walk that found one would pass with the second unmarked.
    expect(rest.length).toBeGreaterThanOrEqual(2)
    // The class list both buttons share, read as the attribute a click actually reads.
    const shared = /const buttonClass =\s*'([^']*)'/.exec(CHIP)?.[1] ?? ''
    expect(shared, 'the chip’s shared class list').not.toBe('')
    expect(shared.split(/\s+/)).toContain('app-no-drag')
    for (const part of rest) {
      const tag = part.slice(0, part.indexOf('>\n'))
      expect(tag, 'each chip button takes the shared class list').toContain(
        'className={buttonClass}'
      )
    }
  })

  it('positions itself in viewport coordinates, which is what a fixed box reads', () => {
    // The engine hands it the selection's rect translated into the top document's
    // (reading R15); `fixed` is the only positioning whose numbers mean that.
    expect(CHIP).toContain('fixed')
    expect(CHIP).toContain('rect.left + rect.width / 2')
  })
})
