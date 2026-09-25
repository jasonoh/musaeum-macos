---
name: verify
description: Launch an isolated Musaeum instance and drive it end-to-end (import watcher, IPC surface via CDP) without touching the real profile or NAS library
---

# Verifying Musaeum changes against a live, isolated app

## Launch recipe (all three matter)

```bash
SCRATCH=$(mktemp -d)/verify   # scratch profile + scratch library
mkdir -p "$SCRATCH/profile" "$SCRATCH/library/imports"
# seed the profile DB: apply electron/main/schema/migrations/001_initial.sql
# via sqlite3, set PRAGMA user_version=<latest>, INSERT OR REPLACE
# app_config library_root -> $SCRATCH/library (001 already inserts rest_api_enabled)

env -u ELECTRON_RUN_AS_NODE \
  MUSAEUM_USER_DATA="$SCRATCH/profile" \
  npm run dev -- -- --remote-debugging-port=9222 > "$SCRATCH/app.log" 2>&1 &
```

Gotchas learned the hard way:
- **`ELECTRON_RUN_AS_NODE=1` is inherited from the VS Code extension host** — without `env -u` the app runs as plain node and dies on `protocol.registerSchemesAsPrivileged`.
- **`HOME=` overrides do NOT isolate the profile on macOS** — Electron resolves userData via the account home (getpwuid), so the app silently opens the REAL `~/Library/Application Support/Musaeum`. Use the `MUSAEUM_USER_DATA` env hook (electron/main/index.ts) instead, and verify isolation by checking a `-wal` file appears in the scratch profile.
- The double `--` in `npm run dev -- -- --flag` is required: one for npm, one for electron-vite's passthrough to Electron.

## Driving the app

- **Import pipeline:** copy a book file into `$SCRATCH/library/imports/` — chokidar picks it up in ~2-5s; poll the scratch DB (`sqlite3 "file:$PROFILE/musaeum.db?mode=ro" 'SELECT ... FROM books'`).
- **IPC surface (what UI buttons call):** CDP on port 9222. `curl http://127.0.0.1:9222/json` → page target ws URL; connect with python `websocket-client` using **`suppress_origin=True`** (Chromium 403s the default Origin header), then `Runtime.evaluate` with `awaitPromise: true` on `window.Musaeum.<domain>.<method>(...)`. `Page.captureScreenshot` gives evidence PNGs of the live window.
- Fixture PDFs/Calibre libraries: build with the sidecar venv's `pypdf` (PdfWriter + add_metadata) and a hand-built `metadata.db` (schema slice in sidecar/tests/ or git history of the verify session).
- Kill with `pkill -f "electron-vite dev"; pkill -f "node_modules/electron/dist/"`, then confirm with `lsof -nP -iTCP:9222 -sTCP:LISTEN` and `kill -9` whatever still holds the port. The pattern must not name the bundle: `scripts/dev-app-branding.mjs` renames `dist/Electron.app` to `dist/Musaeum.app`, so an `Electron.app` pattern matches nothing and leaves the app running — the stale-instance trap below. A dev instance has also been seen to ignore SIGTERM (2026-09-24), hence the port check. A SIGTERM'd instance leaves the profile DB's WAL needing recovery — a read-only open then fails; a normal `sqlite3` open recovers it.

## The stale-instance trap (fired twice, on two different sessions)

**An Electron that survived `pkill` keeps port 9222, and CDP answers from it happily while running the OLD bundle** — so you verify a build you are not testing, and the page reports the change you just made as absent. The second occurrence showed the other face of it: the fresh `npm run dev` logged a `bind() failed` for 9222 and carried on without a debugger, so nothing in the app's own output said which instance CDP was talking to.

Before trusting anything the page reports, confirm the pid listening on 9222 is your own run — `lsof -nP -iTCP:9222 -sTCP:LISTEN`, then compare its start time (`ps -o lstart= -p <pid>`) against your launch. A screenshot from the wrong instance is indistinguishable from a change that didn't work.
