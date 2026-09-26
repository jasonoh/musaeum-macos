"""OpenLibrary API fetcher."""

from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Optional

import requests

SEARCH_URL = "https://openlibrary.org/search.json"
COVER_URL = "https://covers.openlibrary.org/b/id/{cover_id}-L.jpg"
TIMEOUT = 15


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def fetch_openlibrary(
    isbn_13: Optional[str] = None,
    title: Optional[str] = None,
    author: Optional[str] = None,
) -> Optional[dict]:
    params = {"limit": 5, "fields": "*"}
    if isbn_13:
        params["q"] = f"isbn:{isbn_13}"
    elif title:
        params["title"] = title
        if author:
            params["author"] = author
    else:
        return None

    resp = requests.get(SEARCH_URL, params=params, timeout=TIMEOUT)
    resp.raise_for_status()
    docs = resp.json().get("docs") or []
    if not docs:
        return None

    def score(doc: dict) -> float:
        if isbn_13:
            return 1.0
        s = _similarity(title or "", doc.get("title", ""))
        if author and doc.get("author_name"):
            s = 0.7 * s + 0.3 * max(_similarity(author, a) for a in doc["author_name"])
        return s

    best = max(docs, key=score)
    confidence = 0.95 if isbn_13 else score(best)
    if confidence < 0.55:
        return None

    identifiers = {}
    for isbn in best.get("isbn", []):
        if len(isbn) == 13 and "isbn_13" not in identifiers:
            identifiers["isbn_13"] = isbn
        elif len(isbn) == 10 and "isbn_10" not in identifiers:
            identifiers["isbn_10"] = isbn
    edition_key = (best.get("edition_key") or [None])[0]
    if edition_key:
        identifiers["openlibrary"] = edition_key
    for gr_id in best.get("id_goodreads", [])[:1]:
        identifiers["goodreads"] = gr_id

    first_year = best.get("first_publish_year")

    return {
        "source": "openlibrary",
        "title": best.get("title"),
        "authors": [{"name": a, "sort": None} for a in best.get("author_name", [])],
        "publisher": (best.get("publisher") or [None])[0],
        "published_date": str(first_year) if first_year else None,
        "language": (best.get("language") or [None])[0],
        "description": None,  # search API doesn't return descriptions
        "identifiers": identifiers,
        "tags": [s.lower() for s in (best.get("subject") or [])[:8]],
        "cover_url": COVER_URL.format(cover_id=best["cover_i"]) if best.get("cover_i") else None,
        "match_confidence": round(confidence, 2),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


# The request budget for the wider search (D5). Every ISBN asked about is a
# Google request, so the whole sequence is bounded at this many — a work that
# lists 40 ISBNs costs the same as one that lists 6.
KNOWN_ISBN_CAP = 6


def known_isbns(
    title: Optional[str] = None,
    author: Optional[str] = None,
    isbn_13: Optional[str] = None,
) -> list:
    """The ISBNs OpenLibrary lists for the work this book is — search-only (D5).

    `fetch_openlibrary` keeps the first ISBN-13 and the first ISBN-10 it meets
    and **discards the rest of the work's identifiers**, and those discarded ones
    are the point: measured 2026-09-25, the work behind `9780262345064` lists 18
    ISBNs, and two of them (`9780262345071`, `9780262534956`) are answered by
    Google with the English jacket the book's own stored ISBN cannot reach.
    Reading them is what turns "the app had the wrong identifier" into a jacket
    a person can still choose.

    Deliberately *not* part of `fetch_openlibrary`'s return: what that function
    returns is persisted into `metadata.json`, so widening its `identifiers` dict
    would change the stored shape — and the iOS contract with it — for a value
    the record itself has no use for.

    Deduped, **13-digit entries first** (the canonical form, and the one Google
    indexes most often), capped at `KNOWN_ISBN_CAP`. Never raises: an
    unreachable OpenLibrary degrades the search to the row's own identifiers plus
    the title pass, which is the fallback it already has.
    """
    params = {"limit": 5, "fields": "*"}
    if isbn_13:
        params["q"] = f"isbn:{isbn_13}"
    elif title:
        params["title"] = title
        if author:
            params["author"] = author
    else:
        return []

    try:
        resp = requests.get(SEARCH_URL, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
        docs = resp.json().get("docs") or []
    except Exception:
        return []

    if not docs:
        return []

    listed = [i for i in (docs[0].get("isbn") or []) if isinstance(i, str) and i.isdigit()]
    # `dict.fromkeys` dedupes while keeping the payload's own order, and the
    # stable sort then lifts the 13-digit forms to the front without scrambling
    # the order inside either group.
    thirteen_first = sorted(dict.fromkeys(listed), key=lambda i: 0 if len(i) == 13 else 1)
    return thirteen_first[:KNOWN_ISBN_CAP]
