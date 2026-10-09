"""EPUB → AZW3 (KF8-only), in the shape measured in spec Annex A.

Record order is the Calibre shape the device has received: record 0, the
text, a pad record, the fragment / skeleton / guide / NCX indexes with their
CNCX records, the images, then FDST, FLIS, FCIS and EOF. Text is stored
uncompressed with no trailing entries and cut at exactly 4,096 bytes — T2's
form, the one the Oasis opened (spec, *Device experiments*).
"""

import io
import os
import random
import re
import struct
import uuid as uuidlib
from dataclasses import dataclass, field

from PIL import Image

from .epub import Epub, TocEntry, read_epub
from .exth import build_exth
from .identity import read_identity
from .indexes import IndexOverflow, NavPoint, Piece, fragment_index, guide_index, ncx_index, skeleton_index
from .markup import Aids, Part, build_part, css_flow, fixed_base32
from .palmdb import write_palmdb

TEXT_RECORD_BYTES = 4096
MOBI_HEADER_BYTES = 264
MAX_TITLE_BYTES = 1023  # the app's reader refuses 1,024 and over (identity.MAX_TITLE_BYTES)
MAX_TOC_TITLE_CHARS = 255  # a publisher's runaway label must not take the book down
MAX_IMAGE_BYTES = 131_072  # every image record measured is under 128 KiB (largest 130,912)
KEPT_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif"}
NONE = 0xFFFFFFFF
FLIS = b"FLIS" + struct.pack(">IHHIIHHIII", 8, 65, 0, 0, NONE, 1, 3, 3, 1, NONE)
EOF_RECORD = b"\xe9\x8e\r\n"


@dataclass
class Conversion:
    data: bytes
    uuid: str
    title: str
    cover: bytes | None
    warnings: list[str] = field(default_factory=list)


class Resources:
    """Stylesheet flows and image records, numbered in order of first use."""

    def __init__(self, epub: Epub) -> None:
        self.epub = epub
        self.flows: list[bytes] = []
        self.flow_of: dict[str, int] = {}
        self.images: list[bytes] = []
        self.image_of: dict[str, tuple[int, str]] = {}
        self.warnings: list[str] = []

    def stylesheet(self, path: str) -> int | None:
        if path not in self.flow_of:
            if path not in self.epub.files:
                return None
            flow, warnings = css_flow(path, self.epub.files[path])
            self.flows.append(flow)
            self.warnings += warnings
            self.flow_of[path] = len(self.flows)
        return self.flow_of[path]

    def image(self, path: str) -> tuple[int, str] | None:
        path = path.split("#")[0]
        if path not in self.image_of:
            if path not in self.epub.files:
                return None
            data, mime = fit_image(self.epub.files[path], self.epub.media_types.get(path, ""))
            if mime is None:
                self.warnings.append(f"{path}: not a readable image")
                return None
            self.images.append(data)
            self.image_of[path] = (len(self.images), mime)
        return self.image_of[path]


def fit_image(data: bytes, media_type: str) -> tuple[bytes, str | None]:
    """The image as a record the device takes: JPEG/PNG/GIF under 128 KiB, else a smaller JPEG."""
    if media_type in KEPT_IMAGE_TYPES and len(data) <= MAX_IMAGE_BYTES:
        return data, media_type
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception:
        return data, None
    if image.mode not in ("RGB", "L"):
        background = Image.new("RGB", image.size, "white")
        background.paste(image.convert("RGBA"), mask=image.convert("RGBA").getchannel("A"))
        image = background
    while True:
        out = io.BytesIO()
        image.save(out, "JPEG", quality=85)
        if out.tell() <= MAX_IMAGE_BYTES or min(image.size) < 64:
            return out.getvalue(), "image/jpeg"
        image = image.resize((max(1, int(image.width * 0.8)), max(1, int(image.height * 0.8))))


def text_records(text: bytes) -> list[bytes]:
    if any(b >= 0x80 for b in text):
        raise ValueError("the text must be ASCII so no record boundary splits a character")
    return [text[at : at + TEXT_RECORD_BYTES] for at in range(0, len(text), TEXT_RECORD_BYTES)] or [b""]


def u32(value: int) -> bytes:
    return struct.pack(">I", value)


def _truncate(text: str, limit: int) -> str:
    raw = text.encode("utf-8")[:limit]
    return raw.decode("utf-8", "ignore")


