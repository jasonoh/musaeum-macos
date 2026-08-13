import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import {
  CATALOG_VERSION,
  catalogPath,
  mergeBooks,
  metadataJsonToBook,
  readCatalog,
  readCatalogDetailed,
  rebuildFromBookDirs,
  removeFromCatalog,
  replaceCatalog,
  upsertIntoCatalog,
  writeCatalog,
  type MetadataJson
} from './catalog'
import { writeMetadataJson } from './importer'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'musaeum-catalog-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readCatalog', () => {
  it('returns null when no catalog exists', async () => {
    expect(await readCatalog(root)).toBeNull()
  })

  it('round-trips books through writeCatalog', async () => {
    await writeCatalog(root, [makeBook('a'), makeBook('b')])
    const cat = await readCatalog(root)
    expect(cat?.version).toBe(CATALOG_VERSION)
    expect(cat?.generated_at).toBeTruthy()
    expect(cat?.books.map((b) => b.id)).toEqual(['a', 'b'])
  })

  it('returns null for unparsable JSON', async () => {
    await fs.writeFile(catalogPath(root), 'not json{', 'utf8')
    expect(await readCatalog(root)).toBeNull()
  })

  it('returns null for an unknown version', async () => {
    await fs.writeFile(catalogPath(root), JSON.stringify({ version: 99, books: [] }), 'utf8')
    expect(await readCatalog(root)).toBeNull()
  })

  it('leaves no .part file behind after writing', async () => {
    await writeCatalog(root, [makeBook('a')])
    await expect(fs.access(`${catalogPath(root)}.part`)).rejects.toThrow()
  })
})

describe('readCatalogDetailed', () => {
  it('returns missing when no file exists', async () => {
    expect(await readCatalogDetailed(root)).toEqual({ state: 'missing' })
  })

  it('returns invalid for corrupt JSON', async () => {
    await fs.writeFile(catalogPath(root), 'not json{', 'utf8')
    expect(await readCatalogDetailed(root)).toEqual({ state: 'invalid' })
  })

  it('returns invalid for an unknown version', async () => {
    await fs.writeFile(catalogPath(root), JSON.stringify({ version: 99, books: [] }), 'utf8')
    expect(await readCatalogDetailed(root)).toEqual({ state: 'invalid' })
  })

  it('returns ok with the file after writeCatalog', async () => {
    await writeCatalog(root, [makeBook('a')])
    const result = await readCatalogDetailed(root)
    expect(result.state).toBe('ok')
    if (result.state === 'ok') {
      expect(result.file.books.map((b) => b.id)).toEqual(['a'])
    }
  })

  it('derives sort keys a catalog entry is missing', async () => {
    // A catalog written before sort keys were derived — adopting it as-is
    // would sort the book under "Seth" and undo the cache backfill
    await writeCatalog(root, [
      { ...makeBook('a', 'The Traitor Baru Cormorant'), author: 'Seth Dickinson', sortTitle: null, authorSort: null }
    ])
    const result = await readCatalogDetailed(root)
    expect(result.state).toBe('ok')
    if (result.state === 'ok') {
      expect(result.file.books[0].sortTitle).toBe('Traitor Baru Cormorant, The')
      expect(result.file.books[0].authorSort).toBe('Dickinson, Seth')
    }
  })

  it('keeps sort keys the catalog already carries', async () => {
    await writeCatalog(root, [
      { ...makeBook('a', 'The Hobbit'), author: 'J.R.R. Tolkien', sortTitle: 'Hobbit', authorSort: 'Tolkien' }
    ])
    const result = await readCatalogDetailed(root)
    if (result.state === 'ok') {
      expect(result.file.books[0].sortTitle).toBe('Hobbit')
      expect(result.file.books[0].authorSort).toBe('Tolkien')
    }
  })

  it('throws on a non-ENOENT read error', async () => {
    if (process.getuid?.() === 0) return // root ignores file modes
    await writeCatalog(root, [makeBook('a')])
    await fs.chmod(catalogPath(root), 0o000)
    try {
      await expect(readCatalogDetailed(root)).rejects.toThrow()
    } finally {
      await fs.chmod(catalogPath(root), 0o644)
    }
  })
})

