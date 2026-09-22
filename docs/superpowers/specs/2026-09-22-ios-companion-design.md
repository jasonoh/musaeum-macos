# Design: the iOS companion — a read surface, and progress that travels (iOS companion, v1)

**Date:** 2026-09-22
**Status:** **Signed off 2026-09-22 for all four slices** — the three forks settled the same day (D1/D2/D3 below) — to be built in order, with a report at each gate. **Slice 1a is in build.** Three of the readings this spec refused to guess were settled before the code started, and one of them changed the plan: the tailnet address *is* visible to the app (`os.networkInterfaces()` from inside the Electron main process returns `utun9 100.125.135.108`, verified on Electron 37.10.3, the version this repo ships), the default port is **8788** (8787 is the Hermes WebUI, and a plain bind test cannot tell you that on macOS — BSD `SO_REUSEADDR` lets a specific-address bind succeed under a wildcard listener), and a byte-size census of the live library fired the deferred range-request item's own revival condition, against the figure it named (**D15**, **AC15a**).
**Scope:** a JSON HTTP API served by the running app over the tailnet, plus the reading-progress write, so a bespoke iOS app can browse and search the library, pull a book, read it on the phone, and resume where the Mac left off — and vice versa. It does **not** cover any other write (no metadata edits, no status marks, no device sends), does not render the Mac's reader UI on the phone, changes nothing in `metadata.json`'s shape, and does not build the client in this repo.
**Depends on:** the staging this repo has carried since Phase 1 (`docs/architecture.md` → *iOS Companion — Architecture Staging*, `docs/project-overview.md` §5.13), the reading-state policy (`docs/invariants/reader.md`), the service layer as the only home for business logic (invariant 8), and the `app_config` conventions (`docs/invariants/settings-and-editing.md`)
**Interacts with:** `rest_api_enabled`, the flag that already exists for this exact consumer; the `musaeum://` cover route (`electron/main/index.ts:64-83`), whose path rules this feature has to **share** rather than copy; `db.getBooks` / `db.searchBooks`, which cannot paginate today; `EditableSettings` and the Settings dialog; and `ReaderEngine.tsx:176-184`, which is the mechanism the entire cross-device claim rests on
**Supersedes:** nothing. It **discharges** the two Post-MVP entries in `tasks.md` (*iOS companion app (REST API activation; contract already staged)* and *REST API (stub present at `electron/main/api/rest.ts`, disabled)*) and leaves the OPDS spec's **D3** standing — two flags, two unrelated consumers.

---

## Why now

The staging note promised this feature would be cheap to add later, and a session on 2026-09-20 verified five of its six claims against the tree rather than taking them on trust. What that session could not do was decide the product question, so it left two forks open and ended. This document settles them (D1–D3) and writes the thing it offered to write.

The measurements below were taken today, read-only, against the live dev database (`~/Library/Application Support/Musaeum/musaeum.db`, root `/Volumes/books/musaeum`).

**The library is 7,100 books, and three quarters of it is readable by a phone.**

| Fact | Number |
| --- | --- |
| books in the cache | 7,100 |
| hold an **epub** | **5,324 (75.0%)** |
| hold mobi / azw3 | 2,719 / 418 |
| hold a pdf | 1,798 |
| carry reading state (`reading_updated_at` set) | **4** |
| `read_status` other than `unread` | 1 |
| `device_history` rows (sends) | 113 |
| unresolved conflicts | 0 |

*(Format rows are not a partition — a book may hold several.)*

**The in-app reader has been used on four books since it shipped on 2026-08-13, and the phone is the device the owner actually reads on.** That is not an argument against reading in the app — it is the whole argument for this feature. The Mac reader is the engine that had to exist first (it settled the position model, the palette and the file path); the phone is where the reading happens. 5,324 of these books are EPUB, which is the format a native iOS engine reads natively.

**The transport cost the OPDS spec called its main objection is already paid.** This Mac is `westerlund` (100.125.135.108) and the owner's iPhone — `almach`, renamed from `iphone182` — is on the same tailnet under the same account, online right now. `tailscale serve` and `funnel` have **no config**: what exists is a private WireGuard link between two devices, not a port on a LAN. The OPDS spec (D4) reasoned that a network surface on the box holding the library is a posture change worth being reluctant about; here that surface is a tunnel that already exists and is authenticated by the tailnet itself, which is why D3 below is tailnet-only rather than a port.

**Two claims from the 2026-09-20 readiness session are wrong, and both are worth correcting before they shape a build.**

1. *"The position coordinate is the real design fork… the one fork here I'd call genuinely hard."* It is not, and the tree already says so twice. `position` is documented as **opaque to Musaeum** — "an EPUB CFI, whatever mobi.js yields for KF8, a page number for PDF — because three engines have to share one schema and none of them agree on a format", with `percent` as "the portable fallback: when a position no longer resolves, the reader seeks to the fraction instead" (`src/types/book.types.ts:55-61`, and the same sentence in `docs/invariants/reader.md:72`). And the reader **already implements the fallback**: `ReaderEngine.tsx:176-184` calls `view.goTo(initial.position)`, and when that is null or returns `undefined` it seeks by `goToFraction(initial.percent)`, with a `try/catch` around the seek because "`goToFraction` throws for books with no section-size index" (`:223-230`). So a book whose shared coordinate is a **fraction** resumes correctly on the Mac today, with no renderer change and no locator⇄CFI translation layer. That is what makes reading-in-v1 affordable (D5).
2. *"An iOS client reading the library would show Google's title where the Mac shows yours."* No — the lock is not in the read path at all. A field override stops a **fetch** from moving a field (`importer.hydrate` + the reply filter), and the Mac's `books` row already holds the value the user set; any client that reads that row sees the user's value. Nothing in this design fetches metadata, so locks are invisible to it by construction and need no representation on the wire. (`field_overrides` is still machine-local and still needs to become portable — that is `docs/superpowers/specs/2026-09-20-portable-decisions-design.md`, a different workstream, and this feature neither waits on it nor collides with it.)

