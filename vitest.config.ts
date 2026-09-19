import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Tests run through Electron-as-Node (see the `test` script) because
// better-sqlite3 is rebuilt for Electron's ABI. The `electron` alias keeps
// main-process modules importable without a running Electron app.
export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the renderer's aliases in `electron.vite.config.ts`. Without
      // `@`, a test that imports anything under `src/` which in turn imports
      // through `@/…` fails to load at all — so the test config has to agree
      // with the build about what a path means, not just about `electron`.
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/types'),
      electron: resolve(__dirname, 'test/mocks/electron.ts')
    }
  },
  test: {
    environment: 'node',
    pool: 'forks',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts', 'test/**/*.test.ts']
  }
})
