"""Full hydration pipeline: fetch, merge, score covers.

Order (per CLAUDE.md):
  1. embedded EPUB metadata
  2. known identifiers (already merged into `known` by the caller)
  3. Google Books + OpenLibrary in parallel
  4. Goodreads series scrape (when a Goodreads id is known)
  5. conflict resolution
  6. cover fetch + scoring
"""

import json
import os
from concurrent.futures import ThreadPoolExecutor

from extractors.epub_metadata import extract_embedded_cover, extract_epub_metadata
from fetchers.goodreads import fetch_series
from fetchers.google_books import fetch_google_books
from fetchers.openlibrary import fetch_openlibrary
from pipeline.conflict import merge_metadata
from pipeline.cover import select_cover


def hydrate_metadata(
    book_id: str,
    file_path: str,
    book_dir: str,
    known: dict,
    source_preferences: dict,
) -> dict:
    sources = {}

    # 1. Embedded metadata
    embedded = {}
    if file_path.lower().endswith(".epub") and os.path.exists(file_path):
        try:
            embedded = extract_epub_metadata(file_path) or {}
        except Exception:
            embedded = {}
    if embedded:
        sources["embedded"] = embedded

    identifiers = dict(embedded.get("identifiers") or {})
    identifiers.update({k: v for k, v in (known.get("identifiers") or {}).items() if v})

    isbn_13 = identifiers.get("isbn_13")
    title = known.get("title") or embedded.get("title")
    author = known.get("author") or (
        (embedded.get("authors") or [{}])[0].get("name") if embedded.get("authors") else None
    )

    # 3. Parallel online fetch
    with ThreadPoolExecutor(max_workers=3) as pool:
        f_google = pool.submit(_safe, fetch_google_books, isbn_13, title, author)
        f_ol = pool.submit(_safe, fetch_openlibrary, isbn_13, title, author)
        google = f_google.result()
        openlib = f_ol.result()

    if google:
        sources["google_books"] = google
    if openlib:
        sources["openlibrary"] = openlib

    # 4. Series from Goodreads, when we have an id from any source
    goodreads_id = (
        identifiers.get("goodreads")
        or (google or {}).get("identifiers", {}).get("goodreads")
        or (openlib or {}).get("identifiers", {}).get("goodreads")
    )
    if goodreads_id:
        series = fetch_series(goodreads_id)
        if series:
            sources["goodreads"] = {
                "series": series,
                "identifiers": {"goodreads": goodreads_id},
            }

    # 5. Merge + conflicts
    merged, conflicts = merge_metadata(sources, source_preferences)

    # Identifiers baked into the file (or seeded from Calibre) are definitive —
    # online fetches may match a different edition of the same work
    if identifiers:
        merged.setdefault("identifiers", {}).update(identifiers)

    # 6. Cover candidates: online sources + embedded EPUB cover
    candidates = []
    if google and google.get("cover_url"):
        candidates.append({"source": "google_books", "url": google["cover_url"]})
    if openlib and openlib.get("cover_url"):
        candidates.append({"source": "openlibrary", "url": openlib["cover_url"]})
    embedded_cover = extract_embedded_cover(file_path) if file_path.lower().endswith(".epub") else None
    if embedded_cover:
        candidates.append({"source": "embedded", "data": embedded_cover})

    cover_result = select_cover(candidates, book_dir)
    if cover_result["review"] and len(cover_result["candidates"]) > 1:
        conflicts.append(
            {
                "field": "cover",
                "candidates": [
                    {"source": c["source"], "value": c["url"]}
                    for c in cover_result["candidates"]
                ],
            }
        )

    return {
        "metadata": merged,
        "conflicts": conflicts,
        "cover": cover_result["cover"],
    }


def _safe(fn, *args):
    try:
        return fn(*args)
    except Exception:
        return None


def resolve_conflict(book_dir: str, field: str, value: str) -> dict:
    """Kept for API completeness — Node applies most resolutions directly."""
    return {"field": field, "value": json.loads(value) if field == "series" else value}
