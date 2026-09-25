/**
 * What the main window may hand to the OS, and where it may navigate itself.
 *
 * The preload's bridge is re-injected on every navigation of the window, so a
 * main frame that wandered to another origin would carry the whole Musaeum
 * API with it; and `shell.openExternal` on an arbitrary scheme hands the URL
 * to whatever app registered it. Neither is reachable from a book today —
 * foliate's section iframes have no `allow-popups`/`allow-top-navigation` —
 * so these are the second lock, not the first.
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export function isExternalUrlAllowed(url: string): boolean {
  const u = parse(url)
  return !!u && EXTERNAL_PROTOCOLS.has(u.protocol)
}

export function isInAppNavigation(target: string, current: string): boolean {
  const t = parse(target)
  const c = parse(current)
  if (!t || !c) return false
  if (t.protocol === 'file:' && c.protocol === 'file:') return true
  return t.origin !== 'null' && t.origin === c.origin
}
