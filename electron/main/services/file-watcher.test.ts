import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportResult } from '@shared/book.types'
import * as importer from './importer'
import { importAndRemove } from './file-watcher'

vi.mock('./importer', () => ({ addFiles: vi.fn() }))

/**
 * The inbox's success path is an `rm`, so the whole job of this suite is the
 * line between "the file is in the library" and "it is not": only a settled
 * import may take the source with it.
 */
describe('importAndRemove', () => {
  let dir: string
  let file: string

  const result = (r: Partial<ImportResult>): ImportResult[] => [
    { jobId: 'j', fileName: 'Dune.epub', success: false, ...r }
  ]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musaeum-watcher-'))
    file = join(dir, 'Dune.epub')
    await fs.writeFile(file, 'ebook bytes')
  })
  afterEach(() => {
    vi.resetAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  const exists = (): Promise<boolean> =>
    fs.access(file).then(
      () => true,
      () => false
    )

  it('asks the importer to refuse a duplicate rather than wait for a window', async () => {
    vi.mocked(importer.addFiles).mockResolvedValue(result({ success: true, bookId: 'b' }))
    await importAndRemove(file)
    expect(importer.addFiles).toHaveBeenCalledWith([file], { duplicate: 'reject' })
  })

  it('removes the source once the book is in the library', async () => {
    vi.mocked(importer.addFiles).mockResolvedValue(result({ success: true, bookId: 'b' }))
    await importAndRemove(file)
    expect(await exists()).toBe(false)
  })

  it('keeps the source when the import refused it as a duplicate', async () => {
    vi.mocked(importer.addFiles).mockResolvedValue(
      result({ error: 'Already in the library as "Dune"' })
    )
    await importAndRemove(file)
    expect(await exists()).toBe(true)
  })

  it('keeps the source when the import was skipped', async () => {
    vi.mocked(importer.addFiles).mockResolvedValue(result({ skipped: true, action: 'skip' }))
    await importAndRemove(file)
    expect(await exists()).toBe(true)
  })

  it('keeps the source when the import throws or returns nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(importer.addFiles).mockRejectedValueOnce(new Error('boom'))
    await importAndRemove(file)
    expect(await exists()).toBe(true)

    vi.mocked(importer.addFiles).mockResolvedValueOnce([])
    await importAndRemove(file)
    expect(await exists()).toBe(true)
  })
})
