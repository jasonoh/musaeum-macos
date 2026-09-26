# Design: the two cover sources the picker lacks — a wider search, and your own image (cover choice, v2)

**Date:** 2026-09-25
**Status:** Proposed — signed off by Jason 2026-09-25 (*"agreed on all recs. proceed"*, given after the measurements below were put in front of him)
**Scope:** Give the cover picker two sources the gather cannot reach — the jackets that exist under the book's *other* identifiers (and under its title and author), and an image of the owner's own — so that "the auto-select picked the wrong jacket" is answerable per book without a network round trip to anyone else. Deliberately not: a free-text search box, crop/rotate, widening what a *fetch* writes, or repairing a wrong stored ISBN.
**Depends on:** `docs/superpowers/specs/2026-09-21-cover-choice-design.md` (the picker, its IPC surface `coverCandidates`/`setCover`/`releaseFieldOverride`, and the pure tile derivation in `src/lib/cover-candidate-state.ts`), and the cover scoring in `sidecar/pipeline/cover.py`.
**Interacts with:** the picker dialog (`src/components/library/CoverPicker.tsx`) and its payload shape (`CoverCandidate`, `src/types/metadata.types.ts`); the fetch's own cover choice, which this feature deliberately does **not** change (D1).
**Supersedes:** the **Scope** line of the cover-choice design, which excluded *"a cover from a local file"* as out of scope — amended in that spec on 2026-09-25 when the owner answered the Spanish-jacket case with *"if the covers are unacceptable by user's determination, user should be able to upload their own option instead"*. This design is that amendment carried to a buildable shape; it supersedes the exclusion only.

---

## Why now

Everything below was measured on 2026-09-25 against the live APIs and the real dev database, read-only.

`Topology of Violence` (MIT Press, Byung-Chul Han) sits in the library at `7ae66296-fd60-4e99-8420-ef985e36abd6` wearing a **Spanish** jacket — Herder's *Topología de la violencia*, 304×500, from OpenLibrary's work-level cover (`cover_i 7882957`). The owner reported it as a bug.

| question | answer |
| --- | --- |
| What identifiers is the row searched by? | `isbn_13=9780262345064`, `isbn_10=8934995483`, `openlibrary=OL44008583M` |
| What is that ISBN-10? | the **Korean** edition's (9788934995487), and `OL44008583M` is the **Korean** edition key |
| Google, `isbn:9780262345064` | `totalItems: 0` — the row's ISBN is one Google does not index |
| Google, `isbn:0262345056` (its ISBN-10 sibling) | `totalItems: 0` |
| Google, `isbn:9780262534956` | **1 hit**, `B-VVDwAAQBAJ`, MIT Press, `lang=en`, artwork **800×1245** |
| Google, `isbn:0262345072` | **1 hit**, `9eRVDwAAQBAJ`, MIT Press, `lang=en`, artwork **1352×2103** |
| Google, `intitle:"Topology of Violence" inauthor:"Byung-Chul Han"` | **1 hit** — the same MIT volume; the app's own fetcher normalizes it at `match_confidence 1.0` |
| Google, free text `"Topology of Violence" author han` | **300 hits**, mostly other Han/MIT titles — the reason there is no free-text box in this design |
| OpenLibrary, `isbn:9780262345064` | 1 doc, **18 ISBNs listed for the work**, including `9780262345071`, `9780262534956`, `9788425434174` (Spanish), `9788934995487` (Korean) |
| OpenLibrary, asked four other ways (title+author, title-only, free text) | the *same* doc, the *same* `cover_i` — its cover is not query-dependent |
| Google, `isbn:8425434173` (the Spanish edition) | 1 hit, **no artwork at all** |
| Google, `isbn:8934995483` (the Korean edition) | 1 hit, **no artwork at all** |

Scored by the app's own `_score` (`sidecar/pipeline/cover.py:39`), which was called to produce these numbers rather than reimplemented:

| jacket | source | pixels | score |
| --- | --- | --- | --- |
| `9eRVDwAAQBAJ` — English, MIT | google_books | 1352×2103 | **0.9722** |
| `B-VVDwAAQBAJ` — English, MIT | google_books | 800×1245 | **0.9282** |
| OpenLibrary `7882957` — Spanish **← what it applied** | openlibrary | 304×500 | 0.5275 |
| the file's own jacket — English, landscape spread | embedded | 800×514 | 0.5249 |

**The thesis is not "better search would find the jacket."** It is narrower and it cuts two ways:

1. **The correct jacket wins by 84%, and the app already receives the identifier that reaches it.** OpenLibrary's answer for this very book — the one `fetch_openlibrary` (`sidecar/fetchers/openlibrary.py:18`) already gets — lists `9780262345071` and `9780262534956` among its 18 ISBNs. Both are ISBNs **Google answers with the English jacket and artwork**. The fetcher keeps the first 13-digit ISBN it meets and **discards the rest** (`openlibrary.py:53–58`), the row's stored ISBN is one Google does not index at all, and the query builder asks by ISBN **and only by ISBN** when an ISBN is present (`sidecar/fetchers/google_books.py:100–107` — the `elif title:` branch, which works, is unreachable). So the pipeline asks its narrowest possible question, in a code path written to be broader, and then believes the answer.
2. **The file's own jacket is the right jacket in the wrong shape.** The 800×514 image inside the book is the *same English MIT design* — what it lacks is a 2:3 crop (`_score`'s aspect term: 0.43 vs 0.90), and what the pipeline lacks is the identifier. This is what makes the upload source a genuine floor rather than a nicety: the owner's own file already contains the right cover, unusably cropped.

