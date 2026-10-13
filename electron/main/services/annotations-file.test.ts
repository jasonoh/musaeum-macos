import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationsFile, StoredAnnotation } from '@shared/annotation.types'
import {
  ANNOTATIONS_FILENAME,
  annotationsPath,
  emptyAnnotationsFile,
  parseAnnotationsFile,
  readAnnotationsFile,
  writeAnnotationsFile
} from './annotations-file'

const highlight: StoredAnnotation = {
  id: 'h1',
  type: 'highlight',
  cfi: 'epubcfi(/6/14!/4/2/8,/1:0,/1:41)',
  quote: 'The protomolecule is loose.',
  prefix: 'and then',
  suffix: 'It was not',
  percent: 0.42,
  section_label: 'Chapter 7',
  color: 'gold',
  note: null,
  artifact: { kind: 'source', format: 'epub', stamp: null },
  created_at: '2026-10-13T11:02:41.000Z',
  updated_at: '2026-10-13T11:02:41.000Z'
}

const file = (over: Partial<AnnotationsFile> = {}): AnnotationsFile => ({
  version: 1,
  book_id: 'b1',
  annotations: [highlight],
  ...over
})

const text = (value: unknown): string => JSON.stringify(value)

describe('parseAnnotationsFile (spec D2)', () => {
  it('reads a version-1 file, keeping a type it does not know and unknown keys exactly as they were', () => {
    // A later build's bookmark must survive this build's write (spec D2: the shape should not
    // have to change to hold one) — the rule shelves.json set for an unknown shelf kind.
    const bookmark = { id: 'bm1', type: 'bookmark', cfi: 'epubcfi(/6/4!/2)', future: [1, 2] }
    const parsed = parseAnnotationsFile(
      text({ version: 1, book_id: 'b1', annotations: [highlight, bookmark], note: 'kept' })
    )
    expect(parsed).toEqual({
      version: 1,
      book_id: 'b1',
      annotations: [highlight, bookmark],
      note: 'kept'
    })
  })

  it('reads a file with no annotations yet', () => {
    expect(parseAnnotationsFile(text(emptyAnnotationsFile('b1')))).toEqual({
      version: 1,
      book_id: 'b1',
      annotations: []
    })
  })

  it.each([
    ['text that is not JSON', 'not json{'],
    ['an unknown version', text(file({ version: 2 as never }))],
    ['no version', text({ book_id: 'b1', annotations: [] })],
    ['no book_id', text({ version: 1, annotations: [] })],
    ['an empty book_id', text({ version: 1, book_id: '', annotations: [] })],
    ['annotations that are not a list', text({ version: 1, book_id: 'b1', annotations: {} })],
    ['a top-level array', '[]'],
    ['an entry with no id', text({ ...file(), annotations: [{ ...highlight, id: undefined }] })],
    ['an entry with no type', text({ ...file(), annotations: [{ ...highlight, type: 7 }] })],
    ['a highlight with no cfi', text({ ...file(), annotations: [{ ...highlight, cfi: '' }] })],
    ['a highlight with no quote', text({ ...file(), annotations: [{ ...highlight, quote: '' }] })],
    [
      'a highlight whose prefix is not a string',
      text({ ...file(), annotations: [{ ...highlight, prefix: 3 }] })
    ],
    [
      'a highlight with no percent',
      text({ ...file(), annotations: [{ ...highlight, percent: undefined }] })
    ],
    [
      'a percent above 1 — a corrupt record, not a value to clamp',
      text({ ...file(), annotations: [{ ...highlight, percent: 1.4 }] })
    ],
    ['a negative percent', text({ ...file(), annotations: [{ ...highlight, percent: -0.2 }] })],
    [
      'a section_label that is neither a string nor null',
      text({ ...file(), annotations: [{ ...highlight, section_label: 12 }] })
    ],
    ['a highlight with no color', text({ ...file(), annotations: [{ ...highlight, color: '' }] })],
    [
      'a note that is neither a string nor null',
      text({ ...file(), annotations: [{ ...highlight, note: {} }] })
    ],
    [
      'a highlight with no artifact',
      text({ ...file(), annotations: [{ ...highlight, artifact: undefined }] })
    ],
    [
      'an artifact of an unknown kind',
      text({
        ...file(),
        annotations: [{ ...highlight, artifact: { kind: 'cache', format: 'epub', stamp: null } }]
      })
    ],
    [
      'an artifact with no format',
      text({
        ...file(),
        annotations: [{ ...highlight, artifact: { kind: 'source', format: '', stamp: null } }]
      })
    ],
    [
      'an artifact whose stamp is neither a string nor null',
      text({
        ...file(),
        annotations: [{ ...highlight, artifact: { kind: 'derived', format: 'reflow', stamp: 4 } }]
      })
    ],
    [
      'an artifact whose format this build cannot open',
      text({
        ...file(),
        annotations: [{ ...highlight, artifact: { kind: 'source', format: 'txt', stamp: null } }]
      })
    ],
    [
      'a highlight with no timestamps',
      text({ ...file(), annotations: [{ ...highlight, created_at: undefined }] })
    ]
  ])('refuses %s — what it cannot understand, it must never rewrite', (_label, input) => {
    expect(parseAnnotationsFile(input)).toBeNull()
  })

  it('accepts a null section_label and a null note, which are the empty cases rather than bad ones', () => {
    const parsed = parseAnnotationsFile(
      text({ ...file(), annotations: [{ ...highlight, section_label: null, note: null }] })
    )
    expect(parsed?.annotations[0]).toMatchObject({ section_label: null, note: null })
  })
})

