"""PDF → blocks: the layout pass the whole reflow rests on.

**Why this module exists.** Measured on the owner's library (2026-10-07; the
numbers are in `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md`,
Annex A): neither permissive extractor returns a reading order. pdfium hands
back characters in content-stream order, and pdfminer's layout analysis reorders
them only partly — on a two-column textbook both were measured at 5–14 monotone
runs per page where a correct read of the layout needs 2–3, and on a two-column
paper pdfium produced lines whose own characters spanned the gutter on 5–8 pages
of 12. So the columns, the line grouping, the paragraph boundaries and the
heading levels are ours; `pypdfium2` supplies char boxes, region renders and
image objects, which is all it is used for.

**The three ideas in it.**

1. A page is cut into *bands* by the vertical white gaps that persist across the
   page's own height — a projection profile over lines, not a per-line guess. A
   gutter qualifies; a single wide word space in justified text cannot, because
   only the one line that contains it covers it.
2. Every element that reaches across the bands — a title, a full-width table, a
   page-wide figure — is *page-level* and is emitted where it sits vertically.
   The pass therefore segments the page top-to-bottom first and orders the
   columns inside each segment, which is what keeps a title above its columns
   and a wide figure between the two halves of a page.
3. A figure is *any non-text ink*, not an embedded image object: charts, vector
   line art and scanned plates are all invisible to `page.get_objects()`
   (measured: the six-paper corpus sample reports **zero** image objects on most
   pages), while a coarse ink grid over a 0.25-scale render sees all three, and
   the crop is then rendered at 2x.

**Conservative by construction.** Everything uncertain is recorded in
`PageResult.flags` rather than smoothed over, because the design turns "cannot
be ordered confidently" into *keep the original PDF* (D6) rather than into a
mangled book.

Nothing here touches the library: this is slice 1's spike, called by
`scripts/pdf-reflow-probe.py`, and it is deliberately **not** wired into the
sidecar's RPC yet.

Known limits, named rather than discovered later: left-to-right scripts only
(characters are ordered by x within a line); no table structure (a table's rows
survive as lines, its cells do not); no OCR, so a page without a text layer
reports `no_text` and the book falls back.
"""

from __future__ import annotations

import io
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Optional

import pypdfium2 as pdfium

# --- tunables, each one measured against the corpus rather than guessed -----

MIN_PAGE_CHARS = 50  # below this a page is a plate, not text
BAND_COVERAGE = 0.05  # a gutter bin holds under 5% of the densest occupancy
MIN_VALLEY_PT = 6.0  # a gap narrower than this is a word space, not a gutter
MIN_VALLEY_FRACTION = 0.02  # …and a gutter is at least 2% of the text width
MIN_BAND_CHARS = 0.03  # a band holding fewer characters than this is not text
FULL_WIDTH = 0.65  # an element this wide of the text area is page-level
BASELINE_TOLERANCE = 0.6  # of the char height, when grouping chars into lines
WORD_GAP_EM = 0.5  # a gap this wide starts a new word with no space char
BODY_RATIO = 1.12  # a line taller than the body by this much may be a heading
MAX_BANDS = 4  # more bands than this on a page is a layout we do not claim
VALLEY_CHAR_LIMIT = 0.02  # chars sitting in a gutter, as a share of the page
HEADING_MAX_CHARS = 100
PARAGRAPH_LEADING = 1.6  # leading above the median's multiple starts a paragraph
SHORT_LINE = 0.72  # a line this much narrower than its band ends a paragraph
INDENT_EM = 0.9
FIGURE_SCALE = 0.25  # the analysis render: a 612x792 page becomes 153x198
FIGURE_CELL_PT = 12.0  # the ink grid's cell, in points
FIGURE_MIN_PT = 24.0  # a region thinner than this is a rule, not a figure
FIGURE_MIN_AREA = 4000.0  # square points
FIGURE_MAX_PAGE = 0.80  # a region this much of the page is a background
FIGURE_MAX_TEXT_SHARE = 0.25  # a region this covered in text is a table, not a figure
TABLE_LABEL_MAX_CHARS = 40  # inside a table-ish region, shorter than this is a label
TABLE_LABEL_MAX_SHARE = 0.30  # …and narrower than this share of the region
FIGURE_CROP_SCALE = 2.0  # the crop actually written into the EPUB
FIGURE_MAX_PIXELS = 1400  # a figure is never rendered larger than this
FIGURE_PNG_MAX_SHARE = 0.06  # above this share of the page a figure is JPEG
INK_THRESHOLD = 245  # a pixel darker than this at analysis scale is ink
RUNNING_HEAD_PAGES = 0.25  # the share of pages that makes a line a running head
RUNNING_HEAD_MIN = 3
RUNNING_HEAD_BAND = 0.10  # of the page height, top and bottom, where it sits
RUNNING_HEAD_MAX_CHARS = 80
HEADING_LEVELS = 3

