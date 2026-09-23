# Annex: the ask panel's passage window (a defect fix)

**Date:** 2026-09-21 **Status:** built and verified, uncommitted. **Scope:** what travels at the passage rung, and what the prompt says the pointer is — not the ladder, not the rung, not the wire. **Depends on:** `docs/superpowers/specs/2026-09-19-reader-ai-panel-design.md` (D5's payload, D6's ladder — both amended in place at their sites); the reader (`docs/invariants/reader.md`); `src/types/foliate-js.d.ts` (invariant 11's sanctioned home for a vendor divergence). **Interacts with:** the deferred L2 rung (adjacent sections) — this annex does *not* build it, and explains below why its reversal condition is nearer than it looks.

Written from a defect Jason reported from his own screen, with the frame: *"i've highlighted a section at 5%, but the ai thinks i'm still in the introduction."*

---

## 1. The report, and what the panel had said

The screenshot's ask panel, read in full:

- the warning — *"The model could not place this book — questions this session go out with the passage too"* (the `weak` verdict, doing its job);
- the reader's question, and the answer — *"That passage is from later in the book than where you are — you're in the Introduction, and it hasn't come up yet in what you've read."*;
- the citation button — **Go to "Introduction"**, offering to jump to where they already stood;
- the footer — `Sends: title, author, section "Introduction", position (5%), your question, your highlight, this section's text → https://api.deepseek.com · deepseek-flash — this section's text truncated at 6000 characters`.

The reader's own words in the sidebar — *"it's hard to ascertain whether what i'm experiencing is normal"* — sit under a passage that answers exactly that, and the panel told them they had not reached it yet. The answer was not merely unhelpful; it argued them out of the page in front of them.

## 2. What was measured

Read off the book's own folder on the library (`/Volumes/books/musaeum/books/5fe9acf0-…`), not inferred from the screenshot.

| Fact | Value |
| --- | --- |
| Book | *How to Stop Losing Your Sh*t with Your Kids* — Carla Naumburg, epub |
| Stored position | `epubcfi(/6/12!/4[intro],/48/1:230,/56/3:83)`, `reading_percent` **0.0534** |
| The section it lands in | `intro.xhtml` — `<body id="intro">`, **47 element children** |
| The section's own text (`body.textContent`) | **18,405 characters** |
| The page being asked about (body child 24, `cfi/48`) begins at character | **7,805** |
| The highlighted box (body child 25, `div.BX`) begins at character | **8,302** |
| `PASSAGE_CHAR_CAP` | **6,000** |
| So the block that went out covered | characters **0–5,999** |

**The passage stopped 2,302 characters before the reader's page and 2,502 before the passage they were asking about.** What the model held was the part of the Introduction they had already walked past — *"Six Truths About Parental Shit Loss"*, the six numbered truths, the start of *"Why You Haven't Gotten Your Shit Together Yet"* — and nothing that followed, while the system prompt told it (correctly, of its own block) that *"a block labelled as coming from the book may have been cut off at the end… if the answer depends on something past that point, say that you only have the beginning."* It resolved that gap into a fact about the **reader**: not *"I was only given the beginning"* but *"it hasn't come up yet in what you've read."*

**And the section label was not wrong.** The book's own nav has eleven content entries, one per file, and `intro.xhtml` is `Introduction`; the heading on screen — *"Why There's No Such Thing as a Bad Parent"* — is `<p class="BXH-2-col">` inside `<div class="BX">`, which the book gives **no TOC entry and no `<h*>` element at all**. foliate's `TOCProgress.getProgress(index, range)` returns the last entry whose fragment precedes the position, which is `Introduction`, and that is the only name the book offers for it. The pointer was true and useless: it said *section "Introduction", about 5% through* for a page sitting **55% of the way into an 18,405-character section**. The prompt said nothing about a table of contents being coarser than a page, so the model read the label as a measure of progress — and 5% is precisely the number that makes "you haven't got there yet" sound reasonable.

Two defects, then, and the second is what made the first answerable:

- **D-A — the passage was the section's head, not the part they were in.** The cap alone was never enough: the longer the section, the further behind the reader the passage sat, silently. The design's assumption ("the section body of a typical trade EPUB is under this") is false for this book by 3×, and it is false for every textbook section, every long Introduction, and most front matter.
- **D-B — nothing told the model what the pointer is, or forbade it to narrate the reader's progress.** The one rule covering missing text was written about *the block*, and the model applied it to *the person*.

## 3. The fix, as decisions

**D1 — The passage is a **window around where the reader is**, not the section's head.** A window of `PASSAGE_CHAR_CAP` (6,000) with `PASSAGE_LEAD_CHARS` (**1,000**) in front of the anchor and the rest behind it, clamped so a reader near the section's end gets a longer run-up rather than a short window. It always contains its anchor. This is the whole defect: at the reported position it sends 6,806–12,805 instead of 0–5,999, and the highlighted box is inside it.

**D2 — The anchor is a measurement first, the highlight second.** `sectionOffset` — the rendered page's start, as a character offset into the section's own text — is measured by the engine, so it is right by construction; where it is absent (a relocate that arrives before the section's first one, a range that belongs to another document), the window falls back to the **highlight's** position in the section text, found with `indexOf`. That fallback is legitimate rather than a guess: `selection.toString()` and `Range.toString()` are both the concatenation of covered text nodes, which is the same model `sectionText()` uses. Where neither is known, the head is still the window, `windowed` is `false`, and the disclosure line says what it has always said — the pre-fix behaviour, kept as the honest floor rather than deleted.

**D3 — The engine measures it with the range it is already being handed.** `View.#onRelocate` emits `{ …progress, tocItem, pageItem, cfi, range }`, and the paginator builds that range from `#getVisibleRange()` on every page turn — so the position within the section was already arriving at the listener and being dropped. `range` is added to `src/types/foliate-js.d.ts` (invariant 11's sanctioned home) and `ReaderEngine.sectionOffset()` computes the offset as **the length of the text before the range's start**. Building it by measurement rather than by walking nodes handles both shapes a page's start takes — a text node (`startOffset` is a character index) and an element (the same number is a child index) — with no special case for either, and it returns **null** rather than a guess when the range belongs to a different document than the loaded one. That last property is what removes the sequencing question: a relocate still queued from the previous section measures against a document it does not belong to, and the store clears the offset on `setSection` anyway.

**D4 — The offset is session state, and dies with its section.** `sectionOffset` is a field of `reader.store` beside `section`, set on every `relocate` and cleared by `setSection` — because it is a measurement *of one section's text*, and a window built on a stale one would slice the next section at a position that means nothing in it. It is deliberately **not** in `latest.current` (reader.md's progress report), which is spread straight into `saveProgress`: a character offset has no business in `metadata.json`.

**D5 — The disclosure line distinguishes the window from the section.** `windowed` rides in the payload, and `labelFor` renders the passage member as **"this section's text around where you are"** instead of "this section's text". The cut notice is unchanged, because it is still true, and D5 of the spec's rule — the line cannot claim less than is sent — is what makes this a field rather than a sentence typed into the panel.

**D6 — The prompt says what the pointer is, and what the model cannot know.** Three additions, all in `askSystem`:

- the section is named by the book's own table of contents, **"and a table of contents can be far coarser than the page: one entry can run for many pages and hold headings of its own that it never lists. Treat it as a rough location and nothing more."**
- a rule: **"You do not know what they have read and cannot work it out from where they are, so never tell them something has not come up yet, or that it is further on than where they are. The text in their message is what is in front of them at this moment."**
- and, **only when the payload really is a window**, a rule saying so — that the block can begin and end mid-sentence and that what precedes their position is run-up. A rule describing something the payload does not do is a rule the model has to reconcile with the block in front of it, so this one is absent at the head of a section rather than always present.

## 4. Files

| File | What changed |
| --- | --- |
| `src/lib/ask-context.ts` | `PASSAGE_LEAD_CHARS`; `passageWindow()` + `anchorOffset()`; `windowed` on `AskPayload`; the windowed disclosure label; the three prompt additions (one conditional) |
| `src/lib/ask-context.test.ts` | +6 window cases (the reported numbers, anchor precedence, the end-of-section clamp, the short-section negative, the line), +3 prompt cases |
| `src/components/reader/ReaderEngine.tsx` | the loaded-section ref; `sectionOffset(doc, range)`; the offset on the `onRelocate` detail; cleared on teardown |
| `src/stores/reader.store.ts` | `sectionOffset` + `setSectionOffset`; `setSection` clears it; in `ASK_IDLE` |
| `src/stores/reader.store.test.ts` | +3 cases: kept across a re-report, dropped for a new section, dropped for a new book, and no notify for an unchanged value |
| `src/components/reader/ReaderView.tsx` | wires `setSectionOffset`, and keeps the offset **out** of the progress report |
| `src/components/reader/ReaderAsk.tsx` | passes `sectionOffset` into the assemble and the disclosure preview |
| `src/types/foliate-js.d.ts` | `range?: Range \| null` on `FoliateRelocateDetail`, with the reason it is read and never held |

## 5. Criteria, and what decides each

| AC | Claim | Decider |
| --- | --- | --- |
| 1 | A long section sends the part the reader is on, not its head | `ask-context.test.ts` — the reported case to scale (18,405 / 7,805 / 8,302), asserting the passage is **not a prefix** of the section and contains both the page and the highlight |
| 2 | The window always contains its anchor | the same case, plus the end-of-section case (the last `PASSAGE_CHAR_CAP` characters, whole) |
| 3 | A short section is sent whole and is not called a window | `windowed === false`, `truncated === []`, and the system prompt contains no window sentence |
| 4 | The highlight is a sound fallback anchor | a case with no offset at all: `windowed` true, the highlight inside |
| 5 | The disclosure names the window, and never names something it did not send | the line's own string case, beside the existing cut case |
| 6 | The model may not narrate the reader's progress, and is told the label is coarse | two prompt cases |
| 7 | The offset follows the page, and dies with its section | `reader.store.test.ts`; **and live** — the offsets below |
| 8 | The engine measures it at all, off the real vendored relocate | the live pass; the range is read off `paginator.js:953`'s `#getVisibleRange()` through `view.js:263`'s listener |
| 9 | Nothing about the offset reaches `metadata.json` | `ReaderView`'s `latest.current` still carries exactly `{ position, percent }`; read after the live pass, the book's `reading_state` still holds exactly `position` / `percent` / `updated_at` — and its CFI places it in `intro.xhtml`, which is the section the offset was measured in |

## 6. Gates

`npm run typecheck` 0 · `npm run lint` 0 · `npx prettier --check` clean on all 8 touched files · `npm test` **1038 passed / 48 files** (baseline **1026 / 47 files** — 12 new cases in the two touched suites).

**Three mutations, three killed, eight cases reddened** — each applied to the shipped tree and restored byte-exact:

| Mutation | Left the suite |
| --- | --- |
| `anchorOffset`'s result discarded (`const anchor = null`) — the pre-fix behaviour | 6 of 27 red in `ask-context.test.ts` |
| `setSection` no longer clears the offset | 1 of 32 red in `reader.store.test.ts` |
| `labelFor`'s windowed branch deleted | 1 of 27 red in `ask-context.test.ts` |

The first is the same mutation the live pass was run with, on purpose: it is the defect, reproduced in the running app rather than described.

## 7. The live pass

Isolated profile (`MUSAEUM_USER_DATA`), a synthetic library, a **stub SSE endpoint** on `127.0.0.1:8765` that logs every payload it is sent — slice 3's instrument, reused, so no real book and no real library were opened. The fixture reproduces the reported **shape**: a 3-section EPUB whose second section is 18,405 characters under a single TOC entry named *Introduction*, with one marker 213 characters in and another at 8,302.

The app was driven over CDP (`.claude/skills/verify`'s recipe; the dev server's module graph answers `import('/src/stores/reader.store.ts')`, so the reader's own store opens the book and the panel is read directly rather than scraped). Four `PageDown`s put the reader at `sectionOffset` **8,480**, `sectionLabel` *"Introduction"*, section text 18,418 characters, 56% through the book.

**Before / after, same position, same question, one mutation apart:**

| | `passage` | head marker (char 213) | page marker (char 8,315) | disclosure |
| --- | --- | --- | --- | --- |
| pre-fix behaviour | 6,000 chars from char 0 | **present** | **absent** | `this section's text` |
| shipped | 5,999 chars from char 5,727 | **absent** | **present** | `this section's text around where you are` |

The pre-fix row is the report, reproduced: the block that travelled *did not contain the page the question was about* — 2,481 characters short of it — which is exactly the gap the model turned into *"it hasn't come up yet in what you've read."*

Also measured, and worth knowing:

- **The offset tracks the page turn by page turn**: 1 → 2,704 → 5,584 → 8,480 → 11,363 → 14,242 → 17,127, and **0** plus a cleared state when the section changed to the next one. Roughly 2,700 characters a page at the default typography.
- **Opening the panel moves the reader's page**, because the 288px column reflows the paginator: the same page that reported 8,480 before the panel opened reported **6,726** after, and the window followed it (start 5,727, anchor 6,727). The window is built at send time from the state at send time, so this is correct — but it is a real behaviour, not a rounding, and it is why the anchor is read live rather than cached at section load.
- **The probe's own line and the ask's line disagree by design**: the probe asks the model to place *the section*, whose opening is where the section starts (`scoreRecall` compares against the first 120 content tokens), while the ask sends the window around the page. Both are consistent with the label meaning "the book's TOC entry" — and the probe's OPENING check is unaffected by this change.
- **The verdict was `weak` and the rung `passage` in the live run**, which is the branch under test; the `strong` branch sends no passage at all and so is untouched by the window. That the real book measured `weak` *with its section text sent* is the spec's stated reversal condition for the deferred L2 (adjacent sections) — recorded here as **fired**, not acted on: L2 is a different question (text the reader has not reached) and folding it into a defect fix would leave both unmeasured.

## 8. Deliberately not done

- **No finer label from the page's own heading.** The most obvious "fix" for the reported sentence is to send *"in the Introduction, at the part headed 'Why There's No Such Thing as a Bad Parent'"* — and it cannot be done honestly from this file: the heading is `p.BXH-2-col` inside `div.BX`, not an `<h*>`, not in the nav, not `role="doc-*"`. Every route to it is a class-name heuristic (`AHD`, `AHD1`, `BHD-w-Step`, `BXH-2-col` are all Adobe export names), which is a bet about how other books are marked up, and this repo does not ship those without a census. **The window is the honest fix for the same defect**: the heading travels *inside the passage* now, where the model can read it, instead of being guessed at and asserted. Where it does not travel — the pointer rung, `strong` recall — the label remains the book's own, which is what D5 chose.
- **No change to the cap.** 6,000 characters is the design's number and the defect was where the window sat, not how big it was. Truncation is still disclosed, and still cuts the far end.
- **No change to `recall.ts`, the rungs, the wire or the panel's layout.**
- **No persisted offset.** It is reading *position*, and position already has a home with a clock and a reconcile rule; a second one would be a second answer to the same question.

## 9. Residual

- The window is anchored on **the page's start**, so a reader whose question is about the last line of a page has ~5,000 characters of what comes next and 1,000 of run-up. A highlight moves the anchor only when the engine has no offset.
- **A window can begin mid-sentence**, deliberately — and the disclosure says "around where you are" rather than claiming otherwise. The prompt's window rule exists so the model does not read the first line as the section's beginning.
- The fallback anchor is exact when the highlight arrives verbatim in `textContent`; where whitespace collapsed at a block boundary (reader.md's known limit) `indexOf` misses and the window falls back to the head. Unmeasured in the wild — the offset is present in every relocated section, so the fallback is a floor rather than a path.
- The probe still asks about the section's **opening**, which for a long section is text the reader left long ago. It is the right question for what the probe is for (does the model hold this book) and the wrong one for where they are; a per-section-window probe is a different design and is not proposed here.
