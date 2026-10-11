import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Releasing a held field is a change to the book's record, so like a save it
 * needs the library online (portable decisions, slice 1): an offline release
 * would be re-imposed by the next adoption. The service refuses
 * (`library-edit.releaseFieldOverride`); this pins that the editor does not
 * even offer the attempt. A walk cannot prove the chip is disabled — only that
 * the handler the chips are given returns early.
 */
const SOURCE = readFileSync(
  join(process.cwd(), 'src', 'components', 'library', 'BookEditor.tsx'),
  'utf8'
)

/** The text of `const <name> = async (...) => { ... }`, brace-matched. */
function bodyOf(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = `)
  expect(start, `${name} is declared`).toBeGreaterThanOrEqual(0)
  const open = SOURCE.indexOf('{', SOURCE.indexOf('=>', start))
  let depth = 0
  for (let i = open; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') depth++
    else if (SOURCE[i] === '}' && --depth === 0) return SOURCE.slice(open + 1, i)
  }
  throw new Error(`${name} has no closing brace`)
}

describe('BookEditor releaseOverride', () => {
  it('returns before calling the service while the library is offline', () => {
    const body = bodyOf('releaseOverride')
    expect(body).toMatch(/if \([^)]*!online[^)]*\) return/)
    expect(body.indexOf('!online')).toBeLessThan(body.indexOf('releaseFieldOverride'))
  })
})
