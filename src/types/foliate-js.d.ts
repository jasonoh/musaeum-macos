/**
 * Ambient declarations for the vendored foliate-js engine
 * (`vendor/foliate-js`, see its VENDORED.md). The upstream source is plain
 * ES modules with no types; declaring the slice we use keeps `any` out of
 * the reader without typechecking someone else's code.
 *
 * Every signature here was read off `vendor/foliate-js/view.js` at the
 * vendored commit rather than off upstream's README — several of them are
 * looser than the docs suggest, and the reader depends on the difference.
 */
declare module '@vendor/foliate-js/view.js' {
  export interface FoliateTocItem {
    label: string
    href: string
    subitems?: FoliateTocItem[]
  }

  /**
   * `View.#onRelocate` emits `{ ...progress, tocItem, pageItem, cfi, range }`,
   * and `progress` is `{}` for books with no section-size index — so every
   * field here is genuinely optional.
   *
   * `range` is the rendered page's own live `Range` inside the section's
   * document (the paginator's `#afterScroll` builds it from `#getVisibleRange`
   * and passes it through unchanged). Declared 2026-09-21 for the ask panel's
   * passage window, which needs to know where in the section the page starts.
   * It is a mutable DOM object rather than a value — read it at the top of the
   * handler, never hold on to it.
   */
  export interface FoliateRelocateDetail {
    fraction?: number
    cfi?: string
    tocItem?: { label: string } | null
    range?: Range | null
  }

  /** Emitted once per section as it is rendered into the engine's iframe. */
  export interface FoliateLoadDetail {
    doc: Document
    index: number
  }

  export interface FoliateBook {
    toc?: FoliateTocItem[]
    dir?: string
  }

  /**
   * The renderer element `open()` picks: `foliate-paginator` normally,
   * `foliate-fxl` for pre-paginated books. Only the paginator has
   * `setStyles`, which is why upstream calls it optionally too.
   */
  export interface FoliateRenderer extends HTMLElement {
    setStyles?(css: string): void
    next(): Promise<void>
    prev(): Promise<void>
    /**
     * The section on screen: one entry (`paginator.js:1092-1098`), or none before
     * anything has been displayed. `index` is the spine index `getCFI` wants.
     * **During a section change `load` fires before this moves**: the paginator
     * emits `load` from inside `view.load()` and assigns `#view` only after it
     * (`paginator.js:971-998`), so a reader of this inside a `load` listener
     * still sees the previous section.
     */
    getContents(): FoliateContents[]
    /**
     * Scroll so `anchor` is on screen. `select` true makes the paginator *select*
     * the range afterwards (`relocate` reason `'selection'`, `paginator.js:577-578`);
     * false collapses the selection to the anchor's start (`'navigation'`).
     * Paginator only — `foliate-fxl` has none, hence optional.
     */
    scrollToAnchor?(anchor: Range | Element | number, select?: boolean): Promise<void>
    /**
     * Go to the adjacent linear section. **Resolves to `undefined` either way**:
     * at the last section `goTo` finds no index and returns without moving
     * (`paginator.js:1022-1026`, `:1081-1083`), and it also returns without
     * moving while a page turn holds the paginator's lock. A caller learns
     * whether it moved from `getContents()`, not from the result. Paginator only.
     */
    nextSection?(): Promise<void>
    prevSection?(): Promise<void>
  }

  /** One rendered section, as `renderer.getContents()` reports it. */
  export interface FoliateContents {
    index: number
    doc: Document
    overlayer?: unknown
  }

  /**
   * `vendor/foliate-js/tts.js`'s `TTS`: a cursor over the section's blocks, each
   * handed out as SSML with a `<mark name>` before every segment.
   *
   * **The range map is rebuilt on every cursor move.** `#ranges` is reassigned
   * whenever `start`/`resume`/`prev`/`next`/`from` lands on a block
   * (`tts.js:213-216`), and `setMark` looks its name up in that map
   * (`tts.js:271-277`) — the names restart at `"0"` in every block. So a
   * `setMark` for a sentence of block N after the cursor has moved to N+1 either
   * highlights nothing or highlights block N+1's sentence of the same number.
   * The voice reader's controller (`src/lib/speech-controller.ts`) is the one
   * place that owns that ordering.
   */
  export interface FoliateTTS {
    /** The section document this cursor was built over. */
    readonly doc: Document
    /**
     * Called by `setMark` (and by `prev`/`next` when paused) with a clone of
     * the segment's range. A plain field (`tts.js:212`), so it can be replaced.
     */
    highlight: (range: Range) => void
    /** The first block's SSML, or — if the first block is empty — `next()`'s. */
    start(): string | undefined
    resume(): string | undefined
    prev(paused?: boolean): string | undefined
    /** The next block's SSML; `undefined` past the section's last block. */
    next(paused?: boolean): string | undefined
    /**
     * The block holding `range`'s start, cut to begin at the first segment that
     * starts at or after it (`tts.js:259-270`); `undefined` when no block ends
     * after it.
     */
    from(range: Range): string | undefined
    /** Highlight the named segment of the **current** block; silent if the name is not in it. */
    setMark(mark: string): void
  }

