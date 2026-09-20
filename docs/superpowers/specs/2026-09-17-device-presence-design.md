# Design: Kindle presence by the book's own title, not the filename

**Date:** 2026-09-17 **Status:** Implemented and verified 2026-09-17 (AC1–AC9). Two readings from the run worth carrying forward: the device holds **1,555** book files rather than 1,556 (the Nerd Reich duplicate was removed in `eb67b6c`, after this was measured), and the census's bucket B lands at **2** rather than 0 — two files whose title is duplicated in the library and whose EXTH 100 names only one of two co-authors, which the uniqueness guard refuses by design. A+B = **1,343** exactly, which is the number this design promised; the guard costs 2 of them, and the app's book-level answer (1,347) matches the census's mirror of the rule. **Scope:** `electron/main/services/device-manager.ts` (scan, presence, removal) and the send path that consumes it. Adds one derived table (migration 004, `device_file_identity`); no renderer change beyond what a correct presence already drives. **Instrument:** `scripts/device-presence-census.py` — re-run it to reproduce every number here. Read-only, works while the app is running.

---

## Why this exists

Presence — the badge on a card, the "On {device}" button, the bulk send's skip list — is computed by matching `sanitizeTitle(book.title)` against the _stems_ of the files on the device. Every other tool names its files its own way:

- Calibre sends as `{author_sort}/{title} - {authors}.ext` (`Banks, Iain M_/Against a Dark Background - Iain M. Banks.azw3`)
- Titles get mangled in transit: `Algebraist, The`, `Homo Deus_`, `Autocracy, Inc..`

Measured on the real device (1,556 `.mobi`/`.azw3` files, 6,384 library titles):

|       | files     |                                                                                  |
| ----- | --------- | -------------------------------------------------------------------------------- |
| **A** | **86**    | matched by filename — effectively the books Musaeum sent itself                  |
| **B** | **1,257** | **missed by filename, recovered by the title inside the file**                   |
| C     | 1         | no title readable inside (odd header)                                            |
| D     | 212       | its own title matches no library title (user guide, dictionaries, edition drift) |

**The app sees 5.5% of what is on the device, and matching on the title each file carries inside it reaches 86% (1,343 of 1,556).** Consequences today, in the user's words and behaviour:

- "Difficult to ascertain whether a book is on or off the Kindle" — it is, for everything Calibre put there.
- "Send to {device}" is offered for ~1,400 books that are already there, and the bulk button would re-copy them.
- A real duplicate landed on the Kindle: The Nerd Reich sent, retitled, sent again three minutes later — two byte-identical files, same EXTH 113, same md5. Two fixes already shipped for that (below); a third of the class is this design.

### Already landed (2026-09-17, `a6d7bbc`)

- `sendStateFor`: the send button reads the transfer **queue**, not the call that started it (`sendToDevice` resolves when the job is _queued_), so it shows "Sending to {device}…", "On {device}", and "Couldn't send — retry".
- `noteSentFile`: a send records the name it wrote, and presence matches on that as well as on the title, so a retitle no longer hides a book we just sent. Session-scoped, and it only ever covers books _we_ sent.
- Covers are a separate, adjacent finding — the device has stopped generating `system/thumbnails/thumbnail_<EXTH 113>_<cdetype>_portrait.jpg`; writing it (and clearing the stale `…tmp.partial` beside it) is required. Recorded in `docs/invariants/device-transfer.md`; no app path does it yet.

---

## Decision

**Match on what the file says about itself.** For each device file, read the title and author embedded in it and compare those against the library, with the filename rule kept as a fallback for files whose metadata cannot be read.

### Where the identity lives

| format            | source                                                                | notes                                                      |
| ----------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `.mobi` / `.azw3` | MOBI header: full title, EXTH 100 (author), 113 (uuid), 501 (cdetype) | 1,556 of the device's files; exact offsets in the appendix |
| `.pdf`            | Info dictionary / XMP `dc:title`                                      | 10 files, all currently unmatched                          |
| `.kfx`            | not parseable by us                                                   | 12 files; falls back to the filename rule                  |
| `.epub`           | OPF `dc:title` / `dc:creator`                                         | none on this device; sparse in practice                    |

