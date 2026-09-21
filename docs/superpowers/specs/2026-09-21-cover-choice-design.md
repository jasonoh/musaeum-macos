# Design: choosing a cover (metadata, v1)

**Date:** 2026-09-21
**Status:** Proposed — signed off by Jason 2026-09-21 ("recommendation 1 with 2 folded in"), slices 1a → 1b → 2
**Scope:** Let a person choose which jacket a book wears, from the candidates the fetch already gathers — plus the fetcher fix that stops handicapping Google's jacket before the contest starts. Deliberately not: a cover from a local file, crop/rotate, persisted candidate lists, or the device-side cover work (`tasks.md` Kindle presence).
**Depends on:** field overrides (`docs/superpowers/specs/2026-09-20-field-overrides-design.md`), the refresh feedback surface (`docs/invariants/refresh-feedback.md`), the cover scoring pipeline (`docs/invariants/metadata-hydration.md`)
**Interacts with:** the conflict queue's cover leg (`services/conflicts.ts`), the metadata editor's `OverrideChip` (`BookEditor.tsx`), the `musaeum://cover` route and `index.html`'s CSP (see D3), the detail panel's cover block
**Supersedes:** the cover-replacement gap recorded at `tasks.md:73` — once this lands that line's first gap closes there, and this document is the single source of truth for it.

---

## Why now

Reported 2026-09-21 from the running app: a freshly imported EPUB (*Artificial Intelligence*, Melanie Mitchell, book `609f0ecb-de10-40e0-8fd0-e2888704abee`) wears a plain cream jacket, **Re-fetch metadata** changes nothing, and there is no way to set the cover by hand. Read-only against the live library, the sidecar's own pipeline and the real APIs:

- **The hydration succeeded.** `metadata.json` records `google_books` (conf 0.98, fetched 10:52:07Z) and `openlibrary` (conf 0.95, 10:52:08Z), and **zero** conflicts were queued for the book — so nothing failed and nothing was offered for review.
- **The cover on disk is the EPUB's own image.** `cover_full.jpg` (600×907) is a re-encode of `OEBPS/images/9780374715236.jpg` (1290×1950) from inside the file. Re-running `select_cover` against a copy reproduces it byte-identically with `changed: false`, and a full `hydrate_metadata` re-run returns `changed: false` too — so a re-fetch *cannot* change this cover, and "does nothing" is the code being right about a cover the user dislikes.
- **Three real jackets were in hand.** Scores from the shipped formula (`sidecar/pipeline/cover.py:25`): embedded 1290×1950 → **0.832** (winner), OpenLibrary 307×500 → 0.530, Google Books 128×198 → 0.511. Margin **0.302** against a **0.125** review band (`cover.py:76`), so no cover conflict — and the conflict queue is the only place a cover choice exists today.
- **Google is structurally handicapped.** `sidecar/fetchers/google_books.py:74-78` takes the largest *advertised* `imageLinks` key and rewrites `zoom=5|2` **down** to `zoom=1`. Sampled 12 library ISBNs: 11 advertised only `smallThumbnail`+`thumbnail` (~128 px) and the twelfth advertised no image at all; those 11 answer `zoom=0` with 477×720 … 2164×3398. At `zoom=0` this book's jacket scores **0.944**, beating embedded with a margin of **0.111** — *inside* the band, so the app would **offer the choice** instead of silently deciding.

So the defect is not the fetch: it is (a) a fetcher asking Google for its smallest rendition and (b) no path for a person to overrule the score. Both mechanisms exist next door — `resolveConflict`'s cover leg downloads a chosen URL through the sidecar and locks the field (`services/conflicts.ts:38-50, 64`), and `select_cover` already *returns* the candidate list (`cover.py:86-90`) which `hydration.py` throws away unless it queues a conflict (`:118-131`).

