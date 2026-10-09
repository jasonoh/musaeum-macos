"""Vision's regions, filled with the PDF's own characters.

Spec Annex C.5 items 2, 3, 3a and 8. Vision decides *where* the paragraphs and
tables are and in what order (`vision.py`); pdfium decides what they *say*
(`chars.py`) — except where the text layer is itself a scanner's bad OCR, when
Vision's transcript is the better reading and is used instead, and counted.
"""

from __future__ import annotations

import difflib
import re
import statistics
from dataclasses import dataclass, field
from typing import Optional, Sequence

from .chars import Char, baseline_lines
from .model import UNMAPPED_HYPHEN, Block, Box, clean_text
from .vision import PageLayout, Region, Table

PAD = 1.0  # points around a region that still count as inside it
ORPHAN_REACH = 6.0  # a character this close to a region joins it
SPACE_MIN_GAP = 0.1  # × font size: a stored space between glyphs closer than this is spurious
SYNTH_GAP = 0.5  # × character height: a gap this wide with no space character is a word break
TEXT_RATIO = 0.9  # below this agreement the two readings disagree…
JUNK_MARGIN = 0.1  # …and the text layer loses only when it is this much junkier
FIGURE_OVERLAP = 0.6  # a region this much inside a written figure is its label
TABLE_OVERLAP = 0.8  # a paragraph this much inside a table is one of its cells
CAPTION_SIZE_RATIO = 1.1  # regions whose sizes differ more than this never continue each other

_HYPHENS = ("-", "‐", "‑", "‒", "–")
_SENTENCE_END = (".", "!", "?", ":", "”", "’", '"')
_CLOSING = ".,;:!?)]}»”’'\"%°-–—>·"
_OPENING = "([{«“‘¿¡<'’"
_EDGE = "([{\"'“”‘’«».,;:!?)]}*†‡∗"
_ODD = re.compile(r"[^0-9A-Za-zÀ-ÖØ-öø-ÿ'’\-–—.,/%°=+×·−≤≥∈→←αβγδεθλμπσφψω]")
_INNER = re.compile(r"[A-Za-z][.!?:;<>\\|][A-Za-z]")
_NOT_ALNUM = re.compile(r"[^a-z0-9]")
_WS = re.compile(r"\s+")


# --- which reading a region uses (C.5 item 3a) ----------------------------
def junk_score(text: str) -> float:
    """Share of tokens holding an odd character, or punctuation between letters.

    Math such as `(x1, ..., xn)` scores 0; a scanner's `moiL•cular` and
    `h.!'>` do not. Measured on the corpus 2026-10-08 (spec Annex C.5 item 3a).
    """
    toks = [t.strip(_EDGE) for t in text.split()]
    toks = [t for t in toks if t]
    if not toks:
        return 1.0
    return sum(1 for t in toks if _ODD.search(t) or _INNER.search(t)) / len(toks)


def choose_text(pdf_text: str, vision_text: str) -> tuple[str, str]:
    """The region's words: the text layer's, unless it is the worse reading."""
    pdf_text = pdf_text.strip()
    vision_text = _WS.sub(" ", clean_text(vision_text)).strip()
    if not pdf_text:
        return (vision_text, "vision") if vision_text else ("", "pdf")
    # The junk test comes first because it is cheap and settles almost every
    # region: only a text layer clearly junkier than Vision's reading is worth
    # the O(n²) comparison.
    if not vision_text or junk_score(pdf_text) < junk_score(vision_text) + JUNK_MARGIN:
        return pdf_text, "pdf"
    a = _NOT_ALNUM.sub("", pdf_text.lower())
    b = _NOT_ALNUM.sub("", vision_text.lower())
    if difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() < TEXT_RATIO:
        return vision_text, "vision"
    return pdf_text, "pdf"


# --- one line, and lines into a paragraph (C.5 item 3) --------------------
def _binds(before: str, after: str) -> bool:
    """Punctuation attaches to what precedes it; an opening bracket to what follows."""
    if not before or not after:
        return False
    return after[0] in _CLOSING or before[-1] in _OPENING


def line_text(chars: Sequence[Char]) -> str:
    """A baseline's characters (sorted by centre x) as text.

    A stored space survives only when the glyphs either side of it are at
    least 0.1× the font size apart: *Universe*'s text layer stores
    `fi ghting` with a space whose box lies inside the ligature's (a 0.4pt gap
    against ~2.5pt for a word space). A space is added where none is stored
    only across a gap wider than half a character — the slice-1 threshold,
    measured against letter-spaced e-mail addresses.
    """
    out: list[str] = []
    prev: Optional[Char] = None
    prev_text = ""
    space = False
    for c in chars:
        text = "-" if c.text == UNMAPPED_HYPHEN else c.text
        if not text.strip():
            space = True
            continue
        if prev is not None:
            gap = c.left - prev.right
            if space:
                if gap >= SPACE_MIN_GAP * max(prev.size, c.size, 1.0):
                    out.append(" ")
            elif gap > SYNTH_GAP * max(c.height, prev.height) and not _binds(prev_text, text):
                out.append(" ")
        space = False
        out.append(text)
        prev, prev_text = c, text
    return _WS.sub(" ", clean_text("".join(out))).strip()


