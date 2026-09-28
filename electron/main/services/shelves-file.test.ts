import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForeignShelfEntry, ManualShelfEntry, ShelvesFile } from '@shared/shelf.types'
import {
  emptyShelvesFile,
  parseShelvesFile,
  readShelvesFile,
  shelvesPath,
  writeShelvesFile
} from './shelves-file'

const manual: ManualShelfEntry = {
  id: 's1',
  name: 'To Read',
  kind: 'manual',
  created_at: '2026-09-27T10:00:00.000Z',
  updated_at: '2026-09-27T10:05:00.000Z',
  books: [{ id: 'b1', added_at: '2026-09-27T10:05:00.000Z' }]
}
const smart: ForeignShelfEntry = {
  id: 's2',
  kind: 'smart',
  name: 'Unread SF',
  rule: { tags: ['sf'], readStatus: 'unread' },
  extra: 1
}
const text = (value: unknown): string => JSON.stringify(value)

describe('parseShelvesFile (bookshelves D1)', () => {
  it('reads a version-1 file, keeping unknown kinds and unknown keys exactly as they were', () => {
    const file = parseShelvesFile(text({ version: 1, shelves: [manual, smart], note: 'kept' }))
    expect(file).toEqual({ version: 1, shelves: [manual, smart], note: 'kept' })
  })

  it('reads an empty file of shelves', () => {
    expect(parseShelvesFile(text(emptyShelvesFile()))).toEqual({ version: 1, shelves: [] })
  })

  it.each([
    ['text that is not JSON', 'not json{'],
    ['an unknown version', text({ version: 2, shelves: [] })],
    ['no version', text({ shelves: [] })],
    ['shelves that are not a list', text({ version: 1, shelves: {} })],
    ['a top-level array', '[]'],
    ['a shelf with no id', text({ version: 1, shelves: [{ ...manual, id: undefined }] })],
    ['a shelf with an empty id', text({ version: 1, shelves: [{ ...manual, id: '' }] })],
    ['a shelf with no kind', text({ version: 1, shelves: [{ ...manual, kind: undefined }] })],
    ['a manual shelf with no name', text({ version: 1, shelves: [{ ...manual, name: 7 }] })],
    [
      'a manual shelf with no timestamps',
      text({ version: 1, shelves: [{ ...manual, created_at: undefined }] })
    ],
    [
      'a manual shelf whose books are not a list',
      text({ version: 1, shelves: [{ ...manual, books: {} }] })
    ],
    [
      'a member with no added_at',
      text({ version: 1, shelves: [{ ...manual, books: [{ id: 'b1' }] }] })
    ],
    [
      'a member with no id',
      text({ version: 1, shelves: [{ ...manual, books: [{ added_at: 'x' }] }] })
    ]
  ])('refuses %s — what it cannot understand, it must never rewrite', (_label, input) => {
    expect(parseShelvesFile(input)).toBeNull()
  })
})

describe('readShelvesFile / writeShelvesFile', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musaeum-shelves-file-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('answers missing when the library has no shelves.json', async () => {
    expect(await readShelvesFile(root)).toEqual({ state: 'missing' })
  })

  it('answers invalid for a file it cannot use, and leaves its bytes alone', async () => {
    await fs.writeFile(shelvesPath(root), 'not json{', 'utf8')
    expect(await readShelvesFile(root)).toEqual({ state: 'invalid' })
    expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe('not json{')
  })

  it('rethrows an I/O failure that is not a missing file, so a share blip never reads as "no shelves"', async () => {
    await fs.mkdir(shelvesPath(root)) // a directory where the file should be: EISDIR, not ENOENT
    await expect(readShelvesFile(root)).rejects.toThrow()
  })

  it('rethrows ENOENT when the library root itself is gone, rather than reading it as "no shelves" (F3)', async () => {
    await expect(readShelvesFile(join(root, 'gone'))).rejects.toThrow()
  })

  it('round-trips through an atomic write and leaves no .part behind', async () => {
    const file: ShelvesFile = { version: 1, shelves: [manual, smart] }
    await writeShelvesFile(root, file)
    expect(await readShelvesFile(root)).toEqual({ state: 'ok', file })
    expect(await fs.readdir(root)).toEqual(['shelves.json'])
  })

  it('cleans up its scratch file and rethrows when the rename fails (F2)', async () => {
    const file: ShelvesFile = { version: 1, shelves: [manual] }
    await writeShelvesFile(root, file) // an existing shelves.json, so we can tell it was untouched
    const before = await fs.readFile(shelvesPath(root), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('share dropped'))

    await expect(writeShelvesFile(root, { version: 1, shelves: [] })).rejects.toThrow(
      'share dropped'
    )

    expect(await fs.readdir(root)).toEqual(['shelves.json'])
    expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe(before)
    vi.restoreAllMocks()
  })
})
