"""One-time Calibre → Musaeum migration.

Safety: the Calibre library is opened read-only and never modified. Books are
copied (never moved) into the target root's /books/{uuid}/ structure. Cutover
happens in the Electron layer only after explicit user confirmation.
"""

import json
import os
import re
import shutil
import sys
import time
import uuid
from datetime import datetime, timezone

from extractors.calibre_db import read_calibre_db
from extractors.pdf_metadata import render_pdf_cover
from pipeline.cover import _write_cover
from pipeline.hydration import hydrate_metadata

BOOK_EXTENSIONS = (".epub", ".mobi", ".azw3", ".pdf")
HYDRATION_DELAY_S = 0.6  # rate-limit online fetches during bulk migration


def _sanitize(title: str) -> str:
    clean = re.sub(r'[/\\:*?"<>|\x00-\x1f]', "", title or "")
    clean = re.sub(r"\s+", " ", clean).strip()
    return (clean or "untitled")[:80]


def _copy_atomic(src: str, dst: str) -> None:
    """Copy src to dst via a temporary '.part' sibling, then atomically
    rename into place. A NAS drop or crash mid-copy therefore never leaves a
    truncated file at `dst` — presence-based idempotency checks elsewhere
    (e.g. topup._attach_pdf) rely on this. On any failure the partial file is
    removed on a best-effort basis before the exception propagates."""
    part = dst + ".part"
    try:
        shutil.copy2(src, part)
        os.replace(part, dst)
    except Exception:
        try:
            os.remove(part)
        except OSError:
            pass
        raise


def migrate_library(job_id: str, calibre_path: str, target_root: str, hydrate: bool, notify) -> dict:
    def progress(**kwargs):
        notify("migration_progress", {"job_id": job_id, **kwargs})

    progress(phase="scanning", completed=0, total=0)
    calibre = read_calibre_db(calibre_path)["books"]
    total = len(calibre)
    progress(phase="copying", total=total, completed=0)

    books_out = []
    stats = {"migrated": 0, "needsReview": 0, "noMetadata": 0, "duplicates": 0}
    seen_isbns = set()

    for i, record in enumerate(calibre):
        title = record.get("title") or "Untitled"
        progress(
            phase="copying", total=total, completed=i, currentTitle=title, **stats
        )
        try:
            book = _migrate_one(record, calibre_path, target_root, seen_isbns, stats)
            if book:
                books_out.append(book)
        except Exception as exc:
            stats["noMetadata"] += 1
            print(f"migration: failed on '{title}': {exc}", file=sys.stderr, flush=True)

    if hydrate:
        for i, book in enumerate(books_out):
            progress(
                phase="hydrating", total=len(books_out), completed=i,
                currentTitle=book["title"], **stats,
            )
            _hydrate_one(book, target_root, stats)
            time.sleep(HYDRATION_DELAY_S)

    progress(phase="done", total=total, completed=total, currentTitle=None, **stats)
    return {"books": books_out, "stats": stats}


