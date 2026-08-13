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
import type { ReaderPrefs, ReaderTocItem } from '@/stores/reader.store'

interface Props {
  bookId: string
  format: BookFormat
  initial: ReadingState | null
  prefs: ReaderPrefs
  onReady(toc: ReaderTocItem[]): void
  onRelocate(detail: { position: string | null; percent: number }): void
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
 */
const PALETTE = {
  ink: { bg: '#14110d', fg: '#e9e1d2', dim: '#b3a78f', link: '#d4a24e' },
  paper: { bg: '#f3ece0', fg: '#241f18', dim: '#6b6152', link: '#8a5a1a' }
} as const

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
  onError,
  onKeyDown,
  viewRef
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)

  // Callbacks are read through refs so a re-render never re-opens the book
  const cb = useRef({ onReady, onRelocate, onError, onKeyDown })
  const prefsRef = useRef(prefs)
  useEffect(() => {
    cb.current = { onReady, onRelocate, onError, onKeyDown }
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
      cb.current.onRelocate({ position: detail.cfi ?? null, percent: detail.fraction ?? 0 })
    })
    view.addEventListener('load', (event) => {
      const { doc } = (event as CustomEvent<FoliateLoadDetail>).detail
      doc.addEventListener('keydown', (e) => cb.current.onKeyDown(e))
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
