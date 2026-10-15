# The voice reader, slice 2 (listen to a book) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Listen button in the reader opens a transport bar; pressing play reads the visible page aloud sentence by sentence in a local Kokoro voice, the page follows the voice, and the model downloads on first use.

**Architecture:** Foliate's own `view.initTTS('sentence')` supplies marked sentences per block; a pure `speech-queue` flattens each block's SSML into units, a `SpeechPlayer` on one Web Audio clock plays them gaplessly with a two-sentence prefetch (voice and speed per call), and a `SpeechController` is the only code that touches the foliate TTS object (it owns the cursor hazard described under *Facts found while planning*). A `useSpeech` hook owns the model-status → download → ready → playing state machine; `ListenBar` renders it. Position saving is untouched: speech advances pages through the engine, so `onRelocate` fires as it does for a hand turn.

**Tech Stack:** React + TypeScript, Zustand, Web Audio, vendored foliate-js (never edited), the existing `window.Musaeum.tts` surface, the Python sidecar (one dispatcher change).

**Spec:** `docs/superpowers/specs/2026-10-15-voice-reader-design.md` (D4–D7, AC12–AC21; D3/AC7 amended by Task 1). Engine build record and annex: `docs/superpowers/plans/2026-10-15-voice-reader-engine.md`. Invariants to read per task are named in each task's header.

## Decisions taken with the owner before this plan was written

