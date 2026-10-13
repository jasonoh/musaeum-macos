# PDF reflow slice 6 — the content rules (annex)

**Date:** 2026-10-11
**Slice:** 6 of `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` (follows slice 1R's review; the spec's own table stops at 5, which is the docs-only _record_ and is written)
**Status:** **Landed 2026-10-12 as `2c213fd` ("pdf cleanup") — one commit carrying all ten source files below, this annex, the parent spec's _Status_ paragraph and `tasks.md`'s record (13 files, +461 / −38).** The rules and their deciders are green (`pytest sidecar/tests` **408 passed**, `-k reflow` **137**; mutation campaign **8/8 killed**, every row restored), the corpus re-run is the parent spec's Annex C.7 run 3, and the doc half — the spec's Annex C.4/C.5 amendments, `tasks.md` and `CHANGELOG.md` — is this session's follow-up commit. **One rule was handed on rather than delivered** — the furniture tier, which the corpus run measured as neither removing the footer it was written for nor holding the pass's reproducibility — and the owner's decision, taken 2026-10-12, is **to replace it rather than keep or withdraw it: band furniture goes, page numbers included**. _The decision_ below carries the choice, the census it is scoped against, and the decider it needed. **The replacement landed 2026-10-13**, and its own record is `The replacement, landed 2026-10-13` below: the rule is `sidecar/reflow/furniture.py` — read from both sides of the pass, one page at a time, with no count anywhere — the census is `gate.furniture_census`, and both bars are met (see that section for the numbers).
**Annex to:** `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` — the readings here settle four items `tasks.md`'s C2 entry lists as open, and they amend **Annex C.5 items 5, 6 and 9** and **C.4 G2 and G5**. The parent spec is the authority for every product decision; this document settles _rules_ inside them.
**Read first:** `tasks.md` → C2; the spec's **Annex C** in full (C.4's gate table, C.5's numbered rules, C.7's two runs); `docs/invariants/reader.md` (_Reading in the app_); `docs/invariants/files-and-deletion.md` (_The `derived/` folder_).

---

## What this slice is

The tail `tasks.md`'s C2 entry lists under _(2)_, minus the one item it does not fix. C2's own words name four defects and one gate gap; four of the five are repaired here.

1. **`outline.is_junk`'s Roman-folio over-reach.** _Civil_, _Mild_, _DIM_, _Lid_, _Mix_, _Div_ and _dim_ were dropped from a book's table of contents as page labels.
2. **The 80-character furniture cap.** _Universe_'s 276–460-character Cengage footer printed inside the flowing text on **323 of its 530 text pages**.
3. **_Universe_'s truncated chapter titles.** `A User's` / `Guide to the Sky` was cut to `A User's` because the wrapped title's second line fell inside a figure's box.
4. **G5 could not fail a book whose usable outline is empty.** _Modernist Cuisine_ — 355 pages — passed with a two-entry TOC.
5. **Not fixed, deliberately:** _Universe_'s junk `h3`s (1,421 of them, `APRIL`, `Sa` among their sample). Heading _levels_ on a designed page are the same open problem Annex B.3 item 4 named; a rule for it needs corpus iteration and this slice's four items did not. Named here so it is not read as closed.

---

## Readings this slice settled

Numbered `R` because the parent spec's decisions are `D1`–`D10` and its review annex is `C.1`–`C.7`; the roadmap and every child brief quote criteria by number, so a new series cannot reuse either.

**R1 — A Roman folio is a _well-formed_ numeral written in one case; the test is both halves, not either.** Alternatives rejected: the loose `^[ivxlcdm]+$` (matches every letter of `Civil`, `Mild`, `DIM`, `Lid`, `Mix`, `Div`, `dim` — measured, all seven dropped); well-formedness alone (`Dim`, `Div`, `Mix`, `Civ`, `Liv` are all _valid_ numerals — 500+4, 1000+9, 100+4, 50+4 — and still swallowed, while `DIM` is not one, so the two tests are genuinely independent); case-uniformity alone (`DIM` is all-caps and would survive). **Residue, named rather than hidden:** a one-case label that is both a real word and a well-formed numeral — lower-case `mix`, upper-case `DIV` — is still dropped. Strictly smaller than the set the loose form dropped. **Reversal condition:** an outline in the wild whose entry is one of those two.

**R2 — The furniture length cap is a _tier_, not a wall.** A block in the page's top or bottom 8% is furniture when it repeats on a quarter of the text pages up to 80 characters, and on **half** of them between 80 and 600; past 600 it is content however often it repeats. Alternatives rejected: keeping the flat 80-character cap (the measured defect above); removing the cap (a long repeated block is only furniture _because_ it repeats, so a single occurrence must stay in the flow); one share for all lengths (a three-word running head and a 238-character legal footer are not the same evidence). **Reversal condition:** a book whose prose legitimately repeats a >80-character block in the band on half its pages.

