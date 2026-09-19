# Musaeum

Personal ebook library management for macOS — replaces Calibre for a 7000+ book
NAS-hosted library. Electron + React + TypeScript, with a Python sidecar for
metadata hydration and format conversion.

- [CLAUDE.md](CLAUDE.md) — project brief: invariants, conventions, where to look
- [docs/project-overview.md](docs/project-overview.md) — features, status, and how
  it compares to Calibre/Calibre-Web/Kavita and the rest
- [docs/](docs/) — architecture, data contracts, and per-subsystem invariants
- [tasks.md](tasks.md) — roadmap, known issues, backlog
- [CHANGELOG.md](CHANGELOG.md) — release history

## Setup

```bash
# Node dependencies (postinstall rebuilds better-sqlite3 for Electron)
npm install

# Python sidecar (3.11+)
python3.12 -m venv sidecar/.venv
sidecar/.venv/bin/pip install -r sidecar/requirements.txt
```

**Calibre** must be installed for format conversion (`ebook-convert` is
detected at `/Applications/calibre.app/Contents/MacOS/ebook-convert`; override
via the `ebook_convert_path` app config key).

### Secrets

`GOOGLE_BOOKS_API_KEY` reaches the Python sidecar
([`sidecar/fetchers/google_books.py`](sidecar/fetchers/google_books.py)) from
one of two places: the key set in **Settings**, or the environment. It is
optional for casual use but **required before the 7000-book migration** (the
free, keyless tier is rate-limited well below what a bulk run needs).

Settings wins over the environment, so a key entered there survives a
double-clicked `.app`; leave it blank to keep using the environment.

Secrets live in the Infisical project **`musaeum`**. Inject them by wrapping
the dev/build commands in `infisical run` rather than exporting keys by hand:

```bash
infisical run -- npm run dev      # sidecar inherits GOOGLE_BOOKS_API_KEY
infisical run -- npm run build
```

`infisical run` sets the variables only for the wrapped process, so a bare
`npm run dev` still works (online metadata just falls back to the keyless
tier). A packaged `.app` can't be launched through `infisical run` by a
double-click, which is what the Settings field is for — set the key once and
Infisical stops being a runtime dependency.

## Development

```bash
npm run dev        # launch the app with hot reload
npm run typecheck  # tsc across main + renderer
npm run lint       # eslint
npm test           # vitest main-process suite (Electron-as-Node)
npm run build      # production bundles into out/
```

First launch shows a banner to choose the library folder — point it at the
mounted NAS share (or any local folder). Books dropped onto the window, or
into `{library_root}/imports/`, are imported and hydrated automatically.

## Packaging

```bash
npm run pack       # build + electron-builder → dist/Musaeum-<version>-arm64.dmg
npm run pack:dir   # unpacked dist/mac-arm64/Musaeum.app, for fast iteration
```

**Packaging needs Node 20.19+** (electron-builder 26 loads an ESM-only
dependency through `require`, which older Node refuses). Node 18 runs
everything else in this repo fine but fails `npm run pack` with
`ERR_REQUIRE_ESM`.

The build is currently **unsigned** (`mac.identity: null` in
`electron-builder.yml`), so macOS needs a right-click → Open the first time.
Signing and notarization are tracked in [tasks.md](tasks.md).

### Python in a packaged build

The `.app` ships the sidecar as source but **not** `sidecar/.venv` — that venv
is built against one machine's interpreter and hard-codes absolute paths, and
nothing may write inside a signed bundle anyway. Instead, on first launch
[`services/python-env.ts`](electron/main/services/python-env.ts) finds a system
Python 3.11+, builds a venv in `~/Library/Application Support/Musaeum/
sidecar-venv`, and installs `requirements.txt` into it (~20s, needs network,
progress shown in the status bar). Later launches skip it; editing
`requirements.txt` re-runs it, keyed on a hash recorded in the venv.

So a packaged Musaeum requires **Python 3.11+ on the host**. Homebrew's
interpreter is found by absolute path as well as by name, because a
double-clicked app inherits launchd's minimal `PATH` and would not otherwise
see it.

## Layout

- `electron/main/` — main process: IPC handlers (`ipc/`), business logic
  (`services/`), SQLite schema (`schema/migrations/`)
- `electron/preload/` — the `window.Musaeum` contextBridge API
- `src/` — React renderer (components, Zustand stores, hooks)
- `src/types/` — shared TypeScript contracts used by all three layers
- `sidecar/` — Python JSON-RPC sidecar (extraction, fetchers, hydration
  pipeline, conversion, Calibre migration)
