# PDF Reflow Slice 1R Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-run the PDF→EPUB reflow spike so the corpus books come out with their images, their reading order and a working TOC — behind a gate that can actually fail a book.

**Architecture:** A ~200-line Swift helper (`helpers/musaeum-layout`) runs Apple Vision's `RecognizeDocumentsRequest` on each rendered page and prints its paragraph and table regions, in reading order, as JSON lines in PDF coordinates. The Python sidecar (`sidecar/reflow/`) fills each region with pdfium's own characters — falling back to Vision's transcript only where the text layer is itself bad OCR — classifies headings and footnotes from font size and weight, crops figures with the ink detector it already had (fixed), and writes an EPUB whose TOC is the whole outline, nested, with every entry anchored to its heading. A rebuilt gate (`sidecar/reflow/gate.py`, driven by `scripts/pdf-reflow-probe.py`) checks golden passages, segment trigrams, rotated text, figure files, TOC and word loss.

**Tech Stack:** Python 3.12 (`pypdfium2` 5.13.0, `pypdf` 6.16.1, `Pillow` 12.3.0 — all already pinned), pytest 9.1.1, Swift 6.4 / Vision / PDFKit via `xcrun swiftc`.

**Spec:** `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` — read **D4R** and **Annex C** (C.4 is the gate, C.5 the algorithm). Annex B is withdrawn; do not build from it.

**Working directory for every command:** `/Users/jasonoh/Projects/musaeum-macos/.delta/worktrees/ab42yb3tr1jv/musaeum-macos` (a clone, branch `feat/pdf-reflow-vision`). This clone has no venv; use the main repo's:

```bash
PY=/Users/jasonoh/Projects/musaeum-macos/sidecar/.venv/bin/python
```

## Global Constraints

- **No new Python dependency.** `sidecar/requirements.txt` is unchanged (AC9 as amended). Only `pypdfium2`, `pypdf`, `Pillow` and the standard library.
- **The helper adds ≤ 1 MB** to the bundle, builds with `xcrun swiftc -O -parse-as-library -target arm64-apple-macos12.0`, guards every Vision call with `@available(macOS 26.0, *)`, and on older macOS prints `"supported": false` and exits 0.
- **Below macOS 26, or with no helper, a book falls back** with verdict `no_layout` and a one-line reason (D6). Never a crash.
- **The spike reads the library and writes only to `--out`.** No `metadata.json`, no database write, nothing inside a book folder (spec Annex B, *What exists*).
- **The pipeline writes nothing to stderr** (AC10). The helper's stderr is captured, not passed through.
- **The EPUB stylesheet sets no colour and no typeface** — the reader owns typography and theme (`sidecar/reflow/epub.py` docstring, `docs/invariants/reader.md`).
- **Artifacts are deterministic**: the identifier and `dcterms:modified` derive from the source's size and mtime, never the clock.
- **Thresholds are the spec's (Annex C.5), verbatim:** region padding 1pt; orphan reach 6pt; a stored space survives only at a glyph gap ≥ 0.1× font size; a synthetic space needs a gap > 0.5× character height; text-source switch when ratio < 0.9 **and** PDF junk ≥ Vision junk + 0.1; heading when ≤ 2 lines, ≤ 120 chars and size ≥ 1.15× body or a single bold line over a non-bold body; footnote when size ≤ 0.85× body in the bottom quarter; furniture in the top/bottom 8%, ≤ 80 chars, repeating on ≥ 25% of text pages or a bare number; figure JPEG above 6% of the page; plate long side ≤ 1,400 px.
- **Gate thresholds (Annex C.4):** trigram recall ≥ 95%; word loss ≤ 3%; TOC ≥ 90% of entries land on a matching heading; no image under 32 px on its short side.
- **Markdown prose is not hard-wrapped** (`CLAUDE.md`, *Markdown*): one line per paragraph in every `.md` edit.
- **Escalate** (stop, hand back) if a gate check still fails after two repair attempts on the same check, or if a fix would need a new dependency.

## Review Focus

1. **A page with `/Rotate 90`.** The helper draws the page rotated; its boxes must still come back in the unrotated PDF space pdfium uses, so ≥ 90% of characters fall inside a region. Pinned in Task 6 (`test_real_helper_handles_a_rotated_page`).
2. **The helper's stream missing a page** (a crash mid-book, or a page it skipped). That page must still read, as one region, and count as a layout error, not raise. Pinned in Task 8 (`test_missing_page_layout_degrades_to_one_region`).
3. **A PDF pdfium cannot open** (corrupt, truncated, encrypted). `analyse` returns verdict `unreadable` with a reason, never an exception. Pinned in Task 8 (`test_unopenable_pdf_is_a_verdict`).
4. **Outline entries that point past the last page, and duplicate titles** ("Foreword" twice in *Modernist Cuisine*). Out-of-range entries are skipped; duplicates each get their own anchor. Pinned in Task 5 (`test_duplicate_titles_get_distinct_anchors`, `test_entries_past_the_end_are_skipped`).
5. **Characters outside every region** (bleed, crop marks, text off the crop box). Counted as orphans, never a crash and never a stray paragraph. Pinned in Task 7 (`test_char_outside_every_region_is_an_orphan`).

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `sidecar/tests/reflow_pdfs.py` (new) | hand-written fixture PDFs: text in two fonts, rotated text, ink rectangles, crop box, `/Rotate`, outlines | 1 |
| `sidecar/reflow/chars.py` (new) | pdfium characters with size, bold, angle; baseline clustering | 1 |
| `sidecar/reflow/gate.py` (new) | the corpus gate's checks G1–G7, pure functions over an EPUB and pdfium pages | 2 |
| `sidecar/reflow/outline.py` | the outline as `Entry`s at every depth (Task 2, additive), then the TOC source (Task 5) | 2, 5 |
| `scripts/reflow-golden.json` (new) | the golden passages G1 checks, read off the pages by a person | 3 |
| `scripts/pdf-reflow-probe.py` | `--gate-only`, then the full gate on a fresh run | 3, 8 |
| `sidecar/reflow/model.py` (new) | `Block`, `PageResult`, `Document`, `clean_text`, `Box` — moved out of `layout.py` so `regions.py` can import them without a cycle | 4 |
| `sidecar/reflow/layout.py` | figures, plates, roles, furniture, figure placement, `analyse`; the old band pass deleted | 4, 8 |
| `sidecar/reflow/epub.py` | images named by encoding; nested nav anchored on headings; tables, footnotes | 4, 5 |
| `helpers/musaeum-layout/main.swift` (new) | the Vision helper | 6 |
| `scripts/build-layout-helper.sh` (new) | builds it into `helpers/bin/` (gitignored) | 6 |
| `sidecar/reflow/vision.py` (new) | runs the helper, parses its stream | 6 |
| `sidecar/reflow/regions.py` (new) | characters → regions → paragraph and table blocks | 7 |
| `sidecar/tests/test_reflow_*.py` (new) | one file per module | 1–8 |
| spec Annex C.7, `tasks.md` | the gate's two recorded runs | 3, 9 |

Run the whole reflow suite at any point with:

```bash
$PY -m pytest sidecar/tests -k reflow -q
```

---

### Task 1: Fixture PDFs and pdfium characters

**Files:**
- Create: `sidecar/tests/reflow_pdfs.py`
- Create: `sidecar/reflow/chars.py`
- Test: `sidecar/tests/test_reflow_chars.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `tests.reflow_pdfs`: `Text(x, y, text, size=10.0, bold=False, rotated=False)`, `Rect(x, y, w, h, gray=0.0)`, `Page(texts=[], rects=[], width=612.0, height=792.0, crop=None, rotate=0)`, `OutlineItem(title, page, depth=0, top=None)`, `write_pdf(path, pages, outline=None) -> str`.
  - `reflow.chars`: `Char(text, left, bottom, right, top, size=0.0, bold=False, angle=0.0)` with properties `cx`, `cy`, `height`, `rotated`, `is_space`; `page_chars(textpage) -> list[Char]`; `baseline_lines(chars: list[Char]) -> list[list[Char]]` (top to bottom, each sorted by `cx`; rotated characters must be removed by the caller).

- [ ] **Step 1: Write the fixture generator**

Create `sidecar/tests/reflow_pdfs.py`:

```python
"""Tiny PDFs for the reflow tests, written by hand so no test needs the NAS.

Helvetica and Helvetica-Bold are two of the PDF standard 14 fonts, so a page
needs no embedded font: pdfium maps their glyphs to Unicode, reports the font
size, and names the font (`Helvetica-Bold`) — which is how bold is read, since
pdfium reports weight 0 for a font with no descriptor (measured 2026-10-08).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Text:
    x: float
    y: float
    text: str
    size: float = 10.0
    bold: bool = False
    rotated: bool = False  # 90° anticlockwise, like an arXiv stamp


@dataclass
class Rect:
    """A filled rectangle: ink that is not text, i.e. a figure's stand-in."""

    x: float
    y: float
    w: float
    h: float
    gray: float = 0.0


@dataclass
class Page:
    texts: list[Text] = field(default_factory=list)
    rects: list[Rect] = field(default_factory=list)
    width: float = 612.0
    height: float = 792.0
    crop: Optional[tuple[float, float, float, float]] = None
    rotate: int = 0


@dataclass
class OutlineItem:
    title: str
    page: int  # 0-based
    depth: int = 0
    top: Optional[float] = None  # an /XYZ destination's y, in PDF units


def _escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _content(page: Page) -> bytes:
    ops: list[str] = []
    for r in page.rects:
        ops.append(f"{r.gray} g {r.x} {r.y} {r.w} {r.h} re f")
    for t in page.texts:
        font = "F2" if t.bold else "F1"
        if t.rotated:
            ops.append(f"0 g BT /{font} {t.size} Tf 0 1 -1 0 {t.x} {t.y} Tm ({_escape(t.text)}) Tj ET")
        else:
            ops.append(f"0 g BT /{font} {t.size} Tf {t.x} {t.y} Td ({_escape(t.text)}) Tj ET")
    return "\n".join(ops).encode("latin-1")


def write_pdf(path, pages: list[Page], outline: Optional[list[OutlineItem]] = None) -> str:
    """Write `pages` as a PDF at `path`, with an optional outline. Returns the path."""
    objs: list[bytes] = []

    def add(body) -> int:
        objs.append(body if isinstance(body, bytes) else body.encode("latin-1"))
        return len(objs)

    catalog = add(b"")
    pages_obj = add(b"")
    f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
    kids: list[int] = []
    for p in pages:
        data = _content(p)
        content = add(f"<< /Length {len(data)} >>\nstream\n".encode("latin-1") + data + b"\nendstream")
        crop = f" /CropBox [{' '.join(str(v) for v in p.crop)}]" if p.crop else ""
        rotate = f" /Rotate {p.rotate}" if p.rotate else ""
        kids.append(
            add(
                f"<< /Type /Page /Parent {pages_obj} 0 R /MediaBox [0 0 {p.width} {p.height}]{crop}{rotate} "
                f"/Resources << /Font << /F1 {f1} 0 R /F2 {f2} 0 R >> >> /Contents {content} 0 R >>"
            )
        )
    objs[catalog - 1] = f"<< /Type /Catalog /Pages {pages_obj} 0 R >>".encode()
    objs[pages_obj - 1] = (
        f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode()
    )
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for o in offsets:
        out += f"{o:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root {catalog} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    with open(path, "wb") as fh:
        fh.write(out)

    if outline:
        from pypdf import PdfReader, PdfWriter
        from pypdf.generic import Fit

        writer = PdfWriter(clone_from=PdfReader(str(path)))
        parents: dict[int, object] = {}
        for item in outline:
            parent = parents.get(item.depth - 1) if item.depth > 0 else None
            fit = Fit.xyz(0, item.top, None) if item.top is not None else Fit.fit()
            parents[item.depth] = writer.add_outline_item(item.title, item.page, parent=parent, fit=fit)
        with open(path, "wb") as fh:
            writer.write(fh)
    return str(path)
```

- [ ] **Step 2: Write the failing tests**

Create `sidecar/tests/test_reflow_chars.py`:

```python
import pypdfium2 as pdfium

from reflow.chars import Char, baseline_lines, page_chars
from tests.reflow_pdfs import Page, Text, write_pdf


def _chars(tmp_path, page):
    pdf = pdfium.PdfDocument(write_pdf(tmp_path / "c.pdf", [page]))
    return page_chars(pdf[0].get_textpage())


def glyphs(text, x, y, size=10.0):
    """One line of synthetic characters; spaces get pdfium's zero-height box."""
    out = []
    for ch in text:
        if ch == " ":
            out.append(Char(" ", x, y, x + size * 0.25, y, size=size))
            x += size * 0.3
        else:
            out.append(Char(ch, x, y, x + size * 0.5, y + size * 0.7, size=size))
            x += size * 0.55
    return out


def _text(line):
    return "".join(c.text for c in line)


def test_page_chars_reports_size_bold_and_rotation(tmp_path):
    chars = _chars(
        tmp_path,
        Page(texts=[Text(72, 720, "Heading", 18, bold=True), Text(72, 700, "body"), Text(30, 300, "arXiv", rotated=True)]),
    )
    h = next(c for c in chars if c.text == "H")
    b = next(c for c in chars if c.text == "b")
    stamp = [c for c in chars if c.text in "arXiv" and c.cx < 40]
    assert (h.size, h.bold, h.rotated) == (18.0, True, False)
    assert (b.size, b.bold, b.rotated) == (10.0, False, False)
    assert stamp and all(c.rotated for c in stamp)


def test_char_boxes_are_absolute_whatever_the_crop_box(tmp_path):
    chars = _chars(tmp_path, Page(texts=[Text(72, 700, "Absolute")], crop=(40, 40, 572, 752)))
    first = next(c for c in chars if c.text == "A")
    assert 71 <= first.left <= 74 and 699 <= first.bottom <= 702


def test_baseline_lines_keeps_a_raised_apostrophe_on_its_line():
    line1 = glyphs("it", 72, 700) + [Char("'", 83, 704.5, 84, 707, size=10)] + glyphs("s", 84.5, 700)
    line2 = glyphs("ok", 72, 686)
    lines = baseline_lines(line2 + line1)
    assert [_text(ln) for ln in lines] == ["it's", "ok"]


def test_baseline_lines_folds_a_superscript_into_its_line():
    line = glyphs("x", 72, 700) + [Char("1", 77.5, 704, 80, 708, size=6)] + glyphs(" y", 81, 700)
    assert [_text(ln) for ln in baseline_lines(line)] == ["x1 y"]


def test_baseline_lines_attaches_spaces_and_drops_strays():
    line = glyphs("a b", 72, 700)
    stray = Char(" ", 400, 100, 402, 100)
    assert [_text(ln) for ln in baseline_lines(line + [stray])] == ["a b"]


def test_baseline_lines_keeps_two_columns_on_one_baseline_together():
    left = glyphs("left", 72, 700)
    right = glyphs("right", 320, 700)
    lines = baseline_lines(right + left)
    assert [_text(ln) for ln in lines] == ["leftright"]
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `$PY -m pytest sidecar/tests/test_reflow_chars.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'reflow.chars'`.

- [ ] **Step 4: Write `chars.py`**

Create `sidecar/reflow/chars.py`:

