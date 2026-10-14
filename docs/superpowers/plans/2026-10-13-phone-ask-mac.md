# Phone Ask — the Mac half (slices 1 and 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Mac's pure prompt modules to a place both processes import, then add `POST /api/ai/ask` — a stateless streaming relay over the Mac's configured model — with its contract, goldens and smoke checks.

**Architecture:** Slice 1 renames `src/lib/ask-context.ts` and `src/lib/recall.ts` (and tests) to `shared/ask/` behind a new `@ask/*` alias; no body changes. Slice 2 gives `services/ai.ts` an optional `sink` so a request can stream somewhere other than the desktop window, adds `services/api/ask.ts` (request parser, `runAsk` orchestration for the `preview`/`probe`/`ask` modes, SSE framing), adds the shapers and contract text, and wires the route into `api/rest.ts`.

**Tech Stack:** TypeScript (strict), Electron main process with `node:http`, vitest run through `npm test` (Electron-as-Node), the repo's bash smoke script.

**Spec:** `docs/superpowers/specs/2026-10-13-phone-ask-design.md` (D2 for slice 1, D3–D5 and D7 for slice 2). Read `docs/superpowers/specs/2026-09-19-reader-ai-panel-design.md` for why the assembler and scorer behave as they do — this plan moves and calls them, it does not change them. **Read before touching:** `docs/rest-api.md` (the contract, three artifacts in one slice), `docs/invariants/reader.md` and `docs/invariants/settings-and-editing.md`.

## Global Constraints

- **Baseline measured 2026-10-13 at `6425d9d`:** `npm test` → 98 files, **2143 passed, 2 skipped**. Re-measure before relying on it (this repo's handoff numbers are claims, not facts). Slice 1 must end with the same counts.
- `docs/rest-api.md`, the goldens in `electron/main/services/api/shape.test.ts` and `scripts/api-smoke.sh` move **together** in slice 2. `apiVersion` stays **1**.
- `index.html` is **byte-identical** (`git diff --quiet index.html`). No CSP change.
- The ask route's JSON body cap is **1,048,576 bytes**; the section text cap is **200,000 characters**; the heartbeat is **15 s**; at most **2** relay asks in flight (a third answers `503 busy` + `Retry-After: 1`). The reading report's 4,096-byte cap is unchanged.
- No `any`. IPC handlers stay thin; logic lives in `electron/main/services/`. A failure is an SSE `error` event or an HTTP refusal, never a throw out of a handler (invariant 12).
- `shape.ts` keeps exactly its two existing imports (`shape.test.ts` asserts the whole list) — new payload types are declared locally in it.
- Prose in `.md` files is **not hard-wrapped**: one line per paragraph, bullet and table row.
- Gates, every task that changes code: `npm run typecheck && npm run lint && npm test`. Code commits (not docs- or test-only ones) are preceded by the `/verify` skill. Every commit ends with the `Co-Authored-By` trailer from the session's attribution reminder.
- Two consecutive failed repair attempts on the same test is an escalation: stop and hand back.

## Review Focus

Failure modes the spec implies that no happy-path task exercises; each is pinned by a test named in the owning task.

1. **A phone that hangs up mid-answer** (or before the first byte): no pending upstream request, no heartbeat timer and no gate slot may outlive it — Task 6.
2. **A phone ask while the desktop panel has a question in flight:** neither stream may carry the other's events, and a relay ask must never paint into the Mac reader — Tasks 2 and 6.
3. **A probe reply that is garbage, or an explicit refusal:** `unknown` and `weak` respectively, never a thrown error and never the raw reply on the wire — Task 5.
4. **The model unset:** all three modes answer `503 ai unavailable` with a reason, not a partial `200` — Task 6.
5. **A body at, and one byte past, the cap; a section text exactly at, and one character past, its cap; an offset that is negative, `NaN` or past the text:** at the cap passes, past it is a 400, a bad offset is a 400 and an in-range-but-beyond-text offset is clamped by the assembler — Tasks 3 and 6.
6. **A key in the Mac's config must never appear in any response, event or log line** — Task 6.

---

## File Structure

| File | Responsibility | Slice |
| --- | --- | --- |
| `shared/ask/ask-context.ts`, `shared/ask/recall.ts` (+ `.test.ts`) | moved verbatim from `src/lib/` | 1 |
| `electron.vite.config.ts`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts` | the `@ask/*` alias and `shared/**` include | 1 |
| `electron/main/services/ai.ts` (+ `ai.test.ts`) | gains `AskSink` / `AskOptions.sink` | 2 |
| `electron/main/services/api/ask.ts` (+ `ask.test.ts`) | request parser, caps, `runAsk`, `frame`, `healthAi` | 2 |
| `electron/main/services/api/shape.ts` (+ `shape.test.ts`) | `aiUnavailable` word, `ai` health member, the five event payloads | 2 |
| `electron/main/services/api/routes.ts` | `ASK_ROUTE` + `isAskRoute` | 2 |
| `electron/main/api/rest.ts` (+ `rest.ask.test.ts`, `rest.test.ts`) | the route glue: body cap, SSE writer, gate, disconnect, heartbeat | 2 |
| `docs/rest-api.md`, `scripts/api-smoke.sh`, `tasks.md` | the contract's prose half, its executable half, and the backlog entry | 2 |

Slice 1 touches about a dozen files, but four are renames and the rest are one-line import or config edits — this is the move the spec's AC1 describes, and it is the reason slice 1 is its own slice. **If the rename diff shows anything but renames and import lines, stop.**

---

# Slice 1 — the move

### Task 1: Move the two modules behind an `@ask/*` alias

**Files:**
- Move: `src/lib/ask-context.ts` → `shared/ask/ask-context.ts`; `src/lib/ask-context.test.ts` → `shared/ask/ask-context.test.ts`; `src/lib/recall.ts` → `shared/ask/recall.ts`; `src/lib/recall.test.ts` → `shared/ask/recall.test.ts`
- Modify: `electron.vite.config.ts`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`
- Modify (imports): `src/stores/reader.store.ts:8,18`, `src/components/reader/ReaderAsk.tsx:3`, `src/lib/ask-session.ts:24-25`
- Modify (prose): `docs/architecture.md:224` (+ the layout tree), docblock paths in the moved files and in `ReaderAsk.tsx`

**Interfaces:**
- Produces: the alias `@ask/*` → `shared/ask/*`, importable from `electron/**`, `src/**` and tests. The moved modules' exports are unchanged: `buildAskMessages`, `describeEgress`, `AskRung`, `AskContext`, `AskPayload`, `AssembledAsk`, `PASSAGE_CHAR_CAP`, `PASSAGE_LEAD_CHARS` from `@ask/ask-context`; `parseProbe`, `scoreRecall`, `recallOverlap`, `normalizeTokens`, `RecallVerdict`, `ParsedProbe`, `RECALL_THRESHOLD` from `@ask/recall`.

- [ ] **Step 1: Re-measure the baseline and record it**

Run: `npm test 2>&1 | tail -6`
Expected: `Test Files  98 passed (98)` and `Tests  2143 passed | 2 skipped (2145)`. If the numbers differ, write the new ones down — "same count after the move" is the acceptance test, not 2143.

- [ ] **Step 2: Move the files with git, so history follows**

```bash
mkdir -p shared/ask
git mv src/lib/ask-context.ts shared/ask/ask-context.ts
git mv src/lib/ask-context.test.ts shared/ask/ask-context.test.ts
git mv src/lib/recall.ts shared/ask/recall.ts
git mv src/lib/recall.test.ts shared/ask/recall.test.ts
```

- [ ] **Step 3: Add the alias to the four configs**

`electron.vite.config.ts` — beside `sharedTypes`, and into the `main` and `renderer` alias maps (the preload never imports these):

```ts
const sharedTypes = resolve(__dirname, 'src/types')
const sharedAsk = resolve(__dirname, 'shared/ask')
```
```ts
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': sharedTypes, '@ask': sharedAsk }
    },
```
```ts
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': sharedTypes,
        '@ask': sharedAsk,
        '@vendor': resolve(__dirname, 'vendor')
      }
    },
```

`tsconfig.node.json` — `paths` and `include`:

```json
    "paths": {
      "@shared/*": ["./src/types/*"],
      "@ask/*": ["./shared/ask/*"]
    }
```
```json
  "include": [
    "electron/**/*.ts",
    "src/types/**/*.ts",
    "shared/**/*.ts",
    "electron.vite.config.ts",
    "test/**/*.ts"
  ]
```

`tsconfig.web.json`:

```json
    "paths": {
      "@/*": ["./src/*"],
      "@shared/*": ["./src/types/*"],
      "@ask/*": ["./shared/ask/*"]
    }
```
```json
  "include": ["src/**/*.ts", "src/**/*.tsx", "shared/**/*.ts", "test/**/*.ts"]
```

`vitest.config.ts` — the alias and the include glob:

```ts
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/types'),
      '@ask': resolve(__dirname, 'shared/ask'),
      electron: resolve(__dirname, 'test/mocks/electron.ts')
```
```ts
    include: [
      'src/**/*.test.ts',
      'electron/**/*.test.ts',
      'shared/**/*.test.ts',
      'test/**/*.test.ts'
    ]
