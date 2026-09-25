"""Extract embedded metadata from an EPUB's OPF package document."""

import re
import zipfile
import defusedxml.ElementTree as ET
from typing import Optional

from extractors.html_text import html_to_text

try:
    import isbnlib
except ImportError:  # pragma: no cover — isbnlib is in requirements.txt
    isbnlib = None

NS = {
    "container": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
}

# EPUBs in the library are user-supplied, not app-authored, so the zip and the
# XML inside it are untrusted input. `defusedxml` blocks billion-laughs/XXE;
# these caps bound how much of a single member we'll ever hold in memory, so
# a lying or hostile size doesn't get to inflate that instead.
MAX_XML_MEMBER_SIZE = 5 * 1024 * 1024  # container.xml/OPF are small package text
MAX_COVER_IMAGE_SIZE = 50 * 1024 * 1024  # generous for a real embedded cover


def _read_capped(z: zipfile.ZipFile, name: str, max_size: int) -> bytes:
    """Read a zip member, bounded by `max_size` regardless of what its header claims.

    The declared `file_size` is checked first as a cheap rejection, but the
    actual read is *also* capped at `max_size + 1` bytes — a member whose
    header understates its real (decompressed) size can't ride that lie past
    the check and exhaust memory during the read itself.
    """
    info = z.getinfo(name)
    if info.file_size > max_size:
        raise ValueError(f"{name} exceeds the {max_size}-byte cap ({info.file_size} bytes)")
    with z.open(info) as f:
        data = f.read(max_size + 1)
    if len(data) > max_size:
        raise ValueError(f"{name} exceeded the {max_size}-byte cap while reading")
    return data


def _opf_path(z: zipfile.ZipFile) -> str:
    container = ET.fromstring(_read_capped(z, "META-INF/container.xml", MAX_XML_MEMBER_SIZE))
    rootfile = container.find(".//container:rootfile", NS)
    if rootfile is None:
        raise ValueError("EPUB has no rootfile declaration")
    return rootfile.get("full-path")


def _normalize_isbn(raw: str) -> Optional[str]:
    digits = re.sub(r"[^0-9Xx]", "", raw)
    if isbnlib:
        canonical = isbnlib.canonical(digits)
        if isbnlib.is_isbn13(canonical):
            return canonical
        if isbnlib.is_isbn10(canonical):
            return isbnlib.to_isbn13(canonical)
        return None
    return digits if len(digits) in (10, 13) else None


def extract_epub_metadata(file_path: str) -> dict:
    with zipfile.ZipFile(file_path) as z:
        opf_path = _opf_path(z)
        opf = ET.fromstring(_read_capped(z, opf_path, MAX_XML_MEMBER_SIZE))

    meta = opf.find("opf:metadata", NS)
    if meta is None:
        return {}

    def text(tag: str) -> Optional[str]:
        el = meta.find(f"dc:{tag}", NS)
        return el.text.strip() if el is not None and el.text else None

    authors = []
    for creator in meta.findall("dc:creator", NS):
        if not creator.text:
            continue
        role = creator.get(f"{{{NS['opf']}}}role")
        if role and role != "aut":
            continue
        authors.append(
            {
                "name": creator.text.strip(),
                "sort": creator.get(f"{{{NS['opf']}}}file-as"),
            }
        )

    identifiers = {}
    for ident in meta.findall("dc:identifier", NS):
        if not ident.text:
            continue
        value = ident.text.strip()
        scheme = (ident.get(f"{{{NS['opf']}}}scheme") or "").lower()
        if scheme == "isbn" or value.lower().startswith("urn:isbn:") or re.fullmatch(r"[\d-]{10,17}X?", value):
            isbn13 = _normalize_isbn(value)
            if isbn13:
                identifiers["isbn_13"] = isbn13
        elif scheme == "goodreads":
            identifiers["goodreads"] = value
        elif scheme in ("olid", "openlibrary"):
            identifiers["openlibrary"] = value

    published = text("date")
    if published:
        published = published[:10]  # trim time component if present

    description = text("description")
    if description:
        # OPF descriptions are routinely HTML fragments (`<p>`, `<br>`, and
        # entities that survive XML decoding) — the stored description is
        # plain text whose paragraph breaks are newlines
        description = html_to_text(description) or None

    subjects = [s.text.strip() for s in meta.findall("dc:subject", NS) if s.text]

    return {
        "title": text("title"),
        "authors": authors,
        "publisher": text("publisher"),
        "published_date": published,
        "language": text("language"),
        "description": description,
        "identifiers": identifiers,
        "tags": subjects,
    }


def extract_embedded_cover(file_path: str) -> Optional[bytes]:
    """Return the embedded cover image bytes, if the EPUB declares one."""
    try:
        with zipfile.ZipFile(file_path) as z:
            opf_path = _opf_path(z)
            opf = ET.fromstring(_read_capped(z, opf_path, MAX_XML_MEMBER_SIZE))
            manifest = opf.find("opf:manifest", NS)
            meta_el = opf.find("opf:metadata", NS)
            if manifest is None:
                return None

            cover_id = None
            if meta_el is not None:
                for m in meta_el.findall("opf:meta", NS):
                    if m.get("name") == "cover":
                        cover_id = m.get("content")

            href = None
            for item in manifest.findall("opf:item", NS):
                props = item.get("properties") or ""
                if item.get("id") == cover_id or "cover-image" in props:
                    href = item.get("href")
                    break
            if not href:
                return None

            base = "/".join(opf_path.split("/")[:-1])
            full = f"{base}/{href}" if base else href
            return _read_capped(z, full, MAX_COVER_IMAGE_SIZE)
    except Exception:
        return None