**R3 — A Vision region the crop only _overlaps_ keeps its characters.** A character inside a written figure box is the figure's only when no surviving region owns it; a region lying _mostly_ inside the box is still a label and still goes. Alternatives rejected: the old rule — any character inside a crop belongs to the figure (truncates a wrapped heading, measured); letting regions always win (that is the rule Annex B.2 records _from the other side_: a chart's axis labels stayed in the prose as 21,472 single-letter tokens). **Reversal condition:** a figure whose own interior text Vision boxes as one large region spanning the figure's edge, which would then read back into the flow as duplicated words.

**R4 — G5 gains a floor it can fail on: at least one nav entry per 50 source pages.** It applies whether or not the source's outline had usable entries, so the criterion no longer depends on the pipeline's own bookkeeping to be able to fail. Alternative rejected: comparing the nav against the heading pass's own count, which needs a second heading detector inside the gate and grades the gate against the thing it is meant to check. **Reversal condition:** the first real book whose only defect is that it has no chapters — it reflows as one section and now fails G5, which is the honest reading of "you cannot navigate this book" but is a false positive for such a book.

**R5 — The content rules move the converter version to 3.** `produce.CONVERTER_VERSION` is what `reflow.json`'s stamp re-checks (D9), so without the bump every artifact already cached on the share holds the old rendering and the three rules above are **inert on exactly the books that have been read**. Alternative rejected: leaving it, on the grounds that the rules are "minor" — the footer defect is 60% of a book's pages. **Consequence, stated:** every already-reflowed book re-runs its pass once, on its next open, which is the designed behaviour and not a bug.

---

## File table

Branched from `main` at `5a68e81`; landed there as **`2c213fd`** ("pdf cleanup", 2026-10-12). The ten files below are the whole of the code change, plus this annex, the parent spec's _Status_ paragraph and `tasks.md` — `git show --stat 2c213fd` is the record.

