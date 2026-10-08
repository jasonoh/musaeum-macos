import zipfile

from reflow import gate
from reflow.epub import link_entries, write_epub
from reflow.model import Block, Document, PageResult
from reflow.outline import Entry, document_entries, outline_entries
from tests.reflow_pdfs import OutlineItem, Page, Text, write_pdf


def H(text, level=1, top=700.0):
    return Block("heading", text=text, level=level, top=top)


def P(text, top=600.0):
    return Block("para", text=text, top=top)


def _doc(tmp_path, pages, entries=(), from_outline=True):
    doc = Document(source=str(tmp_path / "missing.pdf"))
    for i, blocks in enumerate(pages):
        for b in blocks:
            b.page = i
        doc.pages.append(PageResult(index=i, blocks=list(blocks), chars=500, top=792, bottom=0))
    doc.entries = list(entries)
    doc.entries_from_outline = from_outline
    return doc


def _write(tmp_path, doc):
    out = tmp_path / "out.epub"
    report = write_epub(doc, str(out), "Title")
    return str(out), report


def test_nav_nests_like_the_outline_and_lands_on_headings(tmp_path):
    doc = _doc(
        tmp_path,
        [[H("1 Introduction"), P("intro"), H("1.1 Scope", 2, 500), P("scope", 400)], [H("2 Method"), P("method")]],
        [Entry("1 Introduction", 0, 0), Entry("1.1 Scope", 1, 0), Entry("2 Method", 0, 1)],
    )
    epub, report = _write(tmp_path, doc)
    assert gate.check_package(epub) == []
    assert gate.check_toc(epub, [("1 Introduction", 0), ("1.1 Scope", 1), ("2 Method", 0)]) == []
    assert report["sections"] == 2 and report["toc_entries"] == 3


def test_two_entries_on_one_page_both_survive(tmp_path):
    doc = _doc(
        tmp_path,
        [[H("2 Background"), P("b"), H("3 Model Architecture", 1, 300), P("m", 200)]],
        [Entry("2 Background", 0, 0), Entry("3 Model Architecture", 0, 0)],
    )
    epub, _ = _write(tmp_path, doc)
    with zipfile.ZipFile(epub) as zf:
        assert [t for t, _, _ in gate.nav_entries(zf)] == ["2 Background", "3 Model Architecture"]
    assert gate.check_toc(epub, [("2 Background", 0), ("3 Model Architecture", 0)]) == []


def test_an_entry_with_no_heading_lands_on_the_block_nearest_its_top(tmp_path):
    a, b = P("a", top=700), P("b", top=400)
    doc = _doc(tmp_path, [[a, b]], [Entry("Section B", 0, 0, top=410.0)])
    assert link_entries(doc) == [(doc.entries[0], b)]
    assert b.anchor


def test_an_entry_on_an_empty_page_lands_on_the_next_page_with_blocks(tmp_path):
    later = P("later")
    doc = _doc(tmp_path, [[P("first")], [], [later]], [Entry("Part Two", 0, 1)])
    assert link_entries(doc)[0][1] is later


def test_duplicate_titles_get_distinct_anchors(tmp_path):
    first, second = H("Foreword"), H("Foreword")
    doc = _doc(tmp_path, [[first, P("x")], [second, P("y")]], [Entry("Foreword", 0, 0), Entry("Foreword", 0, 1)])
    targets = link_entries(doc)
    assert [t[1] for t in targets] == [first, second]
    assert first.anchor != second.anchor


def test_entries_past_the_end_are_skipped(tmp_path):
    doc = _doc(tmp_path, [[H("One"), P("x")]], [Entry("One", 0, 0), Entry("Gone", 0, 9)])
    assert [e.title for e, _ in link_entries(doc)] == ["One"]


def test_outline_depth_sets_the_heading_level(tmp_path):
    h = H("Chapter One", level=3)
    doc = _doc(tmp_path, [[h, P("x")]], [Entry("Chapter One", 0, 0)])
    link_entries(doc)
    assert h.level == 1


def test_a_page_label_outline_falls_back_to_the_headings(tmp_path):
    """*Modernist Cuisine*'s outline is 355 page labels — `cover1`–`cover11`,
    `viii`–`xiii`, the folios `2`–`335`, `end1`–`end4` — and the filter kept the
    seven that carry three or more letters. The TOC was `viii, xii, xiii, end1…`
    and no entry could land on a heading (G5: 0 of 7), where the spec's item 9
    asks for the heading pass once the outline is not a TOC."""
    path = write_pdf(
        tmp_path / "j.pdf",
        [Page(texts=[Text(72, 700, "x")]), Page(texts=[Text(72, 700, "y")])],
        outline=[
            OutlineItem("cover4", 0),
            OutlineItem("viii", 0, 1),
            OutlineItem("xii", 0, 1),
            OutlineItem("end1", 0, 1),
            OutlineItem("Introduction", 0, 1),
        ],
    )
    assert [e.title for e in outline_entries(path)] == ["Introduction"]


def test_headings_stand_in_for_a_missing_outline(tmp_path):
    path = write_pdf(tmp_path / "n.pdf", [Page(texts=[Text(72, 700, "x")])])
    doc = _doc(tmp_path, [[H("Intro", 1), H("Detail", 2, 500), H("Minor", 3, 400), P("p", 300)]])
    entries = document_entries(path, doc)
    assert [(e.title, e.depth) for e in entries] == [("Intro", 0), ("Detail", 1)]
    assert doc.entries_from_outline is False


def test_the_outline_wins_when_it_has_entries(tmp_path):
    path = write_pdf(
        tmp_path / "o.pdf",
        [Page(texts=[Text(72, 700, "x")]), Page(texts=[Text(72, 700, "y")])],
        outline=[OutlineItem("One", 0), OutlineItem("Two", 1)],
    )
    doc = _doc(tmp_path, [[P("x")], [P("y")]])
    assert document_entries(path, doc) == outline_entries(path)
    assert doc.entries_from_outline is True and doc.outline_entries == 2


def test_a_book_with_no_toc_gets_one_entry_per_file(tmp_path):
    doc = _doc(tmp_path, [[P(f"page {i}")] for i in range(45)])
    epub, report = _write(tmp_path, doc)
    with zipfile.ZipFile(epub) as zf:
        entries = gate.nav_entries(zf)
    assert report["sections"] == 3 and len(entries) == 3
    assert not [f for f in gate.check_toc(epub, None) if "resolve" in f]


def test_every_page_has_a_marker_and_tables_and_footnotes_render(tmp_path):
    table = Block("table", rows=[["a", "b"], ["c", "d"]], text="a b c d")
    note = Block("footnote", text="A note.")
    doc = _doc(tmp_path, [[H("One"), table], [P("y"), note]], [Entry("One", 0, 0)])
    epub, _ = _write(tmp_path, doc)
    with zipfile.ZipFile(epub) as zf:
        body = zf.read("OEBPS/text/c001.xhtml").decode()
    assert 'id="pg1"' in body and 'id="pg2"' in body
    assert "<td>a</td><td>b</td>" in body
    assert '<p class="footnote">A note.</p>' in body
    assert gate.check_package(epub) == []