_SENTENCE_END = (".", "!", "?", ":", "”", "’")
_HYPHENS = ("-", "‐", "‑", "‒", "–")
_WS = re.compile(r"\s+")

# XML 1.0 cannot carry most C0 control characters, and PDFs hand them out
# freely — a font subset's encoding leaks them into extracted text. Measured:
# every corpus artifact failed schema parsing until these were stripped (a
# book's outline labels carried NULs all the way into `nav.xhtml`).
#
# `\ufffe` is the interesting member of this set. It is not noise: pdfium returns
# it wherever a glyph has no Unicode mapping, and in this library that is
# *exactly* the hyphen at a line break — "excel\ufffe/lent", "unavail\ufffe/
# able", "under\ufffe/stood" across the corpus. `_line_text` turns it back into
# a hyphen so the existing rejoin rule can put the word together again; stripping
# it here is the safety net for whatever else a font's encoding hides.
_ILLEGAL_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff\ufffe\uffff]")
_UNMAPPED_HYPHEN = "\ufffe"


def clean_text(text: str) -> str:
    """Text a reader can be handed: no control characters, no NULs."""
    return _ILLEGAL_XML.sub("", text)


@dataclass
class Element:
    """One thing on a page: a text line or a figure region."""

    kind: str  # 'line' | 'figure'
    left: float
    bottom: float
    right: float
    top: float
    text: str = ""
    height: float = 0.0
    chars: list[Element] = field(default_factory=list)
    image: Optional[bytes] = None
    image_width: int = 0
    image_height: int = 0
    band: int = -1
    split: bool = False  # this line had to be cut at a band boundary

    @property
    def width(self) -> float:
        return self.right - self.left


@dataclass
class Block:
    """The unit the EPUB writer emits, in reading order."""

    kind: str  # 'heading' | 'para' | 'figure'
    text: str = ""
    level: int = 0
    size: float = 0.0  # a heading's height in points, before levels are ranked
    page: int = 0
    top: float = 0.0  # where it sits on its page, for the running-head rule
    bottom: float = 0.0
    image: Optional[bytes] = None
    image_width: int = 0
    image_height: int = 0


@dataclass
class PageResult:
    index: int
    blocks: list[Block] = field(default_factory=list)
    chars: int = 0
    lines: int = 0
    cross_band: int = 0
    figures_swallowed: int = 0
    labels_swallowed: int = 0
    bands: int = 1
    top: float = 0.0  # the page's own box, so a block's position is judgeable
    bottom: float = 0.0
    flags: list[str] = field(default_factory=list)
    seconds: float = 0.0


@dataclass
class Document:
    source: str
    pages: list[PageResult] = field(default_factory=list)
    sections: list[tuple[str, int]] = field(default_factory=list)
    verdict: str = "ok"
    reason: str = ""
    dropped_running_heads: list[str] = field(default_factory=list)
    outline_entries: int = 0

    @property
    def text_pages(self) -> list[PageResult]:
        return [p for p in self.pages if p.chars >= MIN_PAGE_CHARS]


# --- characters and lines --------------------------------------------------
def _height(el: Element) -> float:
    return max(el.top - el.bottom, 1.0)


def _page_chars(textpage: pdfium.PdfTextPage) -> list[Element]:
    """Every character on the page with its box, in pdfium's own order.

    Zero-area boxes are kept (they are real spaces in some files) but they
    contribute nothing to geometry, which is why the band profile counts lines
    rather than characters.
    """
    chars: list[Element] = []
    for i in range(textpage.count_chars()):
        left, bottom, right, top = textpage.get_charbox(i)
        text = textpage.get_text_range(i, 1)
        if text in ("\r", "\n"):
            continue
        chars.append(Element("line", left, bottom, right, top, text=text))
    return chars


def _group_lines(chars: list[Element]) -> list[Element]:
    """Chars → y-bands ("rough lines"), each carrying its own characters.

    A rough line is *not* yet a line of text: two columns on one baseline land
    in the same band, which is what `_split_at_bands` undoes.
    """
    lines: list[Element] = []
    for c in chars:
        placed = False
        if lines:
            ln = lines[-1]
            if abs(c.bottom - ln.bottom) <= BASELINE_TOLERANCE * max(_height(c), ln.height):
                ln.chars.append(c)
                ln.left = min(ln.left, c.left)
                ln.right = max(ln.right, c.right)
                ln.top = max(ln.top, c.top)
                ln.height = max(ln.height, _height(c))
                placed = True
        if not placed:
            lines.append(
                Element(
                    "line",
                    c.left,
                    c.bottom,
                    c.right,
                    c.top,
                    height=_height(c),
                    chars=[c],
                )
            )
    for ln in lines:
        ln.text = _line_text(ln.chars)
    return lines