```

- [ ] **Step 4: Point the importers at the new alias**

`src/stores/reader.store.ts`: `'@/lib/ask-context'` → `'@ask/ask-context'` and `'@/lib/recall'` → `'@ask/recall'`.
`src/components/reader/ReaderAsk.tsx`: `'@/lib/ask-context'` → `'@ask/ask-context'`.
`src/lib/ask-session.ts`: `'./ask-context'` → `'@ask/ask-context'` and `'./recall'` → `'@ask/recall'`.
The two moved test files import their sibling with `./ask-context` / `./recall` — those stay correct.

- [ ] **Step 5: Run the gates to prove it is a pure move**

Run: `npm run typecheck && npm run lint && npm test 2>&1 | tail -6`
Expected: typecheck and lint clean; `Test Files  98 passed (98)` and the **same** `Tests` line as Step 1. If `typecheck` complains about a DOM-only or Node-only global in the moved files under `tsconfig.node.json` (`lib: ES2023`, no DOM), that is a real finding about the move — hand back rather than editing the bodies.

- [ ] **Step 6: Prove the diff is renames and import lines only**

Run: `git diff -M --stat HEAD && git diff -M HEAD -- shared/ask | head -40`
Expected: the four `shared/ask/*` files show as renames at 100% similarity (or differing only in docblock path text if you update it in Step 7).

- [ ] **Step 7: Update the live prose that names the old paths**

Run: `grep -rn "src/lib/ask-context\|src/lib/recall" docs/invariants docs/architecture.md docs/data-contracts.md CLAUDE.md tasks.md src shared electron`
Replace each hit in **live** files (code docblocks, `docs/architecture.md`, invariants) with `shared/ask/…`. Leave dated specs and plans under `docs/superpowers/` alone — they are the record of what the tree said then. In `docs/architecture.md` change the alias paragraph to:

```
Path aliases: `@/*` → `src/*` (renderer), `@shared/*` → `src/types/*` (all three layers), `@ask/*` → `shared/ask/*` (the ask panel's pure prompt and recall modules — imported by the renderer and by the main process's REST relay), `@vendor/*` → `vendor/*` (renderer only — the reader engine). Configured in `electron.vite.config.ts`, both tsconfigs and `vitest.config.ts`.
```
and add a `shared/ask/` line to the layout tree beside `src/types/`.

- [ ] **Step 8: Re-run the gates, then commit**

Run: `npm run typecheck && npm run lint && npm test 2>&1 | tail -4 && git diff --quiet index.html && echo index-unchanged`
Expected: all green, `index-unchanged`.

```bash
git add -A shared src electron.vite.config.ts tsconfig.node.json tsconfig.web.json vitest.config.ts docs/architecture.md
git commit -m "refactor(ask): move the prompt and recall modules to shared/ask behind @ask/*"
```

---

# Slice 2 — the route and the contract

### Task 2: `services/ai.ts` gains a sink

**Files:**
- Modify: `electron/main/services/ai.ts` (`AskOptions`, `Pending`, `ask`, `consume`, `done`, `fail`)
- Test: `electron/main/services/ai.test.ts` (new `describe('ask with a sink')`, using the file's own `startStub`, `configure`, `chunk`, `captured`)

**Interfaces:**
- Produces: `export interface AskSink { chunk(delta: string): void; done(reason: AskDoneReason): void; error(message: string): void }` and `AskOptions.sink?: AskSink`. A request with a sink delivers `chunk`/`done`/`error` to it and **broadcasts nothing**; a request without one is unchanged. `cancel(requestId)` works on both.

- [ ] **Step 1: Write the failing tests**

Add after the existing `describe('ask', …)` block in `ai.test.ts`:

```ts
describe('ask with a sink', () => {
  function recorder() {
    const seen: string[] = []
    return {
      seen,
      sink: {
        chunk: (delta: string) => seen.push(`chunk:${delta}`),
        done: (reason: string) => seen.push(`done:${reason}`),
        error: (message: string) => seen.push(`error:${message}`)
      }
    }
  }

  it('delivers the stream to the sink and broadcasts nothing to the window', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk('Hello'))
      res.write(chunk(' world'))
      res.end('data: [DONE]\n\n')
    })
    configure(stub)
    const { seen, sink } = recorder()

    ask({ requestId: 'relay-1', mode: 'ask', messages: [{ role: 'user', content: 'hi' }] }, { sink })
    await vi.waitFor(() => expect(seen).toContain('done:stop'))

    expect(seen).toEqual(['chunk:Hello', 'chunk: world', 'done:stop'])
    expect(captured).toEqual([])
  })

  it('delivers a failure to the sink, not to the window', async () => {
    setConfig(AI_CONFIG_KEYS.baseUrl, 'http://127.0.0.1:1/v1')
    setConfig(AI_CONFIG_KEYS.model, 'test-model')
    const { seen, sink } = recorder()

    ask({ requestId: 'relay-2', mode: 'ask', messages: [{ role: 'user', content: 'hi' }] }, { sink })
    await vi.waitFor(() => expect(seen.some((line) => line.startsWith('error:'))).toBe(true))

    expect(seen).toHaveLength(1)
    expect(captured).toEqual([])
  })

  it('cancels a sink request as done:canceled, and releases the slot', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk('one'))
    })
    configure(stub)
    const { seen, sink } = recorder()

    ask({ requestId: 'relay-3', mode: 'ask', messages: [{ role: 'user', content: 'hi' }] }, { sink })
    await vi.waitFor(() => expect(seen).toContain('chunk:one'))

    expect(cancel('relay-3')).toBe(true)
    await vi.waitFor(() => expect(seen).toContain('done:canceled'))
    await vi.waitFor(() => expect(cancel('relay-3')).toBe(false))
    expect(captured).toEqual([])
  })

  it('a sink that throws does not break the stream or leak the request', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk('a'))
      res.write(chunk('b'))
      res.end('data: [DONE]\n\n')
    })
    configure(stub)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const seen: string[] = []

    ask(
      { requestId: 'relay-4', mode: 'ask', messages: [{ role: 'user', content: 'hi' }] },
      {
        sink: {
          chunk: () => {
            throw new Error('the socket is gone')
          },
          done: (reason) => seen.push(`done:${reason}`),
          error: (message) => seen.push(`error:${message}`)
        }
      }
    )
    await vi.waitFor(() => expect(seen).toEqual(['done:stop']))
    await vi.waitFor(() => expect(cancel('relay-4')).toBe(false))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a request without a sink still broadcasts, with a sink request beside it', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk('x'))
      res.end('data: [DONE]\n\n')
    })
    configure(stub)
    const { seen, sink } = recorder()

    askOnce('desktop-1')
    ask({ requestId: 'relay-5', mode: 'ask', messages: [{ role: 'user', content: 'hi' }] }, { sink })
    await waitForTerminal('desktop-1')
    await vi.waitFor(() => expect(seen).toContain('done:stop'))

    // The desktop request's events are in the window's stream; the relay's are not
    expect(eventsFor('desktop-1', EVENT_CHANNELS.aiChunk)).toHaveLength(1)
    expect(captured.some((c) => sameRequest(c.payload, 'relay-5'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- electron/main/services/ai.test.ts -t "ask with a sink" 2>&1 | tail -20`
Expected: FAIL — `sink` is not a known option; the first case sees a non-empty `captured` (the service broadcast).

- [ ] **Step 3: Implement the sink**

In `ai.ts`, replace `Pending`, `AskOptions` and add the sink type and two delivery helpers:

```ts
/**
 * Where a request's events go when they are not the desktop window's. The REST
 * relay (`services/api/ask.ts`) passes one so a phone's question streams back to
 * the phone and is never broadcast to a Mac reader that happens to have the ask
 * panel open. A request with no sink is the desktop panel's and behaves exactly
 * as it always has.
 */
export interface AskSink {
  chunk(delta: string): void
  done(reason: AskDoneReason): void
  error(message: string): void
}

interface Pending {
  controller: AbortController
  /** True once a terminal event has been delivered for this id. */
  settled: boolean
  sink?: AskSink
}

