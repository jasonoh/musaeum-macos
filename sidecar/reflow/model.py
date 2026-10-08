"""The reflow's data: what a page becomes, and what a document carries.

Moved out of `layout.py` so `regions.py` and `epub.py` can import the shapes
without importing the page pass (which imports them back).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # pragma: no cover
    from .outline import Entry

Box = tuple[float, float, float, float]  # left, bottom, right, top — PDF user space

MIN_PAGE_CHARS = 50  # below this a page is a plate, not text

# XML 1.0 cannot carry most C0 control characters, and PDFs hand them out
# freely — a font subset's encoding leaks them into extracted text. Measured:
# every corpus artifact failed schema parsing until these were stripped (a
# book's outline labels carried NULs all the way into `nav.xhtml`).
#
# `￾` is the interesting member of this set. It is not noise: pdfium returns
# it wherever a glyph has no Unicode mapping, and in this library that is
# *exactly* the hyphen at a line break — "excel￾/lent", "unavail￾/
# able", "under￾/stood" across the corpus. The line pass turns it back into
# a hyphen so the rejoin rule can put the word together again; stripping it
# here is the safety net for whatever else a font's encoding hides.
_ILLEGAL_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff￾￿]")
UNMAPPED_HYPHEN = "￾"


def clean_text(text: str) -> str:
    """Text a reader can be handed: no control characters, no NULs."""
    return _ILLEGAL_XML.sub("", text)


@dataclass
class Block:
    """The unit the EPUB writer emits, in reading order."""

    kind: str  # 'heading' | 'para' | 'footnote' | 'figure' | 'table'
    text: str = ""
    level: int = 0
    size: float = 0.0  # the median font size of its characters, in points
    bold: bool = False
    lines: int = 0
    page: int = 0
    top: float = 0.0  # where it sits on its page, for furniture and placement
    bottom: float = 0.0
    left: float = 0.0
    right: float = 0.0
    image: Optional[bytes] = None
    image_width: int = 0
    image_height: int = 0
    image_type: str = ""  # 'png' | 'jpeg' — what the bytes are, which names the file
    plate: bool = False  # a whole text-less page rendered as one image
    rows: list[list[str]] = field(default_factory=list)  # a table's cells
    source: str = "pdf"  # 'pdf' | 'vision': where its words came from
    anchor: str = ""  # an id a TOC entry links to


@dataclass
class PageResult:
    index: int
    blocks: list[Block] = field(default_factory=list)
    chars: int = 0
    top: float = 0.0  # the page's own box, so a block's position is judgeable
    bottom: float = 0.0
    flags: list[str] = field(default_factory=list)
    figures_detected: int = 0
    figure_boxes: list[Box] = field(default_factory=list)  # the crops actually written
    crop_failures: list[str] = field(default_factory=list)
    plate: bool = False


@dataclass
class Document:
    source: str
    pages: list[PageResult] = field(default_factory=list)
    entries: list["Entry"] = field(default_factory=list)
    entries_from_outline: bool = False
    verdict: str = "ok"
    reason: str = ""
    dropped_running_heads: list[str] = field(default_factory=list)
    outline_entries: int = 0
    figures_detected: int = 0
    plates: int = 0
    crop_failures: list[str] = field(default_factory=list)
    layout_errors: int = 0
    orphans: int = 0
    vision_regions: int = 0
    vision_pages: set[int] = field(default_factory=set)
    dropped_text: list[str] = field(default_factory=list)

    @property
    def text_pages(self) -> list[PageResult]:
        return [p for p in self.pages if p.chars >= MIN_PAGE_CHARS]
