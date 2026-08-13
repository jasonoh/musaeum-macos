/**
 * Ambient declarations for the vendored foliate-js engine
 * (`vendor/foliate-js`, see its VENDORED.md). The upstream source is plain
 * ES modules with no types; declaring the slice we use keeps `any` out of
 * the reader without typechecking someone else's code.
 */
declare module '@vendor/foliate-js/view.js' {
  export interface FoliateTocItem {
    label: string
    href: string
    subitems?: FoliateTocItem[]
  }

  export interface FoliateRelocateDetail {
    fraction: number
    cfi?: string
    tocItem?: { label: string } | null
  }

  export interface FoliateBook {
    toc?: FoliateTocItem[]
  }

  export interface FoliateRenderer {
    setStyles(css: string): void
  }

  export class FoliateView extends HTMLElement {
    book: FoliateBook
    renderer: FoliateRenderer
    open(file: Blob | File): Promise<void>
    goTo(target: string): Promise<void>
    goToFraction(fraction: number): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    close(): void
  }
}
