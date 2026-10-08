"""PDF → a reflowable EPUB: the slice-1 spike.

Called by `scripts/pdf-reflow-probe.py` and by nothing else yet. It is
**not** wired into the sidecar's RPC, does not know about the library, and
never writes anything outside the output directory it is given, because the
spike's job is to be judged rather than to ship.

See `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` for the
decisions this implements and Annex B for what it measured.
"""

from .epub import link_entries, write_epub
from .layout import analyse, extract_page
from .model import Block, Document, PageResult
from .outline import Entry, document_entries, heading_entries, outline_entries

__all__ = [
    "Block",
    "Document",
    "Entry",
    "PageResult",
    "analyse",
    "document_entries",
    "extract_page",
    "heading_entries",
    "link_entries",
    "outline_entries",
    "write_epub",
]
