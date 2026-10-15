export interface SpeechUnit {
  mark: string
  text: string
  blockEnd: boolean
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      } catch {
        return m
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** A block's SSML → its sentences, in order. Pure; no DOM. Empty block → []. */
export function flattenSsml(ssml: string | null | undefined): SpeechUnit[] {
  if (!ssml) return []
  const raw: { mark: string; text: string }[] = []
  let current: { mark: string; text: string } | null = null
  for (const token of ssml.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (token[0] !== '<') {
      if (current) current.text += decode(token)
      continue
    }
    if (token.startsWith('<?') || token.startsWith('<!')) continue
    const mark = /^<mark\b[^>]*\bname="([^"]*)"/.exec(token)
    if (mark) {
      current = { mark: decode(mark[1] ?? ''), text: '' }
      raw.push(current)
      continue
    }
    if (/^<break\b/.test(token) && current) current.text += ' '
    // every other tag is transparent: its text is the speech
  }
  const units = raw
    .map((u) => ({ mark: u.mark, text: u.text.replace(/\s+/g, ' ').trim() }))
    .filter((u) => u.text !== '')
  return units.map((u, i) => ({ ...u, blockEnd: i === units.length - 1 }))
}
