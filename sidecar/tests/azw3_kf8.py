"""Test-side KF8 reader and EPUB builder for the AZW3 writer's tests.

The reader is written from the MobileRead wiki's generic INDX/TAGX/varint
rules and Annex A's literal offsets — never from the writer's constants — so
a writer that drifts from the measured format fails here.
"""

import struct
import zipfile
from dataclasses import dataclass
from pathlib import Path

from conversion.azw3.exth import parse_exth
from conversion.azw3.palmdb import read_records


def u32(data: bytes, at: int) -> int:
    return struct.unpack_from(">I", data, at)[0]


def read_varint(data: bytes, at: int) -> tuple[int, int]:
    value = 0
    while True:
        byte = data[at]
        at += 1
        value = (value << 7) | (byte & 0x7F)
        if byte & 0x80:
            return value, at


def cncx_strings(record: bytes) -> dict[int, str]:
    strings, at = {}, 0
    while at < len(record) and record[at] != 0:
        start = at
        length, at = read_varint(record, at)
        strings[start] = record[at : at + length].decode("utf-8")
        at += length
    return strings


@dataclass
class Index:
    tags: list[tuple[int, int, int, int]]
    entries: list[tuple[bytes, dict[int, list[int]]]]
    cncx: dict[int, str]
    header: bytes
    data: bytes


def read_index(records: list[bytes], first: int) -> Index:
    """Decode an INDX header record, its data record(s) and CNCX records."""
    head = records[first]
    assert head[:4] == b"INDX"
    header_length = u32(head, 4)
    assert head[header_length : header_length + 4] == b"TAGX"
    tagx_length, control_bytes = struct.unpack_from(">II", head, header_length + 4)
    assert control_bytes == 1
    tags = [tuple(head[a : a + 4]) for a in range(header_length + 12, header_length + tagx_length, 4)]
    data_records, cncx_records = u32(head, 0x18), u32(head, 0x34)
    entries = []
    for r in range(first + 1, first + 1 + data_records):
        rec = records[r]
        idxt, count = u32(rec, 0x14), u32(rec, 0x18)
        assert rec[idxt : idxt + 4] == b"IDXT"
        for i in range(count):
            at = struct.unpack_from(">H", rec, idxt + 4 + 2 * i)[0]
            label = rec[at + 1 : at + 1 + rec[at]]
            at += 1 + rec[at]
            control = rec[at]
            at += 1
            values: dict[int, list[int]] = {}
            for tag, per_group, mask, end in tags:
                if end:
                    continue
                groups = (control & mask) // (mask & -mask)
                for _ in range(groups * per_group):
                    value, at = read_varint(rec, at)
                    values.setdefault(tag, []).append(value)
            entries.append((label, values))
    cncx: dict[int, str] = {}
    for k in range(cncx_records):
        for offset, text in cncx_strings(records[first + 1 + data_records + k]).items():
            cncx[(k << 16) | offset] = text
    return Index(tags, entries, cncx, head, records[first + 1])


@dataclass
class Kf8:
    records: list[bytes]
    rec0: bytes
    exth: dict[int, list[bytes]]
    text: bytes

    def word(self, at: int) -> int:
        return u32(self.rec0, at)

    def index(self, word_at: int) -> Index:
        return read_index(self.records, self.word(word_at))

    def flows(self) -> list[bytes]:
        fdst = self.records[self.word(0xC0)]
        assert fdst[:4] == b"FDST"
        count = u32(fdst, 8)
        return [self.text[u32(fdst, 12 + 8 * i) : u32(fdst, 16 + 8 * i)] for i in range(count)]


def read_kf8(data: bytes) -> Kf8:
    records = read_records(data)
    rec0 = records[0]
    compression, _, text_length, text_records = struct.unpack_from(">HHIH", rec0, 0)
    assert compression == 1, "the writer stores text uncompressed (Annex A, T2)"
    exth: dict[int, list[bytes]] = {}
    for kind, value in parse_exth(rec0[0x10 + u32(rec0, 0x14) :]):
        exth.setdefault(kind, []).append(value)
    text = b"".join(records[1 : 1 + text_records])
    assert len(text) == text_length
    return Kf8(records, rec0, exth, text)


# --- a minimal EPUB 2 builder: just enough package to exercise the writer

CONTAINER = (
    '<?xml version="1.0"?><container version="1.0" '
    'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
    '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
    "</rootfiles></container>"
)


def xhtml(body: str, title: str = "t", head: str = "") -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
        f"<head><title>{title}</title>{head}</head><body>{body}</body></html>"
    )


def build_epub(
    path: Path,
    chapters: list[tuple[str, str]],
    toc: list[tuple[str, str, list]] | None = None,
    css: dict[str, str] | None = None,
    images: dict[str, bytes] | None = None,
    cover: str | None = None,
    guide: list[tuple[str, str, str]] | None = None,
    title: str = "Test Book",
    authors: tuple[str, ...] = ("Ann Author",),
    language: str = "en",
) -> Path:
    """chapters: (file name, full XHTML). toc: (title, href, children) as an NCX."""
    css, images = css or {}, images or {}
    toc = toc if toc is not None else [(name, name, []) for name, _ in chapters]
    manifest = [f'<item id="c{i}" href="{n}" media-type="application/xhtml+xml"/>' for i, (n, _) in enumerate(chapters)]
    manifest += [f'<item id="s{i}" href="{n}" media-type="text/css"/>' for i, n in enumerate(css)]
    for i, name in enumerate(images):
        kind = "image/png" if name.endswith(".png") else "image/jpeg"
        manifest.append(f'<item id="i{i}" href="{name}" media-type="{kind}"/>')
    manifest.append('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
    cover_meta = ""
    if cover:
        cover_meta = f'<meta name="cover" content="i{list(images).index(cover)}"/>'
    creators = "".join(f'<dc:creator opf:role="aut">{a}</dc:creator>' for a in authors)
    guide_xml = ""
    if guide:
        refs = "".join(f'<reference type="{t}" title="{n}" href="{h}"/>' for t, n, h in guide)
        guide_xml = f"<guide>{refs}</guide>"
    spine = "".join(f'<itemref idref="c{i}"/>' for i in range(len(chapters)))
    opf = (
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">'
        f'<dc:title>{title}</dc:title>{creators}<dc:language>{language}</dc:language>'
        f'<dc:identifier id="id">urn:uuid:test</dc:identifier>{cover_meta}</metadata>'
        f'<manifest>{"".join(manifest)}</manifest>'
        f'<spine toc="ncx">{spine}</spine>'
        f"{guide_xml}</package>"
    )
    counter = iter(range(1, 10_000))

    def points(nodes: list) -> str:
        return "".join(
            f'<navPoint id="n{next(counter)}"><navLabel><text>{t}</text></navLabel>'
            f'<content src="{h}"/>{points(kids)}</navPoint>'
            for t, h, kids in nodes
        )

    ncx = (
        '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
        f"<navMap>{points(toc)}</navMap></ncx>"
    )
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/toc.ncx", ncx)
        for name, doc in chapters:
            z.writestr(f"OEBPS/{name}", doc)
        for name, sheet in css.items():
            z.writestr(f"OEBPS/{name}", sheet)
        for name, data in images.items():
            z.writestr(f"OEBPS/{name}", data)
    return path