def _migrate_one(record: dict, calibre_path: str, target_root: str, seen_isbns: set, stats: dict):
    source_dir = os.path.join(calibre_path, record["path"])
    if not os.path.isdir(source_dir):
        stats["noMetadata"] += 1
        return None

    files = [f for f in os.listdir(source_dir) if f.lower().endswith(BOOK_EXTENSIONS)]
    if not files:
        stats["noMetadata"] += 1
        return None

    isbn = record.get("identifiers", {}).get("isbn_13")
    if isbn and isbn in seen_isbns:
        stats["duplicates"] += 1
        return None
    if isbn:
        seen_isbns.add(isbn)

    book_id = str(uuid.uuid4())
    book_dir = os.path.join(target_root, "books", book_id)
    os.makedirs(book_dir, exist_ok=True)

    sanitized = _sanitize(record.get("title") or os.path.splitext(files[0])[0])
    formats = []
    size_bytes = 0
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        fmt = ext.lstrip(".")
        if fmt in formats:
            continue
        target = os.path.join(book_dir, f"{sanitized}{ext}")
        _copy_atomic(os.path.join(source_dir, f), target)
        formats.append(fmt)
        size_bytes += os.path.getsize(target)

    cover = None
    calibre_cover = os.path.join(source_dir, "cover.jpg")
    if os.path.exists(calibre_cover):
        try:
            with open(calibre_cover, "rb") as fh:
                cover = _write_cover(fh.read(), book_dir)
        except Exception:
            cover = None
    if cover is None and formats == ["pdf"]:
        # PDF-only book without a Calibre cover: render page 1
        pdf_file = os.path.join(book_dir, f"{sanitized}.pdf")
        data = render_pdf_cover(pdf_file)
        if data:
            try:
                cover = _write_cover(data, book_dir)
            except Exception:
                cover = None

    now = datetime.now(timezone.utc).isoformat()
    book = {
        "id": book_id,
        "title": record.get("title") or sanitized,
        "sort_title": record.get("sort_title"),
        "author": record.get("author"),
        "author_sort": record.get("author_sort"),
        "publisher": record.get("publisher"),
        "published_date": record.get("published_date"),
        "language": record.get("language"),
        "description": record.get("description"),
        "identifiers": record.get("identifiers") or {},
        "series": record.get("series"),
        "tags": record.get("tags") or [],
        "rating": record.get("rating"),
        "formats": formats,
        "cover_full": "cover_full.jpg" if cover else None,
        "cover_thumb": "cover_thumb.jpg" if cover else None,
        "file_size_bytes": size_bytes,
        "read_status": "unread",
    }
    _write_metadata_json(book_dir, book, now)
    stats["migrated"] += 1
    return book


def _hydrate_one(book: dict, target_root: str, stats: dict) -> None:
    book_dir = os.path.join(target_root, "books", book["id"])
    epubs = [f for f in os.listdir(book_dir) if f.lower().endswith(BOOK_EXTENSIONS)]
    if not epubs:
        return
    try:
        result = hydrate_metadata(
            book_id=book["id"],
            file_path=os.path.join(book_dir, epubs[0]),
            book_dir=book_dir,
            known={
                "title": book["title"],
                "author": book["author"],
                "identifiers": book["identifiers"],
            },
            source_preferences={},
        )
        merged = result["metadata"]
        for key in ("title", "sort_title", "publisher", "published_date",
                    "language", "description", "identifiers", "series", "tags"):
            if merged.get(key):
                book[key] = merged[key]
        if merged.get("authors"):
            book["author"] = merged["authors"][0]["name"]
            book["author_sort"] = merged["authors"][0].get("sort")
        if result["cover"]:
            book["cover_full"] = result["cover"]["full"]
            book["cover_thumb"] = result["cover"]["thumb"]
        if result["conflicts"]:
            book["needs_review"] = True
            stats["needsReview"] += 1
        _write_metadata_json(book_dir, book, datetime.now(timezone.utc).isoformat())
    except Exception as exc:
        print(f"migration: hydration failed for '{book['title']}': {exc}", file=sys.stderr, flush=True)


def _write_metadata_json(book_dir: str, book: dict, now: str) -> None:
    payload = {
        "id": book["id"],
        "title": book["title"],
        "sort_title": book.get("sort_title"),
        "authors": (
            [{"name": book["author"], "sort": book.get("author_sort")}]
            if book.get("author")
            else []
        ),
        "publisher": book.get("publisher"),
        "published_date": book.get("published_date"),
        "language": book.get("language"),
        "description": book.get("description"),
        "identifiers": book.get("identifiers") or {},
        "series": book.get("series"),
        "tags": book.get("tags") or [],
        "cover": (
            {"full": book["cover_full"], "thumb": book["cover_thumb"]}
            if book.get("cover_full")
            else None
        ),
        "formats": book["formats"],
        "rating": book.get("rating"),
        "read_status": book.get("read_status", "unread"),
        "date_added": now,
        "last_modified": now,
    }
    with open(os.path.join(book_dir, "metadata.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
