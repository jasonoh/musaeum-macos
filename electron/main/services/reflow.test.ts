import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReflowResult } from '@shared/book.types'
import { makeBook } from '../../../test/helpers/book'
import { closeDb, insertBook } from './db'
import * as events from './events'
import * as nas from './nas-manager'
import { REFLOW_TIMEOUT_MS, RETRY_VERDICTS, currentProgress, ensure, resetForTests } from './reflow'
import * as sidecar from './sidecar'

/**
 * The sidecar and the event bus are mocked as whole modules: `vi.mock` replaces
 * each, so every export `reflow.ts` reaches for has to be named here.
 * `assertAvailable` is the one that would otherwise *start* a live Python
 * process against `sidecar/.venv` — `getAppPath()` is the repo root under vitest
 * — which is the same reason `bulk-hydrate.test.ts` mocks it.
 */
vi.mock('./sidecar', () => ({
  assertAvailable: vi.fn(),
  call: vi.fn(),
  onNotification: vi.fn(() => () => {})
}))
vi.mock('./events', () => ({ broadcast: vi.fn() }))

let root: string

beforeEach(async () => {
  closeDb()
  resetForTests()
  vi.mocked(sidecar.call).mockReset()
  vi.mocked(sidecar.onNotification).mockClear()
  vi.mocked(sidecar.assertAvailable).mockReset()
  vi.mocked(events.broadcast).mockClear()

  const userData = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(userData, f), { force: true })
  }
  root = mkdtempSync(join(tmpdir(), 'musaeum-reflow-'))
  await nas.setLibraryRoot(root)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

/** The mocked `call` is generic (`call<T>` → `Promise<T>`); one shape serves every case. */
function answerWith(value: Record<string, unknown> | Error): void {
  if (value instanceof Error) vi.mocked(sidecar.call).mockRejectedValue(value as never)
  else vi.mocked(sidecar.call).mockResolvedValue(value as never)
}

/** A PDF-only book, seeded the way the importer leaves one. */
async function seedPdf(id: string, name = 'Some Old Title.pdf'): Promise<string> {
  insertBook({ ...makeBook(id), formats: ['pdf'] })
  const dir = join(root, 'books', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, name), '%PDF-1.4\n')
  return dir
}

const PRODUCED = {
  status: 'produced',
  reason: '',
  verdict: 'ok',
  epub: 'derived/reflow.epub',
  stamp_file: 'derived/reflow.json',
  pages: 12,
  bytes: 4096,
  seconds: 3.5
}

