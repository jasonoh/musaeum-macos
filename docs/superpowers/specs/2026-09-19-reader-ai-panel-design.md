# Design: Ask about what you're reading (reader AI panel, v1)

**Date:** 2026-09-19 **Status:** Proposed — the four gating forks were settled with Jason on 2026-09-19. **All three slices are built** (1, 2 and 3, each on 2026-09-19). v1 is complete as designed; every deferred item below still carries its reversal condition. **Scope:** a question panel inside the reader that knows where you are — the book, the section, the passage you selected — against an OpenAI-compatible endpoint that is **localhost by default**. **Depends on:** the reader (`specs/2026-08-13-native-reader-design.md`, shipped 2026-08-13); the Settings surface over `app_config` (`docs/invariants/settings-and-editing.md`); the `handle()` / preload / event plumbing (`docs/data-contracts.md`). **Supersedes:** the _"AI conversation about the book you are reading"_ paragraph in `tasks.md` §"Captured, not analysed" (2026-09-19). That entry argued the payload and named six forks; this document settles them. The measurements it carried are reused here, not re-derived. **Interacts with:** S1 in-book search (`specs/2026-09-19-reader-search-design.md`) — one side-panel slot, two claimants. The rule is **D4** here; S1's D7 is superseded by it.

---

## Why now

Three of this feature's four moving parts were built for other reasons and are already in the tree. That is what makes it cheap now and would not have been true a month ago:

1. **The pointer is free.** `FoliateRelocateDetail` carries `cfi`, `fraction` and `tocItem` (`src/types/foliate-js.d.ts:23-27`), the engine emits it on every page turn (`vendor/foliate-js/view.js:329-334`), and the current section's `Document` arrives on the `load` event — where it is _already_ being listened for, to attach `keydown` (`ReaderEngine.tsx:156-159`). "Where I am" therefore needs one field threaded through, not a new subsystem.
2. **Jumping is solved.** `goTo(target)` is what the TOC panel calls today (`ReaderView.tsx:214`) and what position restore calls (`ReaderEngine.tsx:181`).
3. **Key resolution has a precedent to copy.** `resolveGoogleBooksKey()` (`services/sidecar.ts:51-57`) already implements "`app_config` wins over the environment, and report which source won"; `SettingsView.resolved` already carries the masked-key shape (`settings.types.ts:34-51`); `mask()` is already written (`settings.ts:149-152`).

And the fourth part — what to send — was settled by the owner's argument on 2026-09-19: **when the decoder holds the content, the message only has to carry the residual.** Title, author and section are an _index_ into knowledge the model already has; the highlighted sentence is the one piece of text that must travel verbatim because it is the **referent**.

What that argument does not settle is whether the model actually holds the content for _this_ book — and the library splits on it. Measured 2026-09-19, read-only against the live dev database: 6,458 books, of which **5,080 hold an epub/mobi/azw3**, so that is this feature's real surface. (The same read is recorded in the `tasks.md` entry that argued the thesis; it is reproduced here so this document stands alone.)

| Slice                       | Books         | Bearing on the bet                                          |
| --------------------------- | ------------- | ----------------------------------------------------------- |
| pre-1900                    | 995           | public-domain canon — the most-memorised material there is  |
| 1900–1959                   | 43            |                                                             |
| 1960–1999                   | 377           |                                                             |
| 2000–2013                   | 3,132         | the bulk: business, self-help, technical, textbooks         |
| 2014–2023                   | 1,773         |                                                             |
| 2024+                       | 134           | **outside most models' knowledge by construction**          |
| Lonely Planet + Rough Guide | 290           | travel guides — no chapter-level recall exists in any model |
| no description at all       | 2,602         | proxy for how weakly indexed these are anywhere             |
| authors / appearing once    | 3,727 / 3,118 | 84% of authors appear exactly once — a long tail            |

_(Rows are separate reads, not a partition — the travel-guide, no-description and author rows overlap the year buckets. Do not sum the column.)_

The canon is exactly where pointer-only should work, and it is a large, real fraction. The 2000–2023 non-fiction majority is where no pointer summons the chapter: 290 travel guides, a UCC contracts textbook, a bread-baking book. **The residual risk is therefore not a rate problem, it is a grounding problem** — and the only local evidence available is a claim that can be checked.

So the design that follows is **pointer-only by default, with local verification**, and this document is where that ladder gets its trigger and thresholds. Nothing leaves the machine to do the checking.

---

## What already exists, read off the tree

Everything below was read this session, not remembered.

