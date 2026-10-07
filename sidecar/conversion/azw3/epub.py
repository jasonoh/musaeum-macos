"""The parts of an EPUB the KF8 writer needs: reading order, members, cover, TOC and guide."""

import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from urllib.parse import unquote, urldefrag

import defusedxml.ElementTree as ET
import lxml.html

from extractors.epub_metadata import (
    MAX_XML_MEMBER_SIZE,
    NS,
    _opf_path,
    _read_capped,
    extract_epub_metadata,
)

MAX_MEMBER_BYTES = 50 * 1024 * 1024  # one chapter or image; the zip is untrusted input
NCX_NS = "http://www.daisy.org/z3986/2005/ncx/"
# Font obfuscation is not DRM: the fonts are dropped anyway (spec D4).
FONT_OBFUSCATION = ("http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC")


@dataclass
class TocEntry:
    title: str
    href: str  # zip path, with any '#fragment'
    children: list["TocEntry"] = field(default_factory=list)


@dataclass
class Epub:
    metadata: dict
    spine: list[str]  # zip paths, in reading order
    files: dict[str, bytes]  # every manifest member that could be read, by zip path
    media_types: dict[str, str]
    cover: str | None
    toc: list[TocEntry]
    guide: list[tuple[str, str, str]]  # (type, title, href)
    warnings: list[str] = field(default_factory=list)


def resolve(base_file: str, href: str) -> str:
    """A zip path for `href` as written inside `base_file`, keeping any '#fragment'."""
    path, fragment = urldefrag(href)
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(base_file), unquote(path))) if path else base_file
    return f"{joined}#{unquote(fragment)}" if fragment else joined


def _refuse_drm(z: zipfile.ZipFile) -> None:
    if "META-INF/encryption.xml" not in z.namelist():
        return
    declared = _read_capped(z, "META-INF/encryption.xml", MAX_XML_MEMBER_SIZE).decode("utf-8", "replace")
    algorithms = set(re.findall(r"""Algorithm=["']([^"']+)""", declared))
    if algorithms - set(FONT_OBFUSCATION):
        raise ValueError("the EPUB is encrypted (DRM) and cannot be converted")


def read_epub(path: str) -> Epub:
    with zipfile.ZipFile(path) as z:
        _refuse_drm(z)
        opf_path = _opf_path(z)
        opf = ET.fromstring(_read_capped(z, opf_path, MAX_XML_MEMBER_SIZE))
        warnings: list[str] = []
        items: dict[str, tuple[str, str, str]] = {}  # id -> (zip path, media type, properties)
        manifest = opf.find("opf:manifest", NS)
        for item in manifest.findall("opf:item", NS) if manifest is not None else []:
            href, item_id = item.get("href"), item.get("id")
            if href and item_id:
                items[item_id] = (resolve(opf_path, href), item.get("media-type") or "", item.get("properties") or "")
        files: dict[str, bytes] = {}
        for zip_path, _, _ in items.values():
            try:
                files[zip_path] = _read_capped(z, zip_path, MAX_MEMBER_BYTES)
            except (KeyError, ValueError) as error:
                warnings.append(f"skipped {zip_path}: {error}")

    media_types = {p: m for p, m, _ in items.values()}
    spine_el = opf.find("opf:spine", NS)
    spine = [
        items[ref.get("idref")][0]
        for ref in (spine_el.findall("opf:itemref", NS) if spine_el is not None else [])
        if ref.get("idref") in items and items[ref.get("idref")][0] in files
    ]
    if not spine:
        raise ValueError("the EPUB has no readable spine")

    cover = None
    metadata_el = opf.find("opf:metadata", NS)
    cover_id = next(
        (m.get("content") for m in (metadata_el.findall("opf:meta", NS) if metadata_el is not None else []) if m.get("name") == "cover"),
        None,
    )
    for item_id, (zip_path, media_type, properties) in items.items():
        if (item_id == cover_id or "cover-image" in properties.split()) and media_type.startswith("image/") and zip_path in files:
            cover = zip_path
            break

    toc = _nav_toc(items, files, warnings) or _ncx_toc(items, files, spine_el, warnings)
    guide_el = opf.find("opf:guide", NS)
    guide = [
        (ref.get("type") or "", ref.get("title") or ref.get("type") or "", resolve(opf_path, ref.get("href")))
        for ref in (guide_el.findall("opf:reference", NS) if guide_el is not None else [])
        if ref.get("type") and ref.get("href")
    ]
    return Epub(extract_epub_metadata(path), spine, files, media_types, cover, toc, guide, warnings)


def _nav_toc(items: dict[str, tuple[str, str, str]], files: dict[str, bytes], warnings: list[str]) -> list[TocEntry]:
    nav_path = next((p for p, _, props in items.values() if "nav" in props.split() and p in files), None)
    if nav_path is None:
        return []
    try:
        doc = lxml.html.document_fromstring(files[nav_path])
        nav = next((n for n in doc.iter("nav") if n.get("epub:type") == "toc"), None)
        ol = nav.find(".//ol") if nav is not None else None
        return _nav_list(ol, nav_path) if ol is not None else []
    except Exception as error:
        warnings.append(_toc_warning(nav_path, error))
        return []


def _nav_list(ol, nav_path: str) -> list[TocEntry]:
    entries = []
    for li in ol.findall("li"):
        link = li.find("a")
        title = " ".join((link if link is not None else li).text_content().split())
        children = _nav_list(li.find("ol"), nav_path) if li.find("ol") is not None else []
        if link is not None and link.get("href"):
            entries.append(TocEntry(title, resolve(nav_path, link.get("href")), children))
        else:
            entries.extend(children)  # an unlinked heading: keep what is under it
    return entries


def _ncx_toc(items: dict[str, tuple[str, str, str]], files: dict[str, bytes], spine_el, warnings: list[str]) -> list[TocEntry]:
    ncx_id = spine_el.get("toc") if spine_el is not None else None
    ncx_path = items[ncx_id][0] if ncx_id in items else next(
        (p for p, m, _ in items.values() if m == "application/x-dtbncx+xml"), None
    )
    if ncx_path is None or ncx_path not in files:
        return []
    try:
        root = ET.fromstring(files[ncx_path])
        nav_map = root.find(f"{{{NCX_NS}}}navMap")
        return _ncx_points(nav_map, ncx_path) if nav_map is not None else []
    except Exception as error:  # malformed, or encrypted by the publisher
        warnings.append(_toc_warning(ncx_path, error))
        return []


def _toc_warning(path: str, error: Exception) -> str:
    return f"table of contents {path} could not be read ({type(error).__name__}); the book gets a single entry"


def _ncx_points(parent, ncx_path: str) -> list[TocEntry]:
    entries = []
    for point in parent.findall(f"{{{NCX_NS}}}navPoint"):
        label = point.find(f"{{{NCX_NS}}}navLabel/{{{NCX_NS}}}text")
        content = point.find(f"{{{NCX_NS}}}content")
        title = " ".join((label.text or "").split()) if label is not None else ""
        children = _ncx_points(point, ncx_path)
        if content is not None and content.get("src"):
            entries.append(TocEntry(title, resolve(ncx_path, content.get("src")), children))
        else:
            entries.extend(children)
    return entries
