# Slice 4 — choosing a provider, and testing the key

| | |
|---|---|
| Date | 2026-09-20 |
| Slice | 4 of the ask panel (its configuration surface — the parent spec's D3 keys, made choosable and testable) |
| Annex to | `docs/superpowers/specs/2026-09-19-reader-ai-panel-design.md` — **D3** (the three `app_config` keys) and **D2**'s sentence about the key never crossing the boundary. This annex settles **readings and wiring**, and records the two product decisions the owner took for it on 2026-09-20 (§2). D1, D4–D9 and AC1–AC25 all stand |
| Read first | `docs/invariants/settings-and-editing.md` (the settings surface, its two rules, `SIDECAR_KEYS`), `docs/data-contracts.md` (the preload surface, `handle()`), `CLAUDE.md` #8 (handlers stay thin) and #9/#12 (the renderer still reaches no host; an AI failure stays non-fatal) |
| Asked for by the owner | 2026-09-20: *"we need to be able to select a provider, which should then automatically configure the api endpoint, then we add the api key, and have a 'test' and 'save' button. The 'Test' should return whether the api key is correctly hitting the endpoint"* |

## 1. What this slice is

1. A **Provider** select at the top of the Ask (AI) group. Choosing a row writes that row's base URL into the Endpoint field. There are eleven rows: three loopback servers, seven cloud endpoints, and **Custom** — which is what the select reads for any URL no row matches, including one the user types.
2. A **Test** button beside the Endpoint/Key fields, which reports one verdict about the endpoint-and-key as they are *in the form right now*: whether the key is accepted, refused, unprobeable, or aimed at nothing.
3. The **Model** field stops being blind: a successful Test returns the ids the endpoint itself listed, and the field offers them (and stays typable).
4. A **Save** button inside the section, which is the dialog's own save — the same behaviour, placed where the owner asked for it (D6).
5. Nothing else. No new `app_config` key, no migration, no contract change to `AppSettings`, no change to the wire, no change to the reader, no new dependency.

### 1.1 Measured before (isolated profile, `MUSAEUM_USER_DATA=/tmp/musaeum-ai-config/profile`, `npx electron . --remote-debugging-port=9223` at `bf6c76e`)

Instrument: `musaeum-app-verification`'s `scripts/cdp.mjs`, one `eval` over the open dialog's DOM. The frame is `/tmp/musaeum-ai-config/before-full.png`, cropped to the modal.

| Measure | Before |
|---|---|
| Ask (AI) section height | **329 px** |
| Controls in the section | 3 text inputs, **1** button (the key's reveal toggle), **0 selects** |
| Buttons that test anything | **0** — the section has no action of its own |
| Provider choice | none; a blank Endpoint means the compiled-in `http://localhost:11434/v1` (`ai.ts:28`) |
| Model field | free text; the only hint that a wrong name is wrong arrives from the reader, mid-question |
| Modal body | top 111, height 698, `scrollHeight` 1527 |
| The section's own Save | none — only the dialog's **Save changes** footer |

## 2. The decisions the owner took for this slice (one batched form, 2026-09-20)

### O1 — the model list comes from the endpoint, never from a table

**Decision:** a successful Test returns the ids the endpoint lists, and the Model field offers those ids. **Alternative:** each provider row ships a few suggested model ids. **Why not:** a hardcoded list goes stale silently, and the failure lands as *"model not found"* inside the reader instead of in the field where it was typed — `settings.ts:151-153` already refuses to guess about a model name for exactly this reason. **Reversal condition:** none foreseen; a provider that lists nothing loses the affordance and keeps the free-text field.

### O2 — Test sends `GET {base}/models`, and nothing else

**Decision:** one request, the model list. No fallback probe, no one-token completion. **Alternatives offered and not taken:** `/models` *with* a completion fallback; a one-token completion as the only probe. **The consequence this annex is obliged to handle:** an endpoint without `/models` cannot be tested, and (measured, §4) one of the seven cloud rows is in exactly that position today. So the ladder must report *"this endpoint has no model list"* — a fact about the endpoint — and never dress it up as a fact about the key (§3 D3). A wrong key and a missing route are different sentences. **Reversal condition:** a row whose provider has no `/models` being used for real, at which point the fallback is one arm in `probe()` and one case in `ai.test.ts`.

### O3 — the provider list, and Claude not in it

**Decision:** eleven rows — Ollama, LM Studio, llama.cpp/vLLM, OpenAI, Google Gemini, xAI, Groq, OpenRouter, DeepSeek, Mistral, Custom. **Alternative offered and not taken:** the same list plus Anthropic. **Why not:** Anthropic's own OpenAI-compatibility layer is documented as *"primarily intended to test and compare model capabilities, and not considered a long-term or production-ready solution"* — and a reading in the parent spec's D3 is that this app speaks one OpenAI-compatible wire and nothing else. A row that routes a reader's questions through a layer its own vendor disclaims is not a convenience. **Reversal condition:** a native Anthropic wire (its `/v1/messages`, `x-api-key`, an SSE shape of its own) — that is a wire decision and belongs in a spec, not in this table. Claude remains reachable today through **Custom**.

## 3. Readings this slice settles (the parent spec left them open)

### D3.1 — the enumeration is a settings-UI table; the client stays vendor-blind

The parent spec's D3 ends *"No provider enumeration in the schema, no per-vendor branch in the client."* This slice adds an enumeration and keeps that sentence's point intact by putting it where it belongs: `src/lib/ai-providers.ts` is renderer-only, holds base URLs and nothing else, and **no main-process file imports it**. `probe()` takes a URL, a model and a key; it has no idea which vendor it is talking to and no branch to prove it. **Why it matters:** the moment a provider table reaches the client, "one OpenAI-compatible wire" becomes "one wire plus N exceptions", which is the thing D3 was protecting. **Reversal condition:** a provider that needs more than a base URL — then the provider *is* a wire fact, the client must know it, and that is a spec amendment rather than a row. The parent spec's D3 gains this scope correction in place when this lands.

### D3.2 — no new `app_config` key; the selection is derived from the endpoint

The select's value is `matchProvider(form.aiBaseUrl)`, computed; choosing a row writes `aiBaseUrl` into the form and nothing else. **Alternative:** a stored `ai_provider`. **Why not:** two representations of one fact can disagree, and the disagreement is invisible — a hand-edited `ai_base_url` beside a stored `ai_provider` renders a select that confidently names a host the client is not posting to. This repo has already paid for that class once, which is why `theme_tokens` has the "both keys present and agreeing on `id`" rule (`settings-and-editing.md`). The base URL *is* the state; deriving a label from it is total. **Reversal condition:** nothing — a config key would need to carry a fact the endpoint string cannot, and the only such facts are wire facts (D3.1's reversal condition).

### D3.3 — the ladder: a missing route is not a rejected key

`probe()` returns one of six verdicts, and the mapping is the whole of the feature's honesty about what it knows:

| What the endpoint answered | Verdict | What the user reads |
|---|---|---|
| 200, body parsed | `ok` | *"The key works — ‹host› listed N models."* (+ whether the chosen model is among them) |
| 200, body unreadable | `ok` | *"The key works. ‹host› answered, but its model list didn't parse."* |
| 401 | `rejected` | *"The endpoint rejected the key (HTTP 401)."* + the endpoint's own message when it sent one |
| 403 | `refused` | *"The endpoint refused the request (HTTP 403): ‹its own message›"* — **not** "your key is bad" |
| 404 / 405 / 501 | `no-model-list` | *"No model list at ‹url› — this endpoint can't be tested this way."* The key was **not** checked, and the sentence says so |
| connection error | `unreachable` | `describeConnectionError`'s existing diagnosis (ECONNREFUSED → *"is your local model server running?"*) |
| no answer inside the deadline | `timeout` | *"‹host› did not answer in 15 s."* |

**Why 403 is not folded into 401:** measured today (§4), `api.groq.com/openai/v1/models` answers **403** `{"error":{"message":"Access denied. Please check your network settings."}}` from this machine — a network block, with no key involved at all. A ladder that reads 403 as "the key is wrong" would have told the owner to go and regenerate a key that was fine. **A 401 is about the key** (that is what the status means and what every row in §4 sent back for a missing one); **a 403 is about the request being refused**, and the endpoint's own message is the useful half. **Reversal condition:** a provider observed answering 403 for a keyed request whose key is in fact bad — then the verdict splits on whether a body names the key, not on the status alone.

### D3.4 — Test runs against the form, never against what is stored

**Decision:** `ai:test({ baseUrl, model, apiKey })` — explicit values, taken from the dialog's `form`. **Why:** the entire point of the button is to answer *before* committing, and a probe that reads `app_config` cannot report on a key the user has just pasted but not saved. **Consequence, stated plainly:** the key now crosses the IPC boundary on every Test press. The parent spec's D2 sentence *"the API key never crosses the IPC boundary in either direction"* is true of the streaming path and was never true of the settings path — `settings:save` has carried `aiApiKey` since slice 1. D2 is corrected in place to say which path it is about, rather than being quietly exceeded. **Reversal condition:** a "Test saved settings" flow, which would be a second button and a worse one.

### D3.5 — the model list is the endpoint's own answer, and the field stays typable

A `<datalist>` over the ids the last successful Test returned, wired to the existing `Field`, which gains one optional prop (`list`). The ids are **sorted**, **capped at 100**, and the total is reported when it was capped — OpenRouter lists several hundred, and a 400-entry dropdown is a worse control than a substring filter, which a datalist gives for free as the user types. Typing stays unrestricted: an id the endpoint didn't list is still sendable, because the endpoint is the authority on what it will run (D3's own reasoning, applied to models). **Alternative:** a `<select>`. **Why not:** it would forbid a model the endpoint lists under another name, and would need a second control to keep free text possible. **Reversal condition:** a user with a several-hundred-model provider unable to find one — then the cap gets a filter box (the appearance picker's D4 precedent).

### D3.6 — the section's Save is the dialog's save, one behaviour with two affordances

The owner asked for a Save button in the section. **Decision:** it calls the same `save()` the footer's **Save changes** calls — whole form, `changedFields` diff, the same ⌘↵. **Alternative:** a section-scoped save writing only the three AI fields. **Why not:** two buttons in one dialog that mean different things about the same form is a bug generator, not a feature — edit the SMB URL, press the AI section's Save, close, and the app has silently kept half of what you told it. The owner's ask is satisfied by *placement*, and nothing about `changedFields` changes. **Reversal condition:** the dialog being deliberately restructured into per-section saves.

### D3.7 — the verdict is local, transient, and cleared by an edit

The verdict and the `probing` flag are `useState` in `SettingsModal`, beside `revealAiKey`. Cleared when any of the three AI fields changes, and on each new press. Nothing is persisted — a restored "the key works" line would describe a request that is not in flight against a key that may since have been revoked, which is `settings-and-editing.md`'s *"state whose cause the user can't see"*. **Reversal condition:** a "last verified" stamp worth keeping across launches, which would need a stored time and a stored endpoint to be meaningful, and would still be a lie after a key rotation.

## 4. Measured — the probe's premises (2026-09-20, from this machine)

`GET {base}/models`, no credentials, `--max-time 12`. An unauthenticated **401 proves the host and the route exist**; a 404 is the route being absent; the body quoted is the endpoint's own.

| Row | URL probed | Status | Body (first 60 chars) | What it means for Test |
|---|---|---|---|---|
| OpenAI | `api.openai.com/v1/models` | 401 | `Missing bearer authentication in header` | route exists → `rejected` without a key |
| Gemini | `generativelanguage.googleapis.com/v1beta/openai/models` | **404** | `Requested entity was not found.` | **route absent** → `no-model-list` (O2's consequence) |
| xAI | `api.x.ai/v1/models` | 401 | `No credentials presented.` | exists |
| Groq | `api.groq.com/openai/v1/models` | **403** | `Access denied. Please check your network settings.` | **network-blocked here** → `refused`, never "your key is bad" |
| OpenRouter | `openrouter.ai/api/v1/models` | **200** | `{"data":[{"id":"prism-ml/ternary-bonsai-2-27b",…` | exists, and lists without a key |
| DeepSeek | `api.deepseek.com/models` | 401 | `Authentication Fails (governor)` | exists; body is **not JSON** |
| Mistral | `api.mistral.ai/v1/models` | 401 | `{"detail":"Invalid API Key"}` | exists; error carries **`detail`**, not `error.message` |
| Ollama / LM Studio / llama.cpp | `localhost:11434`, `:1234`, `:8080` | `000` | — | **nothing running on this machine** — the local rows' probes are unmeasurable here and are decided by the stub instead |

Two of these shape the code: the error reader must carry the endpoint's own words through **three** shapes (a JSON `error.message`, a JSON `detail`, and a bare string — DeepSeek's), and `403 ≠ 401` is not a nicety but the difference between a correct verdict and a wrong one on a row that ships.

**Anthropic was probed too, and the measurement is why it is not a row:** `api.anthropic.com/v1/models` → 401 `x-api-key header is required` — its models route does not accept the `Authorization: Bearer` this client sends at all. Combined with O3, that is two independent reasons for the Custom row.

## 5. The file table

| # | File | Who | What |
|---|---|---|---|
| 1 | `src/lib/ai-providers.ts` | renderer | **new** — `AI_PROVIDERS` (11 rows), `matchProvider()`, `providerById()`, `hostOf()`, `endpointHint()`, `CUSTOM_PROVIDER_ID` |
| 2 | `src/lib/ai-providers.test.ts` | test | **new** — matching both directions, normalization, the per-row URL walk (AC27), and `endpointHint`'s four cases |
| 3 | `src/types/ai.types.ts` | contracts | `AiProbeRequest`, `AiProbeVerdict`, `AiProbeResult` |
| 4 | `src/types/api.types.ts` | contracts | `ai.test(request)` on `MusaeumAPI` |
| 5 | `electron/main/services/ai.ts` | main | `probe()` + the ladder + the model-list parser + `PROBE_MODEL_CAP` (the cap lives here, next to the code that applies it — the renderer only renders what it is handed) |
| 6 | `electron/main/services/ai.test.ts` | test | one case per rung against the file's existing real HTTP stub |
| 7 | `electron/main/ipc/ai.ts` | main | `handle('ai:test', …)` — one line, no logic (invariant 8) |
| 8 | `electron/preload/index.ts` | main | one line |
| 9 | `src/components/settings/SettingsModal.tsx` | renderer | the Provider select, the Test button and verdict line, `Field`'s `list` prop, the datalist, the section's Save |
| 10 | `src/components/settings/ai-section.test.ts` | test | **new** — the two source walks D3.4 and D3.7 need, which no unit test can decide (no DOM harness) |
| 11 | `docs/superpowers/plans/2026-09-20-reader-ai-config-slice4.md` | — | this annex |
| 12 | `docs/superpowers/specs/2026-09-19-reader-ai-panel-design.md` | — | D2's scope correction, D3's enumeration correction, and the trail entry — **when the slice lands** |
| 13 | `docs/invariants/settings-and-editing.md` | — | the AI group's new rules (the derived provider, the form-scoped probe) |
| 14 | `tasks.md` | — | the entry's outcome, additively |
| 15 | `CHANGELOG.md` | — | the user-visible line |

**7 code files + 3 test files = 10, inside `CLAUDE.md`'s ~10-file bound.** The section stays inline in `SettingsModal.tsx` rather than becoming an `AiSection.tsx`: `AppearanceSection` is its own file because it owns its own save path and its own store, and these three fields do neither — they are part of the batched form. Copying the file layout without the reason would be the mistake.

## 6. Acceptance criteria, each with its decider

| AC | Criterion | Decider |
|---|---|---|
| AC26 | Choosing a row writes that row's base URL into the Endpoint field; the select's value is **derived** from the endpoint, so a URL no row matches reads **Custom** — through case and trailing-slash differences too | `ai-providers.test.ts` (`matchProvider` both directions) + live CDP (pick OpenAI → field reads the URL; type a foreign URL → select reads Custom) |
| AC27 | Every row's URL is one our own client can append `/models` to: `isHttpUrl(row.baseUrl)` is true, no trailing slash, and 11 rows exist with exactly one `Custom` | `ai-providers.test.ts`, a walk over `AI_PROVIDERS` (the anti-drift instrument that stops a row landing with a typo) |
| AC28 | No new `app_config` key, no migration, no change to `AppSettings`/`EditableSettings` | `git diff --stat electron/main/schema/migrations/` empty + `settings.test.ts`'s existing key assertions green, unchanged |
| AC29 | Test issues **exactly one** request: `GET {base}/models`, with `Authorization: Bearer ‹key›` when a key is present and **no** `authorization` header when it is not | `ai.test.ts`, the stub's request log (the instrument the streaming suite already uses) |
| AC30 | The ladder, one case per rung: 200+list → `ok`; 200 unparseable → `ok` with the list unread; 401 → `rejected` carrying the endpoint's message; **403 → `refused`, not `rejected`**; 404/405 → `no-model-list`, not `rejected`; `ECONNREFUSED` → `unreachable`; silence past the deadline → `timeout` | `ai.test.ts`, real HTTP stub, `ProbeOptions.timeoutMs` driving the deadline |
| AC31 | With no key set, a 401 reads as *the endpoint wants a key*, never as *the endpoint rejected the key* | `ai.test.ts` |
| AC32 | A successful probe returns the ids listed, **sorted**, capped at 100, with the total; and `modelOffered` is `true`/`false`/`null` for the model asked about | `ai.test.ts`, a 150-id list |
| AC33 | The Model field offers those ids after a successful Test and stays typable | live CDP: `<datalist>` option count after a Test against the stub, then a hand-typed id that survives |
| AC34 | Test reads the **form**, and a Test **writes nothing**: the request carries the edited-but-unsaved values, and `app_config` is unchanged afterwards | live CDP (stub request log + `sqlite3 -readonly` before/after) + source walk: the probe call's argument names `form`, not `view` |
| AC35 | The section's Save and the dialog's Save changes are **one behaviour**: an edit made in another group persists when Save is pressed *in the AI section* | live CDP |
| AC36 | The verdict line is cleared by editing any of the three AI fields and is never persisted | live CDP + source walk (no `localStorage` in the file) |
| AC37 | Nothing on the reader's side moved: `index.html` byte-identical, `ai:ask`/`ai:cancel` untouched, `CONFIG_KEYS`' AI trio and `SIDECAR_KEYS` unchanged (saving an endpoint still restarts nothing) | `git diff --quiet index.html` + the full suite green |

## 7. What must not move

- **The wire.** `POST {base}/chat/completions` with `stream: true`, the SSE parser, `describeConnectionError`, `describeHttpError`, `errorMessageOf` — the probe is additive and reuses the last three verbatim.
- **`index.html`'s CSP.** Byte-identical. The probe is a main-process fetch (parent spec D2).
- **The three key names** (`ai_base_url`, `ai_model`, `ai_api_key`), the type-forced `CONFIG_KEYS` mapping, and their absence from `SIDECAR_KEYS` — an endpoint change must never bounce the Python process (`settings.ts:29-34`).
- **The masked-key rule** in `resolved.aiApiKey`: the key is still never echoed back, in either direction.
- **The reader.** Nothing under `src/components/reader/`, `src/stores/reader.store.ts` or `src/lib/ask-*.ts` is touched; the panel's own disclosure line and payload ladder are untouched.
- **The vendor-blindness of `electron/main/`**: no main-process file may import `ai-providers.ts` (§3 D3.1's assertion).
- **Colour**: every new value rides an existing token (`gold-400`, `danger-400`, `ok-500`, `parchment-*`), which is what slice 7b's repo-wide grep enforces.

## 8. Verification plan

1. `npm run typecheck`, `npm run lint`, `npx prettier --check` on the touched files, then `npm test`. Baseline at `bf6c76e`: 956 tests over 43 files.
2. A mutation campaign (`musaeum-slice-workflow` → `scripts/mutation-campaign.py`), one mutation per new decider: 403 merged back into the 401 arm (AC30), the bearer header sent unconditionally (AC29), `matchProvider` made case-sensitive (AC26), the cap raised past the sort (AC32), `probe()` reading `getConfig` instead of its argument (AC34), a row's URL given a trailing slash (AC27).
3. The app pass on an isolated profile, before and after on the same instrument: §1.1 is the before column; the after column re-runs the same `eval` and the same crop geometry, plus a frame of the section with a verdict showing.
4. **The live proof of the owner's own sentence** — that Test "returns whether the api key is correctly hitting the endpoint" — is a deliberately bogus key (`sk-musaeum-not-a-key`, typed by hand, never a real credential) against a real provider: the line must read *the endpoint rejected the key*. The same button against `https://openrouter.ai/api/v1` must read `ok` and list models with an empty key, and against Gemini's row must read *no model list* rather than blaming the key. That trio is the whole ladder, end to end, through the real IPC path.
5. A stub on the endpoint's own default (`http://localhost:11434/v1`, the parent spec's instrument) for the streaming paths that must not have moved, and for AC33's list.

## 9. Returned — 2026-09-20

**7 code files + 3 test files = 10, inside the bound**, exactly the table above: the two lib files, the three contract/main edits, the section, and the three test files. **Gates: typecheck 0, lint 0, `prettier --check` 0, `npm test` 993 passed / 45 files** (baseline 956/43 — 37 new), build 0, `index.html` byte-identical.

**AC26–AC37 hold.** Where each was decided, and what the instruments said:

| AC | What decided it |
| --- | --- |
| 26 | `ai-providers.test.ts` (both directions, case, trailing slash, the near miss that must *not* match) + live: picking OpenAI filled `https://api.openai.com/v1`, and typing `https://gateway.internal.example/v1` flipped the select to Custom |
| 27 | the per-row walk — the only instrument that can catch a row added with a typo, and two mutations were run against it |
| 28 | no migration, no `AppSettings` change; the live profile's `app_config` carried exactly the three keys after a Save and none before |
| 29 | `ai.test.ts` — one request, `/v1/models`, bearer when a key is present, **no** `authorization` header when it isn't |
| 30 | `ai.test.ts`, one case per rung, real HTTP stub; plus live: OpenAI with a bogus key → *rejected*, OpenRouter with no key → *ok*, Gemini → *no model list* |
| 31 | `ai.test.ts` (`not.toMatch(/rejected the key/)` on the keyless 401) |
| 32 | `ai.test.ts` (150 ids → 100 returned, sorted, `modelCount` 150) + live: **446** listed, **100** options in the datalist, "446 models listed by this endpoint" on the hint |
| 33 | live: the datalist carried 100 options, the field kept its typed value, and the model field stayed typable |
| 34 | live + source walk: `ai.test` appears once, its argument names `form.*`, and `app_config` was read **before** (three keys absent) and **after** four Tests (still absent) — Test writes nothing |
| 35 | live: an edited `smb_url` persisted when **Save** was pressed in the AI section, so the section's Save is the dialog's |
| 36 | live: 1 non-faint line after a Test → 0 after one keystroke in a field |
| 37 | `git diff --quiet index.html` clean; `ai:ask` / `ai:cancel` untouched; the AI trio still absent from `SIDECAR_KEYS` |

**The mutation campaign: 14 mutations, 14 killed**, across three rounds — one per new decider. The one honest wrinkle is in round 1: its first 403 mutation **survived**, and the triage says why. Written as `if (response.status === 403)` → `if (response.status === 401 || response.status === 403)`, it cannot change behaviour, because the 401 arm *above* it has already returned — an **equivalent mutant**, not a missing decider. The mutation that does fold it (adding 403 to the arm that runs first) reds the criterion immediately. That is worth more than the count: the ladder's correctness depends on the **order** of the two arms, so they are not interchangeable, and the first campaign said so by failing to say anything.

**Two copy defects, both found by the live pass and neither by the suite**, which is exactly what the pass is for:

1. **A doubled full stop.** `api.openai.com`'s own message ends in `.`, and the line appended another: *"…at https://platform.openai.com/account/api-keys.."*. `suffix()` now ends the sentence without doubling it (a `[.!?]$` test), and a case asserts both shapes — a detail that ends in a stop and one that doesn't.
2. **"Accepted the key" with no key sent.** OpenRouter lists its models to anyone (446 of them, measured), so the unkeyed Test read *"accepted the key"* about a key that had not been sent. The subject is now derived from whether a key travelled: *"openrouter.ai answered (no key was sent)…"*. Both defects have their own deciding case now, and both were re-verified live after the fix.

**A third defect, and the one worth the most: two lines that contradicted each other.** The first build put a form-derived egress sentence under the Provider select (*"Requests go to <host>."*) beside the Endpoint field's stored-derived one (*"<host> receives what you send"*). Mid-edit — pick OpenAI over a saved OpenRouter, before saving — the two said different things on the same screen, and one of them was about where the book's own text travels. The DOM said nothing (both lines existed, both were "right"), and the screenshot said it immediately. The fix keeps **one** line, always about the value the app would actually use, and moves the only thing the renderer knows and main does not into a pure function with four cases: `endpointHint(formBaseUrl, resolved)` — value in force → main's own sentence; unsaved → *"the reader still sends to <host> until you save"*; blank beside a configured value → *"goes back to the built-in local default when you save"*. The frame's diff confirms **one** egress line now, not two.

**A fourth, smaller one, from the same frame:** the key field's placeholder read *"Not needed for a local model"* while **OpenRouter** — which requires a key — was selected. It now names the row: *"Paste the key for openrouter.ai"*.

**Readings the spec left open, now settled:**

1. **The select's value is derived from the *effective* endpoint, not the raw field.** A blank field resolves to the compiled-in default, so a fresh install reads **Ollama** rather than Custom — verified live (`select: 'ollama'`, placeholder `http://localhost:11434/v1`, hint *"A model running on this machine — nothing leaves it"*). Deriving from the raw field would have shown Custom on the one screen where the app's posture is local.
2. **Custom is a derived state, not a choice.** It renders as a `disabled` option at the end of the list: it is what the select *reads* for a URL no row names, and selecting it could only clear the field and silently drop the endpoint back to the default.
3. **A blank key falls back to the one in force.** `probe()` uses `resolveKey()` when the request carries no key, because a key set in the environment is invisible to the renderer — a Test that reported "none is set" while the reader posted with that key would answer a different question. A case pins it (`Bearer sk-from-env` reaches the stub).
4. **A 200 with an empty list and a 200 with an unparseable body are different sentences.** The first is a real answer from a fresh Ollama (*"it lists no models yet"*); the second means the line could not be shown.
5. **`probe()`'s 15 s deadline is a value, not a mechanism, and has no mutation.** The option-driven case decides that an unanswered request terminates rather than hanging; the specific default is a judgement recorded in the doc comment.
6. **The section stays inline in `SettingsModal.tsx`.** `AppearanceSection` is its own file because it owns its own save path and its own store; these three fields are part of the batched form, so a new file would have copied the layout without the reason.

**Deliberately not done:** no Anthropic row (O3), no completion fallback for `/models` (O2 — its consequence is reported honestly rather than papered over), no persisted provider, no "last verified" stamp, no per-provider model catalogue, and nothing in the reader, the sidecar, the schema or `index.html`.

**One observation for the owner's eye, not a defect:** on the built-in default theme the verdict line's `ok` tone reads warm rather than green, because the default palette's accent ramp is gold and the status family is derived from it (slice 7a's rule). An imported theme with a green accent gets a green "ok". Nothing here changes that; it is recorded because the line is new and visible.

