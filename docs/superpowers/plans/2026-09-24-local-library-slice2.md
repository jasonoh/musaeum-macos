# Slice 2 — the surfaces, and the copy that assumes SMB (annex)

**Why this file exists:** the spec (`docs/superpowers/specs/2026-09-24-local-library-design.md`) is the design; this is what a session with none of this conversation needs. Read the spec's **D4, D5, D6, D7** and **criteria 8–13** first, then this. Slice 1 (the main-process half) is built and committed.

**The owner's two forks are settled and are not yours to reopen:** F1 — the kind is **stored**, resolved at pick time and shown in Settings, and the status sentences are **composed in the main process** so a unit test can assert them; F2 — a cloud-synced root is **named, not refused**.

---

## What slice 1 left you (inherited — do not re-derive, do not re-test)

| Fact                                                                                                                                                                      | Where it lives                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `NASState` is now `connected \| disconnected \| reconnecting \| missing \| unconfigured`; `NASStatus` carries `kind: StorageKind \| null`                                 | `src/types/metadata.types.ts`                                                                              |
| `library_kind ∈ {'local','network'}` is written beside `library_root` by the picker, validated on read, and reported as a resolved view row (`source: 'auto'` / `'none'`) | `electron/main/services/storage-kind.ts`, `services/settings.ts` (`getSettings().resolved.libraryKind`)    |
| A missing **local** root is `missing` with `nextRetryMs === null`, arms no timer, and shells nothing — not from the ladder, not from `reconnect()`                        | `electron/main/services/nas-manager.ts`                                                                    |
| A failed reconnect attempt lands back in `disconnected` (D-B), so the "editing is disabled" copy is reachable more than once                                              | same file, the `attemptInFlight` flag                                                                      |
| `assertOnline()`'s three sentences, which reach the user through toasts, name no server                                                                                   | same file                                                                                                  |
| `pickLibraryRoot(locateAt?, showDialog?)` is exported and resolves the hint to its nearest **surviving ancestor**                                                         | `electron/main/ipc/nas.ts`                                                                                 |
| `survivingAncestor(path)` is exported for the same purpose                                                                                                                | `electron/main/services/storage-kind.ts`                                                                   |
| The write gates are unchanged and must stay unchanged: six components ask `state === 'connected'` — they are asking _can I write_, which is not a wording question        | `BookDetail`, `SelectionPanel`, `DeleteBookDialog`, `DeleteSelectionDialog`, `BookEditor`, `SettingsModal` |

**The state the renderer is in today, which is the defect slice 2 fixes.** For a `missing` root, `NASStatusBanner` falls through to its offline branch — _"Library offline — browsing from cache, editing disabled."_ — with **no** "Retrying in Ns" (because `nextRetryMs` is null, the only thing that makes it honest) and a _Retry Now_ button that now does nothing; `Sidebar`'s status row falls through to _Offline_; `SettingsModal`'s row falls through with it. Read the two components and see the fall-through for yourself before changing them: the banner returns `null` only for `connected`, and its informative branch is keyed on `disconnected`, so `missing` is served by the same words a dropped share gets.

**D6's pre-point is main-complete but unreachable from the renderer**, and closing that is two lines that are yours: `src/types/api.types.ts`'s `chooseLibraryRoot` takes no argument and `electron/preload/index.ts` forwards none, while the handler already accepts `locateAt`. The only caller that passes one is the button this slice adds.

---

## What must not move

- The write-gate list above. `state === 'connected'` stays where it is in all six components.
- `libraryRoot`'s and `libraryKind`'s own flow: neither is in `EditableSettings`, and the batched save must not accept either (`docs/invariants/settings-and-editing.md`).
- `NASStatusBanner`'s two already-good sentences. _"No library folder configured — choose where Musaeum should keep your books."_ is the model the rest of the copy should follow: storage-neutral, an instruction, no server named.
- The `nas*` internal names (D8) — the code keeps saying NAS where the UI says "library folder". That asymmetry is deliberate and recorded.
- Every string this slice changes is **user-visible**, so the change belongs in `CHANGELOG.md` under the day it lands.

---

## The readings you inherit (settled — do not re-derive, do not re-test)

| Reading                                                                                                                                                                                | Settled by                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| A local root that exists is `connected`, writes its library dirs, and derives+persists `local`                                                                                         | `nas-manager.test.ts` (AC1)                     |
| A missing local root is `missing`, `nextRetryMs` null, **zero** `open` over a 70 s window — and `reconnect()` shells nothing however the user asks                                     | `nas-manager.test.ts` (AC2)                     |
| A missing share still arms the 5/15/60 s ladder and still shells the mount                                                                                                             | `nas-manager.test.ts` (AC3)                     |
| The resolver answers `network` only on positive evidence: `smbfs` names it, a local HFS+ volume under `/Volumes/` does not, siblings are not inside a share, no evidence means `local` | `storage-kind.test.ts` (AC4)                    |
| A failed attempt returns to `disconnected`, twice over                                                                                                                                 | `nas-manager.test.ts` (AC5)                     |
| Picking writes `library_root` + `library_kind` and nothing else, as a set                                                                                                              | `ipc/nas.test.ts` (AC6)                         |
| Both refusals' exact words                                                                                                                                                             | `nas-manager.test.ts`, `transfer-queue.test.ts` |

