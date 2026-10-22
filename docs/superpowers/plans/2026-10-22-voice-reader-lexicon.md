# Slice 3 — the pronunciation lexicon

**Date:** 2026-10-22
**Slice:** 3 of 4 (the last unbuilt slice) — `lexicon.json`, `services/lexicon.ts`, the popover
**Annex to:** `docs/superpowers/specs/2026-10-15-voice-reader-design.md` (§ D8, AC22–AC26)
**Read first:** `docs/invariants/voice-reader.md` (the engine and the reader, as built), `docs/invariants/shelves.md` (the discipline `lexicon.json` follows in full), `sidecar/tts/lexicon.py` (the matcher and the respelling derivation, already built and tested), `electron/main/services/tts.ts:36-40` and `:93` (the one line this slice replaces).

---

## What this slice is

1. `{library root}/lexicon.json` becomes canonical for pronunciations, with `shelves.json`'s write discipline in full: atomic `.part` with a random id, never rewrite what cannot be read, carry unknown keys and unknown entry shapes, refuse every write offline.
2. `services/lexicon.ts` is its only writer and its only reader, and the entries it holds are what `services/tts.ts` sends on every `tts_synthesize` call — so a sentence is phonemized with the library's respellings, and a changed file is picked up by a running reader with no restart (AC26).
3. A **Pronounce…** button on the selection chip opens a popover: the word, a "sounds like" field, **Preview** (which speaks the respelling in the current voice, through the same derivation a save would use), **Save**, and **Delete** when the word already has an entry (AC25).
4. It changes nothing about the engine: the sidecar's `Lexicon` (whole-word, case-sensitive, possessive-aware, respelling → phonemes, stress on the capitalised part) is already built and decided by pytest (`sidecar/tests/test_tts_lexicon.py`, 18 cases), which is where AC23 and AC30 live.

**Deliberately not in this slice:** a Settings list of every pronunciation (D8's deferred item, revived by a library with more entries than anyone can remember), per-book overlays (D8's own reversal condition), and rendering a book to audio (D9, its own spec).

---

## Readings the spec left open

Each is a wiring or scope question D8 does not answer, settled here with the alternative it beat.

### R1 — The lexicon is applied in the main process, not the renderer and not the sidecar

`services/tts.ts` reads the library's entries from `services/lexicon.ts` and puts them on every `tts_synthesize` call as `[{word, sounds_like}]`. The renderer never sees the file and never sends entries.

**Beat:** the renderer reading the lexicon and sending the entries with each sentence (`synthesize` already accepts a `lexicon` argument) — rejected because it would put a share read in the renderer behind a per-sentence IPC round trip, and because the sidecar's own contract says it reads no library file (D3: "the sidecar reads no library file, so the method stays pure"). **Reversal:** D8's per-book overlay, when it arrives, makes the entries book-scoped — the resolution stays in main and gains one argument.

### R2 — A stat-keyed cache, and a failed read serves the last good copy

`services/lexicon.ts` keeps `{root, mtimeMs, size, file}` and stats `lexicon.json` before each use; a matching stat answers from the cache, a changed one re-reads. A stat or read failure answers the cached copy (D8: "Speech keeps using the last copy it read when the share drops"), and a file that exists but cannot be parsed leaves the cache alone rather than emptying it.

**Beat:** no cache, a read per sentence — a share read per spoken sentence is two extra round trips per prefetched sentence, and the spec already names the drop case. **Beat:** an interval (a five-second refresh) — nothing measures it, and a timer is a thing to keep alive. **Reversal:** if the per-sentence stat is measured stalling a page turn on the real share, the refresh becomes an interval and the number says how long.

### R3 — Preview is the saved path, on the word

`tts.preview({ word, soundsLike, voice, speed })` synthesizes **the word** with a one-entry lexicon, i.e. exactly what saving and then reading the word aloud would do. It writes nothing.

**Beat:** speaking the respelling alone as text — espeak would read `HAY-gul` as the letters and syllables of a nonsense word, not as the phonemes the splice produces, so the preview would pass and the reading would fail. **Beat:** previewing by writing the entry first and then undoing it — a preview that writes is not a preview. **Reversal:** none foreseen; this is AC24's instrument.

