import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LexiconFile } from '@shared/lexicon.types'
import {
  LEXICON_BAD_RESPELLING,
  LEXICON_GONE,
  LEXICON_NO_WORD,
  LEXICON_UNREADABLE,
  list,
  remove,
  resetForTests,
  save,
  spokenEntries
} from './lexicon'
import { lexiconPath, readLexiconFile } from './lexicon-file'
import * as nas from './nas-manager'

/**
 * The pronunciation list's service layer (voice reader D8; slice annex
 * `docs/superpowers/plans/2026-10-22-voice-reader-lexicon.md`).
 *
 * Two claims are this file's own: **the write discipline** (AC22 — a file it cannot read
 * is never rewritten, an offline write refuses, unknown keys and shapes survive) and
 * **a change is heard without a restart** (AC26 — a save is in the next
 * `spokenEntries()`, and a file written by the other Mac is re-read by its mtime).
 */

let root: string

const hegel = { word: 'Hegel', soundsLike: 'HAY-gul', addedAt: '2026-10-22T09:00:00.000Z' }

async function onDisk(): Promise<LexiconFile> {
  const read = await readLexiconFile(root)
  if (read.state !== 'ok') throw new Error(`lexicon.json is ${read.state}`)
  return read.file
}

async function writeOnDisk(value: unknown): Promise<void> {
  await fs.writeFile(lexiconPath(root), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'musaeum-lexicon-'))
  resetForTests()
  await nas.setLibraryRoot(root)
})

afterEach(() => {
  resetForTests()
  rmSync(root, { recursive: true, force: true })
})

describe('list (AC22 read posture)', () => {
  it('answers missing — not empty — for a library that has never had one', async () => {
    expect(await list()).toEqual({ state: 'missing', entries: [] })
  })

  it('answers the entries camelCase when the file is good', async () => {
    await writeOnDisk({ version: 1, entries: [hegel] })
    expect(await list()).toEqual({ state: 'ok', entries: [hegel] })
  })

  it('answers unreadable, and nothing, for a file it cannot parse — without throwing', async () => {
    await fs.writeFile(lexiconPath(root), 'not json{', 'utf8')
    expect(await list()).toEqual({ state: 'unreadable', entries: [] })
  })

  it('answers unreadable when the library root has gone, rather than empty', async () => {
    await nas.setLibraryRoot(join(root, 'does-not-exist'))
    expect(await list()).toEqual({ state: 'unreadable', entries: [] })
  })
})

