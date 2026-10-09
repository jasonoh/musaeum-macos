# Calibre-free conversion — slice 3 (remove the dependency) Implementation Plan

> **Annex to `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md`**, slice 3 of its _Slices_ table. Written 2026-10-09, after slice 2 landed on `main` (`7f5b5e3`). It settles readings and wiring only; the product decisions are the spec's (`D1`–`D7`) and are not re-opened here.

**Date:** 2026-10-09 · **Slice:** 3 of 4 · **Annex to:** the design's _Slices_ row 3, and its `AC3`, `AC6`, `AC8` · **Read first:** the spec's _Slices_ row and those three criteria; `docs/superpowers/plans/2026-10-08-calibre-free-conversion-slice2.md` (what `convert_format` is now, and why the Electron side still sends a path); `docs/invariants/device-transfer.md` (the send path's rules); `electron/main/services/transfer-queue.ts` (the one call site).

## What this slice is

1. `transfer-queue`'s EPUB → AZW3 branch stops asking for a converter and stops refusing when there is none: it calls the sidecar with `{input_path, output_path}` and nothing else.
2. Everything that existed only to find that path goes: `resolveEbookConvert`, `ebookConvertPath`, `STANDARD_EBOOK_CONVERT`, the `ebook_convert_path` config key, its Settings row, its validation case, its browse picker, and its two type fields.
3. The sidecar's half of slice 2's _accept and ignore_ goes with it: `convert_format`'s third parameter, and the two slice-2 cases that pin it.
4. The dead `ebook_convert_path` that `migration.ts` sends to `migrate_library` goes — the sidecar's `migrate_library(job_id, calibre_path, target_root, hydrate, notify)` had no parameter for it (`sidecar/pipeline/migrate.py:50`).
5. The gate is **AC8**: an EPUB-only send with `calibre.app` moved aside.

## Readings this annex settles

**R1 — the stored `app_config` key is left where it is.** Every install that has one keeps a `ebook_convert_path` row nothing reads again. The alternative — deleting it on first run — buys a migration, a write at startup, and a class of bug (a config write before the library is known) for one orphan string. _Reversed by:_ a future pass that enumerates `app_config` keys strictly and would report the orphan as an error.

**R2 — the sidecar's parameter is dropped here, and slice 2's two cases are inverted rather than deleted.** `sidecar/conversion/converter.py:17,20` and `sidecar/tests/test_converter.py:30,105` carry the accept-and-ignore that existed only for the caller being edited in this slice. What those cases describe does not stop being true: the dispatch lambda reads named keys (`sidecar/main.py:95-99`), so a request that still carries `ebook_convert_path` is not an error. Settle: the RPC case keeps its assertion by sending the extra key and requiring success; the direct-call case becomes `pytest.raises(TypeError)` for the third argument. _Alternative:_ leave the parameter — a signature that lies about what the caller sends. _Reversed by:_ a caller in the wild; there is exactly one, `transfer-queue.ts:107`, edited here.

**R3 — `AC6`'s "the existing `transfer-queue` cases passing unmodified" cannot hold, and saying so is the point.** Three of that file's cases exist only to exercise the resolution: `:106,172-179` (the happy path, asserting the call carried the path), `:205` (a cached format means no resolution), `:219` (no path → the refusal). Settle: the happy path stays and its `toHaveBeenCalledWith('convert_format', {input_path, output_path}, 300_000)` loses the third key; `:205`'s assertion goes with the resolution it watched; `:219`'s case goes with the refusal it pinned. The PDF case at `:202` is untouched — the behaviour it pins (a PDF is never converted) does not move. _Reversed by:_ nothing; the criterion's _letter_ was always about the behaviour, and the annex records that the behaviour is re-pinned rather than the text preserved.

**R4 — `ExecutableKind` narrows to `'python'`, and only that.** `src/types/settings.types.ts:165` and `electron/main/ipc/settings.ts:8-14` (`PICKERS: Record<ExecutableKind, …>`) lose their `ebookConvert` member. `assertExecutable` and `ToolResolution` stay: python uses both (`services/settings.ts:299`, `python-env.ts:86,103`), and `sidecar.ts:11`'s re-export stays for the same reason. _Alternative:_ keep the kind — a type that describes a picker whose row is gone.

**R5 — the file budget is 13, not the spec's 9, and the difference needs the owner's nod.** The nine are the approved `electron/main` ⇄ `src` crossing. The other four are the same parameter's other end and its documentation: `sidecar/conversion/converter.py`, `sidecar/main.py`, `sidecar/tests/test_converter.py`, and the comment at `electron/main/services/device-covers.test.ts:80` that names `ebook-convert` while describing a fact about _any_ conversion (slice 2's plan already anticipated that one). 13 exceeds the brief's ~10-file escalation bound, so the corrected budget is the first thing this slice asks for — the boundary is unchanged, only the count. _Reversed by:_ splitting the sidecar half into its own commit-sized change; not worth it, since leaving the parameter is the thing the spec's `D2` forbids.

