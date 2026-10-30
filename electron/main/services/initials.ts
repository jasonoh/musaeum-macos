/**
 * Initial-letter buckets (A-Z, then `#`) for the OPDS browse tree's "Titles A-Z" and "Authors" lists.
 *
 * This is its own pure file, with no imports from the app, because the answer has to be the same in two places: SQL grouping (the function is registered into SQLite as `musaeum_initial`) and the TypeScript that turns a bucket back into a URL and a filter. If they disagreed, a book would be counted under one letter and listed under another.
 *
 * Accents fold through NFD (`Éric` -> `E`, `Ångström` -> `A`). Letters with no NFD decomposition do not fold: `Ł` stays `Ł`, which is not A-Z, so `Łukasz` lands in `#`. That is the known limit; a transliteration table would fix it and has not been worth the weight.
 */

export type Bucket =
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z'
  | '#'

/** A-Z in order, then `#` last. */
export const BUCKETS: readonly Bucket[] = [
  ...('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') as Bucket[]),
  '#'
]

const COMBINING_MARKS = /\p{M}+/gu
const LEADING_NON_ALNUM = /^[^\p{L}\p{N}]+/u

/**
 * The bucket a title or author sorts under. Leading punctuation and whitespace are skipped (`'Salem's Lot` -> `S`); digits, non-Latin scripts and empty input all land in `#`.
 */
export function initialBucket(text: string | null | undefined): Bucket {
  if (!text) return '#'
  const stripped = text.normalize('NFD').replace(COMBINING_MARKS, '').replace(LEADING_NON_ALNUM, '')
  const first = [...stripped][0]
  if (!first) return '#'
  const upper = first.toUpperCase()
  return upper >= 'A' && upper <= 'Z' && upper.length === 1 ? (upper as Bucket) : '#'
}

/** The URL path segment for a bucket: the letter itself, or `other` for `#` (which does not survive a URL). */
export function bucketSlug(b: Bucket): string {
  return b === '#' ? 'other' : b
}

/** Parse a URL path segment back to a bucket, case-insensitively. Anything that is not a single letter or `other` is `null`. */
export function bucketFromSlug(slug: string): Bucket | null {
  if (slug.toLowerCase() === 'other') return '#'
  if (!/^[A-Za-z]$/.test(slug)) return null
  return slug.toUpperCase() as Bucket
}
