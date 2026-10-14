# Design: Ask about what you're reading, on the phone (the relay route, v1)

**Date:** 2026-10-13
**Status:** Proposed — the three forks were settled with Jason on 2026-10-13 (relay through the Mac; the Mac owns prompt assembly and recall scoring; the phone sends the section text). **Approved 2026-10-13; D2 resolved to the recommended `shared/ask/` with an `@ask/*` alias.** Nothing is built. Plans: `docs/superpowers/plans/2026-10-13-phone-ask-mac.md` (slices 1–2) and `docs/superpowers/plans/2026-10-13-phone-ask-ios.md` (slices 3–4, in `musaeum-ios`).
**Scope:** The reader AI panel's behavior on the phone: ask about the book, the section, or a highlighted passage, with the same payload ladder, the same local recall check and the same disclosure line as the Mac. One new streaming route on the REST API, a small move of the Mac's pure prompt modules so the route can use them, and the panel on the phone. It does **not** cover a phone-direct endpoint (see D1 — designed *for*, not built), persisted transcripts, L2 (adjacent sections), or any change to what the Mac panel does.
**Depends on:** `docs/superpowers/specs/2026-09-19-reader-ai-panel-design.md` (every decision there that this document does not name still holds, and is not restated), `docs/rest-api.md`, `docs/superpowers/specs/2026-09-22-ios-companion-design.md`, and `../musaeum-ios/docs/specs/2026-09-22-client-v1-design.md`.
**Interacts with:** `electron/main/services/ai.ts` (gains one option, D5), `electron/main/api/rest.ts` (gains one route and its own body cap, D3), `src/lib/ask-context.ts` and `src/lib/recall.ts` (move, D2), and the contract's three artifacts — `docs/rest-api.md`, the goldens in `electron/main/services/api/shape.test.ts`, `scripts/api-smoke.sh` — which move in one slice (D7).
**Supersedes:** nothing. It amends one sentence of the AI-panel spec's D2 by extension rather than correction: *"the renderer owns prompt semantics"* stays true of the desktop panel, and the phone is a second caller of the same functions.

---

## Why now

The Mac panel is complete and its hard parts are pure functions. The phone has the reader, the Keychain-held token, and a wire that already reaches the Mac over the tailnet. What it lacks is any path to a model: on a phone `localhost` is the phone, so the Mac's loopback default means nothing there. Relaying through the Mac keeps the one configuration, keeps the key off the phone, and lets an Ollama running on the Mac be the model — which is the posture the Mac feature was built around.

---

## What I read, and what it means for the design

| Fact | Where | Consequence |
| --- | --- | --- |
| `AskContext` already is the request: `mode`, `question`, `sectionText`, `sectionOffset`, `selection`, `rung`, plus the pointer | `src/lib/ask-context.ts:72-104` | The wire body is `AskContext` less title/author (the Mac looks those up by `bookId`) |
| Every ask is single-turn: `buildAskMessages` takes one `question`; the transcript is display state | `ask-context.ts:386`, `ask-session.ts` | No history travels. The phone keeps its transcript in memory (AI-panel D8) |
| `describeEgress()` reads the assembled `AskPayload`, so the line cannot claim less than was sent | `ask-context.ts:487` | A pre-send disclosure on the phone needs the Mac to assemble — hence the `preview` mode (D4) |
| The probe's reply is never shown; it is parsed and scored | AI-panel D6 | The relay consumes the probe stream itself and returns only a verdict (D4) |
| `ai.ask()` always broadcasts to the desktop renderer, and the service keys in-flight requests by id only | `services/ai.ts:461-495` | Needs a sink option, or a phone ask would paint into the Mac's open reader (D5) |
| `@shared/*` resolves to `src/types/*` — types only; `@/*` is the renderer | `docs/architecture.md:224` | Main cannot import `src/lib/*` by alias; the modules need a home both can import (D2) |
| The REST server is plain `node:http`; its only JSON body cap is `MAX_BODY_BYTES = 4096`, sized for the reading report | `api/rest.ts:540` | The ask route needs its own, larger cap; the 4 KiB cap stays as it is (D3) |
| Readium 3.11 exposes `publication.content(from:)` and a `ContentIterator` | `swift-toolkit` `Sources/Shared/Publication/Services/Content/` | The phone can extract a section's text without the engine's help (D6) |
| iOS: only the fraction travels as position; a Readium `Locator` stays local; the server is never a dependency | `musaeum-ios/AGENTS.md` invariants 3, 5 | Section text and a character offset travel; no locator does. Ask degrades to "unavailable, with a reason" |

