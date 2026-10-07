"""One spine file → its KF8 skeleton and fragment, in ASCII (spec Annex A, *Text markup*).

The skeleton is the file's <html>…<body> shell with an empty body; the
fragment is the body's content, inserted just before </body>. Everything is
serialized as ASCII — non-ASCII characters become numeric references, the form
measured in a kindlegen file — so a text record cut at exactly 4,096 bytes can
never split a character (spec, *Device experiments*).
"""

import codecs
import html
import re
from dataclasses import dataclass, field
from html.entities import name2codepoint
from typing import Protocol
from urllib.parse import urlparse

import lxml.html
from lxml import etree

from .epub import resolve

BASE32 = "0123456789ABCDEFGHIJKLMNOPQRSTUV"
XHTML_NS = "http://www.w3.org/1999/xhtml"
XML_NS = "http://www.w3.org/XML/1998/namespace"
XLINK_NS = "http://www.w3.org/1999/xlink"
DECLARATION = b'<?xml version="1.0" encoding="UTF-8"?>\n'
HTML_OPEN = b'<html xmlns="http://www.w3.org/1999/xhtml">'
LINK_PLACEHOLDER = "kindle:pos:fid:0000:off:0000000000"  # fixed width: patched in place later
BLOCK_TAGS = frozenset(
    "address article aside blockquote body dd div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 "
    "header hr li nav ol p pre section table tbody td tfoot th thead tr ul".split()
)
XML_ENTITIES = frozenset({"amp", "lt", "gt", "quot", "apos"})


def base32(value: int) -> str:
    """Digits 0-9A-V, as few as the value needs (an `aid`)."""
    if value < 0:
        raise ValueError("base 32 here is unsigned")
    digits = ""
    while value:
        value, digit = divmod(value, 32)
        digits = BASE32[digit] + digits
    return digits or "0"


def fixed_base32(value: int, width: int) -> str:
    """Zero-padded to `width` digits (flow, embed and position numbers)."""
    digits = base32(value).rjust(width, "0")
    if len(digits) > width:
        raise ValueError(f"{value} needs more than {width} base-32 digits")
    return digits


class Resolver(Protocol):
    def stylesheet(self, path: str) -> int | None: ...  # 1-based flow number
    def image(self, path: str) -> tuple[int, str] | None: ...  # 1-based resource number, MIME type


@dataclass
class Link:
    at: int  # byte offset of the placeholder inside the fragment
    target: str  # zip path, with any '#id'


@dataclass
class Part:
    path: str
    skeleton: bytes
    fragment: bytes
    insert_offset: int  # where the fragment goes inside the skeleton (just before </body>)
    selector: str
    anchors: dict[str, int]  # element id -> offset of that element's start tag in the fragment
    links: list[Link]
    warnings: list[str] = field(default_factory=list)


class Aids:
    """The book-wide `aid` counter: one base-32 value per block element."""

    def __init__(self) -> None:
        self.count = 0

    def next(self) -> str:
        value = base32(self.count)
        self.count += 1
        return value


def _decode(data: bytes) -> str:
    """Text from bytes. A BOM or an XML declaration is authoritative; otherwise valid UTF-8 is UTF-8.

    A `<meta charset>` is only a hint, and publishers get it wrong (a file declaring
    iso-8859-1 over UTF-8 bytes is common), so it is used only for bytes that are not
    valid UTF-8, with Windows-1252 as the last resort.
    """
    if data.startswith(codecs.BOM_UTF8):
        return data[3:].decode("utf-8", "replace")
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return data.decode("utf-16", "replace")
    head = data[:1024].decode("ascii", "replace")
    declared = re.search(r"""<\?xml[^>]*encoding=["']([\w.:-]+)""", head)
    if declared:
        try:
            return data.decode(declared.group(1), "replace")
        except LookupError:
            pass
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    meta = re.search(r"""<meta[^>]*charset=["']?([\w.:-]+)""", head, re.IGNORECASE)
    try:
        return data.decode(meta.group(1) if meta else "cp1252", "replace")
    except LookupError:
        return data.decode("cp1252", "replace")


def _normalise(root: etree._Element) -> None:
    """Plain tag names; no namespaced attributes (epub:type and friends); no `aid` of the source's own."""
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        if el.tag.startswith(f"{{{XHTML_NS}}}"):
            el.tag = el.tag[len(XHTML_NS) + 2 :]
        elif ":" in el.tag and not el.tag.startswith("{"):
            el.tag = el.tag.rsplit(":", 1)[1]  # an HTML parser keeps `svg:svg` as one name
        for name in list(el.attrib):
            if name == "aid":
                del el.attrib[name]
            elif name == "xlink:href":  # an HTML parser's spelling of the namespaced attribute
                el.set(f"{{{XLINK_NS}}}href", el.attrib.pop(name))
            elif ":" in name and not name.startswith("{"):
                del el.attrib[name]
            elif name.startswith("{") and not name.startswith((f"{{{XML_NS}}}", f"{{{XLINK_NS}}}")):
                del el.attrib[name]
    etree.cleanup_namespaces(root)


def _parse(data: bytes, warnings: list[str], path: str) -> etree._Element:
    """Strict XML when the file is well-formed; otherwise a real HTML parse, never a lossy recovery."""
    text = re.sub(r"^\s*<\?xml[^>]*\?>", "", _decode(data).lstrip("\ufeff"))
    text = re.sub(r"<!DOCTYPE[^>\[]*(\[[^\]]*\])?\s*>", "", text, flags=re.IGNORECASE)
    # HTML's named entities are not XML's: write them as numbers before parsing.
    xml_text = re.sub(
        r"&([A-Za-z][A-Za-z0-9]*);",
        lambda m: m.group(0) if m.group(1) in XML_ENTITIES or m.group(1) not in name2codepoint
        else f"&#{name2codepoint[m.group(1)]};",
        text,
    )
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False, huge_tree=False)
    try:
        root = etree.fromstring(xml_text.encode("utf-8"), parser)
        _normalise(root)  # strips the XHTML namespace, so <body> can be found by its plain name
        if root.find("body") is not None:
            return root
    except etree.XMLSyntaxError:
        pass
    warnings.append(f"{path}: not well-formed XHTML; parsed as HTML")
    root = lxml.html.document_fromstring(text)
    _normalise(root)
    return root