```python
"""pdfium's characters, with what the reflow needs to know about each one.

The layout comes from Vision (`vision.py`); the words come from here: every
character the PDF's text layer holds, with its box in PDF user space (the crop
box does not shift it), its font size, whether its font is bold, and its
rotation. Measured 2026-10-08: pdfium reports **weight 0** for a font with no
descriptor — the standard 14 fonts and many subset fonts in this library — so
boldness also reads the font's *name*.
"""

from __future__ import annotations

import ctypes
import math
import re
from dataclasses import dataclass, field

import pypdfium2.raw as raw

_BOLD_NAME = re.compile(r"bold|black|heavy|semibold|demi", re.I)
ROTATION_TOLERANCE = 0.05  # radians; an arXiv stamp reads 4.71 (3π/2)
LINE_LOOKBACK = 8  # how many open lines a glyph may join, newest first
MERGE_MAX_GLYPHS = 4  # a line this short that overlaps its neighbour is a superscript


@dataclass
class Char:
    text: str
    left: float
    bottom: float
    right: float
    top: float
    size: float = 0.0
    bold: bool = False
    angle: float = 0.0

    @property
    def cx(self) -> float:
        return (self.left + self.right) / 2

    @property
    def cy(self) -> float:
        return (self.bottom + self.top) / 2

    @property
    def height(self) -> float:
        return max(self.top - self.bottom, 1.0)

    @property
    def rotated(self) -> bool:
        a = self.angle % (2 * math.pi)
        return min(a, 2 * math.pi - a) > ROTATION_TOLERANCE

    @property
    def is_space(self) -> bool:
        return not self.text.strip()


def page_chars(textpage) -> list[Char]:
    """Every character on a page except pdfium's synthesised line breaks."""
    out: list[Char] = []
    buf = ctypes.create_string_buffer(256)
    flags = ctypes.c_int()
    handle = textpage.raw
    for i in range(textpage.count_chars()):
        text = textpage.get_text_range(i, 1)
        if text in ("", "\r", "\n"):
            continue
        left, bottom, right, top = textpage.get_charbox(i)
        weight = int(raw.FPDFText_GetFontWeight(handle, i))
        length = raw.FPDFText_GetFontInfo(handle, i, buf, len(buf), ctypes.byref(flags))
        name = buf.value.decode("latin-1", "replace") if length else ""
        angle = float(raw.FPDFText_GetCharAngle(handle, i))
        out.append(
            Char(
                text,
                left,
                bottom,
                right,
                top,
                size=float(raw.FPDFText_GetFontSize(handle, i)),
                bold=weight >= 600 or bool(_BOLD_NAME.search(name)),
                angle=angle if angle > 0 else 0.0,
            )
        )
    return out


@dataclass
class _Line:
    bottom: float
    top: float
    chars: list[Char] = field(default_factory=list)

    @property
    def height(self) -> float:
        return max(self.top - self.bottom, 1.0)


def _overlap(a_bottom: float, a_top: float, b_bottom: float, b_top: float) -> float:
    return min(a_top, b_top) - max(a_bottom, b_bottom)


def baseline_lines(chars: list[Char]) -> list[list[Char]]:
    """Characters → lines, top to bottom, each sorted by centre x.

    A glyph joins the open line it overlaps vertically by at least half the
    shorter of the two. Slice 1 grouped by "the same bottom within a tolerance"
    instead, which put an apostrophe — whose box starts well above the baseline
    — on a line of its own. A line of a few glyphs that still overlaps its
    neighbour is a superscript and is folded in. Spaces are attached last, to
    the line that contains their centre, because PDFs often give a space a
    zero-height box; a space near no line is dropped. Callers remove rotated
    characters first.
    """
    glyphs = sorted((c for c in chars if not c.is_space), key=lambda c: -c.cy)
    lines: list[_Line] = []
    for c in glyphs:
        best, best_overlap = None, 0.0
        for ln in lines[-LINE_LOOKBACK:]:
            ov = _overlap(c.bottom, c.top, ln.bottom, ln.top)
            if ov > best_overlap:
                best, best_overlap = ln, ov
        if best is not None and best_overlap >= 0.5 * min(c.height, best.height):
            best.chars.append(c)
            best.bottom = min(best.bottom, c.bottom)
            best.top = max(best.top, c.top)
        else:
            lines.append(_Line(c.bottom, c.top, [c]))

    lines.sort(key=lambda ln: -(ln.bottom + ln.top) / 2)
    merged: list[_Line] = []
    for ln in lines:
        prev = merged[-1] if merged else None
        if (
            prev is not None
            and min(len(ln.chars), len(prev.chars)) <= MERGE_MAX_GLYPHS
            and _overlap(ln.bottom, ln.top, prev.bottom, prev.top) > 0
        ):
            prev.chars.extend(ln.chars)
            prev.bottom = min(prev.bottom, ln.bottom)
            prev.top = max(prev.top, ln.top)
        else:
            merged.append(ln)

    for c in chars:
        if not c.is_space:
            continue
        home = next((ln for ln in merged if ln.bottom - 1.0 <= c.cy <= ln.top + 1.0), None)
        if home is not None:
            home.chars.append(c)

    return [sorted(ln.chars, key=lambda c: c.cx) for ln in merged]
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `$PY -m pytest sidecar/tests/test_reflow_chars.py -v`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add sidecar/tests/reflow_pdfs.py sidecar/reflow/chars.py sidecar/tests/test_reflow_chars.py
git commit -m "feat(sidecar): reflow characters with size, bold and rotation; hand-written fixture PDFs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The gate's checks, and the outline they expect

**Files:**
- Create: `sidecar/reflow/gate.py`
- Modify: `sidecar/reflow/outline.py` (additive: `Entry`, `is_junk`, `clean_label`, `normalise_depths`, `outline_entries`; the existing functions stay until Task 5)
- Test: `sidecar/tests/test_reflow_gate.py`

**Interfaces:**
- Consumes: `reflow.chars.Char`, `page_chars`, `baseline_lines` (Task 1); `tests.reflow_pdfs` (Task 1).
- Produces:
  - `reflow.outline`: `Entry(title: str, depth: int, page: int, top: Optional[float] = None)` (frozen dataclass); `is_junk(label: str) -> bool`; `clean_label(label) -> str`; `normalise_depths(entries: list[Entry]) -> list[Entry]`; `outline_entries(path: str, pages: Optional[int] = None) -> list[Entry]`.
  - `reflow.gate`: `tokens(text) -> list[str]`; `spine_text(epub_path) -> str`; `check_golden(spine: str, passages: Sequence[str]) -> list[str]`; `PageEvidence(segments, upright, rotated, plate_expected)`; `page_evidence(page, chars, exclude=(), page_box=None) -> PageEvidence`; `trigram_recall(segments, spine_tokens) -> tuple[float, int]`; `rotated_only(rotated: Iterable[str], upright: Iterable[str]) -> set[str]`; `check_rotated(spine_tokens, rotated_only_tokens) -> list[str]`; `check_figures(epub_path, *, expected_figures: Optional[int], expected_plates: Optional[int]) -> list[str]`; `nav_entries(zf) -> list[tuple[str, int, str]]`; `check_toc(epub_path, expected: Optional[list[tuple[str, int]]]) -> list[str]`; `word_loss(pdf_tokens: Counter, art_tokens: Counter, excluded: Counter) -> tuple[float, Counter]`; `check_package(epub_path) -> list[str]`. Constants `TRIGRAM_RECALL_MIN = 0.95`, `WORD_LOSS_MAX = 0.03`, `TOC_HEADING_SHARE_MIN = 0.90`. Every failure string starts with its check's id (`"G1 "`, `"G4 "`, …).

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_reflow_gate.py`:

```python
import io
import zipfile
from collections import Counter

import pypdfium2 as pdfium
from PIL import Image

from reflow import gate
from reflow.chars import Char
from reflow.outline import Entry, outline_entries
from tests.reflow_pdfs import OutlineItem, Page, Rect, Text, write_pdf

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">x</dc:identifier><dc:title>T</dc:title><dc:language>en</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>{items}</manifest>
<spine>{spine}</spine></package>"""
CONTAINER = """<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"""
XHTML = """<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>{title}</title></head><body>{body}</body></html>"""


def make_epub(path, chapters, nav_ol, images=None):
    """chapters: [(file name, body html)] in spine order; nav_ol: the <ol> inside the toc nav."""
    images = images or {}
    items = "".join(f'<item id="c{i}" href="text/{n}" media-type="application/xhtml+xml"/>' for i, (n, _) in enumerate(chapters))
    items += "".join(f'<item id="i{i}" href="images/{n}" media-type="{m}"/>' for i, (n, (_, m)) in enumerate(images.items()))
    spine = "".join(f'<itemref idref="c{i}"/>' for i in range(len(chapters)))
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip")
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", OPF.format(items=items, spine=spine))
        zf.writestr("OEBPS/nav.xhtml", XHTML.format(title="Contents", body=f'<nav epub:type="toc">{nav_ol}</nav>'))
        for name, body in chapters:
            zf.writestr(f"OEBPS/text/{name}", XHTML.format(title="Chapter Title Words", body=body))
        for name, (data, _) in images.items():
            zf.writestr(f"OEBPS/images/{name}", data)
    return str(path)


def png(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "black").save(buf, "PNG")
    return buf.getvalue()


def jpeg(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "black").save(buf, "JPEG")
    return buf.getvalue()


def row(text, x, y, size=10.0):
    out = []
    for ch in text:
        if ch == " ":
            out.append(Char(" ", x, y, x + 2.5, y))
            x += 3.0
        else:
            out.append(Char(ch, x, y, x + 5, y + 7, size=size))
            x += 5.5
    return out


def test_tokens_normalise_quotes_and_line_break_hyphens():
    assert gate.tokens("Tycho’s mer-\ncenary “soldier”") == ["tycho's", "mercenary", "soldier"]


def test_spine_text_follows_the_spine_and_skips_head_titles(tmp_path):
    epub = make_epub(tmp_path / "a.epub", [("b.xhtml", "<p>second</p>"), ("a.xhtml", "<p>first</p>")], "<ol/>")
    text = gate.spine_text(epub)
    assert text.index("second") < text.index("first")
    assert "Chapter Title Words" not in text


def test_check_golden_needs_the_passage_contiguous(tmp_path):
    spine = "Kepler was born in 1571 to a poor family in a region"
    assert gate.check_golden(spine, ["born in 1571 to a poor family"]) == []
    interleaved = "Kepler was born in 1571 to a poor sky, nearly merging family in a region"
    fails = gate.check_golden(interleaved, ["born in 1571 to a poor family"])
    assert len(fails) == 1 and fails[0].startswith("G1 ")


def test_segments_split_at_a_gutter_and_drop_a_trailing_hyphen_fragment():
    chars = row("left column words", 72, 700) + row("right side mer-", 320, 700)
    ev = gate.page_evidence(None, chars)
    assert ev.segments == [["left", "column", "words"], ["right", "side"]]


def test_segments_skip_page_furniture_and_excluded_boxes():
    chars = row("CHAPTER 4 THE ORIGIN", 72, 20) + row("body words here now", 72, 400) + row("axis label text", 300, 300)
    ev = gate.page_evidence(None, chars, exclude=[(290, 290, 420, 320)], page_box=(0, 0, 612, 792))
    assert ev.segments == [["body", "words", "here", "now"]]


def test_trigram_recall_drops_when_columns_interleave():
    segments = [["a", "b", "c", "d"], ["w", "x", "y", "z"]]
    assert gate.trigram_recall(segments, "a b c d w x y z".split())[0] == 1.0
    assert gate.trigram_recall(segments, "a b w x c d y z".split())[0] == 0.0


def test_rotated_only_tokens_are_caught_in_the_spine():
    stamp = gate.rotated_only(["arxiv", "1706", "03762v5", "2017"], ["2017", "attention"])
    assert stamp == {"arxiv", "1706", "03762v5"}
    assert gate.check_rotated(["attention", "03762v5"], stamp)[0].startswith("G3 ")


def test_check_figures_catches_mislabelled_bytes_slivers_and_counts(tmp_path):
    epub = make_epub(
        tmp_path / "f.epub",
        [("c.xhtml", "<p>x</p>")],
        "<ol/>",
        {"p0001-0.png": (jpeg(100, 100), "image/png"), "p0002-1.png": (png(7, 406), "image/png"), "p0003-plate.jpg": (jpeg(600, 800), "image/jpeg")},
    )
    fails = gate.check_figures(epub, expected_figures=3, expected_plates=1)
    assert any("p0001-0.png" in f and "bytes jpeg" in f for f in fails)
    assert any("p0002-1.png" in f and "sliver" in f for f in fails)
    assert any("2 figures written, 3 detected" in f for f in fails)
    assert all(f.startswith("G4 ") for f in fails)


def test_check_figures_passes_a_clean_package(tmp_path):
    epub = make_epub(
        tmp_path / "g.epub", [("c.xhtml", "<p>x</p>")], "<ol/>",
        {"p0001-0.png": (png(100, 80), "image/png"), "p0002-1.jpg": (jpeg(300, 200), "image/jpeg")},
    )
    assert gate.check_figures(epub, expected_figures=2, expected_plates=0) == []


NAV = """<ol><li><a href="text/c1.xhtml#t1">Introduction</a><ol><li><a href="text/c1.xhtml#t2">Background</a></li></ol></li><li><a href="text/c2.xhtml#t9">Results</a></li></ol>"""


def test_check_toc_compares_with_the_outline_and_resolves_anchors(tmp_path):
    epub = make_epub(
        tmp_path / "t.epub",
        [("c1.xhtml", '<h1 id="t1">1 Introduction</h1><p id="t2">Background prose</p>'), ("c2.xhtml", "<h1>Results</h1>")],
        NAV,
    )
    fails = gate.check_toc(epub, [("Introduction", 0), ("Background", 1), ("Results", 0)])
    assert any("t9" in f and "does not resolve" in f for f in fails)
    assert any("heading" in f for f in fails)  # 1 of 3 lands on a matching heading
    fails = gate.check_toc(epub, [("Introduction", 0), ("Results", 0)])
    assert any("3 entries" in f and "outline has 2" in f for f in fails)


def test_check_toc_passes_when_every_entry_lands_on_its_heading(tmp_path):
    epub = make_epub(
        tmp_path / "u.epub",
        [("c1.xhtml", '<h1 id="t1">Introduction</h1><h2 id="t2">Background</h2>'), ("c2.xhtml", '<h1 id="t9">Results</h1>')],
        NAV,
    )
    assert gate.check_toc(epub, [("Introduction", 0), ("Background", 1), ("Results", 0)]) == []


def test_word_loss_excludes_what_was_dropped_on_purpose():
    pdf = Counter("the cat sat on the mat page 12".split())
    art = Counter("the cat sat on the mat".split())
    loss, missing = gate.word_loss(pdf, art, Counter(["page", "12"]))
    assert loss == 0.0 and not missing


def test_check_package_flags_a_compressed_mimetype(tmp_path):
    path = tmp_path / "bad.epub"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", "application/epub+zip")
    assert any("compressed" in f for f in gate.check_package(str(path)))


def test_plate_expected_on_a_textless_page_with_ink(tmp_path):
    pdf = pdfium.PdfDocument(write_pdf(tmp_path / "p.pdf", [Page(rects=[Rect(0, 0, 612, 792, 0.4)]), Page()]))
    assert gate.page_evidence(pdf[0], []).plate_expected is True
    assert gate.page_evidence(pdf[1], []).plate_expected is False


def test_outline_entries_keep_every_depth_and_drop_printer_marks(tmp_path):
    path = write_pdf(
        tmp_path / "o.pdf",
        [Page(texts=[Text(72, 700, "x")]), Page(texts=[Text(72, 700, "y")])],
        outline=[
            OutlineItem("cover4", 0, 0),
            OutlineItem("Model Architecture", 0, 1, top=700.0),
            OutlineItem("Encoder", 0, 2),
            OutlineItem("ix", 1, 0),
            OutlineItem("Training", 1, 0),
        ],
    )
    assert outline_entries(path) == [
        Entry("Model Architecture", 0, 0, 700.0),
        Entry("Encoder", 1, 0, None),
        Entry("Training", 0, 1, None),
    ]
    # an entry past the pages being read (a `--limit` run) is skipped, not an error
    assert outline_entries(path, pages=1) == [Entry("Model Architecture", 0, 0, 700.0), Entry("Encoder", 1, 0, None)]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$PY -m pytest sidecar/tests/test_reflow_gate.py -v`
Expected: FAIL — `ImportError: cannot import name 'gate' from 'reflow'` (and `Entry` from `reflow.outline`).

- [ ] **Step 3: Add the outline expectation to `outline.py`**

Append to `sidecar/reflow/outline.py` (leave the existing functions alone — Task 5 replaces them):

```python
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
```

- [ ] **Step 4: Write `gate.py`**

Create `sidecar/reflow/gate.py`:

```python
"""The corpus gate (spec Annex C.4): checks that can fail a book.

Slice 1 "passed" because its gate asked only whether the XML parsed and
counted words as a multiset, which cannot see order. Every check here is
computed from the artifact and from what the source PDF says. Where a check is
defined over the pipeline's own bookkeeping — the figure boxes it wrote, the
pages it read from Vision, the furniture it dropped — that input is a named
parameter, so it is visible in the call rather than trusted silently.
"""

from __future__ import annotations

import difflib
import io
import posixpath
import re
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from html import unescape
from typing import Iterable, Optional, Sequence
from xml.etree import ElementTree

from .chars import Char, baseline_lines

Box = tuple[float, float, float, float]

OPF_NS = "{http://www.idpf.org/2007/opf}"
XHTML_NS = "{http://www.w3.org/1999/xhtml}"
EPUB_NS = "{http://www.idpf.org/2007/ops}"
CONTAINER_NS = "{urn:oasis:names:tc:opendocument:xmlns:container}"

TRIGRAM_RECALL_MIN = 0.95
WORD_LOSS_MAX = 0.03
TOC_HEADING_SHARE_MIN = 0.90
TITLE_SIMILARITY = 0.8
MIN_IMAGE_SIDE = 32
FURNITURE_BAND = 0.08
FURNITURE_MAX_CHARS = 80
PLATE_MAX_CHARS = 50
INK_SCALE = 0.25
INK_THRESHOLD = 245

_QUOTES = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"', "￾": "-"})
_TOKEN = re.compile(r"[0-9A-Za-zÀ-ÖØ-öø-ÿ]+(?:'[A-Za-z]+)?")
_LINE_HYPHEN = re.compile(r"(\w)[-‐‑]\s*[\r\n]+\s*(\w)")
_TAG = re.compile(r"<[^>]+>")
_HEAD = re.compile(r"<head\b.*?</head>", re.S | re.I)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_HEADING_TAGS = {f"{XHTML_NS}h{i}" for i in range(1, 7)}


def tokens(text: str) -> list[str]:
    """Lower-case word tokens, quotes folded, words broken at a line end rejoined."""
    text = _LINE_HYPHEN.sub(r"\1\2", text.translate(_QUOTES))
    return [t.lower() for t in _TOKEN.findall(text)]


# --- reading the package -------------------------------------------------
def _opf(zf: zipfile.ZipFile) -> tuple[str, ElementTree.Element]:
    container = ElementTree.fromstring(zf.read("META-INF/container.xml"))
    rootfile = container.find(f".//{CONTAINER_NS}rootfile")
    path = rootfile.get("full-path") if rootfile is not None else "OEBPS/content.opf"
    return path, ElementTree.fromstring(zf.read(path))


def _manifest(zf: zipfile.ZipFile) -> tuple[ElementTree.Element, dict[str, tuple[str, str, str]]]:
    """The OPF, and its manifest as id → (zip path, media type, properties)."""
    path, opf = _opf(zf)
    base = posixpath.dirname(path)
    items = {}
    for item in opf.iter(f"{OPF_NS}item"):
        href = item.get("href") or ""
        items[item.get("id") or ""] = (
            posixpath.normpath(posixpath.join(base, href)),
            item.get("media-type") or "",
            item.get("properties") or "",
        )
    return opf, items


def spine_documents(zf: zipfile.ZipFile) -> list[str]:
    opf, items = _manifest(zf)
    return [items[ref.get("idref")][0] for ref in opf.iter(f"{OPF_NS}itemref") if ref.get("idref") in items]


def spine_text(epub_path: str) -> str:
    """The book's text in reading order: every spine document, tags and <head> removed."""
    with zipfile.ZipFile(epub_path) as zf:
        parts = []
        for name in spine_documents(zf):
            raw = zf.read(name).decode("utf-8", "replace")
            parts.append(unescape(_TAG.sub(" ", _HEAD.sub(" ", raw))))
    return "\n".join(parts)


# --- G1 golden passages ----------------------------------------------------
def check_golden(spine: str, passages: Sequence[str]) -> list[str]:
    haystack = " " + " ".join(tokens(spine)) + " "
    fails = []
    for passage in passages:
        needle = " ".join(tokens(passage))
        if needle and f" {needle} " not in haystack:
            fails.append(f"G1 passage not contiguous: {' '.join(needle.split()[:8])}…")
    return fails


# --- G2/G3/G4 evidence from one PDF page -----------------------------------
@dataclass
class PageEvidence:
    segments: list[list[str]] = field(default_factory=list)
    upright: list[str] = field(default_factory=list)
    rotated: list[str] = field(default_factory=list)
    plate_expected: bool = False


def _in_any(c: Char, boxes: Sequence[Box]) -> bool:
    return any(b[0] <= c.cx <= b[2] and b[1] <= c.cy <= b[3] for b in boxes)


def _is_furniture(seg: list[Char], text: str, page_box: Optional[Box]) -> bool:
    if page_box is None or len(text.strip()) > FURNITURE_MAX_CHARS:
        return False
    height = page_box[3] - page_box[1]
    top = max(c.top for c in seg)
    bottom = min(c.bottom for c in seg)
    return bottom >= page_box[3] - FURNITURE_BAND * height or top <= page_box[1] + FURNITURE_BAND * height


def _has_ink(page) -> bool:
    image = page.render(scale=INK_SCALE).to_pil().convert("L")
    return image.getextrema()[0] < INK_THRESHOLD


def page_evidence(page, chars: Sequence[Char], exclude: Sequence[Box] = (), page_box: Optional[Box] = None) -> PageEvidence:
    """What the gate needs from one page of the source PDF.

    A *segment* is a run of characters on one baseline with no gap wider than
    the line's median glyph height, so it never crosses a gutter: its word
    trigrams must survive into the artifact whatever the layout was. A segment
    ending in a hyphen loses its last fragment, which the artifact rejoins.
    """
    ev = PageEvidence()
    glyph_count = sum(1 for c in chars if not c.is_space)
    if glyph_count < PLATE_MAX_CHARS and page is not None:
        ev.plate_expected = _has_ink(page)
    ev.rotated = tokens("".join(c.text for c in chars if c.rotated))
    upright = [c for c in chars if not c.rotated]
    lines = baseline_lines(upright)
    ev.upright = tokens("\n".join("".join(c.text for c in ln) for ln in lines))
    for line in baseline_lines([c for c in upright if not _in_any(c, exclude)]):
        glyphs = [c for c in line if not c.is_space]
        if not glyphs:
            continue
        heights = sorted(c.height for c in glyphs)
        limit = heights[len(heights) // 2]
        seg: list[Char] = []
        prev: Optional[Char] = None
        for c in line:
            if prev is not None and not c.is_space and c.left - prev.right > limit:
                _emit(seg, ev.segments, page_box)
                seg = []
            seg.append(c)
            if not c.is_space:
                prev = c
        _emit(seg, ev.segments, page_box)
    return ev


def _emit(seg: list[Char], out: list[list[str]], page_box: Optional[Box]) -> None:
    glyphs = [c for c in seg if not c.is_space]
    if not glyphs:
        return
    text = "".join(c.text for c in seg)
    if _is_furniture(glyphs, text, page_box):
        return
    toks = tokens(text)
    if text.rstrip().endswith(("-", "￾", "‐")) and toks:
        toks = toks[:-1]
    if toks:
        out.append(toks)


def trigram_recall(segments: Iterable[list[str]], spine_tokens: Sequence[str]) -> tuple[float, int]:
    """Share of within-segment word trigrams found contiguous in the artifact."""
    have = {tuple(spine_tokens[i : i + 3]) for i in range(len(spine_tokens) - 2)}
    total = found = 0
    for seg in segments:
        for i in range(len(seg) - 2):
            total += 1
            found += tuple(seg[i : i + 3]) in have
    return (found / total if total else 1.0), total


def rotated_only(rotated: Iterable[str], upright: Iterable[str]) -> set[str]:
    """Tokens that exist in the book only as rotated text — the stamp's own words."""
    seen = set(upright)
    return {t for t in rotated if t not in seen and len(t) >= 4}


def check_rotated(spine_tokens: Sequence[str], stamp: set[str]) -> list[str]:
    leaked = sorted(stamp.intersection(spine_tokens))
    return [f"G3 rotated text in the flow: {', '.join(leaked[:6])}"] if leaked else []


# --- G4 figures ------------------------------------------------------------
_MAGIC = {"png": b"\x89PNG\r\n\x1a\n", "jpeg": b"\xff\xd8\xff"}
_EXT = {".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg"}
_MEDIA = {"image/png": "png", "image/jpeg": "jpeg"}


def check_figures(epub_path: str, *, expected_figures: Optional[int], expected_plates: Optional[int]) -> list[str]:
    from PIL import Image

    fails: list[str] = []
    figures = plates = 0
    with zipfile.ZipFile(epub_path) as zf:
        _, items = _manifest(zf)
        for path, media, _ in items.values():
            if not media.startswith("image/"):
                continue
            data = zf.read(path)
            name = posixpath.basename(path)
            by_bytes = next((k for k, m in _MAGIC.items() if data.startswith(m)), None)
            by_ext = _EXT.get(posixpath.splitext(name)[1].lower())
            by_media = _MEDIA.get(media)
            if not (by_bytes == by_ext == by_media):
                fails.append(f"G4 {name}: bytes {by_bytes}, extension {by_ext}, media type {media}")
            try:
                w, h = Image.open(io.BytesIO(data)).size
                if min(w, h) < MIN_IMAGE_SIDE:
                    fails.append(f"G4 {name}: {w}x{h} is a sliver")
            except Exception as err:
                fails.append(f"G4 {name}: unreadable ({type(err).__name__})")
            if "-plate." in name:
                plates += 1
            else:
                figures += 1
    if expected_figures is not None and figures != expected_figures:
        fails.append(f"G4 {figures} figures written, {expected_figures} detected")
    if expected_plates is not None and plates != expected_plates:
        fails.append(f"G4 {plates} plates written, {expected_plates} text-less pages carry ink")
    return fails


# --- G5 TOC ----------------------------------------------------------------
def _norm_title(text: str) -> str:
    return " ".join(_CONTROL.sub("", text).lower().split())[:100]


def _similar(a: str, b: str) -> bool:
    a, b = _norm_title(a), _norm_title(b)
    if not a or not b:
        return False
    if a == b or (min(len(a), len(b)) >= 4 and (a.startswith(b) or b.startswith(a) or a.endswith(b) or b.endswith(a))):
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= TITLE_SIMILARITY


def nav_entries(zf: zipfile.ZipFile) -> list[tuple[str, int, str]]:
    """The toc nav as (title, depth, resolved zip path with fragment)."""
    _, items = _manifest(zf)
    nav_path = next((p for p, _, props in items.values() if "nav" in props.split()), None)
    if nav_path is None:
        return []
    root = ElementTree.fromstring(zf.read(nav_path))
    toc = next((n for n in root.iter(f"{XHTML_NS}nav") if n.get(f"{EPUB_NS}type") == "toc"), None)
    out: list[tuple[str, int, str]] = []

    def walk(ol: ElementTree.Element, depth: int) -> None:
        for li in ol.findall(f"{XHTML_NS}li"):
            a = li.find(f"{XHTML_NS}a")
            if a is not None:
                href = a.get("href") or ""
                target, _, frag = href.partition("#")
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(nav_path), target))
                out.append(("".join(a.itertext()).strip(), depth, f"{resolved}#{frag}" if frag else resolved))
            sub = li.find(f"{XHTML_NS}ol")
            if sub is not None:
                walk(sub, depth + 1)

    top = toc.find(f"{XHTML_NS}ol") if toc is not None else None
    if top is not None:
        walk(top, 0)
    return out


def check_toc(epub_path: str, expected: Optional[list[tuple[str, int]]]) -> list[str]:
    fails: list[str] = []
    with zipfile.ZipFile(epub_path) as zf:
        entries = nav_entries(zf)
        names = set(zf.namelist())
        ids: dict[str, dict[str, ElementTree.Element]] = {}
        if not entries:
            return ["G5 the nav has no entries"]
        if expected is not None:
            got = [(_norm_title(t), d) for t, d, _ in entries]
            want = [(_norm_title(t), d) for t, d in expected]
            if len(got) != len(want):
                fails.append(f"G5 nav has {len(got)} entries, outline has {len(want)}")
            else:
                diff = next((i for i, (g, w) in enumerate(zip(got, want)) if g != w), None)
                if diff is not None:
                    fails.append(f"G5 entry {diff + 1}: nav {got[diff]} vs outline {want[diff]}")
        hits = 0
        for title, _, href in entries:
            path, _, frag = href.partition("#")
            if path not in names:
                fails.append(f"G5 {href} does not resolve (no such file)")
                continue
            if path not in ids:
                root = ElementTree.fromstring(zf.read(path))
                ids[path] = {el.get("id"): el for el in root.iter() if el.get("id")}
            element = ids[path].get(frag) if frag else None
            if frag and element is None:
                fails.append(f"G5 {href} does not resolve (no id {frag})")
                continue
            if element is not None and element.tag in _HEADING_TAGS and _similar("".join(element.itertext()), title):
                hits += 1
        share = hits / len(entries)
        if share < TOC_HEADING_SHARE_MIN:
            fails.append(f"G5 {hits} of {len(entries)} entries land on a matching heading ({share:.0%})")
    return fails


# --- G6 words --------------------------------------------------------------
def word_loss(pdf_tokens: Counter, art_tokens: Counter, excluded: Counter) -> tuple[float, Counter]:
    missing = pdf_tokens - art_tokens
    missing.subtract(excluded)
    missing = +missing
    total = sum(pdf_tokens.values())
    return (sum(missing.values()) / total if total else 0.0), missing


# --- G7 package --------------------------------------------------------------
def check_package(epub_path: str) -> list[str]:
    """Structural checks an EPUB reader would refuse the file over."""
    problems: list[str] = []
    with zipfile.ZipFile(epub_path) as zf:
        names = zf.namelist()
        if not names or names[0] != "mimetype":
            problems.append("G7 mimetype is not the first entry")
        if "mimetype" in names:
            if zf.getinfo("mimetype").compress_type != zipfile.ZIP_STORED:
                problems.append("G7 mimetype is compressed")
            if zf.read("mimetype") != b"application/epub+zip":
                problems.append("G7 mimetype has the wrong content")
        for name in ("META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml"):
            if name not in names:
                problems.append(f"G7 {name} is missing")
        for name in names:
            if name.endswith((".xhtml", ".opf", ".ncx", ".xml")):
                try:
                    ElementTree.fromstring(zf.read(name))
                except ElementTree.ParseError as err:
                    problems.append(f"G7 {name} does not parse: {err}")
        if "OEBPS/content.opf" in names and "META-INF/container.xml" in names:
            try:
                _, items = _manifest(zf)
                for path, _, _ in items.values():
                    if path not in names:
                        problems.append(f"G7 manifest href {path} is not in the zip")
            except ElementTree.ParseError:
                pass
    return problems
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `$PY -m pytest sidecar/tests/test_reflow_gate.py -v`
Expected: 15 passed.

- [ ] **Step 6: Commit**

```bash
git add sidecar/reflow/gate.py sidecar/reflow/outline.py sidecar/tests/test_reflow_gate.py
git commit -m "feat(sidecar): the reflow gate — golden passages, segment trigrams, rotated text, figure files, TOC, word loss

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Prove the gate fails slice 1

**Files:**
- Create: `scripts/reflow-golden.json`
- Modify: `scripts/pdf-reflow-probe.py` (add `--gate-only DIR`, `gate_book`, `print_gate`; normal mode untouched until Task 8)
- Modify: `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` (append Annex C.7, first run)

**Interfaces:**
- Consumes: `reflow.gate.*`, `reflow.chars.page_chars`, `reflow.outline.outline_entries` (Task 2).
- Produces: in the probe, `gate_book(pdf_path, epub_path, *, passages, pages, expected_figures, expected_plates=..., exclusions=None, skip_pages=frozenset(), excluded_words=None) -> dict[str, list[str]]` and `print_gate(records) -> int` (the number of books that failed). `GOLDEN` and `EXPECT_FALLBACK` module constants.

- [ ] **Step 1: Preserve the slice-1 artifacts**

They are the gate's negative control and the next run overwrites `dist/reflow-spike/`.

```bash
cp -R dist/reflow-spike dist/reflow-spike-slice1
ls dist/reflow-spike-slice1
```

Expected: five `.epub` files and `report.json`.

- [ ] **Step 2: Write the golden passages**

Each was read off the rendered page by a person on 2026-10-08 (`/tmp/golden/*.png`), then checked word by word against the page's text layer. *Modernist Cuisine*'s are as printed: its text layer there is a scanner's OCR, which is the point of Annex C.5 item 3a. Create `scripts/reflow-golden.json`:

```json
{
  "Universe: Solar Systems, Stars, and Galaxies": [
    "Soon Hveen was an international center of astronomical study. Tycho Brahe's Legacy Tycho made no direct contribution to astronomical theory",
    "Kepler was born in 1571 to a poor family in a region that is now part of southwest Germany",
    "His father was unreliable and shiftless, principally employed as a mercenary soldier fighting for whoever paid enough"
  ],
  "Attention is All You Need": [
    "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder",
    "1 Introduction Recurrent neural networks, long short-term memory [13] and gated recurrent [7] neural networks in particular",
    "have been firmly established as state of the art approaches in sequence modeling and transduction problems such as language modeling and machine translation"
  ],
  "Sequence to Sequence Learning with Neural Networks": [
    "Graves [10] introduced a novel differentiable attention mechanism that allows neural networks to focus on different parts of their input",
    "monotonic alignment between the inputs and the outputs [11]. Figure 1: Our model reads an input sentence",
    "The simple trick of reversing the words in the source sentence is one of the key technical contributions of this work"
  ],
  "Politics, Philosophy, Culture": [
    "I have written a book about the history of psychiatry from the 17th century to the very beginning of the 19th",
    "At first I refused to go there since I am not a psychiatrist, even if I have some experience, a very short experience as I told you earlier",
    "Many people look at you as someone who is able to tell them the deep truth about the world and about themselves"
  ],
  "Modernist Cuisine: Volume 1: History & Fundamentals": [
    "What Einstein Told His Cook: Kitchen Science Explained (2002) by Robert L. Wolke (who also contributed to this book",
    "In March 1988, he and Nicholas Kurti together decided they would launch a new scientific discipline and an international conference",
    "examined digital scans of original documents available on the website of Harold McGee"
  ]
}
```

What each passage tests: Universe #2 crosses from the foot of column 1 to the head of column 2; Attention #1 is where slice 1 spliced in the arXiv stamp, and #3 must not have the page-1 footnotes between its halves (it crosses to page 2); Seq2Seq #2 needs the figure's axis labels (`W X Y Z <EOS>`) out of the flow; Modernist #2 and #3 sit in the dark sidebar, #3 crossing its two columns.

- [ ] **Step 3: Add the gate to the probe**

In `scripts/pdf-reflow-probe.py`, add to the imports (after the existing `from reflow import …` line):

```python
from reflow import gate  # noqa: E402
from reflow.chars import page_chars  # noqa: E402
from reflow.outline import outline_entries  # noqa: E402
```

Below `CORPUS`, add:

```python
GOLDEN = Path(__file__).with_name("reflow-golden.json")

# The corpus book whose correct outcome is *no artifact* (D6).
EXPECT_FALLBACK = {"The Complete Guide to Asterix"}
CHECKS = ("G1", "G2", "G3", "G4", "G5", "G6", "G7")


def load_golden() -> dict[str, list[str]]:
    with open(GOLDEN) as fh:
        return json.load(fh)


def gate_book(
    pdf_path: str,
    epub_path: str,
    *,
    passages: list[str],
    pages: int,
    expected_figures: Optional[int],
    expected_plates: Optional[int] = None,
    exclusions: Optional[dict[int, list]] = None,
    skip_pages: frozenset = frozenset(),
    excluded_words: Optional[Counter] = None,
) -> dict[str, list[str]]:
    """Run G1–G7 (spec Annex C.4) on one artifact against its source PDF.

    `expected_plates=None` means "derive it from the PDF"; the other pipeline
    inputs default to *nothing excluded*, which is how the slice-1 artifacts
    are judged — they recorded no figure boxes and read no page from Vision.
    """
    import pypdfium2 as pdfium

    results: dict[str, list[str]] = {g: [] for g in CHECKS}
    results["G7"] = gate.check_package(epub_path)
    spine = gate.spine_text(epub_path)
    spine_tokens = gate.tokens(spine)
    results["G1"] = gate.check_golden(spine, passages)

    segments: list[list[str]] = []
    rotated: list[str] = []
    upright: list[str] = []
    pdf_counter: Counter = Counter()
    plates = 0
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        for i in range(pages):
            page = pdf[i]
            box = page.get_bbox()
            ev = gate.page_evidence(page, page_chars(page.get_textpage()), (exclusions or {}).get(i, []), box)
            plates += ev.plate_expected
            rotated.extend(ev.rotated)
            upright.extend(ev.upright)
            if i not in skip_pages:
                segments.extend(ev.segments)
                pdf_counter.update(ev.upright)
    finally:
        pdf.close()

    recall, trigrams = gate.trigram_recall(segments, spine_tokens)
    if recall < gate.TRIGRAM_RECALL_MIN:
        results["G2"].append(f"G2 segment trigram recall {recall:.1%} of {trigrams} (needs {gate.TRIGRAM_RECALL_MIN:.0%})")
    results["G3"] = gate.check_rotated(spine_tokens, gate.rotated_only(rotated, upright))
    results["G4"] = gate.check_figures(
        epub_path, expected_figures=expected_figures, expected_plates=plates if expected_plates is None else expected_plates
    )
    outline = outline_entries(pdf_path, pages=pages)
    results["G5"] = gate.check_toc(epub_path, [(e.title, e.depth) for e in outline] if len(outline) >= 2 else None)
    loss, missing = gate.word_loss(pdf_counter, Counter(spine_tokens), excluded_words or Counter())
    if loss > gate.WORD_LOSS_MAX:
        results["G6"].append(f"G6 {loss:.1%} of words lost (top: {missing.most_common(6)})")
    return results


def print_gate(records: list[dict]) -> int:
    """One line per check per book; returns how many books failed."""
    failed = 0
    for r in records:
        title = r["title"]
        if title in EXPECT_FALLBACK:
            ok = r.get("artifact") is None and bool(r.get("reason"))
            print(f"{'PASS' if ok else 'FAIL'}  {title} — G8 fallback ({r.get('reason') or 'an artifact was written'})")
            failed += not ok
            continue
        results = r.get("gate")
        if results is None:
            print(f"FAIL  {title} — no artifact ({r.get('reason', '')})")
            failed += 1
            continue
        bad = [g for g in CHECKS if results.get(g)]
        print(f"{'PASS' if not bad else 'FAIL'}  {title}")
        for g in bad:
            lines = results[g]
            for line in lines[:3]:
                print(f"        {line}")
            if len(lines) > 3:
                print(f"        … and {len(lines) - 3} more {g} failures")
        failed += bool(bad)
    print(f"gate: {len(records) - failed}/{len(records)} books pass")
    return failed


def gate_only(directory: str, root: str, only: Optional[str]) -> int:
    """Judge existing artifacts — the slice-1 negative control — without re-running the pipeline."""
    golden = load_golden()
    with open(os.path.join(directory, "report.json")) as fh:
        previous = {b["title"]: b for b in json.load(fh)["books"]}
    records = []
    for title, _ in CORPUS:
        if only and only.lower() not in title.lower():
            continue
        matched, rel, _ = book(title)
        path = pdf_in(os.path.join(root, rel))
        before = previous.get(matched, {})
        slug = re.sub(r"[^a-zA-Z0-9]+", "-", matched).strip("-")[:60]
        epub_path = os.path.join(directory, f"{slug}.epub")
        rec = {"title": matched, "reason": before.get("reason", ""), "artifact": None}
        if os.path.exists(epub_path) and path:
            print(f"… gating {matched}", file=sys.stderr, flush=True)
            import pypdfium2 as pdfium

            pages = len(pdfium.PdfDocument(path))
            rec["artifact"] = os.path.basename(epub_path)
            rec["gate"] = gate_book(
                path, epub_path, passages=golden.get(matched, []), pages=pages, expected_figures=before.get("figures")
            )
        records.append(rec)
    return 1 if print_gate(records) else 0
```

