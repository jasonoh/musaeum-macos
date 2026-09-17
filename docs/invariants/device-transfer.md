# Kindle transfer

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching device detection, sends, or on-device presence.

---

## Kindle Transfer (USB)

- Detect Kindle by polling `/Volumes` every 5s (name contains "kindle", or
  volume has both `documents/` and `system/` dirs)
- **Free space is read from the device's own filesystem, and re-read every
  poll.** `statfs` answers about whichever filesystem _contains_ the path, so a
  `/Volumes/Kindle` that is a bare directory — a mount point left behind by an
  unclean unplug, or the volume in the moment before macOS has attached it —
  reports the _boot disk's_ free space (measured: 72.45 GiB from a plain
  directory in `/tmp`, against 21.31 GiB from the mounted Kindle). The name test
  in `looksLikeKindle` matches without touching the filesystem, so such a
  directory can be recognised as a device, and because the figure was read once,
  at recognition, the row showed 73.2 GB free for a Kindle with 21.3 GB and
  never corrected itself. `freeBytes` now returns null unless the path is a
  mount point (its device differs from its parent directory's), the reading is
  retaken on every poll like the content scan, and a change is broadcast as
  `deviceChanged` — the renderer restates the device rather than re-asking for
  its contents, because a space reading does not change which books are on it.
  A volume that is not actually mounted therefore shows no figure rather than a
  foreign one, and the real number appears within a poll once macOS attaches it.
- Format preference: azw3 → mobi; converts to azw3 via `ebook-convert` when
  neither is cached, and caches the result on the NAS. PDF-only books
  transfer as PDF — never converted (Kindles render PDF natively;
  `ebook-convert` is never invoked for PDFs)
- Copy to `/documents/` on Kindle volume with streamed progress events. The
  destination is named `sanitizeTitle(book.title) + ext`, **not** the source
  file's basename — renaming a book never renames its NAS files, and presence
  matches the current title against device file stems, so copying under the
  on-disk name left a retitled book reading "Send to Kindle" even immediately
  after a successful send. `copyWithProgress` opens the source fd itself (`autoClose: false`) and
  swallows a `close()` failure — macOS's SMB client returns EBADF closing some
  files it has just read in full, which used to fail transfers that had in fact
  completed byte-for-byte. Write-side errors still propagate, and the
  destination size is verified before a book is reported as sent, so a
  truncated copy is still an error.
- **Covers are a device-side cache entry, and the device no longer generates
  them — a send has to write one.** The cover is not read out of the book when
  the library is drawn. The Kindle looks up
  `system/thumbnails/thumbnail_<EXTH 113>_<EXTH 501>_portrait.jpg` (~330×500,
  22–47 KB), keyed by the identity _inside_ the file, not by its name. Measured
  2026-09-17 against 1,567 on-device books: of the 91 books copied since Calibre's
  last connect, none got a cover from the device — every attempt left a 0-byte
  `…_portrait.jpg.tmp.partial`, for azw3 and mobi alike, so the format is not the
  lever. The `.mobi` sends that looked like they worked were showing thumbnails
  written _before_ the copy existed (2019–2026-05 timestamps), which only works
  because a re-copy of an identical file keeps its EXTH 113. Calibre does not rely
  on the device either: its Kindle driver writes the entry itself (`upload_cover`
  → `system/thumbnails`) and keeps a cache at `/amazon-cover-bug/` that it
  restores on each connect — "Restored N cover thumbnails that were destroyed by
  Amazon". Two things are required and neither works alone (verified on the
  device): write the entry, **and** delete the stale `…jpg.tmp.partial` beside
  it, which otherwise hides a cover that is already there — 148 books on this
  device were carrying a cover the marker was hiding. The device neither
  regenerates on its own nor wipes a written entry across a power cycle. **No
  Musaeum code path writes one yet**: the existing library was backfilled by hand
  on 2026-09-17 (77 entries written, 148 markers cleared), and a fresh send still
  leaves its book without a cover.
