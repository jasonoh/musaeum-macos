import re

import pytest

from conversion.azw3.markup import Aids, base32, build_part, css_flow, fixed_base32
from tests.azw3_kf8 import xhtml


class FakeResolver:
    def __init__(self, sheets=(), images=None):
        self.sheets = list(sheets)
        self.images = images or {}

    def stylesheet(self, path):
        return self.sheets.index(path) + 1 if path in self.sheets else None

    def image(self, path):
        return self.images.get(path)


def part(body: str, head: str = "", resolver=None, aids=None):
    return build_part("OEBPS/text/c1.xhtml", xhtml(body, head=head).encode(), aids or Aids(), resolver or FakeResolver())


def test_base32_uses_digits_0_to_v():
    assert [base32(v) for v in (0, 9, 10, 31, 32, 57)] == ["0", "9", "A", "V", "10", "1P"]
    assert fixed_base32(57, 10) == "000000001P"
    with pytest.raises(ValueError):
        fixed_base32(32**4, 4)


def test_the_skeleton_is_the_shell_and_the_fragment_goes_before_body_close():
    p = part("<p>Hello</p>")
    assert p.skeleton.startswith(b'<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head>')
    assert p.skeleton.endswith(b'<body aid="0"></body></html>')
    assert p.skeleton[p.insert_offset :] == b"</body></html>"
    assert p.fragment == b'<p aid="1">Hello</p>'
    assert p.selector == "P-//*[@aid='0']"


def test_the_markup_is_ascii_with_numeric_references():
    p = part("<p>“Café”&nbsp;&mdash; &amp; &lt;</p>")
    assert p.fragment.isascii() and p.skeleton.isascii()
    assert p.fragment == b'<p aid="1">&#8220;Caf&#233;&#8221;&#160;&#8212; &amp; &lt;</p>'


def test_xhtml_self_closing_elements_stay_empty():
    p = part('<p>a<a id="x"/>b</p><div class="gap"/><p>c</p>')
    assert b'<a id="x" aid="2"/>b</p><div class="gap" aid="3"/><p aid="4">c</p>' in p.fragment


def test_aids_run_across_the_book_and_mark_blocks_and_anchors_only():
    aids = Aids()
    first = part("<p>one <em>two</em></p>", aids=aids)
    second = part('<div><span id="s">x</span></div>', aids=aids)
    assert first.fragment == b'<p aid="1">one <em>two</em></p>'
    assert second.selector == "P-//*[@aid='2']"
    assert second.fragment == b'<div aid="3"><span id="s" aid="4">x</span></div>'


def test_anchors_point_at_the_start_tag_of_their_element():
    p = part('<h1>Title</h1><p>text <span id="mid">here</span></p><a name="old">x</a>')
    for anchor, tag in (("mid", b"<span"), ("old", b"<a")):
        assert p.fragment[p.anchors[anchor] :].startswith(tag)
        assert anchor.encode() in p.fragment[p.anchors[anchor] :].split(b">")[0]


def test_internal_links_become_fixed_width_placeholders_and_external_ones_stay():
    p = part('<p><a href="c2.xhtml#n1">1</a> <a href="#top">t</a> <a href="https://x.org/">w</a></p>')
    assert [link.target for link in p.links] == ["OEBPS/text/c2.xhtml#n1", "OEBPS/text/c1.xhtml#top"]
    for link in p.links:
        assert p.fragment[link.at : link.at + 34] == b"kindle:pos:fid:0000:off:0000000000"
    assert b'href="https://x.org/"' in p.fragment


def test_stylesheets_become_flows_and_unknown_links_are_dropped():
    resolver = FakeResolver(sheets=["OEBPS/css/a.css"])
    p = part("<p>x</p>", head='<link rel="stylesheet" href="../css/a.css"/><link rel="stylesheet" href="gone.css"/>', resolver=resolver)
    assert b'<link href="kindle:flow:0001?mime=text/css" rel="stylesheet" type="text/css"/>' in p.skeleton
    assert b"gone.css" not in p.skeleton


def test_images_are_embedded_by_number_and_missing_ones_are_dropped_with_a_warning():
    resolver = FakeResolver(images={"OEBPS/img/a.jpg": (1, "image/jpeg")})
    p = part('<p><img src="../img/a.jpg" alt=""/>after<img src="../img/gone.png"/>tail</p>', resolver=resolver)
    assert b'<img src="kindle:embed:0001?mime=image/jpeg" alt=""/>after' in p.fragment
    assert b"gone.png" not in p.fragment and b"aftertail" in p.fragment
    assert any("gone.png" in w for w in p.warnings)


def test_svg_images_keep_their_xlink_reference():
    resolver = FakeResolver(images={"OEBPS/img/a.jpg": (2, "image/jpeg")})
    body = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../img/a.jpg"/></svg>'
    p = part(body, resolver=resolver)
    assert re.search(rb'href="kindle:embed:0002\?mime=image/jpeg"', p.fragment)


def test_scripts_comments_and_epub_attributes_are_removed():
    p = part('<p epub:type="bodymatter">a<!-- note -->b</p><script>alert(1)</script>')
    assert p.fragment == b'<p aid="1">ab</p>'


def test_a_file_without_a_body_is_refused():
    with pytest.raises(ValueError):
        build_part("x.xhtml", b'<html xmlns="http://www.w3.org/1999/xhtml"><head/></html>', Aids(), FakeResolver())


