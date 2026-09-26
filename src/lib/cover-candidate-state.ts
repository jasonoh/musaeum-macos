import type { CoverUploadOutcome } from '@shared/api.types'
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

/**
 * The third source, and the only one whose bytes come from nowhere else: an
 * image of the user's own.
 *
 * It is the picker's *second* control rather than a mode of the first, because
 * the search trigger and this one are the same kind of thing — a source the
 * gather cannot reach — while the things they do have nothing in common. The
 * copy below has three obligations and they pull in different directions:
 *
 * 1. **It says where the image comes from**, because that is the part a person
 *    cannot see: the dialog is macOS's and the renderer never receives the
 *    path (`chooseCoverFromFile` carries a bookId and nothing else, D6-a), so
 *    "a file on this Mac, chosen in Musaeum's own dialog" is the whole of what
 *    this control can honestly promise.
 * 2. **It must not borrow the search's language.** Nothing is searched, no
 *    database is asked and no network is reached — `set_cover_from_file` reads
 *    one file the user pointed at — so a line that said it searched anything
 *    would be the app describing a round trip it does not make. That is why
 *    the sentence names the Mac and the dialog rather than an edition.
 * 3. **It must not borrow the gather's either.** No uploaded image can ever be
 *    "what a fetch would write": `winner` is a fact about a pool a fetch
 *    assembled, and a fetch cannot assemble this. The upload is a write, not a
 *    candidate (D6-b), which is also why there is no fourth `MetadataSource`.
 *
 * These live here rather than in the component for the reason every rule in
 * this app does: the renderer has no DOM harness, so copy written into a `.tsx`
 * can only be decided by an expensive running-app probe, while a sentence in a
 * plain module is pinned by a unit case.
 */
export const UPLOAD_TRIGGER_LABEL = 'Choose an image…'

export const UPLOAD_TRIGGER_LINE =
  'Uses an image file from this Mac, chosen in Musaeum’s own dialog.'

/**
 * There is deliberately **no sentence for the upload in flight.**
 *
 * There was one — *"Writing that image as the cover…"* — and it was removed
 * because it cannot be true for the span it covers. The renderer makes one call
 * (`chooseCoverFromFile`) that opens the native file sheet *and* then writes the
 * file it returned, so "in flight" spans both, and the longer half by far is the
 * person browsing their own disk. Measured on the running app: with the sheet
 * open, the dialog behind it read *"Writing that image as the cover…"* about a
 * write nobody had chosen yet — and cancelling then left it saying so until the
 * press resolved.
 *
 * Nothing here can distinguish the two phases, on purpose: the whole boundary
 * (D6-a) is that the path never reaches the renderer, so a "choosing" phase and a
 * "writing" phase are not two things this side can see. A vaguer sentence was the
 * alternative and it would have been a smaller lie rather than none. So the
 * control shows a spinner while it is mid-gesture — which is true, and is what a
 * spinner means — and the dialog adds only sentences about the book: the refusal
 * above, and the landed line below.
 */
export const UPLOAD_APPLIED = 'Your image is now the cover on this book.'

/**
 * What the upload call's answer means for this dialog, in two states.
 *
 * A cancellation is an **answer**, not a failure (`api.types.ts` spells the
 * union that way for exactly this reason): the person closed a dialog, nothing
 * was written and there is no book to report. So it must not read as one — no
 * refusal line, no error colour — and it must not re-read either, because
 * nothing moved. This function exists so that reading is a rule with a case
 * rather than a branch nobody asserted: `cancelled` is the only answer that
 * changes nothing, and the difference between it and a refusal is the whole
 * content of the gesture's honesty.
 */
export type CoverUploadReading = { kind: 'settled' } | { kind: 'cancelled' }

export function coverUploadReading(outcome: CoverUploadOutcome): CoverUploadReading {
  return 'cancelled' in outcome ? { kind: 'cancelled' } : { kind: 'settled' }
}

/**
 * The sentence a refused upload prints: the call's own, verbatim.
 *
 * The refusal is a **value** rather than a throw across the boundary (D6-d):
 * the sidecar's guard raises `ValueError` with the sentence the user reads —
 * *"That file is not an image Musaeum can read"*, the 120 px floor's, the
 * damaged-image one — and `sidecar.call`'s rejection carries it here intact.
 * So this rule composes nothing and must not: every failure this gesture can
 * have already has words, and a generic "that image could not be used" written
 * here would replace a sentence that says *why* with one that does not (the
 * slice-2 defect, in copy).
 */
export function uploadRefusal(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface UploadCopy {
  /** The upload's own line under the trigger, or null for a state with none. */
  line: string | null
  /** Whether the gather's book-level notice still stands beside its tiles. */
  gatherNotice: boolean
}

/**
 * What the dialog says about an upload: its own line, and whether the gather's
 * notice still stands.
 *
 * One derivation rather than two, because the two answers are one decision — an
 * upload that landed replaced the bytes *and* took the lock, and both sentences
 * are about that single fact.
 *
 * `line` is absent for a cancellation, which is an answer rather than a
 * failure, and absent while nothing has been asked this session: the two are
 * the same silence on purpose, because neither is news about the book. A
 * sentence for a cancellation would be the dialog reporting a failure that did
 * not happen, which is the one thing this state exists to prevent.
 *
 * `gatherNotice` is false once an upload has landed, and that suppression is
 * the point of the rule rather than a layout choice. The gather's notice
 * explains an unmarked grid with *"None of these is the cover on your book now
 * — it was resolved from a conflict, or replaced outside Musaeum"*. Its first
 * half stays true, but its **explanation** does not: the cover was replaced
 * here, in this dialog, by the person reading the sentence. So the upload's own
 * line stands in the notice's place, and the story the dialog tells about its
 * own action is the true one. Two sentences, one contradicting the other one
 * line apart, is how a reader learns to skip both.
 */
export function uploadCopy(reading: CoverUploadReading | null): UploadCopy {
  const settled = reading?.kind === 'settled'
  return { line: settled ? UPLOAD_APPLIED : null, gatherNotice: !settled }
}