def _line_text(chars: list[Element]) -> str:
    """Assemble a line's text, restoring the spaces the PDF never stored.

    Most PDFs write a real space character between words, and pdfium returns it;
    this only fills the gap where one is genuinely absent. The threshold is
    deliberately *high* (half a character's height) because the two cases are
    not separable by size: measured on page 1 of *Attention is All You Need*,
    the median gap between characters with no space between them is **0.39pt**
    (p90 0.72pt) while the letter-spaced email addresses on the same page sit at
    **2.6pt** — larger than a 10pt font's own space. A low threshold shredded
    those addresses into `ill i a . po l o sukhin`, which is a worse defect than
    the rare word that runs together in a file that stores no space characters
    at all.

    Punctuation is never separated even across a wide gap: a reflow that renders
    `it .` or `don ' t` is wrong in a way a reader notices, and the artifact's own
    word diff reports it as thousands of invented tokens (measured on *Politics,
    Philosophy, Culture*: `it.` 67, `don't` 76 missing tokens that were all one
    false space each).
    """
    ordered = sorted(chars, key=lambda c: c.left)
    out: list[str] = []
    prev_text = ""
    prev_right: Optional[float] = None
    for c in ordered:
        text = "-" if c.text == _UNMAPPED_HYPHEN else c.text
        if prev_right is not None and not _binds(prev_text, text):
            if c.left - prev_right > WORD_GAP_EM * _height(c):
                out.append(" ")
        out.append(text)
        prev_text, prev_right = text, c.right
    return _WS.sub(" ", clean_text("".join(out))).strip()


_CLOSING = ".,;:!?)]}»”’'\"%°-–—> ·"
_OPENING = "([{«“‘¿¡<'’ "


def _binds(before: str, after: str) -> bool:
    """Do these two characters belong to the same token whatever the gap?

    Only two shapes, and both are about the character that *starts* the token:
    punctuation attaches to what precedes it, and a gap after an opening bracket
    attaches to the bracket. Everything else may take a space.
    """
    if not before or not after:
        return False
    return after[0] in _CLOSING or before[-1] in _OPENING


# --- bands (columns) -------------------------------------------------------
def _find_bands(lines: list[Element], width: float) -> list[tuple[float, float]]:
    """The page's text bands, left to right, by projection profile.

    A bin is *solid* when characters cover it. A two-column gutter has no
    characters in it at all, so it is a gap however the lines above it were
    grouped, while a word space is a gap too narrow to count as one.

    The gap threshold is measured in the page's *text* width, not its paper
    width: a LaTeX gutter is 3–6% of the text area (this library's papers: ~17pt
    on a 397pt text width) while the paper is much wider, and judging the gutter
    against the paper is how the first version of this merged two columns into
    one — measured on *Attention is All You Need*, whose 15 pages then reflowed
    as a single column.
    """
    if not lines or width <= 0:
        return []
    occupied = [ch for ln in lines for ch in ln.chars if ch.text.strip()]
    if not occupied:
        return []
    left_edge = min(ch.left for ch in occupied)
    right_edge = max(ch.right for ch in occupied)
    text_width = max(right_edge - left_edge, 1.0)

    # Coverage comes from the *characters*, never from the lines: two columns on
    # one baseline are one rough line by construction (splitting it is what
    # `_split_at_bands` does), so a profile built from line extents is uniformly
    # solid and finds no gutter at all — the second bug this shipped with.
    n = int(width) + 1
    bins = [0] * n
    for ch in occupied:
        for x in range(max(int(ch.left), 0), min(int(ch.right) + 1, n)):
            bins[x] += 1
    peak = max(bins)
    if peak == 0:
        return []
    # Occupancy, not majority: with character coverage a normal body bin holds
    # exactly one character, so a threshold meaning "more than one" finds no
    # solid run anywhere and the page collapses to a single band — measured on
    # *Attention is All You Need*'s two-column pages, which reflowed as one
    # column for exactly this reason.
    threshold = max(1, int(peak * BAND_COVERAGE))

    runs: list[list[float]] = []
    start: Optional[int] = None
    for x in range(n):
        if bins[x] >= threshold:
            if start is None:
                start = x
        elif start is not None:
            runs.append([float(start), float(x)])
            start = None
    if start is not None:
        runs.append([float(start), float(n)])

    # A run separated from its neighbour by less than a gutter is a ragged edge,
    # not a column break; folding it in avoids splitting a page of one column at
    # the longest line's right edge.
    min_gap = max(MIN_VALLEY_PT, MIN_VALLEY_FRACTION * text_width)
    merged: list[list[float]] = []
    for r in runs:
        if merged and r[0] - merged[-1][1] < min_gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    if not merged:
        return []

    # A band holding almost no text is not a column. This is what keeps a
    # rotated stamp or a decorative strip in the margin from becoming a column
    # of one-character lines: measured on page 1 of *Attention is All You Need*,
    # the arXiv stamp held ~10 of 2,838 characters and still produced six
    # single-character "headings" before this rule existed.
    total_chars = len(occupied)
    keep: list[int] = []
    for i, (lo, hi) in enumerate(merged):
        count = sum(1 for ch in occupied if lo <= (ch.left + ch.right) / 2 <= hi)
        if count >= max(4, MIN_BAND_CHARS * total_chars):
            keep.append(i)
    if len(keep) < 2:
        return [(left_edge, right_edge)]
    return [(merged[i][0], merged[i][1]) for i in keep]