def join_lines(lines: list[str]) -> str:
    """Lines into one paragraph; a lower-case word broken at a line end is rejoined."""
    text = ""
    for line in lines:
        if not line:
            continue
        if text:
            if text.endswith(_HYPHENS) and line[:1].islower():
                text = text[:-1]
            else:
                text += " "
        text += line
    return text.strip()


# --- geometry ----------------------------------------------------------------
def _area(b: Box) -> float:
    return max(b[2] - b[0], 0.0) * max(b[3] - b[1], 0.0)


def _share_inside(inner: Box, outer: Box) -> float:
    w = max(0.0, min(inner[2], outer[2]) - max(inner[0], outer[0]))
    h = max(0.0, min(inner[3], outer[3]) - max(inner[1], outer[1]))
    return w * h / max(_area(inner), 1e-6)


def _contains(b: Box, x: float, y: float, pad: float = PAD) -> bool:
    return b[0] - pad <= x <= b[2] + pad and b[1] - pad <= y <= b[3] + pad


def _distance(b: Box, x: float, y: float) -> float:
    dx = max(b[0] - x, 0.0, x - b[2])
    dy = max(b[1] - y, 0.0, y - b[3])
    return (dx * dx + dy * dy) ** 0.5


def _nearest(boxes: Sequence[Box], x: float, y: float) -> Optional[int]:
    """The smallest box containing the point, else the nearest within reach."""
    inside = [i for i, b in enumerate(boxes) if _contains(b, x, y)]
    if inside:
        return min(inside, key=lambda i: _area(boxes[i]))
    if not boxes:
        return None
    best = min(range(len(boxes)), key=lambda i: _distance(boxes[i], x, y))
    return best if _distance(boxes[best], x, y) <= ORPHAN_REACH else None


# --- a page ----------------------------------------------------------------
@dataclass
class PageText:
    blocks: list[Block] = field(default_factory=list)
    orphans: int = 0
    vision_regions: int = 0
    dropped_text: list[str] = field(default_factory=list)


@dataclass
class _Unit:
    """A region or a table, at its place in Vision's order."""

    order: float
    box: Box
    vision_text: str = ""
    table: Optional[Table] = None
    chars: list[Char] = field(default_factory=list)
    rotated: int = 0


def _units(layout: Optional[PageLayout], page_box: Box, figure_boxes: Sequence[Box]) -> list[_Unit]:
    usable = layout is not None and layout.error is None and bool(layout.regions or layout.tables)
    regions: list[Region] = list(layout.regions) if usable else [Region(0, page_box, "")]
    tables: list[Table] = list(layout.tables) if usable else []
    regions = [r for r in regions if not any(_share_inside(r.bbox, f) >= FIGURE_OVERLAP for f in figure_boxes)]
    units: list[_Unit] = []
    for table in tables:
        inside = [r for r in regions if _share_inside(r.bbox, table.bbox) >= TABLE_OVERLAP]
        if inside:
            order = float(min(r.order for r in inside))
        else:
            below = [r.order for r in regions if r.bbox[3] <= table.bbox[3]]
            order = (min(below) - 0.5) if below else float(len(regions))
        units.append(_Unit(order, table.bbox, table=table))
        regions = [r for r in regions if r not in inside]
    units.extend(_Unit(float(r.order), r.bbox, r.text) for r in regions)
    units.sort(key=lambda u: u.order)
    return units


def _continues(previous: Block, last_line: list[Char], first_line: list[Char], text: str) -> bool:
    """Does this region carry on the previous one's paragraph?

    Either Vision cut one line in two (same baseline, to its right — it splits
    *Attention*'s abstract into five line fragments), or a sentence runs on
    into this region: no terminal punctuation before, lower case after. Two
    regions of different type size never continue each other, which keeps a
    caption from swallowing the body text that follows it.
    """
    a = [c for c in last_line if not c.is_space]
    b = [c for c in first_line if not c.is_space]
    if not a or not b:
        return False
    size_a = statistics.median(c.size for c in a)
    size_b = statistics.median(c.size for c in b)
    if size_a > 0 and size_b > 0 and max(size_a, size_b) / min(size_a, size_b) > CAPTION_SIZE_RATIO:
        return False
    height = max(statistics.median(c.height for c in a), 1.0)
    base_a = statistics.median(c.bottom for c in a)
    base_b = statistics.median(c.bottom for c in b)
    if abs(base_a - base_b) <= 0.5 * height and b[0].left >= a[-1].right - 1.0:
        return True
    return text[:1].islower() and not previous.text.rstrip().endswith(_SENTENCE_END)


