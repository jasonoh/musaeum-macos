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

**The source-page map lives in the file.** Every page's first emitted element
carries `id="pg{n}"`, so a position in the reflow can name the PDF page it came
from (D5) — the anchor a later "open the original at this page" needs, and the
only way to debug a reflow against the page that produced it.

**Deterministic on purpose.** The identifier and `dcterms:modified` derive from
the source file's size and mtime, not from the clock, so two runs over the same
PDF produce the same document — which is what makes "is this artifact stale?"
a comparable question (D9) and what slice 2's byte-stability gate asks for.
"""

from __future__ import annotations

import os
import uuid
import zipfile
from datetime import datetime, timezone
from html import escape
from typing import Optional

from .layout import Block, Document, clean_text

_EPUB_TYPE = {
    1: "chapter",
    2: "section",
    3: "subsection",
}

# The reader owns typography; this is only what an EPUB needs to not look broken
# when nothing else is loaded (a fallback reader, a conversion tool).
STYLESHEET = """body { margin: 0; padding: 0; }
h1, h2, h3 { line-height: 1.25; margin: 1.2em 0 0.6em; }
p { margin: 0 0 0.9em; text-indent: 0; }
figure { margin: 1em 0; text-align: center; }
figure img { max-width: 100%; height: auto; }
"""


def _escape(text: str) -> str:
    return escape(clean_text(text), quote=False)


def _slug(text: str) -> str:
    keep = "".join(c if c.isalnum() or c in " -_" else "" for c in clean_text(text)).strip()
    return "-".join(keep.split())[:60].lower() or "section"


def _partition(doc: Document) -> list[tuple[str, int, list[Block]]]:
    """Split the block stream into sections, in order.

    A section boundary that falls mid-page is honoured by splitting that page's
    blocks at the heading the section is named for (or at its first heading),
    because a chapter title at the bottom of the previous chapter's file reads
    as a defect even though no text is lost.
    """
    flat: list[tuple[int, Block]] = []
    for page in doc.pages:
        for block in page.blocks:
            flat.append((page.index, block))
    if not flat:
        return []

    sections = doc.sections or [("Body", flat[0][0])]
    starts: list[tuple[str, int, int]] = []  # title, page, index into flat
    for title, page in sections:
        index = next((i for i, (p, _) in enumerate(flat) if p >= page), len(flat))
        # Prefer the heading the section is named for, so the title opens the
        # section rather than ending the previous one.
        wanted = _normalise(title)
        for i in range(index, min(index + 40, len(flat))):
            _, block = flat[i]
            if block.kind == "heading" and _normalise(block.text) == wanted:
                index = i
                break
        starts.append((title, page, index))
    starts.sort(key=lambda s: s[2])

    out: list[tuple[str, int, list[Block]]] = []
    for i, (title, page, index) in enumerate(starts):
        end = starts[i + 1][2] if i + 1 < len(starts) else len(flat)
        blocks = [b for _, b in flat[index:end]]
        if blocks:
            out.append((title, page, blocks))
    return out or [("Body", flat[0][0], [b for _, b in flat])]


def _normalise(text: str) -> str:
    return " ".join(text.split()).strip().lower()


def _xhtml(
    title: str,
    blocks: list[Block],
    image_names: dict[int, str],
) -> str:
    parts: list[str] = []
    anchored: set[int] = set()
    for block in blocks:
        anchor = ""
        if block.page not in anchored:
            anchored.add(block.page)
            anchor = f' id="pg{block.page + 1}"'
        if block.kind == "figure" and id(block) in image_names:
            parts.append(
                '<figure{0}><img src="../images/{1}" alt="" width="{2}" height="{3}"/></figure>'.format(
                    anchor, image_names[id(block)], block.image_width, block.image_height
                )
            )
        elif block.kind == "heading":
            level = min(max(block.level or 1, 1), 3)
            parts.append(f'<h{level}{anchor}>{_escape(block.text)}</h{level}>')
        elif block.text:
            parts.append(f'<p{anchor}>{_escape(block.text)}</p>')
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
        f"<section epub:type=\"chapter\">\n{body}\n</section>\n"
        "</body>\n"
        "</html>\n"
    )


def _nav(sections: list[tuple[str, int, list[Block]]]) -> str:
    items = "\n".join(
        f'<li><a href="text/c{i + 1:03d}.xhtml">{_escape(title)}</a></li>'
        for i, (title, _, _) in enumerate(sections)
    )
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">\n'
        "<head><title>Contents</title></head>\n"
        "<body>\n"
        '<nav epub:type="toc" id="toc">\n<h1>Contents</h1>\n<ol>\n'
        f"{items}\n"
        "</ol>\n</nav>\n"
        "</body>\n"
        "</html>\n"
    )


def _ncx(sections: list[tuple[str, int, list[Block]]], uid: str, title: str) -> str:
    points = "\n".join(
        f'<navPoint id="nav{i + 1}" playOrder="{i + 1}">'
        f"<navLabel><text>{_escape(name)}</text></navLabel>"
        f'<content src="text/c{i + 1:03d}.xhtml"/></navPoint>'
        for i, (name, _, _) in enumerate(sections)
    )
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
        f'<head><meta name="dtb:uid" content="{uid}"/></head>\n'
        f"<docTitle><text>{_escape(title)}</text></docTitle>\n"
        f"<navMap>\n{points}\n</navMap>\n"
        "</ncx>\n"
    )


def _opf(
    uid: str,
    title: str,
    source_name: str,
    modified: str,
    sections: list[tuple[str, int, list[Block]]],
    images: list[str],
) -> str:
    items = [
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
        '<item id="css" href="style.css" media-type="text/css"/>',
    ]
    for i, _ in enumerate(sections):
        items.append(
            f'<item id="c{i + 1:03d}" href="text/c{i + 1:03d}.xhtml" '
            'media-type="application/xhtml+xml"/>'
        )
    for name in images:
        items.append(
            f'<item id="{_slug(name)}" href="images/{name}" media-type="image/png"/>'
        )
    spine = "\n".join(
        f'<itemref idref="c{i + 1:03d}"/>' for i in range(len(sections))
    )
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
        'unique-identifier="bookid">\n'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        f'<dc:identifier id="bookid">{uid}</dc:identifier>\n'
        f"<dc:title>{_escape(title)}</dc:title>\n"
        "<dc:language>en</dc:language>\n"
        f"<dc:source>{_escape(source_name)}</dc:source>\n"
        '<meta property="dcterms:modified">' + modified + "</meta>\n"
        '<meta name="generator" content="musaeum pdf reflow (slice 1 spike)"/>\n'
        "</metadata>\n"
        "<manifest>\n" + "\n".join(items) + "\n</manifest>\n"
        f'<spine toc="ncx">\n{spine}\n</spine>\n'
        "</package>\n"
    )


def _container() -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<container version="1.0" '
        'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        "<rootfiles>\n"
        '<rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/>\n'
        "</rootfiles>\n"
        "</container>\n"
    )


def write_epub(doc: Document, out_path: str, title: str) -> dict:
    """Write `doc` as an EPUB 3 at `out_path`. Returns a small report."""
    sections = _partition(doc)
    try:
        stat = os.stat(doc.source)
        stamp = f"{stat.st_size}:{int(stat.st_mtime)}"
        modified = datetime.fromtimestamp(stat.st_mtime, timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
    except OSError:
        stamp, modified = doc.source, "1970-01-01T00:00:00Z"
    uid = f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, 'musaeum-reflow:' + stamp)}"

    # One file per figure, named for its page so a crop can always be traced
    # back to the page it came from.
    image_names: dict[int, str] = {}
    images: list[tuple[str, bytes]] = []
    for _, _, blocks in sections:
        for block in blocks:
            if block.kind == "figure" and block.image:
                name = f"p{block.page + 1:04d}-{len(images)}.png"
                image_names[id(block)] = name
                images.append((name, block.image))

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        zf.writestr(info, "application/epub+zip")
        zf.writestr("META-INF/container.xml", _container())
        zf.writestr("OEBPS/content.opf", _opf(uid, title, os.path.basename(doc.source), modified, sections, [n for n, _ in images]))
        zf.writestr("OEBPS/nav.xhtml", _nav(sections))
        zf.writestr("OEBPS/toc.ncx", _ncx(sections, uid, title))
        zf.writestr("OEBPS/style.css", STYLESHEET)
        for i, (name, _, blocks) in enumerate(sections):
            zf.writestr(f"OEBPS/text/c{i + 1:03d}.xhtml", _xhtml(name, blocks, image_names))
        for name, data in images:
            zf.writestr(f"OEBPS/images/{name}", data)

    words = sum(
        len(b.text.split())
        for _, _, blocks in sections
        for b in blocks
        if b.kind in ("para", "heading")
    )
    return {
        "sections": len(sections),
        "images": len(images),
        "words": words,
        "bytes": os.path.getsize(out_path),
        "uid": uid,
    }
