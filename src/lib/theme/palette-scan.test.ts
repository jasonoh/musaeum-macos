import { readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The renderer's source carries no stock Tailwind hue — slice 7b's decider.
 *
 * The parent spec's acceptance for the sweep is "the repo-wide grep reaching
 * zero", and a grep typed inside one session is an instrument that lives only
 * in that session: the next stock red text utility added to a component gets no
 * red from anywhere. This is the same predicate, in the gate.
 *
 * **What it decides:** no `.ts`/`.tsx`/`.css` under `src/` (nor a class in
 * `index.html`, which is in Tailwind's own `content` globs) names a
 * stock-palette colour utility. Test files are **included**, not exempted — the
 * note on composition below is what makes that possible.
 *
 * **What it does not decide** — the residue, deliberately:
 * - that a migrated class *emits* the rule it should. That is a Tailwind build
 *   fact and its instrument is the emitted-stylesheet read in the annex, not a
 *   source walk: a migrated name could be misspelled and this walk would pass.
 * - anything under `electron/` (no Tailwind classes there; the one mention of a
 *   retired name is a comment in `theme/derive.ts`) or `vendor/` (invariant
 *   #11 — never edited, and never scanned).
 * - **colour literals.** A hex string is not a utility, and
 *   `src/lib/theme/reader-palette.ts` owns a documented pair of derived
 *   baselines; scanning for literals would redden on the reader's own design.
 */
const STEMS = [
  'bg',
  'text',
  'border',
  'ring',
  'fill',
  'stroke',
  'divide',
  'from',
  'via',
  'to',
  'outline',
  'decoration',
  'placeholder',
  'caret',
  'accent',
  'shadow'
]
/** Tailwind's stock hues, including the neutrals the app has tokens for. */
const HUES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose'
]
/** Hues that take no step number: the bare whites and blacks. */
const NEUTRALS = ['white', 'black']

const STEPPED = `\\b(?:${STEMS.join('|')})-(?:${HUES.join('|')})-\\d{1,3}(?:/\\d{1,3})?\\b`
const BARE = `\\b(?:${STEMS.join('|')})-(?:${NEUTRALS.join('|')})(?:/\\d{1,3})?\\b`

/**
 * The predicate, built from the two lists rather than written as one literal.
 * `\b` holds before the stem through any variant prefix, and the alpha form is
 * part of the match. What comes back is the utility name, never the prefix — so
 * a `hover:` site prints as its bare name and an offender list reads like the
 * migration table it replaces.
 */
function stockHits(line: string): string[] {
  return [...line.matchAll(new RegExp(STEPPED, 'g')), ...line.matchAll(new RegExp(BARE, 'g'))].map(
    (m) => m[0]
  )
}

const SCANNED = ['.ts', '.tsx', '.css', '.html']
const ROOTS = [join(process.cwd(), 'src'), join(process.cwd(), 'index.html')]

function sourceFiles(): string[] {
  const found: string[] = []
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (SCANNED.some((ext) => entry.name.endsWith(ext))) found.push(child)
    }
  }
  visit(ROOTS[0])
  found.push(ROOTS[1])
  return found
}

/** `file:line  the names on it` — the same shape the session's grep printed. */
function offenders(): string[] {
  const found: string[] = []
  for (const file of sourceFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const hits = stockHits(line)
      if (hits.length) found.push(`${relative(process.cwd(), file)}:${i + 1}  ${hits.join(' ')}`)
    })
  }
  return found
}

describe('no stock Tailwind hue in the renderer source (AC8.4)', () => {
  it('walks the source, and the walk is not vacuous', () => {
    // A broken cwd (or a renamed directory) would make `offenders()` empty and
    // the next case pass for the wrong reason.
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(50)
    // Both roots and both shapes are really being walked: a root or an extension
    // dropped from the lists would leave the case above green over a smaller
    // tree than the criterion it stands for.
    expect(files.some((f) => f.endsWith('.tsx'))).toBe(true)
    expect(files.some((f) => f.endsWith('.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('index.html'))).toBe(true)
  })

  it('finds no stock-palette colour utility', () => {
    expect(offenders()).toEqual([])
  })

  /**
   * The anti-vacuity half: the pattern has to match the shapes the sweep
   * retires and *not* match the token names that replaced them. A pattern that
   * matched nothing at all would leave the case above green forever — which is
   * the failure mode this whole file exists to prevent.
   *
   * **The retired spellings are composed, never written.** This file lives under
   * `src/`, inside Tailwind's own `content` globs, so a literal stock utility
   * spelled here is scanned as a candidate: it emits a dead rule into the app's
   * stylesheet *and* it puts a stock hue back into the very tree this walk
   * asserts has none. (Measured — the first version of this file did both, and
   * the emitted-stylesheet read is what caught it.) Composing the names keeps
   * the acceptance grep and the built stylesheet at zero, which is why test
   * files need no exemption above.
   */
  it('matches every retired shape and no token shape', () => {
    const util = (...parts: string[]): string => parts.join('-')
    const retired = [
      util('text', 'red', '400'),
      `hover:${util('text', 'red', '400')}`,
      `disabled:${util('bg', 'red', '500')}/15`,
      `${util('border', 'red', '500')}/60`,
      util('bg', 'emerald', '500'),
      `${util('ring', 'white')}/5`,
      util('text', 'white'),
      util('bg', 'rose', '600')
    ]
    for (const sample of retired) {
      expect(stockHits(sample), sample).toEqual([sample.slice(sample.lastIndexOf(':') + 1)])
    }

    const tokens = [
      'text-danger-400',
      'hover:bg-danger-500/20',
      'border-danger-500/40',
      'bg-ok-500',
      'ring-parchment/5',
      'text-on-danger',
      'bg-gold-500/20',
      'text-parchment-faint',
      'shadow-cover',
      'whitespace-nowrap',
      'bg-ink-850/95'
    ]
    for (const sample of tokens) expect(stockHits(sample), sample).toEqual([])
  })
})