  /** Opaque resolved navigation target; only its truthiness is meaningful. */
  export type FoliateTarget = object

  /** A hit's context, already trimmed to ~50 characters either side. */
  export interface FoliateSearchExcerpt {
    pre: string
    match: string
    post: string
  }

  export interface FoliateSearchHit {
    cfi: string
    excerpt: FoliateSearchExcerpt
  }

  /** A section that matched. `label` is the TOC label, and **may be empty**. */
  export interface FoliateSearchGroup {
    label: string
    subitems: FoliateSearchHit[]
  }

  export interface FoliateSearchOptions {
    query: string
    /** Omit to search the whole book — the only mode the reader uses (D3). */
    index?: number
    matchCase?: boolean
    matchDiacritics?: boolean
    matchWholeWords?: boolean
    defaultLocale?: string
    /** Defaults to `Overlayer.outline`; the reader passes a color (D4). */
    drawOptions?: { color?: string; width?: number; radius?: number }
  }

  /**
   * An annotation as the engine takes it.
   *
   * `value` is the key: `addAnnotation` removes any annotation under it
   * (`view.js:389`), resolves it as a CFI, and draws from the `value`. A value
   * prefixed `foliate-search:` takes the engine's *other* arm and never reaches
   * the `draw-annotation` event; the reader's own annotations never carry it.
   */
  export interface FoliateAnnotation {
    value: string
  }

  /**
   * …and what `draw-annotation` hands back is **the same object**, every member
   * still on it (`view.js:393`).
   *
   * This is the door the consumer reads its own fields back through — the vendor's
   * highlight layer carries a bookmark's colour exactly this way (`reader.js:165`,
   * `:178-182`) — which is why it is a distinct type from what is *offered*: a
   * caller may put anything on the object, and only it knows what it put there.
   */
  export type FoliateOfferedAnnotation = FoliateAnnotation & Record<string, unknown>

  /** One of `Overlayer`'s static draw functions, as the consumer receives it. */
  export type FoliateDrawFn = (rects: unknown, options?: { color?: string }) => unknown

  /** The closure the engine hands the consumer: `draw(fn, { color })`. */
  export type FoliateDraw = (fn: FoliateDrawFn, options?: { color?: string }) => void

  /**
   * `draw-annotation`'s detail — emitted only for a **non-search** value
   * (`view.js:392-393`), which is the arm this feature uses. `annotation` is the
   * object that was passed to `addAnnotation`, not a copy of it.
   */
  export interface FoliateDrawAnnotationDetail {
    draw: FoliateDraw
    annotation: FoliateOfferedAnnotation
    doc?: Document
    range: Range
  }

  /**
   * `create-overlay`'s detail: a section's overlayer has just been made
   * (`view.js:418`).
   *
   * **Declared and deliberately not used.** The event fires *before* the paginator
   * attaches the new overlayer (`paginator.js:989-995`), so a re-add inside it
   * resolves against the previous section's overlayer and document — see the note
   * on `ReaderEngine`'s `relocate` listener, which is the seam this feature draws
   * from. It stays declared because it is part of the vendor's surface and because
   * the next reader reaching for it should find the reason here rather than
   * rediscover it.
   */
  export interface FoliateCreateOverlayDetail {
    index: number
  }

  /**
   * `show-annotation`'s detail, as the engine's own click handler emits it
   * (`view.js:408-412`). `value` is the overlayer's key — the annotation's own
   * `value`, not its id, because the overlayer never saw the id.
   */
  export interface FoliateShowAnnotationDetail {
    value: string
    index: number
    range: Range
  }

  /**
   * Three shapes, interleaved: one `{ progress }` per section, one
   * `{ label, subitems }` per section that has hits, and the bare string
   * `'done'` last.
   */
  export type FoliateSearchYield = { progress: number } | FoliateSearchGroup | 'done'

