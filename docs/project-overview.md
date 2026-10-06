# Musaeum — Project Overview & Feature Inventory

> Human-facing companion to `CLAUDE.md` (the agent brief), `docs/architecture.md`
> (process model) and `docs/data-contracts.md` (stored shapes). This file answers
> two questions: **what is this, feature by feature**, and **how does it differ
> from everything else that manages or reads ebooks?**
>
> Every number here was measured on this repo at the commit named below, or is
> quoted from a cited source. Where a claim is general knowledge rather than
> verified, it says so.

**Measured at:** `93d2103` ("local library dialogs"). **1,512 vitest tests across 64 files** (through `npm test`, which runs Electron-as-Node so the native better-sqlite3 ABI matches), **113 pytest tests** in the sidecar — both suites green, and both re-run on 2026-09-24. Roughly **31,500 lines of application code** (main process 14,994 · renderer 14,356 · preload 128 · sidecar 2,000) and **24,839 lines of tests** (22,621 TypeScript, 2,218 Python), beside **7,600 lines** of vendored reading engine. Numbers about the iOS client were measured **in that client's own repository** and say so where they appear.

---

## 1. What it is

A **macOS desktop application for personally owning a large ebook library** — in practice 7,000+ books, on network-attached storage, on an external drive, or in a folder on this Mac. It imports and hydrates metadata, presents a fast visual library, opens and reads the books itself, puts them on a Kindle over USB, and serves the whole library to an iPhone companion over a tailnet.

It is a **single-user, local-first replacement for a Calibre workflow**, not a service. There is no account, no Docker, no cloud and no multi-tenancy. There is exactly one listening socket in the whole app — the tailnet-bound HTTP surface the phone talks to, **disabled by default** and behind a generated bearer token (§3.8) — and everything else on the wire is outbound metadata lookups (Google Books, OpenLibrary, Goodreads) that the user can run keyless, or not at all.

Three constraints shape nearly every decision in this repo:

1. **The library is a directory of files, and the machine holding it may not be this one.** A mounted share is not a local disk, and the architecture is arranged around that (see §3.1) — but the same root shape also has to work as a plain folder on the boot disk, which is a *different* failure mode with a different recovery, and telling the two apart is a stored fact rather than an inference.
2. **Beauty is a first-class requirement, not a finish step.** The UI is a "dark library" — warm near-black surfaces, amber/gold accents, serif display type, covers as the hero element — and the palette is fully themeable from the user's own colour schemes.
3. **There is a second client, and one document owns what crosses the wire.** The iPhone app is written against `docs/rest-api.md` in this repo, derives its test fixtures from that document by script and never restates it (§3.8) — and the server side is arranged so that lifting it into a standalone API server stays cheap.

---

## 2. Status — what exists today

| Phase               | What landed                                                                                                                                                                                                             | Date          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **1.0 — MVP**       | Scaffold, NAS offline mode, drag-drop import, hydration pipeline, conflict queue, grid/list/detail, FTS5 search + facets, Kindle transfer with conversion, Apple Books export, Calibre migration wizard, Python sidecar | 2026-07-12    |
| **Multi-machine**   | `catalog.json` derived cache; a second Mac adopts the library on connect                                                                                                                                                | 2026-07-18    |
| **1.5 — PDF**       | PDF as a first-class format (import, hydration, cover, transfer, Calibre top-up)                                                                                                                                        | 2026-07-27    |
| **Scale pass**      | Hand-rolled virtualization for both views — the 7,000-book blocker                                                                                                                                                      | 2026-07-29    |
| **Library UX**      | Keyboard navigation, metadata editor, sorting headers, delete dialogs, per-book context menu                                                                                                                            | 2026-08-10    |
| **Settings & menu** | Settings modal, native app menu, persisted view/sort                                                                                                                                                                    | 2026-08-11    |
| **Packaging**       | `Musaeum.app` / DMG, first-run Python bootstrap, app icon                                                                                                                                                               | 2026-08-12    |
| **In-app reader**   | EPUB/MOBI/AZW3 in a full-window reader; reading position that follows you between machines                                                                                                                              | 2026-08-13    |
| **Bulk operations** | Multi-select (⌘/⇧-click, ⌘A, select-all) + bulk delete / send / re-hydrate                                                                                                                                              | 2026-08-15    |
| **Docs split**      | `CLAUDE.md` became an index; payload moved into `docs/` (12 invariant files)                                                                                                                                            | 2026-09-15    |
| **Theming**         | Palette engine with contrast floors, three import providers (base16, iTerm2, Obsidian), the reader and the window chrome, the status family, and the Appearance section folded behind a _Select theme_ disclosure — slices 1–7b plus the fold | 2026-09-15/20 |
| **Quality pass**    | Scroll reset, stable sort ties, recomputed file sizes, conflict service extraction, +118 tests                                                                                                                          | 2026-09-16    |
| **Kindle presence** | Presence by each device file's _own_ title+author; send receipt; cover backfill                                                                                                                                       | 2026-09-17    |
| **In-book search**  | ⌘F inside the reader: hits grouped by chapter in reading order, counts per chapter, click to jump, outlines drawn on the page in the reader's own palette — and no index, so it works offline and on a dropped share | 2026-09-19    |
| **The Ask panel**   | A panel beside the page that sends the question with the title, author, section label, position and the passage around you to an endpoint the user configures; recall checked against the local text first, and the payload disclosed before the first send | 2026-09-19/21 |
| **Duplicates & overrides** | The ISBN a _fetch_ settles gets a second look, and a field the user set is recorded as an override that later fetches are kept off — with a padlock chip to hand the field back | 2026-09-20    |
| **Library on-ramps** | **Add Books** at last (toolbar and `File ▸ Add Books…`, ⌘O), an empty library that says where books come from in both views, and maintenance moved out of the sidebar into Settings with progress and Cancel in the status bar | 2026-09-20    |
| **Cover candidates** | Google's jacket is fetched at full size rather than handicapped, and the candidates behind a cover are gathered and a chosen one sticks — **slices 1a and 1b only**; the picker itself is not built (§7) | 2026-09-21    |
| **iOS companion**   | The Mac's HTTP surface (§3.8) and the client in its own repository — the split is spelled out in §5.13 | 2026-09-22/23 |
| **Phone uploads**   | `POST /api/books` — a book sent _to_ the library from another machine, through the same importer the Mac's own file picker uses, with a collision answered by policy rather than turned into a question. Mac side 2026-09-23; the phone's picker and share target 2026-09-24 | 2026-09-23/24 |
| **Storage kinds**   | A library that is a share, an external drive, or a folder on this Mac — the kind recorded when it is picked, shown in Settings, and deciding the recovery: a share retries and re-mounts, a folder offers to be located and never pretends a server exists | 2026-09-24    |

**Maturity read:** the daily-driver loop — import → hydrate → curate → read → send — is complete and verified against a real 7,000-book NAS library and a real Kindle, and since 2026-09-24 the same loop runs against a library that is a folder on a machine with no server anywhere near it. It is now a two-client product: the Mac owns the library, and an iPhone app in its own repository reads it, writes its position back, and can send a book into it. The gaps are listed honestly in §7.

---

## 3. The design bets

Eight decisions explain most of the code. They are the interesting part of the project; the feature list in §5 is downstream of them.

### 3.1 The library is a directory, not a database — and it may not be on this machine

