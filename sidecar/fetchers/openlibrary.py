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