**Thesis, one sentence:** the library's own data model is already client-neutral — the row carries no engine-coupled coordinate that a second reader cannot use, covers already ship at two mobile sizes, paths are relative to the library root, and every query the phone needs already exists in the service layer — so what this feature adds is a wire, a token and one carefully-ordered write, not a data model.

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| The REST stub, 14 lines that only `console.warn` | `electron/main/api/rest.ts:11-14` |
| Its single call site, inside `app.whenReady` | `electron/main/index.ts:233` (block opens at `:162`) |
| The flag that gates it, `false` in the live config today | `rest_api_enabled` — `docs/data-contracts.md:152`, measured today |
| The book-bytes resolver: format allowlist, **extension** resolution, traversal rejection, realpath of **both** root and candidate | `electron/main/services/book-bytes.ts:18` |
| Cover resolution, by contrast, is **inline in the protocol handler** — traversal check, join, 404-on-missing | `electron/main/index.ts:64-83` |
| The query surface the phone needs | `db.getBooks` `:206`, `db.getBook` `:274`, `db.searchBooks` `:295`, `db.getFacets` `:496` |
| The progress writer, with the whole tiering policy inside it | `reading-state.saveProgress` `reading-state.ts:78`; `db.setReadingState` `db.ts:381` |
| The reader's restore: position first, fraction as the fallback | `ReaderEngine.tsx:176-184`; the fraction seek and its guard `:223-230` |
| `goToFraction` is a public engine method | `src/types/foliate-js.d.ts:103` |
| `position` is documented opaque; `percent` documented portable | `src/types/book.types.ts:55-61`, `docs/invariants/reader.md:72` |
| The IPC layer is thin — 11 files, **464 lines**, largest 110 | `electron/main/ipc/*.ts` (measured today) |
| Settings is the one writer of the editable config, with validation before write and delete-on-clear | `services/settings.ts:27`, `:112`, `:136`; `src/types/settings.types.ts:22` |
| The prior art for a server in this repo — routing, auth, failure semantics, ownership, all decided | `docs/superpowers/specs/2026-09-19-opds-catalog-design.md` (D3, D4, D6, D7, D8) |
| The stalled-mount exposure a server must respect | `tasks.md:110` — `fs.readdir` on a stalled SMB mount holds a libuv threadpool slot |

**Not true today, and inside this feature rather than free:**

- **Nothing that listens.** No server code exists; `rest.ts` is a warning.
- **No pagination.** `getBooks` (`db.ts:206-242`) and `searchBooks` (`db.ts:295-312`) return **every** matching row. A whole-library payload is not something a phone should walk: a 5-row sample of title + description + tags measured 32 / 363 / 597 / 6,851 / 7,750 bytes, so 7,100 rows is single-digit megabytes per fetch. Pagination has to be added *to the existing builder* (D7).
- **Cover path rules live where they cannot be tested** — inside an Electron `protocol.handle` callback. A second consumer has to either share them or duplicate them (D8).
- **No credential exists**, and `rest_api_enabled` has never been `true`, so no code path has ever refused an unauthorized request.
- **No client.** Nothing has ever cached a book, held progress, or spoken to a Mac that is asleep.

---

## D1 — v1 includes reading, and the client is its own repository

**Decision:** the iOS app is a bespoke SwiftUI app in a **new repo** (`~/Projects/musaeum-ios`), built against a REST API activated in this repo. v1 of the workstream ends with a book readable on the phone that resumes where the Mac left off, and the position travelling the other way. This repo's slices are the *server*, the *contract* and the *Settings surface*; the client's own plan lives in its own repo, and the frozen contract here is its input.

**Why:** reading on the phone is the point of the workstream — 5,324 EPUBs and a reader that has been used on four books, because the Mac is not where reading happens. The alternative that was offered and declined (activate the already-specified OPDS server and use a store-bought OPDS client) buys reading on the phone sooner but cannot carry a Musaeum grid, a to-Kindle flow, or a position write — OPDS is a delivery protocol and its own spec says so in as many words (`opds-catalog-design.md`, *What OPDS is, and what it is not*). Choosing the bespoke app means OPDS stays exactly where its precondition puts it: not built without a device that speaks it.

**Consequence:** two repos, one contract. This repo cannot gate Swift, so the contract has to be *testable without the phone* — golden payloads in this repo's tests and a `curl` walkthrough a human can run (D12) — and the client repo's README points at this repo's `docs/rest-api.md` rather than restating it.

## D2 — A JSON API over `node:http` in the main process, behind the existing `rest_api_enabled`

**Decision:** `electron/main/api/rest.ts` becomes a thin `node:http` server — routing switch, auth check, byte streaming — and the logic it needs lives in `electron/main/services/api/` as pure, testable modules. The surface is activated by the flag that already exists for it, `rest_api_enabled`. **No new dependency** (no express, no router, no schema library) and **no new flag**.

**Why:** this is the OPDS spec's architecture (its D7 — "node:http + a switch + one auth check") applied to a JSON surface, and it keeps invariant 8 intact: `api/` is thin, `services/` owns behaviour, and anything that can be a pure function of inputs becomes one so the suite can decide it without a socket. Reusing the flag is the other half of that spec's D3: it explicitly reserved `rest_api_enabled` for this consumer and introduced `opds_enabled` rather than overloading it, so enabling one can never change the meaning of the other.

**Consequence:** `docs/architecture.md:90` stops saying "REST stub", and the app's process model gains a listener that must be visible in it.

## D3 — Tailnet-only bind, generated bearer token (settled)

**Decision:** the server binds the **tailnet address** and requires `Authorization: Bearer <token>`, where the token is generated (`crypto.randomBytes(32).toString('hex')`) on first enable, stored in `app_config`, compared with `crypto.timingSafeEqual`. The address is resolved by a **pure function over `os.networkInterfaces()`'s shape** — the Tailscale interface carries an address in `100.64.0.0/10` — with an explicit `rest_api_bind` override, and a refusal to bind a non-tailnet, non-loopback address unless the override names it exactly. Unauthorized requests get **401** with `WWW-Authenticate: Bearer`.

