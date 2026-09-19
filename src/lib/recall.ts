/**
 * The recall scorer — the only local evidence about whether the model actually
 * holds *this* book.
 *
 * The design's bet is that title, author and section are an index, so the
 * payload can stay at the pointer while the model supplies the content. The
 * measured library says that bet is uneven: the public-domain canon is where
 * pointer-only should work, and 2024+ titles, the 290 travel guides and the
 * 2,600 books with no description anywhere are precisely where no pointer
 * summons the chapter — and the model has no way to know which kind it is
 * looking at, because it answers fluently either way
 * (`docs/superpowers/specs/2026-09-19-reader-ai-panel-design.md` D6).
 *
 * So the probe asks for a claim that can be checked: the section's opening
 * line. `parseProbe()` reads that reply tolerantly, and `scoreRecall()`
 * compares the claim against the section text the engine is already holding in
 * memory. **Both sides of the comparison are local.** The verdict widens or
 * doesn't widen the next payload; it is never sent anywhere.
 *
 * What this is not: a correctness proof. A model can quote another edition's
 * opening and score `weak` while being substantively right, or share enough
 * tokens to score `strong` while being wrong. It is evidence, and it is better
 * evidence than nothing — risk 1 of the design, stated plainly there.
 */

export type RecallVerdict = 'strong' | 'weak' | 'unknown'

/** The probe reply, after tolerant parsing. */
export interface ParsedProbe {
  /**
   * The contract's `RECALL:` line was legible. False for anything else — a
   * reply that did not follow the contract asserts nothing checkable.
   */
  parsed: boolean
  /** True only when the model claimed recall *and* the reply parsed. */
  recall: boolean
  /** The claimed opening, unwrapped, or `''` when absent. */
  opening: string
}

/** At or above this, the claim counts as placing the book. */
export const RECALL_THRESHOLD = 0.6

/** The claim is the section's *opening*, so it is scored against the section's start. */
export const SECTION_TOKEN_WINDOW = 120

/** Shorter tokens are dropped: articles and prepositions carry no evidence. */
export const MIN_TOKEN_LENGTH = 3

/**
 * Function words, dropped from both sides. Everything under three characters is
 * already gone by length, so this list only needs the longer ones.
 */
const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'all',
  'also',
  'and',
  'any',
  'are',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'can',
  'could',
  'did',
  'does',
  'doing',
  'done',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'her',
  'here',
  'hers',
  'him',
  'his',
  'how',
  'into',
  'its',
  'just',
  'many',
  'more',
  'most',
  'much',
  'must',
  'nor',
  'not',
  'now',
  'off',
  'once',
  'only',
  'other',
  'our',
  'ours',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'too',
  'under',
  'until',
  'upon',
  'very',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours'
])

/**
 * NFC → lowercase → strip diacritics → any non-letter/digit run becomes a
 * space → drop stopwords and tokens under three characters.
 *
 * The split is script-agnostic (`\p{L}\p{N}` rather than `[a-z0-9]`), so a
 * Spanish or Cyrillic book normalizes instead of vanishing. The known limit is
 * the length filter: a two-character CJK word is dropped, and a CJK sentence
 * arrives as a handful of long tokens — verbatim still scores `strong` and a
 * paraphrase still scores `weak`, which is the behaviour the verdict needs.
 */
