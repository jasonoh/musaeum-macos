import { promises as fs, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mobiFile, mobiRecordZero } from '../../../test/helpers/mobi'
import { isMobiFamily, parseMobiRecordZero, readEmbeddedIdentity } from './mobi-header'
import { sanitizeTitle } from './sanitize'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'musaeum-mobi-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a file and read its identity back the way the device pass does. */
async function identityOf(name: string, bytes: Buffer): Promise<unknown> {
  const path = join(dir, name)
  await fs.writeFile(path, bytes)
  return readEmbeddedIdentity(path)
}

describe('readEmbeddedIdentity', () => {
  it('reads the title and author out of a real-shaped header', async () => {
    const identity = await identityOf(
      'a.azw3',
      mobiFile({
        title: 'Against a Dark Background',
        author: 'Banks, Iain M.',
        uuid: '26ff164d-f8d1-4588-b0e7-45fffa91c871',
        cdetype: 'EBOK'
      })
    )

    expect(identity).toMatchObject({
      title: 'Against a Dark Background',
      uuid: '26ff164d-f8d1-4588-b0e7-45fffa91c871',
      cdetype: 'EBOK'
    })
    // The author is Calibre's spelling of the same person the library calls
    // "Iain M. Banks" — and it is NUL-padded to a 4-byte boundary, which is
    // what 3,788 of 36,259 EXTH records on a measured Kindle do. The padding
    // survives this far on purpose: what removes it is `sanitizeTitle`, which
    // is also what makes the comparison case- and punctuation-insensitive.
    expect(identity).toHaveProperty('author', 'Banks, Iain M.\u0000\u0000')
    expect(sanitizeTitle('Banks, Iain M.\u0000\u0000')).toBe('Banks, Iain M.')
  })

  it('finds the title in a record 0 that runs past 16 KB', async () => {
    // A long EXTH — blurb, tag list — pushes record 0 past any fixed window.
    // Measured on a real Kindle: 67 files. A fixed 16 KB read loses the title
    // on all of them, which is why the record table sizes the read instead.
    const identity = await identityOf(
      'big.mobi',
      mobiFile({ title: 'The Algebraist', author: 'Iain M. Banks', filler: 20_000 })
    )

    expect(identity).toMatchObject({ title: 'The Algebraist' })
  })

  it('follows the header length instead of assuming the usual one', async () => {
    // Real files on one Kindle carried MOBI header lengths of 232, 248, 256
    // and 264, and EXTH starts at `0x10 + length`
    const identity = await identityOf(
      'long-header.azw3',
      mobiFile({
        title: 'Excession',
        author: 'Iain M. Banks',
        headerLength: 264,
        nulPadded: false
      })
    )

    expect(identity).toMatchObject({ title: 'Excession', author: 'Iain M. Banks' })
  })

  it('reads EXTH by its magic, whatever the flag says', async () => {
    const identity = await identityOf(
      'no-flag.azw3',
      mobiFile({
        title: 'Feersum Endjinn',
        author: 'Iain M. Banks',
        exthFlag: 0,
        nulPadded: false
      })
    )

    expect(identity).toMatchObject({ title: 'Feersum Endjinn', author: 'Iain M. Banks' })
  })

  it('reads a header with no author rather than refusing the file', async () => {
    // A header carrying the flag with no EXTH block is "no author", not
    // "unreadable": the title alone carries the book where the library holds
    // exactly one book with it
    const identity = await identityOf(
      'flag-no-exth.mobi',
      mobiFile({ title: 'Autocracy, Inc.', withExth: false })
    )

    expect(identity).toEqual({ title: 'Autocracy, Inc.', author: null, uuid: null, cdetype: null })
  })

  it('returns nothing readable for a file that is not a book', async () => {
    expect(await identityOf('garbage.azw3', Buffer.from('not a mobi at all'))).toBeNull()
    expect(await identityOf('empty.azw3', Buffer.alloc(0))).toBeNull()
    expect(await identityOf('short.mobi', Buffer.alloc(40))).toBeNull()
  })

  /**
   * "No title in it" and "we could not read it" are different facts, and only
   * the first is worth remembering. A read failure at the mount (a volume
   * unplugged mid-pass, an EIO — both seen on a real Kindle) must not be cached
   * as a property of the book: that would leave it reading as absent until the
   * file next changed. So those throw, and the pass records nothing.
   */
  it('throws rather than answering when the file cannot be read at all', async () => {
    await expect(readEmbeddedIdentity(join(dir, 'missing.mobi'))).rejects.toThrow()
    await expect(readEmbeddedIdentity(dir)).rejects.toThrow()
  })

  it('returns nothing readable when record 0 cannot be located', async () => {
    // One record gives the read no end, and a truncated record table is what a
    // volume mid-unmount looks like — both are "no identity", not an error
    const single = mobiFile({ title: 'Nowhere' })
    single.writeUInt16BE(1, 76)

    expect(await identityOf('one-record.mobi', single)).toBeNull()
  })

  it('refuses a record 0 that is not a MOBI header', async () => {
    expect(parseMobiRecordZero(Buffer.alloc(300, 0x20))).toBeNull()
    expect(parseMobiRecordZero(Buffer.alloc(8))).toBeNull()
    expect(parseMobiRecordZero(mobiRecordZero({ title: 'Serialization' }))).toMatchObject({
      title: 'Serialization'
    })
  })
})

describe('isMobiFamily', () => {
  it('claims the extensions whose identity we can read, and no others', () => {
    for (const name of ['a.mobi', 'a.azw3', 'a.azw', 'A.AZW3']) {
      expect(isMobiFamily(name)).toBe(true)
    }
    // `.kfx` has no header we can parse and `.pdf` keeps its title somewhere
    // else entirely: both fall back to the filename rule
    for (const name of ['a.kfx', 'a.pdf', 'a.epub', 'noext', '.azw3']) {
      expect(isMobiFamily(name)).toBe(false)
    }
  })
})
