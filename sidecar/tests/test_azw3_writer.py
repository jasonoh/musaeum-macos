import io
import os
import re

import pytest
from PIL import Image

from conversion.azw3.identity import read_identity
from conversion.azw3.probe import describe
from conversion.azw3.writer import MAX_IMAGE_BYTES, build_azw3, fit_image, text_records, write_azw3
from tests.azw3_kf8 import build_epub, read_kf8, xhtml


def jpeg(width=60, height=90, noise=False) -> bytes:
    image = Image.effect_noise((width, height), 100).convert("RGB") if noise else Image.new("RGB", (width, height), "red")
    out = io.BytesIO()
    image.save(out, "JPEG", quality=95)
    return out.getvalue()


@pytest.fixture
def book(tmp_path):
    return build_epub(
        tmp_path / "book.epub",
        chapters=[
            ("c1.xhtml", xhtml(
                '<h1>One</h1><p>“Quoted” text<a href="c2.xhtml#n1">1</a></p><img src="cover.jpg" alt=""/>',
                head='<link rel="stylesheet" href="s.css" type="text/css"/>',
            )),
            ("c2.xhtml", xhtml('<h2>Two</h2><p id="n1">The note.</p>' + "<p>filler line</p>" * 400)),
        ],
        toc=[("One", "c1.xhtml", [("Note", "c2.xhtml#n1", [])]), ("Two", "c2.xhtml", [])],
        css={"s.css": "p { margin: 0 }"},
        images={"cover.jpg": jpeg()},
        cover="cover.jpg",
        authors=("First Author", "Second Author"),
    )


def test_the_text_is_uncompressed_ascii_in_4096_byte_records_with_no_trailing_entries(book):
    kf8 = read_kf8(build_azw3(str(book)).data)
    count = int.from_bytes(kf8.rec0[8:10], "big")
    sizes = [len(r) for r in kf8.records[1 : 1 + count]]
    assert count > 1 and set(sizes[:-1]) == {4096} and 0 < sizes[-1] <= 4096
    assert kf8.text.isascii()
    # T1 crashed the Oasis: PalmDOC text without trailing entries. Compression 1
    # and flags 0 travel together, and read_kf8 already insists on compression 1.
    assert kf8.word(0xF0) == 0


def test_text_records_refuse_text_that_is_not_ascii():
    with pytest.raises(ValueError):
        text_records("café".encode())


def test_the_header_words_point_at_records_of_the_measured_kinds(book):
    kf8 = read_kf8(build_azw3(str(book)).data)
    rec = kf8.records
    assert (kf8.word(0x14), kf8.word(0x18), kf8.word(0x1C), kf8.word(0x24)) == (264, 2, 65001, 8)
    for word in (0x50, 0xF4, 0xF8, 0xFC, 0x104):
        assert rec[kf8.word(word)][:4] == b"INDX", hex(word)
    assert kf8.word(0x50) == kf8.word(0xF8)  # the first non-book record is the fragment index
    assert rec[kf8.word(0xC0)][:4] == b"FDST" and kf8.word(0xC4) == 2
    assert rec[kf8.word(0xC8)][:4] == b"FCIS" and rec[kf8.word(0xD0)][:4] == b"FLIS"
    assert rec[kf8.word(0x6C)][:3] == b"\xff\xd8\xff"
    assert rec[-1] == b"\xe9\x8e\r\n"
    assert int.from_bytes(rec[kf8.word(0xC8)][20:24], "big") == len(kf8.text)


def test_flows_are_the_xhtml_then_each_stylesheet(book):
    kf8 = read_kf8(build_azw3(str(book)).data)
    xhtml_flow, css = kf8.flows()
    assert xhtml_flow.startswith(b'<?xml version="1.0" encoding="UTF-8"?>\n<html')
    assert b"kindle:flow:0001?mime=text/css" in xhtml_flow
    assert css == b"p { margin: 0 }"


def test_each_skeleton_and_fragment_reassemble_where_the_indexes_say(book):
    kf8 = read_kf8(build_azw3(str(book)).data)
    flow = kf8.flows()[0]
    skeletons = kf8.index(0xFC).entries
    fragments = kf8.index(0xF8).entries
    for (_, skel), (label, frag) in zip(skeletons, fragments):
        start, length = skel[6][:2]
        shell = flow[start : start + length]
        assert shell.endswith(b"</body></html>")
        frag_start = start + length + frag[6][0]
        assert int(label) == start + shell.index(b"</body></html>")
        assert flow[frag_start : frag_start + frag[6][1]].startswith(b"<h")


