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
  // that had nothing to do with this repo's code. `.delta/` is the same class as
  // `.claude/` and reached the gate the same way: it holds scratch copies of this
  // repo (`.delta/worktrees/`, `.delta/clones/`) with their own tsconfigs, it is
  // hidden from git by `.git/info/exclude` — which ESLint's flat config does not
  // read — and by 2026-10-13 six stale copies had made `npm run lint` report
  // 1,567 parsing errors, every one of them in a file this repo does not own.
  {
    ignores: [
      'out/',
      'dist/',
      'node_modules/',
      'sidecar/',
      'vendor/**',
      '.claude/',
      '.obsidian/',
      '.delta/'
    ]
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