**R6 — the AC8 instrument, and every write it makes.** Move Calibre aside (`mv /Applications/calibre.app /Applications/calibre.app.off`), send an EPUB-only book, move it back. This is the spec's own criterion and it is reversible in two commands; a source walk alone cannot show that the app does not _gate_ on the path, only that it does not name it. The send writes four things and each has a stated fate: the cached `{book}/<title>.azw3` and the book's `formats`/`file_size_bytes` in `metadata.json` (keep — that is `D7`'s designed caching), the file and its cover entry on the Kindle (delete both afterwards, as slice 1 did), and the `device_history` row (keep — it is the receipt). _Alternative:_ the walk alone. _Reversed by:_ a build in which the resolution is needed again, which would be a different design.

## The file table

Thirteen files. `E:` is the site, read 2026-10-09 on `7f5b5e3`.

| #   | File                                            | Change                                                                                                                                                                 | Evidence                            |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | `electron/main/services/transfer-queue.ts`      | the branch loses its resolve call and its refusal; the call passes two keys                                                                                            | `:96-101`, `:107`                   |
| 2   | `electron/main/services/transfer-queue.test.ts` | the `sidecar` mock loses `ebookConvertPath`; three cases per R3                                                                                                        | `:21,26,106,172-179,202,205,219`    |
| 3   | `electron/main/services/sidecar.ts`             | delete `STANDARD_EBOOK_CONVERT`, `resolveEbookConvert`, `ebookConvertPath`                                                                                             | `:207-219`                          |
| 4   | `electron/main/services/settings.ts`            | the key, the values field, the resolved field, the validation case, and the docblock clause that names it                                                              | `:41-42,97,124,131,188-189,302-303` |
| 5   | `electron/main/services/settings.test.ts`       | the two cases that name it                                                                                                                                             | `:186,221`                          |
| 6   | `electron/main/services/migration.ts`           | the dead parameter in the `migrate_library` params                                                                                                                     | `:151`                              |
| 7   | `electron/main/ipc/settings.ts`                 | the picker entry and the `calibre.app` default path                                                                                                                    | `:8-14`                             |
| 8   | `electron/main/services/device-covers.test.ts`  | the comment names a tool that no longer converts; the fact is about any conversion                                                                                     | `:80`                               |
| 9   | `src/types/settings.types.ts`                   | the values field, the resolved field, and `ExecutableKind`                                                                                                             | `:40,158,165`                       |
| 10  | `src/components/settings/SettingsModal.tsx`     | the `PathField` row, the form field, the browse call — and with them the only copy of the sentence _"Calibre not found — Kindle transfers can't convert EPUB to AZW3"_ | `:45,57,73,576-580`                 |
| 11  | `sidecar/conversion/converter.py`               | the third parameter and the docblock sentence that explains it (R2)                                                                                                    | `:17,20`                            |
| 12  | `sidecar/main.py`                               | the comment above the dispatch lambda (R2)                                                                                                                             | `:96`                               |
| 13  | `sidecar/tests/test_converter.py`               | the two cases inverted per R2                                                                                                                                          | `:30,105`                           |

## Criterion table — every row names its decider

| Criterion                                                                                                                                 | Decider                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AC3** — nothing in `electron/main`, `src` or `sidecar` names `ebook-convert`, `ebook_convert_path`, `ebookConvertPath` or `calibre.app` | a **source walk**, not a one-off grep: a new test that walks the three trees, skips `*.test.*` and whole-line comments (the rule is documented by name in docblocks and the walk must not redden on its own documentation), matches the identifier shapes, and fails with `file:line` and the criterion's number. `scripts/azw3-oracle.py:30` and `sidecar/extractors/calibre_db.py` are outside the three trees and stay |
| **AC6** — a PDF is never converted; a book that already holds an azw3 or mobi is never re-converted                                       | `electron/main/services/transfer-queue.test.ts`'s PDF and cached-format cases after R3's edit — `npm test -- electron/main/services/transfer-queue.test.ts`                                                                                                                                                                                                                                                               |
| **AC8** — uninstalling Calibre changes nothing the app does                                                                               | the live send with `calibre.app` moved aside (R6), on the real Kindle, with the cached file, the device file and the `device_history` row read back                                                                                                                                                                                                                                                                       |
| `convert_format` is called with `{input_path, output_path}` only                                                                          | `sidecar/tests/test_converter.py` after R2's inversion, plus `transfer-queue.test.ts`'s `toHaveBeenCalledWith`                                                                                                                                                                                                                                                                                                            |
| the Settings surface loses exactly one row and nothing else                                                                               | `npm run typecheck` (the narrowed `ExecutableKind` is the compile-time half) + `settings.test.ts` + a CDP pass over the Settings dialog                                                                                                                                                                                                                                                                                   |
| every file this slice touches is formatted                                                                                                | `npx prettier --check` over each touched file that has a parser — and for the two `.md` files, drift measured against `HEAD`, never a whole-file reformat                                                                                                                                                                                                                                                                 |
| **"must not move"**                                                                                                                       | `git diff --quiet <path>` per file in the next section                                                                                                                                                                                                                                                                                                                                                                    |

## What this slice must not move

- `transfer-queue.ts`'s `KINDLE_FORMAT_PREFERENCE` loop, its PDF branch, the `.azw3` cache write with its `updateBook` and `libraryChanged` broadcast, the 300 s timeout, and the copy-with-progress path with its size verification.
- `settings.ts`'s `assertExecutable` (python uses it) and the whole `pythonPath` path; `ToolResolution`, `resolvePython` and the isolation machinery behind them.
- `sidecar/extractors/calibre_db.py`, `sidecar/pipeline/topup.py` and the migration wizard: they read a Calibre _database_, never an install (`services/migration.ts` keeps `calibre_path`).
- `scripts/azw3-oracle.py`'s `CALIBRE` constant — the one sanctioned Calibre-as-tool use; AC3's walk is scoped to the three trees and must not reach `scripts/`.
- `metadata.json`, the SQLite schema, the presence rule, the cover-cache writer, and the reader (the spec's _Deliberately not needed_).
- `CLAUDE.md`'s Stack row and _Resolved Decisions_ §3 — slice 4's, after this gate.

## Verification plan

1. `npm run typecheck && npm test` — the count falls by exactly the cases R3 deletes; state the number reached rather than "green".
2. `npx eslint .` — and on this machine `npx eslint . --ignore-pattern '.delta'`, because the untracked `.delta/worktrees/*/musaeum-macos/` copies make the plain run report 6,475 errors that are all inside them (measured 2026-10-09).
3. `cd sidecar && .venv/bin/python -m pytest -q` — **400** on `7f5b5e3`. R2's inversion changes what two cases assert, not how many there are, so a count that moves means something besides R2 moved.
4. The AC3 walk over all three trees, quoted.
5. The AC8 live pass (R6), with the file's identity read off the device and the cached `.azw3`'s path recorded.
6. Prettier over every touched file; for the two documents, `scripts/prettier-drift.py` before and after, with the working count required to come back to `HEAD`'s.
7. A mutation campaign over the new deciders, one runner per language, with the killed count and the positive control quoted.

## What slice 4 inherits (the record)

Two of the sites the spec's slice-4 row names are already stale, measured 2026-10-09, so slice 4 should not force edits into them: `docs/invariants/settings-and-editing.md` contains no Calibre sentence today, and `docs/invariants/device-transfer.md`'s Calibre mentions are facts about _Calibre's own tool on the device_ (its Kindle driver, the filenames it writes, its cover cache) — true whoever converts, and no part of them says Musaeum needs an install.

What is actually left to correct:

- `README.md:87` — **"[Calibre](https://calibre-ebook.com) is optional, for format conversion on send."** This is the sentence slice 3 makes false. (`:43`'s migration row, and the comparison block, stay.)
- `docs/architecture.md:23` (the stack row _Format Conversion | Calibre CLI (ebook-convert)_) and `:241` ("**Calibre** (host install) — for `ebook-convert` only; detected at …, overridable via `app_config.ebook_convert_path`"). `:49,53,200,203` are the migration reader and the top-up, which stay.
- `CLAUDE.md:83` (the same stack row) and _Resolved Decisions_ §3 ("Calibre CLI: require user installation; path detected, configurable, clear error when missing"), which the spec's header names as what this feature reverses.
- `CHANGELOG.md` — the user-facing fact this slice creates: an EPUB-only send no longer needs Calibre, because the app stopped looking for it.
- `tasks.md` — the Calibre-free entry's next-slice line.

The sentence _"Calibre not found — Kindle transfers can't convert EPUB to AZW3"_ has exactly one copy in the tree (`SettingsModal.tsx:582`, grep 2026-10-09) and this slice deletes it; slice 4 must not hunt for a second.

## Start here

Run these three before reading anything else. The counts belong to `7f5b5e3` (slice 2's merge on `main`); only documentation has landed since, so they are unchanged.

```bash
git log --oneline -3                      # 7f5b5e3 Merge calibre-free-slice2 … at the top
cd sidecar && .venv/bin/python -m pytest -q   # 400 passed
npm run typecheck && npm test             # clean; 1887 passed across 87 files
```

Then read, in order:

1. `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` — its _Slices_ row 3 and `AC3`/`AC6`/`AC8`: the slice's scope, and the criterion whose instrument is a send with Calibre moved aside.
2. `docs/superpowers/plans/2026-10-08-calibre-free-conversion-slice2.md` — what `convert_format` is now, and the constraint that put an _accepted and ignored_ parameter in the tree for this slice to remove.
3. `electron/main/services/transfer-queue.ts` — the one call site, the refusal this slice deletes, and the caching behaviour that must survive it.
4. `docs/invariants/device-transfer.md` — the send path's rules (presence, the cover entry, removal) that the AC8 pass will exercise on the device.

Two environment facts this session paid for: `npm run lint` is red on this machine through no fault of the code (the `.delta` worktree copies — `--ignore-pattern '.delta'` gives 0 problems), and the Kindle reads best if the volume is ejected before the send and the device put in airplane mode.
