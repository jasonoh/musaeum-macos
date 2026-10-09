from reflow.chars import Char
from reflow.regions import build_page_text, choose_text, join_lines, junk_score, line_text
from reflow.vision import PageLayout, Region, Table, TableCell

PAGE = (0.0, 0.0, 612.0, 792.0)


def glyphs(text, x, y, size=10.0, bold=False, angle=0.0):
    out = []
    for ch in text:
        if ch == " ":
            out.append(Char(" ", x, y, x + size * 0.25, y, size=size, angle=angle))
            x += size * 0.3
        else:
            out.append(Char(ch, x, y, x + size * 0.5, y + size * 0.7, size=size, bold=bold, angle=angle))
            x += size * 0.55
    return out


def column(lines, x, y0, size=10.0):
    out = []
    for i, text in enumerate(lines):
        out += glyphs(text, x, y0 - 14 * i, size)
    return out


def layout(*regions, tables=()):
    return PageLayout(page=1, box=PAGE, regions=[Region(i, box, text) for i, (box, text) in enumerate(regions)], tables=list(tables))


def texts(result):
    return [b.text for b in result.blocks]


def test_a_space_inside_a_ligature_is_dropped():
    chars = [
        Char("f", 435.4, 100, 440.4, 107, size=9.5),
        Char("i", 435.4, 100, 440.4, 107, size=9.5),
        Char(" ", 437.8, 100, 440.4, 107, size=9.5),  # Universe p.78: "fi ghting"
        Char("g", 440.8, 98, 445.3, 105, size=9.5),
        Char("h", 445.5, 100, 450.0, 107, size=9.5),
    ]
    assert line_text(chars) == "figh"


def test_real_spaces_stay_and_missing_ones_are_added_but_not_before_punctuation():
    assert line_text(glyphs("the cat", 72, 700)) == "the cat"
    gap = glyphs("the", 72, 700) + glyphs("cat", 100, 700)
    assert line_text(gap) == "the cat"
    stop = glyphs("word", 72, 700) + glyphs(".", 100, 700)
    assert line_text(stop) == "word."


def test_join_lines_rejoins_a_word_broken_at_the_line_end():
    assert join_lines(["a mer-", "cenary soldier"]) == "a mercenary soldier"
    assert join_lines(["Coper-", "Nican"]) == "Coper- Nican"


def test_choose_text_keeps_the_text_layer_for_math():
    assert choose_text("(x1, ..., xn) to a sequence", "(21,...,Xn) to a sequence") == ("(x1, ..., xn) to a sequence", "pdf")


def test_choose_text_takes_vision_over_a_scanners_ocr_layer():
    text, source = choose_text("Hl'n t' I hi' h.!'> to ld tlw moiL•cular", "Herve This has told the story of molecular")
    assert source == "vision" and text == "Herve This has told the story of molecular"
    assert junk_score("Hl'n t' I hi' h.!'> to ld tlw moiL•cular") > junk_score("Herve This has told the story")


def test_choose_text_uses_vision_only_where_the_pdf_has_nothing():
    assert choose_text("", "The Origins of Molecular Gastronomy") == ("The Origins of Molecular Gastronomy", "vision")
    assert choose_text("", "") == ("", "pdf")


def test_two_columns_read_in_vision_order_without_interleaving():
    left = column(["Left one about stars", "left two about stars", "left three about stars"], 72, 700)
    right = column(["Right one about planets", "right two about planets", "right three about planets"], 320, 700)
    result = build_page_text(0, right + left, layout(((70, 670, 250, 712), ""), ((318, 670, 500, 712), "")), [], PAGE)
    assert texts(result) == [
        "Left one about stars left two about stars left three about stars",
        "Right one about planets right two about planets right three about planets",
    ]


def test_a_rotated_stamp_is_dropped_even_though_vision_read_it():
    stamp = glyphs("arXiv:1706", 20, 300, angle=4.71)
    body = column(["Body text here."], 72, 700)
    result = build_page_text(0, stamp + body, layout(((15, 290, 80, 320), "arXiv:1706"), ((70, 695, 300, 712), "")), [], PAGE)
    assert texts(result) == ["Body text here."]


def test_a_vision_region_holding_only_rotated_characters_is_dropped():
    """*Universe* p.352: a figure credit printed at an angle comes back as two
    Vision regions, and the smaller one takes its rotated characters, so the
    wide strip has none of its own and its words arrived from Vision's OCR —
    G3 found `dean`, `hines` and `nrao` in the flow that way."""
    stamp = glyphs("Dean Hines", 320, 340, angle=4.71)
    body = column(["Body text here."], 72, 700)
    regions = layout(
        ((70, 695, 300, 712), "Body text here."),
        ((310, 330, 500, 352), "Dean Hines"),
        ((320, 335, 480, 350), ""),
    )
    result = build_page_text(0, stamp + body, regions, [], PAGE)
    assert texts(result) == ["Body text here."]
    assert result.vision_regions == 0