---

## The design in one paragraph

The phone sends one `POST /api/ai/ask` with a book id, a mode (`preview`, `probe` or `ask`), the reader's pointer, their selection and question, the rung, and the section's text with the reader's offset in it. The Mac looks up title and author, runs the **same** `buildAskMessages` / `describeEgress` / `parseProbe` / `scoreRecall` the desktop panel runs, calls its configured endpoint through `services/ai.ts`, and answers `text/event-stream`: a `disclosure` first, then `delta`s for an ask or a `verdict` for a probe, then `done`. The phone holds the session — the verdict, the rung, the transcript — and the Mac holds nothing between requests. Whether Ask is available, and whether the Mac's endpoint is local, rides on `GET /api/health`.

---

## D1 — The phone talks to a backend interface; the relay is the first implementation

**Decision:** the phone's UI consumes an `AskEvent` stream from an `AskBackend` protocol. `RelayBackend` (the route below) is the only implementation in v1. The event vocabulary is the contract's, not the UI's.

**Why:** Jason chose the relay "for now" and asked that the design not foreclose the alternatives. The seam that keeps them open is exactly one: nothing above `AskBackend` knows whether tokens came from the Mac. A `DirectBackend` — the phone calling an OpenAI-compatible endpoint itself — would have to assemble prompts on the phone, which means a Swift port of the pure modules against the same golden fixtures; that is real work, and it is **not** done here. What *is* done here is that the wire carries the *semantic* request and no provider concept, so the Mac can change its backend (another provider, a second endpoint, a different wire) without the contract moving, and a `DirectBackend` can be added without the UI moving.

