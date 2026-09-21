import { describe, expect, it } from 'vitest'
import type { Book } from '@shared/book.types'
import { makeBook } from '../../test/helpers/book'
import { coverUrl } from './cover-url'

/**
 * The version in the cover URL is what makes a replaced cover repaint at all:
 * the filename is fixed, so without it Chromium answers the same string from
 * cache for the life of the row (measured — see `cover-url.ts`).
 */
function withCover(over: Partial<Book> = {}): Book {
  return {
    ...makeBook('a'),
    coverThumbPath: 'cover_thumb.jpg',
    coverFullPath: 'cover_full.jpg',
    lastModified: '2026-09-21T11:39:40.097Z',
    ...over
  }
}

describe('coverUrl', () => {
  it('carries the row’s clock as a version, for both sizes', () => {
    const book = withCover()

    expect(coverUrl(book, 'full')).toBe('musaeum://cover/a/full?v=2026-09-21T11%3A39%3A40.097Z')
    expect(coverUrl(book, 'thumb')).toBe('musaeum://cover/a/thumb?v=2026-09-21T11%3A39%3A40.097Z')
  })

  it('moves the version when the row moves — the point of the whole thing', () => {
    // A resolved cover conflict, a re-fetch and the editor all write the row and
    // move this clock; the URL changing is what makes the new bytes visible
    const before = coverUrl(withCover(), 'full')
    const after = coverUrl(withCover({ lastModified: '2026-09-21T11:39:41.000Z' }), 'full')

    expect(after).not.toBe(before)
  })

  it('answers null for a book with no cover, and never a versionless URL', () => {
    expect(coverUrl(withCover({ coverFullPath: null }), 'full')).toBeNull()
    expect(coverUrl(withCover({ coverThumbPath: null }), 'thumb')).toBeNull()
    // A row with no clock still gets a URL rather than `?v=` with nothing after
    // it — the version is the *change* signal, not a requirement to show a cover
    expect(coverUrl(withCover({ lastModified: null }), 'full')).toBe('musaeum://cover/a/full')
  })
})
