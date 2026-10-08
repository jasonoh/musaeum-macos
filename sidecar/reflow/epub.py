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