**What this does not buy:** it does not make the phone usable with the Mac asleep. That is a different feature (D1's revival condition: Ask wanted away from the tailnet or with the Mac off, in practice).

---

## D2 — The prompt modules move to where main can import them

**Decision:** `src/lib/ask-context.ts` and `src/lib/recall.ts` (and their tests) move to a location both the renderer and the main process import by alias. The desktop panel's behavior is unchanged, and the move lands before the route (slice 1).

**The alias problem, stated plainly:** `@shared` is the contracts directory, and these are logic. The two modules import only types (`@shared/ai.types`), touch no DOM and no store, so they are movable without edits to their bodies. **Recommended:** a new top-level `shared/ask/` with an `@ask/*` alias added to `electron.vite.config.ts`, both tsconfigs, `vitest.config.ts` and the alias line in `docs/architecture.md`. **Alternative:** main imports `../../../../src/lib/ask-context` by relative path — one line, no config, and it quietly erases the "renderer ⇄ main" boundary the alias table exists to state. **Resolved 2026-10-13: `shared/ask/` with `@ask/*`** — it is an architecture-doc change, so it was stated here rather than decided in a diff.

**Why not move the logic into main and give the desktop panel IPC for it:** the composer assembles a disclosure preview on every keystroke-worth of state change (AI-panel slice 3, reading 1). Putting that behind IPC adds a round trip to a path that is currently a function call, to serve a caller that does not exist yet.

---

## D3 — `POST /api/ai/ask`: one stateless streaming route

**Request** (JSON, `content-type: application/json`):

```jsonc
{
  "bookId": "…",
  "mode": "preview" | "probe" | "ask",
  "rung": "pointer" | "passage",      // the phone's effective rung; ignored for probe/preview-of-probe
  "section": {
    "label": "Chapter 4" | null,       // the book's own TOC label, never a number
    "text": "…" | null,                // the section's text from its start; see the cap below
    "offset": 8302 | null,             // where the reader is within `text`, in characters
    "truncated": false                 // `text` was cut at the cap
  },
  "fraction": 0.05 | null,
  "selection": "…" | null,
  "question": "…" | null               // required for ask and for preview-of-ask
}
```

- `preview` assembles exactly what an `ask` (or, when `question` is absent, a `probe`) would send and returns the `disclosure` event and `done` — **no call to the model**. It is how the phone shows the line *before* the first send without restating the assembler.
- The Mac reads title and author from its own row. **Nothing else about the book is read**, so the AI-panel's "never sent" list (D5) holds unchanged: no path, no CFI, no library, nothing from `metadata.json` beyond title and author.
- **`section.text` is always a prefix of the section** — it starts where the section starts. The probe's scorer compares the model's claimed opening against the section's first 120 content tokens (`recall.ts` `SECTION_TOKEN_WINDOW`), so a text that began mid-section would score every honest claim `weak`; and the Mac's own window logic (`passageWindow`) takes the whole text plus an offset into it. The phone therefore never sends a window: it sends the section from its start, and the Mac cuts.
- **"Characters" are UTF-16 code units** everywhere on this route — every cap and the offset — because the Mac measures in JavaScript string length and the phone's natural unit (Swift's grapheme clusters) would disagree with it on any emoji. The phone counts `utf16.count` and cuts at a scalar boundary.
- **The cap is 200,000 characters** (`ASK_SECTION_TEXT_MAX_CHARS`), the same ceiling `services/ai.ts` already refuses a request above (`MAX_MESSAGE_CHARS`), against a section whose 18,405-character Introduction was the longest the AI-panel work measured. A section longer than the cap is cut **at its end**; the phone then sends `offset: null` if the reader's position lies past the cut, and the Mac's fallback (the highlight, else the head) applies. That is a stated limit on a rare tail, not a silent one — the request carries `section.truncated: true` and slice 4 records how many sections of a real book it meets. A request whose `text` exceeds the cap is a 400, not a clamp.
- The route has **its own body cap**, separate from the 4 KiB `MAX_BODY_BYTES`, with the same lying-`Content-Length` discipline that constant's comment records (a client that declares more than it sends must not hold the route open).

**Response** (`200`, `content-type: text/event-stream`), events in this order, each a `event:` line and a one-line JSON `data:` line:

| Event | Data | When |
| --- | --- | --- |
| `disclosure` | `{ text, members, rung, windowed, truncated, endpoint: { host, isLocal }, model }` | First, always. `text` is `describeEgress()`'s string verbatim; the phone shows it, it does not compose it |
| `verdict` | `{ value: "strong" \| "weak" \| "unknown" }` | `probe` only, after the model's reply is scored. The raw reply is **not** sent |
| `delta` | `{ text }` | `ask` only, in order |
| `done` | `{ reason: "stop" \| "length" \| "canceled" \| "timeout" }` | Last, exactly once. `preview` ends here with no deltas |
| `error` | `{ message }` | Instead of `done`, after the stream has begun. The message is `services/ai.ts`'s own diagnosis — "nothing is listening at …", "the endpoint rejected the key" |

- **Heartbeat:** a `: ping` comment line every 15 s while waiting. A local model's cold first token can take over a minute (AI-panel D9), and `URLSession`'s idle timer would otherwise cut a healthy stream.
- **Before the stream begins**, refusals are the contract's ordinary vocabulary: `400 bad request`, `401`, `404` for an unknown book, and a new **`503 ai unavailable`** carrying a `reason` member (the model is unset, say) — the same two-member shape `422 cannot reflow` already established. After the first byte, a failure is an `error` event; there is no status left to change.
- **Cancellation is a disconnect.** The phone closing the connection aborts the upstream request; the Mac emits nothing (the reader is gone) and the service settles `canceled`. A new question on the phone cancels its previous one the same way.
- **The Mac holds no state between requests.** A restart between a probe and an ask loses nothing, because the phone sends `rung` itself.
- **Unknown fields in a request, and unknown events in a response, are ignored by both sides.** This is the sentence that makes the route extensible: a later `citation` event, or a `fraction`-less request, must not need a version bump to coexist with an old client.
- **Concurrency:** at most 2 relay asks in flight, a third answered `503 busy` + `Retry-After: 1` — the byte routes' existing vocabulary. It is independent of the desktop panel, which keeps its own one-question rule.

