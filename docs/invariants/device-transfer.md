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
- Log to `device_history` table (including failures, with error text)
- Transfers run serially through `transfer-queue.ts`
- **On-device presence** is derived by *scanning* the connected Kindle's
  `documents/` folder (not from `device_history`): `device-manager` walks it
  (depth 2) into a `stem → paths` map, and `getOnDeviceBookIds` matches books
  whose `sanitizeTitle(title)` equals a file stem (extension-agnostic).
  Surfaced as a badge on `BookCard` and an "On {device}" state on the
  detail-panel send button. Presence = f(device files, book set), so the
  renderer recomputes it on **both** triggers: `deviceContentsChanged` (device
  side) and `libraryChanged` (book-set side — the on-connect catalog sync loads
  books asynchronously and can finish *after* the device scan, so recomputing
  only on the device event left presence stale at cold start). The 5s device
  poll re-scans a known device's `documents/` and re-broadcasts only when the
  stem set changed (`keysEqual` guard), so presence self-heals when files change
  on the device outside Musaeum or a first scan ran before the volume settled.
  The walk **skips `{book}.sdr` sidecar folders** — the Kindle names the files
  inside them after the book, so descending into one reports a book as present
  from its leftovers alone. Renaming a book renames its NAS files and names
  future sends from the current title, so presence keeps up — but a copy
  *already* on the device keeps the name it was sent under and reads as a
  different book until it is removed and re-sent.
- **Removing from a device** (`removeBookFromDevice`) is the inverse of
  presence and matches the same way — sanitized title against file stems — so
  it deletes exactly what made the book read as "on device". Each matched file
  takes its `._` AppleDouble sibling and its `{book}.sdr` folder with it, which
  is what deleting on the Kindle itself does; reading position and annotations
  go with them. It **re-scans instead of trusting the cached contents** (which
  are up to one poll interval stale — a file added since would survive and keep
  the book present), and refuses paths that resolve outside `documents/`.
  Entry points: the detail panel's trash button beside an "On {device}" button,
  and a "Remove from {device}…" context-menu item; both open
  `RemoveFromDeviceDialog`. The library copy is never touched — removal is
  undone by sending again.

---
