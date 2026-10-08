"""Where a reflow's sections — and so its TOC — come from.

The PDF's own outline is the best source and the first thing tried, because it
is the publisher's own structure. Measured on the library 2026-10-07 (Annex A of
the design): **22 of 27 text books carry one**, with counts from 7 entries to
355. The fallback matters just as much, though: **three of the six papers carry
no outline at all**, and a paper with no TOC is a paper you cannot navigate —
so when the outline is missing or holds fewer than two usable entries the
detected headings become the sections instead, which is the same pass the
reader's TOC panel will show.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from .model import Document, clean_text

_WS = re.compile(r"\s+")

# Outlines that carry no reader-facing structure. A print-driven PDF (InDesign,
# a book assembled from spreads) names its top-level destinations after the
# printer's marks: measured on *Modernist Cuisine, Vol 1*, all 240 top-level
# entries were `cover1`, `cover2`, … and "using the outline" produced a TOC of
# cover numbers that is worse than no outline at all. `end1`–`end4` (its
# endpapers) are the same family, and a *Roman* folio has to be named
# separately: `is_junk` already drops a label with no run of three letters, so
# `ix` went but `viii`, `xii` and `xiii` — seven entries of that book's 355 —
# came through as the whole TOC.
_JUNK_LABEL = re.compile(r"^(cover|untitled|page|blank|front|back|spread|end)[\s_-]*\d*$", re.I)
_ROMAN = re.compile(r"^[ivxlcdm]+$", re.I)

# --- slice 1R: the outline at every depth (spec Annex C.5, item 9) ---------


@dataclass(frozen=True)
class Entry:
    """One TOC entry: the outline's own, or a heading standing in for it."""

    title: str
    depth: int
    page: int  # 0-based
    top: Optional[float] = None  # the destination's y in PDF units, when it has one


def is_junk(label: str) -> bool:
    """A printer's mark (`cover4`, `end1`), a folio (`ix`, `viii`, `3`), or
    nothing at all."""
    text = label.strip()
    return (
        not text
        or bool(_JUNK_LABEL.match(text))
        or bool(_ROMAN.match(text))
        or not re.search(r"[A-Za-z]{3}", text)
    )


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


MIN_ENTRIES = 2  # an outline with fewer usable entries than this is not a TOC


def heading_entries(doc: Document) -> list[Entry]:
    """Level-1 and level-2 headings as TOC entries, in reading order."""
    out = [
        Entry(clean_label(b.text), b.level - 1, page.index, b.top)
        for page in doc.pages
        for b in page.blocks
        if b.kind == "heading" and b.level in (1, 2) and b.text.strip()
    ]
    return normalise_depths(out)


def document_entries(path: str, doc: Document) -> list[Entry]:
    """The outline when it is a TOC, the headings otherwise."""
    entries = outline_entries(path, pages=len(doc.pages))
    doc.outline_entries = len(entries)
    doc.entries_from_outline = len(entries) >= MIN_ENTRIES
    return entries if doc.entries_from_outline else heading_entries(doc)