The measurements cut against one tempting fix: **widening the fetch**. Google's jackets outrank OpenLibrary's by construction (`SOURCE_PRIORITY`, `cover.py:33` — 1.0 vs 0.66 vs 0.33), so a fetch that asked the wider question would flip jackets for **every book whose stored ISBN misses Google**, on the next re-fetch, across 7109 rows, with no review — the existing 15% band fires only on a near-tie, and here the margin is 84%. That is why the widening lives in the picker (D1) and why the fetch is left alone.

---

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| The picker's gather: `cover_candidates(file_path, book_dir, known)` → `_sources` → `gather_candidates` → `score_candidates` → `summarise_candidates` | `sidecar/pipeline/hydration.py:104`, `:120`, `:126` |
| The scoring formula in one place, with the sort that decides *the* winner | `sidecar/pipeline/cover.py:39`, `:101` |
| The payload the renderer consumes: one entry per candidate with source, dimensions, score, `winner`, `applied`, inlined `thumb` | `sidecar/pipeline/cover.py:168` |
| `applied` is byte identity with `cover_full.jpg`, not provenance — which is why it survives D3's change of meaning | `sidecar/pipeline/cover.py:277` |
| The write path a pick goes through, 600/200 renditions and all | `sidecar/pipeline/cover.py:328` (`write_choice`), `:240`, `:259` |
| `known` travels with the gather so the picker scores the pool a fetch of *this row* would score | `sidecar/main.py:61`, `electron/main/services/cover-choice.ts:80` |
| The lock: a picked cover is held against later fetches, and releasable | `electron/main/ipc/metadata.ts:28`, `src/components/library/CoverPicker.tsx` |
| The pure tile/notice derivation, already tested without a DOM | `src/lib/cover-candidate-state.ts:64`, `:77`, `:107` |
| The search's two fetchers already exist and already download-and-validate images, including Google's placeholder-tile hash guard | `sidecar/fetchers/google_books.py:67` (`_resolve_cover`), `:29` (`PLACEHOLDER_MD5`) |

**Not true today, and inside this feature rather than free:**

- **No way to ask Google a question about an ISBN you already have.** `fetch_google_books` takes `isbn_13`/`title` and returns **one normalized record** — the best match by similarity. A search needs the *volumes that answer*, plural, with their artwork, so it needs a list-returning function beside it.
- **No way to see a work's other ISBNs.** `fetch_openlibrary` returns two identifiers; the other 16 are in the payload it discards. Reading them means a second, search-only read (D5).
- **No file-input path in this app at all.** Nothing in `electron/main/` opens a file dialog today; `src/` cannot read a path (invariant 9 — the renderer never gets `file://`). The upload source is the first feature to need a main-process dialog, which is why it is its own slice.

---

## D1 — The wider question is asked by the picker, never by the fetch

**Decision:** `hydrate_metadata`'s cover gathering is unchanged. The wider search exists only behind an explicit action in the picker, so a re-fetch cannot silently replace a jacket with one found under a different identifier.
**Why:** Google's `SOURCE_PRIORITY` (1.0) beats OpenLibrary's (0.66) and embedded's (0.33), so adding the wider identifier to the fetch's query set would change the applied cover for every book in the class that produced this report — on the next re-fetch, library-wide, without asking. The alternative (widen the fetch) is the *correct eventual* behaviour and the wrong immediate one: it needs a before/after surface first.
**Consequence:** A book nobody opens in the picker keeps its current jacket forever. The library-wide correction is now a named deferred item with a revival condition (a bulk re-check that shows a diff before writing), not a missing feature.

## D2 — The search asks in a fixed order, and the order is the whole safety argument

**Decision:** (1) the ISBNs the row is known by, (2) the ISBNs OpenLibrary lists for the same work, (3) `intitle:"<title>" inauthor:"<author>"`. Never free text. Stop the *identifier* passes when the ISBN list is exhausted, not at the first hit.
**Why:** an ISBN question cannot return another book — a Google volume answering `isbn:X` is the edition with that ISBN, so language and identity cannot drift, which free text cannot promise (measured: 300 hits, mostly wrong, for the free-text form of this very title, against exactly 1 for the structured form). And stopping at the first hit would deny the better of two real hits: this book's two English volumes are the *same design* at 800×1245 and 1352×2103.
**Consequence:** up to N+1 Google requests per press (measured for this book: two misses, two hits), bounded by the cap in D5. The fuzzy pass runs only when no ISBN answered, so its imprecision is confined to rows that have nothing left to lose — books whose stored identifiers are all junk.

## D3 — The search answers with the same `CoverCandidate` list, and no entry it returns may claim `winner`

**Decision:** the search returns `summarise_candidates`' payload unchanged, over its own hits, with `winner: false` on every entry. `applied` keeps its byte-identity meaning. The picker shows searched tiles as a **labelled second group**, after the gather's.
**Why:** `winner` means *"what a fetch would write"* — and a fetch would not write a jacket it never asked for. Re-scoring the searched hits together with the gather's pool (the obvious alternative, so that every mark has one meaning) would make the dialog's most load-bearing sentence a lie. `applied` is provenance-free by construction (`cover.py:277` compares bytes), so it stays true in both groups. No new type is needed either way: the renderer knows which list came from which call because it makes both calls.
**Consequence:** the picker has two groups with different standing, and its footer copy must say so. A search hit is never auto-applied, never the subject of the 15% review band, and carries no score-based recommendation.

