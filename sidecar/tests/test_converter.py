"""`convert_format`: the RPC contract the Calibre wrapper had, now backed by the in-house writer."""

import os

import pytest

import conversion.converter as converter
import main
from conversion.azw3.identity import read_identity
from conversion.converter import convert_format
from tests.azw3_kf8 import build_epub, xhtml
from tests.test_azw3_epub import ADOBE_ENCRYPTION, replace_member


@pytest.fixture
def epub(tmp_path):
    return build_epub(tmp_path / "Book.epub", chapters=[("c.xhtml", xhtml("<h1>One</h1><p>Hello.</p>"))])


def test_it_returns_the_old_contract_plus_warnings_and_the_file_reads_back(epub, tmp_path):
    out = str(tmp_path / "Book.azw3")
    result = convert_format(str(epub), out)
    assert result == {"output_path": out, "size_bytes": os.path.getsize(out), "warnings": []}
    identity = read_identity(open(out, "rb").read())
    assert (identity.title, identity.author, identity.cdetype) == ("Test Book", "Ann Author", "EBOK")


def test_a_calibre_path_from_an_older_caller_is_accepted_and_ignored(epub, tmp_path):
    out = str(tmp_path / "Book.azw3")
    assert convert_format(str(epub), out, "/no/such/ebook-convert")["output_path"] == out


def test_writer_warnings_come_back_with_the_result(tmp_path):
    path = build_epub(
        tmp_path / "w.epub",
        chapters=[("c.xhtml", xhtml("<p>x</p>"))],
        css={"s.css": "@font-face { src: url(f.ttf) }"},
    )
    replace_member(path, "OEBPS/c.xhtml", xhtml("<p>x</p>", head='<link rel="stylesheet" href="s.css"/>').encode())
    assert any("@font-face" in w for w in convert_format(str(path), str(tmp_path / "w.azw3"))["warnings"])


def test_a_missing_source_and_a_wrong_format_are_refused_before_anything_runs(epub, tmp_path):
    with pytest.raises(FileNotFoundError):
        convert_format(str(tmp_path / "gone.epub"), str(tmp_path / "gone.azw3"))
    with pytest.raises(ValueError, match="only EPUB to AZW3"):
        convert_format(str(epub), str(tmp_path / "Book.mobi"))
    pdf = tmp_path / "Book.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    with pytest.raises(ValueError, match="only EPUB to AZW3"):
        convert_format(str(pdf), str(tmp_path / "Book.azw3"))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Book.epub", "Book.pdf"]


def test_a_failed_conversion_says_why_and_leaves_nothing_behind(tmp_path):
    drm = build_epub(tmp_path / "drm.epub", chapters=[("c.xhtml", xhtml("<p>x</p>"))])
    replace_member(drm, "META-INF/encryption.xml", ADOBE_ENCRYPTION.encode())
    with pytest.raises(RuntimeError) as failure:
        convert_format(str(drm), str(tmp_path / "drm.azw3"))
    # The exact sentence, not just the word "encrypted": this string is what the
    # toast and device_history show, so the child's `error: ` prefix must be gone.
    assert str(failure.value) == "conversion failed: the EPUB is encrypted (DRM) and cannot be converted"
    junk = tmp_path / "junk.epub"
    junk.write_bytes(b"not a zip")
    with pytest.raises(RuntimeError, match="conversion failed"):
        convert_format(str(junk), str(tmp_path / "junk.azw3"))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["drm.epub", "junk.epub"]


def test_a_failed_conversion_clears_a_temp_file_left_by_an_earlier_attempt(tmp_path):
    drm = build_epub(tmp_path / "drm.epub", chapters=[("c.xhtml", xhtml("<p>x</p>"))])
    replace_member(drm, "META-INF/encryption.xml", ADOBE_ENCRYPTION.encode())
    (tmp_path / "drm.azw3.tmp").write_bytes(b"half a file")
    with pytest.raises(RuntimeError, match="encrypted"):
        convert_format(str(drm), str(tmp_path / "drm.azw3"))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["drm.epub"]


def test_a_conversion_that_overruns_is_killed_and_leaves_nothing_behind(epub, tmp_path, monkeypatch):
    monkeypatch.setattr(converter, "TIMEOUT", 0.001)
    with pytest.raises(RuntimeError, match="timed out"):
        convert_format(str(epub), str(tmp_path / "Book.azw3"))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Book.epub"]


def test_a_conversion_that_overruns_clears_a_temp_file_left_by_an_earlier_attempt(epub, tmp_path, monkeypatch):
    monkeypatch.setattr(converter, "TIMEOUT", 0.001)
    (tmp_path / "Book.azw3.tmp").write_bytes(b"half a file")
    with pytest.raises(RuntimeError, match="timed out"):
        convert_format(str(epub), str(tmp_path / "Book.azw3"))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Book.epub"]


def test_a_temp_file_left_by_a_killed_earlier_attempt_does_not_survive_the_next(epub, tmp_path):
    out = tmp_path / "Book.azw3"
    (tmp_path / "Book.azw3.tmp").write_bytes(b"half a file")
    convert_format(str(epub), str(out))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Book.azw3", "Book.epub"]


def test_the_rpc_method_converts_and_ignores_a_stale_calibre_path(epub, tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(main, "send", sent.append)
    out = str(tmp_path / "Book.azw3")
    params = {"input_path": str(epub), "output_path": out, "ebook_convert_path": "/gone"}
    main.handle_request({"id": 1, "method": "convert_format", "params": params})
    assert sent[0]["error"] is None and sent[0]["result"]["output_path"] == out
    main.handle_request(
        {"id": 2, "method": "convert_format", "params": {"input_path": str(tmp_path / "no.epub"), "output_path": out}}
    )
    assert "Source file not found" in sent[1]["error"]["message"]


def test_titles_with_spaces_apostrophes_and_dashes_in_their_paths_convert(tmp_path):
    folder = tmp_path / "books" / "a764fbcf-7788"
    folder.mkdir(parents=True)
    source = build_epub(
        folder / "Darwin's Devices — America—Farm to Table.epub", chapters=[("c.xhtml", xhtml("<p>x</p>"))]
    )
    out = str(folder / "Darwin's Devices — America—Farm to Table.azw3")
    assert convert_format(str(source), out)["output_path"] == out
    assert read_identity(open(out, "rb").read()).cdetype == "EBOK"
