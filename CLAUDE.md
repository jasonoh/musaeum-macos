# Musaeum — Claude Code Project Brief

This file loads at the start of every session and is the **index**, not the manual: what the project is, the rules that must never bend, where to look, and when to stop and hand back. The payload lives in `docs/` and is loaded on demand — see Companion files below.

@.claude/rules/orchestration.md

**Companion files:**

- `docs/architecture.md` — process model, directory layout, path aliases, perf targets
- `docs/data-contracts.md` — `metadata.json`, SQLite schema, sidecar RPC, preload API
- `docs/invariants/*.md` — one file per subsystem: the rules, and the reasoning behind them

| Read this | Before you touch |
|---|---|
| `docs/architecture.md` | process structure, directory layout, path aliases, perf targets |
| `docs/data-contracts.md` | `metadata.json`, a SQLite migration, a sidecar method, the preload surface |
| `docs/rest-api.md` | the HTTP surface (`electron/main/api/rest.ts`), the payload shaper, the cover/file byte routes — or anything an out-of-repo client is written against |
| `docs/invariants/nas-and-catalog.md` | NAS detection, offline mode, `catalog.json`, the catalog ⇄ SQLite sync |
| `docs/invariants/metadata-hydration.md` | the hydration pipeline, identifier precedence, the conflict policy, cover scoring |
| `docs/invariants/conflicts-and-series.md` | the conflict queue, series display |
| `docs/invariants/device-transfer.md` | Kindle detection, sends, on-device presence, removal |
| `docs/invariants/library-views.md` | grid, list, sort SQL, virtualization, `BookCard` |
| `docs/invariants/selection-and-keyboard.md` | selection state, keyboard handling, ⌘A |
| `docs/invariants/reader.md` | the reader, foliate-js, `musaeum://book`, reading position |
| `docs/invariants/refresh-feedback.md` | what a re-fetch reports, the toast surface, the bulk job |
| `docs/invariants/files-and-deletion.md` | on-disk filenames, deletion, bulk actions, duplicate gating |
| `docs/invariants/settings-and-editing.md` | `app_config`, persisted UI state, the metadata editor |
| `docs/invariants/packaging-and-python.md` | `electron-builder.yml`, the Python bootstrap, the bundle |
| `docs/invariants/menu-and-branding.md` | the native menu, the app name, the dock icon |
| `tasks.md` · `CHANGELOG.md` · `requirements.md` | roadmap · history · original product spec |
| `docs/superpowers/specs/` · `docs/superpowers/plans/` | feature designs and their implementation plans |

Each invariant file carries the *why* — the measurement, the failure it was written to prevent, the approach that was tried and rejected. That reasoning is what stops a later change from re-breaking it, so read the file your slice touches before editing, not after.

---

## Project Overview

Musaeum is a macOS Electron application for personal ebook library management, designed to replace Calibre for a library of 7000+ books stored on network-attached storage. It prioritizes automatic metadata hydration, clean organization, and frictionless device delivery.

**Beauty is a first-class requirement.** The UI follows a "dark library" aesthetic: warm near-black surfaces, amber/gold accents, serif display type for book titles, covers as the hero element. The palette is consumed through design tokens: `tailwind.config.js` defines them as `rgb(var(--x) / <alpha-value>)` over CSS custom properties, and the properties' *default* lives in `src/index.css`'s `:root` (`ink`, `parchment`, `gold`; plus `font-display`). Since slice 3 of the theming feature a stored theme re-writes those properties at runtime, so `tailwind.config.js` is the palette's *shape* and `:root` is its default, not its identity — a colour decision that lives outside both (a literal in a component, a stock Tailwind hue) is invisible to theming.

---

## Status

Phase 1 (MVP) was implemented and verified end-to-end on 2026-07-12: import → hydration → conflict queue → covers → FTS all confirmed against live APIs. Phase 1.5 PDF support shipped 2026-07-27 (PDF as a first-class format + Calibre PDF top-up, now run against the real library). The in-app reader shipped 2026-08-13 for EPUB/MOBI/AZW3, with reading position that survives a restart and follows you between machines; PDF in the reader is the next phase. See `tasks.md` for the roadmap and known gaps, `README.md` for setup, and `CHANGELOG.md` for history.

Dev quickstart:

```bash
npm install                                  # postinstall rebuilds better-sqlite3
python3.12 -m venv sidecar/.venv && sidecar/.venv/bin/pip install -r sidecar/requirements.txt
npm run dev                                  # launch with hot reload
npm run typecheck && npm run lint            # keep clean; both pass on main
npm test                                     # vitest main-process suite —
                                             # runs Electron-as-Node so the
                                             # better-sqlite3 native ABI matches;
                                             # invoke only via this script
npm run pack                                 # DMG into dist/ — needs Node 22.12+
```

