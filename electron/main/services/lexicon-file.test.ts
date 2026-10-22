import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LexiconEntry, LexiconFile } from '@shared/lexicon.types'
import {
  emptyLexiconFile,
  lexiconPath,
  parseLexiconFile,
  readLexiconFile,
  writeLexiconFile
} from './lexicon-file'

/**
 * `lexicon.json`'s file layer (voice reader D8, slice annex R7 and AC22). The rule under
 * every case here is the one `shelves-file.test.ts` states for its own file: what this
 * build cannot understand, it must never rewrite.
 */

const hegel: LexiconEntry = {
  word: 'Hegel',
  soundsLike: 'HAY-gul',
  addedAt: '2026-10-22T09:00:00.000Z'
}
const kojeve: LexiconEntry = {
  word: 'Kojève',
  soundsLike: 'ko-ZHEV',
  addedAt: '2026-10-22T09:01:00.000Z'
}
const file = (over: Partial<LexiconFile> = {}): LexiconFile => ({
  version: 1,
  entries: [hegel, kojeve],
  ...over
})
const text = (value: unknown): string => JSON.stringify(value)

describe('parseLexiconFile (D8, annex R7)', () => {
  it('reads a version-1 file, keeping unknown keys and an entry shape it does not know', () => {
    // A later build's entry, and one a person hand-wrote, must survive this build's write.
    const foreign = { word: 'Ghost', shape: 'ipa', ipa: 'ɡoʊst' }
    expect(parseLexiconFile(text({ version: 1, entries: [hegel, foreign], note: 'kept' }))).toEqual(
      { version: 1, entries: [hegel, foreign], note: 'kept' }
    )
  })

  it('reads an entry with no addedAt as a hand-written one, rather than refusing the file', () => {
    const parsed = parseLexiconFile(
      text({ version: 1, entries: [{ word: 'Hegel', soundsLike: 'HAY-gul' }] })
    )
    expect(parsed).toEqual({
      version: 1,
      entries: [{ word: 'Hegel', soundsLike: 'HAY-gul', addedAt: '' }]
    })
  })

  it('reads a file with no entries yet', () => {
    expect(parseLexiconFile(text(emptyLexiconFile()))).toEqual({ version: 1, entries: [] })
  })

  it.each([
    ['text that is not JSON', 'not json{'],
    ['an unknown version', text({ version: 2, entries: [] })],
    ['no version', text({ entries: [] })],
    ['entries that are not a list', text({ version: 1, entries: {} })],
    ['a top-level array', '[]'],
    ['a top-level string', '"lexicon"']
  ])('refuses %s — what it cannot understand, it must never rewrite', (_label, input) => {
    expect(parseLexiconFile(input)).toBeNull()
  })

  it('keeps an entry it cannot use verbatim rather than dropping it on the next write', () => {
    // The failure this case exists for: a member with a misspelled field would be
    // *silently deleted* by the first save if the parser skipped it.
    const broken = { word: 'Hegel', sounds_like: 'HAY-gul' }
    const parsed = parseLexiconFile(text({ version: 1, entries: [hegel, broken] }))
    expect(parsed?.entries).toEqual([hegel, broken])
  })
})

describe('readLexiconFile / writeLexiconFile (AC22)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musaeum-lexicon-file-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('answers missing when the library has no lexicon.json', async () => {
    expect(await readLexiconFile(root)).toEqual({ state: 'missing' })
  })

  it('answers invalid for a file it cannot use, and leaves its bytes alone', async () => {
    await fs.writeFile(lexiconPath(root), 'not json{', 'utf8')
    expect(await readLexiconFile(root)).toEqual({ state: 'invalid' })
    expect(await fs.readFile(lexiconPath(root), 'utf8')).toBe('not json{')
  })

  it('rethrows an I/O failure that is not a missing file, so a share blip never reads as "none"', async () => {
    await fs.mkdir(lexiconPath(root)) // a directory where the file should be: EISDIR, not ENOENT
    await expect(readLexiconFile(root)).rejects.toThrow()
  })

  it('rethrows ENOENT when the library root itself is gone, rather than reading it as "none"', async () => {
    await expect(readLexiconFile(join(root, 'gone'))).rejects.toThrow()
  })

  it('round-trips through an atomic write and leaves no .part behind', async () => {
    const value = file()
    await writeLexiconFile(root, value)
    expect(await readLexiconFile(root)).toEqual({ state: 'ok', file: value })
    expect(await fs.readdir(root)).toEqual(['lexicon.json'])
  })

  it('names its scratch file with a random id, so two Macs cannot reuse one', async () => {
    const seen: string[] = []
    const write = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementation((async (path: unknown, ...rest: unknown[]) => {
      seen.push(String(path))
      return (write as unknown as (...args: unknown[]) => Promise<void>)(path, ...rest)
    }) as never)

    await writeLexiconFile(root, file())
    expect(seen).toHaveLength(1)
    // `lexicon.json.<uuid>.part` — not a pid, which is unique only within one machine.
    expect(seen[0]).toMatch(/lexicon\.json\.[0-9a-f-]{36}\.part$/)
  })

  it('cleans up its scratch file and rethrows when the rename fails', async () => {
    await writeLexiconFile(root, file())
    const before = await fs.readFile(lexiconPath(root), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('share dropped'))

    await expect(writeLexiconFile(root, emptyLexiconFile())).rejects.toThrow('share dropped')

    expect(await fs.readdir(root)).toEqual(['lexicon.json'])
    expect(await fs.readFile(lexiconPath(root), 'utf8')).toBe(before)
  })
})
