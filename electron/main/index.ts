import { app, BrowserWindow, nativeTheme, net, protocol, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { ThemeView } from '@shared/theme.types'
import { TRAFFIC_LIGHT_POSITION } from '@shared/window-chrome'
import { startRestApiIfEnabled } from './api/rest'
import { registerAiHandlers } from './ipc/ai'
import { registerDeviceHandlers } from './ipc/device'
import { registerFileHandlers } from './ipc/files'
import { registerLibraryHandlers } from './ipc/library'
import { registerMetadataHandlers } from './ipc/metadata'
import { registerMigrationHandlers } from './ipc/migration'
import { registerNASHandlers } from './ipc/nas'
import { registerReaderHandlers } from './ipc/reader'
import { registerSettingsHandlers } from './ipc/settings'
import { registerThemeHandlers } from './ipc/theme'
import { resolveBookFile, resolveCoverFile } from './services/book-bytes'
import { closeDb } from './services/db'
import { startDeviceDetection, stopDeviceDetection } from './services/device-manager'
import { broadcast, setMainWindow, subscribe } from './services/events'
import { bindToNAS, startWatcher, stopWatcher } from './services/file-watcher'
import { installApplicationMenu } from './services/menu'
import * as importer from './services/importer'
import * as librarySync from './services/library-sync'
import * as nas from './services/nas-manager'
import { ensurePythonEnv } from './services/python-env'
import { createBeforeQuitHandler } from './services/quit'
import * as readingState from './services/reading-state'
import { isPackaged } from './services/runtime'
import * as sidecar from './services/sidecar'
import { isResolverWindow } from './services/theme/resolve-css'
import { activeTheme, nativeScheme, windowBackgroundColor } from './services/theme/store'

// Isolated profile for verification/e2e runs — macOS Electron resolves the
// default userData via the account's home, so a $HOME override is ignored
if (process.env.MUSAEUM_USER_DATA) {
  app.setPath('userData', process.env.MUSAEUM_USER_DATA)
}

// musaeum://cover/{bookId}/{thumb|full} — serves cover images from the
// library without exposing arbitrary file:// access to the renderer
protocol.registerSchemesAsPrivileged([
  { scheme: 'musaeum', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

/**
 * musaeum:// — the renderer's only path to library files. Two hosts:
 *   cover/{bookId}/{thumb|full}   cover images
 *   book/{bookId}/{format}        book bytes for the reader
 * CSP forbids file://, so everything the renderer displays comes through here.
 */
function registerMusaeumProtocol(): void {
  protocol.handle('musaeum', async (request) => {
    const url = new URL(request.url)
    const [bookId, rest] = url.pathname.replace(/^\//, '').split('/')
    if (!bookId || !rest) return new Response(null, { status: 400 })

    if (url.host === 'book') {
      const file = await resolveBookFile(bookId, rest)
      return file ? net.fetch(pathToFileURL(file).toString()) : new Response(null, { status: 404 })
    }

    if (url.host !== 'cover') return new Response(null, { status: 400 })

    // The cover rules live in the service — traversal, containment under the
    // library root, 404-on-missing — so this handler and `GET /api/books/{id}/cover`
    // cannot disagree about the security boundary, and so the boundary is
    // decidable without a running Electron app (D8). The refusal carries its own
    // status because the split *is* the behaviour being preserved: 400 for a row
    // that escapes the library root, 404 for a missing root, book or cover.
    const cover = await resolveCoverFile(bookId, rest)
    if (!cover.ok) return new Response(null, { status: cover.status })

    try {
      return await net.fetch(pathToFileURL(cover.path).toString())
    } catch {
      // A cover whose file is gone *between* the resolver's realpath and this
      // read — a folder deleted outside the app, or half of a failed delete —
      // answers 404 rather than throwing out of the handler. The row keeps fixed
      // cover names, so such a book still asks; the renderer's placeholder needs
      // a *response* it can fail on, and a thrown handler says the same thing
      // noisily.
      return new Response(null, { status: 404 })
    }
  })
}

/**
 * The Dock icon comes from the *running bundle's* icon file, so in development
 * — which runs node_modules/electron/dist/Electron.app — it is Electron's own,
 * the same class of problem `scripts/dev-app-name.mjs` fixes for the menu bar
 * title. Packaged builds get the icon from build/icon.icns and need no help,
 * hence dev-only: setting it there too would just re-set what's already right.
 */
function setDevDockIcon(): void {
  if (isPackaged || process.platform !== 'darwin') return
  const icon = join(app.getAppPath(), 'build/icon.png')
  if (existsSync(icon)) app.dock?.setIcon(icon)
}

/**
 * The current main window, kept in step with `services/events.ts`'s own
 * reference. The `themeChanged` listener below needs it for
 * `setBackgroundColor` — and it has to be a *reference* rather than a captured
 * `win`, because `activate` builds a second window once the first is closed, and
 * a listener closing over the old one would repaint a destroyed window (or,
 * guarded, nothing at all). `adoptWindow` is the one place both references move,
 * so the two can't be updated out of step.
 */
let mainWindow: BrowserWindow | null = null

function adoptWindow(win: BrowserWindow): void {
  mainWindow = win
  setMainWindow(win)
}

function createWindow(): BrowserWindow {
  // The platform's own chrome — scrollbars, traffic lights, the menu bar, the
  // caret, `<select>` popups — is not ours to colour; it follows
  // `nativeTheme.themeSource` and nothing else. Set here from the same stored
  // theme the window's background comes from, so the two cannot disagree at
  // boot. The *decision* is `nativeScheme`, in the theme service, where it has a
  // harness (`index.ts` has none — A25).
  nativeTheme.themeSource = nativeScheme(activeTheme().tokens)

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    // The stored theme's canvas, from the theme service — a function of the
    // tokens and nothing else, so "it is still hardcoded" is visible to a test.
    // This is what covers the frame before any JS runs; the renderer's own
    // pre-paint apply (src/main.tsx) handles the body.
    backgroundColor: windowBackgroundColor(activeTheme().tokens),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  registerMusaeumProtocol()
  setDevDockIcon()
  installApplicationMenu()

  registerLibraryHandlers()
  registerMetadataHandlers()
  registerDeviceHandlers()
  registerNASHandlers()
  registerMigrationHandlers()
  registerFileHandlers()
  registerSettingsHandlers()
  registerReaderHandlers()
  registerThemeHandlers()
  registerAiHandlers()

  const win = createWindow()
  adoptWindow(win)

  // One subscription, for the process (D6). The window's background and the
  // platform's scheme follow the theme through the *same* `themeChanged`
  // broadcast the renderer listens to, so "what is active" has one path and the
  // native chrome cannot drift from the body it frames. `theme.set` broadcasts
  // the whole view (the payload is the `ThemeView` the renderer is handed), so
  // the tokens repainted from here are the ones that were just written.
  //
  // `themeSource` is set unconditionally — it is process-wide and needs no
  // window — while the window's own colour is guarded exactly as `broadcast`
  // guards its send: a theme change after the window is gone (`window-all-closed`
  // on a non-macOS quit, or a rejection between `close` and `activate`) logs
  // nothing and throws nothing (`CLAUDE.md` #12).
  subscribe((event, payload) => {
    if (event !== 'themeChanged') return
    // The registry types the payload `unknown`, so it is cast once and then
    // *checked* — not asserted and trusted. A future broadcast of this channel
    // from anywhere else must not be able to take the main process down from a
    // listener, and it must not be able to set the window's colour from a record
    // that is not a theme: the check is on the two fields this handler reads, so a
    // tokens object missing `dark` (nativeScheme would answer `'light'`) or a
    // canvas is reported rather than applied in silence (`CLAUDE.md` #12).
    const tokens = (payload as ThemeView | undefined)?.active?.tokens
    if (!tokens || typeof tokens.dark !== 'boolean' || typeof tokens.ink?.['950'] !== 'string') {
      console.warn(
        '[theme] themeChanged carried no usable tokens; native chrome unchanged',
        payload
      )
      return
    }
    nativeTheme.themeSource = nativeScheme(tokens)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(windowBackgroundColor(tokens))
    }
  })

  // A packaged build has no venv until it makes one, so the sidecar starts
  // only once an interpreter with its dependencies exists — starting first
  // would fall through to a bare system python and crash-loop on the import
  // of Pillow. Resolves in a microtask on every launch but the first, and a
  // failure still starts the sidecar: dependencies installed globally are a
  // setup python-env can't detect but the sidecar can still use.
  void ensurePythonEnv((progress) => broadcast('pythonEnvProgress', progress)).finally(() => {
    sidecar.start()
  })

  nas.onStatusChange((status) => {
    if (status.state === 'connected') void librarySync.syncOnConnect()
  })
  nas.startHealthChecks()
  bindToNAS()
  if (nas.isOnline()) startWatcher()
  startDeviceDetection()
  // The JSON API's socket (slice 1a of the iOS companion). Non-fatal by
  // construction: a taken port, an address that may not be bound or a missing
  // token is recorded on `getRestApiStatus()` and logged, never thrown, so a
  // failure here can never keep the window from opening (invariant 12).
  void startRestApiIfEnabled()

  app.on('activate', () => {
    // **The count is not the question.** A resolver window is created lazily on
    // the first `.css` import and then lives until the app quits, because
    // destroying it and building another is the shape that dies with `SIGTRAP`
    // in Electron 37.10.3 (D1). So `BrowserWindow.getAllWindows().length` is
    // never 0 again after one import, and the dock icon would silently stop
    // reopening the app. What the dock click is asking is "is there no window the
    // user can see" — so every window counts except the resolver's, which is
    // always hidden and never theirs.
    const userWindows = BrowserWindow.getAllWindows().filter((win) => !isResolverWindow(win))
    if (userWindows.length === 0) {
      adoptWindow(createWindow())
    }
  })
})

app.on('window-all-closed', () => {
  // Standard macOS behavior: stay alive until explicit quit
  if (process.platform !== 'darwin') app.quit()
})

// Async-shutdown handshake (see services/quit.ts): the first before-quit
// flushes reading position to the NAS — bounded by its own timeout, so a
// dead share can never wedge quit — and only the second pass (after that
// settles) stops watchers/timers and closes the database. Ordering matters:
// flushPendingBeforeQuit must run and settle before closeDb, or the flush's
// writes reopen a "closed" database (getDb() silently re-migrates) that is
// about to vanish anyway.
app.on(
  'before-quit',
  createBeforeQuitHandler({
    flush: () => readingState.flushPendingBeforeQuit(),
    teardown: () => {
      stopWatcher()
      stopDeviceDetection()
      nas.stopHealthChecks()
      sidecar.stop()
      closeDb()
    },
    quit: () => app.quit()
  })
)

app.on('will-quit', () => {
  // Synchronous — safe to leave in will-quit rather than the handshake above.
  importer.abortPendingDecisions()
})
