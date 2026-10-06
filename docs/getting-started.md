# Getting it running

> Moved verbatim from `README.md` when the README was cut down to a front page; headings were promoted one level and nothing else changed. The README keeps the short version.

Requirements:

| Requirement                           | Why                                                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A place to keep the library**       | A mounted SMB share, an external drive, or any folder on this Mac — the app records which one it is when you choose it, and only a share ever gets a mount attempt               |
| **macOS** (arm64 build today)         | The app is an Electron macOS app; the packaged DMG is arm64                                                                                                                      |
| **Node 22.12+**                       | `npm install` needs it — `@electron/rebuild` 4 (the `postinstall` native rebuild) requires it; it also covers electron-builder 26's ESM-through-`require` load in `npm run pack` |
| **Python 3.11+**                      | The metadata/conversion sidecar. A packaged build finds it and builds its own venv on first launch                                                                               |
| **Calibre** (optional)                | Only for `ebook-convert`, i.e. format conversion on send. Detected at `/Applications/calibre.app/Contents/MacOS/ebook-convert`, overridable in Settings                          |
| **A Google Books API key** (optional) | Hydration runs keyless, but the free tier is rate-limited well below what a bulk migration needs                                                                                 |

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

## The Google Books key

Hydration picks the key up from either **Settings → Google Books** or the `GOOGLE_BOOKS_API_KEY` environment variable; Settings wins, so a double-clicked `.app` needs no terminal and no wrapper. Leave it blank to stay on the keyless tier. A bulk Calibre migration is the case that needs it — hydrating 7,000 books at the free tier's rate limit is a 90-minute job on top of the copy.

The maintainer's own setup injects it for dev runs with `infisical run -- npm run dev`, which sets the variable only for the wrapped process; a bare `npm run dev` still works, just on the keyless tier.

## Packaging

```bash
npm run pack       # build + electron-builder → dist/Musaeum-<version>-arm64.dmg
npm run pack:dir   # unpacked dist/mac-arm64/Musaeum.app, for fast iteration
```

The build is currently **unsigned** (`mac.identity: null`), so macOS needs a right-click → Open the first time. Signing and notarization are tracked in `tasks.md`.

The `.app` ships the sidecar as source but not `sidecar/.venv` — that venv is built against one machine's interpreter, hard-codes absolute paths, and nothing may write inside a signed bundle anyway. On first launch the app resolves a system Python 3.11+, builds a venv in `~/Library/Application Support/Musaeum/sidecar-venv`, and installs `requirements.txt` into it (~20 s, once, with progress in the status bar), skipping later launches on a hash of the requirements. So a packaged Musaeum requires Python 3.11+ on the host.