export interface AskOptions {
  /** Overridden in tests; the default is `IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number
  /** Deliver events here instead of broadcasting them to the renderer. */
  sink?: AskSink
}
```

In `ask()`: `const entry: Pending = { controller: new AbortController(), settled: false, sink: options.sink }`.

In `consume`, replace `broadcast('aiChunk', { requestId, delta: outcome.text })` with `emitChunk(requestId, entry, outcome.text)`. Replace `done` and `fail`:

```ts
/** A sink is someone else's code: its failure must not end the stream or leak the request. */
function deliver(sink: AskSink, send: () => void): void {
  try {
    send()
  } catch (err) {
    console.warn(`[ai] a sink threw: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function emitChunk(requestId: string, entry: Pending, delta: string): void {
  if (entry.sink) {
    const sink = entry.sink
    return deliver(sink, () => sink.chunk(delta))
  }
  broadcast('aiChunk', { requestId, delta })
}

function done(requestId: string, entry: Pending, reason: AskDoneReason): void {
  entry.settled = true
  if (entry.sink) {
    const sink = entry.sink
    return deliver(sink, () => sink.done(reason))
  }
  broadcast('aiDone', { requestId, reason })
}

function fail(requestId: string, entry: Pending, message: string): void {
  entry.settled = true
  if (entry.sink) {
    const sink = entry.sink
    return deliver(sink, () => sink.error(message))
  }
  broadcast('aiError', { requestId, message })
}
```

`consume` takes `entry` from the enclosing `run` scope already (it is declared inside `run`), so no signature change is needed.

- [ ] **Step 4: Run to verify they pass, and the whole file**

Run: `npm test -- electron/main/services/ai.test.ts 2>&1 | tail -8`
Expected: PASS, with every pre-existing case still green.

- [ ] **Step 5: Gates and commit**

Run: `npm run typecheck && npm run lint && npm test 2>&1 | tail -4`
Expected: green.

```bash
git add electron/main/services/ai.ts electron/main/services/ai.test.ts
git commit -m "feat(ai): a request may stream to a sink instead of the desktop window"
```

---

### Task 3: The ask request — its parser and its caps

**Files:**
- Create: `electron/main/services/api/ask.ts`
- Test: `electron/main/services/api/ask.test.ts`

**Interfaces:**
- Consumes: `AskRung` from `@ask/ask-context` (Task 1).
- Produces: `ASK_SECTION_TEXT_MAX_CHARS = 200_000`, `ASK_BODY_MAX_BYTES = 1_048_576`, `type AskWireMode = 'preview' | 'probe' | 'ask'`, `interface AskWireRequest { bookId: string; mode: AskWireMode; rung: AskRung; section: { label: string | null; text: string | null; offset: number | null; truncated: boolean }; fraction: number | null; selection: string | null; question: string | null }`, `parseAskRequest(body: unknown): { ok: true; request: AskWireRequest } | { ok: false }`.

- [ ] **Step 1: Write the failing tests**

`ask.test.ts` (this file grows in Tasks 4–5; the imports below are the whole of Task 3's):

```ts
import { describe, expect, it } from 'vitest'
import { ASK_SECTION_TEXT_MAX_CHARS, parseAskRequest } from './ask'

describe('parseAskRequest', () => {
  it('accepts the smallest request and fills the defaults', () => {
    const parsed = parseAskRequest({ bookId: 'b1', mode: 'preview' })
    expect(parsed).toEqual({
      ok: true,
      request: {
        bookId: 'b1',
        mode: 'preview',
        rung: 'pointer',
        section: { label: null, text: null, offset: null, truncated: false },
        fraction: null,
        selection: null,
        question: null
      }
    })
  })

  it('carries every member of a full ask', () => {
    const parsed = parseAskRequest({
      bookId: 'b1',
      mode: 'ask',
      rung: 'passage',
      section: { label: 'Chapter 4', text: 'Body text.', offset: 5, truncated: false },
      fraction: 0.42,
      selection: 'a highlighted sentence',
      question: 'What does this mean?'
    })
    expect(parsed.ok && parsed.request).toMatchObject({
      mode: 'ask',
      rung: 'passage',
      section: { label: 'Chapter 4', text: 'Body text.', offset: 5 },
      fraction: 0.42,
      selection: 'a highlighted sentence',
      question: 'What does this mean?'
    })
  })

  it('ignores members it does not know, at both levels', () => {
    const parsed = parseAskRequest({
      bookId: 'b1',
      mode: 'probe',
      futureMember: { a: 1 },
      section: { label: 'x', futureToo: true }
    })
    expect(parsed.ok).toBe(true)
  })

  it('needs a question for an ask, and only for an ask', () => {
    expect(parseAskRequest({ bookId: 'b1', mode: 'ask' }).ok).toBe(false)
    expect(parseAskRequest({ bookId: 'b1', mode: 'ask', question: '   ' }).ok).toBe(false)
    expect(parseAskRequest({ bookId: 'b1', mode: 'probe' }).ok).toBe(true)
    expect(parseAskRequest({ bookId: 'b1', mode: 'preview' }).ok).toBe(true)
  })

  it('holds the section text to its cap: at the cap passes, one past is refused', () => {
    const at = 'x'.repeat(ASK_SECTION_TEXT_MAX_CHARS)
    expect(parseAskRequest({ bookId: 'b1', mode: 'probe', section: { text: at } }).ok).toBe(true)
    expect(
      parseAskRequest({ bookId: 'b1', mode: 'probe', section: { text: at + 'x' } }).ok
    ).toBe(false)
  })

  it.each([
    ['not an object', 'text'],
    ['an array', []],
    ['null', null],
    ['no book id', { mode: 'ask', question: 'q' }],
    ['a blank book id', { bookId: '  ', mode: 'preview' }],
    ['an over-long book id', { bookId: 'x'.repeat(201), mode: 'preview' }],
    ['an unknown mode', { bookId: 'b1', mode: 'stream' }],
    ['an unknown rung', { bookId: 'b1', mode: 'preview', rung: 'chapter' }],
    ['a non-object section', { bookId: 'b1', mode: 'preview', section: 'text' }],
    ['a non-string label', { bookId: 'b1', mode: 'preview', section: { label: 4 } }],
    ['a negative offset', { bookId: 'b1', mode: 'preview', section: { offset: -1 } }],
    ['a NaN offset', { bookId: 'b1', mode: 'preview', section: { offset: Number.NaN } }],
    ['a string offset', { bookId: 'b1', mode: 'preview', section: { offset: '5' } }],
    ['a non-boolean truncated', { bookId: 'b1', mode: 'preview', section: { truncated: 'yes' } }],
    ['a fraction above 1', { bookId: 'b1', mode: 'preview', fraction: 1.1 }],
    ['a negative fraction', { bookId: 'b1', mode: 'preview', fraction: -0.1 }],
    ['a non-string selection', { bookId: 'b1', mode: 'preview', selection: 7 }],
    ['an over-long question', { bookId: 'b1', mode: 'ask', question: 'q'.repeat(10_001) }]
  ])('refuses %s', (_name, body) => {
    expect(parseAskRequest(body)).toEqual({ ok: false })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- electron/main/services/api/ask.test.ts 2>&1 | tail -10`
Expected: FAIL — `./ask` does not exist.

- [ ] **Step 3: Write the parser**

`electron/main/services/api/ask.ts`:

```ts
import type { AskRung } from '@ask/ask-context'

/**
 * The phone's ask, as the Mac receives it (`docs/rest-api.md` § `POST /api/ai/ask`,
 * D3 of `docs/superpowers/specs/2026-10-13-phone-ask-design.md`).
 *
 * This file is the relay's brain and none of its socket: it parses the request,
 * runs the *same* assembler and scorer the desktop panel runs, and reports what
 * happened as events a socket module can frame. Pure over its inputs apart from
 * the model call, which goes through `services/ai.ts`.
 */

/**
 * The longest section text a request may carry, in characters. The same ceiling
 * `services/ai.ts` already refuses a request above (`MAX_MESSAGE_CHARS`), against
 * the longest section the AI-panel work measured (18,405 characters). A request
 * past it is a 400, never a clamp: the text is a *prefix* of the section by the
 * contract, and a silently shortened prefix would score a probe against less
 * than the phone thought it sent.
 */
export const ASK_SECTION_TEXT_MAX_CHARS = 200_000

/** The route's body cap: the text at four UTF-8 bytes a character is 800,000, and the rest is small. */
export const ASK_BODY_MAX_BYTES = 1_048_576

const MAX_BOOK_ID_CHARS = 200
const MAX_LABEL_CHARS = 500
const MAX_SELECTION_CHARS = 50_000
const MAX_QUESTION_CHARS = 10_000

/** `preview` assembles and discloses without calling the model. */
export type AskWireMode = 'preview' | 'probe' | 'ask'

export interface AskWireRequest {
  bookId: string
  mode: AskWireMode
  rung: AskRung
  section: {
    label: string | null
    /** The section from its start — a prefix, never a window. */
    text: string | null
    /** Where the reader is within `text`, in characters. */
    offset: number | null
    truncated: boolean
  }
  fraction: number | null
  selection: string | null
  question: string | null
}

const BAD: unique symbol = Symbol('bad')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Absent and `null` are both "no value"; anything but a short-enough string is not a request. */
function textOrNull(value: unknown, max: number): string | null | typeof BAD {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > max) return BAD
  return value
}

function numberOrNull(value: unknown, min: number, max: number): number | null | typeof BAD {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return BAD
  return value
}

/**
 * Validate a request body. **Never throws** (invariant 12): a body this route
 * cannot make sense of is `{ ok: false }`, which the socket answers 400 — and
 * members it does not know are ignored, at both levels, because that is the
 * sentence that lets the contract grow without a version bump.
 */
export function parseAskRequest(
  body: unknown
): { ok: true; request: AskWireRequest } | { ok: false } {
  const bad = { ok: false } as const
  if (!isRecord(body)) return bad

  const bookId = typeof body.bookId === 'string' ? body.bookId.trim() : ''
  if (!bookId || bookId.length > MAX_BOOK_ID_CHARS) return bad

  const mode = body.mode
  if (mode !== 'preview' && mode !== 'probe' && mode !== 'ask') return bad

  const rung = body.rung === undefined || body.rung === null ? 'pointer' : body.rung
  if (rung !== 'pointer' && rung !== 'passage') return bad

  const rawSection = body.section === undefined || body.section === null ? {} : body.section
  if (!isRecord(rawSection)) return bad

  const label = textOrNull(rawSection.label, MAX_LABEL_CHARS)
  const text = textOrNull(rawSection.text, ASK_SECTION_TEXT_MAX_CHARS)
  const offset = numberOrNull(rawSection.offset, 0, Number.MAX_SAFE_INTEGER)
  const truncated = rawSection.truncated ?? false
  if (label === BAD || text === BAD || offset === BAD || typeof truncated !== 'boolean') return bad

  const fraction = numberOrNull(body.fraction, 0, 1)
  const selection = textOrNull(body.selection, MAX_SELECTION_CHARS)
  const question = textOrNull(body.question, MAX_QUESTION_CHARS)
  if (fraction === BAD || selection === BAD || question === BAD) return bad

  if (mode === 'ask' && !question?.trim()) return bad

  return {
    ok: true,
    request: {
      bookId,
      mode,
      rung,
      section: { label, text, offset, truncated },
      fraction,
      selection,
      question
    }
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- electron/main/services/api/ask.test.ts 2>&1 | tail -8`
Expected: PASS (every `it.each` row green).

- [ ] **Step 5: Gates and commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add electron/main/services/api/ask.ts electron/main/services/api/ask.test.ts
git commit -m "feat(api): the ask request's parser and caps"
```

---

### Task 4: The wire's shapes and the contract text

**Files:**
- Modify: `electron/main/services/api/shape.ts` (error word, `HealthAi`, `healthPayload`, the five event shapers, `AiUnavailablePayload`)
- Modify: `electron/main/services/api/shape.test.ts`
- Modify: `electron/main/services/api/routes.ts` (`ASK_ROUTE`, `isAskRoute`)
- Modify: `docs/rest-api.md`

**Interfaces:**
- Consumes: nothing from earlier tasks (the shapers take plain values).
- Produces, all from `shape.ts`:
  - `API_ERRORS.aiUnavailable = 'ai unavailable'`
  - `interface HealthAi { available: boolean; reason: string | null; isLocal: boolean; host: string; model: string | null }`; `healthPayload(input: { version: string; books: number; online: boolean; ai: HealthAi })` now returns `ai`.
  - `aiUnavailablePayload(reason: string): { error: string; reason: string }`
  - `askDisclosurePayload(input: { text: string; members: string[]; rung: 'pointer' | 'passage'; windowed: boolean; truncated: string[]; host: string; isLocal: boolean; model: string | null }): AskDisclosureData`
  - `askVerdictPayload(value: 'strong' | 'weak' | 'unknown')`, `askDeltaPayload(text: string)`, `askDonePayload(reason: 'stop' | 'length' | 'canceled' | 'timeout')`, `askErrorPayload(message: string)`.
- Produces, from `routes.ts`: `ASK_ROUTE = '/api/ai/ask'`, `isAskRoute(pathname: string): boolean`.

- [ ] **Step 1: Write the failing tests**

In `shape.test.ts`: add the new shapers to the import list from `./shape` (`aiUnavailablePayload, askDeltaPayload, askDisclosurePayload, askDonePayload, askErrorPayload, askVerdictPayload, type HealthAi`), add `ask` request parsing (import `parseAskRequest` from `./ask`), then:

```ts
const AI: HealthAi = {
  available: true,
  reason: null,
  isLocal: true,
  host: 'localhost:11434',
  model: 'llama3.2'
}
```

Change the health golden and add the five event goldens to `PAYLOADS`:

```ts
  health: healthPayload({ version: APP_VERSION, books: 7100, online: true, ai: AI }),
  'ask-disclosure': askDisclosurePayload({
    text: 'Sends: title, author, section “Chapter 4”, position (42%), your question → http://localhost:11434/v1 · llama3.2',
    members: ['title', 'author', 'section', 'position', 'question'],
    rung: 'pointer',
    windowed: false,
    truncated: [],
    host: 'localhost:11434',
    isLocal: true,
    model: 'llama3.2'
  }),
  'ask-verdict': askVerdictPayload('weak'),
  'ask-delta': askDeltaPayload('That passage is'),
  'ask-done': askDonePayload('stop'),
  'ask-error': askErrorPayload('Nothing is listening at http://localhost:11434/v1 — is your local model server running?'),
```

Fix the two existing health cases (the `healthPayload` calls at the "carries the contract version" and "maps the share" cases) by passing `ai: AI`, and extend the second:

```ts
    expect(healthPayload({ version: '1.2.3', books: 7100, online: true, ai: AI })).toEqual({
      apiVersion: 1,
      version: '1.2.3',
      books: 7100,
      library: 'online',
      ai: AI
    })
```

Append new cases:

```ts
describe('the ask route on the wire (phone-ask D3, D7)', () => {
  it('names the route, the new refusal and the heartbeat where a client looks', () => {
    expect(DOC).toContain('POST /api/ai/ask')
    expect(DOC).toContain(`\`${API_ERRORS.aiUnavailable}\``)
    expect(DOC).toContain(': ping')
    expect(DOC).toContain('text/event-stream')
  })

  it("the document's request example is a request the parser accepts", () => {
    const block = DOC.match(/```json request=ask\n([\s\S]*?)\n```/)
    expect(block).not.toBeNull()
    expect(parseAskRequest(JSON.parse(block![1]!)).ok).toBe(true)
  })

  it('carries the ai member on health with the same field list whether or not it is available', () => {
    const off = healthPayload({
      version: 'x',
      books: 0,
      online: false,
      ai: { available: false, reason: 'No model set — add one in Settings.', isLocal: true, host: 'localhost:11434', model: null }
    })
    expect(keyPaths(off).sort()).toEqual(keyPaths(PAYLOADS.health).sort())
  })

  it('builds the 503 body with a reason, the way 422 does', () => {
    expect(aiUnavailablePayload('No model set')).toEqual({
      error: 'ai unavailable',
      reason: 'No model set'
    })
  })

  it('discloses nothing beyond the named members', () => {
    expect(Object.keys(PAYLOADS['ask-disclosure'] as object).sort()).toEqual(
      ['endpoint', 'members', 'model', 'rung', 'text', 'truncated', 'windowed'].sort()
    )
    expect(Object.keys((PAYLOADS['ask-disclosure'] as { endpoint: object }).endpoint).sort()).toEqual(
      ['host', 'isLocal']
    )
  })
})
```

Add a `routes.test`-style case in `shape.test.ts`'s neighbor is unnecessary; `isAskRoute` is covered in Task 6's socket cases.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- electron/main/services/api/shape.test.ts 2>&1 | tail -20`
Expected: FAIL — the new exports do not exist, and the document lacks the new blocks.

- [ ] **Step 3: Implement the shapers**

In `shape.ts`, add the error word inside `API_ERRORS` (before `internal`):

```ts
  /**
   * 503 — the Mac has no model to relay to (`POST /api/ai/ask`); the body also
   * carries `reason`, the way 422 does. Not `offline` and not `busy`: neither
   * retry decision applies, because only the owner at the Mac can fix it.
   */
  aiUnavailable: 'ai unavailable',
```

Replace the health section's interface and function:

```ts
/**
 * Whether the Mac can relay an ask, and to what. Never the key, and no `hasKey`:
 * the phone has no use for it. `available: false` carries a `reason` so the
 * phone can say what to fix instead of showing a bare disabled button.
 */
export interface HealthAi {
  available: boolean
  reason: string | null
  /** The endpoint is loopback, so nothing sent to it leaves the Mac. */
  isLocal: boolean
  /** `host[:port]` of the endpoint, or `''` when none resolved. */
  host: string
  model: string | null
}

export interface HealthPayload {
  apiVersion: number
  version: string
  /** Every book in the cache — the paginated total, not a whole-library load. */
  books: number
  library: 'online' | 'offline'
  ai: HealthAi
}

export function healthPayload(input: {
  version: string
  books: number
  online: boolean
  ai: HealthAi
}): HealthPayload {
  return {
    apiVersion: API_VERSION,
    version: input.version,
    books: input.books,
    library: input.online ? 'online' : 'offline',
    ai: {
      available: input.ai.available,
      reason: input.ai.reason,
      isLocal: input.ai.isLocal,
      host: input.ai.host,
      model: input.ai.model
    }
  }
}
```

Keep the existing `healthPayload` docblock above it. Append at the end of the file:

```ts
// ---------------------------------------------------------------------------
// The ask route (phone-ask D3) — the 503 body and the five stream events
// ---------------------------------------------------------------------------

export interface AiUnavailablePayload {
  error: string
  reason: string
}

/** 503's body — the second refusal with a `reason`, shaped like `cannotReflowPayload`. */
export function aiUnavailablePayload(reason: string): AiUnavailablePayload {
  return { ...errorPayload('aiUnavailable'), reason }
}

export interface AskDisclosureData {
  /** `describeEgress()`'s string, verbatim: the phone shows it, it does not compose it. */
  text: string
  members: string[]
  rung: 'pointer' | 'passage'
  windowed: boolean
  truncated: string[]
  endpoint: { host: string; isLocal: boolean }
  model: string | null
}

export function askDisclosurePayload(input: {
  text: string
  members: string[]
  rung: 'pointer' | 'passage'
  windowed: boolean
  truncated: string[]
  host: string
  isLocal: boolean
  model: string | null
}): AskDisclosureData {
  return {
    text: input.text,
    members: input.members,
    rung: input.rung,
    windowed: input.windowed,
    truncated: input.truncated,
    endpoint: { host: input.host, isLocal: input.isLocal },
    model: input.model
  }
}

export interface AskVerdictData {
  value: 'strong' | 'weak' | 'unknown'
}

export function askVerdictPayload(value: AskVerdictData['value']): AskVerdictData {
  return { value }
}

export interface AskDeltaData {
  text: string
}

export function askDeltaPayload(text: string): AskDeltaData {
  return { text }
}

export interface AskDoneData {
  reason: 'stop' | 'length' | 'canceled' | 'timeout'
}

export function askDonePayload(reason: AskDoneData['reason']): AskDoneData {
  return { reason }
}

export interface AskErrorData {
  message: string
}

export function askErrorPayload(message: string): AskErrorData {
  return { message }
}
```

In `routes.ts` add, after `isBooksCollection`:

```ts
/**
 * `POST /api/ai/ask` — the relay (phone-ask D3). Matched on the pathname only,
 * like the upload; the method decides, and a `GET` or `HEAD` of this path is a
 * known path behind a method it does not answer — the uniform 404 (D11).
 */
export const ASK_ROUTE = '/api/ai/ask'

export function isAskRoute(pathname: string): boolean {
  return pathname === ASK_ROUTE
}
```

- [ ] **Step 4: Write the contract text**

In `docs/rest-api.md`:

(a) In `### GET /api/health`, replace the payload block and extend the field table:

````
```json payload=health
{
  "apiVersion": 1,
  "version": "0.5.0",
  "books": 7100,
  "library": "online",
  "ai": {
    "available": true,
    "reason": null,
    "isLocal": true,
    "host": "localhost:11434",
    "model": "llama3.2"
  }
}
```
````

Check that the `version` in the existing block still equals the current `package.json` version — copy it from the block already there rather than from this plan. Add one table row:

```
| `ai`         | Whether the Mac can relay `POST /api/ai/ask`. `available` is false (with a `reason` in the Mac's own words) when no model is set; `host` is the endpoint's `host[:port]` and `isLocal` says whether it is loopback, so a client can say *remote — `<host>` receives this* before the first send. Never the key. Additive: a client that predates the member sees no Ask and nothing else. |
```

(b) Immediately before `## Resumable downloads`, add the route section (one line per paragraph, no hard wrapping):

````
### `POST /api/ai/ask`

Ask the Mac's configured model about the book being read. **Streaming** — the answer is `text/event-stream`, not JSON. The Mac assembles the prompt, runs the recall check and calls the model; the phone sends the reader's position and, when the ladder calls for it, the section's text (`docs/superpowers/specs/2026-10-13-phone-ask-design.md`). Nothing is stored between requests: the phone keeps the verdict, the rung and the transcript.

```json request=ask
{
  "bookId": "6f1a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  "mode": "ask",
  "rung": "pointer",
  "section": {
    "label": "Chapter 4",
    "text": "It was the best of times, it was the worst of times…",
    "offset": 8302,
    "truncated": false
  },
  "fraction": 0.42,
  "selection": "it was the age of wisdom",
  "question": "What does the repetition do here?"
}
```

| Member | Meaning |
| --- | --- |
| `bookId` | The book. The Mac reads its title and author itself; nothing else about the book is read or sent. |
| `mode` | `preview` assembles exactly what an `ask` (with a `question`) or a `probe` (without one) would send and answers the `disclosure` event and `done` — **no call to the model**. `probe` asks the model to place the book and quote the section's opening, scores the claim against `section.text`, and answers a `verdict`. `ask` streams the answer. |
| `rung` | `pointer` (title, author, section label, position, and the selection) or `passage` (that, plus the section's text around `offset`). Ignored for `probe`, which is pointer-only by construction. Default `pointer`. |
| `section.label` | The book's own table-of-contents label for the section — never a chapter number. |
| `section.text` | The section **from its start**, never a window: the probe scores the model's claimed opening against the section's first 120 content tokens. At most **200,000 characters**; a longer one is a 400. Needed for `probe` and for `ask` at the `passage` rung. |
| `section.offset` | Where the reader is within `text`; `null` when unknown or when it lies past a cut `text`. |
| `section.truncated` | `text` was cut at the cap. |
| `fraction` | The reader's position in the book, 0–1. |
| `selection` | The reader's highlight, verbatim — the referent of a question. At most 50,000 characters; the Mac cuts it further at its own cap and says so in `disclosure`. |
| `question` | Required for `ask` (non-blank, at most 10,000 characters). |

**"Characters" in this table means UTF-16 code units** — the length JavaScript reports for a string, which is what the Mac measures every cap and every offset in. A client that counts grapheme clusters or Unicode scalars will disagree with the Mac on any text containing an emoji or a character outside the Basic Multilingual Plane (Swift: `string.utf16.count`). Cut text at a scalar boundary, never between the halves of a surrogate pair.

Members the Mac does not know are ignored, and so are events the phone does not know. That is how this route grows without a version bump.

**The stream.** Each event is an `event:` line and a one-line JSON `data:` line, in this order, then a blank line. The body of a request is at most **1,048,576 bytes**; a larger one is a 400.

| Event | Sent | Meaning |
| --- | --- | --- |
| `disclosure` | first, always | What leaves the Mac for the model, and where. `text` is the Mac's own disclosure line — show it verbatim. |
| `verdict` | `probe` only | `strong`, `weak` or `unknown`. The model's raw reply is **never** sent. |
| `delta` | `ask` only | The next piece of the answer, in order. |
| `done` | last, exactly once | `stop`, `length` (the model cut itself off), `canceled` or `timeout` (no token for 120 s). |
| `error` | instead of `done` | The stream began and then failed; `message` is a sentence ("Nothing is listening at …", "the endpoint rejected the key"). |

```json payload=ask-disclosure
{
  "text": "Sends: title, author, section “Chapter 4”, position (42%), your question → http://localhost:11434/v1 · llama3.2",
  "members": ["title", "author", "section", "position", "question"],
  "rung": "pointer",
  "windowed": false,
  "truncated": [],
  "endpoint": { "host": "localhost:11434", "isLocal": true },
  "model": "llama3.2"
}
```

```json payload=ask-verdict
{ "value": "weak" }
```

```json payload=ask-delta
{ "text": "That passage is" }
```

```json payload=ask-done
{ "reason": "stop" }
```

```json payload=ask-error
{ "message": "Nothing is listening at http://localhost:11434/v1 — is your local model server running?" }
```

**Heartbeat.** While the Mac waits on a silent model it writes a comment line, `: ping`, every 15 seconds, so a local model's cold first token does not trip the client's idle timer. A client ignores comment lines.

**Cancellation is a disconnect.** Closing the connection aborts the upstream request; nothing more is sent. A new question cancels the previous one the same way.

**Refusals come before the stream.** `400 bad request` (a body this route cannot make sense of, including one past its cap, a section text past its cap and an `ask` with no question), `401`, `404` for an unknown book, **`503 ai unavailable`** (the Mac has no model; the body carries a `reason`), and `503 busy` + `Retry-After: 1` when two asks are already in flight. After the first byte a failure is an `error` event, because no status is left to change. The route is **POST-only**: a `GET` or `HEAD` of its path answers the uniform 404.
````

(c) In the Errors table add a row after `503 busy`:

```
| 503 | `ai unavailable` | `POST /api/ai/ask` only: the Mac has no model configured. The only refusal besides 422 with a second member, `reason` — the Mac's own sentence. Carries no `Retry-After`: only the owner at the Mac can fix it. |
```

(d) In the Methods section add one sentence: `POST /api/ai/ask` is **POST-only**, takes a JSON body and streams its answer; it answers 404 to every other method.

- [ ] **Step 5: Run to verify they pass**

Run: `npm test -- electron/main/services/api/shape.test.ts 2>&1 | tail -12`
Expected: PASS — the golden equality for `health` and the five `ask-*` blocks, the refusal-word check, the request-example case.

- [ ] **Step 6: Gates and commit**

Run: `npm run typecheck && npm run lint && npm test 2>&1 | tail -4`
Expected: the only failures, if any, are `rest.test.ts` health expectations — they are fixed in Task 6, which owns the route. If `typecheck` fails because `rest.ts` still calls `healthPayload` without `ai`, that is expected: make Task 4 and Task 6 land in one working tree before running the full gate, and run only the `shape.test.ts` command above here.

```bash
git add electron/main/services/api/shape.ts electron/main/services/api/shape.test.ts electron/main/services/api/routes.ts docs/rest-api.md
git commit -m "feat(api): the ask route's shapes, health.ai and the contract text"
```

---

### Task 5: `runAsk` — three modes, one assembler

**Files:**
- Modify: `electron/main/services/api/ask.ts`
- Test: `electron/main/services/api/ask.test.ts`

**Interfaces:**
- Consumes: `AskWireRequest` (Task 3); `askDeltaPayload`, `askDisclosurePayload`, `askDonePayload`, `askErrorPayload`, `askVerdictPayload`, `HealthAi` (Task 4); `ai.ask`, `ai.cancel`, `AskSink`, `ai.getStatus` (Task 2 and the existing service); `buildAskMessages`, `describeEgress` from `@ask/ask-context`; `parseProbe`, `scoreRecall` from `@ask/recall`.
- Produces:
  - `type AskEventName = 'disclosure' | 'verdict' | 'delta' | 'done' | 'error'`
  - `type AskEmit = (event: AskEventName, data: object) => void`
  - `frame(event: AskEventName, data: object): string` — `event: …\ndata: {json}\n\n`
  - `healthAi(status: AiStatus): HealthAi`
  - `runAsk(input: { request: AskWireRequest; book: { title: string; author: string | null }; status: AiStatus; emit: AskEmit; signal?: AbortSignal; idleTimeoutMs?: number }): Promise<void>` — resolves once a terminal event has been emitted, or once the signal aborted. Emits nothing after an abort.

- [ ] **Step 1: Write the failing tests**

Extend `ask.test.ts`. Add the imports and the harness (the stub starter mirrors `ai.test.ts`'s own):

```ts
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, vi } from 'vitest'
import { AI_CONFIG_KEYS, getStatus } from '../ai'
import { closeDb, setConfig } from '../db'
import { frame, healthAi, runAsk, type AskEventName, type AskWireRequest } from './ask'

interface Seen {
  event: AskEventName
  data: Record<string, unknown>
}

let servers: Server[] = []
let seen: Seen[] = []

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  // A developer's own `MUSAEUM_AI_*` must not make "no model set" untestable
  for (const key of ['MUSAEUM_AI_BASE_URL', 'MUSAEUM_AI_MODEL', 'MUSAEUM_AI_API_KEY']) {
    vi.stubEnv(key, '')
  }
  servers = []
  seen = []
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections()
          server.close(() => done())
        })
    )
  )
})

interface Stub {
  url: string
  bodies: { messages: { role: string; content: string }[] }[]
}

async function startStub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Stub> {
  const bodies: Stub['bodies'] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')))
    req.on('end', () => {
      try {
        bodies.push(JSON.parse(raw))
      } catch {
        /* not JSON — nothing to record */
      }
      handler(req, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies }
}

const sse = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`

/** A stub that answers with the given deltas and ends. */
function answering(...deltas: string[]) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const delta of deltas) res.write(sse(delta))
    res.end('data: [DONE]\n\n')
  }
}

function configure(stub: Stub): void {
  setConfig(AI_CONFIG_KEYS.baseUrl, stub.url)
  setConfig(AI_CONFIG_KEYS.model, 'test-model')
}

const SECTION =
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief.'

function request(overrides: Partial<AskWireRequest> = {}): AskWireRequest {
  return {
    bookId: 'b1',
    mode: 'ask',
    rung: 'pointer',
    section: { label: 'Book the First', text: SECTION, offset: null, truncated: false },
    fraction: 0.1,
    selection: null,
    question: 'What is the tone of this opening?',
    ...overrides
  }
}

function run(req: AskWireRequest, signal?: AbortSignal) {
  return runAsk({
    request: req,
    book: { title: 'A Tale of Two Cities', author: 'Charles Dickens' },
    status: getStatus(),
    emit: (event, data) => seen.push({ event, data: data as Record<string, unknown> }),
    signal
  })
}

const names = () => seen.map((s) => s.event)
```

The cases:

```ts
describe('frame', () => {
  it('writes an event line, a one-line data line and a blank line', () => {
    expect(frame('delta', { text: 'a\nb' })).toBe('event: delta\ndata: {"text":"a\\nb"}\n\n')
  })
})

describe('healthAi', () => {
  it('reads availability, host and locality off the status, and never a key', () => {
    setConfig(AI_CONFIG_KEYS.baseUrl, 'http://localhost:11434/v1')
    setConfig(AI_CONFIG_KEYS.model, 'llama3.2')
    setConfig(AI_CONFIG_KEYS.apiKey, 'sk-secret-key-9999')
    const ai = healthAi(getStatus())
    expect(ai).toEqual({
      available: true,
      reason: null,
      isLocal: true,
      host: 'localhost:11434',
      model: 'llama3.2'
    })
    expect(JSON.stringify(ai)).not.toContain('secret')
  })

  it('says why it is off when no model is set', () => {
    const ai = healthAi(getStatus())
    expect(ai.available).toBe(false)
    expect(ai.reason).toMatch(/model/i)
    expect(ai.model).toBeNull()
  })
})

describe('runAsk — preview', () => {
  it('discloses a probe when there is no question, and calls no model', async () => {
    const stub = await startStub(answering('never'))
    configure(stub)

    await run(request({ mode: 'preview', question: null }))

    expect(names()).toEqual(['disclosure', 'done'])
    expect(stub.bodies).toHaveLength(0)
    expect(seen[0]!.data.text).toMatch(/^Sends: title, author, section/)
    expect(seen[0]!.data.text).not.toMatch(/question/)
    expect(seen[1]!.data).toEqual({ reason: 'stop' })
  })

  it('discloses an ask when there is one, naming the highlight and the question', async () => {
    const stub = await startStub(answering('never'))
    configure(stub)

    await run(request({ mode: 'preview', selection: 'the age of wisdom' }))

    expect(seen[0]!.data.members).toEqual(
      expect.arrayContaining(['title', 'author', 'section', 'position', 'question', 'highlight'])
    )
    expect(seen[0]!.data.endpoint).toEqual({ host: stub.url.replace(/^http:\/\//, '').replace(/\/v1$/, ''), isLocal: true })
    expect(stub.bodies).toHaveLength(0)
  })
})

describe('runAsk — ask', () => {
  it('streams the deltas in order and ends with one done', async () => {
    const stub = await startStub(answering('A grand', ' contrast.'))
    configure(stub)

    await run(request())

    expect(names()).toEqual(['disclosure', 'delta', 'delta', 'done'])
    expect(seen.filter((s) => s.event === 'delta').map((s) => s.data.text)).toEqual([
      'A grand',
      ' contrast.'
    ])
    expect(seen.at(-1)!.data).toEqual({ reason: 'stop' })
  })

  it('sends none of the section text at the pointer rung (L0)', async () => {
    const stub = await startStub(answering('ok'))
    configure(stub)

    await run(request({ rung: 'pointer' }))

    const sent = JSON.stringify(stub.bodies[0])
    expect(sent).not.toContain('best of times')
    expect(sent).toContain('A Tale of Two Cities')
  })

  it('sends the passage at the passage rung, and says so', async () => {
    const stub = await startStub(answering('ok'))
    configure(stub)

    await run(request({ rung: 'passage' }))

    expect(JSON.stringify(stub.bodies[0])).toContain('best of times')
    expect(seen[0]!.data.members).toContain('passage')
    expect(seen[0]!.data.rung).toBe('passage')
  })

  it('reports an unreachable endpoint as disclosure then error, and no done', async () => {
    setConfig(AI_CONFIG_KEYS.baseUrl, 'http://127.0.0.1:1/v1')
    setConfig(AI_CONFIG_KEYS.model, 'test-model')

    await run(request())

    expect(names()).toEqual(['disclosure', 'error'])
    expect(String(seen[1]!.data.message)).toMatch(/listening|reach|running/i)
  })
})

describe('runAsk — probe', () => {
  it('scores a verbatim opening strong and never sends the raw reply', async () => {
    const stub = await startStub(
      answering('RECALL: yes\n', `OPENING: ${SECTION.slice(0, 80)}\n`)
    )
    configure(stub)

    await run(request({ mode: 'probe', question: null }))

    expect(names()).toEqual(['disclosure', 'verdict', 'done'])
    expect(seen[1]!.data).toEqual({ value: 'strong' })
    expect(JSON.stringify(seen)).not.toContain('RECALL')
  })

  it('scores an explicit refusal weak', async () => {
    const stub = await startStub(answering('RECALL: no\nOPENING:\n'))
    configure(stub)

    await run(request({ mode: 'probe', question: null }))

    expect(seen.find((s) => s.event === 'verdict')!.data).toEqual({ value: 'weak' })
  })

  it('scores a reply that does not follow the contract unknown', async () => {
    const stub = await startStub(answering('Certainly! Here is a lovely summary of the book.'))
    configure(stub)

    await run(request({ mode: 'probe', question: null }))

    expect(seen.find((s) => s.event === 'verdict')!.data).toEqual({ value: 'unknown' })
  })

  it('scores a fluent invention weak: the claim is not on the page', async () => {
    const stub = await startStub(
      answering('RECALL: yes\nOPENING: Call me Ishmael some years ago never mind how long precisely\n')
    )
    configure(stub)

    await run(request({ mode: 'probe', question: null }))

    expect(seen.find((s) => s.event === 'verdict')!.data).toEqual({ value: 'weak' })
  })

  it('is pointer-only by construction: no section text goes to the model', async () => {
    const stub = await startStub(answering('RECALL: no\nOPENING:\n'))
    configure(stub)

    await run(request({ mode: 'probe', rung: 'passage', selection: 'the age of wisdom', question: null }))

    const sent = JSON.stringify(stub.bodies[0])
    expect(sent).not.toContain('best of times')
    expect(sent).not.toContain('age of wisdom')
  })

  it('is unknown, with no section text to check against', async () => {
    const stub = await startStub(answering(`RECALL: yes\nOPENING: ${SECTION.slice(0, 60)}\n`))
    configure(stub)

    await run(
      request({
        mode: 'probe',
        question: null,
        section: { label: 'x', text: null, offset: null, truncated: false }
      })
    )

    expect(seen.find((s) => s.event === 'verdict')!.data).toEqual({ value: 'unknown' })
  })
})

describe('runAsk — hanging up', () => {
  it('aborts the upstream request and emits nothing after the signal fires', async () => {
    let upstreamClosed = false
    const stub = await startStub((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse('one'))
      req.on('close', () => (upstreamClosed = true))
    })
    configure(stub)
    const controller = new AbortController()

    const finished = run(request(), controller.signal)
    await vi.waitFor(() => expect(names()).toContain('delta'))
    const before = seen.length
    controller.abort()
    await finished

    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
    expect(seen).toHaveLength(before)
    expect(names()).not.toContain('done')
    expect(names()).not.toContain('error')
  })

  it('does nothing at all when the signal is already aborted', async () => {
    const stub = await startStub(answering('never'))
    configure(stub)
    const controller = new AbortController()
    controller.abort()

    await run(request(), controller.signal)

    expect(seen).toEqual([])
    expect(stub.bodies).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- electron/main/services/api/ask.test.ts 2>&1 | tail -20`
Expected: FAIL — `frame`, `healthAi` and `runAsk` do not exist.

- [ ] **Step 3: Implement**

Add to the top of `ask.ts` (extending the existing import):

```ts
import { randomUUID } from 'node:crypto'
import type { AiStatus } from '@shared/ai.types'
import { buildAskMessages, describeEgress, type AskRung } from '@ask/ask-context'
import { parseProbe, scoreRecall } from '@ask/recall'
import * as ai from '../ai'
import {
  askDeltaPayload,
  askDisclosurePayload,
  askDonePayload,
  askErrorPayload,
  askVerdictPayload,
  type HealthAi
} from './shape'
```

Append:

```ts
// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

export type AskEventName = 'disclosure' | 'verdict' | 'delta' | 'done' | 'error'

/** How `runAsk` reports. The socket module turns each call into a frame on the wire. */
export type AskEmit = (event: AskEventName, data: object) => void

/** One server-sent event. `JSON.stringify` never emits a raw newline, so `data:` is one line. */
export function frame(event: AskEventName, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** `host[:port]` of an endpoint URL, or `''` when there is none or it does not parse. */
function hostOf(endpoint: string | null): string {
  if (!endpoint) return ''
  try {
    return new URL(endpoint).host
  } catch {
    return ''
  }
}

/** The `ai` member of the health payload. Reads the status; never the key. */
export function healthAi(status: AiStatus): HealthAi {
  return {
    available: status.configured,
    reason: status.reason,
    isLocal: status.isLocal,
    host: hostOf(status.endpoint.value),
    model: status.model.value
  }
}

export interface RunAskInput {
  request: AskWireRequest
  book: { title: string; author: string | null }
  status: AiStatus
  emit: AskEmit
  /** Fires when the phone hangs up. Aborts the upstream request and silences `emit`. */
  signal?: AbortSignal
  /** Overridden in tests; the default is `services/ai.ts`'s own idle deadline. */
  idleTimeoutMs?: number
}

/**
 * One ask, start to terminal event. The three modes are one assembler called
 * three ways (D4): `preview` stops at the disclosure, `probe` collects the
 * model's reply and returns only its score, `ask` streams.
 *
 * **Resolves when a terminal event has been emitted, or when the phone hung up.**
 * After an abort nothing more is emitted — the reader is gone — and the
 * upstream request is canceled through `services/ai.ts`, which releases its slot.
 *
 * **A `preview` with a question previews an ask; without one, a probe.** The
 * assembler refuses a blank ask by design, so the choice is made here, once.
 */
export async function runAsk(input: RunAskInput): Promise<void> {
  const { request, book, status, signal } = input
  if (signal?.aborted) return

  const probing = request.mode === 'probe' || (request.mode === 'preview' && !request.question?.trim())
  const assembled = buildAskMessages({
    mode: probing ? 'probe' : 'ask',
    title: book.title,
    author: book.author,
    sectionLabel: request.section.label,
    fraction: request.fraction,
    question: request.question,
    sectionText: request.section.text,
    sectionOffset: request.section.offset,
    selection: request.selection,
    rung: request.rung
  })

  input.emit(
    'disclosure',
    askDisclosurePayload({
      text: describeEgress({
        endpoint: status.endpoint.value,
        model: status.model.value,
        payload: assembled.payload
      }),
      members: assembled.payload.members,
      rung: assembled.rung,
      windowed: assembled.payload.windowed,
      truncated: assembled.payload.truncated,
      host: hostOf(status.endpoint.value),
      isLocal: status.isLocal,
      model: status.model.value
    })
  )

  if (request.mode === 'preview') {
    input.emit('done', askDonePayload('stop'))
    return
  }

  await new Promise<void>((resolve) => {
    const requestId = `relay-${randomUUID()}`
    let reply = ''
    let hungUp = false

    const onAbort = (): void => {
      hungUp = true
      ai.cancel(requestId)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }

    const sink: ai.AskSink = {
      chunk: (delta) => {
        if (hungUp) return
        if (probing) reply += delta
        else input.emit('delta', askDeltaPayload(delta))
      },
      done: (reason) => {
        if (hungUp || reason === 'canceled') return finish()
        // A partial reply that parses is still scored — `RECALL: no` followed by
        // a dropped connection is the model saying it cannot place the book.
        if (probing) {
          input.emit('verdict', askVerdictPayload(scoreRecall(parseProbe(reply), request.section.text)))
        }
        input.emit('done', askDonePayload(reason))
        finish()
      },
      error: (message) => {
        if (!hungUp) input.emit('error', askErrorPayload(message))
        finish()
      }
    }

    try {
      ai.ask(
        { requestId, mode: assembled.mode, messages: assembled.messages },
        { sink, idleTimeoutMs: input.idleTimeoutMs }
      )
    } catch (err) {
      input.emit('error', askErrorPayload(err instanceof Error ? err.message : String(err)))
      finish()
    }
  })
}
```

Notes for the implementer: `AskDoneReason` from `@shared/ai.types` equals the `AskDoneData['reason']` union, so `askDonePayload(reason)` typechecks once the `canceled` branch above has returned. If `typecheck` objects to `idleTimeoutMs: undefined` under `exactOptionalPropertyTypes`, spread it conditionally — this repo's tsconfigs do not enable that flag, so it should not.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- electron/main/services/api/ask.test.ts 2>&1 | tail -14`
Expected: PASS. If the "fluent invention" case comes back `strong`, do not tune the scorer — the case is checking the *route's* use of it; report the token overlap with `recallOverlap` and pick a more different opening string.

- [ ] **Step 5: Gates and commit**

Run: `npm run typecheck && npm run lint`
Expected: clean (the full `npm test` waits for Task 6 for the reason Task 4 gave).

```bash
git add electron/main/services/api/ask.ts electron/main/services/api/ask.test.ts
git commit -m "feat(api): runAsk — preview, probe and ask through one assembler"
```

---

### Task 6: The route — body cap, SSE, gate, hang-up, heartbeat, health

**Files:**
- Modify: `electron/main/api/rest.ts` (`readJsonBody`, `RouteDeps`, `ServerOptions`, `createRestApiServer`, a new `handleAsk`, the router, the health arm)
- Create: `electron/main/api/rest.ask.test.ts`
- Modify: `electron/main/api/rest.test.ts` (health expectation, around line 475)

**Interfaces:**
- Consumes: `parseAskRequest`, `ASK_BODY_MAX_BYTES`, `runAsk`, `frame`, `healthAi`, `AskEmit` (Tasks 3, 5); `aiUnavailablePayload`, `errorPayload` (Task 4); `isAskRoute` (Task 4); `ai.getStatus`; `getBook` (existing).
- Produces: `ServerOptions.askHeartbeatMs?: number` (default 15,000) — a test seam, like `bodyTimeoutMs`. `POST /api/ai/ask` as the contract describes it.

- [ ] **Step 1: Write the failing tests**

`rest.ask.test.ts` — the harness follows `rest.reflow.test.ts` (real db, real server on an ephemeral port, no NAS involved):

```ts
import { rmSync } from 'fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { AI_CONFIG_KEYS } from '../services/ai'
import { ASK_BODY_MAX_BYTES } from '../services/api/ask'
import * as db from '../services/db'
import { setMainWindow } from '../services/events'
import { createRestApiServer } from './rest'

/**
 * `POST /api/ai/ask` over a real socket, against a stub OpenAI-compatible
 * endpoint. No model is needed and the NAS is not involved: the relay reads one
 * book row and talks to the stub. Events the desktop window would receive are
 * captured on a stand-in window so "a phone's ask never paints into the Mac
 * reader" is a measurement and not a reading of the code.
 */

const TOKEN = 'a1b2c3d4'.repeat(8)
const SECTION =
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.'

let api: Server
let base: string
let upstream: Server[] = []
let windowEvents: { channel: string; payload: unknown }[] = []

beforeEach(async () => {
  db.closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  upstream = []
  windowEvents = []
  for (const key of ['MUSAEUM_AI_BASE_URL', 'MUSAEUM_AI_MODEL', 'MUSAEUM_AI_API_KEY']) {
    vi.stubEnv(key, '')
  }
  setMainWindow({
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => windowEvents.push({ channel, payload }) }
  } as unknown as Parameters<typeof setMainWindow>[0])
  db.insertBook({ ...makeBook('b1', 'A Tale of Two Cities'), author: 'Charles Dickens' })

  api = createRestApiServer(
    { enabled: true, port: 0, bind: '127.0.0.1', token: TOKEN },
    { askHeartbeatMs: 40 }
  )
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})

afterEach(async () => {
  vi.unstubAllEnvs()
  setMainWindow(null)
  api.closeAllConnections()
  await new Promise<void>((resolve) => api.close(() => resolve()))
  await Promise.all(
    upstream.map((s) => new Promise<void>((done) => (s.closeAllConnections(), s.close(() => done()))))
  )
})

async function stub(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: string[] = []
  const closed: boolean[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')))
    req.on('end', () => {
      requests.push(raw)
      req.on('close', () => closed.push(true))
      handler(req, res)
    })
  })
  upstream.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  db.setConfig(AI_CONFIG_KEYS.baseUrl, url)
  db.setConfig(AI_CONFIG_KEYS.model, 'test-model')
  return { requests, closed }
}

const sse = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
const answering = (...deltas: string[]) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const d of deltas) res.write(sse(d))
  res.end('data: [DONE]\n\n')
}
/** An upstream that sends one token and then never finishes. */
const hanging = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('one'))
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const post = (body: unknown, headers: Record<string, string> = auth, signal?: AbortSignal) =>
  fetch(`${base}/api/ai/ask`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal
  })

const ASK = {
  bookId: 'b1',
  mode: 'ask',
  section: { label: 'Book the First', text: SECTION, offset: null },
  fraction: 0.1,
  question: 'What is the tone of this opening?'
}

/** The named events in a finished stream, comments skipped. */
function events(text: string): { event: string; data: Record<string, unknown> }[] {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const [event, data] = block.split('\n')
      return {
        event: event!.replace('event: ', ''),
        data: JSON.parse(data!.replace('data: ', '')) as Record<string, unknown>
      }
    })
}

describe('POST /api/ai/ask — refusals before the stream', () => {
  it('answers 401 with no credential, before any route logic', async () => {
    const res = await post(ASK, { 'content-type': 'application/json' })
    expect(res.status).toBe(401)
  })

  it.each([
    ['not JSON', '{nope'],
    ['an empty body', ''],
    ['an ask with no question', { bookId: 'b1', mode: 'ask' }],
    ['an unknown mode', { bookId: 'b1', mode: 'stream' }]
  ])('answers 400 for %s', async (_name, body) => {
    await stub(answering('x'))
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad request' })
  })

  it('holds the body to its cap: one byte past is a 400, and the upstream is never called', async () => {
    const up = await stub(answering('x'))
    const pad = 'x'.repeat(ASK_BODY_MAX_BYTES)
    const res = await post(JSON.stringify({ ...ASK, selection: pad }))
    expect(res.status).toBe(400)
    expect(up.requests).toHaveLength(0)
  })

  it('answers 404 for an unknown book', async () => {
    await stub(answering('x'))
    const res = await post({ ...ASK, bookId: 'nope' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('answers 503 ai unavailable, with a reason, in every mode when no model is set', async () => {
    for (const mode of ['preview', 'probe', 'ask']) {
      const res = await post({ ...ASK, mode })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error: string; reason: string }
      expect(body.error).toBe('ai unavailable')
      expect(body.reason).toMatch(/model/i)
      expect(res.headers.get('retry-after')).toBeNull()
    }
  })

  it.each(['GET', 'HEAD', 'PUT', 'DELETE'])('answers the uniform 404 to %s', async (method) => {
    const res = await fetch(`${base}/api/ai/ask`, { method, headers: auth })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/ai/ask — the stream', () => {
  it('previews without calling the model', async () => {
    const up = await stub(answering('never'))
    const res = await post({ ...ASK, mode: 'preview', question: null })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
    expect(res.headers.get('cache-control')).toBe('no-store')

    expect(events(await res.text()).map((e) => e.event)).toEqual(['disclosure', 'done'])
    expect(up.requests).toHaveLength(0)
  })

  it('streams an ask: disclosure, deltas in order, one done', async () => {
    await stub(answering('A grand', ' contrast.'))
    const res = await post(ASK)
    const seen = events(await res.text())

    expect(seen.map((e) => e.event)).toEqual(['disclosure', 'delta', 'delta', 'done'])
    expect(seen.filter((e) => e.event === 'delta').map((e) => e.data.text)).toEqual([
      'A grand',
      ' contrast.'
    ])
  })

  it('answers a probe with a verdict and never the raw reply', async () => {
    await stub(answering('RECALL: yes\n', `OPENING: ${SECTION.slice(0, 70)}\n`))
    const res = await post({ ...ASK, mode: 'probe', question: null })
    const text = await res.text()

    expect(events(text).map((e) => e.event)).toEqual(['disclosure', 'verdict', 'done'])
    expect(text).not.toContain('RECALL')
    expect(events(text)[1]!.data).toEqual({ value: 'strong' })
  })

  it('reports an upstream failure as an error event after a 200', async () => {
    db.setConfig(AI_CONFIG_KEYS.baseUrl, 'http://127.0.0.1:1/v1')
    db.setConfig(AI_CONFIG_KEYS.model, 'test-model')
    const res = await post(ASK)
    expect(res.status).toBe(200)
    expect(events(await res.text()).map((e) => e.event)).toEqual(['disclosure', 'error'])
  })

  it('never lets the key reach a response', async () => {
    await stub(answering('ok'))
    db.setConfig(AI_CONFIG_KEYS.apiKey, 'sk-secret-key-9999')
    const body = await (await post(ASK)).text()
    expect(body).not.toContain('sk-secret')
    const health = await (await fetch(`${base}/api/health`, { headers: auth })).text()
    expect(health).not.toContain('sk-secret')
  })

  it("never paints into the Mac reader: the window sees none of a phone's events", async () => {
    await stub(answering('a', 'b'))
    await (await post(ASK)).text()
    expect(windowEvents).toEqual([])
  })

  it('writes a heartbeat comment while the model is silent', async () => {
    await stub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // silence
    })
    const controller = new AbortController()
    const res = await post(ASK, auth, controller.signal)
    const reader = res.body!.getReader()
    let text = ''
    await vi.waitFor(async () => {
      const { value } = await reader.read()
      text += new TextDecoder().decode(value)
      expect(text).toContain(': ping')
    })
    controller.abort()
  })
})

describe('POST /api/ai/ask — concurrency and hanging up', () => {
  it('turns the third concurrent ask away with 503 busy and Retry-After: 1', async () => {
    await stub(hanging)
    const c1 = new AbortController()
    const c2 = new AbortController()
    const first = await post(ASK, auth, c1.signal)
    const second = await post(ASK, auth, c2.signal)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    const third = await post(ASK)
    expect(third.status).toBe(503)
    expect(await third.json()).toEqual({ error: 'busy' })
    expect(third.headers.get('retry-after')).toBe('1')

    c1.abort()
    c2.abort()
  })

  it('aborts the upstream request when the phone hangs up, and frees the slot', async () => {
    const up = await stub(hanging)
    const c1 = new AbortController()
    const c2 = new AbortController()
    await post(ASK, auth, c1.signal)
    await post(ASK, auth, c2.signal)

    c1.abort()
    c2.abort()
    await vi.waitFor(() => expect(up.closed.length).toBe(2))

    // The slots came back: two more asks are admitted
    const c3 = new AbortController()
    const again = await post(ASK, auth, c3.signal)
    expect(again.status).toBe(200)
    c3.abort()
  })

  it("a phone ask beside the desktop's own question keeps each stream to itself", async () => {
    await stub(answering('x'))
    const { ask } = await import('../services/ai')
    ask({ requestId: 'desktop-1', mode: 'ask', messages: [{ role: 'user', content: 'hi' }] })
    const seen = events(await (await post(ASK)).text())
    await vi.waitFor(() =>
      expect(windowEvents.some((e) => (e.payload as { requestId?: string }).requestId === 'desktop-1')).toBe(true)
    )

    expect(seen.map((e) => e.event)).toEqual(['disclosure', 'delta', 'done'])
    expect(windowEvents.every((e) => (e.payload as { requestId?: string }).requestId === 'desktop-1')).toBe(true)
  })
})

describe('GET /api/health — the ai member', () => {
  it('is available when a model is set, with the endpoint as host[:port]', async () => {
    await stub(answering('x'))
    const body = (await (await fetch(`${base}/api/health`, { headers: auth })).json()) as {
      ai: Record<string, unknown>
    }
    expect(body.ai).toMatchObject({ available: true, reason: null, isLocal: true, model: 'test-model' })
    expect(String(body.ai.host)).toMatch(/^127\.0\.0\.1:\d+$/)
  })

  it('says why it is off when no model is set', async () => {
    const body = (await (await fetch(`${base}/api/health`, { headers: auth })).json()) as {
      ai: { available: boolean; reason: string; model: null }
    }
    expect(body.ai.available).toBe(false)
    expect(body.ai.reason).toMatch(/model/i)
    expect(body.ai.model).toBeNull()
  })
})
```

In `rest.test.ts`, at the health expectation (~line 475), add the member with a matcher that does not depend on the machine's AI config:

```ts
    expect(await res.json()).toEqual({
      apiVersion: 1,
      version: APP_VERSION,
      books: 2,
      library: 'offline',
      ai: expect.objectContaining({ available: expect.any(Boolean) })
    })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- electron/main/api 2>&1 | tail -25`
Expected: FAIL — the route answers 404, `askHeartbeatMs` is not an option, and health carries no `ai`.

- [ ] **Step 3: Implement the route**

In `rest.ts`:

(a) Imports. Add to the existing `../services/api/...` imports:

```ts
import { ASK_BODY_MAX_BYTES, frame, healthAi, parseAskRequest, runAsk } from '../services/api/ask'
```
extend the `routes` import with `isAskRoute`, the `shape` import with `aiUnavailablePayload`, and add `import * as ai from '../services/ai'` beside the other service imports.

(b) `readJsonBody` takes the cap as a parameter (default unchanged):

```ts
function readJsonBody(
  req: IncomingMessage,
  timeoutMs: number,
  maxBytes: number = MAX_BODY_BYTES
): Promise<{ ok: true; body: unknown } | { ok: false }> {
```
and in `onData`: `if (size > maxBytes) {`. Add one sentence to its docblock: *"The cap is a parameter because the reading report's 4 KB would refuse every ask; the default is still the report's."*

(c) Constants and deps:

```ts
/** At most this many relay asks in flight; a third is `503 busy`. Independent of the byte budget and of the desktop panel's own question. */
const MAX_RELAY_ASKS = 2

/** How often a silent stream gets a comment line, so a cold local model does not trip the client's idle timer. */
const ASK_HEARTBEAT_MS = 15_000
```
`RouteDeps` gains `askGate: ByteGate` and `askHeartbeatMs: number`; `ServerOptions` gains

```ts
  /** The ask stream's heartbeat interval; default `ASK_HEARTBEAT_MS`. A seam so a case decides it in milliseconds. */
  askHeartbeatMs?: number
```
and `createRestApiServer`'s `deps` gains `askGate: createByteGate(MAX_RELAY_ASKS), askHeartbeatMs: options.askHeartbeatMs ?? ASK_HEARTBEAT_MS`.

(d) The handler, after `handleReadingReport`:

```ts
/**
 * `POST /api/ai/ask` — the relay (phone-ask D3). Thin by construction: the body
 * is read and validated, the book and the model are looked up, and everything
 * else — what travels, what the verdict is, what the model is asked — is
 * `services/api/ask.ts`'s `runAsk`. This function owns only what needs the socket:
 * the SSE headers, the heartbeat, the slot and the hang-up.
 *
 * **The order is the contract's:** the body is refused (400) before the book is
 * looked up (404), and the model's absence (503) is answered before a slot is
 * taken, so a request this surface cannot serve never counts against the two
 * it can.
 */
async function handleAsk(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  const raw = await readJsonBody(req, deps.bodyTimeoutMs, ASK_BODY_MAX_BYTES)
  const parsed = raw.ok ? parseAskRequest(raw.body) : ({ ok: false } as const)
  if (!parsed.ok) {
    sendJson(res, 400, errorPayload('badRequest'))
    return
  }

  const book = getBook(parsed.request.bookId)
  if (!book) {
    sendJson(res, 404, errorPayload('notFound'))
    return
  }

  const status = ai.getStatus()
  if (!status.configured) {
    sendJson(res, 503, aiUnavailablePayload(status.reason ?? 'The Mac has no model set.'))
    return
  }

  if (!deps.askGate.acquire()) {
    sendJson(res, 503, errorPayload('busy'), { 'retry-after': String(BUSY_RETRY_AFTER_SECONDS) })
    return
  }

  const hangup = new AbortController()
  res.on('close', () => hangup.abort())
  let beat: ReturnType<typeof setInterval> | undefined
  try {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive'
    })
    res.flushHeaders()

    const write = (chunk: string): void => {
      if (hangup.signal.aborted || res.writableEnded) return
      res.write(chunk)
    }
    beat = setInterval(() => write(': ping\n\n'), deps.askHeartbeatMs)

    await runAsk({
      request: parsed.request,
      book: { title: book.title, author: book.author ?? null },
      status,
      signal: hangup.signal,
      emit: (event, data) => write(frame(event, data))
    })
    if (!res.writableEnded) res.end()
  } finally {
    if (beat) clearInterval(beat)
    deps.askGate.release()
  }
}
```

(e) The router: add the arm beside the upload's (before `matchBookPath`):

```ts
    // **The relay** (phone-ask D3): POST-only, matched on its pathname. A `GET`
    // or `HEAD` of it falls through to the uniform 404 like any known path behind
    // a method it does not answer.
    if (req.method === 'POST' && isAskRoute(url.pathname)) {
      await handleAsk(req, res, deps)
      return
    }
```
and the health arm:

```ts
      sendJson(
        res,
        200,
        healthPayload({
          version: app.getVersion(),
          books: countBooks(),
          online: nas.isOnline(),
          ai: healthAi(ai.getStatus())
        })
      )
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- electron/main/api electron/main/services/api 2>&1 | tail -20`
Expected: PASS — including the pre-existing `rest.test.ts` and `upload.test.ts`, whose bodies must be unchanged apart from the health expectation.

If the "phone hangs up" case flakes, the likely cause is the `res.on('close')` listener firing at a normal end (it does — `close` follows `end`): `runAsk` has already resolved by then, so the abort is a no-op. Do not remove the listener; diagnose the case's timing first.

- [ ] **Step 5: The full gates**

Run: `npm run typecheck && npm run lint && npm test 2>&1 | tail -6 && git diff --quiet index.html && echo index-unchanged`
Expected: green and `index-unchanged`. Record the new test count — it is the baseline for the iOS slices' live pass.

- [ ] **Step 6: Commit**

Run the `/verify` skill (code commit), then:

```bash
git add electron/main/api/rest.ts electron/main/api/rest.ask.test.ts electron/main/api/rest.test.ts
git commit -m "feat(api): POST /api/ai/ask — a streaming relay over the Mac's model"
```

---

### Task 7: The smoke script, the backlog entry, and the live pass

**Files:**
- Modify: `scripts/api-smoke.sh`
- Modify: `tasks.md` (the existing entry)

**Interfaces:**
- Consumes: the finished route and `health.ai`.
- Produces: the contract's executable half for the new route, and the backlog entry brought up to date.

- [ ] **Step 1: Add the health check**

In the `--- health (GET and HEAD)` section of `scripts/api-smoke.sh`, after the `library` state check, add:

```bash
check 'the payload carries the ai member' 'boolean' "$(jq -r '.ai.available | type' "$BODY")"
check 'the ai member never carries a key' 'no-key' \
  "$(jq -r 'if (.ai | has("apiKey") or has("hasKey")) then "leaked-key" else "no-key" end' "$BODY")"
AI_AVAILABLE="$(jq -r '.ai.available' "$BODY")"
```

- [ ] **Step 2: Add the ask section**

Before `printf '\n--- the shape of a refusal\n'`, add. It uses `preview` only, so it never calls a model and needs none installed:

```bash
printf '\n--- ask (preview: assembles and discloses, calls no model)\n'

if [ -n "$FIRST_ID" ]; then
  ASK_PREVIEW="{\"bookId\":\"$FIRST_ID\",\"mode\":\"preview\",\"question\":\"What is this about?\"}"
  code=$(request /api/ai/ask -X POST -H 'Content-Type: application/json' --data "$ASK_PREVIEW")
  if [ "$AI_AVAILABLE" = "true" ]; then
    check 'a preview answers 200' 200 "$code"
    check 'its type is an event stream' 'text/event-stream' \
      "$(header content-type | sed 's/;.*//')"
    check 'the stream opens with a disclosure' 'event: disclosure' "$(grep -m1 '^event:' "$BODY")"
    check 'the stream ends with a done' 'event: done' "$(grep '^event:' "$BODY" | tail -1)"
    check 'the disclosure line names what is sent' 1 "$(grep -c 'Sends:' "$BODY")"
  else
    check 'with no model set, a preview answers 503' 503 "$code"
    check 'the refusal is the contract body' 'ai unavailable' "$(jq -r '.error' "$BODY")"
    check 'the refusal says why' 'string' "$(jq -r '.reason | type' "$BODY")"
    note 'the Mac has no model set — the streaming checks were skipped; set one in Settings to run them'
  fi
fi

code=$(request /api/ai/ask -X POST -H 'Content-Type: application/json' --data '{"bookId":"x","mode":"stream"}')
check 'an unknown mode answers 400' 400 "$code"
check 'the refusal is the contract body' 'bad request' "$(jq -r '.error' "$BODY")"

code=$(request /api/ai/ask)
check 'a GET of the ask route answers 404' 404 "$code"
```

- [ ] **Step 3: Run the smoke script against an isolated Mac on a stub endpoint**

Use the repo's `verify` skill to bring up an isolated profile (`MUSAEUM_USER_DATA`), enable the REST API there, and run:

```bash
scripts/api-smoke.sh --profile "$MUSAEUM_USER_DATA"
```
Expected: `passed N, failed 0`. Run it twice — once with no `ai_model` set (the 503 branch) and once with `ai_model` set and `ai_base_url` pointing at a stub SSE server (the 200 branch). If a branch cannot be exercised on this machine, say which, in the report. Do not claim a branch passed that did not run.

- [ ] **Step 4: Update the `tasks.md` entry**

The entry *Ask about the page you're on, on the phone — the relay route* already exists under *Specified, not scheduled* (added when the plans were written). Edit it in place, single line, no hard wrapping: replace *"Planned, not started; nothing is built."* with what is now true — slices 1 and 2 built and gated, the date and the commit, the new test count from Task 6 Step 5, and which smoke branches (503 and 200) actually ran. Leave slices 3–4 marked as the iOS repo's.

- [ ] **Step 5: Commit**

```bash
git add scripts/api-smoke.sh tasks.md
git commit -m "test(api): the ask route's smoke checks, and the backlog entry"
```

---

## Self-review (run against the spec)

- **Spec coverage:** D1 (backend seam) → iOS plan. D2 → Task 1. D3 → Tasks 3, 4, 6 (request, caps, events, heartbeat, refusals, gate, disconnect). D4 → Task 5 (one assembler, probe never returns the raw reply). D5 → Task 2. D6 → iOS plan. D7 → Tasks 4 and 7 (`health.ai`, additive, `apiVersion` stays 1, goldens, smoke). AC1–AC3 → Task 1; AC4 → Task 2 and Task 6 (window sees nothing); AC5 → Tasks 5 and 6 (zero upstream calls on preview); AC6 → Task 5; AC7 → Task 5 and 6; AC8 → Task 6; AC9 → Tasks 5 and 6; AC10 → Task 6 (body cap) — the lying-`Content-Length` case is `readJsonBody`'s existing timeout path, which the new cap parameter does not change and `rest.test.ts` already decides; AC11 → Task 6; AC12 → Task 6; AC13 → Tasks 4 and 7; AC14 → Tasks 5 and 6; AC15 → Task 1 and 6.
- **Placeholder scan:** none; every step shows code or an exact command.
- **Type consistency:** `AskSink` (Task 2) is used as `ai.AskSink` in Task 5; `AskWireRequest` (Task 3) is the `request` member of `RunAskInput` (Task 5) and the parser's output in Task 6; the shaper names in Task 4 are the ones Task 5 imports; `healthAi` (Task 5) returns `HealthAi` (Task 4) and feeds `healthPayload` (Task 6); `isAskRoute` (Task 4) is used in Task 6.
- **Known limit to say aloud:** AC10's lying-`Content-Length` half is carried by existing coverage rather than a new case. If the reviewer wants it decided on this route specifically, add a raw-socket case modelled on the one in `rest.test.ts` that declares `Content-Length: 100` and sends 6 bytes to `/api/ai/ask`, expecting a 400 within `bodyTimeoutMs`.
