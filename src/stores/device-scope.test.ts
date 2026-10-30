import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Book, BookSort } from '@shared/book.types'
import { deviceScanned, scopeToDevice } from '@/lib/device-scope'
import { libraryViewState } from '@/lib/library-emptiness'
import { useDeviceStore } from './device.store'
import { useLibraryStore } from './library.store'

const TITLE_ASC: BookSort = { field: 'title', direction: 'asc' }
const KINDLE = 'kindle:Kindle'
const book = (id: string) => ({ id, title: id }) as unknown as Book
const LIBRARY = ['a', 'b', 'c', 'd'].map(book)

/** `window.Musaeum`, reduced to what `load()` reads, always answering the whole library. */
function stubReads() {
  vi.stubGlobal('window', {
    Musaeum: {
      library: {
        getBooks: () => Promise.resolve(LIBRARY),
        searchBooks: () => Promise.resolve(LIBRARY),
        getFacets: () => Promise.resolve({})
      }
    }
  })
}

const ids = () => useLibraryStore.getState().books.map((b) => b.id)

afterEach(() => {
  vi.unstubAllGlobals()
  useLibraryStore.setState({
    activeShelfId: null,
    activeDeviceId: null,
    sort: TITLE_ASC,
    librarySort: TITLE_ASC,
    books: [],
    loadedBooks: [],
    filters: {},
    query: ''
  })
  useDeviceStore.setState({ devices: [], onDevice: {} })
})

describe('scopeToDevice', () => {
  it('is the same list when no device is open', () => {
    expect(scopeToDevice(LIBRARY, null, { [KINDLE]: ['a'] })).toBe(LIBRARY)
  })

  it('keeps the read order and drops what is not on the device', () => {
    expect(scopeToDevice(LIBRARY, KINDLE, { [KINDLE]: ['d', 'b'] }).map((b) => b.id)).toEqual([
      'b',
      'd'
    ])
  })

  it('shows nothing before the first scan, which deviceScanned tells apart from an empty device', () => {
    expect(scopeToDevice(LIBRARY, KINDLE, {})).toEqual([])
    expect(deviceScanned(KINDLE, {})).toBe(false)
    expect(deviceScanned(KINDLE, { [KINDLE]: [] })).toBe(true)
  })
})

describe('the device scope', () => {
  function enter() {
    useLibraryStore.setState({ loadedBooks: LIBRARY, books: LIBRARY })
    useDeviceStore.setState({ onDevice: { [KINDLE]: ['a', 'c'] } })
    useLibraryStore.getState().setActiveDevice(KINDLE)
  }

  it('filters the loaded books by the device’s presence, with no read', () => {
    enter()
    expect(ids()).toEqual(['a', 'c'])
    expect(useLibraryStore.getState().loadedBooks).toHaveLength(4)
  })

  it('re-derives when presence moves, and when the library reloads', async () => {
    stubReads()
    enter()
    useDeviceStore.getState().setOnDevice(KINDLE, ['a', 'b', 'c'])
    useLibraryStore.getState().syncDeviceScope()
    expect(ids()).toEqual(['a', 'b', 'c'])
    await useLibraryStore.getState().load()
    expect(ids()).toEqual(['a', 'b', 'c'])
  })

  it('leaves with the library back in full, keeping the sort', () => {
    enter()
    useLibraryStore.getState().setSort({ field: 'author', direction: 'desc' })
    useLibraryStore.getState().setActiveDevice(null)
    expect(ids()).toEqual(['a', 'b', 'c', 'd'])
    expect(useLibraryStore.getState().sort).toEqual({ field: 'author', direction: 'desc' })
  })

  it('is left by “Library” (setActiveShelf(null))', () => {
    enter()
    useLibraryStore.getState().setActiveShelf(null)
    expect(useLibraryStore.getState().activeDeviceId).toBeNull()
    expect(ids()).toHaveLength(4)
  })

  it('is exclusive with a shelf, and the library sort survives the round trip', () => {
    stubReads()
    enter()
    useLibraryStore.getState().setActiveShelf('shelf-1')
    expect(useLibraryStore.getState().activeDeviceId).toBeNull()
    expect(useLibraryStore.getState().activeShelfId).toBe('shelf-1')
    expect(useLibraryStore.getState().sort.field).toBe('shelf_added')
    useLibraryStore.getState().setActiveDevice(KINDLE)
    expect(useLibraryStore.getState().activeShelfId).toBeNull()
    expect(useLibraryStore.getState().activeDeviceId).toBe(KINDLE)
    expect(useLibraryStore.getState().sort).toEqual(TITLE_ASC)
  })

  it('is left when its device disconnects, and only then', () => {
    enter()
    useLibraryStore.getState().reconcileDeviceScope([KINDLE, 'kindle:Other'])
    expect(useLibraryStore.getState().activeDeviceId).toBe(KINDLE)
    useLibraryStore.getState().reconcileDeviceScope(['kindle:Other'])
    expect(useLibraryStore.getState().activeDeviceId).toBeNull()
    expect(ids()).toHaveLength(4)
  })

  it('is left by filtering to an author', () => {
    stubReads()
    enter()
    useLibraryStore.getState().filterByAuthor('Herbert')
    expect(useLibraryStore.getState().activeDeviceId).toBeNull()
  })
})

describe('removeBooksFromDevice', () => {
  it('drops exactly the removed ids from presence, and returns the failures', async () => {
    vi.stubGlobal('window', {
      Musaeum: {
        devices: {
          removeBooksFromDevice: () =>
            Promise.resolve({ removed: ['a', 'b'], failed: [{ bookId: 'c', error: 'read-only' }] })
        }
      }
    })
    useDeviceStore.setState({ onDevice: { [KINDLE]: ['a', 'b', 'c', 'd'] } })
    const result = await useDeviceStore.getState().removeBooksFromDevice(['a', 'b', 'c'], KINDLE)
    expect(result.failed).toEqual([{ bookId: 'c', error: 'read-only' }])
    expect(useDeviceStore.getState().onDevice[KINDLE]).toEqual(['c', 'd'])
  })

  it('takes a removed book out of the open device view at once', async () => {
    vi.stubGlobal('window', {
      Musaeum: {
        devices: {
          removeBooksFromDevice: () => Promise.resolve({ removed: ['a'], failed: [] })
        }
      }
    })
    useLibraryStore.setState({ loadedBooks: LIBRARY, books: LIBRARY })
    useDeviceStore.setState({ onDevice: { [KINDLE]: ['a', 'c'] } })
    useLibraryStore.getState().setActiveDevice(KINDLE)
    await useDeviceStore.getState().removeBooksFromDevice(['a'], KINDLE)
    useLibraryStore.getState().syncDeviceScope()
    expect(ids()).toEqual(['c'])
  })
})

describe('the empty device view', () => {
  const base = {
    loading: false,
    query: '',
    filters: {},
    resultCount: 0,
    storageConnected: false,
    shelfId: null
  }

  it('says the device is being read until its first scan lands, then that it is empty', () => {
    expect(libraryViewState({ ...base, device: { scanned: false } })).toBe('reading-device')
    expect(libraryViewState({ ...base, device: { scanned: true } })).toBe('empty-device')
  })

  it('needs no storage, and still lets a search miss read as a miss', () => {
    expect(libraryViewState({ ...base, device: { scanned: true } })).toBe('empty-device')
    expect(libraryViewState({ ...base, query: 'x', device: { scanned: true } })).toBe('no-matches')
  })
})
