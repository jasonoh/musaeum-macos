import { readFile } from 'fs/promises'
import { BrowserWindow, session } from 'electron'
import type { LoadedTheme, ThemeIr } from '@shared/theme.types'
import {
  OBSIDIAN_ACCENT_LADDER,
  OBSIDIAN_ROLE_LADDER,
  obsidianIr,
  themeFolderName,
  type ObsidianReads,
  type ResolvedObsidianFile,
  type ResolvedObsidianVariant
} from './parse/obsidian'

/**
 * Slice 6's Electron half: one hidden window that *runs* an Obsidian stylesheet
 * and reads the role values back, so a theme whose palette is computed
 * (`hsl(var(--base-h), …)`, `var()` chains, `color-mix()`) resolves where a
 * regex scrape of the `.css` cannot.
 *
 * Every design decision in this file is a measurement from the annex
 * (`plans/2026-09-19-theming-slice6.md` §2–§3), against Electron 37.10.3:
 *
 * 1. **The window is created once, lazily, and NEVER destroyed** (D1). A
 *    `BrowserWindow` destroyed and then a second one created in the same process
 *    never loads (`ERR_FAILED`), and the process dies with `SIGTRAP` around the
 *    third — with `offscreen` on and off, and with a fixed partition and a fresh
 *    one per window. One window reused resolved all six real themes × two
 *    variants in one process, 1.24 MB of CSS in 25 ms. So: no `destroy()` on any
 *    path, and a timeout *resets* the window (`webContents.stop()` + a reload of
 *    `about:blank`) instead of recycling it. The stylesheet is replaced inside
 *    the same live document per file — the read script finds-or-creates the one
 *    `<style>` element — so nothing has to be navigated between files at all.
 * 2. **The no-network control is a session *filter*, not a cancel-all** (D2). An
 *    unfiltered `onBeforeRequest` cancels the `data:` document itself (it is the
 *    first request the listener sees) and nothing loads; the rule is the
 *    http(s)-scoped pattern `resolverRuleFilter()` returns, installed once on the
 *    `musaeum-theme-resolver` partition. It was measured with a loopback server:
 *    with the document's CSP relaxed to nothing, four requests are attempted and
 *    **zero reach the server**; with the rule removed, all four arrive.
 * 3. **What a computed custom property returns is the substituted token stream,
 *    not a colour** (D3). The read is two-stage: `getComputedStyle(body)` for the
 *    raw string, then that string assigned to a probe element whose computed
 *    colour is read back — the round trip is what evaluates `calc()`,
 *    `color-mix()` and `var()` chains. `normalizeColour` in the adapter accepts
 *    only the four shapes Chromium hands back.
 * 4. **The stylesheet never reaches the real renderer** (§2.6, `CLAUDE.md` #9):
 *    the CSS text lives in this process and only derived hex values cross back.
 *    The window has no preload, no Node, no opened windows, and its document's
 *    CSP is `default-src 'none'; style-src 'unsafe-inline'` — a second layer
 *    beside the session rule.
 *
 * Nothing here throws: a missing file, a read that timed out and a theme whose
 * required roles are unresolved are all `{ ok: false, reason }` values, which is
 * what lets the importer report one file and import the rest (`CLAUDE.md` #12).
 */

/** The window's own session. Fixed: a fresh partition per window was measured too. */
const PARTITION = 'musaeum-theme-resolver'

/** Measured headroom: the slowest real theme on this machine resolves in 25 ms. */
const READ_TIMEOUT_MS = 3000

/** What a timed-out read resets to — never a destroy (D1). */

/**
 * The document the stylesheet is injected into.
 *
 * Its CSP is the second layer of the no-network control: `default-src 'none'`
 * stops `@import`, `url()` and `@font-face` fetches before a request exists,
 * while `style-src 'unsafe-inline'` is what lets the theme arrive as a `<style>`
 * *text node* — no fetch to load the file at all, because the bytes were read by
 * `fs` in main and handed to `executeJavaScript`.
 */
