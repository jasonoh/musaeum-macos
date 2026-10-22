/**
 * The selection chip (spec D8.1) — a control at the selection's own rect.
 *
 * A selection is the one gesture whose position is unambiguous: the browser
 * knows the rect, so the affordance can be where the gesture is. Everything
 * after it is not — a highlight's own rect lives inside the book's iframe,
 * inside the paginator's **closed shadow root**, and mapping it back to window
 * coordinates is a coordinate problem with a version-dependent answer. That is
 * why the note editor is in the panel and this is the only thing that floats.
 *
 * The rect arrives in **viewport coordinates**, already translated by the engine
 * from the section frame's own (reading R15). This component positions and
 * nothing else: it measures nothing, and it holds no state.
 */

/** The selection's rect, as the engine measured it — a plain object, never a live `DOMRect`. */
export interface SelectionRect {
  left: number
  top: number
  width: number
  height: number
}

interface Props {
  rect: SelectionRect
  /** A create is in flight. */
  busy: boolean
  onActivate(): void
  /**
   * Start the voice reader at the selection; the engine passes it only when the
   * reader wired one, and the second button exists only then. It takes no argument: the
   * engine's handler closes over the selection's range and passes it on.
   */
  onReadFromHere?(): void
  /**
   * Fix how the selection is pronounced (voice reader D8). Passed only when the selection
   * is a word — the engine's own `cleanWord` decides — and the popover that opens is the
   * engine's, at the same rect, because only the engine holds both the text and the rect.
   */
  onPronounce?(): void
}

/** Roughly the chip's own box and the gap it keeps — used only to decide above-or-below. */
const CHIP_HEIGHT = 26
const CHIP_GAP = 8

export function SelectionChip({ rect, busy, onActivate, onReadFromHere, onPronounce }: Props) {
  // Above the selection when there is room, below it when there is not: the chip
  // must never be the thing that covers the words it is about.
  const above = rect.top - CHIP_GAP - CHIP_HEIGHT >= 0

  const position = {
    left: rect.left + rect.width / 2,
    top: above ? rect.top - CHIP_GAP - CHIP_HEIGHT : rect.top + rect.height + CHIP_GAP
  }
  const buttonClass =
    'app-no-drag rounded-md border border-gold-500/50 bg-ink-900 px-2.5 py-1 text-[11px] font-medium text-gold-300 shadow-cover-lift transition-colors hover:bg-ink-800 disabled:opacity-50'

  return (
    <div className="fixed z-10 flex -translate-x-1/2 gap-1" style={position}>
      <button
        type="button"
        // **`app-no-drag` because the chip floats, so its rect can land inside the
        // reader's draggable top band** — where a control without the marker takes
        // no mouse input at all: no hover, no click, while the keyboard and every
        // synthetic `element.click()` report it perfectly healthy
        // (`docs/invariants/reader.md:45`; held by
        // `src/components/reader/drag-regions.test.ts`).
        className={buttonClass}
        disabled={busy}
        // The gesture is the mouse's, so the button must not take the selection
        // with it: a `mousedown` that is allowed to land collapses the range
        // before the click ever arrives, and the chip would be pressing nothing.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onActivate}
        title="Highlight this text"
      >
        {busy ? 'Saving…' : 'Highlight'}
      </button>
      {onReadFromHere && (
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onReadFromHere}
          title="Read aloud from here"
        >
          Read from here
        </button>
      )}
      {onPronounce && (
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onPronounce}
          title="Fix how this word is pronounced"
        >
          Pronounce…
        </button>
      )}
    </div>
  )
}
