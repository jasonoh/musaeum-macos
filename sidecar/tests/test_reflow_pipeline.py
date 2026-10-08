import pytest

from reflow import gate, layout
from reflow.epub import write_epub
from reflow.layout import analyse, classify_roles, place_figures, stitch_pages
from reflow.model import Block, PageResult
from reflow.outline import document_entries
from reflow.vision import LayoutUnavailable, PageLayout, Region
from tests.reflow_pdfs import Page, Rect, Text, write_pdf

FOOTER = "CHAPTER 4 THE ORIGIN OF MODERN ASTRONOMY"
F_BOX = (70, 26, 400, 40)
BODY_BOX = (70, 620, 420, 712)


def plain(lines, extra=()):
    return Page(texts=[Text(72, 700 - 14 * i, t) for i, t in enumerate(lines)] + [Text(72, 30, FOOTER, 8)] + list(extra))


def regions(page_no, *boxes):
    return PageLayout(page=page_no, box=(0, 0, 612, 792), regions=[Region(i, b, t) for i, (b, t) in enumerate(boxes)])


BODY = ["Body on this page continues the story of the stars.", "It has enough characters to count as a text page."]


def book(tmp_path):
    two_columns = Page(
        texts=[Text(72, 700 - 14 * i, f"Left line {i} tells of stars") for i in range(6)]
        + [Text(320, 700 - 14 * i, f"Right line {i} tells of planets") for i in range(6)]
        + [Text(72, 30, FOOTER, 8)]
    )
    stamped = plain(BODY, extra=[Text(30, 300, "arXiv:1706.03762v5", 10, rotated=True)])
    headed = plain(BODY, extra=[Text(72, 740, "Chapter Heading", 18, bold=True)])
    plate = Page(rects=[Rect(0, 0, 612, 792, 0.3)])
    path = write_pdf(tmp_path / "book.pdf", [two_columns, stamped, headed, plate])
    layouts = {
        1: regions(1, ((70, 625, 250, 712), ""), ((318, 625, 520, 712), ""), (F_BOX, "")),
        2: regions(2, ((15, 290, 40, 420), "arXiv:1706.03762v5"), (BODY_BOX, ""), (F_BOX, "")),
        3: regions(3, ((70, 735, 300, 760), ""), (BODY_BOX, ""), (F_BOX, "")),
    }
    return path, layouts


def all_text(doc):
    return " ".join(b.text for p in doc.pages for b in p.blocks)


def test_a_book_reads_in_order_without_its_stamp_or_its_running_footer(tmp_path):
    path, layouts = book(tmp_path)
    doc = analyse(path, layouts=layouts)
    assert doc.verdict == "ok"
    first, second = [b.text for b in doc.pages[0].blocks]
    assert first.startswith("Left line 0") and "planets" not in first
    assert second.startswith("Right line 0") and "stars" not in second
    assert FOOTER not in all_text(doc) and doc.dropped_running_heads
    assert "arXiv" not in all_text(doc) and "1706" not in all_text(doc)
    assert doc.pages[2].blocks[0].kind == "heading" and doc.pages[2].blocks[0].level == 1
    assert [b.plate for b in doc.pages[3].blocks] == [True] and doc.plates == 1


def test_the_whole_path_produces_a_package_the_gate_accepts(tmp_path):
    path, layouts = book(tmp_path)
    doc = analyse(path, layouts=layouts)
    doc.entries = document_entries(path, doc)
    out = str(tmp_path / "book.epub")
    write_epub(doc, out, "Book")
    assert gate.check_package(out) == []
    assert gate.check_figures(out, expected_figures=doc.figures_detected, expected_plates=1) == []
    assert gate.check_golden(gate.spine_text(out), ["Left line 5 tells of stars Right line 0 tells of planets"]) == []


def test_missing_page_layout_degrades_to_one_region(tmp_path):
    path = write_pdf(tmp_path / "m.pdf", [plain(BODY) for _ in range(4)])
    layouts = {n: regions(n, (BODY_BOX, ""), (F_BOX, "")) for n in (1, 3, 4)}
    doc = analyse(path, layouts=layouts)
    assert doc.verdict == "ok" and doc.layout_errors == 1
    assert "continues the story" in " ".join(b.text for b in doc.pages[1].blocks)


