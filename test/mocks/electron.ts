import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Minimal Electron surface for vitest runs (aliased in vitest.config.ts).
// Each worker process gets its own throwaway userData dir, so tests touch
// a real better-sqlite3 database without a real Electron app.
const userData = mkdtempSync(join(tmpdir(), 'musaeum-vitest-'))

export const app = {
  getPath: (name: string): string => (name === 'userData' ? userData : tmpdir()),
  setPath: (): void => undefined,
  whenReady: (): Promise<void> => Promise.resolve(),
  on: (): void => undefined,
  // Tests run from the repo root, so sidecar path resolution finds the real
  // sidecar/ dir — tool detection is then exercised, not stubbed
  isPackaged: false,
  getAppPath: (): string => process.cwd()
}

export const ipcMain = { handle: (): void => undefined }
export const dialog = {}
export const shell = {}
export const net = {}
export const protocol = {
  registerSchemesAsPrivileged: (): void => undefined,
  handle: (): void => undefined
}
export class BrowserWindow {}
