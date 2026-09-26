# Application menu, app name & icon

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching the native menu, the app name, or the dock icon.

---

## Application menu

`services/menu.ts`, installed on `whenReady`. It replaces Electron's default menu, which is why the Edit submenu is spelled out — every ⌘C/⌘V/⌘Z the metadata editor needs comes from there, not for free.

Items never act; they `broadcast('menuCommand', …)` and the renderer (`hooks/useMenuCommands.ts`) maps each to the same store action the on-screen control uses, so a menu item and its button can't drift apart. Commands today: Settings (**⌘,**, the shortcut macOS users expect and the only reason the menu is load-bearing rather than cosmetic), grid (⌘1), list (⌘2), Reload Library (**⌘R** — re-reads the shared catalog, the same job as Settings' Reload and the sidebar's icon on the Library row; added 2026-09-26 for a secondary machine that needs to pick up books added elsewhere without a restart). Because the menu reflects no renderer state, Reload Library is never greyed out: pressed mid-job or with the library unreachable, the handler checks `canStartCatalogSync` (`src/lib/catalog-sync.ts`) and does nothing. **⌘R belongs to Reload Library, not the window:** the dev-only renderer reload moved to ⌥⌘R, and the packaged build has no window reload at all.

The menu is built once and never rebuilt — nothing in it reflects renderer state (no checkmarks on the view items), because keeping checked state in sync would mean touching the native menu on every view switch.

**The app name in the menu bar comes from the running bundle's `CFBundleName`**, not `app.name` — so in development it reads "Electron" no matter what the app calls itself. `scripts/dev-app-branding.mjs` (postinstall) renames the dev Electron bundle to `productName`; `npm install` restores the stock plist, which is why it runs there. Packaged builds get the name from `package.json`. `app.setAboutPanelOptions` covers the About panel's *name*.

---

## App icon

`build/icon.png` (1024², committed) is the master; `npm run icons` (`scripts/make-icons.mjs`) renders the 10 iconset sizes with `sips` and packs them with `iconutil` into **`build/icon.icns`** — electron-builder's default lookup path, so packaging will pick it up with no config once it exists.

In development the icon has the same problem as the name above: macOS reads it from the running bundle (the one in `node_modules/electron/dist/`), so each surface needs covering separately — and no two are quite the same fix.

- **About panel** — draws `NSApp.applicationIconImage`, which comes from the bundle's `CFBundleIconFile`. `setAboutPanelOptions` cannot touch it (its `iconPath` is Linux/Windows only), so `dev-app-branding.mjs` overwrites `Contents/Resources/electron.icns` in place and touches the `.app` to invalidate macOS's mtime-keyed icon cache. It overwrites rather than repointing the plist key so a stock `npm install` cleanly undoes it. This is why `npm run icons` also re-runs the branding script.
- **Dock** — covered by the bundle patch, but `setDevDockIcon` in `electron/main/index.ts` also sets it at runtime (dev-only, `app.isPackaged` guard). Deliberate redundancy: the runtime call bypasses the icon cache entirely and needs no reinstall, so editing `icon.png` shows up on the next `npm run dev` even if the postinstall hook never ran.
- **Dock tile label** (the tooltip, and the name in the ⌘-Tab switcher) — comes from the **bundle directory's filename**, minus `.app`, and nothing else, so `dev-app-branding.mjs` renames `dist/Electron.app` to `dist/Musaeum.app` and points the `electron` package's `path.txt` at the new location.
- **Packaged builds** need none of this — the bundle is ours.

That last one cost several failed attempts, so the measurement is worth keeping. It is **not** CFBundleName, CFBundleDisplayName, CFBundleExecutable, the bundle identifier, or LaunchServices: with all five patched to "Musaeum" — `lsappinfo info -only name` and `NSRunningApplication.localizedName` both answering "Musaeum" — the tile still read "Electron". Copying the byte-identical bundle to a path macOS had never seen isolated it: named `Musaeum.app` the label was "Musaeum", named `Electron.app` it was "Electron". (To measure it yourself, ask the Dock what it renders rather than trusting the plist: `osascript -e 'tell application "System Events" to tell process "Dock" to get name of every UI element of list 1'`.)

An earlier attempt renamed **`Contents/MacOS/Electron`** instead. That does nothing for the Dock and **flips `app.isPackaged` to `true` in development** — Electron derives the flag from `basename(process.execPath) !== 'electron'` and nothing else. Three features read that flag and all three broke:

- `sidecarDir()` took the packaged branch (`process.resourcesPath/sidecar`), missed the venv, fell through to a bare `python3.12`, and crashed the app on startup with `spawn python3.12 ENOENT` — which is Node's message for a **cwd** that doesn't exist, not a missing interpreter
- `setDevDockIcon()` early-returned, undoing the Dock icon
- the View menu lost Reload/DevTools

The branding script now restores the stock executable name if it finds a renamed one, so `app.isPackaged` is honest again in dev. Don't rename the executable to chase a label — rename the directory. Main-process code should still read `isPackaged` from `services/runtime.ts` (keyed off `process.defaultApp`), which is immune to the executable's name either way.

Two traps when testing any of this from a shell: `npm test` sets `ELECTRON_RUN_AS_NODE=1`, and if it leaks into a later `npm run dev` the app starts in Node mode and dies on `app.setPath` with `app` undefined (that is the leaked variable, not a broken bundle — `env -u ELECTRON_RUN_AS_NODE` confirms). And `npx asar extract-file … /dev/stdout` ignores the destination and writes the extracted file into the cwd, which is how a stray `main.js` can land in the project root and fail lint.

---
