import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AnnotationsFile,
  NewAnnotationInput,
  StoredAnnotation
} from '@shared/annotation.types'
import { makeBook } from '../../../test/helpers/book'
import * as annotations from './annotations'
import {
  ANNOTATION_GONE,
  ANNOTATIONS_UNREADABLE,
  ANNOTATION_NO_BOOK,
  create,
  isStale,
  list,
  remove,
  resetAnnotationLogForTests,
  stampToken,
  update
} from './annotations'
import { readAnnotationsFile } from './annotations-file'
import { closeDb, insertBook } from './db'
import * as nas from './nas-manager'

let root: string

const bookDir = (id: string): string => join(root, 'books', id)
const filePath = (id: string): string => join(bookDir(id), 'annotations.json')
const stampPath = (id: string): string => join(bookDir(id), 'derived', 'reflow.json')

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  root = mkdtempSync(join(tmpdir(), 'musaeum-annotations-'))
  await nas.setLibraryRoot(root)
  insertBook(makeBook('a'))
  insertBook(makeBook('b'))
  await fs.mkdir(bookDir('a'), { recursive: true })
  // The one-log rule is module-level and per-session by design, so it would carry over between
  // cases in this file (as `shelves.test.ts:23` resets its own for the same reason).
  resetAnnotationLogForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** annotations.json as it is on the share now. */
async function onDisk(id: string): Promise<AnnotationsFile> {
  const read = await readAnnotationsFile(bookDir(id))
  if (read.state !== 'ok') throw new Error(`annotations.json is ${read.state}`)
  return read.file
}

function scratchName(path: unknown): string {
  return basename(String(path))
}

/** Counts writes of annotations.json from here on — every write goes through its scratch file. */
function countWrites(): () => number {
  const spy = vi.spyOn(fs, 'writeFile')
  return () =>
    spy.mock.calls.filter(
      ([path]) =>
        scratchName(path).startsWith('annotations.json.') && scratchName(path).endsWith('.part')
    ).length
}

const input = (over: Partial<NewAnnotationInput> = {}): NewAnnotationInput => ({
  bookId: 'a',
  format: 'epub',
  cfi: 'epubcfi(/6/14!/4/2/8,/1:0,/1:41)',
  quote: 'The protomolecule is loose.',
  prefix: 'and then',
  suffix: 'It was not',
  percent: 0.42,
  sectionLabel: 'Chapter 7',
  ...over
})

const TRIPLE = { sidecar: 4, helper: 1, generator: 'macos-27' }

/** The stamp's `source` half — the size and mtime the pass recorded. Part of the artifact's
 *  identity rather than decoration: a PDF replaced in place re-runs the pass over an unchanged
 *  converter (`sidecar/reflow/produce.py:137-141`), which is what the slice's review caught. */
const SOURCE = { size: 1234, mtime: 1700000000 }

/** A `derived/reflow.json` the app can read, with whatever converter and source a case wants. */
async function writeStamp(
  converter: Record<string, unknown> = TRIPLE,
  source: Record<string, unknown> = SOURCE,
  id = 'a'
): Promise<void> {
  await fs.mkdir(join(bookDir(id), 'derived'), { recursive: true })
  await fs.writeFile(stampPath(id), JSON.stringify({ version: 1, converter, source }), 'utf8')
}

