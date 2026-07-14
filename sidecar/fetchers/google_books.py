"""Google Books API fetcher."""

import os
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Optional

import requests

API_URL = "https://www.googleapis.com/books/v1/volumes"
TIMEOUT = 15


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def fetch_google_books(
    isbn_13: Optional[str] = None,
    title: Optional[str] = None,
    author: Optional[str] = None,
) -> Optional[dict]:
    """Fetch metadata; returns a normalized dict with match_confidence, or None."""
    if isbn_13:
        query = f"isbn:{isbn_13}"
    elif title:
        query = f'intitle:"{title}"'
        if author:
            query += f' inauthor:"{author}"'
    else:
        return None

    params = {"q": query, "maxResults": 5, "printType": "books"}
    api_key = os.environ.get("GOOGLE_BOOKS_API_KEY")
    if api_key:
        params["key"] = api_key

    resp = requests.get(API_URL, params=params, timeout=TIMEOUT)
    resp.raise_for_status()
    items = resp.json().get("items") or []
    if not items:
        return None

    # Rank candidates by title (and author) similarity to what we asked for
    def score(item: dict) -> float:
        info = item.get("volumeInfo", {})
        s = 1.0 if isbn_13 else 0.0
        if title:
            s = _similarity(title, info.get("title", ""))
            if author and info.get("authors"):
                s = 0.7 * s + 0.3 * max(_similarity(author, a) for a in info["authors"])
        return s

    best = max(items, key=score)
    confidence = score(best) if not isbn_13 else 0.98
    if confidence < 0.55:
        return None

    info = best.get("volumeInfo", {})
    identifiers = {}
    for ident in info.get("industryIdentifiers", []):
        if ident.get("type") == "ISBN_13":
            identifiers["isbn_13"] = ident["identifier"]
        elif ident.get("type") == "ISBN_10":
            identifiers["isbn_10"] = ident["identifier"]

    cover_url = None
    links = info.get("imageLinks") or {}
    for key in ("extraLarge", "large", "medium", "thumbnail", "smallThumbnail"):
        if links.get(key):
            cover_url = links[key].replace("http://", "https://")
            break
    if cover_url and "zoom=" in cover_url:
        cover_url = cover_url.replace("zoom=5", "zoom=1").replace("zoom=2", "zoom=1")

    return {
        "source": "google_books",
        "title": info.get("title"),
        "authors": [{"name": a, "sort": None} for a in info.get("authors", [])],
        "publisher": info.get("publisher"),
        "published_date": info.get("publishedDate"),
        "language": info.get("language"),
        "description": info.get("description"),
        "identifiers": identifiers,
        "tags": [c.lower() for c in info.get("categories", [])],
        "cover_url": cover_url,
        "match_confidence": round(confidence, 2),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
