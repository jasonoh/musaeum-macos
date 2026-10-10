# PDF reflow — slice 4 (the wire) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** the phone can fetch a PDF-only book's reflowed EPUB. `GET /api/books/{id}` gains an additive `reflow.available` member, and `GET /api/books/{id}/file?format=reflow` runs (or joins) the pass and serves `{book}/derived/reflow.epub` as `application/epub+zip` — or says why not.

**Annex to:** `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` (D1, D3, D8; the slice table's row 4). **Read first:** that spec's D1/D3/D8, `docs/rest-api.md` (the contract this slice amends), `docs/invariants/reader.md` (`musaeum://book`, `derived/`), `docs/invariants/files-and-deletion.md` (invariant 2's by-extension rule), and `electron/main/services/book-bytes.ts`'s reflow note, which says in as many words that the wire stays closed until this slice opens it.

## Why now

The iOS client's reflow half shipped ahead of this one (`../musaeum-ios`, slice 8, 2026-10-09): `DownloadPlan` asks for `format=reflow` when `book.reflow.available` is true. Against the Mac this repo builds, no payload carries that member and `format=reflow` answers 404 — so the phone falls back to `formats.first`, downloads the PDF, and renders a fixed page at fit-scale. Measured on the owner's own machine 2026-10-09: the packaged app (`dist/mac-arm64/Musaeum.app`, `main` `cdd245f`) contains no `available` anywhere near a `reflow`, and `bookPayload` names no reflow member. **A PDF-only book is reflowable in the app and invisible to the phone.**

## What this slice is

1. **The member.** `bookPayload` gains `reflow: { available: boolean }`, the same shape the client already decodes and the same idiom `cover` uses for _does it exist_. Eligibility is D1's wire rule — **holds a PDF and no EPUB** — and it is a pure rule over `Book.formats`, so it lives in `@shared/book.types` beside `readerTarget` and both the shaper and the route read one declaration.
2. **The route.** `GET /api/books/{id}/file?format=reflow`:
   - **404** for a book that is not eligible (unknown, no PDF, or **holds an EPUB**) — uniformly and reason-free, like every other 404 here (D11). An EPUB-holding book is refused on purpose: `formats[0]` already _is_ an EPUB, so a reflow would be a second, worse rendering of a book the phone can already read.
   - **503** `library offline` while the share is not mounted, before anything is attempted — the byte routes' own order.
   - **200** the artifact, `application/epub+zip`, with its own `ETag`, once the pass has settled with an artifact.
   - **202** `{"phase","completed","total"}` + `Retry-After: 2` while the pass is still running — the client's own poll, and the reason a 535-page pass does not hold one request open for three minutes.
   - **422** `{"error":"cannot reflow","reason":…}` when the pass refused — a settled answer, not a transient one.
3. **The grace.** The route races the pass against `REFLOW_GRACE_MS` (2000). A book that finishes inside it answers 200 on the first request — measured on the fixture: 4 pages in 0.39 s. A longer pass answers 202 and the next request joins the same in-flight promise (`reflow.ensure`'s own rule), so the poll is the same request again and never a second pass.

## Files

| File                                                     | Change                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/book.types.ts`                                | `reflowAvailable(book)` — D1's wire rule, pure                                                                                           |
| `electron/main/services/api/shape.ts`                    | `WireReflow`, `WireBook.reflow`, `reflowPendingPayload`, `reflowRefusedPayload`, `REFLOW_ERROR`                                          |
| `electron/main/services/book-bytes.ts`                   | `REFLOW_FORMAT` / `REFLOW_CONTENT_TYPE`; the "stays closed until slice 4" note becomes the record of it being opened                     |
| `electron/main/services/reflow.ts`                       | the last frame per book (`currentProgress`), cleared when a pass settles                                                                 |
| `electron/main/api/rest.ts`                              | the `format=reflow` arm + `handleReflowFile`, and the `reflowGraceMs` seam                                                               |
| `docs/rest-api.md`                                       | the member on all five book payloads + the field sentence; `#### format=reflow`; the routes table; the errors table; the smoke paragraph |
| `electron/main/services/api/shape.test.ts`               | the member's two values, decided by the rule                                                                                             |
| `electron/main/services/reflow.test.ts`                  | `currentProgress`'s life                                                                                                                 |
| `electron/main/api/reflow-file.test.ts`                  | the route over a real socket                                                                                                             |
| `scripts/api-smoke.sh`                                   | the reflow section (`--- the reflow (PDF-only books)`)                                                                                   |
| `CHANGELOG.md`, `tasks.md`, the spec's _Built — slice 4_ | the record                                                                                                                               |

## Readings (settled here, this slice's own)

- **R1 — the member carries availability only, not a version.** D8 asks for _availability and version_ by analogy with `cover`. The client's committed fixtures (vendored from this document in the iOS slice) carry `{"available": false}` and its `Reflow` type reads one key, so a `version` here would be a member no reader reads and a fixture edit in the other repo. Alternative: add `version` (the artifact's mtime) — **reversal condition:** the first client that revalidates the artifact instead of re-fetching it.
- **R2 — the grace is 2000 ms.** Measured: the 4-page fixture laid out in 0.39 s and answered 200 on the first request; a 535-page book measured 176 s, so the grace has to be far below one poll and far above a small book. Alternative: no race, always await the pass — **reversal condition:** a client whose HTTP timeout outlasts the slowest book, at which point the 202 arm is dead weight. The seam (`ServerOptions.reflowGraceMs`) exists so the suite decides both arms in milliseconds.
- **R3 — the reflow response carries an `ETag`, and nothing else does.** The client's committed smoke log names it (`it carries an ETag`), and the artifact is the one file on this wire whose identity is _derived_ rather than stored, so its `<size>-<mtimeMs>` is the honest label. It is decoration today: the byte writer says `cache-control: no-store`, so no client revalidates. Alternative: no `ETag` — **reversal condition:** the log that names it is the contract, and a check the client's own record carries is not this slice's to drop.
- **R4 — the pass is reached through `reflow.ensure`, not a second door.** Same entry point the app's reader uses (`reader:reflow` → `ensure`), so one pass per book, one lock, one retry rule. Alternative: call the sidecar directly from the route — **reversal condition:** never; that would be the second door slice 2 exists to prevent.

## Acceptance criteria

| #   | Criterion                                                                                                            | Decider                                             |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| AC1 | `bookPayload` carries `reflow.available`, true exactly when the book holds a PDF and no EPUB                         | `shape.test.ts` (the golden pair + a PDF-only book) |
| AC2 | The document and the shaper carry the same member (the pair that AC19 pins)                                          | `shape.test.ts`'s doc-block comparison              |
| AC3 | `format=reflow` on a book that holds an EPUB answers 404 and starts no pass                                          | `reflow-file.test.ts`                               |
| AC4 | `format=reflow` on a PDF-only book serves the artifact: 200, `application/epub+zip`, an `ETag`, the file's own bytes | `reflow-file.test.ts`                               |
| AC5 | A pass still running past the grace answers 202 with the last frame and `Retry-After`                                | `reflow-file.test.ts`                               |
| AC6 | A refused pass answers 422 with the pipeline's own sentence                                                          | `reflow-file.test.ts`                               |
| AC7 | An unknown book, and a share that is not mounted, keep the byte routes' own answers (404 / 503)                      | `reflow-file.test.ts`                               |
| AC8 | `currentProgress` holds the last frame while a pass runs and nothing after it settles                                | `reflow.test.ts`                                    |
| AC9 | The live server answers the whole sequence                                                                           | `scripts/api-smoke.sh`'s reflow section             |

## What must not move

- The five book payloads' existing field lists, except the added member — `shape.test.ts`'s golden comparison is the decider.
- `resolveBookFile`'s four formats and its refusal: `format=reflow` is intercepted **before** it, so `reflow` never becomes a `BookFormat` (D3, AC2 of the parent spec).
- The byte writer's status table (200/206/404/416/503) — the reflow goes through it.
- The 401 path, which runs before routing.

## Verification

1. `npm run typecheck && npm run lint && npm test` — the suite's count moves by the cases this slice adds, and nothing else fails.
2. `npx prettier --check` on every file the slice touches that has a parser (the `.md` documents included — a document here is a test fixture), measuring whose drift each flag is (`scripts/prettier-drift.py`).
3. The mutation campaign: one JSON list, each entry naming a file, an exact anchor, its replacement and the case that must redden.
4. `scripts/api-smoke.sh --profile <scratch profile>` — the reflow section green, and the profile's own counts reconciled (the run adds one book).
5. The iOS pairing: `../musaeum-ios/scripts/vendor-contract-fixtures.sh` re-extracts the fixture set; its `git diff` must show the five payloads unchanged (the member was already vendored from this document in the iOS slice) — which is the two-repo check this whole slice exists for.

---

## Built — slice 4

Landed 2026-10-09, uncommitted when this section was written. **Fourteen files**: five code (`src/types/book.types.ts`, `services/api/shape.ts`, `services/book-bytes.ts`, `services/reflow.ts`, `api/rest.ts`), three suites (two extended, `electron/main/api/reflow-file.test.ts` new), the smoke script, the contract document, this annex, and three record documents. **The parent spec's row 4 budgeted "docs + 3 files + goldens + smoke script" and is short by two code files** — `book-bytes.ts` (the format's two constants and the note that said the wire stayed closed) and `reflow.ts` (the progress reader a `202` answers with) — which is step 4's file-budget rule doing its job: the goldens themselves needed no edit, because they are parsed from the document.

### The gates, as run

| Gate                                                      | Reading                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                       | exit 0                                                                                                                                                                                                                                    |
| `npx eslint . --max-warnings=0 --ignore-pattern '.delta'` | exit 0                                                                                                                                                                                                                                    |
| `npm test`                                                | **1,935 tests in 90 files, 0 failures**                                                                                                                                                                                                   |
| the arithmetic                                            | HEAD was **1,919 across 89**; this slice adds **16** — `shape.test.ts` 4, `reflow.test.ts` 2, `reflow-file.test.ts` 10                                                                                                                    |
| prettier                                                  | clean on every file touched that has a parser, this annex included; `docs/rest-api.md` is **pre-existing drift** (HEAD 70 lines, working 42 — the tables this slice added rows to were re-padded, so the working count comes back _down_) |
| mutation campaign                                         | **8/8 killed**, each aimed at the suite that owns the assertion                                                                                                                                                                           |
| the two-repo pair                                         | `../musaeum-ios/scripts/vendor-contract-fixtures.sh` re-run against this document leaves the client's five book fixtures **byte-identical**                                                                                               |

### The live reading

An isolated instance of **this** tree, a scratch profile holding one hand-built 4-page text PDF (`The Reading Room`, 6,594 B, `formats: ["pdf"]`), REST on the tailnet address port **8791** — the owner's own app holds 8788 and was left alone. `scripts/api-smoke.sh --profile <scratch>`:

```text
--- the reflow (PDF-only books)
PASS  book detail carries reflow.available as a boolean
PASS  format=reflow on a book with an EPUB answers 404
note  reflow poll: statuses 200
PASS  the reflow answers 200 once the pass is done
PASS  its type is an EPUB
PASS  it carries an ETag
PASS  its first bytes are a zip
```

and the route read directly:

```text
formats ['pdf'] | reflow {'available': True}
HTTP/1.1 200 OK
content-type: application/epub+zip
etag: "2619-1791597139372"
content-length: 2619            (body starts "PK")
```

The pass wrote `derived/reflow.epub` (2,619 B) beside its stamp, whose record reads `pages: 4, text_pages: 4, toc_from: headings`. The whole smoke run: **passed 82, failed 1** — the failure the pre-existing `the page carries exactly limit rows — expected 2, got 1`, which needs two books and takes the smoke's own upload as the second. The reflow section is the same seven lines the client's record carries, check name for check name.

### Deviations, and the readings this slice left open

- **The member carries `available` only** (R1, unchanged): the client's vendored fixtures carry `{"available": false}` and its type reads one key, so a `version` would be a member no reader reads and a fixture edit in the other repo.
- **The `ETag` is opt-in on the byte writer**, set by this route alone — the client's own committed smoke log names it, and the stored book and cover routes' documents do not. A case pins the other direction: the stored `format=pdf` route answers **no** `ETag`.
- **The `202` arm is not exercised live, and cannot be by this fixture.** A 4-page pass finishes inside the 2 s grace, so the live run took the 200 arm; a live `202` → `200` needs a PDF that outlasts two seconds (_Universe_ measured 176 s). That arm is decided by `reflow-file.test.ts` (the grace seam at 5 ms) and by the campaign's _a still-running pass is not answered 202_ row.
- **The smoke takes its 422 branch instead of the byte checks** when the profile's PDF-only book is an image-only scan — the honest shape for a generic profile, and the check names say which branch ran.
- **`../musaeum-ios` could not be driven from here.** Its probe's `MUSAEUM_PROBE_OPEN` path downloads `preferredFormat` rather than the `DownloadPlan`, so a simulator run could not observe the phone's reflow download even if one were wanted; and the owner's phone is a real device, where a tap is his. The phone's half was landed and unit-decided in that repo (its slice 8). What this slice changes for it is that the Mac now **answers**.

### What the owner must do to see it on the phone

**Run or repack the Mac.** The packaged app he is running predates this slice, so until a build containing it serves his library, the phone keeps asking for `formats.first` and keeps opening the PDF — which is the report this slice was written from.
