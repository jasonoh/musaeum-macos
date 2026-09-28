import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The drop gate, decided by source walk (AC20).
 *
 * The predicate itself is no longer here: slice 3 of the library-IA design moved
 * it to `BOOK_FILE_EXTENSIONS` / `isBookFile` in `@shared/book.types` so the
 * window drop and the native file picker cannot disagree, and its behaviour is
 * decided in `src/types/book.types.test.ts`. What is left for this file is the
 * one thing the hook still owns — having no list of its own to fall behind,
 * which is how a dropped PDF became a silent no-op: a file the gate rejects
 * never reaches main, so it never fails either.
 *
 * Stated limit: there is no DOM harness in this suite, so a real drop cannot be
 * dispatched at a window. This proves the call site's shape, not the drop's
 * behaviour.
 */
const SOURCE = readFileSync(join(process.cwd(), 'src', 'hooks', 'useDragDrop.ts'), 'utf8')

describe('useDragDrop declares no book-extension list of its own', () => {
  it('names no extension and no second copy of the list', () => {
    expect(SOURCE).not.toMatch(/BOOK_EXTENSIONS|SUPPORTED_FORMATS|WATCHED_EXTENSIONS/)
    expect(SOURCE).not.toMatch(/\.epub|\.mobi|\.azw3|\.pdf/)
  })

  it('gates the dropped files through the shared predicate', () => {
    expect(SOURCE).toMatch(/import \{ isBookFile \} from '@shared\/book\.types'/)
    expect(SOURCE).toMatch(/\.filter\(\(f\) => isBookFile\(f\.name\)\)/)
  })

  it('asks the shared predicate rather than naming a type itself (AC25)', () => {
    // The two halves of AC25 are decided over `isImportDrag` itself, in
    // `book-drag.test.ts`; this one holds the wiring — the hook must *ask*.
    expect(SOURCE).toMatch(/isImportDrag\(/)
    expect(SOURCE).not.toMatch(/includes\('Files'\)/)
  })

  it('still hands the surviving paths to the pipeline through the preload', () => {
    // The on-ramp's other half is unchanged: paths are resolved in the preload
    // (the renderer never invents a file:// path), and progress arrives on the
    // importProgress stream rather than as this call's answer
    expect(SOURCE).toMatch(/window\.Musaeum\.files\.getPathForFile\(f\)/)
    expect(SOURCE).toMatch(/window\.Musaeum\.import\.addFiles\(paths\)/)
  })
})