---

## What you must settle yourself

Each of these is a decision the spec leaves open, with the alternative it beats and the condition that would revive the alternative.

1. **Neutral, mine now.** **Where the composed copy lives, in the main process.** D4 is settled (main, assertable) but _which_ file is not: inline in `nas-manager.ts`'s `getStatus()`, or a new pure `electron/main/services/storage-copy.ts` that `getStatus()` calls. **Recommendation: the new module** — it is a pure function of `(state, kind, nextRetryMs)`, so it needs no database and gets a colocated suite that asserts every sentence in one place, which is D4's whole point. The alternative (inline) beats nothing here and makes the strings decidable only by reading the repository. _Revival condition for the alternative:_ none foreseen.
   **This is the file-table correction the spec's slice-2 row does not carry:** D4 requires `NASStatus` to gain the composed message, so this slice also edits `src/types/metadata.types.ts` (the new field) and `nas-manager.ts` (`getStatus()` sets it). The row lists renderer files and a copy module; the row's own D4 adds a contracts file and a main-process call site. Name both in the land record rather than letting the count surprise the reviewer.
2. **`DEFAULT_SMB_URL`'s fate (D5).** Today `services/settings.ts` compiles `smb://nas` into the product as the resolved `smbUrl` with `source: 'default'`, so **any** user who has not set one — including one whose library is a folder — is shown a row about the owner's own server. The spec leaves two shapes: gate the SMB row on kind and keep the constant (a _network_ user without a URL then still sees a working default), or blank the resolved default so the row reads "not set". **Recommendation: blank the default and give the row a placeholder-free empty state** — this is the only place a personal hostname is compiled into the product, and a network user with no URL is exactly the person a _"the app will not re-mount for you"_ sentence serves better than someone else's hostname. _Revival condition:_ if blanking leaves a network user with nothing actionable, the fix is a hint sentence in the row, not the constant coming back.
3. **D7's sync-root list and its sentence.** Which clients to name (iCloud Drive under `~/Library/Mobile Documents`, `~/Library/CloudStorage/*`, and the conventional `~/Dropbox`, `~/Google Drive`, `~/OneDrive` spellings) and the exact words. The rule the copy must obey: **claim only what is known** — "this folder is synced by <client>; a second machine writing it can lose changes, and iCloud may remove a file's contents until something opens it" — and never "unsupported". _Revival condition for a refusal:_ a measurement (a dataless file degrading a real cover read, or a demonstrated catalog conflict through a sync client), not a taste.
4. **Whether the banner's `missing` affordance replaces _Retry Now_ or sits beside it.** D6 says the recovery is `pickLibraryRoot`, and D2 says a `missing` root has nothing to retry. **Recommendation: replace it** — a button whose only effect is a no-op is worse than an absent one, which is D5's own argument applied to the banner. _Revival condition:_ a user who needs both (unlikely: the kind decides the recovery).
5. **Whether the missing-root affordance also appears in the empty view.** The spec's `Interacts with` list names the empty view and Add Books from the on-ramps spec. Reaching that file is a judgement call — read `docs/superpowers/specs/2026-09-20-library-onramps-and-maintenance-design.md`'s empty-state section before deciding, and if it is not already storage-aware, record the omission rather than expanding this slice.

---

## The harness — it exists, and it is intact

**Profile:** `~/.hermes/profiles/dev/cache/scratch/musaeum-localprobe`

Verified 2026-09-24 (after slice 1 was committed), its state:

| Path                                      | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userdata/musaeum.db`                     | The isolated profile's database. `app_config` holds **`library_root`** = `<profile>/library` and `rest_api_enabled=false`. **There is no `library_kind` row** — the profile predates slice 1, which makes it the real "absent key on a profile that already has a library" case, and the flagship way to exercise the derive-and-persist path. `books` holds one row: `7f1004b3-d3c2-4265-ba63-139948dbbbfc \| The Local Shelf Probe \| books/7f1004b3-…`. |
| `library/`                                | The root, **in place** — `books/<uuid>/`, `imports/`, `exports/`, `catalog.json`. The app therefore starts **`connected`**, which is _not_ the reading-11 fixture.                                                                                                                                                                                                                                                                                         |
| `bin/open` + `open-shim.log`              | The instrument. The shim appends `"$*"` to `$OPEN_SHIM_LOG` and exits 0. The log still holds **three pre-fix lines** — `11:02:39 ARGS: -g smb://nas`, `11:03:00`, `11:04:05` — the 5/15/60 s ladder this slice removed. Keep them: they are the _before_ half of the evidence, and the spec's reading 9.                                                                                                                                                 |
| `frames/`                                 | `01-local-library`, `02-local-reader`, `03-local-reader-frame`, `04-local-root-missing`, `05-retry-now-smb` `.png` — the pre-fix frames, including the two this slice's criteria are about.                                                                                                                                                                                                                                                                |
| `tools/cdp.mjs`, `tools/make-epub.py`     | The CDP driver and the fixture builder. `cdp.mjs` is the one the `musaeum-app-verification` skill describes — **reuse it; do not rebuild it.**                                                                                                                                                                                                                                                                                                             |
| `incoming-probe.epub`, `second-copy.epub` | Fixture books, importable over the real IPC.                                                                                                                                                                                                                                                                                                                                                                                                               |

