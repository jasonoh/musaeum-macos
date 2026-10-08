"""PDF → a reflowable EPUB: the slice-1 spike.

Called by scripts/pdf-reflow-probe.py and by nothing else yet: it is not
wired into the sidecar's RPC (slice 2), does not know about the library, and
writes nothing outside the output path it is given.

See `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` for the
decisions this implements and Annex B for what it measured.
"""

from .epub import link_entries, write_epub
from .layout import analyse
from .model import Block, Document, PageResult
from .outline import Entry, document_entries, heading_entries, outline_entries

__all__ = [
    "Block",
    "Document",
    "Entry",
    "PageResult",
    "analyse",
    "document_entries",
    "heading_entries",
    "link_entries",
    "outline_entries",
    "write_epub",
]
