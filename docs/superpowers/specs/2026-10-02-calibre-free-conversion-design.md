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