---

## D4 — The three modes are one assembler, called three ways

`preview`, `probe` and `ask` differ only in what the handler does with the result of `buildAskMessages`: `preview` stops at `describeEgress`; `probe` sends the messages, collects the reply, and returns `scoreRecall(parseProbe(reply), openingOf(section.text))`; `ask` streams. There is no second prompt, no mode-specific wording in the handler, and the L0-contains-no-section-text assertion (AI-panel AC13) is therefore the same test for both callers.

**The probe scores against `section.text`, which came from the phone.** That is the one new trust edge: the Mac scores a claim against text the phone says is the section. It is acceptable because the phone is the user's own device behind the user's own token, and because a wrong text yields a wrong *verdict* — a worse answer, never a wider disclosure than `disclosure.text` states. Said out loud rather than assumed.

---

## D5 — `services/ai.ts` gains a sink; the desktop path does not change

**Decision:** `AskOptions` gains an optional `sink` receiving `{ chunk | done | error }`. When absent, the service broadcasts exactly as it does today. The REST handler passes a sink that writes SSE frames.

**Why:** `ai.ask()` ends in `broadcast(...)` on all three outcomes (`services/ai.ts` `done` / `fail` / chunk emission), which reaches whichever reader window is open on the Mac. Without a sink, a phone question would paint into a Mac reader that has the panel open. The change is additive and the existing transport suite (`services/ai.test.ts`) is its guard; the new cases assert that a sink request broadcasts **nothing** to the renderer.

The relay mints its own request ids (`relay-…`), so it can never collide with a desktop `ai:ask` id or be cancelled by one.

---

## D6 — The phone extracts text with Readium, sends it, and keeps everything else local

- **Section text** comes from `publication.content(from:)` for the current resource, joined to plain text. The same known limit as the Mac's `textContent` read applies (minified single-line XHTML runs two blocks into one word) and costs the same: a token at the score, never a verdict.
- **The offset** is the character position of the page's start within that text, found from the Readium locator's `progression` within the resource — a coarse mapping, **measured on a real book in the slice** rather than assumed exact. The Mac's own window logic tolerates an offset that is off by a page: the lead of 1,000 characters is the margin. A missing offset is legal and falls back to the highlight, as it does on the Mac.
- **The selection** comes from the navigator's selection observer.
- **The label** is the Readium TOC entry containing the current resource, matched by `href` — the lookup `ContentsSheet` already does. "Go to ‹label›" (AI-panel D7) reuses that lookup and the existing `goTo`.
- **Nothing here is persisted:** the transcript, the verdict and the rung are view-model state that dies with the reader screen (AI-panel D8). iOS invariant 7 (no local cache beyond settings, downloads, positions and the report queue) is untouched.

---

## D7 — The contract moves in one slice, additively, with `apiVersion` at 1

**Decision:** the route, the `ai` member on `GET /api/health`, the new `503 ai unavailable` row and `Retry-After` reuse, the golden payloads and `scripts/api-smoke.sh` change together in slice 2. `apiVersion` stays 1, as `shelves` and `reflow` did.

```json
"ai": { "available": true, "reason": null, "isLocal": true, "host": "localhost:11434", "model": "llama3.2" }
```

Never the key, never a `hasKey` (the phone has no use for it). `available: false` carries a `reason`, so the phone can say "choose a model in Settings on the Mac" instead of a bare disabled button. The member is optional to read: a client that predates it sees no Ask and nothing else.

`rest_api_enabled = false` gates this route like every other. There is no separate switch for Ask — the model being unset *is* its off switch, and a second flag would be a second place to forget.