**Why:** a phone cannot reach loopback, so the OPDS spec's loopback-default (D4) does not transfer; what transfers is its reasoning about TLS — "Musaeum will not terminate TLS in-app", delegated to a transport that already has a good answer. Here that transport exists, is private, is per-device authenticated by the tailnet, and needs no certificate work: the credential still travels, but inside WireGuard. The token is not redundant on top of that — the tailnet has four other devices on it (`westerland`'s peers include `canismajoris`, `cognos`, and the tailnet is one account) — and D8's precedent (a generated token over a user-chosen password, because a token only ever used here cannot be a reused credential) is adopted wholesale.

**Rejected:** `0.0.0.0` — a bearer token crossing the LAN in the clear, for a device that never leaves the tailnet. Loopback-plus-your-own-tunnel — it makes the app's most important setting a thing the owner has to build elsewhere, and the tunnel is already there. No authentication on the tailnet — it makes every tailnet device a reader of the library, and the token costs a Settings row.

**Reversal:** a device that must reach the library and cannot join the tailnet. At that point the answer is a real certificate, not a wider bind.

## D4 — Read-only, plus one write: the reading-progress report

**Decision:** every route is a `GET` except `PUT /api/books/{id}/reading`, which takes a progress report. That write is not a new implementation: the route calls **`reading-state.saveProgress`** with the report the phone sent. Metadata edits, read-status marks, deletions and device sends are **not** in v1.

**Why:** this is the difference between "the phone is a second reader" and "the phone is a second editor", and only the first was asked for. Reusing `saveProgress` is what makes the one write safe: the phone's progress lands in SQLite, advances `read_status` by the same `nextReadStatus` rule (never demotes), respects the metadata.json throttle, parks itself when the share is offline, and is flushed by the quit handshake — all of it already implemented and already tested (`reading-state.test.ts`). A bespoke writer for the phone would have to re-derive every one of those rules, and the first one it would miss is the tiering that keeps a page turn from costing an SMB write.

**Consequence:** the phone can move a book's position and its read status *forward*. It cannot mark a book read out of order, edit a title, or send to a device — and because those are absent by decision rather than by oversight, each is a new `PUT` when it is wanted, at which point the lock/override question arrives with it (a phone edit would be a user edit and would have to mark overrides exactly as `markFromPatch` does).

## D5 — The phone's report carries a fraction, and blanks the position

**Decision:** `PUT /api/books/{id}/reading` takes `{ percent, at? }` — no position member at all — and is applied as `saveProgress({ bookId, position: **null**, percent, final: true, at })`. Writing `null` into `reading_position` is deliberate: it is what makes the newer fraction win on the Mac.

**Why:** the two engines' coordinates cannot be compared, and the *only* thing that can decide which is newer is the clock. If the phone's report left `reading_position` untouched, the Mac would resume by `goTo(staleCfi)` — the reader tries position first and only falls back when it is null or unresolvable (`ReaderEngine.tsx:176-180`) — so a phone that read to 60% would have no effect on where the Mac opens. Blanking it turns the Mac's restore into exactly the path it already documents: null position, `percent 0.6`, `goToFraction(0.6)`. The Mac's own next save writes a fresh CFI, so the null is a transient that means "the shared coordinate is a fraction right now", which is true.

**Rejected:** sending the phone's Readium locator and storing it in `reading_position` — it would be a coordinate the Mac's engine cannot consume, so it buys nothing and costs the Mac its own precise CFI anyway; the wire stays engine-neutral, which is also what keeps the client's engine choice (Readium, or foliate-js in a `WKWebView`) free. **Rejected:** a per-device position map — a migration plus a `metadata.json` change, which is `docs/superpowers/specs/2026-09-20-portable-decisions-design.md`'s ground (it already owns per-field clocks) and must not be pre-empted here.

**Consequence:** a book the Mac last read precisely resumes at a fraction the first time the phone has written to it — the position is *lost* where the fraction is coarse, and a chapter-level ±1% is the cost. **Reversal:** a book where the fraction fallback is unavailable (no section-size index — the `catch` at `ReaderEngine.tsx:227-229`) *and* the phone has destroyed the CFI. Both halves are measurable and neither is measured yet: see *Not verified*.

## D6 — A report is ordered by the clock, and a stale one is refused

**Decision:** the report may carry `at` (ISO). The server applies it only when `at` is absent or not older than the row's `reading_updated_at`; otherwise it answers `200 { applied: false }` with the current state, and writes nothing.

**Why:** every Mac-side writer is the newest by construction, so `saveProgress` has never needed a comparison. The phone breaks that: it queues progress while the Mac is asleep or the share is down, and a flush after a week of Mac reading would drag the book backwards if it were applied blindly. This is the same class as the tie rule adoption already uses (equal or unparseable timestamps give the incoming record the say — `invariants/reader.md`), which is why `at` absent means *apply*, not *refuse*.

**Consequence:** the client must send `at` for queued reports and may omit it for a live read. A phone whose clock is wrong can be refused by its own past or win an argument it should lose — accepted, bounded to one book, and the same residual the portable-decisions spec records for two machines' clocks.

## D7 — Pagination goes into the existing query builder

**Decision:** `db.getBooks` and `db.searchBooks` gain optional `limit` / `offset`, and one `countBooks(filters)`-style total, on the *existing* SQL and the *existing* `orderClause`. The API paginates; the renderer's call sites stay exactly as they are (no limit = today's behaviour). The response carries `{ books, total, limit, offset }`.

**Why:** a second SQL path is how the sort-key rule (invariant 4) and the filter rules drift between the UI and this feature — the OPDS spec flagged this as "the first thing to check during implementation" and it checked out negative: neither function admits limit or offset today. `orderClause` (`db.ts:262-272`) is also where the `id` tiebreak lives, and it is precisely what a paginated list needs — without it a tied sort can reorder between pages and a book can appear twice or vanish, which is the failure the tiebreak was added for.

**Rejected:** paging in the API layer over a full result set (the whole library, serialized per page). **Deferred:** a `count(*)` facet total per page — `getFacets` is already an aggregate over the whole library and is fast enough to fetch once (`db.ts:496`).

## D8 — Cover resolution moves into `book-bytes.ts`, and both consumers call it

**Decision:** the cover rules currently inline in the protocol handler (`index.ts:64-83`) become `resolveCoverFile(bookId, size)` in `electron/main/services/book-bytes.ts`, next to `resolveBookFile`. The `musaeum://cover/…` handler calls it; `GET /api/books/{id}/cover?size=` calls the same function.

