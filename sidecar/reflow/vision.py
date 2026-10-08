"""The layout helper (`helpers/musaeum-layout`), and the shapes it returns.

The helper runs Apple Vision's `RecognizeDocumentsRequest` on each page and
prints JSON lines (spec Annex C.5 item 1). This module finds it, runs it and
parses what it says. Anything that stops it from helping — no binary, macOS
older than 26, a document it cannot open, a different protocol version — is a
`LayoutUnavailable` carrying the one line D6 shows, never a traceback.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

from .model import Box

HELPER_VERSION = 1


@dataclass(frozen=True)
class Region:
    order: int
    bbox: Box
    text: str  # Vision's own transcript: a hint, used only when the text layer is worse


@dataclass(frozen=True)
class TableCell:
    row: int
    col: int
    rowspan: int
    colspan: int
    bbox: Box
    text: str


@dataclass(frozen=True)
class Table:
    bbox: Box
    cells: tuple[TableCell, ...]


@dataclass
class PageLayout:
    page: int  # 1-based, as the helper numbers pages
    box: Box = (0.0, 0.0, 0.0, 0.0)
    rotation: int = 0
    regions: list[Region] = field(default_factory=list)
    tables: list[Table] = field(default_factory=list)
    ms: int = 0
    error: Optional[str] = None


class LayoutUnavailable(Exception):
    """The helper cannot lay this document out here; `reason` is D6's one line."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def find_helper() -> Optional[str]:
    """`$MUSAEUM_LAYOUT_HELPER`, else the repo's `helpers/bin/musaeum-layout`."""
    env = os.environ.get("MUSAEUM_LAYOUT_HELPER")
    if env:
        return env if os.access(env, os.X_OK) else None
    candidate = Path(__file__).resolve().parents[2] / "helpers" / "bin" / "musaeum-layout"
    return str(candidate) if os.access(candidate, os.X_OK) else None


def _box(value) -> Box:
    return (float(value[0]), float(value[1]), float(value[2]), float(value[3]))


def parse_stream(lines: Iterable[str]) -> dict[int, PageLayout]:
    it = iter(lines)
    try:
        header = json.loads(next(it))
    except (StopIteration, json.JSONDecodeError):
        raise LayoutUnavailable("the layout helper wrote no header") from None
    if header.get("helper") != "musaeum-layout":
        raise LayoutUnavailable("the layout helper wrote no header")
    if not header.get("supported", False):
        raise LayoutUnavailable("page layout needs macOS 26 or later")
    if header.get("version") != HELPER_VERSION:
        raise LayoutUnavailable(f"layout helper version {header.get('version')} (expected {HELPER_VERSION})")
    if header.get("error"):
        raise LayoutUnavailable(f"the layout helper: {header['error']}")

    pages: dict[int, PageLayout] = {}
    for line in it:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            number = int(obj.get("page", 0))
        except (json.JSONDecodeError, TypeError, ValueError, AttributeError):
            continue
        if number < 1:
            continue
        if obj.get("error"):
            pages[number] = PageLayout(page=number, error=str(obj["error"]))
            continue
        try:
            regions = sorted(
                (Region(int(r["order"]), _box(r["bbox"]), str(r.get("text", ""))) for r in obj.get("regions", [])),
                key=lambda r: r.order,
            )
            tables = [
                Table(
                    _box(t["bbox"]),
                    tuple(
                        TableCell(
                            int(c["row"]), int(c["col"]), int(c.get("rowspan", 1)), int(c.get("colspan", 1)),
                            _box(c["bbox"]), str(c.get("text", "")),
                        )
                        for c in t.get("cells", [])
                    ),
                )
                for t in obj.get("tables", [])
            ]
            pages[number] = PageLayout(
                number, _box(obj["box"]), int(obj.get("rotation", 0)), regions, tables, int(obj.get("ms", 0))
            )
        except (KeyError, TypeError, ValueError, IndexError) as err:
            pages[number] = PageLayout(page=number, error=f"malformed page line ({type(err).__name__})")
    return pages


def run_helper(
    pdf_path,
    *,
    first: Optional[int] = None,
    last: Optional[int] = None,
    concurrency: int = 8,
    scale: float = 1.5,
    helper: Optional[str] = None,
    timeout: Optional[float] = None,
) -> dict[int, PageLayout]:
    """Lay out pages `first`–`last` (1-based, inclusive; all by default)."""
    exe = helper or find_helper()
    if not exe:
        raise LayoutUnavailable("the layout helper is not installed")
    args = [exe, str(pdf_path), "--concurrency", str(concurrency), "--scale", str(scale)]
    if first is not None and last is not None:
        args += ["--pages", f"{first}-{last}"]
    try:
        # stderr is captured, never passed through: the sidecar's stderr is
        # the app's log (AC10), and PDFKit writes "CoreGraphics PDF has logged
        # an error" there for many real books.
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as err:
        raise LayoutUnavailable(f"the layout helper did not run ({type(err).__name__})") from err
    return parse_stream(proc.stdout.splitlines())
