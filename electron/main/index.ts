import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { TRAFFIC_LIGHT_POSITION } from '@shared/window-chrome'
import { startRestApiIfEnabled } from './api/rest'
import { registerDeviceHandlers } from './ipc/device'
import { registerFileHandlers } from './ipc/files'
import { registerLibraryHandlers } from './ipc/library'
import { registerMetadataHandlers } from './ipc/metadata'
import { registerMigrationHandlers } from './ipc/migration'
import { registerNASHandlers } from './ipc/nas'
import { registerReaderHandlers } from './ipc/reader'
import { registerSettingsHandlers } from './ipc/settings'
import { registerThemeHandlers } from './ipc/theme'
import { resolveBookFile } from './services/book-bytes'
import { closeDb, getBook } from './services/db'
import { startDeviceDetection, stopDeviceDetection } from './services/device-manager'
import { broadcast, setMainWindow } from './services/events'
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
import { activeTheme, windowBackgroundColor } from './services/theme/store'

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
      return file
        ? net.fetch(pathToFileURL(file).toString())
        : new Response(null, { status: 404 })
    }

    if (url.host !== 'cover') return new Response(null, { status: 400 })

    const root = nas.getLibraryRoot()
    const book = getBook(bookId)
    const file = rest === 'thumb' ? book?.coverThumbPath : book?.coverFullPath
    if (!root || !book?.nasPath || !file) return new Response(null, { status: 404 })

    // Cover paths are stored relative to the book dir; reject traversal
    if (file.includes('..') || file.includes('/')) return new Response(null, { status: 400 })
    return net.fetch(pathToFileURL(join(root, book.nasPath, file)).toString())
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

function createWindow(): BrowserWindow {
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

  const win = createWindow()
  setMainWindow(win)

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
  startRestApiIfEnabled()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow()
      setMainWindow(w)
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
