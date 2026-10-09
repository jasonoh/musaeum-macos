# Design: Calibre-free Kindle conversion — an in-house EPUB → AZW3 writer (kindle transfer, v1)

**Date:** 2026-10-02
**Status:** Signed off 2026-10-06 (D1 run: the Oasis does not take a native EPUB). **Nothing built yet.** Slice 1 is a spike with a hard pass/fail gate on the owner's device; slices 2–4 are scheduled only if it passes.
**Scope:** Replace the one place Musaeum runs a Calibre binary — `ebook-convert`, EPUB → AZW3 on a Kindle send — with a writer inside the Python sidecar, then remove the Calibre detection, the Settings field and the error path that exist only to serve it. It deliberately does **not** touch the Calibre *migration* wizard (that reads `metadata.db` as plain SQLite and needs no Calibre install), the PDF rule (PDFs are never converted), the presence rule, the cover-cache writer, the database schema or the `metadata.json` shape.
**Depends on:** `docs/superpowers/specs/2026-09-17-device-presence-design.md` (the MOBI header layout, with the offsets derived) and `docs/superpowers/specs/2026-09-26-device-covers-design.md` (the device keys its cover cache on two fields *inside the file* — a converted file must carry them).
**Interacts with:** `transfer-queue.ts`'s convert branch (the only caller), `services/sidecar.ts` (detection), `services/settings.ts` + `ipc/settings.ts` + `SettingsModal.tsx` (the `ebook_convert_path` field).
**Reverses:** the *Resolved Decisions* entry in `CLAUDE.md` — *"Calibre CLI: require user installation; path detected, configurable, clear error when missing (no bundling)"* — and the Stack row *"Format Conversion | Calibre CLI (ebook-convert)"*. Both are amended in slice 4, **after** the gate passes, never before.

---

## Why now

The product premise is a library manager that is free of Calibre. The conversion call is the one place it still isn't, and it is not a vestige.

- **One call site.** `transfer-queue.ts:96-115`: when a book has no azw3/mobi in its folder but has an EPUB, the queue calls the sidecar's `convert_format`, which shells out to `ebook-convert` (`sidecar/conversion/converter.py`) and caches the AZW3 on the NAS. Nothing else in the app runs a Calibre binary.
- **It is a live path.** Measured against the live database 2026-10-02: **2,232 of 6,725 books are EPUB-only** (no azw3, mobi or pdf) and 69 more hold only EPUB + PDF — about **2,300 books cannot reach the Kindle without a conversion step**. 2,935 already hold an azw3 or mobi, and 1,489 are PDF-only and never convert.
- **The Kindle will not take the EPUB.** The owner's device is a **Kindle Oasis, firmware 5.18.2**, permanently in airplane mode. Amazon's 2022 "EPUB support" is the Send to Kindle *service* converting server-side, which needs a network the device never has; the one source found on the Oasis 3 on this firmware reports no native EPUB support, and a third-party mod exists for it, which implies the same. **Unconfirmed on the device** — see D1, which makes the confirmation a free first step. `device_history` holds 141 logged transfers (2 with errors); the eight most recent are all azw3 — the full format breakdown was not read.
- **A second, smaller finding:** `migration.ts:151` passes `ebook_convert_path` to the sidecar's `migrate_library`, and nothing in `sidecar/pipeline` or `sidecar/main.py` reads it for that method — a dead parameter that makes the migration look like it depends on Calibre when it does not. Removed in slice 3.

**The thesis in one paragraph.** A Kindle-ready file is a container format, not magic: a PalmDB of records holding a MOBI/KF8 header, an EXTH metadata block, the book's markup, its images and a handful of index tables. The sidecar already parses EPUB (`extractors/epub_metadata.py`, `lxml`), already has `Pillow` for image repair, and the app already *reads* this exact header layout in TypeScript (`mobi-header.ts`) and builds real MOBI bytes in tests (`test/helpers/mobi.ts`). So the writer is one new module behind the existing `convert_format` RPC: same arguments in, same `{output_path, size_bytes}` out, no new dependency, no schema change, and nothing in the transfer queue's flow moves except which function it calls.

## Provenance rule — a constraint on how this is built, not a footnote

Musaeum is MIT-licensed. Calibre's writer and KindleUnpack are GPL. A writer that tracks either one's code structure closely — even rewritten line by line — invites a derivative-work argument against the licence. This is not legal advice; it is a rule chosen so the question never arises.