- **Third sidecar lane (owner's choice, 2026-10-15).** `tts_model_status` and `tts_cancel_download` move to a small dedicated pool so they cannot wait behind a bulk refresh or a long `reflow_pdf`. `tts_download_model` stays on the shared pool (it is long and independent; `cancel_download` is safe before the job starts, `models.py:104-108`, so a cancel still lands when the shared pool is saturated). This is a **spec change**, made in Task 1: D3 and AC7 are amended, not just the code.

## Facts found while planning (each one shapes a task)

1. **Foliate's `TTS` rebuilds its range map on every cursor move.** `#ranges` is reassigned inside the list iterator's mapper (`vendor/foliate-js/tts.js:211-214`) whenever `start()`, `next()`, `prev()`, `resume()` or `from()` applies it to a block, and `setMark(name)` looks the name up in whichever block the cursor is on *now* (`:271-277`). So calling `next()` to prefetch block N+1's text makes every later `setMark` for block N a silent no-op or, worse, highlight the wrong range. **Rule that follows (Task 6): the player never prefetches across a block boundary.** The source hands out block N+1's first unit only after block N's last unit has *started* (its `setMark` has already been called). Within a block, prefetch is free, because the units are already in our hands. This costs nothing audible: the player adds a 700 ms pause after a block, which covers a warm synthesis (0.11 s) and a cold one (0.42 s) with room to spare.
2. **`initTTS` binds to the current section's document and returns early only if it is the same document** (`view.js:584-591`); it does not re-fire on section change, so the controller re-calls it after every section advance.
3. **The default highlight is `renderer.scrollToAnchor(range, true)`** (`view.js:588-589`). Passing our own `highlight` replaces it, so ours must scroll too. It draws through the engine's existing `addAnnotation` / `draw-annotation` arm (`ReaderEngine.tsx:295-300`, kind-selected `DRAWS` table), not a second overlay.
4. **The vitest environment is `node`, with no jsdom**, and only `*.test.ts` files run. Component behavior is therefore pinned the way `reader-palette.test.ts` and `drag-regions.test.ts` already do it: pure modules get behavioral tests, components get source-scan tests, and everything visible is proved in the running app (Task 8). The SSML fixture for AC12 is **captured from the real engine in the running app** (Task 3 Step 1), not synthesized by hand.
5. **Nothing in `setMark`'s path knows about pages.** Manual navigation (AC17) is detected by *containment*: after any `relocate`, if the sentence currently being spoken is not inside the new page's range, the user moved, and speech restarts at the new page's first sentence via `tts.from(range)`. No flag is needed to tell a speech-driven scroll from a hand turn, which is what makes it race-free.
6. **The key `L` collides with nothing in the reader.** `ReaderView.onKeyDown` handles only Escape, ArrowRight/Left, PageDown/Up and Space; ⌘F is a menu command. Unmodified `L` is the toggle, bailing in typing targets exactly as the existing handler does.

## Global Constraints

- TypeScript strict; **no `any`**; interfaces in `src/types/`. Functional components only. Icons are hand-rolled SVG in `src/components/shared/icons.tsx`; no icon library.
- **`vendor/foliate-js/` is never edited** (invariant 11). Type gaps are closed in `src/types/foliate-js.d.ts`.
- **The renderer never gets `file://`** and never calls the sidecar directly; audio crosses IPC as `window.Musaeum.tts.synthesize` PCM (invariant 9, spec D10). No new `musaeum://` host, no CSP change expected; AC18 proves it.
- **Nothing in the speech arm may branch on the source format** (spec D5 PDF); a reflowed PDF is an EPUB to it.
- Every list cell / scroll-height invariant is untouched; the bar is a flex row at the bottom of the reader column and must not change `ROW_HEIGHT`-style geometry anywhere in the library.
- Every control that can land in the reader's draggable top band carries `app-no-drag` (`docs/invariants/reader.md`; held by `src/components/reader/drag-regions.test.ts`, which Task 7 extends).
- Voice is one of `TTS_VOICES`; speed is `clampTtsSpeed`'s 0.8–1.5 step 0.1, default 1.0 (`src/types/tts.types.ts`). Pauses: **350 ms after a sentence, 700 ms after a block** (spec D5).
- Prefetch depth **2**. Sentence cache **~50 entries**, in renderer memory only; no disk cache (spec D9).
- Markdown prose is not hard-wrapped. Never commit `.tasks.md.swp`. Never push. Never edit `vendor/`.
- Every commit ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Run the `/verify` recipe before any commit that touches source (subagents cannot call the skill: they read `.claude/skills/verify/` and run its recipe by hand, and the commit message or report quotes the log evidence).
- **Escalate** (stop, hand back) if: a plan step contradicts what is observed; a task needs more than ~10 files or would bend a `CLAUDE.md` invariant; two repair attempts fail on the same test.
- **Real-model tests** read `MUSAEUM_TTS_MODELS=$HOME/Downloads/musaeum-tts-bakeoff/models`. **Do not delete that folder.**
- **Baselines** to report against at the end: pytest 539 passed + 24 skipped without models, 563 passed with; `npm test` 2248 passed in 102 files; typecheck and lint clean.

## Review Focus

The inputs and conditions the spec implies and no task's happy path exercises, most likely first. Each has its pinning test in the task named.

1. **A page turn while a sentence is mid-flight must not leave speech on the old page or double-speak.** The old units must be discarded and the queue refilled from the new page. (Task 4 `jump`; Task 6 containment test.)
2. **A block that yields no units** (an image-only block, a lone `[12]` footnote, whitespace) must be skipped, not stall or end speech. (Task 3 empty-block; Task 6 skip-forward test.)
3. **Silence is a normal answer.** The engine returns empty `samples` / `durationMs: 0` for text with nothing to say; the player advances immediately and does not schedule a zero-length buffer or its pause. (Task 4.)
4. **A synthesis failure mid-book** (sidecar restarted, timeout, a rejection) must stop speech with one line and a retry, and leave the reader fully usable. (Task 4 error path; Task 7 bar.)
5. **A damaged model** (`ready` on size alone, then `verify` fails with "damaged" on first synth, voice-reader.md) must route to a re-download, not to a dead retry loop. (Task 7.)
6. **Closing the reader, switching book, or unmounting while audio is scheduled** must stop the context's sources and `close()` it; no audio from a closed book. (Task 6, Task 7 source scans, Task 8 live.)
7. **Voice or speed changed mid-sentence** applies from the next sentence, and queued-but-unstarted units are re-requested in the new voice. (Task 4.)
8. **Retry racing the old job's `.part`** after the 30-minute app-side download timeout (deferred minor 3). The bar disables Retry for 2 s after a failure and Task 8 records whether the live run ever hits it. (Task 7, Task 8.)

---

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `sidecar/main.py`, `sidecar/tests/test_tts_lane.py` | the third lane | 1 |
| `docs/superpowers/specs/2026-10-15-voice-reader-design.md`, `docs/invariants/voice-reader.md` | D3/AC7 amendment, invariant text | 1 |
| `src/stores/reader.store.ts` (+ test) | `voice`, `speed` prefs; session `listenOpen` | 2 |
| `src/lib/speech-queue.ts` (+ test, + fixture) | SSML → `SpeechUnit[]` | 3 |
| `src/lib/speech-player.ts` (+ test) | gapless Web Audio scheduling, prefetch, cache, transport | 4 |
| `src/lib/theme/reader-palette.ts` (+ test) | the `speech` role | 5 |
| `src/types/foliate-js.d.ts`, `src/lib/speech-controller.ts` (+ test), `src/components/reader/ReaderEngine.tsx` | the engine arm | 6 |
| `src/hooks/useSpeech.ts` (+ test) | state machine over `window.Musaeum.tts` | 7 |
| `src/components/shared/icons.tsx`, `src/components/reader/ListenBar.tsx`, `ReaderView.tsx`, `SelectionChip.tsx`, `drag-regions.test.ts` | the visible surface | 7 |
| docs, `tasks.md`, `CHANGELOG.md` | record | 8 |

Slice 2 is ~20 files across eight tasks; no task exceeds ten. It crosses `sidecar` ⇄ `src` only in Task 1 (one dispatcher change, no wire change).

---

### Task 1: The third sidecar lane (sidecar-engineer)

**Read first:** `docs/invariants/voice-reader.md` (the *Only `tts_synthesize` has a lane of its own* bullet), spec D3 and AC7.

**Files:**
- Modify: `sidecar/main.py:128-152` and `:190-194`
- Modify: `sidecar/tests/test_tts_lane.py`
- Modify: `docs/superpowers/specs/2026-10-15-voice-reader-design.md` (D3 *The lane*, AC7)
- Modify: `docs/invariants/voice-reader.md` (the lane bullet; remove the "Open design question" sentence, state the decision)

**Interfaces:**
- Produces: `main.CONTROL_POOL` (`ThreadPoolExecutor(max_workers=2)`), `main.CONTROL_LANE = frozenset({"tts_model_status", "tts_cancel_download"})`; `lane_for` returns `TTS_POOL` for `tts_synthesize`, `CONTROL_POOL` for the control lane, `POOL` otherwise. `tts_download_model` stays on `POOL`.

- [ ] **Step 1: Write the failing tests** in `sidecar/tests/test_tts_lane.py`, in the file's existing style (patch `main.send`, `monkeypatch.setitem(main.METHODS, ...)`, saturate `main.POOL` with four `gate.wait` blockers):

```python
def test_status_and_cancel_are_answered_while_the_shared_pool_is_saturated(monkeypatch):
    sent = []
    monkeypatch.setattr(main, "send", sent.append)
    monkeypatch.setitem(main.METHODS, "tts_model_status", lambda p: {"ready": True})
    monkeypatch.setitem(main.METHODS, "tts_cancel_download", lambda p: {"cancelled": True})
    gate = threading.Event()
    blockers = [main.POOL.submit(gate.wait) for _ in range(4)]
    try:
        main.dispatch({"id": 1, "method": "tts_model_status", "params": {}})
        main.dispatch({"id": 2, "method": "tts_cancel_download", "params": {}})
        _wait_for(sent, n=2)
        assert {m["id"] for m in sent} == {1, 2}
    finally:
        gate.set()
        for b in blockers:
            b.result(5)


def test_the_download_stays_on_the_shared_pool():
    assert main.lane_for({"method": "tts_download_model"}) is main.POOL


def test_the_control_lane_is_not_the_speech_lane():
    assert main.lane_for({"method": "tts_model_status"}) is main.CONTROL_POOL
    assert main.lane_for({"method": "tts_synthesize"}) is main.TTS_POOL
    assert main.CONTROL_POOL is not main.TTS_POOL
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/jasonoh/Projects/musaeum-macos && sidecar/.venv/bin/python -m pytest sidecar/tests/test_tts_lane.py -v`
Expected: the three new cases FAIL (`AttributeError: module 'main' has no attribute 'CONTROL_POOL'`, and the first times out).

- [ ] **Step 3: Implement** in `sidecar/main.py`: add `CONTROL_POOL = ThreadPoolExecutor(max_workers=2)` and `CONTROL_LANE` beside `TTS_POOL`; extend `lane_for`; add `CONTROL_POOL.shutdown(wait=True)` in `main()` after the other two. Update the comment above `POOL` to say three pools and why (a status or cancel is quick and must never queue behind a Google Books call or a reflow). Update the comment at `METHODS`' tts block to match.

- [ ] **Step 4: Amend the docs.** In the spec, D3 *The lane* gains one sentence: status and cancel run on a two-thread control lane, the download on the shared pool; AC7 gains "and `tts_model_status` / `tts_cancel_download` likewise". In `docs/invariants/voice-reader.md` replace the lane bullet's *Open design question* with the decision and its reason (owner's choice 2026-10-15; the cancel-before-start property is what makes the download's placement safe). Do not hard-wrap.

- [ ] **Step 5: Run the full sidecar suite**

Run: `cd /Users/jasonoh/Projects/musaeum-macos && sidecar/.venv/bin/python -m pytest sidecar/tests -q` and again with `MUSAEUM_TTS_MODELS=$HOME/Downloads/musaeum-tts-bakeoff/models`.
Expected: 542 passed + 24 skipped without models, 566 with (baseline + 3); nothing previously passing now skipped.

- [ ] **Step 6: Verify** — the module is wired into the running sidecar, so run the `/verify` recipe by hand (launch isolated instance, `window.Musaeum.tts.status()` resolves, app boots) and keep the log.

- [ ] **Step 7: Commit**

```bash
git add sidecar/main.py sidecar/tests/test_tts_lane.py docs/superpowers/specs/2026-10-15-voice-reader-design.md docs/invariants/voice-reader.md
git commit -m "feat(tts): a control lane for model status and cancel

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Voice and speed prefs, the listen flag (renderer-engineer)

**Read first:** `docs/invariants/settings-and-editing.md` (persisted UI state), `src/stores/reader.store.ts:48-160` and `:363-420` (`ReaderPrefs`, `sanitizePrefs`, `persistedReaderState`).

**Files:**
- Modify: `src/stores/reader.store.ts`
- Test: `src/stores/reader.store.test.ts`

**Interfaces:**
- Produces: `ReaderPrefs` gains `voice: TtsVoice` and `speed: number`; `DEFAULT_PREFS.voice = TTS_DEFAULT_VOICE`, `.speed = 1.0`; `sanitizePrefs` falls back to `af_heart` for an unknown voice and clamps speed with `clampTtsSpeed`; `ReaderState` gains `listenOpen: boolean` with `toggleListen(): void` and `closeListen(): void`. `listenOpen` is session state, **not** in `persistedReaderState`, and is reset by the same path that resets `searchOpen` etc. when a book closes.
- Consumes: `TTS_VOICES`, `TTS_DEFAULT_VOICE`, `clampTtsSpeed` from `@shared/tts.types`.

- [ ] **Step 1: Write failing tests** next to the existing `sanitizePrefs` cases:

```ts
it('falls back to af_heart for an unknown voice and keeps a known one', () => {
  expect(sanitizePrefs({ voice: 'nope' }).voice).toBe('af_heart')
  expect(sanitizePrefs({ voice: 'bm_george' }).voice).toBe('bm_george')
})
it('clamps speed to 0.8–1.5 in tenths and defaults NaN to 1.0', () => {
  expect(sanitizePrefs({ speed: 9 }).speed).toBe(1.5)
  expect(sanitizePrefs({ speed: 0.1 }).speed).toBe(0.8)
  expect(sanitizePrefs({ speed: 1.26 }).speed).toBe(1.3)
  expect(sanitizePrefs({ speed: 'fast' }).speed).toBe(1.0)
})
it('persists voice and speed but not whether the listen bar is open', () => {
  const persisted = persistedReaderState(useReaderStore.getState())
  expect(JSON.stringify(persisted)).toContain('"voice"')
  expect(persisted).not.toHaveProperty('listenOpen')
})
it('a prefs object stored before this slice still loads, with the new defaults', () => {
  const old = { typeface: 'sans', fontSize: 20, lineHeight: 1.5, margin: 40, theme: 'auto' }
  expect(sanitizePrefs(old)).toMatchObject({ voice: 'af_heart', speed: 1.0, typeface: 'sans' })
})
it('closing a book closes the listen bar', () => { /* open a book, toggleListen, close, expect listenOpen false */ })
```
(Write the last test in full using the store's actual open/close actions; read the existing close tests for the idiom.)

- [ ] **Step 2: Run** `npm test -- src/stores/reader.store.test.ts` — expect FAIL on the new cases.
- [ ] **Step 3: Implement** the fields, defaults, sanitizer lines, the flag and its reset.
- [ ] **Step 4: Run** `npm test -- src/stores/reader.store.test.ts` then `npm run typecheck && npm run lint` — expect PASS/clean. Fix any existing test that deep-equals `DEFAULT_PREFS` or a full prefs literal.
- [ ] **Step 5: Verify** by hand (recipe), then commit `feat(reader): voice and speed prefs, and the listen flag`.

---

### Task 3: `speech-queue`, SSML to units (renderer-engineer)

**Read first:** spec D5 first paragraph and AC12; `vendor/foliate-js/tts.js:80-140` (what the SSML contains: `<mark name="N"/>` before each unit, `<phoneme>`, `<break/>`, `<emphasis>`, `<lang>`).

**Files:**
- Create: `src/lib/speech-queue.ts`
- Create: `src/lib/__fixtures__/foliate-ssml.ts` (captured strings)
- Test: `src/lib/speech-queue.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SpeechUnit { mark: string; text: string; blockEnd: boolean }
/** A block's SSML → its sentences, in order. Pure; no DOM. Empty block → []. */
export function flattenSsml(ssml: string | null | undefined): SpeechUnit[]
```

- [ ] **Step 1: Capture the fixture from the real engine.** Run the `/verify` recipe to launch an isolated instance, import or open a real EPUB from the repo's test corpus (find one with `find . -name '*.epub' -not -path './node_modules/*' | head`; if none, use any EPUB in the isolated library), and over CDP evaluate in the renderer, with the book open: `await viewRef...` is not exposed, so instead evaluate `document.querySelector('foliate-view')` then `await v.initTTS('sentence'); [v.tts.start(), v.tts.next(), v.tts.next()]`. Save at least: a normal paragraph block, a heading, a block containing `<em>`, a block containing a book-carried `<phoneme ph="…">` and `<sub alias="…">` if the book has one (otherwise record that none was available and cover those two by hand-edited copies of a captured block, labelled as such in a comment), and a block whose text is only whitespace or an image. Export them as `export const BLOCK_PARAGRAPH = '…'` etc. with a comment saying which book, which section and the date.
- [ ] **Step 2: Write failing tests** against those strings: marks become ordered units; the last unit has `blockEnd: true` and the others `false`; `<phoneme>` and `<sub>` reduce to their inner text; `<emphasis>` and `<lang>` are transparent; `<break/>` becomes a single space; XML entities (`&amp; &lt; &gt; &quot; &apos; &#x2019;`) decode; runs of whitespace collapse and edges trim; a unit whose text is empty after trimming is dropped, taking its mark with it (and `blockEnd` moves to the new last unit); text before the first mark is dropped; `null`, `''` and an image-only block give `[]`; the `<?xml …?>` prolog is ignored.
- [ ] **Step 3: Run** `npm test -- src/lib/speech-queue.test.ts` — expect FAIL (module missing).
- [ ] **Step 4: Implement** as a single-pass tokenizer over `/<[^>]+>|[^<]+/g`:

```ts
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}
export function flattenSsml(ssml: string | null | undefined): SpeechUnit[] {
  if (!ssml) return []
  const raw: { mark: string; text: string }[] = []
  let current: { mark: string; text: string } | null = null
  for (const token of ssml.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (token[0] !== '<') { if (current) current.text += decode(token); continue }
    if (token.startsWith('<?') || token.startsWith('<!')) continue
    const mark = /^<mark\b[^>]*\bname="([^"]*)"/.exec(token)
    if (mark) { current = { mark: decode(mark[1]), text: '' }; raw.push(current); continue }
    if (/^<break\b/.test(token) && current) current.text += ' '
    // every other tag is transparent: its text is the speech
  }
  const units = raw
    .map((u) => ({ mark: u.mark, text: u.text.replace(/\s+/g, ' ').trim() }))
    .filter((u) => u.text !== '')
  return units.map((u, i) => ({ ...u, blockEnd: i === units.length - 1 }))
}
```
- [ ] **Step 5: Run** the test file, typecheck, lint — expect PASS/clean. Commit `feat(reader): speech-queue flattens foliate SSML into sentences`. No `/verify` needed (a pure module not yet wired); the implementer says so in the report.

---

### Task 4: `speech-player`, gapless playback (renderer-engineer)

**Read first:** spec D5 (playback, pauses, background) and AC13, AC14, AC20; `src/types/tts.types.ts`; the preload `Musaeum.tts.synthesize` contract (`TtsAudio.samples` is mono signed 16-bit little-endian PCM as a `Uint8Array`; empty is silence).

**Files:**
- Create: `src/lib/speech-player.ts`
- Test: `src/lib/speech-player.test.ts`

**Interfaces:**
- Consumes: `SpeechUnit` (Task 3), `TtsRequest`, `TtsAudio`, `TtsVoice`.
- Produces:

```ts
export interface PlayerSource {
  /** Next unit, or null at the end of the book. May wait (a section is loading). */
  take(): Promise<SpeechUnit | null>
  /** Called when a unit starts sounding: the source may now release the next block. */
  started(unit: SpeechUnit): void
  /** Move the cursor so the next take() returns `unit` again. Only ever asked for a unit of the current block. */
  rewind(unit: SpeechUnit): void
}
export interface PlayerSpec { voice: TtsVoice; speed: number }
export interface PlayerDeps {
  context: AudioContextLike              // the minimal surface the player uses; a fake in tests
  synthesize(request: TtsRequest): Promise<TtsAudio>
  source: PlayerSource
  spec(): PlayerSpec                     // read per request, so a change lands on the next sentence
  onUnitStart(unit: SpeechUnit): void    // drives the highlight
  onEnd(): void                          // the book ended
  onError(message: string): void
  prefetch?: number                      // default 2
  pauseMs?: { sentence: number; block: number }   // default 350 / 700
}
export class SpeechPlayer {
  constructor(deps: PlayerDeps)
  start(): void
  pause(): Promise<void>      // context.suspend()
  resume(): Promise<void>     // context.resume()
  stop(): Promise<void>       // stop sources, drop the queue, context.close()
  /** Skip: discard everything unstarted and restart `delta` sentences from the one sounding (-1 / +1). */
  skip(delta: -1 | 1): void
  /** Discard everything unstarted and start again from `unit` (a page turn, a Read-from-here). */
  restartAt(unit: SpeechUnit | null): void
  /** Voice or speed changed: re-request every queued, unstarted unit. */
  specChanged(): void
}
export class SentenceCache { constructor(max = 50); wrap(synthesize): (r: TtsRequest) => Promise<TtsAudio> }
```
`AudioContextLike` is `{ currentTime: number; createBuffer; createBufferSource; destination; suspend(); resume(); close() }`, declared in the same file.

**Behavior to implement** (the design, so the tests below are decidable):
- A single-flight `fill()` loops `take()` and pushes `{ unit, audio: Promise<TtsAudio> }` while `queue.length < prefetch`. The synthesis promise is created at once and not awaited by `fill`, so up to `prefetch` requests are in flight.
- A single-flight `schedule()` awaits the head's audio, converts Int16 LE bytes to a mono `AudioBuffer` at the reply's `sampleRate`, and starts it at `max(context.currentTime, tailEnd + pause)` where `pause` is `pauseMs.block` if the *previous* unit had `blockEnd`, else `pauseMs.sentence`. Empty `samples` or `durationMs === 0` schedules nothing and adds no pause; the unit is skipped (Review Focus 3).
- Scheduling decisions are driven by promise resolution and the buffer's `ended` event, **never by `setTimeout`** in the audible path (spec D5 background). `onUnitStart` is fired by a 100 ms `setInterval` that compares `context.currentTime` with each scheduled item's start; because `currentTime` freezes while suspended, pause stops highlight advance for free. A hidden window throttling that interval only delays the highlight.
- `started(unit)` is called on each `onUnitStart` before `onUnitStart`'s callback, then `fill()` is re-run, which is what releases the next block's first unit (Facts 1).
- A rejection from `synthesize` calls `onError` once with the message, stops scheduling, and leaves the context usable for a retry (`start()` after an error restarts from the failed unit by `rewind`).
- `skip`/`restartAt`/`specChanged` stop every unstarted source, clear the queue, `rewind` the source to the right unit, and refill. `specChanged` rewinds to the first *unstarted* unit.
- `SentenceCache.wrap` keys on `${voice}|${speed}|${text}`, stores the promise (so a re-request during flight shares it), evicts oldest beyond `max`, and evicts a rejected promise.

- [ ] **Step 1: Write failing tests** with a fake clock and fake context (a `FakeContext` whose `currentTime` the test advances and whose sources record `start(when)`, and a `deferred()` helper for synthesis):
  1. *Gapless (AC13):* synthesis latency simulated at 500 ms, three 1.0 s sentences in one block, prefetch 2: the scheduled `start` times satisfy `start[n+1] - end[n] === 350 ms` exactly, never more.
  2. *Block pause:* a `blockEnd` unit is followed by 700 ms.
  3. *Prefetch bound:* after `start()`, no more than `prefetch` synth requests are outstanding beyond the one sounding.
  4. *Block gating (Facts 1):* with a source whose second block's `take()` is spied, the second block's first `take()` is not called until `started(lastUnitOfBlockOne)`.
  5. *Pause/resume (AC14):* `pause()` calls `suspend()`, `resume()` calls `resume()`, and the synthesize spy call count is unchanged across the pair.
  6. *Skip:* `skip(1)` discards queued units, rewinds the source, and the next scheduled unit is the one after the sounding one; `skip(-1)` the one before it.
  7. *Voice/speed (AC14, Review Focus 7):* after `specChanged()` with a new voice, the queued unstarted units are re-requested with the new voice and the sounding one is not.
  8. *Silence (Review Focus 3):* an empty-`samples` reply schedules nothing, adds no pause, and the next unit is scheduled at the same tail.
  9. *Error (Review Focus 4):* a rejected synthesis calls `onError` once and schedules nothing further; `start()` afterwards retries the failed unit.
  10. *End:* `take()` → `null` with nothing left calls `onEnd` after the last buffer ends, not before.
  11. *Stop:* `stop()` stops every started source and calls `close()`; a late synthesis resolution after `stop()` schedules nothing.
  12. *Cache:* a repeat of the same request calls `synthesize` once; a different voice calls it twice; 51 distinct requests evict the first; a rejected request is not cached.
  13. *PCM conversion:* Int16 LE bytes `[0x00,0x40, 0x00,0xC0]` become `[0.5, -0.5]` (±1 LSB).
- [ ] **Step 2: Run** `npm test -- src/lib/speech-player.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** to the behavior above. Keep the class under ~250 lines; split `pcmToFloat32` and `SentenceCache` out as plain functions in the same file.
- [ ] **Step 4: Run** the test file, `npm run typecheck && npm run lint` — expect PASS/clean. Commit `feat(reader): a gapless speech player on the audio clock`. (Pure module, not yet wired: no `/verify`; say so.)

---

### Task 5: The `speech` palette role (renderer-engineer)

**Read first:** `src/lib/theme/reader-palette.ts:36-110`, `src/lib/theme/reader-palette.test.ts` (find the `search` role's contrast decider and its AC5.x cases; `rg -n "search" src/lib/theme/reader-palette.test.ts src/lib/theme/palette-scan.test.ts`), spec D5 *The highlight and the page* and AC19.

**Files:**
- Modify: `src/lib/theme/reader-palette.ts`
- Test: `src/lib/theme/reader-palette.test.ts` (and `palette-scan.test.ts` if it enumerates roles)

**Interfaces:**
- Produces: `ReaderPalette.speech: string`, a resolved `#rrggbb` literal (the overlayer lives in foliate-view's closed shadow root, so it cannot be a CSS variable). Authored rows (`INK_PALETTE`, `PAPER_PALETTE`) and `readerPalette()` each set it. It derives from the same link color as `search`/`annotation` today (the spec's choice: one accent) **but is a field of its own** for the reason the `annotation` role documents.

- [ ] **Step 1: Write failing tests** mirroring the `search` cases: `INK_PALETTE.speech` and `PAPER_PALETTE.speech` are hex literals; `readerPalette(tokens).speech` equals `.link` for dark and light token sets; the fallback palette carries the field; **a contrast decider like `search`'s** — copy its method (it computes contrast of the role against `bg` for every built-in theme's derived palette and asserts a floor) and apply the same floor to `speech`, run over every built-in theme the existing test enumerates (AC19 "in every built-in theme").
- [ ] **Step 2: Run** `npm test -- src/lib/theme` — expect FAIL.
- [ ] **Step 3: Implement** the field with a doc comment in the style of `annotation`'s, saying why it is its own role and that the highlight is drawn as a fill with partial alpha (Task 6's `DRAWS.speech`), so contrast is decided on the fill color against `bg` by the same floor.
- [ ] **Step 4: Run** `npm test -- src/lib/theme && npm run typecheck && npm run lint`. If the decider finds a built-in theme failing the floor, **stop and hand back** (that is a design decision about a theme color, not a repair).
- [ ] **Step 5: Commit** `feat(theme): a speech role in the reader palette`. (Not wired yet: no `/verify`.)