| File                                    | What changed                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar/reflow/outline.py`             | `_ROMAN` becomes the well-formed pattern; `_roman_folio` adds the single-case test; `is_junk` calls it                                                                                                                                                                                                                |
| `sidecar/reflow/layout.py`              | `RUNNING_HEAD_LONG_PAGES` (0.5) and `RUNNING_HEAD_LONG_MAX_CHARS` (600); `_is_furniture` becomes a _candidate_ predicate (position, kind, digits — no length); `mark_running_heads` applies the two tiers, since repetition is a question about the book                                                              |
| `sidecar/reflow/gate.py`                | `FURNITURE_LONG_MAX_CHARS` / `FURNITURE_LONG_PAGES` / `TOC_MAX_PAGES_PER_ENTRY`; `_in_band`, `_normalize`, `furniture_keys`; `PageEvidence.long_band` holds long band blocks out for the book to decide; `_emit` counts a block past the ceiling rather than excusing it; `check_toc(..., pages=)` gains the R4 floor |
| `sidecar/reflow/regions.py`             | `_units` returns the figure-label boxes beside its units; `build_page_text` drops a character only when no surviving region owns it (R3)                                                                                                                                                                              |
| `sidecar/reflow/produce.py`             | `CONVERTER_VERSION = 3` (R5)                                                                                                                                                                                                                                                                                          |
| `scripts/pdf-reflow-probe.py`           | collects each page's `long_band`, resolves it through `gate.furniture_keys`, and passes `pages=` to `check_toc`                                                                                                                                                                                                       |
| `sidecar/tests/test_reflow_toc.py`      | +1 — the folio/title pair (R1)                                                                                                                                                                                                                                                                                        |
| `sidecar/tests/test_reflow_pipeline.py` | +3 — long repeated footer dropped (R2), the two tiers side by side (R2), past the ceiling kept (R2)                                                                                                                                                                                                                   |
| `sidecar/tests/test_reflow_regions.py`  | +1 — the straddling crop (R3)                                                                                                                                                                                                                                                                                         |
| `sidecar/tests/test_reflow_gate.py`     | +3 — `long_band` + `furniture_keys`, the ceiling, the G5 floor (R2, R4)                                                                                                                                                                                                                                               |

`git diff --stat` at review time: **10 files, +323 / −35** — the landed commit `2c213fd` carries **13 files, +461 / −38**, which is those ten plus this annex, the parent spec's _Status_ paragraph and `tasks.md`.

---

## Acceptance criteria and their deciders

| #   | Claim                                                                                                             | Decider                                                                                                                                                           | Result                          |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| AC1 | A chapter named _Civil_/_Mild_ survives the outline filter; `viii`, `xii`, `ix`, `XIV` do not                     | `test_reflow_toc.py::test_a_folio_is_junk_and_a_title_that_spells_one_is_not`                                                                                     | green                           |
| AC2 | A long band block repeating on half the pages is dropped; on a quarter it is kept; past 600 characters it is kept | three cases in `test_reflow_pipeline.py`                                                                                                                          | green                           |
| AC3 | The gate excuses exactly the long band blocks the _book_ repeats, and never one past the ceiling                  | two cases in `test_reflow_gate.py`                                                                                                                                | green                           |
| AC4 | A crop overlapping a heading does not truncate it; a crop's own label still goes                                  | `test_reflow_regions.py::test_an_oversized_crop_does_not_truncate_a_heading_that_straddles_it` + the pre-existing label case                                      | green                           |
| AC5 | G5 fails a two-entry nav for a 355-page book, and passes it with no page count (the old behaviour)                | `test_reflow_gate.py::test_check_toc_fails_a_nav_too_thin_for_the_book`                                                                                           | green                           |
| AC6 | A stamp written by converter 2 no longer matches, so a cached artifact re-runs (R5)                               | the pre-existing `test_reflow_produce.py::test_a_new_converter_version_re_runs_the_pass` pins the _mechanism_; the value change is proved by the corpus run below | mechanism green, value unproved |
| AC7 | The sidecar's stderr stays clean on the corpus (AC10 of the parent spec)                                          | the corpus run's own output                                                                                                                                       | not run                         |

**Mutation campaign:** `8/8 killed`, every row `restored=True`, tree checked clean afterwards. Attribution read from the raw log (the runner's parser is vitest-shaped and reports `attributed 0/8` on pytest, which is the parser missing, not a verdict): each row reddened **exactly its named case** and nothing else — `1 failed, 17–18 passed` per row. JSON is at the session's scratch path; re-derive with the skill's `scripts/mutation-campaign.py` and `--runner "sidecar/.venv/bin/python -m pytest -q -p no:cacheprovider"`.

---

## What must not move

- **`README`-level behaviour of the reader.** Nothing here touches `ReaderEngine`, the `musaeum://` route, `reading_state` or the wire. The artifact is still an EPUB and D10 still holds.
- **The pipeline's three existing tunables.** `RUNNING_HEAD_PAGES` (0.25), `RUNNING_HEAD_MAX_CHARS` (80) and the whole figure/plate block are unchanged; the tier _adds_ two constants rather than re-scaling the old ones, so a book with no long furniture behaves exactly as before. *(**Amended 2026-10-13:** the two tier constants are gone with the tier — the replacement adds three of its own, `FURNITURE_MARGIN` and the letter-spacing floor — and the three above are still the values they were, with `RUNNING_HEAD_BAND`/`RUNNING_HEAD_MAX_CHARS` now aliases of `reflow.furniture`'s so the two sides cannot drift. See *The replacement, landed 2026-10-13*.)*
- **The gate's short band rule.** A band line ≤80 characters is still excused outright, which is the rule the gate has always had; only the long case is new. Tightening it is a separate change with its own measurement. *(**Amended 2026-10-13:** it is still excused outright under the replacement — the gate's route is now a superset of the pipeline's, deliberately, so G2 can never demand a word the pipeline dropped.)*
- **`metadata.json`, `formats`, `file_size_bytes`, the SQLite schema.** Untouched (parent spec AC2).

---

## Verification plan

```bash
# 1. the suite the deciders live in
sidecar/.venv/bin/python -m pytest sidecar/tests -q          # 408 passed (was 400); -k reflow is 137

# 2. the JS gates, since a slice is not "done" on one runner
npm run typecheck && npm run lint && npm test

# 3. the corpus, which is what proves AC6's value change and re-takes C.7 run 2's numbers
sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --production      # ~30 min, exit 0 expected
```

