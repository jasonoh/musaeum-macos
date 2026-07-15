import os

import pytest
from pypdf import PdfWriter

import pipeline.hydration as hydration


@pytest.fixture
def pdf_book(tmp_path):
    path = tmp_path / "book.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_metadata({"/Title": "Deep Work", "/Author": "Cal Newport"})
    with open(path, "wb") as fh:
        writer.write(fh)
    return str(path)


def test_hydrate_pdf_uses_embedded_metadata_and_renders_cover(
    pdf_book, tmp_path, monkeypatch
):
    # Offline: neutralize the network fetchers
    monkeypatch.setattr(hydration, "fetch_google_books", lambda *a: None)
    monkeypatch.setattr(hydration, "fetch_openlibrary", lambda *a: None)
    monkeypatch.setattr(hydration, "fetch_series", lambda *a: None)

    book_dir = str(tmp_path / "out")
    os.makedirs(book_dir)
    result = hydration.hydrate_metadata(
        book_id="test-id",
        file_path=pdf_book,
        book_dir=book_dir,
        known={},
        source_preferences={},
    )

    assert result["metadata"]["title"] == "Deep Work"
    assert result["cover"]["full"] == "cover_full.jpg"
    assert result["cover"]["thumb"] == "cover_thumb.jpg"
    assert os.path.exists(os.path.join(book_dir, "cover_thumb.jpg"))
