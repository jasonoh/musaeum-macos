import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type {
  FoliateDrawAnnotationDetail,
  FoliateLoadDetail,
  FoliateRelocateDetail,
  FoliateShowAnnotationDetail,
  FoliateTocItem,
  FoliateView
} from '@vendor/foliate-js/view.js'
import '@vendor/foliate-js/view.js'
import { Overlayer } from '@vendor/foliate-js/overlayer.js'
import type { ReadingState, ReaderFormat } from '@shared/book.types'
import type { Annotation } from '@shared/annotation.types'
import {
  annotationFromSelection,
  isAnnotationDrawKind,
  planAnnotations,
  removedValues,
  type AnnotationDrawKind,
  type AnnotationLocator,
  type AnnotationPlan,
  type SelectionCapture
} from '@/lib/annotations'
import { SPEECH_DRAW_KIND } from '@/lib/speech-controller'
import { readerPageCss, resolveReaderPalette } from '@/lib/theme/reader-palette'
import type { ReaderPrefs, ReaderSection, ReaderTocItem } from '@/stores/reader.store'
import { useThemeStore } from '@/stores/theme.store'
import { SelectionChip, type SelectionRect } from './SelectionChip'

interface Props {
  bookId: string
  /**
   * The format the URL carries, and the extension the `File` is named with.
   * `'reflow'` is not a `BookFormat` (D3): it is the route segment for the
   * book's derived EPUB, which `book-bytes.resolveReflowFile` serves.
   *
   * `book.reflow` is safe as a *name* because `makeBook` decides a zip by its
   * content — `isZip` reads the first four bytes, and the name is consulted
   * only to exclude `.cbz`/`.fb2` (`vendor/foliate-js/view.js:8-28`, `:101`).
   * The PDF branch is the opposite case (`isPDF` reads the magic and `./pdf.js`
   * is external), which is why `'pdf'` must never reach here.
   */
  format: ReaderFormat
  initial: ReadingState | null
  prefs: ReaderPrefs
  onReady(toc: ReaderTocItem[]): void
  onRelocate(detail: {
    position: string | null
    percent: number
    label: string | null
    /**
     * Where the rendered page starts inside the current section's own text, as
     * a character offset — the ask panel's passage window is built around it,
     * and null whenever the engine cannot say (see `sectionOffset`).
     */
    sectionOffset: number | null
    /**
     * The page on screen, as the engine's own live `Range` — the voice reader's
     * containment check (AC17) reads it to tell a hand turn from its own scroll.
     * Read it in the handler and never hold it, and never let it reach the
     * position report: it is a session fact, like `sectionOffset`.
     */
    range: Range | null
  }): void
  /**
   * The section that has just been rendered, with its own text. Fired from the
   * `load` listener the engine already keeps — the ask panel's passage rung and
   * its recall probe both read the page the reader is actually on, and the
   * paginator renders one section at a time, so the last `load` is the current
   * one.
   */
  onSection(detail: ReaderSection): void
  /** The text selected in that section, or null. A page turn clears it. */
  onSelection(selection: string | null): void
  /**
   * The book's highlights, as the service last answered. The engine offers them
   * to the engine's own annotation arm and never decides what is in the list —
   * `stale` and the artifact comparison are the service's (spec D6).
   */
  annotations: Annotation[]
  /**
   * The resolved color the highlight layer draws in — `annotation` on the
   * reader's derived palette (D9). A **literal**, never `var(--…)`: the overlayer
   * lives in foliate-view's closed shadow root.
   */
  annotationColor: string
  /**
   * The page's own fraction, as the relocator reported it — what a highlight made
   * on this page records as its position (reading R11). Passed rather than
   * derived from the CFI so the record cannot disagree with the bar on screen.
   */
  percent: number
  /** The section's own TOC label, the engine's own name for where this is (D5). */
  sectionLabel: string | null
  /**
   * A click inside a drawn highlight. The engine's own event carries the
   * overlayer's **key** — the annotation's `cfi` — because that is all the
   * overlayer ever saw (`vendor/foliate-js/view.js:408-412`).
   */
  onShowAnnotation(cfi: string): void
  /**
   * The chip's one gesture: the selection's locator, already normalized,
   * refused-by-null and capped (AC13). The parent calls the service with it.
   */
  onHighlight(locator: AnnotationLocator): Promise<unknown>
  /**
   * The chip's second gesture: start the voice reader at the selection. Handed
   * a clone of the selection's own range, in the section document the voice
   * reader's cursor is built over. Absent, the chip offers only Highlight.
   */
  onReadFromHere?(range: Range): void
  onError(message: string): void
  /**
   * The book's own iframe steals focus as soon as a page renders, so the
   * overlay's window listener stops seeing arrow keys. The same handler is
   * attached to every section document — which is what upstream's reader
   * does for the same reason.
   */
  onKeyDown(event: KeyboardEvent): void
  /** Set by the parent so chrome buttons and keys can drive the engine. */
  viewRef: MutableRefObject<FoliateView | null>
}