`--production` copies each corpus book into `dist/books/<slug>/` and works there, so **the library at `/Volumes/books/musaeum` is not written** (the probe's own docstring: "the library stays untouched"). It deletes `derived/` per book first, so every number is the run's own.

**Read the run against Annex C.7 run 2, and expect the gate score to _fall_.** _Modernist Cuisine_ passed that run only because G5's expectation was `None`; R4 makes it fail, so the score moves **4/6 → 3/6** with a newly _visible_ failure (2 entries for 355 pages) rather than a new defect. That is the honest outcome of a decider that could not fail, and it belongs in the record next to the two failures Annex C.7 already carries. Any _regression_ on a book that passed run 2 — a check moving from pass to fail for a reason other than the G5 floor — is the signal to stop.

---

## What landed, in the annex's own order

1. **The corpus re-run — done 2026-10-12** (`--production`, ~12 min on this machine, exit 1), and it is the parent spec's **Annex C.7 run 3**. It is the **first *production* run** of the corpus — the mode that re-lays the source for the gate's exclusions and checks byte stability, the cache, a moved source and folder hygiene — so its numbers are a new baseline, not a fall from run 2's. **The score is `1/6`, not the `3/6` this annex predicted, and the prediction is half right.** *Modernist Cuisine*'s G5 is the one failure this slice owns — 2 entries for 355 pages against R4's floor of 8, exactly the move predicted. *Universe*'s G3 and G5 (87%) and *Politics*' G5 (68%) are run 2's numbers unchanged. *Attention*'s G2/G6 and *Sequence to Sequence*'s G1/G2/G6 were measured against the previous commit before being blamed on this slice: `layout.py`, `outline.py` and `regions.py` at `5a68e81`, run in the same spike mode, fail identically (G2 88.4% of 3,800 and G6 5.5% for *Attention*; G2 92.3% and G6 3.9% for *Sequence to Sequence*), so the difference is the helper's own reading of those pages on a later macOS than run 2 recorded, not the rules. Slice 2's bar fails in exactly one place: **Universe is not byte-stable** — the same source, laid out twice by the same code, produced different content, and this is the first run that checks that bar. **And that failure is this slice's:** the same production check with `layout.py`, `outline.py` and `regions.py` at `5a68e81` is byte-stable (content digest `ef9c4ab505e804ef` twice, same stamp, G5 221 of 255). **Pinned to the tier, module by module:** with only `layout.py` at `5a68e81` — R1, R3, R4 and R5 all still in — the same `--production` check is byte-stable (identical content digests, first pass 89.1 s, G5 223 of 255, G3's witness `alabama, pane, researchers`, unchanged from the new code's run). Combined with the rule-level measurement below, the tier both fails to remove the footer and destabilises the pass for the book it was written for.
2. **Two of the four rules did not do their job, measured against the artifacts rather than against a synthetic case.** The furniture **tier does not remove *Universe*'s Cengage footer**: the footer repeats identically on every page of the source's text layer, while the block the pass builds for it varies page to page (welded to each page's figure credit, its two lines zipped in a varying order), so the artifact carries **244** footer paragraphs normalizing to **77** variants, the commonest on 38 of 534 text pages against the 267 the tier needs. The **folio repair decides differently for 0 of the corpus's 308 usable outline entries** — a live defect in the rule, not one any book in this set hit. R3 is the one with a visible effect: *Universe*'s wrapped heading `A User's Guide to the Sky` survives whole as an `h3`, where run 2 recorded it cut to `A User's`. Both negatives are in the parent spec (C.5 item 5, C.7 run 3) and in `tasks.md` → C2, as measured negatives rather than closed fixes.
3. **The JS gates — done 2026-10-12:** `npm run typecheck` 0, `npm run lint` 0, `npm test` **2008 passed | 4 skipped** (94 files), `pytest sidecar/tests` **408 passed**, `-k reflow` **137**. The lint workaround this item used to name was **not needed**: `--ignore-pattern '.delta'` was there for another session's in-flight worktrees, which `eslint.config.mjs:14` did not ignore (6475 errors, all `No tsconfigRootDir was set`), and `.delta/worktrees/` is empty now — `eslint .` runs clean as it stands.
4. **The parent spec's amendments — done 2026-10-12:** Annex C.5 item 5 carries R2's tiers, **item 6 carries R3** (this annex's own summary named items 5 and 9 — R3 is the crop's side of which characters a written figure owns, and item 6 is where that rule lives), item 9 carries R1, C.4's G2 and G5 carry R2's and R4's, C.7 gains run 3, and the header's _Status_ is rewritten. The spec is the authority for the rules; this annex only settled them.
5. **The `tasks.md` record — done:** the C2 entry's _(2)_ clause closes, the bullet carries this annex's path and the run's numbers, and the `[~]` marker becomes `[x]`.
6. **`CHANGELOG.md` — done:** the 2026-10-09 _Unreleased_ block gains three bullets under _Fixed_ — a book's real chapter names, the wrapped chapter title, and the one-off re-prepare the converter-version bump causes — and, under _Notes_, the Cengage footer as a **measured negative** rather than a fix: the rule was written for it and the corpus run shows it still there. Written on landing, which was `2c213fd`.
7. **Then the minors C2's _(5)_ still lists**, none of them touched here: the smoke poll does not cap `Retry-After` and treats a 503 busy as a FAIL; `GET …?format=reflow` calls the sidecar even for a cached artifact (`resolveReflowFile` without `ensure` is the option); the 422 branch has never been exercised live; and nothing caps passes across books against the four sidecar threads hydration and Kindle conversion share.

## The decision — **taken 2026-10-12: B, and the page numbers come with it**

The owner read the two options below and chose **B**: a reflowed book is meant to read like an EPUB, and its chapter title is *already* an `<h3>` (`Chapter 2 | A User's Guide to the Sky`), so the PDF's own printed furniture — the letter-spaced running head with the page number inside it, the legal footer — is not fidelity worth keeping. **A** is kept below as the withdrawn alternative, with its reasoning, so it is not re-proposed by accident. One rule of this slice was **not delivered**, and the two facts that say so are measurements rather than readings: `layout.py`'s furniture tier changes nothing about the block it was written to remove (*Universe*'s Cengage footer — **244** paragraphs in every artifact, with the tier in and with it out, 77 variants, commonest 38, against the 267 the tier needs), and it costs the pass its reproducibility on that same book (byte-stable with `layout.py` at `5a68e81`, unstable with the tier in — two passes over the unchanged source differ in **2 of 39** spine documents). Both are in the parent spec's C.5 item 5 and C.7 run 3, and the artifacts they were read from are kept under `dist/` — `reflow-production-old/` (all three modules at `5a68e81`), `reflow-production-noR2/` (`layout.py` alone reverted), and `_run3/` **and** `reflow-production-run3/` (two copies of run 3, whose `report.json` and `measured/` are the *before* column of *The replacement, landed 2026-10-13* below) — untracked, so name them in whatever replaces them. **`reflow-production/` now holds run 4** — the replacement's own artifacts and report, run 3 having been copied aside first — where *Universe*'s content digest is `2d414b83d18473fb` twice instead of run 3's `6a302e70b787ee60` then `7b60c773bf8f97d1`. The slice's other three rules stand: R1 is a live rule defect closed (0 of the corpus's 308 usable outline entries affected), R3 is visible in the artifact, R4 is the one move the run predicted.

**A — pull the tier (withdrawn 2026-10-12; recorded as the fallback).** Revert `layout.py`'s two tiers and the `RUNNING_HEAD_LONG_*` constants, and drop the gate's counterpart with them (`PageEvidence.long_band`, `furniture_keys`, the `_emit` split and `FURNITURE_LONG_*`), because that path exists only to mirror the pipeline's rule, and the two have to agree for G2's recall to mean anything. The cases this slice added for it go too — `test_reflow_pipeline.py`'s three, `test_reflow_gate.py`'s floor pair, and the probe's `long_band` collection — deliberately removed rather than skipped. Keep R1, R3, R4 and **`CONVERTER_VERSION = 3`** (R1 and R3 moved bytes, so cached artifacts still have to re-run; the version is not the tier's). The footer then stays open as a named defect with its measurement in `tasks.md` → C2 and C.5 item 5, and `docs/invariants/reader.md`'s reproducibility bullet loses its one exception. **Done means:** `scripts/pdf-reflow-probe.py --production --book Universe` reports `1 byte-stable across two runs` and the same G5 223 of 255, `pytest sidecar/tests -q` is green with those cases gone, and the record (this annex's Status, `tasks.md`, and a `CHANGELOG` line only if a user-visible claim moved) says the tier was withdrawn and why. **When A is what lands instead:** if B's rule cannot hold byte stability on the corpus after its own measurement, A is the fallback — and then the promise is withdrawn rather than deferred: the footer and the running heads stay printed exactly as they always were.

**B — the rule that has to work: band furniture, page numbers included.** What the corpus actually carries, counted on the five artifacts the run produced (`dist/reflow-production/measured/`):

| Book | Blocks | Legal footer | Letter-spaced running heads | Number-only blocks |
| --- | --- | --- | --- | --- |
| Universe: Solar Systems, Stars, and Galaxies | 12,427 | **245** | **254** | 360 |
| Modernist Cuisine: Volume 1 | 5,316 | 1 | 25 | 173 |
| Politics, Philosophy, Culture | 2,832 | 1 | 7 | 28 |
| Attention is All You Need | 197 | 0 | 0 | 2 |
| Sequence to Sequence Learning with Neural Networks | 163 | 0 | 3 | 8 |

*Universe* is the shape of the problem — ~500 blocks of printer's furniture inside the flowing text of a 535-page textbook — and it shows where the page numbers are: **welded into the running heads**. `Chapter 7 | The Sun 1 1 7` is a head whose trailing `1 1 7` is the page number, letter-spaced so the text layer reads each digit on its own baseline; the footer's own `Copyright … Cengage` is the other half. The number-only column is mostly content — a figure's `-40`, a table's `1,000`, a section's `10–2` — so a bare-number rule has to stay inside the band and keep its ceiling; the numbers that are furniture are the ones inside a head.

Two consequences the tier never faced. **(1) Loosening exact equality is not the repair.** The tier's key varied page to page; a running head varies *legitimately* — each names its own chapter (`C H A PT E R 3 CYC L ES O F TH E SU N A N D M OO N 39`) — so no book-wide key ever reaches half the pages, and a looser match would start merging different chapters' heads into one. The rule has to be structural: what the page's own top and bottom band carries, judged within a section, or against the chapter title the outline already attests, with letter-spacing and digits normalized away. **(2) The gate cannot see any of this, so B needs its own decider.** G2 and G6 measure the words an artifact *lost*; not one of the eight checks counts words it *added*, so 500 furniture blocks in the flowing text read as a pass today. The census table above is that instrument's shape — per-artifact counts of band furniture — and `docs/invariants/reader.md`'s byte-stability bar stays alongside it, because a rule that reshuffles the artifact run to run is the same failure the tier had. Its unit cases must be artifact reads, not synthetic repeated strings: identical-input cases pass on the broken rule too, which is exactly how this shipped. It rewrites C.5 item 5 and C.4's G2 again, and it lands a new `CONVERTER_VERSION`.

**B is built — see `The replacement, landed 2026-10-13` below.** **Decided, and not a session's to widen:** the two corpus failures that reproduce on `5a68e81` (*Attention*'s G2/G6, *Sequence to Sequence*'s G1/G2/G6 — the helper's own reading on a later macOS than run 2 recorded) and the owner's open questions 7–9 and D8's three deviations, which want a word rather than work.

**Owner decisions still open, untouched by this slice** — C2's _(1)_ and _(4)_: open questions **7–9** (may G2/G6 keep excluding what only the pipeline's record knows — the same artifacts score 1/6 under `--gate-only`; is _Universe_'s G3 witness repaired in the check; what is G5's bar on a book whose outline entries have no heading) and D8's three deviations (no `version` member on the payload, a `reason` member on the 422, `API_VERSION` stays 1). Each carries a recommendation in the spec and is awaiting the owner's word.

