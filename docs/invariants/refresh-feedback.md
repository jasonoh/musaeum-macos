# Metadata refresh feedback

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** changing what a re-fetch reports, or the toast surface.

---

## Metadata refresh feedback

Pressing **Re-fetch metadata** (the detail panel's ↻ button, or the context
menu) reports three things it used to leave to inference: that a fetch is
running, what it changed, and why it failed. The button's own state covers the
first (`ui.store.refreshingBooks`, subscribed as a boolean per book, so only
the book being refreshed re-renders — plus a spinner chip on its card, which is
the only sign left when the panel has moved on to another book), and the other
two arrive as a **toast** when the fetch settles.

- **`importer.hydrate` returns what it did** (`HydrateOutcome` in
  `src/types/metadata.types.ts`) rather than only logging it: `{ok: true,
  changed, conflicts}` or `{ok: false, error}`. Still never throws — a failed
  hydration is non-fatal by design — so import and the bulk job ignore the
  value, while the re-fetch reports it.
- **Only a real change counts as a change.** `applyHydration` diffs against the
  row before writing and reports the user-facing field each changed column
  belongs to (`HYDRATED_KEY_FIELD` → `HydratedField`). Two exclusions carry
  that: `sort_title`/`author_sort` are derived companions and are *not* in the
  map (a backfilled sort key is not a title change, and reporting it would put
  "Title" on every refresh of a book that arrived without one); and the cover
  hangs on the sidecar's byte comparison, not the row's path — the paths are
  fixed names (`cover_full.jpg`), so `select_cover` hashes what it is about to
  write against what is there and returns `changed`. Without that, the most
  visible change a refresh can make would be the one thing never reported.
- **"Nothing changed" is the answer most worth giving**, and it is a different
  toast from success (`No new metadata found` / "already has the latest
  details"). A refresh that finds nothing new used to look identical to one
  that did nothing at all.
- **A conflict queues a review offer**, not a claim of success: the toast
  carries a *Review* action that opens the conflict queue.
- **The single-book path is the one awaited hydration.** Import and the bulk
  job keep the non-blocking contract; this one is a user action with a person
  waiting, and the panel that launched it can be gone by the time the answer
  arrives — which is why the report goes to the store rather than to component
  state. Everything funnels through `lib/metadata-refresh.ts`, so the button and
  the context menu cannot drift.
- **Failures keep their own words.** Pre-flight rejections (offline, no
  metadata engine, no EPUB/MOBI/AZW3 to read) and in-flight sidecar errors are
  passed through as the toast's detail line rather than flattened into "failed".

`components/shared/Toasts.tsx` is the surface: bottom-centre (never over the
detail panel's action row, which is where these are triggered), at `z-[60]` —
above the modals, because a completion report must not be hidden behind a panel
opened while the job ran. The store owns dismissal (`notify`/`dismissToast`,
3 on screen, errors last longest, an identical message refreshing the toast
instead of stacking a twin). It also replaces the two `alert()` calls that used
to interrupt with an OS dialog.

The **bulk** job reports itself once at the end, through the same surface: the
status-bar counter simply disappears when the run ends, which is the least
informative moment of a job that may have been cancelled or cut short by the
share dropping. `BulkHydrateProgress` therefore carries `updated` (books that
actually changed), `stopped: 'cancelled' | 'offline'`, and `lastError` — and
`failed` is now a real number: `hydrate` returning its failure is what let the
loop stop counting a dead fetch as a finished one.

---
