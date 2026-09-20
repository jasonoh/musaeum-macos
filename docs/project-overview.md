# Musaeum — Project Overview & Feature Inventory

> Human-facing companion to `CLAUDE.md` (the agent brief), `docs/architecture.md`
> (process model) and `docs/data-contracts.md` (stored shapes). This file answers
> two questions: **what is this, feature by feature**, and **how does it differ
> from everything else that manages or reads ebooks?**
>
> Every number here was measured on this repo at the commit named below, or is
> quoted from a cited source. Where a claim is general knowledge rather than
> verified, it says so.

**Measured at:** `88a6830` ("kindle issues"), working tree clean — 631 vitest tests across 29 files, 65 pytest tests, both green.

---

## 1. What it is

A **macOS desktop application for personally owning a large ebook library** — in practice 7,000+ books on network-attached storage. It imports and hydrates metadata, presents a fast visual library, opens and reads the books itself, and puts them on a Kindle over USB.

It is a **single-user, local-first replacement for a Calibre workflow**, not a service. There is no account, no server, no Docker, no cloud, and no network listener. The only thing on the wire is outbound metadata lookups (Google Books, OpenLibrary, Goodreads) that the user can run keyless or not at all.

Two constraints shape nearly every decision in this repo:

1. **The library lives on an SMB share and must survive it being flaky.** A mounted NAS is not a local disk, and the architecture is arranged around that (see §3.1).
2. **Beauty is a first-class requirement, not a finish step.** The UI is a "dark library" — warm near-black surfaces, amber/gold accents, serif display type, covers as the hero element — and the palette is fully themeable from the user's own colour schemes.

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
| **Theming**         | Palette engine with contrast floors + import/picker (slices 1–4)                                                                                                                                                        | 2026-09-15/16 |
| **Quality pass**    | Scroll reset, stable sort ties, recomputed file sizes, conflict service extraction, +118 tests                                                                                                                          | 2026-09-16    |
| **Kindle presence** | Presence by each device file's _own_ title+author; send receipt; cover backfill                                                                                                                                         | 2026-09-17    |

**Maturity read:** the daily-driver loop — import → hydrate → curate → read → send — is complete and verified against a real 7,000-book NAS library and a real Kindle. The gaps are listed honestly in §7.

---

## 3. The design bets

Seven decisions explain most of the code. They are the interesting part of the project; the feature list in §5 is downstream of them.

### 3.1 The NAS is not a disk — so the database is not on it

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
- **The fix:** read each device file's _own_ title and author out of its header and match on those, with an order-insensitive author key (Calibre's "Banks, Iain M." equals the library's "Iain M. Banks"). Presence now answers **1,347 of 6,460 books**. The filename rule survives only as the fallback for files whose header cannot be read (KFX, PDF).
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

---

## 4. Architecture at a glance

```
Electron Main (Node)                    Renderer (React)              Python Sidecar
├── IPC handlers (thin wrappers)        ├── Grid / List / Detail      ├── EPUB + PDF extractors
├── services/ — ALL business logic      ├── Reader (foliate-js)       ├── Calibre metadata.db reader
├── SQLite cache (better-sqlite3, WAL)  ├── Conflict queue            ├── Google Books / OpenLibrary
├── SMB mount manager + health (30s)    ├── Device panel + queue      ├── Goodreads series scraper
├── chokidar watcher on imports/        ├── Migration wizard          ├── Cover scorer + downloader
├── USB device polling (5s)             ├── Settings + Appearance     ├── Hydration pipeline
├── Transfer queue (serial)             └── Zustand stores            ├── ebook-convert wrapper
└── Sidecar process manager                                           └── Calibre migration + PDF top-up
```

- **IPC:** every handler returns `{success, data | error}` — nothing throws across the boundary. `window.Musaeum` is the whole renderer contract.
- **Sidecar:** JSON-RPC over stdio, thread-pooled so long calls don't serialize; streams progress notifications. Auto-restarts on crash (max 3); when absent, the app degrades to filename metadata.
- **Schema:** `PRAGMA user_version` migrations, FTS5 over title/author/series/ tags/description with sync triggers, four migrations to date.
- **Code size:** ~16,100 lines main process, ~10,000 renderer, ~2,700 sidecar; ~7,600 vendored reader engine. 631 main-process tests across 29 files and 65 Python tests, all green.

---

## 5. Feature inventory

### 5.1 Import

