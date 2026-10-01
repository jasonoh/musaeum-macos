import { readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * D4, enforced in the gate: **the storage copy has one home, and it is the main
 * process** — and no surface names a server.
 *
 * The acceptance for this is a grep, and a grep typed inside one session is an
 * instrument that lives only in that session: the next component that types
 * *"Reconnect to the NAS to make changes."* by hand gets no red from anywhere.
 * This is the same predicate, in the gate. It is the sibling of
 * `theme/palette-scan.test.ts`, which makes the same argument for colour.
 *
 * **What it decides:**
 * - no `.ts`/`.tsx` under `src/` carries a bare `NAS` (comments excluded — the
 *   code deliberately keeps the internal `nas*` names, D8) or an `smb://` URL.
 * - no sentence the composer owns is restated in the renderer.
 *
 * **What it does not decide** — the residue, deliberately:
 * - that a surface *renders* the composed value. Only a rendered read can show
 *   that, and its instrument is the probe's frames (`musaeum-app-verification`),
 *   not a source walk: a component could read `copy.label` into a variable it
 *   never draws and this walk would pass.
 * - anything under `electron/` or `sidecar/`: the composer lives there, and the
 *   internal names are allowed to say NAS.
 * - prose *about* the code. Comments are stripped first, so a comment naming the
 *   rule — like this one — is documentation rather than a violation.
 */

const ROOT = process.cwd()
const COMPOSER = join(ROOT, 'electron/main/services/storage-copy.ts')

/**
 * The acronym, and the scheme, **composed rather than written**: this file lives
 * under `src/`, inside the tree it walks. A literal here would be a violation it
 * reported against itself — which is why the walk needs no test exemption, and
 * why the retired spellings below are assembled from parts.
 */
const ACRONYM = ['N', 'A', 'S'].join('')
const SCHEME = ['smb', '://'].join('')

/**
 * A bare acronym. `\b` is wrong here: `NASStatus`, `useNASStatus` and
 * `nasStatus` all contain the letters, and every one of them is a legitimate
 * name the codebase keeps (D8). What is left after the lookarounds is the
 * acronym standing alone — which in a stripped source means a string, a JSX
 * text node, or a new bare identifier.
 */
const BARE_NAS = new RegExp(`(?<![A-Za-z0-9_$])${ACRONYM}(?![A-Za-z0-9_$])`)
const SMB_URL = new RegExp(SCHEME, 'i')

/** Comments out, so a comment naming the rule is documentation, not a hit. */
function uncommented(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/gm, '$1')
}

/** Every file the walk covers. */
function rendererFiles(): string[] {
  const found: string[] = []
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (/\.tsx?$/.test(entry.name)) found.push(child)
    }
  }
  visit(join(ROOT, 'src'))
  return found
}

/** `file:line  what it says` — the shape a session's grep would have printed. */
function offenders(test: RegExp): string[] {
  const found: string[] = []
  for (const file of rendererFiles()) {
    uncommented(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        if (test.test(line))
          found.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 110)}`)
      })
  }
  return found
}

/**
 * The composer's own sentences, read from its source rather than restated here.
 *
 * Restating them would give the copy a second home — the exact thing this file
 * asserts does not exist — and would mean editing two files to reword one
 * sentence. Short literals (the labels, the field names) are dropped: a label is
 * a single common word and would redden on prose.
 */
function composedSentences(): string[] {
  return [...readFileSync(COMPOSER, 'utf8').matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g)]
    .map((match) => match[0].slice(1, -1))
    .filter((sentence) => sentence.length > 20 && sentence.includes(' '))
}

describe('the storage copy lives in main, and names no server (D4, AC11–12)', () => {
  it('walks the renderer, and the walk is not vacuous', () => {
    // A broken cwd would make every offender list empty and every case below
    // pass for the wrong reason
    const files = rendererFiles()
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((f) => f.endsWith('.tsx'))).toBe(true)
    expect(files.some((f) => f.endsWith('.ts'))).toBe(true)
    // The composer is really there to be read for its sentences
    expect(composedSentences().length).toBeGreaterThanOrEqual(5)
  })

  it(`finds no bare ${ACRONYM} and no SMB URL in any renderer file`, () => {
    // Reading 12, as a rule rather than as one repaired sentence: a user with no
    // NAS was shown "Reconnect to the NAS to make changes." The words a user
    // reads are derived from the kind now, so the acronym has no business in a
    // renderer string at all — and neither does a compiled-in share.
    expect([...offenders(BARE_NAS), ...offenders(SMB_URL)]).toEqual([])
  })

  it('finds none of the composer’s sentences restated in the renderer', () => {
    // The measured half. `NASStatusBanner`'s unconfigured sentence and
    // `SettingsModal`'s SMB hint were each written out by hand before this
    // slice; both are the composer's now, and this is what keeps them there.
    const restated: string[] = []
    for (const file of rendererFiles()) {
      const source = uncommented(readFileSync(file, 'utf8'))
      for (const sentence of composedSentences()) {
        if (source.includes(sentence)) {
          restated.push(`${relative(ROOT, file)}  ${sentence.slice(0, 80)}`)
        }
      }
    }
    expect(restated).toEqual([])
  })

  /**
   * The anti-vacuity half, in the palette scan's own style: the predicate has to
   * match the spellings this slice retired and *not* the names the codebase
   * keeps on purpose. A pattern that matched nothing would leave the case above
   * green forever.
   */
  it('matches the retired spellings and not the code’s own names', () => {
    const retired = [
      `This permanently deletes the selected file from the ${ACRONYM}.`,
      `The library is offline. Reconnect to the ${ACRONYM} to make changes.`,
      `${SCHEME}//nas`
    ]
    for (const sample of retired) {
      expect([BARE_NAS.test(sample), SMB_URL.test(sample)], sample).toContain(true)
    }

    // D8: the code keeps saying NAS where the UI says "library folder"
    const kept = [
      'NASStatus',
      'NASState',
      'NASStatusCopy',
      'useNASStatus',
      'nasStatus',
      'NAS_RECONNECT_BACKOFF_MS',
      'SMB URL'
    ]
    for (const sample of kept) {
      expect([BARE_NAS.test(sample), SMB_URL.test(sample)], sample).toEqual([false, false])
    }

    // And the comment-stripper is really stripping both shapes, since every
    // "kept" name above would otherwise be read out of the prose around it
    expect(BARE_NAS.test(uncommented(`  // a ${ACRONYM} write is not cheap`))).toBe(false)
    expect(BARE_NAS.test(uncommented(`{/* Removal needs no ${ACRONYM} */}`))).toBe(false)
    expect(BARE_NAS.test(uncommented(`'from the ${ACRONYM}.'`))).toBe(true)
    expect(SMB_URL.test(uncommented(`open -g '${SCHEME}//nas'`))).toBe(true)
  })
})
