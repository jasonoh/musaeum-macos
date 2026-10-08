"""PDF → a reflowable EPUB: the slice-1 spike.

Called by `scripts/pdf-reflow-probe.py` and by nothing else yet. It is
**not** wired into the sidecar's RPC, does not know about the library, and
never writes anything outside the output directory it is given, because the
spike's job is to be judged rather than to ship.

See `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` for the
decisions this implements and Annex B for what it measured.
"""

from .epub import write_epub
from .layout import Block, Document, PageResult, analyse, extract_page
from .outline import document_sections, sections_from_headings, sections_from_outline

__all__ = [
    "Block",
    "Document",
    "PageResult",
    "analyse",
    "document_sections",
    "extract_page",
    "sections_from_headings",
    "sections_from_outline",
    "write_epub",
]
