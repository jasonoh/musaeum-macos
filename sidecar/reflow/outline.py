"""Where a reflow's sections — and so its TOC — come from.

The PDF's own outline is the best source and the first thing tried, because it
is the publisher's own structure. Measured on the library 2026-10-07 (Annex A of
the design): **22 of 27 text books carry one**, with counts from 7 entries to
355. The fallback matters just as much, though: **three of the six papers carry
no outline at all**, and a paper with no TOC is a paper you cannot navigate —
so when the outline is missing or useless the detected headings become the
sections instead, which is the same pass the reader's TOC panel will show.
"""

from __future__ import annotations

import re
from typing import Optional

from .layout import Document, clean_text

# An outline deeper than this is a list of subsections, and one XHTML file per
# subsection splits a 1,247-page book into thousands of files for no reader's
# benefit; the deeper entries are still in the nav of their parent's page range.
MAX_DEPTH = 1
MAX_SECTIONS = 240
FALLBACK_CHUNK = 20

_WS = re.compile(r"\s+")

# Outlines that carry no reader-facing structure. A print-driven PDF (InDesign,
# a book assembled from spreads) names its top-level destinations after the
# printer's marks: measured on *Modernist Cuisine, Vol 1*, all 240 top-level
# entries were `cover1`, `cover2`, … and "using the outline" produced a TOC of
# cover numbers that is worse than no outline at all.
_JUNK_LABEL = re.compile(r"^(cover|untitled|page|blank|front|back|spread)[\s_-]*\d*$", re.I)


def _usable(entries: list[tuple[str, int]]) -> bool:
    """Is this outline a table of contents, or a list of printer's marks?"""
    if len(entries) < 2:
        return False
    good = sum(
        1
        for title, _ in entries
        if not _JUNK_LABEL.match(title.strip()) and re.search(r"[A-Za-z]{3}", title)
    )
    return good >= 0.5 * len(entries)


def _clean(label: object) -> str:
    text = _WS.sub(" ", clean_text(str(label or ""))).strip()
    return text[:120]


def sections_from_outline(path: str) -> list[tuple[str, int]]:
    """The PDF outline as (title, page index), or `[]` when it has none."""
    try:
        import pypdf

        reader = pypdf.PdfReader(path)
        out: list[tuple[str, int]] = []

        def walk(items: object, depth: int) -> None:
            for item in items:  # type: ignore[union-attr]
                if isinstance(item, list):
                    walk(item, depth + 1)
                    continue
                if depth > MAX_DEPTH:
                    continue
                label = _clean(getattr(item, "title", ""))
                try:
                    page = reader.get_destination_page_number(item)
                except Exception:
                    continue
                if label and isinstance(page, int) and page >= 0:
                    out.append((label, page))

        walk(reader.outline, 0)
    except Exception:
        return []
    return _dedupe(out)


def _dedupe(entries: list[tuple[str, int]]) -> list[tuple[str, int]]:
    """One section per page, first title wins, capped and in page order."""
    by_page: dict[int, str] = {}
    for title, page in entries:
        by_page.setdefault(page, title)
    ordered = [(by_page[page], page) for page in sorted(by_page)]
    if len(ordered) > MAX_SECTIONS:
        step = len(ordered) / MAX_SECTIONS
        ordered = [ordered[int(i * step)] for i in range(MAX_SECTIONS)]
    return ordered


def sections_from_headings(doc: Document) -> list[tuple[str, int]]:
    """Sections from the document's own top-level headings, or fixed chunks.

    A heading is only a section boundary at level 1 — a level-2 heading is a
    subdivision of the section already open, and treating every heading as a
    boundary gives a sixty-entry TOC for a chapter.
    """
    out: list[tuple[str, int]] = []
    for page in doc.pages:
        for block in page.blocks:
            if block.kind == "heading" and block.level == 1 and block.text:
                if not out or out[-1][1] != page.index:
                    out.append((block.text, page.index))
    if not out and doc.pages:
        out = [
            (f"Page {page.index + 1}", page.index)
            for page in doc.pages
            if page.index % FALLBACK_CHUNK == 0
        ]
    return _dedupe(out)


def document_sections(path: str, doc: Document) -> tuple[list[tuple[str, int]], int]:
    """Sections for a whole document, plus how many outline entries were read."""
    entries = sections_from_outline(path)
    doc.outline_entries = len(entries)
    if _usable(entries):
        return entries, len(entries)
    return sections_from_headings(doc), len(entries)

# --- slice 1R: the outline at every depth (spec Annex C.5, item 9) ---------

from dataclasses import dataclass  # noqa: E402


@dataclass(frozen=True)
class Entry:
    """One TOC entry: the outline's own, or a heading standing in for it."""

    title: str
    depth: int
    page: int  # 0-based
    top: Optional[float] = None  # the destination's y in PDF units, when it has one


def is_junk(label: str) -> bool:
    """A printer's mark (`cover4`), a folio (`ix`, `3`), or nothing at all."""
    text = label.strip()
    return not text or bool(_JUNK_LABEL.match(text)) or not re.search(r"[A-Za-z]{3}", text)


def clean_label(label: object) -> str:
    return _WS.sub(" ", clean_text(str(label or ""))).strip()[:120]


def normalise_depths(entries: list[Entry]) -> list[Entry]:
    """No entry may sit more than one level below the one before it.

    Dropping a junk parent would otherwise leave its children two levels deep
    under nothing, which no nested list can express.
    """
    out: list[Entry] = []
    prev = -1
    for e in entries:
        depth = min(e.depth, prev + 1)
        out.append(Entry(e.title, depth, e.page, e.top))
        prev = depth
    return out


def _top(item: object) -> Optional[float]:
    try:
        value = getattr(item, "top", None)
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def outline_entries(path: str, pages: Optional[int] = None) -> list[Entry]:
    """Every usable outline entry at every depth, in outline order.

    Slice 1 kept one entry per page and decimated outlines over 240 entries;
    *Attention is All You Need* lost "3 Model Architecture" and nine more that
    way. Nothing is dropped here but printer's marks and entries whose page
    cannot be resolved or lies past `pages`.
    """
    try:
        import pypdf

        reader = pypdf.PdfReader(path)
        found: list[Entry] = []

        def walk(items: object, depth: int) -> None:
            for item in items:  # type: ignore[union-attr]
                if isinstance(item, list):
                    walk(item, depth + 1)
                    continue
                title = clean_label(getattr(item, "title", ""))
                if is_junk(title):
                    continue
                try:
                    page = reader.get_destination_page_number(item)
                except Exception:
                    continue
                if not isinstance(page, int) or page < 0 or (pages is not None and page >= pages):
                    continue
                found.append(Entry(title, depth, page, _top(item)))

        walk(reader.outline, 0)
    except Exception:
        return []
    return normalise_depths(found)
