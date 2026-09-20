"""The EPUB extractor, against EPUBs assembled in-code.

An EPUB is a zip: an uncompressed `mimetype` entry, `META-INF/container.xml`
naming the OPF package document, and the OPF itself. Every fixture here is
built from those three parts by `_epub()`, so a case can break exactly one of
them and nothing else — which is why there are no binary fixtures in the repo.

The invariant under test is the one in
`docs/invariants/metadata-hydration.md`: a failed extraction must leave the
book with the metadata it already had. In the shipped code that is a two-layer
contract — the extractor itself raises on a broken container or OPF (the same
convention `test_pdf_metadata.py::test_corrupt_file_raises` pins for PDFs),
and `hydrate_metadata` is the layer that swallows it — so both layers get a
case here. `extract_embedded_cover` is the exception: it swallows internally
and returns `None`.
"""

import os
import zipfile

import pytest

import pipeline.hydration as hydration
from extractors.epub_metadata import extract_embedded_cover, extract_epub_metadata

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def _package(metadata: str = "", manifest: str = "") -> str:
    """An OPF package document wrapping the given metadata/manifest bodies."""
    return f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"
            xmlns:opf="http://www.idpf.org/2007/opf">
{metadata}
  </metadata>
  <manifest>
{manifest}
  </manifest>
</package>
"""


def _epub(tmp_path, name="book.epub", *, opf=None, container=CONTAINER, extra=None) -> str:
    """Write a minimal EPUB. `opf=None` omits the package document entirely."""
    path = tmp_path / name
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        # The spec requires mimetype first and stored, and real readers check
        z.writestr(
            zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED
        )
        if container is not None:
            z.writestr("META-INF/container.xml", container)
        if opf is not None:
            z.writestr("OEBPS/content.opf", opf)
        for arcname, data in (extra or {}).items():
            z.writestr(arcname, data)
    return str(path)


# --- a normal EPUB ---------------------------------------------------------

FULL_METADATA = """
    <dc:title>The Hobbit</dc:title>
    <dc:creator opf:role="aut" opf:file-as="Tolkien, J. R. R.">J. R. R. Tolkien</dc:creator>
    <dc:identifier id="bookid" opf:scheme="ISBN">9780547928227</dc:identifier>
    <dc:publisher>Houghton Mifflin Harcourt</dc:publisher>
    <dc:date>2012-09-18T00:00:00+00:00</dc:date>
    <dc:language>en</dc:language>
    <dc:description>&lt;p&gt;A hobbit&lt;/p&gt; leaves home.</dc:description>
    <dc:subject>Fantasy</dc:subject>
    <dc:subject>Classics</dc:subject>
