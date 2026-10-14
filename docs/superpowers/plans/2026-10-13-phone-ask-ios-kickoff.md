# Phone Ask — the iOS session's kickoff (slices 3 and 4)

**Written 2026-10-14, immediately after the Mac half landed.** This is a handoff note, not a plan: the plan is `docs/superpowers/plans/2026-10-13-phone-ask-ios.md` and it is the authority for what to build. This note exists so the session that starts in `../musaeum-ios` does not have to re-derive the state of the Mac half, and does not lose days to four facts that cost this session days to measure.

---

## What landed, and why it unblocks the phone

The Mac half — slices 1 and 2 — is merged on `musaeum-macos`'s `main`, `aa50bbb` → `697e9c4`, seven tasks, each implemented and independently reviewed:

|          |                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| Suite    | `npm test` → **100 files / 2230 passed / 0 failed / 0 skipped** (baseline 98 / 2145)                                  |
| Gates    | `npm run typecheck` 0, `npm run lint` 0, `index.html` byte-identical, `apiVersion` still **1**                        |
| Smoke    | `scripts/api-smoke.sh` green on **both** branches — 87 checks with no model set, 89 for the 200 event stream with one |
| Contract | `docs/rest-api.md` — `POST /api/ai/ask`, five `ask-*` payload blocks, the additive `ai` member on `GET /api/health`   |

The plan's own hard dependency ("the Mac half must be merged first; nothing here is written against a contract that has not landed") is therefore **satisfied**, and the plan file now says so at the top.

---

## The prompt

> Implement slices 3 and 4 of the "phone ask" feature in this repository, per the plan at
> `../musaeum-macos/docs/superpowers/plans/2026-10-13-phone-ask-ios.md`. The spec is
> `../musaeum-macos/docs/superpowers/specs/2026-10-13-phone-ask-design.md` (AC16–AC26 are yours);
> the wire contract is `../musaeum-macos/docs/rest-api.md`. All three are settled and are not up
> for re-litigation.
>
> The Mac half landed on 2026-10-14 and is merged on that repo's `main` (`aa50bbb` → `697e9c4`),
> so the contract these slices are written against is **present and current**. Do not edit
> `../musaeum-macos` — it is the other half of this feature and its own session's work.
>
> Execution: use superpowers:subagent-driven-development. A fresh subagent implements each task
> and a fresh reviewer checks it before the next one.
>
> Before you start:
>
> 1. Read the plan, the spec's "The phone" sections, your repo's `CLAUDE.md` and `AGENTS.md`, and
>    `../musaeum-macos/docs/rest-api.md`'s `POST /api/ai/ask` and `GET /api/health` sections in full.
> 2. `git status` and `git log -3`. Expect a clean tree on your default branch.
> 3. Measure the baseline before Task 1 and report the delta after each task: `xcodegen generate`,
>    then `xcodebuild ... build` and `xcodebuild ... test` against a live simulator (the plan's
>    Gates block carries the exact commands and warns you to pick a simulator that exists).
> 4. **Vendor the contract fixtures from `docs/rest-api.md` as it stands now**, via the plan's
>    `scripts/vendor-contract-fixtures.sh`. The document gained a run of accuracy repairs after
>    its own whole-branch review on 2026-10-14 — a copy made earlier is stale, and Task 1 is
>    designed to fail loudly if the `ask-*` blocks are missing, which is your check that you have
>    the current one.
>
> Scope and stopping points:
>
> - Do Tasks 1–N of the iOS plan, in order. Slice 3 is Core-only and testable with no UI; slice 4
>   adds the Readium glue and the sheet.
> - Stop and show me the vendored fixture diff before the first task that writes app code.
> - The plan's gates for every task are `xcodegen generate` plus a clean build and test run.
>   Commit per task.
>
> Rules that bind this work (your `CLAUDE.md` and `AGENTS.md` have the rest):
>
> - **Never restate the contract.** A field you need that `docs/rest-api.md` does not name is a
>   change to the Mac repo first, not something to invent here.
> - Strict decoding: always-present fields go through `StrictObject` (a missing key throws, an
>   explicit `null` is `nil`). The documented exception is `health.ai`, which is absent on a Mac
>   older than this feature.
> - The bearer token goes in the `Authorization` header and nowhere else — not a log, not an error,
>   not a request body.
> - The Mac being off is an ordinary state with its own surface, not an error path. No local cache:
>   the transcript, the verdict and the rung die with the reader screen.
> - Readium is never patched; anything the toolkit cannot do lives in our code.
> - "Characters" on this route are **UTF-16 code units**, and text is cut at a Unicode-scalar
>   boundary — never between the halves of a surrogate pair.
>
> Escalate and hand back, rather than guess, if: the contract and the goldens disagree; a fact in
> the plan about Readium or URLSession turns out wrong (the plan was written without running its
> code, so expect small corrections and record each one); two consecutive repair attempts fail on
> the same test; or the work reaches beyond the files the plan names.
>
> When you finish, report: the new test count against the baseline, the commit for each task, every
> place the plan's code needed correcting, the outcome of any live pass against a real Mac, and
> anything the plan calls "not verified" that you did verify. Then stop.

