"""Re-runnable Calibre PDF top-up.

Attaches PDFs skipped by the initial migration to their already-migrated
books (matched Goodreads ID → ISBN-13 → normalized title+author), and
imports PDF-only Calibre books as new entries via migrate._migrate_one.
Idempotent: a target folder that already contains a .pdf is skipped, and
library-index matches never create duplicates.
"""

import json
import os
import shutil
from datetime import datetime, timezone
from typing import Callable, Optional

from extractors.calibre_db import read_calibre_db
from pipeline.migrate import _migrate_one, _sanitize

# Sentinel returned by the matcher when a title (or title+author) key maps to
# more than one library entry — the caller must skip rather than guess.
AMBIGUOUS = object()


def _normalize(s: str) -> str:
    """Mirror db.ts findByTitleAuthor: lowercase, non-alphanumerics → space."""
    out = "".join(ch if ch.isalnum() else " " for ch in (s or "").lower())
    return " ".join(out.split())


def _build_matcher(library_index: list) -> Callable[[dict], Optional[dict]]:
    by_goodreads = {e["goodreads"]: e for e in library_index if e.get("goodreads")}
    by_isbn = {e["isbn_13"]: e for e in library_index if e.get("isbn_13")}
    by_title_author = {}
    by_title_only = {}

    def _put(table: dict, key, entry: dict) -> None:
        existing = table.get(key)
        if existing is None:
            table[key] = entry
        elif existing is not entry:
            table[key] = AMBIGUOUS

    for e in library_index:
        key = _normalize(e.get("title") or "")
        if not key:
            continue
        _put(by_title_only, key, e)
        if e.get("author"):
            _put(by_title_author, (key, _normalize(e["author"])), e)

    def match(record: dict):
        """Returns a library entry, the AMBIGUOUS sentinel, or None."""
        ids = record.get("identifiers") or {}
        if ids.get("goodreads") and ids["goodreads"] in by_goodreads:
            return by_goodreads[ids["goodreads"]]
        if ids.get("isbn_13") and ids["isbn_13"] in by_isbn:
            return by_isbn[ids["isbn_13"]]
        nt = _normalize(record.get("title") or "")
        na = _normalize(record.get("author") or "")
        if nt and na and (nt, na) in by_title_author:
            return by_title_author[(nt, na)]
        if nt and not na and nt in by_title_only:
            return by_title_only[nt]
        return None

    return match


def _find_pdf(source_dir: str) -> Optional[str]:
    if not os.path.isdir(source_dir):
        return None
    for f in sorted(os.listdir(source_dir)):
        if f.lower().endswith(".pdf"):
            return os.path.join(source_dir, f)
    return None


def _attach_pdf(pdf_path: str, entry: dict, target_root: str) -> Optional[int]:
    """Copy the PDF into an existing book folder and update metadata.json.
    Returns copied byte size, or None when the folder already has a PDF."""
    book_dir = os.path.join(target_root, entry["nas_path"])
    if not os.path.isdir(book_dir):
        return None
    if any(f.lower().endswith(".pdf") for f in os.listdir(book_dir)):
        return None

    meta_path = os.path.join(book_dir, "metadata.json")
    try:
        with open(meta_path, encoding="utf-8") as fh:
            meta = json.load(fh)
    except Exception:
        meta = {}

    title = meta.get("title") or entry.get("title") or "untitled"
    target = os.path.join(book_dir, f"{_sanitize(title)}.pdf")
    shutil.copy2(pdf_path, target)

    formats = meta.get("formats") or []
    if "pdf" not in formats:
        formats.append("pdf")
    meta["formats"] = formats
    meta["last_modified"] = datetime.now(timezone.utc).isoformat()
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    return os.path.getsize(target)


def topup_pdfs(
    job_id: str,
    calibre_path: str,
    target_root: str,
    library_index: list,
    notify: Callable[[str, dict], None],
) -> dict:
    def progress(**kwargs):
        notify("migration_progress", {"job_id": job_id, **kwargs})

    progress(phase="scanning", completed=0, total=0)
    calibre = read_calibre_db(calibre_path)["books"]

    with_pdf = []
    for record in calibre:
        pdf_path = _find_pdf(os.path.join(calibre_path, record["path"]))
        if pdf_path:
            with_pdf.append((record, pdf_path))

    match = _build_matcher(library_index)
    stats = {"attached": 0, "added": 0, "skipped": 0}
    attached = []
    new_books = []
    migrate_stats = {"migrated": 0, "needsReview": 0, "noMetadata": 0, "duplicates": 0}
    seen_isbns = {e["isbn_13"] for e in library_index if e.get("isbn_13")}
    total = len(with_pdf)

    for i, (record, pdf_path) in enumerate(with_pdf):
        progress(phase="copying", total=total, completed=i,
                 currentTitle=record.get("title"), **stats)
        try:
            entry = match(record)
            if entry is AMBIGUOUS:
                # Multiple library entries share this title — attaching would
                # risk the wrong book, importing would risk a duplicate.
                stats["skipped"] += 1
                print(f"topup: ambiguous match for '{record.get('title')}', skipped", flush=True)
            elif entry is not None:
                size = _attach_pdf(pdf_path, entry, target_root)
                if size is None:
                    stats["skipped"] += 1
                else:
                    stats["attached"] += 1
                    attached.append({"book_id": entry["id"], "file_size_bytes": size})
            else:
                book = _migrate_one(record, calibre_path, target_root,
                                    seen_isbns, migrate_stats)
                if book and "pdf" in book["formats"]:
                    stats["added"] += 1
                    new_books.append(book)
                else:
                    stats["skipped"] += 1
        except Exception as exc:
            stats["skipped"] += 1
            print(f"topup: failed on '{record.get('title')}': {exc}", flush=True)

    progress(phase="done", total=total, completed=total, currentTitle=None, **stats)
    return {"attached": attached, "new_books": new_books, "stats": stats}
