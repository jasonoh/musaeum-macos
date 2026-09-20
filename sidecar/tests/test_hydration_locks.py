"""A field the user has set is not a field a fetch may move.

The main process records the user's decisions (an edit, a resolved conflict) and
passes them down as `locked_fields`. The sidecar's half of the rule is that such
a field is not even *proposed*: no candidate, therefore nothing merged and no
conflict queued — the main process filters the reply as well, but a lock that
still woke the user up for a field they had already decided would be the design's
D3 broken.

Three code paths build a field here, so three shapes of case: `candidates_for`
(the reviewed and quiet fields), the identifiers/tags union, and the cover, which
is a separate step that can spend a download.
"""

import os
import zipfile

import pipeline.hydration as hydration
from pipeline.conflict import merge_metadata

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""


def _book(title=None, author=None, **rest) -> dict:
    """A source record in the shape the fetchers hand to `merge_metadata`."""
    data = dict(rest)
    if title is not None:
        data["title"] = title
    if author is not None:
        data["authors"] = [{"name": author, "sort": None}]
    return data


def _epub(tmp_path, identifier: str) -> str:
    path = tmp_path / "locked.epub"
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Embedded Title</dc:title>
    <dc:identifier id="bookid" opf:scheme="ISBN">{identifier}</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>
"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/c1.xhtml", "<html><body><p>x</p></body></html>")
    return str(path)


def _offline(monkeypatch) -> None:
    monkeypatch.setattr(hydration, "fetch_google_books", lambda *a, **k: None)
    monkeypatch.setattr(hydration, "fetch_openlibrary", lambda *a, **k: None)
    monkeypatch.setattr(hydration, "fetch_series", lambda *a, **k: None)


# --- the merge ------------------------------------------------------------


def test_a_locked_title_is_neither_merged_nor_queued():
    sources = {
        "google_books": _book(title="Fetched Title"),
        "embedded": _book(title="Embedded Title"),
    }

    merged, conflicts = merge_metadata(sources, {}, ["title"])

    assert "title" not in merged
    assert conflicts == []


def test_a_locked_author_queues_no_conflict():
    sources = {
        "google_books": _book(author="Ctprint"),
        "embedded": _book(author="Eve Rodsky"),
    }

    merged, conflicts = merge_metadata(sources, {}, ["author"])

    assert "author" not in merged
    assert conflicts == []


def test_a_locked_series_queues_no_conflict():
    sources = {
        "google_books": _book(series={"name": "A", "index": 1, "total": 2}),
        "embedded": _book(series={"name": "B", "index": 1}),
    }

    merged, conflicts = merge_metadata(sources, {}, ["series"])

    assert "series" not in merged
    assert conflicts == []


def test_the_fields_that_are_not_locked_still_merge():
    # The lock is per field, not per run
    sources = {"google_books": _book(title="Fetched Title", publisher="Penguin")}

    merged, _ = merge_metadata(sources, {}, ["publisher"])

    assert merged["title"] == "Fetched Title"
    assert "publisher" not in merged


def test_locked_identifiers_and_tags_are_not_unioned():
    # These two are built by the union loop rather than by `candidates_for`
    sources = {
        "google_books": {"identifiers": {"isbn_13": "9781707274123"}, "tags": ["space"]},
        "embedded": {"identifiers": {"isbn_10": "1707274126"}, "tags": ["opera"]},
    }

    merged, _ = merge_metadata(sources, {}, ["identifiers", "tags"])

    assert "identifiers" not in merged
    assert "tags" not in merged


# --- the hydration pipeline ----------------------------------------------


def test_a_locked_identifiers_field_beats_the_files_own_identifiers(tmp_path, monkeypatch):
    # The file's identifiers (and the known ones) are merged in *after* the
    # merge, which is why the lock has to be honoured here too
    path = _epub(tmp_path, "0306406152")
    _offline(monkeypatch)
    book_dir = str(tmp_path / "out")
    os.makedirs(book_dir)

    result = hydration.hydrate_metadata(
        book_id="locked",
        file_path=path,
        book_dir=book_dir,
        known={"identifiers": {"isbn_13": "9781707274123"}},
        source_preferences={},
        locked_fields=["identifiers"],
    )

    assert "identifiers" not in result["metadata"]


def test_a_locked_cover_is_not_even_selected(tmp_path, monkeypatch):
    # Selecting a cover downloads and resizes it, so a lock must decide this
    # before any candidate is gathered
    path = _epub(tmp_path, "0306406152")
    _offline(monkeypatch)
    selected: list = []
    monkeypatch.setattr(
        hydration,
        "select_cover",
        lambda *a, **k: (
            selected.append(1) or {"cover": None, "review": False, "candidates": []}
        ),
    )
    book_dir = str(tmp_path / "out")
    os.makedirs(book_dir)

    result = hydration.hydrate_metadata(
        book_id="locked",
        file_path=path,
        book_dir=book_dir,
        known={},
        source_preferences={},
        locked_fields=["cover"],
    )

    assert selected == []
    assert result["cover"] is None


def test_no_locks_means_nothing_changes(tmp_path, monkeypatch):
    # The default is the behaviour that existed before locks: omitted, empty and
    # `None` all mean "propose everything"
    path = _epub(tmp_path, "9781707274123")
    _offline(monkeypatch)
    book_dir = str(tmp_path / "out")
    os.makedirs(book_dir)

    result = hydration.hydrate_metadata(
        book_id="unlocked",
        file_path=path,
        book_dir=book_dir,
        known={},
        source_preferences={},
    )

    assert result["metadata"]["identifiers"]["isbn_13"] == "9781707274123"
