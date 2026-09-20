# Metadata hydration

> Moved verbatim from `CLAUDE.md` (2026-09-15 doc split). `CLAUDE.md` carries
> the one-line index; this file carries the payload. Heading levels were
> promoted (`###` → `##`) and a handful of cross-references repointed —
> nothing else changed.

**Read before:** touching the hydration pipeline, identifier precedence, the conflict policy, or cover scoring.

---

## Metadata Hydration Pipeline

Triggered automatically on every book import. Non-blocking: the book is inserted into the library immediately after copy; hydration continues async (`importer.hydrate` is fire-and-forget from the import path — it *returns* what it did, and the explicit re-fetch described in `docs/invariants/refresh-feedback.md` is the one caller that waits for that value).

```
1. Extract embedded metadata (EPUB OPF, or PDF Info dict + page-1 render as
   an 'embedded' cover candidate)
2. Known identifiers (from Calibre during migration) merged in
3. Parallel fetch: Google Books API + OpenLibrary API
4. Series data: Goodreads scrape when a Goodreads ID is known (any source)
5. Conflict resolution (see policy below)
6. Cover fetch + scoring (formula below)
7. Write metadata.json to NAS + update SQLite cache
```

**Identifier precedence (learned in testing):** identifiers baked into the file or seeded from Calibre are definitive and always override fetched ones — online fetches may match a different *edition* of the same work. (`sidecar/pipeline/hydration.py`)

**A field the user has set is not a field a fetch may move.** The user's own decisions — an edit in the metadata editor, a resolved conflict — are recorded as overrides (`services/field-overrides.ts`) and passed to the sidecar as `locked_fields`, where the merge leaves them out of the candidate list entirely: nothing merged, no conflict queued. That is a deliberate silence, not an oversight — a locked field is one the app will not even tell you it disagrees with, which is why the editor carries the release control (`docs/invariants/settings-and-editing.md`). Two things are enforced in the main process as well, because the sidecar's half cannot cover them: the file's own identifiers and the cover are merged *outside* `merge_metadata`, and the reply is filtered before the write. Without the lock, the merge would overwrite a user's choice on the next fetch, whatever the source-priority arithmetic says.

**Description is plain text, and the file it is read from matters.** A stored description carries no markup: block boundaries are newlines, entities are decoded, and `extractors/html_text.py` is the only place that decides it — both the EPUB extractor and the Calibre one call it, so the two cannot disagree. Calibre's `comments` column is HTML and used to be written through verbatim, which is why 2,781 of 6,462 books in the real library held a `<p>` (measured 2026-09-20). Extraction happens from a specific file, and the sidecar reads embedded metadata from an EPUB or a PDF and nothing else — so `bulk-hydrate.findHydratableFile` reads the folder in preference order (`.epub`, then `.azw3`, `.mobi`, derived from the renderer's own `READABLE_FORMATS`) rather than in `readdir` order, which is directory order and handed the `.azw3` of 14 books in a 200-folder sample that also held an `.epub`. Dropping the embedded source drops its identifiers, its cover fallback, and a description `longest wins` would have preferred. Rows written before this rule still hold markup, so the detail panel renders whatever is on disk through `src/lib/description.ts` — the same rule in the renderer; rewriting the canonical `metadata.json` files is a separate decision, not taken.

**Conflict policy** (`sidecar/pipeline/conflict.py`):
- `title`, `author`, `series` — best candidate applied immediately AND a review conflict queued when sources disagree (book is never left blank)
- `publisher`, `published_date`, `language` — auto-resolved by source priority, never queued
- `description` — longest candidate wins, never queued
- `cover` — top-scored applied; a review conflict is queued when the top two score within 15% (candidate values are image URLs)
- Source priority: google_books > openlibrary/goodreads > calibre > embedded, biased by the user's past resolutions (`db.getSourcePreferences()`)

Cover scoring formula:
```
score = (resolution × 0.4) + (aspect_ratio × 0.3)
      + (source_priority × 0.2) + (file_size × 0.1)
```

Google Books API key: read from the `GOOGLE_BOOKS_API_KEY` environment variable (optional for normal use; required before bulk migration). Secrets live in the Infisical project `musaeum`; inject them for dev/build by wrapping the command — `infisical run -- npm run dev`. A packaged `.app` can't use `infisical run`; the planned path is to move the key into `app_config` via Settings (see tasks.md → Packaging & distribution).

---
