"""Embedded PDF metadata + first-page cover rendering.

PDFs rarely carry identifiers, so extraction returns title/author only;
hydration then works from title+author search. Cover: page 1 rendered via
pdfium at ~2x, JPEG-encoded — fed to pipeline.cover._write_cover by callers.
"""

import io
from typing import Optional

from PIL import Image
from pypdf import PdfReader

RENDER_SCALE = 2.0  # 612pt page * 2 ≈ 1224px wide — plenty for a 600px cover


def extract_pdf_metadata(file_path: str) -> dict:
    reader = PdfReader(file_path)
    meta = reader.metadata
    title = (meta.title or "").strip() if meta and meta.title else None
    author = (meta.author or "").strip() if meta and meta.author else None
    return {
        "title": title or None,
        "authors": [{"name": author, "sort": None}] if author else [],
        "identifiers": {},
    }


def render_pdf_cover(file_path: str) -> Optional[bytes]:
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(file_path)
        try:
            if len(pdf) == 0:
                return None
            bitmap = pdf[0].render(scale=RENDER_SCALE)
            image = bitmap.to_pil()
        finally:
            pdf.close()
        if image.mode != "RGB":
            image = image.convert("RGB")
        buf = io.BytesIO()
        image.save(buf, "JPEG", quality=90)
        return buf.getvalue()
    except Exception:
        return None
