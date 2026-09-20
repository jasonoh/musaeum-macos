/**
 * The description rule: source HTML → the plain text a description is stored as.
 *
 * The extractors (`sidecar/extractors/html_text.py`) now apply this at
 * ingestion, which is where it belongs: a stored description is plain text,
 * and the detail panel renders it with `whitespace-pre-line`. This module
 * exists for the data written *before* that rule did — 2,781 of 6,462 rows
 * hold `<p>` and 1,320 hold `<br>`, because Calibre's `comments` column is
 * HTML and it was written through verbatim. Re-writing those canonical
 * `metadata.json` files is a separate decision; until it is taken, the panel
 * renders whatever is on disk through here, so the rule holds for old rows
 * and new ones alike.
 *
 * Keep this in step with the Python module — they are the same rule in two
 * languages, and the Python one is the one that writes new data.
 */

/**
 * A structural boundary — the end of a paragraph, line or list item — has to
 * survive as a newline. Inline tags are emphasis inside a paragraph, and an
 * opening tag would turn one boundary into a blank line, so neither breaks.
 */
const BLOCK_BREAK =
  /<\s*(?:br|hr|\/p|\/div|\/li|\/ul|\/ol|\/tr|\/h[1-6]|\/blockquote|\/section)\s*\/?\s*>/gi

/** A tag has to look like one, so "5 < 6 and 7 > 2" is left alone. */
const TAG = /<\/?[a-zA-Z][^>]*>/g

/**
 * An escape depth no real description reaches: three levels is the deepest
 * measured in the library, and the loop stops as soon as a pass changes
 * nothing, so plain text costs one pass whatever this is set to.
 */
const MAX_PASSES = 4

/** The named entities that actually reach a book description. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·'
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      // A numeric entity outside the code-point range is left as written
      // rather than replaced with U+FFFD — the reader can still read it.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Plain text for a description, whatever the row holds. Text that carries no
 * markup comes back with its own paragraph breaks intact.
 */
export function descriptionText(raw: string | null | undefined): string {
  if (!raw) return ''
  // Repeat until the text stops changing (bounded): a description can arrive
  // double- or triple-escaped, and any pass short of stable leaves markup
  // visible, which is the defect this exists to remove. It over-resolves
  // absurdly deep `&amp;amp;…` chains, which is the trade for never showing a
  // reader `&#8212;`.
  let text = raw
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = text
    text = decodeEntities(text.replace(BLOCK_BREAK, '\n').replace(TAG, ''))
    if (text === before) break
  }
  return text
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