describe('ensure', () => {
  it('resolves the source by extension and hands the pass its own folder', async () => {
    const dir = await seedPdf('b1')
    answerWith(PRODUCED)

    await ensure('b1')

    const [method, params] = vi.mocked(sidecar.call).mock.calls[0] as unknown as [
      string,
      Record<string, string>
    ]
    expect(method).toBe('reflow_pdf')
    // Invariant 2: the folder is found by extension, so a book renamed after
    // import still reflows — and `book_dir` is *that file's* folder.
    expect(params.pdf_path).toBe(join(dir, 'Some Old Title.pdf'))
    expect(params.book_dir).toBe(dir)
    expect(params.book_id).toBe('b1')
  })

  /**
   * The measured gotcha this rule exists for: the sidecar's default is 120 s and
   * a 535-page pass is 176 s, so the default would report a working pass as a
   * failure while its artifact landed anyway.
   */
  it('gives the pass longer than the sidecar default', async () => {
    await seedPdf('b2')
    answerWith(PRODUCED)
    await ensure('b2')
    const timeout = vi.mocked(sidecar.call).mock.calls[0][2] as number
    expect(timeout).toBe(REFLOW_TIMEOUT_MS)
    expect(timeout).toBeGreaterThan(120_000)
  })

  it('speaks the app’s spelling, not the pipeline’s', async () => {
    await seedPdf('b3')
    answerWith(PRODUCED)
    const result: ReflowResult = await ensure('b3')
    expect(result).toEqual({
      status: 'produced',
      reason: '',
      verdict: 'ok',
      epub: 'derived/reflow.epub',
      stampFile: 'derived/reflow.json',
      pages: 12,
      bytes: 4096,
      seconds: 3.5
    })
  })

  it('answers an unknown status as a fallback rather than trusting it', async () => {
    await seedPdf('b4')
    answerWith({ status: 'exploded' })
    const result = await ensure('b4')
    expect(result.status).toBe('fallback')
    expect(result.pages).toBe(0)
    expect(result.epub).toBe('')
  })

  it('joins a pass already in flight instead of asking twice (AC6)', async () => {
    await seedPdf('b5')
    let release: (value: Record<string, unknown>) => void = () => {}
    vi.mocked(sidecar.call).mockImplementation(
      () => new Promise((resolve) => (release = resolve)) as never
    )

    const both = Promise.all([ensure('b5'), ensure('b5')])
    // The first pass reaches `call` only after an fs read, so releasing before
    // that would fire the no-op above and hang the pair.
    await vi.waitFor(() => expect(vi.mocked(sidecar.call)).toHaveBeenCalled())
    release(PRODUCED)
    const [one, two] = await both

    expect(vi.mocked(sidecar.call)).toHaveBeenCalledTimes(1)
    expect(one).toBe(two)
  })

  it('forgets the pass when it settles, so the next open asks again', async () => {
    await seedPdf('b6')
    answerWith(PRODUCED)
    await ensure('b6')
    await ensure('b6')
    // Twice asked, deliberately: the *cache* is the sidecar's (slice 2's stamp),
    // and it is what answers `cached` — this module holds nothing across calls.
    expect(vi.mocked(sidecar.call)).toHaveBeenCalledTimes(2)
  })

  it('rejects when the metadata engine is unavailable', async () => {
    await seedPdf('b7')
    vi.mocked(sidecar.assertAvailable).mockImplementation(() => {
      throw new Error('Python sidecar is unavailable')
    })
    await expect(ensure('b7')).rejects.toThrow('Python sidecar is unavailable')
    expect(vi.mocked(sidecar.call)).not.toHaveBeenCalled()
  })

  it('rejects when the book holds no PDF', async () => {
    insertBook({ ...makeBook('b8'), formats: ['epub'] })
    await fs.mkdir(join(root, 'books', 'b8'), { recursive: true })
    await fs.writeFile(join(root, 'books', 'b8', 'Book.epub'), 'x')
    await expect(ensure('b8')).rejects.toThrow('no PDF')
  })
})

describe('the retry (R4)', () => {
  it('asks again once when the helper failed pages on a later run', async () => {
    await seedPdf('b9')
    vi.mocked(sidecar.call)
      .mockResolvedValueOnce({
        status: 'fallback',
        verdict: 'unstable_layout',
        reason: '3 of 5 text pages could not be laid out'
      } as never)
      .mockResolvedValueOnce(PRODUCED as never)

    const result = await ensure('b9')

    expect(vi.mocked(sidecar.call)).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('produced')
    // A bar that restarts has to have said why.
    expect(vi.mocked(events.broadcast)).toHaveBeenCalledWith(
      'reflowProgress',
      expect.objectContaining({ phase: 'retrying', bookId: 'b9' })
    )
  })

  it('never retries a verdict that is a fact about the book', async () => {
    expect(RETRY_VERDICTS.has('no_text_layer')).toBe(false)
    expect(RETRY_VERDICTS.has('unreadable')).toBe(false)
    expect(RETRY_VERDICTS.has('write_failed')).toBe(false)
    expect(RETRY_VERDICTS.has('no_layout')).toBe(false)

    await seedPdf('b10')
    answerWith({
      status: 'fallback',
      verdict: 'no_text_layer',
      reason: 'no page carries a text layer'
    })
    const result = await ensure('b10')
    expect(vi.mocked(sidecar.call)).toHaveBeenCalledTimes(1)
    expect(result.reason).toBe('no page carries a text layer')
  })
})

