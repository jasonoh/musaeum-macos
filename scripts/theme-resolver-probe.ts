/**
 * The theme resolver probe — slice 6's Electron-side instrument.
 *
 * `npm test` runs Electron-as-Node, so `BrowserWindow` and `session` do not exist
 * there and three of slice 6's criteria have no unit decider at all: AC6.2 (the
 * resolver reaches no network), AC6.5's effect half (nothing escapes the sandbox)
 * and AC6.6's cleanup half (N resolves leave exactly one window). This script is
 * what decides them, against the *shipped* module rather than a copy of it.
 *
 * It is a probe, not a test: it prints measurements and asserts nothing, so its
 * value is the numbers, which is why the drill-down for each row is in
 * `docs/superpowers/plans/2026-09-19-theming-slice6.md` §8.
 *
 *   npx esbuild scripts/theme-resolver-probe.ts --bundle --platform=node \
 *     --format=cjs --external:electron --outfile=out/probe-theme-resolver.cjs
 *   ./node_modules/.bin/electron out/probe-theme-resolver.cjs [theme.css …]
 *
 * The optional arguments are `theme.css` paths to run the corpus row against.
 * They are arguments rather than a list here because the themes a person has
 * installed are their own files, not the repository's: passing four real ones was
 * what turned "the ladder admits 6 of 6" from a prediction into a measurement.
 *
 * Two habits in here are load-bearing, both learned the hard way:
 *
 * - **Progress is appended with `fs.appendFileSync` as well as logged.** A
 *   renderer crash (Electron 37.10.3 has one around window churn) takes the
 *   process with it and stdout can go with it — the first run of this harness
 *   produced no output at all and looked like a passing script.
 * - **The network instrument is a loopback server, not the `onBeforeRequest`
 *   listener.** A strict-CSP document issues *no* request, so a counter reads 0
 *   whether the session rule is installed or not — measuring the listener proves
 *   nothing about reachability. Which requests actually arrived is the fact.
 */

import { app, BrowserWindow, session } from 'electron'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isResolverWindow,
  resolveObsidianFile,
  resolverRuleFilter
} from '../electron/main/services/theme/resolve-css'

const LOG = join(tmpdir(), 'musaeum-theme-probe.log')
const SCRATCH = join(tmpdir(), 'musaeum-theme-probe')

function report(name: string, value: unknown): void {
  const line = `PROBE ${name} = ${JSON.stringify(value)}`
  appendFileSync(LOG, line + '\n')
  console.log(line.length > 3000 ? `${line.slice(0, 3000)}…` : line)
}

/**
 * AC6.3 as a property over a whole IR: every colour-shaped field is `#rrggbb`
 * and no leaf of the object carries CSS syntax.
 *
 * The first version of this check grepped `JSON.stringify(ir)` for `{` — the
 * container's own brace — and flagged every theme. The criterion is about what a
 * *value* can carry, so this walks the leaves.
 */
function payloadProblem(ir: unknown): string | null {
  const leaves: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      leaves.push(value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(ir)

  const record = ir as Record<string, unknown>
  const colours = [
    'bg',
    'bg2',
    'bg3',
    'border',
    'muted',
    'fg',
    'fg_bright',
    'accent_hint',
    'on_acc_hint'
  ]
  for (const field of colours) {
    const value = record[field]
    if (value === undefined) continue
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/.test(value)) {
      return `${field} is ${JSON.stringify(value)}`
    }
  }
  const accents = (record.accents ?? {}) as Record<string, unknown>
  for (const [slot, value] of Object.entries(accents)) {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/.test(value)) {
      return `accents.${slot} is ${JSON.stringify(value)}`
    }
  }
  for (const leaf of leaves) {
    for (const forbidden of ['url(', '{', '}', '<', 'var(', '@import', ';']) {
      if (leaf.includes(forbidden)) return `a leaf carries ${forbidden}: ${leaf.slice(0, 60)}`
    }
  }
  return null
}

/** A `theme.css` on disk, in a folder of its own — the folder is the theme's name. */
function scratch(folder: string, css: string): string {
  const dir = join(SCRATCH, folder)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'theme.css')
  writeFileSync(file, css)
  return file
}

