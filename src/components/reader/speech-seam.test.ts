import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ANNOTATION_DRAW_KINDS, isAnnotationDrawKind } from '@/lib/annotations'
import { SPEECH_DRAW_KIND } from '@/lib/speech-controller'

/**
 * The voice reader's seam in `ReaderEngine` (voice reader UI, Task 6).
 *
 * There is no DOM harness for components (vitest runs in node), so the seam is
 * pinned the way `drag-regions.test.ts` pins the titlebar — by reading the
 * source — and proved in the running app. Three rules are held here:
 *
 * 1. **One overlayer.** The spoken sentence is drawn through the engine's
 *    existing `draw-annotation` arm under its own kind, selected from the same
 *    `DRAWS` table — never a second overlay.
 * 2. **A spoken sentence is never a record.** The speech kind stays out of
 *    `ANNOTATION_DRAW_KINDS`, which is the persisted plan's list, and the page
 *    range the engine now passes out never reaches the position report.
 * 3. **The reader learns nothing about PDFs** (reader invariant D10): nothing in
 *    the speech arm reads the book's format.
 */
const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), 'utf8')
const ENGINE = read('src', 'components', 'reader', 'ReaderEngine.tsx')
const VIEW = read('src', 'components', 'reader', 'ReaderView.tsx')
const CONTROLLER = read('src', 'lib', 'speech-controller.ts')

/** The `DRAWS` table's body. */
const DRAWS_BODY = ENGINE.slice(
  ENGINE.indexOf('const DRAWS'),
  ENGINE.indexOf('\n}\n', ENGINE.indexOf('const DRAWS'))
)

/** Code only: the controller's comments are allowed to say why it never asks. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The `draw-annotation` listener's body. */
const DRAW_LISTENER = ENGINE.slice(
  ENGINE.indexOf("addEventListener('draw-annotation'"),
  ENGINE.indexOf("addEventListener('show-annotation'")
)

/** The `show-annotation` listener's body. */
const SHOW_LISTENER = ENGINE.slice(
  ENGINE.indexOf("addEventListener('show-annotation'"),
  ENGINE.indexOf("addEventListener('relocate'")
)

describe('the voice reader seam in ReaderEngine', () => {
  it('opens Notes only for a click on a highlight the plan drew, never on the spoken sentence', () => {
    // the overlayer emits show-annotation for any non-search value it holds (view.js:408-413),
    // the speech fill included; only the plan's rows are saved highlights
    expect(SHOW_LISTENER).toMatch(/plan\.current\.rows\.some\(\(row\) => row\.cfi === value\)/)
    expect(SHOW_LISTENER.indexOf('rows.some')).toBeLessThan(
      SHOW_LISTENER.indexOf('cb.current.onShowAnnotation')
    )
  })

  it('draws speech as a fill from the same DRAWS table the highlights use', () => {
    expect(SPEECH_DRAW_KIND).toBe('speech')
    expect(DRAWS_BODY).toMatch(/speech:\s*Overlayer\.highlight/)
    expect(DRAW_LISTENER).toContain('SPEECH_DRAW_KIND')
    expect(DRAW_LISTENER).toContain('DRAWS[drawKind]')
  })

  it('opens no second overlayer', () => {
    expect(ENGINE.match(/new Overlayer\(/g)).toBeNull()
    expect(CONTROLLER).not.toMatch(/Overlayer/)
  })

  it('keeps the speech kind out of the persisted annotation kinds', () => {
    expect(ANNOTATION_DRAW_KINDS).not.toContain(SPEECH_DRAW_KIND)
    expect(isAnnotationDrawKind(SPEECH_DRAW_KIND)).toBe(false)
  })

  it("passes relocate's page range out, and the position report never carries it", () => {
    expect(ENGINE).toMatch(/range: detail\.range \?\? null/)
    // the report is built field by field, so nothing else on the detail rides into it
    expect(VIEW).toContain(
      'latest.current = { position: detail.position, percent: detail.percent }'
    )
    expect(VIEW).not.toMatch(/latest\.current = \{\s*\.\.\.detail/)
  })

  it("hands the chip's own range, cloned at capture, to onReadFromHere", () => {
    expect(ENGINE).toContain('range: range.cloneRange()')
    expect(ENGINE).toMatch(/cb\.current\.onReadFromHere\?\.\(chip\.range\)/)
  })

  it('never reads the book format in the speech arm', () => {
    const code = stripComments(CONTROLLER)
    expect(code).toContain('class SpeechController')
    expect(code).not.toMatch(/\bformat\b|\bpdf\b|reflow/i)
  })
})
