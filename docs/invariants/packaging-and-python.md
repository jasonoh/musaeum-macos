# Packaging & the managed Python runtime

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching `electron-builder.yml`, the Python bootstrap, or anything that ships in the bundle.

---

## Packaging

`electron-builder.yml` → `npm run pack` (DMG) / `npm run pack:dir` (unpacked `.app`). **Needs Node 22.12+** since the Electron 44 upgrade (2026-09-25): `@electron/rebuild` 4 requires it, and it runs in `postinstall`. The older floor, 20.19, came from electron-builder 26 `require()`ing an ESM-only dependency — on Node 18 the pack step dies with `ERR_REQUIRE_ESM` *after* electron-vite has already built, which reads as a build failure but isn't.

Three things in that config are load-bearing:

- **`files` is an allowlist** (`out/**`, `package.json`). Production `dependencies` are collected by electron-builder's own node_modules pass, not by this glob, so better-sqlite3 still ships; devDependencies never do.
- **`asarUnpack: '**/*.node'`** — a `.node` binary can't be loaded from inside an asar. smartUnpack already detects this; it's spelled out because the failure (packaged app dies opening the DB, dev is fine) is expensive to find.
- **`mac.identity: null`** — without it electron-builder signs with whatever Developer ID is in the keychain, making the build machine-dependent. Removing this line is step one of enabling signing.

`build/` is the default `buildResources` dir, which is both why `icon.icns` is picked up with no `mac.icon` entry and why `build/` isn't copied into the app.

**Python in a packaged build** (`services/python-env.ts`). The bundle ships `sidecar/` as source but never `sidecar/.venv` — it's built against one machine's interpreter with absolute paths baked in, and nothing may write inside a signed bundle. So on first launch the app builds its own venv in `userData/sidecar-venv` from the bundled `requirements.txt` (~20s, needs network), then skips it forever after.

- **The marker is the whole re-run policy.** `sidecar-venv/.musaeum-requirements` holds a sha256 of `requirements.txt`, written *after* a successful install — so an interrupted install retries, and editing requirements re-installs, without ever asking pip to resolve the world on a normal launch.
- **Requirements are pinned exactly** (`==`, top-level packages only; since 2026-09-24). With `>=` pins a first launch months after a release resolved whatever was newest that day — versions no pytest run had seen. Bump a pin deliberately, re-run pytest, and expect the marker hash to change: every packaged install re-runs pip once on its next launch.
- **`resolvePython()` order is a contract**: configured → bundled runtime → dev venv → managed venv → bare system python. The bundled-runtime slot (`Resources/python/bin/python3`) is empty today and exists so shipping a standalone CPython later is one `extraResources` entry, not a refactor.
- **The reflow's Swift helper is in no bundle today** (2026-10-08): `helpers/bin/musaeum-layout` is built by `scripts/build-layout-helper.sh` and gitignored, and slice 3 adds its `extraResources` entry. The entry's `to:` has to be `helpers/bin`, because `vision.find_helper()` resolves `parents[2]/helpers/bin/musaeum-layout` from `sidecar/reflow/vision.py` — which in a packaged app is `Contents/Resources/helpers/bin/musaeum-layout`. A wrong `to:` leaves the helper unfound and every book answered `no_layout`, with no code defect to find; `MUSAEUM_LAYOUT_HELPER` overrides the path for a dev or an experiment. 149 KB against AC9's ≤1 MB.
- **Interpreters are searched by absolute path as well as by name.** launchd hands a double-clicked `.app` a minimal `PATH` (`/usr/bin:/bin:…`), so a Homebrew python that resolves fine from a terminal is invisible from Finder. Test packaged launches with `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`.
- **The sidecar starts only after the bootstrap settles** (`index.ts`). Starting first fell through to a bare `python3` and crash-looped on `import PIL` three times before giving up — which is what a packaged build did before this existed. A *failed* bootstrap still starts the sidecar: globally installed dependencies are a setup this can't detect but the sidecar can still use.
- Version rules (`MIN_PYTHON`, `parseVersion`, `meetsMinimum`) live here and are imported by `settings.ts`, so validating a hand-picked interpreter and auto-choosing one can't disagree. `sidecar.ts` re-exports `resolvePython` so Settings still asks it, per the rule in `docs/invariants/settings-and-editing.md`.

---
