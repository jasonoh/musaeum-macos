"""PDF → blocks: the page pass the reflow rests on.

**What changed in slice 1R, and why.** Slice 1 ordered each page with its own
projection-profile column detector over pdfium's characters, and the owner's
reading found every corpus book interleaved. The review traced it to that pass
(spec Annex C.1): one profile over a whole page, which any spanning title or
caption defeats. Reading order now comes from Apple Vision through the layout
helper (`vision.py`), and the words from the text layer (`regions.py`). What is
left here is everything around them: figures, plates, roles, page furniture,
footnotes across a page break, and the per-book verdict.

**A figure is any non-text ink**, not an embedded image object: charts, vector
line art and scanned plates are all invisible to `page.get_objects()`, while a
coarse ink grid over a 0.25-scale render sees all three, and the crop is then
rendered at 2x. Vision does not report figures, so this stays ours.

**Conservative by construction.** A book whose pages cannot be laid out falls
back to the original (D6) with one line saying why; nothing here raises.
"""

from __future__ import annotations

import io
import re
from collections import Counter
from dataclasses import dataclass
from typing import Optional

import pypdfium2 as pdfium

from .chars import page_chars
from .model import MIN_PAGE_CHARS, Block, Box, Document, PageResult
from .regions import build_page_text, join_lines
from .vision import LayoutUnavailable, PageLayout, run_helper

# --- tunables, each one measured against the corpus rather than guessed -----

FIGURE_SCALE = 0.25  # the analysis render: a 612x792 page becomes 153x198
FIGURE_CELL_PT = 12.0  # the ink grid's cell, in points
FIGURE_MIN_PT = 24.0  # a region thinner than this is a rule, not a figure
FIGURE_MIN_AREA = 4000.0  # square points
FIGURE_MAX_PAGE = 0.80  # a region this much of the page is a background, unless it is nearly textless
FIGURE_BACKGROUND_TEXT_SHARE = 0.10  # a page-sized region is a photo only if this little of it is text
FIGURE_MAX_TEXT_SHARE = 0.25  # a region this covered in text is a table, not a figure
FIGURE_CROP_SCALE = 2.0  # the crop actually written into the EPUB
FIGURE_MAX_PIXELS = 1400  # a figure is never rendered larger than this
PLATE_MAX_PIXELS = 1400  # a plate's long side
FIGURE_PNG_MAX_SHARE = 0.06  # above this share of the page a figure is JPEG
INK_THRESHOLD = 245  # a pixel darker than this at analysis scale is ink
RUNNING_HEAD_PAGES = 0.25  # the share of pages that makes a line a running head
RUNNING_HEAD_MIN = 3
RUNNING_HEAD_BAND = 0.08  # of the page height, top and bottom, where it sits
RUNNING_HEAD_MAX_CHARS = 80
HEADING_RATIO = 1.15  # a region this much larger than the body may be a heading
HEADING_MAX_CHARS = 120
HEADING_MAX_LINES = 2
HEADING_LEVELS = 3
FOOTNOTE_RATIO = 0.85  # a region this much smaller than the body…
FOOTNOTE_ZONE = 0.25  # …inside the bottom quarter of its page is a footnote
LAYOUT_ERROR_SHARE = 0.25  # more text pages than this without a layout: fall back
_SENTENCE_END = (".", "!", "?", ":", "”", "’", '"')

