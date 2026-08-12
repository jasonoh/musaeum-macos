import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { renameToTitle } from './book-files'

let dir: string

async function seed(...names: string[]): Promise<void> {
  for (const n of names) await fs.writeFile(join(dir, n), n)
}

const contents = (): Promise<string[]> => fs.readdir(dir).then((f) => f.sort())

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musaeum-files-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('renames every format file, leaving covers and metadata alone', async () => {
  await seed('Old Name.epub', 'Old Name.azw3', 'cover_full.jpg', 'metadata.json')

  expect(await renameToTitle(dir, 'Hatemonger')).toBe(2)
  expect(await contents()).toEqual([
    'Hatemonger.azw3',
    'Hatemonger.epub',
    'cover_full.jpg',
    'metadata.json'
  ])
})

it('sanitizes the title the same way the importer does', async () => {
  await seed('x.epub')

  await renameToTitle(dir, 'Bad/Name: "quoted"')
  expect(await contents()).toEqual(['BadName quoted.epub'])
})

it('is a no-op when the names already match', async () => {
  await seed('Hatemonger.epub')

  expect(await renameToTitle(dir, 'Hatemonger')).toBe(0)
  expect(await contents()).toEqual(['Hatemonger.epub'])
})

it('preserves file content across the rename', async () => {
  await seed('Old Name.pdf')

  await renameToTitle(dir, 'New Name')
  expect(await fs.readFile(join(dir, 'New Name.pdf'), 'utf8')).toBe('Old Name.pdf')
})

it('never renames one file onto another of the same format', async () => {
  await seed('Hatemonger.epub', 'Duplicate.epub')

  expect(await renameToTitle(dir, 'Hatemonger')).toBe(0)
  expect(await contents()).toEqual(['Duplicate.epub', 'Hatemonger.epub'])
})

it('returns 0 rather than throwing when the folder is gone', async () => {
  rmSync(dir, { recursive: true })

  await expect(renameToTitle(dir, 'Hatemonger')).resolves.toBe(0)
})