const RESOLVER_DOCUMENT = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><head>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '</head><body></body>'
)}`

/** Every variable any ladder can ask for, read in ONE `executeJavaScript` per class. */
const LADDER_VARIABLES: readonly string[] = (() => {
  const names = new Set<string>()
  const ladders: Record<string, readonly string[]>[] = [
    OBSIDIAN_ROLE_LADDER,
    OBSIDIAN_ACCENT_LADDER
  ]
  for (const ladder of ladders) {
    for (const rungs of Object.values(ladder)) for (const name of rungs) names.add(name)
  }
  return [...names]
})()

/**
 * Pure. The exact literal `new BrowserWindow` is constructed with.
 *
 * It is a function rather than an inline object because AC6.5 is decided by its
 * *shape* — no `preload` key at all, `nodeIntegration: false`,
 * `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, and a fixed
 * partition — and `main/index.ts` has no harness, so a decision made inside it
 * would be a decision no test could falsify (the A25 precedent in the spec).
 *
 * The geometry is inert (nothing is laid out or painted for a reader; only
 * computed custom properties are taken), but it is part of the literal so the
 * window's construction is one decidable value rather than a literal plus a
 * default the next reader has to go and look up.
 */
export function resolverWindowOptions(): {
  show: boolean
  width: number
  height: number
  webPreferences: {
    offscreen: boolean
    sandbox: boolean
    contextIsolation: boolean
    nodeIntegration: boolean
    webSecurity: boolean
    partition: string
  }
} {
  return {
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      // Measured: `loadURL(data:)` 55–62 ms and reads of 1–3 ms, identical with
      // `offscreen` on and off — so the offscreen surface buys nothing but is
      // the shape §2.6 specified and the one the corpus was measured against.
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: PARTITION
    }
  }
}

/**
 * Pure. The request filter the session rule is installed with: the http(s)-only
 * URL pattern, which is the one below rather than a bare cancel-all — the
 * `data:` document itself is the first request an unfiltered listener sees, and
 * cancelling it fails the load (`ERR_BLOCKED_BY_CLIENT`, nothing resolves at
 * all). The filter never sees the document, and it still covers every http(s)
 * attempt a stylesheet can make.
 */
export function resolverRuleFilter(): { urls: string[] } {
  return { urls: ['*://*/*'] }
}

let resolver: BrowserWindow | null = null
let resolverReady: Promise<BrowserWindow> | null = null
let ruleInstalled = false

/**
 * Whether a window is the resolver's.
 *
 * Exported for `main/index.ts`'s `activate`: the resolver window is long-lived
 * and hidden, so `BrowserWindow.getAllWindows().length` is never 0 once a `.css`
 * has been imported and the dock icon would stop reopening the app. The question
 * there is "is there no *main* window", which this predicate answers.
 */
export function isResolverWindow(win: BrowserWindow): boolean {
  return win === resolver
}

async function createResolver(): Promise<BrowserWindow> {
  const partition = session.fromPartition(PARTITION, { cache: false })
  if (!ruleInstalled) {
    partition.webRequest.onBeforeRequest(resolverRuleFilter(), (_details, callback) =>
      callback({ cancel: true })
    )
    ruleInstalled = true
  }
  const win = new BrowserWindow(resolverWindowOptions())
  // A theme that calls `window.open` opens nothing (AC6.5). The window is also
  // the only one that could, so denying here is the whole surface.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  resolver = win
  await win.loadURL(RESOLVER_DOCUMENT)
  return win
}

/**
 * The one window, created on first use and reused for the process's life.
 *
 * The in-flight promise is cached as well as the window, so two resolves racing
 * at boot cannot each build one — two windows created together are unaffected by
 * D1's crash, but the second would be a hidden window nobody ever reads.
 */