const ROLE_PROBE = `--background-secondary: #101010;
  --background-primary: #161616;
  --background-modifier-border: #303030;
  --text-normal: #e0e0e0;
  --interactive-accent: #ffcc66;`

async function main(): Promise<void> {
  if (app.dock) app.dock.hide()
  await app.whenReady()
  report('electron / chrome', {
    electron: process.versions.electron,
    chrome: process.versions.chrome
  })

  // ---- AC6.1: the corpus, through the shipped resolver ---------------------
  const corpusPaths = process.argv.slice(2).filter((argument) => argument.endsWith('.css'))
  if (corpusPaths.length === 0) {
    report('AC6.1 corpus', 'no theme.css paths given — pass the ones to measure as arguments')
  }
  const corpus: Record<string, unknown>[] = []
  const started = Date.now()
  for (const path of corpusPaths) {
    if (!existsSync(path)) {
      corpus.push({ path, missing: true })
      continue
    }
    const resolved = await resolveObsidianFile(path)
    if (!resolved.ok) {
      corpus.push({ path, ok: false, reason: resolved.reason })
      continue
    }
    corpus.push({
      path,
      ok: true,
      entries: resolved.variants.map((entry) => ({
        variant: entry.variant,
        canvas: entry.ir.bg,
        panel: entry.ir.bg2 ?? null,
        text: entry.ir.fg,
        muted: entry.ir.muted ?? null,
        border: entry.ir.border,
        accentHint: entry.ir.accent_hint,
        onAccHint: entry.ir.on_acc_hint ?? null,
        notes: entry.ir.notes.length,
        payloadProblem: payloadProblem(entry.ir)
      }))
    })
  }
  if (corpusPaths.length > 0) {
    report('AC6.1 corpus through the shipped resolver', corpus)
    report('corpus totals', {
      ms: Date.now() - started,
      themes: corpus.filter((row) => row.ok === true).length,
      entries: corpus.reduce((total, row) => total + ((row.entries as unknown[])?.length ?? 0), 0)
    })
  }

  // ---- AC6.6: window accounting (D1) --------------------------------------
  const windows = BrowserWindow.getAllWindows()
  report('AC6.6 windows after the corpus', {
    total: windows.length,
    resolver: windows.filter((window) => isResolverWindow(window)).length,
    other: windows.filter((window) => !isResolverWindow(window)).length
  })

  // ---- AC6.2: no network, with a loopback server as the instrument ---------
  const hits: string[] = []
  const server = createServer((request, response) => {
    hits.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`

  // Every fetch a stylesheet can make, plus roles that still have to resolve.
  const loopbackCss = `
@import url("${base}/import.css");
@font-face { font-family: beacon; src: url("${base}/f.woff2") format("woff2"); }
body { font-family: beacon; background-image: url("${base}/bg.png"); }
body::before { content: url("${base}/pseudo.png"); }
.theme-dark { ${ROLE_PROBE} }
.theme-light { --background-secondary: #f4f4f4; --text-normal: #111111;
  --background-primary: #ffffff; --background-modifier-border: #cccccc;
  --interactive-accent: #cc8800; }
`
  const loopback = scratch('loopback', loopbackCss)
  const shipped = await resolveObsidianFile(loopback)
  await new Promise((resolve) => setTimeout(resolve, 500))
  report('AC6.2 shipped pair (document CSP + session rule)', {
    resolved: shipped.ok,
    entries: shipped.ok ? shipped.variants.length : 0,
    canvas: shipped.ok ? shipped.variants[0].ir.bg : null,
    requestsReceivedByServer: hits.length,
    urls: [...hits]
  })

  // The second layer alone: drop the rule from the shipped partition and resolve
  // again. The strict-CSP document should still reach nothing.
  const partition = session.fromPartition('musaeum-theme-resolver', { cache: false })
  partition.webRequest.onBeforeRequest(null)
  const hitsBeforeRelaxed = hits.length
  const relaxed = await resolveObsidianFile(loopback)
  await new Promise((resolve) => setTimeout(resolve, 500))
  report('AC6.2 CSP alone (session rule removed)', {
    resolved: relaxed.ok,
    requestsReceivedByServer: hits.length - hitsBeforeRelaxed,
    note: 'the document CSP holds on its own — the spec\'s "second layer" is load-bearing, not decorative'
  })

  // The first layer alone: the shipped filter value, on a document with no CSP.
  const permissive = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  const seen: string[] = []
  permissive.webContents.session.webRequest.onBeforeRequest(resolverRuleFilter(), (details, cb) => {
    seen.push(String(details.url))
    cb({ cancel: true })
  })
  await permissive.loadURL('data:text/html;charset=utf-8,%3Cbody%3E%3C%2Fbody%3E')
  const hitsBeforeFilter = hits.length
  await permissive.webContents.executeJavaScript(
    `(() => { const style = document.createElement('style'); style.textContent = ${JSON.stringify(
      loopbackCss
    )}; document.head.append(style); document.body.classList.add('theme-dark'); return 1 })()`
  )
  await new Promise((resolve) => setTimeout(resolve, 600))
  report('AC6.2 session rule alone (permissive document, shipped filter value)', {
    attemptsSeenByTheRule: seen.length,
    urls: seen.slice(0, 6),
    requestsReceivedByServer: hits.length - hitsBeforeFilter
  })
  permissive.destroy()
  server.close()

  // ---- AC6.6: size headroom (the timeout is 3 s) --------------------------
  let big = `.theme-dark { ${ROLE_PROBE} }\n`
  let index = 0
  while (big.length < 5 * 1024 * 1024) {
    big += `.pad-${index}{padding:${index % 7}px;color:#${(index % 0xffffff)
      .toString(16)
      .padStart(6, '0')};}\n`
    index++
  }
  const bigStarted = Date.now()
  const bigResolved = await resolveObsidianFile(scratch('big', big))
  const bigMs = Date.now() - bigStarted
  const manyCss = `.theme-dark {\n${Array.from(
    { length: 2000 },
    (_, n) => `  --synthetic-${n}: hsl(${n % 360}, 40%, ${20 + (n % 60)}%);`
  ).join('\n')}\n${ROLE_PROBE}\n}\n`
  const manyStarted = Date.now()
  const manyResolved = await resolveObsidianFile(scratch('many', manyCss))
  report('AC6.6 size headroom', {
    fiveMegabytes: {
      ms: bigMs,
      ok: bigResolved.ok,
      canvas: bigResolved.ok ? bigResolved.variants[0].ir.bg : null
    },
    twoThousandDeclarations: {
      ms: Date.now() - manyStarted,
      ok: manyResolved.ok,
      canvas: manyResolved.ok ? manyResolved.variants[0].ir.bg : null
    },
    budgetMs: 3000
  })

  // ---- AC6.4: a non-colour role is rejected, not coerced ------------------
  const rejections: Record<string, unknown> = {}
  const cases: Record<string, string> = {
    'text-normal: none': `.theme-dark { --background-secondary: #101010;
      --text-normal: none; --background-primary: #161616;
      --background-modifier-border: #303030; --interactive-accent: #ffcc66; }`,
    'canvas unresolved': `.theme-dark { --text-normal: #e0e0e0; --background-primary: #161616;
      --background-modifier-border: #303030; --interactive-accent: #ffcc66; }`,
    'still computed': `.theme-dark { --background-secondary: hsl(var(--nope), 10%, 10%);
      --text-normal: #e0e0e0; --background-primary: #161616;
      --background-modifier-border: #303030; --interactive-accent: #ffcc66; }`
  }
  for (const [label, css] of Object.entries(cases)) {
    const resolved = await resolveObsidianFile(
      scratch(`rejected-${label.replace(/[^a-z]+/gi, '-')}`, css)
    )
    rejections[label] = resolved.ok
      ? { ok: true, canvas: resolved.variants[0].ir.bg }
      : { ok: false, reason: resolved.reason }
  }
  report('AC6.4 rejections', rejections)

  const finalWindows = BrowserWindow.getAllWindows()
  report('windows at exit', {
    total: finalWindows.length,
    resolver: finalWindows.filter((window) => isResolverWindow(window)).length
  })
  appendFileSync(LOG, 'PROBE_DONE\n')
  app.quit()
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  appendFileSync(LOG, `PROBE_FATAL ${detail}\n`)
  app.exit(1)
})
