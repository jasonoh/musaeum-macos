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
  readCatalog,
  removeFromCatalog,
  replaceCatalog,
  upsertIntoCatalog,
  writeCatalog
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