function resolverWindow(): Promise<BrowserWindow> {
  if (resolver !== null && !resolver.isDestroyed()) return Promise.resolve(resolver)
  if (resolverReady === null) {
    resolverReady = createResolver().catch((err: unknown) => {
      // A window that could not be created must not be cached as ready: the next
      // import is allowed to try again.
      resolverReady = null
      throw err
    })
  }
  return resolverReady
}

/**
 * The read, per class, as ONE `executeJavaScript`.
 *
 * Two things about it are load-bearing:
 *
 * - **The round trip is what resolves the value.** `getComputedStyle(body)` on a
 *   computed custom property answers the *substituted token stream* —
 *   `hsl(220, 12%, calc(18% - 2%))`, `color-mix( in hsl, #1d2433, #2f3b54 )` —
 *   which is not a colour. Assigning that string to a probe element's `color`
 *   and reading the computed value back is what makes the engine evaluate
 *   `calc()`, `color-mix()` and `var()` chains; the sentinel is set first so an
 *   assignment the engine refused (an unusable value) is *visible* as "the
 *   computed colour is still the sentinel", and the raw string is answered
 *   instead — which `normalizeColour` then rejects, the honest outcome for a
 *   value the resolver did not manage to resolve.
 * - **The stylesheet is replaced in place.** The `<style>` element is
 *   found-or-created by id and its `textContent` set, so one document serves
 *   every file (D1: nothing is navigated, nothing is destroyed) and the previous
 *   theme's declarations cannot linger — the class is swapped on `body` in the
 *   same script.
 */
function readScript(css: string, className: 'dark' | 'light'): string {
  return `(() => {
  let style = document.getElementById('musaeum-obsidian');
  if (style === null) {
    style = document.createElement('style');
    style.id = 'musaeum-obsidian';
    document.head.appendChild(style);
  }
  style.textContent = ${JSON.stringify(css)};
  document.body.classList.remove('theme-dark', 'theme-light');
  document.body.classList.add(${JSON.stringify(`theme-${className}`)});
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  const sentinel = 'rgb(1, 2, 3)';
  const reads = {};
  for (const name of ${JSON.stringify(LADDER_VARIABLES)}) {
    const raw = getComputedStyle(document.body).getPropertyValue(name).trim();
    reads[name] = '';
    if (raw === '') continue;
    probe.style.color = sentinel;
    probe.style.color = raw;
    const resolved = getComputedStyle(probe).color;
    reads[name] = resolved === sentinel ? raw : resolved;
  }
  probe.remove();
  return reads;
})()`
}

/** Distinguishes a timed-out read from a page that answered. */
const READ_TIMED_OUT = Symbol('musaeum theme resolver timed out')

/** The page's answer, narrowed to the strings it is allowed to be. */
function toReads(value: unknown): ObsidianReads {
  const reads: ObsidianReads = {}
  if (typeof value !== 'object' || value === null) return reads
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') reads[name] = raw.trim()
  }
  return reads
}

/**
 * Reset, never recycle (D1): `webContents.stop()` and a reload of the resolver's own
 * document, so a read that hung cannot leave the window mid-script.
 *
 * The reload is the *resolver document*, not `about:blank`: the CSP layer of the
 * no-network control belongs to the document the read happens in, so resetting to a
 * blank page would hand every later read a window whose only control is the session
 * rule. Reloading the same `data:` URL keeps both layers, which is the point of
 * having two. A reset that itself fails is not raised: the timeout is already the
 * fact the user needs.
 */
async function resetResolver(win: BrowserWindow): Promise<void> {
  try {
    win.webContents.stop()
    await win.loadURL(RESOLVER_DOCUMENT)
  } catch {
    // Nothing to do: the window is reset on the next attempt either way, and a
    // throw here would replace the timeout's reason with a lesser one.
  }
}

