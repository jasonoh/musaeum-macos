"""The furniture rule, pinned by what the corpus's own PDFs produce.

Every case below is a block the 2026-10-12 corpus run's layout records actually
carry — its own text, its own box, against its own page — so these are reads of
the books rather than strings written to agree with the rule. The tier's own
cases were synthetic repeats of one string and passed while the rule did nothing
on any real page: this file exists so that cannot happen again.

`top` and `bottom` are the block's box as a fraction of its page's height,
measured from the page's bottom edge; the tests rebuild a page of unit height so
the fixture does not have to carry PDF points.
"""

import json
from pathlib import Path

from reflow import furniture, layout
from reflow.model import Block, Document, PageResult

FIXTURE = Path(__file__).parent / "fixtures" / "reflow_band.json"


def cases() -> list[dict]:
    return json.loads(FIXTURE.read_text())


def page_of(case: dict, index: int = 0) -> PageResult:
    """The case's block on the page it was measured on (unit height)."""
    block = Block(case["kind"], text=case["text"], top=case["top"], bottom=case["bottom"], page=index)
    return PageResult(index=index, chars=500, top=1.0, bottom=0.0, blocks=[block])


def test_the_furniture_rule_reads_the_books_own_pages():
    for case in cases():
        block = page_of(case).blocks[0]
        page = page_of(case)
        got = layout._is_printed_furniture(block, page)
        assert got == case["furniture"], f"{case['book']} p{case['page']}: {case['why']} — got {got}"


def test_a_pass_drops_the_shapes_without_asking_the_book_to_repeat_them():
    """The whole point of the rewrite: *Universe*'s own running head, its welded
    page number and its legal footer go because of what they *are*, not because
    the book happens to print one string twice."""
    doc = Document(source="fixture")
    for i, case in enumerate(cases()):
        doc.pages.append(page_of(case, i))
    # Two filler pages: `mark_running_heads` refuses to judge a document of
    # fewer than `RUNNING_HEAD_MIN` text pages, and the repetition route's
    # threshold has to stay above anything the fixture repeats (it repeats
    # nothing — every text here is distinct).
    for i in range(2):
        filler = Block("para", text=f"Body on filler page {i} of the fixture.", top=0.5, bottom=0.4)
        doc.pages.append(PageResult(index=len(cases()) + i, chars=500, top=1.0, bottom=0.0, blocks=[filler]))
    layout.mark_running_heads(doc)
    dropped = set(doc.dropped_running_heads)
    expected = {case["text"] for case in cases() if case["furniture"]}
    assert dropped == expected
    kept = " ".join(b.text for p in doc.pages for b in p.blocks)
    for case in cases():
        if not case["furniture"]:
            assert case["text"] in kept, f"{case['book']} p{case['page']}: {case['why']}"


def test_a_letter_spaced_line_is_the_shape_and_the_band_is_what_scopes_it():
    """*Universe*'s 17 letter-spaced blocks outside the band are equations and
    figure keys, and every one of them is content — which is why the shape test
    alone is not the rule."""
    equation = "V = V1.04 × 10° = 1020 m/s"
    assert furniture.letter_spaced(equation)
    assert not furniture.shaped(0.173, 0.160, 0.0, 1.0, equation)
    assert furniture.shaped(0.06, 0.04, 0.0, 1.0, "C H A PT E R 3 CYC L ES O F TH E SU N A N D M OO N")


def test_the_margin_takes_a_notice_however_short_and_the_band_is_not_the_margin():
    """*Universe*'s footer arrives as often in fragments (`Copyright 2012 Cengage
    Le deemed that`, 37 characters) as whole, so length is no part of the test:
    position is. What position must not do is take *Modernist Cuisine*'s real
    prose line at the foot of a page (its top at 2.7% of the page) or
    *Politics*' footnote at 7.2% — those are the band, and the band is not the
    page's own margin."""
    whole = "Copyright 2012 Cengage Learning. All Rights Reserved. May not be copied, scanned, or duplicated"
    fragment = "Copyright 2012 Cengage Le deemed that"
    prose = "60 is little point in trying to hide; it's much better to participate and be part ofthe community"
    footnote = "15. Enrico Berlinguer (1922-84). Former Secretary-General of the Italian Communist party"
    assert furniture.shaped(0.021, 0.010, 0.0, 1.0, whole)
    assert furniture.shaped(0.0225, 0.0096, 0.0, 1.0, fragment)
    assert not furniture.shaped(0.027, 0.017, 0.0, 1.0, prose)
    assert not furniture.shaped(0.072, 0.038, 0.0, 1.0, footnote)
