/**
 * Whether this is a packaged build.
 *
 * **Not `app.isPackaged`.** Electron derives that flag from
 * `basename(process.execPath) !== 'electron'` and nothing else, so anything
 * that renames the dev binary silently makes it report `true` in development.
 * That happened once — an attempt to relabel the Dock tile renamed
 * `Contents/MacOS/Electron`, which sent `sidecarDir()` down the packaged
 * branch, lost the venv, and crashed startup with `spawn python3.12 ENOENT`.
 * The Dock tile is labelled from the bundle *directory's* name instead (see
 * `scripts/dev-app-branding.mjs`), so the executable keeps its stock name and
 * `app.isPackaged` is honest again — but this module stays as the one answer
 * to the question, so a future rename can't reintroduce that failure.
 *
 * `process.defaultApp` is set by Electron whenever the app path is passed as
 * an argument — `electron .`, which is how both `npm run dev` and
 * `npm run preview` launch — and is undefined in a packaged app. It is
 * unaffected by the executable's name.
 *
 * The `ELECTRON_RUN_AS_NODE` half covers the vitest suite, which runs
 * Electron-as-Node (so `defaultApp` is unset) against the real `sidecar/`
 * directory. A genuine packaged launch can never set it — with that variable
 * present Electron runs plain Node and never boots the app at all — so it
 * cannot mask a real packaged build.
 *
 * Anything in the main process that needs to know dev-vs-packaged must import
 * this rather than reaching for `app.isPackaged`.
 */
export const isPackaged = !process.defaultApp && !process.env.ELECTRON_RUN_AS_NODE
