import json
import os

import pytest
from pypdf import PdfWriter

from pipeline.topup import _build_matcher, _normalize, topup_pdfs


def make_pdf(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    with open(path, "wb") as fh:
        writer.write(fh)


def make_calibre_library(tmp_path, records):
    """Build a fake Calibre dir tree; returns its root. records: list of
    dicts with keys path (author/title dir) and files (names to create)."""
    root = tmp_path / "calibre"
    for rec in records:
        for fname in rec["files"]:
            fpath = root / rec["path"] / fname
            if fname.endswith(".pdf"):
                make_pdf(str(fpath))
            else:
                os.makedirs(os.path.dirname(str(fpath)), exist_ok=True)
                fpath.write_bytes(b"placeholder")
    return str(root)


def test_normalize_matches_db_ts_semantics():
    assert _normalize("The Pragmatic Programmer!") == "the pragmatic programmer"
    assert _normalize("  Café,   Crème ") == "café crème"


def test_matcher_precedence_goodreads_then_isbn_then_title_author():
    index = [
        {"id": "a", "goodreads": "111", "isbn_13": None, "title": "X", "author": "Y", "nas_path": "books/a"},
        {"id": "b", "goodreads": None, "isbn_13": "9780000000002", "title": "X", "author": "Y", "nas_path": "books/b"},
        {"id": "c", "goodreads": None, "isbn_13": None, "title": "Deep Work", "author": "Cal Newport", "nas_path": "books/c"},
    ]
    match = _build_matcher(index)
    assert match({"identifiers": {"goodreads": "111"}, "title": "?", "author": "?"})["id"] == "a"
    assert match({"identifiers": {"isbn_13": "9780000000002"}, "title": "?", "author": "?"})["id"] == "b"
    assert match({"identifiers": {}, "title": "DEEP WORK.", "author": "Cal Newport"})["id"] == "c"
    assert match({"identifiers": {}, "title": "Unknown", "author": "Nobody"}) is None


@pytest.fixture
def calibre_and_target(tmp_path, monkeypatch):
    calibre_root = make_calibre_library(
        tmp_path,
        [
            {"path": "Cal Newport/Deep Work (1)", "files": ["Deep Work.pdf", "Deep Work.epub"]},
            {"path": "Anon/PDF Only Book (2)", "files": ["PDF Only Book.pdf"]},
            {"path": "Anon/Epub Only (3)", "files": ["Epub Only.epub"]},
        ],
    )
    # Stub read_calibre_db — the fake dir has no metadata.db
    records = [
        {"calibre_id": 1, "title": "Deep Work", "author": "Cal Newport",
         "path": "Cal Newport/Deep Work (1)", "identifiers": {}, "tags": [],
         "sort_title": None, "author_sort": None, "publisher": None,
         "published_date": None, "description": None, "language": None,
         "rating": None, "series": None},
        {"calibre_id": 2, "title": "PDF Only Book", "author": "Anon",
         "path": "Anon/PDF Only Book (2)", "identifiers": {}, "tags": [],
         "sort_title": None, "author_sort": None, "publisher": None,
         "published_date": None, "description": None, "language": None,
         "rating": None, "series": None},
        {"calibre_id": 3, "title": "Epub Only", "author": "Anon",
         "path": "Anon/Epub Only (3)", "identifiers": {}, "tags": [],
         "sort_title": None, "author_sort": None, "publisher": None,
         "published_date": None, "description": None, "language": None,
         "rating": None, "series": None},
    ]
    import pipeline.topup as topup_mod
    monkeypatch.setattr(topup_mod, "read_calibre_db", lambda p: {"books": records})

    target = tmp_path / "musaeum"
    # "Deep Work" already migrated with an epub
    existing_dir = target / "books" / "uuid-deep-work"
    os.makedirs(existing_dir)
    (existing_dir / "Deep Work.epub").write_bytes(b"placeholder")
    (existing_dir / "metadata.json").write_text(json.dumps({
        "id": "uuid-deep-work", "title": "Deep Work", "formats": ["epub"],
        "last_modified": "2026-07-14T00:00:00Z",
    }))
    index = [{"id": "uuid-deep-work", "goodreads": None, "isbn_13": None,
              "title": "Deep Work", "author": "Cal Newport",
              "nas_path": "books/uuid-deep-work"}]
    return calibre_root, str(target), index


def test_topup_attaches_and_adds(calibre_and_target):
    calibre_root, target, index = calibre_and_target
    notifications = []
    result = topup_pdfs(
        job_id="j1", calibre_path=calibre_root, target_root=target,
        library_index=index, notify=lambda m, p: notifications.append((m, p)),
    )

    # Attached to the existing Deep Work folder
    assert result["stats"] == {"attached": 1, "added": 1, "skipped": 0}
    attached_dir = os.path.join(target, "books", "uuid-deep-work")
    assert any(f.endswith(".pdf") for f in os.listdir(attached_dir))
    meta = json.loads(open(os.path.join(attached_dir, "metadata.json")).read())
    assert "pdf" in meta["formats"]

    # PDF-only book imported as new (epub-only book untouched)
    assert len(result["new_books"]) == 1
    assert result["new_books"][0]["title"] == "PDF Only Book"
    assert result["new_books"][0]["formats"] == ["pdf"]
    assert any(m == "migration_progress" for m, _ in notifications)


def test_topup_is_idempotent(calibre_and_target):
    calibre_root, target, index = calibre_and_target
    first = topup_pdfs(job_id="j1", calibre_path=calibre_root,
                       target_root=target, library_index=index,
                       notify=lambda m, p: None)
    # Second run: the attach target already has a PDF → skipped; the new book
    # from run 1 is not in library_index, so guard via title+author too
    index2 = index + [
        {"id": b["id"], "goodreads": None, "isbn_13": None, "title": b["title"],
         "author": b.get("author"), "nas_path": f"books/{b['id']}"}
        for b in first["new_books"]
    ]
    second = topup_pdfs(job_id="j2", calibre_path=calibre_root,
                        target_root=target, library_index=index2,
                        notify=lambda m, p: None)
    assert second["stats"]["added"] == 0
    assert second["stats"]["attached"] == 0
    assert second["stats"]["skipped"] == 2
