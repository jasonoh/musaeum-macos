# Design: PDF that reads like a book — a reflowed EPUB as the default view, the original as the escape hatch (C2, v1)

**Date:** 2026-10-07
**Status:** **Agreed 2026-10-07; amended 2026-10-08 after slice 1 failed review.** The owner read `dist/reflow-spike/` and every artifact failed: no usable images, interleaved columns, a broken TOC. The review (Annex C) traced each defect to a cause in the code, found that the automated gate could not fail a book on order, figures or TOC, and withdrew Annex B's pass and its B.1 "correction". **D4 is superseded by D4R** (Apple Vision's document analysis supplies regions and reading order; the PDF's text layer supplies the characters), and **slice 1R** re-ran the spike behind a rebuilt gate on 2026-10-08: the slice-1 artifacts still fail it and the slice-1R artifacts pass it for **four of the six corpus books** — *Universe* fails G3 and G5, *Politics, Philosophy, Culture* fails G5, and Annex C.7 run 2 names the cause and the measurement behind each. Slices 2–5 no longer wait on the corpus gate: **slice 2 — the pass, production — landed 2026-10-08** (`feat/pdf-reflow-slice-2`, merged as `4140b3e`) and **slice 3 — the Mac reader — landed 2026-10-09** on `feat/pdf-reflow-slice-3` (merged to `main` as `ff09553`), so a **PDF-only book opens in the app** and a book the pass refuses goes to Preview with one line of reason. **Slices 4 and 5 remain** — the wire (`docs/rest-api.md` first, D8) and the record. **The owner read `dist/reflow-spike/` on 2026-10-08 and accepted it for this stage**, so slice 1R is on `main` (`b165d8e`) and the two slices above followed it; slice 3's own record is `tasks.md`'s C2 entry and `docs/superpowers/plans/2026-10-09-pdf-reflow-slice-3.md`, and the invariants it settled are in `docs/invariants/reader.md` (*Reading in the app*) — the rest of the reader's reflow rules, `derived/`'s standing among them, are slice 5's; the two failures and the gate's dependence on the pipeline's own record stay open exactly as Annex C.7 records them — the G5 ones are entries the book has no heading for and entries pointing at pages with no text layer, and open questions 7–9 carry the three decisions that follow from them.
**Scope:** A PDF-only book becomes readable in-app on both platforms by **default through a reflowed EPUB** — one artifact, produced once by the Mac sidecar, cached on the NAS — with the original PDF one gesture away. It deliberately does **not** touch `metadata.json`'s shape, `book.formats`, the SQLite schema, the Calibre migration wizard, OCR, or annotations.
**Depends on:** `docs/invariants/reader.md` (the reader shell, the entry points, the reading-state schema, and the typography/theme layer the artifact inherits), `docs/invariants/nas-and-catalog.md` (the book folder layout and the by-extension rule), `docs/invariants/files-and-deletion.md` (what a book folder holds), `docs/rest-api.md` (the wire the phone reads), `../musaeum-ios/docs/specs/2026-09-22-client-v1-design.md` (the phone's reader).
**Interacts with:** `components/reader/ReaderEngine.tsx` + `stores/reader.store.ts` (the open path), `services/book-bytes.ts` + the `musaeum://` registration in `electron/main/index.ts`, `services/file-access.ts` + `services/apple-books.ts` (the escape hatches), `sidecar/main.py`'s `METHODS` and the notification channel (`services/sidecar.ts:34`), `services/api/shape.ts` + `api/rest.ts`.
**Reverses:** `docs/superpowers/specs/2026-07-14-pdf-multimachine-reader-design.md` § *Engines* ("**PDF: pdf.js** (Mozilla), canvas-rendered") and its § *Experience* line "PDF mode: fit-width / fit-page, zoom" — as the **reading** view. pdf.js is not deleted from the plan; it is demoted from the default to a later refinement of the original's own view (D9). It also fires the iOS backlog's deferred item *PDF in the reader* (revival condition: "a book wanted on the phone that is PDF-only") and amends `tasks.md`'s C2, whose text is written as pdf.js into the existing shell.

---

## Why now

**The library is full of books the phone cannot read, and the phone is where papers are read.** Read off the live database 2026-10-07: of 6,731 books, **1,707 have no EPUB at all** — and an EPUB is the only format both engines render. 1,714 rows hold a PDF, and **1,534 of them hold a PDF and no EPUB**, which is the set this design is for: 1,489 hold *nothing* the Mac can open (`formats == ["pdf"]` coincides exactly with "no epub, azw3 or mobi" here, which is why the Mac's own rule would have found only those), and 45 more hold a Kindle format beside the PDF — **the paper shelf** (§3), where the Mac reads a `mobi` it renders perfectly well while the phone downloads that same `mobi` and fails, because Readium renders EPUB and the client has no mobi branch. On the Mac a PDF-only book falls through to Preview (`stores/reader.store.ts`'s `openBook` → `files.openBookFile`), the pleasant-once-unpleasant-for-a-chapter experience this design exists to replace. On the phone they are worse still: the wire serves `format=pdf`, the client downloads it, and `ReaderModel.load` renders every download with an `EPUBNavigatorViewController`. Readium can *parse* the PDF — the opener is already built with a `pdfFactory` — but nothing in the client renders one, which is what `../musaeum-ios`'s backlog means by "a separate navigator and a PDF document factory, which is not wired here". **Read as a product number: the phone can read 5,024 books today and 6,558 once this ships** (the 1,534 above, less the image-only minority the fallback rule sends back to the original).

**The shape that makes both platforms cheap is one artifact, not two readers.** A reflowed *EPUB* is rendered by the engine each client already owns: on the Mac foliate takes it through the same `musaeum://book/…` route and the same `ReaderEngine`, so the TOC panel, find-in-book, the AI ask panel, the typography popover, the theme-derived page CSS and the whole `reading_state` policy arrive for free; on the phone Readium opens it with the navigator it already builds, at a fraction, with **no iOS engine change**. "Parse the PDF, then render it like an ebook" is therefore one pipeline and one artifact, not a per-platform project.

**The owner's decisions (2026-10-07), which this spec implements.** High fidelity means *the words, the flow and the images in the correct order* — not a facsimile of the page. Conversion is **on demand, cached, with the original readable during**, and needs a visible progress surface. The reflowed EPUB's own position is the position of record; **the original PDF does not get a position in v1**. A book whose layout cannot be laid out confidently falls back to the original rather than shipping a mangled reflow. The wire carries it additively. Tooling is chosen below on measured weight and licence.

## What the corpus actually says

Everything in this section was measured on 2026-10-07 against `/Volumes/books/musaeum` and the live database; the commands and the raw per-page numbers are in **Annex A**. The point of measuring first was that the tooling decision and the fidelity gate both depend on facts nobody had: how much of the shelf even has text, and how badly the two candidate extractors actually read a real textbook.

### 1. One book in ten has no text layer at all

Thirty books holding a PDF and no EPUB sampled at random (`random.seed(20261007)`), three spread pages each, characters counted per page:

| Verdict | Books | What it means |
| --- | --- | --- |
| **Text** (≥200 chars on some sampled page) | **27 / 30 (90%)** | Ordinary reflow candidates |
| **Image-only** (0 chars on every sampled page) | **3 / 30 (10%)** | Scanned or plate-only; reflow needs OCR, which is **out of v1** |
| **A parser that could not open the document** | **0 / 30** | A defensive clause in D6, **not** an observed case — see the revision note |

Of the 27 text books, every one reached ≥1,000 characters on some page and **22 carried a PDF outline** (a ready-made TOC). A 30-book sample puts a wide interval on the 10% (roughly 2–26%), so treat the share as "a real minority", not a number to plan a backlog against. The three image-only verdicts were re-checked with a second extractor on the same pages (`pypdf.extract_text`: 0 characters on every one), so the verdict is the file's and not the probe's.

*Measurement revision, recorded because it moved a published number:* this table first read **26 text / 3 image-only / 1 unopenable**. The unopenable one was my own probe: the page picker computed `npages - 60` without clamping, so the sample's shortest book (12 pages) asked for page **−48** and the raised `PdfiumError` was recorded as "this document cannot be opened". Re-measured, *Efficient Estimation of Word Representations in Vector Space* reads normally — 11 of 11 sampled pages, 3,539 median characters, a 19-entry outline. The corrected tally is above, and no book in the sample defeated a parser.

**This is why OCR is not in v1 and why the fallback rule is load-bearing rather than boilerplate:** the population the reflow cannot serve is real, it is not rare, and D6 makes falling back on it a normal outcome instead of a defect.

### 2. The five hard cases I picked were not the hard cases

The five books chosen by title and size — a scanned-looking textbook, a designed cookbook, a physics text, a comic volume, a communications text — sampled 20 pages each from the middle of the book (pages 41–60):

| Book | Size | Pages | Text pages | Outline | Images/page |
| --- | --- | --- | --- | --- | --- |
| *Molecular Cell Biology, 7th Ed* | 708.2 MB | 1,247 | **0 / 20** | 7 | 1 (full-page) |
| *Understanding Human Communication, 11th Ed* | 371.5 MB | 516 | **0 / 20** | 14 | 1 (full-page) |
| *The Complete Far Side, Vol 1* | 625.1 MB | 673 | **0 / 20** | 0 | 1 (full-page) |
| *Universe: Solar Systems, Stars and Galaxies* | 304.8 MB | 535 | 20 / 20 | **256** | 19 / 20 pages, 66 objects |
| *Modernist Cuisine, Vol 1* | 299.4 MB | 355 | 19 / 20 | **355** | 20 / 20 pages |

**Three of the five have no text layer at all**, including the textbook the size alone would have nominated as the two-column case to beat. The corpus for the fidelity gate is therefore chosen by *measured content*, not by reputation — Annex A lists what each of the five actually is, and the spike re-picks if necessary.

### 3. Papers are the genre the phone is for, and they are the layout this has to survive

The owner's use case is reading papers on the phone, so the paper shelf was measured separately: the library holds six of them, all two-column, all with a text layer, and every one holds a `mobi` beside its `pdf` (*Attention is All You Need* an `epub` as well) — not one is `pdf` alone.

| Paper | Formats | Pages | Outline | Text pages | 2-col pages | Median chars | Median runs | Widest interleave |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| *Attention is All You Need* | mobi, epub, pdf | 15 | 22 | 12 / 12 | 12 / 12 | 3,295 | 1 | 5 / 12 pages |
| *Sequence to Sequence Learning with Neural Networks* | mobi, pdf | 9 | 0 | 8 / 8 | 8 / 8 | 4,044 | 3 | 5 / 8 pages |
| *Learning Phrase Representations… (GRU)* | mobi, pdf | 11 | 0 | 10 / 10 | 10 / 10 | 4,535 | 4 | 4 / 10 pages |
| *Scaling Transformer to 1M Tokens (RMT)* | mobi, pdf | 9 | 13 | 8 / 8 | 8 / 8 | 3,728 | 9 | 1 / 8 pages |
| *Transformers Meet Directed Graphs* | mobi, pdf | 29 | 0 | 12 / 12 | 12 / 12 | 5,317 | 7 | 1 / 12 pages |
| *Efficient Estimation of Word Representations (word2vec)* | mobi, pdf | 12 | 19 | 11 / 11 | 11 / 11 | 3,539 | 1 | 8 / 11 pages |

Three things follow, and the third changes a decision:

1. **Two columns are rarer here than the first probe claimed (corrected — see Annex B.1).** The line-start metric this section was written from called 12 of 12 of *Attention*'s pages two-column; gutter detection finds **one band on all 13**, and the genuinely two-column paper on this shelf is *Learning Phrase Representations* (2 bands on 6 of 9 pages, gutters 12–16pt). Across the shelf, 18% of sampled pages carry more than one band (§5). The layout the reflow has to survive is therefore *multi-region* — body plus captions, sidebars and callouts — which is why §4 is about reading order rather than about fonts.
2. **Papers are short and mostly poorly outlined.** 9–29 pages against the 355–1,247-page books above, so a paper's first-open conversion is fractions of a second of extraction — the progress surface (D7) is for textbooks, not for these; and **three** of the six carry **no** PDF outline at all, so the heading pass is what gives a paper a TOC.
3. **None of them is `pdf`-only, and that breaks the obvious trigger rule.** All six hold `mobi` beside the `pdf` (*Attention* also holds an `epub`), so `readableFormat` returns `mobi` and a rule phrased as *"the Mac cannot read it"* would never reflow a paper — while **the phone cannot read `mobi` or `azw3` at all**: Readium renders EPUB, and the client has no mobi branch (its only mentions of the format are a filter facet and the upload list), so a `mobi`-only book downloads and then fails to open. Measured against the live database: **1,707 books have no EPUB**, of which 1,534 hold a PDF (**the reflow set**) and 173 hold neither an EPUB nor a PDF (mobi/azw3-only — outside this feature's reach, and named as a gap rather than quietly skipped).

So the trigger is **"holds a PDF and no EPUB"** (D1/D7), which is one rule that serves both clients for the same reason: the EPUB is the only format both engines render. The 45 books inside that set which also hold a Kindle format are the shelf those papers live on (they are not all papers, and a reflow serves the rest of them just the same).

### 4. Neither candidate library reads a two-column page correctly

**Read this with the correction in Annex B.1 before trusting the labels**: the pages measured here are *table-heavy*, not two-column, and the sentence "every sampled page of every paper is two-column" in §3 is wrong. What the table below still measures is real and still decides D4 — on a page where text sits in more than one region, pdfium's own order makes 5–14 monotone runs where a correct read of the layout needs 2–3, and pdfminer's is no better.

The case is *Universe* (its body is one column, but its pages carry figure captions, sidebars and callouts — 7–9 distinct line-start clusters per page). Same six pages through both extractors, with the same line segmenter: characters, lines, monotone *runs* in the extraction order (a column-correct read gives ~1 run per column; a reader alternating columns gives ~1 per line), and lines whose own characters are split by a wide horizontal gap (the same-baseline interleave):

| Page | pdfium: chars / lines / runs / wide | pdfminer: chars / lines / runs / wide |
| --- | --- | --- |
| 41 | 3,556 / 168 / **11** / 2 | 3,001 / 90 / **9** / 0 |
| 43 | 5,358 / 150 / **5** / 0 | 4,895 / 94 / **4** / 0 |
| 45 | 7,026 / 376 / **8** / 0 | 6,304 / 198 / **6** / 0 |
| 47 | 3,482 / 151 / **12** / 1 | 2,966 / 97 / **13** / 0 |
| 49 | 3,037 / 191 / **14** / 0 | 2,417 / 91 / **7** / 0 |
| 51 | 4,529 / 172 / **10** / 0 | 4,134 / 107 / **8** / 0 |

The finding is the one that decides D4: **the words are in the file and neither library hands us the order.** Runs of 5–14 where a correct read of a two-column page is 2–3, on both. pdfminer's own order is not better on these pages, its line count is roughly half pdfium's (it groups differently), its character count runs 85–93% of pdfium's, and on real books it writes `Cannot set stroke color: 2 components specified, but only 1 (grayscale), 3 (RGB), and 4 (CMYK) are supported` to stderr **per page** — in this architecture the sidecar's stderr is the app's log. Whatever lands must therefore own its column and reading-order pass, or hand the problem to a model (D4).

*Measurement revision, recorded because it changes a number:* the first pdfminer walker did not descend into `LTFigure`, which would have read as pdfminer dropping ~13% of the words. The corrected walker (`LTContainer` recursion) is in Annex A; the residual gap is a difference in counting whitespace-only boxes and grouping, not (as far as this probe can see) dropped words. The spike's comparison must be a **word-multiset diff against the page's own text**, not a character count.

### 5. Two columns are a minority of pages, and a real one

The correction in Annex B.1 raised the question the original probe could not answer: if the papers are not two-column, how common is a page that genuinely needs column order? Sampled the same way as §1 — 16 books holding a PDF and no EPUB, six pages each, bands detected by the projection profile slice 1 uses (Annex B):

| Result | Pages |
| --- | --- |
| Text pages sampled | **71** |
| …carrying more than one band | **13 (18%)** |
| …in a single band | 58 (82%) |

It is not spread evenly, and that is the useful part: the multi-band pages cluster in **designed reference works** — the *Rough Guides* travel books (4/4, 3/4, 2/6, 2/5 pages), a designed textbook, a cookbook — while ordinary prose books and every paper here are one band throughout. So the column pass is not the main event for a shelf of prose, and it is the whole event for the travel guides, the cookbooks and the textbooks, which are also the books where a wrong reading order is most visible.

### 6. What each tooling candidate weighs, installed

Measured by resolving each candidate's full closure and `HEAD`ing every wheel (Annex A). The sidecar's venv is built **on the user's machine, on first launch**, from a pinned `requirements.txt` (`docs/invariants/packaging-and-python.md`) — so this is a first-run cost, not only a disk cost.

| Candidate | Licence | Distributions | Download | Notable members |
| --- | --- | --- | --- | --- |
| `pypdfium2` — **already a dependency** | BSD / Apache | 0 new | 0 MB | char boxes, per-char font size, image objects, region renders |
| `pdfminer.six` | MIT | **3** | **10.2 MB** | layout analysis (`LAParams`), bbox + font + size per char, AES decryption |
| `pdfplumber` | MIT | 6 | 18.2 MB | pdfminer plus table detection |
| `docling` | MIT | **96** | **300 MB** | torch 121 MB, opencv 46 MB, rapidocr 26 MB, scipy 20 MB, transformers 12 MB, pandas 10 MB — **plus model weights fetched from HuggingFace on first use** |
| `PyMuPDF` | **AGPL-3.0** or commercial | — | — | **Excluded:** the repo is MIT and ships a DMG (`LICENSE`, `electron-builder.yml`); bundling an AGPL wheel relicenses the distributed app |
| Calibre `ebook-convert` / poppler `pdftohtml` | GPL, invoked as a subprocess, user-installed | 0 MB | 0 MB | mature extraction, but an **opaque artifact**: no source-page map, no confidence signal to gate on, and it re-adds the external binary the signed-off Calibre-free work is deleting |

Throughput, text only: `pypdfium2` chars **and** boxes 4 ms/page and 1–18 ms/page on the real books above; `pypdf.extract_text` 2 ms/page; `pdfminer.six` 14 ms/page on a synthetic and materially slower on real pages with many fonts. Speed is **not** the discriminator between the two permissive candidates; installation weight and whether the library hands over a reading order are.

## Design decisions

**D1 — The default view of a PDF is a reflowed EPUB; the original PDF is the escape hatch, and the trigger is "this book holds a PDF and no EPUB".** Rejected: pdf.js as the reading view (the 2026-07-14 spec's own C2). It renders the same fixed page at a different size — the unpleasantness being escaped — and on the phone it would need Readium's unwired PDF navigator, so it is the *expensive* option as well as the poorer one. Rejected: leaving PDFs to Preview (the status quo this feature exists to end). Rejected: the narrower trigger the Mac's own rule suggests ("no format `readableFormat` can open", 1,489 books) — it would skip the whole paper shelf, where a `mobi` beside the PDF makes the Mac happy and leaves the phone with a file it cannot render (§3). One rule, "no EPUB", is 1,534 books and is the same rule for both clients, because the EPUB is the only format both engines render.

**D2 — The reflow is produced once, by the Mac's sidecar, and cached on the NAS.** Not per client and not per open. The phone cannot convert (no local library, no heavy local work — iOS invariant 7), and two converters would produce two documents, which is two positions and two fidelities for one book. Rejected: converting on every open (measured cost below, paid on every read); a conversion service on the phone.

**D3 — The artifact lives outside the book-format namespace, in a `derived/` subfolder beside the book's files.** This is the rule the feature hangs on, and each hazard is an *existing* rule that keys on the extension alone:

| Existing rule | What a `{title}.epub` derivative in the book folder would do |
| --- | --- |
| `book-files.ts:36-38` (`renameToTitle`) | renames **any** `.epub` to `{title}.epub` — onto itself on a PDF-only book, onto the real book file on an EPUB+PDF one |
| `book-files.ts:73-79` (`computeFileSizeBytes`) | counts the derivative in `file_size_bytes` |
| `file-access.ts:37` (`formatFile`) | makes "Open PDF in Preview" open the **derivative** — the precise opposite of what the escape hatch means |
| `apple-books.ts:15` | exports the derivative to Apple Books |
| `bulk-hydrate.findHydratableFile` | re-fetches a PDF book's metadata from the derivative instead of the original |

The precedent that cuts the other way is deliberate and does **not** apply here: a Calibre-free converted AZW3 *is* added to `formats` and `file_size_bytes` (`transfer-queue.ts:111-115`) because it is a real ebook file another device reads. A reflow is a **derived, fallible rendering cache**: adding it to `formats` would make a PDF-only book claim an EPUB, change its format chip, change the phone's `preferredFormat`, offer the derivative to a Kindle, and pollute the `formats` facet counts.

So: `{book}/derived/reflow.epub` plus `{book}/derived/reflow.json` (the version stamp of D9 and the source-page map of D5). A directory name carries no extension, so every `readdir`-plus-`extname` rule above — including the two that delete by extension — skips it without a single change, and `fs.rm` of the folder takes it with the book. Rejected: a fixed-name `reflow.epub` beside the book (the rename rule rewrites it); a library-level `{root}/reflow/{uuid}/` cache (a second layout convention for per-book derived data while covers already live in the book folder).

**D4 — Extraction is our own column/reading-order pass over `pypdfium2`, with `pdfminer.six` admitted only where the spike proves it earns its keep; a layout model is the named escalation, not v1.** The probe (§4) is why this is not "use the library that does layout": no permissive library hands us a reading order, so a heuristic pipeline is ours to write either way, and the fastest primitives are already installed. Slice 1 measures our pass against pdfminer's on the corpus, page by page.

**Escalation condition, stated now so it is a reading and not a debate:** if the spike cannot reach the corpus gate with the heuristic pass, the choice is a layout model (`docling`'s 300 MB closure and first-use model download — a decision for the owner, with the numbers in §6) or shipping the feature as *fallback-only* for the books we cannot order. `PyMuPDF` is not on that list (AGPL). An external CLI is not either while the Calibre-free work is in flight (the tooling table in §6, last row).

**Whichever tool wins, the seam is fixed:** one module maps *PDF → blocks*, each block carrying its bbox, its source page, and a role (heading / paragraph / figure / caption). Numbers are not the difference between the candidates; reversibility is what keeps this decision cheap to revisit.

*Superseded 2026-10-08 by D4R.* The heuristic pass was built and failed the owner's reading on every corpus book (Annex C). The escalation condition above fired, and the escalation is D4R, not `docling`.

**D4R — Layout comes from Apple's Vision framework through a small Swift helper; the characters come from the PDF's own text layer; figures stay ours.** `RecognizeDocumentsRequest` (Vision, macOS 26) returns a page's paragraphs, title, lists and tables in reading order. A ~100-line Swift command-line helper renders each page, runs the request and prints the regions as JSON. The sidecar assigns every pdfium character to the region that contains it, so the words are the PDF's exact text and Vision's OCR transcript is never used where a text layer exists (measured: the OCR reads `suprior`, `valucs`, `MODEKR ASIKONOMY` on the corpus). Vision does not detect figures, so the ink-region figure detector stays in Python, fixed (Annex C.1).

Why this and not the alternatives, measured on 2026-10-08 (Annex C.3):

| | Vision helper (D4R) | Hardened heuristic pass (D4) | `docling` |
| --- | --- | --- | --- |
| Universe p.78 (two columns + sidebar) | column 1, then column 2, paragraphs whole | one band, lines interleaved | not run |
| Attention p.1 (rotated arXiv stamp, footnotes) | stamp isolated as two narrow strips, footnotes separate | stamp spliced into the abstract | not run |
| Cost in the DMG | **+84 KB** (the compiled spike) | 0 | 0 (sidecar ships as source) |
| Cost at first launch | 0 | 0 | +300 MB download plus model weights |
| Licence | OS framework | ours | MIT, 96 distributions |
| Speed | 0.5–1.3 s/page, unchanged by render scale | ~80 ms/page | not measured |

**Named costs, accepted by the owner on 2026-10-08:**

- **Platform floor.** `RecognizeDocumentsRequest` is macOS 26 and later. On an older macOS the helper reports `unsupported` and the book falls back with that reason (D6), the same non-fatal path as a textless book.
- **First-open time.** Roughly 5–10 minutes for a 535-page textbook at one page at a time. The helper processes pages concurrently, and the gate measures the result. D7's progress surface was already a requirement; this makes it load-bearing.
- **A new layer.** `helpers/musaeum-layout/` is Swift source built with `swiftc` from the Xcode toolchain. It is signed and shipped as an `extraResources` binary in slice 2, and the sidecar calls it as a subprocess the way the transfer path calls `ebook-convert`.

The seam above holds: the helper produces *regions*, and `sidecar/reflow/` still turns them into blocks that each carry their bbox, source page and role.

**D5 — Every block carries its source page, and the reflowed EPUB is the position of record.** The reflow's `position` is a CFI into the derived document and its `percent` is the portable currency — the existing schema, unchanged (`docs/invariants/reader.md` *Reading position*). The **original PDF gets no position in v1** (owner, 2026-10-07). The map is still written, because it is what makes a later "open the original at the page I was on" and a future pdf.js viewer possible without re-extracting anything, and because it is the only way to debug a reflow against the page it came from.

**D6 — Confidence, not optimism: a book whose reading order cannot be established falls back to the original, and the surface says why.** The gate is evaluated during the pass and is per **book**, not per page: a textless document (the 10% of §1), a document the parser cannot open, a layout whose regions cannot be ordered, or a genuinely fixed page (a comic, an art book). One rule with no per-file judgement: **no artifact, the original path, one line of reason.** This is invariant 12's posture applied to a new subsystem, and it is what lets a heuristic pass ship at all. `docs/invariants/files-and-deletion.md` gains the rule in slice 5.

*Named consequence, so nobody discovers it on the phone:* the fallback lands on the Mac's escape hatch (Preview) and on the phone as **a book the client still cannot open** — Readium there parses a PDF but nothing renders one until its separate PDF navigator is wired (`../musaeum-ios` backlog). For the ~10% image-only population that is the status quo of today's phone, unchanged by this feature and recorded as a gap rather than papered over.

**D7 — Conversion is on demand, cached, and the reader shows progress while the original stays reachable** (owner, 2026-10-07). The pass runs when a reflowable PDF is first opened, streams progress on the existing notification channel (`sidecar.ts:34`'s `onNotification`, the same mechanism migration progress uses), and is cached permanently. Rejected: a bulk job over 1,534 books that nobody has opened — the same lazy rule the AZW3 cache follows, and the same reasoning as that spec's D7. A 1,247-page scanned textbook is not the cost model: measured on *Universe* (535 pages) the raw extraction is ~18 ms/page and the added line/column/figure work is ours, so a first open is seconds for a typical trade book and minutes for a 700-page textbook — which is exactly why the progress surface is a requirement and not a nicety.

**D8 — The wire gains a reflow representation, additively — never a synthetic member of `formats`.** `formats` keeps meaning *the files this book holds*; a PDF-only book must not report an EPUB, or the phone's `preferredFormat` (`formats.first`) would lie and the Mac's chips and facets would follow it. The shape is a route the phone can already consume: `GET /api/books/{id}/file?format=reflow` answering `application/epub+zip`, and an additive book-payload member reporting availability and version (the pattern `cover` already uses for "does it exist, and what version"). The phone's rule becomes *one clause*: `reflow.available` → download `reflow` and save it locally as `{id}.epub` (the local name is the client's business — iOS invariant 2), else `formats.first` as today. The detailed field list belongs to `docs/rest-api.md` in slice 4, and **the contract lands in this repo first** (iOS invariant 1).

**D9 — Failure stays non-fatal and honest, and a stale artifact is never served.** Temp name, verify, rename into place; a failed pass leaves no residue, logs one line, and the book keeps the original path (invariant 12, and the Calibre-free spec's D5 in the same posture). `derived/reflow.json` records the source PDF's **size and mtime** and the **converter's version**, re-checked on open: a replaced PDF or a new converter version re-runs the pass instead of serving a stale rendering. A regenerated reflow invalidates a stored CFI — the existing percent fallback absorbs it, which is why `percent` is the member that travels.

**D10 — Nothing in the reader's shell changes.** Same `ReaderEngine`, same `musaeum://` route, same panels, same typography and theme resolution, same `reading_state` schema, same search-in-book and ask panel — because the artifact is an EPUB and the engine is already an EPUB engine. The TOC comes from the PDF outline where there is one (§1: 22 of 27) and from a font-size heading pass where there is not — which for this library's papers, three of six with no outline at all (§3), is the difference between a TOC and none. **This is the whole argument for the shape**, and it is also the acceptance test for it: if any part of the reader has to learn about PDFs, the design has gone wrong.

## Slices

| Slice | What | Files (budget) | Gate |
| --- | --- | --- | --- |
| **1 — the spike** | Our own layout pass (columns, lines, reading order, headings) over `pypdfium2` and a throwaway EPUB writer, run over the corpus; the same corpus through `pdfminer.six` for comparison; a probe script that reports word-multiset diff vs the page text, image order, heading detection and TOC per book | `sidecar/reflow/` (new, ≤4) + `scripts/pdf-reflow-probe.py` | **The corpus gate (D6/D4):** ≥5 of the 6 corpus books read end to end in the correct order — no interleaved columns, no dropped paragraphs, images interleaved where they belong — decided by an automated report **and** by the owner reading the six artifacts in the existing reader. The image-only book must produce **no artifact and the fallback**, which is a pass and never counted as a miss. Below the bar, D4's escalation, recorded in the annex |
| **1R — the spike, re-run (2026-10-08)** | Rebuild the gate so it can fail a book on order, figures and TOC, and confirm it fails the slice-1 artifacts. Fix the figure path (crop, plates, MIME). Rebuild the TOC from the whole outline with heading anchors. Replace the text pass with the D4R hybrid: the Swift helper's regions, filled with pdfium's characters | `helpers/musaeum-layout/` (new), `sidecar/reflow/*`, `scripts/pdf-reflow-probe.py`, `sidecar/tests/test_reflow_*.py` | **The corpus gate, rebuilt (Annex C.4):** every check passes on the five text books, and the image-only book still falls back. Then the owner reads the artifacts in the reader. Below the bar, stop and hand back. *(Outcome 2026-10-08: the rebuilt gate fails slice 1's artifacts at `dist/reflow-spike-slice1/` — 1/6, exit 1 — and passes 4 of 6 corpus books; the owner read `dist/reflow-spike/` and accepted that for this stage, both failures and the gate's own caveat recorded in Annex C.7 run 2.)* |
| **2 — the pipeline, production** | Promote to `reflow_pdf` behind the RPC with progress notifications, the `derived/` artifact and its version stamp, the confidence gate, temp-write-and-rename; fixtures and pytest per rule (a generated two-column page, an image-only one, an outline/no-outline pair, a page with no text layer inside a text book) | `sidecar/reflow/*`, `sidecar/main.py`, `sidecar/tests/*`, fixture generator (**≤7**) | pytest green; every corpus book's artifact byte-stable across two runs; no residue on an induced failure; the stamp re-runs on a touched source *(Outcome 2026-10-08: landed as `4140b3e` — the row's files plus the probe, `docs/data-contracts.md` and `tasks.md`; pytest 388 passed. The corpus through the production pass (`scripts/pdf-reflow-probe.py --production`, exit 0): 5/5 text books byte-stable across two runs, 5/5 cached, 5/5 re-ran for a touched source, 5/5 wrote only `derived/`, and the gate reading exactly run 2's per-book result — `4/6` — because the artifact's content rules were deliberately frozen. Two measured caveats: a pass occasionally refuses a book it laid out minutes earlier (three of six runs, each healed by a retry, D6's posture), and `helpers/bin` still ships in no bundle, which is slice 3's first step.)* |
| **3 — the Mac reader** | `derived/reflow.epub` served over `musaeum://book/{id}/reflow` (`book-bytes.ts`'s allowlist, noted in `tasks.md` as the one that fails as a missing feature); the on-demand trigger and cache check; the progress surface and the fallback-with-reason; the readability rule that lets a PDF-only book with a reflow open in-app | `services/reflow.ts` (new), `book-bytes.ts`+test, `ipc/reader.ts` or `ipc/files.ts`, preload + `window.Musaeum` types, `reader.store.ts`+test, `ReaderView.tsx`, `book.types.ts` (**≈8, crossing `electron/main` ⇄ `src` — the brief makes that a hand-back: flagged here so approval happens at sign-off**) | typecheck / lint / `npm test` green; opening a PDF-only book on the real library: progress, then a reflowed book with a working TOC; an image-only book falls back with one line; the original still opens in Preview from the same rows |
| **4 — the wire, then the phone** | `docs/rest-api.md` + `services/api/shape.ts` + `api/rest.ts` + the payload goldens + `scripts/api-smoke.sh`; then the iOS slice: ask for `reflow` when available, save it as `{id}.epub`, open it through the existing `EPUBNavigatorViewController`, report the fraction | Mac: docs + 3 files + goldens + smoke script. iOS: `ContractModels.swift`, `BookDetailScreen.swift`, `MusaeumClient.swift`, `DownloadStore.swift` + tests (**≤5**) | smoke green with the new member; on the phone, a PDF-only book downloads, opens, turns pages and reports a position the Mac's row accepts — **with no engine change** (D10) |
| **5 — the record** | `CLAUDE.md` (the C2 line; the invariant index if a line is added), `docs/invariants/reader.md` (the reflow, the fallback rule), `docs/invariants/files-and-deletion.md` (`derived/` is not a format), `docs/invariants/nas-and-catalog.md` (the folder diagram), `docs/architecture.md` (the sidecar tree), `docs/comparison.md` (the reader row), `tasks.md` in both repos, `CHANGELOG.md` | docs only | — |

## Acceptance criteria

- **AC1** — The corpus gate is run and recorded (automated report + the owner's reading, per book) **before** any pipeline code is promoted, and the annex names the layout approach that passed.
- **AC2** — A reflowed book's `book.formats` and `file_size_bytes` are **byte-identical** to before the pass, and no `metadata.json` gains a member (checked against the live database and the file, not asserted).
- **AC3** — Each of D3's extension-keyed hazards has a decider, not a hope: `renameToTitle` leaves `derived/` untouched, `computeFileSizeBytes` does not count it, `formatFile` and `apple-books.ts` resolve the **original** PDF, and `findHydratableFile` still reads the PDF. (`renameToTitle` and `computeFileSizeBytes` are `book-files.test.ts` cases; the escape hatches are `file-access.test.ts` and an Apple Books check; the last is a `bulk-hydrate` case.)
- **AC4** — A book the pass cannot order confidently produces **no artifact**, opens the original, and shows one line saying why (D6); a textless book is not a blank page.
- **AC5** — An induced failure mid-pass leaves no file at `derived/reflow.epub` and no `.tmp` residue; a source PDF whose size or mtime moved re-runs the pass rather than serving the old rendering (D9).
- **AC6** — While a reflow is being produced the reader shows progress and the original is reachable from the same surface (D7), and a second open of the same book does not start a second pass.
- **AC7** — Reading state behaves exactly as it does for an EPUB: percent travels to the Mac row and to the phone, `read_status` advances by the documented rule, and a regenerated artifact degrades a dead CFI to percent with no new code path (D5/D9).
- **AC8** — The phone reads a PDF-only book end to end with **no change to `ReaderHost.swift` or the navigator construction** (D10), and the position it reports is accepted by the Mac's existing `PUT /api/books/{id}/reading`.
- **AC9** — No new dependency ships unless the spike's verdict authorises it; if `pdfminer.six` is taken, the first-launch install grows by ≤10 MB, and no candidate citing AGPL appears anywhere in `requirements.txt`. *Amended 2026-10-08 (D4R):* `requirements.txt` gains nothing. The layout helper adds ≤1 MB to the DMG, and on macOS older than 26 its absence or refusal is a fallback reason, never a crash.
- **AC10** — The sidecar's stderr is clean during a pass on the corpus (no per-page library chatter in the app's log), or the noise is explicitly suppressed in the pipeline module.

## Risks, named

1. **Reading order is the whole feature, and the probe says the libraries do not provide it.** Measured: on a two-column textbook, 5–14 runs against the 2–3 a correct read needs, with 6 of 20 pages carrying a line that spans both columns (§4); on a two-column *paper*, medians of 1–9 runs with 1–8 pages of 8–12 interleaved (§3). Mitigated by the spike being slice 1, by the gate being a reading rather than a metric, and by D4's escalation carrying its own numbers. This is the risk that decides the feature.
2. **~10% of PDF-only books are image-only and stay unreadable in-app** (3/30 in the sample, wide interval, cross-checked with a second extractor). OCR is out of v1 and the phone renders no PDF at all, so for those books the phone is no better off than today. Revived by wanting one of them on the phone, which is the iOS PDF-navigator item.
3. **`derived/` is a new namespace convention held up by extension-keyed rules.** It is invisible today because a directory has no extension; a future walk that sweeps folders "for all files" must be taught. Mitigated by stating the rule in `docs/invariants/files-and-deletion.md` in the same slice that ships the reader path.
4. **A big book's first open is slow** — seconds for a trade book, minutes for a 1,247-page textbook, paid once. Mitigated by progress (D7) and the cache; not hidden.
5. **Fidelity is judged by reading, and the corpus is five books.** A book outside it may read badly. Mitigated by the confidence gate (D6) and by the escape hatch staying one gesture away — the failure mode is "this one opened in Preview", not "this one is unreadable".
6. **A regenerated artifact is a different document.** A converter-version change re-paginates the reflow, so stored CFIs die and only the fraction survives. Named rather than solved: per-field positions are already an open item in the portable-decisions design, and this adds one more reason to want them.
7. **The phone's gap on fallback books is a product decision, and it is now made.** D6 lets a book fall back; the phone has nowhere to fall back *to*. **Accepted for v1 by the owner on 2026-10-07** (Open question 4) — recorded here so the next person finds a decision rather than a hole.
8. **173 books are outside this feature's reach entirely and are the phone's other gap.** They hold `mobi`/`azw3` and neither an EPUB nor a PDF, so there is nothing to reflow and nothing the phone can render. Named because the headline number in *Why now* ("the phone can read 1,534 more books") could otherwise read as "the phone's gap is closed": it is 90% of it, and the residue is a format the client has no branch for at all.

## Deliberately not needed

No OCR. No change to the `metadata.json` shape, `book.formats`, or the SQLite schema. No bulk conversion job. No position for the original PDF, and no pdf.js in the Mac's shell as part of the default path (D9 leaves the door open as a refinement of the *original's* view). No annotations or highlights — still waiting on the storage decision they always were. No new top-level directory in the library root.

## Open questions for review

All five were answered by the owner on 2026-10-07; the record is kept here rather than deleted, because the corpus and the two boundary approvals are the conditions the later slices run under. Items 7–9 were raised by slice 1R's review on 2026-10-08 and are pending: each is about a rule of the gate's own, not about the pipeline, which is why the slice stopped rather than repairing them.

1. **The corpus — answered, and changed.** Chosen by measured content rather than by title or size, and the paper case was added at the owner's request ("a lot of the types of pdfs I'd expect to read on my phone"): **(1)** *Universe: Solar Systems, Stars and Galaxies* — two-column body plus captions and sidebars, 256 outline entries: the layout stress; **(2)** *Attention is All You Need* — the paper, the owner's own case, 15 pages, 22 outline entries (measured as a **PDF**; the book itself holds an `epub`, so the app would open that instead — it is the layout benchmark, not a reflow candidate); **(3)** *Sequence to Sequence Learning with Neural Networks* — a paper genuinely in the reflow set, 9 pages, **no outline**, and the worst interleave of the six (5 of 8 pages); **(4)** *Politics, Philosophy, Culture* — plain single-column academic prose, the easy case that must not regress; **(5)** *Modernist Cuisine, Vol 1* — designed and caption-heavy, 355 outline entries, where figures in the right order is the test; **(6)** *The Complete Guide to Asterix* — image-only, where the fallback must fire.
2. **The `derived/` folder name** — and whether the heading/TOC pass belongs in slice 2. Open: the name is provisional, and the pass is **in** slice 2, because three of the library's six papers carry no outline (§3) and a paper with no TOC is a paper you cannot navigate.
3. **D8's wire shape** — drafted above, decided in `docs/rest-api.md` in slice 4. Unchanged by the answers here.
4. **The phone's gap for fallback books** — **accepted for v1** (owner, 2026-10-07): a book the reflow refuses stays unreadable on the phone, as it is today, until Readium's PDF navigator is wired. Risk 7 keeps it visible.
5. **Boundaries** — **approved by the owner 2026-10-07**: slice 3 crosses `electron/main` ⇄ `src` (≈8 files) and slice 4 crosses into `../musaeum-ios`, which must be attached to the thread before it can be edited.
6. **Add the GRU paper to the corpus?** — *Learning Phrase Representations using RNN Encoder–Decoder* is the shelf's clean two-column page (2 bands on 6 of 9 pages, 12–16pt gutters) and the six-book corpus turned out to have no genuinely two-column book in it at all, because the metric that chose *Universe* for that role was wrong (Annex B.1). Recommended: add it as a seventh book before slice 2, so the hardest reading the gate claims to make is a real one. **Awaiting the owner.**

7. **May the gate lean on the pipeline's own record for a pass?** Read by `scripts/pdf-reflow-probe.py --out`, the six artifacts score 4/6; read by the same gate's `--gate-only` — the mode run 1's validity claim rests on — they score 1/6, because G2 and G6 exclude the regions read from Vision, the figure labels inside written crops and the dropped furniture, and none of those facts exists outside the pipeline's own report. Annex C.4 requires them *counted* and the probe prints the numbers, so the exclusions are the spec's design, not a mistake — the question is whether they are acceptable evidence for a pass. *Universe* and *Modernist Cuisine* both rest on them: read raw their G6 is 6.36% and 4.47%, against the 3% the check allows. Recommended: keep the exclusions (the pipeline genuinely reads those words from Vision, and charging them twice would be wrong), report the excluded-word share per book as a number the reader can judge, and derive from the PDF everything the PDF can settle — G4's plate half already does. **Awaiting the owner.**

8. **Is *Universe*'s G3 failure the book, the pipeline or the check?** Measured: five of the seven flags are not sideways text at all. The check clusters *every* upright character on a page by baseline, so a sidebar quotation whose baselines sit 6.6pt from the body's is read interleaved (`When they shall cry "PEACE, PEACE" meteoroids. Some of them collide…`, p.262) and a token it cannot witness upright counts as rotated-only — while the pass reads that same page region-scoped and correctly. One flag (`pane`) is the book's own text layer drawing two runs over each other, which no reader of that layer can fix. Recommended: repair the witness — read lines region-scoped, which is what C.4's own reasoning assumes — and leave the pipeline alone. **Awaiting the owner.**

9. **What is G5's bar on a book whose outline entries have no heading?** *Politics, Philosophy, Culture* fails at 21 of 31; six of its misses are entries no artifact could satisfy, because its five part dividers are single plates with no text layer, so 25 of 31 (81%) is that book's ceiling. *Universe* fails at 222 of 255 (87%), but five of its misses are truncated chapter titles and two are section-number landings — both pipeline defects, and repairing only those reaches 229 of 255 (89.8%), still under the 90% share. Recommended: repair the truncated titles and the landings first, since those are real defects the reader would see, and re-measure before deciding whether the share or the outline is what must change. **Awaiting the owner.**

---

## Annex A — the corpus probe (measured 2026-10-07)

Environment: macOS, Python 3.12.8, `pypdfium2` 5.14.0, `pdfminer.six` 20260107, `pypdf` 6.19.0, `docling` 2.135.0 (resolution only — never installed). Library at `/Volumes/books/musaeum` (mounted), database at `~/Library/Application Support/Musaeum/musaeum.db` (read-only).

**Populations, read off the database:** 6,731 books; 1,714 rows hold a PDF; **1,534 hold a PDF and no EPUB** (the reflow set this design commits to); of those, 1,489 hold nothing the Mac can open (`formats == ["pdf"]`, which is exactly the set with no epub, azw3 or mobi on this library — the two queries were run against each other) and 45 hold a Kindle format beside the PDF; **1,707 books have no EPUB at all**, so 173 of them (mobi/azw3-only, no PDF) are outside this feature's reach (Risk 8).

**Text-layer scan** — 30 randomly sampled books from the 1,534 that hold a PDF and no EPUB (`random.seed(20261007)`; the 45 Kindle-format ones inside it are included, on purpose, since §3 is about them), pages `min(10, n)`, `n//2`, `max(0, n-60)`, characters counted with `PdfTextPage.count_chars()` and image objects with `page.get_objects()`:

| Book | MB | Pages | Chars on the three pages | Verdict |
| --- | --- | --- | --- | --- |
| Essential Mobile Interaction Design | 9.3 | 303 | 979 / 1,626 / 2,004 | text |
| The Investopedia Guide to Wall Speak | 4.4 | 353 | 1,985 / 1,809 / 1,813 | text |
| Birth of Biopolitics | 1.1 | 365 | 2,163 / 2,603 / 4,355 | text |
| The Gulag Archipelago, Vol 2 | 33.9 | 717 | 203 / 2,479 / 1,893 | text |
| The Rough Guide to The Bahamas | 17.4 | 372 | 1,984 / 3,645 / 3,950 | text |
| The Rough Guides Directions Athens | 7.5 | 201 | 21 / 1,714 / 1,469 | text |
| Uberpreneurs | 1.0 | 339 | 1,852 / 1,991 / 1,867 | text |
| The Rough Guide Directions Orlando | 20.4 | 196 | 59 / 1,044 / 2,165 | text |
| The Writer's World — Sentences and Paragraphs | 17.3 | 480 | 3,794 / 2,207 / 2,223 | text |
| A Byte of Python | 2.6 | 177 | 1,786 / 1,824 / 1,472 | text |
| Government of Self & Others | 2.8 | 421 | 34 / 2,604 / 2,711 | text |
| **The Complete Guide to Asterix** | 25.7 | 104 | 0 / 0 / 0 | **image-only** |
| Politics, Philosophy, Culture | 5.4 | 355 | 2,579 / 2,392 / 1,673 | text |
| The Rough Guide Directions Dublin | 5.1 | 240 | 1,651 / 2,961 / 2,354 | text |
| **Cabinets and Countertops** | 99.6 | 161 | 0 / 0 / 0 | **image-only** |
| **Calculus — A Complete Course, 7th Ed** | 95.5 | 1,077 | 0 / 0 / 0 | **image-only** |
| Outlines of the Philosophy of Right | 2.2 | 421 | 2,547 / 2,652 / 2,468 | text |
| 42 Rules for Your New Leadership Role | 3.1 | 136 | 1,182 / 2,782 / 2,651 | text |
| Search Patterns | 14.8 | 193 | 1,129 / 586 / 1,022 | text |
| Dynamics of Galaxies | 17.1 | 474 | 2,164 / 3,540 / 4,115 | text |
| UX for Lean Startups | 6.7 | 236 | 1,236 / 2,563 / 902 | text |
| Coding Interviews | 5.4 | 293 | 3,121 / 2,016 / 2,302 | text |
| Recommender Systems and the Social Web | 3.8 | 118 | 3,179 / 3,808 / 3,325 | text |
| Decide | 4.3 | 312 | 1,846 / 1,969 / 2,041 | text |
| Designing Brand Identity | 18.2 | 321 | 2,344 / 1,166 / 964 | text |
| Cheese and Microbes | 19.6 | 346 | 0 / 4,363 / 4,250 | text |
| How to Find Business Information | 1.9 | 218 | 2,428 / 1,857 / 35 | text |
| Trading for Dummies | 4.9 | 387 | 4,184 / 2,046 / 1,697 | text |
| **Efficient Estimation of Word Representations in Vector Space** | 0.2 | 12 | 2,862 / 3,217 / 3,591 | text (see the revision note) |
| Killer UX Design | 56.2 | 289 | 2,673 / 997 / 1,594 | text |

**Tally:** 27 text, 3 image-only, 0 unopenable. Of the 27 text books: 27 reached ≥1,000 chars on some page; 22 carried a PDF outline. The three image-only verdicts were confirmed with a second extractor (`pypdf.extract_text` on the same pages: 0 characters each).

*Revision note — this table's first version was wrong, and the way it was wrong is the reason it is recorded:* the word2vec paper was reported as `PdfiumError`, i.e. unopenable. The page picker computed `npages - 60` with no clamp, so for that 12-page book it asked for page **−48**, and my scan's blanket `except` recorded a *probe* error as a *document* error. Re-measured with the clamp: 12 pages, 2,862 / 3,217 / 3,591 characters on those same three pages, a 19-entry outline, and no call on any page raising (page / size / textpage / count_chars / get_charbox / get_objects all tried individually). **There is no unopenable book in this sample**, which is why D6's parser clause is written as defensive rather than as an observed case — and why a pipeline that dies on one odd page would be a defect this probe would not have caught.

**The five hard-case books**, pages 41–60 sampled (20 pages each):

| Book | MB | Pages | Outline | Text pages | Median chars | Median lines | Pages with wide-gap lines | Images |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Molecular Cell Biology, 7th Ed | 708.2 | 1,247 | 7 | 0 | 0 | 0 | 0 | 20 pages, 20 objects |
| Understanding Human Communication, 11th Ed | 371.5 | 516 | 14 | 0 | 0 | 0 | 0 | 20 pages, 20 objects |
| The Complete Far Side, Vol 1 | 625.1 | 673 | 0 | 0 | 0 | 0 | 0 | 20 pages, 20 objects |
| Universe: Solar Systems, Stars and Galaxies | 304.8 | 535 | 256 | 20 | 4,166 | 186 | 6 | 19 pages, 66 objects |
| Modernist Cuisine, Vol 1 | 299.4 | 355 | 355 | 19 | 4,423 | 236 | 9 | 20 pages, 20 objects |

Sampling cost: 0.2–1.5 ms/page on the three textless books (pdfium finds no text to walk) and 12–18 ms/page on the two text books because of the per-character `get_charbox` work this probe does.

**The paper shelf** (all of it: six books, pages 2–13 sampled — the whole of every paper but the front matter), and the row that changed a decision:

| Paper | Formats | MB | Pages | Outline | Text pages | 2-col pages | Median chars | Median lines | Median runs | Pages with wide-gap lines | Images |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attention is All You Need | mobi, epub, pdf | 2.1 | 15 | 22 | 12 | 12 | 3,295 | 197 | 1 | 5 | 3 |
| Sequence to Sequence Learning with Neural Networks | mobi, pdf | 0.1 | 9 | 0 | 8 | 8 | 4,044 | 163 | 3 | 5 | 0 |
| Learning Phrase Representations… (GRU) | mobi, pdf | 0.6 | 11 | 0 | 10 | 10 | 4,535 | 319 | 4 | 4 | 6 |
| Scaling Transformer to 1M Tokens (RMT) | mobi, pdf | 0.7 | 9 | 13 | 8 | 8 | 3,728 | 195 | 9 | 1 | 6 |
| Transformers Meet Directed Graphs | mobi, pdf | 2.7 | 29 | 0 | 12 | 12 | 5,317 | 372 | 7 | 1 | 4 |
| Efficient Estimation of Word Representations (word2vec) | mobi, pdf | 0.2 | 12 | 19 | 11 | 11 | 3,539 | 131 | 1 | 8 | 0 |

Note the shape of the evidence: **median runs of 1 with 5–8 pages whose lines span both columns** (*Attention*, word2vec) and **median runs of 3–9 with 1–5 such pages** (the rest). A run count alone would call the first two clean and be wrong — the same-baseline interleave is invisible to a vertical-run metric, which is exactly why the probe counts both. Sampling cost: 6.6–20.3 ms/page, the whole shelf in well under a second per book.

*Correction, 2026-10-07 (Annex B.1):* both columns of this table are a **proxy that over-counts columns**. `cols >= 2` clustered *line-left edges* at a 6% threshold, which counts an indented caption, a table's rows and a figure's label as a second column; and `wide` fires on a table row whose cells are separated by gaps. Gutter detection (Annex B) finds **one band** on 13 of 13 sampled *Attention* pages, on 24 of 24 *Transformers Meet Directed Graphs* pages, and on 10 of 10 word2vec pages. The corrected picture: five of six papers are **single column**, the GRU paper is two-column on 6 of 9 pages, and *Universe* — the "two-column textbook" of §2 and §4 — is **one band on all 24 sampled pages**. The runs numbers are real; the *name* put on the layout was not.

**The negative result, and the reason it is recorded:** pdfium does *not* fail on this shelf — word2vec, the file the first scan called unopenable, reads 11 of 11 pages in a second pass (see the revision note above). No book in this entire probe defeated a parser; the D6 parser clause stays as insurance against a corrupt file in the wild, not as a case this data supports.

**Reading order, *Universe*, pages 41/43/45/47/49/51** — pdfium's char order versus pdfminer's layout-analysis order, both segmented by the same rule and both counting a *run* as a monotone downward passage (a correct read of a page in regions needs 2–3 runs per page):

| Page | pdfium chars | lines | runs | wide | pdfminer chars | lines | runs | wide |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 41 | 3,556 | 168 | 11 | 2 | 3,001 | 90 | 9 | 0 |
| 43 | 5,358 | 150 | 5 | 0 | 4,895 | 94 | 4 | 0 |
| 45 | 7,026 | 376 | 8 | 0 | 6,304 | 198 | 6 | 0 |
| 47 | 3,482 | 151 | 12 | 1 | 2,966 | 97 | 13 | 0 |
| 49 | 3,037 | 191 | 14 | 0 | 2,417 | 91 | 7 | 0 |
| 51 | 4,529 | 172 | 10 | 0 | 4,134 | 107 | 8 | 0 |

Line-start clusters per page on this book: 7–9 (pdfium), 3–7 (pdfminer) — a page of two columns *plus* captions, sidebars and callouts. Neither extraction is a reading order.

*Revision note:* the first comparison walker collected only `LTTextContainer` descendants, which excludes text inside `LTFigure` — the numbers above are from the corrected walker (`LTContainer` recursion). The character gap that remains (85–93%) is grouping and whitespace-box handling; the spike's decider is a word-multiset diff, not this count.

**Dependency weights** (`pip install --dry-run --report`, then a `HEAD` per distribution URL for `content-length`):

| Candidate | Distributions | Download total | Largest members |
| --- | --- | --- | --- |
| `pdfminer.six` | 3 | 10.2 MB | pdfminer.six 6.3, cryptography 3.7, cffi 0.2 |
| `pdfplumber` | 6 | 18.2 MB | + pillow 4.6, pypdfium2 3.4 (already present) |
| `docling` | **96** | **300 MB** | torch 121, opencv 46, rapidocr 26, scipy 20, transformers 12, pandas 10, docling-parse 9, lxml 8, sympy 6, numpy 5 |

`docling` also downloads model weights from HuggingFace at first use (not measured; not installed). `PyMuPDF` was not resolved — its AGPL licence excludes it before weight matters.

**Throughput**, generated 30-page single-column PDF (~2,700 chars/page): `pypdfium2` chars **and** boxes 108 ms total (4 ms/page); `pypdf.extract_text` 62 ms (2 ms/page); `pdfminer.six.extract_pages` 424 ms (14 ms/page).

The generator and the three probe scripts (`probe.py`, `compare2.py`, `scan.py`) are throwaway measurement code under `/tmp/reflowprobe`; slice 1 replaces them with `scripts/pdf-reflow-probe.py`, which must re-derive every number above rather than quote it.

**Two minors recorded, not fixed:** pdfminer writes `Cannot set stroke color: 2 components specified…` to stderr **per affected page** on the real books (AC10 covers suppressing it if pdfminer is taken), and a probe's page picker can fail a whole document's verdict on one odd index — the correction above is the worked example, and slice 1's probe must clamp and must name the call that failed rather than the file.

---

## Annex B — slice 1's log: the spike, built and measured 2026-10-07

> **Withdrawn 2026-10-08 (Annex C).** The "automated half passed" claim below rests on a gate that checked only that the XML parses, and a word-multiset diff that cannot see order. B.1's correction — that *Universe* and five of six papers are single-column — was produced by the same broken band detector it was meant to validate. Vision reads *Universe* p.78 as two columns. Kept as the record of what was tried.

**What exists.** `sidecar/reflow/` — `layout.py` (characters → lines → bands → reading order → paragraphs, headings, figures, confidence), `outline.py` (sections from the PDF outline, or from the headings), `epub.py` (a deterministic EPUB 3 writer, one XHTML file per section, page anchors, figures) — plus `scripts/pdf-reflow-probe.py`, which runs the six-book corpus and prints the table below. **Nothing is wired into the sidecar's RPC and no library file or row was touched**; every artifact lands in `dist/reflow-spike/` (gitignored). Re-derive everything with:

```bash
sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --out dist/reflow-spike
```

### The gate's first half — the automated report

| Book | Verdict | Schema problems | Sections | Figures | Words lost | Words extra | Artifact | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| *Universe* (535 pp) | ok | **0** | 146 | 159 | 10% | 5% | 56.1 MB | 44 s |
| *Attention is All You Need* (15 pp) | ok | **0** | 9 | 1 | 6% | 19% | 35 KB | 0.4 s |
| *Sequence to Sequence Learning* (9 pp) | ok | **0** | 5 | 0 | 5% | 4% | 18 KB | 0.3 s |
| *Politics, Philosophy, Culture* (355 pp) | ok | **0** | 25 | 0 | 1% | 3% | 296 KB | 9.5 s |
| *Modernist Cuisine, Vol 1* (355 pp) | ok | **0** | 177 | 87 | 5% | 3% | 12.8 MB | 28 s |
| *The Complete Guide to Asterix* (104 pp) | **no_text_layer** | — | — | — | — | — | **none, as D6 requires** | 0.0 s |

**5 of 6 produced a clean artifact**, and the sixth is the image-only book falling back with a reason — which the design counts as a pass and never as a miss, so the automated half of the corpus gate is met. Every artifact also passes `unzip -t`, carries `mimetype` first and uncompressed, and parses as XHTML, OPF and NCX under `ElementTree` with every manifest href present in the zip.

**What "words lost" is, and is not.** It is a multiset difference between the artifact's tokens and pdfium's own page text, so it says nothing about order — that is what the owner's reading is for. Its two largest sources are *by design and reported separately*: the running heads the pass drops on purpose (Universe 0, *Attention* 14, *Sequence to Sequence* 9, *Modernist Cuisine* 180 — mostly bare page numbers, all inside the top or bottom band), and the synthetic spaces the pass inserts where a PDF stores no space character, which splits a token (`<pad>` → `<`, `pad`, `>`) and so shows as one loss and two gains. Figure labels swallowed into a crop count as losses too. Nothing in the table suggests text going missing from a page's prose, and the largest single offender — 10% on *Universe* — is a 1,247-page-capable textbook whose pages are half figure.

### B.1 The correction the spike forced: the paper shelf is not two-column

Annex A's §3 and its paper table said "every sampled page of every paper is two-column" from a metric that clustered *line-left edges* at a 6% threshold. Re-measured with the projection profile the pass actually uses — bins covered by characters, a gutter being a gap of at least 2% of the text width — while sampling pages 3–26 of each book:

| Book | Pages sampled | Bands per page | Gutters found |
| --- | --- | --- | --- |
| *Attention is All You Need* | 13 | **1 band on all 13** | — |
| *Sequence to Sequence Learning* | 7 | **1 on all 7** | — |
| *Scaling Transformer to 1M Tokens* | 7 | **1 on all 7** | — |
| *Transformers Meet Directed Graphs* | 24 | **1 on all 24** | — |
| *Efficient Estimation of Word Representations* | 10 | **1 on all 10** | — |
| *Learning Phrase Representations* (GRU) | 9 | 1 on 3, **2 on 6** | 12–16pt |
| *Universe* (the "two-column textbook") | 24 | **1 on all 24** | — |
| *Modernist Cuisine, Vol 1* | 20 | 1 on 11, 2 on 8, 3 on 1 | 12–26pt |

The metric that produced the original claim counted an indented caption, a table's rows and a figure's label as columns; the same metric also fired on *table rows whose cells are separated by gaps*, which is what the `wide` column in Annex A's reading-order table was measuring. **Five of the six papers are single-column, *Universe* is single-column, and the shelf's genuinely two-column members are the GRU paper and parts of *Modernist Cuisine*.** §3, §4 and Annex A now carry this correction in place; §5 carries the prevalence measurement it prompted (13 of 71 sampled pages, 18%, concentrated in designed reference works).

### B.2 Bugs the corpus found, each with the measurement that found it

This is the list the spike exists to produce. Each was invisible until a real book was run through the whole path:

| Bug | What it did | Found by |
| --- | --- | --- |
| The gutter was judged against the page, not the text (3% of 612pt = 18.4pt) | merged every two-column page into one band; *Attention* "reflowed" as a single column | the band check above |
| Coverage was built from *line* extents | the same, from the other side: two columns on one baseline are one line by construction, so the profile was uniformly solid and no gutter could be found | the same |
| A band was "solid" when more than one character covered a bin | with character coverage a normal bin holds exactly one, so nothing was solid and the page collapsed to one band | the same |
| The single-band path returned lines with **no text** | 56% of *Sequence to Sequence* silently vanished | the per-page word comparison |
| Repeated-text detection normalised digits, and every numeric block is `#` | 442 real blocks on *Universe* were deleted as "running heads" — the page-level rule (top/bottom band, ≤80 chars, not a bare number) is what stops it | *Universe* missing 3,421 instances of `the` |
| A bordered table's ink is one region | 186 lines swallowed by a table's bounding box: page 7 of *Sequence to Sequence* lost 59% of its text | the same comparison, per page |
| A figure region is not always a figure | the fix above, applied the other way, would have kept a chart's axis labels in the prose — 21,472 single-letter tokens in *Universe*'s flow | the token histogram |
| `page.render(scale=…, crop=…)` per region, lossless | *Universe*'s artifact was **116 MB** against a 305 MB source | artifact size |
| pdfium returns **U+FFFE** for a glyph with no Unicode mapping — in this library, the hyphen at a line break | two bugs at once: every artifact failed XML parsing (U+FFFE is not a legal XML character) and words were left split (`excel␞lent`, `unavail␞able`, `under␞stood`) | the schema check and the missing-token list |
| Outline labels are sometimes the printer's marks | *Modernist Cuisine*'s 240 top-level entries were `cover1`, `cover2`, … and "use the outline" produced a TOC of cover numbers | its section list |
| Heading levels were ranked largest-first | the *rarest* heading size became level 1, so hand-picked "sections" were nearly empty: *Modernist Cuisine* produced **one** section from 1,383 headings | section count |
| A wrapped line's fragment looks like a heading | a paper's sections were named `ships.`, `SMT [29].`, `and 0.08` | its TOC |

### B.3 What is left, named rather than smoothed over

1. **The second half of the gate is a reading, and it is the owner's.** The artifacts are in `dist/reflow-spike/`; five are readable files and the sixth is the fallback. Nothing here substitutes for opening them.
2. **The corpus's real two-column case is not in the corpus.** *Universe* was chosen as the layout stress and turned out single-column; the GRU paper is the clean two-column page (6 of 9) and is not among the six. **Recommended: add it** as a seventh book, which costs one command and makes the gate's hardest reading real rather than assumed.
3. **Table structure is absent** (a documented limit, not a surprise): a table's rows survive as paragraphs, its cells do not, and a table's *rules* are why the figure detector needs its text-coverage test at all.
4. **Headings are noisy on a designed page.** *Modernist Cuisine* yields 715 "headings", many of them design labels rather than titles, and its 177 sections are more TOC than a reader wants. Fine cannot be fixed by tuning alone; slice 2 should cap sections per page-range and require a heading to open a page or follow a gap.
5. **Artifact size scales with figures**, not with text: 56 MB for a 535-page figure-heavy textbook. Slice 2 should decide a per-book budget (and consider downscaling plates further) rather than leaving it unbounded.
6. **Two-column pages inside a *table-like* region** are neither split nor cropped — they keep their words in pdfium's order. The GRU paper's 2-band pages are split correctly, but a table with column text is not, and nothing measures that yet.
7. **The probe's own measures are proxies.** Runs, bands and word multisets are how this annex argues; the artifact is the artifact, and only a reader decides.

---

## Annex C — the review of slice 1, and the plan it forced (2026-10-08)

The owner opened the five artifacts in the reader and reported no images, garbled and interleaved text, and a broken TOC. Each defect below was reproduced against the source PDFs on `/Volumes/books/musaeum` before a cause was named.

### C.1 Defects, with the cause and the measurement

| Defect | Cause | Measured |
| --- | --- | --- |
| Figures missing | `_crop` passes the figure's box as `render(crop=…)`, which pypdfium2 reads as *margins to cut off*. Most crops raise `ValueError: Crop exceeds page dimensions`, and a bare `except` returns `None` | Universe 29 of 44 sampled figures raised; Modernist 34 of 41; Attention Figures 1 and 2 detected, then lost |
| Slivers instead of figures (7×406, 12×1008) | the crops that did not raise rendered the wrong region of the page | the image dimensions in the artifacts |
| A failed figure also loses its labels | lines inside a figure region are dropped whether or not the crop succeeded | `extract_page`, the swallow loop |
| Photo plates gone | a page under 50 characters returns before figure extraction runs | Modernist: 6 of 6 sampled text-less pages carried image objects |
| Large figures gone | an ink region over 80% of the page is discarded as "background" | `FIGURE_MAX_PAGE` |
| Text mask offset on some books | the char-to-cell mapping ignores the page origin, while the figure box adds it | Universe's page box is [33, 33, 681, 816] |
| JPEG served as PNG | every image is named `.png` and declared `image/png`, whatever the encoder wrote | about two-thirds of the images are JPEG bytes |
| Columns interleaved | one projection profile over the whole page; any element spanning the gutter fills it, and the 1-pt gaps left are merged back | Universe p.78: one band found on a two-column page |
| arXiv stamp in the abstract | rotated characters are never removed; the band rule only stops them forming a column | Attention p.1: 37 rotated characters, all in the flow |
| Body lines as headings, real headings missed | heading size is the median *glyph-box* height, not the font size; weight is ignored | Attention "2 Background" is 12pt / weight 700 against 10pt / 425 body |
| Every line its own paragraph | lines grouped against the previous character only, plus a paragraph break on every band change | Universe p.78: 13 baselines split into several rough lines |
| Footnotes merged into prose | no footnote detection, and paragraph joins ignore a size change | Attention p.1 |
| TOC entries lost | one entry per page, first wins | Attention: 10 of 19 depth-0/1 entries dropped, including "3 Model Architecture"; Universe: 93 |
| TOC thinned | an outline over 240 entries is decimated by even sampling | Modernist: 355 → 240 |
| TOC links land mid-chapter | entries link to a file's start; a section starts at its page's top when its heading was not detected | Attention's "3.3" file opens with the end of 3.2.2 |

### C.2 Why the gate passed

`scripts/pdf-reflow-probe.py` passed a book when the verdict was `ok` and its XML parsed. The word check is a multiset difference, blind to order, and it had no threshold: Universe was missing 41,068 words (about 10%) and passed. Nothing counted figures written against figures detected, nothing checked an image's bytes against its media type, and nothing compared the TOC with the outline.

### C.3 The Vision spike (2026-10-08)

`/tmp/vision-spike/main.swift`, 60 lines: PDFKit renders a page, `RecognizeDocumentsRequest` runs on it, and the paragraphs print in order with their normalised boxes. Compiled with `swiftc -O`: an 84 KB binary. macOS 26.7.1, Swift 6.4, SDK 27.0.

| Page | What Vision returned | What slice 1 produced |
| --- | --- | --- |
| Attention p.1 | the stamp as two strips at x=0.02, w=0.03; the abstract in order; "1 Introduction" alone; three footnotes separate | stamp letters spliced into the abstract; footnotes merged into the Introduction |
| Attention p.3 | Figure 1's labels as 26 small regions, then the caption, then "3.1 Encoder and Decoder Stacks" | caption only, no figure |
| Universe p.78 | 11 regions at x=0.13, then 9 at x=0.52; headings and footnote separate; the running footer isolated at y=0.08 | alternating lines from both columns |
| Modernist p.200 | the table detected as a table | rows as paragraphs |
| Modernist p.120 | nothing (a photo plate) | nothing — and no image either |

Speed is 0.5–1.3 s per page, the same at render scales 1.0, 1.5 and 2.5. Region boundaries at 1.5 match 2.5, so 1.5 is the default. The OCR text is not usable as the book's words: `suprior`, `seguence`, `valucs`, `amod = 512`, `HE UKIGIN OF MODEKR ASIKONOMY`.

### C.4 The rebuilt gate

Each check is computed by `scripts/pdf-reflow-probe.py` from the source PDF and the artifact, independently of the pipeline's own bookkeeping. **The gate is valid only if it fails the slice-1 artifacts** (commit `dabc549`), and that run is recorded first.

| # | Check | Pass |
| --- | --- | --- |
| G1 | **Golden passages.** Each text book has ≥3 passages of ≥8 words, read off the page by a person, at least one of them crossing a line break on a multi-region page. Whitespace and line-break hyphens normalised | every passage appears contiguously in the spine text |
| G2 | **Segment trigram recall** (regions read from Vision excluded, and counted). A *segment* is a run of pdfium characters on one baseline with no gap wider than the line's median character height, so a segment never crosses a gutter. Trigrams of words inside segments, read with C.5 item 3's space rule — a stored space is a boundary only at a gap of at least 0.1× the size | ≥95% found contiguous in the artifact's token sequence |
| G3 | **No rotated text in the flow.** Tokens built only from characters whose `FPDFText_GetCharAngle` is non-zero | none in the spine text |
| G4 | **Figures.** Written equals detected; no image under 32 px on its short side; each image's magic bytes match its extension and manifest media type; every text-less page of a text book that carries ink appears as a full-page image | all four |
| G5 | **TOC.** Nav entries equal the outline's usable entries at every depth, nested to match; every `href` fragment resolves to an element | entries equal, and ≥90% land on a heading whose text matches the entry |
| G6 | **Words.** Multiset loss over regions read from the text layer, after removing the dropped page furniture and the figure labels inside written crops (each reported separately) . The source's words are read with C.5 item 3's space rule too, so its repair of a stored space inside a word is not loss (measured on *Universe* pp.1–60: **10.6% raw against 5.9%** with the rule) | ≤3% |
| G7 | **Package.** The existing checks: `mimetype` first and stored, every document parses, every manifest `href` exists | clean |
| G8 | **Fallback.** The image-only book | no artifact, and a reason |

### C.5 The hybrid, specified

1. **The helper.** `musaeum-layout <pdf> [--pages a-b] [--concurrency n] [--scale s]` (defaults: all pages, 8, 1.5) writes JSON lines. The first line is `{"helper":"musaeum-layout","version":1,"supported":bool,"pages":n}`; `supported` is false below macOS 26, and the process then exits 0. Each later line is one page, in page order: `{"page":n,"box":[x0,y0,x1,y1],"rotation":deg,"ms":t,"regions":[…],"tables":[…]}` or `{"page":n,"error":"…"}`. `box` is the crop box. Every bbox is `[x0,y0,x1,y1]` in PDF user space with a bottom-left origin, the space pdfium's character boxes use (measured: 5,512 of 5,650 characters on *Universe* p.78 fall inside a region, the rest being figure labels). A region is `{"kind":"paragraph","order":i,"bbox":…,"text":…}`. Vision also reports a table's cells as paragraphs, so a table is reported twice: as paragraphs, and as `{"bbox":…,"cells":[{"row","col","rowspan","colspan","bbox","text"}]}`. The sidecar keeps the table and drops the paragraphs inside it. Pages run concurrently: 20 *Universe* pages take 29.0 s at concurrency 1, 11.0 s at 4 and 8.5 s at 8. One failing page is one error line, never a dead process.
2. **Characters.** Rotated characters are dropped (G3). Each other character goes to the smallest region that contains its centre, with 1pt of padding. A character outside every region joins the nearest region within 6pt, or is counted as an orphan.
3. **Lines and text, inside a region.** Characters are clustered by baseline (tolerance: half the character height) and sorted by centre x, not left edge. A space character is kept only when the glyphs either side of it are at least 0.1× the font size apart. *Universe*'s text layer stores `fi ghting` with a real space whose box lies inside the ligature's: a 0.4pt gap against ~2.5pt for a word space, and the cause of `artifi cial` in slice 1. A synthetic space is added only where a gap exceeds half the character height: the slice-1 threshold, measured against letter-spaced e-mail addresses. Words broken at a line end are rejoined; U+FFFE becomes a hyphen first, as before. A region whose first line shares a baseline with the previous region's last line, and starts to its right, continues that region's paragraph: Vision splits *Attention*'s abstract into five line-fragment regions.
3a. **Which text a region uses.** The text layer is not always the better source. *Modernist Cuisine*'s sidebars carry a scanner's OCR layer (`scit•ntific disci␞plint• .111d .tn irlll'r`). Per region, the PDF's text is compared with Vision's transcript (alphanumerics only, `SequenceMatcher` ratio). The PDF's text is used unless the ratio is below 0.9 and the PDF text's junk score is at least 0.1 above Vision's, or the PDF has no upright characters there — and a region the PDF's only characters *under* which are rotated is dropped rather than read, because that is a stamp or a sideways figure credit and Vision reads it as upright words (G3). Measured 2026-10-08 on *Universe* p.352: Vision returns a wide credit strip **and** the smaller box that takes its 352 rotated characters, so the strip has none of its own and its words came from the OCR — `dean`, `hines`, `nrao` and `alabama` in the flow that way. The junk score is the share of tokens, edge punctuation stripped, that hold a character outside letters, digits and common punctuation, or punctuation between two letters. Measured on 2026-10-08: math such as `(x1, ..., xn)` scores 0 on both sides, so the PDF wins over Vision's `(21,...,Xn)`; *Modernist Cuisine*'s sidebar scores 0.23 against Vision's 0.00, so Vision wins; *Universe*'s copyright footer has a ratio of 0.24 with both scores 0, so the PDF wins over Vision's `Carriga 3111 Congee`. Regions read from Vision are counted per book.
4. **Roles.** The body size is the character-weighted mode of the size a glyph is really drawn at across the document: `FPDFText_GetFontSize` **scaled by the text matrix's scale factor** (`FPDFText_GetMatrix`). The `Tf` operand alone is 1.0 for every glyph of a book whose producer writes `Tf 1` and puts the size in the text matrix — measured 2026-10-08: 5,650 of 5,650 glyphs on *Universe* p.78, and the same on *Modernist Cuisine* — which left the body at 1.0pt and made **both** size tests unreachable: 0 footnotes, and 1,449 headings all from the single-bold-line branch, `■ Figure 1-3`, `Wavelength (nm)`, `rs` and `KK` among them. With the matrix that page reads 10.5 body / 8.5 / 11.0 / 5.0, and where a producer reports real sizes the matrix is the identity (*Attention*, *Sequence to Sequence* and *Politics* all measure 1.00), so nothing there moves. The same 1.0 defeated item 3's space rule as well — 0.1× 1.0pt is 0.1pt — which kept *Universe*'s `fi ghting` and failed G1. A region is a heading when it has at most 120 characters and either its median size is ≥1.15× body or it is a single line at weight ≥600 over a body below 600; a heading **larger than the body may wrap**, up to four lines, and the single-line test is what the body's own size gets. The two-line cap was written for the body-size case and broke the wrapped one: *Universe*'s `14-2 Making Stars from the Interstellar Medium` is 13pt bold over **three** lines against a 10.5pt body, and 24 of that book's 60 G5 misses were a section head that carried its outline entry's own text while being classified a paragraph. Heading levels follow the outline's depth for headings an outline entry matched, and size rank otherwise (at most three levels). A region whose median size is ≤0.85× body and which sits in the bottom quarter of the page is a footnote (`class="footnote"`). When a page's last **body-sized** paragraph ends without terminal punctuation, a next page that opens in lower case is joined to it, and otherwise the note-sized blocks behind that paragraph move to just after the next page's first paragraph — so a sentence crossing a page break is never read with the notes in its middle (*Attention*'s Introduction, pages 1–2; golden passage G1 #3). *Body-sized* is load-bearing: *Attention* p.1 ends with its NIPS venue line, 9.0pt against a 10.0pt body **and ending in a full stop**, so taking the page's last paragraph literally meant the join never fired at all and the notes stayed inside the first sentence.
5. **Page furniture.** A region inside the top or bottom 8% of the page, at most 80 characters long, whose digit-normalised text repeats on ≥25% of text pages, or which is a bare number. Dropped and counted.
6. **Figures.** `_figure_regions`, with its text mask taken from Vision's regions and the page origin applied on both axes. A region covering more than 80% of the page is kept as a figure only when under 10% of it is text: a full-bleed photo, not a tinted background. A crop is rendered with margins computed from the page box, as JPEG above 6% of the page and PNG below, with the file name and media type taken from the encoding. **A crop under 32px on its short side is not a figure and is not written** (G4 allows none): a faint band a few points tall that straddles a 12pt analysis cell makes two cells ink, so the region measures 24pt and reaches the crop — *Universe* pp.501/504/512, whose 864x27 and 1008x13 crops are that band. The crop is the only place that can tell: at analysis scale the same band reads 16pt tall against the 27px the render actually trims to, so the two renders disagree and the decision has to be made on the crop. The region is recorded as a sliver, counted as *not detected*, and its text stays in the flow, which is what item 6 already asks of a crop that failed. A figure takes its place in reading order before the first region that lies below it and overlaps it horizontally, or after the page's last region. Vision regions and characters inside a figure are dropped **only when the crop succeeded**. A failed crop is logged with its page and box.
7. **Plates.** A page with fewer than 50 characters and any ink becomes one full-page image, long side ≤1,400 px.
8. **Tables.** Vision's cells become an XHTML `<table>`, with each cell's text taken from the characters in its bbox.
9. **Sections and TOC.** Every usable outline entry at every depth, junk labels still filtered (`cover4`, `ix`, `end1`, `viii`), and no per-page dedupe and no decimation. A Roman folio is a folio however many letters it has, and `end1` is the same kind of printer's mark as `cover4`. Measured 2026-10-08: *Modernist Cuisine*'s outline is 355 page labels (`cover1`–`cover11`, `viii`–`xiii`, the folios `2`–`335`, `end1`–`end4`), and the filter kept exactly the seven carrying three or more letters, making its TOC `viii, xii, xiii, end1…` with **0 of 7** landing on a matching heading (G5). Filtering the folios and the `end` family leaves 0 usable entries, which is this item's own fallback: the level-1 and level-2 headings make the TOC. Files split at depth-0 entries. Each nav entry links to the id of the heading that matches its title on its page or the next one; failing that, the region nearest the destination's y; failing that, `#pg{n}`. The nav nests by depth. With no outline, level-1 and level-2 headings make the TOC.
10. **Version.** `reflow.json`'s converter version records the helper's version beside the sidecar's, so a new helper re-runs the pass (D9).

### C.6 What did not change

D1–D3 and D5–D10 stand. OCR stays out of v1: Vision would make it cheap, but an image-only book is mostly comics and plates, where a reflow is the wrong rendering. That is a separate decision for later, not part of this pivot.

### C.7 The gate's runs

**Run 1 — the slice-1 artifacts, kept at `dist/reflow-spike-slice1/` (2026-10-08).** `scripts/pdf-reflow-probe.py --gate-only dist/reflow-spike-slice1`. The gate is valid only if this fails, and it did:

| Book | G1 | G2 | G3 | G4 | G5 | G6 | G7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Universe: Solar Systems, Stars, and Galaxies | 3 of 3 passages | 87.0% recall | rotated text in the flow: alabama, dean, fred… | 46 failures, first p0006-0.png bytes jpeg, extension png | 146 entries for 255; 0% on headings | 8.9% of words lost | pass |
| Attention is All You Need | 2 of 3 passages | pass | pass | pass | 9 entries for 22; 0% on headings | pass | pass |
| Sequence to Sequence Learning with Neural Networks | pass | 93.3% recall | pass | pass | 0 of 5 land on a matching heading | 4.5% of words lost | pass |
| Politics, Philosophy, Culture | pass | pass | pass | 0 plates written, 8 text-less pages carry ink | 25 entries for 31; 0% on headings | pass | pass |
| Modernist Cuisine: Volume 1: History & Fundamentals | 3 of 3 passages | 92.7% recall | pass | 69 failures, first p0022-4.png bytes jpeg, extension png | 177 entries for 7; 0% on headings | 6.1% of words lost | pass |
| The Complete Guide to Asterix | G8 pass — no artifact | — | — | — | — | — | — |

The run printed `gate: 1/6 books pass` and exited 1: every text book failed, and the only pass is the image-only book, whose correct outcome is no artifact (D6).


**Run 2 — slice 1R (2026-10-08).** `scripts/pdf-reflow-probe.py --out dist/reflow-spike`, layout helper v1, macOS 26.7.1. **It does not reach 6/6: four of the six books pass.** The two that do not are named below with the measurement behind each, because a run that cannot pass its own gate is the result, not a footnote to one.

| Book | Pages | Time | ms/page | TOC entries | Figures | Plates | Regions from Vision | G1–G7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Universe: Solar Systems, Stars, and Galaxies | 535 | 222.0 s | 415 | 255 | 635 | 1 | 381 on 194 pages | **G3** 7 rotated words (the gate prints the first 6); **G5** 222 of 255 (87%) |
| Attention is All You Need | 15 | 4.8 s | 320 | 22 | 14 | 0 | 11 on 4 pages | pass |
| Sequence to Sequence Learning with Neural Networks | 9 | 3.3 s | 367 | 8 | 7 | 0 | 1 on 1 page | pass |
| Politics, Philosophy, Culture | 355 | 57.9 s | 163 | 31 | 2 | 8 | 2 on 2 pages | **G5** 21 of 31 (68%) |
| Modernist Cuisine: Volume 1: History & Fundamentals | 355 | 116.0 s | 327 | 2 | 311 | 61 | 390 on 79 pages | pass |
| The Complete Guide to Asterix | 104 | 1.8 s | 17 | 0 | 0 | 0 | — | G8 pass — no artifact (no page carries a text layer) |

The run printed `gate: 4/6 books pass` and exited 1. Nothing reached stderr but the probe's six progress lines (AC10), and every page laid out (0 layout errors in all six books). The two checks that carry the book's words pass with room: *Universe*'s segment trigram recall is **97.50%** of 129,518 trigrams (G2 needs 95%) and its word loss **1.68%** (G6 allows 3%, top of the loss `editorial` 64, `tion` 61, `ing` 49), and G1's three golden passages pass on all five text books.

**What the two failures are, measured.**

- ***Universe*, G3 — six words.** `alabama`, `dean`, `hines`, `pane`, `propulsion`, `researchers`. Not one of them is sideways text: `dean`, `hines` and `propulsion` are the *Egg Nebula* figure credit, which the pass reads correctly from the page's own upright characters on p.352 (`Rodger Thompson, Marcia Rieke, Glenn Schneider, Dean Hines …`), but that page's text layer draws each run **twice** at the same spot, so the gate's line reading can only spell `SDaehaani` and a token it cannot witness upright counts as rotated-only. Five of the seven are the gate's own witness rather than the pipeline: the gate clusters *every* upright character on a page by baseline, so a sidebar quotation whose baselines sit 6.6pt from the body's is read interleaved (`When they shall cry "PEACE, PEACE" meteoroids. Some of them collide…` on p.262), while the pass reads that page region-scoped and correctly. `pane` and `researchers` sit inside blocks the same doubling garbles — `the other l t i th i fE th b li Th pane s us ng e s ze o ar as a ase ne` — where the *artifact* is garbled too: a text-layer defect of the book, not a rotated reading. Closing this means changing the check's witness or its token rule, which is an owner decision rather than a pipeline fix.
- ***Universe* and *Politics, Philosophy, Culture*, G5 — 33 and 10 entries.** Three measured kinds: entries the book has no heading for (*Universe*'s and *Attention*'s `Introduction` entries, ×19 on *Universe* and ×1 on *Attention*, re-counted in review — those printed pages open with an epigraph, and nothing is headed Introduction); a destination page with **no text layer at all** (*Politics*' five part dividers: `Self-Portraits`, `Theories of the Political`, `The Politics of Contemporary Life`, `The Ethics of Sexuality`, `The Politics of Sexuality` — each is one plate, so 25 of that book's 31 entries is the ceiling and 81% is the most the check can ever see, a sixth entry (*Notes on the Power of Culture*, p.330) landing on a figure as well); and a wrapped chapter title whose second line an oversized figure crop swallowed (`A User's` / `Guide to the Sky`, with `Atoms`, `The Outer`, `The Family` and `Astrobiology:` the same way, plus two section-number landings) — a pipeline defect, not a limit of the check. The letter-spaced titles this record first blamed in fact land as hits. The wrapped-heading repair below moved *Universe* from 76% to 87%, measured by running its parent with the same gate code.

**Bugs the corpus found, each with the measurement that found it.** Every one was repaired against a failing test in the module that owns it; seven of the eight amended a spec rule — six in Annex C.5 and one in C.4 (the gate's own reading of the source's words) — each with the same measurement; the eighth is the crash fix, which moved no rule.

| # | Defect | Cause | Measurement |
| --- | --- | --- | --- |
| 1 | `stitch_pages` raised `IndexError` on *Universe* — no artifact for a 535-page book | the join deletes the continuation paragraph, and the loop kept a pre-join snapshot of the pages that had one | page 290's last paragraph is the Cengage footer (no terminal punctuation) and page 291 holds exactly one paragraph, which starts in lower case; `layout.py:385` in the corpus run, and a 3-page synthetic PDF |
| 2 | every size in *Universe* and *Modernist Cuisine* was 1.0pt | `FPDFText_GetFontSize` is the `Tf` operand alone, and both books write `Tf 1` with the real size in the text matrix | 5,650 of 5,650 glyphs on p.78; 0 footnotes on both books and *Universe*'s 1,449 headings all from the single-bold-line branch (`■ Figure 1-3`, `Wavelength (nm)`, `KK`); with the matrix that page reads 10.5 / 8.5 / 11.0 / 5.0 |
| 3 | the gate read the source's words raw, so the spec's own space repair counted as loss | G2 and G6 joined a baseline's stored characters with no geometry | *Universe* pp.1–60: **10.6% loss raw against 5.9%** with item 3's rule (the review's own setups, which differ in the exclusions they apply, gave 5.0%/2.0% with none and 3.27%/0.87% with the probe's); whole book with the probe's exclusions **6.36% → 1.68%**, the pair that carries *Universe* and *Modernist Cuisine* past G6; segment `soldier fi ghting for` |
| 4 | a paragraph crossing a page break was read with 15 notes inside it | the join took the page's last *paragraph*, and *Attention* p.1 ends with its NIPS venue line at 9.0pt — and a full stop | *Attention* p.1: last block `31st Conference on NIPS …` at 9.0pt against a 10.0pt body; golden passage G1 #3 |
| 5 | *Modernist Cuisine*'s whole TOC was seven page labels | the junk filter drops a label with no run of three letters, so `ix` went and `viii`, `xii`, `xiii` and `end1`–`end4` stayed | its outline is 355 page labels (`cover1`–`cover11`, `viii`–`xiii`, `2`–`335`, `end1`–`end4`); G5 measured **0 of 7** on a matching heading |
| 6 | three crops under 32px were written | a faint band that straddles a 12pt analysis cell makes two cells ink, so the region measures 24pt and the crop trims it to 13px | G4: `p0501-543.png 864x27`, `p0504-545.png` and `p0512-562.png 1008x13`; the same band reads 16pt at analysis scale and 27px in the render (p.501) |
| 7 | rotated figure credits reached the flow as upright words | Vision returns a wide credit strip *and* the smaller box that takes its rotated characters, so the strip has none of its own and its text came from the OCR | G3 on *Universe* p.352: `dean`, `hines`, `nrao`, `fred` |
| 8 | a section heading that wraps to three lines was a paragraph | the heading rule capped **every** heading at two lines, and *Universe*'s section heads are 13pt bold against a 10.5pt body | 24 of *Universe*'s 60 G5 misses were a section head carrying its outline entry's own text (`14-2 Making Stars from the Interstellar Medium`); G5 76% → 87% |

**Named, not smoothed over.** A second run of this same command on the same day produced *Modernist Cuisine* with **62 layout errors** against 0 in the recorded run: 62 of its 355 pages came back from the helper as `{"error": …}`, and each such page reads as a single region, which moved that book's figures 311 → 333 and its words 167,780 → 162,790. Every error is counted, D6 tolerates them up to 25%, and the book passes the gate either way — but the run is only reproducible while the NAS answers every page, and a reader would see 62 degraded pages. **The gate also cannot see** two things this run measured: the **68,303 orphan characters** on *Universe* (1,478 of them on p.295, the prose of a lower right column Vision never boxed) that item 2 drops by design and G6 then charges — under the 3% it allows, but not zero — and a page whose text layer draws two runs over each other, where the artifact and the gate are both garbled and neither is more right than the other.

**What the pass verdict does not cover (measured by the Task 9 review).** The same six artifacts, read by `--gate-only` — the mode run 1 used, which has no pipeline record to draw exclusions from — score `gate: 1/6 books pass`: *Attention*'s G6 3.3%, *Sequence to Sequence*'s 5.5%, *Modernist Cuisine*'s 3.3%, *Universe*'s G2 94.5% with G6 10.6%, and *Politics*' G5 21 of 31. Annex C.4 requires G2 to exclude the regions read from Vision *and count them*, and G6 to remove the dropped furniture and the figure labels inside written crops, each reported separately; those facts are only knowable from the pipeline's own record, and the strict mode has none — so on a D4R artifact its loss figure is a pessimistic upper bound rather than an independent verdict. The owner's decision is whether that provenance is acceptable evidence for a pass: two of the four passes (*Universe* and *Modernist Cuisine*) rest on it, since read raw *Universe*'s G6 is 6.36% and *Modernist*'s 4.47%, both above the 3% the check allows. *Modernist Cuisine*'s G5 pass carries no TOC evidence either — after the junk-label repair its usable outline is 0 entries, so the check's expectation is `None` and its heading-share test is skipped, and the artifact's TOC is 2 entries for a 355-page book (`MODERNIST`, `CUISINE`). The gate also cannot judge what the owner's reading must: heading levels on designed pages, figure placement, the Vision-read pages, and the 1,421 `h3`s *Universe* carries, whose sample includes junk (`APRIL`, `Sa`).
