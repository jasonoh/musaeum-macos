import { describe, expect, it } from 'vitest'
import type { CoverCandidate } from '@shared/metadata.types'
import { makeBook } from '../../test/helpers/book'
import {
  NONE_APPLIED,
  NONE_APPLIED_NO_WINNER,
  NONE_APPLIED_WITH_WINNER,
  NO_CANDIDATES,
  NO_SEARCH_RESULTS,
  SEARCHED_NONE_APPLIED,
  TILE_LABELS,
  UPLOAD_APPLIED,
  UPLOAD_TRIGGER_LABEL,
  UPLOAD_TRIGGER_LINE,
  candidateMark,
  candidateTiles,
  coverTiles,
  coverUploadReading,
  sameCandidate,
  searchedCoverTiles,
  searchedTiles,
  tileKey,
  uploadCopy,
  uploadRefusal
} from './cover-candidate-state'

/**
 * The tiles' own rule: which candidate is marked what, and what the picker says
 * when the book is wearing none of them.
 *
 * `applied` and `winner` are the sidecar's two facts and are set here rather
 * than derived — a fixture that computed them would be a second implementation
 * of `summarise_candidates`, and the case would then pass while the payload was
 * wrong.
 */
function candidate(over: Partial<CoverCandidate> = {}): CoverCandidate {
  return {
    source: 'openlibrary',
    url: 'https://covers.openlibrary.org/b/id/1-L.jpg',
    width: 304,
    height: 500,
    score: 0.5275,
    winner: false,
    applied: false,
    thumb: 'data:image/jpeg;base64,AAAA',
    ...over
  }
}

/** The file's own jacket: no `url` *key*, which is what makes it an extraction. */
const embedded: CoverCandidate = embeddedCandidate({
  width: 800,
  height: 514,
  score: 0.5249
})

/**
 * The absent-url shape, built by deletion rather than by hand: the sidecar's
 * payload omits the key for `embedded` (it is never `null`), and a fixture that
 * simply left it off would still carry it the moment `candidate()`'s defaults
 * change — which is exactly the field this slice asserts on.
 */
function embeddedCandidate(over: Partial<CoverCandidate> = {}): CoverCandidate {
  const c = candidate({ source: 'embedded', ...over })
  delete c.url
  return c
}

/**
 * One hit from the wider search.
 *
 * The numbers are the ones 2026-09-25 measured on the book this feature exists
 * for — the English MIT jacket at 1352×2103 — and `secondHit` is its twin at
 * 800×1245: the same design, the same `source`, two answers. That pair is why
 * the searched group is keyed by the candidate and not by its source.
 *
 * `winner: false` is written here and not derived: it is the search's own
 * contract (D3 — a fetch would not write a jacket it never asked for, so the
 * sidecar forces it). A fixture that computed it would be a second
 * implementation of that force, and the case would pass while the payload lied.
 */
function searchHit(over: Partial<CoverCandidate> = {}): CoverCandidate {
  return candidate({
    source: 'google_books',
    url: 'https://books.google.com/books/content?id=9eRVDwAAQBAJ&printsec=frontcover',
    width: 1352,
    height: 2103,
    score: 0.9722,
    winner: false,
    ...over
  })
}

/** The other half of the measured pair: the same jacket, 800×1245. */
const secondHit: CoverCandidate = searchHit({
  url: 'https://books.google.com/books/content?id=B-VVDwAAQBAJ&printsec=frontcover',
  width: 800,
  height: 1245,
  score: 0.9282
})

describe('candidateMark', () => {
  it('reads the two flags independently, so a candidate can be both', () => {
    expect(candidateMark(candidate({ applied: true, winner: true }))).toBe('both')
    expect(candidateMark(candidate({ applied: true }))).toBe('applied')
    expect(candidateMark(candidate({ winner: true }))).toBe('winner')
    expect(candidateMark(candidate())).toBe('neither')
  })

  it('marks the winner even when the book is wearing something else', () => {
    const { tiles } = candidateTiles([
      candidate({ winner: true }),
      candidate({ source: 'google_books', applied: true })
    ])

    expect(tiles.map((t) => t.mark)).toEqual(['winner', 'applied'])
  })

  it('says nothing about a candidate that is neither', () => {
    const { tiles } = candidateTiles([embedded, candidate({ winner: true })])

    expect(tiles[0].label).toBe('')
    expect(tiles[1].label).toBe('A fetch would write this')
  })
})

