# Design: device covers — the Kindle's own cache entry, written by the app (kindle transfer, v1)

**Date:** 2026-09-26
**Status:** Signed off 2026-09-26 — **slice 1 only** (the send-time write). Slice 2 (the connect pass) is approved in principle but held for the owner's review before it touches `device-manager`.
**Scope:** Musaeum writes the Kindle's cover-cache entry (`system/thumbnails/thumbnail_<EXTH 113>_<EXTH 501>_portrait.jpg`) at send time, and a bounded pass on connect fills in the entries for the files already on the device. It deliberately does **not** touch `documents/`, the presence rule, the transfer queue's format choice, the database schema, or any renderer surface.
**Depends on:** the device-presence work (`docs/superpowers/specs/2026-09-17-device-presence-design.md`, measured 2026-09-17) — `readEmbeddedIdentity` and the per-file identity cache are this design's inputs.
**Interacts with:** `transfer-queue`'s send path (one hook, after the bytes are verified), and `device-manager`'s header pass (this pass is scheduled behind it, see D6).
**Supersedes:** the `[ ]` item *"Write covers on send, and re-apply on connect"* in `tasks.md`'s Kindle presence section — the same work, now with a design.

---

## Why now

The device stopped generating covers for itself, the app has never written one, and the manual fix decays.

- **Nothing writes the entry.** `grep -rn thumbnail electron/main` → 0 hits; `docs/invariants/device-transfer.md:15` says it outright: *"**No Musaeum code path writes one yet**"*.
- **The measurement that found it, 2026-09-17, against 1,567 files on this Kindle:** of the 91 books copied since Calibre's last connect, none got a cover from the device — every attempt left a **0-byte `…_portrait.jpg.tmp.partial`**, for azw3 and mobi alike. The `.mobi` sends that looked like they worked were showing thumbnails written before the copy existed.
- **The one backfill was by hand:** 77 entries written, 224 markers cleared, and **148 books turned out to be carrying a cover that a marker was hiding**. So today: every send lands coverless, and most of the device's 1,567 files were never given an entry by the app.
- **The owner's reason for the work, in his words:** *"i hate not having covers."* And on scope: his Kindle **is permanently in airplane mode**, so it has never received the updates that destroy these entries. The `Amazon destroys covers` half of the invariant is Calibre's experience on a syncing Kindle; it is not his, so a write-once fix does not decay here. That removes the standing argument for a restore cache, and it is why slice 2 is a *backfill that keeps up*, not a defence.

**Measured today, for the three calls this design had to make** (read-only; the probe scripts are named in *Risks*):

| Reading | Value |
| --- | --- |
| `readEmbeddedIdentity` on 4 real library files (2 azw3, 1 mobi, 1 azw3) | **4/4 carry EXTH 113 and EXTH 501** — `cdetype: EBOK` every time. The entry name is determined for real books. |
| *Red Rising*'s `.azw3` vs its `.mobi` | uuid **`5f8e82e4…`** vs **`1b3e27dc…`** — same book, two identities. The entry belongs to the **file**, not the book. |
| `nativeImage` → `resize` → `toJPEG(85)` on three real `cover_full.jpg` (529×800, 399×600, 512×684) | **24,211 B / 29,204 B / 37,370 B** — every one inside the device's own band (~330×500, **22–47 KB**) — at **1.1 ms** average over 10 runs. **Corrected in place 2026-09-26, during the build:** the `330×500` this row first carried was the **stretch**'s output — both dimensions handed to `resize` — and not the fit's. The shipped fit writes **330×499 / 330×496 / 330×441** at **24,114 / 28,886 / 34,366 B** for these same three jackets (`scripts/device-cover-probe.ts`). The wrong figure measured exactly the behaviour D3 exists to reject. |
| `nativeImage.resize({width, height})` with both dimensions | **stretches** — 512×684 (1:1.336) forced into 330×500 (1:1.515) is a ~13 % squash. Fitting is a rule this design has to state, not a default. |