export function normalizeTokens(text: string | null | undefined): string[] {
  if (!text) return []
  return text
    .normalize('NFC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token))
}

/** Strips the wrapping a model may add around a value: bold, backticks, quotes. */
const WRAP = /^[\s*_`"'“”‘’]+|[\s*_`"'“”‘’]+$/g

function unwrap(text: string): string {
  return text.replace(WRAP, '').replace(/\s+/g, ' ').trim()
}

/** A key line, tolerating leading list markers, quotes, bold and backticks. */
function keyValue(line: string, key: 'recall' | 'opening'): string | null {
  const match = line.match(new RegExp(`^[\\s>*_\`#"-]*\\**${key}\\**\\s*[:：]\\s*(.*)$`, 'i'))
  return match ? match[1] : null
}

/**
 * Any `KEY: value` line — the end of a wrapped opening.
 *
 * Single-word keys with a value after the colon only, which is what keeps it
 * from eating prose: a line of book text that happens to end in a colon has
 * nothing after it, and a sentence is far longer than a field name.
 */
const KEY_LINE = /^[\s*_`>#'"-]*\**[A-Za-z][A-Za-z_' -]{0,14}\**\s*[:：]\s*\S/

/** How many lines a wrapped opening may run on for. A model wraps; it does not essay. */
const MAX_OPENING_LINES = 2

/**
 * Read a probe reply.
 *
 * Tolerance is the whole job here (a model's formatting is not a decision this
 * feature gets to make): case-insensitive keys, bold or backticked keys and
 * values, curly or straight quotes, extra whitespace, and an opening that runs
 * on past the end of its line. A reply that does not follow the contract comes
 * back as `{ parsed: false, recall: false, opening: '' }` rather than throwing
 * — the panel stays usable and the verdict lands on `unknown`.
 */
export function parseProbe(reply: string | null | undefined): ParsedProbe {
  const unparsed: ParsedProbe = { parsed: false, recall: false, opening: '' }
  if (!reply) return unparsed

  const lines = reply.split(/\r?\n/)
  let recall: boolean | null = null
  const opening: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]

    const recallValue = keyValue(raw, 'recall')
    if (recallValue !== null) {
      if (recall === null) {
        const value = unwrap(recallValue)
        if (/^(yes|true|y)\b/i.test(value)) recall = true
        else if (/^(no|false|n)\b/i.test(value)) recall = false
      }
      continue
    }

    const openingValue = keyValue(raw, 'opening')
    if (openingValue !== null && opening.length === 0) {
      const value = unwrap(openingValue)
      if (value) opening.push(value)
      // A model that puts the opening on the next line is still following the
      // contract, so keep reading until a blank line, a new key line, or one
      // wrap too many.
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim()
        if (!next || KEY_LINE.test(next)) break
        if (opening.length >= MAX_OPENING_LINES) break
        opening.push(unwrap(next))
        i = j
      }
      continue
    }
  }

  if (recall === null) return unparsed
  return { parsed: true, recall, opening: opening.join(' ') }
}

/**
 * The share of the claimed opening that actually appears in the section's first
 * `SECTION_TOKEN_WINDOW` content tokens, or `null` when there is nothing to
 * check against (no section text, or no content tokens in it).
 *
 * The denominator is the *claim*, not the section: this answers "is this claim
 * about this page?", not "did they quote it all?". One property worth knowing:
 * a very short claim can score high, which is why the contract asks for 8–15
 * words — and why the verdict is evidence rather than proof.
 */
export function recallOverlap(
  parsed: ParsedProbe,
  sectionText: string | null | undefined
): number | null {
  const local = new Set(normalizeTokens(sectionText).slice(0, SECTION_TOKEN_WINDOW))
  if (!local.size) return null
  const claimed = new Set(normalizeTokens(parsed.opening))
  if (!claimed.size) return 0
  let shared = 0
  for (const token of claimed) if (local.has(token)) shared += 1
  return shared / claimed.size
}

/**
 * The verdict, and the only thing that decides the rung (D6):
 *
 * - `unknown` — the reply did not parse, or there is no section text to check
 *   against. The payload stays at L0 and the panel shows the *unverified*
 *   badge: answers are reconstructed, not recalled.
 * - `weak` — the model said it could not place the book, or claimed it could
 *   and the claim did not hold up. The passage is added for this session.
 * - `strong` — the claim matched. The bet paying off, and nothing is said.
 *
 * A probe that *errored* never reaches here at all: the caller leaves the
 * verdict at `unknown` and the panel stays usable, the same "non-fatal, keep
 * the working part" rule invariant 12 states for hydration and NAS.
 */
export function scoreRecall(
  parsed: ParsedProbe,
  sectionText: string | null | undefined
): RecallVerdict {
  if (!parsed.parsed) return 'unknown'
  if (!parsed.recall) return 'weak'
  const overlap = recallOverlap(parsed, sectionText)
  if (overlap === null) return 'unknown'
  return overlap >= RECALL_THRESHOLD ? 'strong' : 'weak'
}