def _remove(el: etree._Element) -> None:
    """Drop an element, keeping its tail text."""
    parent = el.getparent()
    if el.tail:
        previous = el.getprevious()
        if previous is not None:
            previous.tail = (previous.tail or "") + el.tail
        else:
            parent.text = (parent.text or "") + el.tail
    parent.remove(el)


def _ascii(text: str) -> bytes:
    return html.escape(text, quote=False).encode("ascii", "xmlcharrefreplace")


def _embed(el: etree._Element, path: str, resolver: Resolver, warnings: list[str]) -> bool:
    """Point an image at its resource record; False when the book does not hold it."""
    for attr in ("src", f"{{{XLINK_NS}}}href", "href"):
        ref = el.get(attr)
        if ref:
            found = resolver.image(resolve(path, ref))
            if found is None:
                warnings.append(f"{path}: dropped an image that is not in the book: {ref}")
                return False
            el.set(attr, f"kindle:embed:{fixed_base32(found[0], 4)}?mime={found[1]}")
            return True
    return True


def build_part(path: str, data: bytes, aids: Aids, resolver: Resolver) -> Part:
    warnings: list[str] = []
    root = _parse(data, warnings, path)
    for el in list(root.iter(etree.Comment, etree.ProcessingInstruction, "script")):
        _remove(el)
    head = root.find("head")
    body = root.find("body")
    if body is None:
        raise ValueError(f"{path} has no <body>")

    for link in list(head.iter("link")) if head is not None else []:
        flow = resolver.stylesheet(resolve(path, link.get("href", ""))) if "stylesheet" in (link.get("rel") or "") else None
        if flow is None:
            _remove(link)
        else:
            link.attrib.clear()
            link.set("href", f"kindle:flow:{fixed_base32(flow, 4)}?mime=text/css")
            link.set("rel", "stylesheet")
            link.set("type", "text/css")

    for el in list(body.iter()):
        if isinstance(el.tag, str) and etree.QName(el).localname in ("img", "image") and not _embed(el, path, resolver, warnings):
            if el.getparent() is not None:
                _remove(el)  # takes anything inside it along; links are counted after this

    targets: list[str] = []
    body.set("aid", aids.next())
    for el in body.iter():
        if el is body or not isinstance(el.tag, str):
            continue
        local = etree.QName(el).localname
        if local == "a" and el.get("href") and not urlparse(el.get("href")).scheme:
            targets.append(resolve(path, el.get("href")))
            el.set("href", LINK_PLACEHOLDER)
        if local in BLOCK_TAGS or el.get("id") or (local == "a" and el.get("name")):
            el.set("aid", aids.next())

    fragment = _ascii(body.text or "") + b"".join(
        etree.tostring(child, encoding="ascii", with_tail=True) for child in body
    )
    shell = etree.Element("body", dict(body.attrib))
    shell.text = ""
    head_bytes = etree.tostring(head, encoding="ascii") if head is not None else b"<head></head>"
    opening = DECLARATION + HTML_OPEN + head_bytes
    body_shell = etree.tostring(shell, encoding="ascii")
    skeleton = opening + body_shell + b"</html>"
    insert_offset = len(opening) + body_shell.index(b"</body>")

    # Only a placeholder standing as an href value is a link; book text that happens to
    # look like one is not.
    placeholder = b'href="' + LINK_PLACEHOLDER.encode() + b'"'
    starts, at = [], fragment.find(placeholder)
    while at != -1:
        starts.append(at + len(b'href="'))
        at = fragment.find(placeholder, at + 1)
    if len(starts) != len(targets):
        raise ValueError(f"{path}: {len(targets)} links but {len(starts)} placeholders")

    anchors: dict[str, int] = {}
    for el in body.iter():
        anchor = el.get("id") or (el.get("name") if el.tag == "a" else None)
        if anchor and el is not body and anchor not in anchors:
            match = re.search(rb'\said="' + el.get("aid").encode() + rb'"', fragment)
            anchors[anchor] = fragment.rindex(b"<", 0, match.start())
    if body.get("id"):
        anchors.setdefault(body.get("id"), 0)

    return Part(
        path=path,
        skeleton=skeleton,
        fragment=fragment,
        insert_offset=insert_offset,
        selector=f"P-//*[@aid='{body.get('aid')}']",
        anchors=anchors,
        links=[Link(at, target) for at, target in zip(starts, targets)],
        warnings=warnings,
    )


def css_flow(path: str, data: bytes) -> tuple[bytes, list[str]]:
    """A stylesheet as an ASCII flow. Embedded fonts are out of scope (spec D4) and dropped."""
    text = data.decode("utf-8", "replace")
    warnings = []
    without_fonts = re.sub(r"@font-face\s*\{[^}]*\}", "", text, flags=re.IGNORECASE)
    if without_fonts != text:
        warnings.append(f"{path}: dropped @font-face rules (embedded fonts are out of scope)")
    text = re.sub(r"@import[^;]*;", "", without_fonts, flags=re.IGNORECASE)
    escaped = "".join(c if ord(c) < 0x80 else f"\\{ord(c):X} " for c in text)
    return escaped.encode("ascii"), warnings
