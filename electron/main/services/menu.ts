import { Menu, app, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/api.types'
import { broadcast } from './events'
import { isPackaged } from './runtime'

/**
 * The native application menu. Two things depend on it existing:
 *
 * - **Standard shortcuts.** Replacing Electron's default menu means every
 *   Cmd+C/V/Z the metadata editor needs has to be re-declared here; the Edit
 *   submenu is not decoration.
 * - **Cmd+,** — macOS looks for Settings in the app menu, and there is no
 *   other place to hang the shortcut. Items only *send* a command; the
 *   renderer decides what it means (see `useMenuCommands`), so a menu item
 *   and its in-app control can never drift apart.
 *
 * The menu is built once and never rebuilt. Nothing here reflects renderer
 * state (no checkmarks on the view items), which is deliberate: keeping
 * checked state in sync would mean touching the menu on every view switch.
 */
function command(cmd: MenuCommand): () => void {
  return () => broadcast('menuCommand', cmd)
}

function buildTemplate(): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin'

  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: command('open-settings') },
      { type: 'separator' },
      ...(isMac
        ? ([
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' }
          ] as MenuItemConstructorOptions[])
        : []),
      { role: 'quit' }
    ]
  }

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      // Not `role: 'selectAll'` — that role owns ⌘A, and the library needs it.
      // The renderer routes by focus so text fields keep their own select-all.
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: command('select-all') }
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { label: 'Grid', accelerator: 'CmdOrCtrl+1', click: command('view-grid') },
      { label: 'List', accelerator: 'CmdOrCtrl+2', click: command('view-list') },
      { type: 'separator' },
      // Reload and DevTools are dev affordances; a shipped build shouldn't
      // offer a reload that drops the user back at an empty library
      ...(isPackaged
        ? []
        : ([
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' }
          ] as MenuItemConstructorOptions[])),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }

  return [appMenu, editMenu, viewMenu, { role: 'windowMenu' }]
}

export function installApplicationMenu(): void {
  // The About panel reads the bundle in dev (where it says "Electron"), so
  // name it explicitly rather than letting the dev bundle speak for the app
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: app.getVersion()
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()))
}
