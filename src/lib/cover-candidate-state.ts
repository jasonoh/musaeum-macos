import type { CoverCandidate } from '@shared/metadata.types'

/**
 * What a picker tile says about its candidate — the derivation, kept out of the
 * component on purpose.
 *
 * The renderer has no DOM harness, so a rule that lives inside a `.tsx` can only
 * be decided by an expensive running-app probe. This rule has four states and
 * three sentences, so it is the part of the picker a unit case can actually
 * pin — the same reasoning that put the cover URL in `src/lib/cover-url.ts`.
 *
 * Two things it refuses to restate: the candidate's own numbers (`applied` and
 * `winner` come from the sidecar, and re-deriving either here would be a second
 * answer to "what does the book have" and "what would a fetch write"), and the
 * provenance of the cover on disk. The cover's *source* is recorded nowhere, so
 * a tile says what is on the book **now** and never "the one you chose": a
 * cover that was resolved from a conflict, or replaced outside the app, is
 * byte-identical to nothing in this list, and a sentence claiming otherwise
 * would be the app telling the user something it cannot know.
 */

export type CandidateMark = 'applied' | 'winner' | 'both' | 'neither'

export interface CandidateTile {
  candidate: CoverCandidate
  mark: CandidateMark
  /** The tile's own one-line report; empty for a candidate with nothing to say. */
  label: string
}

export const TILE_LABELS: Record<CandidateMark, string> = {
  applied: 'On your book now',
  winner: 'A fetch would write this',
  both: 'On your book now — and a fetch would write it',
  neither: ''
}

/**
 * The book has none of these. Composed rather than fixed, because the two
 * halves are independent facts: every candidate can read `applied: false`, and
 * a gather can also mark *no* winner at all (the best-scoring image was dropped
 * for being undisplayable). A single sentence would claim a marked winner on
 * the second shape and be wrong.
 */
export const NONE_APPLIED =
  'None of these is the cover on your book now — it was resolved from a conflict, or replaced outside Musaeum.'

export const NONE_APPLIED_WITH_WINNER = `${NONE_APPLIED} The marked one is what a fetch would write.`

export const NONE_APPLIED_NO_WINNER = `${NONE_APPLIED} No fetch would write any of these.`

/**
 * The payload arrived with nothing in it.
 *
 * Not a state the picker is designed to show — a gather that cannot run refuses
 * with its own sentence, and a book with no file is refused before the sidecar
 * is called (AC16) — but a silently empty modal is exactly what a blank grid
 * looked like the last time this surface was wrong, so it gets copy rather
 * than an empty list.
 */
export const NO_CANDIDATES = 'The gather came back with no cover candidates for this book.'

/**
 * One candidate's mark. `applied` and `winner` are independent facts.
 */
export function candidateMark(candidate: CoverCandidate): CandidateMark {
  if (candidate.applied) return candidate.winner ? 'both' : 'applied'
  return candidate.winner ? 'winner' : 'neither'
}

/**
 * A candidate's identity, which is the pair `setCover` takes — **not** its source.
 *
 * This lives here rather than in the component because it is the rule the whole
 * picker rests on and it has a measured counterexample, while a `.tsx` rule of
 * this shape can only be decided by an expensive running-app probe. The gather
 * returns one entry per source, so a source-keyed rule was harmless there; the
 * searched group is not — measured on the book that motivated this feature: two
 * English MIT jackets, both `google_books`, 1352×2103 and 800×1245. Keyed by
 * source, picking one of those two lights up both tiles as the one being written
 * and then marks both as on the book, which is a claim about bytes the renderer
 * has no way to check.
 *
 * Proven needed by a mutation, not by argument: with this rule weakened to
 * `a.source === b.source`, every test in the repository still passed.
 */
export function sameCandidate(a: CoverCandidate, b: CoverCandidate): boolean {
  return a.source === b.source && a.url === b.url
}

/**
 * The same pair as a React key.
 *
 * `embedded` carries no url and needs no other branch: it is the only entry its
 * own source can have, because the file holds one jacket.
 */
export function tileKey(candidate: CoverCandidate): string {
  return `${candidate.source}:${candidate.url ?? ''}`
}

/**
 * One candidate per tile, with its mark and that mark's sentence.
 *
 * The mapping both groups use, on purpose: a searched tile carries exactly the
 * vocabulary a gathered one does — `applied` is byte identity in both, and
 * `candidateMark` is the only thing that decides a mark.
 */
