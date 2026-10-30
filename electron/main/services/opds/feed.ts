import type { Book, BookFormat } from '@shared/book.types'
import { orderedFormats } from '@shared/book.types'

/**
 * The OPDS 1.2 feed documents, as strings (`docs/superpowers/specs/2026-09-19-opds-catalog-design.md`).
 *
 * **Pure, and deliberately so.** No I/O, no database, no settings: the base URL
 * and the clock arrive as a `FeedContext`, and the books arrive already queried
 * and paged. The http layer owns routing, auth and the bytes; this file owns
 * only what a client's parser will be strict about — media types, rels, escaping
 * — so a golden test can hold all of it still.
 */

/** Link media types are exact strings (§2.2, §2.3): the most common way a feed is rejected by a picky client. */
export const OPDS_NAV_TYPE = 'application/atom+xml;profile=opds-catalog;kind=navigation'
export const OPDS_ACQ_TYPE = 'application/atom+xml;profile=opds-catalog;kind=acquisition'
export const OPENSEARCH_TYPE = 'application/opensearchdescription+xml'

/**
 * Entries per page, chosen by measurement against the < 500 KB target.
 * Measured: 100 synthetic worst-case books (80-character titles, 2,000-character
 * descriptions full of escapable characters and truncated to `SUMMARY_MAX`, five
 * tags, four formats, both covers) serialize to 592,921 bytes, about 5.9 KB each;
 * the largest multiple of 10 under 500 KB is therefore 80. Typical books are
 * about half that size.
 */
export const OPDS_PAGE_SIZE = 80

/** Summary length in characters (code points); a full-length description would make a page cost more than the books on it. */
export const SUMMARY_MAX = 1000

/**
 * Declared over the union so a fifth format is a typecheck failure here. The two
 * Mobipocket types are unregistered and deliberately shared: there is no
 * registered type for KF8, and a client that filters by type would otherwise see
 * two distinct Mobipocket formats.
 */
export const FORMAT_TYPES: Record<BookFormat, string> = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/x-mobipocket-ebook'
}

export type FeedContext = {
  /** `http://host:port`, no trailing slash. */
  baseUrl: string
  /** The ISO time the feed's own `updated` carries; injected so goldens are stable. */
  now: string
}

export interface PageWindow {
  /** 1-based. */
  page: number
  offset: number
  limit: number
  hasNext: boolean
  hasPrev: boolean
}

const EPOCH = '1970-01-01T00:00:00Z'

/**
 * Atom wants an RFC 3339 date-time and a strict client rejects or mis-sorts a
 * feed over one bad entry, while the stored columns are free text (Calibre
 * imports, sidecar writes). Accept only what `Date.parse` reads and normalize it.
 */
function rfc3339(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

/** DCMI W3CDTF: a year, a year-month, a date, or a full date-time. Anything else is omitted rather than guessed at. */
function w3cdtf(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  return /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/.test(value)
    ? value
    : undefined
}

/**
 * Escape for element text and attribute values, and drop what XML 1.0 cannot
 * carry at all (C0 controls other than tab/LF/CR, lone surrogates, U+FFFE/FFFF).
 * One book with a stray NUL in its description would otherwise make every page
 * it appears on unparseable.
 */
export function escapeXml(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    const legal =
      c === 0x9 ||
      c === 0xa ||
      c === 0xd ||
      (c >= 0x20 && c <= 0xd7ff) ||
      (c >= 0xe000 && c <= 0xfffd) ||
      (c >= 0x10000 && c <= 0x10ffff)
    if (!legal) continue
    switch (ch) {
      case '&':
        out += '&amp;'
        break
      case '<':
        out += '&lt;'
        break
      case '>':
        out += '&gt;'
        break
      case '"':
        out += '&quot;'
        break
      case "'":
        out += '&apos;'
        break
      default:
        out += ch
    }
  }
  return out
}

/**
 * The window a `?page=` names. `null` for a present-but-invalid value (the
 * caller answers 400); an absent one is page 1. A page past the end is valid
 * and simply empty, so a client walking `next` links never meets an error.
 */
export function pageWindow(
  rawPage: string | null,
  total: number,
  size: number = OPDS_PAGE_SIZE
): PageWindow | null {
  let page = 1
  if (rawPage !== null) {
    // Digits only, no leading zero, bounded so the offset is always a safe integer.
    if (!/^[1-9]\d{0,8}$/.test(rawPage)) return null
    page = Number(rawPage)
  }
  const offset = (page - 1) * size
  return { page, offset, limit: size, hasNext: offset + size < total, hasPrev: page > 1 }
}