"""


@pytest.fixture
def hobbit(tmp_path):
    return _epub(tmp_path, opf=_package(FULL_METADATA))


def test_reads_title_author_and_isbn(hobbit):
    result = extract_epub_metadata(hobbit)

    assert result["title"] == "The Hobbit"
    assert result["authors"] == [
        {"name": "J. R. R. Tolkien", "sort": "Tolkien, J. R. R."}
    ]
    assert result["identifiers"] == {"isbn_13": "9780547928227"}


def test_reads_publisher_language_and_tags(hobbit):
    result = extract_epub_metadata(hobbit)

    assert result["publisher"] == "Houghton Mifflin Harcourt"
    assert result["language"] == "en"
    assert result["tags"] == ["Fantasy", "Classics"]


def test_date_is_trimmed_to_the_day(hobbit):
    # published_date is a date in metadata.json, not a timestamp
    assert extract_epub_metadata(hobbit)["published_date"] == "2012-09-18"


def test_description_html_is_stripped(hobbit):
    # OPF descriptions are routinely HTML fragments; the tags must not reach
    # the book record. The `</p>` is a paragraph boundary rather than inline
    # markup, so it survives as the newline the panel renders as a break —
    # dropping it instead welds two paragraphs onto one line (measured on the
    # real library: "…for a new generation of women.It started with the Sh*t
    # I Do List."), which is what `extractors/html_text.py` exists to prevent.
    assert extract_epub_metadata(hobbit)["description"] == "A hobbit\nleaves home."


def test_description_entities_are_decoded(tmp_path):
    # A blurb that arrived double-escaped, with an em dash as a numeric entity
    # and a real markup break: neither may reach the panel as written
    path = _epub(
        tmp_path,
        opf=_package(
            '<dc:description>A hands-on guide&#8212;finally&lt;br&gt;'
            "A second line</dc:description>"
        ),
    )
    assert extract_epub_metadata(path)["description"] == (
        "A hands-on guide—finally\nA second line"
    )


def test_an_isbn10_identifier_is_converted_to_isbn13(tmp_path):
    # Normalized so an old ISBN-10 file and a fetched ISBN-13 are one book
    path = _epub(
        tmp_path,
        opf=_package(
            '<dc:identifier id="bookid" opf:scheme="ISBN">0-547-92822-X</dc:identifier>'
        ),
    )

    assert extract_epub_metadata(path)["identifiers"] == {"isbn_13": "9780547928227"}


def test_a_urn_isbn_identifier_is_recognized_without_a_scheme(tmp_path):
    path = _epub(
        tmp_path,
        opf=_package(
            '<dc:identifier id="bookid">urn:isbn:9780547928227</dc:identifier>'
        ),
    )

    assert extract_epub_metadata(path)["identifiers"] == {"isbn_13": "9780547928227"}


def test_a_uuid_identifier_is_not_mistaken_for_an_isbn(tmp_path):
    path = _epub(
        tmp_path,
        opf=_package(
            '<dc:identifier id="bookid">urn:uuid:9f1a2b3c-0000-4000-8000-000000000000</dc:identifier>'
        ),
    )

    assert extract_epub_metadata(path)["identifiers"] == {}


def test_goodreads_and_openlibrary_schemes_are_kept(tmp_path):
    path = _epub(
        tmp_path,
        opf=_package(
            '<dc:identifier opf:scheme="goodreads">5907</dc:identifier>'
            '<dc:identifier opf:scheme="OLID">OL7353617M</dc:identifier>'
        ),
    )

    assert extract_epub_metadata(path)["identifiers"] == {
        "goodreads": "5907",
        "openlibrary": "OL7353617M",
    }


def test_non_author_creators_are_skipped(tmp_path):
    path = _epub(
        tmp_path,
        opf=_package(
            '<dc:creator opf:role="aut">Susanna Clarke</dc:creator>'
            '<dc:creator opf:role="ill">Portia Rosenberg</dc:creator>'
        ),
    )

    assert extract_epub_metadata(path)["authors"] == [
        {"name": "Susanna Clarke", "sort": None}
    ]


# --- an EPUB with no metadata at all --------------------------------------


def test_an_opf_without_a_metadata_element_extracts_to_nothing(tmp_path):
    path = _epub(
        tmp_path,
        opf='<?xml version="1.0"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><manifest/></package>',
    )

    # Empty, not partially-filled: hydration treats a falsy record as "no
    # embedded source" and leaves the book with what it had
    assert extract_epub_metadata(path) == {}


def test_an_empty_metadata_element_yields_blank_fields_not_an_error(tmp_path):
    result = extract_epub_metadata(_epub(tmp_path, opf=_package()))

    assert result["title"] is None
    assert result["authors"] == []
    assert result["identifiers"] == {}
    assert result["tags"] == []
    assert result["description"] is None
    assert result["published_date"] is None


def test_a_titleless_creatorless_book_still_reports_the_fields_it_has(tmp_path):
    path = _epub(tmp_path, opf=_package("<dc:language>en</dc:language>"))
    result = extract_epub_metadata(path)

    assert result["title"] is None
    assert result["language"] == "en"


# --- a missing or malformed OPF -------------------------------------------


def test_a_malformed_opf_raises_rather_than_returning_half_a_book(tmp_path):
    path = _epub(tmp_path, opf="<package><metadata><dc:title>Trunc")

    with pytest.raises(Exception):
        extract_epub_metadata(path)


def test_an_opf_the_container_points_at_but_the_zip_lacks_raises(tmp_path):
    path = _epub(tmp_path, opf=None)

    with pytest.raises(KeyError):
        extract_epub_metadata(path)


def test_a_missing_container_raises(tmp_path):
    path = _epub(tmp_path, opf=_package(FULL_METADATA), container=None)

    with pytest.raises(KeyError):
        extract_epub_metadata(path)


def test_a_container_with_no_rootfile_declaration_raises_valueerror(tmp_path):
    empty_container = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles/>
</container>
"""
    path = _epub(tmp_path, opf=_package(FULL_METADATA), container=empty_container)

    with pytest.raises(ValueError):
        extract_epub_metadata(path)