function tilesOf(candidates: CoverCandidate[]): CandidateTile[] {
  return candidates.map((candidate) => {
    const mark = candidateMark(candidate)
    return { candidate, mark, label: TILE_LABELS[mark] }
  })
}

/**
 * The tiles to render, and the one book-level sentence that goes with them —
 * `null` in the ordinary case where a candidate is on the book.
 *
 * The order is the sidecar's (best first) and is not re-sorted: `winner` is the
 * head of the scored list, so a second sort here would be a second answer to
 * which jacket wins.
 */
export function candidateTiles(candidates: CoverCandidate[]): CoverTiles {
  const tiles = tilesOf(candidates)

  const applied = tiles.some((t) => t.mark === 'applied' || t.mark === 'both')
  if (applied) return { tiles, notice: null }
  if (!tiles.length) return { tiles, notice: NO_CANDIDATES }

  const winner = tiles.some((t) => t.mark === 'winner' || t.mark === 'both')
  return { tiles, notice: winner ? NONE_APPLIED_WITH_WINNER : NONE_APPLIED_NO_WINNER }
}

export interface CoverTiles {
  tiles: CandidateTile[]
  /** The one book-level sentence beside the tiles, or `null` for none. */
  notice: string | null
}

/**
 * The tiles and their sentence for a payload that may not be here yet.
 *
 * This exists because "nothing to derive yet" and "found nothing" are the same
 * empty array and must never read the same. `null` — a gather still in flight —
 * gets no sentence at all; only a payload that really arrived empty gets
 * `NO_CANDIDATES`. Measured in the real app: deriving from `candidates ?? []`
 * announced "no cover candidates for this book" for the whole of every gather,
 * which is a finding the app had not made and then contradicted.
 */
export function coverTiles(candidates: CoverCandidate[] | null): CoverTiles {
  return candidates === null ? { tiles: [], notice: null } : candidateTiles(candidates)
}

/**
 * The searched group's two sentences — the wider search's, never the gather's.
 *
 * The group's heading in the picker says where these tiles came from and that a
 * fetch would not write one of them; these say what is true of them now. What
 * they must never do is borrow the gather's vocabulary of *what a fetch would
 * write*: a fetch asks the gather's question and not this one (D3 of the
 * 2026-09-25 design), so no searched tile is a `winner` and no searched sentence
 * may offer one. `SEARCHED_NONE_APPLIED` therefore states the searched group's
 * own fact — a search offers jackets and never applies one — rather than
 * repeating `NONE_APPLIED`'s explanation of why the book wears something else,
 * which is the gather's sentence to say.
 */
export const NO_SEARCH_RESULTS = 'The wider search came back with no covers for this book.'

export const SEARCHED_NONE_APPLIED =
  'The cover on your book now is none of these — a search offers jackets and never applies one.'

/**
 * The tiles and the sentence for the wider search's hits — `candidateTiles`'
 * rule over the other payload.
 *
 * The rule is shared and the sentence is not, because the two groups' answers to
 * "what would a fetch write" are not the same answer. Which is also why this
 * does not branch on `winner`: the search forces every entry to `winner: false`,
 * so a sentence derived from that field could only restate a fact of the
 * *gather* — and the only marks a searched tile can carry are `applied` (byte
 * identity, true in both groups) and `neither`.
 *
 * The order is the search's and is not re-sorted, and duplicates are kept: two
 * editions of one book can both answer under one `source` (measured: the same
 * English jacket at 1352×2103 and 800×1245, both `google_books`), so a
 * source-keyed rule would drop one of the two best answers.
 */
export function searchedTiles(hits: CoverCandidate[]): CoverTiles {
  const tiles = tilesOf(hits)
  if (!tiles.length) return { tiles, notice: NO_SEARCH_RESULTS }

  const applied = tiles.some((t) => t.mark === 'applied' || t.mark === 'both')
  return { tiles, notice: applied ? null : SEARCHED_NONE_APPLIED }
}

/**
 * The same for a search that may not have run, or may still be running.
 *
 * `null` gets no sentence at all — `coverTiles`' rule one level down, and for
 * the same measured reason: slice 2 shipped a gather that announced "no cover
 * candidates for this book" for the whole of every gather and then contradicted
 * itself, because "nothing asked yet", "still asking" and "came back empty" are
 * the same empty array. An empty array that really arrived is the only shape
 * that earns `NO_SEARCH_RESULTS`.
 */
export function searchedCoverTiles(hits: CoverCandidate[] | null): CoverTiles {
  return hits === null ? { tiles: [], notice: null } : searchedTiles(hits)
}
