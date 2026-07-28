import * as appleBooks from '../services/apple-books'
import * as deviceManager from '../services/device-manager'
import * as transferQueue from '../services/transfer-queue'
import { handle } from './handle'

export function registerDeviceHandlers(): void {
  handle('devices:getConnectedDevices', () => deviceManager.getConnectedDevices())
  handle('devices:sendToDevice', (bookId: string, deviceId: string) =>
    transferQueue.sendToDevice(bookId, deviceId)
  )
  handle('devices:getTransferProgress', (jobId: string) =>
    transferQueue.getTransferProgress(jobId)
  )
  handle('devices:exportToAppleBooks', (bookId: string) => appleBooks.exportToAppleBooks(bookId))
  handle('devices:getOnDeviceBookIds', (deviceId: string) =>
    deviceManager.getOnDeviceBookIds(deviceId)
  )
}