### R4 — One verb for add and edit

`save({ word, soundsLike })` adds or replaces by exact word (case-sensitive), stamping `addedAt` on add and keeping the original on edit; `remove(word)`; `list()`. Each mutation answers with the file's **whole** entry list, as the file now holds it (the annotations-file rule, annex R1).

**Beat:** separate `add`/`update` channels — the popover knows which state it opened in, but the intent is one, and the file's own discipline is "apply the change to what was read". **Reversal:** a lexicon big enough that two entries for one spelling are wanted (then entries need ids).

### R5 — The chip's word is the selection, trimmed, on one line and at most 80 characters

The sidecar's matcher is `(?<!\w)(alternatives)(?!\w)` over escaped literals, so a multi-word entry (`Van Gogh`, `Hegel Kant`) already works and is already tested (`test_the_longer_entry_wins_over_its_prefix`). D8's "whole words" is a rule about _matching_, not a refusal of a name with a space in it.

**Beat:** offering Pronounce… only for a selection with no whitespace — it loses every compound surname, which is most of the names a person would want to fix. **Reversal:** a measured case where a phrase entry fires where it should not.

### R6 — A respelling is letters, spaces, hyphens and apostrophes

Digits and other punctuation have no phonemes (`_parts` splits on `[-\s]+` and each part goes to espeak), so anything else is refused with one sentence rather than improvised into a wrong-but-silent pronunciation — the failure this feature exists to remove.

**Beat:** accepting anything the phonemizer does not throw on — that is precisely the silent case. **Reversal:** a respelling someone needs that the rule cannot express (a syllable the rule cannot spell), which would arrive as a new allowed character with a case.

### R7 — Unknown entry shapes are carried, never applied

A parsed entry is a record with a non-empty string `word` and a non-empty string `soundsLike` (an absent `addedAt` reads as `''` — a hand-written entry, and it is stamped on the next save). Any other array member is kept **verbatim** and never spoken. The whole file is refused (never rewritten) only when it does not parse or its `version` is not 1.

**Beat:** refusing the file for one unreadable entry — D8 says unknown shapes are carried through, and refusing the whole file would take every good entry with it. **Reversal:** none.

### R8 — The popover lives in `ReaderEngine`, beside the chip that opens it

The chip is that component's own control (`SelectionChip.tsx`, rendered at `ReaderEngine.tsx:578`), and it is the only place the selection's text and rect exist together. `PronouncePopover` is rendered there, reads the voice and speed from the reader store itself, and calls the bridge itself. **`ReaderView.tsx` does not change in this slice.**

**Beat:** mounting it beside `ReaderPrefsPopover` in `ReaderView` — that threads the chip's word and rect up through a component that does not hold them. **Reversal:** a second opener (a Settings list) that shares the popover.

### R9 — A mutation refreshes the cache from what it wrote, and nothing broadcasts

The write path updates the cache with the file it just wrote, so the next sentence speaks the new entry; no `libraryChanged`. The reader is the only consumer, and a library-wide reload to redraw a two-field popover is the cost `annotations.ts` names for the same decision.