## D4 — The search writes nothing and persists nothing

**Decision:** same rule as the gather it extends. `metadata.json` is untouched, no candidate list is cached, and the only write path remains `write_choice` behind the existing lock.
**Why:** the gather's docstring already commits to this (`hydration.py:104–118`), and a search that persisted would make the picker's contents a function of history rather than of the book.
**Consequence:** every press re-asks the network. That is a deliberate cost, not an oversight (Risks 1).

## D5 — The work's other ISBNs come from a search-only OpenLibrary read, not from the stored record

**Decision:** a new `known_isbns(title, author, isbn_13)` returns the work's identifier list — deduped, 13-digit first, capped at 6 — and only the search calls it. `fetch_openlibrary`'s return shape does not change.
**Why:** the hydration persists what `fetch_openlibrary` returns, so widening *its* `identifiers` dict would change `metadata.json`'s shape (and therefore the iOS contract and 7109 stored records) for a value the record has no use for. The cap is a request budget, and the dedupe is because the payload lists both ISBN-10 and ISBN-13 forms of the same edition.
**Consequence:** the search costs one extra OpenLibrary request per press (no API key, unlike Google). If OpenLibrary is unreachable, the search degrades to the row's own identifiers plus the title pass, which is precisely the fallback it already has.

## D6 — An uploaded image is written through the existing write path and held like any pick

**Decision:** the file arrives as an absolute path from a main-process dialog (the renderer never sees `file://`), the sidecar validates it with PIL against the same 120 px floor `score_candidates` applies, and the 600/200 renditions come from the existing `_write_cover`/`_renditions`. The cover is locked exactly as a picked one is, and releasable through the existing release.
**Why:** every alternative duplicates a rule that exists once — a second encoder, a second thumbnail size, or a second lock would each be a second answer to a question already answered (`cover.py:240`, `:259`).
**Consequence:** an uploaded image is indistinguishable downstream from a fetched one, which is the point; the only new failure mode is a file that is not an image or is too small, refused with a message rather than a throw.

---

## Store and component shape

The searched list is **component state inside `CoverPicker.tsx`**, not store state and not persisted: the dialog mounts keyed per book, so a second book cannot inherit the first book's search, and nothing outside the dialog needs the list. The gather's own list keeps its existing home. Nothing new is persisted (`applied UI state` is unchanged), so `ui.store.ts` is not touched by this feature.

---

## Acceptance criteria

### Slice 3a — the search source (sidecar → IPC → preload)

1. With Google answering nothing for `9780262345064`, the search reaches the *other* identifiers and returns the English jacket: a pytest over the ISBN sequence actually asked, with the two fetcher calls recorded.
2. When every ISBN in the row misses, the title+author pass runs and it uses the structured form — asserted on the recorded query strings (`intitle:` **and** `inauthor:`), never free text.
2a. **Added at the build, 2026-09-25, at a letter rather than as a renumber.** The sequence's bound is *derived* from the two caps it contains (`2 + KNOWN_ISBN_CAP`), so the work's list cannot crowd the row's own identifiers out of their own budget: pytest asserting the derivation **and** the sequence's content, which fails on a flat cap of 6 — measured, that truncation reaches only the first of this book's two English jackets. It is in this slice because it pins the slice's own request boundary rather than a later feature.
3. A search that finds nothing returns `[]` and raises nothing — pytest.
4. The OpenLibrary identifier read is deduped and capped at 6, 13-digit first — pytest against a recorded payload with 18 entries.
5. `coverChoice.searchCovers(bookId)` sends the same `{file_path, book_dir, known}` triple the gather sends — a source walk, because the two must not drift.
6. `git diff --quiet sidecar/pipeline/cover.py src/types/metadata.types.ts` — the search adds no scoring rule and no contract type.
7. **Live, in the running app** (isolated profile, the real book): `searchCovers` returns ≥2 English jackets, the top one scoring ≥0.9, and none of them is the Spanish jacket — decided against the live payload, not a fixture.

### Slice 3a-ii — the picker's affordance

8. The dialog shows the search trigger in its zero- and result-states; pressing it shows a spinner, then the searched group labelled as searched — CDP probe **and** a frame.
9. The searched group's notice is a distinct sentence from the gather's, and it never claims a fetch would write any of them — a unit test on the pure derivation.
10. A pick from a searched tile writes `cover_full.jpg` at 600 px, repaints the panel and the grid card, and holds the cover — CDP probe plus the written files' own dimensions.

### Slice 3b — your own image

11. Choosing an image writes 600/200 renditions and locks the cover; the lock line renders — CDP probe **and** a frame.
12. A non-image, or an image under 120 px on either side, is refused with a message and **nothing is written** — pytest on the sidecar guard plus a `git diff --quiet` over the book folder.
13. `git diff --quiet schema/migrations/` — this feature persists nothing new.

---

## Slices, and why they are cut this way

**Slice 3a (9 files, 7 code + 2 test, at the house bound).** New: `sidecar/tests/test_cover_search.py`, `electron/main/services/cover-choice.test.ts` (or the existing wiring walk extended). Edited: `sidecar/fetchers/google_books.py` (a list-returning search beside `fetch_google_books`), `sidecar/fetchers/openlibrary.py` (`known_isbns`), `sidecar/pipeline/hydration.py` (`search_candidates` beside `cover_candidates`), `sidecar/main.py` (`search_covers` in `METHODS`), `electron/main/services/cover-choice.ts` (`searchCovers`), `electron/main/ipc/metadata.ts` (`metadata:searchCovers`), `electron/preload/index.ts`. It stops at the preload because that is where it becomes testable without a DOM: the payload is provable by pytest and by a CDP `eval` of the preload method, and the UI cannot be proven at all without the probe (which is the expensive instrument, so it runs once).

