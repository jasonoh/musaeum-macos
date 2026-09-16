# NAS storage & the catalog

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching NAS detection, offline mode, `catalog.json`, or the catalog ⇄ SQLite sync.

---

## NAS / Storage

- Library root is configurable; stored in `app_config` key `library_root`
- SMB share for auto-reconnect: `app_config` key `smb_url` (default `smb://ohnas`)
- On launch: check if NAS volume is mounted
  - If mounted: proceed normally (also ensures `books/`, `imports/`, `exports/` exist)
  - If not mounted: attempt auto-reconnect via `open -g smb://…`
  - If reconnect fails: enter **offline/read-only mode**
    - SQLite cache serves all browse and search operations
    - Write operations throw via `nas.assertOnline()` with clear UI feedback
    - Reconnection retried on exponential backoff: 5s → 15s → 60s
    - Non-blocking status banner shown; user can manually retry
- NAS health checked every 30 seconds while app is running
- No hardcoded NAS paths stored in SQLite — all paths relative to library root
- Cover images are served to the renderer via the custom
  **`musaeum://cover/{bookId}/{thumb|full}`** protocol — the renderer never
  gets raw `file://` access (CSP enforces this)
- **Multi-machine**: `catalog.json` at the library root is a derived cache of
  every book's `metadata.json` (which stays canonical). Every metadata write
  upserts it (bulk ops batch one write) — a deliberate edit or hydration
  upserts the whole record, but a background push like reading position
  field-merges only its own fields onto the existing entry, so finishing a
  chapter on one machine can't clobber an edit made on another; on connect
  and on "Refresh Library" the local SQLite cache is transactionally replaced
  from it; "Rebuild Catalog" re-walks `books/*/metadata.json` as recovery.
  Last-write-wins, one machine at a time. (`services/catalog.ts`,
  `services/library-sync.ts`)

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
