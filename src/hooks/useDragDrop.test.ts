import { describe, expect, it } from 'vitest'
import { isBookFile } from './useDragDrop'

/**
 * The drop gate is the app's oldest on-ramp and the only one the import
 * pipeline cannot correct for: a file it rejects never reaches main, so a
 * missing extension is a silent no-op rather than a failed import. PDF became
 * a first-class format in Phase 1.5 and this list kept the old three, which is
 * exactly the drift these cases pin.
 */
describe('isBookFile', () => {
  it('accepts every format the import pipeline supports', () => {
    for (const name of ['dune.epub', 'dune.mobi', 'dune.azw3', 'dune.pdf']) {
      expect(isBookFile(name), name).toBe(true)
    }
  })

  it('matches regardless of case, since Finder hands over the on-disk name', () => {
    expect(isBookFile('Dune.PDF')).toBe(true)
    expect(isBookFile('Dune.EPUB')).toBe(true)
  })

  it('rejects anything else, including a near-miss suffix', () => {
    for (const name of ['cover.jpg', 'notes.txt', 'dune.pdf.part', 'epub']) {
      expect(isBookFile(name), name).toBe(false)
    }
  })
})
