# Conflict resolution & series

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching the conflict queue UI or series display.

---

## Conflict Resolution UI

- Surfaced as a review queue (badge count in sidebar → modal)
- Never blocks import flow
- Per-conflict: side-by-side candidate comparison, click to choose
- "Accept all from Source X" shortcut
- Resolutions logged (`metadata_conflicts.chosen_source`) and fed back into auto-resolution scoring on future hydrations

**The badge is a number the renderer was *told*, not something it reads.** `useUIStore.conflictCount` moves only on the `conflictQueueUpdated` event — or once, when `useLibrary` mounts and reads the queue — while the modal itself reads fresh on every open. So *every* path that changes the conflict set has to announce the new count, or the badge keeps a number the modal will contradict: reported 2026-09-20 as "4 next to *Needs Review*, and nothing to review", which only a full restart cleared. Two paths did not announce it, and both are now funnelled through a single function so they cannot drift apart again — deleting a book (`book-delete.removeBook`) and any adoption (`library-sync.adopt`, because `replaceAllBooks` prunes the conflicts of a book the incoming catalog no longer has: it runs with the foreign keys off and deletes them in the same transaction). The announcement is unconditional rather than "only when that book had conflicts" — one rule with no branch is one a future path cannot half-follow.

Measured *after* the report, on the real library, which is how the mechanism was settled rather than guessed: 42 conflict rows, **all resolved**, zero unresolved and **zero orphans** — so the number on screen had never been the database's, and the delete had in fact cleaned up after itself.

**A book's deletion takes its field overrides with it too.** `field_overrides` is one JSON map in `app_config`, not a `books` table, so nothing cascades it — and the map was found holding an id no `books` row matched (six fields, from the book deleted in that same report). `fieldOverrides.forget(id)` rides the same funnel. A conflict is the other dependent, and it is deleted inside `db.deleteBook` (the `books` FK would otherwise block the delete).

A conflict's candidate list can never offer the same value twice: `sidecar/pipeline/conflict.py` normalizes the candidates and queues a review only when at least two of them differ, so two choices that look like the same wrong author are genuinely different strings — a *matching* problem (which book the fetch found), not a queue defect.

---

## Series Convention

```json
{
  "series_name": "The Expanse",
  "series_index": 1.0,
  "series_total": 9,
  "series_display": "The Expanse #1"
}
```

- `series_index` is float (supports 0.5, 1.5 for novellas)
- Display format: drop `.0` for whole numbers — use the shared `seriesDisplay()` helper in `src/types/book.types.ts`
- `series_total` from Goodreads where available

---