describe('coverTiles', () => {
  it('says nothing while the gather is still in flight', () => {
    // The measured bug: deriving from `candidates ?? []` made a running gather
    // announce "no cover candidates for this book" and then contradict itself
    expect(coverTiles(null)).toEqual({ tiles: [], notice: null })
  })

  it('gets the empty-payload sentence only from a payload that really arrived empty', () => {
    expect(coverTiles([])).toEqual({ tiles: [], notice: NO_CANDIDATES })
    expect(coverTiles([candidate({ applied: true })]).notice).not.toBe(NO_CANDIDATES)
  })
})

describe('candidateTiles', () => {
  it('has no book-level sentence while one candidate is on the book', () => {
    expect(candidateTiles([candidate({ applied: true })]).notice).toBeNull()
    expect(candidateTiles([candidate({ applied: true, winner: true })]).notice).toBeNull()
  })

  it('says so when the book is wearing none of them, and names the winner it can still mark', () => {
    // The real case, measured on *Star Maker* (2026-09-21) and again on this
    // library's Spanish-edition match (2026-09-25): a cover written outside the
    // candidate set — an older conflict resolution, a folder restored from a
    // backup — makes every `applied` false. Silence here is what would look
    // broken.
    const { tiles, notice } = candidateTiles([
      candidate({ winner: true }),
      embedded,
      candidate({ source: 'google_books' })
    ])

    expect(tiles.every((t) => t.mark !== 'applied' && t.mark !== 'both')).toBe(true)
    expect(notice).toBe(NONE_APPLIED_WITH_WINNER)
  })

  it('does not claim a marked winner when the gather could not offer one', () => {
    // Reachable: the best-scoring image whose pixels do not load is dropped
    // from the payload (reading 6 of the slice 1b annex), so no entry carries
    // `winner` and a sentence naming one would be the app inventing a fact.
    const { tiles, notice } = candidateTiles([candidate(), embedded])

    expect(tiles.every((t) => t.candidate.winner === false)).toBe(true)
    expect(tiles.every((t) => t.mark === 'neither')).toBe(true)
    expect(notice).toBe(NONE_APPLIED_NO_WINNER)
  })

  it('keeps the sidecar’s order and its thumbs verbatim', () => {
    // The payload's `thumb` is a `data:` URL and is the renderer's only legal
    // way to show a candidate at all (the CSP names no remote origin) — so the
    // derivation must not rewrite it, and must not re-sort the list it was
    // handed (`winner` is the head of the sidecar's own scored list).
    const { tiles } = candidateTiles([candidate({ winner: true }), embedded])

    expect(tiles.map((t) => t.candidate.source)).toEqual(['openlibrary', 'embedded'])
    expect(tiles[0].candidate.thumb).toBe('data:image/jpeg;base64,AAAA')
    // …and the file's own candidate still has no url, in the payload as here
    expect('url' in tiles[1].candidate).toBe(false)
  })

  it('gives an empty payload its own sentence rather than the none-is-yours one', () => {
    // A gather that cannot run refuses with its own message (AC16), so this is
    // a payload that should not happen — but "none of these is on your book"
    // over an empty grid would read as a working picker showing nothing.
    expect(candidateTiles([])).toEqual({ tiles: [], notice: NO_CANDIDATES })
  })
})

describe('searchedCoverTiles', () => {
  it('says nothing at all while the search is still running', () => {
    // The slice-2 defect, one level down: `searched ?? []` would make every
    // search announce "no covers for this book" for as long as it ran and then
    // contradict itself. `null` is "asked for and not back", and it is silent —
    // the spinner is the only thing that may speak for a search in flight.
    expect(searchedCoverTiles(null)).toEqual({ tiles: [], notice: null })
  })

  it('gives the empty sentence only to a search that really came back empty', () => {
    // Two findings that must never read alike. `[]` is a search that answered
    // with nothing, and it is the only shape that earns the sentence.
    expect(searchedCoverTiles([])).toEqual({ tiles: [], notice: NO_SEARCH_RESULTS })
    expect(searchedCoverTiles([searchHit()]).tiles).toHaveLength(1)
    expect(searchedCoverTiles([searchHit()]).notice).not.toBe(NO_SEARCH_RESULTS)

    // …and it is the searched group's own sentence, not the gather's, which is
    // about a different call with a different answer.
    expect(NO_SEARCH_RESULTS).not.toBe(NO_CANDIDATES)
  })
})

