import pypdfium2 as pdfium

from reflow.chars import Char, baseline_lines, page_chars
from tests.reflow_pdfs import Page, Text, write_pdf


def _chars(tmp_path, page):
    pdf = pdfium.PdfDocument(write_pdf(tmp_path / "c.pdf", [page]))
    return page_chars(pdf[0].get_textpage())


def glyphs(text, x, y, size=10.0):
    """One line of synthetic characters; spaces get pdfium's zero-height box."""
    out = []
    for ch in text:
        if ch == " ":
            out.append(Char(" ", x, y, x + size * 0.25, y, size=size))
            x += size * 0.3
        else:
            out.append(Char(ch, x, y, x + size * 0.5, y + size * 0.7, size=size))
            x += size * 0.55
    return out


def _text(line):
    return "".join(c.text for c in line)


def test_page_chars_reports_size_bold_and_rotation(tmp_path):
    chars = _chars(
        tmp_path,
        Page(texts=[Text(72, 720, "Heading", 18, bold=True), Text(72, 700, "body"), Text(30, 300, "arXiv", rotated=True)]),
    )
    h = next(c for c in chars if c.text == "H")
    b = next(c for c in chars if c.text == "b")
    stamp = [c for c in chars if c.text in "arXiv" and c.cx < 40]
    assert (h.size, h.bold, h.rotated) == (18.0, True, False)
    assert (b.size, b.bold, b.rotated) == (10.0, False, False)
    assert stamp and all(c.rotated for c in stamp)


def test_char_boxes_are_absolute_whatever_the_crop_box(tmp_path):
    chars = _chars(tmp_path, Page(texts=[Text(72, 700, "Absolute")], crop=(40, 40, 572, 752)))
    first = next(c for c in chars if c.text == "A")
    assert 71 <= first.left <= 74 and 699 <= first.bottom <= 702


def test_baseline_lines_keeps_a_raised_apostrophe_on_its_line():
    line1 = glyphs("it", 72, 700) + [Char("'", 83, 704.5, 84, 707, size=10)] + glyphs("s", 84.5, 700)
    line2 = glyphs("ok", 72, 686)
    lines = baseline_lines(line2 + line1)
    assert [_text(ln) for ln in lines] == ["it's", "ok"]


def test_baseline_lines_folds_a_superscript_into_its_line():
    line = glyphs("x", 72, 700) + [Char("1", 77.5, 704, 80, 708, size=6)] + glyphs(" y", 81, 700)
    assert [_text(ln) for ln in baseline_lines(line)] == ["x1 y"]


def test_baseline_lines_attaches_spaces_and_drops_strays():
    line = glyphs("a b", 72, 700)
    stray = Char(" ", 400, 100, 402, 100)
    assert [_text(ln) for ln in baseline_lines(line + [stray])] == ["a b"]


def test_baseline_lines_keeps_two_columns_on_one_baseline_together():
    left = glyphs("left", 72, 700)
    right = glyphs("right", 320, 700)
    lines = baseline_lines(right + left)
    assert [_text(ln) for ln in lines] == ["leftright"]