Dev database: `~/Library/Application Support/Musaeum/musaeum.db` (WAL — safe to inspect with the sqlite3 CLI while the app runs).

---

## Stack

| Layer            | Technology                        |
|------------------|-----------------------------------|
| Shell            | Electron 44                       |
| UI               | React + TypeScript                |
| Styling          | Tailwind CSS                      |
| State            | Zustand                           |
| Main Process     | Node.js (Electron)                |
| Local Database   | SQLite via better-sqlite3         |
| Metadata/Convert | Python 3.11+ sidecar              |
| Format Conversion| Calibre CLI (ebook-convert)       |
| IPC              | Electron contextBridge + ipcMain  |

Fixed; do not substitute. Process model, directory layout and path aliases are in `docs/architecture.md`.

---

## Invariants — never break these

Each one is load-bearing and has a doc carrying the full reasoning. If a change would require bending one, that is an escalation (below), not a judgement call.

1. **`metadata.json` is canonical; `catalog.json` is derived.** Never make the catalog authoritative, and never write it from a path that has not already written `metadata.json`. (`invariants/nas-and-catalog.md`)
2. **Every file lookup resolves by extension**, never by canonical filename — a book renamed after import must still open, hydrate, delete and transfer. (`invariants/files-and-deletion.md`)
3. **Nothing may read `formats[0]`.** Use `primaryFormat()` / `orderedFormats()` — the array holds whatever order the writing source left. (`invariants/library-views.md`)
4. **Sort keys are derived at every write path** via `sortableTitle()` / `sortableAuthor()`: import, `applyHydration`, `metadataJsonToBook`, and catalog reads. A path that forgets strands books under the wrong letter. (`invariants/library-views.md`)
5. **Reading state — position *and* read status — must survive the round trip.** `metadataJsonToBook` and `replaceAllBooks` carry it, and adoption *reconciles* — strictly newer local progress wins, a `read_status` the user set included — rather than overwriting. (`invariants/reader.md`)
6. **A settled title renames its files**, on all three paths: `importer.hydrate`, `library:updateBook`, `metadata:resolveConflict`. (`invariants/files-and-deletion.md`)
7. **Row height is computed, not measured.** `ROW_HEIGHT` / `CARD_META_HEIGHT` / `CARD_META_MARGIN` must match real DOM geometry, and every list cell needs a **block-level** child. Drift shows up as scroll jank, not a build error. (`invariants/library-views.md`)
8. **Business logic lives in `electron/main/services/`.** IPC handlers are thin wrappers through `handle()`. (`data-contracts.md`)
9. **The renderer never gets `file://`.** Covers and book bytes go through `musaeum://`, realpathing *both* the library root and the candidate. (`invariants/reader.md`)
10. **`app.isPackaged` must stay honest.** Never rename `Contents/MacOS/Electron` to chase a label; read `isPackaged` from `services/runtime.ts`. (`invariants/menu-and-branding.md`)
11. **`vendor/foliate-js/` is never edited.** Divergences live in our code or in  `src/types/foliate-js.d.ts`. (`invariants/reader.md`)
12. **Failures stay non-fatal where the doc says so.** NAS errors degrade to offline mode; a failed hydration keeps embedded metadata and never throws. (`invariants/nas-and-catalog.md`, `invariants/refresh-feedback.md`)

---

## Escalate — stop and hand back — when

- The task needs a design decision this brief does not settle.
- One of the **Invariants** above would have to bend.
- The work exceeds roughly 10 files, or crosses a boundary you were not given (`electron/main` ⇄ `src` ⇄ `sidecar`).
- Two consecutive repair attempts fail on the same test.

Hand back what you found rather than a partial guess. A stopped task is cheap; a plausible change that quietly breaks an invariant is not.

---

## Main session only

If you are the main session — not a subagent — you are also the orchestrator: read and follow `.claude/rules/orchestration.md`. It owns the `deep-reasoner` / `fast-worker` delegation contract, the superpowers-coexistence rules, and its own precedence note. It is `@`-imported above, so it is already in context.

Subagents ignore this section; you own your one slice and hand back.

**Repo agents** (`.claude/agents/`) sit on the layer boundaries, so a slice routes by where it lands:

| Agent | Owns |
|---|---|
| `spec-writer` | a checkable spec before implementation, into `docs/superpowers/specs/` |
| `main-engineer` | `electron/main/` — services, IPC, DB + migrations |
| `renderer-engineer` | `src/` — components, stores, hooks, lib |
| `sidecar-engineer` | `sidecar/` — extractors, fetchers, pipeline, conversion |
| `contracts-engineer` | `src/types/` + `schema/migrations/` + the `metadata.json` shape |
| `packaging-engineer` | `electron-builder.yml`, the Python bootstrap, the bundle |
| `test-author` | `test/` (vitest) and `sidecar/tests/` (pytest) |
| `reviewer` | the pre-merge gate against the invariants list |

