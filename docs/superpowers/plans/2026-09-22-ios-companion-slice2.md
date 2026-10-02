# Slice 2 — the Settings row, and where it says the server is (annex)

**Why this file exists:** the spec is the design; this is what a session with none of this conversation needs. Read the spec's criteria **27–30** and **D13** first, then this.

## The readings this session settled before you start

1. **`RestApiStatus` was built for this row, in 1a.** `electron/main/api/rest.ts:99-116` returns `{ state, address, port, reason, at }`, and `reason` is documented as _"why it is not listening, in words a Settings row can show"_. Do not re-derive a status: call `getRestApiStatus()` (it hands back a copy, deliberately) and render it. Read the `RestApiState` union rather than guessing its members.
2. **The four keys already exist and already resolve.** `services/settings.ts:34` (`REST_API_CONFIG_KEYS`), `:46` (`DEFAULT_REST_API_PORT = 8788`, with `MIN`/`MAX_REST_API_PORT` at `:49-50`), `:337` (`resolveRestApiConfig()`, which generates the token on enable). `src/types/settings.types.ts:22-25` carries all four on `AppSettings`. **What is missing is the editable path**: `EditableSettings` — the type the save IPC validates — does not carry them, and adding them there is what makes AC28's "exactly the four keys" decidable at all.
3. **The renderer's save path is `window.Musaeum.settings.get()` / `.save(updates)`** (`src/types/api.types.ts:190-198`): absent fields are untouched, blank fields are cleared back to auto-detection, and a validation failure **rejects without writing anything**. Use it — a second writer for `app_config` is what the invariant file forbids.
4. **Live start/stop already exists**: `startRestApiIfEnabled()` / `stopRestApi()` in `electron/main/api/rest.ts`. The toggle must call them, because AC27 asks for the **live** listen status, and a row that writes the flag while showing a stale state is exactly the failure the criterion names.
5. **The credential 1a's review left for this slice.** The token must be read _where it is shown_, never captured when the modal mounted, or a rotation displays a stale value — the same class as the reader's stale list (D17), and the same fix has the same shape. One thing to design for rather than discover: **the token has to be copyable, not merely hidden** (the phone needs it), so "masked with a reveal" means reveal **plus** copy — and the copy must not be a `console.log`, a `data-` attribute, or a value smuggled through the DOM.
6. **The renderer has no DOM harness** (D13 says so explicitly), so this slice's evidence is a **running-app probe** — the same instrument 1c used. `.claude/skills/verify/SKILL.md` carries the launch recipe, the isolated profile, and the stale-instance trap; capture before/after frames if the look matters.

## What must not move

- `services/settings.ts`'s validation rules (a port outside `MIN`/`MAX`, a bind that does not parse) and the "blank means auto-detect" contract.
- The server's own activation path: the row **calls** it, and re-implementing any part of it is the boundary this whole workstream has kept.
- The token's shape (64 hex chars) and that it is generated on enable, never typed by hand.
- The app's existing Settings suite (AC30) — and the row must not disturb the other sections' save behaviour.

## The two documents AC29 names

- `docs/data-contracts.md:152` — _"All but `rest_api_enabled` are editable in Settings"_ — is **false** now and is corrected in this slice.
- `docs/invariants/settings-and-editing.md:22` lists the editable fields; the four `rest_api_*` keys join that list **with their rules** (blank means auto for the port and the bind; the token is generated on enable and never typed), because a list without the rules is what let the sentence above go stale.

## What landed (2026-09-22)

Built, reviewed (not blocking) and fixed, over two commits or one. The row is `src/components/settings/RestApiSection.tsx`; the wording it shows lives in `src/lib/rest-api-status.ts`, with a case of its own, because the renderer has no DOM harness and this is the one piece of row logic a case can reach.

**The two things the review changed about this slice's own reasoning:**

- **The switch and Save were not serialized.** A click during an in-flight Save ran two overlapping `settings:save` calls, and the loser's `stopEpoch` left a live socket reported as `disabled` beside a switch reading On — rendered as "the switch is off", which is the AC27 failure class, reachable. The renderer now guards the pair and the wording takes the stored flag, so a lost listener reads "the listener stopped". The service has no queue *by design*; the bound is written into `docs/invariants/settings-and-editing.md` rather than answered with machinery this slice was not given.
- **AC28's decider was weaker than its criterion.** The case asserted the four keys **by name**; a fifth key written alongside them would have passed. It now compares the `app_config` key *set* before and after, which is what "exactly the four keys and nothing else" means. The live probe read two full key-sets either side of one click — an instrument the next session cannot re-run, so the case is the durable half.

**What the next session should not re-derive:** the token's masking is presentation (the value is in the renderer either way, exactly as the Ask key's is); "live" means composed-at-read rather than pushed, so a post-bind server error leaves the last state; and the URL is resolver-composed on each read, so the row can name an address the socket did not bind — the status line is the authoritative half and the discrepancy is visible rather than hidden.

## Start here

```bash
git log --oneline -3        # slice 1c landed as c5ad6a1, its documents as 4055c6e, invariant 3 as 03c2daa
npm run typecheck && npm run lint       # both 0
npm test                    # 55 files / 1305 tests
sidecar/.venv/bin/python -m pytest -q sidecar/tests   # 113 passed
```
