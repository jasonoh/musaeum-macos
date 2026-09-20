"""The description rule, in isolation.

`html_to_text` is what stands between a source's HTML and the text a reader
sees, so these cases are written against the exact junk the real library
holds: Calibre `comments` (`<div><p>`, `<h1>`, `&#8212;` — 2,781 rows held a
`<p>` before this rule, 1,320 a `<br>`) and OPF descriptions that arrived
double-escaped.

The two properties worth pinning separately are the ones a naive strip gets
wrong: a block boundary has to become a newline (dropping it welds two
paragraphs onto one line), and a `<` that is arithmetic rather than markup has
to survive.
"""

from extractors.html_text import html_to_text


def test_block_boundaries_become_paragraph_breaks():
    assert html_to_text("<p>First para.</p><p>Second para.</p>") == "First para.\nSecond para."


def test_br_is_a_line_break_and_inline_tags_are_dropped():
    assert (
        html_to_text("Line one<br/>Line <b>two</b><br />Line <i>three</i>")
        == "Line one\nLine two\nLine three"
    )


def test_calibre_style_comment_is_plain_text():
    assert (
        html_to_text('<div><p>WINNER OF THE PRIZE</p><h1>Bestseller</h1></div>')
        == "WINNER OF THE PRIZE\nBestseller"
    )


def test_entities_are_decoded():
    assert html_to_text("Reese Witherspoon&#8212;and more&nbsp;&amp;&nbsp;more") == (
        "Reese Witherspoon—and more & more"
    )


def test_double_escaped_markup_is_resolved():
    # What a double-escaped OPF yields after one XML decode. Both boundary
    # tags land, and two adjacent boundaries are a blank line — that is what
    # `</p><br>` asks for, and the rule preserves it rather than guessing.
    assert html_to_text("&lt;p&gt;A blurb&lt;/p&gt;&lt;br&gt;More") == "A blurb\n\nMore"


def test_triple_escaped_markup_is_resolved():
    # The deepest escape measured in the real library, verbatim: the inner tag
    # only surfaces on the third pass, so a two-pass rule leaves it visible
    assert html_to_text(
        "<p>&amp;lt;p&amp;gt;Award-winning cookbook author Eileen Yin-Fei Lo"
    ) == "Award-winning cookbook author Eileen Yin-Fei Lo"


def test_arithmetic_is_not_markup():
    assert html_to_text("Cheaper than 5 < 6 and 7 > 2, honestly") == (
        "Cheaper than 5 < 6 and 7 > 2, honestly"
    )


def test_plain_text_is_unchanged():
    plain = "A blurb with no markup.\n\nA second paragraph."
    assert html_to_text(plain) == plain


def test_whitespace_is_tidied():
    assert html_to_text("  <p>Trailing space   </p>\n\n\n\n<p>Next</p>  ") == (
        "Trailing space\n\nNext"
    )


def test_empty_and_none_are_empty():
    assert html_to_text("") == ""
    assert html_to_text(None) == ""
