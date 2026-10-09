import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * AC3 of `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md`,
 * enforced: **nothing in the app names the Calibre conversion path.**
 *
 * Slice 3 deleted the resolution — the `ebook_convert_path` `app_config` key,
 * its Settings row, the `resolveEbookConvert` helper and the refusal a missing
 * install raised — so `convert_format` is now called with
 * `{input_path, output_path}` and nothing else. What is left to keep out is any
 * *new* site: a re-added detection, a re-added default install path, a request
 * that carries a converter path again.
 *
 * **Why a source walk rather than a unit case:** the rule is about code that
 * must not exist. A behaviour test can only pin the call sites that exist
 * today; this fails on the next one the moment it is written. AC3 has no other
 * decider available, because the claim is an absence over three trees.
 *
 * **Test files and whole-line comments are both skipped, deliberately.**
 * `sidecar/tests/test_converter.py` sends an extra `ebook_convert_path` key on
 * purpose, to pin that the dispatch reads *named* keys and so still tolerates a
 * key sent by an older caller — a walk that scanned it would redden on the very
 * case that proves the behaviour. And the rule is *documented by name* in
 * docblocks; a walk that flagged its own documentation could never be green.
 *
 * **The comment skip is line-leading, so a Python docstring body is not
 * covered.** The four markers are `#`, `//`, `*` and `/*`; a line inside a
 * triple-quoted docstring starts with none of them, so prose there naming one of
 * the four reads as a site. The one such line this slice removed
 * (`converter.py`'s "`ebook_convert_path` is accepted and ignored") was a true
 * statement about code that no longer exists, so nothing is left to flag — but a
 * later session writing a docstring *about* the removal should expect this walk
 * to object, and put the sentence in a `#` comment instead. The limit is stated
 * rather than closed: recognising docstring bodies needs a parser, and the
 * repo's own `test/invariants.test.ts` walk has the same boundary.
 *
 * **Scope is the three trees the criterion names.** `scripts/azw3-oracle.py`'s
 * `CALIBRE` constant is the one sanctioned Calibre-as-a-tool use and lives
 * outside them; `sidecar/extractors/calibre_db.py` reads a Calibre *database*
 * (never an install) and spells none of these four.
 */

/** The four spellings slice 3 removed. Each is what a stray site would type. */
const FORBIDDEN = ['ebook-convert', 'ebook_convert_path', 'ebookConvertPath', 'calibre.app']

/** Every source file under a governed tree, minus the test suites. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      // `sidecar/tests/` is the Python suite — `test_*.py`, which `*.test.*`
      // does not match, so the directory itself is the skip rule.
      if (entry === 'tests' || entry === '__tests__') continue
      sources(path, found)
    } else if (/\.(ts|tsx|py)$/.test(entry) && !/\.test\./.test(entry)) found.push(path)
  }
  return found
}

describe('AC3 — the app no longer names a Calibre conversion path', () => {
  it('has none of the four in electron/main, src or sidecar', () => {
    const root = process.cwd()
    const offenders = ['electron/main', 'src', 'sidecar']
      .flatMap((tree) => sources(join(root, tree)))
      .flatMap((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .map((text, i) => ({ text: text.trim(), at: i + 1 }))
          // A whole-line comment that *names* one of them is documentation, not a site.
          .filter(({ text }) => !/^(\/\/|\*|\/\*|#)/.test(text))
          .filter(({ text }) => FORBIDDEN.some((name) => text.includes(name)))
          .map(({ text, at }) => `${path.slice(root.length + 1)}:${at}  ${text.slice(0, 120)}`)
      )

    expect(offenders).toEqual([])
  })
})
