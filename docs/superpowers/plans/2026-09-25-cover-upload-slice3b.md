# Slice 3b — your own image

**Status:** built in two halves, 2026-09-25. Design: `docs/superpowers/specs/2026-09-25-cover-sources-design.md` (D6, AC11–AC13).
**Why the split:** the row said 8 files; the honest count is **12** — the row again missed `src/types/api.types.ts` (a new preload method does not typecheck without it) and it folded the renderer's button into the same slice that crosses the main-process dialog boundary. So: **3b-i — the write path** (8 files, no UI), **3b-ii — the button** (4 files). Same cut as 3a, for the same reason: the payload is provable without a DOM.

---

## What this slice is for

The fallback the owner asked for before any search existed: *"if the covers are unacceptable by user's determination, user should be able to upload their own option instead."* Two slices later it is the last unreachable case — a book whose right jacket exists in no database, or in no database the app can reach.

## The shape, decided before the build

**D6-a — the dialog is the main process's, and the path never crosses the boundary.** `dialog.showOpenDialog` runs in `ipc/metadata.ts` on the handler side, exactly as `import`'s, `theme`'s, `settings`'s and `library`'s do. The renderer sends a `bookId` and receives either `{cancelled: true}` or the updated book. The chosen path is never a value the renderer can name, so a compromised renderer cannot ask the main process to write an arbitrary file into a book folder, and invariant 9's `file://` rule is not strained by this slice at all.

**D6-b — no new member of the source vocabulary.** `SOURCE_PRIORITY` (`pipeline/cover.py:33`) is keyed by *the sources the scoring step can produce*, and `_score` reads it; a fourth key would be a scoring change (which AC6 of the parent design forbids) and would make "a source the gather could have produced" — the thing `refusalFor`'s first refusal tests — mean something else. The upload is not a scored source: it is a write. So the sidecar gets a **separate method** with no `source` parameter, and the main process gets a sibling of `chooseCover` rather than a fourth `CoverChoice`.

**D6-c — the lock is one implementation.** `chooseCover`'s tail is extracted (`settleChoice`): the row update, the `markFromPatch` marking with `before = null`, `metadata.json`, the catalog upsert, the broadcast. Both gestures call it. D6 says an uploaded cover is "held exactly as a picked one is"; a second copy of that tail is exactly how "held like any pick" would stop being true.

**D6-d — the refusal is a value, not an exception across the boundary.** The sidecar raises `ValueError` with the sentence the user reads; `sidecar.call` rejects; `handle()` returns `{success: false, error}`; the dialog renders it in the line it already has for a failed search. Nothing is written, because the guard runs before `_write_cover`.

**D6-e — a book with no EPUB can still be dressed.** The upload path does *not* call `hydratableFile` — there is no file to read for identifiers or an embedded jacket, and an upload needs neither. This is the one place the upload is *better* than the other two sources, and it falls out of not sharing their pre-flight.

## Files

### 3b-i — the write path (8)

| file | Δ | what |
|---|---|---|
| `sidecar/pipeline/cover.py` | edit | `set_cover_from_file(book_dir, image_path)` — read, guard, `_write_chosen(data, book_dir, "upload")`. **Must not touch `SOURCE_PRIORITY`, `_score`, `score_candidates` or `select_cover`.** |
| `sidecar/main.py` | +5 | `set_cover_from_file` in `METHODS`, with D6's reason in a comment |
| `sidecar/tests/test_cover_upload.py` | new | AC12: valid → 600/200 on disk with the right dims; a text file → refused with a sentence; a 100×300 → refused; **both refusals leave the folder with no `cover_full.jpg`** |
| `electron/main/services/cover-choice.ts` | edit | extract `settleChoice`; add `chooseUploadedCover(bookId, imagePath)` |
| `electron/main/services/cover-choice.test.ts` | edit | the tail is shared (a case per gesture) + the upload writes nothing when the sidecar refuses |
| `electron/main/ipc/metadata.ts` | +~14 | `metadata:chooseCoverFromFile` — the dialog, the cancel value, the call. **Inject the dialog function the way `ipc/nas.ts:27` does**, so a test can decide the cancel path |
| `electron/preload/index.ts` | +1 | `chooseCoverFromFile: (bookId) => invoke(...)` |
| `src/types/api.types.ts` | +~6 | the method on `MusaeumAPI`. **The file the row keeps missing** |

### 3b-ii — the button (4)

| file | Δ | what |
|---|---|---|
| `src/components/library/CoverPicker.tsx` | edit | "Choose an image…" beside the search trigger, its line, its busy state, its refusal line, and a reload after a successful upload so the new jacket reads as applied |
| `src/lib/cover-candidate-state.ts` | +~10 | the button's line and the refused/cancelled sentences, so the copy has a unit decider |
| `src/lib/cover-candidate-state.test.ts` | +3–4 | those sentences, and that a cancel says nothing |
| `src/components/library/cover-picker-wiring.test.ts` | +1 | the new IPC name is on the walk's allow-list |

## Acceptance criteria (from the design)

- **AC11** — choosing an image writes 600/200 and locks the cover; the lock line renders. *CDP probe and a frame.*
- **AC12** — a non-image, or an image under 120 px on either side, is refused with a message and **nothing is written**. *Pytest on the guard, plus `git diff --quiet` over the book folder.*
- **AC13** — `git diff --quiet schema/migrations/`. *This feature persists nothing new.*

## What must not move

- `SOURCE_PRIORITY`, `_score`, `score_candidates`, `select_cover` — byte-identical (§D6-b).
- `schema/migrations/` — byte-identical (AC13).
- `src/types/metadata.types.ts` — no new source, no new `CoverChoice` shape (§D6-b). If a build finds it *must* change, that is a stopping condition, not a judgement call.
- The 120 px floor is `score_candidates:119`'s, quoted rather than re-chosen.

## Start here

1. `git log --oneline -4` — this repo has concurrent sessions; a gate number describes a commit.
2. `sidecar/pipeline/cover.py:229-353` — the write path this slice reuses (`_write_cover`, `_renditions`, `_write_chosen`).
3. `electron/main/services/cover-choice.ts:139-180` — the tail to extract.
4. `electron/main/ipc/nas.ts:27` and `ipc/nas.test.ts:112` — the injectable-dialog precedent.
5. The probe harness for AC11 is `/tmp/probe-cover` with `MUSAEUM_USER_DATA`, launched with `env -u ELECTRON_RUN_AS_NODE`, CDP on 9222 — never the live profile.
