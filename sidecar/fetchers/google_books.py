"""Google Books API fetcher."""

import hashlib
import os
import re
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Optional, Tuple

import requests

API_URL = "https://www.googleapis.com/books/v1/volumes"
TIMEOUT = 15
# An image is bigger than a metadata record; the fetch is the slow part either
# way, but this is the one request here whose size is not bounded by the API.
IMAGE_TIMEOUT = 30

# Google answers `zoom=0` with one shared "image not available" tile when it
# holds no full-size artwork for a volume. That tile is 575x750, it is bigger
# than anything the API advertises, and it scores 0.783 against the pipeline's
# formula — high enough to win against most embedded covers — so it must never
# become a candidate. Measured 2026-09-21: three unrelated volumes returned
# these exact bytes (md5 a64fa89d7ebc97075c1d363fc5fea71f, 9,103 B).
#
# If Google ever changes the tile this stops matching and the placeholder goes
# back to being an ordinary candidate. What makes that visible rather than
# silent is the cover census in
# `docs/superpowers/specs/2026-09-21-cover-choice-design.md`, which prints
# every winner's md5 — a hash shared by unrelated books is the signature.
PLACEHOLDER_MD5 = "a64fa89d7ebc97075c1d363fc5fea71f"

# The advertised links, largest first. Every volume sampled (11 of 11 that had
# any image, 2026-09-21) advertised only `thumbnail`/`smallThumbnail` — about
# 128 px wide — while the same volumes answered `zoom=0` with up to 2164x3398,
# which is why the biggest rendition is asked for rather than the biggest one
# advertised.
LINK_KEYS = ("extraLarge", "large", "medium", "thumbnail", "smallThumbnail")


def _at_zoom(url: str, zoom: int) -> str:
    """The same Google image at another zoom. `zoom=0` is the largest held."""
    return re.sub(r"(?<=[?&])zoom=\d+", f"zoom={zoom}", url)


def _cover_urls(links: dict) -> list:
    """The renditions to try, best first: the biggest, then what was offered."""
    advertised = next((links[key] for key in LINK_KEYS if links.get(key)), None)
    if not advertised:
        return []
    advertised = advertised.replace("http://", "https://")
    if "zoom=" not in advertised:
        return [advertised]
    biggest = _at_zoom(advertised, 0)
    return [biggest] if biggest == advertised else [biggest, advertised]


def _download_image(url: str) -> Optional[bytes]:
    """The image at `url`, or None — the same >1 KB rule `cover.py` applies."""
    try:
        resp = requests.get(url, timeout=IMAGE_TIMEOUT)
        resp.raise_for_status()
    except Exception:
        return None
    return resp.content if len(resp.content) > 1_000 else None


def _resolve_cover(links: dict) -> Tuple[Optional[str], Optional[bytes]]:
    """The first rendition that is a real image: `(url, bytes)`, or `(None, None)`.

    The bytes come back with the url because the pipeline would otherwise
    download the same image a second time to score it — the point of asking for
    the big rendition is defeated if fetching it costs two round trips.

    A volume whose every rendition is the placeholder tile answers `(None, None)`
    rather than an URL, so the book keeps whatever its own file carries instead
    of being given "image not available" in place of a cover. A transient
    download failure lands in the same place: this source is simply silent for
    that hydration, which is the shape hydration failures already have.
    """
    for url in _cover_urls(links):
        data = _download_image(url)
        if not data:
            continue
        if hashlib.md5(data).hexdigest() == PLACEHOLDER_MD5:
            continue
        return url, data
    return None, None


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

    cover_url, cover_data = _resolve_cover(info.get("imageLinks") or {})

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
        # The bytes behind `cover_url`, already downloaded and checked — see
        # `_resolve_cover`. `None` when Google holds nothing real, in which case
        # `cover_url` is `None` too.
        "cover_data": cover_data,
        "match_confidence": round(confidence, 2),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
