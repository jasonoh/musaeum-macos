# Musaeum

**A macOS app for a large ebook library — on a NAS, an external drive, or a folder on this Mac.** Import once, hydrate the metadata automatically, curate and read the books, and put them on a Kindle — with the library staying exactly where you put it.

Musaeum is a native macOS application for personally owning a 7,000-book collection. It is a single-user, local-first replacement for a Calibre workflow: **no server, no account, no browser, no Docker, and no database in the library folder.** The canonical copy of the library is the files you already have, in folders you can read with `ls` — and the app takes that as literally as it sounds. The library root is **a mounted share, an external drive, or any folder on this Mac**; the app records which one you picked, and only a share ever gets a mount attempt.

It is now two apps: this one, and an **iOS companion** that reads the same library from a phone (see [The iOS companion](#the-ios-companion) — it lives in [its own repository](https://github.com/jasonoh/musaeum-ios)). Type the Mac's URL and token into the phone and the library is on it — no cloud in between, and reading position that travels both ways.

It is the app its author actually uses, against a real 7,000-book SMB share and a real Kindle — and, since 2026-09-24, against a library that is a plain folder on a machine with no server anywhere near it. Not a demo, and not a product with a support desk.

---

## Why I built it

Calibre is the incumbent for good reasons: nothing else converts between as many formats, edits EPUBs, or has a decade of metadata tooling behind it. Two things about it still didn't fit my library.

**The library is on a NAS.** Mine is 7,000 books on an SMB share, reachable from more than one Mac. Calibre's own manual [says not to do that](https://manual.calibre-ebook.com/faq.html) — _"Do not put your calibre library on a networked drive"_ — because the entire library is one SQLite file (`metadata.db`) whose assumptions about file locking and hard links don't hold over a network filesystem, and two copies of Calibre opening one share can corrupt it. That is an honest constraint, and Calibre's answer is to not share the library directory at all and run a Content server instead. It just means Calibre is the wrong tool for the arrangement I actually have.

**Everything else on top of it.** Calibre is effectively several programs in one window — library manager, converter, EPUB editor, viewer, content server, plugin host — and the part I needed was a small slice of that. Every alternative that solves multi-device access solves it by standing up a service: Calibre-Web in front of an existing Calibre database, Kavita/Komga/BookLore in Docker, a browser to read in. Musaeum goes the other way: one Mac app that knows where the books are, what they are, what's on the Kindle, and where I stopped reading.

**Then I asked the question that turned out to matter more than the NAS.** _Can someone with a laptop and no server use this?_ (2026-09-24). In principle yes — and almost entirely for free, because every storage decision in this repo is path-generic: a plain folder already imports, hydrates, reads, transfers and round-trips reading state exactly as a share does. One assumption was not. An unreachable root was treated as a share that had dropped, so a library that was just _a folder on this Mac_ and got renamed made the app shell a mount command at a server that does not exist — at 5 seconds, then 15, then 60, **forever** — with a _Retry Now_ button that ran the same thing and a refusal that told you to reconnect to a NAS. There is no honest way to fix that with better copy: the app had to know which of the two it was holding. It now records that when you pick the folder, because that is a fact available while the path exists and a guess once it is gone.

**What actually took the work** was the small dishonest failure modes. `Difficult to ascertain whether a book is on or off the Kindle` is a complaint I wrote into a spec — and when I measured it, the app was offering to send roughly 1,400 books that were already on the device. A Kindle row showed 73 GB free on a device with 21 GB. A cover that would not change, and would not say why. Most of the interesting code in this repo came from turning those feelings into counts, and then fixing the thing behind the count.

---

## What it does

### Import

- Three ways in: drag files onto the window, drop them into `{library_root}/imports/`, or **File ▸ Add Books…** (⌘O).
- **EPUB, MOBI, AZW3 and PDF** are all first-class inputs — import, extraction, covers, transfer and migration.
- A duplicate is a decision, not a warning row. An ISBN-13 hit or a normalized title+author match _pauses_ the import and forces a choice: **Skip / Add as new / Add format to existing**. A duplicate that only a metadata _fetch_ reveals is reported too, on the surface that path already has, with no buttons — a shared ISBN is not proof of the same file.
- Every book gets a UUID folder with a `metadata.json` written atomically; hydration runs in the background, so import never blocks on the network.

### Metadata

- Hydration draws on the file itself (EPUB OPF, PDF Info dict), Google Books, OpenLibrary, and Goodreads for series — plus Calibre's own `metadata.db` as an identifier seed during migration.
- **Identifiers the file or Calibre already declares always beat a fetched one.** That is a precedence rule rather than a confidence score, because live testing caught Google Books confidently returning a _different edition_ and replacing a book's own ISBN — and a rule can't regress the way a heuristic can.
- **High-stakes disagreements go to a human.** Title, author and series land in a review queue with the candidates side by side and cover previews inline. Publisher, date and language auto-resolve by source priority, so the queue stays quiet.
- Covers are scored, not guessed — resolution, aspect ratio, source priority and file size, with a published formula and a 120 px floor; if the top two are within 15% a conflict is queued _while the winner still applies_, so no book is ever left coverless waiting for review.
- **A field you edit is yours.** A save or a resolved conflict records the field as an override, and later fetches are kept off it — with a padlock chip in the editor to hand the field back to Musaeum without changing its value. The reported case behind this: an author corrected by hand, re-fetched back to the wrong value on the same row.
- **A re-fetch reports what it did.** _Metadata updated_ names the fields that moved; _No new metadata found_ is an answer distinct from a failure; a re-fetch that turns up disagreement offers a **Review** button rather than a badge you have to notice.

### Browsing and curating

- A cover grid and a sortable list, **both virtualized by hand** — a 7,000-book library renders about 40 items and 1,000 DOM nodes at any scroll offset instead of 7,000 rows. The library query measured **115 ms** and search **18 ms** on a synthetic 7,000-book library, and **152 ms / 3 ms** against the live 7,101-book library on the share.
- Full-text search (SQLite FTS5) over title, author, series, tags and description, with facet filters carrying live counts, and six sort fields with a pinned tiebreak so equal keys hold a stable order.
- Sort keys derived on every write path — `The Great Gatsby` → `Great Gatsby, The`; surname particles and generational suffixes handled (`Ursula K. Le Guin` → `Le Guin, Ursula K.`; `King Jr.` stays under K).
- Multi-select with ⌘/⇧-click, ⇧+arrows, a checkbox column and ⌘A; bulk delete, bulk send to device, bulk re-fetch (sequential, cancellable, with progress and Cancel in the status bar).
- A metadata editor for title, author, series, publisher, date, language, tags, description and identifiers — **only changed fields are sent**, so a save can't clobber what hydration filled in meanwhile.
- Delete with per-format granularity, reveal in Finder, or open a format in its system default app.

### Reading

- **EPUB, MOBI and AZW3 open in the app's own reader** (a vendored foliate-js) — double-click, the detail panel's Read button, the context menu, or the selection panel. PDFs open in Preview for now; PDF in the reader is the next phase.
- **Search inside the book** (⌘F): hits grouped by chapter in reading order, counts per chapter, click to jump, and outlines drawn on the page in the reader's own palette. Nothing is indexed and nothing leaves the machine — the engine searches the copy of the book already open in memory, so it works offline and on a dropped share.
- **Ask about what you're reading.** A panel beside the page sends your question with the title, author, section label, position and the passage around you to an endpoint _you_ configure — a local model (Ollama, LM Studio, llama.cpp/vLLM) by default, or a cloud provider if you point it at one. Recall is checked against the local text first, and the panel discloses exactly what it is about to send before the first send.
- Typography controls (typeface, size, line height, spacing, page palette) remembered per machine, all of it themed.
- **Position and read status follow you between machines**, reconciled rather than overwritten: strictly newer progress wins, so reading offline and quitting can't lose a session and a stale record from the other Mac can't rewind one. Opening a book starts it, passing 98% finishes it, and the transition only ever moves forward — so a book you mark read by hand stays read.
- Reading is the one action that keeps working when the library is unreachable: it isn't a write, and the reader saying it can't reach the file beats a dead button that won't say why.

### Devices

- A **Kindle over USB** is detected and its Documents folder scanned.
- **Presence is judged by each file's own embedded title and author, not its filename.** The app used to match titles against filenames, which only recognizes files it wrote itself — Calibre writes `{author_sort}/{title} - {authors}.ext`. Measured on the real device: recognition went from **86 of 1,555 files to 1,343**, and the "send to Kindle" offer for ~1,400 books already there went away. The filename rule survives only as the fallback for files whose header can't be read.
- A serial transfer queue with per-book progress; **on-demand AZW3 conversion** through Calibre's `ebook-convert`; PDF is never converted (Kindles render PDFs natively — it's copied directly).
- **A send says what it did:** _Sending… / On the device / Couldn't send — retry_, with the reason. The button used to re-enable mid-copy, and a second click put a byte-identical duplicate on the device.
- The copy owns its source file descriptor, logs rather than raises on a `close()` failure (macOS's SMB client can fail it on a file it has just read in full), and verifies the destination size before calling a book sent. Free space is read only from a real mount point and re-read on every poll — a `/Volumes/Kindle` folder left behind by an unclean unplug was reporting the boot disk's 73 GB for a 21 GB device.
- **Apple Books export** for a single book.

### Where the library lives

- **The root is a share, an external drive, or a folder on this Mac — and the app records which one when you pick it.** Settings → Library shows it as _Local folder_ or _Network share_. That is a fact stored at pick time rather than derived at failure time, because for a share an unmount takes the mount point with it (an ancestor walk then lands on `/Volumes`, which is the boot disk — measured).
- **A share** gets the full recovery: mount detection, 30-second health checks, reconnect with 5/15/60-second backoff, a non-blocking banner, a manual _Retry Now_, and a **read-only cache mode** while it is away so the library stays browsable and searchable.
- **A folder** gets no retry loop at all, deliberately. A backoff is a claim that waiting is a strategy and for a folder it is false — nothing is coming back on its own — so **no timer is armed and no mount is ever attempted**, not by the ladder and not by _Retry Now_. The banner says the folder is missing and the recovery is the picker: _**Locate Library Folder…**_ opens it **at the folder that went missing**, or at its nearest surviving ancestor, because a dialog ignores a starting point that does not exist. The refusal matches: _"The library folder is missing — choose where it went to make changes."_
- **One place composes every word the app says about storage, and it lives in the main process.** The banner, the sidebar's status row, Settings and both delete dialogs are readers of that one module, so no two surfaces can tell you a different story — and a sentence composed in main can be asserted by a test, where one typed inside a component cannot. It is also why **`smb://ohnas` is no longer compiled into the app**: until 2026-09-24 a _folder_ with a share configured had that mount run on its behalf, and the SMB URL field is now rendered only when the library really is a share.
- **A cloud-synced folder is named, not refused.** iCloud Drive, Dropbox, Google Drive, OneDrive, Box and Proton Drive are recognised by the folder's own path, and the app shows one line naming the client and the last-write-wins hazard rather than treating it as an ordinary folder — with iCloud's eviction behaviour claimed for iCloud alone, because that is the only client it was measured on. Anything else inside `~/Library/CloudStorage` is reported **by the name it spells** instead of as "not synced".
- Nothing storage-dependent throws: hydration failures keep the file's embedded metadata and never propagate, and the _reason_ reaches the UI. A root that is gone still leaves the library browsable and searchable from the local cache, with editing disabled and the empty pane silent — it used to offer three ways to add a book that the app would refuse.
- The 30-second health check runs for **both** kinds, because it is an `fs.access` on a folder, and it is what makes a re-plugged drive return within half a minute. Checked is not retried: that is the difference the two words exist to make.
- The library's own layout is the design bet, and it is also why none of the above needed a migration — the same root shape gets the same data model on all three:

```
{library_root}/
├── books/<uuid>/
│   ├── metadata.json      ← canonical record for this book
│   ├── cover_full.jpg     (600px) · cover_thumb.jpg (200px)
│   └── <title>.epub /.mobi /.azw3 /.pdf
├── catalog.json           ← derived, flattened, regenerable
└── imports/               ← watched drop folder
```

Per-book files are canonical and `catalog.json` is derived, so **there is no shared database to corrupt**: no locking or hard-link requirement, the only cross-machine write is an atomic file rename, a torn or deleted cache is a rebuild rather than data loss, and a second Mac adopts the whole library from `catalog.json` on connect instead of re-importing. The queryable SQLite database is a disposable local cache in `Application Support` — which is what makes a plain folder a perfectly good home for a library, and losing one an inconvenience rather than a catastrophe.

### Migration from Calibre

- A **read-only** scan of a Calibre library, sidecar-orchestrated copy with streamed progress, optional rate-limited hydration, and an explicit cutover step. Nothing is ever deleted from Calibre for you.
- A re-runnable **PDF top-up** attaches PDFs from the Calibre library to books already imported (idempotent, atomic), imports PDF-only books as new, and skips ambiguous matches rather than guessing.
- `ebook-convert` is the only Calibre binary the app touches; its path is configurable and a missing Calibre produces a clear error instead of a broken feature. Migrating does not require keeping Calibre.

### Theming

The UI is a "dark library" — warm near-black surfaces, amber/gold accents, serif display type, covers as the hero element — and **beauty is a requirement here, not a finish step**. You can point it at a palette you already use elsewhere: base16 (`.yaml`), iTerm2 (`.itermcolors`), or an Obsidian theme (its `theme.css` is read out of a live cascade, because those palettes are usually computed). The app derives its own design tokens from that palette with **contrast floors enforced at every step**, and a palette that can't hold a legible contrast is refused _with its reason_ instead of half-applied. A theme supplies **palette only — never geometry, typography or layout**. The reader and the window chrome follow it, imported themes survive their source file being moved or deleted, and applying one takes a single click with no save dialog.

---

## The iOS companion

Musaeum is two apps. This one owns the library; a companion iPhone app — SwiftUI over Readium, deployment target iOS 18, in [its own repository](https://github.com/jasonoh/musaeum-ios) (locally `../musaeum-ios`) — reads it from anywhere your phone can reach your tailnet. Same books, same covers, same reading position, and **no cloud in between**: the phone talks to your Mac, not to a service. No account, no sync service, no third party holding the library.

What's on the phone today:

- **Connect** with the URL and bearer token the Mac's Settings shows — the token lives in the Keychain, and the connection check reports the contract version, the app version, the book count and whether the library share is mounted.
- **The whole library as a cover grid**, paged from the Mac's own query, with **the Mac's own eight sort orders** and its **full-text search** — the same query returns the same books in the same order on both machines.
- **Filters that mirror the Mac's sidebar** — read status, format, a rating floor, and the library's own authors, series and tags, drawn from the Mac's own counts, every tick applying at once.
- **A download into the phone's own storage** and a **reader** that opens at the fraction the Mac last recorded. What you've downloaded stays readable with the Mac asleep, shut, or off the network entirely.
- **The position travels back.** Closing a book — or just putting the phone away mid-page — reports where you actually got to, queued on the phone when the Mac can't take it and flushed when it answers, ordered by the report's own clock so a stale phone reading can never drag the Mac's position backwards.
- **A book goes the other way too — from the phone into the library.** A Files picker in the library's toolbar, and **Copy to Musaeum** in any app's share sheet (Files, Safari, Mail) as the second way in. One row says what happened, in the Mac's own words: _Sent to the library_, _Sent — and you already had it_, or the refusal with its reason beside it; nothing is claimed before the Mac answers. The three refusal classes are treated as what they are — a `400` or a `413` is that book's own problem and offers nothing to retry, `503 busy` and a sleeping Mac are worth waiting out, and a `401` points at the settings row that shows the current token.

**A book can also come _to_ the library from another machine, and both halves of that are live.** `POST /api/books?format=epub&filename=…` carries the book's bytes as its body and answers `201` with the book it created — the same row the Mac's own file picker would have made, through the same importer, so a book that arrives this way is indistinguishable afterwards from one dropped on the window. It refuses honestly rather than hanging: `400` before anything is written; **`413 content too large` past 1 GiB, answered _while the sender is still uploading_**, so a file that will never fit is refused instead of waited out; `503 busy` when two byte transfers are already in flight; and `503` with a `Retry-After` when the library itself is unreachable. A book that collides with one you already own is **added, with the match named in the answer**, rather than stopped on a question nobody is looking at. The phone's half is a Files picker and a **Copy to Musaeum** share target, declared as a document type rather than as a share _extension_ — and that is a decision with a measurement behind it: an extension is a second process, and handing a picked file across to the app needs either an app-group container or a keychain access group, both of which are Apple Developer Program capabilities. With the free personal team this app is signed with, adding either stops the profile being issued and **the app itself stops installing on the iPhone**, while the simulator stays green throughout. Declaring the four formats costs no entitlement, keeps the token in one process, and makes iOS hand the app its own copy of the file — which then goes out through the same path the picker's does.

To use it: the Mac needs **Settings → Phone access** switched on, and both devices must be on the same tailnet. The server binds the tailnet address only, behind a generated bearer token, answers 401 to anything without it, and streams a book with range requests (the largest book in the library is 528 MB). There is no LAN or public surface, and the switch closes the socket when it goes off.

To build it: Xcode 27+ and `brew install xcodegen`, then `xcodegen generate` and `xcodebuild` — the simulator destination is an **id**, never a device name, and `Musaeum.xcodeproj` is generated output rather than the source of truth. Xcode's **free personal team is enough**, because the app declares no entitlements; what that costs is a provisioning profile that expires every 7 days and needs one re-run from Xcode to renew.

**The contract is deliberately not restated in the client.** [`docs/rest-api.md`](docs/rest-api.md) in this repo owns the wire — routes, payloads, statuses, auth, failure semantics, API version 1 — and the iOS repo **derives its test fixtures from that document by script**, so a field the document doesn't name and the wire doesn't carry fails its suite. [`scripts/api-smoke.sh`](scripts/api-smoke.sh) decides the same contract's executable half, exercising every route against a live Mac. The client's own decisions, its gates and the before/after frames for each of its slices live in its repo under `docs/specs/`, `docs/plans/` and `docs/evidence/`.

---

## How it differs from what already exists

| Tool                                    | What it actually is                                                     | Where it sits                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Calibre**                             | Desktop manager + converter + editor + viewer + optional content server | The incumbent, with an enormous feature surface — and explicitly **not** for a library on a network drive.                           |
| **Calibre-Web**                         | A web front-end over an existing Calibre `metadata.db`                  | Browse/read/send from anywhere, but it **requires a pre-built Calibre library**, and heavy editing still happens in desktop Calibre. |
| **Kavita / Komga / BookLore**           | Self-hosted servers (Docker), comics and manga first                    | Multi-user, OPDS, per-page progress, Kobo/KOReader sync — and a server plus a browser or third-party app to read in.                 |
| **Readarr / LazyLibrarian**             | Acquisition automation for the `*arr` stack                             | They go _find_ books for you; Readarr's repo was archived in June 2025.                                                              |
| **Thorium Reader / Foliate / KOReader** | Readers                                                                 | Excellent reading apps with no library-management layer: no hydration of a large collection, no device-delivery workflow.            |
| **Kindle / Apple Books / Kobo**         | Retail ecosystems                                                       | Beautiful reading, with your library in their cloud, on their terms, in their formats.                                               |

Five differences matter most:

1. **It is built for the library to be a directory of files — on a share, on a drive, or in a folder on this Mac — rather than a database with a window around it.** Calibre's manual says not to put the library on a networked drive because its library _is_ one SQLite file; Musaeum's library is books and folders, which is why the same root works on a NAS, on an external drive, and in a plain directory on a laptop with nothing else installed. That is the single biggest architectural difference in this comparison, and it's why the canonical record is per-book files plus a disposable local cache rather than one shared SQLite file.
2. **There is no shared database to corrupt, lose, or outgrow.** Every alternative above makes one file or one server's database authoritative. Here the authoritative thing is the book's own folder. A torn cache is a rebuild; concurrent access can't corrupt anything; pointing a second machine at the share is a read, not a migration.
3. **Multi-machine access without a server, a Docker container or a browser.** The second Mac gets a native app from `catalog.json` on the share, with reading position that follows you between them by reconciliation rather than blind overwrite.
4. **Device presence is judged by content, not filenames.** On a real Kindle, on both sides of the same change: **86 of 1,555 files recognized by filename, then 1,343 of them by their own embedded titles.**
5. **Failures degrade visibly and are reported in the user's terms.** Offline mode instead of an error, embedded metadata kept instead of a thrown exception, _"No new metadata found"_ as an answer distinct from a failure, a send state that doesn't lie, and a re-fetch that names the fields it moved. The app treats _"what did that action actually do?"_ as a feature.

**Where the others plainly win** — because a comparison without this is marketing:

- **Calibre has a far broader feature surface**, and will for a long time: a conversion matrix across ~20 formats, a full EPUB editor, a **library-wide index of book _contents_** (Musaeum searches inside the book you have open — ⌘F, and it needs no index — but its catalog is what it indexes library-wide, and a contents index was rejected rather than deferred), custom columns, a plugin ecosystem and virtual libraries. If you're doing metadata surgery at scale, Calibre is the stronger tool.
- **Every server option beats Musaeum on reach**: multi-user access with per-user permissions, OPDS, Kobo and KOReader sync, and reading on a phone or tablet in bed. Musaeum's own answer to the last of those is one iOS app for one person — which is a phone in bed, but it is not reach.
- **They also beat it on comics and manga** (CBZ/CBR aren't supported here at all) and on **annotations, highlights and bookmarks** (Musaeum's reader deliberately has none yet — highlights are the first thing that would make a book's record grow without bound, so they need a storage decision before UI).
- **Musaeum is macOS-only, single-user, unsigned today, and needs Python 3.11+ for its full feature set.** It is not trying to be a product for other people.

The honest one-liner: **Musaeum is what Calibre's own documentation tells you not to do — put the library on a NAS — done deliberately from the first line of the data model**, and generalised since to an external drive or a plain directory on a laptop with no server anywhere near it: wrapped in an app that reads the books, knows what's on the Kindle, and reports what it actually did. `docs/project-overview.md` carries the long version of this section, with a source for every competitor claim and a measurement for every number about Musaeum.

---

## Status

| Phase                    | Landed                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1.0 — MVP**            | Scaffold, NAS offline mode, import, hydration pipeline, conflict queue, grid/list/detail, FTS5 search + facets, Kindle transfer with conversion, Apple Books export, Calibre migration wizard, Python sidecar                                                                                    |
| **Multi-machine**        | `catalog.json` derived cache; a second Mac adopts the library on connect                                                                                                                                                                                                                         |
| **1.5 — PDF**            | PDF as a first-class format, plus the Calibre PDF top-up                                                                                                                                                                                                                                         |
| **Scale pass**           | Hand-rolled virtualization — the 7,000-book blocker, removed                                                                                                                                                                                                                                     |
| **Library UX**           | Keyboard navigation, metadata editor, sorting, delete dialogs, per-book context menu, bulk selection and bulk actions                                                                                                                                                                            |
| **Settings & packaging** | Settings modal, native menu, `Musaeum.app` / DMG, first-run Python bootstrap, app icon                                                                                                                                                                                                           |
| **Reader**               | EPUB/MOBI/AZW3 in-app, position and read status following you between machines, search inside the book, the Ask panel                                                                                                                                                                            |
| **Kindle presence**      | Presence by each file's own title and author; send receipts; cover backfill                                                                                                                                                                                                                      |
| **Theming**              | Palette engine with contrast floors, three import providers, the reader and window chrome included                                                                                                                                                                                               |
| **Metadata control**     | Field overrides with padlock chips, post-hydration duplicate reports, cover candidates and conflict previews                                                                                                                                                                                     |
| **iOS companion**        | The library served over the tailnet (off by default, bearer token, no LAN or public surface), plus an iPhone app that browses, searches, filters, downloads and reads it — and carries the reading position both ways                                                                            |
| **Storage**              | A library that is a folder on this Mac, an external drive, or a mounted share — the kind is recorded when you pick it, Settings shows it, and it decides the recovery: a share retries and re-mounts, a folder offers to be located and never pretends a server exists                           |
| **Phone uploads**        | `POST /api/books` — a book sent _to_ the library from another machine, through the same importer the Mac's own file picker uses, with a collision named rather than turned into a question nobody can answer — and the phone's half, a Files picker and a share target that needs no entitlement |

The daily-driver loop — **import → hydrate → curate → read → send** — is complete and verified against a real 7,000-book NAS library and a real Kindle, and the same loop runs against a library that is a folder on a machine with no server at all: the storage work above was driven in the running app on an isolated profile with the folder renamed out from under it and an `open` shim on the `PATH`, which is how the app proves it shells nothing.

**Verification is layered:** at the time of writing, **1,512 tests across 64 files** in the main process and renderer (vitest, run through Electron-as-Node so the native SQLite ABI matches) and **113 Python tests** in the sidecar, all green; TypeScript strict with no `any`, and typecheck and lint treated as gates rather than suggestions. Cases are chosen to kill specific mutations, and the harness records which mutations it reproduced. Performance targets are set against measured numbers rather than hopes. 33,696 lines of application code and about 25,000 lines of tests, plus ~7,600 lines of vendored reading engine.

### Not built

- **No annotations, highlights or bookmarks.** They need a storage decision first.
- **PDF doesn't open in the reader yet** — PDFs open in Preview.
- **No manual cover picker yet.** The machinery and the candidates exist; the picker is the next slice. Today a cover is chosen by score, and you can change it by resolving a cover conflict in the review queue.
- **No bulk metadata edit** across a selection (add tags, set series, set read status).
- **No collections UI** (the schema has it; the UI doesn't), **no Goodreads account sync**, **no OPDS feed** (specified, conditional on owning a second reading device that speaks it), **no update mechanism** (manual for now), and **no mobile app for any platform other than iOS**.
- **The phone app is narrower than the Mac.** It can't read PDFs (they're served over the wire, but the phone's reader doesn't wire up a PDF engine yet), a download that drops starts again rather than resuming, and it keeps no local library cache — the list it draws comes from the Mac. Each of those carries the condition that would revive it in [`musaeum-ios`'s `tasks.md`](https://github.com/jasonoh/musaeum-ios/blob/main/tasks.md).
- **A book reaches the library one file at a time, and an interrupted upload starts again.** The phone's picker takes a single file, the route answers one book per request, and a batch would be a queue the phone owns — there isn't one. There is no `Range` on `POST /api/books` and no idempotency key, which is survivable rather than tidy: a re-sent book is a second book, with the match named in the answer, so a failure costs a large file's transfer time and never a duplicate. A book that isn't a readable file on disk — an iCloud Drive placeholder the phone hasn't downloaded, a Photos item, a URL — is reported rather than worked around.
- **The phone app is built from source, onto your own device.** There's no App Store or TestFlight release, and no signed distribution: `xcodegen generate`, then Xcode, as above.
- **Covers aren't written to the Kindle on send**, and the current Kindle firmware no longer generates them, so a fresh send lands without one.
- **The packaged build is unsigned** and has only been opened on this machine; it needs a Developer ID certificate to be notarized.
- **A library inside a cloud folder is named, not policed.** The line about the last-write-wins hazard is copy rather than a guard: nothing blocks the choice, and what a sync client does to a `metadata.json` mid-write is unmeasured.
- **An external drive is reasoned about rather than driven.** The kind rule puts any local filesystem on the folder path — no retry, no mount — but the only local shape exercised in the running app so far is a folder on the boot disk.
- **Untested against real SMB failure modes** — the offline path was verified with a local folder standing in for a share, and mount loss mid-import and mid-transfer are still not exercised against a real server.

`tasks.md` is the honest, current backlog, down to the individual defect; `CHANGELOG.md` records the _why_ behind each change, including the measurements that exposed bugs.

---

## Getting it running

Requirements:

| Requirement                           | Why                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A place to keep the library**       | A mounted SMB share, an external drive, or any folder on this Mac — the app records which one it is when you choose it, and only a share ever gets a mount attempt |
| **macOS** (arm64 build today)         | The app is an Electron macOS app; the packaged DMG is arm64                                                                                                        |
| **Node 20.19+**                       | `npm run pack` needs it — electron-builder 26 loads an ESM-only dependency through `require`, which older Node refuses with `ERR_REQUIRE_ESM`                      |
| **Python 3.11+**                      | The metadata/conversion sidecar. A packaged build finds it and builds its own venv on first launch                                                                 |
| **Calibre** (optional)                | Only for `ebook-convert`, i.e. format conversion on send. Detected at `/Applications/calibre.app/Contents/MacOS/ebook-convert`, overridable in Settings            |
| **A Google Books API key** (optional) | Hydration runs keyless, but the free tier is rate-limited well below what a bulk migration needs                                                                   |

```bash
npm install                                  # postinstall rebuilds better-sqlite3 for Electron

python3.12 -m venv sidecar/.venv             # the Python sidecar
sidecar/.venv/bin/pip install -r sidecar/requirements.txt

npm run dev                                  # launch with hot reload
npm run typecheck && npm run lint            # keep clean; both pass on main
npm test                                     # vitest — main process AND renderer, run
                                            # through Electron-as-Node so the
                                            # better-sqlite3 native ABI matches;
                                            # invoke only through this script
```

The sidecar's own suite lives in `sidecar/tests/` and runs with `sidecar/.venv/bin/python -m pytest sidecar/tests` (after `pip install -r sidecar/requirements-dev.txt`).

First launch shows a banner to choose the library folder — **a folder on this Mac, an external drive, or a mounted share**. The app records which _kind_ it is when you pick it (re-picking re-derives it, so a wrong answer is also fixable), because the two fail differently, and **Settings → Library shows it**: _Local folder_ or _Network share_, with a line naming the cloud client when the folder sits inside one (iCloud Drive, Dropbox, Google Drive, OneDrive, Box, Proton Drive — named with the last-write-wins hazard, never refused). That is also the section that renders the **SMB URL** field, and it appears only when the library really is a share — it no longer fills its own placeholder with a machine you do not own. An unreachable share is retried on a 5/15/60-second backoff and re-mounted, and could genuinely come back on its own; an unreachable folder is **never retried and never mounted**, because nothing is coming back — the banner says the folder is missing and offers _Locate Library Folder…_, which opens the picker at the folder that went missing (or at its nearest surviving parent). Either way the library stays browsable from the local cache and editing stays disabled until it is back; the status row and the banner use the same words because both read them from one place; and the empty pane says nothing at all while the library cannot take a book, where it used to offer three ways to add one that the app would refuse. Books dropped onto the window, or into `{library_root}/imports/`, are imported and hydrated automatically, and **＋ Add Books** in the toolbar or `File ▸ Add Books…` (⌘O) opens a file picker.

### The Google Books key

Hydration picks the key up from either **Settings → Google Books** or the `GOOGLE_BOOKS_API_KEY` environment variable; Settings wins, so a double-clicked `.app` needs no terminal and no wrapper. Leave it blank to stay on the keyless tier. A bulk Calibre migration is the case that needs it — hydrating 7,000 books at the free tier's rate limit is a 90-minute job on top of the copy.

The maintainer's own setup injects it for dev runs with `infisical run -- npm run dev`, which sets the variable only for the wrapped process; a bare `npm run dev` still works, just on the keyless tier.

### Packaging

```bash
npm run pack       # build + electron-builder → dist/Musaeum-<version>-arm64.dmg
npm run pack:dir   # unpacked dist/mac-arm64/Musaeum.app, for fast iteration
```

The build is currently **unsigned** (`mac.identity: null`), so macOS needs a right-click → Open the first time. Signing and notarization are tracked in `tasks.md`.

The `.app` ships the sidecar as source but not `sidecar/.venv` — that venv is built against one machine's interpreter, hard-codes absolute paths, and nothing may write inside a signed bundle anyway. On first launch the app resolves a system Python 3.11+, builds a venv in `~/Library/Application Support/Musaeum/sidecar-venv`, and installs `requirements.txt` into it (~20 s, once, with progress in the status bar), skipping later launches on a hash of the requirements. So a packaged Musaeum requires Python 3.11+ on the host.

---

## How the code is organised

```
electron/main/     main process — IPC handlers (ipc/), ALL business logic (services/),
                   SQLite schema (schema/migrations/), the REST surface (api/)
electron/preload/  the window.Musaeum contextBridge API
src/               React renderer — components, Zustand stores, hooks, pure logic (lib/)
src/types/         shared TypeScript contracts used by all three layers
sidecar/           Python JSON-RPC sidecar — extractors, fetchers, hydration, conversion,
                   Calibre migration and PDF top-up
vendor/foliate-js/ the reading engine — vendored, never edited

../musaeum-ios/    the companion iOS client — a separate repository (SwiftUI over
                   Readium), written against this repo's docs/rest-api.md
```

Two rules hold across the repo: every IPC handler is a thin wrapper (business logic lives in `services/`, so lifting the whole thing into a standalone API server stays cheap), and the renderer never receives a `file://` path — covers and book bytes go through a custom `musaeum://` protocol that realpaths both the library root and the candidate. `docs/architecture.md` has the full process model, layout and path aliases.

**Twelve invariants are written down with their reasoning** — `docs/invariants/*.md`, one file per subsystem. Each records the measurement that produced the rule and the approach that was rejected, so a later change meets the reasoning rather than just the rule. Examples: nothing may read `formats[0]` (the array order is whatever the writing source left); sort keys are derived on every write path or books strand under the wrong letter; row height is computed from constants and never measured, or the virtualizer drifts without a build error.

---

## Documentation

| Document                                                                                  | What's in it                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`docs/project-overview.md`](docs/project-overview.md)                                    | The long version of the two sections above: the full feature inventory, a measurement behind each claim, and the sourced comparison to Calibre, Calibre-Web, Kavita, Komga and the rest — stamped at `f50d464` and re-measured in the same pass as this file |
| [`CLAUDE.md`](CLAUDE.md)                                                                  | The agent brief: the invariants as a list, the conventions, and the routing table saying which doc to read before touching which subsystem                                                                                                                   |
| [`docs/architecture.md`](docs/architecture.md)                                            | Process model, directory layout, path aliases, performance targets                                                                                                                                                                                           |
| [`docs/data-contracts.md`](docs/data-contracts.md)                                        | `metadata.json`, the SQLite schema, the sidecar RPC surface, the preload API                                                                                                                                                                                 |
| [`docs/rest-api.md`](docs/rest-api.md)                                                    | The HTTP contract this repo owes the phone — every route including the two writes, with payloads, statuses and failure semantics                                                                                                                             |
| [`jasonoh/musaeum-ios`](https://github.com/jasonoh/musaeum-ios)                           | The iOS client in its own repository: its design, plans, gates, before/after evidence frames and its own `tasks.md` — it deliberately does not restate the wire contract                                                                                     |
| [`docs/invariants/`](docs/invariants/)                                                    | One file per subsystem: the rule, the measurement that produced it, the rejected alternative                                                                                                                                                                 |
| [`tasks.md`](tasks.md)                                                                    | The working backlog, roadmap and known gaps                                                                                                                                                                                                                  |
| [`CHANGELOG.md`](CHANGELOG.md)                                                            | Release history, including the _why_ and the measurements that found each bug                                                                                                                                                                                |
| [`requirements.md`](requirements.md)                                                      | The original product spec, kept as the record of why the pieces are shaped as they are                                                                                                                                                                       |
| [`docs/superpowers/specs/`](docs/superpowers/specs/), [`plans/`](docs/superpowers/plans/) | Feature designs and their implementation plans, in flight and landed                                                                                                                                                                                         |
| [`docs/how-this-was-built.md`](docs/how-this-was-built.md)                                | An in-progress write-up on how the whole thing was built and verified                                                                                                                                                                                        |

### How this was built

Musaeum is AI-assisted. Its application code was written by AI coding agents under the author's direction — requirements, constraints, design bets, acceptance criteria and the overrules all his; implementation, tests, changelog and invariant files largely theirs. It was accepted against a real NAS library and a real Kindle, not fixtures. `docs/how-this-was-built.md` is the honest account of that split, including the bugs it took adversarial review and a mutating test harness to find.

---

## License

`package.json` declares MIT. There is no `LICENSE` file in the tree yet — it needs to be added before this repository goes public.
