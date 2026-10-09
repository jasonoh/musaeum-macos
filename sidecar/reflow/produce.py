"""The production pass: a PDF → `{book}/derived/reflow.epub` plus its stamp.

`reflow_pdf` is what the sidecar's RPC calls (spec D7). Around the pass slice 1R
already had (`analyse` → `document_entries` → `write_epub`) it adds the four
things that turn a working spike into a cache on a share:

- **The stamp (D9).** `derived/reflow.json` records the source PDF's size and
  mtime and the converter's version. A pass is skipped only when a stamp and an
  artifact are both there and the stamp matches the file on disk — so a replaced
  PDF, a new sidecar version or a new helper re-runs the pass instead of serving
  a stale rendering.
- **Temp-write, verify, rename (D9).** The EPUB is written to
  `derived/reflow.epub.tmp`, read back, and only then renamed over the old one;
  the stamp is written the same way *after* it, because an artifact no stamp
  describes is not an artifact. A failure at any point removes the temp — its own
  and any earlier run's — and, if this run created `derived/`, the folder.
- **One pass per book (D7, AC6).** The sidecar runs requests on four threads, so
  two opens can ask for the same book at once; a per-artifact lock makes the
  second wait and then find the first one's stamp current.
- **D6's verdict is `analyse`'s.** A book whose verdict is not `ok` writes
  nothing and returns the one line the reader shows.

What it deliberately does not touch: `metadata.json` (read for the title, never
written), any format file, the database, or anything else outside
`{book}/derived/` (AC2). A torn pass is one line on stderr and a fallback (D9,
invariant 12) — never a raised error.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import zipfile
from typing import Callable, Optional

from .epub import GENERATOR, write_epub
from .layout import analyse
from .outline import document_entries
from .vision import HELPER_VERSION

# pypdf logs every damaged xref it walks — "Ignoring wrong pointing object
# 2334", "incorrect startxref pointer(2)" — through `logging`, and Python's
# lastResort handler prints WARNING and above to stderr, which is the app's log
# (AC10). Measured 2026-10-08: walking the library's books that hold a PDF wrote
# thousands of these lines, and the same read at ERROR is silent. AC10's own
# escape hatch is "or the noise is explicitly suppressed in the pipeline
# module", which is this line; the helper's stderr is separately discarded in
# `vision._stream_helper`.
logging.getLogger("pypdf").setLevel(logging.ERROR)

# 1 was the slice-1R spike. Bump this whenever a change in `reflow/` moves the
# artifact's bytes: the stamp re-checks it, which is how a new converter version
# re-runs a pass instead of serving the old rendering (D9).
CONVERTER_VERSION = 2
STAMP_VERSION = 1
DERIVED = "derived"
EPUB_NAME = "reflow.epub"
STAMP_NAME = "reflow.json"
TMP = ".tmp"

# What a pass measured about the book, shared by the stamp and the result.
# `page_map` is D5's map, not a count (`write_epub`'s report also carries
# `sections`, which is the count).
STAT_KEYS = (
    "pages",
    "text_pages",
    "toc_entries",
    "toc_from",
    "figures",
    "plates",
    "words",
    "bytes",
    "page_map",
    "layout_errors",
    "vision_regions",
)
Progress = Callable[[str, int, int], None]
Notifier = Callable[[str, dict], None]

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def artifact_paths(book_dir: str) -> tuple[str, str]:
    """Where a book's artifact and its stamp live (D3)."""
    derived = os.path.join(book_dir, DERIVED)
    return os.path.join(derived, EPUB_NAME), os.path.join(derived, STAMP_NAME)


def converter_version() -> dict:
    """What D9 re-checks: a new sidecar version or a new helper re-runs the pass."""
    return {"sidecar": CONVERTER_VERSION, "helper": HELPER_VERSION, "generator": GENERATOR}


def read_stamp(stamp_path: str) -> Optional[dict]:
    """The stamp as it was written, or `None` when it cannot be read (D9)."""
    try:
        with open(stamp_path, encoding="utf-8") as fh:
            stamp = json.load(fh)
    except (OSError, ValueError):
        return None
    return stamp if isinstance(stamp, dict) else None