describe('the round trip (AC1)', () => {
  it('writes a highlight, and the file on disk says what the answer said', async () => {
    const result = await create(input())
    const created = result.created

    expect(result.annotations).toEqual([created])
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created).toMatchObject({
      type: 'highlight',
      cfi: 'epubcfi(/6/14!/4/2/8,/1:0,/1:41)',
      quote: 'The protomolecule is loose.',
      prefix: 'and then',
      suffix: 'It was not',
      percent: 0.42,
      sectionLabel: 'Chapter 7',
      color: 'gold',
      note: null,
      stale: false
    })
    expect(created.createdAt).toBe(created.updatedAt)

    // Read back off disk, independently of the writer (the criterion's instrument)
    const file = JSON.parse(await fs.readFile(filePath('a'), 'utf8')) as AnnotationsFile
    expect(file.version).toBe(1)
    expect(file.book_id).toBe('a')
    expect(file.annotations).toHaveLength(1)
    expect(file.annotations[0]).toMatchObject({
      id: created.id,
      type: 'highlight',
      section_label: 'Chapter 7',
      note: null,
      created_at: created.createdAt
    })

    expect(await list('a', 'epub')).toEqual({ state: 'ok', annotations: result.annotations })
  })

  it('mints the id, the type, both timestamps and the artifact, and takes none of them from the caller', async () => {
    // The input type has no such members, so this is a type-level rule with a runtime face:
    // a caller that passes them anyway cannot change what is stored (annex R5).
    const withExtras = {
      ...input(),
      id: 'caller',
      type: 'bookmark',
      created_at: '1999-01-01T00:00:00.000Z'
    } as unknown as NewAnnotationInput
    const created = (await create(withExtras)).created

    expect(created.id).not.toBe('caller')
    expect(created.type).toBe('highlight')
    expect(created.createdAt).not.toBe('1999-01-01T00:00:00.000Z')

    // The bridge carries the shape the panel reads and nothing else. In particular `artifact`
    // is absent (annex R5), so no renderer can read or name a `derived/` fact — and a
    // `toMatchObject` cannot fail on an extra member, which is why this names every key.
    expect(Object.keys(created).sort()).toEqual([
      'cfi',
      'color',
      'createdAt',
      'id',
      'note',
      'percent',
      'prefix',
      'quote',
      'sectionLabel',
      'stale',
      'suffix',
      'type',
      'updatedAt'
    ])
    expect((await onDisk('a')).annotations[0]).toMatchObject({
      type: 'highlight',
      artifact: { kind: 'source', format: 'epub', stamp: null }
    })
  })
})

