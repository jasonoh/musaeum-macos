import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Book, BookSort, LibraryFacets } from '@shared/book.types'
import { persistedLibraryState, restoredSort, useLibraryStore } from './library.store'

const TITLE_ASC: BookSort = { field: 'title', direction: 'asc' }
const SHELF_DESC: BookSort = { field: 'shelf_added', direction: 'desc' }

/** Read once, and keep it true: every facet kind empty. */
const NO_FACETS: LibraryFacets = { authors: [], series: [], tags: [], formats: [], readStatus: [] }

/** `window.Musaeum`, reduced to the three reads `load()` makes. */
function stubLibrary(calls: { getBooks: unknown[]; searchBooks: unknown[]; getFacets: unknown[] }) {
  vi.stubGlobal('window', {
    Musaeum: {
      library: {
        getBooks: (filters: unknown) => {
          calls.getBooks.push(filters)
          return Promise.resolve([] as Book[])
        },
        searchBooks: (query: string, sort: unknown, scope: unknown) => {
          calls.searchBooks.push({ query, sort, scope })
          return Promise.resolve([] as Book[])
        },
        getFacets: (scope: unknown) => {
          calls.getFacets.push(scope)
          return Promise.resolve(NO_FACETS)
        }
      }
    }
  })
}

function emptyCalls() {
  return { getBooks: [], searchBooks: [], getFacets: [] }
}

afterEach(() => {
  vi.unstubAllGlobals()
  useLibraryStore.setState({
    activeShelfId: null,
    sort: TITLE_ASC,
    librarySort: TITLE_ASC,
    // The scope cases below set these; without the reset a later case reads a
    // previous case's filters and the "absent, not null" assertion sees them
    filters: {},
    query: ''
  })
})

describe('the scope (AC17)', () => {
  it('travels on the browse read, next to the filters it is not part of', async () => {
    const calls = emptyCalls()
    stubLibrary(calls)
    useLibraryStore.setState({ activeShelfId: 'shelf-1', filters: { authors: ['Herbert'] } })
    await useLibraryStore.getState().load()
    // One object, one WHERE builder: the scope rides with the filters rather
    // than being folded into them (R4)
    expect(calls.getBooks).toEqual([{ authors: ['Herbert'], sort: TITLE_ASC, shelfId: 'shelf-1' }])
    expect(calls.getFacets).toEqual([{ shelfId: 'shelf-1' }])
  })

  it('travels on the search read, which filters never do', async () => {
    const calls = emptyCalls()
    stubLibrary(calls)
    useLibraryStore.setState({ activeShelfId: 'shelf-1', query: 'dune' })
    await useLibraryStore.getState().load()
    expect(calls.searchBooks).toEqual([
      { query: 'dune', sort: TITLE_ASC, scope: { shelfId: 'shelf-1' } }
    ])
    expect(calls.getBooks).toEqual([])
  })

  it('is absent — not null — with no shelf open', async () => {
    const calls = emptyCalls()
    stubLibrary(calls)
    await useLibraryStore.getState().load()
    // `undefined`, because the preload's optional parameters and the SQL guard
    // both read absence; a `shelfId: null` would be a value nothing expects
    expect(calls.getBooks).toEqual([{ sort: TITLE_ASC }])
    expect(calls.getFacets).toEqual([undefined])
  })

  it('does not scope the search when no shelf is open', async () => {
    const calls = emptyCalls()
    stubLibrary(calls)
    useLibraryStore.setState({ query: 'dune' })
    await useLibraryStore.getState().load()
    // The preload's `scope` is optional; passing `{ shelfId: undefined }` would
    // be a second shape for the same absence
    expect(calls.searchBooks).toEqual([{ query: 'dune', sort: TITLE_ASC, scope: undefined }])
  })
})

describe('entering and leaving (AC17, AC18)', () => {
  it('enters with Date Added to Shelf, newest first, and remembers the library sort', () => {
    useLibraryStore.setState({
      sort: { field: 'author', direction: 'desc' },
      librarySort: { field: 'author', direction: 'desc' }
    })
    useLibraryStore.getState().setActiveShelf('shelf-1')
    const s = useLibraryStore.getState()
    expect(s.activeShelfId).toBe('shelf-1')
    expect(s.sort).toEqual(SHELF_DESC)
    expect(s.librarySort).toEqual({ field: 'author', direction: 'desc' })
  })

  it('leaves to the library sort, whatever the shelf was sorted by', () => {
    useLibraryStore.setState({
      activeShelfId: 'shelf-1',
      sort: SHELF_DESC,
      librarySort: { field: 'series', direction: 'asc' }
    })
    useLibraryStore.getState().setActiveShelf(null)
    const s = useLibraryStore.getState()
    expect(s.activeShelfId).toBeNull()
    expect(s.sort).toEqual({ field: 'series', direction: 'asc' })
  })

  it('switching straight between two shelves cannot overwrite the library sort (R1)', () => {
    useLibraryStore.setState({ sort: TITLE_ASC, librarySort: TITLE_ASC })
    useLibraryStore.getState().setActiveShelf('a')
    useLibraryStore.getState().setActiveShelf('b')
    // The second entry would otherwise remember `shelf_added`, and leaving
    // would restore a sort the library never had
    expect(useLibraryStore.getState().librarySort).toEqual(TITLE_ASC)
  })

  it('a sort chosen inside a shelf is the shelf\u2019s own (R1)', () => {
    useLibraryStore.setState({ activeShelfId: 'shelf-1', sort: SHELF_DESC, librarySort: TITLE_ASC })
    useLibraryStore.getState().setSort({ field: 'author', direction: 'asc' })
    expect(useLibraryStore.getState().sort).toEqual({ field: 'author', direction: 'asc' })
    expect(useLibraryStore.getState().librarySort).toEqual(TITLE_ASC)
  })

  it('a sort chosen in the library is remembered', () => {
    useLibraryStore.getState().setSort({ field: 'rating', direction: 'desc' })
    expect(useLibraryStore.getState().librarySort).toEqual({ field: 'rating', direction: 'desc' })
  })
})