describe('mergeBooks', () => {
  it('replaces entries by id and appends new ones', () => {
    const current = [makeBook('a', 'Old A'), makeBook('b')]
    const merged = mergeBooks(current, [makeBook('a', 'New A'), makeBook('c')])
    expect(merged.map((b) => b.id).sort()).toEqual(['a', 'b', 'c'])
    expect(merged.find((b) => b.id === 'a')?.title).toBe('New A')
  })
})

describe('upsertIntoCatalog', () => {
  it('creates the catalog from fallback when missing', async () => {
    await upsertIntoCatalog(root, [makeBook('new')], () => [makeBook('local')])
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id).sort()).toEqual(['local', 'new'])
  })

  it('merges into the existing catalog and ignores fallback', async () => {
    await writeCatalog(root, [makeBook('a')])
    await upsertIntoCatalog(root, [makeBook('b')], () => [makeBook('should-not-appear')])
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id).sort()).toEqual(['a', 'b'])
  })

  it('serializes concurrent upserts (none lost)', async () => {
    await writeCatalog(root, [])
    const ids = Array.from({ length: 10 }, (_, i) => `bk-${i}`)
    await Promise.all(ids.map((id) => upsertIntoCatalog(root, [makeBook(id)], () => [])))
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id).sort()).toEqual([...ids].sort())
  })
})

describe('removeFromCatalog', () => {
  it('removes the entry by id', async () => {
    await writeCatalog(root, [makeBook('a'), makeBook('b')])
    await removeFromCatalog(root, 'a', () => [])
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id)).toEqual(['b'])
  })
})

describe('replaceCatalog', () => {
  it('overwrites the whole catalog', async () => {
    await writeCatalog(root, [makeBook('a')])
    await replaceCatalog(root, [makeBook('x'), makeBook('y')])
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id)).toEqual(['x', 'y'])
  })
})

function makeMetadataJson(id: string, title = `Book ${id}`): MetadataJson {
  return {
    id,
    title,
    sort_title: title,
    authors: [{ name: 'Jane Author', sort: 'Author, Jane' }],
    publisher: 'Orbit',
    published_date: '2011-06-02',
    language: 'en',
    description: 'desc',
    identifiers: { isbn_13: '9780316129084' },
    series: { name: 'The Expanse', index: 1, total: 9 },
    tags: ['sf'],
    cover: { full: 'cover_full.jpg', thumb: 'cover_thumb.jpg' },
    formats: ['epub', 'pdf'],
    rating: null,
    read_status: 'unread',
    date_added: '2025-01-15T10:30:00Z',
    last_modified: '2025-01-15T10:31:00Z'
  }
}

async function writeBookDir(id: string, json: MetadataJson | string): Promise<string> {
  const dir = join(root, 'books', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    join(dir, 'metadata.json'),
    typeof json === 'string' ? json : JSON.stringify(json),
    'utf8'
  )
  return dir
}