In `main`, add the option to the argument loop:

```python
        elif arg == "--gate-only":
            i += 1
            gate_dir = argv[i]
```

initialise `gate_dir: Optional[str] = None` beside `compare = False`, and right after `root = library_root()` add:

```python
    if gate_dir:
        return gate_only(os.path.abspath(gate_dir), root, only)
```

Add `--gate-only DIR` to the module docstring's usage block:

```
    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --gate-only dist/reflow-spike-slice1
```

- [ ] **Step 4: Run the gate on slice 1 — it must fail**

Run: `$PY scripts/pdf-reflow-probe.py --gate-only dist/reflow-spike-slice1 | tee /tmp/gate-slice1.txt`
Expected: exit code 1; `gate: 1/6 books pass` (only Asterix's fallback). For each of the five text books, at least: **G1** (passages not contiguous), **G4** (bytes jpeg, extension png; slivers), **G5** (nav has fewer entries than the outline, or heading share below 90%). If any text book **passes**, the gate is not valid — stop and hand back with the output.

- [ ] **Step 5: Record the run in the spec**

Append to `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md`, after C.6:

```markdown
### C.7 The gate's runs

**Run 1 — the slice-1 artifacts, kept at `dist/reflow-spike-slice1/` (YYYY-MM-DD).** `scripts/pdf-reflow-probe.py --gate-only dist/reflow-spike-slice1`. The gate is valid only if this fails, and it did:

| Book | G1 | G2 | G3 | G4 | G5 | G6 | G7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| … one row per book, each cell `pass` or the first failure, from `/tmp/gate-slice1.txt` … |
```

Fill in the date and every row from `/tmp/gate-slice1.txt`, one cell per check: `pass`, or the first failure line shortened to its numbers (for example `2 of 3 passages`, `81% recall`, `106 of 159 mislabelled`). Asterix gets one row reading `G8 pass — no artifact`.

- [ ] **Step 6: Commit**

```bash
git add scripts/reflow-golden.json scripts/pdf-reflow-probe.py docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md
git commit -m "feat(scripts): the probe gates existing artifacts; the slice-1 artifacts fail it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Figures that survive — the crop, the plates, the file types

**Files:**
- Create: `sidecar/reflow/model.py`
- Modify: `sidecar/reflow/layout.py` (data classes move out; `_figure_regions`, `_crop`, `extract_page`, `analyse`; new `Crop`, `render_plate`, `_has_ink`)
- Modify: `sidecar/reflow/epub.py` (image names and media types follow the encoding)
- Modify: `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` (Annex C.5 item 6, one sentence)
- Test: `sidecar/tests/test_reflow_figures.py`

**Interfaces:**
- Consumes: `reflow.gate.check_figures`, `check_package` (Task 2); `tests.reflow_pdfs` (Task 1).
- Produces:
  - `reflow.model`: `Box`, `MIN_PAGE_CHARS = 50`, `UNMAPPED_HYPHEN`, `clean_text(text) -> str`, `Block`, `PageResult`, `Document` (fields below — later tasks rely on every one of them).
  - `reflow.layout`: `Crop(data: bytes, width: int, height: int, image_type: str)`; `_figure_regions(page, text_boxes, page_rect) -> tuple[list[Box], list[Box]]` (figures, table-like); `_crop(page, box, page_rect) -> Optional[Crop]`; `render_plate(page) -> Optional[Crop]`.
  - `layout.py` keeps re-exporting `Block`, `Document`, `PageResult`, `clean_text`, so `epub.py`, `outline.py` and the probe keep importing them from `.layout` until Task 5 moves their imports.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_reflow_figures.py`:

```python
import io

import pypdfium2 as pdfium
from PIL import Image

from reflow import gate, layout
from reflow.epub import write_epub
from reflow.layout import _crop, _figure_regions, extract_page, render_plate
from reflow.model import Block, Document, PageResult
from tests.reflow_pdfs import Page, Rect, Text, write_pdf

BODY = [Text(72, 720 - 14 * i, f"Body line {i} carries enough characters to make this a text page.") for i in range(4)]


def _page(tmp_path, page, name="f.pdf"):
    pdf = pdfium.PdfDocument(write_pdf(tmp_path / name, [page]))
    return pdf, pdf[0]


def _dark_share(data):
    hist = Image.open(io.BytesIO(data)).convert("L").histogram()
    return sum(hist[:128]) / sum(hist)


def test_crop_renders_the_box_it_is_given(tmp_path):
    pdf, page = _page(tmp_path, Page(rects=[Rect(300, 300, 120, 90)]))
    crop = _crop(page, (300, 300, 420, 390), page.get_bbox())
    assert crop is not None and crop.image_type == "png"
    assert abs(crop.width - 240) <= 12 and abs(crop.height - 180) <= 12
    assert _dark_share(crop.data) > 0.8


def test_crop_honours_a_crop_box_origin(tmp_path):
    pdf, page = _page(tmp_path, Page(rects=[Rect(300, 300, 120, 90)], crop=(33, 33, 581, 759)))
    crop = _crop(page, (300, 300, 420, 390), page.get_bbox())
    assert crop is not None and _dark_share(crop.data) > 0.8


def test_crop_off_the_page_is_none_not_an_exception(tmp_path):
    pdf, page = _page(tmp_path, Page())
    assert _crop(page, (700, 700, 800, 800), page.get_bbox()) is None


def test_a_large_crop_is_jpeg(tmp_path):
    pdf, page = _page(tmp_path, Page(rects=[Rect(50, 50, 500, 600, 0.5)]))
    crop = _crop(page, (50, 50, 550, 650), page.get_bbox())
    assert crop.image_type == "jpeg" and crop.data.startswith(b"\xff\xd8")


def test_text_mask_respects_the_page_origin(tmp_path):
    # A block of text on a page whose crop box starts at x=80. With the
    # origin ignored, the mask lands 80pt left of the text and the text's
    # own ink becomes a "table-like" region.
    texts = [Text(100, 700 - 12 * i, "Masked text that must never become a figure region") for i in range(10)]
    pdf, page = _page(tmp_path, Page(texts=texts, rects=[Rect(300, 200, 120, 90)], crop=(80, 80, 600, 780)))
    figures, table_like = _figure_regions(page, [(98, 588, 400, 712)], page.get_bbox())
    assert table_like == []
    assert len(figures) == 1
    left, bottom, right, top = figures[0]
    assert left <= 300 and right >= 420 and bottom <= 200 and top >= 290


def test_a_full_page_photo_with_little_text_is_a_figure(tmp_path):
    pdf, page = _page(tmp_path, Page(texts=BODY[:1], rects=[Rect(0, 0, 612, 700, 0.3)]))  # 88% of the page
    figures, _ = _figure_regions(page, [(72, 715, 500, 730)], page.get_bbox())
    assert len(figures) == 1


def test_plate_renders_a_textless_page(tmp_path):
    pdf, page = _page(tmp_path, Page(rects=[Rect(0, 0, 612, 792, 0.3)]))
    plate = render_plate(page)
    assert plate is not None and plate.image_type == "jpeg"
    assert max(plate.width, plate.height) <= 1400


def test_a_blank_page_has_no_plate(tmp_path):
    pdf, page = _page(tmp_path, Page())
    assert render_plate(page) is None


def test_a_failed_crop_keeps_the_figures_labels(tmp_path, monkeypatch):
    texts = BODY + [Text(320, 340, "Label inside the figure")]
    pdf, page = _page(tmp_path, Page(texts=texts, rects=[Rect(300, 300, 200, 90, 0.8)]))
    monkeypatch.setattr(layout, "_crop", lambda *a, **k: None)
    result = extract_page(page, 0)
    assert "Label inside the figure" in " ".join(b.text for b in result.blocks)
    assert result.crop_failures and not any(b.kind == "figure" for b in result.blocks)


def test_a_written_crop_swallows_its_labels(tmp_path):
    texts = BODY + [Text(320, 340, "Label inside the figure")]
    pdf, page = _page(tmp_path, Page(texts=texts, rects=[Rect(300, 300, 200, 90, 0.8)]))
    result = extract_page(page, 0)
    assert "Label inside the figure" not in " ".join(b.text for b in result.blocks)
    assert [b.image_type for b in result.blocks if b.kind == "figure"] == ["png"]


def test_a_textless_page_becomes_a_plate(tmp_path):
    pdf, page = _page(tmp_path, Page(rects=[Rect(0, 0, 612, 792, 0.3)]))
    result = extract_page(page, 0)
    assert [b.plate for b in result.blocks] == [True]


def _image(kind, w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "gray").save(buf, "PNG" if kind == "png" else "JPEG")
    return buf.getvalue()


def test_epub_names_and_types_images_by_their_encoding(tmp_path):
    doc = Document(source=str(tmp_path / "missing.pdf"))
    doc.pages = [
        PageResult(index=0, chars=500, blocks=[
            Block("para", text="Some text.", page=0),
            Block("figure", page=0, image=_image("png", 80, 60), image_width=80, image_height=60, image_type="png"),
            Block("figure", page=0, image=_image("jpeg", 300, 200), image_width=300, image_height=200, image_type="jpeg"),
        ]),
        PageResult(index=1, chars=0, blocks=[
            Block("figure", page=1, image=_image("jpeg", 600, 800), image_width=600, image_height=800, image_type="jpeg", plate=True),
        ]),
    ]
    out = tmp_path / "out.epub"
    write_epub(doc, str(out), "T")
    assert gate.check_package(str(out)) == []
    assert gate.check_figures(str(out), expected_figures=2, expected_plates=1) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$PY -m pytest sidecar/tests/test_reflow_figures.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'reflow.model'`.

- [ ] **Step 3: Create `model.py`**

Create `sidecar/reflow/model.py`. The `_ILLEGAL_XML` comment and `clean_text` move here verbatim from `layout.py` (lines 96–113 before this task); the rest is new:

```python
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
    # Slice-1 bookkeeping for the band pass; deleted with it in Task 8.
    lines: int = 0
    cross_band: int = 0
    figures_swallowed: int = 0
    labels_swallowed: int = 0
    bands: int = 1
    seconds: float = 0.0


@dataclass
class Document:
    source: str
    pages: list[PageResult] = field(default_factory=list)
    sections: list[tuple[str, int]] = field(default_factory=list)  # slice 1; Task 5 replaces it with `entries`
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
```

- [ ] **Step 4: Point `layout.py` at the model**

In `sidecar/reflow/layout.py`:

1. Delete `MIN_PAGE_CHARS = 50` from the tunables block, the `_ILLEGAL_XML` comment and regex, `_UNMAPPED_HYPHEN`, `clean_text`, and the `Block`, `PageResult` and `Document` dataclasses (they now live in `model.py`).
2. After `import pypdfium2 as pdfium`, add:

```python
from .model import MIN_PAGE_CHARS, Block, Box, Document, PageResult, clean_text
from .model import UNMAPPED_HYPHEN as _UNMAPPED_HYPHEN
```

3. Add `image_type: str = ""` to `Element` after `image_height`, and in `build_blocks`'s figure branch pass `image_type=el.image_type` to `Block(...)`.
4. Add to the tunables block:

```python
FIGURE_BACKGROUND_TEXT_SHARE = 0.10  # a page-sized region is a photo only if this little of it is text
PLATE_MAX_PIXELS = 1400  # a plate's long side
```

- [ ] **Step 5: Fix the text mask and the background rule in `_figure_regions`**

Two changes inside `_figure_regions`. The column of a text box's cell must be measured from the page's left edge, as its row already is from the top:

```python
    for left, bottom, right, top in text_boxes:
        c0 = max(int((left - page_rect[0]) * FIGURE_SCALE) // cell, 0)
        c1 = min(int((right - page_rect[0]) * FIGURE_SCALE) // cell, cols - 1)
        r0 = max(int((page_rect[3] - top) * FIGURE_SCALE) // cell, 0)
        r1 = min(int((page_rect[3] - bottom) * FIGURE_SCALE) // cell, rows - 1)
```

And a page-sized region is no longer discarded outright: it is a photo when it carries almost no text, and a tinted background otherwise. Replace everything in the region loop from `if w * h > FIGURE_MAX_PAGE * page_w * page_h:` to the end of the loop body with:

```python
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
```

Update the `FIGURE_MAX_PAGE` comment to `# a region this much of the page is a background, unless it is nearly textless`.

- [ ] **Step 6: Replace `_crop`, add `Crop`, `render_plate` and `_has_ink`**

Replace the whole `_crop` function with:

```python
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
```

- [ ] **Step 7: Use them in `extract_page` and `analyse`**

In `extract_page`, replace the no-text early return:

```python
    if result.chars < MIN_PAGE_CHARS:
        result.flags.append("no_text")
        plate = render_plate(page)
        if plate is not None:
            result.plate = True
            result.blocks = [
                Block(
                    "figure", page=index, top=page_rect[3], bottom=page_rect[1], left=page_rect[0], right=page_rect[2],
                    image=plate.data, image_width=plate.width, image_height=plate.height,
                    image_type=plate.image_type, plate=True,
                )
            ]
        result.seconds = time.perf_counter() - started
        return result
```

Replace the figure loop and the swallow block (from `boxes = [...]` to the end of `if regions or table_like:`) with:

```python
    boxes = [(e.left, e.bottom, e.right, e.top) for e in elements]
    regions, table_like = _figure_regions(page, boxes, page_rect)
    result.figures_detected = len(regions)
    written: list[Box] = []
    for box in regions:
        crop = _crop(page, box, page_rect)
        if crop is None:
            result.crop_failures.append(f"page {index + 1} box {tuple(round(v, 1) for v in box)}")
            continue
        written.append(box)
        elements.append(
            Element(
                "figure", box[0], box[1], box[2], box[3],
                image=crop.data, image_width=crop.width, image_height=crop.height, image_type=crop.image_type,
            )
        )
    result.figure_boxes = written

    # Text inside a *written* figure is part of the figure — it is already in
    # the crop. Inside a figure whose crop failed it is the only copy left, so
    # it stays (slice 1 dropped it either way).
    if written or table_like:
        kept: list[Element] = []
        for el in elements:
            if el.kind == "line" and _inside(el, written):
                result.figures_swallowed += 1
                continue
            if el.kind == "line" and _label_inside(el, table_like):
                result.labels_swallowed += 1
                continue
            kept.append(el)
        elements = kept
```

In `analyse`, after the page loop and before `mark_running_heads(doc)`, aggregate:

```python
    doc.figures_detected = sum(p.figures_detected for p in doc.pages)
    doc.plates = sum(1 for p in doc.pages if p.plate)
    doc.crop_failures = [f for p in doc.pages for f in p.crop_failures]
```

- [ ] **Step 8: Name images by their encoding in `epub.py`**

In `sidecar/reflow/epub.py`, add below `_EPUB_TYPE`:

```python
_IMAGE_EXT = {"png": "png", "jpeg": "jpg"}
_IMAGE_MEDIA = {"png": "image/png", "jpeg": "image/jpeg"}
```

In `_opf`, change the parameter `images: list[str]` to `images: list[tuple[str, str]]` (name, media type) and its loop to:

```python
    for i, (name, media) in enumerate(images):
        items.append(f'<item id="img{i + 1}" href="images/{name}" media-type="{media}"/>')
```

In `write_epub`, replace the image-collection loop with:

```python
    image_names: dict[int, str] = {}
    images: list[tuple[str, bytes, str]] = []
    for _, _, blocks in sections:
        for block in blocks:
            if block.kind == "figure" and block.image:
                kind = block.image_type or "png"
                stem = "plate" if block.plate else str(len(images))
                name = f"p{block.page + 1:04d}-{stem}.{_IMAGE_EXT[kind]}"
                image_names[id(block)] = name
                images.append((name, block.image, _IMAGE_MEDIA[kind]))
```

and update the two uses: `_opf(..., [(n, m) for n, _, m in images])` and `for name, data, _ in images: zf.writestr(f"OEBPS/images/{name}", data)`.

- [ ] **Step 9: Record the background rule in the spec**

In Annex C.5 item 6 of the spec, after the sentence ending "the page origin applied on both axes.", add: `A region covering more than 80% of the page is kept as a figure only when under 10% of it is text: a full-bleed photo, not a tinted background.`

- [ ] **Step 10: Run the tests to verify they pass**

Run: `$PY -m pytest sidecar/tests/test_reflow_figures.py sidecar/tests/test_reflow_gate.py sidecar/tests/test_reflow_chars.py -v`
Expected: all pass (12 new).

- [ ] **Step 11: Commit**

```bash
git add sidecar/reflow/model.py sidecar/reflow/layout.py sidecar/reflow/epub.py sidecar/tests/test_reflow_figures.py docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md
git commit -m "fix(sidecar): figures survive the reflow — crop by margins, keep labels when a crop fails, plates, file types that match their bytes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The whole outline, nested, landing on its headings

**Files:**
- Modify: `sidecar/reflow/outline.py` (replace the slice-1 section functions with `heading_entries` and `document_entries`)
- Replace: `sidecar/reflow/epub.py` (full file below)
- Modify: `sidecar/reflow/__init__.py`, `scripts/pdf-reflow-probe.py` (`run_one`'s TOC lines)
- Test: `sidecar/tests/test_reflow_toc.py`

**Interfaces:**
- Consumes: `Entry`, `outline_entries`, `normalise_depths`, `clean_label` (Task 2); `model.Block`, `Document`, `PageResult` (Task 4); `gate.check_toc`, `nav_entries`, `check_package` (Task 2).
- Produces:
  - `reflow.outline`: `heading_entries(doc) -> list[Entry]`; `document_entries(path, doc) -> list[Entry]` — sets `doc.outline_entries` and `doc.entries_from_outline`, returns the entries; the caller assigns `doc.entries`.
  - `reflow.epub`: `link_entries(doc) -> list[tuple[Entry, Block]]` (gives each target block an `anchor`, and, for outline entries, `level = min(depth + 1, 3)`); `write_epub(doc, out_path, title) -> dict` with keys `sections`, `toc_entries`, `images`, `words`, `bytes`, `uid`. It renders block kinds `heading`, `para`, `footnote` (`<p class="footnote">`), `figure` and `table` (`<table><tbody><tr><td>`).

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_reflow_toc.py`:

```python
import zipfile

from reflow import gate
from reflow.epub import link_entries, write_epub
from reflow.model import Block, Document, PageResult
from reflow.outline import Entry, document_entries, outline_entries
from tests.reflow_pdfs import OutlineItem, Page, Text, write_pdf


def H(text, level=1, top=700.0):
    return Block("heading", text=text, level=level, top=top)


def P(text, top=600.0):
    return Block("para", text=text, top=top)


def _doc(tmp_path, pages, entries=(), from_outline=True):
    doc = Document(source=str(tmp_path / "missing.pdf"))
    for i, blocks in enumerate(pages):
        for b in blocks:
            b.page = i
        doc.pages.append(PageResult(index=i, blocks=list(blocks), chars=500, top=792, bottom=0))
    doc.entries = list(entries)
    doc.entries_from_outline = from_outline
    return doc


def _write(tmp_path, doc):
    out = tmp_path / "out.epub"
    report = write_epub(doc, str(out), "Title")
    return str(out), report


def test_nav_nests_like_the_outline_and_lands_on_headings(tmp_path):
    doc = _doc(
        tmp_path,
        [[H("1 Introduction"), P("intro"), H("1.1 Scope", 2, 500), P("scope", 400)], [H("2 Method"), P("method")]],
        [Entry("1 Introduction", 0, 0), Entry("1.1 Scope", 1, 0), Entry("2 Method", 0, 1)],
    )
    epub, report = _write(tmp_path, doc)
    assert gate.check_package(epub) == []
    assert gate.check_toc(epub, [("1 Introduction", 0), ("1.1 Scope", 1), ("2 Method", 0)]) == []
    assert report["sections"] == 2 and report["toc_entries"] == 3


def test_two_entries_on_one_page_both_survive(tmp_path):
    doc = _doc(
        tmp_path,
        [[H("2 Background"), P("b"), H("3 Model Architecture", 1, 300), P("m", 200)]],
        [Entry("2 Background", 0, 0), Entry("3 Model Architecture", 0, 0)],
    )
    epub, _ = _write(tmp_path, doc)
    with zipfile.ZipFile(epub) as zf:
        assert [t for t, _, _ in gate.nav_entries(zf)] == ["2 Background", "3 Model Architecture"]
    assert gate.check_toc(epub, [("2 Background", 0), ("3 Model Architecture", 0)]) == []


def test_an_entry_with_no_heading_lands_on_the_block_nearest_its_top(tmp_path):
    a, b = P("a", top=700), P("b", top=400)
    doc = _doc(tmp_path, [[a, b]], [Entry("Section B", 0, 0, top=410.0)])
    assert link_entries(doc) == [(doc.entries[0], b)]
    assert b.anchor


def test_an_entry_on_an_empty_page_lands_on_the_next_page_with_blocks(tmp_path):
    later = P("later")
    doc = _doc(tmp_path, [[P("first")], [], [later]], [Entry("Part Two", 0, 1)])
    assert link_entries(doc)[0][1] is later


def test_duplicate_titles_get_distinct_anchors(tmp_path):
    first, second = H("Foreword"), H("Foreword")
    doc = _doc(tmp_path, [[first, P("x")], [second, P("y")]], [Entry("Foreword", 0, 0), Entry("Foreword", 0, 1)])
    targets = link_entries(doc)
    assert [t[1] for t in targets] == [first, second]
    assert first.anchor != second.anchor


def test_entries_past_the_end_are_skipped(tmp_path):
    doc = _doc(tmp_path, [[H("One"), P("x")]], [Entry("One", 0, 0), Entry("Gone", 0, 9)])
    assert [e.title for e, _ in link_entries(doc)] == ["One"]


def test_outline_depth_sets_the_heading_level(tmp_path):
    h = H("Chapter One", level=3)
    doc = _doc(tmp_path, [[h, P("x")]], [Entry("Chapter One", 0, 0)])
    link_entries(doc)
    assert h.level == 1


def test_headings_stand_in_for_a_missing_outline(tmp_path):
    path = write_pdf(tmp_path / "n.pdf", [Page(texts=[Text(72, 700, "x")])])
    doc = _doc(tmp_path, [[H("Intro", 1), H("Detail", 2, 500), H("Minor", 3, 400), P("p", 300)]])
    entries = document_entries(path, doc)
    assert [(e.title, e.depth) for e in entries] == [("Intro", 0), ("Detail", 1)]
    assert doc.entries_from_outline is False


def test_the_outline_wins_when_it_has_entries(tmp_path):
    path = write_pdf(
        tmp_path / "o.pdf",
        [Page(texts=[Text(72, 700, "x")]), Page(texts=[Text(72, 700, "y")])],
        outline=[OutlineItem("One", 0), OutlineItem("Two", 1)],
    )
    doc = _doc(tmp_path, [[P("x")], [P("y")]])
    assert document_entries(path, doc) == outline_entries(path)
    assert doc.entries_from_outline is True and doc.outline_entries == 2


def test_a_book_with_no_toc_gets_one_entry_per_file(tmp_path):
    doc = _doc(tmp_path, [[P(f"page {i}")] for i in range(45)])
    epub, report = _write(tmp_path, doc)
    with zipfile.ZipFile(epub) as zf:
        entries = gate.nav_entries(zf)
    assert report["sections"] == 3 and len(entries) == 3
    assert not [f for f in gate.check_toc(epub, None) if "resolve" in f]


def test_every_page_has_a_marker_and_tables_and_footnotes_render(tmp_path):
    table = Block("table", rows=[["a", "b"], ["c", "d"]], text="a b c d")
    note = Block("footnote", text="A note.")
    doc = _doc(tmp_path, [[H("One"), table], [P("y"), note]], [Entry("One", 0, 0)])
    epub, _ = _write(tmp_path, doc)
    with zipfile.ZipFile(epub) as zf:
        body = zf.read("OEBPS/text/c001.xhtml").decode()
    assert 'id="pg1"' in body and 'id="pg2"' in body
    assert "<td>a</td><td>b</td>" in body
    assert '<p class="footnote">A note.</p>' in body
    assert gate.check_package(epub) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$PY -m pytest sidecar/tests/test_reflow_toc.py -v`
Expected: FAIL — `ImportError: cannot import name 'link_entries' from 'reflow.epub'`.

- [ ] **Step 3: Replace the section functions in `outline.py`**

In `sidecar/reflow/outline.py`: change `from .layout import Document, clean_text` to `from .model import Document, clean_text`; move the `dataclass` import to the top; delete `MAX_DEPTH`, `MAX_SECTIONS`, `FALLBACK_CHUNK`, `_usable`, `_clean`, `sections_from_outline`, `_dedupe`, `sections_from_headings` and `document_sections`; update the module docstring's last sentence to say the headings stand in "when the outline is missing or holds fewer than two usable entries". Then append:

```python
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
```

- [ ] **Step 4: Replace `epub.py`**

Replace the whole of `sidecar/reflow/epub.py` with:

```python
"""Blocks → a reflowable EPUB 3.

**Why an EPUB.** Because both clients already have an EPUB engine: foliate on
the Mac and Readium's `EPUBNavigatorViewController` on the phone. Shipping a
reflow as an EPUB means the reader's shell, its search, its TOC panel, its
typography and its whole `reading_state` policy apply to a PDF book without one
line of change on either platform — the argument the design is built on.

**What this writer deliberately does not do.** It names no typeface, sets no
colour and does not touch line height, because the reader injects its own
stylesheet and derives the page palette from the app's theme
(`docs/invariants/reader.md`, `src/lib/theme/reader-palette.ts`). A stylesheet
that set a colour here would fight the theme on both clients.

**The TOC is the outline, whole.** Every usable outline entry at every depth is
a nav entry, nested as the outline nests, linking to the *heading* it names.
Slice 1 kept one entry per page, decimated long outlines and linked each entry
to the top of a file, so *Attention is All You Need* lost ten of nineteen
entries and its "3.3" opened on the end of 3.2.2 (spec Annex C.1). Files split
at depth-0 entries; deeper entries are anchors inside them.

**The source-page map lives in the file.** Each page's first block in a file
is preceded by `<span id="pg{n}">`, so a position in the reflow can name the
PDF page it came from (D5).

**Deterministic on purpose.** The identifier and `dcterms:modified` derive from
the source file's size and mtime, not from the clock, so two runs over the same
PDF produce the same document — which is what makes "is this artifact stale?"
a comparable question (D9) and what slice 2's byte-stability gate asks for.
"""

from __future__ import annotations

import difflib
import os
import uuid
import zipfile
from datetime import datetime, timezone
from html import escape

from .model import Block, Document, clean_text
from .outline import Entry

FALLBACK_CHUNK = 20  # pages per file when a book has no TOC at all
TITLE_SIMILARITY = 0.8
GENERATOR = "musaeum pdf reflow (slice 1R; layout helper v1)"
_IMAGE_EXT = {"png": "png", "jpeg": "jpg"}
_IMAGE_MEDIA = {"png": "image/png", "jpeg": "image/jpeg"}

# The reader owns typography; this is only what an EPUB needs to not look broken
# when nothing else is loaded (a fallback reader, a conversion tool).
STYLESHEET = """body { margin: 0; padding: 0; }
h1, h2, h3 { line-height: 1.25; margin: 1.2em 0 0.6em; }
p { margin: 0 0 0.9em; text-indent: 0; }
p.footnote { font-size: 0.85em; }
figure { margin: 1em 0; text-align: center; }
figure img { max-width: 100%; height: auto; }
table { border-collapse: collapse; margin: 1em 0; }
td { padding: 0.2em 0.5em; vertical-align: top; }
"""


def _escape(text: str) -> str:
    return escape(clean_text(text), quote=False)


def _norm(text: str) -> str:
    return " ".join(clean_text(text).lower().split())


def _similar(a: str, b: str) -> bool:
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return False
    if a == b:
        return True
    if min(len(a), len(b)) >= 4 and (a.startswith(b) or b.startswith(a) or a.endswith(b) or b.endswith(a)):
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= TITLE_SIMILARITY


def link_entries(doc: Document) -> list[tuple[Entry, Block]]:
    """Give every TOC entry a block to land on, and that block an id.

    In order of preference: an unclaimed heading on the entry's page or the
    next whose text matches the title; the block nearest the destination's y;
    the first block of the entry's page, or of the next page that has one. An
    entry past the last page with blocks is dropped. A heading an *outline*
    entry claims takes its level from the outline's depth.
    """
    by_page = {page.index: page.blocks for page in doc.pages if page.blocks}
    pages = sorted(by_page)
    claimed: set[int] = set()
    targets: list[tuple[Entry, Block]] = []
    counter = 0
    for entry in doc.entries:
        target = None
        for p in (entry.page, entry.page + 1):
            target = next(
                (b for b in by_page.get(p, []) if b.kind == "heading" and id(b) not in claimed and _similar(b.text, entry.title)),
                None,
            )
            if target is not None:
                break
        if target is not None:
            claimed.add(id(target))
            if doc.entries_from_outline:
                target.level = min(entry.depth + 1, 3)
        elif entry.top is not None and entry.page in by_page:
            target = min(by_page[entry.page], key=lambda b: abs(b.top - entry.top))
        else:
            page = next((p for p in pages if p >= entry.page), None)
            if page is None:
                continue
            target = by_page[page][0]
        if not target.anchor:
            counter += 1
            target.anchor = f"t{counter}"
        targets.append((entry, target))
    return targets


def _partition(doc: Document, targets: list[tuple[Entry, Block]]) -> list[tuple[str, list[Block]]]:
    """Split the block stream into files at depth-0 entries (or every 20 pages)."""
    flat = [b for page in doc.pages for b in page.blocks]
    if not flat:
        return []
    index = {id(b): i for i, b in enumerate(flat)}
    starts: dict[int, str] = {}
    for entry, block in targets:
        if entry.depth == 0:
            starts.setdefault(index[id(block)], entry.title)
    if not starts:
        chunk = None
        for i, b in enumerate(flat):
            if b.page // FALLBACK_CHUNK != chunk:
                chunk = b.page // FALLBACK_CHUNK
                starts[i] = f"Page {b.page + 1}"
    starts.setdefault(0, "Front matter")
    order = sorted(starts)
    return [(starts[s], flat[s : order[k + 1] if k + 1 < len(order) else len(flat)]) for k, s in enumerate(order)]


def _xhtml(title: str, blocks: list[Block], image_names: dict[int, str]) -> str:
    parts: list[str] = []
    marked: set[int] = set()
    for b in blocks:
        if b.page not in marked:
            marked.add(b.page)
            parts.append(f'<span id="pg{b.page + 1}"></span>')
        ident = f' id="{b.anchor}"' if b.anchor else ""
        if b.kind == "figure" and id(b) in image_names:
            parts.append(
                f'<figure{ident}><img src="../images/{image_names[id(b)]}" alt="" '
                f'width="{b.image_width}" height="{b.image_height}"/></figure>'
            )
        elif b.kind == "heading" and b.text:
            level = min(max(b.level or 1, 1), 3)
            parts.append(f"<h{level}{ident}>{_escape(b.text)}</h{level}>")
        elif b.kind == "table" and b.rows:
            rows = "".join(
                "<tr>" + "".join(f"<td>{_escape(cell)}</td>" for cell in row) + "</tr>" for row in b.rows if any(row)
            )
            parts.append(f"<table{ident}><tbody>{rows}</tbody></table>")
        elif b.kind == "footnote" and b.text:
            parts.append(f'<p class="footnote"{ident}>{_escape(b.text)}</p>')
        elif b.text:
            parts.append(f"<p{ident}>{_escape(b.text)}</p>")
        elif b.anchor:
            parts.append(f"<span{ident}></span>")
    body = "\n".join(parts)
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">\n'
        "<head>\n"
        f"<title>{_escape(title)}</title>\n"
        '<link rel="stylesheet" type="text/css" href="../style.css"/>\n'
        "</head>\n"
        "<body>\n"
        f'<section epub:type="chapter">\n{body}\n</section>\n'
        "</body>\n"
        "</html>\n"
    )


def _nav(items: list[tuple[str, int, str]]) -> str:
    html: list[str] = []
    prev = -1
    for title, depth, href in items:
        if depth > prev:
            html.append("<ol>")
        else:
            html.append("</li>")
            html.extend("</ol></li>" for _ in range(prev - depth))
        html.append(f'<li><a href="{href}">{_escape(title)}</a>')
        prev = depth
    if prev >= 0:
        html.append("</li>")
        html.extend("</ol></li>" for _ in range(prev))
        html.append("</ol>")
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">\n'
        "<head><title>Contents</title></head>\n"
        "<body>\n"
        '<nav epub:type="toc" id="toc">\n<h1>Contents</h1>\n'
        + "\n".join(html)
        + "\n</nav>\n</body>\n</html>\n"
    )


def _ncx(items: list[tuple[str, int, str]], uid: str, title: str) -> str:
    points: list[str] = []
    prev = -1
    for i, (name, depth, href) in enumerate(items):
        if depth <= prev:
            points.append("</navPoint>" * (prev - depth + 1))
        points.append(
            f'<navPoint id="nav{i + 1}" playOrder="{i + 1}">'
            f"<navLabel><text>{_escape(name)}</text></navLabel>"
            f'<content src="{href}"/>'
        )
        prev = depth
    points.append("</navPoint>" * (prev + 1))
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
        f'<head><meta name="dtb:uid" content="{uid}"/></head>\n'
        f"<docTitle><text>{_escape(title)}</text></docTitle>\n"
        f"<navMap>\n{''.join(points)}\n</navMap>\n"
        "</ncx>\n"
    )


def _opf(uid: str, title: str, source_name: str, modified: str, files: int, images: list[tuple[str, str]]) -> str:
    items = [
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
        '<item id="css" href="style.css" media-type="text/css"/>',
    ]
    for i in range(files):
        items.append(f'<item id="c{i + 1:03d}" href="text/c{i + 1:03d}.xhtml" media-type="application/xhtml+xml"/>')
    for i, (name, media) in enumerate(images):
        items.append(f'<item id="img{i + 1}" href="images/{name}" media-type="{media}"/>')
    spine = "\n".join(f'<itemref idref="c{i + 1:03d}"/>' for i in range(files))
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        f'<dc:identifier id="bookid">{uid}</dc:identifier>\n'
        f"<dc:title>{_escape(title)}</dc:title>\n"
        "<dc:language>en</dc:language>\n"
        f"<dc:source>{_escape(source_name)}</dc:source>\n"
        f'<meta property="dcterms:modified">{modified}</meta>\n'
        f'<meta name="generator" content="{GENERATOR}"/>\n'
        "</metadata>\n"
        "<manifest>\n" + "\n".join(items) + "\n</manifest>\n"
        f'<spine toc="ncx">\n{spine}\n</spine>\n'
        "</package>\n"
    )


def _container() -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        "<rootfiles>\n"
        '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
        "</rootfiles>\n"
        "</container>\n"
    )


def write_epub(doc: Document, out_path: str, title: str) -> dict:
    """Write `doc` as an EPUB 3 at `out_path`. Returns a small report."""
    targets = link_entries(doc)
    files = _partition(doc, targets)
    file_of = {id(b): i for i, (_, blocks) in enumerate(files) for b in blocks}
    if targets:
        items = [(e.title, e.depth, f"text/c{file_of[id(b)] + 1:03d}.xhtml#{b.anchor}") for e, b in targets]
    else:
        items = []
        for i, (name, blocks) in enumerate(files):
            if not blocks[0].anchor:
                blocks[0].anchor = f"f{i + 1}"
            items.append((name, 0, f"text/c{i + 1:03d}.xhtml#{blocks[0].anchor}"))

    try:
        stat = os.stat(doc.source)
        stamp = f"{stat.st_size}:{int(stat.st_mtime)}"
        modified = datetime.fromtimestamp(stat.st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except OSError:
        stamp, modified = doc.source, "1970-01-01T00:00:00Z"
    uid = f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, 'musaeum-reflow:' + stamp)}"

    # One file per figure, named for its page so a crop can always be traced
    # back to the page it came from, and for its encoding so the name, the
    # manifest and the bytes agree (slice 1 called every JPEG a PNG).
    image_names: dict[int, str] = {}
    images: list[tuple[str, bytes, str]] = []
    for _, blocks in files:
        for b in blocks:
            if b.kind == "figure" and b.image:
                kind = b.image_type or "png"
                stem = "plate" if b.plate else str(len(images))
                name = f"p{b.page + 1:04d}-{stem}.{_IMAGE_EXT[kind]}"
                image_names[id(b)] = name
                images.append((name, b.image, _IMAGE_MEDIA[kind]))

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        zf.writestr(info, "application/epub+zip")
        zf.writestr("META-INF/container.xml", _container())
        zf.writestr(
            "OEBPS/content.opf",
            _opf(uid, title, os.path.basename(doc.source), modified, len(files), [(n, m) for n, _, m in images]),
        )
        zf.writestr("OEBPS/nav.xhtml", _nav(items))
        zf.writestr("OEBPS/toc.ncx", _ncx(items, uid, title))
        zf.writestr("OEBPS/style.css", STYLESHEET)
        for i, (name, blocks) in enumerate(files):
            zf.writestr(f"OEBPS/text/c{i + 1:03d}.xhtml", _xhtml(name, blocks, image_names))
        for name, data, _ in images:
            zf.writestr(f"OEBPS/images/{name}", data)

    words = sum(
        len(b.text.split()) for _, blocks in files for b in blocks if b.kind in ("para", "heading", "footnote", "table")
    )
    return {
        "sections": len(files),
        "toc_entries": len(items),
        "images": len(images),
        "words": words,
        "bytes": os.path.getsize(out_path),
        "uid": uid,
    }
```

- [ ] **Step 5: Update the exports and the probe**

`sidecar/reflow/__init__.py` — replace the import and `__all__` with:

```python
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
```

In `scripts/pdf-reflow-probe.py`: change `from reflow import analyse, document_sections, write_epub` to `from reflow import analyse, document_entries, write_epub`. In `run_one`, replace the three lines from `doc = analyse(path, limit=limit)` through `doc.sections = sections` with:

```python
    doc = analyse(path, limit=limit)
    doc.entries = document_entries(path, doc)
```

and the three TOC fields with:

```python
    rec["outline_entries"] = doc.outline_entries
    rec["sections"] = len(doc.entries)
    rec["section_titles"] = [e.title for e in doc.entries[:8]]
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `$PY -m pytest sidecar/tests -k reflow -v`
Expected: all pass (11 new). Also `$PY scripts/pdf-reflow-probe.py --help 2>&1 | head -3` still prints the usage (the module imports).

- [ ] **Step 7: Commit**

```bash
git add sidecar/reflow/outline.py sidecar/reflow/epub.py sidecar/reflow/__init__.py scripts/pdf-reflow-probe.py sidecar/tests/test_reflow_toc.py
git commit -m "fix(sidecar): the reflow TOC is the whole outline, nested, each entry anchored on its heading

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The layout helper

**Files:**
- Create: `helpers/musaeum-layout/main.swift`
- Create: `scripts/build-layout-helper.sh` (executable)
- Modify: `.gitignore` (add `helpers/bin/`)
- Create: `sidecar/reflow/vision.py`
- Test: `sidecar/tests/test_reflow_vision.py`

**Interfaces:**
- Consumes: `model.Box` (Task 4); `reflow.chars.page_chars` and `tests.reflow_pdfs` (Task 1) for the integration tests.
- Produces: `reflow.vision`: `HELPER_VERSION = 1`; `Region(order: int, bbox: Box, text: str)`; `TableCell(row, col, rowspan, colspan, bbox, text)`; `Table(bbox: Box, cells: tuple[TableCell, ...])`; `PageLayout(page: int, box: Box = (0,0,0,0), rotation: int = 0, regions: list[Region] = [], tables: list[Table] = [], ms: int = 0, error: Optional[str] = None)` — `page` is **1-based**, as the helper numbers pages; `LayoutUnavailable(reason)` with `.reason`; `find_helper() -> Optional[str]`; `parse_stream(lines: Iterable[str]) -> dict[int, PageLayout]`; `run_helper(pdf_path, *, first=None, last=None, concurrency=8, scale=1.5, helper=None, timeout=None) -> dict[int, PageLayout]`.

- [ ] **Step 1: Write the helper**

Create `helpers/musaeum-layout/main.swift` — the spike in `/tmp/vision-spike/musaeum-layout.swift`, measured on 2026-10-08 (spec Annex C.3 and C.5 item 1), with the default concurrency at 8:

```swift
// musaeum-layout — a page's reading order from Apple Vision, as JSON lines.
//
// The PDF reflow (docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md,
// D4R and Annex C.5) takes its regions and their order from here and its words
// from the PDF's own text layer, so the OCR transcript this prints is a hint,
// never the book's text. Coordinates are PDF user-space points with a
// bottom-left origin — the space pdfium's character boxes live in — so the
// sidecar can assign characters to regions without knowing how a page was
// rendered. Measured: 5,512 of 5,650 characters on Universe p.78 land inside
// a region; the rest are figure labels.
//
// Usage: musaeum-layout <pdf> [--pages a-b] [--concurrency n] [--scale s]
//
// Builds for macOS 12+ (scripts/build-layout-helper.sh) so it can always say
// why it cannot help: below macOS 26 it prints {"supported": false} and exits 0.
import CoreGraphics
import Foundation
import PDFKit
import Vision

let helperVersion = 1

struct Options {
    var path = ""
    var first = 1
    var last = Int.max
    // 20 Universe pages: 29.0 s at 1, 11.0 s at 4, 8.5 s at 8 (2026-10-08).
    var concurrency = 8
    // Region boundaries at 1.5 match 2.5; time does not change with scale.
    var scale: CGFloat = 1.5
}

func parse(_ args: [String]) -> Options? {
    var o = Options()
    var i = 1
    while i < args.count {
        let a = args[i]
        func next() -> String? { i += 1; return i < args.count ? args[i] : nil }
        switch a {
        case "--pages":
            guard let v = next() else { return nil }
            let parts = v.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 2, parts[0] >= 1, parts[1] >= parts[0] else { return nil }
            o.first = parts[0]; o.last = parts[1]
        case "--concurrency":
            guard let v = next(), let n = Int(v), n >= 1 else { return nil }
            o.concurrency = n
        case "--scale":
            guard let v = next(), let s = Double(v), s > 0 else { return nil }
            o.scale = CGFloat(s)
        default:
            if a.hasPrefix("--") || !o.path.isEmpty { return nil }
            o.path = a
        }
        i += 1
    }
    return o.path.isEmpty ? nil : o
}

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

/// The page as drawn (rotation applied), and the map from that drawing's
/// unscaled space back to PDF user space.
struct Raster {
    let image: CGImage
    let size: CGSize  // drawn size in points
    let toPage: CGAffineTransform
    let box: CGRect  // the crop box, user space
}

func render(_ page: PDFPage, scale: CGFloat) -> Raster? {
    let box = page.bounds(for: .cropBox)
    let toDrawn = page.transform(for: .cropBox)
    let drawn = box.applying(toDrawn)
    let w = Int((drawn.width * scale).rounded()), h = Int((drawn.height * scale).rounded())
    guard w > 0, h > 0, let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { return nil }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .cropBox, to: ctx)
    guard let image = ctx.makeImage() else { return nil }
    let origin = CGAffineTransform(translationX: -drawn.minX, y: -drawn.minY)
    return Raster(
        image: image, size: drawn.size,
        toPage: toDrawn.concatenating(origin).inverted(), box: box)
}

@available(macOS 26.0, *)
func pageRect(_ r: NormalizedRect, _ raster: Raster) -> [Double] {
    let drawn = r.toImageCoordinates(raster.size, origin: .lowerLeft)
    let p = drawn.applying(raster.toPage)
    return [p.minX, p.minY, p.maxX, p.maxY].map { (Double($0) * 100).rounded() / 100 }
}

@available(macOS 26.0, *)
func analyse(_ page: PDFPage, number: Int, scale: CGFloat) async -> [String: Any] {
    let started = Date()
    guard let raster = render(page, scale: scale) else {
        return ["page": number, "error": "render failed"]
    }
    let observations: [DocumentObservation]
    do {
        observations = try await RecognizeDocumentsRequest().perform(on: raster.image)
    } catch {
        return ["page": number, "error": "vision: \(error.localizedDescription)"]
    }
    var regions: [[String: Any]] = []
    var tables: [[String: Any]] = []
    for obs in observations {
        let doc = obs.document
        for p in doc.paragraphs {
            regions.append([
                "kind": "paragraph", "order": regions.count,
                "bbox": pageRect(p.boundingRegion.boundingBox, raster),
                "text": p.transcript,
            ])
        }
        // Vision also reports a table's cells as paragraphs; the sidecar keeps
        // the table and drops the paragraphs inside it.
        for t in doc.tables {
            var cells: [[String: Any]] = []
            for row in t.rows {
                for cell in row {
                    cells.append([
                        "row": cell.rowRange.lowerBound, "col": cell.columnRange.lowerBound,
                        "rowspan": cell.rowRange.count, "colspan": cell.columnRange.count,
                        "bbox": pageRect(cell.content.boundingRegion.boundingBox, raster),
                        "text": cell.content.text.transcript,
                    ])
                }
            }
            tables.append(["bbox": pageRect(t.boundingRegion.boundingBox, raster), "cells": cells])
        }
    }
    let b = raster.box
    return [
        "page": number,
        "box": [b.minX, b.minY, b.maxX, b.maxY],
        "rotation": page.rotation,
        "ms": Int(Date().timeIntervalSince(started) * 1000),
        "regions": regions,
        "tables": tables,
    ]
}

@main
struct Main {
    static func main() async {
        guard let o = parse(CommandLine.arguments) else {
            FileHandle.standardError.write(
                "usage: musaeum-layout <pdf> [--pages a-b] [--concurrency n] [--scale s]\n"
                    .data(using: .utf8)!)
            exit(2)
        }
        guard #available(macOS 26.0, *) else {
            emit(["helper": "musaeum-layout", "version": helperVersion, "supported": false])
            exit(0)
        }
        guard let doc = PDFDocument(url: URL(fileURLWithPath: o.path)) else {
            emit(["helper": "musaeum-layout", "version": helperVersion, "supported": true,
                  "error": "cannot open document"])
            exit(1)
        }
        emit(["helper": "musaeum-layout", "version": helperVersion, "supported": true,
              "pages": doc.pageCount])
        let last = min(o.last, doc.pageCount)
        guard o.first <= last else { exit(0) }
        let numbers = Array(o.first...last)

        // Pages run concurrently and are written strictly in page order, so a
        // reader of the stream can treat line n as page n's whole answer.
        var pending: [Int: [String: Any]] = [:]
        var nextOut = o.first
        await withTaskGroup(of: [String: Any].self) { group in
            var it = numbers.makeIterator()
            func add() {
                guard let n = it.next() else { return }
                // PDFPage is not Sendable; each task opens its own handle on
                // the document so no page object crosses a task boundary.
                let path = o.path, scale = o.scale
                group.addTask {
                    guard let d = PDFDocument(url: URL(fileURLWithPath: path)),
                        let page = d.page(at: n - 1)
                    else { return ["page": n, "error": "cannot open page"] }
                    return await analyse(page, number: n, scale: scale)
                }
            }
            for _ in 0..<o.concurrency { add() }
            for await result in group {
                pending[result["page"] as! Int] = result
                while let ready = pending.removeValue(forKey: nextOut) {
                    emit(ready)
                    nextOut += 1
                }
                add()
            }
        }
    }
}
```

- [ ] **Step 2: Write the build script and ignore its output**

Create `scripts/build-layout-helper.sh`:

```sh
#!/bin/sh
# Build the page-layout helper the PDF reflow calls (spec D4R, Annex C.5).
#
# Needs the Xcode toolchain. The binary runs on macOS 12 and later and reports
# "supported": false below macOS 26, where Vision's document request does not
# exist — so a machine that cannot use it gets a reason, not a crash.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/helpers/bin"
xcrun swiftc -O -parse-as-library -target arm64-apple-macos12.0 \
  -o "$root/helpers/bin/musaeum-layout" "$root/helpers/musaeum-layout/main.swift"
echo "built $root/helpers/bin/musaeum-layout ($(du -h "$root/helpers/bin/musaeum-layout" | cut -f1))"
```

```bash
chmod +x scripts/build-layout-helper.sh
printf '\n# The PDF reflow layout helper, built by scripts/build-layout-helper.sh\nhelpers/bin/\n' >> .gitignore
./scripts/build-layout-helper.sh
helpers/bin/musaeum-layout; echo "exit=$?"
```

Expected: `built …/helpers/bin/musaeum-layout (148K)` — anything up to 1 MB is within AC9; then the usage line and `exit=2`.

- [ ] **Step 3: Write the failing tests**

Create `sidecar/tests/test_reflow_vision.py`:

```python
import json
import platform

import pypdfium2 as pdfium
import pytest

from reflow.chars import page_chars
from reflow.vision import LayoutUnavailable, find_helper, parse_stream, run_helper
from tests.reflow_pdfs import Page, Text, write_pdf

HEADER = json.dumps({"helper": "musaeum-layout", "version": 1, "supported": True, "pages": 2})


def test_an_unsupported_machine_is_a_reason():
    with pytest.raises(LayoutUnavailable) as err:
        parse_stream([json.dumps({"helper": "musaeum-layout", "version": 1, "supported": False})])
    assert "macOS 26" in err.value.reason


def test_a_different_helper_version_is_refused():
    with pytest.raises(LayoutUnavailable) as err:
        parse_stream([json.dumps({"helper": "musaeum-layout", "version": 2, "supported": True})])
    assert "version 2" in err.value.reason


def test_no_output_is_a_reason():
    with pytest.raises(LayoutUnavailable) as err:
        parse_stream([])
    assert "no header" in err.value.reason


def test_a_document_the_helper_cannot_open_is_a_reason():
    line = json.dumps({"helper": "musaeum-layout", "version": 1, "supported": True, "error": "cannot open document"})
    with pytest.raises(LayoutUnavailable) as err:
        parse_stream([line])
    assert "cannot open document" in err.value.reason


def test_pages_regions_and_tables_parse_and_bad_lines_are_skipped():
    page = {
        "page": 1, "box": [0, 0, 612, 792], "rotation": 0, "ms": 5,
        "regions": [
            {"kind": "paragraph", "order": 1, "bbox": [1, 2, 3, 4], "text": "b"},
            {"kind": "paragraph", "order": 0, "bbox": [5, 6, 7, 8], "text": "a"},
        ],
        "tables": [{"bbox": [0, 0, 10, 10], "cells": [{"row": 0, "col": 1, "rowspan": 1, "colspan": 2, "bbox": [0, 0, 5, 5], "text": "x"}]}],
    }
    pages = parse_stream([HEADER, json.dumps(page), json.dumps({"page": 2, "error": "vision: boom"}), "not json", ""])
    assert [r.text for r in pages[1].regions] == ["a", "b"]
    assert pages[1].regions[0].bbox == (5.0, 6.0, 7.0, 8.0)
    assert pages[1].tables[0].cells[0].colspan == 2
    assert pages[2].error == "vision: boom" and pages[2].regions == []


def test_a_missing_helper_is_a_reason(monkeypatch, tmp_path):
    monkeypatch.setenv("MUSAEUM_LAYOUT_HELPER", str(tmp_path / "nope"))
    with pytest.raises(LayoutUnavailable) as err:
        run_helper(tmp_path / "x.pdf")
    assert "not installed" in err.value.reason


def test_run_helper_reads_whatever_helper_it_is_given(tmp_path):
    script = tmp_path / "fake"
    page = json.dumps({"page": 1, "box": [0, 0, 1, 1], "regions": [], "tables": []})
    script.write_text(f"#!/bin/sh\necho '{HEADER}'\necho '{page}'\necho noise >&2\n")
    script.chmod(0o755)
    assert list(run_helper(tmp_path / "x.pdf", helper=str(script))) == [1]


def _real_helper():
    exe = find_helper()
    major = int((platform.mac_ver()[0] or "0").split(".")[0])
    if not exe or major < 26:
        pytest.skip("needs the built layout helper on macOS 26+ (scripts/build-layout-helper.sh)")
    return exe


PARAGRAPH = [Text(72, 700 - 16 * i, f"This is line number {i} of a plain paragraph of text.", 12) for i in range(8)]


def _inside_share(path, layout):
    chars = [c for c in page_chars(pdfium.PdfDocument(path)[0].get_textpage()) if not c.is_space]
    boxes = [r.bbox for r in layout.regions]
    inside = sum(1 for c in chars if any(b[0] - 1 <= c.cx <= b[2] + 1 and b[1] - 1 <= c.cy <= b[3] + 1 for b in boxes))
    return inside / len(chars)


def test_real_helper_regions_land_on_pdf_coordinates(tmp_path):
    exe = _real_helper()
    path = write_pdf(tmp_path / "p.pdf", [Page(texts=PARAGRAPH, crop=(40, 40, 572, 752))])
    layout = run_helper(path, helper=exe)[1]
    assert layout.error is None and layout.regions
    assert layout.box == (40.0, 40.0, 572.0, 752.0)
    assert _inside_share(path, layout) >= 0.9


def test_real_helper_handles_a_rotated_page(tmp_path):
    exe = _real_helper()
    path = write_pdf(tmp_path / "r.pdf", [Page(texts=PARAGRAPH, rotate=90)])
    layout = run_helper(path, helper=exe)[1]
    assert layout.rotation == 90 and layout.regions
    assert _inside_share(path, layout) >= 0.9
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `$PY -m pytest sidecar/tests/test_reflow_vision.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'reflow.vision'`.

- [ ] **Step 5: Write `vision.py`**

Create `sidecar/reflow/vision.py`:

```python
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `$PY -m pytest sidecar/tests/test_reflow_vision.py -v`
Expected: 9 passed on this Mac (macOS 26.7 with the helper built); on a machine without the helper the two `test_real_helper_*` tests report SKIPPED and the rest pass.

- [ ] **Step 7: Commit**

```bash
git add helpers/musaeum-layout/main.swift scripts/build-layout-helper.sh .gitignore sidecar/reflow/vision.py sidecar/tests/test_reflow_vision.py
git commit -m "feat(helpers): musaeum-layout — a page's regions and reading order from Apple Vision, in PDF coordinates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Regions filled with the PDF's own characters

**Files:**
- Create: `sidecar/reflow/regions.py`
- Test: `sidecar/tests/test_reflow_regions.py`

**Interfaces:**
- Consumes: `Char`, `baseline_lines` (Task 1); `Block`, `Box`, `UNMAPPED_HYPHEN`, `clean_text` (Task 4); `PageLayout`, `Region`, `Table`, `TableCell` (Task 6).
- Produces: `reflow.regions`: `junk_score(text) -> float`; `choose_text(pdf_text, vision_text) -> tuple[str, str]` (text, `'pdf'|'vision'`); `line_text(chars) -> str`; `join_lines(lines: list[str]) -> str`; `PageText(blocks, orphans, vision_regions, dropped_text)`; `build_page_text(index: int, chars: Sequence[Char], layout: Optional[PageLayout], figure_boxes: Sequence[Box], page_box: Box) -> PageText`. Blocks come out as kind `para` (with `size`, `bold`, `lines`, `left/bottom/right/top`, `source`) or `table` (with `rows`); roles are Task 8's.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_reflow_regions.py`:

```python
from reflow.chars import Char
from reflow.regions import build_page_text, choose_text, join_lines, junk_score, line_text
from reflow.vision import PageLayout, Region, Table, TableCell

PAGE = (0.0, 0.0, 612.0, 792.0)


def glyphs(text, x, y, size=10.0, bold=False, angle=0.0):
    out = []
    for ch in text:
        if ch == " ":
            out.append(Char(" ", x, y, x + size * 0.25, y, size=size, angle=angle))
            x += size * 0.3
        else:
            out.append(Char(ch, x, y, x + size * 0.5, y + size * 0.7, size=size, bold=bold, angle=angle))
            x += size * 0.55
    return out


def column(lines, x, y0, size=10.0):
    out = []
    for i, text in enumerate(lines):
        out += glyphs(text, x, y0 - 14 * i, size)
    return out


def layout(*regions, tables=()):
    return PageLayout(page=1, box=PAGE, regions=[Region(i, box, text) for i, (box, text) in enumerate(regions)], tables=list(tables))


def texts(result):
    return [b.text for b in result.blocks]


def test_a_space_inside_a_ligature_is_dropped():
    chars = [
        Char("f", 435.4, 100, 440.4, 107, size=9.5),
        Char("i", 435.4, 100, 440.4, 107, size=9.5),
        Char(" ", 437.8, 100, 440.4, 107, size=9.5),  # Universe p.78: "fi ghting"
        Char("g", 440.8, 98, 445.3, 105, size=9.5),
        Char("h", 445.5, 100, 450.0, 107, size=9.5),
    ]
    assert line_text(chars) == "figh"


def test_real_spaces_stay_and_missing_ones_are_added_but_not_before_punctuation():
    assert line_text(glyphs("the cat", 72, 700)) == "the cat"
    gap = glyphs("the", 72, 700) + glyphs("cat", 100, 700)
    assert line_text(gap) == "the cat"
    stop = glyphs("word", 72, 700) + glyphs(".", 100, 700)
    assert line_text(stop) == "word."


def test_join_lines_rejoins_a_word_broken_at_the_line_end():
    assert join_lines(["a mer-", "cenary soldier"]) == "a mercenary soldier"
    assert join_lines(["Coper-", "Nican"]) == "Coper- Nican"


def test_choose_text_keeps_the_text_layer_for_math():
    assert choose_text("(x1, ..., xn) to a sequence", "(21,...,Xn) to a sequence") == ("(x1, ..., xn) to a sequence", "pdf")


def test_choose_text_takes_vision_over_a_scanners_ocr_layer():
    text, source = choose_text("Hl'n t' I hi' h.!'> to ld tlw moiL•cular", "Herve This has told the story of molecular")
    assert source == "vision" and text == "Herve This has told the story of molecular"
    assert junk_score("Hl'n t' I hi' h.!'> to ld tlw moiL•cular") > junk_score("Herve This has told the story")


def test_choose_text_uses_vision_only_where_the_pdf_has_nothing():
    assert choose_text("", "The Origins of Molecular Gastronomy") == ("The Origins of Molecular Gastronomy", "vision")
    assert choose_text("", "") == ("", "pdf")


def test_two_columns_read_in_vision_order_without_interleaving():
    left = column(["Left one about stars", "left two about stars", "left three about stars"], 72, 700)
    right = column(["Right one about planets", "right two about planets", "right three about planets"], 320, 700)
    result = build_page_text(0, right + left, layout(((70, 670, 250, 712), ""), ((318, 670, 500, 712), "")), [], PAGE)
    assert texts(result) == [
        "Left one about stars left two about stars left three about stars",
        "Right one about planets right two about planets right three about planets",
    ]


def test_a_rotated_stamp_is_dropped_even_though_vision_read_it():
    stamp = glyphs("arXiv:1706", 20, 300, angle=4.71)
    body = column(["Body text here."], 72, 700)
    result = build_page_text(0, stamp + body, layout(((15, 290, 80, 320), "arXiv:1706"), ((70, 695, 300, 712), "")), [], PAGE)
    assert texts(result) == ["Body text here."]


def test_vision_splitting_a_line_in_two_is_one_paragraph():
    chars = glyphs("The dominant models are", 72, 700) + glyphs("mechanism.", 72, 686) + glyphs("We propose a new", 150, 686)
    result = build_page_text(0, chars, layout(((70, 684, 300, 712), ""), ((148, 684, 400, 698), "")), [], PAGE)
    assert texts(result) == ["The dominant models are mechanism. We propose a new"]


def test_a_sentence_continuing_into_the_next_column_is_one_paragraph():
    left = column(["Kepler was born to a poor"], 72, 100)
    right = column(["family in a region."], 320, 700)
    result = build_page_text(0, left + right, layout(((70, 95, 250, 112), ""), ((318, 695, 500, 712), "")), [], PAGE)
    assert texts(result) == ["Kepler was born to a poor family in a region."]


def test_a_smaller_caption_never_swallows_the_body_after_it():
    caption = glyphs("Figure 1 A caption without stop", 72, 500, size=8)
    body = glyphs("continues the body.", 72, 450)
    result = build_page_text(0, caption + body, layout(((70, 495, 300, 510), ""), ((70, 445, 300, 460), "")), [], PAGE)
    assert len(result.blocks) == 2


def test_a_table_replaces_the_paragraphs_inside_it():
    intro = glyphs("Times and temperatures.", 72, 700)
    cells = glyphs("fish", 72, 600) + glyphs("63", 200, 600) + glyphs("eggs", 72, 586) + glyphs("57", 200, 586)
    table = Table(
        (70, 580, 260, 612),
        (
            TableCell(0, 0, 1, 1, (70, 596, 150, 612), "fish"),
            TableCell(0, 1, 1, 1, (190, 596, 260, 612), "63"),
            TableCell(1, 0, 1, 1, (70, 580, 150, 596), "eggs"),
            TableCell(1, 1, 1, 1, (190, 580, 260, 596), "57"),
        ),
    )
    regions = layout(((70, 695, 300, 712), ""), ((70, 596, 150, 612), "fish"), ((190, 596, 260, 612), "63"), tables=[table])
    result = build_page_text(0, intro + cells, regions, [], PAGE)
    assert [b.kind for b in result.blocks] == ["para", "table"]
    assert result.blocks[1].rows == [["fish", "63"], ["eggs", "57"]]


def test_a_written_figure_swallows_its_label_and_records_it():
    body = glyphs("Body text here.", 72, 700)
    label = glyphs("Label inside", 320, 340)
    result = build_page_text(
        0, body + label, layout(((70, 695, 300, 712), ""), ((310, 335, 480, 352), "Label inside")), [(300, 300, 500, 390)], PAGE
    )
    assert texts(result) == ["Body text here."]
    assert result.dropped_text == ["Label inside"]


def test_a_page_vision_failed_on_reads_as_one_region():
    chars = column(["First line.", "Second line."], 72, 700)
    result = build_page_text(0, chars, PageLayout(page=1, error="vision: boom"), [], PAGE)
    assert texts(result) == ["First line. Second line."]


def test_char_outside_every_region_is_an_orphan():
    chars = glyphs("Body.", 72, 700) + [Char("x", 900, 900, 905, 907, size=10)]
    result = build_page_text(0, chars, layout(((70, 695, 300, 712), "")), [], PAGE)
    assert texts(result) == ["Body."] and result.orphans == 1


def test_a_garbage_text_layer_region_reads_from_vision_and_is_counted():
    chars = glyphs("Hl'n t' I hi' h.!'> to ld tlw moiL•cular", 72, 700)
    result = build_page_text(0, chars, layout(((70, 695, 400, 712), "Herve This has told the story of molecular")), [], PAGE)
    assert texts(result) == ["Herve This has told the story of molecular"]
    assert result.blocks[0].source == "vision" and result.vision_regions == 1


def test_block_size_and_boldness_come_from_its_characters():
    chars = glyphs("A Bold Heading", 72, 740, size=18, bold=True)
    block = build_page_text(0, chars, layout(((70, 735, 300, 760), "")), [], PAGE).blocks[0]
    assert (block.size, block.bold, block.lines) == (18.0, True, 1)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$PY -m pytest sidecar/tests/test_reflow_regions.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'reflow.regions'`.

- [ ] **Step 3: Write `regions.py`**

Create `sidecar/reflow/regions.py`:

```python
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
        if unit.rotated and not glyphs:
            continue  # a rotated stamp: never read back in from Vision's OCR
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `$PY -m pytest sidecar/tests/test_reflow_regions.py -v`
Expected: 17 passed.

- [ ] **Step 5: Commit**

```bash
git add sidecar/reflow/regions.py sidecar/tests/test_reflow_regions.py
git commit -m "feat(sidecar): reflow regions — Vision's order, the text layer's words, Vision's only where the layer is bad OCR

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The page pass on Vision — roles, furniture, figures in place, and the old pass deleted

**Files:**
- Modify: `sidecar/reflow/layout.py` (rewire `analyse`; add `classify_roles`, `stitch_pages`, `place_figures`; delete the band pass)
- Modify: `sidecar/reflow/model.py` (drop `PageResult`'s slice-1 fields and `Document.sections`)
- Modify: `sidecar/reflow/__init__.py`
- Modify: `scripts/pdf-reflow-probe.py` (normal mode runs the gate)
- Modify: `sidecar/tests/test_reflow_figures.py` (its three `extract_page` tests move onto `analyse`)
- Modify: `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` (Annex C.5 item 4, footnotes)
- Test: `sidecar/tests/test_reflow_pipeline.py`

**Interfaces:**
- Consumes: everything above — `page_chars` (1), `gate.*` (2), `model.*`, `_figure_regions`, `_crop`, `render_plate` (4), `document_entries`, `write_epub` (5), `run_helper`, `LayoutUnavailable`, `PageLayout` (6), `build_page_text`, `join_lines` (7).
- Produces: `reflow.layout`: `analyse(path, limit=None, layouts: Optional[dict[int, PageLayout]] = None) -> Document` — `layouts` is keyed by **1-based** page number; when `None` the helper is run. Verdicts: `ok`, `no_text_layer`, `no_layout` (helper missing or macOS < 26), `unreadable` (pdfium cannot open the file), `unstable_layout` (more than 25% of text pages had no usable layout). `classify_roles(pages) -> None`; `stitch_pages(pages) -> None`; `place_figures(text_blocks, figures) -> list[Block]`; `mark_running_heads(doc) -> None`.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_reflow_pipeline.py`:

```python
import pytest

from reflow import gate, layout
from reflow.epub import write_epub
from reflow.layout import analyse, classify_roles, place_figures, stitch_pages
from reflow.model import Block, PageResult
from reflow.outline import document_entries
from reflow.vision import LayoutUnavailable, PageLayout, Region
from tests.reflow_pdfs import Page, Rect, Text, write_pdf

FOOTER = "CHAPTER 4 THE ORIGIN OF MODERN ASTRONOMY"
F_BOX = (70, 26, 400, 40)
BODY_BOX = (70, 620, 420, 712)


def plain(lines, extra=()):
    return Page(texts=[Text(72, 700 - 14 * i, t) for i, t in enumerate(lines)] + [Text(72, 30, FOOTER, 8)] + list(extra))


def regions(page_no, *boxes):
    return PageLayout(page=page_no, box=(0, 0, 612, 792), regions=[Region(i, b, t) for i, (b, t) in enumerate(boxes)])


BODY = ["Body on this page continues the story of the stars.", "It has enough characters to count as a text page."]


def book(tmp_path):
    two_columns = Page(
        texts=[Text(72, 700 - 14 * i, f"Left line {i} tells of stars") for i in range(6)]
        + [Text(320, 700 - 14 * i, f"Right line {i} tells of planets") for i in range(6)]
        + [Text(72, 30, FOOTER, 8)]
    )
    stamped = plain(BODY, extra=[Text(30, 300, "arXiv:1706.03762v5", 10, rotated=True)])
    headed = plain(BODY, extra=[Text(72, 740, "Chapter Heading", 18, bold=True)])
    plate = Page(rects=[Rect(0, 0, 612, 792, 0.3)])
    path = write_pdf(tmp_path / "book.pdf", [two_columns, stamped, headed, plate])
    layouts = {
        1: regions(1, ((70, 625, 250, 712), ""), ((318, 625, 520, 712), ""), (F_BOX, "")),
        2: regions(2, ((15, 290, 40, 420), "arXiv:1706.03762v5"), (BODY_BOX, ""), (F_BOX, "")),
        3: regions(3, ((70, 735, 300, 760), ""), (BODY_BOX, ""), (F_BOX, "")),
    }
    return path, layouts


def all_text(doc):
    return " ".join(b.text for p in doc.pages for b in p.blocks)


def test_a_book_reads_in_order_without_its_stamp_or_its_running_footer(tmp_path):
    path, layouts = book(tmp_path)
    doc = analyse(path, layouts=layouts)
    assert doc.verdict == "ok"
    first, second = [b.text for b in doc.pages[0].blocks]
    assert first.startswith("Left line 0") and "planets" not in first
    assert second.startswith("Right line 0") and "stars" not in second
    assert FOOTER not in all_text(doc) and doc.dropped_running_heads
    assert "arXiv" not in all_text(doc) and "1706" not in all_text(doc)
    assert doc.pages[2].blocks[0].kind == "heading" and doc.pages[2].blocks[0].level == 1
    assert [b.plate for b in doc.pages[3].blocks] == [True] and doc.plates == 1


def test_the_whole_path_produces_a_package_the_gate_accepts(tmp_path):
    path, layouts = book(tmp_path)
    doc = analyse(path, layouts=layouts)
    doc.entries = document_entries(path, doc)
    out = str(tmp_path / "book.epub")
    write_epub(doc, out, "Book")
    assert gate.check_package(out) == []
    assert gate.check_figures(out, expected_figures=doc.figures_detected, expected_plates=1) == []
    assert gate.check_golden(gate.spine_text(out), ["Left line 5 tells of stars Right line 0 tells of planets"]) == []


def test_missing_page_layout_degrades_to_one_region(tmp_path):
    path = write_pdf(tmp_path / "m.pdf", [plain(BODY) for _ in range(4)])
    layouts = {n: regions(n, (BODY_BOX, ""), (F_BOX, "")) for n in (1, 3, 4)}
    doc = analyse(path, layouts=layouts)
    assert doc.verdict == "ok" and doc.layout_errors == 1
    assert "continues the story" in " ".join(b.text for b in doc.pages[1].blocks)


def test_too_many_missing_layouts_is_unstable(tmp_path):
    path = write_pdf(tmp_path / "u.pdf", [plain(BODY) for _ in range(4)])
    doc = analyse(path, layouts={1: regions(1, (BODY_BOX, ""))})
    assert doc.verdict == "unstable_layout" and "3 of 4" in doc.reason


def test_unopenable_pdf_is_a_verdict(tmp_path):
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"this is not a pdf at all")
    doc = analyse(str(path), layouts={})
    assert doc.verdict == "unreadable" and doc.reason


def test_no_layout_helper_is_a_fallback_reason(tmp_path, monkeypatch):
    path = write_pdf(tmp_path / "n.pdf", [plain(BODY)])

    def unavailable(*args, **kwargs):
        raise LayoutUnavailable("page layout needs macOS 26 or later")

    monkeypatch.setattr(layout, "run_helper", unavailable)
    doc = analyse(path)
    assert doc.verdict == "no_layout" and "macOS 26" in doc.reason


def test_a_textless_book_never_runs_the_helper(tmp_path, monkeypatch):
    path = write_pdf(tmp_path / "t.pdf", [Page(rects=[Rect(0, 0, 612, 792, 0.3)])] * 2)
    monkeypatch.setattr(layout, "run_helper", lambda *a, **k: pytest.fail("helper ran on a textless book"))
    assert analyse(path).verdict == "no_text_layer"


def B(kind="para", text="", size=10.0, bold=False, lines=3, top=600.0, bottom=560.0, left=72.0, right=500.0):
    return Block(kind, text=text, size=size, bold=bold, lines=lines, top=top, bottom=bottom, left=left, right=right)


def page(*blocks, index=0):
    return PageResult(index=index, blocks=list(blocks), chars=500, top=792, bottom=0)


def test_roles_from_size_and_weight():
    body = B(text="x" * 400)
    big = B(text="Chapter One", size=18, lines=1, top=750)
    bold = B(text="Encoder Stacks", bold=True, lines=1, top=700)
    long_bold = B(text="y" * 300, bold=True)
    note = B(text="* A note.", size=8, lines=1, top=80, bottom=70)
    small_mid = B(text="A caption.", size=8, lines=1, top=400)
    classify_roles([page(body, big, bold, long_bold, note, small_mid)])
    assert (big.kind, big.level) == ("heading", 1)
    assert (bold.kind, bold.level) == ("heading", 2)
    assert long_bold.kind == "para" and small_mid.kind == "para"
    assert note.kind == "footnote"


def test_a_paragraph_continuing_onto_the_next_page_is_joined_before_its_notes():
    last = B(text="approaches in sequence modeling and")
    note = B("footnote", text="* Equal contribution.")
    cont = B(text="transduction problems such as language modeling.")
    p0, p1 = page(last, note), page(cont, index=1)
    stitch_pages([p0, p1])
    assert [b.text for b in p0.blocks] == ["approaches in sequence modeling and transduction problems such as language modeling.", "* Equal contribution."]
    assert p1.blocks == []


def test_notes_move_past_a_paragraph_that_continues_with_a_capital():
    last, note = B(text="ends without a stop"), B("footnote", text="note")
    first, more = B(text="Next starts upper."), B(text="More.")
    p0, p1 = page(last, note), page(first, more, index=1)
    stitch_pages([p0, p1])
    assert [b.text for b in p0.blocks] == ["ends without a stop"]
    assert [b.text for b in p1.blocks] == ["Next starts upper.", "note", "More."]


def test_figures_go_before_the_first_block_below_them_in_their_column():
    above = B(text="above", top=700, bottom=650, left=72, right=300)
    other_column = B(text="right column", top=500, bottom=300, left=320, right=540)
    below = B(text="below", top=400, bottom=350, left=72, right=300)
    figure = B("figure", top=600, bottom=450, left=80, right=280)
    assert place_figures([above, other_column, below], [figure]) == [above, other_column, figure, below]
    assert place_figures([above], [B("figure", top=100, bottom=50)])[-1].kind == "figure"
```

In `sidecar/tests/test_reflow_figures.py`, delete `test_a_failed_crop_keeps_the_figures_labels`, `test_a_written_crop_swallows_its_labels`, `test_a_textless_page_becomes_a_plate` and the `extract_page` import, and add:

```python
from reflow.layout import analyse
from reflow.vision import PageLayout, Region

LABELLED = BODY + [Text(320, 340, "Label inside the figure")]
LABEL_LAYOUT = {
    1: PageLayout(
        page=1, box=(0, 0, 612, 792),
        regions=[Region(0, (70, 670, 450, 732), ""), Region(1, (310, 335, 480, 352), "Label inside the figure")],
    )
}


def test_a_failed_crop_keeps_the_figures_labels(tmp_path, monkeypatch):
    path = write_pdf(tmp_path / "l.pdf", [Page(texts=LABELLED, rects=[Rect(300, 300, 200, 90, 0.8)])])
    monkeypatch.setattr(layout, "_crop", lambda *a, **k: None)
    doc = analyse(path, layouts=LABEL_LAYOUT)
    assert "Label inside the figure" in " ".join(b.text for b in doc.pages[0].blocks)
    assert len(doc.crop_failures) == 1 and not any(b.kind == "figure" for b in doc.pages[0].blocks)


def test_a_written_crop_swallows_its_labels(tmp_path):
    path = write_pdf(tmp_path / "w.pdf", [Page(texts=LABELLED, rects=[Rect(300, 300, 200, 90, 0.8)])])
    doc = analyse(path, layouts=LABEL_LAYOUT)
    assert "Label inside the figure" not in " ".join(b.text for b in doc.pages[0].blocks)
    assert [b.image_type for b in doc.pages[0].blocks if b.kind == "figure"] == ["png"]
    assert "Label inside the figure" in doc.dropped_text


def test_a_textless_page_becomes_a_plate(tmp_path):
    path = write_pdf(tmp_path / "p.pdf", [Page(texts=LABELLED), Page(rects=[Rect(0, 0, 612, 792, 0.3)])])
    doc = analyse(path, layouts={1: LABEL_LAYOUT[1]})
    assert [b.plate for b in doc.pages[1].blocks] == [True]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$PY -m pytest sidecar/tests/test_reflow_pipeline.py sidecar/tests/test_reflow_figures.py -v`
Expected: FAIL — `ImportError: cannot import name 'classify_roles' from 'reflow.layout'`.

- [ ] **Step 3: Delete the band pass from `layout.py`**

Delete, from `sidecar/reflow/layout.py`: the class `Element`; the functions `_height`, `_page_chars`, `_group_lines`, `_line_text`, `_binds`, `_find_bands`, `_band_of`, `_is_page_level`, `order_elements`, `_leading`, `_body_height`, `_joins`, `build_blocks`, `assign_heading_levels`, `_split_at_bands`, `_refresh`, `extract_page`, `_inside`, `_label_inside`; the constants `_CLOSING`, `_OPENING`, `_HYPHENS`, and the tunables `BAND_COVERAGE`, `MIN_VALLEY_PT`, `MIN_VALLEY_FRACTION`, `MIN_BAND_CHARS`, `FULL_WIDTH`, `BASELINE_TOLERANCE`, `WORD_GAP_EM`, `BODY_RATIO`, `MAX_BANDS`, `VALLEY_CHAR_LIMIT`, `HEADING_MAX_CHARS`, `PARAGRAPH_LEADING`, `SHORT_LINE`, `INDENT_EM`, `TABLE_LABEL_MAX_CHARS`, `TABLE_LABEL_MAX_SHARE`, `HEADING_LEVELS`. Remove the now-unused `time` import.

**Keep exactly as Task 4 left them:** `_figure_regions`, `Crop`, `_crop`, `_has_ink`, `render_plate`, and their `FIGURE_*`, `PLATE_MAX_PIXELS`, `INK_THRESHOLD` tunables.

Replace the module docstring with:

```python
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
```

Set the imports to:

```python
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
```

and add to the tunables block:

```python
HEADING_RATIO = 1.15  # a region this much larger than the body may be a heading
HEADING_MAX_CHARS = 120
HEADING_MAX_LINES = 2
HEADING_LEVELS = 3
FOOTNOTE_RATIO = 0.85  # a region this much smaller than the body…
FOOTNOTE_ZONE = 0.25  # …inside the bottom quarter of its page is a footnote
LAYOUT_ERROR_SHARE = 0.25  # more text pages than this without a layout: fall back
_SENTENCE_END = (".", "!", "?", ":", "”", "’", '"')
```

and change `RUNNING_HEAD_BAND = 0.10` to `RUNNING_HEAD_BAND = 0.08` (spec Annex C.5 item 5). In `_is_furniture`, change the first test to `if block.kind in ("figure", "table") or not block.text.strip():`.

- [ ] **Step 4: Add roles, stitching and figure placement**

Add to `layout.py`, after the running-heads section:

```python
# --- roles (spec Annex C.5 item 4) ------------------------------------------
def _size_key(size: float) -> float:
    return round(size * 2) / 2


def classify_roles(pages: list[PageResult]) -> None:
    """Headings and footnotes, from font size and weight against the body.

    The body is the size carrying the most characters. Slice 1 measured
    glyph-box heights instead, which made body lines headings and missed a
    paper's bold section titles at the body's own size. Heading levels rank the
    heading sizes, largest first; an outline entry that later claims a heading
    overrides its level with the outline's depth (`epub.link_entries`).
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
        return
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


def _index(blocks: list[Block], block: Block) -> int:
    return next(i for i, b in enumerate(blocks) if b is block)


def stitch_pages(pages: list[PageResult]) -> None:
    """Carry a paragraph across a page break, and its page's footnotes past it.

    Vision orders a page's footnotes after its last paragraph, so a sentence
    running on to the next page would be read with the notes in its middle —
    *Attention is All You Need*'s Introduction, pages 1 to 2. When a page's
    last paragraph ends without terminal punctuation: a next page that opens
    in lower case is the same paragraph and is joined to it; otherwise the
    notes move to just after the next page's first paragraph.
    """
    text_pages = [p for p in pages if any(b.kind == "para" for b in p.blocks)]
    for page, nxt in zip(text_pages, text_pages[1:]):
        last = [b for b in page.blocks if b.kind == "para"][-1]
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
        notes = [b for b in page.blocks[start + 1 :] if b.kind == "footnote"]
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
```

- [ ] **Step 5: Rewire `analyse` and the verdict**

Replace `_verdict` and `analyse` with:

```python
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
    classify_roles(doc.pages)
    stitch_pages(doc.pages)
    _verdict(doc)
    return doc
```

- [ ] **Step 6: Drop the slice-1 fields and update the exports**

In `sidecar/reflow/model.py`, delete from `PageResult` the comment `# Slice-1 bookkeeping…` and the six fields under it (`lines`, `cross_band`, `figures_swallowed`, `labels_swallowed`, `bands`, `seconds`), and delete `Document.sections` with its comment.

In `sidecar/reflow/__init__.py`, change `from .layout import analyse, extract_page` to `from .layout import analyse` and remove `"extract_page"` from `__all__`. Replace the docstring's second paragraph with: `Called by scripts/pdf-reflow-probe.py and by nothing else yet: it is not wired into the sidecar's RPC (slice 2), does not know about the library, and writes nothing outside the output path it is given.`

- [ ] **Step 7: Record the footnote rule in the spec**

In Annex C.5 item 4, replace `A region whose median size is ≤0.85× body and which sits in the bottom quarter of the page is a footnote, emitted where Vision ordered it with class="footnote".` with: `A region whose median size is ≤0.85× body and which sits in the bottom quarter of the page is a footnote (`class="footnote"`). When a page's last paragraph ends without terminal punctuation, a next page that opens in lower case is joined to it, and otherwise that page's footnotes move to after the next page's first paragraph — so a sentence crossing a page break is never read with the notes in its middle (*Attention*'s Introduction, pages 1–2; golden passage G1 #3).`

- [ ] **Step 8: Make the probe's normal mode run the gate**

In `scripts/pdf-reflow-probe.py`:

1. Delete `pdf_words`, `epub_text`, `validate`, `missing_report`, `compare_pdfminer`, the `--compare` option and its `compare` parameter, and the now-unused `ElementTree`, `unescape`, `zipfile` and `TAG` names. Remove the `--compare` line from the docstring and replace its paragraph about "word-multiset diff" with: `Each artifact is judged by the gate of the spec's Annex C.4 (sidecar/reflow/gate.py); the script exits 1 if any book fails it.`
2. Replace `run_one` with:

```python
def run_one(title: str, why: str, root: str, out_dir: str, limit: Optional[int], golden: dict[str, list[str]]) -> dict:
    matched, rel, formats = book(title)
    path = pdf_in(os.path.join(root, rel))
    if not path:
        return {"title": matched, "why": why, "verdict": "no_pdf", "reason": "folder holds no .pdf", "artifact": None}

    rec: dict = {
        "title": matched,
        "why": why,
        "formats": formats,
        "mb": round(os.path.getsize(path) / 1048576, 1),
        "pdf": os.path.basename(path),
    }
    started = time.perf_counter()
    doc = analyse(path, limit=limit)
    doc.entries = document_entries(path, doc)
    rec["seconds"] = round(time.perf_counter() - started, 1)
    rec["pages"] = len(doc.pages)
    rec["ms_per_page"] = round(rec["seconds"] / max(len(doc.pages), 1) * 1000, 1)
    blocks = [b for p in doc.pages for b in p.blocks]
    rec.update(
        verdict=doc.verdict,
        reason=doc.reason,
        text_pages=len(doc.text_pages),
        headings=sum(1 for b in blocks if b.kind == "heading"),
        footnotes=sum(1 for b in blocks if b.kind == "footnote"),
        tables=sum(1 for b in blocks if b.kind == "table"),
        figures=doc.figures_detected,
        plates=doc.plates,
        crop_failures=doc.crop_failures[:5],
        vision_regions=doc.vision_regions,
        vision_pages=len(doc.vision_pages),
        orphans=doc.orphans,
        layout_errors=doc.layout_errors,
        dropped_running_heads=len(doc.dropped_running_heads),
        running_head_sample=doc.dropped_running_heads[:4],
        outline_entries=doc.outline_entries,
        toc_from="outline" if doc.entries_from_outline else "headings",
        section_titles=[e.title for e in doc.entries[:8]],
    )

    slug = re.sub(r"[^a-zA-Z0-9]+", "-", matched).strip("-")[:60]
    epub_path = os.path.join(out_dir, f"{slug}.epub")
    if doc.verdict != "ok":
        rec["artifact"] = None
        rec["note"] = "fallback: no artifact written, which is what D6 asks for"
        return rec
    rec.update(write_epub(doc, epub_path, matched))
    rec["artifact"] = os.path.relpath(epub_path, out_dir)
    rec["gate"] = gate_book(
        path,
        epub_path,
        passages=golden.get(matched, []),
        pages=len(doc.pages),
        expected_figures=doc.figures_detected,
        exclusions={p.index: p.figure_boxes for p in doc.pages},
        skip_pages=frozenset(doc.vision_pages),
        excluded_words=Counter(gate.tokens("\n".join(doc.dropped_running_heads + doc.dropped_text))),
    )
    return rec
```

3. Replace `print_report` with:

```python
def print_report(records: list[dict]) -> None:
    print(f"{'book':44s} {'pages':>6s} {'verdict':<15s} {'toc':>5s} {'figs':>5s} {'plates':>6s} {'ocr':>5s} {'sec':>6s} {'ms/pg':>6s}")
    for r in records:
        if r.get("verdict") == "no_pdf":
            print(f"{r['title'][:44]:44s} {'-':>6s} no pdf")
            continue
        print(
            f"{r['title'][:44]:44s} {r['pages']:>6d} {r['verdict']:<15s} {r.get('toc_entries', 0):>5d} "
            f"{r['figures']:>5d} {r['plates']:>6d} {r['vision_regions']:>5d} {r['seconds']:>6.1f} {r['ms_per_page']:>6.1f}"
        )
    print()
    for r in records:
        if r.get("verdict") == "no_pdf":
            continue
        print(f"— {r['title']}  ({r['why']})")
        print(f"    verdict   {r['verdict']}{' — ' + r['reason'] if r['reason'] else ''}")
        print(f"    toc       from the {r['toc_from']}; {r['outline_entries']} outline entries; first: {r['section_titles'][:4]}")
        print(
            f"    blocks    {r['headings']} headings, {r['footnotes']} footnotes, {r['tables']} tables, "
            f"{r['dropped_running_heads']} furniture dropped, {r['orphans']} orphan chars, {r['layout_errors']} layout errors, "
            f"{r['vision_regions']} regions read from Vision on {r['vision_pages']} pages"
        )
        print(f"    figures   {r['figures']} detected, {r['plates']} plates, crop failures: {r['crop_failures'] or 'none'}")
        if r.get("artifact"):
            print(f"    artifact  {r['artifact']}  {r['bytes'] / 1024:.0f} KB  {r['words']} words  {r['sections']} files")
        print()
```

4. In `main`, build `golden = load_golden()` once, call `run_one(title, why, root, out_dir, limit, golden)`, and replace the closing `passed = …` / `fallback = …` / `print(f"gate: …")` / `return 0` lines with:

```python
    return 1 if print_gate(records) else 0
```

- [ ] **Step 9: Run the whole reflow suite**

Run: `$PY -m pytest sidecar/tests -k reflow -v`
Expected: all pass (11 new in `test_reflow_pipeline.py`; `test_reflow_figures.py` still 12). Then the full sidecar suite, which must stay green: `$PY -m pytest sidecar/tests -q`.

- [ ] **Step 10: Commit**

```bash
git add sidecar/reflow sidecar/tests scripts/pdf-reflow-probe.py docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md
git commit -m "feat(sidecar): the reflow page pass on Vision — roles from size and weight, footnotes past a page break, figures in place; the band pass deleted

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Run the corpus through the gate, and hand it to the owner

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` (Annex C.7, run 2; the status line)
- Modify: `tasks.md` (the C2 entry)
- Output (gitignored): `dist/reflow-spike/`

**Interfaces:**
- Consumes: the whole pipeline (Tasks 1–8); the built helper (Task 6); the NAS mounted at `/Volumes/books/musaeum` and the live database (read-only).
- Produces: six artifacts or fallbacks in `dist/reflow-spike/`, `report.json`, and the recorded run.

- [ ] **Step 1: Check the preconditions**

```bash
ls /Volumes/books/musaeum >/dev/null && echo nas-ok
test -x helpers/bin/musaeum-layout || ./scripts/build-layout-helper.sh
sw_vers -productVersion
```

Expected: `nas-ok`, a built helper, and macOS 26 or later. If the NAS is not mounted, stop and ask the owner to mount it.

- [ ] **Step 2: Run the probe**

```bash
$PY scripts/pdf-reflow-probe.py --out dist/reflow-spike >/tmp/gate-1r.txt 2>/tmp/gate-1r.err; echo "exit=$?"
cat /tmp/gate-1r.txt
grep -v '^… ' /tmp/gate-1r.err
```

Expected: `exit=0`, `gate: 6/6 books pass`, and the last command prints nothing — the pipeline's only stderr is the probe's own progress lines (AC10). *Universe* takes a few minutes (≈0.43 s/page in the helper at concurrency 8, measured).

- [ ] **Step 3: If a check fails, debug it — at most two repair attempts per check**

Use superpowers:systematic-debugging. For each failing `Gn`, reproduce it on the smallest page range first (`--book "<title>" --limit <n>`), find the cause in the code, write a failing pytest that pins it in the module that owns it (`test_reflow_regions.py`, `test_reflow_pipeline.py`, `test_reflow_toc.py` or `test_reflow_figures.py`), fix it, and re-run Step 2. Record every repair as a row of a *Bugs the corpus found* table in Annex C.7 run 2 — the defect, the cause, the measurement that found it. A threshold may only change when the run shows the spec's value is wrong, and then the spec's Annex C.5 changes in the same commit, with the measurement. **If the same check still fails after two repair attempts, stop and hand back** with the output and what was tried (CLAUDE.md, *Escalate*).

- [ ] **Step 4: Record run 2**

Append to Annex C.7 in the spec:

```markdown
**Run 2 — slice 1R (YYYY-MM-DD).** `scripts/pdf-reflow-probe.py --out dist/reflow-spike`, layout helper v1 on macOS 26.x.

| Book | Pages | Time | ms/page | TOC entries | Figures | Plates | Regions from Vision | G1–G7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| … one row per book from `/tmp/gate-1r.txt` and `dist/reflow-spike/report.json` … |
```

Fill in the date, the macOS version and every row: `G1–G7` reads `pass`, or the check that failed. Asterix reads `G8 pass — no artifact (no page carries a text layer)`. If Step 3 found bugs, add their table under it.

- [ ] **Step 5: Update the status lines**

In the spec's **Status** line, replace `and **slice 1R** re-runs the spike behind a rebuilt gate. Slices 2–5 still wait on the corpus gate, now slice 1R's.` with `and **slice 1R** re-ran the spike behind a rebuilt gate: the slice-1 artifacts fail it and the slice-1R artifacts pass it (Annex C.7). **What remains before slice 2 is the owner reading `dist/reflow-spike/`.**`

In `tasks.md`'s C2 entry, replace `**Slice 1R is in progress on \`feat/pdf-reflow-vision\`.**` with `**Slice 1R passed its rebuilt gate on YYYY-MM-DD (Annex C.7, run 2); the owner's reading of \`dist/reflow-spike/\` is what remains before slice 2.**`

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md tasks.md
git commit -m "docs: Annex C.7 — slice 1R passes the rebuilt gate on the corpus; the owner's reading is next

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand the artifacts to the owner**

Report: the gate table; the artifact paths in `dist/reflow-spike/`; the per-book timings; any repairs from Step 3; and what the gate cannot judge and the owner's reading must — heading levels on designed pages, figure placement on *Modernist Cuisine*, whether *Universe*'s sidebars read in a sensible place, and how the pages Vision read (the `ocr` column) look. The gate passing is necessary, not sufficient (spec Annex B.3 item 7 still holds: only a reader decides).