**Slice 3a-ii (4 files).** Edited: `src/components/library/CoverPicker.tsx`, `src/lib/cover-candidate-state.ts` (+ its test), `src/components/library/cover-picker-wiring.test.ts`. This is the renderer slice the house order puts last, and it is small because the payload shape is deliberately unchanged.

**Slice 3b (8 files, and it is the one that needs a new seam).** Edited: `sidecar/main.py`, `sidecar/pipeline/cover.py` (the file-input write path), `electron/main/services/cover-choice.ts` (the dialog + the call), `electron/main/ipc/metadata.ts`, `electron/preload/index.ts`, `src/components/library/CoverPicker.tsx`, plus two test files. It is separate from 3a because it crosses a different boundary (main-process dialog + filesystem read by main, not by the renderer) and because 3a's search is useful on its own — it is the slice that fixes this book.

---

## Rejected and deferred, with the condition that would revive them

- **A free-text search box** — rejected: measured 300 mostly-wrong hits for free text against 1 for the structured form, and a free-text hit cannot honestly carry the fetch's marks (D3). Revived when a book whose *stored title* is also wrong appears — a foreign-language import is the likely trigger.
- **Widening the fetch (D1's alternative)** — deferred, not rejected on merit: it is the correct eventual behaviour and needs a surface that shows a before/after first. Revived when a bulk "re-check covers" job exists that reports its diff before writing.
- **Repairing the stored ISBN from Google's own volume record** — deferred. Google answers `9780262534956` with the very volume that holds the jacket, and OpenLibrary already lists it, so the row *could* be corrected. It is a metadata write with its own conflict semantics, and it is the "wrong identifier in the row" bug class rather than the cover bug; folding it in would put a second decision inside this one.
- **Crop/rotate of the file's own jacket** — rejected: the 800×514 spread is the English design in an unusable aspect, but a crop tool is a different feature with its own UI. Revived when enough books carry spread-shaped jackets to justify the tool — and note the cheaper path (Google's 1352×2103 for the same design) already exists for this book.
- **Upload from a URL** — deferred; additive when the REST surface grows a cover write, which would need a decision about server-side fetching.

## Risks, stated plainly

1. **Cost and latency per press.** Up to N+1 Google requests (N ≤ 6 by D5) plus the largest rendition of each hit — measured at 197 KB and 417 KB for this book's two. A press that is slow is a spinner, not a failure, and nothing happens without a press. Residual: no caching between presses, so a second press re-pays.
2. **A widened search can surface another edition's jacket, in another language.** Measured on this book: OpenLibrary's list includes the Spanish and Korean ISBNs, and Google *answered* both records — with no artwork, which is the only reason no Spanish tile enters the searched group. That is a property of Google's data, not a guarantee this design creates. The guard is D2's ordering (identifier questions first) plus D3 (nothing is applied without a pick). Residual: a redundant Spanish tile if Google ever adds artwork to that record.
3. **Google's `language` field is not trustworthy** — measured: the Korean edition's volume reports `lang='en'`. No language filter is therefore possible, and none is attempted; the ordering is the whole guard.
4. **Invariants held.** None of the twelve bends. Named specifically: no `metadata.json` shape change and no catalog write (1, 5); no sort-key path (4); no `formats[0]` read (3); the renderer still receives inlined previews and never a `file://` — `summarise_candidates` owns that rule for both groups (9); no business logic in an IPC handler (8); the search cannot rename or move a file (2, 6); no `src/types/folio`-shaped change and no `vendor/` edit (11); a search failure is a silent miss, exactly as a fetch failure is a miss (12).

---

## Built — slice 3a (2026-09-25)

**What landed: 8 code files + 2 test files — and the row was short by one.** The row counted 7 code (the two fetchers, `hydration.py`, `main.py`, the service, the IPC handler, the preload) plus 2 test files. The build's eighth code file is **`src/types/api.types.ts`**, which the row never listed and the build could not avoid: the preload's `const api: MusaeumAPI` literal fails typecheck (TS2353) unless the interface gains `searchCovers`, so "mirror the declaration" was load-bearing rather than optional. The second test file is the *extended* `electron/main/services/cover-choice.test.ts` (11 → 16 cases) rather than a new one, so the tests' count is right and the code count is not.

**The one deviation, and it was mine rather than the builder's.** The build brief said the whole ISBN sequence is capped at 6. That is not what D5 says — D5 caps *the work's list* at 6, and D2's cost line ("two misses, two hits") already assumes the row's own two identifiers are asked **in addition**. Implemented literally, the sequence ended one entry short of `9780262534956`, the second English jacket at the work's index 5 — so a press would have offered one jacket where the library can reach two. The bound is now **derived**: `MAX_SEARCH_ISBNS = 2 + KNOWN_ISBN_CAP`, with the derivation and the failure in the comment, and the criterion that fails on a flat cap is **AC2a** (added after approval, at a letter, per the house rule — it is in *this* slice because it pins the slice's own boundary rather than a later feature).

**Criteria, and what verified each.**