def test_too_many_missing_layouts_is_unstable(tmp_path):
    path = write_pdf(tmp_path / "u.pdf", [plain(BODY) for _ in range(4)])
    doc = analyse(path, layouts={1: regions(1, (BODY_BOX, ""))})
    assert doc.verdict == "unstable_layout" and "3 of 4" in doc.reason


def test_unopenable_pdf_is_a_verdict(tmp_path):
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"this is not a pdf at all")
    doc = analyse(str(path), layouts={})
    assert doc.verdict == "unreadable" and doc.reason


def test_no_layout_helper_is_a_fallback_reason(tmp_path, monkeypatch):
    path = write_pdf(tmp_path / "n.pdf", [plain(BODY)])

    def unavailable(*args, **kwargs):
        raise LayoutUnavailable("page layout needs macOS 26 or later")

    monkeypatch.setattr(layout, "run_helper", unavailable)
    doc = analyse(path)
    assert doc.verdict == "no_layout" and "macOS 26" in doc.reason


def test_a_textless_book_never_runs_the_helper(tmp_path, monkeypatch):
    path = write_pdf(tmp_path / "t.pdf", [Page(rects=[Rect(0, 0, 612, 792, 0.3)])] * 2)
    monkeypatch.setattr(layout, "run_helper", lambda *a, **k: pytest.fail("helper ran on a textless book"))
    assert analyse(path).verdict == "no_text_layer"


def B(kind="para", text="", size=10.0, bold=False, lines=3, top=600.0, bottom=560.0, left=72.0, right=500.0):
    return Block(kind, text=text, size=size, bold=bold, lines=lines, top=top, bottom=bottom, left=left, right=right)


def page(*blocks, index=0):
    return PageResult(index=index, blocks=list(blocks), chars=500, top=792, bottom=0)


def test_roles_from_size_and_weight():
    body = B(text="x" * 400)
    big = B(text="Chapter One", size=18, lines=1, top=750)
    bold = B(text="Encoder Stacks", bold=True, lines=1, top=700)
    long_bold = B(text="y" * 300, bold=True)
    note = B(text="* A note.", size=8, lines=1, top=80, bottom=70)
    small_mid = B(text="A caption.", size=8, lines=1, top=400)
    classify_roles([page(body, big, bold, long_bold, note, small_mid)])
    assert (big.kind, big.level) == ("heading", 1)
    assert (bold.kind, bold.level) == ("heading", 2)
    assert long_bold.kind == "para" and small_mid.kind == "para"
    assert note.kind == "footnote"


def test_a_paragraph_continuing_onto_the_next_page_is_joined_before_its_notes():
    last = B(text="approaches in sequence modeling and")
    note = B("footnote", text="* Equal contribution.")
    cont = B(text="transduction problems such as language modeling.")
    p0, p1 = page(last, note), page(cont, index=1)
    stitch_pages([p0, p1])
    assert [b.text for b in p0.blocks] == ["approaches in sequence modeling and transduction problems such as language modeling.", "* Equal contribution."]
    assert p1.blocks == []


def test_notes_move_past_a_paragraph_that_continues_with_a_capital():
    last, note = B(text="ends without a stop"), B("footnote", text="note")
    first, more = B(text="Next starts upper."), B(text="More.")
    p0, p1 = page(last, note), page(first, more, index=1)
    stitch_pages([p0, p1])
    assert [b.text for b in p0.blocks] == ["ends without a stop"]
    assert [b.text for b in p1.blocks] == ["Next starts upper.", "note", "More."]


def test_figures_go_before_the_first_block_below_them_in_their_column():
    above = B(text="above", top=700, bottom=650, left=72, right=300)
    other_column = B(text="right column", top=500, bottom=300, left=320, right=540)
    below = B(text="below", top=400, bottom=350, left=72, right=300)
    figure = B("figure", top=600, bottom=450, left=80, right=280)
    assert place_figures([above, other_column, below], [figure]) == [above, other_column, figure, below]
    assert place_figures([above], [B("figure", top=100, bottom=50)])[-1].kind == "figure"
