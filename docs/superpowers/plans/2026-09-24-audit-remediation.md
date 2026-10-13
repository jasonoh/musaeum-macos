# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the findings of the 2026-09-24 whole-codebase audit — one invariant violation, missing CI, Electron window hardening, sidecar robustness, test gaps, and doc drift — without bending any `CLAUDE.md` invariant.

**Architecture:** Each task is an independent, separately-committable fix on `main`'s layer boundaries (`electron/main` ⇄ `src` ⇄ `sidecar`). No schema, `metadata.json` or REST wire-shape change is in scope. Work that needs a design decision or a manual in-app check is marked **USER** and is not to be done unattended.

**Tech Stack:** Electron + TypeScript (vitest via `npm test`, which runs Electron-as-Node), React/Tailwind/Zustand renderer, Python 3.12 sidecar (pytest via `sidecar/.venv/bin/python -m pytest sidecar/tests`).

**Spec:** the audit report is this plan's spec; its findings are restated under each task's **Why** so the plan stands alone.

## Resuming this plan (read first in a new session)

1. `git log --oneline -20` — every completed task is one commit whose subject starts with `audit(T<n>)`. That is the source of truth; the checkboxes below are a convenience and may lag.
2. Update the **Progress** table when a task lands (same commit).
3. Baseline before any work: `npm run typecheck && npm run lint && npm test` and `sidecar/.venv/bin/python -m pytest sidecar/tests -q` must all pass. On 2026-09-24: 1510 vitest passed / 2 skipped; 113 pytest passed.
4. Never `git add -A` — `.obsidian/workspace.json` churns on its own (until T5 lands). Stage named paths only.

## Progress

