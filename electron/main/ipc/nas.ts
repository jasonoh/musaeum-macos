import { dialog } from 'electron'
import * as catalog from '../services/catalog'
import * as librarySync from '../services/library-sync'
import * as nas from '../services/nas-manager'
import { handle } from './handle'

export function registerNASHandlers(): void {
  handle('nas:getStatus', () => nas.getStatus())
  handle('nas:reconnect', () => nas.reconnect())

  handle('nas:setLibraryRoot', async (path: string) => {
    await nas.setLibraryRoot(path)
    await librarySync.syncOnConnect()
  })

  handle('nas:chooseLibraryRoot', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose Library Folder',
      message: 'Select the folder that holds (or will hold) your Musaeum library',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    const root = result.filePaths[0]

    // Peek for an existing library before wiring the root in, and hold the
    // automatic on-connect apply until the user has answered
    const existing = await catalog.readCatalog(root)
    if (existing) librarySync.skipRoot(root)
    await nas.setLibraryRoot(root)

    if (existing) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: `Found a Musaeum library with ${existing.books.length} ${
          existing.books.length === 1 ? 'book' : 'books'
        }`,
        detail: 'Use this library? Your local view will be refreshed from it.',
        buttons: ['Use This Library', 'Not Now'],
        defaultId: 0,
        cancelId: 1
      })
      if (response === 0) await librarySync.applyCatalog(root)
    } else {
      await librarySync.syncOnConnect()
    }
    return root
  })
}
