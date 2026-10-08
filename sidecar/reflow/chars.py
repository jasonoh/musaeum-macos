"""pdfium's characters, with what the reflow needs to know about each one.

The layout comes from Vision (`vision.py`); the words come from here: every
character the PDF's text layer holds, with its box in PDF user space (the crop
box does not shift it), the size it is really drawn at, whether its font is
bold, and its rotation. The size is the `Tf` operand scaled by the text matrix
(`_font_size`), because a producer that writes `Tf 1` leaves every glyph at
1.0. Measured 2026-10-08: pdfium reports **weight 0** for a font with no
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


def _font_size(handle, index: int) -> float:
    """The size the glyph actually occupies, in page units.

    `FPDFText_GetFontSize` alone is the `Tf` operand, and a producer that
    writes `Tf 1` and puts the real size in the text matrix leaves it at
    **1.0 for every character of the book** — measured on *Universe* (5,650 of
    5,650 glyphs on p.78 report 1.0) and *Modernist Cuisine*. That is not a
    cosmetic number: the body size came out 1.0pt, so every heading test
    (`≥1.15× body`) and footnote test (`≤0.85× body`) was unreachable, and the
    space test — a stored space survives only at a gap ≥0.1× the size — kept
    *Universe*'s `fi ghting`, where the real space's gap is 0.4pt against ~1pt
    of allowance. Multiplying by the text matrix's scale reads 10.5 / 8.5 /
    11.0 / 5.0 on that page; on a producer that reports real sizes already the
    matrix is the identity and nothing moves (*Attention*, *Sequence to
    Sequence* and *Politics* all measure a scale of 1.00).
    """
    size = float(raw.FPDFText_GetFontSize(handle, index))
    matrix = raw.FS_MATRIX()
    if raw.FPDFText_GetMatrix(handle, index, ctypes.byref(matrix)):
        scale = math.sqrt(abs(matrix.a * matrix.d - matrix.b * matrix.c))
        if scale > 0:
            size *= scale
    return size


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
                size=_font_size(handle, i),
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