**The thesis in one paragraph.** The Kindle looks up a cover by a name built from two fields *inside the file it holds*; the app already reads those two fields for a different reason, already knows which book each device file is, and already has the jacket on disk. So the whole feature is one small writer plus one pass, with no new dependency, no schema change, no sidecar call and no renderer surface. The design that follows is: **name the entry from the file's own identity, fit the jacket into the device's box, clear the marker that would hide it, and never let any of it fail a send.**

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| The two keys the entry name is built from, read out of a MOBI/AZW3 header, with the offsets already proven | `electron/main/services/mobi-header.ts:102` (`readEmbeddedIdentity` → `uuid` EXTH 113, `cdetype` EXTH 501) |
| One success point per send, with `device.mountPath`, `bookDir`, `sourceFile` and `deviceName` all in hand | `electron/main/services/transfer-queue.ts:135-145` |
| The book's jacket as a filename relative to the book's folder | `Book.coverFullPath` (`src/types/book.types.ts:129`), resolved against `join(libraryRoot, book.nasPath)` |
| The device files' identities, cached by `path+size+mtime` — **uuid and cdetype included** | `electron/main/services/db.ts:806` (`DeviceFileIdentityRecord`) |
| The header pass, and the one place a connect is turned into background work | `device-manager.ts:601` (file set moved) and `:629` (`deviceConnected`) both call `scheduleKeyPass(id)`; `runKeyPass` ends at `:253` |
| The match rule's inputs and its per-book direction | `device-manager.ts:402` (`filesCarryingBook`), `:423` (`deviceLibrary`), `:459` (`getOnDeviceBookIds`) |
| Kindle detection requires `system/` to exist — the directory this feature writes into | `device-manager.ts:45-56` (`looksLikeKindle`) |
| A staged fake Kindle at a temp dir, with real MOBI bytes for fixtures (EXTH 113/501 included) and `rm`/`open`/`readFile` rehomed | `transfer-queue.test.ts:43-103`, `device-manager.test.ts:1-50`, `test/helpers/mobi.ts` |

**Not true today, and inside this feature rather than free:**

- **Nothing in the main process encodes an image.** No `nativeImage` call exists anywhere in `electron`/`src`; the only encoder in the repo is the sidecar's (`sidecar/pipeline/cover.py:291`). D2 picks the writer.
- **The file→book direction does not exist.** `filesCarryingBook` answers *"which files carry this book"*; the connect pass needs *"which book does this file carry"*. Writing a second match rule would be drift, so D7 makes it a view of the same one, with an agreement criterion (AC13).
- **The stale-marker literal is one measurement old.** The invariant records `…_portrait.jpg.tmp.partial` and nothing re-checked the spelling since. D4 makes it a constant and AC8 pins the behaviour; the spelling is a reading to confirm on the next connect (Risks 2).

---

## D1 — The entry is named from the identity of the **file**, read where that file was copied from

**Decision:** the send path reads `readEmbeddedIdentity(sourceFile)` — the file whose bytes were just verified onto the device — and names the entry `thumbnail_<uuid>_<cdetype>_portrait.jpg` from it. The connect pass names each entry from **that device file's** cached identity row.
**Why:** *Red Rising*'s azw3 and mobi carry different uuids, so "the book's identity" is not a thing that exists; the device looks up the entry by the identity of the file it holds, so the only correct key is the copy's. Reading it from the source rather than the device copy is free and equivalent: `copyWithProgress` copies bytes verbatim and verifies the size, and a re-copy of an identical file keeps its EXTH 113 — which is the same fact the 2026-09-17 measurement already leaned on.
**Consequence:** a book sent in two formats gets two entries. A re-conversion that produced a new uuid (only possible if the cached azw3 were replaced with a fresh `ebook-convert` output) would leave the old entry orphaned and harmless, and the new one written on the next send.

## D2 — `nativeImage`, in the main process

**Decision:** the JPEG is produced with Electron's own `nativeImage` (`createFromPath` → `resize` → `toJPEG(85)`). No new dependency, no sidecar method, no Python process per send.
**Why:** measured — 1.1 ms and 24–37 KB for real jackets, inside the device's own 22–47 KB band. The alternative (a `cover_device_thumbnail` sidecar method reusing `pipeline/cover.py`'s `_encode`) buys a marginally better resampling filter and costs a boundary crossing, an RPC method, a process spawn on the send path, and a failure mode that only exists when Python is missing. It is recorded as the fallback rather than rejected outright (see *Rejected and deferred*).
**Consequence:** the entry's pixels come from Chromium's encoder, so a future visual complaint about a soft jacket has a named one-line place to change.