def _band_of(el: Element, bands: list[tuple[float, float]]) -> int:
    centre = (el.left + el.right) / 2
    best, best_d = 0, None
    for i, (lo, hi) in enumerate(bands):
        d = 0.0 if lo <= centre <= hi else min(abs(centre - lo), abs(centre - hi))
        if best_d is None or d < best_d:
            best, best_d = i, d
    return best


def _is_page_level(el: Element, bands: list[tuple[float, float]]) -> bool:
    """Does this element span the text area rather than sit in one column?"""
    if len(bands) < 2:
        return True
    area = bands[-1][1] - bands[0][0]
    if area <= 0 or el.width < FULL_WIDTH * area:
        return False
    return el.left <= bands[0][0] + 0.08 * area and el.right >= bands[-1][1] - 0.08 * area


# --- reading order ---------------------------------------------------------
def order_elements(
    elements: list[Element], bands: list[tuple[float, float]]
) -> list[Element]:
    """Segment the page vertically, then order each segment's columns.

    Sorting everything by y instead is the bug this exists to avoid: a page
    title would land wherever its baseline falls relative to the two columns
    beneath it, and a wide figure in the middle of a page would be interleaved
    into one column's text.
    """
    for el in elements:
        el.band = _band_of(el, bands)
    segments: list[tuple[str, list[Element]]] = []
    run: list[Element] = []
    for el in sorted(elements, key=lambda e: (-e.top, e.left)):
        if _is_page_level(el, bands):
            if run:
                segments.append(("columns", run))
                run = []
            segments.append(("page", [el]))
        else:
            run.append(el)
    if run:
        segments.append(("columns", run))

    ordered: list[Element] = []
    for kind, group in segments:
        if kind == "page":
            ordered.extend(group)
            continue
        for i in range(len(bands)):
            ordered.extend(sorted((e for e in group if e.band == i), key=lambda e: -e.top))
    return ordered