describe('reconcileScope (Review Focus 1)', () => {
  it('clears a scope the list no longer holds, and restores the library sort', () => {
    useLibraryStore.setState({
      activeShelfId: 'gone',
      sort: SHELF_DESC,
      librarySort: { field: 'author', direction: 'asc' }
    })
    useLibraryStore.getState().reconcileScope(['present'])
    const s = useLibraryStore.getState()
    expect(s.activeShelfId).toBeNull()
    expect(s.sort).toEqual({ field: 'author', direction: 'asc' })
  })

  it('leaves a scope the list still holds alone', () => {
    useLibraryStore.setState({ activeShelfId: 'present', sort: SHELF_DESC })
    useLibraryStore.getState().reconcileScope(['present'])
    expect(useLibraryStore.getState().activeShelfId).toBe('present')
  })

  it('is a no-op with no shelf open', () => {
    useLibraryStore.setState({ activeShelfId: null, sort: TITLE_ASC })
    useLibraryStore.getState().reconcileScope([])
    expect(useLibraryStore.getState().sort).toEqual(TITLE_ASC)
  })
})

describe('what outlives the session (note 1)', () => {
  it('persists the library sort, never the shelf sort', () => {
    useLibraryStore.setState({ activeShelfId: 'shelf-1', sort: SHELF_DESC, librarySort: TITLE_ASC })
    // The whole of the rule, in the shape `persistedUIState` is tested in
    expect(persistedLibraryState(useLibraryStore.getState())).toEqual({ sort: TITLE_ASC })
  })

  it('refuses a stored shelf_added and keeps the library default', () => {
    // A build that persisted one would otherwise open the library sorted by a
    // shelf's membership, which it has none of
    expect(restoredSort(SHELF_DESC)).toBeNull()
    expect(restoredSort({ field: 'title', direction: 'asc' })).toEqual(TITLE_ASC)
    expect(restoredSort({ field: 'nonsense', direction: 'asc' })).toBeNull()
    expect(restoredSort(null)).toBeNull()
    expect(restoredSort('title')).toBeNull()
  })
})

/**
 * `load()` is the store's only reader, and this slice gave it a new way to be
 * asked twice at once: two sidebar clicks issue two scoped reads, and the SQL
 * they run is not the same cost, so the older answer can arrive last. Without a
 * guard the grid would show one shelf's rows while `activeShelfId` names
 * another — nothing would error, and the sort control, the placeholder and the
 * sidebar highlight would all be describing a different shelf than the books.
 */
describe('a read that is overtaken', () => {
  /** One resolver per `getBooks` call, so the case decides which answer lands. */
  function stubDeferredLibrary(): Array<(books: Book[]) => void> {
    const resolvers: Array<(books: Book[]) => void> = []
    vi.stubGlobal('window', {
      Musaeum: {
        library: {
          getBooks: () => new Promise<Book[]>((resolve) => resolvers.push(resolve)),
          searchBooks: () => Promise.resolve([] as Book[]),
          getFacets: () => Promise.resolve(NO_FACETS)
        }
      }
    })
    return resolvers
  }

  /** Only `id` is read here; the rest of `Book` is not this case's subject. */
  const book = (id: string) => ({ id, title: id }) as Book
  const ids = () => useLibraryStore.getState().books.map((b) => b.id)

  it('drops the older answer rather than applying it over the newer one', async () => {
    const resolvers = stubDeferredLibrary()
    useLibraryStore.setState({ activeShelfId: 'a' })
    const first = useLibraryStore.getState().load()
    useLibraryStore.setState({ activeShelfId: 'b' })
    const second = useLibraryStore.getState().load()

    // the newer read answers first …
    resolvers[1]([book('b1')])
    await second
    expect(ids()).toEqual(['b1'])

    // … and the older one lands afterwards, which must change nothing
    resolvers[0]([book('a1')])
    await first
    expect(ids()).toEqual(['b1'])
    // The overtaken read is not allowed to clear the winner's loading flag either
    expect(useLibraryStore.getState().loading).toBe(false)
  })

  it('still commits a read nothing overtook', async () => {
    const resolvers = stubDeferredLibrary()
    const load = useLibraryStore.getState().load()
    resolvers[0]([book('only')])
    await load
    expect(ids()).toEqual(['only'])
  })
})