- **Three ways in:** drag files onto the window, drop into `{root}/imports/` (chokidar-watched), or the migration wizard.
- **Duplicate gate, not a warning row.** An ISBN-13 hit or normalized title+author match _pauses_ the import and forces a choice: **Skip / Add as new / Add format to existing**. "Add format" deletes any prior file of that extension first, so a stale copy can't be sent to a device.
- UUID book directories; filenames derived from a sanitized title; `metadata.json` written atomically; hydration kick-off is non-blocking.
- PDF is a first-class input alongside EPUB/MOBI/AZW3.

### 5.2 Metadata hydration

- See §3.2 for the policy. Mechanically: extraction → parallel fetch → merge → conflict queue → cover scoring → resize to 600px/200px → write.
- Per-book provenance is recorded (`fetched_at`, `match_confidence` per source).
- **Re-fetch one book or a whole selection.** Single: an awaited call that reports the diffed result (with a spinner on the button _and_ on the card, so a refresh started elsewhere and left behind is still visible). Bulk: a _sequential, cancellable_ job — sequential because the sidecar would otherwise fan concurrent hydrations at rate-limited APIs, batched so the catalog is written once, with progress and Cancel in the status bar because the job outlives the selection that started it.
- A re-fetch that finds disagreement offers a **Review** button on the report rather than leaving a badge to be noticed.

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
- **Reading works offline.** It's the one action not disabled when the NAS is unreachable: it isn't a write, and the reader saying it can't reach the file beats a dead button that won't say why.

### 5.7 Multi-machine

- `catalog.json` at the library root is a flattened derived cache of every book record. Every `metadata.json` write path upserts it; bulk operations batch one write at the end, off the critical path.
- **First run on a new machine:** choose root → catalog detected → _"Found a Musaeum library with N books — use it?"_ → populate the cache. No re-import.
- **Adoption reconciles reading state** (newer local wins) instead of replacing rows wholesale.
- **Recovery:** _Rebuild catalog_ walks `books/*/metadata.json` with progress.
- Concurrency is deliberately last-write-wins (single user, one machine at a time); the design revision condition is ~50k books, not now.

### 5.8 NAS and offline behaviour

- Mount detection; auto-reconnect via `open -g smb://` with 5s/15s/60s backoff; 30s health checks; offline/read-only mode with a banner; reconnection detection inside the 5s target.
- Every NAS-dependent operation degrades rather than throwing, and the _reason_ reaches the UI.

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

### 5.13 Staged for a companion app

The architecture is deliberately shaped for an iOS companion: the schema holds no UI-coupled fields, `metadata.json` is the documented contract, paths are relative to the library root, covers ship at two resolutions, all data access goes through the service layer (so lifting it into a standalone API server stays cheap), and a REST module exists at `electron/main/api/rest.ts` **disabled** behind `rest_api_enabled = false`. Nothing is exposed today.

---

## 6. Engineering character

- **Performance targets vs measured:** library load <2s (measured `getBooks` 115ms + 18ms search at 7,000 books), cold start <3s, hydration <5s/book, NAS reconnection <5s, conversion <30s, memory <500MB (32MB heap in the library view). The scale pass exists because the app was not allowed to solve this by "get a smaller library".
- **Tests follow the reasoning:** 631 vitest tests / 29 files in the main process (run through Electron-as-Node so the native better-sqlite3 ABI matches) and 65 pytest tests in the sidecar covering the merge policy, EPUB extraction against fixture books, PDF metadata, hydration and the PDF top-up. Cases are chosen to kill specific mutations, and the harness notes which mutations it reproduced.
- **Typecheck and lint are clean** and treated as a gate, not a suggestion; TypeScript strict, no `any`.
- **Docs discipline:** 12 invariant files, 14 specs/plans under `docs/superpowers/`, and a changelog that records _why_ — including the measurements that exposed bugs.

---

## 7. What is not built

Stated plainly, because a feature list without this section is marketing:

- **No mobile reading, no multi-user, no web UI.** Musaeum is one person on one Mac (or a second Mac pointed at the same share). iOS companion is roadmap (contract staged); multi-user and a web UI are rejected rather than pending.
- **No OPDS feed.** Now **specified, conditionally** — `docs/superpowers/specs/2026-09-19-opds-catalog-design.md`, whose first precondition is a second reading device that speaks OPDS. Without one, not building it remains the right answer.
- **No annotations, highlights or bookmarks.** Deliberately out of the reader's first release; highlights are the first thing that would make a book's record grow without bound, so they need a storage decision before UI.
- **No in-book search.** Now **specified** and recommended as the next reader slice — `docs/superpowers/specs/2026-09-19-reader-search-design.md`; the vendored engine already implements the search itself.
- **No AI or conversation features of any kind.** Captured as an owner idea 2026-09-19 and recorded in `tasks.md` → *Captured, not analysed* — asking an AI about the book currently open, with the reading position (or a highlight) as the context. Not designed, not sized for real. The owner's position is **pointer-only**: send a title, author, section and the highlighted passage, and let the model's own knowledge carry the rest — measured against this library, that is well-founded for the canon slice and poor for the 2000–2023 non-fiction majority. Because `open()` already holds the book in memory, the recall check that decides between them can run locally, so egress stays small either way and a local model makes it zero.
- **No collections UI.** The schema has `collections` / `book_collections`; the UI does not.
- **PDF in the reader** — PDFs open in Preview today.
- **No bulk metadata edit** across a selection (add tags, set series, set read status) — the one group-meaningful action left out of the selection work.
- **Covers are not written on send**, and Amazon destroys them, so a fresh send still lands without a cover (Calibre keeps a restore cache for exactly this).
- **The packaged build is unsigned and untested on a second Mac.** Signing needs a Developer ID.
- **Untested against real SMB failure modes** — offline mode was verified with a local folder; mount-loss mid-import and mid-transfer are still not exercised.
- **No update mechanism** (manual for now).
- **Raw markup-fragility risk:** the Goodreads series scraper parses embedded JSON with an HTML fallback, and degrades silently by design.

Two of these were analysed against the roadmap and written up as designs (`docs/superpowers/specs/`, 2026-09-19); **neither is scheduled** — a spec here means the decision is actionable when its trigger fires, not that work has started. The third item on that analysis's shortlist — a library-wide index of book _contents_, which is what Calibre's full-text search does — was **rejected** rather than deferred, with its reversal condition recorded in the first spec's D1.

---

## 8. How it differs from existing ebook managers and readers

### 8.1 The landscape

| Tool                                                | What it actually is                                                             | Where it sits                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Calibre**                                         | Desktop library manager + converter + editor + viewer + optional content server | The incumbent. Enormous feature surface. Explicitly **not** for a library on a network drive.                                                                                                  |
| **Calibre-Web**                                     | A web front-end over an existing Calibre `metadata.db`                          | Browse/read/send from anywhere; **requires a pre-built Calibre library**, and heavy editing still happens in desktop Calibre. Historically turbulent fork history.                             |
| **Kavita / Komga / BookLore**                       | Self-hosted _servers_ (Docker) built for comics/manga first, ebooks second      | Multi-user, OPDS, per-page progress, Kobo/KOReader sync. Need a server and a browser or a third-party app to read.                                                                             |
| **Readarr / LazyLibrarian**                         | _Acquisition_ automation (`*arr` stack)                                         | Watches authors, grabs new releases via Usenet/torrent. Readarr's repo was archived June 2025. Not a reader or a curated library.                                                              |
| **Thorium Reader / Foliate / KOReader**             | Readers                                                                         | Excellent reading apps, no library-management layer: no hydration of a large collection, no device delivery workflow. Foliate is Linux-first; Thorium is cross-platform and accessibility-led. |
| **Kindle / Apple Books / Kobo / Google Play Books** | Retail ecosystems                                                               | Beautiful reading, but your library lives in their cloud, on their terms, in their formats.                                                                                                    |
| **BookFusion**                                      | Cloud ebook service + Calibre sync plugin                                       | Cross-device reading and highlight sync — by syncing your library into their cloud.                                                                                                            |

### 8.2 What Musaeum does differently

**1. It is built for the library to live on a NAS — the exact configuration Calibre tells you not to use.** Calibre's manual: _"Do not put your calibre library on a networked drive… most network filesystems lack various filesystem features that calibre uses… calibre is a single user application, if you accidentally run two copies of calibre on the same networked library, bad things will happen."_ Musaeum was specified for a 7,000-book SMB-hosted library, and that is why its canonical record is per-book files plus a disposable local cache rather than one shared SQLite file. This is the single biggest architectural difference in this comparison.

**2. There is no shared database to corrupt, lose, or outgrow.** Every alternative above makes one file or one server's database authoritative. In Musaeum the authoritative thing is the book's own folder; the fast queryable copy is local and regenerable. Practical consequences: a torn or absent cache is a rebuild, not a recovery; concurrent access can't corrupt anything; and pointing a second machine at the share is a read, not a migration.

**3. Multi-machine access without a server, without Docker, and without a browser.** Calibre-Web and the Kavita/Komga/BookLore family give you multi-device access — by standing up a service and reading in a browser or a third-party app. Musaeum gives the second Mac a native app from `catalog.json` in the share, and reading position that follows you between them with reconciliation (strictly newer progress wins) rather than blind overwrite.

**4. Device presence is judged by the file's own content, not its filename.** This is the difference between _"1,347 of 6,460 books are on your Kindle"_ and _"86 of 1,555 files were recognized"_ — measured on a real device, on both sides of the change. Calibre, as the app that wrote those files, does not face the problem; every tool that reads someone else's device does, and most solve it with filenames.