---

## Acceptance criteria

### Slice 1 — the move (Mac, no behavior change)

1. `ask-context` and `recall` and their tests live at the new location; `src/lib/ask-session.ts` and the panel import from it; **no body changed** (a `git diff -M` shows renames only plus import lines).
2. `npm run typecheck && npm run lint && npm test` pass with the **same test count** as before the move.
3. `docs/architecture.md` names the new alias.

### Slice 2 — the route and the contract (Mac)

4. **A `sink` request broadcasts nothing** to the renderer; a request without one broadcasts as before (asserted both ways).
5. `preview` returns `disclosure` then `done` and makes **zero** calls to the endpoint (asserted against a stub that fails the test if it is hit).
6. An `ask` at the pointer rung sends **none** of `section.text` to the stub endpoint; at the passage rung it sends a window containing the offset's neighborhood (the AI-panel AC13/AC14 assertions, run through the route).
7. A `probe` returns a `verdict` and **never** the model's raw reply; the same five fixtures as AI-panel AC17 give the same five verdicts through the route.
8. `delta`s arrive in order, `done` exactly once, and no listener or pending entry remains after settle.
9. Closing the connection mid-stream aborts the upstream request (the stub observes the socket close) and leaves no pending entry.
10. A body past the route's cap is refused without being buffered; a lying `Content-Length` does not hold the route open; the 4 KiB reading-report cap is unchanged.
11. Unknown book → 404; unset model → `503 ai unavailable` with a `reason`; a third concurrent ask → `503 busy`; no token → 401. Unknown request fields are ignored.
12. A heartbeat comment appears within 15 s of a silent upstream.
13. `GET /api/health` carries `ai`; the golden, `docs/rest-api.md` and `scripts/api-smoke.sh` agree (the existing contract suite is the decider).
14. The key appears in no response, no event and no log line.
15. `index.html` is byte-identical.

### Slice 3 — the client (iOS)

16. Models derive from the contract's `json payload=` blocks by `scripts/vendor-contract-fixtures.sh`; a field the document does not name fails the suite.
17. The SSE reader handles: an event split across reads, several events in one read, a `: ping` comment, an unknown event (ignored), and a truncated stream (surfaced as an error, never as a clean `done`).
18. Every refusal — 401, 404, 503 `ai unavailable`, 503 `busy`, offline, and an unknown `apiVersion` — is an ordinary state with its own surface (iOS invariant 5), never a crash.
19. The bearer token appears in no log, error or interface (iOS invariant 10).

### Slice 4 — the panel (iOS, verified against a live Mac on an isolated profile with a stub SSE endpoint, no model required)

20. The disclosure line is on screen **before** the first send, comes from a `preview`, and names endpoint, model and payload; it says *remote — host receives this* for a non-loopback endpoint.
21. Tokens render incrementally; a `weak` verdict adds the passage and says why; the override switch adds it on demand and cannot lower a `weak`.
22. A highlight is sent verbatim as the referent. At the pointer rung, section text goes from the phone to the Mac (for scoring) but **not onward to the model** — checked on the stub endpoint's request log, not on the phone.
23. "Go to ‹label›" jumps when the label matches a TOC entry and is absent when it does not.
24. Dismissing the sheet or asking again cancels the stream; closing the book clears the transcript; nothing about a conversation is on disk.
25. With the Mac unreachable, a downloaded book reads exactly as before and Ask says why it is unavailable.
26. The offset mapping is measured on a real book, with the figure recorded — the window must contain the page the reader is on.

---

## Slices, and why they are cut this way

Each slice stays inside the ~10-file bound; the work crosses `electron/main` ⇄ `src` ⇄ the iOS repo, so each is dispatched on its own side and none is a single agent's job.

