import type { BookFilters } from '@shared/book.types'
import {
  countBooksByInitial,
  getBooksPage,
  listNamesByInitial,
  type BookPage,
  type NameKind
} from '../db'
import { BUCKETS, bucketFromSlug, bucketSlug, type Bucket } from '../initials'
import {
  OPDS_ACQ_TYPE,
  OPDS_NAV_PAGE_SIZE,
  OPDS_NAV_TYPE,
  buildAcquisitionFeed,
  buildNavigationFeed,
  pageWindow,
  type FeedContext,
  type NavEntry,
  type PageWindow
} from './feed'

/**
 * The OPDS browse tree (`docs/superpowers/specs/2026-09-19-opds-catalog-design.md`, slice O2): unread, authors, series and titles.
 *
 * `matchBrowsePath` is the route table (pure); `serveBrowse` is the feed assembly. The http layer
 * (`api/opds.ts`) owns auth, the no-library check and the socket, and calls these once.
 *
 * Every list is read through the db's one query path (`getBooksPage`, `listNamesByInitial`,
 * `countBooksByInitial`): a book is counted under the same letter it is listed under.
 */

export type BrowseRoute =
  | { kind: 'unread' }
  | { kind: 'letters'; tree: 'authors' | 'series' | 'titles' }
  | { kind: 'names'; tree: 'authors' | 'series'; bucket: Bucket }
  | { kind: 'titles'; bucket: Bucket }
  | { kind: 'by-author'; name: string }
  | { kind: 'by-series'; name: string }

/**
 * Parse a path into a route, or `null` for anything that is not one. The path is split on `/`
 * **before** it is decoded, so an encoded slash (`A%2FB`) stays inside a name instead of
 * becoming a second segment.
 */
export function matchBrowsePath(pathname: string): BrowseRoute | null {
  const parts = pathname.split('/')
  // ['', 'opds', section, rest?]
  if (parts[0] !== '' || parts[1] !== 'opds') return null
  const section = parts[2]
  const rest = parts[3]
  if (parts.length < 3 || parts.length > 4) return null

  if (section === 'unread') return parts.length === 3 ? { kind: 'unread' } : null

  if (section === 'authors' || section === 'series' || section === 'titles') {
    if (parts.length === 3) return { kind: 'letters', tree: section }
    const bucket = bucketFromSlug(rest ?? '')
    if (!bucket) return null
    return section === 'titles'
      ? { kind: 'titles', bucket }
      : { kind: 'names', tree: section, bucket }
  }

  if (section === 'by-author' || section === 'by-series') {
    if (parts.length !== 4) return null
    let name: string
    try {
      name = decodeURIComponent(rest ?? '')
    } catch {
      return null
    }
    if (!name) return null
    return section === 'by-author' ? { kind: 'by-author', name } : { kind: 'by-series', name }
  }

  return null
}

/** The one place a name becomes part of a path. */
function encodeName(name: string): string {
  return encodeURIComponent(name)
}

const TITLE_ASC: BookFilters['sort'] = { field: 'title', direction: 'asc' }

const TREE_LABEL = { authors: 'Authors', series: 'Series', titles: 'Titles' } as const
const NAME_KIND: Record<'authors' | 'series', NameKind> = { authors: 'author', series: 'series' }

type Served = { status: 200; type: string; body: string } | { status: 400 }

function acquisition(
  ctx: FeedContext,
  rawPage: string | null,
  feed: { id: string; title: string; selfPath: string },
  query: (window: PageWindow) => BookPage
): Served {
  // Asked twice, as `api/opds.ts` always has: once to validate and size the query, once with the total
  const probe = pageWindow(rawPage, 0)
  if (!probe) return { status: 400 }
  const page = query(probe)
  const window = pageWindow(rawPage, page.total) as PageWindow
  return {
    status: 200,
    type: OPDS_ACQ_TYPE,
    body: buildAcquisitionFeed(ctx, { ...feed, books: page.books, total: page.total, window })
  }
}

