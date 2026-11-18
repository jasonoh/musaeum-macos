import { describe, expect, it } from 'vitest'
import { matchShelfMembershipPath, matchShelfPositionPath } from './routes'

/**
 * The position path's cases (reading-queue slice 3, Task 3; design D6).
 *
 * `routes.ts`'s book and membership matchers are decided in `query.test.ts`,
 * because the split's file row is that pair and `matchBookPath` is one of the
 * moved functions. This file exists for the one property slice 3 adds: **a
 * path has exactly one meaning**, so the membership shape and the position
 * shape are two matchers that cannot both claim the same path. Every case below
 * is a fact about the pair as much as about one function — the disjointness
 * assertions are the reason a widened `matchShelfMembershipPath` was rejected
 * (R1), and they are pinned here so a later "simplification" that folds the two
 * together has to delete a case rather than quietly change an answer.
 *
 * Socketless, like its sibling: a string in, a decision out.
 */

describe('matchShelfPositionPath — the position write (reading-queue D6)', () => {
  it('names both ids for the one shape it answers', () => {
    expect(matchShelfPositionPath('/api/shelves/abc/books/def/position')).toEqual({
      shelfId: 'abc',
      bookId: 'def'
    })
  })

  it('decodes both segments, so an id with a space or a slash is still an id', () => {
    // A book id is opaque; `%2F` in one must come back as a slash rather than
    // splitting the path into a sixth segment
    expect(matchShelfPositionPath('/api/shelves/a%20b/books/c%2Fd/position')).toEqual({
      shelfId: 'a b',
      bookId: 'c/d'
    })
  })

  it('does not match the membership path, which has no trailing segment', () => {
    // The whole reason this is a second matcher: `…/books/{bookId}` is the
    // membership write, and reading it here would give one path two meanings
    expect(matchShelfPositionPath('/api/shelves/abc/books/def')).toBeNull()
  })

  it.each([
    // A sixth segment, a trailing slash, and a segment after `position`
    '/api/shelves/abc/books/def/position/extra',
    '/api/shelves/abc/books/def/position/',
    '/api/shelves/abc/books/def/position/extra/more',
    // Missing segments — the shape needs all five
    '/api/shelves/abc/books/position',
    '/api/shelves/abc/position',
    '/api/shelves/position',
    '/api/shelves/abc/books',
    '/api/shelves/abc',
    '/api/shelves/',
    '/api/shelves',
    // Empty segments
    '/api/shelves//books/def/position',
    '/api/shelves/abc/books//position',
    '/api/shelves//books//position',
    // The literal is `books`, and the last segment is exactly `position`
    '/api/shelves/abc/shelf/def/position',
    '/api/shelves/abc/books/def/Position',
    '/api/shelves/abc/books/def/positions',
    // Another route entirely
    '/api/books/abc/position',
    '/api/library'
  ])('answers null for a path that is not the position shape (%s)', (pathname) => {
    expect(matchShelfPositionPath(pathname)).toBeNull()
  })

  it('answers null for a malformed escape rather than throwing', () => {
    // The book matcher's own rule: an id that cannot be decoded is not this
    // route's path, and the router answers 404 uniformly (D11)
    expect(matchShelfPositionPath('/api/shelves/%E0%A4%A/books/b/position')).toBeNull()
    expect(matchShelfPositionPath('/api/shelves/a/books/%/position')).toBeNull()
    expect(matchShelfPositionPath('/api/shelves/a/books/b%2/position')).toBeNull()
  })
})

describe('the two shelf matchers cannot both claim a path (R1)', () => {
  it('leaves the position path to the position matcher', () => {
    // Pinned rather than newly true: `matchShelfMembershipPath` refuses any
    // extra segment (`rest.length`), and that check is what slice 3 keeps
    // instead of widening. A known path behind the wrong method is still the
    // uniform 404 (D11) — but a *path* that is a different route must never be
    // matched by this one as a membership edit.
    expect(matchShelfMembershipPath('/api/shelves/abc/books/def/position')).toBeNull()
  })

  it.each([
    '/api/shelves/abc/books/def',
    '/api/shelves/abc/books/def/position',
    '/api/shelves/abc/books/def/position/extra',
    '/api/shelves/abc/books/def/extra',
    '/api/shelves/abc/books/position',
    '/api/shelves//books/def',
    '/api/shelves//books/def/position',
    '/api/books/abc'
  ])('claims at most one meaning for %s', (pathname) => {
    const membership = matchShelfMembershipPath(pathname)
    const position = matchShelfPositionPath(pathname)

    expect(membership !== null && position !== null).toBe(false)
  })
})
