"""Extract embedded metadata from an EPUB's OPF package document."""

import re
import zipfile
import xml.etree.ElementTree as ET
from typing import Optional

try:
    import isbnlib
except ImportError:  # pragma: no cover — isbnlib is in requirements.txt
    isbnlib = None

NS = {
    "container": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
}


def _opf_path(z: zipfile.ZipFile) -> str:
    container = ET.fromstring(z.read("META-INF/container.xml"))
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
        opf = ET.fromstring(z.read(_opf_path(z)))

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
        # OPF descriptions are often HTML fragments
        description = re.sub(r"<[^>]+>", "", description).strip()

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
            opf = ET.fromstring(z.read(opf_path))
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
            return z.read(full)
    except Exception:
        return None