/** The reads the two ladder sets need, for one applied class. */
async function readClass(
  win: BrowserWindow,
  css: string,
  className: 'dark' | 'light',
  path: string
): Promise<{ ok: true; reads: ObsidianReads } | { ok: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof READ_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(READ_TIMED_OUT), READ_TIMEOUT_MS)
  })
  try {
    const value: unknown = await Promise.race([
      win.webContents.executeJavaScript(readScript(css, className)),
      timeout
    ])
    if (value === READ_TIMED_OUT) {
      await resetResolver(win)
      return { ok: false, reason: `${path} timed out after 3s` }
    }
    return { ok: true, reads: toReads(value) }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await resetResolver(win)
    return { ok: false, reason: `${path}: the resolver could not complete its read (${detail})` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * D5's entry rule, pure so it has a unit decider of its own: the dark-class read
 * is the theme's first entry, and the light-class read joins it **only** when it
 * resolved and its canvas implies the *other* variant.
 *
 * The second half is what the corpus measured: Dracula + LYT's `theme-light`
 * class resolves to a dark palette (one entry, not two), and a dark-only theme's
 * light read is entirely empty — its required roles never resolve, so it never
 * reaches here. Tokyo Night and Things are genuine pairs and keep their two
 * rows.
 */
export function resolvedEntries(dark: ThemeIr, light: ThemeIr | null): ResolvedObsidianVariant[] {
  const entries: ResolvedObsidianVariant[] = [{ variant: dark.variant, ir: dark }]
  if (light !== null && light.variant !== dark.variant) {
    entries.push({ variant: light.variant, ir: light })
  }
  return entries
}

/**
 * One `theme.css` -> its entries, or the reason it has none.
 *
 * Two reads, one window: `theme-dark` then `theme-light`, both in the same live
 * document (measured — the swap is a class mutation on `body`, and both reads
 * answer in the same window). The applied class is only a *probe*; the variant
 * each entry carries comes from its own canvas's lightness (`variantFromCanvas`),
 * which is why the light read is handed to `resolvedEntries` as an IR rather
 * than as "a light theme".
 */
export async function resolveObsidianFile(path: string): Promise<ResolvedObsidianFile> {
  const name = themeFolderName(path)
  if (name === null) {
    return {
      ok: false,
      reason: `${path} is not inside a theme folder — an Obsidian theme is a folder containing theme.css`
    }
  }

  let css: string
  try {
    css = await readFile(path, 'utf8')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `Could not read ${path}: ${detail}` }
  }

  let win: BrowserWindow
  try {
    win = await resolverWindow()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `the theme resolver window could not be created: ${detail}` }
  }

  const dark = await readClass(win, css, 'dark', path)
  if (!dark.ok) return { ok: false, reason: dark.reason }
  const darkIr = obsidianIr(dark.reads, { name, sourcePath: path, variantClass: 'dark' })
  if (!darkIr.ok) return { ok: false, reason: darkIr.reason }

  const light = await readClass(win, css, 'light', path)
  if (!light.ok) return { ok: false, reason: light.reason }
  const lightIr = obsidianIr(light.reads, { name, sourcePath: path, variantClass: 'light' })

  return { ok: true, variants: resolvedEntries(darkIr.ir, lightIr.ok ? lightIr.ir : null) }
}

/**
 * The single-entry door: the same resolve, answering only the theme's first
 * entry (the dark-class read).
 *
 * It exists for callers that want *a theme* rather than a file's rows —
 * `loadThemeFileAsync` is one — while the importer, which has to write a row per
 * entry, uses `resolveObsidianFile`'s full answer.
 */
export async function resolveObsidianTheme(path: string): Promise<LoadedTheme> {
  const resolved = await resolveObsidianFile(path)
  if (!resolved.ok) return { ok: false, reason: resolved.reason }
  const first = resolved.variants[0]
  if (first === undefined) return { ok: false, reason: `${path}: no palette resolved` }
  return { ok: true, ir: first.ir }
}
