import io

import pytest
from PIL import Image
from pypdf import PdfWriter

from extractors.pdf_metadata import extract_pdf_metadata, render_pdf_cover


@pytest.fixture
def pdf_with_metadata(tmp_path):
    path = tmp_path / "sample.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_metadata({"/Title": "Practical SQL", "/Author": "Anthony DeBarros"})
    with open(path, "wb") as fh:
        writer.write(fh)
    return str(path)


@pytest.fixture
def pdf_without_metadata(tmp_path):
    path = tmp_path / "1982_scan_final_v2.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    with open(path, "wb") as fh:
        writer.write(fh)
    return str(path)


def test_extracts_embedded_title_and_author(pdf_with_metadata):
    result = extract_pdf_metadata(pdf_with_metadata)
    assert result["title"] == "Practical SQL"
    assert result["authors"] == [{"name": "Anthony DeBarros", "sort": None}]
    assert result["identifiers"] == {}


def test_missing_metadata_returns_none_title(pdf_without_metadata):
    result = extract_pdf_metadata(pdf_without_metadata)
    assert result["title"] is None
    assert result["authors"] == []


def test_corrupt_file_raises(tmp_path):
    bad = tmp_path / "not_a.pdf"
    bad.write_bytes(b"this is not a pdf")
    with pytest.raises(Exception):
        extract_pdf_metadata(str(bad))


def test_render_cover_returns_decodable_jpeg(pdf_with_metadata):
    data = render_pdf_cover(pdf_with_metadata)
    assert data is not None
    img = Image.open(io.BytesIO(data))
    assert img.format == "JPEG"
    assert img.width >= 400


def test_render_cover_returns_none_for_corrupt_file(tmp_path):
    bad = tmp_path / "not_a.pdf"
    bad.write_bytes(b"junk")
    assert render_pdf_cover(str(bad)) is None


def test_render_cover_logs_failure_for_corrupt_file(tmp_path, capsys):
    bad = tmp_path / "not_a.pdf"
    bad.write_bytes(b"junk")
    result = render_pdf_cover(str(bad))
    assert result is None
    err = capsys.readouterr().err
    assert "pdf_metadata" in err
    assert str(bad) in err