- Log to `device_history` table (including failures, with error text)
- Transfers run serially through `transfer-queue.ts`
- **On-device presence** is derived by _scanning_ the connected Kindle's
  `documents/` folder (not from `device_history`): `device-manager` walks it
  (depth 2) into a `stem → paths` map, and `getOnDeviceBookIds` matches a book
  three ways — `sanitizeTitle(title)` against a file stem (extension-agnostic),
  the **title and author inside the file**, and the title inside it alone where
  the library holds exactly one book with that title. The filename reading is
  what keeps a book Musaeum sent visible when its own header cannot be read; the
  content readings are what see a device another tool filled (below).
  Surfaced as a badge on `BookCard` and an "On {device}" state on the
  detail-panel send button. Presence = f(device files, book set), so the
  renderer recomputes it on **both** triggers: `deviceContentsChanged` (device
  side) and `libraryChanged` (book-set side — the on-connect catalog sync loads
  books asynchronously and can finish _after_ the device scan, so recomputing
  only on the device event left presence stale at cold start). The 5s device
  poll re-scans a known device's `documents/` and re-broadcasts only when the
  stem set changed (`keysEqual` guard), so presence self-heals when files change
  on the device outside Musaeum or a first scan ran before the volume settled.
  The walk **skips `{book}.sdr` sidecar folders** — the Kindle names the files
  inside them after the book, so descending into one reports a book as present
  from its leftovers alone. Renaming a book renames its NAS files and names
  future sends from the current title, so presence keeps up — but a copy
  _already_ on the device keeps the name it was sent under, which a title change
  afterwards cannot move. That is what the send receipt below is for: before it,
  such a copy read as a _different_ book, and the only way out was to remove it
  and send it again.
- **A send records the name it wrote** (`noteSentFile`), because that is the one
  fact a device file cannot give back once the title moves on. `getOnDeviceBookIds`
  matches on that name as well as on the sanitized title, so a book retitled after
  its send stays "on device" rather than reading as absent and inviting a second
  send — measured on a real Kindle as a byte-identical duplicate (same EXTH 113,
  same md5) sent three minutes after the first. It is only ever a second _match
  key_: the file still has to be in the scan, so deleting or renaming it on the
  device drops the claim with everything else, and `removeBookFromDevice` matches
  both keys or a book the app calls present would refuse to come off. Cleared with
  the connection, since a receipt is about the sends made over it. **Known gap:**
  retitle _plus_ an unplug leaves the book reading as absent again — closing that
  means persisting the name (`device_history` has no filename column today) or
  matching on identity (EXTH 113, which the covers already use), and neither is in.
  Content matching (below) does not close it either, and is not meant to: a
  retitle rewrites the library's files, not the bytes of the copy already on the
  device, so that copy's own title still says the old one.
- **Presence matches what the file says about _itself_, not the name a host gave
  it.** Matching by sanitized title against file _stems_ only sees books Musaeum
  wrote itself, and Calibre writes `{author_sort}/{title} - {authors}.ext` with
  its own spellings ("Algebraist, The" for "The Algebraist"). Measured 2026-09-17
  on this Kindle: the filename rule recognized **86** of 1,555 book files; the
  title each file carries inside it reaches **1,343** (86%). So the badge was
  silent for most of the library and "Send to {device}" was offered for ~1,400
  books already there — including one that then landed twice, byte-identical.
  A library book is present when a device file's own title and author are the
  book's (`authorKey` is order-insensitive, so Calibre's "Banks, Iain M." is the
  library's "Iain M. Banks"), or when the file's title is the book's and exactly
  one library book has that normalized title. **The uniqueness guard is
  load-bearing**: without it two library books sharing a title would both claim
  one file, and a false positive (the badge claiming a book that is not there)
  costs more than the re-send a false negative costs. A `.mobi`/`.azw3` header is
  read per the layout in the design's appendix — 78 bytes, the record table, then
  record 0 *sized from that table* (a fixed 16 KB window loses the title on 67
  files) — and EXTH is detected by its magic, not by its flag. KFX, PDF and
  EPUB keep the filename rule; nothing reads them yet.
