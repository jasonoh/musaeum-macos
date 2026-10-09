"""The production pass, and the rules it rests on.

`produce.reflow_pdf` is the seam slice 3 calls, so what is pinned here is the
artifact (byte-stable across two runs, never half-written, never written at all
for a book the confidence gate refuses), the stamp D9 re-checks, and the
progress D7 shows. The artifact's determinism lives here too: it is a rule of
`write_epub` that no other test file owns, and it is the same bar Task 4
measures over the corpus.
"""

from __future__ import annotations

import time
import zipfile

from reflow.epub import write_epub
from reflow.model import Block, Document, PageResult
from reflow.outline import Entry


def _source(tmp_path):
    """A file for the artifact to be stamped from — the writer only stats it."""
    source = tmp_path / "A Book.pdf"
    source.write_bytes(b"%PDF-1.4\n% a stand-in for the book's own file\n")
    return source


def _doc(tmp_path, pages: int = 5) -> Document:
    doc = Document(source=str(_source(tmp_path)))
    for i in range(pages):
        doc.pages.append(
            PageResult(
                index=i,
                chars=500,
                top=792.0,
                bottom=0.0,
                blocks=[
                    Block("heading", text=f"Chapter {i + 1}", level=1, page=i, top=700.0),
                    Block("para", text="Body text on this page, and enough of it to read.", page=i, top=600.0),
                ],
            )
        )
    return doc


def test_every_zip_entry_carries_a_fixed_date(tmp_path):
    """Measured 2026-10-08: a str-named entry took the run's own second, so two
    runs a second apart differed and slice 2's byte-stability bar could not be
    met."""
    out = tmp_path / "one.epub"
    write_epub(_doc(tmp_path), str(out), "A Book")
    with zipfile.ZipFile(out) as zf:
        assert {info.date_time for info in zf.infolist()} == {(1980, 1, 1, 0, 0, 0)}


def test_two_runs_over_one_source_are_byte_identical(tmp_path):
    """The sleep crosses the second the removed clock had as its resolution."""
    doc = _doc(tmp_path)
    first, second = tmp_path / "one.epub", tmp_path / "two.epub"
    write_epub(doc, str(first), "A Book")
    time.sleep(1.1)
    write_epub(doc, str(second), "A Book")
    assert first.read_bytes() == second.read_bytes()


def test_the_report_maps_every_page_to_the_file_that_holds_it(tmp_path):
    """D5: a position in the reflow can name the PDF page it came from without
    re-extracting anything. Two depth-0 entries split the book into two files."""
    doc = _doc(tmp_path, pages=5)
    doc.entries = [Entry("Chapter 1", 0, 0), Entry("Chapter 3", 0, 2)]
    report = write_epub(doc, str(tmp_path / "m.epub"), "A Book")
    assert report["sections"] == 2
    assert report["page_map"] == [
        {"href": "text/c001.xhtml", "title": "Chapter 1", "from_page": 1, "to_page": 2},
        {"href": "text/c002.xhtml", "title": "Chapter 3", "from_page": 3, "to_page": 5},
    ]
    assert max(entry["to_page"] for entry in report["page_map"]) == len(doc.pages)