---

### Task 6: The engine arm: `SpeechController` and the ReaderEngine seam (renderer-engineer)

**Read first:** `docs/invariants/reader.md` (all of it: the reader learns nothing about PDFs, position saving, the `relocate` ordering note at `ReaderEngine.tsx:317-340`), `docs/invariants/selection-and-keyboard.md` only for the key map, spec D5 and AC15–AC17, and *Facts found while planning* 1, 2, 3, 5 above.

**Files:**
- Modify: `src/types/foliate-js.d.ts` (add `View.tts`, `initTTS`, the TTS class surface, `renderer.scrollToAnchor`, `renderer.nextSection/prevSection`, the `relocate` detail's `range`; closes type gaps, never edits `vendor/`)
- Create: `src/lib/speech-controller.ts`
- Test: `src/lib/speech-controller.test.ts`
- Modify: `src/components/reader/ReaderEngine.tsx` (add `DRAWS.speech` / the annotation kind, surface the relocate range and the chip's selection range)
- Modify: `src/lib/annotations.ts` only if its `AnnotationDrawKind` union must grow (it is the `isAnnotationDrawKind` source); keep the speech kind out of the persisted annotation list, since speech highlights are never saved.

**Interfaces:**
- Consumes: `flattenSsml`, `PlayerSource` (Tasks 3–4), `ReaderPalette.speech` (Task 5).
- Produces:

```ts
export interface SpeechControllerDeps {
  view: FoliateView
  speechColor(): string                      // the resolved palette literal, read fresh
  onError(message: string): void
}
export class SpeechController implements PlayerSource {
  constructor(deps: SpeechControllerDeps)
  /** Begin at the first sentence of the page now shown, or at `range`. Resolves false when there is nothing to say. */
  begin(from?: Range): Promise<boolean>
  take(): Promise<SpeechUnit | null>
  started(unit: SpeechUnit): void           // calls tts.setMark(unit.mark) → draws and scrolls
  rewind(unit: SpeechUnit): void
  /** Feed every relocate here. If the sentence being spoken is outside `pageRange`, the user moved: returns the page's first unit (restart there), else null. */
  onRelocate(pageRange: Range | null): Promise<SpeechUnit | null>
  dispose(): void                            // clears the speech highlight
}
```

**Behavior:**
- `begin` calls `view.initTTS('sentence', highlight)` where `highlight(range)` calls `renderer.scrollToAnchor(range, true)` **and** replaces the single speech annotation: `deleteAnnotation` the previous (value `speech:${n}`-style key is not a CFI, so the controller instead stores the previous annotation object and deletes it) then `addAnnotation({ value: view.getCFI(index, range), kind: 'speech', color: speechColor() })`. Reuse the engine's `draw-annotation` arm (Fact 3); never a second overlayer. Highlight failures (`addAnnotation` throws on an unresolvable value, documented in the d.ts) are swallowed with the page still scrolled: a missing highlight must not stop the voice.
- Blocks: the controller keeps `blockUnits: SpeechUnit[]` and `idx`. `take()` returns `blockUnits[idx++]`; at the end of the block it **waits for `started(lastUnit)` of the current block** (Fact 1), then `tts.next()` → `flattenSsml` → loop while the result is `[]` (Review Focus 2); when `tts.next()` yields nothing, advance a section (`renderer.nextSection()`; if it resolves to nothing, return `null`), wait for the engine's `load` (a one-shot listener on the `view`, with a timeout of 10 s that surfaces `onError('Could not continue to the next chapter.')`), re-run `initTTS` (Fact 2), and `tts.start()`.
- `rewind(unit)`: set `idx` to the unit's index within `blockUnits` (guaranteed present by the gating; a unit not found is a programming error that raises).
- `onRelocate`: if no unit is sounding, return null. If the sounding unit's range (kept from the highlight call) starts inside `pageRange` (`compareBoundaryPoints` both ways), return null. Otherwise (AC17): `tts.from(pageRange)`, flatten, drop leading empties, reset `blockUnits`/`idx`, and return the first unit.
- `dispose()` deletes the speech annotation and drops references. No timers.

- [ ] **Step 1: Close the type gaps** in `src/types/foliate-js.d.ts`; run `npm run typecheck`.
- [ ] **Step 2: Write failing tests** with a **fake foliate `tts`** that reproduces the hazard: it holds blocks, reassigns an internal `ranges` map on every `start/next/prev/from`, and its `setMark(name)` highlights only if the name exists in the *current* block's map, otherwise does nothing. Cases: (a) in-block `take()` sequence, the second block's first unit is not taken until `started(last)`; (b) **`setMark` for the last unit of block 1 succeeds even though block 2 is next**, i.e. the controller never advanced the engine early (this test fails against a naive prefetch-across-blocks controller, which is the point); (c) an empty block is skipped; (d) end of section → `nextSection` → `load` → `initTTS` again → `start`; (e) end of book → `null`; (f) `rewind` replays a unit; (g) `onRelocate` with a page that contains the sounding sentence returns null, a page that does not returns the first unit of that page (AC17) and subsequent `take()`s continue from there; (h) `dispose` deletes the highlight annotation; (i) `addAnnotation` throwing does not reject `started`.
- [ ] **Step 3: Run** `npm test -- src/lib/speech-controller.test.ts` — expect FAIL.
- [ ] **Step 4: Implement** the controller and the `ReaderEngine` seam: `DRAWS.speech` (a fill, `Overlayer.highlight`, with the color from the annotation as the existing kinds do), the engine passes `relocate`'s `range` out through `onRelocate`'s detail as `range: Range | null`, and a `viewRef`-adjacent `onReadFromHere(range: Range)` callback fired by the chip. Do not add any branch on format.
- [ ] **Step 5: Run** `npm test`, `npm run typecheck`, `npm run lint` — expect PASS/clean, and every existing reader test unchanged (reading-state cases re-run unchanged, AC16).
- [ ] **Step 6: Verify** the seam in the running app by hand: isolated instance, open an EPUB, evaluate `document.querySelector('foliate-view')`'s `initTTS('sentence')` then `tts.start()` and confirm the engine still reports `relocate` normally; capture the log.
- [ ] **Step 7: Commit** `feat(reader): the speech arm over foliate's own marked sentences`.

---

### Task 7: The surface: `useSpeech`, `ListenBar`, the header button, the chip (renderer-engineer)

**Read first:** `docs/invariants/reader.md` (draggable band note, `app-no-drag`), spec D4 (download surface), D6, AC18; `ReaderView.tsx:210-330` and `:395-430` (key handler, header), `SelectionChip.tsx`, `src/components/shared/icons.tsx`, `ReaderPrefsPopover.tsx` for the popover idiom (voice and speed controls live in the bar, not Settings, per D6/D4).

**Files:**
- Create: `src/hooks/useSpeech.ts`, `src/hooks/useSpeech.test.ts`
- Create: `src/components/reader/ListenBar.tsx`
- Modify: `src/components/shared/icons.tsx` (`ListenIcon`, plus the few transport glyphs the bar needs; hand-rolled SVG)
- Modify: `src/components/reader/ReaderView.tsx` (header Listen button next to Highlights and notes; the bar as the bottom row of the reader column; the `L` key; stop speech on close/book change)
- Modify: `src/components/reader/SelectionChip.tsx` (a second button, **Read from here**; keeps `onMouseDown` preventDefault and `app-no-drag`)
- Modify: `src/components/reader/drag-regions.test.ts` (extend its scan to the new header button and the chip's second button)

**Interfaces:**
- Produces from `useSpeech`:

```ts
export type SpeechPhase =
  | { kind: 'idle' }                                         // bar open, nothing playing
  | { kind: 'needs-model'; totalBytes: number }              // "Download the voice (120 MB)"
  | { kind: 'downloading'; completed: number; total: number }
  | { kind: 'loading' }                                      // model warming; first sentence pending
  | { kind: 'playing' } | { kind: 'paused' }
  | { kind: 'error'; message: string; canRetry: boolean }
  | { kind: 'offline-no-model' }                             // one honest sentence, not a toast
export interface SpeechApi {
  phase: SpeechPhase
  play(from?: Range): Promise<void>; pause(): void; resume(): void
  skip(delta: -1 | 1): void
  download(): Promise<void>; cancelDownload(): void; retry(): void
  close(): void
}
export function useSpeech(args: { viewRef: MutableRefObject<FoliateView | null>; ... }): SpeechApi
```
(The implementer settles the exact args from Task 6's controller; the phases above are fixed.)

**Behavior:**
- On first **play** with no model: `window.Musaeum.tts.status()`; `ready` false → `needs-model`. Pressing the bar's download button calls `downloadModel()` and subscribes to `on.ttsModelProgress` (unsubscribed on unmount) for the `downloading` phase; `cancelDownload()` returns to `needs-model`. A resolved `{ status: 'failed' }` or a rejection → `error` with `canRetry`, and Retry is disabled for 2 s (Review Focus 8). Offline with no model (the failure text or `navigator.onLine === false`) → `offline-no-model`, one sentence.
- A synthesis rejection containing "damaged" (voice-reader.md) → `needs-model` plus a one-line "The voice file is damaged; download it again.", not a retry loop (Review Focus 5). Any other rejection → `error`, `canRetry: true`; Retry calls the player's `start()`.
- `play` builds a `SpeechController` + `SpeechPlayer` (with an `AudioContext`, `SentenceCache(50).wrap(window.Musaeum.tts.synthesize)`), `begin(from)`, `player.start()`. `onRelocate` events from the engine are forwarded to `controller.onRelocate(range)`; a returned unit → `player.restartAt(unit)` (AC17).
- Voice/speed: read from the store's prefs per request (`spec()`); a store change calls `player.specChanged()`.
- Unmount, `closeListen`, closing the reader, or a book change → `player.stop()` and `controller.dispose()` (Review Focus 6).
- `ListenBar`: previous sentence, play/pause, next sentence, a speed stepper (0.8–1.5 by 0.1), a voice select over `TTS_VOICES`, close; the download/progress/cancel/error/offline states as one slim line each. It is a flex row at the bottom of the reader column, **not** a fifth occupant of the side slot (D6): an open ToC/search/notes/ask panel stays open beside it (AC18).
- `L` toggles the bar (opens it; pressing play still starts speech), unmodified and not in a typing target; Space/arrows keep page-turn meaning.
- Chip: **Read from here** calls `onReadFromHere(range)` → `listenOpen = true` and `play(range)`; the chip goes away as it does after Highlight.

- [ ] **Step 1: Write failing tests** in `useSpeech.test.ts` for the pure state transitions by extracting the reducer (`speechReducer(state, event)`) from the hook, since there is no DOM environment: `needs-model` → `downloading` on progress → back to `needs-model` on cancel; failed download → `error` with `canRetry`; "damaged" → `needs-model` with its line; offline text → `offline-no-model`; play/pause/resume transitions; `error` retry. Add source-scan cases (the repo's idiom) pinning that: the header Listen button has `app-no-drag`, `aria-pressed` and a title; `ReaderView` stops speech when `bookId` changes and on unmount; the bar is rendered outside the side-slot conditional chain; the key handler's `L` case checks `isTypingTarget` and modifier keys; `ListenBar` imports no icon library; the chip's second button has `app-no-drag` and `onMouseDown` preventDefault.
- [ ] **Step 2: Run** `npm test -- src/hooks/useSpeech.test.ts src/components/reader` — expect FAIL.
- [ ] **Step 3: Implement** the reducer/hook, `ListenBar`, icons, `ReaderView` and `SelectionChip` changes.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run lint` — PASS/clean.
- [ ] **Step 5: Verify** with the `/verify` recipe by hand and **quote the evidence**: isolated instance with a model directory preseeded by copying `$HOME/Downloads/musaeum-tts-bakeoff/models` into the isolated profile's `tts-models/` (copy, never move or delete the source); open an EPUB; press the header button (CDP click) and assert the bar exists, press play and assert audio is scheduled (`AudioContext.currentTime` advances, the highlight annotation exists), assert no `Content-Security-Policy` violation in the console (AC18), open the ToC and confirm the bar stays. Screenshot the bar in the default theme for the report.
- [ ] **Step 6: Commit** `feat(reader): the Listen button, the transport bar and Read from here`.

*(If this task's honest file count exceeds ten, split it at `useSpeech` | components and report; do not squeeze.)*

---

### Task 8: The live pass, acceptance, and the record (controller-led; renderer-engineer assists)

**Read first:** spec AC15–AC21 and *Risks* 2–3; `.claude/skills/verify/` (the isolated-instance recipe).

**Files:**
- Modify: `docs/invariants/voice-reader.md` (describe the reader half; remove "slices 2 and 3 are not described here until they exist" for slice 2)
- Modify: `docs/superpowers/specs/2026-10-15-voice-reader-design.md` (status line, *Not verified* items now measured, any amendment the pass forces)
- Modify: `docs/superpowers/plans/2026-10-15-voice-reader-ui.md` (an *Annex* with measurements, test counts, deviations)
- Modify: `tasks.md` (the voice reader entry), `CHANGELOG.md`

This task changes no source unless a live check fails; a failure is handled by the stop rules, not patched silently.

- [ ] **Step 1: The first real model download (new, folded in).** Launch an isolated instance with an **empty** `tts-models/` and no `MUSAEUM_TTS_MODELS`. Press Listen → play. Record: the bar shows "Download the voice (120 MB)"; progress moves (sample the `ttsModelProgress` events: first, a middle one, last); wall-clock time and effective MB/s from GitHub; final `status()` is `ready`; both files' sizes and sha256 match the pins in spec D4 (`shasum -a 256` on `tts-models/`); then cancel mid-download on a second empty profile and confirm `cancelled`, no stray non-`.part` file, and a clean re-download afterwards. Record any redirect, rate-limit or hash surprise: this is the first time the real URL is exercised, so an unexpected status is a finding, not noise.
- [ ] **Step 2: AC15 in the running app** on a real EPUB, a real MOBI (or AZW3) and a reflowed PDF: sentence highlight follows the voice; the page follows the highlight across a **page boundary** and a **section boundary**; screenshot each.
- [ ] **Step 3: AC16.** Listen across a page boundary, wait out the 2 s debounce, close the reader, reopen the book: it reopens at the position listening reached (check `reading_state` in the isolated SQLite with the `sqlite3` CLI).
- [ ] **Step 4: AC17.** While speaking: a page turn (ArrowRight), a TOC jump, a search jump each restart at the new page's first sentence.
- [ ] **Step 5: AC18.** Bar open beside each of ToC, search, notes, ask without closing them; zero CSP violations in the console for the whole listen.
- [ ] **Step 6: AC21, cold and warm first-sentence timing.** Cold: `kill` the sidecar's model by waiting past the idle release is impractical, so restart the isolated instance, press play, and measure press → first `AudioBufferSourceNode.start` (instrument via CDP by wrapping `AudioBufferSourceNode.prototype.start` before the press). Warm: pause, `restartAt` the first sentence again (or press play on a second book) within the idle window and measure again. Three runs each; record median and worst. Targets: cold ≤ 2 s, warm ≤ 1 s (the engine measured 0.42 s / 0.11 s for synthesis alone).
- [ ] **Step 7: AC20, a minimized window for ten minutes (new, folded in).** Start listening to a long chapter; minimize the window (and, in a second run, hide the app with ⌘H); for ten minutes sample every 5 s from a script outside the page (via CDP on the debugging port, `Runtime.evaluate` of `audioContext.currentTime` and a counter incremented in the player's `onUnitStart`): `currentTime` must advance in real time and the unit counter must keep rising; a stall longer than the 700 ms block pause or a counter that stops is a **fail**. Record the maximum inter-sample gap. If it fails, **stop**: the spec says the background premise is then wrong and the document is amended before anything ships. Do not paper over it with a larger prefetch without reporting it.
- [ ] **Step 8: Risk 3, speech beside a bulk refresh.** While speaking, start a bulk metadata refresh on the isolated library; record whether any gap beyond the configured pause appears and the synthesis latency under load (`duration` of the `tts:synthesize` calls). This is a measurement for the record, not a gate, as the spec says.
- [ ] **Step 9: Control lane live.** With a `reflow_pdf` running on a PDF-only book, press play on another book with no model: `status()` returns promptly (it used to be able to wait up to 120 s). Record the latency.
- [ ] **Step 10: Write the record**: the invariants file's reader section (what the bar owns; the cursor hazard and why prefetch stops at a block; containment-based manual-navigation detection; the L key), spec status line and *Not verified* items updated with measured results, the plan annex, `tasks.md` (slice 2 done, slice 3 next, the four "Settle before slice 2" items resolved or re-stated honestly), `CHANGELOG.md`. Prose not hard-wrapped.
- [ ] **Step 11: Final suites.** `npm run typecheck && npm run lint && npm test` and `sidecar/.venv/bin/python -m pytest sidecar/tests -q` with and without `MUSAEUM_TTS_MODELS=$HOME/Downloads/musaeum-tts-bakeoff/models`. Report against the baseline: pytest 539 passed + 24 skipped without models and 563 with (expect +3 from Task 1); `npm test` 2248 in 102 files (expect growth from the new test files). Confirm `git status` shows no `.tasks.md.swp` staged, no `vendor/` diff (`git diff main --stat -- vendor` empty), and that `$HOME/Downloads/musaeum-tts-bakeoff/models` still exists.
- [ ] **Step 12: Whole-branch review** by the `reviewer` agent against the invariants list, then commit the record: `docs(voice-reader): slice 2 live pass and record`.

---

## Per-task gate (subagent-driven execution)

For each task: dispatch the named repo agent (`sidecar-engineer` Task 1; `renderer-engineer` Tasks 2–7; `test-author` only if a task's tests need a second pair of hands), hand it the task text *and* the docs named under **Read first**, then dispatch `reviewer` on the resulting diff against the CLAUDE.md invariants and this plan's Review Focus. A reviewer finding is fixed by the implementer and re-reviewed; two failed repair attempts on the same test is an escalation. The controller (not a subagent) runs Task 8's live checks, because they need judgment about what a measurement means.

## Self-review against the spec

- **D4 download surface:** Task 7 (states, progress, cancel, offline sentence, damaged route), Task 8 Step 1 (the real fetch).
- **D5 playback:** Tasks 3, 4, 6 (queue, prefetch, clock, pauses, section boundary, manual navigation, position, PDF-neutral); background → Task 8 Step 7.
- **D6 controls:** Task 7 (Listen button, bar not a panel, Read from here, the L key chosen against the reader's real key map).
- **D7 prefs:** Task 2.
- **D9 seams:** the 50-sentence in-memory cache in Task 4; no disk cache; `VoiceSpec` is already in `src/types`.
- **AC12:** Task 3 with a captured real fixture. **AC13/14:** Task 4. **AC15–17:** Tasks 6 and 8. **AC18:** Tasks 7 and 8. **AC19:** Task 5. **AC20, AC21:** Task 8.
- **Amended, not violated:** D3 *The lane* and AC7 (Task 1). The owner chose this; it is recorded where the next reader will look.
- **Deferred engine minors** are not fixed here (normalizer edge cases, `services/tts.ts` error-path consistency, RPC param validation). The one that slice 2 touches, the retry-versus-old-`.part` race, is handled by the 2 s Retry delay and measured in Task 8; the 30-minute app-side timeout leaving a Python job running is unchanged and stays in the annex's list.
- **Slice 3** (lexicon file, popover, Preview) is untouched; `services/tts.ts`'s `NO_LEXICON` stays.

---

## Annex — what the build found

Built 2026-10-15 on `feat/voice-reader-ui` (commits `c9c1c1e` to `0ca3f5d`, 18 of them) by subagent-driven execution with a review after every task; the live pass (Task 8) found two failures that became Task 9. The rules this slice taught are in `docs/invariants/voice-reader.md`; the spec's acceptance outcomes are marked on AC12 to AC21 in the design.

**Test counts.** Baseline (end of the engine): `npm test` 2248 passed in 102 files. Along the way: Task 6, 2349 in 106 files; Task 7a, 2410 in 108; Task 7b, 2425 in 109; Task 9, 2437 passed in 109 files. Task 1 added three pytest cases (543 passed and 24 skipped without the models, 566 passed with them, at that task). Typecheck and lint clean at every task.

FINAL COUNTS: TBD by controller

**Deviations from the plan, each with its reason.**

- (a) `scrollToAnchor(range, false)`, not `(range, true)` as Fact 3 said: `true` selects each sentence, raising the Highlight chip and feeding the ask panel on every sentence. It also scrolls only when the sentence is off the page, because scrolling every sentence wiped a selection the user held and restarted the save debounce.
- (b) The Escape ladder gained a rung (results, panels, the listen bar, the book). Spec D6 was silent; a listener must be able to quiet the voice without losing their page.
- (c) Prefetch is gated per block by the player (`take()` is not called until `started(last)`), which the plan left to the controller; foliate's `next()` rebuilds its range map.
- (d) `PlayerSource` gained an optional `abort()` and `ended(unit)`, which the plan's interface did not have. `ended` is Task 9's: a section is not advanced until the old section's last sentence has ended.
- (e) `isSaved(cfi)` became a required controller dependency, and `show-annotation` in `ReaderEngine` returns early for a speech fill, so a speech fill never replaces a saved highlight or opens Notes.
- (f) The controller reads each unit's range through `tts.setMark` with a capturing probe (`onPage`) so a restart can drop sentences that start before the page; `tts.from()` returns the whole block when the page opens inside its last sentence.
- (g) The end of the book is decided from `book.sections` (`linear !== 'no'`), not from `nextSection()` resolving to nothing, because it resolves `undefined` both when it moves and at the last section.
- (h) Task 5: no search-contrast decider existed to copy, so a `src/` decider over ink, paper and the default plus the two tightest literals was accepted, and an `electron/main` sweep in `derive.test.ts` was added so AC19's "every built-in theme" is a standing test (13 themes, minimum ratio 3.032).
- (i) The reducer lives in `src/lib/speech-state.ts`, not in the hook, so its test imports no React or vendor code; `isSavedValue` was added to `src/lib/annotations.ts` over the plan's own offer predicate.

**Rulings taken during the build, each with its cost.**

- Task 2: a same-book reopen resets `listenOpen` like `tocOpen` and `prefsOpen`, for consistency with its siblings. Cost: double-clicking the open book closes the bar mid-playback.
- Task 5: see (h). Cost: none standing now that the sweep exists.
- Task 6: `scrollToAnchor(range, false)`; see (a). Cost: a spec and plan deviation, recorded here.
- Task 6: the 150 ms `nextSection` retry kept running after `abort()` until the 10 s deadline, so a page turn during a chapter crossing could be followed by one extra section step. Deferred at the time and fixed in Task 7a (the retry stops once the move is superseded).
- Task 7a: the commit trailer is `Claude Sonnet 5.5` on every commit regardless of the harness's own attribution line (the owner's mandate); `ec75657` was reworded to `7733115` for it.
- Task 7a: download state is hook-local, so closing the reader mid-download and reopening shows "Download the voice" until it is pressed; the press rejoins the same job. Cost: a stale bar until pressed, and the store-as-truth convention is bent for this one slice. The reversal is to move the phase into the store.
- Task 7b: the one CSP console error seen while building was the fixture book's own `kindle:embed` image blocked by `img-src` at book load, before any listening; AC18 is judged on violations during a listen. The Task 8 corpus never produced it.
- Task 7b: Escape gets a rung; see (b). Cost: Escape no longer closes the book in one press while the bar is open.

**Deferred minor findings.**

- Task 1: `models.py` has a comment before the docstring (predates this slice). The two wording fixes the review asked of `docs/invariants/voice-reader.md` (the 30-minute timeout stated twice; "is what makes that safe") are made in the Task 8 doc pass.
- Task 2: the persist test does not set a non-default voice and speed first; the `closeListen` cleanup is not in a `finally`.
- Task 3: tokenizing is quadratic on malformed SSML only (bare `<` runs: 50,000 characters take about 2.7 s); engine SSML is well-formed and realistic blocks take 0.3 ms. Lone-surrogate numeric entities pass the guard.
- Task 4: a deferred rewind that fails later in `fill()` calls `fail()` after the audio was cut; the player class is about 375 lines against the planned 250; a refused rewind in the replay branch is untested.
- Task 5: the sweep pins `stems.length > 0` rather than the built-in theme count; `derive.test.ts` has prettier drift that predates this slice.
- Task 6: the own-section-change check has a one-sentence window (a hand turn inside the new section while the old last sentence still sounds is read as our own move); the d.ts has no `sections` on some books, in which case a later section is assumed to exist. A user highlight with exactly the spoken sentence's CFI is skipped by `isSaved`, so that one sentence gets no fill.
- Task 7a: the `useSpeech` tests are source-regex scans, weak against behaviour; the damaged-model notice kept visible during `loading` may mask a later error; an image-only start that crosses a section, followed by a page turn before the first sentence, is still ignored. `isSaved` also counts a highlight the engine refused to draw.
- Task 7b: Escape inside the voice `<select>` does nothing (`isTypingTarget`); the bar's gating (needs-model, downloading, error) is pinned by source scan only, and its needs-model path was first exercised live in Task 8; the `noFocus` comment overstates, since only the Listen button applies it.
- Engine minors from the engine annex remain as listed there.

**The live pass (Task 8, 2026-10-15, `d46c7da`, no source changes; isolated profiles; Task 9 re-measured the two failures at `0ca3f5d`).**

| Step | Result |
| --- | --- |
| 1 First real download | Pass. 120,575,669 B in 3.70 s (32.6 MB/s), 98 progress events, hashes and sizes match, one 302 redirect, cancel at 41.1 MB leaves the directory empty, re-download 4.73 s |
| 2 AC15 | Page boundary pass (highlight 37 to 57 ms after the buffer, median; max 101 ms; 330 sentences; 3 formats). Section boundary **failed**, fixed in Task 9: 6 of 6 crossings, page moves +20..51 ms after the end, next audible +698..702 ms, section load 24 to 55 ms |
| 3 AC16 | Pass for the save. Reopen one page early is pre-existing (control with no speech: 7 to 6, 8 to 7) |
| 4 AC17 | TOC and search jumps pass. ArrowRight near figures **failed** (13 of 24), fixed in Task 9: 10 of 10 on the stuck page, 23 of 23 mixed |
| 5 AC18 | Pass. 0 CSP violations during a listen (positive control caught); `AudioContext` running at the first `start()` |
| 6 AC21 | Warm pass (median 0.66 s). **Cold fails on its worst run**: 1,796, 1,529, 3,192 ms; median 1.80 s |
| 7 AC20 | Pass. Minimized 600 s: ratio 0.999 to 1.001, max sample gap 5.006 s, max silence 0.700 s, none over 0.75 s. Hidden 180 s: the same |
| 8 Risk 3 | Measured, not a gate. During a bulk rehydrate: synthesis median 621 ms (p90 1,405) against 260 ms idle. Light load; the job was network-bound |
| 9 Control lane | Pass. `tts.status()` during a 63.5 s reflow: median 0.5 ms, max 9.7 ms |
| a to d | Pass. Escape closes the bar then the book; a click on the spoken sentence leaves Notes closed; a held selection and its chip survive sentence changes; an image-only cover starts at the first text |

Task 9 also ruled out the "two `addAnnotation` calls per sentence" Task 8 reported: foliate's `deleteAnnotation(a)` is `addAnnotation(a, true)` and the harness's wrapper counted each removal as an add. Live, split on the `remove` argument: 4 buffers, 4 draws, 4 removes.

**Open items.**

- **AC21 cold fails on its worst run** (median 1.80 s passes; worst 3.19 s, on a long first sentence, against 2 s). Options: pre-warm the model, or split a long first sentence. The owner's call.
- **The first sentence of a new section is synthesized inside the 700 ms pause**, with 440 to 540 ms spare on short headings. A long first sentence with a cold cache (idle p90 1.4 s) can overrun and lengthen the pause. A warm-up from `book.sections[i+1].createDocument()` would remove it; not built.
- **Read from here inside a block's last sentence starts at the block's first sentence** (`from()`'s whole-block fallback). The right answer is the sentence containing the selection.
- **The reader reopens a book one page early even without speech.** Pre-existing, observed in the live pass; the bar shrinking the column makes it one page more with speech.
- **A single unit can be 87.6 s** (Darwin section 14, inside the 4,000-character cap); previous, next and the highlight are coarse there.
- **`paginator.js:1113` TypeError** (`#view` is null in the `setStyles` rAF) fired twice on reader close and reopen. It is in `vendor/`, which is never edited, and is unrelated to speech.
- **The `OceanofPDF.com` watermark is read aloud at every chapter end of the AZW3 fixture.** That is the book's content, not the app's. The reflowed PDF also reads footnotes inline.
- **Heavy CPU contention is unmeasured** (risk 3 ran under a light load).
- Slice 3 (the lexicon file, popover and Preview) is untouched, and `services/tts.ts`'s `NO_LEXICON` stays.
