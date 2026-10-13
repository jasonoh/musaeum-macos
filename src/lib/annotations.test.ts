import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { Annotation } from '@shared/annotation.types'
import {
  ANNOTATION_DRAW_KINDS,
  annotationFromSelection,
  annotationGroups,
  isAnnotationDrawKind,
  planAnnotations,
  removedValues,
  type AnnotationDrawRow,
  type DrawableAnnotation
} from './annotations'

/**
 * The reader surface's decisions, without a DOM and without a store.
 *
 * There is no `document` in this environment (`environment: 'node'`, no jsdom),
 * which is the reason `src/lib/annotations.ts` is pure and the engine is reached
 * as a **stub source** — the pattern `src/lib/reader-search.ts:82-90` already
 * uses to keep foliate-js out of a test. The vendor is never driven here; the
 * plan's own contract with it (what it offers, what it does with a throw, what a
 * row says) is.
 */

/** A stored highlight as the bridge hands it over — every field, so a case overrides only its subject. */
function ann(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'a1',
    type: 'highlight',
    cfi: 'epubcfi(/6/4!/4/2/2,/1:0,/1:4)',
    quote: 'the protomolecule is loose',
    prefix: '',
    suffix: '',
    percent: 0.5,
    sectionLabel: null,
    color: 'gold',
    note: null,
    createdAt: '2026-10-13T11:02:41.000Z',
    updatedAt: '2026-10-13T11:02:41.000Z',
    stale: false,
    ...over
  }
}

/**
 * A stand-in for `foliate-view`, structurally: it records what it was offered,
 * and `behaviour` decides whether a given value resolves or throws.
 *
 * The throw is the engine's real failure mode rather than a defensive one —
 * `addAnnotation` destructures `resolveNavigation`'s `undefined`
 * (`vendor/foliate-js/view.js:385` against `:446-459`).
 */
function stubSource(behaviour: (value: string) => 'ok' | 'throw' = () => 'ok') {
  const calls: DrawableAnnotation[] = []
  return {
    calls,
    async addAnnotation(annotation: DrawableAnnotation): Promise<unknown> {
      calls.push(annotation)
      if (behaviour(annotation.value) === 'throw') throw new Error('Could not resolve target')
      return { index: 0, label: '' }
    }
  }
}

describe('annotationFromSelection (AC13, R9/R10)', () => {
  const capture = {
    quote: '  the protomolecule   is loose\n',
    cfi: '  epubcfi(/6/4!/4/2/2)  ',
    percent: 0.42,
    sectionLabel: '  Chapter 7  ',
    prefix: 'and then ',
    suffix: ' it was not'
  }

  it('normalizes the whitespace and the ends of every member it keeps', () => {
    expect(annotationFromSelection(capture)).toEqual({
      cfi: 'epubcfi(/6/4!/4/2/2)',
      quote: 'the protomolecule is loose',
      prefix: 'and then',
      suffix: 'it was not',
      percent: 0.42,
      sectionLabel: 'Chapter 7'
    })
  })

  it('returns exactly the members a caller may say, and nothing a mint belongs to (R5)', () => {
    // The key set *is* the criterion: an `id`, a `type`, a timestamp or an
    // `artifact` here would be the renderer naming something only the file's
    // writer mints, which is the rule slice 1 enforced with a type.
    const locator = annotationFromSelection(capture)
    expect(Object.keys(locator ?? {}).sort()).toEqual([
      'cfi',
      'percent',
      'prefix',
      'quote',
      'sectionLabel',
      'suffix'
    ])
  })

  it('refuses a whitespace-only quote rather than returning a partial record', () => {
    for (const quote of ['', '   ', '\n\t ']) {
      expect(annotationFromSelection({ ...capture, quote }), JSON.stringify(quote)).toBeNull()
    }
  })

  it('refuses a blank position, trimmed', () => {
    expect(annotationFromSelection({ ...capture, cfi: '' })).toBeNull()
    expect(annotationFromSelection({ ...capture, cfi: '   ' })).toBeNull()
  })

  it('caps the quote and each side of the context at the file’s own limits', () => {
    // 800 characters in, 512 out; 40 either side, 32 retained — the caps are
    // `QUOTE_MAX` / `CONTEXT_MAX`, and a copy of them here would pass for any
    // pair of numbers, so the *length* is what is asserted.
    const long = annotationFromSelection({
      ...capture,
      quote: 'a '.repeat(400),
      prefix: 'b'.repeat(40),
      suffix: 'c'.repeat(40)
    })
    expect(long?.quote).toHaveLength(512)
    expect(long?.prefix).toHaveLength(32)
    expect(long?.suffix).toHaveLength(32)
    expect(long?.prefix).toBe('b'.repeat(32))
    expect(long?.suffix).toBe('c'.repeat(32))
  })

  it('clamps the fraction, and takes a caller’s nonsense as the start of the book', () => {
    expect(annotationFromSelection({ ...capture, percent: 1.4 })?.percent).toBe(1)
    expect(annotationFromSelection({ ...capture, percent: -0.2 })?.percent).toBe(0)
    expect(annotationFromSelection({ ...capture, percent: Number.NaN })?.percent).toBe(0)
  })

  it('stores an absent section label as null, and a missing context as empty', () => {
    const bare = annotationFromSelection({ ...capture, sectionLabel: null })
    expect(bare?.sectionLabel).toBeNull()
    expect(annotationFromSelection({ ...capture, sectionLabel: '   ' })?.sectionLabel).toBeNull()
    const noContext = annotationFromSelection({
      quote: 'x',
      cfi: 'c',
      percent: 0,
      sectionLabel: null
    })
    expect(noContext).toMatchObject({ prefix: '', suffix: '' })
  })
})

