"""Musaeum Python sidecar — JSON-RPC over stdio.

Requests arrive as newline-delimited JSON on stdin:
    {"id": "req-1", "method": "hydrate_metadata", "params": {...}}
Responses are written to stdout with the matching id. Messages without an id
are notifications (main process → renderer progress relays).

Long-running methods execute on a thread pool so concurrent requests from the
Electron main process don't serialize behind each other.
"""

import json
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor

from conversion.converter import convert_format
from extractors.calibre_db import read_calibre_db
from extractors.epub_metadata import extract_epub_metadata
from extractors.pdf_metadata import extract_pdf_metadata
from pipeline.cover import fetch_cover, previews_for
from pipeline.hydration import hydrate_metadata
from pipeline.migrate import migrate_library
from pipeline.topup import topup_pdfs

_stdout_lock = threading.Lock()


def send(message: dict) -> None:
    with _stdout_lock:
        sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def notify(method: str, params: dict) -> None:
    send({"method": method, "params": params})


METHODS = {
    "extract_epub_metadata": lambda p: extract_epub_metadata(p["file_path"]),
    "extract_pdf_metadata": lambda p: extract_pdf_metadata(p["file_path"]),
    "read_calibre_db": lambda p: read_calibre_db(p["calibre_path"]),
    "hydrate_metadata": lambda p: hydrate_metadata(
        book_id=p["book_id"],
        file_path=p["file_path"],
        book_dir=p["book_dir"],
        known=p.get("known") or {},
        source_preferences=p.get("source_preferences") or {},
        locked_fields=p.get("locked_fields") or [],
    ),
    "fetch_cover": lambda p: fetch_cover(
        book_dir=p["book_dir"], url=p.get("url"), source=p.get("source", "google_books")
    ),
    "cover_previews": lambda p: previews_for(p.get("urls") or []),
    "convert_format": lambda p: convert_format(
        input_path=p["input_path"],
        output_path=p["output_path"],
        ebook_convert_path=p["ebook_convert_path"],
    ),
    "migrate_library": lambda p: migrate_library(
        job_id=p["job_id"],
        calibre_path=p["calibre_path"],
        target_root=p["target_root"],
        hydrate=p.get("hydrate", False),
        notify=notify,
    ),
    "topup_pdfs": lambda p: topup_pdfs(
        job_id=p["job_id"],
        calibre_path=p["calibre_path"],
        target_root=p["target_root"],
        library_index=p.get("library_index") or [],
        notify=notify,
    ),
}


def handle_request(request: dict) -> None:
    req_id = request.get("id")
    method = request.get("method")
    try:
        fn = METHODS.get(method)
        if fn is None:
            raise ValueError(f"Unknown method: {method}")
        result = fn(request.get("params") or {})
        send({"id": req_id, "result": result, "error": None})
    except Exception as exc:  # noqa: BLE001 — errors cross the RPC boundary
        traceback.print_exc(file=sys.stderr)
        send({"id": req_id, "result": None, "error": {"message": str(exc)}})


def main() -> None:
    pool = ThreadPoolExecutor(max_workers=4)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            print(f"unparseable request: {line[:200]}", file=sys.stderr)
            continue
        pool.submit(handle_request, request)


if __name__ == "__main__":
    main()
