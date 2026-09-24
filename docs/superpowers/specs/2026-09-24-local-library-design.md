# Design: a library on a local disk (storage kind, recovery, and the copy that assumes SMB)

**Date:** 2026-09-24
**Status:** **Slice 1 built and committed (`6aff1a1`, 2026-09-24); slices 2–3 outstanding.** Both forks are settled by the owner: **F1 — the kind is stored**, resolved at pick time, shown in Settings, with the status sentences composed in the main process so a unit test can assert them; **F2 — a cloud-synced root is named, not refused**. Slice 2's annex is `docs/superpowers/plans/2026-09-24-local-library-slice2.md`, and its `## Start here` block is the shortest way in. The evidence below was measured in the running app 2026-09-24, before the build (transcripts in §What was measured; the pre-fix frames and the `open` shim's log survive in the probe profile the annex names).
**Scope:** a library that lives on a local disk (internal, external, or a folder on this Mac) as a first-class storage *kind*: which recovery a missing root takes, what the app calls unavailability, and the words the UI uses. Deliberately does **not** touch: the catalog ⇄ SQLite sync, `metadata.json`'s shape, path storage, the `musaeum://` routes, the REST API, hydration, or device transfer.
**Depends on:** `docs/invariants/nas-and-catalog.md` (the root, offline mode, the catalog), `docs/invariants/settings-and-editing.md` (`app_config`, and the rule that the library root keeps its own flow rather than joining the batched save).
**Interacts with:** `NASStatusBanner.tsx`, `Sidebar.tsx`'s status row, `SettingsModal.tsx`'s Library section, `DeleteBookDialog.tsx` / `DeleteSelectionDialog.tsx`, and the empty view + Add Books built by `docs/superpowers/specs/2026-09-20-library-onramps-and-maintenance-design.md`.
**Supersedes:** nothing.

---

## Why now

The owner's question, 2026-09-24: *"for people who don't have this more complex setup and want to setup a local-disk library, can musaeum yet support a local (non-nas/smb) library on the disk?"*

**It already does, by accident — and the accident is not free.** Every storage decision in the app is path-generic: the root is any directory, "is it up?" is `fs.access`, and every write gate asks `assertOnline()`. Nothing anywhere asks *what kind* of storage it is. What is NAS-specific is a single assumption baked into one function: that an unreachable library is unreachable **because a share dropped**, so the recovery is to re-mount it. For a local folder that assumption is false, and the app's response to it is to shell `open -g smb://ohnas` forever.

The thesis this design turns on: **the storage layer never needed a NAS; the availability *vocabulary* did.** A share is "unreachable and will come back on its own" — retry, with a backoff, is the right response. A local folder is "unreachable because you changed something" — a retry cannot fix it and the user must be asked. Both are one state machine today, and it is written for the first case.

This is worth a slice now because the second audience is the larger one. A Calibre refugee with a laptop and no NAS cannot set Musaeum up today without being told to reconnect a server they do not own — and the fix is bounded, invariant-free, and lands in two files' worth of decisions plus the copy.

---

## What was measured, in the running app (2026-09-24)

Not read off the tree — driven. Isolated profile (`MUSAEUM_USER_DATA`), `library_root` = a plain directory on the boot disk, the built `out/` launched with `--remote-debugging-port=9223`, one synthetic EPUB imported over the real IPC, and **`open` shimmed on `PATH`** so every mount attempt the main process makes is logged with its arguments.

