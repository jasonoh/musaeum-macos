import { dialog } from 'electron'
import * as nas from '../services/nas-manager'
import { handle } from './handle'

export function registerNASHandlers(): void {
  handle('nas:getStatus', () => nas.getStatus())
  handle('nas:reconnect', () => nas.reconnect())
  handle('nas:setLibraryRoot', (path: string) => nas.setLibraryRoot(path))

  handle('nas:chooseLibraryRoot', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose Library Folder',
      message: 'Select the folder that holds (or will hold) your Musaeum library',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    await nas.setLibraryRoot(result.filePaths[0])
    return result.filePaths[0]
  })
}