describe('searchedTiles', () => {
  it('keeps every hit, two under one source among them, and re-orders nothing', () => {
    // Measured on the book this feature exists for: two English MIT jackets, the
    // same design at two sizes, both `google_books`. A rule keyed by `source`
    // would collapse them into one tile and silently drop the better answer.
    //
    // Handed over worst-first on purpose. The search's own payload is best-first,
    // and on a payload already in that order a re-sort here is invisible —
    // measured, that mutation survived this case. What is pinned is the weaker
    // but real property: this derivation re-orders nothing it is given.
    const { tiles } = searchedTiles([secondHit, searchHit()])

    expect(tiles.map((t) => t.candidate.url)).toEqual([secondHit.url, searchHit().url])
    expect(tiles.map((t) => t.candidate.source)).toEqual(['google_books', 'google_books'])
    // The thumb is the renderer's only legal way to show a hit (the CSP names no
    // remote origin), so it crosses this derivation untouched
    expect(tiles[0].candidate.thumb).toBe('data:image/jpeg;base64,AAAA')
  })

  it('never offers the fetched mark, and says the searched sentence instead', () => {
    // AC9. The group's standing is that no fetch would write one of these, so no
    // searched tile may carry the label the gather's tiles carry for it, and the
    // group's sentence may not claim it either.
    const { tiles, notice } = searchedTiles([searchHit(), secondHit])

    expect(tiles.every((t) => t.candidate.winner === false)).toBe(true)
    expect(tiles.every((t) => t.mark === 'neither')).toBe(true)
    expect(tiles.every((t) => t.label !== TILE_LABELS.winner)).toBe(true)
    expect(tiles.every((t) => t.label !== TILE_LABELS.both)).toBe(true)

    // A sentence of its own — not the gather's, in any of its three shapes
    expect(notice).toBe(SEARCHED_NONE_APPLIED)
    expect(notice).not.toBe(NONE_APPLIED)
    expect(notice).not.toBe(NONE_APPLIED_NO_WINNER)
    expect(notice).not.toBe(NONE_APPLIED_WITH_WINNER)
    expect(notice).not.toBe(NO_CANDIDATES)
  })

  it('marks a hit the book is wearing, and only that one', () => {
    // `applied` is byte identity and is true in both groups (D3), so a searched
    // tile can be the one on the book — and then the group needs no book-level
    // sentence, by the same rule the gather's has.
    const { tiles, notice } = searchedTiles([searchHit({ applied: true }), secondHit])

    expect(tiles.map((t) => t.mark)).toEqual(['applied', 'neither'])
    expect(tiles[0].label).toBe(TILE_LABELS.applied)
    expect(tiles[1].label).toBe('')
    expect(notice).toBeNull()
  })
})

/**
 * Identity is the pair `setCover` takes, never the source.
 *
 * These cases exist because a mutation proved they had to: weakening the rule to
 * `a.source === b.source` left **every test in the repository passing**, so the
 * rule that keeps two same-source tiles apart had nothing deciding it at all.
 * The counterexample is measured, not hypothetical — the book this feature was
 * built for returns two `google_books` jackets (1352×2103 and 800×1245), and the
 * whole point of the searched group is that a user can pick between them.
 */
describe('sameCandidate — identity is the pair, not the source', () => {
  it('two jackets from one source are two candidates', () => {
    const ebook = candidate({
      source: 'google_books',
      url: 'https://books.google.com/x?id=9eRVDwAAQBAJ'
    })
    const paperback = candidate({
      source: 'google_books',
      url: 'https://books.google.com/x?id=B-VVDwAAQBAJ',
      width: 800,
      height: 1245
    })

    expect(sameCandidate(ebook, paperback)).toBe(false)
    // …which is what makes them two tiles with two keys, and what stops a pick
    // from marking both as the book's own cover.
    expect(new Set([tileKey(ebook), tileKey(paperback)]).size).toBe(2)
  })

  it('is a candidate itself', () => {
    const jacket = candidate()

    expect(sameCandidate(jacket, jacket)).toBe(true)
    expect(tileKey(jacket)).toBe(`${jacket.source}:${jacket.url}`)
  })

  it('the file’s own jacket is the one candidate with no url, and still needs no other branch', () => {
    // One jacket per file, so a source-keyed key is unambiguous for exactly one
    // source — and the pair form has to keep working when the url is absent.
    expect(sameCandidate(embedded, embedded)).toBe(true)
    expect(tileKey(embedded)).toBe('embedded:')
    expect(sameCandidate(embedded, candidate({ source: 'embedded', url: undefined }))).toBe(true)
  })

  it('a different source is a different candidate, whatever the url', () => {
    const url = 'https://example.test/jacket.jpg'

    expect(
      sameCandidate(
        candidate({ source: 'google_books', url }),
        candidate({ source: 'openlibrary', url })
      )
    ).toBe(false)
  })
})