def record_zero(*, text_length: int, text_count: int, title: bytes, exth: bytes, at: dict[str, int], locale: int) -> bytes:
    rec0 = bytearray(16 + MOBI_HEADER_BYTES)
    struct.pack_into(">HHIHHHH", rec0, 0, 1, 0, text_length, text_count, TEXT_RECORD_BYTES, 0, 0)
    rec0[0x10:0x14] = b"MOBI"
    struct.pack_into(">IIIII", rec0, 0x14, MOBI_HEADER_BYTES, 2, 65001, random.getrandbits(32), 8)
    for word in range(0x28, 0x50, 4):
        struct.pack_into(">I", rec0, word, NONE)
    title_at = len(rec0) + len(exth)
    struct.pack_into(">IIIIIII", rec0, 0x50, at["first_non_book"], title_at, len(title), locale, 0, 0, 8)
    struct.pack_into(">I", rec0, 0x6C, at["first_image"])
    struct.pack_into(">I", rec0, 0x80, 0x50)  # EXTH present
    struct.pack_into(">II", rec0, 0xA4, NONE, NONE)
    struct.pack_into(">IIIIII", rec0, 0xC0, at["fdst"], at["fdst_count"], at["fcis"], 1, at["flis"], 1)
    struct.pack_into(">IIII", rec0, 0xE0, NONE, 0, NONE, NONE)
    struct.pack_into(">I", rec0, 0xF0, 0)  # no trailing entries (T2)
    struct.pack_into(">IIIII", rec0, 0xF4, at["ncx"], at["fragment"], at["skeleton"], NONE, at["guide"])
    struct.pack_into(">IIII", rec0, 0x108, NONE, 0, NONE, 0)
    body = bytes(rec0) + exth + title
    return body + b"\0" * (-len(body) % 4) + b"\0" * 4


def _nav(entries: list[TocEntry], locate) -> list[NavPoint]:
    points = []
    for entry in entries:
        found = locate(entry.href)
        children = _nav(entry.children, locate)
        if found is None:
            points.extend(children)
        else:
            fid, off, pos = found
            points.append(NavPoint((entry.title or "Untitled")[:MAX_TOC_TITLE_CHARS], fid, off, pos, children))
    return points


def _entries(points: list[NavPoint]) -> int:
    return sum(1 + _entries(p.children) for p in points)


def _depth(points: list[NavPoint]) -> int:
    return 1 + max((_depth(p.children) for p in points if p.children), default=0)


def _without_deepest(points: list[NavPoint], depth: int) -> list[NavPoint]:
    """The tree with every node at `depth` (0-based) removed."""
    if depth == 0:
        return []
    return [
        NavPoint(p.title, p.fid, p.off, p.pos, _without_deepest(p.children, depth - 1) if p.children else [])
        for p in points
    ]


