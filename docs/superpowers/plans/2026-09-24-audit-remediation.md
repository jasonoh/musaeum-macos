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
| T4 | Sidecar dispatch never drops a reply | todo |
| T5 | Doc drift + untrack `.obsidian/workspace.json` | todo |
| T6 | `library:updateBook` orchestration moves to `services/` | todo |
| T7 | `file-access.ts` tests | todo |
| T8 | Sidecar tests: identifier precedence, cover-conflict positive case | todo |
| T9 | Calibre-migration insert in one transaction | todo |
| T10 | `orderedFormats()` in context menu and list Formats column | todo |
| T11 | Dialog focus management | todo |
| T12 | Source-scan tests for invariants 8 and 11 | todo |
| T13 | Pin sidecar Python dependencies | todo |
| U1 | **USER** — main window `sandbox: true` (needs in-app check) | todo |
| U2 | **USER** — Electron 37 → supported major + `@electron/rebuild` 4 | todo |
| U3 | **USER** — decide the deferred list at the end of this file | todo |

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

**Why:** `electron/main/index.ts:150` passes *any* URL from `setWindowOpenHandler` to `shell.openExternal`, and no `will-navigate` handler exists. Book iframes can't reach either today (their sandbox lacks `allow-popups`/`allow-top-navigation`), so this is defence in depth: a navigated main frame would get the full preload API, and `openExternal` on a custom scheme is the classic Electron exploit shape.

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

**Why:** `electron/main/ipc/library.ts:44-72` is the one IPC handler that orchestrates (NAS check, row write, reading-state clock, field overrides, `metadata.json`, catalog, rename) instead of delegating — invariant 8. `docs/invariants/files-and-deletion.md` names `library:updateBook` as a rename call site; the behaviour and ordering must not change.

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

**Why:** `revealBook`/`openBookFile` have no tests, yet this is where the `formats[0]` bug was measured on 1,372 books (`test/invariants.test.ts` docstring). Guard invariants 2 and 3 behaviourally.

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

- `migration.ts` / `pipeline/migrate.py` have no direct tests (one-time path; worth it only if another migration run is planned).
- EPUB XML via stdlib `ElementTree` + no zip-member size cap (`sidecar/extractors/epub_metadata.py:23,44,113`) — `defusedxml` + a size guard.
- `db.findByTitleAuthor` (`db.ts:628`) full scan per import — index on normalised title/author needs a migration (contracts-engineer).
- Sidecar `ThreadPoolExecutor(max_workers=4)` shared between hour-long migration and interactive calls.
- `tsconfig` `noUncheckedIndexedAccess` — likely a large diff; measure first.
- `ListView.tsx:99-110` cells vs `docs/invariants/library-views.md`'s "block-level child" wording — measure in-app, then align code or doc.
- The `electron/main/services/theme/` subsystem (~3k lines) was not audited.
- No tests for `sidecar.ts`, `library.store.ts`, `ui.store.ts`.