describe('planAnnotations (AC14, AC16, R12/R13)', () => {
  it('reports the locator the engine refused as undrawable and draws the other', async () => {
    const source = stubSource((value) => (value === 'bad' ? 'throw' : 'ok'))
    const plan = await planAnnotations(
      [
        ann({ id: 'bad', cfi: 'bad', percent: 0.2 }),
        ann({ id: 'good', cfi: 'good', percent: 0.6 })
      ],
      '#d4a24e',
      source
    )

    expect(plan.undrawable).toEqual(['bad'])
    expect(plan.rows.map((row) => row.id)).toEqual(['good'])
    // One throw costs one annotation: the plan resolved, and the second was drawn.
    expect(source.calls.map((call) => call.value)).toEqual(['bad', 'good'])
  })

  it('offers a refused position once, however many records point at it (never twice)', async () => {
    const source = stubSource(() => 'throw')
    const plan = await planAnnotations(
      [ann({ id: 'x', cfi: 'same' }), ann({ id: 'y', cfi: 'same' })],
      '#d4a24e',
      source
    )

    expect(source.calls.map((call) => call.value)).toEqual(['same'])
    expect(plan.undrawable).toEqual(['x'])
  })

  it('never offers a stale annotation — it is in neither list, not a caught failure', async () => {
    const source = stubSource()
    const plan = await planAnnotations(
      [ann({ id: 'fresh', cfi: 'f' }), ann({ id: 'old', cfi: 'o', stale: true })],
      '#d4a24e',
      source
    )

    expect(source.calls.map((call) => call.value)).toEqual(['f'])
    expect(plan.rows.map((row) => row.id)).toEqual(['fresh'])
    expect(plan.undrawable).toEqual([])
  })

  it('names the draw as a highlight (AC16)', async () => {
    const plan = await planAnnotations([ann()], '#d4a24e', stubSource())
    expect(plan.rows).toHaveLength(1)
    expect(plan.rows[0].kind).toBe('highlight')
    expect(plan.rows[0]).toMatchObject({ id: 'a1', cfi: ann().cfi, color: '#d4a24e' })
    // …and the vocabulary is the plan's alone: the search path's own draw is an
    // `outline` the engine applies inside `search()`, never through this plan.
    expect(ANNOTATION_DRAW_KINDS).toEqual(['highlight'])
    expect(isAnnotationDrawKind('highlight')).toBe(true)
    expect(isAnnotationDrawKind('outline')).toBe(false)
    expect(isAnnotationDrawKind(undefined)).toBe(false)
  })

  it('carries the resolved color into the row and into the engine’s own call (AC15)', async () => {
    const a = await planAnnotations([ann()], '#d4a24e', stubSource())
    const b = await planAnnotations([ann()], '#cb4b16', stubSource())

    expect(a.rows[0].color).toBe('#d4a24e')
    expect(b.rows[0].color).toBe('#cb4b16')
    expect(a.rows).not.toEqual(b.rows)
  })

  it('offers the whole book in document order, whatever order the file holds', async () => {
    const source = stubSource()
    const plan = await planAnnotations(
      [
        ann({ id: 'later', cfi: 'l', percent: 0.9 }),
        ann({ id: 'first', cfi: 'f', percent: 0.1 }),
        ann({ id: 'second', cfi: 's', percent: 0.1, createdAt: '2026-10-13T12:00:00.000Z' })
      ],
      '#d4a24e',
      source
    )
    expect(plan.rows.map((row) => row.id)).toEqual(['first', 'second', 'later'])
    expect(plan.undrawable).toEqual([])
  })

  it('names what the page is showing that the book no longer holds (R13)', () => {
    const row = (cfi: string): AnnotationDrawRow => ({
      id: cfi,
      cfi,
      kind: 'highlight',
      color: '#d4a24e'
    })
    const kept = row('kept')
    const gone = row('gone')

    expect(removedValues([kept, gone], [kept])).toEqual(['gone'])
    expect(removedValues([kept], [kept])).toEqual([])
    // A re-run that draws nothing new removes nothing: the engine's own re-add
    // is idempotent (`overlayer.remove(value)` on the way in, `view.js:389`).
    expect(removedValues([], [kept])).toEqual([])
  })
})

