import { execSync } from 'child_process'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Invariant 3, enforced: **nothing may read `formats[0]`.**
 *
 * The array holds whatever order the writing source left it in, so a position is
 * not a preference — `primaryFormat()` / `orderedFormats()` are the only readings
 * of it (`src/types/book.types.ts:169-189`). A positional read is a mis-pick that
 * no type can catch and no ordinary unit case sees, because the books it affects
 * are exactly the ones whose array disagrees with `FORMAT_ORDER`.
 *
 * **Why a source scan rather than a unit case:** the rule is about code that must
 * not exist. A behavior test can only prove the call sites that exist today are
 * right; this fails on the next one, the moment it is written — which is the job
 * the invariant docs do for the other twelve rules.
 *
 * **Measured 2026-09-22, on the two sites this caught:** **1,372 of 7,100 books**
 * hold a first element that disagrees with the preferred format — one book in
 * five. `revealBook` revealed the PDF under an EPUB label, and the reader handed
 * the OS the PDF, for any book whose writer left the array in that order.
 */

/** Every `.ts`/`.tsx`/`.py` file under the trees the invariant governs. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, found)
    else if (/\.(ts|tsx|py)$/.test(entry) && !/\.test\./.test(entry)) found.push(path)
  }
  return found
}

/** A member index or `.at()` read of `formats` — the shape every violation has. */
const POSITIONAL = /\.formats\s*(\[|\.at\()/

describe('invariant 3 — no code reads `formats` by position', () => {
  it('has no positional read of `formats` anywhere outside the helpers that own the order', () => {
    const root = process.cwd()
    const offenders = ['src', 'electron', 'sidecar']
      .flatMap((tree) => sources(join(root, tree)))
      .flatMap((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .map((text, i) => ({ text: text.trim(), at: i + 1 }))
          // A whole-line comment that *names* the rule is documentation, not a read.
          .filter(({ text }) => !/^(\/\/|\*|\/\*)/.test(text) && POSITIONAL.test(text))
          .map(({ text, at }) => `${path.slice(root.length + 1)}:${at}  ${text.slice(0, 120)}`)
      )

    expect(offenders).toEqual([])
  })
})

/**
 * Audit U1's flag, enforced: **the main window is created sandboxed.**
 *
 * `sandbox: false` at `electron/main/index.ts:180` passes `npm run typecheck`,
 * `npm run lint`, `npm test` and `npm run build` alike, so without a decider the
 * flag's whole proof is a comment. It cannot be decided by a behaviour case —
 * `index.ts` is not importable under vitest, because importing it runs the
 * `whenReady` microtasks that reach `services/menu.ts` and exit 1 before
 * `createWindow()` is ever called (A25, stated in `services/theme/store.test.ts`)
 * — so this reads the source as text, the instrument the three existing source
 * walks already use.
 *
 * Two halves, because either alone has a hole. The positive half pins the flag
 * *inside* `createWindow`'s `new BrowserWindow({ … })` options, so a
 * restructured object that drops the member altogether reddens instead of
 * passing vacuously. The absence half walks all of `electron/main/` for a
 * `sandbox: false` anywhere — a new window, or a flip in a place this slice
 * never thought to look — and reports each hit as `file:line`.
 *
 * The forbidden token is composed rather than spelled, so the case cannot match
 * its own source if the walk is ever widened to `test/`.
 */
describe('audit U1 — the main window is created sandboxed', () => {
  it('sets `sandbox: true` in `createWindow`, and no code turns it off', () => {
    const root = process.cwd()
    const source = readFileSync(join(root, 'electron/main/index.ts'), 'utf8')

    // Positive half: the flag must sit inside `createWindow`'s window options.
    const start = source.indexOf('new BrowserWindow({')
    // A slice that silently found nothing would satisfy nothing below, loudly.
    expect(start).toBeGreaterThan(-1)
    const options = source.slice(start, source.indexOf('})', start))
    expect(options).toMatch(/sandbox:\s*true/)

    // Absence half: no `sandbox: false` anywhere in the main process.
    const forbidden = new RegExp('sandbox' + '\\s*:\\s*' + 'false')
    const offenders = sources(join(root, 'electron/main')).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((text, i) => ({ text: text.trim(), at: i + 1 }))
        // A whole-line comment that names the rule is documentation, not a flip.
        .filter(({ text }) => !/^(\/\/|\*|\/\*)/.test(text) && forbidden.test(text))
        .map(({ text, at }) => `${path.slice(root.length + 1)}:${at}  ${text.slice(0, 120)}`)
    )
    expect(offenders).toEqual([])
  })
})

/**
 * Invariant 8, enforced in its sharpest form: **an IPC handler does no file,
 * path or process work of its own** — that is orchestration, and it belongs in
 * `electron/main/services/` where it can be tested without the IPC layer. The
 * 2026-09-24 audit moved the three handlers that did (`library:updateBook`,
 * `metadata:rehydrateBook`, `theme:openFolder`); this keeps the next one out.
 */
describe('invariant 8 — IPC handlers do no file or process work of their own', () => {
  it('no electron/main/ipc file imports fs, path or child_process', () => {
    const dir = join(process.cwd(), 'electron/main/ipc')
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
      .filter((f) =>
        /from '(fs|fs\/promises|path|child_process)'/.test(readFileSync(join(dir, f), 'utf8'))
      )
    expect(offenders).toEqual([])
  })
})

/**
 * Invariant 9's channel, pinned: **`musaeum://` stays `corsEnabled`.** The
 * renderer reads book bytes with `fetch('musaeum://book/…')` from a `file://`
 * (packaged) or `http://localhost` (dev) origin, and on Electron 44 Chromium
 * refuses that cross-origin fetch — `Failed to fetch`, before our handler runs —
 * unless the scheme carries the flag (measured 2026-09-25; 37 did not need it).
 * The electron mock stubs `registerSchemesAsPrivileged`, so no behavior test
 * can see the flag go missing; the reader would just stop opening books.
 */
describe('invariant 9 — the musaeum scheme keeps the privileges the reader fetches through', () => {
  it('registers musaeum as standard, secure, fetch-capable and CORS-enabled', () => {
    const source = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8')
    const start = source.indexOf('registerSchemesAsPrivileged(')
    const call = source.slice(start, source.indexOf('])', start))
    // A slice that silently found nothing would satisfy nothing below, loudly.
    expect(start).toBeGreaterThan(-1)
    expect(call).toContain("scheme: 'musaeum'")
    for (const privilege of ['standard', 'secure', 'supportFetchAPI', 'corsEnabled']) {
      expect(call).toMatch(new RegExp(`\\b${privilege}: true\\b`))
    }
  })
})

/**
 * Invariant 11, enforced: **`vendor/foliate-js/` is never edited.** Divergences
 * live in our code or `src/types/foliate-js.d.ts`. One commit — the vendoring —
 * has ever touched the tree; a re-vendor is a deliberate act that updates the
 * count below in the same commit. CI checks out full history for this.
 */
describe('invariant 11 — vendor/foliate-js is never edited', () => {
  const git = (cmd: string) => execSync(cmd, { cwd: process.cwd(), encoding: 'utf8' }).trim()

  it('has no uncommitted change', () => {
    expect(git('git status --porcelain -- vendor/foliate-js')).toBe('')
  })

  it('has been touched by exactly the one vendoring commit', () => {
    expect(
      git('git log --format=%H -- vendor/foliate-js').split('\n').filter(Boolean)
    ).toHaveLength(1)
  })
})

/**
 * Highlights and notes, slice 1, enforced: **a book's own record has one reader.**
 *
 * `{book}/annotations.json` is a third canonical file beside `metadata.json` and
 * `shelves.json`, and the rule that keeps it one is that a single pair of modules owns it:
 * the name, the parser and the atomic write live in `services/annotations-file.ts`, and
 * every read and write of it in `services/annotations.ts`. A second reader — a card badge,
 * a facet count, a future exporter — would be a second place the file's shape is
 * understood, and the drift would surface as data loss rather than as a build error
 * (annotations design D1/D3, AC8).
 *
 * **The literal is spelled here rather than imported from the constant it guards**, and the
 * reason is this file's own project: `tsconfig.web.json` lists `src/**` and `test/**` only,
 * so importing `electron/main/services/annotations-file.ts` is a `TS6307` and `npm run
 * typecheck` fails (the same boundary `reader-palette.test.ts` records). Both halves of the
 * walk are kept honest against that: the literal must be spelled by *exactly* the module
 * that builds the path (so a rename reddens this test rather than emptying it), and the
 * service must still be importing that module (so deleting the reader reddens it too).
 *
 * The import half exists because the literal half alone has a hole the review found: a second
 * reader that took the exported `annotationsPath()` builder — a card badge, a facet count, an
 * exporter — never spells the name, and four such modules would have passed. A trailing
 * comment is stripped before either check, so naming the file in a comment is still free.
 */
describe('a book’s annotations file has one reader', () => {
  it('is spelled by one module, and imported only by the service that owns its rules', () => {
    const root = process.cwd()
    const literal = 'annotations.json'
    const file = 'electron/main/services/annotations-file.ts'
    const service = 'electron/main/services/annotations.ts'

    /** A source file's lines with comments taken out: a comment that names the rule is
     *  documentation rather than a read, and this walk is about reads. */
    const codeLines = (path: string): string[] =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((text) => text.replace(/\/\/.*$/, ''))
        .map((text) => text.trim())
        .filter((text) => text !== '' && !/^(\*|\/\*)/.test(text))

    const walked = ['src', 'electron', 'sidecar'].flatMap((tree) => sources(join(root, tree)))

    // Exactly one module spells the file's name: the one that builds the path from the folder.
    const naming = walked
      .filter((path) => codeLines(path).some((text) => text.includes(literal)))
      .map((path) => relative(root, path))
    expect(naming).toEqual([file])

    // The path builder is the door a second reader would come through — `annotationsPath()`
    // needs no literal — so this names who may import it. A badge, a facet count or an
    // exporter that took the builder instead of the name is what this half catches.
    const importing = walked
      .filter((path) =>
        codeLines(path).some((text) => /from ['"].*annotations-file['"]/.test(text))
      )
      .map((path) => relative(root, path))
    expect(importing.filter((path) => path !== service)).toEqual([])
    // …and the service is still one of them, so the walk cannot pass by having lost the module.
    expect(importing).toContain(service)
  })
})
