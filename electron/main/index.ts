import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { startRestApiIfEnabled } from './api/rest'
import { registerDeviceHandlers } from './ipc/device'
import { registerFileHandlers } from './ipc/files'
import { registerLibraryHandlers } from './ipc/library'
import { registerMetadataHandlers } from './ipc/metadata'
import { registerMigrationHandlers } from './ipc/migration'
import { registerNASHandlers } from './ipc/nas'
import { registerSettingsHandlers } from './ipc/settings'
import { closeDb, getBook } from './services/db'
import { startDeviceDetection, stopDeviceDetection } from './services/device-manager'
import { setMainWindow } from './services/events'
import { bindToNAS, startWatcher, stopWatcher } from './services/file-watcher'
import { installApplicationMenu } from './services/menu'
import * as importer from './services/importer'
import * as librarySync from './services/library-sync'
import * as nas from './services/nas-manager'
import { isPackaged } from './services/runtime'
import * as sidecar from './services/sidecar'

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

function registerCoverProtocol(): void {
  protocol.handle('musaeum', (request) => {
    const url = new URL(request.url)
    const [bookId, size] = url.pathname.replace(/^\//, '').split('/')
    if (url.host !== 'cover' || !bookId) return new Response(null, { status: 400 })

    const root = nas.getLibraryRoot()
    const book = getBook(bookId)
    const file = size === 'thumb' ? book?.coverThumbPath : book?.coverFullPath
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
    backgroundColor: '#0d0b09',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 18 },
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
  registerCoverProtocol()
  setDevDockIcon()
  installApplicationMenu()

  registerLibraryHandlers()
  registerMetadataHandlers()
  registerDeviceHandlers()
  registerNASHandlers()
  registerMigrationHandlers()
  registerFileHandlers()
  registerSettingsHandlers()

  const win = createWindow()
  setMainWindow(win)

  sidecar.start()
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

app.on('before-quit', () => {
  stopWatcher()
  stopDeviceDetection()
  nas.stopHealthChecks()
  sidecar.stop()
  closeDb()
})

app.on('will-quit', () => {
  importer.abortPendingDecisions()
})