describe('metadataJsonToBook', () => {
  it('maps the canonical metadata.json shape onto Book', async () => {
    const dir = await writeBookDir('uuid-1', makeMetadataJson('uuid-1', 'Leviathan Wakes'))
    await fs.writeFile(join(dir, 'Leviathan Wakes.epub'), 'x'.repeat(100))
    await fs.writeFile(join(dir, 'Leviathan Wakes.pdf'), 'y'.repeat(50))
    const book = await metadataJsonToBook(makeMetadataJson('uuid-1', 'Leviathan Wakes'), 'uuid-1', dir)
    expect(book).toMatchObject({
      id: 'uuid-1',
      title: 'Leviathan Wakes',
      author: 'Jane Author',
      authorSort: 'Author, Jane',
      isbn13: '9780316129084',
      seriesName: 'The Expanse',
      seriesIndex: 1,
      seriesTotal: 9,
      coverFullPath: 'cover_full.jpg',
      coverThumbPath: 'cover_thumb.jpg',
      formats: ['epub', 'pdf'],
      tags: ['sf'],
      readStatus: 'unread',
      nasPath: join('books', 'uuid-1'),
      fileSizeBytes: 150
    })
  })

  it('tolerates minimal metadata and unknown formats', async () => {
    const dir = await writeBookDir('uuid-2', { id: 'uuid-2', title: 'Bare' })
    const book = await metadataJsonToBook(
      { id: 'uuid-2', title: 'Bare', formats: ['epub', 'cbz'] },
      'uuid-2',
      dir
    )
    expect(book.author).toBeNull()
    expect(book.formats).toEqual(['epub'])
    expect(book.readStatus).toBe('unread')
    expect(book.fileSizeBytes).toBeNull()
  })
})

describe('rebuildFromBookDirs', () => {
  it('walks book dirs, writes the catalog, reports progress, skips broken folders', async () => {
    await writeBookDir('uuid-1', makeMetadataJson('uuid-1'))
    await writeBookDir('uuid-2', makeMetadataJson('uuid-2'))
    await writeBookDir('uuid-broken', '{not json')
    const seen: number[] = []
    const books = await rebuildFromBookDirs(root, (p) => seen.push(p.completed))
    expect(books.map((b) => b.id).sort()).toEqual(['uuid-1', 'uuid-2'])
    expect(seen).toEqual([1, 2, 3])
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id).sort()).toEqual(['uuid-1', 'uuid-2'])
  })

  it('returns an empty catalog for a root with no books dir', async () => {
    const books = await rebuildFromBookDirs(root)
    expect(books).toEqual([])
    expect((await readCatalog(root))?.books).toEqual([])
  })

  it('rejects when books/ exists but is a file (ENOTDIR, not ENOENT)', async () => {
    await fs.writeFile(join(root, 'books'), 'not a directory', 'utf8')
    await expect(rebuildFromBookDirs(root)).rejects.toThrow()
  })

  it('dedupes two folders whose metadata.json share one id, keeping the later folder', async () => {
    await writeBookDir('uuid-aaa', makeMetadataJson('shared-id', 'First'))
    await writeBookDir('uuid-bbb', { ...makeMetadataJson('shared-id', 'Second') })
    const books = await rebuildFromBookDirs(root)
    expect(books.map((b) => b.id)).toEqual(['shared-id'])
    expect(books[0].title).toBe('Second')
    const cat = await readCatalog(root)
    expect(cat?.books.length).toBe(1)
  })
})

describe('reading state propagation', () => {
  it('survives a metadata.json round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musaeum-rs-'))
    const book = makeBook('rs-1')
    book.readingState = { position: 'epubcfi(/6/4!/2/10)', percent: 0.42, updatedAt: '2026-08-13T10:00:00Z' }

    await writeMetadataJson(dir, book)
    const json = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')) as MetadataJson
    const restored = await metadataJsonToBook(json, 'rs-1', dir)

    expect(restored.readingState).toEqual(book.readingState)
  })

  it('reads as null when metadata.json predates reading state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musaeum-rs-'))
    const restored = await metadataJsonToBook({ id: 'rs-2', title: 'Old Book' }, 'rs-2', dir)
    expect(restored.readingState).toBeNull()
  })

  it('rejects a malformed reading_state rather than trusting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musaeum-rs-'))
    const restored = await metadataJsonToBook(
      { id: 'rs-3', title: 'Broken', reading_state: { percent: 5, position: 12 } } as unknown as MetadataJson,
      'rs-3',
      dir
    )
    // percent clamps into range; a non-string position is discarded
    expect(restored.readingState).toEqual({ position: null, percent: 1, updatedAt: '' })
  })
})
