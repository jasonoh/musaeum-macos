# Settings, remembered UI state & the metadata editor

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching `app_config`, persisted UI state, or the metadata editor.

---

## Remembered UI state

View mode (`ui.store`) and sort (`library.store`) survive a restart, persisted per machine to `localStorage` under `musaeum.ui` / `musaeum.library` via zustand's `persist`. Deliberately *not* persisted: selection, modals, and the search query and filters — reopening to a filtered library that looks like a much smaller one is state whose cause the user can't see.

Both stores `merge` through a validator (`isBookSort` in `book.types.ts`, a literal check for the view) rather than trusting storage: it was written by whatever build ran last, and a sort field that no longer exists would reach `db.SORT_SQL` with no expression to match. Note that `localStorage` is keyed by origin, so a dev server on a different port starts from defaults; packaged builds load from `file://` and are stable.

---

## Settings

`components/settings/SettingsModal.tsx` over `services/settings.ts` — the only way to change the *editable* `app_config` fields (`smb_url`, `python_path`, `ebook_convert_path`, `google_books_api_key`) from the UI. The theming keys are edited by the Appearance picker instead (see the theme section below). Reached from the sidebar's NAS status row (or **⌘,**), so "Not configured" leads to where it's fixed.

Two rules shape the service:
- **It never re-implements detection.** What python and ebook-convert resolve to is asked of `sidecar.ts` (`resolvePython` / `resolveEbookConvert`, which return a `ToolResolution` carrying `configured | auto | none`) — the module that actually spawns them. Settings reporting a path the app doesn't use would be worse than showing nothing.
- **A bad value is rejected at save time**, before anything is written, so a failed save changes nothing. Blank always means "back to auto-detection": the field is `deleteConfig`'d rather than stored as `''`, because every reader treats *missing* as the signal to auto-detect. Each field's placeholder is what it resolves to today, so clearing one visibly falls back instead of breaking a feature.

`python_path` and `google_books_api_key` are read at **spawn** time, so changing either calls `sidecar.restart()` — skipped when the value didn't actually change, so a no-op re-save can't bounce the sidecar mid-hydration. `restart()` is why the exit handler checks `proc !== p` before tearing state down: the old process's exit event arrives *after* its replacement is running and would otherwise null out the successor.

The Google Books key resolves from `app_config` first and `process.env` second, so a key set here survives a double-clicked `.app` while `infisical run -- npm run dev` still works with nothing configured. It is returned to the renderer in `values` (to edit) but only ever masked in `resolved`.

Library root keeps its own flow (`nas.chooseLibraryRoot`) rather than joining the batched save — picking a root can adopt an existing catalog, which is a question the user has to answer as it happens.

### The Ask (AI) group (slice 4, 2026-09-20)

Three keys — `ai_base_url`, `ai_model`, `ai_api_key` — with two rules of their own, both settled in `docs/superpowers/plans/2026-09-20-reader-ai-config-slice4.md`:

- **The provider is a label derived from the endpoint, never a stored fact.** `src/lib/ai-providers.ts` (renderer-only) holds eleven rows — three loopback servers, seven cloud endpoints, and Custom — and a row's whole content is a base URL. Choosing one writes that URL into the Endpoint field; which row the select shows is *computed* from the value on screen (`matchProvider`, normalized for case and a trailing slash), so a URL nobody lists reads **Custom** and a stored provider id can never disagree with where requests actually go. **No main-process file may import that table**, and it exists only so a text field is easy to fill: the client stays vendor-blind — `probe()` takes a URL, a model and a key, and branches on no vendor at all. A provider that needed a header or a wire of its own would be a wire fact and would belong in the schema, which is a spec amendment rather than a row.
- **Test answers about the form, not about what is saved.** `ai:test` takes its endpoint, model and key as **arguments** (`services/ai.ts` → `probe()`, one thin handler in `ipc/ai.ts`), because the button exists to answer *before* committing — the one exception being a blank endpoint, which falls back to the resolved value, so the first Test on a fresh install means something. It writes nothing. One request (`GET {base}/models`) and six verdicts, and the ladder is the part worth knowing: **401 is about the key, 403 is not** (measured 2026-09-20: `api.groq.com/openai/v1/models` answers 403 with a network message and no key involved), and **404/405/501 mean the endpoint has no model list** — so the key was never checked, and the sentence says exactly that rather than blaming it. The models it lists are the endpoint's own, sorted, capped at 100 with the total reported, and offered back to the Model field as a datalist that stays typable.

---

## The theme's `app_config` keys

Slice 3 (2026-09-16) added three keys — `theme_id`, `theme_tokens`, `theme_library` — and they are the first *main-process-visible* user preference: `createWindow()` reads `theme_tokens` to colour the window before a renderer exists. Three rules come with them, and none of them applies to the other `app_config` keys:

- **`theme/store.ts` is the only writer, and it writes both keys in one transaction.** Derive and validate *first*, then open the transaction. The only legal states are "both keys absent" (the built-in default is active) and "both present and agreeing on `id`" — `theme.set(DEFAULT_THEME_ID)` therefore deletes the pair rather than storing the default's values, because two representations of "default" is a class of state bug for no benefit. The natural order — write the id, derive second — is what leaves the app pointing at a theme it cannot render.
- **Storage is not trusted, on every read.** `theme_tokens` is re-parsed and re-validated: every value the derivation emits — the 16 colours (7 ink, 3 parchment, 4 gold, `on_acc`, `scrim`) plus `shadow` and `dark`, and the status family when the set carries one. Anything short of that is treated as *no theme* — the default applies, the reason is logged, the row is left in place for the user to fix, and the app keeps running. This is the same rule as `sanitizePrefs` and the stores' `merge` validators, for the same reason: a row written by another build (or edited by hand) must not be able to render an unreadable app.
- **`theme_library` is the picker's, and it follows both rules above.** Slice 4 (2026-09-16) made the appearance picker its writer and its first reader, and it inherits the two rules rather than getting its own: it is an array of records in exactly `theme_tokens`' shape, re-validated on **every** read (an entry the reader refuses is dropped with the reason logged and left in the key for the user to fix — a row the reader would refuse can never be applied), and written by one read-modify-write transaction that upserts by id. It is never read while writing `theme_tokens`: `theme.set` does not touch it, so a pick cannot lose the library. Two narrow writers: the importer's `upsertLibrary` (add and update) and the ladder's re-derive arm (rewrite one entry in place).
- **The importer is the only path from a file to a row.** `theme/importer.ts` reads → parses → derives → validates → upserts, per file and independently, so a batch of five files with one malformed member imports four and reports the fifth by path and reason. Importing never activates a theme, and the *derived values* are what is stored — nothing is ever copied, moved or normalized beside the source file, which is what lets an imported theme still be applied after its file has been moved away.
- **The drop-box folder (`userData/themes`) is the user's.** A scan is `readdirSync`, non-recursive, limited to `.yaml`/`.yml`/`.itermcolors`; anything else in it is ignored silently. The app never writes a *file* into it — the one thing it may do *to* it is create the directory, so *Reveal in Finder* works before the first import, and that `mkdir` lives in the IPC layer rather than on the read path (a missing folder is an empty scan, not an error).

`theme_tokens` carries `engineVersion`. A mismatch is **not** a validation failure: an id that can be re-derived — from the inlined built-in corpus, or for an imported theme from its `sourcePath` when that file is still readable — is re-derived and the row rewritten, otherwise the stored values are kept and the view reports `stale` so the picker can flag the row as derived by an older engine rather than the app losing a theme it can still render. That ladder makes a theme *read* able to write — the one place where this service is not side-effect free, and the reason its rewrite is wrapped so a refusing database cannot fail the read (it is called from `createWindow()`, where a throw means no window at all).

The built-in schemes are inlined into the main bundle with `?raw` imports (`theme/builtin/*.yaml`, the `db.ts`-and-its-migrations precedent) rather than read from disk: main is *bundled* to `out/main/index.js` and `electron-builder.yml`'s `files` allowlist ships only `out/**` + `package.json`, so a runtime `readFileSync` on a source path cannot work in a packaged build.

---

## Editing metadata by hand

`components/library/BookEditor.tsx` — a modal over `library.updateBook`, which already writes metadata.json and upserts the catalog, so the editor needs no main-process work of its own. Opened from the detail panel's pencil button or the context menu; mounted in `App.tsx` keyed on `ui.store.editingBookId`.

**An edit here is the user's decision, and it outranks any fetch.** The fields a patch actually *changed* are recorded as overrides (`services/field-overrides.ts`, one JSON map in `app_config` under `field_overrides`, keyed by book id), and `importer.hydrate` then keeps the fetch off them — the sidecar is told not to propose them, and the reply is filtered before the write. The editor is therefore also where that is undone: a held field carries a gold padlock chip, and clicking it releases the field without touching its value. The map is machine-local by design — it is not in `metadata.json`, so a re-fetch run from another machine can still move an overridden field; see `docs/superpowers/specs/2026-09-20-field-overrides-design.md` (D1, and the condition that would move it into the book's record).

Two rules keep it from doing damage: it sends **only changed fields**, so a save can't clobber what hydration wrote meanwhile; and a sort key equal to its derived form is shown as a live placeholder rather than a value, so renaming a book re-derives the sort title instead of stranding the old one (a genuinely custom key is shown and left alone). Renaming a book **does** rename its files (see `docs/invariants/files-and-deletion.md`).

---