describe('the read state (AC5, AC11, R3)', () => {
  it('answers missing for a book nobody has annotated, and creates no file', async () => {
    expect(await list('a', 'epub')).toEqual({ state: 'missing', annotations: [] })
    expect(await fs.readdir(bookDir('a'))).toEqual([])
  })

  it('answers unreadable — not an empty list — for a file it cannot parse, and leaves its bytes alone', async () => {
    await fs.writeFile(filePath('a'), 'not json{', 'utf8')

    expect(await list('a', 'epub')).toEqual({ state: 'unreadable', annotations: [] })
    expect(await fs.readFile(filePath('a'), 'utf8')).toBe('not json{')
  })

  it('answers missing, then unreadable, when the book folder goes away (invariant 12)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await list('a', 'epub')).toEqual({ state: 'missing', annotations: [] })

    rmSync(bookDir('a'), { recursive: true, force: true })
    expect(await list('a', 'epub')).toEqual({ state: 'unreadable', annotations: [] })
    expect(warn).toHaveBeenCalled()
  })

  it('answers unreadable for a book the library does not hold', async () => {
    expect(await list('nope', 'epub')).toEqual({ state: 'unreadable', annotations: [] })
  })

  it('reports an unreadable file once, not once per call, until a read succeeds (the precedent’s rule)', async () => {
    // `shelves.ts` keeps this rule for the same file class, and the reason is the panel's
    // shape: it reads on open and after every mutation, so an unreadable file would otherwise
    // print the same bytes on every refresh.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await fs.mkdir(filePath('a')) // a directory where the file should be: EISDIR, not a state
    await expect(update('a', 'anything', 'a note', 'epub')).rejects.toThrow(ANNOTATIONS_UNREADABLE)
    expect(await list('a', 'epub')).toEqual({ state: 'unreadable', annotations: [] })
    await expect(remove('a', 'anything', 'epub')).rejects.toThrow(ANNOTATIONS_UNREADABLE)
    expect(warn).toHaveBeenCalledTimes(1)

    // A read that got far enough to answer — here the file is simply gone — is news again when
    // the file stops being readable a second time.
    rmSync(filePath('a'), { recursive: true, force: true })
    expect(await list('a', 'epub')).toEqual({ state: 'missing', annotations: [] })
    await fs.mkdir(filePath('a'))
    expect(await list('a', 'epub')).toEqual({ state: 'unreadable', annotations: [] })
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('a file that cannot be read is never overwritten (AC4)', () => {
  it.each([
    ['invalid JSON', 'not json{'],
    ['an unknown version', JSON.stringify({ version: 2, book_id: 'a', annotations: [] })]
  ])('refuses a write over %s, and leaves the bytes identical', async (_label, text) => {
    await fs.writeFile(filePath('a'), text, 'utf8')

    await expect(create(input())).rejects.toThrow(ANNOTATIONS_UNREADABLE)
    expect(await fs.readFile(filePath('a'), 'utf8')).toBe(text)
  })

  it('refuses a write when the read fails for a reason that is not a missing file', async () => {
    await fs.mkdir(filePath('a')) // a directory where the file should be: EISDIR
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(create(input())).rejects.toThrow(ANNOTATIONS_UNREADABLE)
    expect(warn).toHaveBeenCalled()
  })

  it('starts from nothing when the file is simply absent, and creates it', async () => {
    await create(input())
    expect((await onDisk('a')).annotations).toHaveLength(1)
  })
})

describe('the write re-reads the file (AC6, R1)', () => {
  it('applies the change to what is on disk, not to what this process last saw', async () => {
    const first = await create(input({ cfi: 'cfi-1', quote: 'one' }))
    expect(first.annotations).toHaveLength(1)

    // The other Mac annotates the same book between this process's two calls.
    const other: StoredAnnotation = {
      id: 'other-mac',
      type: 'highlight',
      cfi: 'cfi-2',
      quote: 'two',
      prefix: '',
      suffix: '',
      percent: 0.6,
      section_label: null,
      color: 'gold',
      note: 'from the other machine',
      artifact: { kind: 'source', format: 'epub', stamp: null },
      created_at: '2026-10-13T09:00:00.000Z',
      updated_at: '2026-10-13T09:00:00.000Z'
    }
    const disk = await onDisk('a')
    disk.annotations.push(other)
    await fs.writeFile(filePath('a'), `${JSON.stringify(disk, null, 2)}\n`, 'utf8')

    const after = await create(input({ cfi: 'cfi-3', quote: 'three' }))

    expect(after.annotations.map((a) => a.quote)).toEqual(['one', 'two', 'three'])
    // …and the answer is what the file holds, not a local append
    expect((await list('a', 'epub')).annotations).toEqual(after.annotations)
    expect((await onDisk('a')).annotations).toHaveLength(3)
    expect(after.created.quote).toBe('three')
    expect(after.annotations.find((a) => a.id === 'other-mac')?.note).toBe('from the other machine')
  })

  it('serializes mutations started together, each over a fresh read, so all of them land (R7)', async () => {
    const writes = countWrites()
    await Promise.all([
      create(input({ cfi: 'cfi-1' })),
      create(input({ cfi: 'cfi-2' })),
      create(input({ cfi: 'cfi-3' }))
    ])

    expect(writes()).toBe(3)
    expect((await onDisk('a')).annotations).toHaveLength(3)
    expect((await list('a', 'epub')).annotations).toHaveLength(3)
  })

  it('closes one mutation before the next begins, whatever book it touches (R7)', async () => {
    // The reading's alternative — a queue keyed by `bookId` — reaches the same file contents
    // in every case above, so end state alone cannot tell the two designs apart. What differs
    // is the overlap, and that is what this watches: each book's write and its rename are
    // contiguous in the timeline rather than interleaved with the other book's.
    await fs.mkdir(bookDir('b'), { recursive: true })
    const write = vi.spyOn(fs, 'writeFile')
    const rename = vi.spyOn(fs, 'rename')

    await Promise.all([
      create(input({ cfi: 'cfi-a1' })),
      create(input({ bookId: 'b', cfi: 'cfi-b1' }))
    ])

    type Spy = { mock: { calls: unknown[][]; invocationCallOrder: number[] } }
    const order = (spy: Spy, id: string): number[] =>
      spy.mock.invocationCallOrder.filter((_, i) =>
        String(spy.mock.calls[i]![0]).includes(join('books', id, ''))
      )

    const a = [...order(write, 'a'), ...order(rename, 'a')].sort((x, y) => x - y)
    const b = [...order(write, 'b'), ...order(rename, 'b')].sort((x, y) => x - y)
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
    expect(Math.max(...a)).toBeLessThan(Math.min(...b))
  })
})

describe('notes (R4)', () => {
  it('stores a note verbatim apart from its ends, newlines and spacing included', async () => {
    const { created } = await create(input())
    const note = '  first line\n\nsecond   line with   spaces\n\tthird  '

    const stored = (await update('a', created.id, note, 'epub')).find((a) => a.id === created.id)

    expect(stored?.note).toBe('first line\n\nsecond   line with   spaces\n\tthird')
    expect((await onDisk('a')).annotations[0]).toMatchObject({
      note: 'first line\n\nsecond   line with   spaces\n\tthird'
    })
  })

  it('keeps the highlight and drops the note when the note is blank, which is not an error', async () => {
    const { created } = await create(input())
    await update('a', created.id, 'something', 'epub')

    for (const blank of ['', '   ', '\n\t ']) {
      const stored = (await update('a', created.id, blank, 'epub')).find((a) => a.id === created.id)
      expect(stored?.note).toBeNull()
    }
    expect((await onDisk('a')).annotations).toHaveLength(1)
  })

  it('writes nothing when the note is already the one being saved, and moves updated_at only for a real change', async () => {
    const { created } = await create(input())
    const writes = countWrites()

    const same = await update('a', created.id, null, 'epub')
    expect(writes()).toBe(0)
    expect(same.find((a) => a.id === created.id)?.updatedAt).toBe(created.updatedAt)

    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-10-14T00:00:00.000Z')
    const changed = await update('a', created.id, 'a note', 'epub')
    const written = writes()
    vi.restoreAllMocks()

    expect(written).toBe(1)
    expect(changed.find((a) => a.id === created.id)?.updatedAt).toBe('2026-10-14T00:00:00.000Z')
  })

  it('refuses a note for a highlight that is gone, rather than appearing to have written it', async () => {
    await expect(update('a', 'no-such-id', 'hi', 'epub')).rejects.toThrow(ANNOTATION_GONE)
    await expect(remove('a', 'no-such-id', 'epub')).rejects.toThrow(ANNOTATION_GONE)
  })
})

describe('removing (spec D8)', () => {
  it('deletes one highlight and answers with the rest', async () => {
    await create(input({ cfi: 'cfi-1' }))
    const { created: second } = await create(input({ cfi: 'cfi-2' }))

    const left = await remove('a', second.id, 'epub')

    expect(left).toHaveLength(1)
    expect(left[0]!.cfi).toBe('cfi-1')
    expect((await onDisk('a')).annotations).toHaveLength(1)
  })
})

describe('the artifact a cfi points into (AC7, R2, R6)', () => {
  it('records the stamp’s identity for a derived annotation, and the format for a source one', async () => {
    await writeStamp()

    const derived = (await create(input({ format: 'reflow' }))).created
    expect(derived.stale).toBe(false)
    expect((await onDisk('a')).annotations[0]).toMatchObject({
      artifact: {
        kind: 'derived',
        format: 'reflow',
        stamp: stampToken({ version: 1, converter: TRIPLE, source: SOURCE })
      }
    })

    await fs.mkdir(bookDir('b'), { recursive: true })
    const source = (await create(input({ bookId: 'b', format: 'epub' }))).created
    expect(source.stale).toBe(false)
    expect((await onDisk('b')).annotations[0]).toMatchObject({
      artifact: { kind: 'source', format: 'epub', stamp: null }
    })
  })

  it('marks it stale when the stamp moves, whichever member moved', async () => {
    await writeStamp()
    await create(input({ format: 'reflow' }))

    const moved: Array<{ converter?: Record<string, unknown>; source?: Record<string, unknown> }> =
      [
        { converter: { sidecar: 5, helper: 1, generator: 'macos-27' } },
        { converter: { sidecar: 4, helper: 2, generator: 'macos-27' } },
        { converter: { sidecar: 4, helper: 1, generator: 'macos-28' } },
        // …and the source, which the pass's own cache condition compares exactly as it compares
        // the converter: a PDF replaced in place re-runs the pass (the slice review's finding,
        // and the reason this identity is a digest of the whole stamp, not of the converter).
        { source: { size: 9999, mtime: 1700000000 } },
        { source: { size: 1234, mtime: 1700000001 } }
      ]

    for (const one of moved) {
      await writeStamp(one.converter ?? TRIPLE, one.source ?? SOURCE)
      const marked = (await list('a', 'reflow')).annotations
      expect(marked[0]!.stale, JSON.stringify(one)).toBe(true)
    }

    // …and a re-run that writes the stamp it was made against is not a different artifact (the
    // reproducibility bar: two passes over an unchanged source write byte-identical output)
    await writeStamp()
    expect((await list('a', 'reflow')).annotations[0]!.stale).toBe(false)
  })

  it('marks every derived annotation stale when the stamp cannot be read at all (R6)', async () => {
    await writeStamp()
    await create(input({ format: 'reflow' }))

    rmSync(stampPath('a'), { force: true })
    expect((await list('a', 'reflow')).annotations[0]!.stale).toBe(true)

    await writeStamp()
    await fs.writeFile(stampPath('a'), 'not json{', 'utf8')
    expect((await list('a', 'reflow')).annotations[0]!.stale).toBe(true)

    // …and a stamp the pass's own condition could not use is not a match either: a converter
    // that is not a record, a source missing a term, and a stamp missing either. Each is an
    // identity this build cannot establish, so each reads as a mismatch rather than a match
    // (which is the safe direction — an unknown artifact is never drawn into).
    for (const unusable of [
      { version: 1, converter: [4, 1], source: SOURCE },
      { version: 1, converter: TRIPLE, source: { size: 1234 } },
      { version: 1, converter: TRIPLE },
      { converter: TRIPLE, source: SOURCE }
    ]) {
      await fs.writeFile(stampPath('a'), JSON.stringify(unusable), 'utf8')
      expect((await list('a', 'reflow')).annotations[0]!.stale, JSON.stringify(unusable)).toBe(true)
    }

    // …and such a stamp is not an identity this build will *mint* either: an annotation made
    // while the stamp is unusable records no stamp at all, so it is stale from the moment it
    // exists rather than trusted as a digest of something the pass could not have written.
    // This stamp is unusable in exactly one way — it has no version — so the version rule is
    // what has to catch it (the source rule catches the other shapes, above).
    await fs.writeFile(stampPath('a'), JSON.stringify({ converter: TRIPLE, source: SOURCE }), 'utf8')
    expect((await create(input({ format: 'reflow', cfi: 'cfi-born' }))).created.stale).toBe(true)
    expect((await onDisk('a')).annotations[1]).toMatchObject({
      cfi: 'cfi-born',
      artifact: { kind: 'derived', format: 'reflow', stamp: null }
    })
  })

  it('never marks a source annotation stale for the book’s own file', async () => {
    await create(input({ format: 'epub' }))
    expect((await list('a', 'epub')).annotations[0]!.stale).toBe(false)
  })

  it('marks an annotation made against another artifact stale, per annotation rather than per list', async () => {
    await writeStamp()
    await create(input({ format: 'epub', cfi: 'cfi-source' }))
    await create(input({ format: 'reflow', cfi: 'cfi-derived' }))

    // The reader has this book open as its reflow: the source annotation's cfi points into a
    // document that is not on screen, so it is listed and never drawn — and the derived one is
    // the opposite, in the same answer.
    const asReflow = (await list('a', 'reflow')).annotations
    expect(asReflow.map((a) => [a.cfi, a.stale])).toEqual([
      ['cfi-source', true],
      ['cfi-derived', false]
    ])

    const asEpub = (await list('a', 'epub')).annotations
    expect(asEpub.map((a) => [a.cfi, a.stale])).toEqual([
      ['cfi-source', false],
      ['cfi-derived', true]
    ])
  })

  it('answers one token per stamp, and null for anything it cannot establish (stampToken)', () => {
    const stamp = { version: 1, converter: TRIPLE, source: SOURCE }

    // The order the members were written in is not part of the stamp's identity…
    expect(stampToken(stamp)).toBe(
      stampToken({
        source: { mtime: SOURCE.mtime, size: SOURCE.size },
        converter: { generator: TRIPLE.generator, helper: TRIPLE.helper, sidecar: TRIPLE.sidecar },
        version: 1
      })
    )

    // …but every member of it is: the converter's triple, and the source's own two terms.
    for (const other of [
      { ...stamp, converter: { ...TRIPLE, sidecar: 5 } },
      { ...stamp, converter: { ...TRIPLE, helper: 2 } },
      { ...stamp, converter: { ...TRIPLE, generator: 'macos-28' } },
      { ...stamp, source: { ...SOURCE, size: 9999 } },
      { ...stamp, source: { ...SOURCE, mtime: 1700000001 } }
    ]) {
      expect(stampToken(other), JSON.stringify(other)).not.toBe(stampToken(stamp))
    }

    // A stamp this build cannot compare has no identity at all, and no identity is not a match.
    for (const none of [
      null,
      '4',
      [1, 2],
      {},
      { version: 1, converter: TRIPLE },
      { version: 1, converter: [4, 1], source: SOURCE },
      { version: 1, converter: TRIPLE, source: { size: 1234 } }
    ]) {
      expect(stampToken(none), JSON.stringify(none)).toBeNull()
    }
  })

  it('isStale answers the table the read path depends on', () => {
    const source = { kind: 'source', format: 'epub', stamp: null } as const
    const derived = { kind: 'derived', format: 'reflow', stamp: 'a-digest' } as const
    expect(isStale(source, source)).toBe(false)
    expect(isStale(source, { ...source, format: 'mobi' })).toBe(true)
    expect(isStale(source, derived)).toBe(true)
    expect(isStale(derived, derived)).toBe(false)
    expect(isStale(derived, { ...derived, stamp: 'another-digest' })).toBe(true)
    expect(isStale(derived, { ...derived, stamp: null })).toBe(true)
    expect(isStale({ ...derived, stamp: null }, derived)).toBe(true)
  })
})

describe('the file is carried, not just understood (spec D2)', () => {
  it('keeps an entry of a type this build does not know, verbatim, through a write', async () => {
    const foreign = { id: 'bm-1', type: 'bookmark', cfi: 'epubcfi(/6/4!/2)', extra: [1, 2] }
    await fs.writeFile(
      filePath('a'),
      `${JSON.stringify({ version: 1, book_id: 'a', annotations: [foreign] }, null, 2)}\n`,
      'utf8'
    )

    // It is not a highlight, so the renderer never sees it…
    expect(await list('a', 'epub')).toEqual({ state: 'ok', annotations: [] })

    // …and a write of ours leaves it exactly as the other build left it
    await create(input())
    const disk = await onDisk('a')
    expect(disk.annotations).toHaveLength(2)
    expect(disk.annotations.find((e) => e.id === 'bm-1')).toEqual(foreign)
  })

  it('repairs a book_id that names another book, and refuses nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await fs.writeFile(
      filePath('a'),
      `${JSON.stringify({ version: 1, book_id: 'someone-else', annotations: [] })}\n`,
      'utf8'
    )

    await create(input())

    expect(warn).toHaveBeenCalled()
    expect((await onDisk('a')).book_id).toBe('a')
  })
})

describe('the write path refuses what it cannot do', () => {
  it('refuses a write while the library is not reachable, and writes nothing', async () => {
    await nas.setLibraryRoot(join(root, 'gone'))

    await expect(create(input())).rejects.toThrow(/missing|offline/)
    await expect(fs.access(filePath('a'))).rejects.toThrow()
  })

  it('refuses a highlight for a book the library does not hold', async () => {
    await expect(create(input({ bookId: 'not-a-book' }))).rejects.toThrow(ANNOTATION_NO_BOOK)
  })

  it('refuses a highlight with no position, and one with no text', async () => {
    await expect(create(input({ cfi: '   ' }))).rejects.toThrow(/needs a position/)
    await expect(create(input({ quote: ' \n\t ' }))).rejects.toThrow(/needs the text/)
    await expect(fs.access(filePath('a'))).rejects.toThrow()
  })
})

describe('what the writer normalizes on the way in', () => {
  it('clamps a percent and a quote rather than storing impossible ones', async () => {
    const high = (await create(input({ percent: 5, cfi: 'cfi-1' }))).created
    const low = (await create(input({ percent: -3, cfi: 'cfi-2' }))).created
    const long = (await create(input({ quote: 'x   y'.repeat(400), cfi: 'cfi-3' }))).created

    expect(high.percent).toBe(1)
    expect(low.percent).toBe(0)
    expect(long.quote).toHaveLength(512)
    expect(long.quote.startsWith('x y')).toBe(true)
  })

  it('caps the context either side, drops an empty section label, and defaults the color', async () => {
    const created = (
      await create(
        input({ prefix: 'p'.repeat(80), suffix: 's'.repeat(80), sectionLabel: '   ', color: '  ' })
      )
    ).created

    expect(created.prefix).toHaveLength(32)
    expect(created.suffix).toHaveLength(32)
    expect(created.sectionLabel).toBeNull()
    expect(created.color).toBe('gold')
  })

  it('normalizes the quote the way a search excerpt is normalized, so the two are comparable', async () => {
    const created = (await create(input({ quote: '  the   protomolecule\nis  loose  ' }))).created
    expect(created.quote).toBe('the protomolecule is loose')
  })
})

describe('the module’s own surface', () => {
  it('exports the sentences a caller renders', () => {
    expect(annotations.ANNOTATIONS_UNREADABLE).toMatch(/could not be read/)
    expect(annotations.ANNOTATION_GONE).toMatch(/no longer in this book/)
    expect(annotations.ANNOTATION_NO_BOOK).toMatch(/not in the library/)
  })
})
