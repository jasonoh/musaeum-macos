import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Invariant 3, enforced: **nothing may read `formats[0]`.**
 *
 * The array holds whatever order the writing source left it in, so a position is
 * not a preference — `primaryFormat()` / `orderedFormats()` are the only readings
 * of it (`src/types/book.types.ts:169-189`). A positional read is a mis-pick that
 * no type can catch and no ordinary unit case sees, because the books it affects
 * are exactly the ones whose array disagrees with `FORMAT_ORDER`.
 *
 * **Why a source scan rather than a unit case:** the rule is about code that must
 * not exist. A behaviour test can only prove the call sites that exist today are
 * right; this fails on the next one, the moment it is written — which is the job
 * the invariant docs do for the other twelve rules.
 *
 * **Measured 2026-09-22, on the two sites this caught:** **1,372 of 7,100 books**
 * hold a first element that disagrees with the preferred format — one book in
 * five. `revealBook` revealed the PDF under an EPUB label, and the reader handed
 * the OS the PDF, for any book whose writer left the array in that order.
 */

/** Every `.ts`/`.tsx`/`.py` file under the trees the invariant governs. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, found)
    else if (/\.(ts|tsx|py)$/.test(entry) && !/\.test\./.test(entry)) found.push(path)
  }
  return found
}

/** A member index or `.at()` read of `formats` — the shape every violation has. */
const POSITIONAL = /\.formats\s*(\[|\.at\()/

describe('invariant 3 — no code reads `formats` by position', () => {
  it('has no positional read of `formats` anywhere outside the helpers that own the order', () => {
    const root = process.cwd()
    const offenders = ['src', 'electron', 'sidecar']
      .flatMap((tree) => sources(join(root, tree)))
      .flatMap((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .map((text, i) => ({ text: text.trim(), at: i + 1 }))
          // A whole-line comment that *names* the rule is documentation, not a read.
          .filter(({ text }) => !/^(\/\/|\*|\/\*)/.test(text) && POSITIONAL.test(text))
          .map(({ text, at }) => `${path.slice(root.length + 1)}:${at}  ${text.slice(0, 120)}`)
      )

    expect(offenders).toEqual([])
  })
})