/** Flatten foliate's nested TOC — the panel renders one list, indented. */
function flattenToc(items: FoliateTocItem[] | undefined, depth = 0): ReaderTocItem[] {
  return (items ?? []).flatMap((item) => [
    { label: item.label?.trim() || 'Untitled', href: item.href, depth },
    ...flattenToc(item.subitems, depth + 1)
  ])
}

/**
 * Wraps foliate-js's <foliate-view> custom element. The engine owns its own
 * DOM, so React only mounts the host and hands it a Blob — book bytes arrive
 * over musaeum://, never file://.
 *
 * The page's colors are no longer a table in this file: they are derived from
 * the active theme's tokens in `src/lib/theme/reader-palette.ts`, which is also
 * where the injected stylesheet lives now. This component reads the theme store
 * beside the reader store — the same place it already reads prefs — and hands
 * the pure module two values.
 */
export function ReaderEngine({
  bookId,
  format,
  initial,
  prefs,
  onReady,
  onRelocate,
  onSection,
  onSelection,
  annotations,
  annotationColor,
  percent,
  sectionLabel,
  onShowAnnotation,
  onHighlight,
  onReadFromHere,
  onError,
  onKeyDown,
  viewRef
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)

  /**
   * The document of the section that was last rendered, and its spine index.
   *
   * Held because the two listeners that need it are separate ones: `load`
   * receives the document, and `relocate` — which fires on every page turn,
   * most of them with no `load` at all — receives the range. Measuring the
   * page's offset needs both. The `load` rule the panel already relies on
   * applies here too: the paginator renders one section at a time, so the last
   * `load` is the current one.
   */
  const loaded = useRef<{ index: number; doc: Document } | null>(null)

  /**
   * The active theme's tokens, or null before `src/main.tsx` has seeded the
   * store — in which case `:root`'s authored palette is what is on screen and
   * the resolver falls back to the ink row, which is the same row.
   *
   * The *palette* is deliberately not held here: it is resolved inside each
   * effect that needs one, because a freshly-built palette object in a
   * dependency array is a new identity on every render and would re-inject the
   * stylesheet for no reason.
   */
  const tokens = useThemeStore((s) => s.view?.active.tokens ?? null)

  // Callbacks are read through refs so a re-render never re-opens the book
  const cb = useRef({
    onReady,
    onRelocate,
    onSection,
    onSelection,
    onShowAnnotation,
    onHighlight,
    onReadFromHere,
    onError,
    onKeyDown
  })
  const prefsRef = useRef(prefs)
  // The tokens ride with the prefs for the same reason: the open path reads
  // both at the moment the bytes arrive, and a theme that changed *while* a book
  // was loading must color the page it is about to show, not re-open it.
  const tokensRef = useRef(tokens)
  /**
   * The page's own position and name, for the chip's locator (reading R11).
   *
   * Through a ref for the same reason the callbacks are: the selection is
   * captured inside a listener that outlives the render it was attached in, and
   * a closure over `percent` would stamp whatever the value was when the section
   * loaded rather than the page the selection is on.
   */
  const pageRef = useRef({ percent, sectionLabel })
  /**
   * The list and the color the plan is run against, read through a ref by three
   * callers — the section listener, the effect below, and nothing else — because
   * a closure would be the stale one for whichever of them did not declare it.
   */
  const live = useRef({ annotations, color: annotationColor })
  useEffect(() => {
    cb.current = {
      onReady,
      onRelocate,
      onSection,
      onSelection,
      onShowAnnotation,
      onHighlight,
      onReadFromHere,
      onError,
      onKeyDown
    }
    prefsRef.current = prefs
    tokensRef.current = tokens
    pageRef.current = { percent, sectionLabel }
    live.current = { annotations, color: annotationColor }
  })

  /**
   * What the engine was last handed. `rows` is the half read back — it is what
   * says which values are *on the page*, and therefore which ones a delete has to
   * take off it (reading R13). `undrawable` is the plan's own report, carried
   * rather than discarded so that "this one is not on the page" is a value in
   * hand rather than a console line (reading R12; its reversal is the panel row
   * that would show it).
   */
  const plan = useRef<AnnotationPlan>({ rows: [], undrawable: [] })

  /** The selection chip: the live selection's rect and its locator (D8.1). */
  const [chip, setChip] = useState<{
    rect: SelectionRect
    capture: SelectionCapture
    /** A clone, so a later change to the live selection cannot move it. */
    range: Range
  } | null>(null)
  const [saving, setSaving] = useState(false)

  /**
   * Run the plan against the view (AC14, AC15, R12/R13).
   *
   * A no-op until `open()` has resolved: with no renderer every offer throws and
   * the layer would call the whole book undrawable. The first real plan comes
   * from `create-overlay`, which arrives with the first section.
   */
  const replan = useCallback(async () => {
    const view = viewRef.current
    if (!view?.renderer) return
    const previous = plan.current.rows
    let next: AnnotationPlan
    try {
      next = await planAnnotations(live.current.annotations, live.current.color, view)
    } catch {
      // The plan catches per annotation; a throw reaching here is the engine
      // itself, and a layer that cannot draw must not take the book with it
      // (invariant 12) — so this is a no-op rather than a second error surface
      // stacked on the reader's own.
      return
    }
    for (const value of removedValues(previous, next.rows)) {
      try {
        await view.deleteAnnotation({ value })
      } catch {
        /* the section that held it is gone — there is nothing left to remove */
      }
    }
    plan.current = next
  }, [viewRef])

  // Re-open only when the book changes; pref changes restyle in place
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false

    const view = document.createElement('foliate-view') as FoliateView
    // A custom element is inline by default; the paginator measures its own
    // box, so it has to be told to fill the host
    view.style.display = 'block'
    view.style.width = '100%'
    view.style.height = '100%'
    host.append(view)
    viewRef.current = view

    /**
     * The highlight layer's two arms and its click.
     *
     * `draw-annotation` fires **only** for a value the engine does not recognise
     * as a search hit (`view.js:392-393`), so search's own outlines are untouched
     * by anything here — which is what AC16 means by the search path's draw
     * staying its own. The `annotation` in the detail is the object that was
     * handed to `addAnnotation`, so the kind and the color ride on it (reading
     * R14), and the draw function is selected from a table by that kind rather
     * than hardcoded: a name nothing reads is a comment, and the criterion says
     * the plan *names* the draw.
     *
     * The voice reader's sentence comes through this same arm under its own
     * kind (`SPEECH_DRAW_KIND`, `src/lib/speech-controller.ts`) — one overlayer,
     * never a second. It is offered by the speech controller alone and is never
     * in `annotations`, so the plan neither re-adds nor removes it and nothing
     * about it is ever saved.
     */
    view.addEventListener('draw-annotation', (event) => {
      const { draw, annotation } = (event as CustomEvent<FoliateDrawAnnotationDetail>).detail
      const kind = annotation.kind
      const drawKind: EngineDrawKind | null =
        kind === SPEECH_DRAW_KIND ? SPEECH_DRAW_KIND : isAnnotationDrawKind(kind) ? kind : null
      if (!drawKind) return
      draw(DRAWS[drawKind], {
        color: typeof annotation.color === 'string' ? annotation.color : ''
      })
    })

    /**
     * A click inside a drawn highlight — D8.2's second opener. The engine's own
     * handler emits the **key** of the overlayer it hit (`view.js:408-412`),
     * which is the `cfi` this layer offered: the overlayer never knew the id.
     */
    view.addEventListener('show-annotation', (event) => {
      if (disposed) return
      const { value } = (event as CustomEvent<FoliateShowAnnotationDetail>).detail
      cb.current.onShowAnnotation(value)
    })

    /**
     * **The plan is re-offered from `relocate`, not from `create-overlay`, and the
     * reason is a vendor ordering fact rather than a preference.**
     *
     * `create-overlay` is emitted from `#createOverlayer` *before* the paginator
     * attaches the new overlayer — the emit is at `view.js:418` and the `attach`
     * callback that sets `view.overlayer` runs only when that method *returns*
     * (`paginator.js:989-995`), one line before `this.#view = view`. So a re-add
     * inside that handler finds `getContents()` still describing the **previous**
     * section (`paginator.js:1092-1098` returns `this.#view`'s overlayer and
     * document under the *new* `#index`), and draws the new section's rectangles
     * into the old section's overlay — or, on the very first section, draws
     * nothing at all, because `#view` is still undefined. The vendor's own
     * reference highlight layer uses that seam (`reader.js:172-177`), and it is
     * reading a tree this repo never runs.
     *
     * `relocate` is emitted from `#afterScroll` (`paginator.js:966-969`), which
     * runs after `this.#view = view` and after `scrollToAnchor` — the first moment
     * at which the plan can draw on the section that is actually on screen, and
     * it fires for every section display including a re-display of the same index
     * (which is what a jump to a highlight inside the current section is).
     */
    view.addEventListener('relocate', (event) => {
      // Guarded like onReady/onError: a relocate arriving from a torn-down
      // view would stamp the previous book's CFI onto the current bookId
      if (disposed) return
      const detail = (event as CustomEvent<FoliateRelocateDetail>).detail
      cb.current.onRelocate({
        position: detail.cfi ?? null,
        percent: detail.fraction ?? 0,
        // The book's own name for the section — never a chapter number, which
        // drifts across editions (D5)
        label: detail.tocItem?.label?.trim() || null,
        sectionOffset: sectionOffset(loaded.current?.doc ?? null, detail.range),
        range: detail.range ?? null
      })
      void replan()
    })
    view.addEventListener('load', (event) => {
      const { doc, index } = (event as CustomEvent<FoliateLoadDetail>).detail
      doc.addEventListener('keydown', (e) => cb.current.onKeyDown(e))
      // The selection has to be read where it is made: the overlay's own
      // listeners never see a selection inside the book's iframe. Captured
      // wide — a drag can end outside the section, and a shift-arrow makes one
      // with no mouse at all — because the store drops the repeats.
      //
      // One read, two destinations. The **text** goes to the store, because it
      // is the one thing the ask panel sends verbatim. The **locator** — the
      // CFI, the rect, the text either side of the range (AC13) — stays in this
      // component: the chip that acts on it is this component's own control, and
      // a `cfi` has no business in a store the ask panel reads.
      const capture = () => {
        const quote = selectionText(doc)
        cb.current.onSelection(quote)
        const range = selectionRange(doc)
        if (!quote || !range) {
          setChip(null)
          return
        }
        const rect = selectionRect(doc, range)
        if (!rect) {
          setChip(null)
          return
        }
        let cfi: string
        try {
          cfi = view.getCFI(index, range)
        } catch {
          // A range the CFI builder cannot describe is a locator this build
          // cannot store — no chip, and nothing thrown out of a document event.
          setChip(null)
          return
        }
        setChip({
          rect,
          range: range.cloneRange(),
          capture: {
            quote,
            cfi,
            percent: pageRef.current.percent,
            sectionLabel: pageRef.current.sectionLabel,
            ...contextAround(doc, range)
          }
        })
      }
      doc.addEventListener('selectionchange', capture)
      doc.addEventListener('mouseup', capture)
      doc.addEventListener('keyup', capture)

      if (disposed) return
      loaded.current = { index, doc }
      cb.current.onSection({ index, text: sectionText(doc) })
      // A new section starts with nothing selected in it — no text, no chip
      cb.current.onSelection(null)
      setChip(null)
    })

    void (async () => {
      try {
        const response = await fetch(`musaeum://book/${bookId}/${format}`)
        if (!response.ok) throw new Error('This book’s file could not be read.')
        const blob = await response.blob()
        if (disposed) return

        // A Blob is not enough: `makeBook` sniffs `file.name` for the CBZ and
        // FB2 special cases before anything else, and a Blob has none — the
        // engine throws "Cannot read properties of undefined" on every book.
        await view.open(new File([blob], `book.${format}`))
        if (disposed) return

        const renderer = view.renderer
        renderer?.setAttribute('margin', `${prefsRef.current.margin}px`)
        // Read through the refs, not this render's props: the effect keys on the
        // book, so a pref or theme change must not run it again.
        renderer?.setStyles?.(
          readerPageCss(
            prefsRef.current,
            resolveReaderPalette(prefsRef.current.theme, tokensRef.current)
          )
        )

        // A stored position may no longer resolve — a re-downloaded file, a
        // different engine version. `goTo` reports that by returning
        // undefined rather than rejecting, so percent is the fallback.
        const restored = initial?.position ? await view.goTo(initial.position) : undefined
        if (disposed) return
        if (!restored) {
          const fraction = initial?.percent ?? 0
          if (fraction > 0) await goToFraction(view, fraction)
          // Nothing renders until something navigates: `open()` only loads
          // the spine. This is upstream's cold-start path.
          else await renderer?.next()
        }
        if (disposed) return

        cb.current.onReady(flattenToc(view.book?.toc))
      } catch (err) {
        if (!disposed) cb.current.onError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      disposed = true
      viewRef.current = null
      // A torn-down view must not leave a document behind for the next book's
      // relocate to measure against.
      loaded.current = null
      // `close()` throws when `open()` resolved but nothing was ever
      // displayed — tearing down a book that failed mid-load is normal here
      try {
        view.close()
      } catch {
        /* nothing to tear down */
      }
      view.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, format])

  /**
   * Restyle in place — on a typography change, and on a **theme** change while
   * the book is open (AC5.1): the tokens are a dependency, and the palette is
   * resolved in here rather than passed in, so a switch repaints the page
   * without re-opening the book.
   */
  useEffect(() => {
    const renderer = viewRef.current?.renderer
    renderer?.setAttribute('margin', `${prefs.margin}px`)
    renderer?.setStyles?.(readerPageCss(prefs, resolveReaderPalette(prefs.theme, tokens)))
  }, [prefs, tokens, viewRef])

  /**
   * The layer follows the list and the resolved color, and it is **re-run** rather
   * than amended (reading R13).
   *
   * The color half is the obligation `ReaderSearch` already discharges, for the
   * same measured reason: the engine keeps the options it was handed, so a
   * highlight drawn under one theme would keep that theme's color after a switch
   * — measured once already at 1,780 px of the wrong color on a page that had
   * gone dark (`docs/invariants/reader.md:69`). Keyed on the resolved color
   * rather than on the tokens, so a theme change that leaves the `annotation`
   * role alone redraws nothing.
   *
   * Cheap and safe: re-offering a value is idempotent — the engine removes what
   * it is about to re-add (`view.js:389`) — and the one thing a re-run cannot do,
   * un-draw a deleted highlight, is `removedValues`' job inside `replan`.
   */
  useEffect(() => {
    void replan()
  }, [replan, annotations, annotationColor])

  /**
   * The chip's one gesture (D8.1): the selection becomes a record.
   *
   * The refusal is a guard rather than a path — the chip is only shown once the
   * capture produced a locator — and the chip goes on the way out either way: the
   * drawn highlight is the feedback, and a failure has already been put on the
   * toast surface by the store (reading R16).
   */
  const onChipActivate = useCallback(() => {
    if (!chip || saving) return
    const locator = annotationFromSelection(chip.capture)
    if (!locator) {
      setChip(null)
      return
    }
    setSaving(true)
    void cb.current
      .onHighlight(locator)
      .catch(() => {})
      .finally(() => {
        setSaving(false)
        setChip(null)
      })
  }, [chip, saving])

  /**
   * The chip's voice gesture: hand the selection's range to the voice reader and
   * put the chip away — the spoken sentence's highlight is the feedback.
   */
  const onChipReadFromHere = useCallback(() => {
    if (!chip) return
    cb.current.onReadFromHere?.(chip.range)
    setChip(null)
  }, [chip])

  return (
    <div ref={hostRef} className="h-full w-full">
      {chip && (
        <SelectionChip
          rect={chip.rect}
          busy={saving}
          onActivate={onChipActivate}
          onReadFromHere={onReadFromHere ? onChipReadFromHere : undefined}
        />
      )}
    </div>
  )
}

/** Every kind the `draw-annotation` arm draws: the plan's, and the voice reader's sentence. */
type EngineDrawKind = AnnotationDrawKind | typeof SPEECH_DRAW_KIND

/**
 * The draw function each kind names (reading R14).
 *
 * A table rather than a hardcoded call, because AC16 says the plan *names* the
 * draw and a name nothing reads is a comment: the row's `kind` is what selects
 * this, and one entry per kind is a typecheck — a second kind cannot be added
 * without saying what draws it.
 *
 * `speech` is a fill like a highlight, in the palette's `speech` literal that
 * rides on the annotation. It is deliberately not in `ANNOTATION_DRAW_KINDS`:
 * that list is the persisted plan's, and a spoken sentence is never a record.
 */
const DRAWS: Record<EngineDrawKind, (rects: unknown, options?: { color?: string }) => unknown> = {
  highlight: Overlayer.highlight,
  speech: Overlayer.highlight
}

/** `goToFraction` throws for books with no section-size index. */
async function goToFraction(view: FoliateView, fraction: number): Promise<void> {
  try {
    await view.goToFraction(fraction)
  } catch {
    await view.renderer?.next()
  }
}

/**
 * The section's own text — what the ask panel sends at the passage rung, and
 * what its recall verdict is scored against.
 *
 * `textContent` rather than `innerText`, deliberately: `load` fires while the
 * paginator is measuring the new section with its iframe unrendered, and
 * `innerText` needs layout. It is also the vendor's own text model — foliate's
 * search reads the same text nodes and joins them the same way
 * (`vendor/foliate-js/text-walker.js` is imported for exactly that). The known
 * limit: XHTML minified onto one line puts no whitespace between two block
 * elements, so those two words read as one. That costs a little in the passage
 * and a token at the score; it does not change a verdict.
 */
function sectionText(doc: Document): string {
  return doc.body?.textContent?.trim() ?? ''
}

/**
 * Where the rendered page starts, as a character offset into `sectionText(doc)`
 * — the anchor the ask panel windowed its passage around (measured
 * 2026-09-21: without it, a question about the second half of a long section
 * traveled with a passage that stopped thousands of characters before it).
 *
 * The whole computation is a range's own text: `Range.toString()` concatenates
 * the text nodes a range covers, which is the same model `sectionText()` uses,
 * so the two are directly comparable. Building the prefix by measurement rather
 * than by walking nodes also handles both shapes a page's start takes — a text
 * node, where `startOffset` is a character index, and an element, where the
 * same number is a child index — without special-casing either.
 *
 * It returns null rather than guessing: no range, no loaded document, or a
 * range that does not belong to the document we were handed. The last case is
 * the real one — a relocate still queued from the previous section arrives
 * with its own document's range — and it is why no caller has to sequence this
 * against `load`. Null is a safe answer: the window then falls back to the
 * highlight, and then to the section's head.
 */
function sectionOffset(doc: Document | null, range: Range | null | undefined): number | null {
  const body = doc?.body
  if (!body || !range) return null
  const start = range.startContainer
  if (start !== body && !body.contains(start)) return null
  try {
    const before = doc.createRange()
    before.selectNodeContents(body)
    before.setEnd(start, range.startOffset)
    return before.toString().length
  } catch {
    // A `setEnd` the range itself considers out of bounds: the page's start is
    // unknown, not zero.
    return null
  }
}

/** The selected text in a section, trimmed — null for a bare caret. */
function selectionText(doc: Document): string | null {
  const selection = doc.getSelection()
  const text = selection && !selection.isCollapsed ? selection.toString().trim() : ''
  return text || null
}

/**
 * The live, non-collapsed selection's range in a section, or null.
 *
 * Separate from `selectionText` because the two are asked different questions —
 * one wants the words, the other wants the place — and because `getRangeAt(0)`
 * is the only part that can throw (an index past the list, on a selection that
 * changed between the two calls).
 */
function selectionRange(doc: Document): Range | null {
  const selection = doc.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  try {
    return selection.getRangeAt(0)
  } catch {
    return null
  }
}

/**
 * The text either side of a selection (AC13, reading R10).
 *
 * `Range.toString()` over the body up to the range's start, and from its end —
 * the same text model `sectionText` and `sectionOffset` use, so a stored
 * `prefix` was measured the way the page it came from is. **This reads; the cap
 * and the whitespace normalization are `src/lib/annotations.ts`'s**, because
 * they are the file's own shape and one module decides them.
 *
 * A range that does not belong to this document gives no context rather than an
 * exception: the quote is the anchor, and a highlight without its context is
 * still a record (`ReaderEngine`'s `sectionOffset` makes the same call).
 */
function contextAround(doc: Document, range: Range): { prefix: string; suffix: string } {
  const body = doc.body
  if (!body) return { prefix: '', suffix: '' }
  try {
    const before = doc.createRange()
    before.selectNodeContents(body)
    before.setEnd(range.startContainer, range.startOffset)
    const after = doc.createRange()
    after.selectNodeContents(body)
    after.setStart(range.endContainer, range.endOffset)
    return { prefix: before.toString(), suffix: after.toString() }
  } catch {
    return { prefix: '', suffix: '' }
  }
}

/**
 * The selection's rect, in **viewport** coordinates (reading R15).
 *
 * The book renders in its own iframe inside the paginator's closed shadow root,
 * so a range's own `getBoundingClientRect()` is in *that* frame's coordinates.
 * `frameElement` is the iframe itself — same-origin by construction, since the
 * paginator sandboxes with `allow-same-origin` (`paginator.js:244`) — and its
 * rect is already in the top document's viewport, so the sum is the selection's
 * place on the reader's screen without reaching into the shadow root.
 *
 * Null when either half is unavailable. A chip at a guessed position is worse
 * than no chip: the rectangle is what makes the affordance *the gesture's*, and
 * the manual pass is what decides whether the guess was ever needed.
 */
function selectionRect(doc: Document, range: Range): SelectionRect | null {
  const rect = range.getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) return null
  const frame = doc.defaultView?.frameElement
  const frameRect = frame?.getBoundingClientRect()
  if (!frameRect) return null
  return {
    left: rect.left + frameRect.left,
    top: rect.top + frameRect.top,
    width: rect.width,
    height: rect.height
  }
}
