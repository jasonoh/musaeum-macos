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
   */
  export interface FoliateRelocateDetail {
    fraction?: number
    cfi?: string
    tocItem?: { label: string } | null
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
    /** Defaults to `Overlayer.outline`; the reader passes a colour (D4). */
    drawOptions?: { color?: string; width?: number; radius?: number }
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
    /** Throws if `open()` resolved but nothing was ever displayed. */
    close(): void
  }
}