- **Reading those headers is asynchronous, and it cannot be otherwise.** One
  `open` per file is the mount's per-file latency, not the bytes: a full pass
  over 1,555 files measures **73 s** (12 readers, the census instrument, cold
  mount). Three rules follow, and all three are load-bearing:
  1. **The 5 s poll stays readdir-only.** It walks `documents/` and compares
     stems; it never opens a book. Header reads happen *after* the scan, in the
     background, on a bounded pool (8).
  2. **Keys are cached in SQLite by `path + size + mtime`** (`device_file_identity`,
     migration 004). Re-reading on every connect is not acceptable, and a file
     *replaced under the same name* has a different size/mtime — so it is read
     again rather than believed. A same-name replacement is otherwise invisible:
     the poll compares stems. The table is derived data — deleting every row
     costs one pass and nothing else.
  3. **Presence is allowed to settle.** `getOnDeviceBookIds` answers with the
     identities that have landed, and the pass broadcasts `deviceContentsChanged`
     as batches of 100 arrive — the event the renderer already recomputes
     presence on, so no new channel. Measured in the app: 1,347 books answered
     **3.9 s** from launch with a warm cache. With an *empty* identity cache the
     same launch answered in ~21 s, but the mount's own page cache was hot from
     the reads this slice had just done — the figure to plan against is the
     73 s above, not 21 s.
  The scan half still decides what *exists*: an identity whose file is no longer
  in the current scan is ignored, so a file removed a moment ago stops counting
  before the pass that would prune it has run. Reproduce the numbers with
  `scripts/device-presence-census.py` (read-only, re-runnable while the app runs;
  it grades the app's rule — see its bucket definitions for what B means).
- **The send button reports what the transfer is doing**, not what the call that
  started it returned: `sendToDevice` resolves the moment the job is _queued_, so
  a button bound to that promise re-enables during the copy. `sendStateFor` reads
  the queue instead — "Sending to {device}…" (disabled) while a job for that book
  is live, "On {device}" from the moment it lands (which is also what covers the
  gap before the scan catches up), and a failed job shows `Couldn't send — retry`
  with the error in its tooltip, alongside the queue panel's own error text and
  Try again. This is the half that made the duplicate above _visible_; the receipt
  is the half that made it impossible.
- **Removing from a device** (`removeBookFromDevice`) is the inverse of
  presence and matches the same way — sanitized title against file stems, the
  names of files we sent under a previous title, and the title and author inside
  each file — so it deletes exactly what made the book read as "on device". The
  content half is not optional: without it a book Calibre wrote reads "On
  {device}" and then refuses to come off, which is the same inconsistency the send
  receipt had to fix, in the other direction. Ambiguity follows the match rule, so
  a title two library books share removes the file that made either read present,
  and the count returned is what the dialog reports. Each matched file takes its
  `._` AppleDouble sibling and its `{book}.sdr` folder with it, which is what
  deleting on the Kindle itself does; reading position and annotations go with
  them. It **re-scans instead of trusting the cached contents** (which are up to
  one poll interval stale — a file added since would survive and keep the book
  present) and refuses paths that resolve outside `documents/`.
  Entry points: the detail panel's trash button beside an "On {device}" button,
  and a "Remove from {device}…" context-menu item; both open
  `RemoveFromDeviceDialog`. The library copy is never touched — removal is
  undone by sending again.

## Testing this area

`electron/main/services/device-manager.test.ts` points `scan()`'s filesystem
calls at a throwaway directory standing in for `/Volumes`, so a fake Kindle can
be plugged in and unplugged without touching the machine's real volumes.

**Every call production code can make has to be rehomed by that stand-in — the
destructive ones first.** It covered `readdir`/`access`/`stat`/`statfs` but not
`fs.rm`, and a test fixture named after a file the attached Kindle really holds
(`Against a Dark Background - Iain M. Banks.azw3`, copied out of the census
output) was deleted off the real device by a passing run. `rm`/`open`/`readFile`
are rehomed now, and fixtures use titles (`The Fixture Codex`) that cannot exist
on a real device while keeping the *shape* the test is about (Calibre's
`{author_sort}/{title} - {authors}.ext`). Two more traps worth knowing:

- `exists()` in that file reads the throwaway `mount` dir the walk tests use, not
  the fake volume the presence tests use — so an
  `expect(await exists(x)).toBe(false)` about a removal passes without anything
  having been deleted. Ask for the volume explicitly.
- Header fixtures are built as **real MOBI bytes** (`test/helpers/mobi.ts`), never
  by mocking the parser: the offsets are the thing under test. The fixture carries
  the shapes the device really has — header lengths 232/248/256/264, EXTH values
  NUL-padded to a 4-byte boundary (3,788 of 36,259 records on this device), record
  0 past 16 KB — and `sanitizeTitle` is what strips the padding, at comparison
  time.

---
