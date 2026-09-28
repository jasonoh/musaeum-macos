import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Source walk over the payload's lifecycle (AC27, Review Focus 1).
 *
 * Stated limit, as in `useDragDrop.test.ts`: there is no DOM harness here, so a
 * window listener cannot be fired at a real window. What is asserted is the
 * shape the mechanism needs — the clear is on the **window**, because the
 * source element cannot be trusted to be alive at the end (both views are
 * virtualized), and the hook is mounted exactly once. The slot's own behaviour
 * is `src/lib/book-drag.test.ts`; the live half is the CDP probe.
 */
const SOURCE = readFileSync(join(process.cwd(), 'src', 'hooks', 'useBookDrag.ts'), 'utf8')
const APP = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')

describe('useBookDrag clears the payload on the window', () => {
  it('listens for both ends of a drag, and cleans both up', () => {
    expect(SOURCE).toMatch(/window\.addEventListener\('drop', clear\)/)
    expect(SOURCE).toMatch(/window\.addEventListener\('dragend', clear\)/)
    expect(SOURCE).toMatch(/window\.removeEventListener\('drop', clear\)/)
    expect(SOURCE).toMatch(/window\.removeEventListener\('dragend', clear\)/)
  })

  it('clears through the module rather than reaching into a slot of its own', () => {
    expect(SOURCE).toMatch(/import \{ clearDragPayload \} from '@\/lib\/book-drag'/)
    expect(SOURCE).toMatch(/clearDragPayload\(\)/)
  })

  it('is mounted once, in App, beside the other window drag listener', () => {
    expect(APP.match(/useBookDrag\(\)/g)).toHaveLength(1)
    expect(APP).toMatch(/useDragDrop\(\)\s*\n\s*useBookDrag\(\)/)
  })
})