describe('readAnnotationsFile / writeAnnotationsFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musaeum-annotations-file-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers missing when the book folder holds no annotations.json', async () => {
    expect(await readAnnotationsFile(dir)).toEqual({ state: 'missing' })
  })

  it('answers invalid for a file it cannot use, and leaves its bytes alone', async () => {
    await fs.writeFile(annotationsPath(dir), 'not json{', 'utf8')
    expect(await readAnnotationsFile(dir)).toEqual({ state: 'invalid' })
    expect(await fs.readFile(annotationsPath(dir), 'utf8')).toBe('not json{')
  })

  it('rethrows an I/O failure that is not a missing file, so a share blip never reads as "no annotations"', async () => {
    await fs.mkdir(annotationsPath(dir)) // a directory where the file should be: EISDIR, not ENOENT
    await expect(readAnnotationsFile(dir)).rejects.toThrow()
  })

  it('rethrows ENOENT when the book folder itself is gone, rather than reading it as "no annotations"', async () => {
    await expect(readAnnotationsFile(join(dir, 'gone'))).rejects.toThrow()
  })

  it('round-trips through an atomic write and leaves no .part behind', async () => {
    await writeAnnotationsFile(dir, file())
    expect(await readAnnotationsFile(dir)).toEqual({ state: 'ok', file: file() })
    expect(await fs.readdir(dir)).toEqual([ANNOTATIONS_FILENAME])
  })

  it('cleans up its scratch file and rethrows when the rename fails', async () => {
    await writeAnnotationsFile(dir, file())
    const before = await fs.readFile(annotationsPath(dir), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('share dropped'))

    await expect(writeAnnotationsFile(dir, file({ annotations: [] }))).rejects.toThrow(
      'share dropped'
    )

    expect(await fs.readdir(dir)).toEqual([ANNOTATIONS_FILENAME])
    expect(await fs.readFile(annotationsPath(dir), 'utf8')).toBe(before)
    vi.restoreAllMocks()
  })

  it('writes its scratch file under the file’s own name, so a sweep can recognize it', async () => {
    const spy = vi.spyOn(fs, 'writeFile')
    await writeAnnotationsFile(dir, file())
    const names = spy.mock.calls.map(([path]) => basename(String(path)))
    spy.mockRestore()

    // The scratch name carries a UUID rather than a pid: several Macs share this folder and a
    // pid is unique only within one machine (the reasoning in `shelves-file.ts`).
    expect(names).toEqual([
      expect.stringMatching(new RegExp(`^${ANNOTATIONS_FILENAME}\\.[0-9a-f-]{36}\\.part$`))
    ])
  })
})