**5. The hydration pipeline argues with itself in public — and learns.** Fetching is table stakes (Calibre-Web and Kavita both scrape online metadata). What is unusual is the explicit policy: reviewed fields vs quiet fields, embedded and Calibre identifiers always winning over fetched ones, a cover score with a published formula, and a resolver that biases future scoring toward the source you keep choosing.

**6. It reads the books, in the app, over the same protocol that serves covers — with the sandbox kept.** One gesture opens any book: EPUB/MOBI/AZW3 in the reader, PDF in Preview. The renderer is never handed a `file://` path, book content can't execute, and CSP admits no remote host, so a book can't phone home. Bringing the reader in-house is also what makes "reading position follows you" possible at all.

**7. It is fast at the size where the alternatives get slow, and it reports its numbers.** ~40 rendered items and ~1,000 DOM nodes at any scroll offset in a 7,000-book library; 115ms to load, 18ms to search. Those figures exist because the virtualization is hand-rolled to keep the grid a CSS grid and the list a real `<table>`.

**8. Failures degrade visibly and are reported in user terms.** Offline mode instead of an error; hydration that keeps embedded metadata instead of throwing; _"No new metadata found"_ as an answer distinct from a failure; a send that says _Sending… / On Kindle / Couldn't send — retry_ instead of a button that lies. The app treats "what did that action actually do?" as a feature.

**9. Beauty and theming are requirements, not polish.** Neither Calibre, Calibre-Web, Kavita, Komga nor Thorium derives a matched design system from a palette the user already owns elsewhere, with contrast floors enforced and a refusal-with-reason when a palette cannot be made legible — and a rule that a theme supplies palette only, never layout.

**10. It is a tool for owning your files, and behaves like one.** No account, no service, no listener. Metadata lookups are the only network traffic and they are best-effort with silent degradation. Calibre migration is read-only against Calibre and ends at an explicit cutover.

### 8.3 Where the others win — plainly

- **Calibre has a far broader feature surface**, and honestly more than Musaeum will have for a long time: a conversion matrix across ~20 formats, a full EPUB editor, **full-text search inside book contents** (Musaeum searches its catalog, not the pages), custom columns, a plugin ecosystem, virtual libraries, and a content server. If you are editing metadata by hand at scale, Calibre is the stronger tool. _(This paragraph is general knowledge, not re-verified here beyond the FAQ's conversion matrix and network warning.)_
- **Every server option beats Musaeum on reach.** Kavita, Komga, BookLore and Calibre-Web give multi-user access with per-user permissions, OPDS, Kobo sync, Tachiyomi/Mihon and KOReader integration, and reading on a phone in bed. Musaeum has none of that.
- **They also beat it on comics and manga** (CBZ/CBR are not supported here at all), on **annotations and highlights** (Thorium and Calibre's viewer have them; Musaeum's reader deliberately doesn't yet), and on **bookmarking/wiki metadata depth**.
- **Retail ecosystems win on convenience** and on the fact that most readers already have a phone/tablet reading app they like.
- **Readarr/LazyLibrarian win on acquisition automation** — they go get new releases. Musaeum only ever manages what you already own and hand it.
- **Musaeum is macOS-only, single-user, unsigned today, and needs Python 3.11+ for its full feature set.** It is not trying to be a product for other people, and it should not be recommended as one yet.

### 8.4 Choosing, briefly

| If your situation is…                                                                                     | The better tool                              |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 7,000 books on a NAS, one Mac (or two), a Kindle on USB, and you want one fast app that reads and curates | **Musaeum**                                  |
| You want to read your library on a phone, from anywhere, with other people                                | **Calibre-Web / Kavita / BookLore** (server) |
| Deep metadata surgery, conversion between exotic formats, plugins, in-book full-text search               | **Calibre**                                  |
| Comics and manga are the core of the library                                                              | **Kavita / Komga**                           |
| You want it to go _find_ new books for you                                                                | **LazyLibrarian**                            |
| You just want to read one EPUB beautifully, with annotations, accessibility-first                         | **Thorium Reader**                           |
| Your books are in Amazon's / Apple's ecosystem and you're happy there                                     | **Kindle / Apple Books**                     |

**The honest one-liner:** Musaeum is what Calibre's own documentation tells you not to do — put the library on a NAS — done deliberately from the first line of the data model, wrapped in an app that reads the books, knows what's on the Kindle, and reports what it actually did.

---

## 9. Sources

Everything about Musaeum in this document is measured from this repository at `88a6830`. Competitor claims come from:

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