---

## The replacement, landed 2026-10-13

B, built. **One commit**: `sidecar/reflow/furniture.py` (the rule, once, read from both sides of the pass), `layout.py` (the shape route in, the tier out), `gate.py` (`_is_furniture` rewritten, `furniture_keys` and `PageEvidence.long_band` removed, `furniture_census` added), `produce.py` (`CONVERTER_VERSION 3 → 4`), `scripts/pdf-reflow-probe.py` (the census per book, the `long_band` plumbing out), and the tests — the tier's cases replaced rather than joined.

### The rule

A block is page furniture when it is in the page's band **and** its shape is the printer's. **No count anywhere**, which is the whole of the difference from the tier:

- **a running head** — the line is letter-spaced: three or more one-character words making up two-fifths of them. *Universe*'s chapter heads (`C H A PT E R 3 CYC L ES O F TH E SU N A N D M OO N 39`, the trailing digits its page number) and its part dividers (`PA RT 1 TH E S KY`, three of seven words) are both this shape, and so are *Modernist Cuisine*'s `VOLU M E 1 · HISTORY AND FUNDAMENTALS`.
- **the page's own outer margin** — the block lies wholly inside the top or bottom **2.5%** strip. That is below the text column, where a book prints its legal notice and nothing else, and it takes the Cengage footer in whichever state the pass leaves it: `Copyright 2012 Cengage Learning. All Rights Reserved…` whole, or the fragments the zipping produces (`Copyright 2012 Cengage Le deemed that`, 37 characters), or nothing legible at all. Length is no part of the test, which is what makes it work on a block whose text varies page to page.
- the **bare page number** and the **repetition** routes are unchanged from slice 1R: a band line of at most `RUNNING_HEAD_MAX_CHARS` whose digit-normalized text recurs on a quarter of the text pages.