### Match rule

Normalize both sides with `sanitizeTitle` (already the app's rule; it strips `[:/\\*?"<>|]`, collapses whitespace, lowercases for comparison).

A library book is **on the device** when some device file satisfies:

1. **Title + author agree** — the file's normalized title equals the book's, and the file's author (normalized, order-insensitive) equals the book's, when the file carries one; or
2. **Title agrees and is unique** — exactly one library book has that normalized title (6,384 distinct titles across 6,460 books, so collisions are ~1%); or
3. **Fallback: the filename rule** — today's behaviour, for files whose metadata could not be read (KFX, the odd header, an unreadable book), plus the send receipts already shipped.

Rule 2 is the guard against the one way this design can lie in the _other_ direction: a false positive makes the badge say a book is on the device when a different book is. When a title is ambiguous and no author is available, prefer absent — the user re-sending a book is cheap; being told a book is on the device when it is not is not.

### Cost, and why this cannot be a naive scan

Measured with the census instrument on this device: a full pass over 1,556 files (one `open`, the record table, then record 0) takes **~72 s** — the mount's per-file latency, not the bytes, and 12 parallel workers did not improve it. Presence is recomputed on every `deviceContentsChanged` and `libraryChanged`, and the 5 s `/Volumes` poll re-scans on a timer, so:

- **The poll stays readdir-only.** Header reads never enter it. The poll's job is unchanged: detect the file set, broadcast when it moves.
- **Keys are read once per (path, size, mtime) and cached.** In memory for the connection, and — because 72 s on every reconnect is not acceptable — in SQLite keyed by `path + size + mtime`, so only new or replaced files are read. The cache is derived data: deleting the table costs one full pass and nothing else.
- **Reads run in the background after the scan**, bounded workers (8–12), and presence is allowed to settle: the app already treats it as asynchronous (the catalog sync can finish after the device scan, which is why the renderer recomputes on both `deviceContentsChanged` and `libraryChanged`).
- **When a batch lands, broadcast `deviceContentsChanged`** — that is the event whose handler re-asks for presence, so no new channel is needed. (A row whose facts change, `deviceChanged`, is about the device's own attributes, not its contents.)
- Budget to hold: presence for a fully-read device settles **within ~15 s of connect with a warm cache**, and does not delay the first scan.

### Removal

`removeBookFromDevice` must delete exactly what made the book read as present — today that is the title stem plus the recorded send names, and it becomes the content-matched file(s) too. Otherwise a book the app shows as "On {device}" refuses to come off, which is the same inconsistency the send receipt already had to fix. Ambiguity follows the match rule: a shared title removes the shared file (and the existing dialog's count reflects it).

---

## Alternatives rejected

1. **Also strip a trailing ` - {author}` from the stem.** Cheap, and it recovers 384 files — but it guesses at a _configurable_ Calibre template, and the census shows the content match recovers 1,257. If kept at all, it is a fallback for unreadable metadata, not the rule.
2. **Persist the send filename** (`device_history` gains a `filename` column). Closes the receipt gap across reconnects, but its reach is the 90 books we sent ourselves — 6% of the device. Superseded.
3. **Match by EXTH 113 (uuid).** Exact for files we wrote, and already the key the device itself uses for covers — but Calibre's 1,481 files carry _their_ uuids, so it cannot link them to our library. Keep it for covers; it is not a general identity here.
4. **Derive presence from `device_history`.** Already rejected in the invariant doc: a stale log cannot say whether a file is still on the device.
5. **Fuzzy/edition matching** (identifiers, ISBN, subtitle-insensitive titles). The residual 212 includes `The Audacity of Hope` against a longer library title, and `Drive: The Surprising Truth About What Motiv` truncated inside the file. Real, but a second slice — do not build it on the first.

---

## Acceptance criteria

Unit-level (vitest, `electron/main/services/device-manager.test.ts`, using the existing stand-in `/Volumes` harness):

- **AC1** A `.mobi` fixture at `Author, Name/Title - Author.mobi` whose embedded title matches a library book is reported present. (Synthesize the header: appendix.)
- **AC2** The same book, retitled in the library, stays present (the file's own title is what matches).
- **AC3** A file whose embedded title matches nothing stays absent.
- **AC4** No regression: a file that matches only by filename is still present, and a file whose header cannot be read falls back to the filename rule.
- **AC5** Two library books sharing one normalized title, no author in the file: absent (rule 2 refuses to guess). With the author present and agreeing: present.
- **AC6** `removeBookFromDevice` deletes a Calibre-named file that made the book present, and reports the count.

Device-level (real Kindle, measured):

- **AC7** `scripts/device-presence-census.py` after the change: bucket B drops to 0 and A+B = **1,343 of 1,556** (the number this design promises). Expect the census's A count to _fall_ as B absorbs it — the split is what matters, not A.
- **AC8** In the running app: `devices.getOnDeviceBookIds` returns ≥1,300 within 15 s of connecting a warm-cache device, and the 5 s poll performs no header reads (assert in a test that the poll path calls no `open`).
- **AC9** Spot-check three titles that are on the device under Calibre's naming and were invisible before: `Homo Deus`, `Against a Dark Background`, `21 Lessons for the 21st Century` — each reads "On {device}" in the detail panel, and neither the detail button nor a bulk send offers to send it again.

## Testing notes for the implementer

- The stand-in harness stubs `readdir`, `access`, `stat`, `statfs` for `/Volumes` paths. Header reads need **`open`/`readFile` added to the shim** (`rehome` + `tracked`, as the others are) or the new code will read the real filesystem.
- Build fixtures by writing real headers rather than mocking the parser: a MOBI record 0 is a few hundred bytes (appendix), and a fixture that a parser _parses_ is the only thing that proves the offsets.
- Keep the census script working as the outer check — it is the one test that runs against the actual device and the actual library.

## Appendix — MOBI/AZW3 layout (re-derived 2026-09-17; do not repeat it)

PalmDB header, 78 bytes: record count `u16` at **76**. Record table from **78**, 8 bytes per entry, entry 0 = `offset u32`, attributes, unique id. Record 0 is the whole book's header record and starts at that offset (0 in practice).

Inside record 0:

| field             | where                  | how                                                                                            |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| MOBI magic        | `+0x10`                | `"MOBI"`                                                                                       |
| header length     | `+0x14`                | `u32`                                                                                          |
| full title offset | `+0x54`                | `u32`, relative to record 0                                                                    |
| full title length | `+0x58`                | `u32`                                                                                          |
| EXTH flags        | `+0x80`                | `u32`; `0x40` set means EXTH follows                                                           |
| EXTH              | `0x10 + header length` | magic `"EXTH"`, `u32` length, `u32` count, then records of `u32` type + `u32` length + payload |

EXTH types worth having: **100** author, **113** uuid, **501** cdetype (`EBOK`), **503** updated title.

Two traps, both measured:

- **Do not read a fixed window.** Record 0 is usually ~10 KB but a long EXTH (blurb, tag list) pushes it past 16 KB; a fixed window silently loses the title on ~30 files. Read 78 bytes, then the record table, then record 0 exactly.
- **EXTH flags are not always present**: check the magic rather than trusting the flag, and treat a missing EXTH as "no author" rather than an error — rule 2 covers the book if its title is unique.

Adjacent, same key: the device's cover cache entry is named `thumbnail_<EXTH 113>_<EXTH 501>_portrait.jpg`, which is why the uuid is worth reading even though it does not identify a _book_ across tools.

## Non-goals

- The device report / browser. With presence content-based, most of that case evaporates; what remains (the residual 212) is a reporting question, not a browsing one. Revisit after this lands.
- Writing covers on send. A separate slice with its own evidence, in `docs/invariants/device-transfer.md`.
- Anything that changes what a send _writes_: this design only changes how the app _recognizes_ what is there.