def _fit_ncx(nav: list[NavPoint], flow_length: int, warnings: list[str]) -> list[bytes]:
    """The NCX records, shrinking the table of contents until its index fits one record.

    Every file measured has one CNCX record and one data record per index, so the
    spike does not write more. A book that does not fit loses its deepest level,
    then its trailing entries, with a warning: it converts, and it is readable.
    """
    total = _entries(nav)
    while True:
        try:
            records = ncx_index(nav, flow_length)
            break
        except IndexOverflow:
            depth = _depth(nav)
            if depth > 1:
                nav = _without_deepest(nav, depth - 1)
                warnings.append(f"table of contents does not fit the index: dropped its deepest level (level {depth})")
            elif len(nav) > 1:
                nav = nav[: max(1, len(nav) * 9 // 10)]
            else:
                raise  # one entry that cannot fit: nothing left to trim
    kept = _entries(nav)
    if kept < total:
        warnings.append(f"table of contents trimmed from {total} to {kept} entries to fit the index")
    return records


def build_azw3(epub_path: str) -> Conversion:
    epub = read_epub(epub_path)
    meta = epub.metadata
    resources = Resources(epub)
    aids = Aids()
    warnings = list(epub.warnings)
    parts: list[Part] = []
    for path in epub.spine:
        part = build_part(path, epub.files[path], aids, resources)
        parts.append(part)
        warnings += part.warnings
    cover = resources.image(epub.cover)[0] - 1 if epub.cover and resources.image(epub.cover) else None

    pieces, starts, fid_of = [], [], {}
    at = 0
    for fid, part in enumerate(parts):
        starts.append(at)
        fid_of[part.path] = fid
        pieces.append(Piece(at, len(part.skeleton), at + part.insert_offset, len(part.fragment), part.selector))
        at += len(part.skeleton) + len(part.fragment)

    def locate(href: str) -> tuple[int, int, int] | None:
        path, _, anchor = href.partition("#")
        if path not in fid_of:
            return None
        fid = fid_of[path]
        off = parts[fid].anchors.get(anchor, 0) if anchor else 0
        if anchor and anchor not in parts[fid].anchors:
            warnings.append(f"{href}: no such anchor; pointing at the start of the file")
        return fid, off, pieces[fid].insert_at + off

    flow0 = bytearray()
    for part in parts:
        fragment = bytearray(part.fragment)
        for link in part.links:
            found = locate(link.target)
            fid, off = (found[0], found[1]) if found else (fid_of[part.path], 0)
            if found is None:
                warnings.append(f"{part.path}: link to {link.target} is outside the book; pointing at its own start")
            fragment[link.at : link.at + 34] = f"kindle:pos:fid:{fixed_base32(fid, 4)}:off:{fixed_base32(off, 10)}".encode()
        flow0 += part.skeleton + fragment
    warnings += resources.warnings
    flows = [bytes(flow0)] + resources.flows
    text = b"".join(flows)
    sections, edge = [], 0
    for flow in flows:
        sections.append((edge, edge + len(flow)))
        edge += len(flow)

    title = _truncate(meta.get("title") or os.path.splitext(os.path.basename(epub_path))[0], MAX_TITLE_BYTES)
    nav = _nav(epub.toc, locate) or [NavPoint(title, 0, 0, pieces[0].insert_at)]
    guide = []
    for kind, ref_title, href in epub.guide:
        found = locate(href)
        if found and kind not in [g[0] for g in guide]:
            guide.append((kind, ref_title, found[0], found[1]))
    if "text" not in [g[0] for g in guide]:
        guide.append(("text", "Beginning", 0, 0))

    texts = text_records(text)
    n = len(texts)
    pad = b"\0" * (4 - len(text) % 4)
    fragment_records = fragment_index(pieces)
    skeleton_records = skeleton_index(pieces)
    guide_records = guide_index(guide)
    ncx_records = _fit_ncx(nav, len(flow0), warnings)
    first_non_book = n + 2
    at = {"first_non_book": first_non_book, "fragment": first_non_book}
    at["skeleton"] = at["fragment"] + len(fragment_records)
    at["guide"] = at["skeleton"] + len(skeleton_records)
    at["ncx"] = at["guide"] + len(guide_records)
    first_resource = at["ncx"] + len(ncx_records)
    at["first_image"] = first_resource if resources.images else NONE
    at["fdst"] = first_resource + len(resources.images)
    at["fdst_count"] = len(flows)
    at["flis"], at["fcis"] = at["fdst"] + 1, at["fdst"] + 2

    book_uuid = str(uuidlib.uuid4())
    language = meta.get("language") or "en"
    exth_records = [(100, a["name"].encode()) for a in meta.get("authors") or []]
    for kind, key in ((101, "publisher"), (103, "description"), (106, "published_date")):
        if meta.get(key):
            exth_records.append((kind, meta[key].encode()))
    if (meta.get("identifiers") or {}).get("isbn_13"):
        exth_records.append((104, meta["identifiers"]["isbn_13"].encode()))
    exth_records += [(108, b"Musaeum"), (113, book_uuid.encode()), (125, u32(len(resources.images))), (131, u32(0))]
    if cover is not None:
        exth_records += [(201, u32(cover)), (203, u32(0))]
    exth_records += [(501, b"EBOK"), (503, title.encode()), (524, language.encode())]

    rec0 = record_zero(
        text_length=len(text),
        text_count=n,
        title=title.encode(),
        exth=build_exth(exth_records),
        at=at,
        locale=9 if language.lower().startswith("en") else 0,
    )
    fdst = b"FDST" + struct.pack(">II", 12, len(flows)) + b"".join(struct.pack(">II", a, b) for a, b in sections)
    fcis = b"FCIS" + struct.pack(">IIIIIIIIIIHHI", 20, 16, 2, 0, len(text), 0, 40, 0, 40, 8, 1, 1, 0)
    records = (
        [rec0] + texts + [pad] + fragment_records + skeleton_records + guide_records + ncx_records
        + resources.images + [fdst, FLIS, fcis, EOF_RECORD]
    )
    label = re.sub(r"[^A-Za-z0-9]+", "_", title).strip("_")[:31] or "book"
    data = write_palmdb(label, records)

    # D3: the file must read back, through the app's own offsets, as what was written.
    identity = read_identity(data)
    authors = [a["name"] for a in meta.get("authors") or []]
    if identity is None or (identity.title, identity.uuid, identity.cdetype) != (title, book_uuid, "EBOK") or identity.author != (authors[-1] if authors else None):
        raise ValueError(f"the written file does not read back as written: {identity}")
    cover_bytes = resources.images[cover] if cover is not None else None
    return Conversion(data, book_uuid, title, cover_bytes, warnings)


def write_azw3(epub_path: str, out_path: str) -> Conversion:
    """Convert, then write beside the target and rename into place (spec D5)."""
    conversion = build_azw3(epub_path)
    temp = out_path + ".tmp"
    try:
        with open(temp, "wb") as f:
            f.write(conversion.data)
        os.replace(temp, out_path)
    except BaseException:
        if os.path.exists(temp):
            os.remove(temp)
        raise
    return conversion