Calibre keeps everything in one SQLite file (`metadata.db`) inside the library folder. That file _is_ the library, which is why Calibre's own manual says: **"Do not put your calibre library on a networked drive"** — network filesystems lack the locking and hardlinking it relies on, and a second copy of Calibre opening the same share can corrupt it. Calibre's own remedy is to not share the library directory at all and run a Content server instead ([source](https://manual.calibre-ebook.com/faq.html)).

Musaeum inverts this. **The canonical record is a per-book `metadata.json` next to the book's files**, and the queryable database is a _disposable local cache_ in `~/Library/Application Support/Musaeum/`:

```
{library_root}/
├── books/<uuid>/
│   ├── metadata.json          ← canonical
│   ├── cover_full.jpg  (600px)
│   ├── cover_thumb.jpg (200px)
│   └── <title>.epub / .mobi / .azw3 / .pdf
├── catalog.json               ← derived, flattenable, regenerable
└── imports/                   ← watched drop folder
```

Consequences, and they are the point:

- **No shared-file database to corrupt.** No locking or hardlinking requirement; the only cross-machine write is a file rename, done atomically (`.part` + rename).
- **A torn or deleted cache is never data loss** — it rebuilds by walking the per-book files. `Rebuild catalog` is a recovery action, not a disaster plan.
- **Sync is free.** A second machine reads `catalog.json` on connect and shows the whole library without re-importing (verified end-to-end 2026-07-18).
- **A network blip is a degradation, not a failure.** NAS errors fall to offline mode and get surfaced in the UI; hydration failures keep embedded metadata and never throw.

**The first half of that title is what makes the second half affordable.** Because the canonical record is a per-book file and the queryable copy is local and disposable, "where the library lives" is a *path* and nothing more: the same root shape imports, hydrates, opens in the reader, transfers to a device and round-trips reading state whether it is an SMB mount, an external drive, or a folder on the boot disk. That was never designed for — it fell out of the data model — and it was driven rather than assumed: on 2026-09-24 the whole loop ran in the app against a local folder, on an isolated profile, with `open` shimmed on `PATH`.

**What did not fall out is one assumption hidden inside the recovery path** — that an unreachable root means a share has dropped. So a library that was simply *a folder on this Mac*, renamed out from under the app, shelled `open -g smb://…` at 5 s, then 15, then 60, **forever**, under a banner whose only button ran the same mount and whose refusal told the user to reconnect to a NAS. The fix is the design bet worth recording, because there is no honest way to reach it at failure time: **the kind is a fact recorded when the folder is picked, not derived when it breaks.** At pick time the path exists and the mount table can be asked; once it is gone, an ancestor walk out of `/Volumes/nas/books` lands on `/Volumes` — the boot disk, measured — and reports the library as a healthy local folder. So `library_kind` is stored beside the root, shown in Settings → Library as *Local folder* or *Network share*, re-derived whenever the folder is re-picked (so a wrong answer stays fixable), and it decides which recovery a state offers: a share gets the mount attempt, the 5/15/60-second backoff and *Retry Now*; a folder gets **no timer armed and no mount attempted — not by the ladder and not by the button** — and offers *Locate Library Folder…* instead, opening the picker **at the folder that went missing**, or at its nearest surviving ancestor, because a dialog silently ignores a starting point that does not exist. Checked is not retried, and the 30-second health check runs for both kinds because it is an `fs.access` on a folder — which is what makes a re-plugged drive return within half a minute.

**A cloud-synced root is named, not refused**, deliberately. iCloud Drive, Dropbox, Google Drive, OneDrive, Box and Proton Drive are recognised by the folder's own path — so the account name and date a File Provider appends do not hide it — and get one line naming the client and the last-write-wins hazard, with iCloud's file-eviction behaviour claimed for **iCloud alone**, because that is the only client it was measured on. Anything else inside `~/Library/CloudStorage` is reported by the name it spells. The refusal's two justifications (a dataless file degrading a cover read; a catalog conflict through a sync client) are measurements this design does not have, and an unsupported *"not synced"* verdict is exactly the claim the line exists to avoid.

**And every word the app says about storage is composed in one place, in the main process** (`services/storage-copy.ts`, 31 cases of its own). Five states × two surfaces used to be ten independent chains of conditions, and the disagreement was visible: a folder that had moved fell through both to the words a dropped share gets — including a retrying clause that was a lie, since a folder arms no timer. The banner, the sidebar's status row, Settings and both delete dialogs are now readers of that one module; a sentence composed in main can be asserted by a case, where one typed inside a component cannot; and `src/lib/storage-copy-scan.test.ts` walks `src/` so a new hand-typed *"from the NAS"* fails a test rather than shipping. It is also why **`smb://nas` is no longer compiled into the app at all** — as a Settings default or as a mount the app used to run behind the user's back.

### 3.2 Metadata is fetched, merged, and then _argued about_

Hydration is not "look up the title and take the best result". It is a pipeline with a documented conflict policy:

- **Sources:** the file itself (EPUB OPF / PDF Info dict), Google Books, OpenLibrary, Goodreads (series), and — during migration — Calibre's own `metadata.db`.
- **Embedded and Calibre identifiers always win.** Live testing found Google Books confidently matching the _wrong edition_ and replacing a file's own ISBN; that is now impossible.
- **High-stakes fields disagree → ask the human.** Title, author and series go to a review queue with candidates side by side. Publisher, date and language auto-resolve by source priority so the queue stays quiet. Description: longest wins. Identifiers and tags: union.
- **The resolver learns.** `source_preferences` biases future scoring toward the source you keep choosing for a field.
- **Covers are scored, not guessed.** `resolution×0.4 + aspect(2:3 ideality)×0.3
  - source_priority×0.2 + file_size×0.1`, with a 120px floor; if the top two are within 15% the winner still applies _and_ a cover conflict is queued, so a book is never left coverless while it waits for review.
- **A refresh reports what it did.** _Metadata updated_ lists the fields that actually moved; _No new metadata found_ is a distinct answer from a failure; and a failure is now distinguishable from "the book was already perfect" — previously silent, because hydration is non-fatal by design.

### 3.3 Devices are first-class, and presence is judged by content

The Kindle half of the app was rebuilt after measurement, not intuition:

- **The bug:** presence matched a book's title against the _filenames_ on the device. That only recognizes files Musaeum wrote itself — Calibre writes `{author_sort}/{title} - {authors}.ext` — so **86 of the Kindle's 1,555 files** were seen and "Send to Kindle" was offered for ~1,400 books already there.
- **The fix:** read each device file's _own_ title and author out of its header and match on those, with an order-insensitive author key (Calibre's "Banks, Iain M." equals the library's "Iain M. Banks"). Presence then answered **1,347 of 6,460 books**. The filename rule survives only as the fallback for files whose header cannot be read (KFX, PDF). Both readings are dated: the library has since been repaired to **7,101 rows** (637 folders held a complete `metadata.json` the catalog had never listed — adopted by the app's own rebuild walk, 0 lost), so the denominators here describe the measurement, not today's library.
- **The cost was engineered around:** opening every file takes ~73s on a cold mount, so facts are cached by `path + size + mtime` (a file replaced under the same name has different ones, so it is re-read rather than believed), the 5s poll stays readdir-only, and presence settles as batches land — **3.9s from launch**, warm.
- **A send states its state.** The button reads _Sending to Kindle…_ until the job resolves, _On Kindle_ when it lands, _Couldn't send — retry_ with the reason when it fails. Previously it re-enabled while the book was still copying and a second click put a **byte-identical duplicate** on the device.
- **Titles that settle rename their files**, on all three write paths, so a retitled book does not strand an old filename on disk.

### 3.4 Reading position is stored on three clocks

Reading state has to survive a restart, an offline session, _and_ a different machine — and the three stores cost wildly different amounts to write:

| Store           | When written        | Why                                      |
| --------------- | ------------------- | ---------------------------------------- |
| SQLite          | every page turn     | local, cheap                             |
| `metadata.json` | 30s throttle        | per-book, over SMB                       |
| `catalog.json`  | reader close / quit | whole library (~10MB) — never on a timer |

Adoption **reconciles** rather than overwrites: strictly newer local progress wins, so reading offline and then quitting cannot lose the session, and a stale catalog from another machine cannot rewind fresher progress. Quit flushes the pending position _before_ the DB closes, bounded by a 3s timeout so a wedged mount can never hold the app open.

### 3.5 The reader is vendored, not installed

`vendor/foliate-js/` is checked in and **never edited** (upstream publishes nothing to npm; the package under that name is a stale third-party republish). Our divergences live in our own code or in a `.d.ts`. Book bytes are served through a custom `musaeum://book/{id}/{format}` protocol that realpaths _both_ the library root and the candidate — the renderer never receives a `file://` path. CSP admits `blob:` styles (books bring their own stylesheets) but keeps `script-src 'self'`, so **book content can never execute and an EPUB cannot phone home** through an `@import`, background image or font.

### 3.6 Abstractions are written down with their reasons

The repo enforces twelve **invariants**, each with a `docs/invariants/*.md` file carrying the measurement that produced it and the approach that was rejected. Examples: nothing may read `formats[0]` (the array order is whatever the writing source left); sort keys are derived on _every_ write path or books strand under the wrong letter; row height is computed from constants, never measured, or the virtualizer drifts without a build error. The point is that a later change meets the reasoning, not just the rule.

### 3.7 A palette theme engine with guardrails

Themes are imported from tools the owner already uses — **base16 (`.yaml`)**, **iTerm2 (`.itermcolors`)** and **Obsidian (`theme.css`, read out of a live cascade because its palettes are computed)** — and the app _derives_ its own design tokens from the palette, enforcing contrast floors at every step. A palette that cannot hold a legible contrast is **refused with its reason**, per file, in its own row; the app keeps the theme it already had. A theme supplies **palette only — never geometry, typography, shadow shape or layout**. Imported themes survive their source file being moved or deleted, because what is stored is the derived values, not a reference, and a row discloses what its derivation had to approximate.

### 3.8 The phone is a second client, and one document owns the wire

The only listener in this app exists so that a phone can read the library from anywhere the tailnet reaches. Three decisions make it a bet rather than an integration:

- **It is off by default, and it is not on the LAN.** `rest_api_enabled` is `false`; the switch lives in **Settings → Phone access** and turning it off closes the socket. The bind address is the **tailnet address resolved from the interface map** — not `0.0.0.0`, and not loopback plus a tunnel the user is expected to build. Auth is a generated 64-character bearer token, compared in constant time, with a `401` (`WWW-Authenticate`) for anything that arrives without it.
- **`docs/rest-api.md` is the contract, and it is the only description of it.** Eight routes — six reads (`health`, `library`, `library/facets`, `books/{id}`, `books/{id}/cover`, `books/{id}/file`) and two writes (`PUT` the reading report, `POST /api/books` the upload) — with their payloads, statuses and failure semantics, at `apiVersion` 1. The client **derives its test fixtures from that document by script** (`scripts/vendor-contract-fixtures.sh` extracts its own `json payload=` blocks) and never restates it, so a field the document does not name and the wire does not carry fails the client's suite. The document, its goldens and `scripts/api-smoke.sh`'s executable half move **as one artifact**: `shape.test.ts` parses those same blocks out of the document and compares them field for field against what the server builds.
- **Nothing about the library's layout crosses the wire.** A book is asked for by `id` and `format`; paths stay on disk and are never mentioned. Covers ship at two resolutions (600 px and 200 px); a book is streamed with a single `Range`, because the largest book in this library is **528 MiB**; and concurrent byte transfers are capped at **two**, covers included, because the process's file I/O shares a four-slot threadpool with the app's own cover loads and catalog writes.

**What it buys, plainly:** "the position follows you between machines" exists because the phone writes back through the Mac's own `saveProgress`, and "send a book to the library" exists because the upload calls the Mac's own importer — so a book that arrives from the phone is indistinguishable, afterwards, from one dropped on the window. Neither is a sync feature: there is no service in the middle and no third party holding the library, which is the same posture the rest of the app takes.

**What it deliberately does not have:** any route that edits a book (an upload *creates* a row, which is why it never touches the field-override map), any notion of a second user, TLS (the transport is WireGuard's), or a library cache on the phone.

---

## 4. Architecture at a glance

```
Electron Main (Node)                     Renderer (React)              Python Sidecar
├── IPC handlers (thin wrappers)         ├── Grid / List / Detail      ├── EPUB + PDF extractors
├── services/ — ALL business logic       ├── Reader (foliate-js)       ├── Calibre metadata.db reader
├── SQLite cache (better-sqlite3, WAL)   ├── Conflict queue            ├── Google Books / OpenLibrary
├── storage kind + health (30s)          ├── Device panel + queue      ├── Goodreads series scraper
├── chokidar watcher on imports/         ├── Migration wizard          ├── Cover scorer + downloader
├── USB device polling (5s)              ├── Settings + Appearance     ├── Hydration pipeline
├── Transfer queue (serial)              ├── In-book search + Ask      ├── ebook-convert wrapper
├── REST surface, api/ (tailnet, off)    └── Zustand stores            └── Calibre migration + PDF top-up
└── Sidecar process manager

                        ⇅   docs/rest-api.md   ⇅
     ../musaeum-ios — SwiftUI over Readium, in its own repository
```

- **IPC:** every handler returns `{success, data | error}` — nothing throws across the boundary. `window.Musaeum` is the whole renderer contract.
- **Sidecar:** JSON-RPC over stdio, thread-pooled so long calls don't serialize; streams progress notifications. Auto-restarts on crash (max 3); when absent, the app degrades to filename metadata.
- **Schema:** `PRAGMA user_version` migrations, FTS5 over title/author/series/tags/description with sync triggers, **five migrations to date** — the device file-identity cache and the reading-state columns each arrived as one.
- **HTTP surface:** six read routes and two writes under `electron/main/api/`, bound to the tailnet address and off by default (§3.8). The app at the other end of it lives in its own repository and derives its fixtures from this repo's document.
- **Code size:** ~14,994 lines of main process (services, IPC, schema, the HTTP surface), ~14,356 renderer, 128 preload, ~2,000 sidecar, beside ~7,600 lines of vendored reader engine — and 22,621 lines of TypeScript tests plus 2,218 of Python tests. Every IPC handler is a thin wrapper and every byte the renderer shows comes through `musaeum://`, which is what keeps lifting the services into a standalone API server cheap.

---

## 5. Feature inventory

### 5.1 Import

- **Three ways in on the Mac:** drag files onto the window, drop into `{root}/imports/` (chokidar-watched), or **File ▸ Add Books…** (⌘O, and **＋ Add Books** in the toolbar) — the file picker the library-IA work added, which is what makes the app usable without knowing a drop folder exists. A fourth way in is the phone's `POST /api/books` (§5.13).
- **Duplicate gate, not a warning row.** An ISBN-13 hit or normalized title+author match _pauses_ the import and forces a choice: **Skip / Add as new / Add format to existing**. "Add format" deletes any prior file of that extension first, so a stale copy can't be sent to a device. The upload path passes a **policy** rather than a prompt (`add-new`) because the question would otherwise be asked on a screen nobody is looking at — the answer names the match it found instead.
- UUID book directories; filenames derived from a sanitized title; `metadata.json` written atomically; hydration kick-off is non-blocking.
- PDF is a first-class input alongside EPUB/MOBI/AZW3 — in the picker's filter, in the drop handler and in the migration wizard. Found while scoping the on-ramp work: `useDragDrop` still listed only epub/mobi/azw3, so **a dropped PDF was silently discarded** while five other declarations of the same fact carried it. Fixed as part of that slice.
- **An empty library says where books come from** — one `EmptyLibrary` shared by both views — and stays **silent** when the library cannot take a book at all, instead of offering three on-ramps the app would refuse.

### 5.2 Metadata hydration

- See §3.2 for the policy. Mechanically: extraction → parallel fetch → merge → conflict queue → cover scoring → resize to 600px/200px → write.
- Per-book provenance is recorded (`fetched_at`, `match_confidence` per source).
- **Re-fetch one book or a whole selection.** Single: an awaited call that reports the diffed result (with a spinner on the button _and_ on the card, so a refresh started elsewhere and left behind is still visible). Bulk: a _sequential, cancellable_ job — sequential because the sidecar would otherwise fan concurrent hydrations at rate-limited APIs, batched so the catalog is written once, with progress and Cancel in the status bar because the job outlives the selection that started it.
- A re-fetch that finds disagreement offers a **Review** button on the report rather than leaving a badge to be noticed.
- **A field you edit is yours.** A metadata-editor save or a resolved conflict records the field as an **override**, in one machine-local map keyed by book id, and later fetches are kept off it at two boundaries: the sidecar's merge omits the field from the candidate list (so nothing merges and no conflict queues) and the main process filters it out of the reply, because the file's own identifiers and the cover are merged outside `merge_metadata`. A padlock chip in the editor hands the field back to Musaeum without changing its value, and a lock is invisible until the editor is open — nothing is re-proposed as a conflict. The reported case behind it: an author corrected by hand to _Eve Rodsky_ and re-fetched back to `Ctprint` **on the row the correction had been typed into**. The build's own criterion caught the first version, which marked the override *after* `db.updateBook` — so the "did the user decide anything?" diff ran against the row the write had just produced, always came out equal, and the feature was a silent no-op with a green suite.
- **A duplicate the _fetch_ reveals is reported too**, with no buttons. A shared ISBN is not proof of the same file — the pair that prompted it shares one because a summary listing copied it — so it is reported on the surface that path already has (a card note on import, a toast on a re-fetch, a count appended to a bulk job's summary) and never acted on. Deliberately no library-wide `GROUP BY isbn_13` scan: it would surface the older pairs the decision was not made about.
- **Cover candidates are gathered, and a cover can be chosen today only by resolving a cover conflict in the review queue; the manual picker is the one slice of that design left** (§7). The half that shipped is worth recording because it was a fetcher handicapping Google before the contest started: the largest *advertised* `imageLinks` key was rewritten **down** to `zoom=1`, and 11 of 12 sampled volumes advertised nothing larger than ~128 px while answering `zoom=0` with up to 2164×3398. At `zoom=0` the book that prompted it scores **0.944** against the embedded cover's **0.832** — a margin of 0.111, *inside* the 0.125 review band, so the app would offer the choice rather than silently deciding. The rewrite needed a sentinel guard: `zoom=0` answers a byte-identical *"image not available"* tile for three unrelated books.

### 5.3 Browsing and finding

- **Cover grid and sortable list**, both virtualized by hand (react-window was rejected: it wants absolutely positioned cells, which would cost the grid its CSS grid and the list its real `<table>`). Measured on a synthetic 7,000-book library: **~40 rendered items and ~1,000 DOM nodes** at any scroll offset (was 7,000), **32MB** JS heap, `getBooks` **115ms**, search **18ms**.
- **Full-text search** (FTS5) over title, author, series, tags and description, ordered by relevance or by the active sort. Facet filters with live counts: author, series, tag, format, read status, minimum rating.
- **Six sort fields** with a pinned `id ASC` tiebreak so equal keys hold a stable order across loads.
- **Sort keys are derived everywhere** — `The Great Gatsby` → `Great Gatsby, The`; surname particles (`Ursula K. Le Guin` → `Le Guin, Ursula K.`) and generational suffixes (`King Jr.` still under K) handled.
- **A card says what file it is:** a format chip in the cover's corner showing the format the reader would open plus a count of the rest (_EPUB +1_), full list in the tooltip. PDF sorts last but is never what gets hidden — a PDF is never converted and (currently) has no in-app reader, so it is the label most worth seeing at a glance.
- **Keyboard navigation:** arrows (grid by column, list by row), Home/End, PageUp/Down, Escape to close. Selection survives a grid↔list switch and is scrolled into view. ⌘1/⌘2 switch views.
- **Scrolling behaves:** narrowing 7,000 books to a search result returns you to the top (measured 230,059px → 0), while a metadata edit or a delete leaves your place alone; a column-count change restores the _book_ at the top of the viewport rather than the pixel offset.
- **Empty states and a toast surface** for work that finishes out of sight.

### 5.4 Multi-select and bulk actions

- ⌘-click to add/remove, ⇧-click for a run (re-ranging from the same pivot, not creeping outward — hence both an anchor and a cursor), ⇧+arrow from the keyboard, a checkbox column with select-all in the list, and ⌘A routed by focus so it still means "select this field" inside a text input.
- **Three bulk actions:** delete (one batched operation, not a loop — a loop would rewrite ~10MB `catalog.json` over SMB per book), send to device (onto the serial queue), refresh metadata (sequential cancellable job).
- Partial failure is normal and _named_: a book that can't be deleted is listed in the dialog and stays selected, so the report is also the retry.

### 5.5 Curating and editing

- **Metadata editor** — title, author, series, publisher, date, language, tags, description, identifiers — opened from the detail panel or the context menu, ⌘↵ to save. **Only changed fields are sent**, so a save can't clobber a value hydration filled in meanwhile. Sort keys that merely match the derived form show as a live placeholder, so renaming re-derives rather than stranding.
- **Delete** with per-format granularity: one format file, several, or the whole book (selecting every format deletes the book), one confirmation dialog shared by the card hover button, the context menu and the detail panel.
- **Reveal in Finder** (with the file selected) or **open in the system default app**, per format.

### 5.6 Reading

- **EPUB, MOBI and AZW3** in a full-window reader over the vendored foliate-js. Four entry points: double-click, the detail panel's Read button, the context menu, the selection panel.
- **PDF opens in Preview** for now (PDF in the reader is the next phase); whatever the engine can't render falls through the same gesture, so every book responds to a double-click.
- TOC panel, typography popover (typeface, size, line height, spacing, paper/ink page theme) remembered per machine.
- **Position follows you** across restarts and machines (§3.4).
- **Read status is automatic and monotonic:** opening starts a book, passing 98% finishes it, and the transition only ever moves forward — so marking a book read by hand sticks even if you open it again.
- **Reading works offline.** It's the one action not disabled when the library is unreachable: it isn't a write, and the reader saying it can't reach the file beats a dead button that won't say why.
- **Search inside the book** (⌘F): hits grouped by chapter in reading order, counts per chapter, click to jump, and outlines drawn on the page **in the reader's own palette** — the colour is derived from the active theme and the outlines re-draw when it changes, not merely on a new run. There is no index and no I/O: the vendored engine's `search()` walks the copy of the book already open in memory, so it works offline and on a dropped share. Its expensive twin — a library-wide index of book _contents_, which is what Calibre's full-text search does — was **rejected** rather than deferred, with its reversal condition written down in the spec.
- **Ask about what you're reading.** A panel that shares the reader's single side slot with the TOC and with search, sending the title, author, section label, position and the passage around you to an endpoint the user configures — a local model first-class (Ollama, LM Studio, llama.cpp/vLLM) or a cloud provider if pointed at one. It is the app's own compression argument applied to a prompt: with a model that already holds the text, the pointer is an _index_ and the passage is the only thing that has to travel verbatim, because it is the referent. Why the payload escalates on evidence rather than on hope is measured rather than assumed — the library **splits** the bet (the pre-1900 canon is exactly where pointer-only works; the 2000–2023 non-fiction majority, 290 travel guides among them, is where no pointer summons the chapter), so recall is checked against the local text first and the panel **says what it is about to send** before the first send. No transcript is stored anywhere: not in `metadata.json`, not in the catalog.

### 5.7 Multi-machine

- `catalog.json` at the library root is a flattened derived cache of every book record. Every `metadata.json` write path upserts it; bulk operations batch one write at the end, off the critical path.
- **First run on a new machine:** choose root → catalog detected → _"Found a Musaeum library with N books — use it?"_ → populate the cache. No re-import.
- **Adoption reconciles reading state** (newer local wins) instead of replacing rows wholesale.
- **Recovery:** _Rebuild catalog_ walks `books/*/metadata.json` with progress.
- Concurrency is deliberately last-write-wins (single user, one machine at a time); the design revision condition is ~50k books, not now.

### 5.8 Storage: a share, an external drive, or a folder on this Mac

- **The root's kind is recorded when the folder is picked** and shown in Settings → Library as *Local folder* or *Network share*, with a line naming the cloud client when the folder sits inside one (iCloud Drive, Dropbox, Google Drive, OneDrive, Box, Proton Drive — named with the last-write-wins hazard, never refused). §3.1 carries why the kind is stored rather than worked out at failure time.
- **A share** gets the full recovery: mount detection, 30-second health checks, auto-reconnect via `open -g smb://` on a 5 s/15 s/60 s backoff, a non-blocking banner, a manual *Retry Now*, and offline read-only cache mode so the library stays browsable and searchable while it is away.
- **A folder** gets **no retry loop at all**, deliberately: a backoff is a claim that waiting is a strategy, and for a folder it is false. The banner says the folder is missing and the recovery is the picker — *Locate Library Folder…*, opening at the folder that went missing or at its nearest surviving ancestor — and the refusal matches the state (*"The library folder is missing — choose where it went to make changes."*) instead of asking for a NAS.
- **The state machine reaches `disconnected` again.** A failed attempt used to pin the status at *"Reconnecting to the library…"*, so the half of the sentence that matters — _editing is disabled_ — appeared once and was replaced for good. This was never a local-disk bug: any share away for more than five seconds put the app in it.
- The **30-second health check runs for both kinds**, because it is an `fs.access` on a folder — which is what makes a re-plugged drive return within half a minute. Checked is not retried: that is the difference the two words exist to make.
- Every storage-dependent operation degrades rather than throwing, and the _reason_ reaches the UI: hydration keeps the file's embedded metadata, a root that is gone leaves the library browsable and searchable from the cache with editing disabled, and the empty pane goes silent rather than offering on-ramps it would refuse.

### 5.9 Device delivery (Kindle) and Apple Books

- USB device detection by polling `/Volumes` (5s); Kindle identified, Documents folder scanned.
- **Serial transfer queue** with per-book copy progress and `device_history` logging. On-demand **azw3 conversion** via `ebook-convert` when the device wants a format the library doesn't have — **PDF is never converted** (Kindles render PDFs natively), it is copied directly.
- **Robustness that came from real failures:** macOS's SMB client can fail `close()` on a file it has just read in full (seen on a 50MB azw3 whose copy on the device was byte-identical), so the copy owns its source fd, logs a close error instead of raising, and **verifies the destination size** before calling a book sent. Free space is read only from a real mount point and re-read every poll — a stale `/Volumes/Kindle` was reporting the boot disk's 73.2GB for a device with 21.3GB.
- Failed transfers are dismissible, show the full error, and offer _Try again_; successful ones auto-clear.
- **On-device presence** per §3.3, with badges on cards, an "On {device}" send state, and removal that deletes the file's own title/author match plus `.sdr` sidecars.
- **Apple Books export** for a single book (`open -a Books`).

### 5.10 Calibre migration

- **Read-only scan** of a Calibre library, then sidecar-orchestrated copy with streamed progress, optional rate-limited hydration (the 0.6s rate limit puts a 7,000-book run at ~90+ minutes on top of copy time), and an explicit cutover step — nothing is deleted from Calibre for you.
- **PDF top-up** (`topup_pdfs`) — a re-runnable tool that attaches PDFs from a Calibre library to existing book folders (idempotent; `.part` atomic copy) or imports PDF-only books as new, matching by Goodreads ID → ISBN-13 → normalized title+author and **skipping ambiguous matches rather than guessing**. Run against the real library on 2026-07-27.
- Converts and _adopts_ rather than requiring Calibre afterwards: `ebook-convert` is the only Calibre binary the app uses, its path is configurable, and a missing Calibre produces a clear error instead of a broken feature.

### 5.11 Theming

- Palette-only engine (§3.7) with import via native picker, drop anywhere on the Appearance section, or a drop-box folder (`~/Library/Application Support/Musaeum/themes`) with rescan and _Reveal in Finder_. Partial success is normal: five files with one bad one still import the other four.
- **Clicking a row applies it immediately** — no Save, no ⌘↵ — because a colour choice is its own feedback loop, and putting it behind the dialog's save chord is how a settings screen hides the thing you are looking at (measured: 19ms repaint with the modal still open).
- The reader's palette is in scope; themes apply to the whole app, with the window's own background colour set from the active theme before the renderer exists (no flash — tokens applied 19.6ms after document-start, first paint at 44ms).

### 5.12 Settings, platform integration and packaging

- **Settings** for library root (with catalog-adoption prompt), `smb_url`, Python path, `ebook-convert` path and the Google Books API key. Values are validated _before_ anything is written, so a failed save leaves the previous settings intact; clearing a field deletes the key so auto-detection resumes; each field's placeholder is the value actually in force, distinguishing "set here" from "auto-detected" from "not found".
- **Native application menu** carrying ⌘, for Settings and ⌘1/⌘2 for views. Menu items emit a command and the renderer decides what it means, so a menu item and its in-app control can't drift apart.
- **View mode and sort persist** across restarts; filters and the search query deliberately don't. A restored sort is validated on rehydrate.
- **Packaging:** `npm run pack` → a 117MB DMG (arm64, `productivity`). The bundle ships the sidecar as source but not the venv; on first launch the app finds a system Python 3.11+, builds a venv in Application Support and installs dependencies into it (~20s, once, with progress in the status bar), skipping later launches via a requirements hash — and searching interpreters by absolute path too, because a double-clicked app inherits launchd's minimal `PATH`. The build is **unsigned** today (tracked in `tasks.md`).
- **A secret path that needs no terminal:** the API key can live in `app_config` and wins over the environment, so a double-clicked `.app` works without an `infisical run` wrapper.
- **Two rows in Settings are not preferences.** The Library section reports the storage **kind** (and the cloud client, when the folder is inside one), and renders the **SMB URL** field only when the library really is a share — it no longer fills its own placeholder with `smb://nas`, which is not compiled into the app at all any more. **Phone access** is the REST surface's switch: apply-on-click, a port and a bind field, the token (masked, with reveal and copy), the URL to type into the phone, and a live status line that renders the server's own reason verbatim when a bind fails. The four `app_config` keys behind it are validated before any write, and a cleared field is deleted rather than stored as `''`.
- **Maintenance moved out of the sidebar and into Settings**, with the descriptions a destructive twenty-one-minute action deserves; its progress and Cancel live in the status bar, because the job outlives the selection that started it.

### 5.13 The iOS companion

**The client is real, and it lives in its own repository: `jasonoh/musaeum-ios`** (locally `../musaeum-ios`) — SwiftUI over Readium, deployment target iOS 18, built by XcodeGen from `project.yml`. It is not a design any more; it is the app its author reads on his phone.

In the order he would use it: **connect** with the URL and bearer token the Mac's Settings row prints (the token is a Keychain item; the check reports the contract version, the app version, the book count and whether the library is mounted); **browse** the library as a paged cover grid in **the Mac's own sort orders** — the menu curates eight, drawn from the same six fields the Mac itself sorts by, in the Mac's own wording — and run the Mac's own full-text search, so the same query returns the same books in the same order on both machines; **narrow** it with the Mac's own facet vocabulary and counts — read status, format, a rating floor, and the library's own authors, series and tags — every tick applying at once, with the toolbar saying how many are on; **download** a book into the app's own storage and **read** it there, opening at the fraction the Mac last recorded; **report the position back** when the book closes or the app leaves the foreground, queued on the phone while the Mac is asleep or unreachable, flushed when it answers, and ordered by the report's own clock so a stale phone cannot drag the Mac's position backwards; and **send a book the other way**, from a Files picker or a share sheet.

Four things about it are decisions rather than features:

- **The contract is not restated in the client, and that is mechanical rather than aspirational.** `docs/rest-api.md` in this repo owns the wire; the client **extracts its test fixtures from that document by script** (`scripts/vendor-contract-fixtures.sh` reads its `json payload=` blocks), so a field the document does not name and the wire does not carry fails the client's suite. A payload change is therefore a change **here** first, document and goldens together — which is why §3.8 describes the routes, their payloads and `api-smoke.sh` as one artifact.
- **Nothing about the Mac's file layout crosses the wire.** A book is asked for by `id` and `format`, the local file's name is the client's own business, and no `file://` URL is ever composed. The fraction is the only position that travels: a Readium `Locator` is an engine coordinate and stays on the phone.
- **The server is never a dependency.** Offline, `401`, `404`, `503` and an unknown `apiVersion` are ordinary states with their own surfaces — never a crash, and never a dialog nobody can act on — and a downloaded book still reads with every one of them true at once.
- **The token stays in one process**, which is what decided the shape of the upload's second route (below).

**Sending a book into the library.** `POST /api/books?format=&filename=` carries the book's bytes as its body and answers `201` with the row it created — the same row the Mac's own picker would have made, through the same importer, so a book that arrives this way is indistinguishable afterwards from one dropped on the window. The client's half is a Files picker in the library's toolbar (one file at a time) plus **Copy to Musaeum** in any share sheet, declared as document types rather than as a share *extension* — and that is a decision with a measurement behind it: an extension is a second process, and getting a picked file across to the app needs either an app-group container or a keychain access group, **both Apple Developer Program capabilities**, so with the free personal team this app is signed with, adding either stops the profile being issued and *the app itself stops installing on the iPhone* — while the simulator would have stayed green throughout. Declaring the four formats costs no entitlement and makes iOS hand the app its own copy of the file, which then goes out through the same path the picker's does. The client did have to grow one case the Mac's new route demanded: a `413 content too large` fell into `default` and read as *the Mac is not answering*, **and was retried** — the one failure that route produces which a retry cannot fix. Nothing in either suite could see that gap until a client existed, which is the argument for the client living in its own repository rather than in a plan.

**Its own gates, measured in that repository on 2026-09-24:** `xcodebuild test` — **117 cases across 15 suites, 0 failures** (16 test files, one of them the `URLProtocol` stub). The Mac's side of the same contract is `scripts/api-smoke.sh`, which exercises every route against a live server and, on the landed upload slice, recorded **70 passed / 0 failed** (`docs/superpowers/plans/2026-09-23-phone-upload-slice2.md` — a number quoted from that record rather than re-run for this document). The client's design, its per-slice plans, its live-probe script and its evidence frames are all in its own repository, under `docs/specs/`, `docs/plans/` and `docs/evidence/`.

---

## 6. Engineering character

- **Performance targets vs measured:** library load <2s, cold start <3s, hydration <5s/book, storage reconnection <5s, conversion <30s, memory <500MB. Measured against a **synthetic 7,000-book library**: `getBooks` **115 ms**, search **18 ms**, ~40 rendered items and ~1,000 DOM nodes at any scroll offset (was 7,000 rows), 32 MB JS heap. Measured against the **live 7,101-book library on the share**: `getBooks` **152 ms**, title search **3 ms**. Two numbers taken under different conditions are stated with their conditions, not averaged. The scale pass exists because the app was not allowed to solve this by "get a smaller library".
- **Tests follow the reasoning:** **1,512 vitest tests across 64 files** — both main process and renderer, through `npm test`, which runs Electron-as-Node so the native better-sqlite3 ABI matches — and **113 pytest tests** in the sidecar covering the merge policy, EPUB extraction against fixture books, PDF metadata, hydration, the PDF top-up and the theme derivation. Cases are chosen to kill specific mutations, and the harness records which mutations it reproduced.
- **The suite is falsified, not merely green.** Slices are asked to prove a decider can fail: restoring a one-line pin has to redden a named case, an inverted branch has to fail in both directions, and a criterion whose mutation survives is reported as *no decider* rather than counted as coverage. That discipline is what caught the two defects most worth recording — a field-override map marked *after* the row was written (a silent no-op with a green suite) and a `413` that a client mapped correctly and then retried anyway.
- **Typecheck and lint are clean** and treated as a gate, not a suggestion; TypeScript strict, no `any`.
- **Docs discipline:** 12 invariant files, **16 specs and 21 plans** under `docs/superpowers/`, and a changelog that records _why_ — including the measurements that exposed the bugs.

---

## 7. What is not built

Stated plainly, because a feature list without this section is marketing:

- **No annotations, highlights or bookmarks.** Deliberately out of the reader, and still waiting on a storage decision: highlights are the first thing that would make a book's record grow without bound, so they need somewhere to live before there is UI.
- **PDF does not open in the reader** — PDFs open in Preview. Everything else about PDF is first-class: import, hydration, covers, transfer (copied, never converted), the Calibre top-up, and the wire (`format=pdf` is served).
- **No manual cover picker.** The candidates are gathered and one can be set underneath; the picker is the one slice of that design still unbuilt, and its annex is written.
- **No bulk metadata edit** across a selection (add tags, set series, set read status) — the one group-meaningful action left out of the selection work.
- **No collections UI.** The schema has `collections` / `book_collections`; the UI does not.
- **No OPDS feed** — specified and **conditional**, its first precondition being a second reading device that speaks OPDS. Without one, not building it remains the right answer.
- **No Goodreads account sync**, and **no update mechanism** — the packaged build is manual for now.
- **The phone app is narrower than the Mac.** It cannot read PDFs (they are served over the wire; the phone's reader wires up no PDF engine), a download that drops **starts again rather than resuming**, it keeps **no local library cache** (the list it draws comes from the Mac, and the queue of positions waiting to be reported has no screen of its own), and it **sends one book at a time**. Each of those carries the condition that would revive it in that repo's `tasks.md`.
- **An upload is not resumable.** `POST /api/books` has no `Range` and no idempotency key, so a failed send is a new send: survivable rather than tidy, because a duplicate is answered by policy rather than refused, but it costs a large file's transfer time. A book that is not a readable file on disk — an undehydrated iCloud Drive placeholder, a Photos item, a URL — is reported rather than worked around.
- **An external drive is reasoned about rather than driven.** The kind rule puts any local filesystem on the folder path — no retry, no mount — but the only local shape exercised in the running app so far is a folder on the boot disk.
- **A library inside a cloud folder is named, not policed.** The line about the last-write-wins hazard is copy rather than a guard: nothing blocks the choice, and what a sync client does to a `metadata.json` mid-write is unmeasured.
- **Untested against real SMB failure modes.** The offline path was verified with a local folder standing in for a share; mount loss mid-import and mid-transfer are still not exercised against a real server.
- **The packaged build is unsigned, and has only been opened on this machine.** Signing needs a Developer ID certificate, which is blocked on an Apple Developer account — and the DMG has not been run on a second Mac, which was the point of packaging it.
- **The iOS client is built from source onto your own device.** There is no App Store or TestFlight release and no signed distribution, and the free personal team's provisioning profile expires every seven days until one re-run from Xcode renews it.
- **The `imports/` drop folder has never actually fired.** The watcher is armed on launch and re-armed on every reconnect, and the inbox has held zero files since July — so the feature is live, named by nothing in the suite, and its success path is an `rm`, which makes it a hazard rather than a gap. The honest options are to test it or to remove it.
- **No multi-user, no web UI, and no mobile client other than the iOS one.** Multi-user and a web UI are **rejected** rather than pending; other mobile platforms are not planned. Musaeum is one person, one library.
- **Raw-markup fragility:** the Goodreads series scraper parses embedded JSON with an HTML fallback and degrades silently by design.

**The 2026-09-19 analysis that produced the three specs** (`docs/superpowers/specs/`, the reader's Ask panel, OPDS, and a library-wide index of book contents) is worth closing out explicitly, because two of its three have moved: the **Ask panel shipped** (§5.6), **OPDS stays conditional** on a device that speaks it, and the third — a library-wide index of book _contents_, which is what Calibre's full-text search does — was **rejected** rather than deferred, with its reversal condition written down in that spec's D1. A spec here means the decision is actionable the moment its trigger fires, not that work has started; the in-book search that did ship is the other half of that decision, and it needs no index at all (§5.6).

---

## 8. How it differs from existing ebook managers and readers

> **A dated, sourced, column-by-column comparison now lives in [`comparison.md`](comparison.md)** (checked 2026-10-06). This section is the longer narrative; where the two disagree, `comparison.md` is the newer.

### 8.1 The landscape

| Tool                                                | What it actually is                                                             | Where it sits                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Calibre**                                         | Desktop library manager + converter + editor + viewer + optional content server | The incumbent. Enormous feature surface. Explicitly **not** for a library on a network drive.                                                                                                  |
| **Calibre-Web**                                     | A web front-end over an existing Calibre `metadata.db`                          | Browse/read/send from anywhere; **requires a pre-built Calibre library**, and heavy editing still happens in desktop Calibre. Historically turbulent fork history.                             |
| **Kavita / Komga** | Self-hosted _servers_ (Docker or standalone), comics/manga first, ebooks second | Multi-user, OPDS, per-page progress, Kobo/KOReader sync. Need a server and a browser or a third-party app to read. |
| **BookLore → BookOrbit** | Self-hosted _servers_ (Docker), ebook-first, with comics and (BookOrbit) audiobooks | BookLore is entering maintenance mode; **BookOrbit** is its official successor, with a native iOS app. Both document network storage as unsupported. Community fork: Grimmory. Details in [`comparison.md`](comparison.md). |
| **Readarr / LazyLibrarian**                         | _Acquisition_ automation (`*arr` stack)                                         | Watches authors, grabs new releases via Usenet/torrent. Readarr's repo was archived June 2025. Not a reader or a curated library.                                                              |
| **Thorium Reader / Foliate / KOReader**             | Readers                                                                         | Excellent reading apps, no library-management layer: no hydration of a large collection, no device delivery workflow. Foliate is Linux-first; Thorium is cross-platform and accessibility-led. |
| **Kindle / Apple Books / Kobo / Google Play Books** | Retail ecosystems                                                               | Beautiful reading, but your library lives in their cloud, on their terms, in their formats.                                                                                                    |
| **BookFusion**                                      | Cloud ebook service + Calibre sync plugin                                       | Cross-device reading and highlight sync — by syncing your library into their cloud.                                                                                                            |

### 8.2 What Musaeum does differently

**1. The library is a directory of files, not a database with a window around it — which is what makes a NAS, an external drive and a plain folder the same thing to the app.** Calibre's manual: _"Do not put your calibre library on a networked drive… most network filesystems lack various filesystem features that calibre uses… calibre is a single user application, if you accidentally run two copies of calibre on the same networked library, bad things will happen."_ That is an honest constraint about Calibre's own design: its library _is_ one SQLite file. Musaeum was specified for a 7,000-book SMB-hosted library and therefore keeps the canonical record in per-book files, with the queryable database as a disposable local cache — and that is also why the same root works on a share, on a drive, and in a folder on a laptop with no server anywhere near it. This is the single biggest architectural difference in this comparison.

**2. There is no shared database to corrupt, lose, or outgrow.** Every alternative above makes one file or one server's database authoritative. In Musaeum the authoritative thing is the book's own folder; the fast queryable copy is local and regenerable. Practical consequences: a torn or absent cache is a rebuild, not a recovery; concurrent access can't corrupt anything; and pointing a second machine at the share is a read, not a migration.

**3. Multi-machine access without a server, without Docker, and without a browser.** Calibre-Web and the Kavita/Komga/BookLore family give you multi-device access — by standing up a service and reading in a browser or a third-party app. Musaeum gives the second Mac a native app from `catalog.json` in the share, and reading position that follows you between them with reconciliation (strictly newer progress wins) rather than blind overwrite. The phone is the same idea one step further: the Mac binds a socket on the tailnet — off unless switched on — and the client is a real SwiftUI app in its own repository, so the books travel between two machines the owner already owns, with no account, no sync service and no third party holding the library (§3.8).

**4. Device presence is judged by the file's own content, not its filename.** This is the difference between _"1,347 of 6,460 books are on your Kindle"_ and _"86 of 1,555 files were recognized"_ — measured on a real device, on both sides of the change. Calibre, as the app that wrote those files, does not face the problem; every tool that reads someone else's device does, and most solve it with filenames.

**5. The hydration pipeline argues with itself in public — and learns.** Fetching is table stakes (Calibre-Web and Kavita both scrape online metadata). What is unusual is the explicit policy: reviewed fields vs quiet fields, embedded and Calibre identifiers always winning over fetched ones, a cover score with a published formula, and a resolver that biases future scoring toward the source you keep choosing.

**6. It reads the books, in the app, over the same protocol that serves covers — with the sandbox kept.** One gesture opens any book: EPUB/MOBI/AZW3 in the reader, PDF in Preview. The renderer is never handed a `file://` path, book content can't execute, and CSP admits no remote host, so a book can't phone home. Bringing the reader in-house is also what makes "reading position follows you" possible at all.

**7. It is fast at the size where the alternatives get slow, and it reports its numbers.** ~40 rendered items and ~1,000 DOM nodes at any scroll offset in a 7,000-book library; 115ms to load, 18ms to search. Those figures exist because the virtualization is hand-rolled to keep the grid a CSS grid and the list a real `<table>`.

**8. Failures degrade visibly and are reported in user terms.** Offline mode instead of an error; hydration that keeps embedded metadata instead of throwing; _"No new metadata found"_ as an answer distinct from a failure; a send that says _Sending… / On Kindle / Couldn't send — retry_ instead of a button that lies. The app treats "what did that action actually do?" as a feature.

**9. Beauty and theming are requirements, not polish.** Neither Calibre, Calibre-Web, Kavita, Komga nor Thorium derives a matched design system from a palette the user already owns elsewhere, with contrast floors enforced and a refusal-with-reason when a palette cannot be made legible — and a rule that a theme supplies palette only, never layout.

**10. It is a tool for owning your files, and behaves like one.** No account, no third party, and no listener at all unless the owner turns the phone's one on — and when it is on it binds the tailnet address only, behind a token the app generates itself (§3.8). Metadata lookups are the other half of the network traffic and they are best-effort with silent degradation. Calibre migration is read-only against Calibre and ends at an explicit cutover.

### 8.3 Where the others win — plainly

- **Calibre has a far broader feature surface**, and honestly more than Musaeum will have for a long time: a conversion matrix across ~20 formats, a full EPUB editor, **a library-wide full-text index of book contents** (Musaeum searches inside the book you have open — ⌘F, and it needs no index at all — but its catalog is what it indexes library-wide, and a contents index was rejected rather than deferred), custom columns, a plugin ecosystem, virtual libraries, and a content server. If you are editing metadata by hand at scale, Calibre is the stronger tool. _(This paragraph is general knowledge, not re-verified here beyond the FAQ's conversion matrix and network warning.)_
- **Every server option beats Musaeum on reach.** Kavita, Komga, BookLore and Calibre-Web give multi-user access with per-user permissions, OPDS, Kobo sync, Tachiyomi/Mihon and KOReader integration, and reading on a phone or tablet in bed. Musaeum's answer to the last of those is one iOS app for one person — which is a phone in bed, but it is not reach.
- **They also beat it on comics and manga** (CBZ/CBR are not supported here at all), on **annotations and highlights** (Thorium and Calibre's viewer have them; Musaeum's reader deliberately doesn't yet), and on **bookmarking/wiki metadata depth**.
- **Retail ecosystems win on convenience** and on the fact that most readers already have a phone/tablet reading app they like.
- **Readarr/LazyLibrarian win on acquisition automation** — they go get new releases. Musaeum only ever manages what you already own and hand it.
- **Musaeum is macOS-only, single-user, unsigned today, and needs Python 3.11+ for its full feature set.** It is not trying to be a product for other people, and it should not be recommended as one yet.

### 8.4 Choosing, briefly

| If your situation is…                                                                                     | The better tool                              |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 7,000 books on a NAS, a drive or a folder, one Mac (or two), a Kindle on USB, an iPhone, and one fast app that reads and curates | **Musaeum**                                  |
| You want to read your library on a phone, from anywhere, with other people                                | **Calibre-Web / Kavita / BookLore** (server) |
| Deep metadata surgery, conversion between exotic formats, plugins, in-book full-text search               | **Calibre**                                  |
| Comics and manga are the core of the library                                                              | **Kavita / Komga**                           |
| You want it to go _find_ new books for you                                                                | **LazyLibrarian**                            |
| You just want to read one EPUB beautifully, with annotations, accessibility-first                         | **Thorium Reader**                           |
| Your books are in Amazon's / Apple's ecosystem and you're happy there                                     | **Kindle / Apple Books**                     |

**The honest one-liner:** Musaeum is what Calibre's own documentation tells you not to do — put the library on a NAS — done deliberately from the first line of the data model and generalised since to an external drive or a plain directory on a laptop with no server anywhere near it: wrapped in an app that reads the books, knows what's on the Kindle, serves the library to the owner's own phone, and reports what it actually did.

---

## 9. Sources

Everything about Musaeum in this document is measured from this repository at `93d2103` (see the stamp at the top for the suites re-run on 2026-09-24), except the numbers attributed to the iOS client, which were measured in `jasonoh/musaeum-ios`. Competitor claims come from:

- Calibre manual, FAQ — "Do not put your calibre library on a networked drive", conversion format matrix: <https://manual.calibre-ebook.com/faq.html>
- Calibre content server: <https://manual.calibre-ebook.com/en/server.html>
- Calibre-Web feature list and install requirements (needs a valid Calibre database): <https://github.com/janeczku/calibre-web>
- Kavita vs Calibre-Web vs Komga feature/resource comparison:
  <https://selfhosting.sh/compare/kavita-vs-calibre-web-vs-komga>
- Self-hosted ebook landscape (Calibre-Web "read-mostly", server-side fork history): <https://devhandbook.io/blog/2026-08-25-self-hosted-ebook-library-calibre-web-kavita-komga>
- BookLore (self-hosted, multi-user, OPDS, Kobo/KOReader sync, built-in reader):
  <https://github.com/booklore-app/booklore>
- Readarr archived / LazyLibrarian maintained:
  <https://selfhosting.sh/compare/readarr-vs-lazylibrarian/>
- Thorium Reader (EPUB 3 reader, accessibility-led):
  <https://www.thoriumreader.com/> · <https://thorium.edrlab.org/en>
- Foliate (Linux GTK reader with a library view, EPUB/MOBI/AZW3):
  <https://en.wikipedia.org/wiki/Foliate_(software)>
- Amazon Send to Kindle dropping MOBI/.AZW/.PRC, adding EPUB:
  <https://blog.the-ebook-reader.com/2023/09/25/send-to-kindle-losing-mobi-support-probably-for-real-this-time>
- BookFusion Calibre sync plugin (cloud sync of a Calibre library):
  <https://support.bookfusion.com/hc/en-us/articles/360018852052>
