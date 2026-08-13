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
    /** Throws if `open()` resolved but nothing was ever displayed. */
    close(): void
  }
}
