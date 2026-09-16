# Settings, remembered UI state & the metadata editor

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching `app_config`, persisted UI state, or the metadata editor.

---

## Remembered UI state

View mode (`ui.store`) and sort (`library.store`) survive a restart, persisted
per machine to `localStorage` under `musaeum.ui` / `musaeum.library` via
zustand's `persist`. Deliberately *not* persisted: selection, modals, and the
search query and filters — reopening to a filtered library that looks like a
much smaller one is state whose cause the user can't see.

Both stores `merge` through a validator (`isBookSort` in `book.types.ts`, a
literal check for the view) rather than trusting storage: it was written by
whatever build ran last, and a sort field that no longer exists would reach
`db.SORT_SQL` with no expression to match. Note that `localStorage` is keyed
by origin, so a dev server on a different port starts from defaults; packaged
builds load from `file://` and are stable.

---

## Settings

`components/settings/SettingsModal.tsx` over `services/settings.ts` — the only
way to change `app_config` from the UI. Reached from the sidebar's NAS status
row (or **⌘,**), so "Not configured" leads to where it's fixed.

Two rules shape the service:
- **It never re-implements detection.** What python and ebook-convert resolve
  to is asked of `sidecar.ts` (`resolvePython` / `resolveEbookConvert`, which
  return a `ToolResolution` carrying `configured | auto | none`) — the module
  that actually spawns them. Settings reporting a path the app doesn't use
  would be worse than showing nothing.
- **A bad value is rejected at save time**, before anything is written, so a
  failed save changes nothing. Blank always means "back to auto-detection":
  the field is `deleteConfig`'d rather than stored as `''`, because every
  reader treats *missing* as the signal to auto-detect. Each field's
  placeholder is what it resolves to today, so clearing one visibly falls
  back instead of breaking a feature.

`python_path` and `google_books_api_key` are read at **spawn** time, so
changing either calls `sidecar.restart()` — skipped when the value didn't
actually change, so a no-op re-save can't bounce the sidecar mid-hydration.
`restart()` is why the exit handler checks `proc !== p` before tearing state
down: the old process's exit event arrives *after* its replacement is running
and would otherwise null out the successor.

The Google Books key resolves from `app_config` first and `process.env`
second, so a key set here survives a double-clicked `.app` while
`infisical run -- npm run dev` still works with nothing configured. It is
returned to the renderer in `values` (to edit) but only ever masked in
`resolved`.

Library root keeps its own flow (`nas.chooseLibraryRoot`) rather than joining
the batched save — picking a root can adopt an existing catalog, which is a
question the user has to answer as it happens.

---

## Editing metadata by hand

`components/library/BookEditor.tsx` — a modal over `library.updateBook`, which
already writes metadata.json and upserts the catalog, so the editor needs no
main-process work of its own. Opened from the detail panel's pencil button or
the context menu; mounted in `App.tsx` keyed on `ui.store.editingBookId`.

Two rules keep it from doing damage: it sends **only changed fields**, so a
save can't clobber what hydration wrote meanwhile; and a sort key equal to its
derived form is shown as a live placeholder rather than a value, so renaming a
book re-derives the sort title instead of stranding the old one (a genuinely
custom key is shown and left alone). Renaming a book **does** rename its files
(see `docs/invariants/files-and-deletion.md`).

---
