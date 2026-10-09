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
    scaled: bool = False  # `Tf 1` plus a scaling `Tm`, as *Universe* writes it


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
        elif t.scaled:
            s = t.size
            ops.append(f"0 g BT /{font} 1 Tf {s} 0 0 {s} {t.x} {t.y} Tm ({_escape(t.text)}) Tj ET")
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
