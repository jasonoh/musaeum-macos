# How Musaeum compares

**Checked 2026-10-06.** Competitor claims come from each project's own README or documentation, listed under [Sources](#sources); Musaeum's come from this repository. Projects move quickly, so a cell here is a dated claim and not a standing one. Where a claim couldn't be confirmed from a primary source it says **not verified** instead of guessing.

This is a comparison of **library managers**: tools that hold a collection of ebooks and help you organize, read and deliver it. Readers (Thorium, Foliate, KOReader), retail ecosystems (Kindle, Apple Books, Kobo) and acquisition tools (Readarr, LazyLibrarian) are a different category and are covered in [`project-overview.md` §8](project-overview.md#8-how-it-differs-from-existing-ebook-managers-and-readers).

> **Read it as "who is it for", not "who wins".** Musaeum is a single-user Mac app that was designed around one arrangement: a large library on a NAS, a drive or a plain folder, with no server in the way. It does that well and plenty else less well. The servers beat it on reach and format breadth; Calibre beats it on depth; BookOrbit beats it on distribution.

| Mark | Meaning                                               |
| ---- | ----------------------------------------------------- |
| ✅   | Yes, per the project's own documentation              |
| ⚠️   | Partly, or with a caveat stated in the cell           |
| ❌   | No, or the project says it is unsupported             |
| ❔   | Not verified from a primary source — treat as unknown |

## The tools

| Tool                                                                                 | What it is                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Musaeum**                                                                          | A macOS desktop app (Electron) for a large personal library, plus a companion iOS app. Single-user, local-first, MIT.                                                                                                      |
| [**Calibre**](https://github.com/kovidgoyal/calibre)                                 | The incumbent desktop manager: library, conversion, editor, viewer, device transfer, and an optional Content server. GPL-3.0; macOS, Windows, Linux.                                                                       |
| [**Calibre-Web-Automated**](https://github.com/crocodilestick/Calibre-Web-Automated) | A Docker web front-end over a Calibre `metadata.db`, adding auto-ingest, conversion, duplicate detection and KOReader sync. A fork of [Calibre-Web](https://github.com/janeczku/calibre-web), which it builds on. GPL-3.0. |
| [**BookOrbit**](https://github.com/bookorbit/bookorbit)                              | A self-hosted reading platform for ebooks, PDFs, comics and audiobooks, and the **official successor to BookLore**, which is entering maintenance mode (see [BookLore and Grimmory](#booklore-and-grimmory)). AGPL-3.0.    |
| [**Kavita**](https://github.com/Kareadita/Kavita)                                    | A self-hosted reading server for manga, comics and books (EPUB, PDF). GPL-3.0, with an optional paid tier, Kavita+.                                                                                                        |
| [**Komga**](https://github.com/gotson/komga)                                         | A self-hosted media server for comics, manga, magazines and ebooks. MIT.                                                                                                                                                   |

## The chart

|                                       | **Musaeum**                                                                                 | **Calibre**                                             | **Calibre-Web-Automated**                                              | **BookOrbit**                                       | **Kavita**                                            | **Komga**                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| **Shape**                             | Desktop app (macOS only, arm64 build)                                                       | Desktop app; optional Content server                    | Web server (Docker)                                                    | Web server (Docker)                                 | Web server (Docker or binary; Windows, macOS, Linux)  | Web server (Docker or standalone)                       |
| **Needs a server running**            | ❌ The phone server is optional, off by default                                             | ❌ Optional Content server                              | ✅                                                                     | ✅                                                  | ✅                                                    | ✅                                                      |
| **Library on a NAS / SMB share**      | ✅ The design target                                                                        | ❌ Calibre's FAQ says not to                            | ⚠️ Supported with `NETWORK_SHARE_MODE=true`, which disables SQLite WAL | ❌ Network, NAS and cloud mounts are unsupported    | ❔                                                    | ❔                                                      |
| **Where the record lives**            | Per-book `metadata.json` files; SQLite is a disposable local cache                          | One SQLite file, `metadata.db`                          | Calibre's `metadata.db` plus its own `app.db`                          | PostgreSQL                                          | Its own database in its config directory              | ❔                                                      |
| **Needs an existing Calibre library** | ❌ Can import one, read-only                                                                | —                                                       | ✅                                                                     | ❌                                                  | ❌                                                    | ❌                                                      |
| **Licence**                           | MIT                                                                                         | GPL-3.0                                                 | GPL-3.0                                                                | AGPL-3.0                                            | GPL-3.0                                               | MIT                                                     |
| **Cost**                              | Free                                                                                        | Free                                                    | Free                                                                   | Free; managed hosting is offered                    | Free; optional Kavita+ at $4/month                    | Free                                                    |
| **Multi-user**                        | ❌ Single-user by design                                                                    | ⚠️ Accounts on the Content server                       | ✅ Per-user permissions, OAuth/OIDC                                    | ✅ OIDC/SSO, granular permissions                   | ✅ OIDC or built-in logins, roles                     | ✅ Per-library access, age and label restrictions       |
| **Automatic metadata**                | ✅ File, Google Books, OpenLibrary, Goodreads; disagreements go to a review queue           | ✅ Fetches from the internet                            | ✅ On ingest                                                           | ✅ 14 providers                                     | ⚠️ Automatic downloads are a Kavita+ feature          | ❔ Metadata editing is documented; sources not verified |
| **Reads books in-app**                | ✅ EPUB, MOBI, AZW3, PDF (reflowed on demand)                                               | ✅ Desktop viewer; browser reader on the Content server | ✅ In the browser                                                      | ✅ EPUB, KEPUB, MOBI, AZW3, PDF, comics, audiobooks | ✅ EPUB, PDF and comics readers                       | ✅ Web reader                                           |
| **Annotations and highlights**        | ❌                                                                                          | ✅                                                      | ❔                                                                     | ✅ Synced across Kobo, KOReader and web             | ✅ EPUB highlights and notes                          | ❔                                                      |
| **Comics and manga**                  | ❌                                                                                          | ⚠️ Handles comic formats                                | ❔ Ingests 27+ formats; comics not verified                            | ✅ CBZ/CBR                                          | ✅ A primary use                                      | ✅ A primary use                                        |
| **Audiobooks**                        | ❌                                                                                          | ❔                                                      | ❔                                                                     | ✅                                                  | ❌ Not among its listed formats                       | ❌ Not among its listed formats                         |
| **Kindle**                            | ✅ USB, with on-demand AZW3 conversion; presence judged by each file's own title and author | ✅ Device transfer and conversion                       | ✅ Auto-send to e-readers; EPUB fixing for Kindle                      | ❔                                                  | ❔                                                    | ❔                                                      |
| **Kobo / KOReader / OPDS**            | ❌ None; the REST API serves only the Musaeum iOS app                                       | ❔ OPDS not confirmed in the manual                     | ✅ OPDS, Kobo sync, KOReader sync                                      | ✅ Kobo and KOReader sync                           | ✅ OPDS and KOReader progress sync                    | ✅ OPDS v1 and v2, Kobo sync, KOReader sync             |
| **Native iPhone app**                 | ⚠️ Yes, but build-from-source on your own device; no TestFlight or App Store                | ❔ None listed                                          | ❔ None listed                                                         | ✅ On the App Store                                 | ❔ None listed on its site; OPDS and third-party apps | ❔ None listed on its site; OPDS, Mihon extension       |
| **Convert between formats**           | ⚠️ AZW3 on send, via Calibre's `ebook-convert`                                              | ✅ Converts between formats                             | ✅ EPUB, MOBI, AZW3, KEPUB, PDF                                        | ❔                                                  | ❔                                                    | ❔                                                      |
| **Install friction**                  | ⚠️ Build from source; unsigned DMG; needs Python 3.11+                                      | ✅ Installers for macOS, Windows, Linux                 | ⚠️ Docker, three volume binds, a Calibre library                       | ⚠️ Docker, PostgreSQL                               | ✅ Docker or a binary                                 | ✅ Docker or standalone                                 |

A few footnotes the chart can't carry:

- **Calibre-Web (original)** has the same Calibre-database requirement as CWA, plus OPDS, Kobo sync, send-to-Kindle and in-browser reading, and it is actively maintained. CWA is a fork that adds the automation; it is shown in its place.
- **"❔" is not "no."** It marks a cell nobody checked in this pass. A reader who knows the answer is welcome to fix it.
- **Musaeum's REST API is a feature of its iOS app, not an open integration.** It is documented in [`rest-api.md`](rest-api.md), but it isn't OPDS and Kobo and KOReader don't speak it.

## Where Musaeum differs

1. **The library is a directory of files, not a database with a window around it.** Calibre's manual says [not to keep a library on a networked drive](https://manual.calibre-ebook.com/faq.html), because the library is one SQLite file. BookOrbit and BookLore say the same about their own storage. Musaeum keeps the canonical record in per-book folders and treats the database as a disposable local cache, which is why one root works on a share, a drive or a plain folder. CWA is the one server that now supports a share, by turning off SQLite WAL and polling instead of watching the filesystem.
2. **No server, no Docker, no account.** Everything above except Calibre needs a running server. Musaeum is a desktop app; the one listening socket is the phone's, off by default and bound to the tailnet address only.
3. **Device presence is judged by content.** Measured on a real Kindle, filename matching recognized 86 of 1,555 files and the file's own embedded title and author recognized 1,343. Most tools that read someone else's device do the filename version.
4. **A re-fetch says what it did**, a field you edit stays yours, and a disagreement between sources goes to a review queue instead of being silently overwritten.
5. **A theme engine** that derives its tokens from a palette you already own (base16, iTerm2 or Obsidian), with contrast floors enforced. No other tool here was checked for this, so it is a claim about Musaeum and not a comparison.

## Where the others win

- **Reach.** Every server here gives you multiple users, remote access from a browser, and OPDS for third-party reading apps. Musaeum is one person, one Mac, and one phone app.
- **Device ecosystems.** CWA, BookOrbit and Komga sync with Kobo and KOReader. Musaeum can't.
- **Format breadth.** Comics and manga are a primary use for Kavita and Komga; BookOrbit adds audiobooks. Musaeum has neither.
- **Annotations.** Calibre, BookOrbit and Kavita have them. Musaeum's reader deliberately doesn't yet, because highlights are what would make a book's record grow without bound, and they need a storage decision before a UI.
- **Calibre's depth.** Conversion across many formats, a full EPUB editor, custom columns, plugins, virtual libraries, and a library-wide index of book contents. If you are doing metadata surgery at scale, Calibre is the stronger tool.
- **Distribution.** BookOrbit's iOS app is on the App Store. Musaeum's is built from source onto your own device with a free personal team, and its profile expires every 7 days. The Mac app is unsigned and there is no published release.
- **Maturity and community.** Calibre has decades behind it and 26.1k GitHub stars, Calibre-Web has 18.3k, and BookOrbit lists 5.2k. Musaeum is a personal project with no support desk.

## Choosing, briefly

| If your situation is…                                                                                | Start with…               |
| ---------------------------------------------------------------------------------------------------- | ------------------------- |
| A large library on a NAS or drive, one or two Macs, a Kindle on USB, an iPhone, and no server        | **Musaeum**               |
| Deep metadata work, exotic conversions, plugins, or a library-wide full-text index                   | **Calibre**               |
| An existing Calibre library you want on the web, with Kobo and KOReader sync and automatic ingest    | **Calibre-Web-Automated** |
| A family or several users, ebooks plus audiobooks and comics, a native iPhone app from the App Store | **BookOrbit**             |
| Comics and manga at the centre, with ebooks alongside                                                | **Kavita** or **Komga**   |

## BookLore and Grimmory

[BookLore](https://github.com/booklore-app/booklore) has no column of its own because it is winding down. Its README says **BookOrbit is its official successor and the home of active development**, and that BookLore is _entering maintenance mode_ and will get occasional maintenance, bug fixes and security updates. BookOrbit offers a guided migration from it.

[Grimmory](https://github.com/grimmory-tools/grimmory) is a community-maintained fork of BookLore that continues the BookLore experience. It runs as a Java application server backed by MariaDB, like BookLore itself, is AGPL-3.0, and is a supported migration source in BookOrbit. BookLore's own documentation says its file operations are built for local filesystems only and that network storage is "unsupported and untested", so the NAS row above applies to the whole family.

## Sources

Checked 2026-10-06.

- Calibre: [repository and licence](https://github.com/kovidgoyal/calibre) · [FAQ, "Do not put your calibre library on a networked drive"](https://manual.calibre-ebook.com/faq.html) · [Content server, user accounts](https://manual.calibre-ebook.com/server.html) · [9.10 release notes, via a news report](https://webiano.digital/calibre-9-10-gives-its-self-hosted-library-a-modern-front-door/)
- Calibre-Web-Automated: [README](https://github.com/crocodilestick/Calibre-Web-Automated), covering the licence, ingest, conversion, sync and `NETWORK_SHARE_MODE`
- Calibre-Web: [README](https://github.com/janeczku/calibre-web), covering the Calibre-database requirement and its feature list
- BookLore: [README](https://github.com/booklore-app/booklore), covering the maintenance-mode notice, the licence, MariaDB, and the network-storage statement
- BookOrbit: [README](https://github.com/bookorbit/bookorbit), covering features, PostgreSQL, the local-storage-only statement, the App Store app, and AGPL-3.0 · [migration page](https://bookorbit.app/migration/)
- Grimmory: [repository](https://github.com/grimmory-tools/grimmory) and [community description](https://forum.cloudron.io/topic/15497/grimmory-self-hosted-digital-library-for-ebooks-comics-audiobooks-community-fork-of-booklore)
- Kavita: [site](https://www.kavitareader.com/), covering formats, Kavita+ and its price · [repository](https://github.com/Kareadita/Kavita), covering the licence, deployment and features · [KOReader sync guide](https://wiki.kavitareader.com/guides/3rdparty/koreader/)
- Komga: [site](https://komga.org/) · [repository](https://github.com/gotson/komga), covering the licence, Kobo and KOReader sync, OPDS v1/v2 and per-library access control

Musaeum's own cells are measured from this repository: [`project-overview.md`](project-overview.md), [`rest-api.md`](rest-api.md), [`invariants/`](invariants/) and `CHANGELOG.md`.
