declare module '*.sql?raw' {
  const content: string
  export default content
}

// The built-in theme corpus is inlined at build time rather than read from disk
// at runtime: `electron.vite.config.ts` bundles `electron/main/index.ts` into
// `out/main/index.js`, and `electron-builder.yml` ships `out/**` only — so a
// `readFileSync` on a path under `services/theme/builtin/` works in neither dev
// nor a packaged build. F10's precedent is the `*.sql?raw` declaration above.
declare module '*.yaml?raw' {
  const content: string
  export default content
}