| Fact                                                                                                                      | Where                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Relocate detail carries `fraction`, `cfi`, `tocItem`                                                                      | `src/types/foliate-js.d.ts:23-27`; emitted at `vendor/foliate-js/view.js:329-334` |
| The engine **drops** `tocItem` and collapses `fraction`→`percent`                                                         | `ReaderEngine.tsx:149-155`                                                        |
| The current section's `Document` is already received                                                                      | `ReaderEngine.tsx:156-159` (`load` listener)                                      |
| `getCFI(index, range)`, `resolveCFI(cfi)`, `addAnnotation`, `goTo`, `getProgressOf`, `getSectionFractions` are all public | `view.js:368, 431, 436, 460, 494, 490`                                            |
| One side-panel slot; two session-only flags; `close()` clears both                                                        | `ReaderView.tsx:213-214`; `reader.store.ts:100-103, 156-164`                      |
| Session flags are never persisted — only `prefs` survives a restart                                                       | `reader.store.ts:179-183`                                                         |
| Keys the renderer may not reach: no remote host is reachable from it                                                      | `index.html:8` — `connect-src 'self' ws: musaeum:`                                |
| IPC never throws across the boundary; handlers are thin wrappers                                                          | `ipc/handle.ts:8-22`; `CLAUDE.md` invariant 8                                     |
| Main→renderer events go through one broadcast helper                                                                      | `services/events.ts:13-17`; `api.types.ts:216-232`                                |
| Settings keys are type-forced: a missing mapping is a compile error                                                       | `settings.ts:26-34` (`Record<keyof EditableSettings, string>`)                    |
| Migrations are numbered SQL imported `?raw` into `db.ts`                                                                  | `electron/main/schema/migrations/00{1..4}_*.sql`; `db.ts:15-18`                   |
| Tests: vitest via Electron-as-Node, `electron` aliased to a mock                                                          | `vitest.config.ts`; `package.json` `test` script                                  |

**Four things are _not_ true today and are inside this feature, not free:**

- `tocItem` never reaches the UI, so there is no section label to send (D5).
- Nothing captures a **selection** inside a section document — the `load` listener attaches `keydown` and nothing else (D5).
- Nothing in the tree speaks to an LLM: no client, no config key, no IPC surface.
- The renderer has **no DOM test harness** (`tasks.md`, slice-4 debt) — which is why both pieces of this feature that deserve tests are pure functions (slices 1–2), and the panel is verified in the running app instead.

---

## The design in one paragraph

A third occupant of the reader's side-panel slot. It assembles a prompt from the pointer (title, author, section label, fraction) plus, if you highlighted something, that sentence verbatim. The **main process** — never the renderer, never the Python sidecar — posts that to an OpenAI-compatible `/chat/completions` with `stream: true` and streams tokens back over the event channel. Endpoint, model and optional key come from `app_config`, **defaulting to a local model on localhost**, so the standing posture ("no account, no service, no listener") is preserved until you point it somewhere else. On opening the panel for a book, one cheap probe asks the model to place the book and quote the section's opening; the answer is scored **locally** against the text already in memory. If the model cannot place it, the passage is added to the payload for that session and the panel says so.

---

## D1 — It is not a sidecar

**Decision:** the wire client is `electron/main/services/ai.ts`; the surface is `src/components/reader/ReaderAsk.tsx`; the IPC file is `electron/main/ipc/ai.ts`. The word _sidecar_ appears nowhere in the feature.

**Why:** in this repo _sidecar_ is the Python metadata process (`services/sidecar.ts`, `docs/data-contracts.md` §"Python Sidecar Communication"). Naming a renderer panel plus a main-process HTTP client a sidecar would read as the wrong process for as long as the code lives — and it would invite exactly the wrong implementation (fork 1 of the `tasks.md` entry).

**Consequence:** `tasks.md`'s phrasing ("a sidecar to the ebook reader") is retired in favour of "the ask panel". Cheap now, expensive after a year of commits.

---

## D2 — The call happens in the main process; the panel is not the client

**Decision:** the renderer never opens a socket. `index.html:8` is **not touched**.

**Why:** the CSP is a stated promise, not an oversight — _"book content can never execute and an EPUB cannot phone home"_ (`docs/project-overview.md` §3.5). Widening `connect-src` to reach an arbitrary user-configured host would hand any book's injected markup a network path, which is the one thing the reader's architecture is built to prevent. The main process reaching a URL the user typed into Settings keeps that boundary intact.

**Where the line falls inside the feature** — the split is not arbitrary:

- **The renderer owns prompt semantics.** The context assembler and the recall scorer are pure functions in `src/lib/` (slices 2–3) because that is where the _inputs_ are: the pointer, the section's text, the selection. It emits `{ system, messages }` plus a `describeEgress()` string.
- **Main owns the wire.** URL, model, key, SSE parsing, cancellation, timeouts, error diagnosis. It accepts assembled messages and knows nothing about books.

**What that buys:** the API key never crosses the IPC boundary in either direction (the renderer only ever sees the masked `detail` string), and the transport is testable today while the panel still is not (`vitest.config.ts` includes `electron/**/*.test.ts` and `src/**/*.test.ts`).

---

## D3 — One OpenAI-compatible shape, localhost first

**Decision:** three `app_config` keys, all editable in Settings:

| Setting     | Key           | Env fallback          | Default                                        | Validation                                                                                                             |
| ----------- | ------------- | --------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `aiBaseUrl` | `ai_base_url` | `MUSAEUM_AI_BASE_URL` | `http://localhost:11434/v1` (source `default`) | must match `https?://host[:port][/path]`                                                                               |
| `aiModel`   | `ai_model`    | `MUSAEUM_AI_MODEL`    | **none** — source `none`                       | non-empty                                                                                                              |
| `aiApiKey`  | `ai_api_key`  | `MUSAEUM_AI_API_KEY`  | none                                           | none (only a live request can tell a good key from a bad one — the same reasoning `settings.ts:125-128` already gives) |

One wire format — `POST {base}/chat/completions` with `stream: true` — covers every endpoint the owner named: Ollama's OpenAI-compatible surface (`/v1`), `llama-server`, LM Studio, and any cloud OpenAI-compatible host. No provider enumeration in the schema, no per-vendor branch in the client.

