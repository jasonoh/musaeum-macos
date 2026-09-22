# Slice 1c — progress that travels (annex)

**Why this file exists:** the spec (`docs/superpowers/specs/2026-09-22-ios-companion-design.md`) is the design. This annex is what a session with none of the conversation that built 1a and 1b needs, so that nothing here has to be re-derived: the criteria, the readings already settled, what must not move, and the one piece of work the pre-merge review handed to this slice on purpose.

**Criteria: 20–26.** The row: **new `electron/main/services/api/reading.ts` + its test; one route added to `api/rest.ts`.** 1c is the only slice that writes anything, which is why it is cut small and its own.

## The route

`PUT /api/books/{id}/reading` — body `{ percent, at? }` — answered `{ applied: true|false }`.

| Criterion | The rule, and the decider that carries it |
|---|---|
| **20** | `percent: 0.6` writes `reading_percent = 0.6`, moves `reading_updated_at`, and leaves `reading_position` **null** (D5). The phone writes the *fraction*; the CFI stays the Mac's. Unit case reading the row back. |
| **21** | A report whose `at` is **older** than the row's clock is refused: `applied: false`, **and the row is byte-identical afterwards**. The second half is the guard — "nothing was written when nothing should have been". |
| **22** | `read_status` advances exactly as the Mac's own writes do — `unread → reading`, `≥98% → read`, **never a demotion** — asserted for parity against `nextReadStatus` itself, including a `read` book reported at 5%. |
| **23** | With the NAS offline a report still lands in SQLite and is parked for the next flush (`nas.isOnline()` false; assert the row **and** the pending set). Invariant 12's non-fatal discipline, unchanged. |
| **24** | An unknown book id answers 404 and writes nothing. |
| **25** | **On the real engine:** a row with `position: null, percent: 0.42`, opened on the Mac, lands at ~42% of the book, not at page one. **Only a CDP probe in the running app can decide this** — it is the spec's first "Not verified" reading, it is D5's whole premise, and no unit test can carry it. |
| **26** | Round trip: after the phone's write, a **page turn on the Mac writes a fresh CFI** into `reading_position` while `reading_percent` moves with it. Same probe, plus the database read. |

## Readings already settled — do not re-derive these

1. **The CFI never leaves the Mac and the phone never needs it.** `docs/invariants/reader.md:72` declares `position` opaque; `src/types/book.types.ts:55-61` calls `percent` "the portable fallback"; `services/reading-state.ts:87-88` already writes **both** on every Mac-side write.
2. **The Mac already resumes from a fraction, unmodified.** `src/components/reader/ReaderEngine.tsx:176-184` falls through `goTo` → `goToFraction` when a position is null or unresolvable, with the `try/catch` at `:223-230` for books with no section-size index. So the phone writes a fraction, the row's CFI is blanked so the newer coordinate wins, and the Mac resumes there **with no renderer change and no locator⇄CFI translation layer.** AC25/26 are what turn that reading into evidence — the fall-through is a `catch`-guarded path, so the *frequency* of the throw is exactly what the probe measures.
3. **The write goes through `services/reading-state.ts`'s `saveProgress` verbatim.** Not a second writer: a route that set the columns itself would be the second home for the percent/status rules, which is what invariant 5 and AC22 exist to prevent.
4. **`nextReadStatus` is the status rule**, the same function the Mac's own writes call — hence AC22's parity assertion rather than a re-typed threshold table.
5. **`at` is the client's clock, and it must lose to a newer local write** (AC21). A phone whose clock is behind must not rewind progress the Mac has already advanced.
6. **The contract's document and goldens are each other's decider.** `shape.test.ts` parses the `json payload=` blocks out of `docs/rest-api.md` and compares them field for field, so 1c's payload needs its own block in the document **and** an entry in the test's `PAYLOADS` map — a payload added to the code and not to that map is invisible to every case, which the review named as the pair's one blind spot.

## The judgement the review handed to this slice (do it here, not separately)

`api/rest.ts` is 1,008 lines: the routing switch, the byte machinery **and** ~126 lines of pure parameter parsing (`parseLibraryQuery`, `parseSort`, `intParam`, `listParam`, `matchBookPath`, `decodeSegment`). The pre-merge review's verdict was that the layer is thin in the sense invariant 8 means — it decides no query, no path rule, no payload — but that D2's own test is "anything that can be a pure function of inputs becomes one so the suite can decide it without a socket", and these six are exactly that, reachable today only through a live socket. **The split, to do as part of 1c rather than as a slice of its own:**

- `services/api/query.ts` ← `parseLibraryQuery`, `parseSort`, `intParam`, `listParam`
- `services/api/routes.ts` ← `matchBookPath`, `decodeSegment`
- **Keep in the socket:** `sendBytes`, `streamRange`, the byte gate, the status record — those write headers and own the transfer budget, which is HTTP's own business.
- Also fold the one status→word mapping still sitting in the socket (the cover route's `cover.status === 400 ? 'badRequest' : 'notFound'`) into the resolver's own result, so `API_ERRORS` stays the shaper's single home.

Why here: 1c's `PUT` needs the same 400 discipline (a malformed `percent`, a bad body), and the move gives that validation a socketless decider for free. Result: `rest.ts` ≈ 880 lines, and 1c's row grows from 2 code + 1 test to **4 code + 2 test + 1 document** — still the smallest slice, and named here rather than discovered in the build.

## What must not move

- **The read surface 1b landed.** One route is added; nothing else changes status, shape or order. `npm test`'s 52 files are the decider, and the two prettier-churn files (`db.ts`, `docs/architecture.md`) carry pre-existing formatting noise that is not to be churned further.
- **`docs/rest-api.md`'s "Not in this version" section.** It currently says the `PUT` "is the next slice (1c) and lands in this document with its own golden payload when it ships" — 1c is that ship. The route moves into the main table, the status-code table and the errors table, with its payload block, **in the same change as the code** (AC19's pair).
- **`scripts/api-smoke.sh`.** Its header states what it cannot do (it compares statuses, headers and byte counts — it cannot hash a tail, because the wire carries no path). A write route is worth one check pair — a `PUT` and a read-back that shows the percent landed — but keep the same rule: every line it prints is a `PASS`/`FAIL` it actually observed.
- **`API_ERRORS` stays the shaper's**, and no token ever reaches a payload, a log or the status record.

## Not 1c's — slice 2's, by design

`docs/data-contracts.md:152` ("All but `rest_api_enabled` are editable in Settings") and `docs/invariants/settings-and-editing.md:22` both change meaning now that four `rest_api_*` keys exist; the `SettingsModal` row is AC27–30; and the server captures its token, port and bind **by closure at creation**, so a save that *changes* them needs a listener restart — unreachable while the flag is off, and first reachable exactly when the toggle is used to change rather than enable.

## Start here

```bash
git log --oneline -3        # 1b is the commit on top of 9c1db15; this spec/annex line lands with it
npm run typecheck && npm run lint       # both 0
npm test                    # 52 files / 1198 tests
sidecar/.venv/bin/python -m pytest -q sidecar/tests   # 113 passed
```

**Then read, in this order:** AC20–26 above, then `services/reading-state.ts` (the writer this route must reuse), then `ReaderEngine.tsx:160-240` (the resume path AC25/26 measure), then `rest.ts`'s switch — and start from `git log` rather than from any conversation, because everything 1a and 1b did is in the tree and not in the chat.
