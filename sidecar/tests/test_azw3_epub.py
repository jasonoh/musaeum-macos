import zipfile

import pytest

from conversion.azw3.epub import read_epub, resolve
from tests.azw3_kf8 import CONTAINER, build_epub, xhtml


def test_resolve_follows_relative_paths_and_keeps_the_fragment():
    assert resolve("OEBPS/text/c1.xhtml", "../images/a.jpg") == "OEBPS/images/a.jpg"
    assert resolve("OEBPS/text/c1.xhtml", "c2.xhtml#note%201") == "OEBPS/text/c2.xhtml#note 1"
    assert resolve("OEBPS/text/c1.xhtml", "#top") == "OEBPS/text/c1.xhtml#top"


def test_the_spine_cover_toc_and_guide_are_read(tmp_path):
    path = build_epub(
        tmp_path / "b.epub",
        chapters=[("c1.xhtml", xhtml("<p>one</p>")), ("c2.xhtml", xhtml("<p>two</p>"))],
        toc=[("One", "c1.xhtml", [("Inner", "c1.xhtml#x", [])]), ("Two", "c2.xhtml", [])],
        images={"cover.jpg": b"\xff\xd8\xff\xe0jpeg"},
        cover="cover.jpg",
        guide=[("toc", "Contents", "c2.xhtml")],
    )
    epub = read_epub(str(path))
    assert epub.spine == ["OEBPS/c1.xhtml", "OEBPS/c2.xhtml"]
    assert epub.cover == "OEBPS/cover.jpg"
    assert epub.media_types["OEBPS/cover.jpg"] == "image/jpeg"
    assert [(e.title, e.href, [c.title for c in e.children]) for e in epub.toc] == [
        ("One", "OEBPS/c1.xhtml", ["Inner"]),
        ("Two", "OEBPS/c2.xhtml", []),
    ]
    assert epub.toc[0].children[0].href == "OEBPS/c1.xhtml#x"
    assert epub.guide == [("toc", "Contents", "OEBPS/c2.xhtml")]
    assert epub.metadata["title"] == "Test Book"
    assert epub.metadata["authors"][0]["name"] == "Ann Author"


def test_an_epub3_nav_is_preferred_and_unlinked_headings_keep_their_children(tmp_path):
    path = build_epub(tmp_path / "b.epub", chapters=[("c1.xhtml", xhtml("<p>one</p>"))], toc=[("From NCX", "c1.xhtml", [])])
    nav = xhtml(
        '<nav epub:type="toc"><ol><li><a href="c1.xhtml">From &amp; nav</a>'
        '<ol><li><span>Heading</span><ol><li><a href="c1.xhtml#a">Deep</a></li></ol></li></ol>'
        "</li></ol></nav>"
    )
    with zipfile.ZipFile(path, "a") as z:
        z.writestr("OEBPS/nav.xhtml", nav)
    rewrite_opf(path, '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
    epub = read_epub(str(path))
    assert [(e.title, [c.title for c in e.children]) for e in epub.toc] == [("From & nav", ["Deep"])]


def test_a_missing_member_is_a_warning_and_an_empty_spine_is_an_error(tmp_path):
    path = build_epub(tmp_path / "b.epub", chapters=[("c1.xhtml", xhtml("<p>one</p>"))])
    rewrite_opf(path, '<item id="gone" href="gone.jpg" media-type="image/jpeg"/>')
    assert any("gone.jpg" in w for w in read_epub(str(path)).warnings)

    empty = tmp_path / "empty.epub"
    with zipfile.ZipFile(empty, "w") as z:
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr(
            "OEBPS/content.opf",
            '<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata/><manifest/><spine/></package>',
        )
    with pytest.raises(ValueError):
        read_epub(str(empty))


def rewrite_opf(path, extra_manifest_item: str) -> None:
    """Rebuild the zip with one more manifest item in the OPF."""
    with zipfile.ZipFile(path) as z:
        members = {name: z.read(name) for name in z.namelist()}
    opf = members["OEBPS/content.opf"].decode()
    members["OEBPS/content.opf"] = opf.replace("<manifest>", "<manifest>" + extra_manifest_item).encode()
    with zipfile.ZipFile(path, "w") as z:
        for name, data in members.items():
            z.writestr(name, data)


# --- final review: a TOC that cannot be parsed degrades, it does not fail the book


def replace_member(path, name: str, data: bytes) -> None:
    with zipfile.ZipFile(path) as z:
        members = {n: z.read(n) for n in z.namelist()}
    members[name] = data
    with zipfile.ZipFile(path, "w") as z:
        for n, d in members.items():
            z.writestr(n, d)


@pytest.mark.parametrize(
    "ncx",
    [
        b'<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>x</navLabel></navPoint></navMap></ncx>',
        b'<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>a&nbsp;b</text></navLabel><content src="c1.xhtml"/></navPoint></navMap></ncx>',
        b"\x00\x01 encrypted bytes, not XML at all",
    ],
)
def test_a_table_of_contents_that_cannot_be_parsed_is_empty_with_a_warning(tmp_path, ncx):
    path = build_epub(tmp_path / "b.epub", chapters=[("c1.xhtml", xhtml("<p>one</p>"))])
    replace_member(path, "OEBPS/toc.ncx", ncx)
    epub = read_epub(str(path))
    assert epub.toc == []
    assert any("table of contents" in w and "toc.ncx" in w for w in epub.warnings)


# --- a DRM-encrypted EPUB fails with its real reason, not an XML error from inside it

ADOBE_ENCRYPTION = (
    '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">'
    '<enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>'
    '<enc:CipherData><enc:CipherReference URI="OEBPS/c1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>'
)
FONT_OBFUSCATION = ADOBE_ENCRYPTION.replace("http://www.w3.org/2001/04/xmlenc#aes128-cbc", "http://www.idpf.org/2008/embedding").replace("OEBPS/c1.xhtml", "OEBPS/f.otf")


def test_a_drm_encrypted_epub_is_refused_with_the_reason(tmp_path):
    path = build_epub(tmp_path / "b.epub", chapters=[("c1.xhtml", xhtml("<p>one</p>"))])
    replace_member(path, "META-INF/encryption.xml", ADOBE_ENCRYPTION.encode())
    with pytest.raises(ValueError, match="encrypted"):
        read_epub(str(path))


def test_font_obfuscation_alone_is_not_drm(tmp_path):
    path = build_epub(tmp_path / "b.epub", chapters=[("c1.xhtml", xhtml("<p>one</p>"))])
    replace_member(path, "META-INF/encryption.xml", FONT_OBFUSCATION.encode())
    assert read_epub(str(path)).spine == ["OEBPS/c1.xhtml"]