| # | Reading | Evidence |
| --- | --- | --- |
| 1 | A local root is `connected` with no NAS involved | Sidebar read `MUSAEUM \| Library \| 0 \| FILTERS \| Library connected`; `books/ imports/ exports/` created in the folder |
| 2 | **Zero** mount attempts while the root is reachable | The shim log held one line, and it was the shim's own smoke test |
| 3 | Import works end to end | `import.addFiles` → `{success: true, bookId: 7f1004b3…}`; `<root>/books/7f1004b3…/The Local Shelf Probe.epub` + `metadata.json` |
| 4 | The byte copy is exact | `md5` source `f720afd353d8f3c869b7f225e54bc207` == copy `f720afd353d8f3c869b7f225e54bc207` |
| 5 | Sort keys are derived on the local path (invariant 4) | `metadata.json` carries `"sort_title": "Local Shelf Probe, The"` and `sort: "Author, Probe"` |
| 6 | No absolute path is stored (Phase-1 staging claim 4) | SQLite `nas_path` = `books/7f1004b3-d3c2-4265-ba63-139948dbbbfc` |
| 7 | The reader opens from a local root | `foliate-view.book` → `{title: "The Local Shelf Probe", author: "Probe Author", sections: 2}`; frame shows *Opening Shelf* and the chapter's probe sentence |
| 8 | Reading state round-trips through a local catalog (invariant 5) | `metadata.json` **and** `catalog.json` both carry `read_status: "reading"` + `readingState.position: "epubcfi(/6/2!/4,/2,/4/1:48)"`, 49.05 %; DB wiped to **0 rows**, relaunch adopted from the local `catalog.json` → 1 row and the sidebar's `STATUS \| Reading \| 1` facet |
| 9 | **The failure mode: a missing local root triggers an SMB mount** | Root renamed away; shim log `11:02:39 ARGS: -g smb://ohnas`, then `11:03:00`, then `11:04:05` — the 5 s / 15 s / 60 s backoff, repeating |
| 10 | **`Retry Now` — the only recovery the UI offers — runs the same SMB mount** | Clicked it; a fourth `open` arrived 2 s later (`11:02:03` after `11:02:01`) |
| 11 | The app never settles into "offline" | `Library offline — browsing from cache, editing disabled. Retrying in 5s.` for four samples, then `Reconnecting to the library…` for the next 20+ over 60 s, unchanged |
| 12 | A write on a local library tells the user to fix a NAS | `import.addFiles` → `"The library is offline. Reconnect to the NAS to make changes."` (toast, verbatim, in the frame) |
| 13 | The SMB default is the owner's own server, in a shipped default | `smb_url` was deliberately left unset; recovery used `smb://ohnas` (`services/settings.ts:47`) |
| 14 | Not every `/Volumes/` path is a share — on this machine | `mount`: `/dev/disk6s2 on /Volumes/data (hfs, local, …)` alongside `//oh@ohnas…/books on /Volumes/books (smbfs, …)` |

Frames were captured at `<scratch>/musaeum-localprobe/frames/` (`01-local-library`, `03-local-reader-frame`, `05-retry-now-smb`) — scratch is pruned, so treat them as illustrative. The procedure in §Handoff re-derives every reading above.

**Reading 14 is the reason F1 exists.** The obvious inference — *a root under `/Volumes/` is a share* — is false on this machine, with a local HFS+ volume living there. So is its cousin *`fs.statfs().type` tells you*: measured, the same call returns `26` for APFS (`/`, `/Volumes/Macintosh HD`), `25` for the local HFS+ volume, and `30` for every `smbfs` share. `30` naming the network is real but is a whitelist of one measured constant, and nothing guarantees the next filesystem (a USB stick, exFAT, NFS) lands on the right side of it.

---

## What already exists, read off the tree

| Fact | Where |
| --- | --- |
| The root is any directory; the picker is a plain directory dialog | `ipc/nas.ts:16-23` |
| "Is it up?" is `fs.access` — a local folder is `connected` | `nas-manager.ts:67-74`, `:82-107` |
| Every write gate funnels through `assertOnline()` / `isOnline()` | `nas-manager.ts:45-57`; 14 call sites (book-delete, cover-choice, conflicts, transfer-queue, importer, bulk-hydrate, apple-books, migration, reading-state, library-sync, file-access, api/upload) |
| Import copies with `fs.copyFile` — cross-device safe, so a second disk behaves | `importer.ts:247`, `:571` |
| Covers and book bytes realpath **both** sides, so symlinks and `/tmp`→`/private/tmp` are handled | `book-bytes.ts:83-91` |
| The catalog is written at the root and adopted on connect | `library-sync.ts:190-201` |
| The `imports/` watcher arms on connect and disarms otherwise | `file-watcher.ts:15-32`, `:50-56` |
| The status banner's copy is already storage-neutral | `NASStatusBanner.tsx:17-36`, `:40-62` |
| The sidebar's status row is not | `Sidebar.tsx:87-96` |
| `libraryRoot` is deliberately **not** in `EditableSettings` — it has its own flow | `src/types/settings.types.ts:10-36`; `settings-and-editing.md:34` |
| The **only** SMB-specific code in the main process | `nas-manager.ts:127-138` (`open -g`), `settings.ts:47` + `:126-128` + `:231-235` (`smb_url`, its default and its validation) |
| `NASState` / `NASStatus`, and the two components that switch on it | `src/types/metadata.types.ts:159`, `:182-188`; `Sidebar.tsx:87-96`; `SettingsModal.tsx:344-350` |

**Not true today, and inside this feature rather than free:**

- **There is no `nas-manager.test.ts`.** The module that owns the app's recovery behaviour has no direct suite; its behaviour is covered only incidentally by the suites that call `setLibraryRoot(tmpdir)`. This slice puts a decision in it, so it needs one.
- **`state === 'connected'` is re-derived in six components** (`BookDetail`, `SelectionPanel`, `DeleteBookDialog`, `DeleteSelectionDialog`, `BookEditor`, `SettingsModal`) and two more read `state` for copy (`Sidebar`, `NASStatusBanner`). Adding a union member fans out to all of them; the ones that only gate a button are fine (they want "can I write"), but the two that *render state* must learn the new member or they will fall through to `Offline`.

---

## The two defects, precisely

