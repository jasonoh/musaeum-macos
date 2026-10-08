import io
import zipfile
from collections import Counter

import pypdfium2 as pdfium
from PIL import Image

from reflow import gate
from reflow.chars import Char
from reflow.outline import Entry, outline_entries
from tests.reflow_pdfs import OutlineItem, Page, Rect, Text, write_pdf

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">x</dc:identifier><dc:title>T</dc:title><dc:language>en</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>{items}</manifest>
<spine>{spine}</spine></package>"""
CONTAINER = """<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"""
XHTML = """<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>{title}</title></head><body>{body}</body></html>"""


def make_epub(path, chapters, nav_ol, images=None):
    """chapters: [(file name, body html)] in spine order; nav_ol: the <ol> inside the toc nav."""
    images = images or {}
    items = "".join(f'<item id="c{i}" href="text/{n}" media-type="application/xhtml+xml"/>' for i, (n, _) in enumerate(chapters))
    items += "".join(f'<item id="i{i}" href="images/{n}" media-type="{m}"/>' for i, (n, (_, m)) in enumerate(images.items()))
    spine = "".join(f'<itemref idref="c{i}"/>' for i in range(len(chapters)))
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip")
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", OPF.format(items=items, spine=spine))
        zf.writestr("OEBPS/nav.xhtml", XHTML.format(title="Contents", body=f'<nav epub:type="toc">{nav_ol}</nav>'))
        for name, body in chapters:
            zf.writestr(f"OEBPS/text/{name}", XHTML.format(title="Chapter Title Words", body=body))
        for name, (data, _) in images.items():
            zf.writestr(f"OEBPS/images/{name}", data)
    return str(path)


def png(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "black").save(buf, "PNG")
    return buf.getvalue()


def jpeg(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "black").save(buf, "JPEG")
    return buf.getvalue()


def row(text, x, y, size=10.0):
    out = []
    for ch in text:
        if ch == " ":
            out.append(Char(" ", x, y, x + 2.5, y))
            x += 3.0
        else:
            out.append(Char(ch, x, y, x + 5, y + 7, size=size))
            x += 5.5
    return out


def test_tokens_normalise_quotes_and_line_break_hyphens():
    assert gate.tokens("Tycho’s mer-\ncenary “soldier”") == ["tycho's", "mercenary", "soldier"]


def test_spine_text_follows_the_spine_and_skips_head_titles(tmp_path):
    epub = make_epub(tmp_path / "a.epub", [("b.xhtml", "<p>second</p>"), ("a.xhtml", "<p>first</p>")], "<ol/>")
    text = gate.spine_text(epub)
    assert text.index("second") < text.index("first")
    assert "Chapter Title Words" not in text


def test_check_golden_needs_the_passage_contiguous(tmp_path):
    spine = "Kepler was born in 1571 to a poor family in a region"
    assert gate.check_golden(spine, ["born in 1571 to a poor family"]) == []
    interleaved = "Kepler was born in 1571 to a poor sky, nearly merging family in a region"
    fails = gate.check_golden(interleaved, ["born in 1571 to a poor family"])
    assert len(fails) == 1 and fails[0].startswith("G1 ")


def test_segments_split_at_a_gutter_and_drop_a_trailing_hyphen_fragment():
    chars = row("left column words", 72, 700) + row("right side mer-", 320, 700)
    ev = gate.page_evidence(None, chars)
    assert ev.segments == [["left", "column", "words"], ["right", "side"]]


def test_a_stored_space_inside_a_glyph_cluster_is_not_a_word_break():
    """*Universe*'s text layer stores `fi ghting`, `Th e sun` and `diff erence`:
    the space's box lies inside the glyph cluster (a 0.4pt gap against ~2.5pt for
    a word space). C.5 item 3 drops it, so a gate that reads the stored
    characters raw calls the repaired word lost and misses every trigram across
    it — measured on *Universe* pp.1–60: 10.6% word loss raw against 5.9% with
    the rule."""
    cluster = row("fi", 72, 700) + [Char(" ", 82.0, 700, 82.4, 700)] + row("ghting", 82.4, 700)
    ev = gate.page_evidence(None, cluster)
    assert ev.segments == [["fighting"]]
    assert ev.upright == ["fighting"]


def test_segments_skip_page_furniture_and_excluded_boxes():
    chars = row("CHAPTER 4 THE ORIGIN", 72, 20) + row("body words here now", 72, 400) + row("axis label text", 300, 300)
    ev = gate.page_evidence(None, chars, exclude=[(290, 290, 420, 320)], page_box=(0, 0, 612, 792))
    assert ev.segments == [["body", "words", "here", "now"]]


def test_trigram_recall_drops_when_columns_interleave():
    segments = [["a", "b", "c", "d"], ["w", "x", "y", "z"]]
    assert gate.trigram_recall(segments, "a b c d w x y z".split())[0] == 1.0
    assert gate.trigram_recall(segments, "a b w x c d y z".split())[0] == 0.0


def test_rotated_only_tokens_are_caught_in_the_spine():
    stamp = gate.rotated_only(["arxiv", "1706", "03762v5", "2017"], ["2017", "attention"])
    assert stamp == {"arxiv", "1706", "03762v5"}
    assert gate.check_rotated(["attention", "03762v5"], stamp)[0].startswith("G3 ")


def test_check_figures_catches_mislabelled_bytes_slivers_and_counts(tmp_path):
    epub = make_epub(
        tmp_path / "f.epub",
        [("c.xhtml", "<p>x</p>")],
        "<ol/>",
        {"p0001-0.png": (jpeg(100, 100), "image/png"), "p0002-1.png": (png(7, 406), "image/png"), "p0003-plate.jpg": (jpeg(600, 800), "image/jpeg")},
    )
    fails = gate.check_figures(epub, expected_figures=3, expected_plates=1)
    assert any("p0001-0.png" in f and "bytes jpeg" in f for f in fails)
    assert any("p0002-1.png" in f and "sliver" in f for f in fails)
    assert any("2 figures written, 3 detected" in f for f in fails)
    assert all(f.startswith("G4 ") for f in fails)


def test_check_figures_passes_a_clean_package(tmp_path):
    epub = make_epub(
        tmp_path / "g.epub", [("c.xhtml", "<p>x</p>")], "<ol/>",
        {"p0001-0.png": (png(100, 80), "image/png"), "p0002-1.jpg": (jpeg(300, 200), "image/jpeg")},
    )
    assert gate.check_figures(epub, expected_figures=2, expected_plates=0) == []


NAV = """<ol><li><a href="text/c1.xhtml#t1">Introduction</a><ol><li><a href="text/c1.xhtml#t2">Background</a></li></ol></li><li><a href="text/c2.xhtml#t9">Results</a></li></ol>"""


def test_check_toc_compares_with_the_outline_and_resolves_anchors(tmp_path):
    epub = make_epub(
        tmp_path / "t.epub",
        [("c1.xhtml", '<h1 id="t1">1 Introduction</h1><p id="t2">Background prose</p>'), ("c2.xhtml", "<h1>Results</h1>")],
        NAV,
    )
    fails = gate.check_toc(epub, [("Introduction", 0), ("Background", 1), ("Results", 0)])
    assert any("t9" in f and "does not resolve" in f for f in fails)
    assert any("heading" in f for f in fails)  # 1 of 3 lands on a matching heading
    fails = gate.check_toc(epub, [("Introduction", 0), ("Results", 0)])
    assert any("3 entries" in f and "outline has 2" in f for f in fails)


def test_check_toc_passes_when_every_entry_lands_on_its_heading(tmp_path):
    epub = make_epub(
        tmp_path / "u.epub",
        [("c1.xhtml", '<h1 id="t1">Introduction</h1><h2 id="t2">Background</h2>'), ("c2.xhtml", '<h1 id="t9">Results</h1>')],
        NAV,
    )
    assert gate.check_toc(epub, [("Introduction", 0), ("Background", 1), ("Results", 0)]) == []


def test_word_loss_excludes_what_was_dropped_on_purpose():
    pdf = Counter("the cat sat on the mat page 12".split())
    art = Counter("the cat sat on the mat".split())
    loss, missing = gate.word_loss(pdf, art, Counter(["page", "12"]))
    assert loss == 0.0 and not missing


def test_check_package_flags_a_compressed_mimetype(tmp_path):
    path = tmp_path / "bad.epub"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", "application/epub+zip")
    assert any("compressed" in f for f in gate.check_package(str(path)))


def test_plate_expected_on_a_textless_page_with_ink(tmp_path):
    pdf = pdfium.PdfDocument(write_pdf(tmp_path / "p.pdf", [Page(rects=[Rect(0, 0, 612, 792, 0.4)]), Page()]))
    assert gate.page_evidence(pdf[0], []).plate_expected is True
    assert gate.page_evidence(pdf[1], []).plate_expected is False


def test_outline_entries_keep_every_depth_and_drop_printer_marks(tmp_path):
    path = write_pdf(
        tmp_path / "o.pdf",
        [Page(texts=[Text(72, 700, "x")]), Page(texts=[Text(72, 700, "y")])],
        outline=[
            OutlineItem("cover4", 0, 0),
            OutlineItem("Model Architecture", 0, 1, top=700.0),
            OutlineItem("Encoder", 0, 2),
            OutlineItem("ix", 1, 0),
            OutlineItem("Training", 1, 0),
        ],
    )
    assert outline_entries(path) == [
        Entry("Model Architecture", 0, 0, 700.0),
        Entry("Encoder", 1, 0, None),
        Entry("Training", 0, 1, None),
    ]
    # an entry past the pages being read (a `--limit` run) is skipped, not an error
    assert outline_entries(path, pages=1) == [Entry("Model Architecture", 0, 0, 700.0), Entry("Encoder", 1, 0, None)]
