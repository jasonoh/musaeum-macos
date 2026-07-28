/** Strip filesystem-hostile characters; cap length for NAS friendliness. */
export function sanitizeTitle(title: string): string {
  const clean = title
    .replace(/[/\\:*?"<>|]/g, '')
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (clean || 'untitled').slice(0, 80)
}
