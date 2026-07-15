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
    assert result["stats"] == {"attached": 1, "added": 1, "skipped": 0, "errors": 0}
    attached_dir = os.path.join(target, "books", "uuid-deep-work")
    assert any(f.endswith(".pdf") for f in os.listdir(attached_dir))
    meta = json.loads(open(os.path.join(attached_dir, "metadata.json")).read())
    assert "pdf" in meta["formats"]

    # PDF-only book imported as new (epub-only book untouched)
    assert len(result["new_books"]) == 1
    assert result["new_books"][0]["title"] == "PDF Only Book"
    assert result["new_books"][0]["formats"] == ["pdf"]
    assert any(m == "migration_progress" for m, _ in notifications)


def _ambiguous_setup(tmp_path, monkeypatch, record_author):
    """Two library entries share the normalized title 'Collected Stories';
    one Calibre record with that title (author per record_author) has a PDF."""
    calibre_root = make_calibre_library(
        tmp_path,
        [{"path": "Unknown/Collected Stories (9)", "files": ["Collected Stories.pdf"]}],
    )
    records = [
        {"calibre_id": 9, "title": "Collected Stories", "author": record_author,
         "path": "Unknown/Collected Stories (9)", "identifiers": {}, "tags": [],
         "sort_title": None, "author_sort": None, "publisher": None,
         "published_date": None, "description": None, "language": None,
         "rating": None, "series": None},
    ]
    import pipeline.topup as topup_mod
    monkeypatch.setattr(topup_mod, "read_calibre_db", lambda p: {"books": records})

    target = tmp_path / "musaeum"
    index = []
    for uid, author in (("uuid-cs-1", "Author One"), ("uuid-cs-2", "Author Two")):
        book_dir = target / "books" / uid
        os.makedirs(book_dir)
        (book_dir / "metadata.json").write_text(json.dumps({
            "id": uid, "title": "Collected Stories", "formats": ["epub"],
        }))
        index.append({"id": uid, "goodreads": None, "isbn_13": None,
                      "title": "Collected Stories", "author": author,
                      "nas_path": f"books/{uid}"})
    return calibre_root, str(target), index


def test_topup_ambiguous_title_without_author_is_skipped(tmp_path, monkeypatch):
    calibre_root, target, index = _ambiguous_setup(tmp_path, monkeypatch, None)
    result = topup_pdfs(job_id="j-amb", calibre_path=calibre_root,
                        target_root=target, library_index=index,
                        notify=lambda m, p: None)
    assert result["stats"] == {"attached": 0, "added": 0, "skipped": 1, "errors": 0}
    assert result["attached"] == []
    assert result["new_books"] == []
    for uid in ("uuid-cs-1", "uuid-cs-2"):
        folder = os.path.join(target, "books", uid)
        assert not any(f.endswith(".pdf") for f in os.listdir(folder))


def test_topup_title_author_disambiguates_shared_title(tmp_path, monkeypatch):
    calibre_root, target, index = _ambiguous_setup(tmp_path, monkeypatch, "Author Two")
    result = topup_pdfs(job_id="j-dis", calibre_path=calibre_root,
                        target_root=target, library_index=index,
                        notify=lambda m, p: None)
    assert result["stats"] == {"attached": 1, "added": 0, "skipped": 0, "errors": 0}
    assert result["attached"][0]["book_id"] == "uuid-cs-2"
    dir_two = os.path.join(target, "books", "uuid-cs-2")
    assert any(f.endswith(".pdf") for f in os.listdir(dir_two))
    dir_one = os.path.join(target, "books", "uuid-cs-1")
    assert not any(f.endswith(".pdf") for f in os.listdir(dir_one))


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
    assert second["stats"]["errors"] == 0
    # Both targets already had a PDF on disk — reported distinctly so the
    # caller can self-heal SQLite's `formats` after a crash-interrupted run.
    assert {p["book_id"] for p in second["already_present"]} == {
        "uuid-deep-work",
        first["new_books"][0]["id"],
    }


def test_attach_corrupt_metadata_json_is_counted_as_error_and_file_is_untouched(calibre_and_target):
    """A transient/corrupt metadata.json read must never be papered over with
    a blank {} rewrite — that would destroy the canonical title/authors/
    identifiers/series/cover/read_status. It must surface as an error and
    leave the file exactly as it was, so a re-run can retry."""
    calibre_root, target, index = calibre_and_target
    meta_path = os.path.join(target, "books", "uuid-deep-work", "metadata.json")
    corrupt_content = "{not valid json at all"
    with open(meta_path, "w", encoding="utf-8") as fh:
        fh.write(corrupt_content)

    result = topup_pdfs(job_id="j-corrupt", calibre_path=calibre_root,
                        target_root=target, library_index=index,
                        notify=lambda m, p: None)

    assert result["stats"]["errors"] == 1
    assert result["stats"]["attached"] == 0
    assert result["attached"] == []

    with open(meta_path, encoding="utf-8") as fh:
        assert fh.read() == corrupt_content

    book_dir = os.path.join(target, "books", "uuid-deep-work")
    assert not any(f.lower().endswith(".pdf") for f in os.listdir(book_dir))


def test_duplicate_isbn_across_library_entries_is_ambiguous_and_skipped(tmp_path, monkeypatch):
    calibre_root = make_calibre_library(
        tmp_path,
        [{"path": "Unknown/Some Book (5)", "files": ["Some Book.pdf"]}],
    )
    records = [
        {"calibre_id": 5, "title": "Some Book", "author": "Someone",
         "path": "Unknown/Some Book (5)", "identifiers": {"isbn_13": "9781111111111"},
         "tags": [], "sort_title": None, "author_sort": None, "publisher": None,
         "published_date": None, "description": None, "language": None,
         "rating": None, "series": None},
    ]
    import pipeline.topup as topup_mod
    monkeypatch.setattr(topup_mod, "read_calibre_db", lambda p: {"books": records})

    target = tmp_path / "musaeum"
    index = []
    for uid in ("uuid-x", "uuid-y"):
        book_dir = target / "books" / uid
        os.makedirs(book_dir)
        (book_dir / "metadata.json").write_text(json.dumps({
            "id": uid, "title": f"Different Title {uid}", "formats": ["epub"],
        }))
        # Both entries share an ISBN-13 (a bad data situation, but one the
        # matcher must not guess through) despite differing titles/authors.
        index.append({"id": uid, "goodreads": None, "isbn_13": "9781111111111",
                      "title": f"Different Title {uid}", "author": "Nobody",
                      "nas_path": f"books/{uid}"})

    result = topup_pdfs(job_id="j-dupisbn", calibre_path=calibre_root,
                        target_root=str(target), library_index=index,
                        notify=lambda m, p: None)

    assert result["stats"] == {"attached": 0, "added": 0, "skipped": 1, "errors": 0}
    for uid in ("uuid-x", "uuid-y"):
        folder = os.path.join(str(target), "books", uid)
        assert not any(f.endswith(".pdf") for f in os.listdir(folder))
