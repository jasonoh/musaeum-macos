import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `.claude/` holds agent worktrees (`.claude/worktrees/<name>/`), each with
  // its own tsconfig.json — leaving them visible makes the type-aware parser
  // report "multiple candidate TSConfigRootDirs" and refuse to parse every file
  // in the main tree, so a live worktree would silently break `npm run lint`.
  // `.obsidian/` is the vault the docs are browsed in — its plugin bundles are
  // minified third-party JS, and linting them turned the gate red for 635 errors
  // that had nothing to do with this repo's code.
  {
    ignores: ['out/', 'dist/', 'node_modules/', 'sidecar/', 'vendor/**', '.claude/', '.obsidian/']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  },
  {
    files: ['*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly' }
    }
  },
  {
    // Plain-JS build scripts run in Node, outside the TS configs' lib
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } }
  },
  {
    rules: {
      // Matches the project convention: no `any` — define real interfaces
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
)
