"""Full hydration pipeline: fetch, merge, score covers.

Order (per docs/invariants/metadata-hydration.md):
  1. embedded metadata (EPUB or PDF)
  2. known identifiers (already merged into `known` by the caller)
  3. Google Books + OpenLibrary in parallel
  4. Goodreads series scrape (when a Goodreads id is known)
  5. conflict resolution
  6. cover fetch + scoring

`hydrate_metadata` is the write path. `cover_candidates` runs steps 1 and 3 and
then the scoring step, writing nothing: the cover picker's live gather (D1 of the
cover-choice design), for a book whose jacket a person wants to choose rather
than one a fetch is settling.
"""

import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from extractors.epub_metadata import extract_epub_metadata
from extractors.pdf_metadata import extract_pdf_metadata
from fetchers.goodreads import fetch_series
from fetchers.google_books import fetch_google_books, search_by_isbn, search_by_title
from fetchers.openlibrary import KNOWN_ISBN_CAP, fetch_openlibrary, known_isbns
from pipeline.conflict import merge_metadata
from pipeline.cover import gather_candidates, score_candidates, select_cover, summarise_candidates


def hydrate_metadata(
    book_id: str,
    file_path: str,
    book_dir: str,
    known: dict,
    source_preferences: dict,
    locked_fields: Optional[list] = None,
) -> dict:
    """`locked_fields` are the fields the user has set themselves: the merge
    does not propose them and no cover is selected when `cover` is one of them
    (see `docs/superpowers/specs/2026-09-20-field-overrides-design.md`)."""
    sources = {}
    locked = set(locked_fields or ())

    # 1. Embedded metadata, and 3. the parallel online fetch
    embedded, identifiers, google, openlib = _sources(file_path, known)
    if embedded:
        sources["embedded"] = embedded
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
    merged, conflicts = merge_metadata(sources, source_preferences, locked)

    # Identifiers baked into the file (or seeded from Calibre) are definitive —
    # online fetches may match a different edition of the same work. Not when
    # the user owns this field: then their value is the definitive one.
    if identifiers and "identifiers" not in locked:
        merged.setdefault("identifiers", {}).update(identifiers)

    # 6. Cover candidates: online sources + embedded cover (EPUB or PDF).
    # A locked cover gathers no candidate at all: selecting one would spend a
    # download on an image the user has already chosen over. The gather itself
    # lives in `cover.gather_candidates`, shared with the picker's live gather
    # so the two cannot offer different jackets for the same book.
    if "cover" in locked:
        cover_result = {"cover": None, "review": False, "candidates": []}
    else:
        cover_result = select_cover(gather_candidates(file_path, google, openlib), book_dir)
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


def cover_candidates(file_path: str, book_dir: str, known: dict) -> list:
    """Every jacket a fetch would consider for this book — the picker's gather.

    Nothing is written and nothing is persisted: `metadata.json` is untouched by
    this (D1), the candidates are recomputed live on every call, and the answer
    is `cover.summarise_candidates`' payload — one entry per candidate carrying
    its source, its dimensions, its score, whether it is the one that would win,
    whether it is the one on disk now, and a small inlined image the renderer can
    actually display (its CSP names no remote origin, so a bare URL could not be
    shown at all).

    It deliberately does **not** honour a `cover` lock. The lock belongs to the
    fetch: `hydrate_metadata` gathers no candidate for a locked cover, but a
    person reopening the picker to choose a different jacket is exactly what the
    lock must not prevent — otherwise locking once would be a one-way door (D4).
    """
    _, _, google, openlib = _sources(file_path, known)
    return summarise_candidates(
        score_candidates(gather_candidates(file_path, google, openlib)), book_dir
    )


# The whole ISBN sequence's request budget (D5). It is *derived*, not chosen:
# the row contributes at most two identifiers and `known_isbns` caps the work's
# list at its own `KNOWN_ISBN_CAP`, so this is their sum. A flat 6 would silently
# truncate the work's list to four entries and crowd out the row's own, which are
# the most precise identifiers the book has — measured on the book that produced
# this feature, where the second English jacket sits at the work's index 5 and a
# flat cap reaches the first one only.
MAX_SEARCH_ISBNS = 2 + KNOWN_ISBN_CAP