**Why:** the rules are a security boundary — traversal rejection, a join under the library root, 404 rather than a thrown error — and a boundary written twice is a boundary whose wrong half is the network-facing one. This is the OPDS spec's D6 verbatim ("a second resolver written beside it would be a second place to get that wrong"), and it is also `docs/invariants/reader.md:33`'s own rule: the path rules live in that service rather than in the protocol handler *so they can be tested without Electron*. That sentence is currently true of book bytes and false of covers; this slice makes it true of both.

**Consequence:** `index.ts` shrinks, and the cover route's behaviour is pinned by a unit test instead of by looking at the app. The extraction must not change what the handler answers today — the same paths, the same 400/404 split — and that is an acceptance criterion (AC11).

## D9 — The hot path reads SQLite; bytes stream, with a bounded number in flight

**Decision:** list, detail and search answer from SQLite and never touch the NAS. Cover and book bytes are streamed (`fs.createReadStream` + `pipeline`, `stat` for `Content-Length`) rather than buffered, and at most **2** byte transfers are in flight at once; the overflow answers `503` with `Retry-After` rather than queueing in the threadpool.

**Why:** `tasks.md:110` records that `fs.readdir` on a stalled SMB mount holds a libuv threadpool slot and that "several hung reader requests could stall other main-process fs work" — a race today, and a certainty once a phone pages covers over a stalled share. The default pool is 4 slots *for the whole process*: the app's own cover loads, catalog writes and hydration reads share them. The cap is deliberately small so the app always has a slot left, and a 503 the client retries is better than a Mac whose library view freezes because a phone asked for 300 covers. Streaming rather than `readFile` bounds memory as well — one book here is up to a few MB, and `readFile` would hold each one whole in the main process.

**Consequence:** the client must treat 503 as retryable. The cap is a bound to revisit with a measurement, not a law: the first number was chosen to leave the pool headroom, not measured under load.

## D10 — The wire carries a shaped payload, not the row

**Decision:** responses are built by pure functions in `services/api/shape.ts` from `Book` rows, with an explicit field list — the book's identity and metadata, its `formats`, its `fileSizeBytes`, a `cover` object carrying the two sizes with their **version** (`src/lib/cover-url.ts`'s rule, so a replaced cover is not answered from a cache), and `reading: { status, percent, updatedAt }`. `nasPath`, `sortTitle` and `authorSort` do **not** cross.