---

## Four facts the Mac half measured, which the iOS plan predates

These cost this session real time. They are **now named in `docs/rest-api.md`**, which stays the authority — they are here so they do not arrive as a surprise mid-task.

1. **The ask route's body read has a 10 s total deadline, and it is not reset by data.** `BODY_TIMEOUT_MS` is a _total_ budget for the whole body, unlike the upload route's 30 s stall clock which every chunk resets. A phone sending the full 200,000-character section text over a slow tailnet link gets a bare `400 bad request`, indistinguishable from a malformed body. If your slice sends whole sections, this is the first thing to hit.
2. **The response's Content-Type is `text/event-stream; charset=utf-8` — the whole header, parameter and all.** A client that compares it for equality against the bare `text/event-stream` fails on every response. This repo's own smoke script strips the parameter (`sed 's/;.*//'`) before comparing; match the start, or accept the parameter.
3. **A `done` whose `reason` is `canceled` can never arrive.** It is one of the service's four settle values and the route drops it before the wire, because a client that hung up is not reading. Do not plan an event that cannot arrive — cancellation is a disconnect, and nothing more is sent.
4. **Two member names collide across the directions.** The request's `section.truncated` is a **boolean** (the phone saying _it_ cut the text it sent); the disclosure's `truncated` is an **array** of member names (the Mac saying it cut a member it was about to send). Same word, opposite direction. A client that decodes one into the other reports the wrong cut. The `members` vocabulary is likewise over the request's own member names, and `highlight` and `passage` are the two that mean something other than a field of the request body.

---

## If you bring up an isolated Mac to test against

Slices 3–4 want a live Mac to talk to. Do **not** point the phone at the real library or a real profile. Four traps this session hit, all measured:

- **Use `MUSAEUM_USER_DATA`.** The `verify` skill in the Mac repo (`.claude/skills/verify/SKILL.md`) carries the recipe. A scratch profile and a scratch library are cheap; the real profile's database should keep its old mtime throughout.
- **A scratch library needs at least two books**, not one — a pre-existing smoke check asks for `limit=2`, and a one-book library fails it.
- **The scratch profile's database cannot be seeded by piping all eight migrations through `sqlite3`.** `002_sort_keys.sql` calls `musaeum_sort_title`/`musaeum_author_sort`, SQL functions only the app registers on its own connection, so `sqlite3 < 002…` dies with `no such function`. Apply `001_initial.sql`, write the `app_config` rows (`library_root`, `rest_api_enabled`, `rest_api_bind`, `rest_api_port`, and `ai_model` when you want the 200 branch), set `PRAGMA user_version = 1`, and let the app's own runner apply 002–008 at boot.
- **Launch with `env -u ELECTRON_RUN_AS_NODE`**, or the app runs as plain Node and dies with no window. And the app is branded `Musaeum.app`, so `pkill -f "electron-vite dev"` and `pkill -f "node_modules/electron/dist/"` both **miss** it — the survivor is `node_modules/electron/dist/Musaeum.app/Contents/MacOS/Electron`; check with `lsof -nP -iTCP:<port> -sTCP:LISTEN` and clear it with `kill -9`.

The Mac side is already proven against an isolated profile on both branches, and the run logs are kept at `~/.hermes/profiles/dev/cache/scratch/smoke-ask/` (`run-503.log`, `run-200.log`, `run-bookless.log`) — worth reading before you build your own harness, since they show exactly what the wire does in each state.

---

## One tool hazard worth knowing before you read any file

**A `read_file` on the Mac repo (and possibly on yours) masks secret-shaped text.** This session's tooling printed `google_books_api_key` as `googl...key` and key _values_ as `***`, while the bytes on disk were intact. A subagent that copies a masked literal into a fixture produces a **vacuous** assertion that passes while proving nothing. The mitigation is a byte-level probe (`shasum`, a length count, a substring test) rather than trusting the read.