def test_links_and_the_ncx_point_at_the_element_they_name(book):
    kf8 = read_kf8(build_azw3(str(book)).data)
    flow = kf8.flows()[0]
    skeletons, fragments = kf8.index(0xFC).entries, kf8.index(0xF8).entries

    def fragment_bytes(fid: int) -> bytes:
        start, length = skeletons[fid][1][6][:2]
        return flow[start + length :]

    fid, off = re.search(rb"kindle:pos:fid:(\w{4}):off:(\w{10})", flow).groups()
    assert fragment_bytes(int(fid, 32))[int(off, 32) :].startswith(b'<p id="n1"')
    ncx = kf8.index(0xF4)
    by_title = {ncx.cncx[v[3][0]]: v for _, v in ncx.entries}
    assert list(by_title) == ["One", "Two", "Note"]
    note = by_title["Note"]
    assert fragment_bytes(note[6][0])[note[6][1] :].startswith(b'<p id="n1"')
    assert note[1][0] == int(fragments[note[6][0]][0]) + note[6][1]
    assert (note[4], note[21]) == ([1], [0])


def test_the_guide_always_has_a_start_of_text(book):
    guide = read_kf8(build_azw3(str(book)).data).index(0x104)
    assert [(label, guide.cncx[v[1][0]], v[6]) for label, v in guide.entries] == [(b"text", "Beginning", [0, 0])]


def test_the_file_reads_back_through_the_apps_own_offsets(book):
    conversion = build_azw3(str(book))
    identity = read_identity(conversion.data)
    assert (identity.title, identity.author, identity.uuid, identity.cdetype) == (
        "Test Book", "Second Author", conversion.uuid, "EBOK",  # the app's reader keeps the last author
    )
    kf8 = read_kf8(conversion.data)
    assert kf8.exth[100] == [b"First Author", b"Second Author"]
    assert kf8.exth[201] == [b"\0\0\0\0"] and kf8.exth[125] == [b"\0\0\0\1"]
    assert conversion.cover == kf8.records[kf8.word(0x6C)]
    assert build_azw3(str(book)).uuid != conversion.uuid  # fresh per file (spec D3)


def test_the_probe_describes_the_written_file(book):
    lines = describe(build_azw3(str(book)).data)
    assert any("INDX" in line for line in lines) and any("FDST" in line for line in lines)


def test_a_title_of_1024_bytes_or_more_is_cut_so_the_app_can_still_read_it(tmp_path):
    path = build_epub(tmp_path / "long.epub", chapters=[("c.xhtml", xhtml("<p>x</p>"))], title="é" * 600)
    identity = read_identity(build_azw3(str(path)).data)
    assert identity.title == "é" * 511  # 1,022 bytes: whole characters under 1,024


def test_toc_entries_and_links_outside_the_book_fall_back_with_warnings(tmp_path):
    path = build_epub(
        tmp_path / "b.epub",
        chapters=[("c.xhtml", xhtml('<p><a href="elsewhere.xhtml">x</a> <a href="#nope">y</a></p>'))],
        toc=[("Gone", "elsewhere.xhtml", []), ("Here", "c.xhtml#nope", [])],
    )
    conversion = build_azw3(str(path))
    ncx = read_kf8(conversion.data).index(0xF4)
    assert [ncx.cncx[v[3][0]] for _, v in ncx.entries] == ["Here"]
    assert any("outside the book" in w for w in conversion.warnings)
    assert any("no such anchor" in w for w in conversion.warnings)


def test_a_book_without_a_table_of_contents_gets_one_entry(tmp_path):
    path = build_epub(tmp_path / "b.epub", chapters=[("c.xhtml", xhtml("<p>x</p>"))], toc=[])
    ncx = read_kf8(build_azw3(str(path)).data).index(0xF4)
    assert [ncx.cncx[v[3][0]] for _, v in ncx.entries] == ["Test Book"]


def test_images_over_128_kib_or_of_other_types_become_smaller_jpegs():
    big = jpeg(1600, 2400, noise=True)
    assert len(big) > MAX_IMAGE_BYTES
    data, mime = fit_image(big, "image/jpeg")
    assert mime == "image/jpeg" and len(data) <= MAX_IMAGE_BYTES
    webp = io.BytesIO()
    Image.new("RGBA", (10, 10), (0, 0, 255, 128)).save(webp, "WEBP")
    data, mime = fit_image(webp.getvalue(), "image/webp")
    assert mime == "image/jpeg" and data[:3] == b"\xff\xd8\xff"
    assert fit_image(b"<svg/>", "image/svg+xml") == (b"<svg/>", None)
    small = jpeg()
    assert fit_image(small, "image/jpeg") == (small, "image/jpeg")


def test_write_leaves_the_file_and_no_temp(book, tmp_path):
    target = tmp_path / "out.azw3"
    conversion = write_azw3(str(book), str(target))
    assert target.read_bytes() == conversion.data
    assert sorted(p.name for p in tmp_path.iterdir()) == ["book.epub", "out.azw3"]


def test_a_write_that_fails_leaves_no_file_and_no_temp(book, tmp_path, monkeypatch):
    def full_disk(*_):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", full_disk)
    with pytest.raises(OSError):
        write_azw3(str(book), str(tmp_path / "out.azw3"))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["book.epub"]