**Handoffs name their docs.** A subagent starts with no memory of the session that dispatched it, so every dispatch carries the `docs/invariants/*.md` path(s) the work touches — not just the file to edit. That is what the routing table at the top of this file is for.

---

## Conventions

### Code Style

- TypeScript strict mode; `npm run typecheck` covers main + renderer
- ESLint (flat config, `eslint.config.mjs`) + Prettier — keep both clean
- No `any` types — define interfaces in `src/types/`
- All IPC handlers in `electron/main/ipc/` — one file per domain, registered through `ipc/handle.ts`
- All business logic in `electron/main/services/` — never in IPC handlers
- React components are functional only — no class components
- Zustand stores are the single source of truth for UI state; main-process events are wired into stores once, in the `src/hooks/use*.ts` hooks mounted by `App.tsx`
- Never call NAS/file operations directly from renderer — always via IPC
- Icons are the hand-rolled inline SVG set in `src/components/shared/icons.tsx` — no icon library

### Error Handling

- All IPC handlers wrapped via `handle()` → `{ success, data | error }`; never throw across the IPC boundary
- Python sidecar errors returned in JSON-RPC `error` field
- NAS errors are non-fatal — degrade to offline mode, log, surface in UI
- Hydration failures are non-fatal — book keeps embedded metadata
- Format conversion failures are logged to `device_history` with error field

### File Naming

- React components: PascalCase (`BookCard.tsx`)
- Services, hooks, stores: camelCase / kebab (`nas-manager.ts`, `useLibrary.ts`)
- Python modules: snake_case (`epub_metadata.py`)

### Markdown

- **Prose is not hard-wrapped.** One line per paragraph, bullet, blockquote and table row, however long — no fixed-column wrapping in any `.md` file. Prettier's `proseWrap` is left at `preserve`, so nothing enforces this but this line; wrapped prose arrives as noise the reader has to clean up by hand.
- Fenced code blocks, tables, YAML frontmatter and indented lists keep their own formatting; don't reflow them.

---

## Performance Targets

| Metric                              | Target       |
|-------------------------------------|--------------|
| Library load (7000 books)           | < 2 seconds  |
| Search response time                | < 100ms      |
| App cold start                      | < 3 seconds  |
| Metadata hydration per book         | < 5 seconds  |
| NAS reconnection detection          | < 5 seconds  |
| Format conversion (epub → mobi)     | < 30 seconds |
| Memory footprint (typical use)      | < 500MB      |

Both library views are virtualized (see `docs/invariants/library-views.md`); measured against a synthetic 7000-book library at ~1000 DOM nodes, 32MB heap, 115ms `getBooks`, 18ms search.

---

## iOS Companion

**The client is real, in its own repository: `jasonoh/musaeum-ios`** (locally `../musaeum-ios`) — SwiftUI over Readium, iOS 18, XcodeGen from `project.yml`. **The wire contract is this repo's:** `docs/rest-api.md` is the only description of it, the client derives its test fixtures from that document by script and never restates it, and `scripts/api-smoke.sh` is the contract's executable half — so a payload change touches the document, its goldens and the smoke script in one slice, here, first.

The Phase 1 staging claims below are what made that client cheap; all six held.

1. SQLite schema contains no UI-coupled fields
2. `metadata.json` is the canonical data contract (documented in `docs/data-contracts.md`)
3. REST API is real at `electron/main/api/rest.ts` — six read routes and two writes (the reading report and a book upload) behind a generated bearer token, bound to the tailnet address, disabled by default via the `app_config` flag `rest_api_enabled = false` (`docs/invariants/settings-and-editing.md`)
4. All book file paths stored as relative paths from library root
5. Covers at two resolutions: `cover_thumb.jpg` (200px), `cover_full.jpg` (600px)
6. All data access goes through the service layer (IPC handlers contain no business logic) so extraction to a standalone API server stays cheap

---

## Resolved Decisions (formerly Open Questions)

1. **App name**: **Musaeum** — confirmed 2026-07-12
2. **Goodreads scraping**: accepted for personal use; best-effort with silent degradation, never exposed as a networked service
3. **Calibre CLI**: require user installation; path detected, configurable, clear error when missing (no bundling)
4. **Google Books API key**: `GOOGLE_BOOKS_API_KEY` env var; obtain before running the 7000-book migration
5. **Update mechanism**: still open — tracked in tasks.md (manual for now)