1. **Allowed sources:** the MobileRead wiki's MOBI/KF8 format pages; the device-presence spec's appendix and our own parsers (`mobi-header.ts`); and **the bytes of real files** — the library holds ~2,900 azw3/mobi files that open on the owner's Oasis, and reading a file's header, record table and index structure is observing a format, not reading source.
2. **Not read while building:** Calibre's writer source, KindleUnpack's source, and any other GPL implementation of this format. Their *output* and *behaviour* are fair game; their code is not an input.
3. **Provenance log:** the annex (slice 1's, then slice 2's) records for each structure the writer emits *which* allowed source it came from — a wiki section, or a measured file and offset. A structure with no entry does not ship.
4. **Calibre as a test oracle only, and only until it is uninstalled.** Running the installed `ebook-convert` to turn our AZW3 *back* into an EPUB and diffing the text is using a tool, not copying code. It is a one-time validation step in slice 1/2, never a dependency of `npm test` or `pytest`.

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| The only call into Calibre, and the format preference around it | `electron/main/services/transfer-queue.ts:80-115` (`KINDLE_FORMAT_PREFERENCE`, convert branch, cache + `updateBook`) |
| The wrapper to be replaced | `sidecar/conversion/converter.py` (`convert_format`, 300 s timeout), `sidecar/main.py:18,95` |
| Calibre detection and the configurable path | `electron/main/services/sidecar.ts:207-217` (`STANDARD_EBOOK_CONVERT`, `ebookConvertPath`), `services/settings.ts:97,124,188,302`, `ipc/settings.ts:11`, `SettingsModal.tsx:576`, `src/types/settings.types.ts:40` |
| The dead parameter | `electron/main/services/migration.ts:151`; `sidecar/main.py:98` is `convert_format`'s only reader |
| MOBI/EXTH header offsets already proven against 1,555 real files | `electron/main/services/mobi-header.ts`, `test/helpers/mobi.ts` (fixtures built as real bytes, never mocked) |
| The two fields the device keys its cover cache on — a converted file must carry both | EXTH 113 (uuid) and EXTH 501 (cdetype, `EBOK` on every real file measured), `docs/invariants/device-transfer.md:15` |
| EPUB parsing, HTML cleanup | `sidecar/extractors/epub_metadata.py`, `extractors/html_text.py`; `lxml`, `Pillow`, `beautifulsoup4` already in `sidecar/requirements.txt` |
| Test seams | `transfer-queue.test.ts:26,106,172-219` (mocks `ebookConvertPath`), `settings.test.ts:186,221`, `sidecar/tests/` |

## Design decisions

**D1 — Confirm native EPUB first; assume it fails.** Copy one `.epub` into the Oasis's `documents/` folder and see whether the library lists it. Five minutes, no code. If it opens, conversion is unnecessary and this design collapses to *delete the call* (slice 3 only). If not — expected — the writer is needed, and D2–D6 apply.

