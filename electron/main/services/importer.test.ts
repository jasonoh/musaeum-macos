import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { writeMetadataJson } from './importer'

let bookDir: string
beforeEach(() => {
  bookDir = mkdtempSync(join(tmpdir(), 'musaeum-importer-'))
})
afterEach(() => {
  rmSync(bookDir, { recursive: true, force: true })
})

describe('writeMetadataJson', () => {
  it('leaves no .part file behind after writing', async () => {
    await writeMetadataJson(bookDir, makeBook('a'))
    const leftovers = (await fs.readdir(bookDir)).filter((f) => f.includes('.part'))
    expect(leftovers).toEqual([])
  })

  // Regression test for a real interleaving: reader:saveProgress is
  // unserialized and updates its "already wrote this book" bookkeeping only
  // after the await, so a session's first two page turns can both start a
  // writeMetadataJson call for the same book folder concurrently. Both must
  // complete without throwing, the file left behind must be valid JSON
  // matching one writer's payload (not a torn interleaving of both), and no
  // scratch file may remain. This is discriminating against a fixed scratch
  // name: with a shared `${target}.part`, one writer's rename can race the
  // other's write, and this test fails (either an ENOENT from the losing
  // rename or a torn/invalid metadata.json).
  it('completes both writers and leaves a valid, uncorrupted file when two concurrent writes target the same folder', async () => {
    const bookA = makeBook('a', 'Title From Writer A')
    const bookB = makeBook('a', 'Title From Writer B')

    await Promise.all([
      writeMetadataJson(bookDir, bookA),
      writeMetadataJson(bookDir, bookB)
    ])

    const raw = await fs.readFile(join(bookDir, 'metadata.json'), 'utf8')
    const parsed = JSON.parse(raw) as { title: string }
    expect(['Title From Writer A', 'Title From Writer B']).toContain(parsed.title)

    const leftovers = (await fs.readdir(bookDir)).filter((f) => f.includes('.part'))
    expect(leftovers).toEqual([])
  })
})