def test_a_file_that_is_not_a_zip_raises(tmp_path):
    bad = tmp_path / "not_an.epub"
    bad.write_bytes(b"this is not an epub")

    with pytest.raises(zipfile.BadZipFile):
        extract_epub_metadata(str(bad))


# --- the invariant, at the layer that carries it --------------------------


def test_hydration_keeps_going_when_the_epub_cannot_be_read(tmp_path, monkeypatch):
    """A broken EPUB must not fail the hydration — it just contributes no
    embedded source (docs/invariants/metadata-hydration.md)."""
    monkeypatch.setattr(hydration, "fetch_google_books", lambda *a: None)
    monkeypatch.setattr(hydration, "fetch_openlibrary", lambda *a: None)
    monkeypatch.setattr(hydration, "fetch_series", lambda *a: None)

    broken = _epub(tmp_path, name="broken.epub", opf="<package><metadata>trunc")
    book_dir = str(tmp_path / "out")
    os.makedirs(book_dir)

    result = hydration.hydrate_metadata(
        book_id="test-id",
        file_path=broken,
        book_dir=book_dir,
        known={"title": "What The Book Already Had"},
        source_preferences={},
    )

    # No exception, and the caller's existing title is untouched
    assert result["conflicts"] == []
    assert result["metadata"].get("title") is None


# --- the embedded cover ---------------------------------------------------


def test_the_cover_declared_by_a_meta_element_is_read_from_the_zip(tmp_path):
    path = _epub(
        tmp_path,
        opf=_package(
            '<meta name="cover" content="cover-img"/>',
            '<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>',
        ),
        extra={"OEBPS/images/cover.jpg": b"\xff\xd8jpeg-bytes"},
    )

    assert extract_embedded_cover(path) == b"\xff\xd8jpeg-bytes"


def test_an_epub3_cover_image_property_is_read_without_a_meta_element(tmp_path):
    path = _epub(
        tmp_path,
        opf=_package(
            "",
            '<item id="c" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>',
        ),
        extra={"OEBPS/cover.jpg": b"\xff\xd8epub3"},
    )

    assert extract_embedded_cover(path) == b"\xff\xd8epub3"


def test_a_manifest_with_no_cover_entry_returns_none(tmp_path):
    # The manifest is not empty — it just declares nothing as the cover, so
    # the first image in the book must not be promoted to one
    path = _epub(
        tmp_path,
        opf=_package(
            FULL_METADATA,
            '<item id="fig1" href="images/figure1.jpg" media-type="image/jpeg"/>'
            '<item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>',
        ),
        extra={"OEBPS/images/figure1.jpg": b"\xff\xd8not-a-cover"},
    )

    assert extract_embedded_cover(path) is None


def test_a_malformed_opf_yields_no_cover_rather_than_raising(tmp_path):
    # Unlike the metadata path, the cover reader swallows and returns None
    path = _epub(tmp_path, opf="<package><manifest>trunc")

    assert extract_embedded_cover(path) is None