**D2 — The writer lives in the sidecar, as one module behind the existing RPC.** `sidecar/conversion/` gains the KF8 writer (a package, one file per concern: container/records, EXTH, markup chunking, index tables — each small enough to hold in context). `convert_format(input_path, output_path)` keeps its return shape; the `ebook_convert_path` argument is dropped. Python, because the fixed stack says so, `lxml` and `Pillow` are already there, and the format work is byte-level `struct` and `zlib` from the standard library. **No new dependency.** A Go or Rust helper binary (e.g. `kindle-cli`'s azw3 package over `leotaku/mobi`) was considered and not chosen: it adds a language, a build and a bundled binary to a stack the brief calls fixed, for a small project whose quality and licence this design did not vet. It stays the fallback if the gate fails (D6).

**D3 — The output must carry what the app reads back.** Every file written has: the **title and author in the header** (presence matches on them — `device-presence-design.md`), **EXTH 113 with a fresh uuid per output file** (the cover cache entry belongs to the file, not the book — *Red Rising*'s azw3 and mobi carry different uuids), **EXTH 501 = `EBOK`**, the embedded cover as the file's own cover record, and a working table of contents. A converted file that the app's own `readEmbeddedIdentity` cannot read is a failed conversion: the writer's last step re-reads its output with the same offsets the TypeScript side uses (via a fixture-compatible check in pytest), so a writer that drifts from the reader fails a test, not a Kindle.

**D4 — Fidelity target is "reads like the source," not "matches Calibre's output."** Prose, headings, images, internal links and footnote jumps, the cover, and the TOC survive. CSS is passed through where KF8 accepts it and dropped where it does not; a feature the writer cannot honour is a **warning returned with the result**, never a failed conversion and never silence (invariant 12). Fixed-layout EPUBs, EPUB 3 media overlays and embedded fonts are out of scope for v1 and convert as best-effort reflowable.

**D5 — Failure stays non-fatal and honest.** A conversion that cannot produce a valid file raises with a specific reason into the existing `error` path (`device_history` row, UI toast), exactly as today's `ebook-convert failed` does. No half-written file is ever left on the NAS: write to a temp name in the book folder, verify (D3), then rename into place.

**D6 — The gate, and what a failure means.** Slice 1 passes only if all three spike books **open on the Oasis, show their cover, jump to chapters from the TOC, follow an internal link, and keep a reading position across closing the book.** A pass authorises slices 2–4. A fail does **not** mean "bundle Calibre": it means reassess between wrapping an existing open-source writer (D2's fallback) and keeping Calibre as an *optional* converter the app uses when present — a decision for the owner at that point, recorded in the annex.

**D7 — Cached conversions stay as they are.** The 2,935 azw3/mobi files already in book folders are untouched; the writer only runs for books that have none. No batch pre-conversion of the backlog (owner decision, 2026-10-02): conversion stays lazy, on first send, cached permanently on the NAS as today.

## Slices

| Slice | What | Files (budget) | Gate |
| --- | --- | --- | --- |
| **1 — the spike** | D1's EPUB test, then a throwaway writer for three EPUBs (plain prose; images + footnotes; a deep TOC) and a probe script; annex records provenance per structure and the device result | `sidecar/conversion/` (new, ≤4), probe script, annex | D6 — on the device, all five readings, per book |
| **2 — the writer, production** | Promote the spike to the real writer behind `convert_format`; real fixtures (small hand-built EPUBs), pytest cases per structure, the D3 round-trip check; Calibre-as-oracle validation run once and logged | `sidecar/conversion/*`, `sidecar/main.py`, `sidecar/tests/` (≤7) | pytest green; D3 round-trip on every fixture; the oracle diff clean on the corpus sample |
| **3 — remove the dependency** | `transfer-queue` stops resolving a path and drops the "Calibre not found" error; delete `ebookConvertPath` detection, the Settings key/field/validation, the type, and the dead `migrate_library` parameter; update the tests that mock them | `transfer-queue.ts`+test, `sidecar.ts`, `settings.ts`+test, `ipc/settings.ts`, `SettingsModal.tsx`, `settings.types.ts`, `migration.ts` (**9 — under the 10-file bound, across `electron/main` ⇄ `src`, which is a boundary the owner has to approve**) | `npm test`, typecheck, lint clean; a send of an EPUB-only book on the real Kindle |
| **4 — the record** | Amend `CLAUDE.md` (Resolved Decisions §3, Stack row), `docs/architecture.md:23,218`, `docs/invariants/device-transfer.md:13`, `docs/invariants/settings-and-editing.md`, `README.md:67,99`, `tasks.md`, `CHANGELOG.md` | docs only | — |

## Acceptance criteria

- **AC1** — D1's EPUB test is run and its result recorded before any writer code is written.
- **AC2** — For each of the three spike EPUBs, the Oasis opens the file, shows its cover, navigates by TOC, follows one internal link and restores a reading position (D6). Recorded per book, per reading.
- **AC3** — `convert_format` is called with `{input_path, output_path}` only; no code path in `electron/main`, `sidecar` or `src` references `ebook-convert`, `ebook_convert_path`, `ebookConvertPath` or `calibre.app` after slice 3 (a grep, not a belief; `calibre_db.py` and the migration wizard are the only Calibre mentions that remain, and they read a database).
- **AC4** — Every output file carries title, author, EXTH 113 (unique per file) and EXTH 501 = `EBOK`, verified by re-reading it through the same offsets as `mobi-header.ts` (D3).
- **AC5** — A failed or interrupted conversion leaves **no** file at the target path and no `.tmp` residue on the NAS (D5).
- **AC6** — A PDF is never converted, and a book that already holds an azw3 or mobi is never re-converted (unchanged behaviour, pinned by the existing `transfer-queue` cases passing unmodified).
- **AC7** — The provenance log (slice 1 and 2 annexes) names an allowed source for every structure the writer emits; none cites GPL source.
- **AC8** — After slice 3, uninstalling Calibre changes nothing the app does — verified by a send of an EPUB-only book with `calibre.app` moved aside. (The migration wizard reads a Calibre `metadata.db` and never needed the install.)

## Risks, named

1. **The index tables are the hard part.** KF8's skeleton, fragment and NCX indexes are where a from-scratch writer most often produces a file that *parses* but that the firmware rejects or mis-paginates. Mitigated by the spike being the first thing built and the gate being on the real device; the real files in the library are the byte-level reference for what the Oasis accepts.
2. **Only one device decides.** The Oasis on 5.18.2 is the only reader this is tested against. A file that opens there may not open on another Kindle or in the Kindle app; that is acceptable for a single-owner app and is recorded, not hidden.
3. **Fidelity gaps on hostile EPUBs.** Publisher CSS, odd XHTML and big tables will degrade. D4 makes each one a returned warning so the count is measurable on the real library, not a surprise in the reader.
4. **Provenance discipline is a human rule.** Nothing mechanical enforces the provenance rule; the annex's per-structure log is the check, and the reviewer agent's pre-merge pass reads it.
5. **Cost of the 2,300-book backlog.** Lazy conversion means the first send of each EPUB-only book pays the conversion. Today's `ebook-convert` run time is the baseline to beat or match; slice 2 measures it, and the 30-second target in `CLAUDE.md`'s performance table applies.

## Deliberately not needed

No migration, no new `app_config` key (one is *removed*), no new dependency, no `metadata.json` change, no renderer surface beyond deleting a Settings field, and no change to the cover-cache writer or the presence rule. No backlog batch job (D7). No fixed-layout, media-overlay or embedded-font support (D4).

## Open questions for review

1. **D1's result** — does the Oasis list a USB-copied `.epub`? (Run before anything else; changes the whole design if yes.) **Result (2026-10-06):** not listed, would not open. The converter is needed; D2–D6 apply.
2. **Slice 3 crosses `electron/main` ⇄ `src`** (9 files). The brief says to hand that back for approval; this spec flags it so the approval happens at sign-off, not mid-build. **Approved by the owner 2026-10-06.**
3. **The `CLAUDE.md` amendment** (slice 4) reverses a *Resolved Decision*. It is deferred until the gate passes — confirm that ordering. **Ordering confirmed by the owner 2026-10-06.**

---

## Annex A — slice 1 provenance log (measured 2026-10-06)

**Reference files.** Nine real `.azw3` from the library, copied to `/tmp/azw3-ref/` and described by `scripts/azw3-probe.py`, then decoded by a throwaway script built only from the wiki's generic INDX/TAGX/varint rules and the PalmDOC algorithm (not committed). Three are the spec's reference set, all **kindlegen-built** (EXTH 204 = 201, 535 = a kindlegen build, no EXTH 108): *Cibola Burn* (prose; 641,620 B, 362 records), *The Disordered Cosmos* (footnotes + 30 images; 2,360,932 B, 226 records), *Patent, Copyright & Trademark* (three-level TOC; 2,434,260 B, 501 records). Two more kindlegen files widen the sample: *How Software Works* (images + fonts) and *Lonely Planet Rome* (1,090 records, JPEG + GIF — kindlegen-built, but PalmDOC-compressed). Four are **Calibre-built** (EXTH 108): *Red Rising* (2.20.0) and *Merchants of Doubt* (2.21.0), and — the shape the device has actually received — *American War* (8.16.1) and *The Transparency Society* (5.31.1), the azw3 cached in the folders of two books `device_history` logs as sent. `device_history` records `format_sent = 'azw3'` for a conversion and for an already-present azw3 alike (`transfer-queue.ts:84-91`), so the 130 error-free azw3 sends do not by themselves say what was sent; a read-only check during the final review (2026-10-06) of the azw3 in each of the **115 distinct sent books' folders** found all of them **Calibre-built (0.7.54 through 9.9; 78 are 9.6.0), KF8-only, compression 2**, and the two probed in full here match. Calibre's *output* is an allowed observation (§Provenance rule 2). None of the nine was produced by Musaeum's own conversion code.

**The container held.** `read_records` read all nine without error; Task 3's assumptions stand.

| Structure | Where it is | Fields | Source | Confirmed against real file? |
| --- | --- | --- | --- | --- |
| PalmDB header and record table | bytes 0–77, then 8-byte entries, then a 2-byte gap | type `BOOK`, creator `MOBI`, count at 76; unique-id seed (+68) = **2n − 1** and record *i*'s 3-byte uid = **2i** | MobileRead *PDB*; device-presence appendix; seed and uids **measured** | yes, 9/9 |
| Record 0: PalmDOC header | rec0 0–15 | compression (**17480 HUFF/CDIC** in 4 kindlegen files; **2 PalmDOC** in all 4 Calibre files and *Lonely Planet*), text length, text-record count, record size 4096, encryption 0 | MobileRead *MOBI* | yes, 9/9 |
| Record 0: MOBI header to 0xf0 | rec0 0x10–0xef | header length **264** (9/9); type 2; encoding 65001; file version **8**; +0x50 first non-book = the fragment INDX record; +0x54/+0x58 full title; +0x68 min version 8; +0x6c first image; +0x70/+0x74 HUFF record/count (0/0 when PalmDOC); +0x80 EXTH flags `0x50` in 7/9, `0x1050` in *How Software Works* (has FONT records) and *American War*, `0x58` in *Lonely Planet* | MobileRead *MOBI* | yes, 9/9 |
| Record 0: the KF8 words | rec0 0xc0–0x114 | **+0xc0 = FDST record number** as one u32 (the wiki's MOBI 6 reading — first/last content as two u16 — does not hold in KF8: the high half is 0, the low half is the FDST record in 9/9); +0xc4 FDST section count; +0xc8 FCIS record; +0xcc 1; +0xd0 FLIS record; +0xd4 1; +0xf0 extra-data flags **3** (9/9); **+0xf4 NCX index; +0xf8 fragment index; +0xfc skeleton index**; +0x100 the last `DATP` record (kindlegen) or `0xffffffff` (Calibre); **+0x104 guide index**; +0x108 `0xffffffff`; +0x10c 0; +0x110 `0xffffffff`; +0x114 0 | wiki to 0xf4 (which it names "INDX record offset" — measured as the NCX index; it lists 0xf8–0x108 as unknown); **measured** beyond — each pointer resolved to a record of the named kind in 9/9 | yes, 9/9 |
| EXTH | after the 264-byte header | Calibre writes 100–109, 112, **113 (uuid), 501 `EBOK`**, 503, 524, 204–207; kindlegen adds 121 (in 2 of 5 kindlegen files), 125 (resource count), 131, 201/202 (cover/thumb offsets from first image), 535, 536, 542, 547 | MobileRead *MOBI* EXTH; measured | yes |
| KF8 layout | whole file | **KF8-only in 9/9** — no `BOUNDARY` record, no MOBI 6 half, no EXTH 121 in Calibre files | measured only | yes |
| Text records | records 1..n | ≤4096 B uncompressed each; ends with **trailing entries for flags 0x3**: a multibyte byte (low 2 bits + 1 = its length) and, outside it, an indexing (TBS) entry whose size is a backward varint (`0x81` = empty, 1 byte). Confirmed by decoding *Red Rising*'s text to **exactly** the header's 900,046 bytes | wiki trailing-entry rule; measured | yes; TBS *content* not decoded (see Q4) |
| Post-text pad record | record n+1 | 1–3 NUL bytes. kindlegen sizes it so the next record starts at a 4-byte file offset (5/5); Calibre's does not (2/2), and those files still reach the device — alignment is not required | measured only | yes |
| Text markup | decoded text | one flow 0 of XHTML: each source file becomes a **skeleton** (its `<html>…<body aid="…">` shell with an empty body) **followed by its fragments**; then flows 1..k (CSS, linked as `kindle:flow:NNNN?mime=text/css`). Images are `kindle:embed:NNNN?mime=…` (1-based resource number), internal links are `kindle:pos:fid:FFFF:off:OOOOOOOOOO`, elements carry `aid="…"`; every number is **base 32, digits 0–9A–V** | measured only | yes (*Red Rising*: 4,621 `aid`, 55 `kindle:pos` links) |
| FDST | one record | `FDST`, u32 header length 12, u32 section count, then (start, end) u32 pairs over the decoded text: flow 0 is the XHTML, the rest are CSS/SVG flows | measured only | yes, 9/9 |
| INDX header record | first record of each index | INDX header (192 B) per wiki; +0x18 data-record count; +0x24 total entries; **+0x34 CNCX record count**; `TAGX` at +192; after TAGX, the last entry's label (length-prefixed) and a u16 entry count, then `IDXT` | wiki generic INDX/TAGX; measured | yes |
| INDX data record | next record(s) | INDX header (192 B) with +0x14 IDXT offset, +0x18 entry count; entries at 192 = a 1-byte label length, the label, 1 control byte, then forward varints; `IDXT` + u16 entry offsets | wiki generic; measured | yes |
| CNCX record | after an index's data records | strings, each a forward-varint length then UTF-8 bytes; tags point at them by byte offset (record k adds k << 16) | measured only | yes |
| Skeleton index (+0xfc) | e.g. *Red Rising* 225–226 | label `SKEL` + 10-digit number; TAGX `(1,1,mask 3)` fragment count, `(6,2,mask 12)` (start, length) in flow 0 — both written **twice** (control 0x0a = two groups) | measured only | yes, 9/9 |
| Fragment index (+0xf8) | e.g. 222–223 | label = 10-digit decimal **insert position** in flow 0 (inside the skeleton: before `</body>`, e.g. skeleton (0, 412) → 396); tag 2 = CNCX offset of an XPath selector `P-//*[@aid='…']`; tag 3 = skeleton number; tag 4 = fragment sequence number; tag 6 = (offset within the skeleton's fragments, length). Calibre writes **one fragment per skeleton** for most files (*Red Rising*: 145 fragments over 56 skeletons); kindlegen splits more | measured only | yes, 9/9 |
| NCX index (+0xf4) | e.g. 230–231 | label = 2-digit hex entry number; tag 1 position in flow 0, 2 length, 3 CNCX title, 4 depth, **21 parent, 22 first child, 23 last child** — these three are absent from *Cibola Burn*'s TAGX (a flat TOC; kindlegen omits them) and present in the other 8, including every Calibre file whether its TOC is flat or not, 6 (fragment number, offset); entries are ordered **by depth level** (all depth-0 first, then depth-1, …). Decoded in full on *Patent*'s three levels (34 entries) | measured only | yes |
| Guide index (+0x104) | e.g. 227–228 | label = guide type (`toc`, `copyright-page`, `text`); tag 1 CNCX title, tag 6 (fragment number, offset) | measured only | yes |
| Resource records | from +0x6c | raw JPEG/GIF/PNG; kindlegen adds `FONT` records and a `RESC` record (spine XML) — **Calibre writes neither**; the cover is the resource at EXTH 201 (cover offset) from the first image | measured; EXTH 201 per wiki | yes |
| HUFF/CDIC, DATP | kindlegen only | compression dictionaries; `DATP` purpose not decoded | measured only | yes — **not needed**: the Calibre shape omits both |
| FLIS / FCIS / EOF | records at +0xd0, +0xc8, and last | **FLIS** (36 B) byte-identical to the wiki's fixed layout. **FCIS differs from the wiki in KF8:** 52 B, not 44 — +12 is **2** (wiki 1), +28 is **40** (wiki 32), and it ends `00000000 00000028 00000008 0001 0001 00000000`; +20 = text length as documented. Identical in 9/9, so the writer copies the measured form. EOF `e9 8e 0d 0a` | MobileRead *MOBI* for FLIS/EOF; FCIS **measured** | yes, 9/9 |

**Answers slice 1b is written from**

1. **Joint or KF8-only?** KF8-only, **9 of 9**, from two producers (kindlegen, Calibre 2.20–8.16). Everything the review found in the sent books' folders is KF8-only Calibre output, so the Oasis takes KF8-only. The spike writes KF8-only; no MOBI 6 half.
2. **Header pointers.** +0xc0 FDST, +0xc8 FCIS, +0xd0 FLIS, +0xf4 NCX, +0xf8 fragment, +0xfc skeleton, +0x104 guide, +0x6c first image, +0x50 first non-book (= fragment index); +0x100 is `0xffffffff` when there is no `DATP`. The remaining words are constants, the same in 9/9, tabled above.
3. **Index encodings.** Fully decoded for all four indexes (tables above). The TAGX tables are **identical in 8 of 9** files; the exception is *Cibola Burn*'s NCX TAGX, which omits tags 21–23 for a flat TOC. Every Calibre file — the shape the device has received — carries all of them, so the writer emits the four TAGX tables verbatim in the full form, flat TOC or not. The minimal shape: one skeleton per spine file, one fragment per skeleton holding the whole body, NCX entries ordered by depth with parent/child tags.
4. **Compression, and two device experiments.** kindlegen uses HUFF/CDIC; Calibre uses PalmDOC (2), the shape the Oasis takes. Two cheaper options are untested on the device and are slice 1b's first manual step: **(a)** compression 1 (none), and **(b)** extra-data flags 0 (no trailing entries — the TBS content was not decoded, and writing it is the one structure here still without a source). If (b) fails, TBS becomes a measurement task of its own; if (a) fails, the writer implements PalmDOC compression (documented on the wiki). **Run 2026-10-07 — see *Device experiments* below: (a) works, (b) works only with (a).**
5. **Would MOBI 6 suffice?** Not decided here — **the owner's call** (spec D2/D6). The measurement's bearing on it: KF8's indexes, the risk the spec named first, turned out regular and fully decodable, and the minimal KF8 shape is what the owner's device has received for every sent azw3 the review checked. KF8 also keeps CSS (D4's fidelity target); MOBI 6 does not. The evidence favours staying with AZW3.

### Device experiments (run by the owner 2026-10-07)

Three files derived from a book the Oasis already holds — *The Transparency Society*'s cached azw3 (Calibre 5.31.1) — each with a new title (`[T0]`/`[T1]`/`[T2] …`, full title and EXTH 503) and a fresh EXTH 113, built by a throwaway script over `write_palmdb`/`build_exth` and the PalmDOC algorithm. Before the device, each was checked to decode to the original's text **byte for byte** with every index pointer resolving, and round-tripped once through `ebook-convert` as an oracle (§Provenance rule 4): exit 0, text identical to the original's round trip. Copied to `documents/` over USB, airplane mode on.

| File | Changed from the original | Listed | Opens | TOC (content list) | TOC links in the book | Reopens at last page | Progress |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **T0** | nothing but title + uuid; re-wrapped by our `write_palmdb`, record 0 rebuilt by our `build_exth` | yes | yes | yes | yes | yes | right |
| **T1** | trailing entries stripped, +0xf0 = 0; **PalmDOC compression kept** | yes | **freezes, then the Kindle crashes** | — | — | — | — |
| **T2** | trailing entries stripped, +0xf0 = 0, **text stored uncompressed** (compression 1), records ≤ 4096 B split at UTF-8 boundaries | yes | yes | yes | yes | yes | right |

**What it settles.** T0 proves the container writer and the record-0 rebuild on the device. T1 and T2 differ in **one thing only**: compression. The original's 40 text records each decompress to exactly 4,096 bytes and none ends inside a UTF-8 sequence (measured: multibyte overlap 0 in 40/40), so T2's re-split reproduced the original boundaries and the multibyte trailer had nothing to carry. Hence: **without trailing entries, the Oasis reads uncompressed text and crashes on PalmDOC text.** One observation each, on one device (Risk 2).

**Ruling for slice 1b.** The writer emits **compression 1, extra-data flags 0, text records of at most 4,096 bytes cut at UTF-8 boundaries** — T2's form. That removes the two structures without a full source (the TBS content, and a PalmDOC compressor plus its trailers) from the spike. Cost: files are larger — T2 is 233,019 B against the original's 153,877 (≈1.5×) — acceptable for lazy, per-book conversion (D7). A crash on open is the worst failure the device has shown; slice 2 keeps a pytest case that pins `compression == 1` together with `flags == 0`, so the combination T1 showed cannot be written by accident.

---

## Annex B — slice 1b provenance log and the D6 gate (built 2026-10-07; device readings pending)

| Structure the writer emits | Source |
| --- | --- |
| Forward varints, CNCX records | MobileRead *MOBI* (variable-width integers); Annex A *CNCX record* |
| INDX header + data records, the four TAGX tables (full form) | Annex A *INDX* rows; `build_index` rebuilds the skeleton, fragment, NCX and guide records of four real files byte for byte (16/16) |
| Skeleton entries (`SKEL` + 10 digits; count ×2; start/length ×2) | Annex A *Skeleton index* |
| Fragment entries (10-digit insert position; selector, file, sequence, offset/length), one fragment per skeleton | Annex A *Fragment index*; one-per-skeleton is Calibre's most common shape (*Red Rising*) |
| NCX entries (breadth-first; depth; parent; first/last child; length to the next entry at the same depth or shallower) | Annex A *NCX index*; `ncx_index` rebuilds *Patent*'s three-level TOC, *Red Rising*'s and *American War*'s byte for byte from the tree alone |
| NCX labels wider than two hex digits | **not measured** — every label is widened alike so the order holds; no gate book exercises it (largest TOC: 148 entries) |
| Guide entries, sorted by type; a `text` entry always present | Annex A *Guide index* (labels `text`, `toc`, `copyright-page` measured) |
| Link targets `kindle:pos:fid:FFFF:off:OOOOOOOOOO` → the target element's start tag; NCX position = the fragment's insert position + that offset | measured 2026-10-07 on *Red Rising* (5 links, 4 NCX entries checked) |
| `aid` on block elements and every id-bearing element; selector `P-//*[@aid='…']` on the body | Annex A *Text markup* / *Fragment index* |
| ASCII text: numeric character references in markup, `\XXXX ` escapes in CSS | *Lonely Planet Rome* (kindlegen): 6,568 `&#x…;` references |
| Compression 1, extra-data flags 0, exact 4,096-byte records | *Device experiments* T2 (T1, PalmDOC with flags 0, crashed the Oasis) |
| Record 0 words; EXTH 100–106/108/113/125/131/201/203/204–207/501/503/524/535 | Annex A *Record 0* and *EXTH* rows. 204–207 and 535 are Calibre's measured values: they name Amazon's kindlegen as the creator software and are kept for the gate because every file the Oasis has opened carries them; whether the firmware reads them is unmeasured. 108 is `Musaeum` (where Calibre signs itself) |
| Pad record; FDST; FLIS; 52-byte FCIS; EOF; record order | Annex A |
| Images ≤ 131,072 B, else a re-encoded JPEG | Annex A *Resource records*; measured maximum 130,912 B across nine files |
| Cover-cache JPEG `thumbnail_<113>_<501>_portrait.jpg`, fitted inside 330×500 | `docs/invariants/device-transfer.md` |

**Gate books, converted** (`scripts/azw3-spike.py`, files in `/tmp/azw3-gate/out/`): *Yellowface* 998,961 B in 0.13 s; *Darwin's Devices* 3,580,872 B in 0.27 s; *Raspberry Pi for Secret Agents* 4,129,009 B in 0.14 s. **No warnings on any of the three.** Cover-cache JPEGs: 18,436 B at 330×499, 26,852 B at 330×480, 29,852 B at 330×412. The 60-book sample drawn at random from the EPUB-only library converted without error (slowest: a 238 MB cookbook at 24.0 s, under the 30 s target); its warnings were 15 dropped `@font-face` rules, and image drops from one book with SVG page images and one with missing images.

**Oracle** (`ebook-convert` AZW3 → EPUB, once): exit 0 on all three. Words across the source's reading-order files against the round trip's: *Yellowface* 88,798 / 88,798, *Darwin's Devices* 84,308 / 84,308, *Raspberry Pi* 36,823 / 36,823 — **missing 0, extra 0** on each.

**Final review of the code (2026-10-07) and what it changed.** A fresh reviewer ran the writer against all 5,024 EPUB books on the NAS (TOC and spine) and converted 33 of them; the fixes below are pinned by tests, and the gate books were rebuilt afterwards (same sizes, 0 warnings, oracle again 0 missing / 0 extra). Re-run over 90 real books (the 60-book sample plus 30 of the reviewer's 33 copies, the rest no longer on disk): **78 convert; none loses more than 0.2% of its words** (the written text compared with the source's reading-order text); **the other 12 are DRM-encrypted** (Adobe `aes128-cbc` in `META-INF/encryption.xml`) and are now refused with that reason, not an XML error from inside the encrypted file. Changes: a table of contents that cannot be parsed (3 real books) degrades to a one-entry TOC with a warning; a TOC too big for one index record (largest real: 2,899 entries) loses its deepest level, then trailing entries, with a warning, and a single title is cut to 255 characters; malformed publisher XHTML is parsed by an HTML parser, not an XML recovery that silently dropped `&T` from `AT&T`; declared encodings are honoured, and a lying `<meta charset>` over valid UTF-8 bytes is not (*Darwin's Devices* declares iso-8859-1 over UTF-8); links are counted after dropped images; the source's own `aid` attributes are replaced; FLIS, the 52-byte FCIS, the locale and the read-back refusal are pinned by tests. **Not done, and why:** a TOC over ~2,000 entries is trimmed because the spike writes one CNCX record, as every measured file has; multi-record CNCX is unmeasured and waits for slice 2 and the device. The slowest conversion measured is *The Complete Story of Civilization* (4.7 M words) at 43 s, over the 30 s target; every other real book took under 11 s.

**D6, on the Oasis** (run by the owner 2026-10-07; the three books and their cover-cache entries copied over USB, airplane mode on): the owner reported that **all three books worked perfectly** — opening, cover, TOC navigation, an internal link and a kept reading position. Recorded as a pass on all five readings for each book; the owner did not itemise the fifteen readings or note any rendering difference.

| Book | Opens | Cover | TOC (incl. a deep entry) | Internal link | Reading position | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| *Yellowface* | pass | pass | pass | pass | pass | |
| *Darwin's Devices* | pass | pass | pass | pass | pass | |
| *Raspberry Pi for Secret Agents* | pass | pass | pass | pass | pass | |

**Verdict: pass.** Slices 2–4 are authorised (D6). Still unmeasured on the device and therefore carried into slice 2: a TOC over about 2,000 entries (multi-record CNCX), NCX labels wider than two hex digits, the creator-software fields (EXTH 204–207, 535), and any book with embedded fonts, fixed layout or SVG pages.

---

## Annex C — slice 2 (`convert_format` on the in-house writer), built 2026-10-09

**The oracle (spec slice 2 gate).** `scripts/azw3-oracle.py`, once: each book converted with `convert_format`, converted back to EPUB with Calibre's `ebook-convert`, and the words of the source's reading-order files compared with the round trip's. Fifteen books: twelve drawn at random from the EPUB-only library under 50 MB (`formats = '["epub"]'` and `file_size_bytes < 50000000`, `order by random() limit 12` — 2,085 candidates in the dev database on 2026-10-09) and the three slice 1 gate books, so the numbers continue from Annex B. The twelve were copied off the NAS and converted from the copies; the three gate books were read in place.

| Book                                         | Result                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| _Caligula and Three Other Plays_             | ok: 101,791 source words, 101,791 round trip, missing 0, extra 0; 1,938,659 B in 0.6 s, 0 warning(s) |
| _How to Be Invisible, Third Edition_         | ok: 79,785 / 79,785, missing 0, extra 0; 744,929 B in 0.1 s, 0 warning(s)                            |
| _Kender, Gully Dwarves and Gnomes_           | ok: 44,890 / 44,890, missing 0, extra 0; 475,971 B in 0.1 s, 0 warning(s)                            |
| _Lonely Planet US & British Virgin Islands_  | ok: 122,568 / 122,568, missing 0, extra 0; 6,957,172 B in 0.5 s, 0 warning(s)                        |
| _Maiden of Pain_                             | ok: 81,311 / 81,311, missing 0, extra 0; 537,126 B in 0.1 s, 0 warning(s)                            |
| _Speaking Up_                                | ok: 50,597 / 50,597, missing 0, extra 0; 9,441,674 B in 0.2 s, 1 warning(s)                          |
| _The Nine Billion Names of God_              | **DIFFERS**: 2,769 / 2,712, missing 57, extra 0; 35,698 B in 0.1 s, 0 warning(s) — Finding 1         |
| _The Rodale Whole Foods Cookbook_            | **ORACLE FAILED (1)** — Finding 2                                                                    |
| _The Woman Who Changed Her Brain_            | ok: 96,649 / 96,649, missing 0, extra 0; 4,210,463 B in 0.2 s, 0 warning(s)                          |
| _Tim Gunn's Fashion Bible_                   | ok: 89,204 / 89,204, missing 0, extra 0; 18,316,276 B in 1.9 s, 1 warning(s)                         |
| _Trading Basics_                             | **ORACLE FAILED (1)** — Finding 2                                                                    |
| _Unmasking Superfoods_                       | ok: 79,418 / 79,418, missing 0, extra 0; 1,307,301 B in 0.5 s, 0 warning(s)                          |
| _Yellowface_ (gate book)                     | ok: 88,798 / 88,798, missing 0, extra 0; 998,961 B in 0.6 s, 0 warning(s)                            |
| _Darwin's Devices_ (gate book)               | ok: 84,308 / 84,308, missing 0, extra 0; 3,580,872 B in 1.3 s, 0 warning(s)                          |
| _Raspberry Pi for Secret Agents_ (gate book) | ok: 36,823 / 36,823, missing 0, extra 0; 4,129,009 B in 0.8 s, 0 warning(s)                          |

**Finding 1 — the 57 missing words are a jacket page, and the oracle drops it for anyone's file.** The source's spine is `titlepage.xhtml` (0 words), `jacket.xhtml` (57 words) and the novel's `.htm` (2,712 words). The 57 the round trip lacks are exactly `jacket.xhtml`'s — the blurb, `SUMMARY: This splendidly wide range of stories …` — and **our AZW3 does contain them** (`b"SUMMARY:"` is in the file's bytes). **Control:** Calibre's own AZW3 of the same book, converted EPUB → AZW3 → EPUB by Calibre alone, loses the _identical_ 57 words. So the loss is Calibre's EPUB writer regenerating its own jacket on the way back, not the writer dropping a page. Consequence for reading this table: the oracle's word diff is blind to jacket pages, so `missing N` on a book whose EPUB carries one is not evidence about the writer.

**Finding 2 — two books Calibre cannot convert back to EPUB at all.** Calibre's AZW3 → EPUB exits 1 on _The Rodale Whole Foods Cookbook_ and _Trading Basics_, inside its own EPUB-output transform: `conversion/plugins/epub_output.py:219` → `oeb/transforms/rescale.py:19` → `rescale.py:60` → `oeb/base.py:599 read` → `FileNotFoundError: [Errno 2] … /calibre-…/_plumber/text/part0000.html#0-f7373ba965c74a4dbde31798074c8d3e` — a resource path with a fragment on it. **Two controls.** (a) Calibre's own AZW3 of both books round-trips clean (rc=0, missing 0, extra 0), so the books themselves are not the problem. (b) Calibre _reads_ our files: `ebook-convert <our>.azw3` to **TXT** and to **MOBI** both exit 0 for both books, and for _Yellowface_. So the failure is confined to Calibre's EPUB output transform on a file our writer produced — the file is readable, and it is not what the device sees (Annex B's D6 gate is on-device and passed). **Not settled, and not guessed at:** whether the trigger is a quirk in our skeleton/link encoding that this transform trips over, or a defect in the transform itself. The plan's instruction for a finding of this kind is to stop and report rather than patch around it, and a link-shape census over both failing books and two passing ones (`<a href>` into the first spine file; same-file / cross-file / plain-file anchors, images) found **no shape that separates the failures from the passes** — _Caligula_ carries 386 cross-file anchors and converts clean, _Rodale_ carries 3,645 and does not. Root-causing it inside Calibre's `rescale` pass is its own investigation; it is left here as a named, measured open item rather than silently absorbed.

**Verdict.** 12 of 15 clean. One anomaly (Finding 1) is proven to be the oracle's own loss, by a control that reproduces it with a Calibre-authored AZW3. The other two (Finding 2) are Calibre's EPUB output transform failing on our file, with the file shown readable through Calibre's other outputs and clean through Calibre's own AZW3 of the same books. **No word the writer was given has been shown missing**, and no book of the fifteen failed to convert.