**To reach the reading-11 fixture** (a missing local root), from the profile root: move `library` aside (`library` → `library-moved`), **note the shim log's line count first** so the new attempt's lines are identifiable, relaunch, and sample for ~60 s. Do not clear the log — the pre-fix lines are evidence; count instead.

**Launch recipe, with the two traps that cost a session each:** the app must be the **built** `out/` (`npm run build` first), launched as `env -u ELECTRON_RUN_AS_NODE MUSAEUM_USER_DATA=<profile>/userdata OPEN_SHIM_LOG=<profile>/open-shim.log PATH=<profile>/bin:$PATH npx electron . --remote-debugging-port=9223` — without `env -u ELECTRON_RUN_AS_NODE`, Electron runs as plain Node and no window appears; and a coverless fixture has no `musaeum://cover` image to click, so open the reader by dispatching a `dblclick` on the card's title node.

**Cleanup, which the spec's own handoff requires:** restore the folder, quit the app, and confirm the owner's app is untouched — `git status`, and nothing in `~/Library/Application Support/Musaeum` was opened. The owner's own library is `/Volumes/books/musaeum` and it is live: never point a probe at it.

---

## Slice 1's results, with the pre-fix value beside each

Every number is measured on the committed tree (`9aeb518`); the "before" column is the spec's own reading or the falsified run, so the claim has something to be wrong against.

| What                                           | Before                                                                         | After (slice 1)                                                           | Instrument                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Mount attempts for a folder whose root is gone | 3/minute, forever (reading 9)                                                  | **0** across a 70 s window                                                | vitest, `child_process.exec` spied, fake clock past the whole ladder |
| _Retry Now_ on a missing folder                | shells the same mount (reading 10)                                             | shells **nothing**                                                        | same spy, `reconnect()` called directly                              |
| State after a failed attempt                   | pinned at `reconnecting` indefinitely (reading 11)                             | **`disconnected`**, twice over                                            | vitest, status listener                                              |
| A write refused on a folder whose root is gone | _"The library is offline. Reconnect to the NAS to make changes."_ (reading 12) | _"The library folder is missing — choose where it went to make changes."_ | vitest, `assertOnline()`'s own words                                 |
| Typecheck / lint / build                       | —                                                                              | **0 / 0 / 0**                                                             | the gates                                                            |
| Suite                                          | 1408 tests, 59 files                                                           | **1445 tests, 62 files**                                                  | `npm test`                                                           |
| Sidecar suite                                  | 113                                                                            | **113 passed**                                                            | `sidecar/.venv/bin/python -m pytest -q sidecar/tests`                |

**Falsified, not merely green:** restoring D-B's one-line pin fails the AC5 case (2 landings where 3 are required), and inverting the kind branch fails five cases in both directions. Anything you add to this area should survive the same treatment before you trust it.

---

## Start here

```bash
git log --oneline -3        # slice 1 landed as 9aeb518 on top of e5d7b3b
git status --short          # clean: slice 1 committed, nothing outstanding
npm run typecheck && npm run lint      # both 0
npm test                    # 62 files / 1445 tests
sidecar/.venv/bin/python -m pytest -q sidecar/tests   # 113 passed
```

Then read, in this order:

1. **`electron/main/services/nas-manager.ts`** — the state machine you are rendering. `checkHealth()` is where `missing` is decided and where `nextRetryMs` becomes null; `getStatus()` is where the composed message will join it (D4).
2. **`src/components/shared/NASStatusBanner.tsx`** — the surface criteria 8 and 11–12 are about. Its fall-through branches are the whole defect: a `missing` root is served the offline copy and a _Retry Now_ that does nothing.
3. **`src/types/metadata.types.ts`** — `NASState` / `NASStatus` (what main hands you now) and `StorageKind`.
4. **`docs/invariants/settings-and-editing.md`** — the house pattern D4 follows (_the row renders the socket; it does not describe it_) and the `libraryRoot` rule that keeps `libraryKind` out of `EditableSettings`.
5. **`docs/invariants/nas-and-catalog.md`** — slice 1's note names the local case; slice 3 is what writes it up in full, so do not spend this slice's budget there.