function letters(ctx: FeedContext, tree: 'authors' | 'series' | 'titles'): Served {
  const counts = countBooksByInitial(tree === 'titles' ? 'title' : NAME_KIND[tree])
  const byBucket = new Map(counts.map((c) => [c.bucket, c.count]))
  const entries: NavEntry[] = BUCKETS.filter((b) => (byBucket.get(b) ?? 0) > 0).map((b) => ({
    id: `urn:musaeum:opds:${tree}:${bucketSlug(b)}`,
    title: b,
    content: `${byBucket.get(b)} books`,
    path: `/opds/${tree}/${bucketSlug(b)}`,
    kind: tree === 'titles' ? 'acquisition' : 'navigation'
  }))
  return {
    status: 200,
    type: OPDS_NAV_TYPE,
    body: buildNavigationFeed(ctx, {
      id: `urn:musaeum:opds:${tree}`,
      title: TREE_LABEL[tree],
      selfPath: `/opds/${tree}`,
      entries
    })
  }
}

function names(
  ctx: FeedContext,
  tree: 'authors' | 'series',
  bucket: Bucket,
  rawPage: string | null
): Served {
  const probe = pageWindow(rawPage, 0, OPDS_NAV_PAGE_SIZE)
  if (!probe) return { status: 400 }
  const { names: rows, total } = listNamesByInitial(NAME_KIND[tree], bucket, {
    limit: probe.limit,
    offset: probe.offset
  })
  const window = pageWindow(rawPage, total, OPDS_NAV_PAGE_SIZE) as PageWindow
  const target = tree === 'authors' ? 'by-author' : 'by-series'
  const entries: NavEntry[] = rows.map((r) => ({
    id: `urn:musaeum:opds:${target}:${encodeName(r.name)}`,
    title: r.name,
    content: `${r.count} books`,
    path: `/opds/${target}/${encodeName(r.name)}`,
    kind: 'acquisition'
  }))
  return {
    status: 200,
    type: OPDS_NAV_TYPE,
    body: buildNavigationFeed(ctx, {
      id: `urn:musaeum:opds:${tree}:${bucketSlug(bucket)}`,
      title: `${TREE_LABEL[tree]} — ${bucket}`,
      selfPath: `/opds/${tree}/${bucketSlug(bucket)}`,
      entries,
      total,
      window
    })
  }
}

/** Query and build the feed for a matched route. `rawPage` is the `?page=` value, or `null` when absent. */
export function serveBrowse(route: BrowseRoute, ctx: FeedContext, rawPage: string | null): Served {
  const at = (filters: BookFilters & { titleInitial?: Bucket }) => (w: PageWindow) =>
    getBooksPage(filters, { limit: w.limit, offset: w.offset })

  switch (route.kind) {
    case 'letters':
      return letters(ctx, route.tree)
    case 'names':
      return names(ctx, route.tree, route.bucket, rawPage)
    case 'titles':
      return acquisition(
        ctx,
        rawPage,
        {
          id: `urn:musaeum:opds:titles:${bucketSlug(route.bucket)}`,
          title: `Titles — ${route.bucket}`,
          selfPath: `/opds/titles/${bucketSlug(route.bucket)}`
        },
        at({ titleInitial: route.bucket, sort: TITLE_ASC })
      )
    case 'unread':
      return acquisition(
        ctx,
        rawPage,
        { id: 'urn:musaeum:opds:unread', title: 'Unread', selfPath: '/opds/unread' },
        at({ readStatus: ['unread'], sort: TITLE_ASC })
      )
    case 'by-author':
      return acquisition(
        ctx,
        rawPage,
        {
          id: `urn:musaeum:opds:by-author:${encodeName(route.name)}`,
          title: route.name,
          selfPath: `/opds/by-author/${encodeName(route.name)}`
        },
        at({ authors: [route.name], sort: TITLE_ASC })
      )
    case 'by-series':
      return acquisition(
        ctx,
        rawPage,
        {
          id: `urn:musaeum:opds:by-series:${encodeName(route.name)}`,
          title: route.name,
          selfPath: `/opds/by-series/${encodeName(route.name)}`
        },
        at({ series: [route.name], sort: { field: 'series', direction: 'asc' } })
      )
  }
}