**Model has no default, deliberately.** Inventing `llama3.2` would produce a panel that fails with "model not found" on a machine that has Ollama but not that model. An unset model means the panel is **unavailable with a reason** — the shape `ResolvedSetting.source === 'none'` already carries for Python and Calibre (`settings.ts:58-70`).

**The default being loopback is the point.** With `http://localhost:11434/v1` the feature's egress is exactly zero, which is the app's standing posture. The status surface therefore reports `isLocal`, computed in main from the host (loopback only: `localhost`, `127.0.0.0/8`, `[::1]`), and the panel shows _"local — nothing leaves this machine"_ vs _"remote — `<host>` receives this"_. The user can still point it at a cloud endpoint; the app just never lets that happen quietly.

**Not added to `SIDECAR_KEYS`.** The AI endpoint is read per request, so changing it must **not** bounce the Python process out from under an in-flight hydration (`settings.ts:33-34, 104-108`).

**`aiApiKey` is never echoed** in `resolved` — `detail` carries `mask(key)`, exactly as `googleBooksApiKey` does (`settings.ts:71-77`, AC in `settings.test.ts:51-58`).

---

## D4 — The panel slot: three-way exclusivity

**Decision:** `ReaderToc`, `ReaderSearch` (S1) and `ReaderAsk` share **one** side slot, mutually exclusive, as session-only store flags in `reader.store.ts`. Opening any one closes the others; `close()` clears all three; none is persisted.

**Why:** this is the layout question `tasks.md` handed to _"whichever of the two lands second"_. The answer is the one S1's D7 already argues for and `closePrefs` already implies: the reading pane is the product, and a 288px column on each side of it — on a laptop, over a paginated EPUB — is a worse trade than two clicks. Exclusivity also keeps the state machine trivial (three booleans, one rule) instead of introducing a "both open" layout that nothing has asked for.

**Keyboard rule.** The panel's textarea is a typing target, so `ReaderView`'s existing `isTypingTarget` guard (`ReaderView.tsx:100`) already stops Space and arrows from turning pages while you type. One case has to be added: **Escape with focus inside the panel closes the panel, not the book** — the same shape the `prefsOpen` branch already implements (`ReaderView.tsx:105-110`), and for the same reason (a panel the reader owns is not something Escape should take the book away from). Escape outside the panel still closes the reader.

**Panel geometry:** `w-72 shrink-0`, `border-r border-ink-800 bg-ink-950`, mirroring `ReaderToc.tsx:11` — with the transcript scrolling under a pinned composer.

---

## D5 — What travels: the pointer is the index, the referent is verbatim

**Decision — the payload, by rung:**

| Rung             | What is sent                                                                            | When                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **L0** (default) | title, author, section label, fraction, the question, and the selection if there is one | always, unless the probe says the model cannot place this book                               |
| **L1**           | L0 **+ the current section's text**, capped                                             | when the verdict is `weak` for this `(book, session)`, or when the user turns the passage on |
| L2               | L1 + a CFI-centred window across adjacent sections                                      | **deferred** — see "Rejected and deferred"                                                   |

- **The selection is always sent, and is always the referent.** It is the only text that travels by default, it is bounded (a selection longer than the cap is truncated with a visible notice), and the prompt says which part is which: the pointer is an index, the selection is authoritative over recall.
- **The section label comes from `tocItem.label`, and the fraction from the relocate detail — never a chapter number.** Section indices and chapter numbers drift across editions, reissues and translations, and a collection's "chapter 7" is a short story. Today that label is _dropped_ (`ReaderEngine.tsx:149-155`); threading it through is the one change to the engine this feature needs.
- **The passage is capped at ~6,000 characters** (~1,200 words: the section body of a typical trade EPUB is under this; a textbook section is not, and the notice says it was truncated).
- **The disclosure line is mandatory, and it precedes the first send.** The composer shows the endpoint, the model, and what the payload contains — _"Sends: title, author, section “Chapter 4”, your highlight → <host>"_ — and it updates when the rung changes (_"+ this section's text"_). Fork 3 of the `tasks.md` entry asked for exactly this and it is not optional: the payload argument reduced the egress, it did not eliminate it.

**What is _never_ sent, at any rung:** the book's file, paths, the library, the reading position as a CFI, the transcript of other books, anything from `metadata.json` beyond title and author, and the API key outside the `Authorization` header.

---

## D6 — The ladder: pointer-only by default, verified locally

**Decision:** one probe per `(book, session)`, issued when the panel first opens for that book, scored on this machine. Its verdict decides the rung.

**The probe.** A single-turn call with a strict output contract, assembled by the same pure function as the questions (`buildAskMessages({ mode: 'probe' })`):

```
RECALL: <yes|no>
OPENING: <the first 8–15 words of that section, verbatim>
```

**The score.** `parseProbe()` reads those two lines tolerantly (case-insensitive keys, optional backticks/bold); `scoreRecall()` then compares the claimed opening against the section text already held in memory:

- normalize both sides (NFC → casefold → strip diacritics → non-alphanumerics to spaces → collapse → drop stopwords and tokens under 3 characters);
- `score` = |claimed ∩ local| / |claimed| over the local section's first 120 content tokens;
- **`strong`** if `score ≥ 0.6`; **`weak`** if the model said `RECALL: no`, or scored below 0.6 while claiming to recall; **`unknown`** if the reply did not parse or no section text is loaded.

