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
  // sidecar/ dir — tool detection is then exercised, not stubbed. Note that
  // main-process code reads dev-vs-packaged from services/runtime.ts, not from
  // this field; it is here to keep the mock faithful to the real app surface.
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
// Main-process modules that touch `nativeTheme` (electron/main/index.ts sets
// `themeSource` from the stored theme) must stay importable under vitest, so the
// mock carries it. Assignable and inert: nothing in the suite reads it back —
// the wiring that writes it is decided by the source walk in
// services/theme/store.test.ts, not here (AC5.5's A25 residual).
export const nativeTheme = { themeSource: 'dark' }
/**
 * The device-cover codec is the one place in the main process that needs
 * Chromium's image codecs, and `npm test` has no Chromium. A table reaching
 * `nativeImage` here would write no cover and report success, so it is loud
 * instead: a test that forgets `setCoverEncoderForTests()` fails at the call
 * rather than asserting an entry that never appeared. The real codec is decided
 * by `scripts/device-cover-probe.ts`, under a real Electron.
 */
export const nativeImage = {
  createFromPath: (): never => {
    throw new Error(
      'nativeImage is not available under vitest — inject the codec with setCoverEncoderForTests()'
    )
  }
}
export class BrowserWindow {}
