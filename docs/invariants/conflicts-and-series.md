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