| AC | decider | result |
| --- | --- | --- |
| 1 — the search reaches the identifiers Google does not index | pytest over the *sequence* asked | holds |
| 2 — the title pass runs only after every ISBN missed, and is structured | pytest on the recorded query strings (`intitle:` **and** `inauthor:`) | holds |
| 2a — the bound leaves room for the row's own identifiers | pytest: `MAX_SEARCH_ISBNS == 2 + KNOWN_ISBN_CAP`, plus the sequence's content | holds (fails on a flat 6 — that is the point) |
| 3 — a search that finds nothing returns `[]` and raises nothing | pytest | holds |
| 4 — the work's list is deduped, 13-digit first, capped | pytest against the real 18-entry payload | holds |
| 5 — `searchCovers` sends the gather's own `{file_path, book_dir, known}` triple | source walk + a runtime case | holds |
| 6 — no scoring rule and no contract type moved | `git diff --quiet sidecar/pipeline/cover.py src/types/metadata.types.ts` | **clean** |
| 7 — live, on the real book | the shipped code, the real row, the real APIs | **holds** (below) |

**AC7, run against the real row rather than a fixture** (isolated profile, live APIs, the shipped `search_candidates`):

```
ISBNs asked (7): 9780262345064 · 8934995483 · 9788934995487 · 9780262345057
                 · 9788425434174 · 9780262345071 · 9780262534956
came back (2):   google_books 1352x2103  score=0.9722  winner=False  url+thumb
                 google_books  800x1245  score=0.9282  winner=False  url+thumb
Spanish jacket:  absent — Google's record for that ISBN carries no artwork
```

Those two scores are identical to the independent computation the design's *Why now* carries (0.9722 / 0.9282), which is the cross-check worth keeping: the app's own scorer and the scoping probe agree. The Spanish and Korean ISBNs **were asked** and answered nothing — the ordering's guard held on real data.

**Gates.** `pytest` **148 passed** (baseline **125**, +23), `typecheck` 0, `lint` 0, `prettier` clean; frozen-tree `npm test` runs after the renderer slice lands, so it is not claimed here. **Mutation campaign: 12 of 12 killed** (10 sidecar rows, 2 service rows; every file restored byte-exact). One row **survived first and was a real finding** — the url guard in `search_candidates` had no decider, because the two fetchers always set a url, so nothing exercised the branch. The test now names it, and says why the guard exists: `services/cover-choice.ts` refuses an online choice with no url (its slice-1b D6 refusal), so an url-less entry would become a tile that cannot be chosen.

**Two corrections to the record, and a third that supersedes both.** The pytest baseline is **125**, not the 117 this brief and an earlier reading carried. I first attributed that to my own `tail`-hidden exit code, and **that attribution was wrong**: the repo was being committed to by two other sessions while this slice was built, and `a075007 audit(U3): parse EPUB XML with defusedxml and cap zip-member reads` added **8 sidecar cases** between the readings. The same goes for the vitest total: `6997c86 audit(U2): pin the musaeum scheme's corsEnabled` added the invariant-9 CORS case (its comment reads *measured 2026-09-25*), which is the `test/invariants.test.ts` +1 I first recorded as *unexplained* — it was a commit, in a file I never touched, and the file's hash matches HEAD's. **Both of those rises are other sessions' work, not this slice's.** The lesson the next session needs: this repo has concurrent sessions, so a gate number describes a commit and a moment, not "the tree" — record `git rev-parse --short HEAD` beside every count, and never call a tree frozen without checking `git log` first.

And the eighth code file is still the honest deviation: `src/types/api.types.ts`, which the row did not list and the preload cannot typecheck without. `sidecar/pipeline/cover.py` and `src/types/metadata.types.ts` are byte-unchanged (`git diff --quiet`).

**Gates, at `a23d0b3` with this slice's work uncommitted:** `pytest` **148 passed** (baseline **125**), `typecheck` 0, `lint` 0, prettier **code** clean, and frozen-tree `npm test` **1574 passed / 70 files** after the renderer slice landed. **What "prettier clean" means here, since it is narrower than it sounds:** in this repo `prettier --check` is meaningful for code only. Every markdown file writes emphasis as `*x*` where prettier wants `_x_` — `tasks.md` carried **26** such lines and `CHANGELOG.md` **127** at `a23d0b3`, before any of this feature's work — so the repo's prose convention is `*x*` and the mismatch is left for a formatting pass that is not this slice's business. The check is clean on every code file this feature touches; it is not, and was not, clean across the markdown. **Mutation campaign: 12 of 12 killed** on the sidecar and service, plus **12 of 12** for slice 2's rows re-run against the moved lib and **4 of 4** for the searched group's own derivation. One row **survived first and was a real finding** — the url guard in `search_candidates` had no decider, because the two fetchers always set a url, so nothing exercised the branch. The test now names it, and says why the guard exists: `services/cover-choice.ts` refuses an online choice with no url (its slice-1b D6 refusal), so an url-less entry would become a tile that cannot be chosen. The searched group's rows survived nothing; the renderer slice's own audit had already caught and fixed one survivor of its own (a stable re-sort, invisible against a best-first fixture).

**Note for whoever probes the UI next:** Electron moved **37 → 44** under this slice (`3a48e00`, another session). The Python probes here are unaffected; the running-app evidence for the renderer slice was captured on 44, and slice 2's frames were captured on 37 — do not compare them pixel-for-pixel across that boundary.

