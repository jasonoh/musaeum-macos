import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type {
  FoliateLoadDetail,
  FoliateRelocateDetail,
  FoliateTocItem,
  FoliateView
} from '@vendor/foliate-js/view.js'
import '@vendor/foliate-js/view.js'
import type { BookFormat, ReadingState } from '@shared/book.types'
import type { ReaderPrefs, ReaderSection, ReaderTocItem } from '@/stores/reader.store'

interface Props {
  bookId: string
  format: BookFormat
  initial: ReadingState | null
  prefs: ReaderPrefs
  onReady(toc: ReaderTocItem[]): void
  onRelocate(detail: { position: string | null; percent: number; label: string | null }): void
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
 * Copies of the Tailwind design tokens, by value. The book renders in its own
 * iframe document, which the app's stylesheet does not reach, so these cannot
 * be class names — but they must stay in step with `tailwind.config.js`:
 * `ink` is `ink-900`, `fg` is `parchment`, `dim` is `parchment-dim`, `link` is
 * `gold-400`. A palette change has to update this table too. The `paper` row
 * has no token counterpart — the app has no light theme to borrow from.
 *
 * `search` is a role of its own rather than a second use of `link` so that
 * theming slice 5, which makes this table *derived*, has a name to derive: a
 * colour that is not named here is one slice 5 cannot carry, and a themed app
 * would outline search hits in a hardcoded amber.
 */
const PALETTE = {
  ink: { bg: '#14110d', fg: '#e9e1d2', dim: '#b3a78f', link: '#d4a24e', search: '#d4a24e' },
  paper: { bg: '#f3ece0', fg: '#241f18', dim: '#6b6152', link: '#8a5a1a', search: '#8a5a1a' }
} as const

/**
 * The colour search hits are outlined in — a resolved literal from the table
 * above, never `var(--…)` (D4).
 *
 * The overlayer that draws it lives in foliate-view's **closed shadow root**
 * inside the app's own document, so a custom property passed across that
 * boundary is a bet this repo does not take: it would probably inherit, and
 * "probably" is not something a unit test can decide. Passing the literal also
 * keeps the colour inside the reader's palette, which is where slice 5 has to
 * be able to find it.
 */
export function searchHighlightColor(theme: ReaderPrefs['theme']): string {
  return PALETTE[theme].search
}

const SERIF = '"Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif'
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif'

/**
 * Styles injected *into* the book's document. Deliberately unprefixed by
 * `!important`: a book that ships its own typography keeps it, and these
 * only fill in what it left unsaid.
 */
function pageCss(prefs: ReaderPrefs): string {
  const c = PALETTE[prefs.theme]
  const family = prefs.typeface === 'serif' ? SERIF : SANS
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color-scheme: ${prefs.theme === 'paper' ? 'light' : 'dark'};
      font-size: ${prefs.fontSize}px;
      background: ${c.bg};
      color: ${c.fg};
      font-family: ${family};
    }
    body {
      background: ${c.bg};
      color: ${c.fg};
      font-family: ${family};
    }
    p, li, blockquote, dd, td {
      line-height: ${prefs.lineHeight};
      -webkit-hyphens: auto;
      hyphens: auto;
      -webkit-hyphenate-limit-before: 3;
      -webkit-hyphenate-limit-after: 2;
      -webkit-hyphenate-limit-lines: 2;
      hanging-punctuation: allow-end last;
      widows: 2;
      orphans: 2;
    }
    /* Keep the above from overriding an explicit alignment */
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }
    h1, h2, h3, h4, h5, h6 {
      font-family: ${SERIF};
      line-height: 1.2;
      font-weight: 600;
      -webkit-hyphens: manual;
      hyphens: manual;
    }
    a, a:link, a:visited { color: ${c.link}; }
    hr { border: 0; border-top: 1px solid ${c.dim}; opacity: 0.4; }
    pre { white-space: pre-wrap !important; }
    ::selection { background: ${c.link}44; }
  `
}

/**
 * Wraps foliate-js's <foliate-view> custom element. The engine owns its own
 * DOM, so React only mounts the host and hands it a Blob — book bytes arrive
 * over musaeum://, never file://.
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
  onError,
  onKeyDown,
  viewRef
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)

  // Callbacks are read through refs so a re-render never re-opens the book
  const cb = useRef({ onReady, onRelocate, onSection, onSelection, onError, onKeyDown })
  const prefsRef = useRef(prefs)
  useEffect(() => {
    cb.current = { onReady, onRelocate, onSection, onSelection, onError, onKeyDown }
    prefsRef.current = prefs
  })

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
        label: detail.tocItem?.label?.trim() || null
      })
    })
    view.addEventListener('load', (event) => {
      const { doc, index } = (event as CustomEvent<FoliateLoadDetail>).detail
      doc.addEventListener('keydown', (e) => cb.current.onKeyDown(e))
      // The selection has to be read where it is made: the overlay's own
      // listeners never see a selection inside the book's iframe. Captured
      // wide — a drag can end outside the section, and a shift-arrow makes one
      // with no mouse at all — because the store drops the repeats.
      const capture = () => cb.current.onSelection(selectionText(doc))
      doc.addEventListener('selectionchange', capture)
      doc.addEventListener('mouseup', capture)
      doc.addEventListener('keyup', capture)

      if (disposed) return
      cb.current.onSection({ index, text: sectionText(doc) })
      // A new section starts with nothing selected in it
      cb.current.onSelection(null)
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
        renderer?.setStyles?.(pageCss(prefsRef.current))

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

  useEffect(() => {
    const renderer = viewRef.current?.renderer
    renderer?.setAttribute('margin', `${prefs.margin}px`)
    renderer?.setStyles?.(pageCss(prefs))
  }, [prefs, viewRef])

  return <div ref={hostRef} className="h-full w-full" />
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

/** The selected text in a section, trimmed — null for a bare caret. */
function selectionText(doc: Document): string | null {
  const selection = doc.getSelection()
  const text = selection && !selection.isCollapsed ? selection.toString().trim() : ''
  return text || null
}