def stamp_is_current(stamp: Optional[dict], stat: os.stat_result) -> bool:
    """Would a pass over *this* file write this stamp now?"""
    if not isinstance(stamp, dict) or stamp.get("version") != STAMP_VERSION:
        return False
    source = stamp.get("source") or {}
    return (
        source.get("size") == stat.st_size
        and source.get("mtime") == int(stat.st_mtime)
        and stamp.get("converter") == converter_version()
    )


def _lock_for(path: str) -> threading.Lock:
    """One lock per artifact, so two opens of one book run one pass (AC6).

    One entry per book reflowed in this process: bounded by the library, and
    small.
    """
    with _locks_guard:
        lock = _locks.get(path)
        if lock is None:
            lock = _locks[path] = threading.Lock()
        return lock


def _inside(book_dir: str, path: str) -> bool:
    """D3's `derived/` is the book's: never write it into a folder we do not own."""
    return os.path.realpath(path).startswith(os.path.realpath(book_dir) + os.sep)


def _title(book_dir: str, pdf_path: str) -> str:
    """The EPUB's title: the canonical record's, else the file's own stem."""
    try:
        with open(os.path.join(book_dir, "metadata.json"), encoding="utf-8") as fh:
            title = (json.load(fh) or {}).get("title")
    except (OSError, ValueError):
        title = None
    return str(title or "").strip() or os.path.splitext(os.path.basename(pdf_path))[0]


def _doc_stats(doc) -> dict:
    """What the pass measured before anything was written.

    A book that falls back (D6) still carries these, because they are the numbers
    its one line of reason is made of — `3 of 5 text pages could not be laid
    out` — and a reader that shows the reason with a zero next to it is worse
    than one that shows nothing. What only a written artifact can report (words,
    bytes, the page map, the TOC's entry count) stays empty on a fallback.
    """
    return {
        "pages": len(doc.pages),
        "text_pages": len(doc.text_pages),
        "figures": doc.figures_detected,
        "plates": doc.plates,
        "layout_errors": doc.layout_errors,
        "vision_regions": doc.vision_regions,
    }


def _stats(doc, report: dict) -> dict:
    return {
        "pages": len(doc.pages),
        "text_pages": len(doc.text_pages),
        "toc_entries": report["toc_entries"],
        "toc_from": "outline" if doc.entries_from_outline else "headings",
        "figures": doc.figures_detected,
        "plates": doc.plates,
        "words": report["words"],
        "bytes": report["bytes"],
        "page_map": report["page_map"],
        "layout_errors": doc.layout_errors,
        "vision_regions": doc.vision_regions,
    }


def _write_stamp(path: str, stamp: dict) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(stamp, fh, ensure_ascii=False, indent=1)


def _verify_epub(path: str) -> None:
    """The temp file is an EPUB this app can read, before it replaces a good one.

    `ZipFile` reads the central directory at the end of the file and the mimetype
    at its start, so a torn write — the failure a temp name exists to catch —
    fails here. `testzip()` would read every byte of a 56 MB artifact back over
    the share; the head and the tail are what a torn write loses.
    """
    with zipfile.ZipFile(path) as zf:
        if zf.read("mimetype") != b"application/epub+zip":
            raise ValueError("the written file is not an EPUB")
        missing = [
            name
            for name in ("META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml")
            if name not in zf.namelist()
        ]
    if missing:
        raise ValueError(f"the written EPUB has no {missing[0]}")