**Why:** the consumer is outside this repo and outside this language, so the wire shape is a contract rather than a projection of a table — a column rename should be a deliberate contract change, not a silent client break. The derived sort keys are omitted because sorting is done **server-side** (the `sort` parameter, invariant 4's keys, one implementation); the Mac's CFI is omitted because it is a coordinate no other engine can use (D5); `nasPath` is omitted because it is the library's internal layout. The cover version is carried because the renderer already learned this lesson the hard way — a constant URL is answered from Chromium's cache, and the fix was a version on the URL (`CHANGELOG`, 2026-09-21).

**Consequence:** `docs/rest-api.md` is the contract document, and a field added to `Book` does not appear on the wire until someone adds it to the shaper and to that document.

## D11 — Failure semantics: a server that is never a dependency (invariant 12)

**Decision:** a bind failure is logged, recorded on a status surface the Settings row reads, and the app starts normally. With the NAS offline, list/detail/search answer **200** from the cache and byte routes answer **503**. Unknown book, unknown format, a format the book does not have, a traversing path and a missing file all answer **404**, uniformly and reason-free, exactly as the `musaeum://` routes do. No library configured answers **503**. A handler never throws out of the request, and neither does one throw at the process.

**Why:** this is invariant 12 plus the OPDS spec's failure table, which already worked out the shapes and their reasons. The uniform 404 is deliberate: "the `musaeum://` routes answer 404 rather than leaking which of the reasons applied", and a network surface has no business knowing better.

## D12 — The contract is provable without a phone

**Decision:** three artifacts carry the contract, all in this repo: `docs/rest-api.md` (routes, payload shapes, auth, failure table, version), golden payload cases in `services/api/shape.test.ts`, and `scripts/api-smoke.sh` — a re-runnable walkthrough that reads the token from the app's own database and exercises the routes with `curl`, printing PASS/FAIL per line. `GET /api/health` carries `apiVersion: 1` and the client checks it.

**Why:** the client lives in another repo that this repo's gates cannot reach. Without a frozen, executable contract, the only thing keeping two repos in step is memory — and the first thing to rot would be the payload field list, which is exactly what D10 exists to make explicit. The smoke script is the OPDS spec's own gate ("`curl` checks of the auth paths"), and its value is that the *next* session can re-run it rather than re-derive it.

**Consequence:** a contract change is a change to the document **and** the goldens **and** the script, in one slice.

## D13 — Settings owns four keys and generates the token; the row is the last slice

**Decision:** `rest_api_enabled` (exists), `rest_api_port` (default chosen at build, avoiding 8787 — taken on this machine), `rest_api_token` (generated on enable, never typed by hand), `rest_api_bind` (empty = the resolved tailnet address). They join `EditableSettings` and `app_config`, follow the existing rules (validate before write, clearing deletes the key, a failed save leaves the previous settings intact), and the row that surfaces them — plus the listen status — is the **last** slice.

**Why:** the keys must exist before the server can be configured, but the UI's evidence is a running-app probe and the renderer has no DOM harness, so it is the expensive instrument and it comes last (the house rule). Adding the fields to `EditableSettings` rather than reading keys ad hoc is what turns "did I wire this everywhere?" into a compile error — the record is typed `Record<keyof EditableSettings, string>` (`services/settings.ts:27`) and `SettingsView` is explicit, so the type checker enumerates the write paths.

**Consequence:** `docs/data-contracts.md:152`'s sentence — "All but `rest_api_enabled` are editable in Settings" — becomes false and is corrected in slice 2's pass; `docs/invariants/settings-and-editing.md:22` gains the new keys. A generated token is masked in the UI with the full URL shown for typing into the phone (the OPDS spec's own Settings shape).

## D14 — The Mac must be running, and the client caches so that *reading* does not need it

**Decision:** no daemon, no menu-bar agent, no launchd service. Fetching and progress-syncing work only while the app is open on the Mac; the client **downloads the file into its own store** and keeps its own progress, so a book already pulled reads with the Mac asleep, the share dropped, or the phone on a plane. A queued progress report is flushed when the server next answers, ordered by D6's clock.

**Why:** the library is on SMB and the phone cannot reach it, so a server that outlives the app would have to own a second lifecycle — launchd, the mount, the sidecar's Python environment, the theme's config reads, and every service this repo keeps in-process (`docs/architecture.md`'s process model is one Electron app plus one child Python). That is a different project, not a slice of this one. What makes the "macOS app as server" shape tolerable for a *reader* specifically is that reading is not a request-streaming activity: the bytes come once, and everything after that is local. So the constraint bites at exactly two moments — the first fetch of a book, and the flush of a position — and neither is a moment when the owner is likely to be reading.

**Rejected:** a small always-on daemon serving the cache (a second process to install, update, secure and keep in step — and it would need its own answer for the mount, the sidecar and `app_config`). **Rejected:** a scheduled sync that pulls the next N unread books while the app is open (it is a good idea and it is not v1: it needs a policy for what to pull, storage to manage on the phone, and a deletion story for the phone's own copy — its own spec if it is wanted) — but note it is the *cheap* answer to this risk later, because it is client-side only.

**Consequence:** "I want a new book right now and the Mac is shut" has no answer in this design, and that is the moment a companion most wants to feel whole (risk 1). The reversal condition is behavioural, not technical: this becomes a daemon/sync feature when the owner finds himself wanting the library while the Mac is asleep and cannot wait for it.

## D15 — Downloads are resumable, because this library's largest books are not small

**Decision:** `GET /api/books/{id}/file` accepts a single-range `Range: bytes=N-` request and answers **206** with `Content-Range` and `Accept-Ranges: bytes`; a request with no range is unchanged (200, the whole file). A malformed or unsatisfiable range answers **416**. The client resumes a dropped transfer from its own partial file instead of restarting it.

**Why:** the spec deferred range requests with a written revival condition — "revived by a book large enough that a phone download hurts (a 6 MB mobi over the tailnet is not that)" — and **the figure in that sentence was a guess, not a measurement, and it fired the condition against itself.** Measured today, read-only, against the live library: **80 books whose EPUB exceeds 100 MB**, and the largest EPUB files are **528 MB** (*Marie Kondo's Kurashi at Home*), **285 MB** (*Light From the Void*), **175 MB** (*Cosmic Queries*), **157 MB** (*Your Ticket to the Universe*) — these are the files themselves, not their folders' totals, checked on disk after the folder figure turned out to be ambiguous. A further **569** sit in the 20–100 MB band (the whole EPUB census: 1,505 under 1 MB, 2,175 at 1–5 MB, 995 at 5–20 MB, 569 at 20–100 MB, 80 over 100 MB). Without Range support a dropped transfer restarts from zero, and over a tailnet the longer a transfer runs the likelier it is to drop — so the books that most need resuming are exactly the ones worst to restart. A route with no `Range` is what the OPDS spec chose, deliberately; that spec serves *other people's clients*, where you cannot rely on a resumption convention, while this route serves one client we write.

**Rejected:** multi-range requests (resuming one file needs one range) and `HEAD` probing (the length arrives on the first response anyway). **Consequence:** the byte route gains one status (416) and keeps its 404/503 table unchanged; D9's concurrency cap now bounds a *long-lived* connection rather than a burst, which is the case the cap was chosen for; and the criterion is named in the AC list as **AC15a** — after a `Range: bytes=N-` request the bytes served are the file's **tail from N**, byte-identical, not a re-sent head.

---

## The wire, concretely

Every route requires the bearer token; every response is JSON except the two byte routes. Base URL is `http://<tailnet-address>:<port>`.

| Route | Answers |
| --- | --- |
| `GET /api/health` | `{ apiVersion, version, books, library: 'online' \| 'offline' }` — the client's connect check |
| `GET /api/library?q=&sort=&dir=&limit=&offset=&authors=&series=&tags=&formats=&readStatus=&minRating=` | `{ books: […], total, limit, offset }`; `q` uses the app's own FTS path, so a phone search and the Mac's search agree |
| `GET /api/library/facets` | the app's `LibraryFacets` — the filter counts, computed once |
| `GET /api/books/{id}` | one shaped book |
| `GET /api/books/{id}/cover?size=thumb\|full` | `image/jpeg` |
| `GET /api/books/{id}/file?format=epub` | the bytes, `Content-Length`, a type from `BOOK_FILE_EXTENSIONS`' map |
| `PUT /api/books/{id}/reading` | body `{ percent, at? }` → `{ applied, book }` |

`limit` defaults to 100 and is capped (500). The client's list is paged; a book detail is one request; the reading state it resumes from is inside the book payload it already fetched.

## Store and component shape

No renderer state exists in this feature until slice 2, and then only the dialog's own local fields — `SettingsModal.tsx` reads `settings:get` and writes `settings:save` like every other field, and the listen status is resolved into `SettingsView` in the main process rather than held in a store. Nothing about the API is persisted in the renderer: no Zustand field, no localStorage, and no new `musaeum://` host.

---

## Acceptance criteria

### Slice 1a — the pipe (server, credential, config)

1. With `rest_api_enabled` unset or `false` (the default), **nothing listens**: a connection to the configured port is refused, and `npm test` shows no server started. *Decider:* a case that starts the app's activation function with the flag absent and asserts the listen was never attempted (the port probe is the same assertion made by the machine).
2. A request with no `Authorization` header answers **401** with `WWW-Authenticate: Bearer`; a wrong token answers 401; the right one answers 200. *Decider:* unit cases against the request handler, plus one `curl` line in `scripts/api-smoke.sh`.
3. Token comparison is **constant-time** and a failed attempt logs the client address and never the credential. *Decider:* a source walk over `services/api/auth.ts` stating its own limit inside the test (a unit case cannot observe timing), asserting `timingSafeEqual` is the comparison and that the log call carries no token.
4. Bind-address resolution is a **pure function** over an interface map: a tailnet address in `100.64.0.0/10` is chosen; `rest_api_bind` overrides it; a non-tailnet, non-loopback override is refused with a reason. *Decider:* cases over fixture interface maps — never the machine's own interfaces, which are not a fixture.
5. A bind failure is **non-fatal**: with the port already occupied, activation returns an error the app records, and the app's own start-up path is unaffected. *Decider:* a unit case binding a socket first, asserting the recorded status and that the process did not throw.
6. Enabling (a `saveSettings` call with `restApiEnabled: 'true'`) **generates** a token when none exists, writes it, and a second enable does not replace it. *Decider:* unit case over a temp database.
7. `index.html` (the repo root, where the CSP lives) is untouched — no CSP change. *Decider:* `git diff --quiet index.html`.
8. `npm run typecheck` (0), `npm run lint` (0), `npm test` green, prettier clean on touched files.
8a. **Starting and stopping are symmetric (added 2026-09-22, after the build).** `stopRestApi()` closes the listener activation opened; afterwards the port **refuses a new connection**, a second stop does not throw, and a stop with nothing started is a settled no-op. If the close *fails* the status says `failed` with a reason rather than `disabled` — a status claiming a dead socket while one is still listening is the exact lie the function exists to prevent. *Why it is in 1a and not slice 2:* criterion 27's decider ends "…then disable and confirm the port is refused", and slice 2's file row is `SettingsModal.tsx` plus two documents, so a lifecycle path had nowhere else to live — the alternative was a slice-2 row that edits `api/rest.ts` and breaks its own file budget. *Decider:* a case over a real socket on `127.0.0.1:0` — a connection succeeds before the stop and is refused after it; an assertion on the status record alone would pass with the socket still open. **Failure mode seen once:** with the `close()` removed the case fails — 1098 pass, and the failure is an authenticated 401 arriving on the port that had just been reported dead. **Two things the pre-merge review added to this criterion, both recorded rather than smoothed over:** (1) its *failure half* — the status saying `failed` when the close fails — is a **code-read, not a decided claim**: the `!listening` guard excludes the one error Node documents for `close()`, so no case reaches it and none can while `openServer` is module-private; a `close` seam beside the existing `listen` seam is what would decide it. (2) A stop arriving **while the bind is in flight** used to be lost — the stop took the "nothing was started" branch, and the activation then opened a socket nobody held a reference to. Activation now captures an epoch and loses to a newer stop; the case holds a real listener past a gate, and **with the epoch check removed that case is the only failure: `expected 'listening' to be 'disabled'`**, which is the socket opening behind a status that says the opposite.

### Slice 1b — the read surface

9. `GET /api/library?limit=…&offset=…` returns exactly `limit` rows, and the same order as the app's own list for the same `sort`, against a fixture library. *Decider:* a comparison against `db.getBooks({ sort })` over the same fixture.
10. Every page of a small fixture library, walked to exhaustion, yields each book id **exactly once** — including under a sort whose keys tie. *Decider:* fixture with deliberately tied authors.
11. `q=` returns the same ids as `db.searchBooks` for that query. *Decider:* fixture comparison.
12. `getBooks()` with no `limit` behaves exactly as today: the existing suite stays green, and one case asserts the unpaginated path explicitly. *Decider:* existing tests plus one named case.
13. `resolveCoverFile` answers the same path the protocol handler resolved before the extraction, and `null` for a missing cover, a traversing path, and a size it does not know. *Decider:* unit cases over a temp library — the extraction's whole point is that this is now testable without Electron.
14. `GET /api/books/{id}/cover?size=full` serves bytes **identical to the file** (hash compare) with `image/jpeg`; 404 for a book with no cover, an unknown id, and a traversing path. *Decider:* fixture library + hash.
15. `GET /api/books/{id}/file?format=…` serves bytes identical to the file on disk with a correct `Content-Length`; 404 for an unknown format, a format the book does not have, an unknown book, and a traversing `nasPath`; **503** with the NAS offline. *Decider:* fixture + a stubbed offline state.
15a. **A resumed download serves the tail, not a re-sent head (D15).** A request carrying `Range: bytes=N-` answers **206** with `Content-Range: bytes N-<total-1>/<total>` and `Accept-Ranges: bytes`, and the bytes it writes hash-match the file's own bytes **from offset N**; an unsatisfiable range answers 416 and a request with no range is unchanged (200, whole file). *Decider:* fixture library; hash the response against `fs.readFileSync(path).subarray(N)` — hashing the *tail* is the criterion, because a server that ignores `Range` and re-sends the head still answers 200/206-shaped bytes and would pass any weaker test. The first slice the reading in D15 was taken for: 80 books in this library hold an EPUB over 100 MB, so a re-sent head is minutes of transfer, not bytes.
16. The list/detail/search path touches **no NAS**: the read module's imports are asserted and contain no filesystem or `nas-manager` import. *Decider:* `grep -n '^import'` over the module — the import list is the evidence, not the assertion.
17. At most 2 byte transfers are in flight; the overflow answers 503 with `Retry-After`, and the app's own operations are unaffected while a transfer is stalled. *Decider:* unit case driving three concurrent requests against a stubbed slow read.
18. `scripts/api-smoke.sh` runs end to end against a live app on an isolated profile and prints a PASS/FAIL per route.
19. `docs/rest-api.md` exists and every route above appears in it with its payload shape and status codes; the golden cases in `shape.test.ts` match it field for field. *Decider:* the goldens are the decider — a field in the payload that the document does not name, or vice versa, is the drift this pair exists to catch.

### Slice 1c — progress that travels

20. A `PUT …/reading { percent: 0.6 }` writes `reading_percent = 0.6`, moves `reading_updated_at`, and leaves `reading_position` **null** (D5). *Decider:* unit case reading the row back.
21. A report whose `at` is **older** than the row's clock is refused: `applied: false`, and the row is byte-identical afterwards. *Decider:* unit case; the second half is the guard — "and nothing was written when nothing should be".
22. A report advances `read_status` exactly as the Mac's own do — `unread → reading`, `≥98% → read`, never a demotion. *Decider:* unit case asserting parity with `nextReadStatus`, including a `read` book reported at 5%.
23. With the NAS offline, a report still lands in SQLite and is parked for the next flush. *Decider:* unit case with `nas.isOnline()` false, asserting the row and the pending set.
24. An unknown book id answers 404 and writes nothing. *Decider:* unit case.
25. **The cross-device claim, on the real engine:** with a book whose row has `position: null, percent: 0.42`, opening it on the Mac lands at ~42% of the book, not at the first page. *Decider:* a CDP probe in the running app — only the real foliate instance can decide `goToFraction`, so no unit test can carry this criterion.
26. Round trip: after the phone's write, a page turn on the Mac writes a **fresh** CFI into `reading_position` while `reading_percent` moves with it. *Decider:* the same probe, plus the database read.

### Slice 2 — the Settings row, and where it says the server is

27. The row shows enable, port, bind, a masked token with a reveal, the full URL to type into the phone, and the live listen status — including the reason when a bind failed (AC5's surface). *Decider:* a CDP probe on an isolated profile: enable, read the URL and token off the screen, `curl` the health route with them, then disable and confirm the port is refused.
28. Enabling writes exactly the four keys and nothing else; clearing the bind restores tailnet resolution. *Decider:* database read before/after, compared key by key.
29. `docs/data-contracts.md`'s "all but `rest_api_enabled` are editable in Settings" is corrected, and `docs/invariants/settings-and-editing.md` names the four keys with their rules. *Decider:* the two files' diffs.
30. The app's existing Settings suite stays green. *Decider:* `npm test`.

---

## Slices, and why they are cut this way

**Slice 1a — the pipe (6 code files, 3 test files, 1 document — the whole slice at the bound, which is what forces the 1a/1b cut).** New: `electron/main/services/api/auth.ts`, `services/api/bind.ts`, their two test files. Edited: `electron/main/api/rest.ts` (rewritten from 14 lines), `electron/main/services/settings.ts` (three keys, token generation, validation), `src/types/settings.types.ts`, `electron/main/index.ts` (the call site becomes status-aware), `docs/architecture.md:90`. Stops at "a server that answers 401/200 and can be configured" — testable entirely in the suite, with no route that needs a library.

**Slice 1b — the read surface (5 code files, 2 test files, 2 contract artifacts).** New: `electron/main/services/api/shape.ts`, `docs/rest-api.md`, `scripts/api-smoke.sh`. Edited: `api/rest.ts` (the routes, **and `healthPayload()`'s count** — 1a counts with `getBooks().length`, which loads all 7,100 rows per call (~115ms by this repo's own measurement) on the route the phone uses as a connect check; this slice's paginated total is what that becomes, and it must not become a second `COUNT(*)` with its own filter rules, which is the drift invariant 4 exists to prevent), `services/db.ts` (`limit`/`offset`/total on the two existing builders), `services/book-bytes.ts` (+`resolveCoverFile`), `electron/main/index.ts` (the protocol handler calls it). Tests: `services/api/shape.test.ts`, `book-bytes.test.ts`. Stops before any write: everything here is a pure function of a library plus a socket.

**Slice 1c — progress that travels (2 code files, 1 test file).** New: `electron/main/services/api/reading.ts` + its test. Edited: `api/rest.ts` (one route). This is the smallest slice and deliberately its own: it is the only write, its rules (D5/D6) are the ones most likely to be argued with, and it can land or be held without blocking the read surface.

**Slice 2 — the Settings row (1 code file, 1 test file, 2 documents).** Edited: `src/components/settings/SettingsModal.tsx` (the row + its test), `docs/data-contracts.md`, `docs/invariants/settings-and-editing.md`. Last because the renderer's evidence is a running-app probe, which is the expensive instrument. **One thing the build must add (pre-merge review, 2026-09-22):** the server captures the token, the port and the bind **by closure at creation**, so a save that changes them leaves a running socket comparing the *old* credential until the next start — the file's own precedent (`sidecarAffected` → `sidecar.restart()`) has no equivalent for the listen-time keys, and `stopRestApi()` / `startRestApiIfEnabled()` now make one possible. Unreachable in 1a (the flag is off and nothing writes these keys); it fires the first time the toggle is used to *change* them rather than to turn them on.

**The client, in its own repo (~`/Users/jasonoh/Projects/musaeum-ios`).** Not a slice of this spec and not gated here: SwiftUI, a base URL + token, a list against `GET /api/library`, a detail, a downloader into the app's own store, a reader (Readium Swift is the candidate — general knowledge, not verified from this machine), and a progress writer that queues while the server is unreachable. Its first act is a plan in its own repo, written against `docs/rest-api.md` and the smoke script. **This repo's job is to make that contract frozen and executable, which is what D12 and AC19 are for.**

**Honest count: 11 distinct code files, 6 test files and 5 documents — 22 files touched across four slices**, roughly double what a single file-budget row would have claimed. That row would have counted the server and the routes and missed three things: the four consumers of the new config keys (settings, the shared type, the call site, the invariant doc), the cover-resolution extraction the byte route forces onto `index.ts` and `book-bytes.ts`, and the contract's own two artifacts (the document and the smoke script) that D12 makes load-bearing. The house rule is to name the split rather than discover it, and the split is the four slices above — each independently landable, each at or under the bound.

## Rejected and deferred, with the condition that would revive them

- **OPDS as the transport** — declined 2026-09-22 in favour of the bespoke app (D1). It cannot carry a position write, by protocol. Revived by a second reading device that speaks OPDS and nothing else; its own spec is written and is not re-opened here.
- **Writes beyond progress** (metadata edits, status marks, sends, deletes) — deferred, each needing its own route and bringing the lock/override question with it. Revived by the first time the owner wants to correct a book from the phone rather than walk to the Mac.
- **A per-device position map in `metadata.json` + a column** — deferred to `docs/superpowers/specs/2026-09-20-portable-decisions-design.md`, which already owns per-field clocks. Revived by D5's reversal condition firing (below).
- **Translating locators ⇄ CFIs** — rejected: a mapping layer for a coordinate the schema deliberately declares opaque, to buy precision the fraction fallback already approximates. Revived only if D5's reversal fires *and* the per-device map is refused.
- **Range requests / partial downloads** — **no longer deferred: D15 adopts them.** This item's own revival condition fired against the figure it named, and the figure was a guess — the library holds **80 books whose EPUB exceeds 100 MB**, the largest a **528 MB** EPUB, not the 6 MB mobi this sentence assumed. Left standing (rather than deleted) so the correction is legible and the next reader can see which measurement mattered. The OPDS scope it cites governs *other people's* clients; this route serves one client we write.
- **Delta sync (`?since=`)** — deferred. Revived when a full first-page fetch is slow enough for the client to page through the library on every launch, which the paginated list already makes unlikely.
- **TLS termination in-app** — rejected (OPDS D4), and unnecessary while the transport is WireGuard. Revived by D3's reversal.
- **`safeStorage` for the token** — deferred; `app_config` matches the Google Books key's precedent and the token exists only here. Revived by the owner wanting a human-readable password, or by a token that has to be shared with something else.
- **An always-on background service so the library is reachable with the Mac asleep** — rejected as a slice of this work (D14), with the client-side sibling named there. Revived by living the constraint rather than by reasoning about it.
- **Annotations and highlights over the wire** — out of scope. The reader has none, and their storage decision is unfinished for the Mac's own reader (`tasks.md`, reader section); a phone client would want them, and it must not get its own storage answer by accident.
- **A web UI in the renderer** — rejected; the client is the phone app.

## Risks, stated plainly

1. **The Mac must be awake with the app open, and there is no daemon** (D14 — this is the design's own choice, not an oversight). The library is on SMB, the phone cannot reach it, and while the Mac sleeps there is nothing listening. The mitigation is client-side and real: the phone **caches the file**, so reading works with the Mac off, the share dropped, or the phone on a plane — only *fetching* and *syncing progress* need the Mac. What this costs, honestly: the app cannot be the answer to "I want a new book right now and the Mac is shut", and that is the moment a companion most wants to feel whole.
2. **The app's first listener.** Everything in this repo's posture — "no account, no service, no listener" — is one flag away from being false. Mitigations: tailnet-only bind, a bearer token, and no route that writes except progress. The residual: the token lives in `app_config` in plaintext, and any tailnet device that has it reads the whole library. That was true of nothing before this.
3. **D5's fraction fallback may be unavailable for some books.** `goToFraction` throws for a book with no section-size index (`ReaderEngine.tsx:223-230`) and the catch opens at the *first page*. If the phone has also blanked the CFI, such a book silently loses its place. Both halves are measurable (see *Not verified*) and neither is measured yet — which is why AC25 is a live probe rather than a unit case.
4. **The stalled share.** `tasks.md:110`'s threadpool exposure becomes reachable by design (D9). The cap bounds it; it does not remove it, and the number 2 was chosen for headroom rather than measured under load.
5. **Two repos, one contract, and this repo cannot gate the other.** AC19 and the smoke script are the mitigation; the residual is that the client's own build quality is invisible from here, and a contract change lands in one repo before it lands in the other.
6. **The reader on the phone is a new engine's worth of behaviour, and the reader on the Mac has four books of history.** The reading experience — typography, page turns, position fidelity — is being rebuilt somewhere the owner will judge it by looking at it. Nothing in this repo's suite will say whether it is good.
7. **Invariants held:** 2 and 9 (extension-based resolution and realpath-both-sides — the byte routes reuse `resolveBookFile`/`resolveCoverFile` rather than re-implementing either); 4 (sorting stays in the existing SQL, D7); 5 (reading state survives the round trip — D5 is a change to *which* field carries the shared coordinate, not to whether it propagates, and AC26 is its decider); 8 (the HTTP layer is thin, all behaviour is in `services/`); 12 (D11). **Not touched:** 1, 3, 6, 7, 10, 11 — in particular `metadata.json`'s shape (nothing is added) and `vendor/foliate-js/` (the Mac's reader is not modified at all; the fraction fallback it needs already ships).

## Not verified — the readings this design refuses to guess, and what each one gates

Each of these is a *reading*, not a preference, and each has a throwaway harness outside the repo (the house rule: a harness costs no file in the slice's budget). Two of them gate slice 1a directly, which is why they come before any file of it is written.

1. **Does `goToFraction` work at open time on a real book?** The wrap at `ReaderEngine.tsx:223-230` suggests it can throw; what is unmeasured is how often, on *this* library, and whether the section-size index exists before the first paint. Harness: an isolated profile, a book row forced to `{position: null, percent: 0.42}`, open it by CDP, and read where it lands. **This is D5's whole premise** and it gates slice 1c.
2. **Does the tailnet address appear in `os.networkInterfaces()` from inside the app?** On macOS, Tailscale runs as a network extension and its address lives on a `utun` interface; nothing in this repo has ever enumerated interfaces. Harness: a one-line Node script run under Electron, printing the interface map; then the same read from the packaged build, where the process is launched by launchd's minimal environment. **Gates slice 1a** — D3's resolver has no other source for its default.
3. **How long does one book's bytes take over SMB, and does a transfer hold a threadpool slot long enough to disturb the app?** Harness: a timed fetch of the largest epub in the library plus a concurrent `getBooks` timing. **Informs D9's cap** in slice 1b, which is otherwise a number picked by eye.
4. **What port is free and sensible?** 8787 is taken on this machine (the Hermes WebUI). Harness: bind-scan the candidates before choosing the default. **Gates slice 1a's default.**

## Start here

Three commands, and the files worth reading first.

```bash
git log --oneline -3              # cbf1e5c is the commit this spec was written against
npm run typecheck && npm run lint  # both 0, measured 2026-09-22
npm test                           # 1026 passed / 48 files, measured 2026-09-22
sidecar/.venv/bin/python -m pytest -q sidecar/tests   # 113 passed
```

Then, in order: `electron/main/api/rest.ts` (14 lines, the whole starting point), `docs/invariants/reader.md` (the position policy D5 changes the *use* of, not the text of), `docs/superpowers/specs/2026-09-19-opds-catalog-design.md` (the server decisions this one reuses rather than re-derives), and `docs/invariants/settings-and-editing.md` (the four keys' rules, before touching `app_config`).