  export class FoliateView extends HTMLElement {
    book: FoliateBook
    /** Created by `open()` — undefined until it resolves. */
    renderer?: FoliateRenderer
    open(file: Blob | File): Promise<void>
    /**
     * Swallows its own failures: returns the resolved target on success and
     * `undefined` when the target could not be resolved. It does **not**
     * reject, so a stale position has to be detected from the return value.
     */
    goTo(target: string | number): Promise<FoliateTarget | undefined>
    /** Throws if the book has no section-size index. */
    goToFraction(fraction: number): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    /**
     * Whole-book (or one-section) search, as an async generator.
     *
     * It calls `clearSearch()` on entry, so **exactly one search is live at a
     * time** and a second run erases the first's highlights — which is why a
     * superseded consumer has to stop writing. Hits are stored as annotations
     * under the `foliate-search:` prefix and re-added on every section render,
     * so they stay outlined while you read on.
     *
     * Breaking the iteration stops it; there is no `AbortController`.
     */
    search(opts: FoliateSearchOptions): AsyncGenerator<FoliateSearchYield, void, void>
    /** Delete the search annotations — every outline the engine drew. */
    clearSearch(): void
    /**
     * Draw one annotation, keyed by its `value`.
     *
     * It removes any annotation already under that key, resolves the value to a
     * spine index, and — for a value that is **not** `foliate-search:`-prefixed —
     * emits `draw-annotation` with a closure the consumer calls. Resolves to the
     * section it landed in, which is what the engine's own TOC progress uses.
     *
     * **It throws when the value does not resolve.** `resolveNavigation` catches
     * its own failure and returns `undefined` (`view.js:446-459`) and this method
     * destructures that return on the next line (`view.js:385`) — so an
     * unresolvable locator is an exception, not a miss, and every caller here
     * treats it as one.
     */
    addAnnotation(annotation: FoliateAnnotation): Promise<{ index: number; label: string }>
    /** The same call with the flag that removes instead of drawing (`view.js:399-401`). */
    deleteAnnotation(annotation: FoliateAnnotation): Promise<{ index: number; label: string }>
    /**
     * The CFI for a range inside a section: `CFI.joinIndir(sectionCfi,
     * CFI.fromRange(range))` (`view.js:431-435`). A null range yields the
     * section's own base CFI.
     */
    getCFI(index: number, range: Range | null): string
    /**
     * The last `relocate` detail (`view.js:329-338`), or null before the first
     * and after `close()`. Its `range` is the page on screen.
     */
    lastLocation?: FoliateRelocateDetail | null
    /**
     * The section's TTS cursor, made by `initTTS` and nulled by `close()`.
     * Undefined until the first `initTTS`.
     */
    tts?: FoliateTTS | null
    /**
     * Build `tts` over the section on screen (`view.js:584-590`). **A no-op when
     * `tts` already sits on that document** — the `highlight` passed then is
     * ignored, so a caller that needs its own has to assign `tts.highlight`. It
     * does not follow a section change: call it again after one. Without a
     * `highlight`, the default is `renderer.scrollToAnchor(range, true)`.
     */
    initTTS(granularity?: 'word' | 'sentence', highlight?: (range: Range) => void): Promise<void>
    /** Throws if `open()` resolved but nothing was ever displayed. */
    close(): void
  }
}

/**
 * `vendor/foliate-js/overlayer.js` — the two draw functions.
 *
 * Declared here rather than imported from upstream for the same reason the view
 * is: the vendored tree is never edited (invariant 11), and this file is where
 * every divergence lives. `highlight` is a filled rect set with the vendored
 * opacity/blend custom properties (`overlayer.js:126-141`); `outline` is the
 * stroked one search draws with (`:142-158`).
 */
declare module '@vendor/foliate-js/overlayer.js' {
  /**
   * The two draw functions (a filled highlight, a stroked outline).
   *
   * The rects they are called with are the paginator's own — an array of
   * `{ left, top, height, width }` in the section document's coordinates. They
   * are declared `unknown` here **deliberately**: nothing in `src/` ever reads or
   * builds one (the engine supplies them, and this app only hands the *function*
   * over), and the loose parameter is what lets both statics share one type with
   * the `draw` closure the view hands the consumer.
   */
  export class Overlayer {
    static highlight(rects: unknown, options?: { color?: string }): unknown
    static outline(
      rects: unknown,
      options?: { color?: string; width?: number; radius?: number }
    ): unknown
  }
}
