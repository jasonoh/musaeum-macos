# NAS storage & the catalog

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching NAS detection, offline mode, `catalog.json`, or the catalog ⇄ SQLite sync.

---

## NAS / Storage

- Library root is configurable; stored in `app_config` key `library_root`
- **Storage kind**: `app_config` key `library_kind` ∈ `local | network`, resolved **when the folder is chosen** and written beside `library_root` by that same flow (`services/storage-kind.ts` — a `mount`-table scan naming the filesystem, `statfs().type` as a cheap pre-check, and **network only on positive evidence, local otherwise**). It is a fact recorded while the path necessarily exists, not a guess made when it does not: for a root on a share, an unmount takes the mount point with it, so an ancestor walk lands on `/Volumes`, which is the boot disk. Misreading a share as local costs the auto-remount; misreading a folder as a share is the bug this exists to remove. Design: `docs/superpowers/specs/2026-09-24-local-library-design.md` — slice 1 landed 2026-09-24, and that spec's slice 3 writes the local case up in full.
- SMB share for auto-reconnect: `app_config` key `smb_url` (default `smb://ohnas`) — **used only on the `network` path**
- On launch: check whether the root is reachable (`fs.access`)
  - If reachable: proceed normally (also ensures `books/`, `imports/`, `exports/` exist)
  - If unreachable **and the kind is `network`**: attempt auto-reconnect via `open -g smb://…`
    - If reconnect fails: enter **offline/read-only mode**
      - SQLite cache serves all browse and search operations
      - Write operations throw via `nas.assertOnline()` with clear UI feedback
      - Reconnection retried on exponential backoff: 5s → 15s → 60s
      - Non-blocking status banner shown; user can manually retry
      - **A failed attempt always returns to `disconnected`** — `reconnecting` describes the attempt, not the situation, or the "editing is disabled" half of the message is shown once and never again (slice 1, 2026-09-24)
  - If unreachable **and the kind is `local`**: the state is **`missing`**, not offline. A backoff is a claim that waiting is a strategy and for a folder it is false, so **no timer is armed** (`nextRetryMs` is null), **no mount is attempted** — not by the ladder and not by _Retry Now_ — and the recovery is the picker, because something moved the folder and only its owner can say where. The refusal names the folder, never a server (slice 1, 2026-09-24)
- NAS health checked every 30 seconds while app is running
- No hardcoded NAS paths stored in SQLite — all paths relative to library root
- Cover images are served to the renderer via the custom **`musaeum://cover/{bookId}/{thumb|full}`** protocol — the renderer never gets raw `file://` access (CSP enforces this)
- **Multi-machine**: `catalog.json` at the library root is a derived cache of every book's `metadata.json` (which stays canonical). Every metadata write upserts it (bulk ops batch one write) — a deliberate edit or hydration upserts the whole record, but a background push like reading position field-merges only its own fields onto the existing entry, so finishing a chapter on one machine can't clobber an edit made on another; on connect and on "Refresh Library" the local SQLite cache is transactionally replaced from it; "Rebuild Catalog" re-walks `books/*/metadata.json` as recovery. Last-write-wins, one machine at a time. (`services/catalog.ts`, `services/library-sync.ts`)

---

## Book Storage Structure (NAS)

```
{library_root}/
  catalog.json                     # derived cache of all metadata.json (multi-machine)
  books/
    {uuid}/
      {sanitized-title}.epub
      {sanitized-title}.mobi       # cached, generated on demand
      {sanitized-title}.azw3       # cached, generated on demand
      {sanitized-title}.pdf        # original import or Calibre top-up; never converted
      cover_full.jpg               # 600px
      cover_thumb.jpg              # 200px
      metadata.json
  exports/                         # ephemeral; cleared post-transfer
  imports/                         # drag-drop landing zone (watched)
```

---