_WS = re.compile(r"\s+")


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
        c0 = max(int((left - page_rect[0]) * FIGURE_SCALE) // cell, 0)
        c1 = min(int((right - page_rect[0]) * FIGURE_SCALE) // cell, cols - 1)
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
        covered = 0.0
        for box_left, box_bottom, box_right, box_top in text_boxes:
            overlap_w = max(0.0, min(box_right, right) - max(box_left, left))
            overlap_h = max(0.0, min(box_top, top) - max(box_bottom, bottom))
            covered += overlap_w * overlap_h
        share = covered / max(w * h, 1.0)
        # A page-sized region is a full-bleed photo only when it carries almost
        # no text; with text through it, it is a tinted background. Slice 1
        # discarded every region over 80% of the page, photos included.
        if w * h > FIGURE_MAX_PAGE * page_w * page_h and share >= FIGURE_BACKGROUND_TEXT_SHARE:
            continue
        # A *table* is ink with text all through it: its rules and their bbox
        # make one large region, and treating that as a figure deleted the
        # table's own words — measured on page 7 of *Sequence to Sequence
        # Learning*, where 186 of the page's lines were swallowed by the bbox of
        # a bordered table and the page lost 59% of its text. A figure has ink
        # with only sparse labels inside it, so text coverage is the test.
        if share > FIGURE_MAX_TEXT_SHARE:
            table_like.append((left, bottom, right, top))
            continue
        figures.append((left, bottom, right, top))
    return figures, table_like


@dataclass
class Crop:
    data: bytes
    width: int
    height: int
    image_type: str  # 'png' | 'jpeg'


def _crop(page: pdfium.PdfPage, box: Box, page_rect: Box) -> Optional[Crop]:
    """Render a region at 2x, trimmed of its white margin, as PNG or JPEG.

    pypdfium2's `crop` is the amount to cut off each edge, measured from the
    page box — not a region. Slice 1 passed the region itself, so most crops
    raised `ValueError: Crop exceeds page dimensions` (29 of 44 on *Universe*,
    34 of 41 on *Modernist Cuisine*) and the rest rendered the wrong part of
    the page, which is where the 7×406 slivers came from (spec Annex C.1).

    Encoding is chosen by size, and the choice is a size decision, not a taste
    one: a figure-heavy textbook came out at **116 MB** when every region was a
    lossless PNG, against a 305 MB source. Small regions — charts, diagrams,
    line art, where text must stay crisp — stay PNG; anything larger is JPEG.
    The returned `image_type` names the file, so the bytes and the name agree.
    """
    px0, py0, px1, py1 = page_rect
    left, bottom, right, top = box
    margins = (max(left - px0, 0.0), max(bottom - py0, 0.0), max(px1 - right, 0.0), max(py1 - top, 0.0))
    if (px1 - px0) - margins[0] - margins[2] < 1 or (py1 - py0) - margins[1] - margins[3] < 1:
        return None
    try:
        image = page.render(scale=FIGURE_CROP_SCALE, crop=margins).to_pil().convert("RGB")
    except Exception:
        # A crop the page cannot render is not worth failing a whole book
        # over; the caller records it and keeps the region's text.
        return None
    from PIL import Image

    mask = image.convert("L").point(lambda v: 255 if v < 250 else 0)
    bbox = mask.getbbox()
    if bbox:
        pad = 4
        image = image.crop(
            (max(bbox[0] - pad, 0), max(bbox[1] - pad, 0), min(bbox[2] + pad, image.width), min(bbox[3] + pad, image.height))
        )
    if max(image.size) > FIGURE_MAX_PIXELS:
        factor = FIGURE_MAX_PIXELS / max(image.size)
        image = image.resize((max(1, int(image.width * factor)), max(1, int(image.height * factor))), Image.LANCZOS)
    buffer = io.BytesIO()
    page_area = max((px1 - px0) * (py1 - py0), 1.0)
    if (right - left) * (top - bottom) > FIGURE_PNG_MAX_SHARE * page_area:
        image.save(buffer, "JPEG", quality=82, optimize=True)
        kind = "jpeg"
    else:
        image.save(buffer, "PNG", optimize=True)
        kind = "png"
    return Crop(buffer.getvalue(), image.width, image.height, kind)


def _has_ink(page: pdfium.PdfPage) -> bool:
    image = page.render(scale=FIGURE_SCALE).to_pil().convert("L")
    return image.getextrema()[0] < INK_THRESHOLD


def render_plate(page: pdfium.PdfPage) -> Optional[Crop]:
    """A text-less page with ink on it, as one JPEG.

    Slice 1 returned before figure extraction on any page under 50
    characters, so every photo plate vanished (*Modernist Cuisine*: 6 of 6
    sampled text-less pages carried images).
    """
    if not _has_ink(page):
        return None
    width, height = page.get_size()
    scale = min(FIGURE_CROP_SCALE, PLATE_MAX_PIXELS / max(width, height, 1.0))
    try:
        image = page.render(scale=scale).to_pil().convert("RGB")
    except Exception:
        return None
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=82, optimize=True)
    return Crop(buffer.getvalue(), image.width, image.height, "jpeg")


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
    if block.kind in ("figure", "table") or not block.text.strip():
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


# --- roles (spec Annex C.5 item 4) ------------------------------------------
def _size_key(size: float) -> float:
    return round(size * 2) / 2


def classify_roles(pages: list[PageResult]) -> float:
    """Headings and footnotes, from font size and weight against the body.

    The body is the size carrying the most characters. Slice 1 measured
    glyph-box heights instead, which made body lines headings and missed a
    paper's bold section titles at the body's own size. Heading levels rank the
    heading sizes, largest first; an outline entry that later claims a heading
    overrides its level with the outline's depth (`epub.link_entries`).

    Returns the body size, which `stitch_pages` needs: what a page ends with is
    a *body* paragraph, not whatever Vision put last.
    """
    sizes: Counter = Counter()
    bold_chars = all_chars = 0
    for page in pages:
        for b in page.blocks:
            if b.kind == "para" and b.size > 0:
                n = len(b.text)
                sizes[_size_key(b.size)] += n
                all_chars += n
                bold_chars += n if b.bold else 0
    if not sizes:
        return 0.0
    body = sizes.most_common(1)[0][0]
    body_bold = bold_chars * 2 > all_chars
    for page in pages:
        height = max(page.top - page.bottom, 1.0)
        for b in page.blocks:
            if b.kind != "para" or b.size <= 0:
                continue
            short = b.lines <= HEADING_MAX_LINES and len(b.text) <= HEADING_MAX_CHARS and re.search(r"[A-Za-z]{2}", b.text)
            if short and (b.size >= HEADING_RATIO * body or (b.lines == 1 and b.bold and not body_bold)):
                b.kind = "heading"
            elif b.size <= FOOTNOTE_RATIO * body and b.top <= page.bottom + FOOTNOTE_ZONE * height:
                b.kind = "footnote"
    ranked = sorted({_size_key(b.size) for p in pages for b in p.blocks if b.kind == "heading"}, reverse=True)
    level_of = {size: min(i + 1, HEADING_LEVELS) for i, size in enumerate(ranked)}
    for page in pages:
        for b in page.blocks:
            if b.kind == "heading":
                b.level = level_of[_size_key(b.size)]
    return body


def _index(blocks: list[Block], block: Block) -> int:
    return next(i for i, b in enumerate(blocks) if b is block)


def _is_body_text(block: Block, body: float) -> bool:
    """Is this paragraph at the document's body size?

    `body` is 0.0 when the page pass could not tell (no sizes at all), and then
    every paragraph counts, which is what the rule did before.
    """
    if block.kind != "para":
        return False
    return body <= 0 or _size_key(block.size) == _size_key(body)


def _is_note_like(block: Block, body: float) -> bool:
    """A block a page carries after its body: a classified footnote, or small
    print at a size the body is not — how Vision leaves a page's notes."""
    if block.kind == "footnote":
        return True
    return block.kind == "para" and body > 0 and _size_key(block.size) != _size_key(body)


def stitch_pages(pages: list[PageResult], body: float = 0.0) -> None:
    """Carry a paragraph across a page break, and its page's notes past it.

    Vision orders a page's footnotes after its last paragraph, so a sentence
    running on to the next page would be read with the notes in its middle —
    *Attention is All You Need*'s Introduction, pages 1 to 2. When a page's
    last **body-sized** paragraph ends without terminal punctuation: a next page
    that opens in lower case is the same paragraph and is joined to it;
    otherwise the note-sized blocks behind it move to just after the next page's
    first paragraph.

    *Body-sized* is the whole point of passing `body` in. *Attention* p.1 ends
    with its NIPS venue line — 9.0pt against a 10.0pt body, and a full stop — so
    the page's "last paragraph" was the venue line, the join never fired, and
    the notes sat in the middle of the introduction's first sentence (golden
    passage G1 #3). The page's text ends where its body size ends; everything
    smaller behind it is the note block Vision put there.

    The join *removes* the paragraph it takes, and a page holding only that
    one then has none left — *Universe* pages 290→291 end in the copyright
    footer, which carries no terminal punctuation, and page 291 is a single
    paragraph starting in lower case. The paragraph list is therefore read
    per page as the loop reaches it, not once at the top: the snapshot is what
    made `[-1]` an `IndexError` that took down the whole book.
    """
    text_pages = [p for p in pages if any(b.kind == "para" for b in p.blocks)]
    for page, nxt in zip(text_pages, text_pages[1:]):
        last = next(
            (b for b in reversed(page.blocks) if _is_body_text(b, body)), None
        )
        if last is None:
            # Nothing at body size is left here (the previous page's join took
            # this page's only paragraph), so there is nothing to carry onward.
            continue
        if last.text.rstrip().endswith(_SENTENCE_END):
            continue
        first = next((b for b in nxt.blocks if b.kind == "para"), None)
        if first is None:
            continue
        if first.text[:1].islower():
            last.text = join_lines([last.text, first.text])
            last.lines += first.lines
            del nxt.blocks[_index(nxt.blocks, first)]
            continue
        start = _index(page.blocks, last)
        notes = [b for b in page.blocks[start + 1 :] if _is_note_like(b, body) and b.text]
        if not notes:
            continue
        page.blocks = [b for b in page.blocks if not any(b is n for n in notes)]
        at = _index(nxt.blocks, first) + 1
        nxt.blocks[at:at] = notes


def place_figures(text_blocks: list[Block], figures: list[Block]) -> list[Block]:
    """Each figure before the first block that lies below it in its column.

    "Below" is the block's top at or under the figure's bottom; "its column"
    is any horizontal overlap. A figure with nothing below it closes the page.
    """
    out = list(text_blocks)
    for fig in sorted(figures, key=lambda f: -f.top):
        at = len(out)
        for i, b in enumerate(out):
            if b.kind == "figure":
                continue
            if b.top <= fig.bottom + 2.0 and min(b.right, fig.right) - max(b.left, fig.left) > 0:
                at = i
                break
        out.insert(at, fig)
    return out


def _verdict(doc: Document) -> None:
    """The per-book confidence gate (D6): lay it out, or keep the original."""
    text_pages = doc.text_pages
    if not text_pages:
        doc.verdict, doc.reason = "no_text_layer", "no page carries a text layer"
    elif doc.layout_errors > LAYOUT_ERROR_SHARE * len(text_pages):
        doc.verdict = "unstable_layout"
        doc.reason = f"{doc.layout_errors} of {len(text_pages)} text pages could not be laid out"
    else:
        doc.verdict, doc.reason = "ok", ""


def _text_count(page: pdfium.PdfPage) -> int:
    return len(re.sub(r"\s", "", page.get_textpage().get_text_range()))


def _page(page: pdfium.PdfPage, index: int, layout: Optional[PageLayout], doc: Document) -> PageResult:
    result = PageResult(index=index)
    rect = page.get_bbox()
    result.top, result.bottom = rect[3], rect[1]
    chars = page_chars(page.get_textpage())
    result.chars = sum(1 for c in chars if not c.is_space)
    if result.chars < MIN_PAGE_CHARS:
        plate = render_plate(page)
        if plate is not None:
            result.plate = True
            result.blocks = [
                Block(
                    "figure", page=index, left=rect[0], bottom=rect[1], right=rect[2], top=rect[3],
                    image=plate.data, image_width=plate.width, image_height=plate.height,
                    image_type=plate.image_type, plate=True,
                )
            ]
        return result

    usable = layout is not None and layout.error is None and bool(layout.regions or layout.tables)
    if not usable:
        doc.layout_errors += 1
        result.flags.append("layout_error")
        mask = [(c.left, c.bottom, c.right, c.top) for c in chars if not c.is_space]
    else:
        mask = [r.bbox for r in layout.regions] + [t.bbox for t in layout.tables]

    regions, _table_like = _figure_regions(page, mask, rect)
    result.figures_detected = len(regions)
    figures: list[Block] = []
    for box in regions:
        crop = _crop(page, box, rect)
        if crop is None:
            result.crop_failures.append(f"page {index + 1} box {tuple(round(v, 1) for v in box)}")
            continue
        result.figure_boxes.append(box)
        figures.append(
            Block(
                "figure", page=index, left=box[0], bottom=box[1], right=box[2], top=box[3],
                image=crop.data, image_width=crop.width, image_height=crop.height, image_type=crop.image_type,
            )
        )

    text = build_page_text(index, chars, layout if usable else None, result.figure_boxes, rect)
    doc.orphans += text.orphans
    doc.vision_regions += text.vision_regions
    if text.vision_regions:
        doc.vision_pages.add(index)
    doc.dropped_text.extend(text.dropped_text)
    result.blocks = place_figures(text.blocks, figures)
    return result


def analyse(path: str, limit: Optional[int] = None, layouts: Optional[dict[int, PageLayout]] = None) -> Document:
    """A whole PDF → a Document the EPUB writer can lay out, or a verdict saying why not.

    `layouts` (keyed by 1-based page number) is the helper's answer; when it
    is `None` the helper is run. A book with no text layer never runs it.
    """
    doc = Document(source=path)
    try:
        pdf = pdfium.PdfDocument(path)
    except Exception as err:
        doc.verdict, doc.reason = "unreadable", f"the PDF cannot be opened ({type(err).__name__})"
        return doc
    try:
        count = min(len(pdf), limit) if limit else len(pdf)
        counts = [_text_count(pdf[i]) for i in range(count)]
        if not any(n >= MIN_PAGE_CHARS for n in counts):
            doc.pages = [PageResult(index=i, chars=counts[i]) for i in range(count)]
            _verdict(doc)
            return doc
        if layouts is None:
            try:
                layouts = run_helper(path, first=1, last=count)
            except LayoutUnavailable as err:
                doc.verdict, doc.reason = "no_layout", err.reason
                return doc
        for i in range(count):
            doc.pages.append(_page(pdf[i], i, layouts.get(i + 1), doc))
    finally:
        pdf.close()
    doc.figures_detected = sum(p.figures_detected for p in doc.pages)
    doc.plates = sum(1 for p in doc.pages if p.plate)
    doc.crop_failures = [f for p in doc.pages for f in p.crop_failures]
    mark_running_heads(doc)
    body = classify_roles(doc.pages)
    stitch_pages(doc.pages, body)
    _verdict(doc)
    return doc