**What each verdict does:**

| Verdict   | Payload for this session      | Panel shows                                                                         |
| --------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `strong`  | L0 — pointer only             | nothing (the bet paying off)                                                        |
| `weak`    | **L1** — the passage is added | _"the model couldn't place this book — sending the passage for this session"_       |
| `unknown` | L0 (the default)              | an _unverified_ badge — _"answers about this book are reconstructed, not recalled"_ |

**Why a probe and not a heuristic.** The measured tail (2024+ titles, 290 travel guides, the 2,600 with no description anywhere) is precisely where no pointer summons the chapter — and the model has no way to know which kind it is looking at; it answers fluently either way. The only local evidence is a claim that can be checked, and the cheapest such claim is the section's own opening line.

**Why the check never leaves the machine.** Both sides of the comparison are local: the claim is in the response, the truth is the section text the engine already holds. The verdict itself is never sent anywhere.

**The user override.** A _"send the passage too"_ switch in the composer, so the ladder is not the only control. It wins over `strong` and `unknown`; it cannot _lower_ a `weak` verdict below L1.

**Failure of the probe is not failure of the feature.** A probe that errors (endpoint down, timeout) leaves the verdict at `unknown` and the panel usable — the same "non-fatal, keep the working part" rule invariant 12 states for hydration and NAS.

---

## D7 — Citations are section labels, never CFIs

**Decision:** the panel offers **"Go to ‹label›"** when the answer names a section label that matches an entry in the TOC already in the store, and that is the only jump affordance in v1.

**Why not CFIs:** a CFI is an opaque product of _this_ file's structure (`view.js:431-434`). A model cannot know one, so "cite a CFI and let the panel jump to it" is an instruction to hallucinate — and the failure mode is a confident pointer into the wrong place in the book, which is worse than no pointer. Labels come from the book's own TOC, which we hold, so matching is a lookup and a miss is visibly a miss.

**Why "go to a label" is still a citation:** it is the answer's one verifiable claim about location, and it resolves through `goTo(href)` — the path the TOC panel already uses, including its `goTo`-returns-`undefined` failure handling.

Citations are **not** required of the model, and an answer that omits them is normal.

---

## D8 — Transcripts and cache are session-scoped in v1

**Decision:** the conversation, the probe verdict and the per-question answers live in the `reader` store (session, in-memory) and die with the reader. **Nothing is written to `metadata.json`, `catalog.json`, or SQLite.**

**Why:** transcripts are the first thing in this feature that grows without bound — the same class as highlights — and both `metadata.json` and `catalog.json` carry a per-book SMB write and a whole-library rewrite respectively (`docs/invariants/nas-and-catalog.md`). A feature whose whole argument is that it sends a citation instead of a chapter should not pay a NAS round trip to remember a conversation.

**Deferred, with reversal conditions:**

- **Answer cache** keyed by `(book, model, cfi-or-fraction, question)` in SQLite — worth building when answered questions are visibly re-asked in practice.
- **Per-book probe verdict** in SQLite so a new session doesn't re-probe — worth building when the probe's latency (one local round trip per book per session) is actually felt.
- **Transcript persistence at all** — optional by construction; v1 is single-session.

None of the three is required for the feature to be correct, and each is additive: a new migration following `schema/migrations/00{1..4}` and its import in `db.ts:15-18`.

---

## D9 — The wire: streaming over IPC, in the house pattern

**Decision:** two request/response calls and three events.

```
ai:getStatus()  → { configured, reason, endpoint: ResolvedSetting, model: ResolvedSetting, isLocal, hasKey }
ai:ask(request: AskRequest) → { requestId }
ai:cancel(requestId) → boolean

event:ai-chunk  { requestId, delta }
event:ai-done   { requestId, reason: 'stop' | 'length' | 'cancelled' | 'timeout' }
event:ai-error  { requestId, message }
```

- **The caller mints `requestId`** (so `AskRequest` carries it) rather than the service returning one. As first written this decision went the other way, and building it showed why that was wrong: the renderer subscribes _then_ asks, and a refused connection fails in a few milliseconds — faster than the IPC reply carrying the id would arrive. A service-minted id would have left that error with nobody listening, and the panel stuck. Minting it caller-side removes the race rather than racing it. (`ai:getStatus`, not `ai:status`, follows the house `domain:verb` convention — `settings:get`, `library:getBooks`.)

- **The job-id shape is the existing one.** `transfer-queue` and `bulk-hydrate` already return an id and push progress through `events.broadcast`; this adds three channel entries to `EVENT_CHANNELS` (`api.types.ts:216-232`) and three listeners to the preload's `on` block.
- **Cancellation is a terminal `done`, not an error.** The user closing the panel or starting another question is a normal outcome; it aborts the `AbortController` and emits `reason: 'cancelled'`.
- **At most one user question in flight**, and at most one probe per book per session. A new question cancels the previous one.
- **Listeners are per-request and released on settle.** The panel subscribes when `ai:ask` resolves and unsubscribes on `chunk`'s terminal event — a leaked listener per question would be a memory leak in an app with a 500MB ceiling, and it is invisible until it isn't.
- **Timeouts are idle-based:** no chunk for 120s → `reason: 'timeout'`, terminal. No total deadline: a local model's first token can legitimately take a minute on a cold start.
- **Errors carry a diagnosis, not an errno.** `ECONNREFUSED` → _"Nothing is listening at `<url>` — is your local model server running?"_; a 401/403 → _"the endpoint rejected the key"_; a JSON error body with an `error.message` → that message. This is the same discipline as the Settings surface refusing to report a path the app doesn't actually use (`settings.ts:11-22`).

