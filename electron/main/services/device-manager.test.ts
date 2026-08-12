import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeFilesWithStem, scanDocuments } from './device-manager'

let mount: string
let documents: string

/** Write a file under documents/, creating any parent dirs. */
async function put(relPath: string, contents = 'x'): Promise<string> {
  const full = join(documents, relPath)
  await fs.mkdir(join(full, '..'), { recursive: true })
  await fs.writeFile(full, contents)
  return full
}

async function exists(relPath: string): Promise<boolean> {
  return fs
    .stat(join(documents, relPath))
    .then(() => true)
    .catch(() => false)
}

beforeEach(async () => {
  mount = mkdtempSync(join(tmpdir(), 'musaeum-device-'))
  documents = join(mount, 'documents')
  await fs.mkdir(documents, { recursive: true })
})

afterEach(() => {
  rmSync(mount, { recursive: true, force: true })
})

describe('scanDocuments', () => {
  it('maps lowercased stems to every path carrying them', async () => {
    await put('Leviathan Wakes.azw3')
    await put('collection/Leviathan Wakes.mobi')
    await put('Caliban’s War.epub')

    const stems = await scanDocuments(mount)

    expect([...stems.keys()].sort()).toEqual(['caliban’s war', 'leviathan wakes'])
    expect(stems.get('leviathan wakes')).toHaveLength(2)
  })

  it('ignores .sdr sidecars, whose contents are named after the book', async () => {
    await put('Leviathan Wakes.sdr/Leviathan Wakes.apnx')

    expect(await scanDocuments(mount)).toEqual(new Map())
  })

  it('ignores dotfiles, including AppleDouble siblings', async () => {
    await put('Leviathan Wakes.azw3')
    await put('._Leviathan Wakes.azw3')

    expect(await scanDocuments(mount)).toEqual(
      new Map([['leviathan wakes', [join(documents, 'Leviathan Wakes.azw3')]]])
    )
  })

  it('stops at depth 2 and survives a missing documents/ folder', async () => {
    await put('a/b/Too Deep.epub')
    expect(await scanDocuments(mount)).toEqual(new Map())

    rmSync(documents, { recursive: true })
    expect(await scanDocuments(mount)).toEqual(new Map())
  })
})

describe('removeFilesWithStem', () => {
  it('takes the file, its AppleDouble sibling, and its .sdr folder', async () => {
    await put('Leviathan Wakes.azw3')
    await put('._Leviathan Wakes.azw3')
    await put('Leviathan Wakes.sdr/Leviathan Wakes.apnx')
    await put('Caliban’s War.epub')

    expect(await removeFilesWithStem(mount, 'leviathan wakes')).toBe(1)

    expect(await exists('Leviathan Wakes.azw3')).toBe(false)
    expect(await exists('._Leviathan Wakes.azw3')).toBe(false)
    expect(await exists('Leviathan Wakes.sdr')).toBe(false)
    // Untouched neighbour
    expect(await exists('Caliban’s War.epub')).toBe(true)
  })

  it('removes every copy of a book, including one in a subfolder', async () => {
    await put('Leviathan Wakes.azw3')
    await put('collection/Leviathan Wakes.mobi')

    expect(await removeFilesWithStem(mount, 'leviathan wakes')).toBe(2)
    expect(await scanDocuments(mount)).toEqual(new Map())
    // The folder itself is not the book's to delete
    expect(await exists('collection')).toBe(true)
  })

  it('removes nothing when no file matches', async () => {
    await put('Caliban’s War.epub')

    expect(await removeFilesWithStem(mount, 'leviathan wakes')).toBe(0)
    expect(await exists('Caliban’s War.epub')).toBe(true)
  })
})