# --- paragraphs and headings ----------------------------------------------
def _leading(ordered: list[Element]) -> float:
    """The page's median baseline step, measured **within** a band.

    Across a band boundary the step is meaningless — the first line of column
    two sits *above* the last of column one — so those pairs are excluded.
    """
    deltas = [
        a.bottom - b.bottom
        for a, b in zip(ordered, ordered[1:])
        if a.kind == b.kind == "line" and a.band == b.band and a.bottom - b.bottom > 0.5
    ]
    if not deltas:
        return 12.0
    deltas.sort()
    return deltas[len(deltas) // 2]


def _body_height(lines: list[Element]) -> float:
    """The page's body size: the height carrying the most characters."""
    weights: dict[int, int] = {}
    for ln in lines:
        key = int(round(ln.height))
        weights[key] = weights.get(key, 0) + max(len(ln.text), 1)
    if not weights:
        return 10.0
    return float(max(weights.items(), key=lambda kv: kv[1])[0])


def _joins(prev: Element, cur: Element, leading: float, band_width: float) -> bool:
    """Does `cur` continue `prev`'s paragraph?"""
    if prev.bottom - cur.bottom > leading * PARAGRAPH_LEADING:
        return False
    ends = prev.text.rstrip().endswith(_SENTENCE_END)
    if not ends:
        return True
    if cur.left - prev.left > INDENT_EM * max(cur.height, 1.0):
        return False
    return prev.width >= SHORT_LINE * band_width


def build_blocks(
    ordered: list[Element], bands: list[tuple[float, float]], page: int
) -> list[Block]:
    """Elements → paragraphs, headings and figures, in reading order."""
    lines = [e for e in ordered if e.kind == "line"]
    body = _body_height(lines)
    leading = _leading(ordered)
    blocks: list[Block] = []
    current: list[Element] = []
    current_band = -1

    def flush() -> None:
        nonlocal current
        if not current:
            return
        text = ""
        for ln in current:
            if text:
                # A word broken across lines rejoins without its hyphen; any
                # other break is a space.
                if text.endswith(_HYPHENS) and ln.text[:1].islower():
                    text = text[:-1]
                else:
                    text += " "
            text += ln.text
        blocks.append(
            Block(
                "para",
                text=text.strip(),
                page=page,
                top=max(ln.top for ln in current),
                bottom=min(ln.bottom for ln in current),
            )
        )
        current = []

    for el in ordered:
        if el.kind == "figure":
            flush()
            blocks.append(
                Block(
                    "figure",
                    page=page,
                    top=el.top,
                    bottom=el.bottom,
                    image=el.image,
                    image_width=el.image_width,
                    image_height=el.image_height,
                )
            )
            continue
        if (
            el.height >= body * BODY_RATIO
            and len(el.text) >= 3
            and len(el.text) <= HEADING_MAX_CHARS
            and not el.text.isdigit()
            # A heading starts a thought with a capital; a fragment of a wrapped
            # line starts lowercase and ends in a comma or a stop. Without this,
            # a paper's shifted math and its table fragments became "headings" —
            # measured on *Sequence to Sequence Learning*, whose six sections
            # were named `ships.`, `SMT [29].` and `and 0.08`.
            and el.text[:1].isupper()
            and not el.text.rstrip().endswith((",", ";"))
        ):
            flush()
            blocks.append(
                Block(
                    "heading",
                    text=el.text.strip(),
                    page=page,
                    size=el.height,
                    top=el.top,
                    bottom=el.bottom,
                )
            )
            continue
        band_width = bands[el.band][1] - bands[el.band][0] if 0 <= el.band < len(bands) else 0.0
        if current and (el.band != current_band or not _joins(current[-1], el, leading, band_width)):
            flush()
        if not current:
            current_band = el.band
        current.append(el)
    flush()
    return [b for b in blocks if b.kind != "para" or b.text]


def assign_heading_levels(pages: list[PageResult]) -> None:
    """Rank the document's heading sizes, with the *dominant* one at level 1.

    Not "the largest size is level 1", which sounds equivalent and is not: a
    book's part titles are larger than its chapter titles and far rarer, so
    ranking by size alone puts chapters at level 2, and `sections_from_headings`
    — which takes level 1 — then finds almost nothing. Measured on *Modernist
    Cuisine, Vol 1*: 1,383 detected headings produced a **one-section** document.
    The dominant heading size is what a book repeats, which is what a TOC is.
    """
    counted = Counter(
        round(b.size, 1) for p in pages for b in p.blocks if b.kind == "heading"
    )
    if not counted:
        return
    common = counted.most_common(1)[0][0]
    smaller = sorted((size for size in counted if size < common), reverse=True)
    levels: dict[float, int] = {size: 2 + min(1, i) for i, size in enumerate(smaller)}
    levels[common] = 1
    for page in pages:
        for b in page.blocks:
            if b.kind == "heading":
                size = round(b.size, 1)
                # Anything larger than the dominant size is its equal as a
                # divider (a part title), never a subsection of it.
                b.level = 1 if size >= common else levels.get(size, HEADING_LEVELS)


# --- figures ---------------------------------------------------------------
def _figure_regions(
    page: pdfium.PdfPage,
    text_boxes: list[tuple[float, float, float, float]],
    page_rect: tuple[float, float, float, float],
) -> tuple[list[tuple[float, float, float, float]], list[tuple[float, float, float, float]]]:
    """Ink regions, split into *figures* and *table-like* regions.

    A figure is cropped and its own text is dropped from the flow (it is already
    in the picture). A table-like region — ink with text all through it — is not
    a figure at all and is never cropped: its words are the book's words and
    throwing away a bordered table's text cost *Sequence to Sequence Learning*
    59% of one page. It is returned separately so the caller can still use its
    box to remove the label-grade fragments a chart leaves behind.
    """
    from PIL import Image  # noqa: F401  (fail loudly if Pillow is missing)

    bitmap = page.render(scale=FIGURE_SCALE)
    image = bitmap.to_pil().convert("L")
    width, height = image.size
    if width < 8 or height < 8:
        return [], []
    pixels = image.load()

    cell = max(1, int(round(FIGURE_CELL_PT * FIGURE_SCALE)))
    cols = max(1, width // cell)
    rows = max(1, height // cell)
    text_cells: set[tuple[int, int]] = set()
    for left, bottom, right, top in text_boxes:
        c0 = max(int(left * FIGURE_SCALE) // cell, 0)
        c1 = min(int(right * FIGURE_SCALE) // cell, cols - 1)
        r0 = max(int((page_rect[3] - top) * FIGURE_SCALE) // cell, 0)
        r1 = min(int((page_rect[3] - bottom) * FIGURE_SCALE) // cell, rows - 1)
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                text_cells.add((r, c))

    ink: set[tuple[int, int]] = set()
    for r in range(rows):
        for c in range(cols):
            if (r, c) in text_cells:
                continue
            y0, x0 = r * cell, c * cell
            found = False
            for y in range(y0, min(y0 + cell, height)):
                for x in range(x0, min(x0 + cell, width)):
                    if pixels[x, y] < INK_THRESHOLD:
                        found = True
                        break
                if found:
                    break
            if found:
                ink.add((r, c))
    if not ink:
        return [], []

    regions: list[tuple[float, float, float, float]] = []
    figures: list[tuple[float, float, float, float]] = []
    table_like: list[tuple[float, float, float, float]] = []
    seen: set[tuple[int, int]] = set()
    for seed in sorted(ink):
        if seed in seen:
            continue
        stack = [seed]
        seen.add(seed)
        r0 = r1 = seed[0]
        c0 = c1 = seed[1]
        while stack:
            r, c = stack.pop()
            r0, r1 = min(r0, r), max(r1, r)
            c0, c1 = min(c0, c), max(c1, c)
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if dr == dc == 0:
                        continue
                    nxt = (r + dr, c + dc)
                    if nxt in ink and nxt not in seen:
                        seen.add(nxt)
                        stack.append(nxt)
        left = max(page_rect[0] + c0 * cell / FIGURE_SCALE, page_rect[0])
        right = min(page_rect[0] + (c1 + 1) * cell / FIGURE_SCALE, page_rect[2])
        top = min(page_rect[3] - r0 * cell / FIGURE_SCALE, page_rect[3])
        bottom = max(page_rect[3] - (r1 + 1) * cell / FIGURE_SCALE, page_rect[1])
        w, h = right - left, top - bottom
        page_w = page_rect[2] - page_rect[0]
        page_h = page_rect[3] - page_rect[1]
        if min(w, h) < FIGURE_MIN_PT or w * h < FIGURE_MIN_AREA:
            continue
        if w * h > FIGURE_MAX_PAGE * page_w * page_h:
            continue
        # A *table* is ink with text all through it: its rules and their bbox
        # make one large region, and treating that as a figure deleted the
        # table's own words — measured on page 7 of *Sequence to Sequence
        # Learning*, where 186 of the page's lines were swallowed by the bbox of
        # a bordered table and the page lost 59% of its text. A figure has ink
        # with only sparse labels inside it, so text coverage is the test.
        covered = 0.0
        for box_left, box_bottom, box_right, box_top in text_boxes:
            overlap_w = max(0.0, min(box_right, right) - max(box_left, left))
            overlap_h = max(0.0, min(box_top, top) - max(box_bottom, bottom))
            covered += overlap_w * overlap_h
        if covered / max(w * h, 1.0) > FIGURE_MAX_TEXT_SHARE:
            table_like.append((left, bottom, right, top))
            continue
        figures.append((left, bottom, right, top))
    return figures, table_like


def _crop(
    page: pdfium.PdfPage, box: tuple[float, float, float, float], page_area: float
) -> Optional[tuple[bytes, int, int]]:
    """Render a region at 2x, trimmed of its white margin, as PNG or JPEG.

    Encoding is chosen by size, and the choice is a size decision, not a taste
    one: a 1,000-page text book whose figures are photographs came out at **116
    MB** when every region was a lossless PNG, against a 305 MB source PDF. Small
    regions — charts, diagrams, line art, where text must stay crisp — stay PNG;
    anything larger is JPEG at 82. The pixel ceiling keeps a full-page plate from
    being rendered at a resolution no reader will ever show.
    """
    try:
        image = page.render(scale=FIGURE_CROP_SCALE, crop=box).to_pil().convert("RGB")
    except Exception:
        # A crop the page cannot render is not worth failing a whole book over.
        return None
    from PIL import Image
    mask = image.convert("L").point(lambda v: 255 if v < 250 else 0)
    bbox = mask.getbbox()
    if bbox:
        pad = 4
        image = image.crop(
            (
                max(bbox[0] - pad, 0),
                max(bbox[1] - pad, 0),
                min(bbox[2] + pad, image.width),
                min(bbox[3] + pad, image.height),
            )
        )
    if max(image.size) > FIGURE_MAX_PIXELS:
        factor = FIGURE_MAX_PIXELS / max(image.size)
        image = image.resize(
            (max(1, int(image.width * factor)), max(1, int(image.height * factor))),
            Image.LANCZOS,
        )
    buffer = io.BytesIO()
    region_area = (box[2] - box[0]) * (box[3] - box[1])
    if region_area > FIGURE_PNG_MAX_SHARE * page_area:
        image.save(buffer, "JPEG", quality=82, optimize=True)
    else:
        image.save(buffer, "PNG", optimize=True)
    return buffer.getvalue(), image.width, image.height


# --- the page pass ---------------------------------------------------------
def _split_at_bands(
    chars: list[Element], bands: list[tuple[float, float]], proto: Element
) -> list[Element]:
    """Cut one y-band's characters into bands — the columns on its baseline.

    A space character that lands in the gutter between columns is attached to
    the band it precedes rather than dropped: a reflow that loses word
    boundaries is worse than one that keeps a trailing space.
    """
    if not chars:
        return []
    if len(bands) < 2:
        ln = Element(
            "line",
            proto.left,
            proto.bottom,
            proto.right,
            proto.top,
            chars=sorted(chars, key=lambda c: c.left),
        )
        _refresh(ln)
        ln.text = _line_text(ln.chars)
        return [ln]
    groups: list[list[Element]] = [[] for _ in bands]
    for c in sorted(chars, key=lambda c: c.left):
        centre = (c.left + c.right) / 2
        index = None
        for i, (lo, hi) in enumerate(bands):
            if lo <= centre <= hi:
                index = i
                break
        if index is None:
            index = min(
                range(len(bands)),
                key=lambda i: min(abs(centre - bands[i][0]), abs(centre - bands[i][1])),
            )
            if not c.text.strip() and index > 0 and not groups[index]:
                index -= 1
        groups[index].append(c)
    out: list[Element] = []
    for group in groups:
        if not group:
            continue
        ln = Element("line", proto.left, proto.bottom, proto.right, proto.top, chars=group)
        _refresh(ln)
        ln.text = _line_text(group)
        ln.split = True
        out.append(ln)
    return out


def _refresh(ln: Element) -> None:
    """A line's box and its *size*: the middle character's height, not the max.

    The max is what made math and table rows look like headings: one superscript
    or one tall glyph in an otherwise body-sized line pushed the line's height
    past the heading threshold, so *Attention is All You Need* produced 27
    "headings", including `O(n2 · d) O(1) O(1)` and a table caption. The median
    character is the line's apparent type size, and it is what a reader sees.
    """
    if not ln.chars:
        return
    ln.left = min(c.left for c in ln.chars)
    ln.right = max(c.right for c in ln.chars)
    ln.bottom = min(c.bottom for c in ln.chars)
    ln.top = max(c.top for c in ln.chars)
    heights = sorted(_height(c) for c in ln.chars)
    ln.height = heights[len(heights) // 2]


def extract_page(page: pdfium.PdfPage, index: int) -> PageResult:
    """One page → blocks in reading order, plus what the pass is unsure of."""
    started = time.perf_counter()
    result = PageResult(index=index)
    page_rect = page.get_bbox()
    result.top, result.bottom = page_rect[3], page_rect[1]
    chars = _page_chars(page.get_textpage())
    result.chars = sum(1 for c in chars if c.text.strip())
    if result.chars < MIN_PAGE_CHARS:
        result.flags.append("no_text")
        result.seconds = time.perf_counter() - started
        return result

    band_width = page_rect[2] - page_rect[0]
    rough = _group_lines(chars)
    bands = _find_bands(rough, band_width)
    result.bands = len(bands)
    elements: list[Element] = []
    for ln in rough:
        pieces = _split_at_bands(ln.chars, bands, ln)
        if len(pieces) > 1:
            result.cross_band += 1
        elements.extend(pieces)
    result.lines = sum(1 for e in elements if e.text.strip())

    # Characters that sit in a gutter belong to no band, and a page full of them
    # is one we cannot claim to have ordered.
    valley = sum(
        1
        for c in chars
        if c.text.strip()
        and not any(lo <= (c.left + c.right) / 2 <= hi for lo, hi in bands)
    )
    if result.chars and valley / result.chars > VALLEY_CHAR_LIMIT:
        result.flags.append("valley_chars")

    boxes = [(e.left, e.bottom, e.right, e.top) for e in elements]
    regions, table_like = _figure_regions(page, boxes, page_rect)
    page_area = max((page_rect[2] - page_rect[0]) * (page_rect[3] - page_rect[1]), 1.0)
    for box in regions:
        cropped = _crop(page, box, page_area)
        if not cropped:
            continue
        data, width, height = cropped
        elements.append(
            Element(
                "figure", box[0], box[1], box[2], box[3],
                image=data, image_width=width, image_height=height,
            )
        )

    # Text that sits *inside* a figure is part of the figure — a chart's data
    # labels, an axis, a diagram's own words. It is already in the crop, so
    # leaving it in the flow prints it twice: once as prose, once as a picture.
    if regions or table_like:
        kept: list[Element] = []
        for el in elements:
            if el.kind == "line" and _inside(el, regions):
                result.figures_swallowed += 1
                continue
            # Inside a table-like region only the *fragments* go: a row is a long
            # line and stays, a chart's axis label (`Moon`, `Earth`,
            # `Temperature (K)`) is a short one and is what makes a figure-heavy
            # book read as noise — measured on *Universe*, whose first run put
            # 21,472 single-letter tokens into the flow.
            if el.kind == "line" and _label_inside(el, table_like):
                result.labels_swallowed += 1
                continue
            kept.append(el)
        elements = kept

    result.blocks = build_blocks(order_elements(elements, bands), bands, index)
    if len(bands) > MAX_BANDS:
        result.flags.append("many_bands")
    result.seconds = time.perf_counter() - started
    return result


def _inside(el: Element, regions: list[tuple[float, float, float, float]]) -> bool:
    """Is most of this element inside one of these regions?"""
    area = max((el.right - el.left) * (el.top - el.bottom), 1.0)
    for left, bottom, right, top in regions:
        overlap_w = max(0.0, min(el.right, right) - max(el.left, left))
        overlap_h = max(0.0, min(el.top, top) - max(el.bottom, bottom))
        if overlap_w * overlap_h / area >= 0.6:
            return True
    return False


def _label_inside(
    el: Element, regions: list[tuple[float, float, float, float]]
) -> bool:
    """Is this a short label sitting inside a table-like region?"""
    if len(el.text) > TABLE_LABEL_MAX_CHARS:
        return False
    if not _inside(el, regions):
        return False
    for left, _bottom, right, _top in regions:
        if left <= (el.left + el.right) / 2 <= right:
            return el.width < TABLE_LABEL_MAX_SHARE * max(right - left, 1.0)
    return False


# --- running heads ---------------------------------------------------------
def _normalise(text: str) -> str:
    return _WS.sub(" ", re.sub(r"\d+", "#", text)).strip().lower()


def mark_running_heads(doc: Document) -> None:
    """Drop the repeated page furniture, and record what was dropped.

    A running head is a line that (a) repeats across many pages, (b) sits in the
    page's top or bottom band, and (c) differs between pages only by digits.
    Without this, every page of a textbook opens with its own header inside the
    flowing text — the loudest possible reflow defect.

    The position and length tests are not decoration. Without them the digit
    normalisation alone decides the question, so every numeric block normalises
    to `#`, "appears" on every page, and is deleted: measured on *Universe*,
    442 blocks went that way on the first run, which is why its text was missing
    3,421 instances of the word `the` — those blocks were the pages' real prose,
    dropped because a citation read `(p. 123)` on page one and `(p. 124)` on
    page two.
    """
    text_pages = doc.text_pages
    if len(text_pages) < RUNNING_HEAD_MIN:
        return
    seen: dict[str, int] = {}
    for page in text_pages:
        for block in page.blocks:
            if _is_furniture(block, page):
                key = _normalise(block.text)
                seen[key] = seen.get(key, 0) + 1
    threshold = max(RUNNING_HEAD_MIN, RUNNING_HEAD_PAGES * len(text_pages))
    repeats = {t for t, n in seen.items() if n >= threshold}
    if not repeats:
        return
    for page in text_pages:
        kept: list[Block] = []
        for block in page.blocks:
            if _is_furniture(block, page) and _normalise(block.text) in repeats:
                doc.dropped_running_heads.append(block.text)
                continue
            kept.append(block)
        page.blocks = kept


def _is_furniture(block: Block, page: PageResult) -> bool:
    """Is this block page furniture rather than content?"""
    if block.kind == "figure" or not block.text.strip():
        return False
    if len(block.text) > RUNNING_HEAD_MAX_CHARS:
        return False
    height = page.top - page.bottom
    if height <= 0:
        return False
    in_band = (
        block.top >= page.bottom + (1 - RUNNING_HEAD_BAND) * height
        or block.bottom <= page.bottom + RUNNING_HEAD_BAND * height
    )
    if not in_band:
        return False
    # A bare page number is furniture; a bare number anywhere else is not.
    apart_from_digits = re.sub(r"[\d#\s]", "", _normalise(block.text))
    return bool(apart_from_digits) or len(block.text.strip()) <= 5


def _verdict(doc: Document) -> None:
    """The per-book confidence gate (D6): order it or keep the original.

    The signals are deliberately about *our own* uncertainty rather than about
    the page being complex: a two-column page is not a problem (splitting its
    baselines is the pass working), while a page carrying more bands than this
    pass claims to order, or characters stranded in a gutter, is.
    """
    text_pages = doc.text_pages
    if not text_pages:
        doc.verdict, doc.reason = "no_text_layer", "no page carries a text layer"
        return
    flagged = [p for p in text_pages if "many_bands" in p.flags or "valley_chars" in p.flags]
    if len(flagged) > 0.25 * len(text_pages):
        doc.verdict = "unstable_layout"
        doc.reason = (
            f"{len(flagged)} of {len(text_pages)} pages carry more bands than this pass "
            "can order (or characters stranded in a gutter)"
        )
        return
    doc.verdict, doc.reason = "ok", ""


def analyse(
    path: str,
    sections: Optional[list[tuple[str, int]]] = None,
    limit: Optional[int] = None,
) -> Document:
    """A whole PDF → a Document the EPUB writer can lay out."""
    doc = Document(source=path, sections=list(sections or []))
    pdf = pdfium.PdfDocument(path)
    try:
        total = len(pdf)
        for i in range(min(total, limit) if limit else total):
            doc.pages.append(extract_page(pdf[i], i))
    finally:
        pdf.close()
    mark_running_heads(doc)
    assign_heading_levels(doc.pages)
    _verdict(doc)
    return doc