describe('annotationGroups (R17)', () => {
  it('groups by the section’s own label, in document order', () => {
    const groups = annotationGroups([
      ann({ id: 'b', sectionLabel: 'Chapter 2', percent: 0.6 }),
      ann({ id: 'a', sectionLabel: 'Chapter 1', percent: 0.2 }),
      ann({ id: 'c', sectionLabel: 'Chapter 1', percent: 0.3 })
    ])

    expect(groups.map((group) => group.label)).toEqual(['Chapter 1', 'Chapter 2'])
    expect(groups[0].items.map((item) => item.id)).toEqual(['a', 'c'])
    expect(groups[1].items.map((item) => item.id)).toEqual(['b'])
  })

  it('names an unlabelled section by its place, the rule the find panel uses', () => {
    const groups = annotationGroups([
      ann({ id: 'a', sectionLabel: null, percent: 0.1 }),
      ann({ id: 'b', sectionLabel: 'Chapter 2', percent: 0.2 })
    ])
    expect(groups.map((group) => group.label)).toEqual(['Part 1', 'Chapter 2'])
  })

  it('breaks a tie on the fraction with the moment it was made', () => {
    const groups = annotationGroups([
      ann({ id: 'late', percent: 0.4, createdAt: '2026-10-13T12:00:00.000Z' }),
      ann({ id: 'early', percent: 0.4, createdAt: '2026-10-13T09:00:00.000Z' })
    ])
    expect(groups.flatMap((group) => group.items).map((item) => item.id)).toEqual(['early', 'late'])
  })

  it('is empty for a book nobody has annotated', () => {
    expect(annotationGroups([])).toEqual([])
  })
})

/**
 * AC19 — the delete dialog's copy names the notes (spec D4, reading R21).
 *
 * A string case, and the residue is stated rather than implied: it decides that
 * the sentence exists in the source, not that it is *rendered*. The rendering is
 * the manual frame. The dialog's own rules are in
 * `docs/invariants/files-and-deletion.md`.
 */
describe('the delete dialog’s copy (AC19)', () => {
  const DIALOG = readFileSync(
    join(process.cwd(), 'src', 'components', 'library', 'DeleteBookDialog.tsx'),
    'utf8'
  )

  /** Comments out, so a comment *about* the rule is documentation rather than a hit. */
  function uncommented(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/gm, '$1')
  }

  /** The two halves of the copy branch: the whole-book sentence, and the format one. */
  function branches(): { whole: string; partial: string } {
    const flat = uncommented(DIALOG).replace(/\s+/g, ' ')
    const start = flat.indexOf('This permanently removes')
    const end = flat.indexOf('</p>', start)
    if (start < 0 || end < 0) throw new Error('DeleteBookDialog has no copy paragraph to read')
    const [whole, partial] = flat.slice(start, end).split(') : (')
    if (!whole || !partial) throw new Error('the copy paragraph is not a two-branch ternary')
    return { whole, partial }
  }

  it('says a whole-book delete takes the notes, beside the covers and the metadata', () => {
    // The sentence this app already says about a different store — *"along with
    // its reading position and annotations"* on the device side — so a person who
    // has seen that dialog expects the library's delete to behave the same way.
    expect(branches().whole).toContain('notes')
  })

  it('does not say it about a single format, because the book and its notes stay', () => {
    // `deleteFormats` never touches a file that is not a book format
    // (`docs/invariants/files-and-deletion.md:17`), so naming the notes in this
    // branch would be a false sentence about a reversible action.
    const { partial } = branches()
    expect(partial).toContain('remaining')
    expect(partial).not.toContain('notes')
  })
})
