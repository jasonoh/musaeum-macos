"""Goodreads series scraper.

Best-effort HTML scraping for series name / index / total — Goodreads has no
public API. Personal-use tool; requests are one-off per book, not bulk.
Any failure returns None and the pipeline continues without series data.
"""

import json
import re
from typing import Optional

import requests
from bs4 import BeautifulSoup

BOOK_URL = "https://www.goodreads.com/book/show/{book_id}"
TIMEOUT = 15
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
}


def fetch_series(goodreads_id: str) -> Optional[dict]:
    try:
        resp = requests.get(
            BOOK_URL.format(book_id=goodreads_id), headers=HEADERS, timeout=TIMEOUT
        )
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")

        series = _from_next_data(soup) or _from_series_link(soup)
        if not series:
            return None

        total = _series_total(soup, series["name"])
        if total:
            series["total"] = total
        return series
    except Exception:
        return None


def _from_next_data(soup: BeautifulSoup) -> Optional[dict]:
    """Modern Goodreads pages embed Apollo state in __NEXT_DATA__."""
    tag = soup.find("script", id="__NEXT_DATA__")
    if not tag or not tag.string:
        return None
    try:
        data = json.loads(tag.string)
        apollo = data["props"]["pageProps"]["apolloState"]
        series_name = None
        position = None
        for value in apollo.values():
            if isinstance(value, dict) and value.get("__typename") == "Series":
                series_name = value.get("title")
            if isinstance(value, dict) and value.get("__typename") == "BookSeries":
                pos = value.get("userPosition") or value.get("seriesPosition")
                if pos:
                    position = pos
        if series_name:
            return {"name": series_name, "index": _parse_index(position)}
    except Exception:
        pass
    return None


def _from_series_link(soup: BeautifulSoup) -> Optional[dict]:
    """Fallback: anchor to /series/… with text like 'The Expanse #1'."""
    link = soup.find("a", href=re.compile(r"/series/"))
    if not link:
        return None
    text = link.get_text(" ", strip=True)
    m = re.match(r"^(.*?)\s*#([\d.]+)\s*$", text)
    if m:
        return {"name": m.group(1).strip("() "), "index": _parse_index(m.group(2))}
    return {"name": text.strip("() "), "index": 1.0} if text else None


def _series_total(soup: BeautifulSoup, series_name: str) -> Optional[int]:
    text = soup.get_text(" ", strip=True)
    m = re.search(re.escape(series_name) + r"\s*\(?#?[\d.]*\s*of\s*(\d+)", text)
    return int(m.group(1)) if m else None


def _parse_index(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 1.0