/**
 * The third source: an image of the user's own (D6, AC11–AC13).
 *
 * The control's copy and its two decisions live in the module for the same
 * reason the other two groups' do — a rule inside a `.tsx` can only be decided
 * by a running-app probe — and the two decisions are the ones a probe would
 * otherwise be the *only* thing to catch: a cancellation that reads as a
 * failure, and a landed upload that leaves the gather's explanation of an
 * unmarked grid standing.
 */
describe('the upload control’s copy', () => {
  it('says where the image comes from, and promises no search and no fetch', () => {
    // The dialog that picks the file is macOS's and the path never crosses the
    // boundary (D6-a), so where the image comes from is the one thing this copy
    // owes the reader. The two negatives are the other half of the same rule:
    // nothing is searched and nothing is fetched, so neither word may appear —
    // a line borrowing the search's language would describe a round trip the
    // gesture does not make, and one borrowing the gather's would claim a
    // `winner` that cannot exist for a file the app was handed (D6-b).
    expect(UPLOAD_TRIGGER_LABEL).toContain('image')
    expect(UPLOAD_TRIGGER_LINE).toContain('this Mac')
    expect(UPLOAD_TRIGGER_LINE).toContain('dialog')

    expect(UPLOAD_TRIGGER_LABEL).not.toMatch(/search/i)
    expect(UPLOAD_TRIGGER_LINE).not.toMatch(/search|fetch/i)
  })

  // There is no case here for "no busy sentence": the rule that this dialog shows
  // no line while the file sheet is open is a *removal*, and the only test that
  // could stand for it would scan this module for words like "writing" — pinning
  // prose rather than behaviour, and failing on any later sentence that happens to
  // use them. The reasoning lives in the block comment above `UPLOAD_APPLIED` and
  // in the diff; the honest deciders around it — the landed sentence, the refusal
  // in the service's own words, and a cancellation's silence — are the cases above
  // and below.
})

describe('coverUploadReading — what the upload call’s answer means', () => {
  it('reads a cancellation as an answer of its own, not as a failure', () => {
    // `CoverUploadOutcome`'s two arms: the book the write produced, or
    // `{cancelled: true}`. Only the second changes nothing, and this is the
    // case that decides the branch the whole gesture's honesty rests on.
    expect(coverUploadReading({ cancelled: true })).toEqual({ kind: 'cancelled' })
    expect(coverUploadReading(makeBook('re-dressed'))).toEqual({ kind: 'settled' })
  })
})

describe('uploadCopy — the dialog’s line, and the gather’s notice', () => {
  it('says nothing at all for a cancellation, and for nothing asked yet', () => {
    // The silent states are the point of the rule: a line for a cancellation
    // would report a failure that did not happen, and the person who closed the
    // dialog needs no notification that they did. Asked-yet and cancelled are
    // the same silence on purpose — neither is news about the book.
    expect(uploadCopy(null)).toEqual({ line: null, gatherNotice: true })
    expect(uploadCopy({ kind: 'cancelled' })).toEqual({ line: null, gatherNotice: true })
  })

  it('reports a landed image, and stands the gather’s explanation down', () => {
    // AC11's copy half. After an upload every gathered tile loses `applied` (an
    // uploaded rendition is byte-identical to nothing the gather returned), so
    // the dialog's own sentence is the true explanation of its own action —
    // where the gather's would name a cause that is not what happened:
    // *"resolved from a conflict, or replaced outside Musaeum"*. Only one of
    // the two may print.
    expect(uploadCopy({ kind: 'settled' })).toEqual({
      line: UPLOAD_APPLIED,
      gatherNotice: false
    })
    // The landed sentence reports the book and not the button that was pressed,
    // and it stands in for a different sentence rather than varying it
    expect(UPLOAD_APPLIED).toContain('cover on this book')
    expect(UPLOAD_APPLIED).not.toBe(NONE_APPLIED)
    expect(UPLOAD_APPLIED).not.toMatch(/conflict|outside Musaeum/)
  })
})

describe('uploadRefusal — the sentence a refused file prints', () => {
  it('prints the call’s own words, verbatim', () => {
    // The guard's sentence is what makes a refusal actionable ("not an image"
    // and "under 120 px" are two different corrections a person can make), so
    // this rule passes it through untouched rather than composing a general one
    const sentence = 'That image is too small — a cover needs at least 120 px on both sides'
    expect(uploadRefusal(new Error(sentence))).toBe(sentence)
  })

  it('still says something when the rejection is not an Error', () => {
    // `sidecar.call` rejects with an Error, but a rejection is `unknown` by
    // type and a rule that returned '' here would print an empty line where the
    // user is waiting to be told what happened
    expect(uploadRefusal('sidecar refused')).toBe('sidecar refused')
  })
})