**And the measurement cut against the easy half of the thesis.** `zoom=0` is not a uniformly better URL: three of eleven sampled volumes returned the **same** 575×750 "image not available" tile — byte-identical (md5 `a64fa89d7ebc97075c1d363fc5fea71f`) for three unrelated books — while `zoom=1` returned three distinct real jackets for those same books. A naive `zoom=1 → zoom=0` rewrite would trade a small real cover for a placeholder on exactly the books that lack one, for a score of 0.783 that beats most embedded covers. That is why the fetcher fix is its own slice with a census (D5, AC2–AC3) rather than a line folded into the UI work.

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| Candidate gathering, scoring, the review band, and that `select_cover` returns the scored list | `sidecar/pipeline/cover.py:43-91`, `:76`, `:86-90` |
| …and that `hydration.py` drops that list except when it queues a conflict | `sidecar/pipeline/hydration.py:118-131` |
| A locked cover gathers no candidate at all, so a lock is honoured for free | `sidecar/pipeline/hydration.py:99-103` |
| Applying a chosen cover already exists end to end: sidecar download → row → `metadata.json` → lock → catalog → broadcast | `electron/main/services/conflicts.ts:38-50`, `:64-77` |
| `cover` is a first-class `HydratedField`; both cover columns map to it | `src/types/metadata.types.ts:28-32`, `:70-71` |
| The lock store's API: `list` / `markFromPatch` (diff-guarded, and the guard is documented as a property of one caller) / `release` | `electron/main/services/field-overrides.ts` |
| The padlock + release control, rendered per *editor* field | `src/components/library/BookEditor.tsx:426-460` |
| The cover URL is constant per book — `musaeum://cover/{id}/{size}` — and `BookCover` remembers a failed URL *by value* | `src/components/library/BookCard.tsx:21-24`, `:37-59` |
| The cover route parses the **pathname only** (so a query string is free), and 404s a missing file | `electron/main/index.ts:56-80` |
| The one-funnel lib precedent for a user action that reports through the store | `src/lib/metadata-refresh.ts` |
| Session-only UI state lives on `ui.store` beside the panel it opens (`editingBookId`) | `src/stores/ui.store.ts:97`, `:201` |

**Not true today, and inside this feature rather than free:**

- **No sidecar method returns a candidate list, and none sets a chosen cover.** `fetch_cover(book_dir, url, source)` exists (`cover.py:137`) but takes a URL only — an *embedded* candidate has no URL, so "put the file's own jacket back" is not expressible.
- **No candidate image can be shown in the renderer.** `index.html:8`'s CSP is `img-src 'self' musaeum: data: blob:` — **no `https:`** — so the conflict resolver's `<img src={value}>` with a remote URL (`ConflictResolver.tsx:23-32`) is blocked by the CSP as written. That is a pre-existing defect in the only cover UI that existed; candidates must travel as data URLs or through `musaeum://` (D3).
- **A cover override has no release.** The editor renders its padlock per field **it** edits and has no cover row, so a `cover` lock set from anywhere else is unreleasable from the UI today (D4, AC14/AC17).

---

## D1 — Candidates are gathered live, when the picker opens

**Decision:** `cover_candidates` runs the gather step at the moment the picker opens — the same three requests a hydration makes — and writes nothing. Nothing about the candidate list is persisted, and `metadata.json` is untouched by this feature.
**Why:** persisting means a new member in the file the iOS contract documents (`docs/data-contracts.md`), holding data that is stale-able by definition (a jacket URL can rot) and that is only ever wanted at the moment of a user action. The gather is one flag-free sidecar call with a spinner already on screen, and it works on a book that has never been hydrated. The alternative — extend `metadata.json` + a `books` column with `cover_candidates` — buys offline capability for a modal that cannot *write* offline anyway (the write is a NAS write), which is the argument that settles it.
**Consequence:** the picker needs the network and the sidecar; offline it says so (AC16) rather than showing an empty grid. `tasks.md:58` ("persist cover `source`/`width`/`height`") is *not* discharged here and is not needed here.

## D2 — Two sidecar methods, and the main process orchestrates nothing