**D-A — the recovery path is SMB-only.** `reconnect()` (`nas-manager.ts:121-142`) is the app's entire answer to an unreachable root. It is called by the backoff timer (`:109-119`), by the banner's *Retry Now*, and by the sidebar's row. When the root is missing it shells `open -g '<smb_url>'` and waits five seconds for a mount to appear. For a local root there is **nothing to mount and nothing that could come back** — readings 9, 10 and 13. The user is offered a button whose only effect is a failed connection to a server they do not have.

**D-B — the state machine never returns to `disconnected`, so the app claims to be reconnecting forever.** `reconnect()` begins with `setState('reconnecting')` (`:125`), and `checkHealth()` only downgrades to `disconnected` when the current state is *not* `reconnecting` (`:103`). So after the first automatic retry the state is pinned at `reconnecting` until it succeeds, and the banner — whose informative branch is keyed on `disconnected` (`NASStatusBanner.tsx:44-51`) — never shows it again. Measured: the copy *"Library offline — browsing from cache, editing disabled. Retrying in 5s."* was visible for four samples, then *"Reconnecting to the library…"* for the remaining 20+ across a minute.

**D-B is not a local-disk bug.** It hits every NAS user whose share is away for more than five seconds: the app stops telling them the library is offline and editing is disabled, and instead implies it is mid-recovery, indefinitely. It is filed here because reading 11 is where it surfaced, and because the fix is the same state machine.

---

## D1 — Storage kind is a fact recorded when the root is chosen, not a guess repeated at every failure

