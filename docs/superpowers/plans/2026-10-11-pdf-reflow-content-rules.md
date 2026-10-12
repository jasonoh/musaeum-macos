# PDF reflow slice 6 — the content rules (annex)

**Date:** 2026-10-11
**Slice:** 6 of `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` (follows slice 1R's review; the spec's own table stops at 5, which is the docs-only _record_ and is written)
**Status:** **In flight, in the working tree, uncommitted.** Code and its deciders are done and green; the corpus re-run and the record are not. Nothing below is on `main`.
**Annex to:** `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` — the readings here settle four items `tasks.md`'s C2 entry lists as open, and they amend **Annex C.5 items 5 and 9** and **C.4 G2 and G5**. The parent spec is the authority for every product decision; this document settles _rules_ inside them.
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

Branched from `main` at `5a68e81`. All ten files are **modified in the working tree and uncommitted**.

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

`git diff --stat`: **10 files, +323 / −35.**

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
- **The pipeline's three existing tunables.** `RUNNING_HEAD_PAGES` (0.25), `RUNNING_HEAD_MAX_CHARS` (80) and the whole figure/plate block are unchanged; the tier _adds_ two constants rather than re-scaling the old ones, so a book with no long furniture behaves exactly as before.
- **The gate's short band rule.** A band line ≤80 characters is still excused outright, which is the rule the gate has always had; only the long case is new. Tightening it is a separate change with its own measurement.
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

## What remains, in order

1. **Run the corpus** (`--production`, ~30 min) and read it against C.7 run 2, with the G5 expectation above.
2. **Run the JS gates** — `npm run typecheck && npm run lint && npm test`. Lint needs `--ignore-pattern '.delta'` in this clone: `.delta/worktrees/` holds another session's in-flight worktrees and `eslint.config.mjs:14` does not ignore them (6475 errors, all `No tsconfigRootDir was set`). **Do not delete `.delta/`.**
3. **Amend the parent spec**: Annex C.5 items 5 and 9 gain R1–R3's rules in place, C.4's G2 and G5 gain R2's and R4's, and the header's _Status_ gains this annex. The spec is the authority for the rules; this annex only settles them.
4. **Write the record into `tasks.md`** — the C2 entry's _(2)_ clause closes, and the C2 bullet gains this annex's path and the run's numbers.
5. **`CHANGELOG.md`** — _Added_/_Fixed_ bullets a user would notice: a book's real chapter names no longer disappear from the contents panel, a licence footer no longer prints 323 times, a wrapped chapter title is no longer cut in half. **Written on landing, not now** — the work is uncommitted and the entry would claim something not yet in history.
6. **Then the minors C2's _(5)_ still lists**, none of them touched here: the smoke poll does not cap `Retry-After` and treats a 503 busy as a FAIL; `GET …?format=reflow` calls the sidecar even for a cached artifact (`resolveReflowFile` without `ensure` is the option); the 422 branch has never been exercised live; and nothing caps passes across books against the four sidecar threads hydration and Kindle conversion share.

**Owner decisions still open, untouched by this slice** — C2's _(1)_ and _(4)_: open questions **7–9** (may G2/G6 keep excluding what only the pipeline's record knows — the same artifacts score 1/6 under `--gate-only`; is _Universe_'s G3 witness repaired in the check; what is G5's bar on a book whose outline entries have no heading) and D8's three deviations (no `version` member on the payload, a `reason` member on the 422, `API_VERSION` stays 1). Each carries a recommendation in the spec and is awaiting the owner's word.

---

## Start here

```bash
cd /Users/jasonoh/Projects/musaeum-macos
git log --oneline -3          # HEAD is 5a68e81 ("americanized"); this slice is uncommitted
git status --short            # 10 modified files — read the annex's file table against it
git diff --stat               # 10 files, +323 / −35
sidecar/.venv/bin/python -m pytest sidecar/tests -q      # 408 passed; -k reflow is 137
```

Then read, in this order:

1. **`tasks.md` → the C2 bullet and the `[~]` entry under it** — what the feature is, what is closed, what is not, and the two owner decisions waiting.
2. **This annex's _Readings_ and _What remains_** — the four rules that were settled, why each alternative lost, and the six steps left, in order.
3. **The parent spec's Annex C.4 and C.7** — the gate's eight checks and run 2's per-book table, which the corpus re-run is read against.
4. **`sidecar/reflow/gate.py`'s `furniture_keys` and `_emit`, beside `layout.py`'s `mark_running_heads`** — the same rule implemented twice on purpose, once from the artifact's side and once from the source's, and the pair that has to agree for G2's recall to mean anything.

The three commands in the block above are what the counts in this document belong to. The corpus run (~30 min) is the first thing to do, not a later step: it is the only instrument that proves AC6 and the only thing that re-takes C.7 run 2's numbers.