Both halves are measured rather than assumed, and each is what keeps the other honest:

- **The band keeps the shape test honest.** Of *Universe*'s letter-spaced blocks outside the band, every one is content: an equation (`V = V1.04 × 10° = 1020 m/s`), a figure key (`Star a Ari b CM a a Hya a UMi b Cet`), a page whose own text layer reads as one long smear. That is why the shape alone is not the rule — and it is the case the tier's synthetic unit tests never saw.
- **The margin keeps the position test honest.** Every block lying wholly inside those strips on the corpus — **184** of them — is furniture (*Universe*'s 138 footer fragments, *Modernist Cuisine*'s 46 one-line running heads and their page numbers), while *Modernist*'s two real prose lines that reach the foot of a page (tops at 2.7%) and *Politics*' footnote at 7.2% are in the band, stay, and are the fixture's negative cases.

### The numbers

**The census** (`gate.furniture_census`) is B's own decider, and it is why this can be called done rather than merely changed: not one of the gate's eight checks counts a word an artifact **added**, so *Universe*'s ~500 furniture blocks read as a pass on every one of them. It counts the two shapes a reader sees as furniture — a rights notice, and a letter-spaced line of capitals — and calls a shape the artifact carries once a page's own rather than the printer's (only a text carried twice or more counts, digits collapsed, so a head with a different page number on every page still registers) — which is what keeps the two front-matter notices (*Modernist*, *Politics*) and *Universe*'s title-page line out of the count. Before → after, on the two production runs of the corpus:

| Book | Blocks | Furniture before (run 3, the tier) | after (run 4) |
| --- | --- | --- | --- |
| Universe: Solar Systems, Stars, and Galaxies | 12,426 → 11,591 | **566** | **0** |
| Modernist Cuisine: Volume 1: History & Fundamentals | 5,315 → 5,227 | **23** | **0** |
| Politics, Philosophy, Culture | 2,831 → 2,828 | 0 | **0** |
| Attention is All You Need | 196 | 0 | **0** |
| Sequence to Sequence Learning with Neural Networks | 162 | 0 | **0** |

Both columns are re-takeable off the artifacts the two runs left behind, one instrument, no layout: `scripts/pdf-reflow-probe.py --census-only dist/reflow-production-run3` reads `3/5 artifacts free` (566, 23, 0, 0, 0) and `--census-only dist/reflow-production` reads `5/5`. Each invocation writes what it read to `census.json` in the directory it read — the decider's reading of an artifact that does not change belongs beside the artifact, not only inside the run's report, because run 4's `report.json` carries the census as the run computed it (*Politics* **3**, its first recurrence gate) while the decider as landed reads **0** on the same artifact. The artifacts agree where it matters: run 3's report predates the census altogether (`census: null` on every book), which is why the before column is the re-take, not the table the run printed.

**Byte stability holds.** Run 4's own line is `production: 5/5 written, 5 byte-stable across two runs, 5 cached on the next open, 5 never served a stale stamp, 5 re-ran the pass on a touched source, 5 wrote only derived/` — against run 3's **4 byte-stable**, whose one failure was *Universe*. `--production --book Universe` on its own reads **1 byte-stable across two runs**. This is the bar D9's stamp rests on, and the one the tier broke.

**Nothing legitimate went.** The rule drops, on the corpus's own layout records: *Universe* **835** of 13,030 blocks, *Modernist Cuisine* **88** of 5,730, *Politics* **3** of 2,840, the two papers **0** — and every one of *Universe*'s **103** distinct dropped shapes was read by hand: a Cengage footer variant, a chapter head, a part divider, the print-run line. G1's golden passages all still appear (checked in the run and pinned by the fixture). G2/G6 move only where the drop is the point, and G6's exclusions are the pipeline's own `dropped_running_heads`, so a correct drop cannot be charged as loss.

**What still prints, named rather than smoothed over.** The census is zero and the residue is not, and it is two measured classes:

- **A running head set without letter-spacing and printed *inside the text column*.** *Modernist Cuisine* keeps **73** of them (`VOLUME 1 · HISTORY AND FUNDAMENTALS`, in settings with no letter-spacing at all, at 2.7–3.4% of the page) and *Politics, Philosophy, Culture* keeps about **200** (its chapter titles at the page head: `The Politics of Contemporary Life` ×31, `Self-Portraits` ×25, `The Ethics of Sexuality` ×20). *Universe* has almost none, which is why its own defect is gone: its heads are all letter-spaced, and its plain part dividers went with the margin.
- **The recurring feature-box headings *Universe* prints in its foot band** — `How Do We Know?` on 36 pages, `Study and Review` on 20, `Great Debates` and `Enhanced WebAssign` on 11 each. These are printed in the band, at furniture depth, by the printer's design rather than by the writer's.

The key that would take both is one this slice measured and did not adopt: **the line's letters with spaces and digits removed** (so `PA RT 1 TH E S KY` and `Part 1: The Sky` are one key, and *Modernist*'s 73 heads are one key at 130 pages). It cannot be thresholded. The sets overlap — *Universe*'s feature headings recur **36**, **20** and **11** times against the **8** that *Modernist*'s `HEAT AND ENERGY` reaches and the **13** of `THE PHYSICS OF FOOD AND WATER` — so a share that unifies the running heads takes the feature headings with them, and one that spares the feature headings leaves the heads. That is a decision about what a reflowed book should keep, not a threshold to tune, and it is recorded for the owner rather than taken here (`tasks.md` → C2).

Amending this slice to take them is a small rule change and a re-measure; what it is not is a reason to hold the two bars this slice was set: the census reads **zero** for every book, and *Universe*'s own defect — the whole reason the item existed — is gone.

### The files