## D3 — Fit within 330×500, preserving aspect, never upscaling

**Decision:** `deviceCoverSize(w, h)` scales by `min(330/w, 500/h)`, clamped to `≤ 1`, and the encoder is handed **one** dimension so Electron keeps the aspect.
**Why:** measured — passing both dimensions stretches (512×684 → 330×500 is a 13 % squash). Passing one dimension preserves aspect but cannot honour a box in both directions. Computing the fitted pair and passing only the binding dimension does both. The box and the quality are the device's observed shape and an encoder setting that lands in the measured byte band.
**Consequence:** a jacket that is not 2:3 produces an entry that is not 330×500 (a 1:1.336 jacket → 330×441). Whether the device renders a non-330×500 entry is **unmeasured** — it is risk 2, and the reading that settles it is a device that has one.

## D4 — Clear the marker that would hide the entry, and only that marker

**Decision:** before writing, delete `<entry>.tmp.partial` under `system/thumbnails/`. Nothing else is ever deleted, and no directory-wide sweep is performed.
**Why:** the measurement is unambiguous that a marker hides an entry that is already there — 148 of 1,567 files were carrying a cover behind a 0-byte marker, and the device leaves markers whenever it tries and fails to generate one. The restriction is the other half: this is the one code path in the app that deletes files on a mounted device, and a fixture named after a real book already deleted a real file off an attached Kindle once (`device-transfer.md`'s testing section). Deleting only the name we are about to write is not a heuristic — it is the only file whose absence is a precondition of our own write.
**Consequence:** a stray marker for an entry we do not write (a book removed from the library, an entry whose file is gone) is left alone. That is deliberate, and it is why AC14 plants one and asserts it survives.

## D5 — No part of this can fail a send, and none of it gets UI

**Decision:** the write is wrapped in its own `try`/`catch`; a failure or a skip logs and the job still reaches `done`. No new field on `TransferJob`, no toast, no status-line text, and no renderer change at all.
**Why:** invariant 12 — the failures that stay non-fatal, stay non-fatal. The book *did* arrive; a missing cover is a cosmetic device-side cache miss, and the surfaces that would report it are the ones the user is looking at for a different reason. A sentinel that reports "cover not written" beside a successful send would read as a failed send.
**Consequence:** the only evidence of a failure is a log line. That is named as a deliberate non-addition, with its reversal condition in *Rejected and deferred*.

## D6 — The connect pass runs behind the identity pass, one at a time, and is skipped when there is nothing to scan

**Decision:** `runKeyPass` schedules a cover pass for the same device when it settles; passes coalesce per device exactly as the header pass does (`keyPasses`/`keyPassQueued` is the pattern to copy); a device whose scan enumerated nothing runs no cover pass.
**Why:** the pass's input is the identity cache, which the header pass fills — run it first and every file is a miss. A cold device already takes ~72 s to read through, so the cover pass must add **no opens on the device**: it reads the cache, calls `readdir` on `system/thumbnails/` once, and stats nothing. The empty-scan guard is `pruneKeyCache`'s own (`device-manager.ts:304-309`): an empty file list is also what a volume mid-unmount looks like, and writing entries against that reading is how a pass would scribble on a device that is going away.
**Consequence:** the first connect after this lands is the expensive one — every coverless book on the device needs its jacket read off the share (bounded by the same 8-worker pool the header pass uses; a book's cover is read **once**, not once per file). Every later connect is readdir-only and writes nothing. Measured cost after the first pass is not yet taken; the count the pass reports is what makes it visible.

## D7 — The file→book direction is a second *view* of the match rule, not a second rule

**Decision:** `device-manager` gains `deviceFileOwners(deviceId)` returning `{ path, bookId, uuid, cdetype }` for the files it can attribute, derived from the same inputs `getOnDeviceBookIds` uses (the identity cache ∩ the current scan, the unique-title guard, the title+author pair, the filename rule and the send receipts). The cover pass consumes it and holds no matching logic of its own.
**Why:** a second implementation of the match rule is the exact drift class this repo keeps writing invariants against — two answers to "which book is this file", one of them in a path nobody re-reads. Making it a view means the ambiguity guard ("prefer absent", `device-manager.ts:394-400`) applies to covers for free.
**Consequence:** a file the library cannot attribute gets no entry, even when a human looking at the device would say obviously which book it is. That is the same trade presence already made — a re-send is cheap, a wrong jacket is not — and AC13 is what holds the two views together.

---

## Acceptance criteria

### Slice 1 — the send writes the entry

1. A send writes exactly one file into `system/thumbnails/`, named `thumbnail_<uuid>_<cdetype>_portrait.jpg` from the identity of the file that was copied. Decided by a unit case over a staged fake Kindle and a `mobiFile` fixture with known EXTH 113/501 — asserting the **filename**, not that "a file appeared".
2. A book sent in a second format writes a **second** entry, under that file's own uuid (D1). Decided by the same harness with two fixtures whose uuids differ.
3. The entry's bytes are a JPEG (`FF D8 FF` leading) of the fitted size: a 2:3 source → 330×495 (**corrected in place at the build:** the box is 330×500 = 1:1.515, *not* 1:1.5, so a 2:3 jacket fits **width-bound** and leaves five pixels of height unused — the first draft's 330×500 came from the stretch, see the measurement table); a 1:1.336 source → 330×441; a 200×300 source → 200×300 unchanged (never upscaled). The last three are cases on the pure size function, the first is asserted on what the send actually wrote.
4. A `<entry>.tmp.partial` sitting beside the destination is gone after the send, and the bytes still verify. Decided on real fs in the fake-Kindle harness.
5. The entry exists at the moment the job reads `done` — the write is inside the send, before the terminal emit, not a fire-and-forget after it. Decided by asserting both in one case.
6. A book with no cover (`coverFullPath` null) writes nothing and still reaches `done`. Decided by the same case shape as AC1, asserting the thumbnails directory is absent-or-empty.
7. A PDF send writes no entry and still reaches `done` (no EXTH to name one with). Decided by the PDF case already in `transfer-queue.test.ts`, extended with the assertion.
8. A cover write that **fails** — an unreadable cover, a thumbnails write that rejects — leaves the job `done`, logs, and writes no partial file. Decided by injecting the failure at the `fs` boundary, the shape `transfer-queue.test.ts:239-263` already uses for the EBADF case.
9. The send writes **nothing** outside `<mount>/system/thumbnails/` and the pre-existing `documents/` copy: no file under the library root is created, removed or modified, and no database row changes beyond the `device_history` row the send already writes. Decided by a file-list-plus-mtime comparison of the book folder and a before/after read of the book row.
10. Every case in `transfer-queue.test.ts` that exists today still passes unmodified except where AC7 adds an assertion — the copy path, the format choice and the size verification do not move.

### Slice 2 — the connect pass fills in what is missing

11. After the header pass settles for a connected device, one entry is written per *distinct* cover among the files that (a) the library attributes to a book, (b) carry a `uuid` and a `cdetype`, and (c) have no entry yet. Decided over a fixture device holding a Musaeum-named file, a Calibre-named file with a matching title, and a file the library cannot attribute.
12. A file whose title two library books share, and which carries no author, gets **no** entry (the ambiguity guard, D7) while its neighbour with an author does. Decided in the same fixture.
13. Every `(file, book)` pair `deviceFileOwners` produces is a pair presence agrees with: for each pair, the book is in `getOnDeviceBookIds(deviceId)`, and the file is one `filesCarryingBook` (or the stem rule, or a send receipt) attributes to it. Decided as a property assertion over the fixture device — this is the case that catches the reverse rule drifting from the forward one.
14. The pass deletes **only** the marker for an entry it is writing: an unrelated `something_else_EBOK_portrait.jpg.tmp.partial` and a foreign file in `system/thumbnails/` both survive the pass. Decided on real fs.
15. The pass is idempotent: a second run over the same device writes **0** entries and reports 0. Decided by running it twice in one case.
16. The pass is non-fatal and non-blocking: an unreadable cover, a vanished device file, and a device that disappears mid-pass each end the pass with a log and leave the identity pass's own results intact. Decided by three cases against a failing/absent mount, with the header pass's assertions re-read afterwards.
17. A device whose scan enumerated nothing runs no cover pass at all — asserted by planting an entry-less device with no `documents/` reading and asserting the thumbnails directory is untouched. (D6's guard, mirroring `pruneKeyCache`.)

## Slices, and why they are cut this way

**Slice 1 (4 files, under the bound).** New: `electron/main/services/device-covers.ts` (the naming rule, the size rule, the encoder, the marker-clear-plus-write, its result type — all pure over an injected path, plus the record type the pass will reuse), `device-covers.test.ts`. Edited: `transfer-queue.ts` (one hook and its `try`/`catch`), `transfer-queue.test.ts` (AC1–AC9). It stops after the send because that is the whole complaint — *"every send lands coverless"* — and everything it needs is already in hand at that point in the code.

**Slice 2 (4–5 files, under the bound).** Edited: `device-covers.ts` (the pass and its counters), `device-manager.ts` (`deviceFileOwners` + the scheduling behind `runKeyPass`), `device-manager.test.ts` (AC13, the mapping), `device-covers.test.ts` (AC11–AC12, AC14–AC17). Slice 2 is separable because it needs a *second* input slice 1 does not — the identity cache, which exists only after a connect — and because it is the half that writes to the device unasked.

Both slices are decided without the device attached. The three readings that need the Kindle are in *Risks*, and none of them decides whether the slices are correct — they decide whether the marker spelling and the fitted size are what the device wants.

## Rejected and deferred, with the condition that would revive them

- **The sidecar as the encoder** (`pipeline/cover.py`'s `_encode`, PIL). Rejected on measurement (D2): the main-process encoder lands in the device's own byte band, and the sidecar costs a boundary, an RPC method and a spawn per send. **Revived** if a jacket visibly degrades — the fallback is one method and one call site.
- **Forcing exactly 330×500** (what the device's own entries measure). Rejected because it stretches any jacket that is not 2:3 by up to 13 % (measured). **Revived** if the device turns out to ignore an entry whose dimensions are not the box — a reading, not a preference.
- **A restore cache in the style of Calibre's `/amazon-cover-bug/`.** Rejected: it exists to survive a syncing Kindle destroying entries, and the owner's device is in permanent airplane mode, so there is nothing to restore. **Revived** the moment a device that syncs is used — and then it is a new design, not this one.
- **A manual *Re-apply covers to {device}* action.** Offered and not taken: the owner chose the automatic pass. **Revived** if the automatic pass ever writes something unwanted — the pass is one call, so the action is a button plus a count.
- **Writing entries for KFX and PDF on the device.** Rejected: neither carries a parseable EXTH 113/501, so no entry can be *named*, and guessing one would write a file the device never looks up. **Revived** by one census reading — if the device's own PDF entries turn out to be named after the file rather than an identity, a second naming rule is a small function.
- **Deriving a cover for the 12 books with no `coverFullPath`** (re-extracting the file's own jacket). Deferred: re-hydration already does it, and this feature is not the place to introduce a second cover producer.
- **Any renderer change.** None is needed; the entries are the device's own business (D5).
- **A `device_history` column or any persisted record of a cover write.** Deferred: the entry's existence *is* the record, and it is the one the device reads.

## Risks, stated plainly

1. **This is the app's second code path that deletes files on a mounted device**, and the first one already deleted a real file off a real Kindle from a passing test run. Mitigation: D4 narrows the deletion to the exact name being written, AC14 plants a decoy that must survive, and the harness must rehome `rm`/`unlink`/`open`/`writeFile` for the thumbnails path before slice 1's first case runs — fixtures carry uuids that cannot exist on a real device (`test/helpers/mobi.ts`'s `The Fixture Codex` convention).
2. **The marker literal and the fitted-size question are one measurement old and unconfirmed.** `…_portrait.jpg.tmp.partial` comes from a single hand-backfill session, and whether the device renders a 330×441 entry is unknown. Both are cosmetic-but-visible if wrong (a cover that does not appear). The reading to take on the next connect: `ls system/thumbnails/ | grep tmp` for the spelling, and whether any entry whose jacket is not 2:3 shows on the device. **Neither reading gates either slice** — a wrong spelling costs a cover, not a file, and the entry is still correct by the key the device looks up.
3. **The device may litter a fresh marker beside an entry we just wrote** (it leaves one whenever it tries and fails to generate its own). Unmeasurable from here — his device is never plugged in during this session. If it does, the next connect's pass clears it, which is exactly what the automatic option buys; if it happens every connect, the cost is one `rm` per affected book and nothing else.
4. **A wrong file→book attribution puts the wrong jacket on a book.** Guarded by D7's shared ambiguity rule, and cosmetic: the correct jacket is one re-send away, and the library's own cover is untouched (nothing in this feature writes to the share).
5. **The first connect is expensive, and its cost is not yet measured.** Every coverless book on the device needs one jacket read off the share, at SMB latency. Bounded by a worker pool and by reading each book's cover once; visible through the pass's own counters. If it is bad enough to notice, the fix is the manual action this design already prices.
6. **Invariants.** Held: **12** (every failure stays non-fatal — D5, AC8, AC16), **2** (book lookups by extension — untouched; the cover is resolved from `coverFullPath`, and the device side is keyed by identity), **11** (`vendor/` untouched). Explicitly *not* touched: **1** (`metadata.json` is not written by this feature at all), **3** and **4** (nothing here reads `formats` or derives a sort key), **5** (reading state is not in this path), **6** (no rename), **9** (`musaeum://` is not involved — this writes to a device, not to the renderer). No migration, no new `app_config` key, no new dependency, no CSP change, no renderer file.

---

## Start here (for whichever session builds this)

- `docs/invariants/device-transfer.md:15` and `:28-37` — the cover rule and the harness's own hazards, including the deleted-real-file incident.
- `electron/main/services/transfer-queue.ts:126-151` — the send path and its single success point.
- `electron/main/services/mobi-header.ts:54-128` — the identity reader this design keys off.
- `electron/main/services/device-manager.ts:143-254` — `refreshDeviceContents`, `scheduleKeyPass`, `runKeyPass`: the pattern the cover pass copies, and the place it is scheduled from.

---

## Built — slice 1 (2026-09-26)

**What shipped.** `services/device-covers.ts` (name, size, codec, marker-clear-then-write, result type) + `device-covers.test.ts`; one hook in `transfer-queue.ts` between `noteSentFile` and the terminal emit, + seven cases; `scripts/device-cover-probe.ts`. **Slice 2 not started** — held for review, per the sign-off.

**Files: 6, not the 4 the design budgeted.** Both extras were forced, neither is optional:

- **`test/mocks/electron.ts` (edited)** — `device-covers.ts` imports `nativeImage` at module scope, and the `electron` alias is an inert mock, so a test file that never *calls* the codec still fails at **link** time without it. The mock gains `nativeImage` as a loud throw naming `setCoverEncoderForTests`, so a forgotten swap is a failure at the call rather than a suite asserting a file that never appeared.
- **`scripts/device-cover-probe.ts` (new)** — the real codec has no unit decider at all in this environment (`npm test` is Electron-as-Node). The probe imports the **shipped** `writeDeviceCover`, not a copy of it, plants the marker the device leaves behind, writes into a throwaway mount, and prints what landed. Precedent: `scripts/theme-resolver-probe.ts`.

**Readings the build had to settle** (the design left each of these open):

- **The codec, end to end, on three real jackets** (`Brand Against the Machine` 529×800, `Red Rising` 399×600, `Influence` 512×684, on 2026-09-26): entries named `thumbnail_183fc97a…_EBOK_portrait.jpg` / `…5f8e82e4…` / `…007cd145…`, **24,114 / 28,886 / 34,366 B** — all inside the device's band — decoded back off disk at **330×499 / 330×496 / 330×441**, JPEG SOI present, marker cleared. **124–271 ms** for the whole write, which is the SMB read of `cover_full.jpg`, not the encode (the encode alone is the 1.1 ms the design measured).
- **The write takes the source *path*, not an identity**: `writeDeviceCover({ mountPath, sourceFile, coverPath })` reads `readEmbeddedIdentity` itself. That keeps the naming rule in one module and puts AC1's identity half where it can be decided — a real `mobiFile` fixture through the shipped parser — while the send's own half is decided by the entry that lands on disk. The spec's "asserting the filename" is met with the name spelled as a **literal**; see the campaign note below for why that is not a stylistic choice.
- **The codec is a swappable binding** (`setCoverEncoderForTests(fn)`), not a mocked module. Mocking `./device-covers` in `transfer-queue.test.ts` would have taken the naming, the identity read, the marker and the write with it and left the file asserting its own stub.
- **D5's "a failure or a skip logs" became: expected skips log nothing.** No identity to name an entry with (every PDF send) and no jacket on the book are ordinary states; the two surprises — a jacket that cannot be encoded, a device that refuses the write — log exactly one `console.warn`, and the job reaches `done` either way. As written, the decision would have put a line on every PDF send forever. Two cases assert the silence, not just the entry's absence.
- **AC8's "inject the failure at the `fs` boundary" was realised with two real mechanisms instead**: a codec that throws, and `system` written as a *file* so the cache directory cannot be created (`ENOTDIR`). No `fs` monkeypatch was needed for this criterion; the EBADF case keeps its own.
- **AC9's mtime comparison was unnecessary**: the path touches exactly one share file, and read-only (the jacket). Decided as a file-list comparison either side of the send plus "no `metadata.json` was created". The harness's `put()` was widened to `string | Buffer` for the MOBI fixtures — the only edit to a pre-existing helper.
- **AC5's instrument**: "the entry is there when the job reads `done`" is decided by spying the `transferProgress` broadcast and checking the file's existence at the instant the `done` payload fires — the event the renderer itself reacts to, rather than a second assertion after the promise settles (which a write moved after the emit would still pass).

**Gates, on the tree that shipped** (`8501924` + this slice, 2026-09-26): `npm run typecheck` **0** · `npm run lint` **0** · the six code files `prettier --check` **clean** · `npm test` **1630 passed / 72 files** (baseline 1609 / 71 → **+21 cases**: 14 new in `device-covers.test.ts`, 7 in `transfer-queue.test.ts`). AC10 holds: no pre-existing case changed except the PDF one gaining its assertion. The three `.md` files this slice touches are prettier-dirty **and so are their `HEAD` versions** (`git show HEAD:<file> | prettier --check` flags both) — that is the repo-wide markdown drift already recorded in `tasks.md` (2026-09-25 entry), not a delta this slice introduced, and reformatting `docs/` here would be a drive-by.

**Mutation campaign: 12/12 killed**, and attributed per row with `scripts/attribute-mutations.py` (which case reddened, not just how many). Two rows carry collateral worth naming: the name-order swap reddens **5** cases (`device-covers.test.ts`'s two name cases, "hands the codec the jacket", the marker case and "leaves every other file alone" — every one of them asserts the name), and the `coverPath: null` mutation reddens **5** in `transfer-queue.test.ts` (every case that expects an entry, plus the two that expect a *surprise* line, since the skip changes from `encode`/`failed` to `cover`). No case reddens for everything: the pure size cases and the skip cases stay green under all twelve.

**The campaign's first run was 11/12, and the survivor is the finding.** *"The entry name puts cdetype before uuid"* survived, because every case derived its expectation from `deviceCoverName(...)` — swapping the arguments inside the function moved both sides of the assertion and nothing reddened. The name is now a **literal** in the suite (and in the transfer-queue case), which makes that row kill 5 cases. Generalised into `docs/invariants/device-transfer.md`'s testing section: the device's spelling is an external fact, so the expectation has to be one too.

**What these deciders cannot see**, stated so slice 2 does not over-trust them: nothing here decides the two device readings (whether the Kindle renders a *fitted* entry, and whether the marker spelling is right) — the probe measures our side of the boundary only, and both readings need the device. And the naming rule is one function shared by the send (slice 1) and the pass (slice 2), so nothing in slice 1 stops the pass from passing it something other than the file's own cached identity — AC13's agreement criterion is what will hold that.