**Beat:** a `libraryChanged` broadcast — 7,000 rows reloaded to redraw nothing. **Reversal:** a Settings list of every entry (D8's deferred item) becomes a second consumer.

---

## File table

| File                                         | Change                                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/lexicon.types.ts`                 | **new** — the stored file's shape, the bridge shapes, and the two validators (`isValidWord`, `isValidRespelling`, `toLexiconEntry`) both sides share |
| `electron/main/services/lexicon-file.ts`     | **new** — `lexicon.json`: parse, read (missing vs unreadable), atomic write. `shelves-file.ts`'s discipline, its own file                            |
| `electron/main/services/lexicon.ts`          | **new** — the stat-keyed cache, the mutation queue, `list` / `save` / `remove` / `spokenEntries`                                                     |
| `electron/main/ipc/lexicon.ts`               | **new** — three thin channels                                                                                                                        |
| `electron/main/services/tts.ts`              | **edit** — `synthesize` sends the library's entries (replacing `NO_LEXICON`); `preview` added                                                        |
| `electron/main/index.ts`                     | **edit** — one registration line                                                                                                                     |
| `electron/preload/index.ts`                  | **edit** — `lexicon` namespace, `tts.preview`                                                                                                        |
| `src/types/api.types.ts`                     | **edit** — the bridge's typing for both                                                                                                              |
| `src/components/reader/PronouncePopover.tsx` | **new** — the popover: word, sounds-like field, Preview, Save, Delete                                                                                |
| `src/components/reader/SelectionChip.tsx`    | **edit** — the third button, `onPronounce?`                                                                                                          |
| `src/components/reader/ReaderEngine.tsx`     | **edit** — the popover's state and mount                                                                                                             |

**Tests:** `src/types/lexicon.types.test.ts`, `electron/main/services/lexicon-file.test.ts`, `electron/main/services/lexicon.test.ts`, `electron/main/services/tts.test.ts` (**new file** — `services/tts.ts` has had no suite), `src/components/reader/pronounce-surface.test.ts`.

**Count, honestly: 11 source files (8 with logic, 3 one-line appliers) + 5 test files = 16.** The spec's slice table says "inside the ~10-file bound", and it is inside it only by the logic count; the three appliers are the ones a file-budget row never lists, which is the shortfall that rule exists to name.

**What must not move:** `sidecar/` (the matcher and the derivation are built and decided), `docs/rest-api.md` and the REST surface (`lexicon.json` is a library file, not a wire addition), `metadata.json` and the SQLite schema (no column, no migration — D8's "no adoption path and no SQLite cache"), `ReaderView.tsx`, and the speech player.

---

## Acceptance criteria, and the decider for each

| AC  | Claim                                                                                                                                                                                         | Decider                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22  | `.part` with a random id; an unparseable file or an unknown `version` is not rewritten and refuses with one sentence; unknown keys and entry shapes survive a write; an offline write refuses | `lexicon-file.test.ts` (parse/refuse/atomic/scratch-name/rename-failure) + `lexicon.test.ts` (the offline mutation, file byte-identical)                                                                                                |
| 23  | Matching is whole-word and case-sensitive; `Okafor's` and `Okafor’s` use `Okafor`; `Hegelian` is not `Hegel`                                                                                  | **already decided** — `sidecar/tests/test_tts_lexicon.py` (`test_matching_is_whole_word_and_case_sensitive`, both possessive parametrisations, `test_hostile_and_sloppy_entries_never_raise`). This slice adds no matcher               |
| 24  | The respelling-derived phonemes for `Hegel` and `Kojève` are **listened to and judged correct**                                                                                               | **met 2026-10-22** — five clips rendered through `tts.synthesize`'s own body with a one-entry lexicon (the path Preview uses): `Hegel` and `Kojève` plain against respelled, plus one sentence; listened to by Jason and judged correct |
| 25  | The popover adds, previews, edits and deletes; Preview speaks the respelling in the current voice before saving                                                                               | `pronounce-surface.test.ts` (the button, the fields, the call order, Delete only when an entry exists, `app-no-drag` on the floating surface) + the manual pass in the running app                                                      |
| 26  | A changed `lexicon.json` is picked up by a running session without a restart                                                                                                                  | `lexicon.test.ts` — a save's own entry is spoken by the next `spokenEntries()` with no restart; and a file written **out of band** (mtime moved) is re-read, while an unreadable one serves the last good copy                          |

---

## Verification plan

1. `npm run typecheck` and `npm run lint` — both clean at `b961594` before the first edit.
2. `npm test` (main-process suite) and `pytest sidecar/tests` — the sidecar must be **unchanged** (563 passed with the real models, 539 + 24 skipped without, per `tasks.md:158`); any move there is a finding, not a pass.
3. A mutation campaign over the new deciders (`scripts/mutation-campaign.py`): the cache's stat comparison, the invalid-file rule, the offline refusal, the entry mapping to the wire, the preview's single entry, and the ordering the chip's third button depends on. Every row quoted killed/survived.
4. `npx prettier --check` over every touched file with a parser, documents included, with the drift measured against `HEAD` before any formatting.
5. The manual pass in the running app: select `Hegel`, Pronounce…, Preview, Save, then listen to a sentence containing it; then edit and delete, and confirm the speech follows each change without reopening the book (AC25, AC26's live half).

---

## Start here

```
git log --oneline -3
npm run typecheck && npm run lint && npm test
pytest sidecar/tests -q
```

The three files worth reading before anything else, in order: `sidecar/tts/lexicon.py` (what the entries become — whole-word matching, possessives, and `respelling_to_phonemes`, all already decided), `electron/main/services/annotations.ts` (the queue + read-state + refusal posture this slice copies at library scope), and `electron/main/services/shelves-file.ts` (the file discipline, verbatim).

---

## Built — slice 3 (2026-10-22)

One working tree, not committed at the time of writing. At the finish line: **25 paths** — 12 source files (9 with logic, 3 one-line appliers), 7 test files (4 new; 3 modified), and 6 documents (this annex new, `docs/invariants/voice-reader.md`, `docs/data-contracts.md`, the specification's header, `tasks.md`, `CHANGELOG.md`).

Two existing suites needed an assertion **inverted** rather than added, and both are the class this project watches for. `tts.test.ts` pinned `lexicon: []` on every `tts_synthesize` call — exactly what this slice replaces. `listen-surface.test.ts` pinned the selection chip at exactly two buttons; the count is now three, and stays exact because a walk that found one button would pass with the others unmarked. `test/invariants.test.ts` gained the file's one-reader walk (below).

### Gates

| Gate                   | Result                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | clean (0 errors, both projects)                                                                                                                                                                                                                                                                                                                                                             |
| `npm run lint`         | clean (`eslint . --max-warnings=0`)                                                                                                                                                                                                                                                                                                                                                         |
| `npm test`             | **2535 passed in 113 files** (baseline `b961594`: 2445 in 109 — **+90 cases, +4 files**)                                                                                                                                                                                                                                                                                                    |
| `pytest sidecar/tests` | **543 passed, 24 skipped** — and `git status sidecar/` is empty: the sidecar was not touched, so any movement there would have been a finding                                                                                                                                                                                                                                               |
| Mutation campaign      | **17/17 killed**, every row `restored=True`, the last run taken after the final change to any case                                                                                                                                                                                                                                                                                          |
| `prettier --check`     | every touched code file clean. The documents already dirty at `HEAD` were **not** reformatted, and the two counts prove this slice added no drift to them: `tasks.md` 16 differing lines at `HEAD` and 16 in the working copy, `CHANGELOG.md` 167 and 167, the spec header 92 and 92. This annex is 0 on both (`prettier --write` run once, on its own emphasis markers and table padding). |

### The campaign, and the one row that survived first

17 rows over the new deciders — the cache's stat comparison, the offline fallback, `invalid` versus `missing`, the `changed: false` guard, `assertOnline`, the gone-entry refusal, the entries reaching every sentence, Preview's one-entry lexicon, the respelling validator, the word cap, the `addedAt` tolerance, the scratch file's random id, the chip's word gate, the chip's third button, Preview's call, Delete's gating, and the file's one naming module.

**The first run was 15/16** (the list was 16 rows then): _"the chip offers Pronounce… for a selection that is not a word"_ survived. The case asserted only the left half of the conditional (`onPronounce={cleanWord(…) ?`), so a mutation that offered the button unconditionally (`: onChipPronounce`) still matched it — the case asserted the rule but not the distinction. Repaired by pinning the whole expression and asserting the absence of an unconditional offer, then the **whole JSON re-run**: 16/16 — and 17/17 once the one-reader walk was added and the whole list re-run again. That is reason 5 of the triage list, and the repair is in the case, not the code.

Collateral worth naming, since three rows reddened more than their own case and all three are one claim seen twice: _the cache stops re-reading_ took 2 cases (the re-read case and the "unreadable file does not empty speech" case, which is the same cache decision), _synthesize speaks with no pronunciations_ took 2 (the entries case and the "read once per sentence" case), and _a respelling may contain digits_ took 5 of the validator's refusal rows (collapsing the regex admits empty, whitespace and punctuation too) — breadth that is the point, not a defect.

**What the campaign cannot see.** The one-reader walk's _import_ half has no expressible single-anchor mutant: making a second module import `lexicon-file` reddens that module's typecheck before any case can run, so the mutant would be killed by the compiler rather than by the walk. Its _naming_ half is decided (respelling the constant reddens it, measured), and the import half rests on the `expect(importing).toContain(service)` non-vacuity clause. Recorded rather than papered over.

### Deviations from what this annex wrote

- **R4 gained a `changed: false` guard.** A save that saves the value already there writes nothing. The reason arrived with R2: the cache keys on the file's mtime, so a redundant write would make the next sentence re-read the whole list for no change. `save` now answers the list unchanged and the file's bytes and mtime are untouched (a case pins both).
- **Preview is on the `tts` namespace** (`tts:preview`), not the lexicon's. It is a synthesis — the word spoken with a one-entry lexicon, writing nothing — and the engine's door already exists there; the lexicon namespace carries only the file's three operations.
- **`cleanWord` allows a compound name**, per R5 (`Van Gogh`, `Hegel Kant`), because the sidecar's matcher already handles a multi-word literal and `test_the_longer_entry_wins_over_its_prefix` pins it. The chip therefore offers Pronounce… for any single-line selection of at most 80 characters.
- **`LexiconEntry.addedAt` may be `''`** — a hand-written entry. The build settled the question the annex only implied: an absent `addedAt` reads as `''` rather than refusing the entry or inventing a timestamp, and the first real edit stamps it (R7).
- **`services/tts.ts`'s private `text()` helper became `asText()`** because `speak()`'s own `text` parameter shadowed it. Mechanical; named so the next reader of the diff does not go looking for a rename that changed behaviour.
- **File count: 12 source + 7 test + 6 documents = 25 paths**, against the spec's "inside the ~10-file bound" and this annex's own honest count of 16. The three one-line appliers (`index.ts`, the preload, `api.types.ts`), the one-reader invariant walk, and the two invariant/data-contract documents are the files a budget row never imagines — which is the shortfall that rule exists to name.
- **`docs/invariants/voice-reader.md` gained four lexicon rules and `docs/data-contracts.md` a `lexicon.json` section and the two namespaces.** The routing table in `CLAUDE.md` says those two documents are what the next session reads before touching this surface, so a slice that left them silent would have shipped a rule nothing states.

### AC24 — the ear check, answered 2026-10-22

**AC24 is met: Jason listened to all five clips on 2026-10-22 and judged the respelled pronunciations correct.** The criterion was the owner's ear, not the machine's; the build's job was to hand it a faithful artifact, and the artifact is the five WAVs below. The build produced the artifact it needs: five WAVs rendered through `tts.synthesize`'s own body (`Engine.synthesize` with the one-entry lexicon, the path Preview uses), `af_heart`, speed 1.0 — `Hegel` plain and respelled (`HAY-gul`), `Kojève` plain and respelled (`ko-ZHEV`), and one full sentence with `Hegel` respelled in it. Their `lexicon_version` values differ between the plain and respelled takes (`4f53cda18c2baa0c` for no entry against `e2cce5cb0bf22c58` and `6c9674b9ce860680`), which is the machine-side proof the derivation was applied; whether it _sounds_ right is the part only a person can say. The verdict is recorded here and in the specification's own _Outcomes, slice 3_ table, in `tasks.md` and in `CHANGELOG.md`, so no later session re-runs a check that is already answered. **What the verdict settles:** the substitution D8 named as unverified — a respelling a person types rather than hand-written IPA — yields a pronunciation good enough to ship. **What it does not settle:** how a respelling nobody has heard yet will come out, which is what Preview exists for.

### Not verified

- **AC25's live half.** The popover's wiring is decided by the source walk and the surface's shape by the markup, but nothing in the suite renders it (`environment: 'node'`): the manual pass — select `Hegel`, Pronounce…, Preview, Save, then listen to a sentence containing it, then edit and delete — has not been run in the app. It is the same standing gap the annotations and theming slices carry.
- **The per-sentence `stat` over a real SMB share.** R2's cost claim (one `stat` per sentence, not a read) is measured on a local temp root only. If it stalls a page turn on the NAS, R2's reversal condition fires: an interval replaces the per-call stat.