def test_css_is_ascii_and_embedded_fonts_are_dropped_with_a_warning():
    flow, warnings = css_flow("s.css", "p::before { content: '—' } @font-face { src: url(f.ttf) } h1 { x: 1 }".encode())
    assert flow == b"p::before { content: '\\2014 ' }  h1 { x: 1 }"
    assert warnings == ["s.css: dropped @font-face rules (embedded fonts are out of scope)"]


# --- final review: malformed publisher markup must keep its text, and links/anchors must stay honest


def raw_part(data: bytes, resolver=None):
    return build_part("OEBPS/text/c1.xhtml", data, Aids(), resolver or FakeResolver())


def test_an_html5_file_with_an_unclosed_meta_still_has_its_body():
    p = raw_part(b'<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><p>Cover</p></body></html>')
    assert p.fragment == b'<p aid="1">Cover</p>'
    assert any("HTML" in w for w in p.warnings)


@pytest.mark.parametrize(
    "markup, expected",
    [
        (b"<html><body><p>AT&T and a < b</p></body></html>", b"<p aid=\"1\">AT&amp;T and a &lt; b</p>"),
        (b"<html><body><p>line<br>two</p><p>third</p></body></html>", b'<p aid="1">line<br/>two</p><p aid="2">third</p>'),
    ],
)
def test_text_in_malformed_markup_is_kept_not_dropped(markup, expected):
    assert raw_part(markup).fragment == expected


def test_a_declared_non_utf8_encoding_is_honoured():
    latin = '<?xml version="1.0" encoding="iso-8859-1"?><html xmlns="http://www.w3.org/1999/xhtml"><head/><body><p>café</p></body></html>'
    assert raw_part(latin.encode("latin-1")).fragment == b'<p aid="1">caf&#233;</p>'
    utf16 = '<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><p>café</p></body></html>'.encode("utf-16")
    assert raw_part(utf16).fragment == b'<p aid="1">caf&#233;</p>'


def test_a_link_inside_an_image_that_is_dropped_does_not_unbalance_the_placeholders():
    # Well-formed XML can nest an element inside <img>; dropping the image takes it along.
    p = raw_part(b'<html><body><p><img src="gone.jpg"><a href="c2.xhtml">x</a></img></p><p><a href="#t">t</a></p></body></html>')
    assert len(p.links) == p.fragment.count(b"kindle:pos:fid:0000:off:0000000000") == 1
    assert p.links[0].target == "OEBPS/text/c1.xhtml#t"


def test_a_link_after_an_image_that_is_dropped_survives_an_html_parse():
    p = raw_part(b'<html><body><p><img src="gone.jpg"><a href="c2.xhtml">x</a></p></body></html>')
    assert [link.target for link in p.links] == ["OEBPS/text/c2.xhtml"]


def test_book_text_that_looks_like_a_link_placeholder_is_not_counted():
    p = part("<p>kindle:pos:fid:0000:off:0000000000 <a href=\"#a\">a</a></p>")
    assert len(p.links) == 1 and p.fragment[p.links[0].at : p.links[0].at + 34] == b"kindle:pos:fid:0000:off:0000000000"
    assert p.fragment.index(b"href=") < p.links[0].at


def test_aid_attributes_already_in_the_source_are_replaced_so_anchors_stay_true():
    p = part('<span aid="2">old</span><p>new</p><p id="t">target</p>')
    assert p.fragment[p.anchors["t"] :].startswith(b'<p id="t"')
    assert p.fragment == b'<span>old</span><p aid="1">new</p><p id="t" aid="2">target</p>'


# --- regression found re-running the gate books: well-formed XHTML must stay on the strict path


def test_well_formed_xhtml_is_parsed_strictly_with_no_html_fallback_warning():
    p = part("<p>Hello</p>")
    assert not any("HTML" in w for w in p.warnings)


def test_a_prefixed_svg_in_a_file_that_needs_the_html_fallback_does_not_crash():
    body = b'<html><body><p>AT&T</p><svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:image xlink:href="a.jpg"/></svg:svg></body></html>'
    p = raw_part(body)
    assert b"AT&amp;T" in p.fragment and b"svg:" not in p.fragment


def test_an_svg_spine_document_with_no_html_body_falls_back_instead_of_raising():
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><text>Cover</text></svg>'
    p = raw_part(svg)
    assert b"Cover" in p.fragment and any("HTML" in w for w in p.warnings)


def test_a_meta_charset_that_lies_does_not_override_valid_utf8():
    # Darwin's Devices: <meta charset=iso-8859-1> over UTF-8 bytes. Valid UTF-8 is UTF-8.
    doc = '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta content="text/html; charset=iso-8859-1" http-equiv="content-type"/></head><body><p>Darwin’s</p></body></html>'
    assert raw_part(doc.encode("utf-8")).fragment == b'<p aid="1">Darwin&#8217;s</p>'


def test_a_meta_charset_is_used_when_the_bytes_are_not_utf8():
    doc = '<html><head><meta charset="iso-8859-1"></head><body><p>café</p></body></html>'
    assert raw_part(doc.encode("latin-1")).fragment == b'<p aid="1">caf&#233;</p>'
    assert raw_part(b"<html><body><p>caf\xe9</p></body></html>").fragment == b'<p aid="1">caf&#233;</p>'  # no claim at all: cp1252