| File | What changed |
| --- | --- |
| `sidecar/reflow/furniture.py` | **new** — the rule once: `letter_spaced`, `in_band`, `in_margin`, `shaped`, and the four measured constants |
| `sidecar/reflow/layout.py` | `RUNNING_HEAD_LONG_*` gone; `_is_furniture` split into `_is_printed_furniture` (shape) and `_is_short_band_line` (the shipped route); `mark_running_heads` drops by shape first, then by repetition |
| `sidecar/reflow/gate.py` | `furniture_keys`, `PageEvidence.long_band` and the `_emit` split gone; `_is_furniture` reads the shapes; `_running_head` and `furniture_census` added (B's decider) |
| `sidecar/reflow/produce.py` | `CONVERTER_VERSION = 4` |
| `scripts/pdf-reflow-probe.py` | the long-band collection gone; the census printed per book and failed on |
| `sidecar/tests/fixtures/reflow_band.json` | **new** — 33 real blocks from the corpus records, 15 of them furniture, with the box each was measured at |
| `sidecar/tests/test_reflow_furniture.py` | **new** — the artifact reads: the fixture against the rule, against a whole pass, and the two shape tests |
| `sidecar/tests/test_reflow_pipeline.py` | the tier's three cases replaced by the shipped repetition route's, and the shape route's own |
| `sidecar/tests/test_reflow_gate.py` | the tier's two cases replaced by the fixture read from the gate's side, the long-band case, and two census cases |

### What the record gets wrong now

**This annex's own census table reads differently under the decider that landed, and the numbers above are the decider's on both sides.** The table in *The decision* was counted by hand on the run-3 artifacts — **245** legal footers and **254** letter-spaced heads for *Universe* — and `gate.furniture_census` asks its own questions of the same files: it wants the letters to dominate a line (a letter-spaced *equation* is not a running head) and it counts the footer's *fragments* as notices, where the hand count took only the ones carrying a whole phrase. Re-taken on run 3's artifacts it reads **207** notices and **359** heads, **566** furniture of *Universe*'s 12,426 blocks, and **23** of *Modernist Cuisine*'s 5,315. **Nothing moves but the instrument:** the two books it fails are the two the tier was measured failing, the other three read zero both ways, and run 4's artifacts read zero everywhere. The command that re-takes either column without laying a book out is `scripts/pdf-reflow-probe.py --census-only <dir>` — the census is a property of the *artifact*, so a fresh layout would be measuring a different one.

**The artifact-side drop counts confirm the record-side ones exactly**, which is the cross-check that says the rule did on the real pass what it did on the records: *Universe* 12,426 → 11,591 blocks (**835**), *Modernist Cuisine* 5,315 → 5,227 (**88**), *Politics, Philosophy, Culture* 2,831 → 2,828 (**3**), the two papers unchanged.

**The gate's numbers are run 3's, to the letter.** Run 4 reads `gate: 1/6 books pass` — *Universe* G3 (`alabama`, `pane`, `researchers`) and G5 222 of 255 (87%), *Attention* G2 88.4% of 3,800 and G6 5.4%, *Sequence to Sequence* G1/G2 92.3% and G6 3.9%, *Politics* G5 21 of 31 (68%), *Modernist Cuisine* G5 2 entries for 355 pages, *Asterix* G8 pass. Every one of those is exactly run 3's, and every one is one of the owner's open questions or one of the two failures that reproduce on `5a68e81` — **none of them is this rule's**.

---

## Start here

```bash
cd /Users/oh/Projects/musaeum-macos
git log --oneline -3          # 2c213fd ("pdf cleanup") landed 2026-10-12; the furniture rule's replacement is the next commit
git show --stat 2c213fd       # 13 files, +461 / −38 — the ten below, this annex, the spec's Status, tasks.md
sidecar/.venv/bin/python -m pytest sidecar/tests -q      # 413 passed; -k reflow is 142
sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --census-only dist/reflow-production
```

Then read, in this order:

1. **This annex's _The replacement, landed 2026-10-13_** — B, built: the rule, the census before → after, the byte-stability reading, the gate's numbers and the residue. Everything `C2-tail (a)` owed is settled there.
2. **This annex's _The decision_** — taken 2026-10-12: **B**, band furniture removed including page numbers, with the census it had to be measured against and the decider it needed. It is the *why* behind the replacement.
3. **`tasks.md` → C2 and `C2-tail (a)`** — the tracker's own words for the same thing, and what is still open around it.
4. **This annex's _Readings_ and _What landed_** — the four rules that were settled, why each alternative lost, the seven steps with their outcomes in order, and which of the four the run found short of its own claim.
5. **The parent spec's Annex C.4, C.5 and C.7** — the gate's eight checks, the rules this annex amends, and runs 2, 3 and 4 per book.
6. **`sidecar/reflow/furniture.py`, beside `layout.py`'s `mark_running_heads` and `gate.py`'s `_is_furniture`** — the rule once, read from both sides of the pass, after the two-copies version it replaced (`gate.furniture_keys` beside `layout.mark_running_heads`) drifted into the tier and had to be pulled.

The commands in the block above are what the counts in this document belong to. The corpus run (~30 min on the annex's estimate, ~12 min measured, ~25 min for run 4) was the first thing done, not a later step: it is the only instrument that proves a rule changes what the pass *writes*, and the only thing that re-takes C.7's numbers — and on 2026-10-12 it also falsified two of this annex's own claims about what the rules do, which is why _What landed_ leads with the run rather than closing with it.