| Task | Title | Status |
|---|---|---|
| T1 | Sort keys derived in `db.updateBook` (invariant 4) | done |
| T2 | Window navigation guards + `openExternal` allowlist | done |
| T3 | CI workflow + lint fails on warnings | done (CI unproven until first push) |
| T4 | Sidecar dispatch never drops a reply | done |
| T5 | Doc drift + untrack `.obsidian/workspace.json` | done |
| T6 | `library:updateBook` orchestration moves to `services/` | done |
| T7 | `file-access.ts` tests | done |
| T8 | Sidecar tests: identifier precedence, cover-conflict positive case | done |
| T9 | Calibre-migration insert in one transaction | done |
| T10 | `orderedFormats()` in context menu and list Formats column | done |
| T11 | Dialog focus management | done — checked in-app 2026-09-24 via the verify skill (real CDP key events, isolated profile, disk-image Kindle): Settings, BookEditor, DeleteBook (detail + card), DeleteSelection, RemoveFromDevice — focus starts inside (Cancel on the three destructive ones), Tab/Shift-Tab wrap without escaping, Esc restores the opener |
| T12 | Source-scan tests for invariants 8 and 11 | done (also moved metadata:rehydrateBook → bulkHydrate.rehydrateBook, theme:openFolder → store.openThemeFolder) |
| T13 | Pin sidecar Python dependencies | done |
| U1 | **USER** — main window `sandbox: true` (needs in-app check) | todo |
| U2 | **USER** — Electron 37 → supported major + `@electron/rebuild` 4 | done 2026-09-25 — Electron 44.4.5, `@electron/rebuild` 4.2, better-sqlite3 13 (N-API prebuilds); `musaeum://` needed `corsEnabled` on 44 (pinned in `test/invariants.test.ts`); Node floor 22.12 (CI too). Packaged DMG checked on an isolated profile: `isPackaged` true, import + cover, reader renders, REST smoke 70/70 |
| U3 | **USER** — decide the deferred list at the end of this file | decided 2026-09-24 — see U3 below |
| N1 | `noUncheckedIndexedAccess` — theme subsystem (main) | done 2026-10-13 — 74 error instances → 0 across its 7 files (list re-measured at `9b20f21`: still exact); the flag stays off, N3/N5 flip it. Emitted-JS delta across the four source files is two behaviour-neutral constructs (paired `INK_STOPS`, base16's accents guard) — `obsidian.ts` and `itermcolors.ts` emit byte-identical JS |
| N2 | `noUncheckedIndexedAccess` — rest of main source | done 2026-10-13 — 27 error instances → 0 across its 9 files (list re-measured at `bd8b056`: still exact, and it is the plan's 8/22 table that was short by `services/device-covers.ts` and `ipc/metadata.ts`); the flag stays off, N3/N5 flip it. Emitted-JS delta across the nine files is five behaviour-neutral constructs (two Electron dialog-path destructures, a `device-covers` owner guard, `importer`'s first-author local, `db`'s prefs row local) — `api/auth.ts`, `api/bind.ts`, `nas-manager.ts` and `storage-kind.ts` emit byte-identical JS; node project 120 → 93, exactly the 27, with nothing new appearing elsewhere |
| N3 | `noUncheckedIndexedAccess` — main tests; flip `tsconfig.node.json` | done 2026-10-13 — 91 error instances → 0 across its 18 files (re-measured at `4829484`: the re-measured 18/91, not the 11/58 written at `:619` — that row also never named `annotations`, `shelves`, `reflow`, `library-sync`, `cover-choice`, `book-delete` or `ipc/shelves`); **the flag is now ON in `tsconfig.node.json`**, made a build too (`npm run build` exits 0), and `tsconfig.web.json` is untouched so the web project still reports 67 under the CLI flag. The diff is 68 bang-only lines plus `importer.test.ts`'s eight declaration rewrites (`const [r] = await X()` → `const (await X())[0]!`, runtime-identical for the `ImportResult[]` it resolves to, chosen so no `expect(...)` argument changes text) and `cover-choice.test.ts`'s one own-line block form; emitted JS is byte-identical for 17 of 18 files, the delta being exactly those eight lines. No matcher, `it()` name, fixture or asserted value changed anywhere. `annotations.test.ts` (6 drift lines) and `conflicts.test.ts` (8) were already over `printWidth` at HEAD and their pre-existing regions are left as they were |
| N4 | `noUncheckedIndexedAccess` — renderer source + `src/types` | done 2026-10-13 — 14 error instances → 0 across its 8 files (list re-measured at `a11057f`: still exact, the second of the two lists that had not moved); the flag stays off, N5 flips `tsconfig.web.json`. Emitted-JS delta across the eight files is three behaviour-neutral constructs (the `DeleteSelectionDialog` destructure, `useDialogFocus`'s first/last guard, `reader-search`'s `?? null` fallback) — `useBookNavigation.ts`, `ai-providers.ts`, `metadata-feedback.ts`, `recall.ts` and `types/book.types.ts` emit byte-identical JS, so invariant 4's derivation is provably untouched; web project 81 → 67 (exactly the 14) and the node project 93 → 91, `book.types.ts` being the shared file N3's flip was waiting on |
| N5 | `noUncheckedIndexedAccess` — renderer tests; flip `tsconfig.web.json` | done 2026-10-13 — 67 error instances → 0 across its 15 files (list re-measured at `0176639`: still exact, and it is the plan's 9/38 row at `:621` that is stale — the six files it never named are `cover-picker-wiring`, `cover-candidate-state`, `annotations`, `library.store`, `drag-regions` and `shelves.store`); **the flag is now ON in `tsconfig.web.json`**, made a build too (`npm run build` exits 0), so both projects stand at zero with the flag written into the file and the series closes. The diff is 58 lines, every one a `!` insertion: 66 new `!` characters for the 67 errors (one clears two, through `tokenOf`'s inferred return), 55 of the 58 removed/added pairs byte-identical once the `!`s are erased and the other 3 pairing with a removed line that already carried one. Emitted JS is byte-identical for **all fifteen** files — a stronger no-behaviour-change claim than any earlier slice could make. No matcher, `it()` name, fixture or asserted value moved, and no destructuring pattern needed the local-binding rewrite; all fifteen were prettier-clean at HEAD and remain clean |

## Global Constraints

- The 12 invariants in `CLAUDE.md` hold after every task. If a task would bend one, stop and hand back.
- Business logic in `electron/main/services/`; IPC handlers stay thin via `handle()`.
- No `any`; shared interfaces live in `src/types/`.
- Markdown prose is not hard-wrapped (one line per paragraph/bullet).
- Commit per task, subject `audit(T<n>): <summary>`, ending with the `Co-Authored-By` line the session supplies.
- Every task ends with the full gate green: `npm run typecheck && npm run lint && npm test` (+ pytest for sidecar tasks).

## Review Focus

- A metadata-editor save that sets a **custom** sort title must keep it — T1's derivation only fills a sort key the patch did not supply (test in T1).
- An edit that changes the author to empty must clear `authorSort` to `null`, not leave the old one (test in T1).
- `mailto:` links and in-app `musaeum://` resources must keep working after T2 — only `http:`/`https:`/`mailto:` open externally; in-app loads are untouched (test in T2).
- In dev, the Vite dev-server URL must stay navigable after T2's `will-navigate` guard (the guard allows the window's own origin; test in T2).
- A sidecar request that is valid JSON but not an object (`[]`, `"x"`, `3`) must produce an error frame or a stderr line, never silence (test in T4).

---

### T1: Sort keys derived in `db.updateBook` (invariant 4)

**Why:** `services/conflicts.ts:60` resolves a `title`/`author` conflict through `db.updateBook`, which writes the column and never re-derives `sort_title`/`author_sort`. `catalog.ts:40` (`withSortKeys`) only backfills a *missing* key, so the stale key is permanent: a book renamed by the review queue sorts under its old letter forever. The metadata editor escapes only because `src/components/library/BookEditor.tsx:107` derives in the renderer. Deriving at the one write primitive fixes the conflict path and every future caller.

**Files:**
- Modify: `electron/main/services/db.ts:535` (`updateBook`)
- Test: `electron/main/services/db.test.ts`, `electron/main/services/conflicts.test.ts`
- Doc: `docs/invariants/library-views.md` (the sort-key write-path list — add `db.updateBook` as the derivation point for patches)

**Interfaces:** Produces: `updateBook(id, updates)` now guarantees — if `updates.title !== undefined && updates.sortTitle === undefined` it also writes `sortableTitle(title)`; if `updates.author !== undefined && updates.authorSort === undefined` it also writes `sortableAuthor(author)`. An explicit `sortTitle`/`authorSort` in the patch always wins.

- [ ] **Step 1: Write the failing tests** (append to `db.test.ts`; add `updateBook` to its import list)

```ts
describe('updateBook — sort keys follow the fields they are derived from', () => {
  it('re-derives sortTitle when a patch changes the title', () => {
    insertBook({ ...makeBook('a', 'The Bakery Attack'), sortTitle: 'Bakery Attack, The' })
    updateBook('a', { title: 'After the Quake' })
    expect(getBook('a')?.sortTitle).toBe('After the Quake')
  })

  it('re-derives authorSort when a patch changes the author', () => {
    insertBook({ ...makeBook('a'), author: 'Haruki Murakami', authorSort: 'Murakami, Haruki' })
    updateBook('a', { author: 'Ursula K. Le Guin' })
    expect(getBook('a')?.authorSort).toBe('Le Guin, Ursula K.')
  })

  it('clears authorSort when the author is cleared', () => {
    insertBook({ ...makeBook('a'), author: 'Haruki Murakami', authorSort: 'Murakami, Haruki' })
    updateBook('a', { author: null })
    expect(getBook('a')?.authorSort).toBeNull()
  })

  it('keeps a sort key the patch supplies explicitly (the editor’s custom sort title)', () => {
    insertBook(makeBook('a', 'The Road'))
    updateBook('a', { title: 'The Road', sortTitle: 'Zzz custom' })
    expect(getBook('a')?.sortTitle).toBe('Zzz custom')
  })

  it('leaves sort keys alone when the patch touches neither field', () => {
    insertBook({ ...makeBook('a', 'The Road'), sortTitle: 'Road, The' })
    updateBook('a', { publisher: 'Knopf' })
    expect(getBook('a')?.sortTitle).toBe('Road, The')
  })
})
```

And in `conflicts.test.ts`, after the "renames the book files" case:

```ts
  it('re-derives the sort title when a title conflict resolves (invariant 4)', async () => {
    await seed('a', 'The Bakery Attack')
    updateBook('a', { sortTitle: 'Bakery Attack, The' })
    insertConflict('a', 'title', [{ source: 'google_books', value: 'After the Quake' }])

    await resolveConflict(soleConflictId(), { title: 'google_books' })

    expect(getBook('a')?.sortTitle).toBe('After the Quake')
  })
```

(add `updateBook` to that file's `./db` import).

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- electron/main/services/db.test.ts electron/main/services/conflicts.test.ts`
Expected: the re-derive/clear cases FAIL (sortTitle stays `'Bakery Attack, The'`); the explicit and untouched cases pass.

- [ ] **Step 3: Implement** — at the top of `updateBook` in `db.ts`:

```ts
export function updateBook(id: string, updates: Partial<Book>): void {
  // Invariant 4 at the write primitive: a patch that moves a title or author
  // moves its sort key too, unless it names one itself (the editor's custom
  // sort title). Without this a resolved title conflict kept its old key for
  // good — catalog adoption only fills a *missing* key, never a stale one.
  const patch: Partial<Book> = { ...updates }
  if (patch.title !== undefined && patch.sortTitle === undefined && patch.title !== null) {
    patch.sortTitle = sortableTitle(patch.title)
  }
  if (patch.author !== undefined && patch.authorSort === undefined) {
    patch.authorSort = sortableAuthor(patch.author)
  }
  const sets: string[] = []
  const params: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
```

(rest of the function unchanged; `sortableTitle`/`sortableAuthor` are already imported at `db.ts:13`).

- [ ] **Step 4: Run tests to verify they pass** — same command; then the full gate.
- [ ] **Step 5: Doc** — in `docs/invariants/library-views.md`, where the write paths deriving sort keys are listed, add: "`db.updateBook` derives both keys for any patch that changes `title`/`author` without naming the key — the conflict queue relies on this (fixed 2026-09-24)."
- [ ] **Step 6: Commit** `audit(T1): derive sort keys in db.updateBook so resolved conflicts re-sort`

---

### T2: Window navigation guards + `openExternal` allowlist

**Why:** `electron/main/index.ts:150` passes *any* URL from `setWindowOpenHandler` to `shell.openExternal`, and no `will-navigate` handler exists. Book iframes can't reach either today (their sandbox lacks `allow-popups`/`allow-top-navigation`), so this is defense in depth: a navigated main frame would get the full preload API, and `openExternal` on a custom scheme is the classic Electron exploit shape.

**Files:**
- Create: `electron/main/services/window-guards.ts`
- Test: `electron/main/services/window-guards.test.ts`
- Modify: `electron/main/index.ts:150-153` (+ import)

**Interfaces:** Produces `isExternalUrlAllowed(url: string): boolean` (true only for `http:`, `https:`, `mailto:`) and `isInAppNavigation(target: string, current: string): boolean` (true iff same origin, or both `file:` URLs).

- [ ] **Step 1: Failing test** `window-guards.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isExternalUrlAllowed, isInAppNavigation } from './window-guards'

describe('isExternalUrlAllowed', () => {
  it.each(['https://openlibrary.org/x', 'http://example.com', 'mailto:a@b.c'])('allows %s', (u) =>
    expect(isExternalUrlAllowed(u)).toBe(true)
  )
  it.each(['file:///etc/passwd', 'musaeum://book/x', 'javascript:alert(1)', 'smb://nas/x', 'not a url', ''])(
    'refuses %s',
    (u) => expect(isExternalUrlAllowed(u)).toBe(false)
  )
})

describe('isInAppNavigation', () => {
  it('allows the dev server reloading itself', () =>
    expect(isInAppNavigation('http://localhost:5173/#/x', 'http://localhost:5173/')).toBe(true))
  it('allows file: to file: (the packaged renderer)', () =>
    expect(isInAppNavigation('file:///A/index.html', 'file:///A/index.html#x')).toBe(true))
  it('refuses a remote origin', () =>
    expect(isInAppNavigation('https://evil.example/', 'http://localhost:5173/')).toBe(false))
  it('refuses file: from a packaged window to a remote page', () =>
    expect(isInAppNavigation('https://evil.example/', 'file:///A/index.html')).toBe(false))
  it('refuses garbage', () => expect(isInAppNavigation('::::', 'file:///A/index.html')).toBe(false))
})
```

- [ ] **Step 2:** `npm test -- electron/main/services/window-guards.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `window-guards.ts`:

```ts
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
```

- [ ] **Step 4: Wire** in `index.ts` (replace lines 150-153):

```ts
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrlAllowed(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isInAppNavigation(url, win.webContents.getURL())) event.preventDefault()
  })
```

and `import { isExternalUrlAllowed, isInAppNavigation } from './services/window-guards'`.
- [ ] **Step 5:** full gate green.
- [ ] **Step 6: Commit** `audit(T2): allowlist openExternal schemes and guard main-window navigation`

---

### T3: CI workflow + lint fails on warnings

**Why:** No `.github/workflows/` exists — "typecheck and lint pass on main" is enforced by memory only. `react-hooks/exhaustive-deps` is `warn` and `npm run lint` has no `--max-warnings`, so a stale-closure bug would pass lint.

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (`"lint": "eslint . --max-warnings=0"`)

- [ ] **Step 1:** change the lint script; run `npm run lint` → must still exit 0 (0 warnings today).
- [ ] **Step 2:** create `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    # macOS: better-sqlite3 is rebuilt against Electron in postinstall and the
    # suite runs Electron-as-Node (`npm test`), matching the dev machine.
    # storage-kind.test.ts's two `runIf(existsSync(...))` cases need the real
    # NAS/Dropbox mounts and skip here by design.
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: python -m venv sidecar/.venv && sidecar/.venv/bin/pip install -r sidecar/requirements.txt -r sidecar/requirements-dev.txt
      - run: sidecar/.venv/bin/python -m pytest sidecar/tests -q
```

- [ ] **Step 3:** validate YAML locally: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` (skip if PyYAML absent). The workflow is only proven on the first push — note in the commit body that it has not run yet.
- [ ] **Step 4: Commit** `audit(T3): add CI (typecheck, lint, vitest, pytest) and fail lint on warnings`

---

### T4: Sidecar dispatch never drops a reply

**Why:** `sidecar/main.py:94-96` reads `request.get("id")` outside the `try`. A line that is valid JSON but not an object raises `AttributeError` inside a `ThreadPoolExecutor` future nobody reads — no reply, no log; the Node caller waits out its 120–300 s timeout.

**Files:** Modify `sidecar/main.py:94-118`; Test: `sidecar/tests/test_main_dispatch.py` (create).

- [ ] **Step 1: Failing test**

```python
"""The dispatch loop's promise: every request gets a frame back, or stderr says why."""

import main


def _capture(monkeypatch):
    sent = []
    monkeypatch.setattr(main, "send", lambda frame: sent.append(frame))
    return sent


def test_non_object_request_is_reported_not_swallowed(monkeypatch, capsys):
    sent = _capture(monkeypatch)
    main.handle_request(["not", "an", "object"])
    assert sent == [] or sent[0]["error"] is not None
    assert "not a JSON-RPC object" in capsys.readouterr().err


def test_unknown_method_still_replies_with_error(monkeypatch):
    sent = _capture(monkeypatch)
    main.handle_request({"id": 7, "method": "nope"})
    assert sent[0]["id"] == 7
    assert "Unknown method" in sent[0]["error"]["message"]
```

(`sidecar/tests/conftest.py` already puts `sidecar/` on `sys.path` — confirm by reading it; if not, the test imports as `from sidecar import main` per the other tests' idiom.)
- [ ] **Step 2:** `sidecar/.venv/bin/python -m pytest sidecar/tests/test_main_dispatch.py -q` → first test FAILS with `AttributeError`.
- [ ] **Step 3: Implement**

```python
def handle_request(request: object) -> None:
    if not isinstance(request, dict):
        # No id to answer to: the caller's timeout is the only reply it can
        # get, so say so where a human will look.
        print(f"dropped request, not a JSON-RPC object: {str(request)[:200]}", file=sys.stderr)
        return
    req_id = request.get("id")
    try:
        method = request.get("method")
        ...  # unchanged body
```

- [ ] **Step 4:** pytest green (whole suite).
- [ ] **Step 5: Commit** `audit(T4): sidecar reports non-object requests instead of dropping them`

---

### T5: Doc drift + untrack `.obsidian/workspace.json`

**Why:** `docs/architecture.md:225` says the REST API has "one write"; `CLAUDE.md:197` and `docs/rest-api.md` say two (reading report + book upload). `.obsidian/workspace.json` is tracked and dirties the tree whenever the vault opens.

**Files:** `docs/architecture.md:225`, `.gitignore`.

- [ ] **Step 1:** in `docs/architecture.md:225` replace "six read routes and one write" with "six read routes and two writes (the reading report and a book upload)" and "still disabled by default" wording unchanged.
- [ ] **Step 2:** append to `.gitignore`:

```
# Obsidian's per-machine window state; the vault's settings and themes stay tracked
.obsidian/workspace.json
.obsidian/workspace-mobile.json
```

- [ ] **Step 3:** `git rm --cached .obsidian/workspace.json` (keeps the file on disk).
- [ ] **Step 4: Commit** `audit(T5): fix REST write count in architecture.md; stop tracking Obsidian workspace state`

---

### T6: `library:updateBook` orchestration moves to `services/`

**Why:** `electron/main/ipc/library.ts:44-72` is the one IPC handler that orchestrates (NAS check, row write, reading-state clock, field overrides, `metadata.json`, catalog, rename) instead of delegating — invariant 8. `docs/invariants/files-and-deletion.md` names `library:updateBook` as a rename call site; the behavior and ordering must not change.

**Files:**
- Create: `electron/main/services/library-edit.ts`, `electron/main/services/library-edit.test.ts`
- Modify: `electron/main/ipc/library.ts:44-72`
- Doc: `docs/invariants/files-and-deletion.md` — name `libraryEdit.updateBook` as the implementation behind `library:updateBook`.

**Interfaces:** Produces `export async function updateBook(id: string, updates: Partial<Book>): Promise<void>` in `services/library-edit.ts`.

- [ ] **Step 1: Failing test** — reuse `conflicts.test.ts`'s `beforeEach`/`afterEach` and `seed()` verbatim (copy them; they reset the DB, point `nas` at a temp root, write an empty catalog). Cases:

```ts
it('writes the row, metadata.json and renames files to the new title', async () => {
  const dir = await seed('a', 'Old Title')
  await updateBook('a', { title: 'New Title' })
  expect(getBook('a')?.title).toBe('New Title')
  expect(JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')).title).toBe('New Title')
  expect(await fs.readdir(dir)).toContain('New Title.epub')
})

it('marks changed fields as user overrides', async () => {
  await seed('a')
  await updateBook('a', { publisher: 'Knopf' })
  expect(list('a')).toContain('publisher')
})

it('refuses when the library is offline', async () => {
  await seed('a')
  vi.spyOn(nas, 'assertOnline').mockImplementation(() => { throw new Error('offline') })
  await expect(updateBook('a', { title: 'X' })).rejects.toThrow('offline')
})
```

(check `field-overrides.ts`'s `list` return shape before asserting — adapt `toContain` to it.)
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3: Implement** — move the handler body verbatim (comments included) into `library-edit.ts` as `updateBook`, with the imports it needs (`join`, `db`, `readingState`, `fieldOverrides`, `importer`, `librarySync`, `bookFiles`, `nas`, `broadcast`). Handler becomes:

```ts
  handle('library:updateBook', (id: string, updates: Partial<Book>) => libraryEdit.updateBook(id, updates))
```

Remove now-unused imports from `ipc/library.ts` (lint will flag them).
- [ ] **Step 4:** full gate green (existing ipc tests for `library:updateBook`, if any, must pass unchanged).
- [ ] **Step 5: Commit** `audit(T6): move library:updateBook orchestration into services/library-edit`

---

### T7: `file-access.ts` tests

**Why:** `revealBook`/`openBookFile` have no tests, yet this is where the `formats[0]` bug was measured on 1,372 books (`test/invariants.test.ts` docstring). Guard invariants 2 and 3 behaviorally.

**Files:** Create `electron/main/services/file-access.test.ts`.

- [ ] **Step 1:** Mock `electron`'s `shell` (`vi.mock('electron', async (orig) => ({ ...(await orig()), shell: { showItemInFolder: vi.fn(), openPath: vi.fn().mockResolvedValue('') } }))`), reuse the DB/NAS temp-root setup from `conflicts.test.ts`. Cases:
  - multi-format book `formats: ['pdf', 'epub']` with files `Renamed.PDF` and `Renamed.epub`: `revealBook(id)` reveals the **epub** (primary format per `FORMAT_ORDER`, not index 0).
  - renamed file (`Totally Different Name.epub`, title `Book a`): `openBookFile(id, 'epub')` opens it (extension lookup, case-insensitive).
  - `openBookFile(id, 'mobi')` with no mobi file rejects `/No MOBI file/`.
  - missing folder rejects `/Book folder is missing/`.
  - no matching file for any format: `revealBook` falls back to `shell.openPath(dir)`.
- [ ] **Step 2:** run; these are characterization tests and should PASS on current code. If one fails, stop — it is a live bug; hand back.
- [ ] **Step 3: Commit** `audit(T7): cover file-access reveal/open by extension and primary format`

---

### T8: Sidecar tests — identifier precedence and the cover-conflict positive case

**Why:** `docs/invariants/metadata-hydration.md:27` says identifiers baked into the file override fetched ones (`pipeline/hydration.py:71-75`), but no test has a fetcher disagree. The cover conflict (top two candidates within 15%, `pipeline/hydration.py:82-95`, `pipeline/cover.py:146`) is only tested in the negative.

**Files:** Create `sidecar/tests/test_hydration_precedence.py`.

- [ ] **Step 1:** Read `pipeline/hydration.py` (`hydrate_metadata` signature, how `known`/embedded identifiers flow, how `_safe` wraps fetchers) and `test_hydration_locks.py` (`_epub`, `_offline` monkeypatch idiom). Write:
  - `test_embedded_isbn_beats_a_fetched_one`: EPUB with ISBN `9780000000001`; monkeypatch `hydration.fetch_google_books` to return a record with `identifiers: {"isbn_13": "9780000000002"}`; others offline. Assert result `identifiers["isbn_13"] == "9780000000001"`.
  - `test_close_cover_candidates_queue_a_review_conflict`: monkeypatch the cover selection (`pipeline.cover.select_cover` or whatever `hydration.py` calls — read first) to return two candidates whose scores are within 15% with `review=True`; assert the result's `conflicts` contains an entry with `field == "cover"` and both candidate sources.
- [ ] **Step 2:** run; both are characterization tests and should PASS. A failure is a live bug — stop and hand back.
- [ ] **Step 3: Commit** `audit(T8): pin identifier precedence and the cover-review conflict`

---

### T9: Calibre-migration insert in one transaction

**Why:** `electron/main/services/migration.ts:293-330` (`insertMigratedBooks`) inserts 7000+ rows with one implicit commit each; `db.replaceAllBooks` (`db.ts:655`) shows the house pattern of one `db.transaction`. Per-row failure logging must be preserved (a bad record must not roll back the rest).

**Files:** Modify `electron/main/services/migration.ts:293`.

- [ ] **Step 1: Implement** — wrap the loop: `db.getDb().transaction(() => { for (...) { ...try { db.insertBook(book) } catch {...} } })()`. The inner try/catch stays, so one failing row is logged and skipped inside the transaction (better-sqlite3 only rolls back if the exception escapes the transaction function). Confirm `getDb` is exported from `db.ts` (it is imported by `db.test.ts`).
- [ ] **Step 2:** full gate green. (No migration test exists; a unit test for this glue is out of scope — see U3.)
- [ ] **Step 3: Commit** `audit(T9): insert migrated books in a single transaction`

---

### T10: `orderedFormats()` in context menu and list Formats column

**Why:** `src/components/library/BookContextMenu.tsx:145` and `src/components/library/ListView.tsx:112-121` iterate `book.formats` in storage order, so "Open MOBI" can precede "Open EPUB". `BookCard.tsx:154` already uses `orderedFormats()`.

**Files:** those two components.
- [ ] **Step 1:** replace `book.formats.map(` with `orderedFormats(book).map(` (check `orderedFormats`'s signature in `src/types/book.types.ts:169-189` — it may take the array, not the book), importing from `@shared/book.types`.
- [ ] **Step 2:** full gate green.
- [ ] **Step 3: Commit** `audit(T10): list formats in preference order in the context menu and list view`

---

### T11: Dialog focus management

**Why:** `BookEditor`, `DeleteBookDialog`, `DeleteSelectionDialog`, `RemoveFromDeviceDialog`, `SettingsModal` set `role="dialog" aria-modal="true"` but never move focus in, trap Tab, or restore focus on close.

**Files:** Create `src/hooks/useDialogFocus.ts` (+ `src/hooks/useDialogFocus.test.ts` if the renderer test setup supports DOM — check `vitest.config.ts` environment; if node-only, skip the test and verify via the `verify` skill). Modify the five dialogs.

**Interfaces:** `useDialogFocus(ref: RefObject<HTMLElement>): void` — on mount: remember `document.activeElement`, focus the first `[data-autofocus]` or first focusable in `ref`; on `keydown` Tab/Shift-Tab: wrap within `ref`'s focusables; on unmount: restore focus to the remembered element if still in the document.

- [ ] **Step 1: Implement**

```ts
import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** Focus into a modal on open, keep Tab inside it, and hand focus back on close. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const opener = document.activeElement as HTMLElement | null
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    ;(root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? root).focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    root.addEventListener('keydown', onKey)
    return () => {
      root.removeEventListener('keydown', onKey)
      if (opener?.isConnected) opener.focus()
    }
  }, [ref])
}
```

- [ ] **Step 2:** in each dialog: `const panelRef = useRef<HTMLDivElement>(null)`, `useDialogFocus(panelRef)`, `ref={panelRef}` + `tabIndex={-1}` on the `role="dialog"` element. For destructive dialogs put `data-autofocus` on **Cancel**, not the destructive button. Check each dialog's existing global keyboard handling (selection-and-keyboard invariant: ⌘A etc.) is not broken — read `docs/invariants/selection-and-keyboard.md` first.
- [ ] **Step 3:** full gate; then in-app check via the `verify` skill if available (open each dialog, Tab cycles inside, Esc returns focus to the opener).
- [ ] **Step 4: Commit** `audit(T11): focus management for modal dialogs`

---

### T12: Source-scan tests for invariants 8 and 11

**Why:** Only invariant 3 is mechanically enforced. Two more are cheap to scan: IPC handlers must not do file/path work themselves (8), and `vendor/foliate-js/` is never edited (11).

**Files:** Modify `test/invariants.test.ts`. Depends on T6 (otherwise `ipc/library.ts` imports `path`).

- [ ] **Step 1:** first run `grep -nE "from '(fs|fs/promises|path|child_process)'" electron/main/ipc/*.ts`. If anything besides `ipc/library.ts` (fixed by T6) matches, list it and hand back — it is a finding, not something to suppress.
- [ ] **Step 2:** add:

```ts
describe('invariant 8 — IPC handlers do no file or process work of their own', () => {
  it('no electron/main/ipc file imports fs, path or child_process', () => {
    const root = process.cwd()
    const dir = join(root, 'electron/main/ipc')
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
      .filter((f) => /from '(fs|fs\/promises|path|child_process)'/.test(readFileSync(join(dir, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('invariant 11 — vendor/foliate-js is never edited', () => {
  it('has no uncommitted change and exactly one commit touching it', () => {
    const run = (cmd: string) => execSync(cmd, { cwd: process.cwd(), encoding: 'utf8' }).trim()
    expect(run('git status --porcelain -- vendor/foliate-js')).toBe('')
    expect(run('git log --format=%H -- vendor/foliate-js').split('\n').filter(Boolean)).toHaveLength(1)
  })
})
```

with `import { execSync } from 'child_process'`. **Before committing, verify** `git log --format=%H -- vendor/foliate-js | wc -l` is `1` today; if it is more (a sanctioned re-vendor), pin the expected count to today's value and say so in a comment. CI's `actions/checkout` defaults to a shallow clone — set `fetch-depth: 0` in `ci.yml` in this same task so the history check works there.
- [ ] **Step 3:** full gate green. **Step 4: Commit** `audit(T12): source-scan invariants 8 and 11`

---

### T13: Pin sidecar Python dependencies

**Why:** `sidecar/requirements.txt` is all `>=`, and packaged builds `pip install` it on first launch (`electron/main/services/python-env.ts`, `docs/invariants/packaging-and-python.md`) — a user months after a release gets untested versions.

**Files:** `sidecar/requirements.txt`, `docs/invariants/packaging-and-python.md`.
- [ ] **Step 1:** `sidecar/.venv/bin/pip freeze` — take the installed version of each *top-level* package listed in `requirements.txt` and rewrite each line as `pkg==X.Y.Z` (top-level only; no hashes — the bootstrap's `pip install -r` must keep working unchanged). Read `python-env.ts` to confirm it installs from this file and whether it checks for a changed requirements hash to re-bootstrap (if it does, note that pinning triggers one reinstall).
- [ ] **Step 2:** pytest green in the existing venv.
- [ ] **Step 3:** doc line in `packaging-and-python.md`: requirements are pinned exactly; bump deliberately and re-run pytest.
- [ ] **Step 4: Commit** `audit(T13): pin sidecar top-level dependencies`

---

### U1 (USER): main window `sandbox: true`

`electron/main/index.ts:144` sets `sandbox: false` with no stated reason; the theme window uses `sandbox: true`. The preload imports only `contextBridge`, `ipcRenderer`, `webUtils` from `electron` plus bundled `@shared` constants, which a sandboxed preload supports — but electron-vite's preload output must be CommonJS and self-contained. Needs: flip the flag, `npm run build`, launch, and exercise drag-and-drop import (`webUtils.getPathForFile`), the reader, settings, and a device send. Do this with the user or via the `verify` skill; add a comment either way.

### U2 (USER): Electron upgrade

`package.json` pins `electron ^37.2.0`; latest is 44.x and Electron patches only the newest three majors, so 37 is receiving no Chromium fixes while the app runs a network-listening REST server. Bundle with `@electron/rebuild` 3.7 → 4.x (clears 18 dev-time `npm audit` advisories, 1 critical). Needs the user: a major upgrade touching `better-sqlite3`'s native rebuild, `app.isPackaged` (invariant 10), packaging and the reader. Update `CLAUDE.md`'s "Electron (latest LTS)" claim when done.

### U3 (USER): deferred — decide or drop

Decided with the user 2026-09-24.

- **Dropped** — `migration.ts` / `pipeline/migrate.py` have no direct tests. No second migration run is planned. Measured: of 7,671 importable Calibre books (`/Volumes/books/library/metadata.db`, untouched since 2026-07-06), ~420 match nothing in the DB by ISBN, Goodreads ID or exact title, plus 208 more that are likely title variants. That fits the 637 on-disk-but-unlisted folders `tasks.md` already records, so the gap is adoption, not a migration defect.
- **Do** — EPUB XML via stdlib `ElementTree` + no zip-member size cap (`sidecar/extractors/epub_metadata.py:23,44,113`) — `defusedxml` + a size guard. Landed as `audit(U3)`.
- **Open** — `db.findByTitleAuthor` (`db.ts:628`) full scan per import — index on normalized title/author needs a migration (contracts-engineer).
- **Open** — Sidecar `ThreadPoolExecutor(max_workers=4)` shared between hour-long migration and interactive calls.
- **Measured → sliced as N1–N5 below** — `tsconfig` `noUncheckedIndexedAccess`.
- **Open** — `ListView.tsx:99-110` cells vs `docs/invariants/library-views.md`'s "block-level child" wording — measure in-app, then align code or doc.
- **Open** — The `electron/main/services/theme/` subsystem (~3k lines) was not audited.
- **Open** — No tests for `sidecar.ts`, `library.store.ts`, `ui.store.ts`.

### N1–N5: `noUncheckedIndexedAccess`

**Measured 2026-09-24 at `698f4b2`** with `npx tsc --noEmit -p tsconfig.{node,web}.json --noUncheckedIndexedAccess`: **208 errors in 43 files** — 79 in 20 source files, 129 in 23 test files (`src/types/book.types.ts` is in both projects and counts twice). Codes in source: TS2322 ×27, TS2345 ×23, TS2532 ×16, TS18048 ×12, TS2722 ×1. Over the ~10-file bound, so it is sliced by layer; each slice is one commit `audit(N<n>): …` and ends with the full gate green.

**Rules for every slice:**

- No behavior change. Narrow with a real check (`if (x === undefined) …`, `?? fallback`, destructuring with a guard) where the missing case can actually happen, and say in the commit which reads are genuinely bounded (loop over `.length`, a regex group that must match) — those may use `!`, sparingly. Tests may use `!` or a small `at(i)` helper freely.
- Per-slice check: the slice's files drop to zero under the flag via the CLI command above; the flag itself goes into the tsconfig only in N3 (node) and N5 (web), once that project is at zero.
- Re-measure before starting — the counts below drift as code lands.

| Slice | Owner | Files (errors) |
|---|---|---|
| **N1** theme (main) | main-engineer | `services/theme/derive.ts` (13), `theme/parse/obsidian.ts` (12), `theme/parse/base16.ts` (10), `theme/parse/itermcolors.ts` (6), `theme/store.test.ts` (15), `theme/importer.test.ts` (10), `theme/derive.test.ts` (8) — 7 files, 74 |
| **N2** main source | main-engineer | `ipc/nas.ts` (5), `services/api/bind.ts` (4), `services/db.ts` (3 — `:60`, `:377` invokes a possibly-undefined function, `:793`), `services/importer.ts` (3), `services/storage-kind.ts` (3), `services/file-watcher.ts` (2), `services/api/auth.ts` (1), `services/nas-manager.ts` (1) — 8 files, 22 |
| **N3** main tests + flip | test-author | `services/catalog.test.ts` (12), `services/api/upload.test.ts` (10), `services/importer.test.ts` (9), `services/ai.test.ts` (9), `ipc/nas.test.ts` (5), `services/device-manager.test.ts` (4), `services/bulk-hydrate.test.ts` (3), `api/upload.test.ts` (2), `services/api/shape.test.ts` (2), `api/rest.test.ts` (1), `services/conflicts.test.ts` (1) — 11 files, 58; then add `"noUncheckedIndexedAccess": true` to `tsconfig.node.json`. Needs N1, N2 and `book.types.ts` from N4 first. |
| **N4** renderer source + types | renderer-engineer (+ contracts-engineer for `src/types/book.types.ts:374,380`) | `src/lib/recall.ts` (4), `src/types/book.types.ts` (2), `src/hooks/useBookNavigation.ts` (2), `src/hooks/useDialogFocus.ts` (2), `src/lib/ai-providers.ts` (1), `src/lib/metadata-feedback.ts` (1), `src/lib/reader-search.ts` (1), `src/components/library/DeleteSelectionDialog.tsx` (1) — 8 files, 14 |
| **N5** renderer tests + flip | test-author | `src/lib/theme/css.test.ts` (15), `src/lib/theme/reader-palette.test.ts` (13), `ask-context.test.ts` (2), `ask-session.test.ts` (2), `theme/palette-scan.test.ts` (2), `add-books.test.ts` (1), `ai-providers.test.ts` (1), `reader-search.test.ts` (1), `stores/reader.store.test.ts` (1) — 9 files, 38; then add the flag to `tsconfig.web.json`. Needs N4. |

Order: N1 ∥ N2 ∥ N4 → N3 → N5. `book.types.ts` is in both projects, so N3's flip waits on N4 too.

### The N-series re-measured 2026-10-13, at `d4d3ef6` (N1 landed)

The lists above are the figures this plan was written against on 2026-09-24. These are the remainder on the tree N1 landed on, taken with the rules' own command — re-measure again before starting, and quote the delta rather than the written number.

- **N2 — main source: 9 files, 27 instances** (written as 8/22). Two files are missing from the list above: `services/device-covers.ts` (6, the largest single file in the slice) and `ipc/metadata.ts` (1). The rest are as written: `ipc/nas.ts` (5), `services/api/bind.ts` (4), `services/storage-kind.ts` (3), `services/importer.ts` (3), `services/db.ts` (3), `services/nas-manager.ts` (1), `services/api/auth.ts` (1).
- **N3 — main tests + the `tsconfig.node.json` flip: 18 files, 91** (written as 11/58). New since it was written: `annotations.test.ts` (8), `shelves.test.ts` (5), `reflow.test.ts` (5), `library-sync.test.ts` (3), `cover-choice.test.ts` (3), `book-delete.test.ts` (1), `ipc/shelves.test.ts` (1). Grown: `catalog.test.ts` 12 → 14, `importer.test.ts` 9 → 12, `api/shape.test.ts` 2 → 4. And N1 took the three theme test files out of it entirely (33 instances).
- **N4 — renderer source + `src/types`: 8 files, 14 — still exact**, the second of the two lists that have not moved.
- **N5 — renderer tests + the `tsconfig.web.json` flip: 15 files, 67** (written as 9/38). New since it was written: `cover-picker-wiring.test.ts` (11), `cover-candidate-state.test.ts` (7), `annotations.test.ts` (5), `library.store.test.ts` (3), `drag-regions.test.ts` (2), `shelves.store.test.ts` (1).
- **Project totals at `d4d3ef6`:** `tsconfig.node.json` **120** (208 as written, 194 before N1), `tsconfig.web.json` **81** (as written). `src/types/book.types.ts` (2) is in both projects, so N3's and N5's flips still each wait on it, exactly as the order line says.

### N2 starts here

> Superseded as a starting point by _N5 starts here_ at the foot of this file — N2, N3 and N4 have landed since. Kept as the record of what N2 was dispatched with.

```bash
git log --oneline -3                                   # d4d3ef6 is N1 — N2 starts there, not at this plan's own base
npm run typecheck && npm run lint && npm test            # 0, 0, 2121 passed (97 files) — N1's numbers, and this slice must not move them
sidecar/.venv/bin/python -m pytest sidecar/tests -q      # 413 passed, and it must stay 413
npx tsc --noEmit -p tsconfig.node.json --noUncheckedIndexedAccess 2>&1 | grep -E '^electron/main/(ipc|services|api)/' | grep -v '\.test\.ts' | cut -d'(' -f1 | sort | uniq -c | sort -rn
```

That last command is the slice's acceptance check: before the work it prints the nine files above and 27 instances; after it, **nothing** in those nine — with `npm run typecheck` (the flag off) still 0, so nothing narrowed is left lying.

Read, in this order: this file's rules at `:609-613`; `CLAUDE.md`'s invariants — **3** (nothing reads `formats[0]`), **4** (sort keys derived at every write path) and **8** (business logic stays in `services/`), the three a narrowing edit in `services/db.ts` or `ipc/nas.ts` can bend; then the nine files, of which `services/db.ts` already carries the list's own annotation (`:60` and `:377` invoke a possibly-undefined function, `:793`) and `services/device-covers.ts` was not in the list at all.

**The two instruments N1 established are this slice's too**, and both are one command. The acceptance check above, whose _discrimination_ is its own pre-change count — it printed exactly these 27 before the work, which is what proves the flag reaches these files at all. And the **emitted-JS diff**, which is how a typing-only slice answers "no behaviour change" at all: `git archive HEAD <dir> | tar -x -C <scratch>/head --strip-components=<n>`, then `npx esbuild --target=es2022 <file>` each touched source file at `HEAD` and from the working copy (no `--loader`, which esbuild refuses once it is given a path) and `diff -ru` the two trees — `!`s and annotations vanish, so what is left is the runtime delta the record quotes. N1's was two constructs, both semantic no-ops, with two of its four files byte-identical.

The slice is 27 instances in 9 files, all under `electron/main/`: no renderer file, no `src/types/`, no sidecar, no `vendor/`. **The flag does not go in on this slice** — `tsconfig.node.json` gets it in N3, once that project is at zero. Bookkeeping in the same commit: this file's **Progress** table, N2's row. Stage named paths only.

### The N-series re-measured 2026-10-13, at `9a2a420` (N2, N3 and N4 landed)

Three of the four remaining slices have landed, so this is the series' last measurement before it closes. Taken with the rules' own commands, at the HEAD above.

- **N2 — main source: 9 files, 27 → 0** (`a11057f`). Node project 120 → 93. Emitted JS byte-identical for four of the nine files (`api/auth.ts`, `api/bind.ts`, `nas-manager.ts`, `storage-kind.ts`); the other five carried six hunks, all behaviour-neutral.
- **N4 — renderer source + `src/types`: 8 files, 14 → 0** (`4829484`). Web project 81 → 67, and the node project 93 → 91 because `src/types/book.types.ts` is in both. Emitted JS byte-identical for five of the eight, `types/book.types.ts` among them — so `sortableAuthor`, invariant 4's own derivation, was provably untouched.
- **N3 — main tests + the `tsconfig.node.json` flip: 18 files, 91 → 0** (`9a2a420`). **The node flag is now ON**: `npx tsc --noEmit -p tsconfig.node.json` is 0 and `npm run build` exits 0. Its diff is 70 single-`!` lines, three lines gaining a second `!`, `importer.test.ts`'s eight declaration rewrites and one own-line block form; emitted JS is byte-identical for 17 of the 18 files, the delta being exactly those eight lines.
- **N5 — renderer tests + the `tsconfig.web.json` flip: 15 files, 67 — the whole remainder, and it has not moved since `d4d3ef6`.** Both halves of the written 9/38 are stale.
- **Project totals at `9a2a420`:** `tsconfig.node.json` **0** with the flag on (120 at `d4d3ef6`, 208 as written); `tsconfig.web.json` **67** under the CLI flag (81 at `d4d3ef6`, as written) — and **every one of the 67 is a test file**: that project's `src/` with `*.test.ts` excluded is **0**, which is N4's result holding.

### N5 starts here

> Consumed — N5 landed in this commit, which is the slice that closes the series. Kept as the record of what N5 was dispatched with.

```bash
git log --oneline -4                                     # 9a2a420 is N3 — N2, N3 and N4 have landed, and N5 starts there
npm run typecheck && npm run lint && npm test            # 0, 0, 2121 passed (97 files) — the numbers this slice must not move
sidecar/.venv/bin/python -m pytest sidecar/tests -q      # 413 passed, and it must stay 413
npx tsc --noEmit -p tsconfig.web.json --noUncheckedIndexedAccess 2>&1 | grep -E '^src/' | grep '\.test\.ts' | cut -d'(' -f1 | sort | uniq -c | sort -rn
```

That last command is the acceptance check: before the work it prints the fifteen files and 67 instances below; after it, **nothing** — and then `tsconfig.web.json` gains `"noUncheckedIndexedAccess": true`, after which `npm run typecheck` must still be 0 **and `npm run build` must exit 0**. That build is the flip's real consumer and the ordinary gate cannot see it: N3's flip was proved that way, and a flipped tsconfig that breaks electron-vite type emission passes typecheck and lint alike.

The fifteen files, re-measured at `9a2a420` — exact, in the order the acceptance check prints them: `src/lib/theme/css.test.ts` (15), `src/lib/theme/reader-palette.test.ts` (13), `src/components/library/cover-picker-wiring.test.ts` (11), `src/lib/cover-candidate-state.test.ts` (7), `src/lib/annotations.test.ts` (5), `src/stores/library.store.test.ts` (3), `src/lib/theme/palette-scan.test.ts` (2), `src/lib/ask-session.test.ts` (2), `src/lib/ask-context.test.ts` (2), `src/components/reader/drag-regions.test.ts` (2), `src/stores/shelves.store.test.ts` (1), `src/stores/reader.store.test.ts` (1), `src/lib/reader-search.test.ts` (1), `src/lib/ai-providers.test.ts` (1), `src/lib/add-books.test.ts` (1).

Read, in this order: this file's rules at `:609-613`; `CLAUDE.md`'s invariants — **3** (nothing reads `formats[0]`), **5** (reading position _and_ read status survive the round trip) and **11** (`vendor/foliate-js/` is never edited), the three a test-file edit in these suites can bend; then the fifteen files.

What N3 learned, and N5 inherits:

- **The rules are more permissive inside tests**: "tests may use `!` or a small `at(i)` helper freely" (`:611`). What is _not_ permitted is changing what a test asserts — no matcher, `it()` name, fixture or asserted value moves to make a type error go away.
- **The suite's case count is the "no behaviour change" instrument for a test slice**, and it is stronger here than the emitted-JS diff: 97 files / 2121 passed before and after. A different total is a deleted case or a run that never happened, and those two read identically in a report.
- **Where a destructuring pattern cannot take a `!`** — `const [result] = await X()` — the fix is the local-binding rewrite `const result = (await X())[0]!` rather than an assertion at each use site, precisely so that no `expect(...)` argument changes text. N3 did that eight times in `importer.test.ts` and quoted the emitted-JS delta as the proof it is one evaluation.
- **Judge the diff mechanically before believing a "typing only" claim.** N3's was reconciled by pairing every removed line with its added line and requiring `added.replace(/!/g, '') === removed` for each pair: of 82 removed lines, 70 were single-`!` and three gained a second `!`, and the eleven that did not match were the eight rewrites plus three lines that already carried a `!`.
- **Pre-existing prettier dirt is left alone, and this repo has some.** Measured at `9a2a420`: `electron/main/services/annotations.test.ts` (6 differing lines) and `conflicts.test.ts` (8) are over `printWidth` 100 at HEAD, and `tsconfig.node.json` was too (its `include` array). The N-series' own precedent, and N1's before it, is to leave it, record it and not reformat — so expect `prettier --check` to fail on files this slice never touches, and do not "fix" them.

**Environment facts already paid for:** `npm install` has run (its postinstall rebuilt better-sqlite3) and `sidecar/.venv` exists; `.delta/` is in `eslint.config.mjs`'s ignores, so `npm run lint` is 0 on this tree; `npm test` must be invoked only as `npm test`, because it runs Electron-as-Node so the better-sqlite3 native ABI matches; the dev database is `~/Library/Application Support/Musaeum/musaeum.db` (WAL, readable while the app runs). Nothing in this slice needs the app launched. `CHANGELOG.md` and `docs/roadmap-history.md` are deliberately not updated by this series — it is typing-only, so there is nothing a user can see.

N5 is 15 files, past `CLAUDE.md`'s ~10-file escalation bound, so it is delegated as N3 was: one implementer in the tree at a time; the brief carries the rules, the baseline numbers, the scope and out-of-scope lists and "do not commit"; and the parent re-runs every gate, the bang-only reconciliation and the emitted-JS diff before it commits.