**Decision:** `cover_candidates({book_id, file_path, book_dir})` and `set_cover({book_id, file_path, book_dir, source, url?})` are sidecar methods on the existing `METHODS` table (`sidecar/main.py:44-46, 56+`); the main process's new service calls them through `sidecar.call` and never touches an image or a URL itself.
**Why:** the candidate set is only computable where the file is — an embedded candidate means opening the EPUB's zip and decoding an image, which is PIL and `extractors/epub_metadata.py` territory, not Node's. It also keeps the *decision* out of the renderer: the renderer echoes back a `{source, url}` pair that the sidecar itself produced (D6's refusal), never a URL it invented.
**Consequence:** the picker's candidate payload is a sidecar contract; a change to what a candidate carries is a sidecar change plus a type change, in that order.

## D3 — Candidate images travel as data-URL thumbnails

**Decision:** every candidate carries `thumb: 'data:image/jpeg;base64,…'`, a ≤240 px JPEG (q80) rendered by the sidecar from the same bytes it scored. The payload is capped by construction: one entry per gathered candidate (3–4 in practice), ~6–20 KB each.
**Why:** the CSP already allows `data:` for images and forbids `https:` (`index.html:8`), so a remote URL in an `<img>` cannot render — which is precisely what is wrong with the existing cover-conflict UI. The two alternatives are worse: a new `musaeum://` host for candidate thumbs means a temp directory with a lifecycle nobody owns, and adding `https:` to `img-src` widens a stated promise (`docs/project-overview.md` §3.5, cited in `tasks.md`) — refused, not negotiated.
**Consequence:** the sidecar becomes the only producer of viewable candidate images, so the conflict resolver's own cover candidates — which are stored as URL strings in `metadata_conflicts` — can later be repaired by routing them through the same summariser. Deliberately **not** in this spec — see *Rejected and deferred*.

## D4 — A pick is a user decision: it locks `cover`, and the picker owns the release

**Decision:** choosing a candidate writes the bytes, updates the row, rewrites `metadata.json`, upserts the catalog, and marks `cover` in `field_overrides` — the same five things a resolved cover conflict does (`services/conflicts.ts:64-77`). The marking is done by `markFromPatch(bookId, {coverFullPath, coverThumbPath}, null)`: `before = null` is deliberate, because the gesture *is* the decision and the diff guard exists to stop a form from locking fields the user never touched.
**The release lives in the picker**, as the same padlock chip the editor uses (`BookEditor.tsx:426-460`), calling `release(bookId, 'cover')`. The editor cannot own it: it renders chips only for the fields it edits and has no cover row (AC17 makes that gap explicit in `docs/invariants/settings-and-editing.md`).
**The lock is the fetch's, not the picker's.** A locked cover makes the *hydration* gather no candidates at all (`hydration.py:99-103`) — that is the lock working; `cover_candidates` deliberately does **not** honour it, because the user reopening the picker to choose a different jacket is exactly the thing the lock must not prevent.
**Why:** without it the next re-fetch can revert the choice (which is today's behaviour and the reported complaint), and the app already has one vocabulary for "a field the user set outranks a fetch". A second meaning for the same word would be worse than the lock.
**Consequence:** a cover lock becomes visible in a surface other than the editor — the first such field — and the editor's padlock is no longer the only way out of one.

## D5 — Google is asked for `zoom=0`, guarded against its placeholder

**Decision:** `fetchers/google_books.py` normalises the advertised image URL to `zoom=0` (rather than down to `zoom=1`) and **drops the result** when the downloaded bytes equal Google's "image not available" tile, falling back to the advertised thumbnail. The tile is one named constant holding its md5 (`a64fa89d7ebc97075c1d363fc5fea71f`, 575×750, 9,103 B — measured 2026-09-21, byte-identical for three unrelated volumes), with its provenance in the comment beside it.
**Why:** the API never advertises anything larger than 128 px (11 of the 12 sampled volumes advertised only `smallThumbnail`/`thumbnail`; the twelfth advertised nothing), so today's fetcher cannot reach the artwork that exists — for the reported book that is the difference between silently wearing a plain jacket and being *offered* the recognised one. The guard is what stops the fix from being a regression: without it, three of eleven sampled volumes would have traded a real 128 px jacket for the placeholder, which scores 0.783 and would win over most embedded covers.
**Alternatives:** dimensions-only detection (575×750) — rejected as the primary because a genuine cover can be that size, and a false drop is silent; skipping `zoom=0` entirely — rejected, it is the reported defect. Both remain available as the reversal if the md5 stops matching.
**Consequence:** **a re-fetch can now move a cover that it could not move before**, library-wide (**7,107** rows in the dev database as of 2026-09-21; nothing re-hydrates by itself). That is the intent, and where the two candidates are close the review band now offers the choice instead of deciding — but it is a behaviour change on a path other than the one being asked for, which is why it lands as its own slice with its own census (AC3) rather than inside the UI work.
**Residual, stated:** the tile's md5 is a third-party artifact. If Google changes it, the guard stops working *silently* and the placeholder becomes a normal candidate. What makes that visible rather than invisible is the census printing every winner's md5 (AC3): a hash shared by unrelated books is the signature.

## D6 — `set_cover` refuses a pair it did not gather

**Decision:** `set_cover` accepts `source` plus, for the online sources, the `url` the gather returned, and refuses anything else: a `source` not in `SOURCE_PRIORITY` (`cover.py:19`), a non-embedded candidate with no url, or an embedded candidate with one. The refusal is a value, not a throw, and it never reaches the network.
**Why:** the renderer is the one place in this app that must not be able to name a URL and have the main process fetch it (invariant 9's spirit: the renderer never gets `file://`, and by the same reasoning it does not get to hand the main process an arbitrary egress). The picker only ever echoes back what it was given, so the constraint costs nothing.
**Consequence:** the check has to be *on the main-process side of the boundary* — a renderer-only validation would be the same rule the CSP exists to avoid trusting.

## D7 — A chosen cover must repaint without a restart, and the mechanism is decided by a probe

**Decision:** the requirement is that both surfaces which show the book's cover — the detail panel's `full` and the grid card's `thumb` — show the **new pixels** after a choice, with no relaunch. Whether that needs a mechanism at all is decided by a probe in the running app (AC13): `musaeum://cover/{id}/{size}` is a **constant URL per book**, so a replacement at the same URL is the one case `BookCover`'s by-value `failedUrl` comment does not cover (`BookCard.tsx:44-48` guards a *changed* URL).
**If the probe shows no repaint**, the mechanism is chosen in this order: (1) `coverUrl()` appends `?v=<row.lastModified>` — the row already carries the clock, the route parses the pathname only (`electron/main/index.ts:56-80`), and nothing about caching semantics changes for the other 7,106 books; (2) failing that, the cover route answers with a revalidation header, which costs a NAS read per cover and is therefore only acceptable if (1) does not work. **Not** a `no-store` header on the route: that is a per-repaint NAS read on the grid's hottest path.
**Consequence:** if (1) is needed it also fixes any pre-existing staleness on the conflict-resolution path — one function, both views.

---

## Store and component shape

`ui.store` gains `coverPickerBookId: string | null` and `requestCoverPicker(bookId | null)`, modelled on `editingBookId` / `requestEdit` (`src/stores/ui.store.ts:97, 201`): **session-only**, never persisted (the persisted-store rule in `docs/invariants/settings-and-editing.md`), and cleared by the same paths that clear the other modals. The picker is mounted in `App.tsx` keyed on the book id, as `BookEditor` is. Everything else the picker needs — the candidate list, which is busy, the last error — is local component state: it is derived from one call and dies with the modal, so it does not belong in a store that survives it. No DOM nodes in the store.

## Acceptance criteria

### Slice 1a — the fetcher asks for Google's big jacket

1. For a volume whose `imageLinks` advertises only `smallThumbnail`/`thumbnail`, `fetch_google_books` returns a `zoom=0` URL. Decider: `sidecar/tests/test_google_cover.py`, offline (recorded volume shape + a fixture image), no network.
2. A `zoom=0` response whose bytes **equal** the recorded placeholder is discarded and the advertised thumbnail is returned instead; a **different** image of the same dimensions is kept. Two cases, same file.
3. Read-only census over ≥25 real ISBNs from the dev database, reporting per volume: `zoom=0` dimensions + md5 + score, `zoom=1` dimensions + score, and (where the book exists) the embedded cover's score; then (a) how many winners flip from embedded to Google, (b) how many `zoom=0` responses are the placeholder, (c) **the set of md5s among the winners** — a hash shared by unrelated books is the signature of an unguarded placeholder. Decider: the scratch harness (outside the repo, so it costs no file in the budget); the numbers are quoted in *Built — slice 1a*. This criterion is the one that decides whether the slice is an improvement on this library rather than in principle.

### Slice 1b — candidates, and setting one (sidecar → service → contracts)

4. `cover_candidates` returns one entry per gathered candidate carrying `source`, `url` (absent for `embedded`), `width`, `height`, `score`, `winner`, `applied` (true when the candidate's bytes are identical to the stored full cover), and `thumb` as a `data:image/jpeg;base64,` URL ≤ 240 px. Decider: `sidecar/tests/test_cover_candidates.py` (synthetic EPUB fixture + monkeypatched fetchers).
5. The `embedded` candidate's bytes are the EPUB's own cover image, byte for byte. Decider: same file (md5 against the fixture's known image bytes).
6. `set_cover(source='embedded')` restores the file's own jacket exactly: the bytes written to `cover_full.jpg` equal `_encode(extract_embedded_cover(file))`. Decider: same file, round trip through `tmp_path`.
7. `set_cover` refuses a `source` not in `SOURCE_PRIORITY`, an online source with no url, and an embedded source *with* one — and in every case reaches no network. Decider: `electron/main/services/cover-choice.test.ts` (vitest).
8. A choice writes the cover bytes, updates the row's two cover columns, rewrites `metadata.json` (whose `cover` names the same two fixed filenames), upserts the catalog, and returns the updated book. Decider: `cover-choice.test.ts`, with the sidecar stubbed.
9. **A choice marks the override even when the chosen candidate is already the one applied.** Decider: the guard case in `cover-choice.test.ts`, asserting `list(bookId)` contains `cover` while the row's values before and after are equal. Without this half of AC8, "the choice is recorded" passes on an implementation that records nothing.
10. With `cover` overridden, a hydration gathers no candidate and reports a change set without `cover`. Decider: `sidecar/tests/test_hydration_locks.py:150` (`test_a_locked_cover_is_not_even_selected` — cited, not re-written) plus one assertion on the extracted gather if the refactor moved the guard.
11. The gather refactor is behaviour-preserving: fed the reported book's three candidate descriptors, `select_cover` picks `embedded`, reports `changed: false` against the stored bytes, and queues no review. Decider: a unit case over those descriptors (no network), run against both the pre- and post-refactor call path.

### Slice 2 — the picker

12. Opening the picker on a book lists every gathered candidate as an image with its source label, marks the applied one, and marks the winner when it differs from the applied one. Decider: CDP probe + one frame.
13. Choosing a candidate changes the cover **pixels** in the detail panel and on the grid card, with no relaunch. Decider: CDP — capture the cover region before and after and compare the frames (the mechanism's evidence is `coverFullPath`/`coverThumbPath`, but the criterion is the pixels, because D7 exists precisely because the row can be right while the image is stale).
14. Once chosen, the picker shows the cover as held, and releasing it lets the next re-fetch move the cover again. Decider: CDP probe reading `library.getFieldOverrides(bookId)` before and after the release, plus a re-fetch whose outcome names the cover.
15. Every `thumb` in the assembled payload is a `data:` URL, asserted over the serialized candidate array's **leaves** rather than over the JSX. Decider: `cover-choice.test.ts` (shape criterion), because a component with a remote `src` satisfies every rendered-state assertion while the CSP blocks the image.
16. A gather that cannot run (offline, no sidecar, no EPUB/MOBI/AZW3 in the folder) produces a sentence in the picker naming the reason, never an empty grid. Decider: the refusal shape in `cover-choice.test.ts` + the picker's error path in the app pass.
17. `docs/invariants/settings-and-editing.md` states that a `cover` lock's release lives in the cover picker, not in the editor. Decider: source walk (the sentence is present and names the picker).

## Slices, and why they are cut this way

**Slice 1a (2 files).** Edited: `sidecar/fetchers/google_books.py`. New: `sidecar/tests/test_google_cover.py`. Invisible on its own — nothing in the UI changes — and that is the point: it is the change with a library-wide consequence (D5's blast radius) and it has a decider that speaks about the real library (AC3), so it lands and is measured alone before any UI depends on it.

**Slice 1b (9 files, at the house bound).** New: `electron/main/services/cover-choice.ts` (pre-flight, gather, apply, lock, catalog, broadcast — the `conflicts.ts` cover leg given a home of its own rather than a second copy), `sidecar/tests/test_cover_candidates.py`, `electron/main/services/cover-choice.test.ts`. Edited: `sidecar/pipeline/cover.py` (extract `gather_candidates`, add the summariser and `write_choice`), `sidecar/pipeline/hydration.py` (call the extracted gather, so candidates have one home), `sidecar/main.py` (two methods), `electron/main/ipc/metadata.ts` (two thin handlers), `electron/preload/index.ts`, `src/types/api.types.ts`, `src/types/metadata.types.ts`. It stops at the boundary because everything it adds is decidable today — pytest for the sidecar, vitest for the service — and the next part is not.

**Slice 2 (6 files).** New: `src/components/library/CoverPicker.tsx`. Edited: `src/stores/ui.store.ts`, `src/App.tsx`, `src/components/library/BookDetail.tsx` (the control on the cover block, `BookDetail.tsx:83-84`), `src/components/library/BookContextMenu.tsx` (the same action, both entry points opening one modal), `docs/invariants/settings-and-editing.md`. The UI comes last because the renderer has no DOM harness: its evidence is a running-app probe, and this slice needs three of them (AC12–AC14).

## Rejected and deferred, with the condition that would revive them

- **Persisting candidates into `metadata.json` / `app_config`** — D1's alternative; deferred. Revived when the picker must work without the network, or when the bulk path wants the candidate list without a second fetch.
- **A cover from a local file** — deferred; the widest gap of the three, and the honest reason is that it needs decisions this spec does not take (where the source image lives, whether it is copied into the book folder, what happens to a file the user later moves). Revived by a report of a jacket that exists nowhere online — a scanned or personal edition — which is a real case for a library this size.
- **Repairing the conflict resolver's cover candidates with the same data-URL thumbs** — deferred. It is a pre-existing defect (`ConflictResolver.tsx:23-32` against `index.html:8`), it needs a second RPC (thumbs for URLs that are already in `metadata_conflicts`), and D5 *increases* the chance of seeing it, which is the condition that revives it: the first cover conflict that appears after slice 1a lands.
- **Widening the CSP's `img-src` to `https:`** — rejected outright. It is a stated promise, not an accident, and it would put remote images in the renderer to save one RPC.
- **Cropping or rotating the stored cover** — rejected: the cover is an artifact of an edition, not a composition surface, and a crop has no source to re-derive from. A "use this image file" gesture (above) is the version of that wish that does not need a derivative.
- **A cover per *format*** (the epub's jacket and the mobi's jacket differ) — rejected this round: `metadata.json`'s `cover` is one pair of fixed filenames and every consumer assumes it. Revived only with a consumer that needs two.
- **The device-side cover work** (`tasks.md:202`, writing covers on send) — untouched; different mechanism, different storage key, no interaction.
- **Bulk "set this cover for these N books"** — deferred; the selection panel is the natural home and nothing here forecloses it.

## Risks, stated plainly

1. **The placeholder guard is a hash of somebody else's artifact.** If Google changes the tile, the md5 stops matching, the guard goes quiet, and the placeholder becomes an ordinary candidate that often wins on score. What makes this survivable is that the census (AC3) prints every winner's md5, so a hash shared by unrelated books is visible in the output instead of surfacing as a book wearing "image not available" months later. Reversal: re-measure and update the constant — the guard's provenance comment is the instruction.
2. **D5 changes what a re-fetch may rewrite, library-wide.** Nothing re-hydrates on its own, so the exposure is the paths a person invokes: import, the single re-fetch, and the bulk job. A re-fetch of an old book can now swap a jacket it previously could not — intentional, and the review band offers the choice when the two are close — but it is a behaviour change outside the reported defect, which is why it is slice 1a with the census rather than a line inside the UI slice.
3. **The write is a NAS write on a real book, and it is two writes.** `_write_cover` (`cover.py:94-115`) writes `cover_full.jpg` then `cover_thumb.jpg`; a failure between them leaves a new full and a stale thumb. Nothing breaks — the row's names are fixed, so no consumer points at a missing file — and the next write corrects it. Recorded rather than solved.
4. **The picker's certainty about "applied" is byte identity, not provenance.** `applied` compares candidate bytes to the stored file, because the cover's *source* is not recorded anywhere (`tasks.md:58`). A re-encoded or externally replaced cover reads as "no candidate applied", and the picker must therefore not phrase it as "the one you chose". This is the honest cost of D1 and is cheap to upgrade later if `tasks.md:58` lands.
5. **A gather on a 22 MB EPUB reads and decodes an image** (`extract_embedded_cover`), which is the one part of the flow that is not a network round trip. Measured on the reported book, the whole gather is seconds; the picker is a modal with a spinner and a real cancel-by-dismiss, so the exposure is latency, not a hang.
6. **Invariants held:** #1 (candidates are never written into `metadata.json`, so its authority is untouched), #8 (all logic in `services/`, handlers thin through `handle()`), #9 (the renderer still gets no `file://`; data URLs and `musaeum://` only), #12 (a failed gather is a sentence, never a throw — and a lock is not an error). **Not touched:** #2 and #6 (no file renaming), #3/#4/#5/#7 (no library SQL, sort keys or row geometry), #10 (packaging), #11 (`vendor/foliate-js` is nowhere near this).

---

## Not verified — measure first

1. **Does a same-URL cover replacement repaint at all?** The URL is constant per book and `BookCover`'s remembered failure is by value, so the answer is not obvious from the code. Instrument: the AC13 probe, and it is the **first** act of slice 2, before any component is written — because D7's mechanism depends on it and D7 is the one decision here that could otherwise ship a picker that looks broken.
2. **Is the placeholder tile stable?** Sampled once (three volumes, one hash). The census widens the sample to the real library's own ISBNs; the reversal condition in Risk 1 covers a change.
3. **Does `zoom=0` exist for every volume?** All 11 sampled volumes that advertised an image answered with one at `zoom=0`. Not a promise: `_download` returns `None` for a non-200 or a sub-1 KB body (`cover.py:34-40`), so an absence degrades to today's behaviour — the candidate is simply missing, which is invariant 12's shape and needs no code.

---

## Built — slice 1a (2026-09-21)

**AC1 and AC2 hold.** `sidecar/tests/test_google_cover.py`, 10 cases, all offline — `requests.get` is replaced and a URL nobody stubbed answers 404, so no case can quietly reach the network. What they decide: the biggest rendition is asked for first with the advertised one behind it; an advertised `smallThumbnail` is upgraded *and* kept as the fallback; a link with no `zoom` parameter is used as it is; empty `imageLinks` is no rendition; the fetch returns the big URL **with** its bytes; the tile is discarded in favour of the advertised thumbnail; a **real** image of the tile's exact dimensions is kept (the false-drop guard); a rendition that cannot be downloaded falls through; every rendition being the tile means no cover at all; and the constant still holds the md5 that was measured. Gate: `sidecar/.venv/bin/python -m pytest sidecar/tests` → **94 passed** (84 before, 10 new), `npm run typecheck` 0, `npm run lint` 0, `npm test` **1010 passed / 46 files**.

**AC3 holds, and it is the number the slice exists for: 5 of 14 winners flip from embedded to Google, and the guard is not decorative — 3 of the 14 would have been made *worse* by the unguarded rewrite.** Census over 15 randomly sampled books (ISBN-13 present, a cover on disk), one skipped for having no EPUB in its folder, run against the **shipped fetcher** with only the network shimmed so one API response per book serves both the census and the fetcher's own call:

| Book | new (`zoom=0`) | old (`zoom=1`) | embedded | winner |
| --- | --- | --- | --- | --- |
| After the Quake | 0.904 | 0.514 | 0.674 | embedded → **Google** |
| Mac & Cheese | 0.958 | 0.480 | 0.629 | embedded → **Google** |
| The Phoenix Project | 0.990 | 0.521 | 0.563 | embedded → **Google** |
| The Arabian Cookbook | 0.889 | 0.457 | 0.670 | embedded → **Google** |
| While Time Remains | 0.900 | 0.510 | 0.862 | embedded → **Google** |
| Across the River and Into the Trees | 0.945 | 0.517 | 0.469 | Google, now at full size |
| A Brief History of Time | 0.939 | 0.522 | 0.497 | Google, now at full size |

The remaining 7 are unchanged in source: six keep their embedded jacket, and one — with no embedded cover at all — keeps Google's 128 px thumbnail, because Google holds only the tile at `zoom=0`.

- `zoom=0` answered with **the tile for 5 of 14**, and unguarded **3 of those 5 would have been a regression**: *The Fatal Eggs* (embedded 0.526) and *Photoshop CS6 Unlocked* (0.704) would each have swapped a real jacket for the tile, which scores **0.782**, and *Designing Machine Learning Systems* has no embedded cover, so the tile would have become its only cover. The other two (0.864) would have kept their embedded jacket on score. *Why now* predicted this from three volumes; on a random sample it is a third of every book Google has a cover for.
- **0 hashes shared between winners** across 14 books. Without the guard five of them would have carried the same md5 — which is what AC3(c) is for.
- **0 fall-throughs for any other reason**: no first-rendition 404 or sub-1 KB body in the sample.

**Mutation campaign: 6 of 6 killed.** Every decider in the new file was mutated and every one reddened it: the upgrade to the biggest rendition removed, the placeholder guard deleted, the guard **inverted** (which must reject real covers and keep tiles), the ladder `break`ing instead of falling through a failed download, the bytes no longer travelling with the url, and the `http → https` normalisation removed. Each mutation's file was restored byte-exact from the runner's in-memory original and sha256-verified, so the campaign cannot have left the tree dirty.

**Deviations, each with its reason.**

1. **3 files, not the row's 2.** `sidecar/pipeline/hydration.py` had to change: the fetcher's bytes are handed to the scoring step as `data` so the big rendition is downloaded once instead of twice. Without it, asking for a 2164×3398 image costs two ~400 KB downloads per book — a tax of gigabytes on a 7,107-book bulk refresh, paid to save one line. Recorded as an overrun rather than absorbed: hydration is the *consumer* of a value the slice introduces, which is exactly the class a budget row built by walking names is short by.
2. **The guard lives in the fetcher, not in the scoring step** — a reading this spec left open (`_resolve_cover`, `fetchers/google_books.py:74-95`). The fetcher is the only place that knows *which* rendition it asked for, and therefore that a 575×750 answer is an answer to its own question rather than a cover; `select_cover` cannot tell the tile from a real jacket of the same size. The alternative — the guard in `cover.py` — would also have needed the fallback URL to travel through the candidate dict: two more files for a worse home.
3. **AC3's sample is 15, not the ≥25 the criterion asked for.** Google throttles a burst of ISBN lookups — the first two census attempts died on `429` inside a minute, the second after 90 s of backoff. The harness now caches one API response per book, serves the fetcher from that cache, and paces itself; 25 would still have risked a half-finished run against a live quota. The harness is re-runnable (its method is spelled out in AC3) and printed the numbers above; it sits in the session's scratch directory, which is pruned after 72 h.
4. **The first version of one case was wrong, and reddening is what proved the case real.** `test_a_small_thumbnail_is_upgraded_and_kept_as_the_fallback` asserted the fallback URL in the `http://` form the API ships, while `_cover_urls` normalises to https before deriving anything — so it failed against a correct implementation. The expectation was corrected, not the code: that normalisation is what carries the existing `http → https` behaviour into the fallback path.