describe('save and remove (AC22 write discipline)', () => {
  it('adds an entry, stamps addedAt, and answers the whole list', async () => {
    const entries = await save({ word: 'Hegel', soundsLike: 'HAY-gul' })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.word).toBe('Hegel')
    expect(entries[0]?.soundsLike).toBe('HAY-gul')
    expect(entries[0]?.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await onDisk()).toMatchObject({
      version: 1,
      entries: [{ word: 'Hegel', soundsLike: 'HAY-gul' }]
    })
    // The library root also holds the folders `setLibraryRoot` bootstraps; what this case
    // is about is that the write left one file and no scratch.
    const files = await fs.readdir(root)
    expect(files).toContain('lexicon.json')
    expect(files.filter((name) => name.includes('.part'))).toEqual([])
  })

  it('edits in place, keeping addedAt, and writes once', async () => {
    await writeOnDisk({ version: 1, entries: [hegel] })
    const entries = await save({ word: 'Hegel', soundsLike: 'HAY-gull' })
    expect(entries).toEqual([{ ...hegel, soundsLike: 'HAY-gull' }])
    expect((await onDisk()).entries).toEqual([{ ...hegel, soundsLike: 'HAY-gull' }])
  })

  it('stamps addedAt only when a hand-written entry is actually edited', async () => {
    await writeOnDisk({ version: 1, entries: [{ word: 'Hegel', soundsLike: 'HAY-gul' }] })
    // The same value written back is not an edit: no stamp is invented, nothing is written.
    const same = await save({ word: 'Hegel', soundsLike: 'HAY-gul' })
    expect(same[0]?.addedAt).toBe('')
    const edited = await save({ word: 'Hegel', soundsLike: 'hay-GUL' })
    expect(edited[0]?.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('writes nothing when a save saves the value already there', async () => {
    await save({ word: 'Hegel', soundsLike: 'HAY-gul' })
    const before = await fs.readFile(lexiconPath(root), 'utf8')
    const stat = await fs.stat(lexiconPath(root))
    await save({ word: 'Hegel', soundsLike: 'HAY-gul' })
    expect(await fs.readFile(lexiconPath(root), 'utf8')).toBe(before)
    expect((await fs.stat(lexiconPath(root))).mtimeMs).toBe(stat.mtimeMs)
  })

  it.each([
    ['an empty respelling', { word: 'Hegel', soundsLike: '  ' }, LEXICON_BAD_RESPELLING],
    ['a respelling with digits', { word: 'Hegel', soundsLike: 'HAY2-gul' }, LEXICON_BAD_RESPELLING],
    ['an empty word', { word: '   ', soundsLike: 'HAY-gul' }, LEXICON_NO_WORD]
  ])('refuses %s with its own sentence, writing nothing', async (_label, input, sentence) => {
    await expect(save(input)).rejects.toThrow(sentence)
    expect(await fs.readdir(root)).not.toContain('lexicon.json')
  })

  it('removes one entry and answers the rest', async () => {
    await writeOnDisk({
      version: 1,
      entries: [hegel, { word: 'Kojève', soundsLike: 'ko-ZHEV', addedAt: '' }]
    })
    expect((await remove('Hegel')).map((e) => e.word)).toEqual(['Kojève'])
    expect((await onDisk()).entries.map((e) => (e as { word: string }).word)).toEqual(['Kojève'])
  })

  it('refuses to remove a word that is not there, leaving the file untouched', async () => {
    await writeOnDisk({ version: 1, entries: [hegel] })
    const before = await fs.readFile(lexiconPath(root), 'utf8')
    await expect(remove('Kant')).rejects.toThrow(LEXICON_GONE)
    expect(await fs.readFile(lexiconPath(root), 'utf8')).toBe(before)
  })

  it('carries an entry shape it does not know through a write, untouched', async () => {
    const foreign = { word: 'Ghost', shape: 'ipa', ipa: 'ɡoʊst' }
    await writeOnDisk({ version: 1, entries: [foreign], note: 'kept' })
    await save({ word: 'Hegel', soundsLike: 'HAY-gul' })
    const disk = await onDisk()
    // `LexiconFile` types the members this build reads; an unknown top-level key is carried
    // without being typed, so the assertion reads it through a record.
    expect((disk as unknown as Record<string, unknown>).note).toBe('kept')
    expect(disk.entries[0]).toEqual(foreign)
    expect(disk.entries[1]).toMatchObject({ word: 'Hegel', soundsLike: 'HAY-gul' })
    // Carried, never spoken — the entry is not one this build may use.
    expect((await spokenEntries()).map((e) => e.word)).toEqual(['Hegel'])
  })

  it('never rewrites a file it cannot read, and refuses the mutation', async () => {
    await fs.writeFile(lexiconPath(root), 'not json{', 'utf8')
    await expect(save({ word: 'Hegel', soundsLike: 'HAY-gul' })).rejects.toThrow(LEXICON_UNREADABLE)
    expect(await fs.readFile(lexiconPath(root), 'utf8')).toBe('not json{')
  })

  it('refuses every mutation while the library is unreachable, writing nothing', async () => {
    await writeOnDisk({ version: 1, entries: [hegel] })
    const before = await fs.readFile(lexiconPath(root), 'utf8')
    await nas.setLibraryRoot(join(root, 'does-not-exist'))

    await expect(save({ word: 'Kant', soundsLike: 'kahnt' })).rejects.toThrow(/missing|offline/)
    await expect(remove('Hegel')).rejects.toThrow(/missing|offline/)
    expect(await fs.readFile(lexiconPath(root), 'utf8')).toBe(before)
  })
})

describe('spokenEntries (AC26, and D8 offline posture)', () => {
  it('speaks what a save just wrote, with no restart and no second read', async () => {
    // Before the save the library teaches nothing.
    expect(await spokenEntries()).toEqual([])
    await save({ word: 'Hegel', soundsLike: 'HAY-gul' })
    // The sidecar's own shape: snake_case, and nothing but the two fields it reads.
    expect(await spokenEntries()).toEqual([{ word: 'Hegel', sounds_like: 'HAY-gul' }])
  })

  it('re-reads a file another writer changed, by its mtime', async () => {
    await save({ word: 'Hegel', soundsLike: 'HAY-gul' })
    expect(await spokenEntries()).toHaveLength(1)

    // The other Mac's edit, out of band. The mtime is moved on purpose: a same-millisecond
    // rewrite is the one case a stat-keyed cache cannot see, and this case is about the
    // ordinary one.
    await writeOnDisk({
      version: 1,
      entries: [hegel, { word: 'Kojève', soundsLike: 'ko-ZHEV', addedAt: '' }]
    })
    await fs.utimes(lexiconPath(root), new Date(), new Date(Date.now() + 2_000))

    expect((await spokenEntries()).map((e) => e.word)).toEqual(['Hegel', 'Kojève'])
  })

  it('keeps the last good copy when the library goes away mid-session (D8)', async () => {
    await save({ word: 'Hegel', soundsLike: 'HAY-gul' })
    rmSync(root, { recursive: true, force: true })
    expect(await spokenEntries()).toEqual([{ word: 'Hegel', sounds_like: 'HAY-gul' }])
  })

  it('keeps the last good copy when the file becomes unreadable, rather than emptying speech', async () => {
    await save({ word: 'Hegel', soundsLike: 'HAY-gul' })
    await fs.writeFile(lexiconPath(root), 'not json{', 'utf8')
    await fs.utimes(lexiconPath(root), new Date(), new Date(Date.now() + 2_000))
    expect((await spokenEntries()).map((e) => e.word)).toEqual(['Hegel'])
    expect((await list()).state).toBe('unreadable')
  })

  it('answers nothing at all — never throws — with no library configured', async () => {
    vi.spyOn(nas, 'getLibraryRoot').mockReturnValue(null)
    await expect(spokenEntries()).resolves.toEqual([])
    await expect(list()).resolves.toEqual({ state: 'missing', entries: [] })
  })
})
