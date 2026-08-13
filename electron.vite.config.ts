import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const sharedTypes = resolve(__dirname, 'src/types')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': sharedTypes }
    },
    build: {
      lib: { entry: 'electron/main/index.ts' }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': sharedTypes }
    },
    build: {
      lib: { entry: 'electron/preload/index.ts' }
    }
  },
  renderer: {
    root: '.',
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': sharedTypes,
        '@vendor': resolve(__dirname, 'vendor')
      }
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
        // foliate-js's PDF renderer (vendor/foliate-js/pdf.js, only reached
        // via view.js's `await import('./pdf.js')`) builds a pdf.js asset
        // path with `new URL(\`vendor/pdfjs/${path}\`, import.meta.url)`.
        // Vite's asset-import-meta-url plugin rewrites that dynamic
        // template into an `import.meta.glob('vendor/pdfjs/*', …)`, and
        // that generated glob lacks the leading './' the glob-import
        // plugin requires, which aborts the build. Musaeum never opens
        // PDFs through the in-app reader (see CLAUDE.md — PDFs open via
        // the system default app), so pdf.js is excluded from bundling
        // rather than worked around; nothing in the app's reader path
        // reaches it. Do not edit vendor/foliate-js/pdf.js to fix this —
        // it is vendored source.
        external: (id) => id.endsWith('vendor/foliate-js/pdf.js')
      }
    }
  }
})
