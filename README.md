# Musaeum

Personal ebook library management for macOS — replaces Calibre for a 7000+ book
NAS-hosted library. Electron + React + TypeScript, with a Python sidecar for
metadata hydration and format conversion.

- [CLAUDE.md](CLAUDE.md) — architecture, data contracts, conventions
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
npm run build      # production bundles into out/
```

First launch shows a banner to choose the library folder — point it at the
mounted NAS share (or any local folder). Books dropped onto the window, or
into `{library_root}/imports/`, are imported and hydrated automatically.

## Layout

- `electron/main/` — main process: IPC handlers (`ipc/`), business logic
  (`services/`), SQLite schema (`schema/migrations/`)
- `electron/preload/` — the `window.Musaeum` contextBridge API
- `src/` — React renderer (components, Zustand stores, hooks)
- `src/types/` — shared TypeScript contracts used by all three layers
- `sidecar/` — Python JSON-RPC sidecar (extraction, fetchers, hydration
  pipeline, conversion, Calibre migration)