**Decision (recommendation — this is fork F1):** add `app_config` key `library_kind ∈ {'local','network'}`. It is resolved **at pick time**, when the root necessarily exists and the whole path can be asked about, and it is written alongside `library_root` by the same flow (`ipc/nas.ts`'s `chooseLibraryRoot`). It is shown in Settings → Library and can be changed there.

**Why at pick time, and why stored.** The question "what kind of storage is this path?" can only be asked while the path exists — and the moment it matters is exactly when it does not. The ancestor walk that would answer it later is unavailable for the flagship case: when `//ohnas/books` unmounts, `/Volumes/books/Musaeum` is gone *and so is `/Volumes/books`*, so walking up lands on `/Volumes`, which is the boot disk. Deriving the answer at failure time therefore requires remembering the path *shape*, which is the stored fact under a different name. Storing the resolved kind is honest: it is a fact about where the user chose to put the library, it does not change when the path temporarily does, and re-picking is the one event that re-derives it.

**Why the inference must be an *inference with a visible answer*, not a silent rule.** Reading 14 kills the path-prefix test with a counterexample on this machine. The measured signal that does work is the mount table: a `mount` scan naming the filesystem containing the path (`smbfs`, `afpfs`, `nfs` → network; `local` and any other fs type → local), with `fs.statfs(root).type === 30` as a cheap pre-check. Both were measured here; neither is a complete theory of filesystems, so: **network only on positive evidence, local otherwise**, and the answer is *displayed* next to the root so a wrong guess costs one click rather than a silently wrong recovery. The asymmetry is what makes the default safe — misreading a network share as local costs the auto-remount (the user still has *Retry Now* and the picker), whereas misreading a local folder as network is the bug this slice exists to remove.

**Consequence:** `SettingsView.values` gains a field that the batched save must not accept (the `libraryRoot` rule, `settings-and-editing.md:34`), so `EditableSettings` omits it exactly as it omits `libraryRoot` — unless the Settings row edits it directly, in which case it goes through its own handler beside `nas:setLibraryRoot`. A storage kind that is stored is a stored fact that can go stale if a library moves between an SMB share and a disk; the picker re-derives on every pick, which is the mitigation, and Settings' display is what makes the stale case visible.

## D2 — A missing local root is `missing`, not `offline`, and it does not retry

**Decision:** `NASState` gains `'missing'`. `checkHealth()` sets it when the root is absent **and** the kind is local. A `missing` root schedules no reconnect, arms no backoff, and reports `nextRetryMs: null`. The recovery it offers is *Locate Library Folder…*.

**Why:** a backoff is a claim that waiting is a strategy. For a share that is true — shares come back. For a folder it is false, and the retry's only observable effects are three `open` calls a minute (reading 9) and a banner that lies (reading 11). The distinction also makes the *fix* legible: `offline` means "come back later", `missing` means "tell me where it went".

**Consequence:** the banner, the sidebar row and the Settings row each gain a case. `'missing'` must not be `'disconnected'` with different words — the *behaviour* differs (no timer), so a state that only changes copy is the wrong shape; and the `nextRetryMs` field must actually be null or the banner's `Retrying in Ns` will render for a state that is not retrying.

## D3 — `reconnect()` can return to `disconnected` (D-B's fix)

**Decision:** the state machine gets an explicit notion of "a retry attempt is in flight" that is not the same thing as the connection state. `reconnecting` describes *now*; `disconnected` describes *the share is away and a timer is armed*. A failed attempt must land back in `disconnected` so the informative copy is reachable more than once.

**Why:** reading 11. The current pin is a one-line condition (`:103`) whose cost is the app hiding "editing is disabled" from the user for the whole time it matters. This is a sibling fix, not a rewrite: the state union already has the member; the transition is what is missing.

**Consequence:** `reconnecting` becomes a genuinely transient state, so the `reconnecting` flag the renderer holds for the button's spinner (`nas.store.ts:25-33`) is no longer doing the same job as the main process's state — the two must not be conflated by the fix. Any change here is testable for the first time, which is why D6's suite is a prerequisite for this decision rather than a consequence of it.

## D4 — The UI names the storage, from one place, in the main process

**Decision:** `NASStatus` gains the resolved `kind`, and the renderer renders sentences composed **in main** — one per state — rather than branching on state itself. The storage kind is passed through as a fact; the words are not invented in the renderer.

**Why:** the house pattern already exists (`settings-and-editing.md`'s *the row renders the socket; it does not describe it*), and the alternative is what the app does today: two components each carry their own nested ternary over `NASState` (`Sidebar.tsx:89-95`, `SettingsModal.tsx:344-350`), so a new state is a new branch in both and the two can disagree. It also makes the user-visible strings assertable in a unit test instead of only by eye.

**Consequence:** one new module composes the copy and owns every string this slice changes; `Sidebar`, `NASStatusBanner` and `SettingsModal` become readers. The banner's two already-good sentences (`No library folder configured — …`, reading-neutral) are the model. `state === 'connected'` stays where it is in the six write-gating components — they are asking "can I write", which is not a wording question.

## D5 — The SMB row is gated on the kind; the resolved view stays total

**Decision:** Settings → Library renders the SMB URL field only when the kind is `network`. `SettingsView.resolved.smbUrl` keeps its shape and its value regardless, and `DEFAULT_SMB_URL` is only ever *used* on the network path.

**Why:** a field whose placeholder is a server the user does not own (`settings.ts:126-131` resolving the compiled-in `smb://ohnas` as `source: 'default'`) is worse than an absent one: it invites the reading "this app expects something from me here". Keeping the view total rather than making the field conditional *in the type* avoids churning a shared interface for a render-time decision — the same reason the row renders the listener's report whole.

**Consequence:** `DEFAULT_SMB_URL` should lose its personal value in favour of an empty/blank resolved state, or the word "default" in that row keeps meaning `ohnas`. Either way, this is the only place a personal server name is compiled into the product.

## D6 — The recovery for a local library is the picker, pre-pointed

**Decision:** a `missing` local root's action is *Locate Library Folder…*, opening the existing `chooseLibraryRoot` dialog (a new handler parameter that pre-points it at the last known root, or its nearest surviving parent). That flow already does the right things — it peeks for a `catalog.json`, asks whether to adopt it, and holds the on-connect apply until the user answers (`ipc/nas.ts:24-46`), which is exactly the question a moved library raises.

**Why:** it reuses the one flow that already knows how to answer "this folder already holds a library — use it?", so a user who renamed `~/Books` to `~/Reading` gets their library back with no new concepts, no adoption dialog to invent, and no risk of the app re-adopting a stale catalog silently.

**Consequence:** the button in the banner and the row in Settings must both call it, and both must be reachable when the root is `missing`. `chooseLibraryRoot` currently returns the chosen root and applies the catalog itself; the Locate path is the same call, so the only new main-process work is the pre-point hint.

## D7 — A cloud-synced root is *named*, not policed (fork F2 — recommendation)

**Decision (recommendation):** when the chosen root sits inside a known sync root (`~/Library/Mobile Documents`, `~/Library/CloudStorage/*`, `~/Dropbox`, `~/Google Drive`, `~/OneDrive`), Settings says so in one line — that a second machine writing the same library is outside the "one machine at a time" rule the catalog documents (`nas-and-catalog.md:27`), and that iCloud may evict file contents. No refusal, and no new machinery.

**Why:** the hazards are real but neither is verifiable cheaply from here, and a *block* would be the wrong posture for an app that already accepts a folder on a share two machines write. A sentence costs nothing and reaches the user at the moment they pick. Refusing would need evidence this design does not have: whether a dataless file actually degrades a cover read, and how the catalog behaves when two machines write it concurrently through a sync client. Those are their own slices with their own measurements.

**Consequence:** the copy must not promise more than is known — it says "this folder is synced by <client>; a second machine writing it can lose changes", not "unsupported". If it ever becomes a refusal, the condition is a measurement, not a taste.

## D8 — Non-decision: the internal names stay `nas*`

**Decision:** the `nas:getStatus` / `nas:setLibraryRoot` / `nas:reconnect` channels, the `NASState` / `NASStatus` types, `nas-manager.ts`'s filename, the `nas.store`, the renderer's `nas` key and `Book.nasPath` are **not** renamed. Only user-visible strings change.

**Why:** renaming them touches ~20 files across both processes for zero behaviour, which is exactly the drive-by churn the repo's conventions forbid; and `nasPath` in particular is a field name inside the metadata contract's neighbourhood, where a rename has an audience outside this repo (the iOS client and `docs/rest-api.md`). A future rename is its own mechanical slice, with no invariant and no reasoning attached.

**Consequence:** the code will keep saying NAS where the UI says "library folder". That is a deliberate asymmetry this paragraph exists to record, so nobody reads it later as an oversight.

---

## Slices, and why they are cut this way

**Slice 1 — main: the kind, the state, and the recovery (7 files: 4 code + 1 new module + 2 test files).**
New: `services/storage-kind.ts` (the resolver: mount-table scan, `statfs` pre-check, the local default) and `nas-manager.test.ts` (the module has none today). Edited: `nas-manager.ts` (the `missing` state, the no-retry rule, the kind-aware `reconnect`, D-B's transition), `settings.ts` (the key, its validation, the resolved view), `ipc/nas.ts` (write the kind on pick; the pre-point parameter), `src/types/metadata.types.ts` (`NASState` + `NASStatus`). Cut here because all of it is decidable without a screen — a fixture root and a fake `open` are enough to assert which recovery a state takes.

**Slice 2 — renderer: the surfaces (7-8 files + 1 test).**
New: the copy module (`src/lib/storage-copy.ts` or a `@shared` home — F1's answer decides whether the strings live in main at all; if they do, they are composed in `nas-manager`/`settings` and the renderer only reads). Edited: `NASStatusBanner.tsx`, `Sidebar.tsx`, `SettingsModal.tsx` (the SMB row gate, the kind display, the Locate button, the sync-root line), `DeleteBookDialog.tsx` and `DeleteSelectionDialog.tsx` (the "from the NAS" copy), `nas.store.ts` if the reconnect flag needs to follow D3. Cut after slice 1 because every string it renders is a fact slice 1 starts emitting.

**Slice 3 — the record (3-4 files).**
`docs/invariants/nas-and-catalog.md` gains the local case — the file already says "library root is configurable" and stops short of saying what that means, which is how this gap survived — plus `README.md`'s setup (today it assumes a share), `tasks.md`'s entry replaced by what landed, and `CHANGELOG.md` at land time.

Slice 1 is the whole decision surface; if the copy module pushes slice 2 past the house bound, the cut moves to "the banner and the sidebar" / "Settings and the dialogs" rather than either half being dropped.

---

## Acceptance criteria

### Slice 1

1. A local root that exists reports `connected` and writes the library dirs (decider: vitest on a `mkdtemp` root — the reading-1 mechanism, now with the kind explicitly `local`).
2. A local root that is missing reports `missing`, with `nextRetryMs === null`, and **no** `open` is attempted — asserted over a real timer window, not by inspection (decider: vitest with `child_process.exec` spied, root deleted mid-test, timers advanced past the first backoff interval).
3. A network root that is missing still reports `disconnected`/`reconnecting`, still schedules its backoff, and still shells the mount (decider: vitest, same spy, `library_kind: 'network'` — this is the criterion that stops the slice from quietly deleting the NAS feature).
4. The kind resolver answers `local` for a temp dir and the real boot disk, and `network` for a mounted `smbfs` path — with `/Volumes/data`-shaped input (a local volume under `/Volumes/`) resolving to `local` (decider: vitest against captured `mount` output, plus one live case on this machine).
5. After a failed reconnect attempt the state returns to `disconnected`, so the informative copy is reachable a second time (decider: vitest on the state sequence, ≥2 attempts).
6. Picking a root writes both `library_root` and `library_kind` in one flow, and a later launch reports the stored kind (decider: vitest over `ipc/nas.ts`'s handler with a stubbed dialog).
7. `npm run typecheck` / `npm run lint` clean (decider: the gates).

### Slice 2

8. With a local root that is missing, the banner renders the storage-correct sentence and offers *Locate Library Folder…*, and the accessibility tree contains no string matching `NAS` (decider: CDP probe on an isolated profile with a deleted root — the reading-11 fixture).
9. With a local root, Settings → Library renders no SMB field (decider: CDP probe reading the modal's text).
10. With a network root, the SMB field still renders (decider: CDP probe, `library_kind: 'network'`).
11. A write attempted while a local root is missing reports a sentence that names no server (decider: CDP probe driving `import.addFiles` and reading the toast — reading 12, inverted).
12. The delete dialogs' copy names the library, not the NAS (decider: source walk of the two files, since reaching the dialog needs a device round trip; state that limit).
13. The status rows' three states render from one composer rather than two ternaries (decider: `git diff` showing the ternaries gone from `Sidebar.tsx` and `SettingsModal.tsx`).

### Slice 3

14. `docs/invariants/nas-and-catalog.md` carries the local case: what `local` changes (recovery, no retry) and what it does not (the catalog, the gates, the routes) (decider: the doc, reviewed against this spec's D1–D6).
15. `README.md`'s setup no longer implies a share is required (decider: read the setup section against reading 1–8).

**Regression to hold, on both kinds:** the eight readings 3–8 must still pass on a local root after the change — import, exact copy, derived sort keys, relative path, reader, and the reading-state round trip. The cheapest decider is to re-run this spec's procedure on a fresh probe root and compare against the table above.

---

## Slice 2 — landed 2026-09-24, with the pre-fix value beside each

Annex: `docs/superpowers/plans/2026-09-24-local-library-slice2.md`. Every value is measured on the working tree; the "before" column is this spec's own reading or the falsified run, so the claim has something to be wrong against.

| What | Before | After (slice 2) | Instrument |
| --- | --- | --- | --- |
| A `missing` local root's banner sentence | *"Library offline — browsing from cache, editing disabled."* (reading 11's fall-through) | *"Library folder missing — browsing from cache, editing disabled."* | CDP probe, reading-11 fixture (`frames/06-…`) |
| That state's one button | *Retry Now* — a no-op since slice 1 | *Locate Library Folder…*, hinting `libraryRoot` (D6) | same probe, plus its accessibility tree |
| The sidebar row's word | *Offline* | *Folder missing* | same probe |
| Settings → Library, local library | an `SMB URL` row placeholder-ing `smb://ohnas` | no SMB row at all, beside *Storage: Local folder* | CDP probe (`frames/08-…`) |
| Settings → Library, `library_kind: network` | (unreachable — the row was drawn for everyone) | the field, empty, noting *"No share set — the app will not mount one for you…"*, with **no placeholder** | CDP probe (`frames/09-…`) |
| A refused write, as shown to the user | *"The library is offline. Reconnect to the NAS to make changes."* (reading 12) | *"The library folder is missing — choose where it went to make changes."*, in a toast | probe driving `import.addFiles` (`frames/07-…`) |
| Strings matching `NAS` in the accessibility tree | (not measured before) | **0** of 133 nodes | `Accessibility.getFullAXTree` over CDP |
| The delete dialogs' copy | *"…from the NAS."* | *"…from the library folder."* | source walk, now in the gate |
| Mount attempts across the whole probe | 3 lines in the shim log, and forever (reading 9) | **0 new** — the log still holds its same three pre-fix lines | the `open` shim's log |
| Typecheck / lint / build | — | **0 / 0 / 0** | the gates |
| Suite | 1445 tests, 62 files (slice 1) | **1500 tests, 64 files** | `npm test` |
| Sidecar suite | 113 | **113 passed** | `pytest` |

**The file table in this spec's own slice row was wrong, and the correction is the one the annex predicted.** The row said "7–8 files + 1 test", renderer only. What landed is **17 files: 12 code + 5 test** — because D4's answer puts the copy in the main process, `NASStatus` gains a composed field, and D6's hint is unreachable from the renderer without a contracts change. The two rows it did not carry: `src/types/metadata.types.ts` + `electron/main/services/nas-manager.ts` (D4's field and its call site) and `src/types/api.types.ts` + `electron/preload/index.ts` (D6's pass-through). The copy module is `electron/main/services/storage-copy.ts`, not `src/lib/` — F1's answer settled it as main-composed.

**The five decisions this spec left open, as taken** (each with the alternative it beat, per the annex):

1. **The composer is its own pure module** — `(state, kind, nextRetryMs) → { message, label, recovery }`, needing no database, so all 31 assertions about the words live in one place, which is D4's whole point.
2. **`DEFAULT_SMB_URL` is gone** — blanked, with the row's empty state carrying *"the app will not mount one for you"*. `smb://ohnas` no longer exists in the product; the one `smb://` literal left in main is `SMB_URL_EXAMPLE = 'smb://server/share'`, which is what the validation refusal quotes.
3. **The sync-root table is measured and open-ended** — iCloud Drive (both spellings), Dropbox, Google Drive, OneDrive, Box and Proton Drive are mapped from the real folder shapes in `~/Library/CloudStorage`; anything else there is reported *by the name it spells*, because that directory is open-ended and a whitelist would answer "not synced" for a folder that is. The eviction clause is claimed for iCloud alone.
4. ***Locate* replaces *Retry Now*** for `missing` — a button whose only effect is a no-op is worse than an absent one, which is D5's own argument.
5. **The empty view was not reached into** — `EmptyLibrary` is not storage-aware, and the banner's affordance is app-level, so it is already on screen above that pane. Recorded as residue rather than expanded (below).

**Falsified, not merely green:** 13 mutations, each breaking one claim, each turning its own gate red — the missing folder's sentence; the recovery `missing` offers; the retry clause with nothing armed; the `missing` + `network` guard; `copy` dropped from the status (a *compile-time* red, since the field is required); the SMB default; the unset-share note; a hostname compiled back into the mount; the unknown-client fallback; the iCloud clause inverted; a surface restating a composed sentence; a surface restating a message; and the dialogs saying "NAS" again. **The announce fix was falsified by construction:** its case was written first and failed on the unfixed tree (one entry where two are required), then passed after the fix.

**One defect the probe found that this slice had to fix, and did.** The status was announced only when the *state* changed — `setState` returned early — so the *kind* moving on its own never reached a surface. A re-pick that swaps a folder for a share keeps the state at `connected`, which left Settings rendering the old kind and the SMB row wrongly shown or wrongly hidden. Found by AC10 itself (the criterion that reads Settings with `library_kind: 'network'` failed on the probe's first run), fixed by announcing on any change to `(state, kind, libraryRoot)` — with `nextRetryMs` deliberately outside the comparison, because it is a countdown.

**Residue, recorded rather than reached into** (the annex's item-5 rule, applied twice more):

- **`EmptyLibrary` is not storage-aware.** With a `missing` root and zero books the pane still says *"Drag EPUB, MOBI, AZW3 or PDF files anywhere in this window"* while the banner above says the folder is gone — an invitation to drop books into a folder that does not exist. The honest fix is one conditional (suppress the first-run copy while `copy.recovery === 'locate'`), and it belongs with the empty view's own design, `2026-09-20-library-onramps-and-maintenance-design.md`.
- **The delete dialogs' offline notice is one sentence for four states.** *"The library is offline — reconnect before deleting"* renders for `unconfigured`, `disconnected`, `reconnecting` **and** `missing`, and "reconnect" is a remedy only one of them has. It names no server, so AC12 holds; a per-cause rewrite wants the composer's sentence handed to the dialog, which is a store read those dialogs do not do today.
- **AC12's decider is a source walk, and its limit is stated** — reaching the dialog needs a device round trip. The walk is now *in the gate* (`src/lib/storage-copy-scan.test.ts`), so it fails on the next hand-typed sentence rather than only on a re-read.

**The probe's own state, for the next session.** Profile `~/.hermes/profiles/dev/cache/scratch/musaeum-localprobe`, restored to what it was: `library_kind` **absent** again (so it is still the derive-and-persist fixture), `library` in place, no `library-moved`, the `open` shim's log still at its **three** pre-fix `-g smb://ohnas` lines, and four new frames — `06-local-root-missing-slice2`, `07-refused-write-missing-root`, `08-settings-local-root`, `09-settings-network-share` — beside the five pre-fix ones. The owner's app was never opened: the launch carried `MUSAEUM_USER_DATA`, and the owner's library is `/Volumes/books/musaeum`.

## Rejected and deferred, with the condition that would revive them

- **Inferring the kind from the path prefix (`/Volumes/…` ⇒ network)** — rejected on evidence: `/Volumes/data` is a local HFS+ volume on this machine (reading 14). Revived never as a prefix test; a *mount*-based resolver is the accepted mechanism (D1).
- **Inferring the kind at failure time by walking to the nearest existing ancestor** — rejected: for a root on a share, the ancestor that survives the unmount is `/Volumes`, which is local, so the walk answers *local* for the flagship NAS case. Revived only if a way to ask "what was at this path?" without storing anything appears.
- **Storing no kind and always offering both recoveries** — rejected: an SMB mount attempt for a folder is not a harmless extra option, it is the reading-9 spam, and a *Locate* dialog for an unmounted share asks the user to do the app's job. Revived if the resolver's inference is ever shown to be unreliable in the field — the fallback is to ask in the picker with no pre-selection.
- **Refusing a cloud-synced root** — deferred (D7). Revived by a measurement: a dataless file degrading a real cover read, or a demonstrated catalog conflict through a sync client.
- **Renaming the `nas*` surface** — deferred (D8), mechanical, no reasoning attached.
- **Removing the 30 s health poll for a local root** — not built. The poll is `fs.access` on a folder: cheap, and it is what makes an ejected drive visible within 30 s. Revisit only if the poll is seen costing something measurable on a local root.
- **A default library location on first run** (`~/Documents/Musaeum`, or creating it) — deferred. The empty view and Add Books (`2026-09-20-library-onramps-and-maintenance-design.md`) already carry the first-run on-ramp, and *"No library folder configured — choose where Musaeum should keep your books"* is an honest, working instruction. Revived if first-run feedback shows the picker is a wall rather than a step.

---

## Risks, stated plainly

1. **The kind is a stored fact, and stored facts can be wrong.** A library moved from a share to a disk keeps `network` until it is re-picked, and the symptom is the one this slice fixes (an SMB mount for a local path). The mitigations are that the picker re-derives on every pick and Settings displays it; the residual is a user who moves a library with Finder and never opens Settings. Slice 2's criterion 9 is where that would show up as "the SMB row is still there" — say so in the code comment beside the key.
2. **The resolver's network list is a whitelist of measured constants.** `30` is `smbfs` here; AFP, NFS and a future macOS are not measured. The design's answer is the conservative default plus the visible answer, not completeness — a network filesystem the resolver misses degrades to "no auto-remount, the user picks again", which is a bad day rather than a broken library. The `mount`-name mechanism is the more durable half because it reads a *name*, so it should lead and `statfs` should be the pre-check, not the reverse.
3. **D-B's fix touches the state machine every other feature reads.** `state === 'connected'` gates writes in six components and arms the watcher and the catalog sync (`index.ts:228-233`, `file-watcher.ts:53`); a transition that flaps would repeatedly disarm and re-arm the watcher. The suite that does not exist today is the mitigation, and criteria 2, 3 and 5 are the guard.
4. **This slice makes a claim about the world (a folder is local) that only the machine can settle.** Every criterion above is decidable here *except* the network half of criteria 3 and 4, which need a mounted share. The shares on this machine are mounted (`/Volumes/books`, `/Volumes/media`), so the resolver's network case is measurable — but it must be re-measured against a share that is *away* for criterion 3, which is the pre-existing `tasks.md:223` item and stays open here.
5. **Invariants held:** this touches **12** (failures stay non-fatal — a `missing` root still degrades to the cache, and no new throw crosses the boundary) and re-verifies **1, 4 and 5** on a local root rather than changing them (readings 5, 6 and 8). It deliberately does not touch **2, 3, 6, 7, 9, 10 or 11**: no file lookup, no `formats[0]`, no rename path, no geometry, no route, no packaging, no vendored file. **8** holds: the kind resolution and the state transitions live in `services/`, and the handlers stay thin.

---

## Open forks

**F1 — is the kind stored-and-confirmed, or derived at failure time?** Recommendation: **stored, resolved at pick time, displayed in Settings** (D1), because failure time cannot recover the fact (the ancestor walk is unavailable for the case that matters) and because the display is what makes a wrong guess a one-click fix. The rejected alternative is in §Rejected with its revival condition. *A second, smaller fork inside F1*: whether the copy strings are composed in main and carried across the bridge (D4's recommendation, matching the REST-API row's precedent) or live in the renderer as a lookup table keyed on state. Main is recommended for assertability.

**F2 — a cloud-synced root: named or refused?** Recommendation: **named, in one line** (D7), with the hazards stated as claims that are actually known. The refused alternative needs a measurement this design does not have.

Both are the owner's call; neither blocks slice 1, which is where the state machine and the resolver land.

---

## Handoff — how to re-derive every reading above

The probe is cheap and leaves the owner's library alone. From `~/Projects/musaeum`, with the user's own app closed:

1. `npm run build` → `out/`.
2. `P=<scratch>/musaeum-localprobe`; make `$P/bin/open` a shell shim that appends `"$*"` to `$P/open-shim.log` and `exit 0`, and `chmod +x` it. This is the instrument for readings 2, 9, 10 and 13 — without it, `open -g smb://…` is a silent no-op that looks like nothing happened.
3. Launch once to let the app create its schema: `env -u ELECTRON_RUN_AS_NODE MUSAEUM_USER_DATA=$P/userdata OPEN_SHIM_LOG=$P/open-shim.log PATH=$P/bin:$PATH npx electron . --remote-debugging-port=9223`. Quit it (the debug port's pid from `lsof -nP -iTCP:9223 -sTCP:LISTEN`, `kill`, then `kill -9` if it lingers).
4. `sqlite3 $P/userdata/musaeum.db "insert into app_config(key,value) values('library_root','$P/library') on conflict(key) do update set value=excluded.value;"` — and **deliberately leave `smb_url` unset**, which is what makes reading 13 appear.
5. Relaunch; drive the renderer with the `musaeum-app-verification` skill's `cdp.mjs` on `CDP_PORT=9223`. Import with `window.Musaeum.import.addFiles(['<abs path to a fixture epub>'])`; open the reader by dispatching a `dblclick` on the card's title node (a coverless fixture has no `musaeum://cover` img to select on — the skill's own trap).
6. For readings 9–12: quit, `mv $P/library $P/library-moved`, clear `open-shim.log`, relaunch, and watch both the log and the banner. Reading 11 needs ~60 s of samples: the informative copy is visible only until the first retry fires.
7. Cleanup: restore the folder, quit, and confirm the user's own app is untouched (`git status` clean; nothing in `~/Library/Application Support/Musaeum` was opened).

**What "done" looks like for the next session:** slice 1 green with its suite (including the first `nas-manager.test.ts`), slice 2 probed in the running app on the reading-11 fixture, and this document's readings re-taken and compared — with any reading that *changed* named in the land record, the way the 2026-09-20 onramps spec records its own.