def _table_block(index: int, unit: _Unit) -> Optional[Block]:
    table = unit.table
    cells = list(table.cells) if table else []
    if not cells:
        return None
    rows = max(c.row + c.rowspan for c in cells)
    cols = max(c.col + c.colspan for c in cells)
    grid = [["" for _ in range(cols)] for _ in range(rows)]
    boxes = [c.bbox for c in cells]
    buckets: list[list[Char]] = [[] for _ in cells]
    for ch in unit.chars:
        i = _nearest(boxes, ch.cx, ch.cy)
        if i is not None:
            buckets[i].append(ch)
    for cell, chars in zip(cells, buckets):
        pdf_text = join_lines([line_text(ln) for ln in baseline_lines(chars)])
        grid[cell.row][cell.col], _ = choose_text(pdf_text, cell.text)
    left, bottom, right, top = table.bbox
    return Block(
        "table",
        text=" ".join(t for row in grid for t in row if t),
        rows=grid,
        lines=rows,
        page=index,
        left=left,
        bottom=bottom,
        right=right,
        top=top,
    )


def build_page_text(
    index: int,
    chars: Sequence[Char],
    layout: Optional[PageLayout],
    figure_boxes: Sequence[Box],
    page_box: Box,
) -> PageText:
    """One page's text blocks, in Vision's reading order.

    `figure_boxes` are the crops actually written: their characters and the
    regions inside them are the figure's labels, already in the picture. A page
    the helper failed on (or skipped) reads as one region covering the page —
    non-fatal, and counted by the caller as a layout error.
    """
    result = PageText()
    units = _units(layout, page_box, figure_boxes)
    boxes = [u.box for u in units]
    rotated = [c for c in chars if c.rotated]
    dropped: list[Char] = []
    for c in chars:
        if any(_contains(f, c.cx, c.cy, 0.0) for f in figure_boxes):
            dropped.append(c)
            continue
        i = _nearest(boxes, c.cx, c.cy)
        if i is None:
            if not c.is_space and not c.rotated:
                result.orphans += 1
            continue
        if c.rotated:
            units[i].rotated += 1
        else:
            units[i].chars.append(c)
    result.dropped_text = [t for t in (line_text(ln) for ln in baseline_lines([c for c in dropped if not c.rotated])) if t]

    previous: Optional[Block] = None
    previous_line: list[Char] = []
    for unit in units:
        if unit.table is not None:
            block = _table_block(index, unit)
            if block is not None:
                result.blocks.append(block)
            previous, previous_line = None, []
            continue
        glyphs = [c for c in unit.chars if not c.is_space]
        if not glyphs and (
            unit.rotated
            or any(_contains(unit.box, c.cx, c.cy, 0.0) for c in rotated)
        ):
            # A rotated stamp or a sideways figure credit: never read back in
            # from Vision's OCR, which reads it as upright words and trips G3.
            # The rotated characters are not always *this* unit's: Vision
            # overlays a wide credit strip with the smaller box that takes
            # them, so the strip has none of its own and its text would come
            # from the OCR — *Universe* p.352, where G3 found `dean`, `hines`
            # and `nrao` in the flow.
            continue
        lines = baseline_lines(unit.chars)
        text, source = choose_text(join_lines([line_text(ln) for ln in lines]), unit.vision_text)
        if not text:
            continue
        if source == "vision":
            result.vision_regions += 1
        if previous is not None and lines and _continues(previous, previous_line, lines[0], text):
            previous.text = join_lines([previous.text, text])
            previous.lines += len(lines)
            previous.bottom = min(previous.bottom, unit.box[1])
            previous.left = min(previous.left, unit.box[0])
            previous.right = max(previous.right, unit.box[2])
            previous_line = lines[-1]
            continue
        block = Block(
            "para",
            text=text,
            page=index,
            size=statistics.median(c.size for c in glyphs) if glyphs else 0.0,
            bold=bool(glyphs) and sum(c.bold for c in glyphs) * 2 > len(glyphs),
            lines=max(len(lines), 1),
            left=unit.box[0],
            bottom=unit.box[1],
            right=unit.box[2],
            top=unit.box[3],
            source=source,
        )
        result.blocks.append(block)
        previous, previous_line = block, (lines[-1] if lines else [])
    return result