| Slice | Repo | What | Why it is its own slice |
| --- | --- | --- | --- |
| 1 | Mac | Move the two modules + tests, add the alias | A pure refactor with an exact-count test gate; folding it into the route would make a rename and a behavior change one diff |
| 2 | Mac | Sink option, the route, the cap, `health.ai`, `rest-api.md`, goldens, smoke script | The contract's three artifacts move together (D7); the iOS repo reads this slice's output |
| 3 | iOS | `AskBackend`, `RelayBackend`, the SSE reader, models from fixtures | Testable with no UI, as the Mac's slice 1 was |
| 4 | iOS | Text extraction, the sheet, the reader chrome entry, the probe | Needs a running Mac and a stub endpoint; the only slice whose verification is a frame |

Slices 3 and 4 follow slice 2's merge; nothing on the phone is written against a contract that has not landed (iOS invariant 1).

---

## Rejected and deferred, with the condition that would revive them

- **A phone-direct endpoint (`DirectBackend`).** Deferred, designed for (D1). Revived when Ask is wanted with the Mac asleep or off the tailnet, in practice. It would need the pure modules ported to Swift against shared golden fixtures — the AI-panel logic in two languages is the cost, so it is bought only on that evidence.
- **Phone assembles the prompt and the Mac is a pipe.** Rejected: it puts the feature's thesis in two languages from day one, for a benefit (direct mode) that is not wanted yet.
- **The Mac extracts section text from the file.** Rejected: it needs a mapping from Readium's resource and offset onto the Mac's own parse of the file — the edition-drift problem the AI-panel spec avoided by never using chapter numbers — and it would make Ask depend on the NAS being mounted.
- **A job-id + reconnectable stream.** Rejected: server-side job state and a replay buffer for a client that asked for neither.
- **Non-streaming.** Rejected: a cold local model leaves the panel blank for tens of seconds.
- **A second flag for Ask in Settings.** Rejected (D7): an unset model already means unavailable-with-a-reason.
- **Persisted phone transcripts, an answer cache, a verdict cache.** Deferred on the AI-panel spec's own conditions (its D8); additive later.
- **L2 (adjacent sections).** Out of scope here; it is an open tail on the Mac feature (`tasks.md`) and the phone inherits whatever the Mac decides.

---

## Risks, stated plainly

1. **The offset mapping is approximate.** Readium reports progression within a resource, not a character offset into a text it did not produce. The window's 1,000-character lead absorbs a page of error; if the measured error is larger on real books, the passage rung regresses toward the defect the 2026-09-21 fix removed (the window not containing the page). AC26 exists to find out before shipping, not after.
2. **The section text is untrusted input to the scorer and, at L1, to the model.** The AI-panel spec's prompt-injection mitigation (delimited, declared data) travels with the shared assembler unchanged; the blast radius is still a misleading answer, never an action. A phone supplying a wrong text yields a wrong verdict, not a wider disclosure (D4).
3. **Cold local models versus mobile networking.** Heartbeats cover the idle timer, but iOS suspends an app that leaves the foreground; a stream is expected to end if the reader backgrounds, and the phone treats that as a cancel, not an error.
4. **The move (D2) touches shipped, tested code.** The exact-count gate and a rename-only diff are the mitigation; if either fails, the slice stops there.
5. **Invariants held:** none of 1–6 (no `metadata.json`, catalog, filename, sort key or reading-state change); 8 (the handler is a wrapper over services); 9 (no `file://`, no renderer fetch); 11 (`vendor/` untouched); 12 (an AI failure is an `error` event or a 503, never a throw). iOS 1, 3, 5, 7 and 10 are held as noted above.

---

## Not verified

- That `publication.content(from:)` yields usable text for the EPUBs, MOBI-derived and reflowed-PDF EPUBs in this library, and how it behaves on a book with minified XHTML. Read off the toolkit's source, not run.
- How often a real book's sections exceed the 200,000-character cap (D3) — recorded in slice 4's live pass; the cap is a ceiling chosen from the 18,405-character longest section the AI-panel work measured, not a fitted number.
- Whether `URLSession.bytes` delivers lines promptly enough for token-by-token rendering over the tailnet. Expected, not observed.
- The right home for the moved modules (D2) — a recommendation, awaiting review.