describe('the frames', () => {
  it('re-broadcasts a reflow_progress frame in the app’s spelling', async () => {
    await seedPdf('b11')
    answerWith(PRODUCED)
    await ensure('b11')

    const handler = vi.mocked(sidecar.onNotification).mock.calls[0][1] as (params: unknown) => void
    vi.mocked(events.broadcast).mockClear()
    handler({ book_id: 'b11', phase: 'layout', completed: 3, total: 9 })

    expect(vi.mocked(events.broadcast)).toHaveBeenCalledWith('reflowProgress', {
      bookId: 'b11',
      phase: 'layout',
      completed: 3,
      total: 9
    })
  })

  it('carries the pipeline’s sentence on a fallback frame', async () => {
    await seedPdf('b12')
    answerWith(PRODUCED)
    await ensure('b12')

    const handler = vi.mocked(sidecar.onNotification).mock.calls[0][1] as (params: unknown) => void
    vi.mocked(events.broadcast).mockClear()
    handler({ book_id: 'b12', phase: 'fallback', reason: 'no page carries a text layer' })

    expect(vi.mocked(events.broadcast)).toHaveBeenCalledWith(
      'reflowProgress',
      expect.objectContaining({ reason: 'no page carries a text layer' })
    )
  })

  it('drops a frame that names no book', async () => {
    await seedPdf('b13')
    answerWith(PRODUCED)
    await ensure('b13')

    const handler = vi.mocked(sidecar.onNotification).mock.calls[0][1] as (params: unknown) => void
    vi.mocked(events.broadcast).mockClear()
    handler({ phase: 'layout' })
    handler({ book_id: 'b13' })
    handler(undefined)

    expect(vi.mocked(events.broadcast)).not.toHaveBeenCalled()
  })

  it('subscribes once, however many books are asked for', async () => {
    await seedPdf('b14')
    await seedPdf('b15')
    answerWith(PRODUCED)
    await ensure('b14')
    await ensure('b15')
    expect(vi.mocked(sidecar.onNotification)).toHaveBeenCalledTimes(1)
  })
})

/**
 * The wire's `202` reads where a pass is while it runs (slice 4): a reflow is
 * minutes and a request cannot hold a socket that long, so the route answers the
 * last frame and the client asks again.
 */
describe('currentProgress', () => {
  it('holds the last frame while a pass runs, and nothing once it settles', async () => {
    await seedPdf('b16')
    let release: (value: Record<string, unknown>) => void = () => {}
    vi.mocked(sidecar.call).mockImplementation(
      () => new Promise((resolve) => (release = resolve)) as never
    )

    const running = ensure('b16')
    await vi.waitFor(() => expect(vi.mocked(sidecar.call)).toHaveBeenCalled())

    // Nothing yet, deliberately: a pass with no frame answers `null`, so the
    // route writes its own `start 0 0` rather than a frame from a previous open
    expect(currentProgress('b16')).toBeNull()

    const handler = vi.mocked(sidecar.onNotification).mock.calls[0][1] as (params: unknown) => void
    handler({ book_id: 'b16', phase: 'layout', completed: 3, total: 9 })
    expect(currentProgress('b16')).toEqual({ phase: 'layout', completed: 3, total: 9 })

    release(PRODUCED)
    await running
    // The frame goes with the pass it described: a settled book has no progress
    // to report, and a later `202` must never answer with where it *was*
    expect(currentProgress('b16')).toBeNull()
  })

  it('reports the retry while it is happening', async () => {
    await seedPdf('b17')
    let release: (value: Record<string, unknown>) => void = () => {}
    vi.mocked(sidecar.call)
      .mockResolvedValueOnce({
        status: 'fallback',
        verdict: 'unstable_layout',
        reason: '3 of 5 text pages could not be laid out'
      } as never)
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)) as never)

    const running = ensure('b17')
    // `retrying` is this app's own phase (the sidecar never sends it), and a bar
    // that restarts has to be able to say so
    await vi.waitFor(() =>
      expect(currentProgress('b17')).toEqual({ phase: 'retrying', completed: 0, total: 0 })
    )
    release(PRODUCED)
    await running
    expect(currentProgress('b17')).toBeNull()
  })
})