def _remove(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def reflow_pdf(
    book_dir: str,
    pdf_path: str,
    *,
    book_id: str = "",
    force: bool = False,
    notify: Optional[Notifier] = None,
) -> dict:
    """Produce — or re-use — one book's reflowed EPUB. Never raises (D6, D9).

    `status` is `produced`, `cached` or `fallback`; a fallback wrote nothing and
    carries D6's one line of reason. `notify(method, params)` receives
    `reflow_progress` frames while the pass runs: `phase` is `start`, `layout`,
    `reading`, `writing`, `done`, `cached` or `fallback`, and the two page phases
    carry `completed` of `total`.
    """
    started = time.perf_counter()
    result: dict = {
        "book_id": book_id,
        "status": "fallback",
        "reason": "",
        "verdict": "",
        "epub": "",
        "stamp_file": "",
        "converter": converter_version(),
        "seconds": 0.0,
        "pages": 0,
        "text_pages": 0,
        "toc_entries": 0,
        "toc_from": "",
        "figures": 0,
        "plates": 0,
        "words": 0,
        "bytes": 0,
        "page_map": [],
        "layout_errors": 0,
        "vision_regions": 0,
    }

    def progress(phase: str, done: int = 0, total: int = 0, **extra) -> None:
        if notify is not None:
            notify(
                "reflow_progress",
                {"book_id": book_id, "phase": phase, "completed": done, "total": total, **extra},
            )

    def finish(status: str = "") -> dict:
        if status:
            result["status"] = status
        result["seconds"] = round(time.perf_counter() - started, 1)
        return result

    def fallback(reason: str, verdict: str = "", **extra) -> dict:
        result["reason"] = reason
        result["verdict"] = verdict or result["verdict"]
        progress("fallback", reason=reason, verdict=result["verdict"], **extra)
        return finish("fallback")

    if not os.path.isdir(book_dir):
        return fallback("the book folder is not there")
    if not os.path.isfile(pdf_path) or not _inside(book_dir, pdf_path):
        return fallback("the book folder holds no PDF at that path")
    try:
        stat = os.stat(pdf_path)
    except OSError as err:
        return fallback(f"the PDF cannot be read ({type(err).__name__})")

    epub_path, stamp_path = artifact_paths(book_dir)
    with _lock_for(epub_path):
        if not force and os.path.exists(epub_path):
            stamp = read_stamp(stamp_path)
            if stamp_is_current(stamp, stat):
                result.update({key: stamp.get(key, result[key]) for key in STAT_KEYS})
                result["epub"] = os.path.relpath(epub_path, book_dir)
                result["stamp_file"] = os.path.relpath(stamp_path, book_dir)
                progress("cached", pages=result["pages"], bytes=result["bytes"])
                return finish("cached")

        # An earlier run that died mid-write, cleaned before this one starts, so
        # the folder's contents always mean "the last pass that finished".
        _remove(epub_path + TMP)
        _remove(stamp_path + TMP)
        derived = os.path.dirname(epub_path)
        made_dir = not os.path.isdir(derived)
        placed = False
        placed_stamp = False
        try:
            progress("start")
            doc = analyse(pdf_path, progress=progress)
            doc.entries = document_entries(pdf_path, doc)
            result["verdict"] = doc.verdict
            result.update(_doc_stats(doc))
            if doc.verdict != "ok":
                return fallback(doc.reason or "this book cannot be laid out")

            os.makedirs(derived, exist_ok=True)
            progress("writing")
            report = write_epub(doc, epub_path + TMP, _title(book_dir, pdf_path))
            _verify_epub(epub_path + TMP)
            os.replace(epub_path + TMP, epub_path)
            placed = True
            stats = _stats(doc, report)
            _write_stamp(
                stamp_path + TMP,
                {
                    "version": STAMP_VERSION,
                    "converter": converter_version(),
                    "source": {
                        "name": os.path.basename(pdf_path),
                        "size": stat.st_size,
                        "mtime": int(stat.st_mtime),
                    },
                    **stats,
                },
            )
            os.replace(stamp_path + TMP, stamp_path)
            placed_stamp = True
            result.update(stats)
            result["epub"] = os.path.relpath(epub_path, book_dir)
            result["stamp_file"] = os.path.relpath(stamp_path, book_dir)
            progress("done", pages=result["pages"], bytes=result["bytes"], toc_entries=result["toc_entries"])
            return finish("produced")
        except Exception as err:  # noqa: BLE001 — a torn pass is a fallback, not a traceback
            print(f"reflow: {pdf_path}: {type(err).__name__}: {err}", file=sys.stderr, flush=True)
            return fallback(f"the reflow could not be written ({type(err).__name__})", verdict="write_failed")
        finally:
            _remove(epub_path + TMP)
            _remove(stamp_path + TMP)
            if placed and not placed_stamp:
                # An artifact no stamp describes is not an artifact: the next open
                # would re-run anyway, and D6 says a book that could not be
                # produced keeps the original path with nothing behind it.
                _remove(epub_path)
            if made_dir:
                try:
                    os.rmdir(derived)
                except OSError:
                    pass  # something is in it, so it is not this run's residue
