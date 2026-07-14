import { BrowserWindow } from 'electron'
import { EVENT_CHANNELS } from '@shared/api.types'

type ChannelKey = keyof typeof EVENT_CHANNELS

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

/** Push an event to the renderer. Safe to call before the window exists. */
export function broadcast(event: ChannelKey, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(EVENT_CHANNELS[event], payload)
  }
}
