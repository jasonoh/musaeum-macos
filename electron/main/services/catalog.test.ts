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
  rebuildFromBookDirs,
  removeFromCatalog,
  replaceCatalog,
  upsertIntoCatalog,
  writeCatalog,
  type MetadataJson
} from './catalog'

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
})