**What must not have moved, checked:** `sidecar/pipeline/cover.py` and `src/types/metadata.types.ts` are byte-unchanged (`git diff --quiet`), no migration exists for this feature, nothing was written to the library or the dev database (the probe reads a copy in an isolated profile), and `metadata.json`'s identifier shape is untouched — the work's ISBN list is read at search time only (D5).

**What the build taught:** the widening was never a search-quality problem. The app received the identifier that reaches the right jacket in a payload it already fetches, and asked its narrowest question instead — so the feature is one *question*, asked deliberately, and the whole safety argument is the order the questions are asked in.

**What 3a left for 3a-ii, and it was the visible half:** the picker's trigger and your own image. Nothing in 3a was reachable from the UI, which is why AC7 was proven through the sidecar rather than on screen.

## Built — slice 3a-ii (2026-09-25)

**The row said 4 files and the build is 4** — the only slice in this feature whose count was right (3a's row was short by `src/types/api.types.ts`; slice 2's by three). But the build still found one file the row could not have named, and it is the slice's most important rule.

**What the mutation found, and why it mattered.** The searched group's whole premise is that the measured payload carries **two `google_books` jackets** (1352×2103 and 800×1245) and that a user picks *between* them. That premise is safe only if a tile's identity is the **pair** `setCover` takes — `(source, url)` — and not the source. The builder wrote that rule, said why in a comment, and left it in `CoverPicker.tsx`. Weakening it to `a.source === b.source` left **every test in the repository green**: the rule that stops a pick from marking *both* MIT tiles as the book's own cover had nothing deciding it at all. It now lives in `src/lib/cover-candidate-state.ts` beside `candidateMark`, where a `.tsx`-shaped rule can have a unit decider at all, with four cases of its own (**lib 15 → 19**): two jackets from one source are two candidates *and* two React keys; a candidate is itself; the file's own jacket — the one candidate with no url — still needs no other branch; a different source is a different candidate whatever the url. The mutation is now killed, which is the only form of proof that would have caught this.

**Gates, at `a23d0b3` with this slice's work uncommitted:** `typecheck` 0, `lint` 0, prettier **code** clean (see the markdown note above), frozen-tree `npm test` **1578 passed / 70 files**, and the slice's campaign **5 of 5 killed** (4 in the lib's derivations, 1 on the component's call site, every file restored byte-exact).

**AC8 and AC10, in the running app** — isolated profile `/tmp/probe-cover`, Electron 44, and the real row rebuilt into the probe library *through the app's own path* (`library.rebuildCatalog` → 2 books; the hand-inserted row had been synced away at startup, which is invariant 1 behaving exactly as designed):

- **The trigger exists and reads honestly.** With the picker open on *Topology of Violence*, the dialog shows the gather's two tiles — OpenLibrary 304×500 marked *On your book now — and a fetch would write it* (the **Spanish Herder** jacket, the defect itself) and the file's own 800×514 — then *Look for more covers* with its line: *Searches this book's other editions — by their ISBNs, then by title and author.*
- **Pressed at t=0, tiles at t+6s** — live Google, no cache, the app's real round trip. `GOOGLE BOOKS 1352×2103` and `GOOGLE BOOKS 800×1245`: the two English MIT jackets this design predicted, under *From a wider search*, with both sentences (*A fetch would not write any of them — nothing changes unless you pick one*; *a search offers jackets and never applies one*) — **and the Spanish jacket still on the book.** Nothing was written or applied by searching, which is D1/D4 on screen.
- **The pick writes what slice 1b writes.** Choosing the 1352×2103 tile put `cover_full.jpg` at **600×933** and `cover_thumb.jpg` at **200×311** in the book's folder (aspect preserved exactly), repainted the grid card through `musaeum://cover/…/thumb?v=2026-09-26T02:23:32.827Z` at natural 200×311, kept the panel and the card in agreement, and moved the marks correctly: the picked tile reads *Google Books is now the cover on this book*, OpenLibrary loses *On your book now* and reads *A fetch would write this*, and the file's own reads *Held: a metadata fetch will not change this cover.*
- **Frames:** `frame-3aii-01-detail.png` (before), `-02-picker.png` (the trigger), `-03-searched.png` (the money shot), `-04-grid-after.png` (after), `-05-before-after.png` (the composite: *Topología de la violencia*, Herder → TOPOLOGY OF VIOLENCE, MIT) — all in the verification scratch dir, all vision-checked as renders rather than as files.

**One observation from looking, not from a test, and not fixed here:** the first searched row's captions sit on the dialog body's scroll cut, so the group arrives partially clipped until you scroll. Legible, reachable, and a styling pass rather than a behaviour — recorded so the next visual pass starts with it.

**What is left is 3b** — your own image — and nothing else.

## Built — slice 3b-i (2026-09-25)

**The row said 8 files; the plan said 12 across two halves; 3b-i came in at exactly the plan's 8.** The split is the record's honest part: the row folded the renderer's button into the slice that crosses the main-process dialog boundary, and it missed `src/types/api.types.ts` for the second time in this feature — a new preload method does not typecheck without it. So 3b-i is the write path with no UI at all, and 3b-ii is the button.

