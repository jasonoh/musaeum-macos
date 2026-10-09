<div align="center">

<img src="docs/assets/logo.png" alt="Musaeum" width="128" height="128" />

# Musaeum

**Your ebook library, where you keep it — on a NAS, an external drive, or a folder on your Mac.**

Import once, let the metadata fill itself in, read the books, and send them to a Kindle. No server, no account, no Docker, and no database in your library folder.

[![CI](https://github.com/jasonoh/musaeum-macos/actions/workflows/ci.yml/badge.svg)](https://github.com/jasonoh/musaeum-macos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/jasonoh/musaeum-macos?color=c9a24d)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/jasonoh/musaeum-macos?color=c9a24d)](CHANGELOG.md)
[![Last commit](https://img.shields.io/github/last-commit/jasonoh/musaeum-macos?color=c9a24d)](https://github.com/jasonoh/musaeum-macos/commits/main)
<br />
[![macOS](https://img.shields.io/badge/macOS-arm64-1c1a17?logo=apple&logoColor=white)](#-getting-started)
[![Electron](https://img.shields.io/badge/Electron-44-1c1a17?logo=electron&logoColor=9feaf9)](docs/architecture.md)
[![React](https://img.shields.io/badge/React-18-1c1a17?logo=react&logoColor=61dafb)](docs/architecture.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-1c1a17?logo=typescript&logoColor=3178c6)](docs/architecture.md)
[![Python](https://img.shields.io/badge/Python-3.11%2B-1c1a17?logo=python&logoColor=ffd343)](docs/getting-started.md)

[Features](#-features) · [Comparison](#-how-it-compares) · [Getting started](#-getting-started) · [iOS companion](#-ios-companion) · [Documentation](#-documentation) · [Changelog](CHANGELOG.md)

<br />

<img width="1438" height="898" alt="Musaeum — the library grid" src="https://github.com/user-attachments/assets/62d8c12d-0fb4-4c6c-9274-90da079f438e" />

</div>

---

## ✨ Features

|                          |                                 |                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📥 **Import**            | EPUB, MOBI, AZW3 and PDF        | Drag onto the window, drop in `imports/`, or ⌘O. A duplicate pauses the import and asks.                                                                                                                                                     |
| 🔎 **Metadata**          | Hydrated automatically          | The file itself, Google Books, OpenLibrary and Goodreads. Disagreements go to a review queue; a field you edit stays yours.                                                                                                                  |
| 🗂️ **Library**           | Built for 7,000+ books          | Virtualized grid and list, full-text search in about 18 ms, facets, six sorts, bulk actions.                                                                                                                                                 |
| 📖 **Reader**            | EPUB, MOBI, AZW3 and PDF in-app | Search inside the book, an optional Ask panel pointed at a model you choose, and a reading position that follows you between machines. A PDF-only book is prepared into a readable EPUB on demand, and its original PDF is one gesture away. |
| 📲 **Kindle**            | Over USB                        | Knows what's already on the device, converts to AZW3 on demand, and says what a send actually did.                                                                                                                                           |
| 💾 **Storage**           | A share, a drive or a folder    | A NAS gets mount recovery and an offline read-only cache; a plain folder doesn't pretend a server exists.                                                                                                                                    |
| 🎨 **Theming**           | A dark library, in your colors  | Import a base16, iTerm2 or Obsidian palette. Contrast floors are enforced, and a palette that can't hold them is refused.                                                                                                                    |
| 📚 **Calibre migration** | Read-only                       | Copy a Calibre library across with progress. Nothing in Calibre is ever deleted.                                                                                                                                                             |

Every one of these has a measurement behind it. [`docs/project-overview.md`](docs/project-overview.md) is the full inventory.

## 🗄️ The library is just files

```
{library_root}/
├── books/<uuid>/
│   ├── metadata.json      ← canonical record for this book
│   ├── cover_full.jpg · cover_thumb.jpg
│   └── <title>.epub / .mobi / .azw3 / .pdf
├── catalog.json           ← derived, regenerable
└── imports/               ← watched drop folder
```

Per-book files are canonical and `catalog.json` is derived, so there is no shared database to corrupt, and a second Mac adopts the whole library from `catalog.json` instead of re-importing. The SQLite database is a disposable local cache. Calibre's manual [says not to keep a library on a network drive](https://manual.calibre-ebook.com/faq.html); Musaeum was designed for exactly that. [Why I built it →](docs/why-i-built-it.md)

## ⚖️ How it compares

Musaeum is one person's Mac app, so the servers beat it on reach and Calibre beats it on depth. This is the short version; [`docs/comparison.md`](docs/comparison.md) has the full chart, sources for every cell, and where each tool is the better pick. ❔ means not verified, not "no". Checked 2026-10-06.

|                            | **Musaeum**                         | **Calibre**            | **Calibre-Web-Automated** | **BookOrbit**  | **Kavita**       | **Komga**     |
| -------------------------- | ----------------------------------- | ---------------------- | ------------------------- | -------------- | ---------------- | ------------- |
| **Shape**                  | Mac app                             | Desktop app            | Docker server             | Docker server  | Docker or binary | Docker or JAR |
| **No server to run**       | ✅                                  | ✅                     | ❌                        | ❌             | ❌               | ❌            |
| **Library on a NAS**       | ✅ The design target                | ❌ Docs advise against | ⚠️ With a workaround      | ❌ Unsupported | ❔               | ❔            |
| **Multi-user**             | ❌                                  | ⚠️ Content server      | ✅                        | ✅             | ✅               | ✅            |
| **Automatic metadata**     | ✅ With a review queue              | ✅                     | ✅                        | ✅             | ⚠️ Paid Kavita+  | ❔            |
| **Reads in-app**           | ✅ EPUB, MOBI, AZW3, PDF (reflowed) | ✅                     | ✅ Browser                | ✅             | ✅               | ✅            |
| **Annotations**            | ❌                                  | ✅                     | ❔                        | ✅             | ✅               | ❔            |
| **Comics and manga**       | ❌                                  | ⚠️                     | ❔                        | ✅             | ✅               | ✅            |
| **Audiobooks**             | ❌                                  | ❔                     | ❔                        | ✅             | ❌               | ❌            |
| **Kindle**                 | ✅ USB, judged by content           | ✅                     | ✅ Auto-send              | ❔             | ❔               | ❔            |
| **Kobo / KOReader / OPDS** | ❌                                  | ❔                     | ✅                        | ✅             | ✅               | ✅            |
| **iPhone app**             | ⚠️ Build from source                | ❔                     | ❔                        | ✅ App Store   | ❔               | ❔            |
| **Licence**                | MIT                                 | GPL-3.0                | GPL-3.0                   | AGPL-3.0       | GPL-3.0          | MIT           |

**BookLore** has no column because it is entering maintenance mode, with [BookOrbit as its official successor](https://github.com/booklore-app/booklore). Its community fork, **Grimmory**, is covered in the full comparison.

**Where Musaeum is different:** the library is a folder of files rather than a database, so a NAS, an external drive and a plain folder are the same thing to it. There is no server, no Docker and no account, and "is it on my Kindle" is answered by each file's own title and author rather than its filename. **Where it isn't better:** multi-user access, Kobo and KOReader sync, comics, audiobooks, annotations, and distribution, since its iPhone app is built from source and its Mac app is unsigned.

## 🚀 Getting started

**You need:** macOS (arm64), Node 22.12+, Python 3.11+, and somewhere to keep the library. **No Calibre** — EPUB → AZW3 conversion on a Kindle send is built into the app. A Google Books API key is optional too.

```bash
git clone https://github.com/jasonoh/musaeum-macos.git && cd musaeum-macos
npm install                                  # also rebuilds better-sqlite3 for Electron

python3.12 -m venv sidecar/.venv             # the Python metadata sidecar
sidecar/.venv/bin/pip install -r sidecar/requirements.txt

./scripts/build-layout-helper.sh             # the PDF reader's Swift helper (Apple Vision):
                                             # needs the Xcode toolchain, writes
                                             # helpers/bin/ (gitignored). Without it PDF
                                             # reflow falls back and 3 pytest cases skip

npm run dev                                  # launch with hot reload
```

To build the app instead, run `npm run pack`. It writes `dist/Musaeum-<version>-arm64.dmg`, which is currently **unsigned**, so macOS needs a right-click → Open the first time. There is no published release yet.

On first launch, choose the library folder: a folder on this Mac, an external drive, or a mounted share. Drop books on the window and they're imported and hydrated in the background.

More: [`docs/getting-started.md`](docs/getting-started.md) covers first launch, the Google Books key, tests and packaging in detail.

## 📱 iOS companion

A companion iPhone app lives in [its own repository](https://github.com/jasonoh/musaeum-ios) (SwiftUI over Readium, iOS 18). It browses, searches, filters, downloads and reads the same library, carries reading position back to the Mac, and can send a book into the library from the share sheet.

- **No cloud in between.** The phone talks to your Mac over your tailnet. The server is **off by default**, bound to the tailnet address only, and answers 401 to anything without its bearer token.
- Switch on **Settings → Phone access**, then enter the URL and token on the phone.
- [`docs/rest-api.md`](docs/rest-api.md) is the one document that owns the wire; the iOS repo derives its test fixtures from it.

## 🧭 Where it stands

Musaeum is the app its author uses daily, against a real 7,000-book library and a real Kindle. It is a single-user tool, not a product with a support desk.

- ✅ The full loop works: **import → hydrate → curate → read → send**, plus the iOS companion.
- ⚠️ It is an **Electron** app, not a native one: macOS-only (arm64 build), single-user, and **unsigned** for now.
- ⚠️ No annotations or highlights, no bulk metadata edit, no OPDS, no auto-update.
- ✅ **Kindle sends convert in-house.** EPUB → AZW3 is the app's own writer, so no Calibre binary is installed, detected or required; Calibre's *library* is still readable for a migration, and nothing is ever deleted from it.
- 🔬 Verification is layered: well over a thousand vitest cases, a pytest suite for the sidecar, strict TypeScript, and CI on every push.

[`tasks.md`](tasks.md) is the honest backlog; [`docs/roadmap-history.md`](docs/roadmap-history.md) is the record of everything already landed behind it. [`docs/project-overview.md`](docs/project-overview.md) has the full "not built" list and a sourced comparison with Calibre, Calibre-Web, Kavita and Komga, including where they plainly win.

## 📚 Documentation

| Document                                                                                       | What's in it                                                                                                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`docs/getting-started.md`](docs/getting-started.md)                                           | Requirements, first launch, the Google Books key, tests, packaging                                                        |
| [`docs/project-overview.md`](docs/project-overview.md)                                         | The design bets, the full feature inventory, what isn't built, and how it compares to Calibre and the self-hosted servers |
| [`docs/why-i-built-it.md`](docs/why-i-built-it.md)                                             | The story behind it: Calibre, a NAS, and a Kindle that was lying                                                          |
| [`docs/architecture.md`](docs/architecture.md)                                                 | Process model, directory layout, path aliases, performance targets                                                        |
| [`docs/data-contracts.md`](docs/data-contracts.md)                                             | `metadata.json`, the SQLite schema, the sidecar RPC, the preload API                                                      |
| [`docs/rest-api.md`](docs/rest-api.md)                                                         | The HTTP contract the phone is written against                                                                            |
| [`docs/invariants/`](docs/invariants/)                                                         | One file per subsystem: the rule, the measurement behind it, the rejected alternative                                     |
| [`docs/how-this-was-built.md`](docs/how-this-was-built.md)                                     | How the project was built and verified                                                                                    |
| [`tasks.md`](tasks.md) · [`CHANGELOG.md`](CHANGELOG.md) · [`requirements.md`](requirements.md) | The backlog, the history, and the original spec                                                                           |
| [`docs/roadmap-history.md`](docs/roadmap-history.md)                                           | The shipped record, moved out of `tasks.md` — every landed slice and its numbers                                          |
| [`CLAUDE.md`](CLAUDE.md)                                                                       | The agent brief: invariants, conventions, and which doc to read before touching what                                      |

## 🤖 How this was built

Musaeum is AI-assisted. The application code was written by AI coding agents under the author's direction: the requirements, constraints, design bets, acceptance criteria and overrules are the author's, and the implementation, tests and invariant files are largely the agents'. It was accepted against a real NAS library and a real Kindle rather than fixtures. [`docs/how-this-was-built.md`](docs/how-this-was-built.md) is the honest account, including the bugs that took adversarial review to find.

## 📄 License

[MIT](LICENSE) © 2026 Jason I. Oh