**Why main and not preload:** the key, the URL and the socket stay in one process, and the transport test runs under vitest without an Electron window.

---

## Store and component shape (slice 3 sketch)

`reader.store.ts` additions, all session-only, none persisted (`partialize` stays `{ prefs }`):

```
askOpen: boolean
askRung: 'pointer' | 'passage'      // the effective rung; the override and the verdict both write here
askVerdict: RecallVerdict | null    // 'strong' | 'weak' | 'unknown'
askTurns: AskTurn[]                 // { role, text, streaming } — the transcript, in memory only
askStatus: 'idle' | 'probing' | 'streaming' | 'error'
askError: string | null
```

Actions: `toggleAsk()` (closes TOC/search), `closeAsk()`, `setRung()`, `setVerdict()`, `appendDelta(requestId, delta)`, `settle(requestId, reason)`, `reset()`. `openBook()` and `close()` clear the transcript — a book is a new conversation.

Components: `ReaderAsk.tsx` (transcript + composer + disclosure line + verdict badge). Wiring: `useAi.ts` subscribes to the three events **once**, in the `src/hooks/use*.ts` layer mounted by `App.tsx`, per the house rule for main-process events.

`ReaderEngine.tsx` gains exactly two things: `tocItem.label` threaded into `onRelocate`, and an `onSection({ index, text })` callback fired from the existing `load` listener (plus a `selectionchange`/`mouseup` listener that captures the current selection's text and CFI through the public `getCFI(index, range)`). No new engine features, no `vendor/` edits (invariant 11).

---

## Acceptance criteria

### Slice 1 — foundations (signed off)

1. `AppSettings` gains `aiBaseUrl`, `aiModel`, `aiApiKey`; `CONFIG_KEYS` maps them to `ai_base_url` / `ai_model` / `ai_api_key`. A forgotten mapping is a **typecheck** error (`settings.ts:26-34`), not a runtime one — assert by construction.
2. A blank base URL resolves to `http://localhost:11434/v1` with source `default`; a blank model resolves to source `none` and the panel reports why; the key never appears in `resolved` (masked `detail` only), asserted the way `settings.test.ts:51-58` already asserts it.
3. `MUSAEUM_AI_*` env vars are honoured when nothing is configured, and `source` is `'env'` — the `resolveGoogleBooksKey` contract, applied to three values.
4. Saving the endpoint or model does **not** call `sidecar.restart()` (they are not in `SIDECAR_KEYS`), asserted.
5. `ai:status` reports `{ configured, model, endpoint, isLocal, reason }`; `isLocal` is true for `localhost`, `127.0.0.1`, `[::1]`, and false for anything else.
6. Against a stub SSE server: deltas broadcast **in order**, `ai-done { reason: 'stop' }` fires exactly once, and **zero listeners remain** after settle.
7. `ai:cancel` mid-stream closes the socket and produces `ai-done { reason: 'cancelled' }` — not an error.
8. `ECONNREFUSED` produces the "is your local model server running?" message; a 401 produces "the endpoint rejected the key"; a JSON `{ error: { message } }` body surfaces that message.
9. No chunk for 120s produces a terminal `timeout`; no request can hang forever.
10. The SSE parser handles: an event split across chunks, several events in one chunk, `data: [DONE]`, comment/heartbeat lines, and a malformed JSON line (skipped, not fatal).
11. `index.html` is byte-identical (**no CSP change**) and the renderer never receives the key.
12. `npm run typecheck && npm run lint && npm test` all green.

### Slice 2 — the two pure pieces

13. `buildAskMessages()` output at **L0 contains none of the section text** — asserted as a literal absence, because that absence _is_ the thesis.
14. At L1 it contains the passage, truncated at the cap with the truncation visible in the disclosure string.
15. `describeEgress()` names the endpoint, the model and every payload member actually present.
16. `parseProbe()` is tolerant of formatting (bold/backticks/case/extra whitespace) and returns "no recall, no opening" for a reply that does not follow the contract.
17. `scoreRecall()` yields `strong`/`weak`/`unknown` on fixed fixtures: a verbatim opening, a near-miss from another edition, a fluent invention, an explicit refusal, an unparseable reply.

### Slice 3 — the panel (verified in the running app)

18. The panel occupies the slot exactly as `ReaderToc` does; opening it closes the TOC and vice versa; closing the reader clears everything.
19. Escape while the composer has focus closes the panel and leaves the book open; Escape anywhere else still closes the reader.
20. The disclosure line is visible **before** the first send and names endpoint + model + payload.
21. Tokens render incrementally (verified against a stub SSE server over CDP, not against a real model — the verification must not depend on Ollama being installed).
22. A `weak` verdict visibly adds the passage and says why; the override switch adds it on demand.
23. "Go to ‹label›" jumps when the label matches a TOC entry and is absent when it does not.
24. Opening another book clears the transcript; nothing about the conversation is on disk (`grep` the library root for any new file: zero).
25. The panel works with the library offline — the book is already in memory, and nothing in this path touches the NAS.

---

## Slices, and why they are cut this way

**Slice 1 — foundations (11 files, at the house bound; the one now signed off).** New: `src/types/ai.types.ts`, `electron/main/services/ai.ts`, `electron/main/ipc/ai.ts`, `electron/main/services/ai.test.ts`. Edited: `src/types/settings.types.ts`, `src/types/api.types.ts`, `electron/preload/index.ts`, `electron/main/index.ts`, `electron/main/services/settings.ts`, `electron/main/services/settings.test.ts`, `src/components/settings/SettingsModal.tsx`.

It stops at the IPC boundary on purpose: it is testable today (vitest covers `electron/**`), it makes the endpoint configurable and honest, and it ships no UI. If the endpoint story is wrong — model unset, wrong default base URL, a provider that isn't OpenAI-compatible — that is discovered here, for the price of a settings field, rather than after the panel exists.

**Slice 2 — the pure pieces (4 files).** `src/lib/ask-context.ts` (+test), `src/lib/recall.ts` (+test). The prompt and the scorer, with no dependency on slice 1 or the panel. This is the part of the feature that _is_ the feature: what travels, and what counts as weak recall.

**Slice 3 — the panel (8 files).** `src/components/reader/ReaderAsk.tsx`, `src/components/reader/ReaderView.tsx`, `src/components/reader/ReaderEngine.tsx`, `src/stores/reader.store.ts`, `src/hooks/useAi.ts`, `src/App.tsx`, `src/lib/ask-session.ts` (+test, the pure reducer for probe→verdict→rung).

Verified in the running app against a **stub SSE server** on localhost (a ~40-line node script), so the acceptance run is reproducible on any machine and does not require a model to be installed.

---

## Rejected and deferred, with the condition that would revive them

- **A library-wide "ask the AI about my library"** — a _different_ feature (a catalog query over FTS), and explicitly not absorbed here (`tasks.md` fork 6 named it to stop exactly that).
- **Sending the section by default** — rejected: it contradicts the egress argument that justifies the whole shape, and the ladder already reaches it on evidence. Revived only if probing proves useless on real books.
- **A cloud-first provider model** — rejected in favour of a loopback default (D3); a cloud endpoint remains a first-class choice, it just isn't the default.
- **A second right-hand panel** — rejected (D4). Revived if search and ask are both used in the same sitting often enough that the exclusivity is felt.
- **CFI citations and CFI jump-to** — rejected (D7): unproducible by the model, so unverifiable.
- **Highlights/annotations persistence** — untouched. The panel reads a live selection through the public annotation mechanism without needing storage, which is what stops this feature queueing behind the annotations decision (`tasks.md`, C1 out-of-scope list).
- **L2 (adjacent sections / a CFI window)** — deferred. Revived when a real book is observed to stay `weak` _with_ its section text sent, which is the only evidence that would justify the wider payload.
- **SQLite answer cache, verdict cache, transcript persistence** — deferred (D8) with named conditions, all additive migrations.

---

## Risks, stated plainly

1. **The probe is a discriminator, not a guarantee.** A model can quote an opening line from memory of a _different edition_ and score `weak` while being substantively right, or produce a fluent paraphrase that happens to share tokens and score `strong` while being wrong. It is evidence about this book, and it is better evidence than nothing — not a correctness proof.
2. **A small local model will fail the probe often**, which means the ladder widens the payload constantly. That is the ladder working, but it means the feature's cost profile depends on the model chosen — worth measuring on the real library before drawing conclusions about the thesis.
3. **Prompt injection becomes possible for the first time.** At L1 a book's own text reaches a model, and book text is untrusted input. Nothing the model returns is executable — there is no tool call, no code path, no renderer fetch — so the blast radius is a misleading answer, not a compromised machine. The passage is delimited and the system prompt says it is data, never instructions; that is mitigation, not immunity, and it should be said out loud rather than assumed away.
4. **"I don't have this book" must stay a legal answer.** For the measured tail — 2024+ titles, the 290 travel guides, the 2,600 with no description at all — a plausible invented chapter summary is the worst possible output. The system prompt says refusal is complete and cheap, and the probe's `RECALL: no` is a first-class outcome rather than a failure.
5. **Invariants held:** this design touches none of 1–6 (no `metadata.json`, no catalog, no filename, no sort key, no reading-state round trip), keeps 8 (IPC handlers stay thin), 9 (`no file://`, no new renderer fetch), 11 (`vendor/` untouched) and 12 (an AI failure is non-fatal and never throws across the boundary). It does not touch the Python sidecar at all.

---

## Built — slice 1 (2026-09-19)

The eleven code files listed above exist. **AC1–AC12 hold**, verified by `npm run typecheck`, `npm run lint` and `npm test` — 675 tests over 30 files, 44 of them new — plus a `git diff --quiet index.html` check standing behind AC11.

What building it changed, and what it taught:

- **D9's request id moved to the caller** — the one decision that changed under implementation, and the reason is recorded there.
- **`describeHttpError` failed its own AC first.** The first version read the message off the response body's _root_ object, so `{"error":{"message":"model 'x' not found"}}` — the most common failure there is, a local server that does not have the model — came back as raw JSON instead of the endpoint's own sentence. AC8 caught it. The fix is `httpErrorMessage()`, which checks `error.message`, then a flat `message`, then the raw string.
- **One reader for both failure shapes.** `errorMessageOf()` is shared by the SSE path (an `error` object arriving mid-stream) and the HTTP path, so a provider that fails either way reads the same way to the person looking at it.

**Not in this slice, deliberately:** there is no UI, so nothing here is visible in the app yet — the panel, the prompt assembler and the recall scorer are slices 2 and 3 (slice 2 has since landed; see below). Nothing in the renderer calls `window.Musaeum.ai` at all yet; the surface exists and is driven from the main process in its tests.

---

## Built — slice 2 (2026-09-19)

Four files, all new, all pure — `src/lib/ask-context.ts` + `ask-context.test.ts` (18 tests) and `src/lib/recall.ts` + `recall.test.ts` (21 tests). **AC13–AC17 hold**, verified by `npm run typecheck`, `npm run lint` and `npm test` — 714 tests over 32 files, 39 of them new — with `git status` confirming the four files are the only changes. No store, no IPC, no DOM, no import from `electron/main/services/ai.ts`; the one import out of `src/lib` is the *type* `AskMode`/`ChatMessage`, which is the seam itself rather than a dependency on slice 1's service.

What building it changed, and what it taught:

- **`parseProbe` failed its own tolerance criterion first.** The first version's "the opening wrapped on to the next line" branch gathered *every* following non-blank line, so `OPENING: Alice was beginning` followed by `NOTE: a guess` scored the claim as `Alice was beginning NOTE: a guess` — a deflated overlap and a spurious **`weak`**, which would have widened the payload for a book the model had placed correctly. Fixed by ending the wrap at any single-word `KEY: value` line (a line of prose that ends in a colon has nothing after it) and at two continuation lines. AC16 caught a real bug, not a formatting quibble.
- **The probe's payload is not the ask's payload, and the spec did not say so.** The L0 row lists "the question, and the selection if there is one"; a probe has neither — and since the probe is what *decides* the rung, it cannot already be at the passage rung. So `buildAskMessages({ mode: 'probe' })` is pointer-only **by construction**: title, author, section label, position, and nothing else, even when a selection and a passage are handed to it. The highlight is the referent *of a question*; there is no question yet. Recorded here so a later session does not have to re-derive the reading.
- **The disclosure line reads the payload, not the caller's intent.** `describeEgress()` takes the `AskPayload` the assembler built, and `members` is derived from that object's own fields — so "names every payload member actually present" holds by construction, with no second list to keep in sync and no way for the line to claim less than is sent.
- **Two small departures from the approved text.** (1) The D5 example line (`Sends: title, author, section “Chapter 4”, your highlight → <host>`) is longer in the implementation, which also names the position and the model — fraction does travel (the rung table), and AC15 asks for every member present. It is a wrapped line in a 288px panel, which is the cost. (2) One cap is used for both blocks of book text — `PASSAGE_CHAR_CAP = 6000` applies to the passage *and* to an oversized highlight — rather than two numbers, since D5 states one cap and only one measurement.
- **A blank question throws.** An `ask` with no question (or only whitespace) raises `An ask needs a question.` rather than assembling a pointer-only request and posting it: that is a caller bug, and the composer's disabled send button is the same rule on the UI side. A probe needs no question, so it is unaffected.

**For slice 3, the two entry points are:** `buildAskMessages({ mode, rung, title, author, sectionLabel, fraction, question, sectionText, selection })` → `{ system, messages, payload, rung }` and `describeEgress({ endpoint, model, payload })` → the composer's disclosure string. The verdict side is `scoreRecall(parseProbe(reply), sectionText)` → `'strong' | 'weak' | 'unknown'`, with `recallOverlap()` exported so the threshold can be asserted directly.

---

## Built — slice 3 (2026-09-19)

The panel exists and v1 is complete. **AC18–AC25 hold**, decided by the instrument each one needs — a unit test where the claim is logic, the running app where the claim is layout, the wire where the claim is egress:

| AC  | What decided it                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18  | CDP: one slot (w-72 = 288px, `border-r border-ink-800 bg-ink-950`), TOC and ask clicked in turn — `aria-pressed` flips on one and the other's `<aside>` is the only one |
| 19  | CDP: Escape dispatched inside the composer → panel gone, reader still open; Escape elsewhere → reader closed                                                            |
| 20  | CDP: the line reads before the first send, and after the probe it names exactly the members sent                                                                        |
| 21  | CDP: a strict prefix of the answer rendered with the caret while the stream was still arriving, captured in that same call                                              |
| 22  | CDP + the stub's request log: `weak` → notice + `this section's text` in the disclosure; the override → the passage in the *body*, not just in the line                 |
| 23  | CDP: `Go to “The Ledger of Small Debts”` appears, and clicking it moves the pointer to `section “The Ledger of Small Debts”, position (72%)`; absent for an answer that names no section |
| 24  | `find` + `grep` over the library root, the SQLite file and its WAL: a sentinel answer appears in 0 of them, and no file was written during the session                  |
| 25  | Structural: the panel's entire IPC surface is `ai:getStatus` / `ai:ask` / `ai:cancel` and the three `on.ai*` subscriptions — plus a behavioural run with the book's folder moved out of the library root, which still answered       |

The verification ran against a **stub SSE server**, no model and no library: `MUSAEUM_USER_DATA` isolation plus two synthetic EPUBs (`/tmp/musaeum-probe`), so the real library was never opened and **no real book was touched** — the sentinel and tree checks are only meaningful because nothing else was writing.

**Nine code files, two test files.** The eight planned, plus:

- `src/components/shared/icons.tsx` — the panel's header button needs a glyph, and the house rule is that icons are hand-rolled SVGs in that set rather than borrowed from a library. One 12-line `AskIcon`.
- `src/stores/reader.store.test.ts` — the file already existed (sanitizePrefs); the store's ask routing is now 14 more cases there, because the reducer can be tested in isolation but *routing* (which stream an event lands in) is store behaviour.
- `vitest.config.ts` — one line, and the only genuine bug the gates caught. The store now imports through `@/`, which no test had ever exercised; `vitest.config.ts` aliased `@shared` and `electron` but not `@`, so `reader.store.test.ts` failed to *load*. The build config already had the alias (`electron.vite.config.ts`) — the test config now mirrors it, which is the fix rather than writing the store's one import relative and leaving the trap for the next file.

**One bug found before it ran, and it was a real one.** `onRelocate` reports position updates, and `latest.current` is spread straight into `reader:saveProgress` — so adding `label` to the relocate detail and letting the whole detail become `latest` would have posted a `label` field into the progress report. The handler now destructures the two fields the report carries. Nothing would have failed loudly; it would have travelled silently for as long as the report shape tolerated it.

**Readings this spec left open, now settled — each one is a coin flip the next session should not have to make again:**

1. **The disclosure line needs a payload before a question exists.** `buildAskMessages` refuses an empty ask (deliberately), so the composer assembles its preview with a placeholder standing in for the *question* only. The member list is still the assembler's own — derived from the payload's fields — so an ask always lists `your question`, which is correct: an ask cannot be sent without one.
2. **The probe is a send too, so it gets a line.** D5's rule is that nothing leaves quietly; the probe is the one request the reader pressed nothing for. While it is out the panel says *"Checking whether the model knows this book. Sends: title, author, section “X”, position → host"* — the probe's own payload, from the same assembler. This is an addition beyond the letter of D5 and squarely inside its intent.
3. **Escape's scope.** The decision text says "Escape while the composer has focus"; the build scopes it to *focus anywhere inside the panel* (its buttons included) and additionally swallows unmodified keys while focus is inside — which is the rule the `prefsOpen` branch already states, applied to the second panel. Without it Space on the panel's own button would also turn the page underneath.
4. **A cancelled probe still lands a verdict.** `null` means "not probed", so leaving it `null` after a cancel would re-probe on every reopen and weaken "one probe per (book, session)". Cancelled or failed, the verdict is `unknown` — unverified, which is what is actually known. A partial reply that parses is still scored (`RECALL: no` followed by a dropped connection is the model saying it cannot place the book).
5. **The selection's CFI is captured nowhere.** D7 jumps by label and D8 defers the cfi-keyed cache, so nothing consumes `getCFI(index, range)`; the selection's *text* is all that travels. `src/types/foliate-js.d.ts` is therefore untouched — when the deferred cache is built, whoever needs the CFI declares it then, rather than this slice widening the vendored surface for a field with no reader.
6. **The section text is `textContent`, not `innerText`.** `load` fires while the paginator is measuring the new section with its iframe unrendered, and `innerText` needs layout; foliate's own search reads the same text nodes. The known limit is a file whose XHTML is minified onto one line — two block elements then read as one word — which costs a little in the passage and a token at the score, never a verdict.
7. **The transcript is one store field (`askSession`), not the sketch's four flat ones.** The reducer is its only writer; `askTurns` / `askStatus` / `askError` as separate fields would be three writes per event and could disagree. `askStatus` is derived instead, by `askStatusOf(session, probing)`, and the pure module owns that rule too.
8. **D9's per-request listener bullet is superseded by its own wire-once bullet.** `useAi.ts` subscribes once at the root; the store routes by `requestId`, and a stale event returns the *same state object*, so it cannot notify a subscriber. There is no listener to leak — the failure that bullet guarded against is now structurally impossible, and it is asserted at the store level (a subscriber is not called for a request nobody is waiting on).
9. **A settled answer that produced no tokens is dropped** rather than left as an empty bubble, so a failure before the first token reads as a sentence rather than a blank box.

**Deliberately not done:** no transcript persistence, no answer cache, no verdict cache, no L2 (adjacent sections), no CFI storage, no highlights storage — all deferred with the conditions already stated above. The one thing the panel reaches outside itself is `openModal('settings')` for the unavailable state's button, which is the existing modal route and not a new surface.

**Stated plainly, so nobody re-derives it:** AC25's "works with the library offline" is proven structurally and by one behavioural run (the book's folder removed from the library root while a question was answered), not by unmounting the NAS — the section text is in memory and no path in this feature reads a file. And the verification observed something outside this slice: with two books imported in one session, the second book was in `catalog.json` and on disk but had no `books` row until the app was relaunched, after which the startup catalog reconciliation adopted it. That is the import/catalog path, untouched here, and whether it is a race with the verification's own immediate `refreshLibrary()` call or a real gap is **not diagnosed** — it is recorded rather than explained.