**What it does.** `set_cover_from_file(book_dir, image_path)` in the sidecar reads the file, refuses it or not, and writes through `_write_chosen(data, book_dir, "upload")` — so the 600/200 renditions come from `_renditions` and the filenames stay `cover_full.jpg` / `cover_thumb.jpg`, one encoder and one thumbnail rule in the app. `chooseUploadedCover(bookId, imagePath)` is a sibling of `chooseCover`, and `chooseCover`'s tail was **extracted into `settleChoice`, not copied** (D6-c): row → `markFromPatch(…, null)` → `metadata.json` → catalog → broadcast, one implementation for both gestures. The dialog lives in `ipc/metadata.ts` behind an injectable `ShowImageDialog` (the `ipc/nas.ts:27` precedent), and `src/types/api.types.ts` freezes the renderer's side as *a bookId in, a book or a cancellation out* — so the chosen path never crosses the boundary and invariant 9 is not strained by this feature at all. Two design calls paid off in the same place: **no fourth member of the source vocabulary** (`SOURCE_PRIORITY` gains no key, `_score` untouched — the upload is a write, not something the gather could have produced) and **no `hydratableFile` on this path**, which is why a book with no EPUB — a PDF-only book — can now be dressed, the one case where an upload beats both databases.

**The finding, and it was mine, not the build's.** The guard validated with `Image.open(...).size`, which reads a file's dimensions **lazily**. So a *truncated* image — a half-finished download, the most plausible damaged file a person picks — passed the guard and failed later, in the writer's decode, arriving at the dialog as `OSError: image file is truncated (2 bytes not processed)` instead of the sentence D6 promises. Measured with a hand-written probe over six refusal shapes, each in its own folder with the folder compared before and after: nothing was ever written (the write is prevented either way, because `_renditions` runs before the files are touched), so this was never a data hazard — it was the app showing a Python exception where it promised to say *why*. Fixed by making the guard read the pixels (`img.load()`), which also makes "nothing is written" **structural** rather than inherited from `_write_cover`'s internal ordering, and by giving a damaged image its own sentence: *"That image is damaged — Musaeum could not read all of it"*, distinct from *"That file is not an image Musaeum can read"*, because the second would be false about a file that plainly is one. **Why the build's own campaign missed it:** its six rows were floor-deleted, floor-re-chosen, not-an-image-bypassed, read/validate-skipped, tail-copied and dialog-returns-the-path — no row was *a damaged image*, because a mutation can only attack a rule a test already names. That is the asymmetry worth remembering: mutation proves a rule has a decider, and can never prove the rule set is complete. The new case fails on both my fix's own row and on the collapse of the two sentences back into one.

**Gates, at `8a5f67f` with 3b-i uncommitted:** `pytest` **156 → 157** (148 before this slice), `typecheck` 0, `lint` 0, prettier clean on code, focused vitest **24 / 24** (16 before this slice), and **5 of 5 mutations killed** — three sidecar rows re-derived by hand so each kill names its failing case (the floor, `img.load()`'s absence, the collapsed sentences), two service rows (a tail that writes the row but never marks it — 3 cases red; the upload inheriting the gather's pre-flight, which the PDF-only case catches). Every mutated file restored byte-exact by sha256. **AC12 verified by my own probe, not by the shipped test:** a `.txt`, a 3-byte file wearing `.jpg`, a 100×300 image, a missing path, a directory and a truncated JPEG all refuse with a sentence and leave the folder with nothing new in it. **AC13:** `git diff --quiet electron/main/schema/migrations` clean; `src/types/metadata.types.ts` clean; `cover.py` **+61/−0** before this session's fix, so `SOURCE_PRIORITY`, `_score`, `score_candidates` and `select_cover` are byte-identical (D6-b).

**Two deviations accepted, one noted.** The dialog is **not** parented to a `BrowserWindow` — the brief asked for a parent, the plan said "exactly as the other four do", and all four existing dialogs (`migration`, `settings`, `theme`, `library`) call `dialog.showOpenDialog(options)` with no window; `handle()` gives a handler no event, so a parent would need a new main-window accessor and a ninth file. Consistency with four precedents wins, and `src/types/api.types.ts` gains a named `CoverUploadOutcome = Book | { cancelled: true }` (the union needs a home; `BulkDeleteResult` is the precedent). **Found while building and not fixed:** `docs/data-contracts.md` has lagged this feature by four slices — its sidecar method table has neither `cover_candidates`, `set_cover` nor `search_covers`, and its preload sketch has no `CoverChoice`/`coverCandidates`/`setCover`, so `set_cover_from_file` and `chooseCoverFromFile` follow an existing gap rather than creating one. That is the contract document, so it wants a pass of its own.

**What 3b-i does not do:** nothing in it is reachable from the UI. AC11's probe and frame belong to 3b-ii.

## Built — slice 3b-ii (2026-09-25)

**Four files, exactly the plan's count** — the first slice in this feature whose row was right twice running. `src/components/library/CoverPicker.tsx` (+185/−12, 663 lines): the **Choose an image…** control beside *Look for more covers* — a trigger with its own line (*Uses an image file from this Mac, chosen in Musaeum’s own dialog*), `uploading` / `uploadReading` / `uploadError` / `readRun` state, `chooseImage`, and a `disabled` prop on `TileButton`. `src/lib/cover-candidate-state.ts` (+111, 319): `UPLOAD_TRIGGER_LABEL`, `UPLOAD_TRIGGER_LINE`, `UPLOAD_APPLIED`, `CoverUploadReading`, `coverUploadReading()`, `uploadRefusal()`, `UploadCopy`, `uploadCopy()`. Its test (+101, 414 lines, 26 cases from 19) and `cover-picker-wiring.test.ts` (+97, 218 lines, 8 cases from 5 — the allow-list goes 5 → 6 names with `metadata.chooseCoverFromFile`, plus two walk cases). No fifth file: the icon is `ImageIcon`, already in `icons.tsx`.