def search_candidates(file_path: str, book_dir: str, known: dict) -> list:
    """The wider search: the jackets that exist under the book's *other*
    identifiers, or — only as a last resort — under its title and author.

    Where `cover_candidates` asks the question a *fetch* asks, this asks the one
    a fetch deliberately never asks (D1 of
    `docs/superpowers/specs/2026-09-25-cover-sources-design.md`): the identifiers
    OpenLibrary lists for the work, among them the ISBNs of other editions. Those
    are the jackets a fetch cannot reach — and, because a fetch would not write a
    jacket it never asked for, the jackets it must never be allowed to write
    silently.

    The order is the whole safety argument, so it is fixed here (D2):

    1. the ISBNs **the row is known by** — `known`'s `isbn_13`, then `isbn_10`;
    2. the ISBNs OpenLibrary lists for the same work (`known_isbns`);
    3. *only when no ISBN answered*, `intitle:"<title>" inauthor:"<author>"`.

    The identifier passes run to the **end** of the list rather than stopping at
    the first hit: this book's two English volumes come from two different ISBNs
    (800x1245 and 1352x2103, the same jacket design), and stopping early would
    deny the better of the two. The fuzzy pass is confined to rows whose
    identifiers are all junk, and it is structured rather than free text —
    measured 2026-09-25, `intitle:"…" inauthor:"…"` answers exactly 1 volume
    where the free-text form of the same title answers 300.

    Nothing is written and nothing is persisted (D4): every press re-asks the
    network, `metadata.json` is untouched, and no candidate list is cached.

    Every entry comes back with `winner: false` (D3). `winner` means "what a
    fetch would write", and a fetch would never ask this question — the mark is
    forced here, on the way out, rather than by a parameter on
    `summarise_candidates`, because that function's meaning is shared with the
    gather and must not learn about a group whose head is not its winner.
    `applied` keeps its byte-identity meaning, unchanged. `url` is present on
    every entry (every hit here is online); a hit that somehow arrived without
    one is dropped, because it is not one `set_cover` could take.

    `file_path` travels only so this call sends the same
    `{file_path, book_dir, known}` triple the gather does — the searched group is
    online-only and nothing is read from the file.

    Never raises: a failing fetcher is a miss, exactly as in `_sources`.
    """
    identifiers = {k: v for k, v in (known.get("identifiers") or {}).items() if v}
    isbn_13 = identifiers.get("isbn_13")
    isbn_10 = identifiers.get("isbn_10")
    title = known.get("title")
    author = known.get("author")

    # (a) the row's own identifiers, (b) the work's — deduped across both and
    # capped as one sequence, because each entry in it is a Google request
    listed = (isbn_13, isbn_10, *_search_call(known_isbns, title, author, isbn_13))
    asked = list(dict.fromkeys(isbn for isbn in listed if isbn))[:MAX_SEARCH_ISBNS]

    hits = []
    for isbn in asked:
        hits.extend(_search_call(search_by_isbn, isbn))

    # (c) the structured title pass, only when every identifier missed
    if not hits:
        hits = _search_call(search_by_title, title, author)

    out = []
    for entry in summarise_candidates(score_candidates(_dedupe_by_bytes(hits)), book_dir):
        if not entry.get("url"):
            continue
        entry["winner"] = False
        out.append(entry)
    return out


def _search_call(fn, *args) -> list:
    """`fn(*args)` as a list, or `[]` — a failing fetcher is a miss (D2).

    The three search functions each promise never to raise; this is the caller's
    half of that promise, so a bug in one of them costs a tile rather than the
    whole press. The same shape as `_safe`, which does it for the hydration's own
    two fetchers.
    """
    try:
        return list(fn(*args) or [])
    except Exception:
        return []


def _dedupe_by_bytes(hits: list) -> list:
    """The hits, one per distinct image.

    Two ISBNs of one work answer the *same* volume — measured here, where a
    sibling ISBN and the work's own ISBN-13 both reach the English jacket — so a
    search that simply concatenated its passes would offer that jacket twice.
    Keyed on the bytes rather than the url, because one image is served from
    several query-string spellings and only the bytes say it is the same image.
    """
    seen = set()
    unique = []
    for hit in hits:
        data = hit.get("data")
        key = hashlib.md5(data).hexdigest() if data else f"url:{hit.get('url')}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(hit)
    return unique


def _sources(file_path: str, known: dict) -> tuple:
    """Steps 1 and 3: the file's own metadata, then the two online fetches.

    One home for "the three requests a hydration makes", because two callers now
    need the same answers for the same book: `hydrate_metadata`, which merges
    them, and `cover_candidates`, which has to score the same candidate set the
    fetch would have scored. A second copy of the identifier precedence — the
    file's own values, the caller's `known` ones over them, and title/author as
    the search fallback — would let the picker offer jackets the fetch never
    considered at all (D1).

    Returns `(embedded, identifiers, google, openlib)`. Either fetcher may be
    `None`: a fetcher that raises is a miss, not a failed hydration.
    """
    embedded = {}
    lower = file_path.lower()
    if os.path.exists(file_path):
        try:
            if lower.endswith(".epub"):
                embedded = extract_epub_metadata(file_path) or {}
            elif lower.endswith(".pdf"):
                embedded = extract_pdf_metadata(file_path) or {}
        except Exception:
            embedded = {}

    identifiers = dict(embedded.get("identifiers") or {})
    identifiers.update({k: v for k, v in (known.get("identifiers") or {}).items() if v})

    isbn_13 = identifiers.get("isbn_13")
    title = known.get("title") or embedded.get("title")
    author = known.get("author") or (
        (embedded.get("authors") or [{}])[0].get("name") if embedded.get("authors") else None
    )

    with ThreadPoolExecutor(max_workers=3) as pool:
        f_google = pool.submit(_safe, fetch_google_books, isbn_13, title, author)
        f_ol = pool.submit(_safe, fetch_openlibrary, isbn_13, title, author)
        google = f_google.result()
        openlib = f_ol.result()

    return embedded, identifiers, google, openlib


def _safe(fn, *args):
    try:
        return fn(*args)
    except Exception:
        return None


def resolve_conflict(book_dir: str, field: str, value: str) -> dict:
    """Kept for API completeness — Node applies most resolutions directly."""
    return {"field": field, "value": json.loads(value) if field == "series" else value}
