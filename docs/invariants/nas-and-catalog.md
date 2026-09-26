# NAS storage & the catalog

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching NAS detection, offline mode, `catalog.json`, or the catalog ⇄ SQLite sync.

---

## Storage and the library root

> The file keeps its `nas*` name, and so do the identifiers behind it — `NASState`, `NASStatus`, `nas-manager.ts`, `nas.store`, `Book.nasPath`. That asymmetry is deliberate and recorded in the design (`docs/superpowers/specs/2026-09-24-local-library-design.md`, D8: only user-visible strings change); nothing a user reads says NAS.

- Library root is configurable; stored in `app_config` key `library_root`
- **Storage kind**: `app_config` key `library_kind` ∈ `local | network`, resolved **when the folder is chosen** and written beside `library_root` by that same flow (`services/storage-kind.ts` — a `mount`-table scan naming the filesystem, `statfs().type` as a cheap pre-check, and **network only on positive evidence, local otherwise**). It is a fact recorded while the path necessarily exists, not a guess made when it does not: for a root on a share, an unmount takes the mount point with it, so an ancestor walk lands on `/Volumes`, which is the boot disk. Misreading a share as local costs the auto-remount; misreading a folder as a share is the bug this exists to remove. Design: `docs/superpowers/specs/2026-09-24-local-library-design.md` — all three slices landed 2026-09-24, and its slice 3 wrote the local case up in full (the bullets below).
- SMB share for auto-reconnect: `app_config` key `smb_url` — **used only on the `network` path**, and **it has no default**. The compiled-in `smb://ohnas` was removed by slice 2 of the local-library design (`DEFAULT_SMB_URL` is gone; `services/settings.ts:59` keeps `SMB_URL_EXAMPLE = 'smb://server/share'` for the validation refusal alone), because a _folder_ with a share configured had `open -g smb://ohnas` run on its behalf. The resolved view and the row's own note are asserted to name no server (`settings.test.ts`, `storage-copy.test.ts`), and Settings renders the field only when the kind is `network`
- On launch: check whether the root is reachable (`fs.access`)
  - If reachable: proceed normally (also ensures `books/`, `imports/`, `exports/` exist)
  - If unreachable **and the kind is `network`**: attempt auto-reconnect via `open -g smb://…`
    - If reconnect fails: enter **offline/read-only mode**
      - SQLite cache serves all browse and search operations
      - Write operations throw via `nas.assertOnline()` with clear UI feedback
      - Reconnection retried on exponential backoff: 5s → 15s → 60s
      - Non-blocking status banner shown; user can manually retry
      - **A failed attempt always returns to `disconnected`** — `reconnecting` describes the attempt, not the situation, or the "editing is disabled" half of the message is shown once and never again (slice 1, 2026-09-24)
  - If unreachable **and the kind is `local`**: the state is **`missing`**, not offline. A backoff is a claim that waiting is a strategy and for a folder it is false, so **no timer is armed** (`nextRetryMs` is null), **no mount is attempted** — not by the ladder and not by _Retry Now_ — and the recovery is the picker, because something moved the folder and only its owner can say where. The refusal names the folder, never a server (`nas-manager.ts:120`: _"The library folder is missing — choose where it went to make changes."_; slice 1, 2026-09-24)
    - The recovery it offers is **_Locate Library Folder…_**, which opens `chooseLibraryRoot` **pre-pointed at the root that went missing** — or at its nearest surviving ancestor, because `showOpenDialog` ignores a `defaultPath` that does not exist (`services/storage-kind.ts`'s `survivingAncestor`; slice 2, 2026-09-24). It reuses the picker rather than inventing a second adopt flow: that flow already knows how to peek for a `catalog.json` and ask whether to use it, which is exactly the question a moved library raises
    - The 30-second poll still runs over a `missing` root, so a re-plugged drive or a folder that reappears is noticed and returns the app to `connected` — a poll is `fs.access`, not a retry; nothing is _done_ on the library's behalf until it is back
- **One place composes every sentence about storage, and it is the main process.** `services/storage-copy.ts` is `(state, kind, nextRetryMs) → { message, label, recovery, deleteBlocked }`, and the sidebar's status row, the banner, Settings and **both delete dialogs** are readers of it (`Sidebar.tsx`, `NASStatusBanner.tsx`, `SettingsModal.tsx`, `DeleteBookDialog.tsx`, `DeleteSelectionDialog.tsx`). `deleteBlocked` exists because the dialogs carry **no recovery control**: the banner's sentence states the situation and leaves the verb to the button beside it, and a dialog has to name the verb itself — so a folder that has moved reads _"The library folder is missing — choose where it went before deleting."_ where all four unreachable states read _"…offline — reconnect before deleting."_ until 2026-09-24 (the second residue slice 2 recorded, built that day: 3 code files + 1 contract field + 2 test files). **Two surfaces still hand-type that sentence and one refusal keeps its own copy** — `SelectionPanel.tsx`'s _reconnect to act_, `BookEditor.tsx`'s _reconnect before saving_, and `assertOnline()`'s toast, which for `missing` and `disconnected` shares this copy's stem and parts from it in the closing clause (_to make changes_ against _before deleting_) and for `unconfigured` is worded outright differently (it points at Settings, the notice at the picker) — three sentences for three moments, which is why it stays apart — all three filed in `tasks.md` rather than reached into. It exists because both surfaces used to carry their own nested ternary over `NASState`, so a folder that had moved fell through both to the dropped-share copy — _"Library offline — browsing from cache, editing disabled."_, with no retry clause, which is the only thing that makes that sentence honest — beside a _Retry Now_ whose only effect was a no-op; and because a sentence composed in main is assertable in a unit test (39 cases) where one typed inside a component is not. `src/lib/storage-copy-scan.test.ts` keeps it in the gate: no `.ts`/`.tsx` under `src/` may carry a bare `NAS` or an `smb://` URL, and no sentence the composer owns may be restated there (comments stripped, so prose about the rule is documentation; samples composed from parts, so the walk does not redden on itself). **Its named limit:** the walk proves no renderer hand-types a sentence — not that a surface _draws_ the composed one, which only a rendered read can show — and it keeps only the sentences the composer _owns_, so a sibling that types its own sentence outside that list (`SelectionPanel.tsx`, `BookEditor.tsx`, `assertOnline()`; all three named above and filed in `tasks.md`) is invisible to it by construction rather than by oversight
- **The kind changes the recovery and the words, and nothing else.** Every other storage decision here is path-generic, and was before this feature — which is why a folder on this Mac was already a working library: the catalog (written at the root, adopted on connect), the write gates (`nas.assertOnline()` — 16 call sites across 12 modules, grep 2026-09-24), the relative-path rule below, the `musaeum://` cover and book-byte routes, hydration, the `imports/` watcher and the REST surface all behave identically for a folder and a share. Only the two behaviours above differ, and a future recovery question should be asked in those terms — _does this change what an unreachable root does, or only what it says?_
- **A cloud-synced root is named, not policed** (slice 2, D7): a root inside iCloud Drive, Dropbox, Google Drive, OneDrive, Box or Proton Drive gets one line in Settings naming the client and the last-write-wins hazard, and the eviction clause is claimed for **iCloud alone** because that is the only client it was measured for. Nothing is refused, and the table is measured from the real folder shapes rather than assumed: `~/Library/CloudStorage` is open-ended, so an unlisted client there is reported **by the name it spells** rather than as "not synced" (`services/storage-kind.ts`)
- Health checked every 30 seconds while the app runs — for **both** kinds, since the check is `fs.access` on a folder and it is what makes an ejected drive visible within 30 s. A `missing` root is _checked_ and never _retried_, which is the distinction the two words exist to make
- Nothing absolute is stored in SQLite — every book path is relative to the library root (the column keeps its `nas_path` name; D8)
- Cover images are served to the renderer via the custom **`musaeum://cover/{bookId}/{thumb|full}`** protocol — the renderer never gets raw `file://` access (CSP enforces this)
- **Multi-machine**: `catalog.json` at the library root is a derived cache of every book's `metadata.json` (which stays canonical). Every metadata write upserts it (bulk ops batch one write) — a deliberate edit or hydration upserts the whole record, but a background push like reading position field-merges only its own fields onto the existing entry, so finishing a chapter on one machine can't clobber an edit made on another; on connect and on "Refresh Library" (Settings' Reload, **⌘R**, or the icon beside the sidebar's Library label) the local SQLite cache is transactionally replaced from it; "Rebuild Catalog" re-walks `books/*/metadata.json` as recovery. Last-write-wins, one machine at a time. (`services/catalog.ts`, `services/library-sync.ts`)

---

## Book Storage Structure

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