**The mechanism, since it is the part a later hand would get wrong.** The re-read of what the book now wears *is the mount effect, re-run*: `readRun` is in its dependency list, so a settled upload re-reads the gather's payload **and** `getFieldOverrides` — the lock line is re-read, never assumed — and `load()` repaints the panel through the row's own `?v=` clock. Nothing sets `applied` from the upload's return value: `setPicked` still has exactly one call site, in `choose`. That is the boundary holding: the renderer learns what happened by looking, not by being told.

**One judgement beyond the brief, verified by me and kept.** `uploadCopy()` stands the gather's notice down once an upload has settled. Without it the dialog prints *"None of these is the cover on your book now — it was resolved from a conflict, or replaced outside Musaeum"* one paragraph below *"Your image is now the cover on this book"*, and the first half of that sentence's *explanation* is false: the cover was replaced **inside** Musaeum, by the person reading it. The stand-down is one clause (`gatherNotice: !settled`) with a case and a walk assertion; the child extended the busy state to disable the search trigger and both tile grids too, since two writes share `cover_full.jpg`/`cover_thumb.jpg`.

**The finding this slice produced, and the copy it deleted.** `setUploading(true)` runs *before* the IPC that opens the native sheet, so `uploading` spans two phases — the person browsing their disk, and the write — and the dialog read **"Writing that image as the cover…"** for *both*. Seen in the running app: with the sheet open, the dialog behind it claimed a write nobody had chosen yet, and a cancellation left it saying so until the press resolved. Nothing on this side can tell the phases apart, and on purpose: D6-a is that the path never reaches the renderer, so "choosing" and "writing" are not two things a renderer can see. So `UPLOAD_BUSY` was **removed** rather than reworded — the trigger's spinner is the whole signal while the control is mid-gesture, and the dialog keeps only sentences that are true of the book. **Recorded rather than pinned:** the removal has no decider, because the only test that could stand for it would scan the copy module for words like *writing* — pinning prose, and failing on any later honest sentence that used them. The reasoning lives in the block comment above `UPLOAD_APPLIED`, and in this diff. (The child's own 16-row campaign had a row for "the busy line renders", which dies with the line; every other row in it stands.)

**AC11 verified live, through the real native file sheet** — not stubbed. The probe app ran on an isolated profile (`MUSAEUM_USER_DATA=/tmp/probe-cover`) with its own library copy, and the sheet was driven with Accessibility keystrokes (⌘⇧G, the path, Return), which is the only honest way to reach `dialog.showOpenDialog` from a CDP session. In one continuous run: pressing **Choose an image…** and choosing a 1200×1600 file showed the spinner, settled in **~2 seconds** on *"Your image is now the cover on this book."*, **removed the gather's notice** (the stand-down, live), kept the *Held:* line, and moved the row's clock — the panel's `?v=` went `02:23:32.827Z → 02:57:11.598Z` and, on the final run from the final build, `…03:02:57.980Z`. **The book itself changed:** `cover_full.jpg` **600×800**, `cover_thumb.jpg` **200×267**, and the written 600×800 **is the file that was chosen** — mean per-pixel difference **0.43/255** against the source, i.e. a re-encode and not some other image; the detail panel reads 600×800 and the grid card 200×267. The lock is real at rest: `app_config.field_overrides` = `{"7ae66296-…":["cover"]}`. Both refusals render the sidecar's own sentence in the dialog and **write nothing** — a 3-byte file wearing `.jpg` reads *"That file is not an image Musaeum can read"*, a 100×300 image reads *"That image is 100x300 px — a cover needs at least 120 px on each side"* — and **cancelling says nothing at all**; the clock stayed frozen at `02:57:11.598Z` across all three, which is what "nothing was written" looks like as evidence rather than as a claim. Frames: `frame-3b-01` (landed), `frame-3b-02` (refused), `frame-3b-03` (cancelled), `frame-3b-06` (the busy line, kept as the defect's own evidence — the state no longer exists), and `frame-3b-09`, a before/after of the panel: the wider search's orange MIT jacket beside the book wearing the uploaded image, legible.

**Gates.** `typecheck` 0, `lint` 0, prettier clean on all four files, focused vitest **33 / 33** (2 files), and my own three mutations on the stand-down rule **3 of 3 killed** with the failing assertion visible: `gatherNotice: true` (the notice stops standing down), `settled = reading !== null` (a refusal read as a landing), and `line: UPLOAD_APPLIED` (the landed sentence printed always). The child's campaign ran 16 rows to 16 kills after fixing three first-pass survivors — swallowing the refusal line, dropping `uploading` from a trigger's `disabled`, and hardcoding the notice gate each had **no decider at all** until it wrote one. Its stated residual: that the effect actually *re-runs* on `readRun` is not something a walk can decide, and is the probe's half — which is where the `?v=` movement above comes from.

**Found and not fixed, recorded not glossed.** (a) On a PDF-only book the gather refuses on open, so its red sentence sits above the new control and stays there after a successful upload — pre-existing on mount, but this slice is the first time the two coexist; a copy/layout pass. (b) A refusal leaves the *landed* sentence standing above it, so a person who uploads successfully and then picks a bad file reads both at once. Both statements are true and they are different slots, but the reading is odd — a copy pass, with the owner's taste as the judge. (c) `docs/data-contracts.md` still lacks the whole cover method/IPC family, four slices stale (3b-i's finding, unchanged).