def test_vision_splitting_a_line_in_two_is_one_paragraph():
    chars = glyphs("The dominant models are", 72, 700) + glyphs("mechanism.", 72, 686) + glyphs("We propose a new", 150, 686)
    result = build_page_text(0, chars, layout(((70, 684, 300, 712), ""), ((148, 684, 400, 698), "")), [], PAGE)
    assert texts(result) == ["The dominant models are mechanism. We propose a new"]


def test_a_sentence_continuing_into_the_next_column_is_one_paragraph():
    left = column(["Kepler was born to a poor"], 72, 100)
    right = column(["family in a region."], 320, 700)
    result = build_page_text(0, left + right, layout(((70, 95, 250, 112), ""), ((318, 695, 500, 712), "")), [], PAGE)
    assert texts(result) == ["Kepler was born to a poor family in a region."]


def test_a_smaller_caption_never_swallows_the_body_after_it():
    caption = glyphs("Figure 1 A caption without stop", 72, 500, size=8)
    body = glyphs("continues the body.", 72, 450)
    result = build_page_text(0, caption + body, layout(((70, 495, 300, 510), ""), ((70, 445, 300, 460), "")), [], PAGE)
    assert len(result.blocks) == 2


def test_a_table_replaces_the_paragraphs_inside_it():
    intro = glyphs("Times and temperatures.", 72, 700)
    cells = glyphs("fish", 72, 600) + glyphs("63", 200, 600) + glyphs("eggs", 72, 586) + glyphs("57", 200, 586)
    table = Table(
        (70, 580, 260, 612),
        (
            TableCell(0, 0, 1, 1, (70, 596, 150, 612), "fish"),
            TableCell(0, 1, 1, 1, (190, 596, 260, 612), "63"),
            TableCell(1, 0, 1, 1, (70, 580, 150, 596), "eggs"),
            TableCell(1, 1, 1, 1, (190, 580, 260, 596), "57"),
        ),
    )
    regions = layout(((70, 695, 300, 712), ""), ((70, 596, 150, 612), "fish"), ((190, 596, 260, 612), "63"), tables=[table])
    result = build_page_text(0, intro + cells, regions, [], PAGE)
    assert [b.kind for b in result.blocks] == ["para", "table"]
    assert result.blocks[1].rows == [["fish", "63"], ["eggs", "57"]]


def test_a_written_figure_swallows_its_label_and_records_it():
    body = glyphs("Body text here.", 72, 700)
    label = glyphs("Label inside", 320, 340)
    result = build_page_text(
        0, body + label, layout(((70, 695, 300, 712), ""), ((310, 335, 480, 352), "Label inside")), [(300, 300, 500, 390)], PAGE
    )
    assert texts(result) == ["Body text here."]
    assert result.dropped_text == ["Label inside"]


def test_a_page_vision_failed_on_reads_as_one_region():
    chars = column(["First line.", "Second line."], 72, 700)
    result = build_page_text(0, chars, PageLayout(page=1, error="vision: boom"), [], PAGE)
    assert texts(result) == ["First line. Second line."]


def test_char_outside_every_region_is_an_orphan():
    chars = glyphs("Body.", 72, 700) + [Char("x", 900, 900, 905, 907, size=10)]
    result = build_page_text(0, chars, layout(((70, 695, 300, 712), "")), [], PAGE)
    assert texts(result) == ["Body."] and result.orphans == 1


def test_a_garbage_text_layer_region_reads_from_vision_and_is_counted():
    chars = glyphs("Hl'n t' I hi' h.!'> to ld tlw moiL•cular", 72, 700)
    result = build_page_text(0, chars, layout(((70, 695, 400, 712), "Herve This has told the story of molecular")), [], PAGE)
    assert texts(result) == ["Herve This has told the story of molecular"]
    assert result.blocks[0].source == "vision" and result.vision_regions == 1


def test_block_size_and_boldness_come_from_its_characters():
    chars = glyphs("A Bold Heading", 72, 740, size=18, bold=True)
    block = build_page_text(0, chars, layout(((70, 735, 300, 760), "")), [], PAGE).blocks[0]
    assert (block.size, block.bold, block.lines) == (18.0, True, 1)