const NS =
  'xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" ' +
  'xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"'

const REL_ACQUISITION = 'http://opds-spec.org/acquisition/open-access'

function link(rel: string, href: string, type: string, title?: string): string {
  const t = title ? ` title="${escapeXml(title)}"` : ''
  return `<link rel="${escapeXml(rel)}" href="${escapeXml(href)}" type="${escapeXml(type)}"${t}/>`
}

function withPage(path: string, page: number): string {
  return `${path}${path.includes('?') ? '&' : '?'}page=${page}`
}

function truncate(text: string, max: number): string {
  const points = [...text]
  if (points.length <= max) return text
  return points.slice(0, max - 1).join('') + '…'
}

function header(
  ctx: FeedContext,
  id: string,
  title: string,
  selfHref: string,
  type: string
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<feed ${NS}>\n` +
    `<id>${escapeXml(id)}</id>\n<title>${escapeXml(title)}</title>\n<updated>${escapeXml(rfc3339(ctx.now) ?? EPOCH)}</updated>\n` +
    `<author><name>Musaeum</name></author>\n` +
    `${link('self', selfHref, type)}\n${link('start', `${ctx.baseUrl}/opds`, OPDS_NAV_TYPE)}\n` +
    `${link('search', `${ctx.baseUrl}/opds/search.xml`, OPENSEARCH_TYPE)}\n`
  )
}

/** Entries per page of the author and series name lists (`/opds/authors/{slug}`, `/opds/series/{slug}`); an entry is tiny, so this is far above `OPDS_PAGE_SIZE`. Title buckets are acquisition feeds paged at `OPDS_PAGE_SIZE`, and the letters feeds are unpaged. */
export const OPDS_NAV_PAGE_SIZE = 200

/** One row of a navigation feed. `path` is absolute-from-root and already percent-encoded; `kind` is what it leads to. */
export type NavEntry = {
  id: string
  title: string
  content: string
  path: string
  kind: 'navigation' | 'acquisition'
  /** Defaults to `subsection`. */
  rel?: string
}

function navEntry(ctx: FeedContext, entry: NavEntry): string {
  const type = entry.kind === 'navigation' ? OPDS_NAV_TYPE : OPDS_ACQ_TYPE
  return (
    `<entry>\n<id>${escapeXml(entry.id)}</id>\n<title>${escapeXml(entry.title)}</title>\n<updated>${escapeXml(rfc3339(ctx.now) ?? EPOCH)}</updated>\n` +
    `<content type="text">${escapeXml(entry.content)}</content>\n${link(entry.rel ?? 'subsection', `${ctx.baseUrl}${entry.path}`, type)}\n</entry>\n`
  )
}

export function buildRootFeed(ctx: FeedContext): string {
  const entries: NavEntry[] = [
    {
      id: 'urn:musaeum:opds:new',
      title: 'Newest',
      content: 'Recently added books',
      path: '/opds/new',
      kind: 'acquisition',
      rel: 'http://opds-spec.org/sort/new'
    },
    {
      id: 'urn:musaeum:opds:unread',
      title: 'Unread',
      content: 'Books you have not read yet',
      path: '/opds/unread',
      kind: 'acquisition'
    },
    {
      id: 'urn:musaeum:opds:authors',
      title: 'Authors',
      content: 'Browse by author',
      path: '/opds/authors',
      kind: 'navigation'
    },
    {
      id: 'urn:musaeum:opds:series',
      title: 'Series',
      content: 'Browse by series',
      path: '/opds/series',
      kind: 'navigation'
    },
    {
      id: 'urn:musaeum:opds:titles',
      title: 'Titles',
      content: 'Browse by title',
      path: '/opds/titles',
      kind: 'navigation'
    },
    {
      id: 'urn:musaeum:opds:all',
      title: 'All books',
      content: 'Every book, by title',
      path: '/opds/all',
      kind: 'acquisition'
    }
  ]
  return (
    header(ctx, 'urn:musaeum:opds:root', 'Musaeum', `${ctx.baseUrl}/opds`, OPDS_NAV_TYPE) +
    entries.map((e) => navEntry(ctx, e)).join('') +
    '</feed>\n'
  )
}

/** A feed of links to other feeds. `window` (when paged) carries next/previous; `total` is advertised only when known. */
export function buildNavigationFeed(
  ctx: FeedContext,
  opts: {
    id: string
    title: string
    selfPath: string
    entries: NavEntry[]
    total?: number
    window?: PageWindow
  }
): string {
  const { window } = opts
  const href = (page: number): string => `${ctx.baseUrl}${withPage(opts.selfPath, page)}`
  let out = header(
    ctx,
    opts.id,
    opts.title,
    window ? href(window.page) : `${ctx.baseUrl}${opts.selfPath}`,
    OPDS_NAV_TYPE
  )
  if (opts.total !== undefined) {
    out += `<opensearch:totalResults>${opts.total}</opensearch:totalResults>\n`
  }
  if (window) {
    out += `<opensearch:itemsPerPage>${window.limit}</opensearch:itemsPerPage>\n`
    if (window.hasPrev) out += link('previous', href(window.page - 1), OPDS_NAV_TYPE) + '\n'
    if (window.hasNext) out += link('next', href(window.page + 1), OPDS_NAV_TYPE) + '\n'
  }
  for (const entry of opts.entries) out += navEntry(ctx, entry)
  return out + '</feed>\n'
}

function buildEntry(ctx: FeedContext, book: Book): string {
  const parts: string[] = []
  parts.push(`<id>urn:uuid:${escapeXml(book.id)}</id>`)
  parts.push(`<title>${escapeXml(book.title)}</title>`)
  if (book.author) parts.push(`<author><name>${escapeXml(book.author)}</name></author>`)
  parts.push(
    `<updated>${escapeXml(rfc3339(book.lastModified) ?? rfc3339(book.dateAdded) ?? EPOCH)}</updated>`
  )
  if (book.language) parts.push(`<dc:language>${escapeXml(book.language)}</dc:language>`)
  const issued = w3cdtf(book.publishedDate)
  if (issued) parts.push(`<dc:issued>${escapeXml(issued)}</dc:issued>`)
  const isbn = book.isbn13 || book.isbn10
  if (isbn) parts.push(`<dc:identifier>urn:isbn:${escapeXml(isbn)}</dc:identifier>`)
  if (book.publisher) parts.push(`<dc:publisher>${escapeXml(book.publisher)}</dc:publisher>`)
  for (const tag of book.tags) {
    if (tag) parts.push(`<category term="${escapeXml(tag)}" label="${escapeXml(tag)}"/>`)
  }
  if (book.description) {
    parts.push(
      `<summary type="text">${escapeXml(truncate(book.description, SUMMARY_MAX))}</summary>`
    )
  }
  const id = encodeURIComponent(book.id)
  if (book.coverFullPath) {
    parts.push(
      link('http://opds-spec.org/image', `${ctx.baseUrl}/opds/cover/${id}/full`, 'image/jpeg')
    )
  }
  if (book.coverThumbPath) {
    parts.push(
      link(
        'http://opds-spec.org/image/thumbnail',
        `${ctx.baseUrl}/opds/cover/${id}/thumb`,
        'image/jpeg'
      )
    )
  }
  for (const format of orderedFormats(book)) {
    parts.push(
      link(REL_ACQUISITION, `${ctx.baseUrl}/opds/book/${id}/${format}`, FORMAT_TYPES[format])
    )
  }
  return `<entry>\n${parts.join('\n')}\n</entry>\n`
}

export function buildAcquisitionFeed(
  ctx: FeedContext,
  opts: {
    id: string
    title: string
    selfPath: string
    books: Book[]
    total: number
    window: PageWindow
    extraLinks?: string
  }
): string {
  const { window } = opts
  const href = (page: number): string => `${ctx.baseUrl}${withPage(opts.selfPath, page)}`
  let out = header(ctx, opts.id, opts.title, href(window.page), OPDS_ACQ_TYPE)
  out += `<opensearch:totalResults>${opts.total}</opensearch:totalResults>\n`
  out += `<opensearch:itemsPerPage>${window.limit}</opensearch:itemsPerPage>\n`
  if (window.hasPrev) out += link('previous', href(window.page - 1), OPDS_ACQ_TYPE) + '\n'
  if (window.hasNext) out += link('next', href(window.page + 1), OPDS_ACQ_TYPE) + '\n'
  if (opts.extraLinks) out += opts.extraLinks + '\n'
  for (const book of opts.books) out += buildEntry(ctx, book)
  return out + '</feed>\n'
}

export function buildSearchDescription(ctx: FeedContext): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">\n` +
    `<ShortName>Musaeum</ShortName>\n<Description>Search the Musaeum library</Description>\n` +
    `<InputEncoding>UTF-8</InputEncoding>\n` +
    `<Url type="${OPDS_ACQ_TYPE}" template="${escapeXml(ctx.baseUrl)}/opds/search?q={searchTerms}"/>\n` +
    `</OpenSearchDescription>\n`
  )
}
