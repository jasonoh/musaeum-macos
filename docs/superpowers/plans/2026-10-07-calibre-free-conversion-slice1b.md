# Calibre-free conversion — slice 1b (the spike KF8 writer and the device gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert an EPUB into an AZW3 the owner's Kindle Oasis opens, with a working cover, table of contents, internal links and reading position, using only the in-house writer, then run the spec's D6 gate on three real books.

**Architecture:** Four new modules in `sidecar/conversion/azw3/`, beside slice 1a's `palmdb`/`exth`/`identity`/`probe`: `indexes` (varints, CNCX, INDX and the four KF8 index tables), `epub` (spine, members, cover, TOC, guide), `markup` (one spine file → skeleton + fragment, in ASCII) and `writer` (assembly, the D3 read-back check, the D5 atomic write). A CLI, `scripts/azw3-spike.py`, drives one conversion and writes the device's cover-cache entry. Nothing is wired into `convert_format`; slice 2 owns that.

**Tech Stack:** Python 3.12, `lxml` 6.1.1, `defusedxml` 0.7.1, `Pillow` 12.3.0 (all already in `sidecar/requirements.txt`), pytest 9.1.1.

**Spec:** `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md`. Read **Annex A** (every structure this plan writes is measured there) and its **Device experiments** section (why the text is uncompressed with no trailing entries) before Task 1.

## Global Constraints

- **The text form is T2's, and only T2's:** compression **1**, extra-data flags (+0xf0) **0**, text records of **exactly 4,096 bytes** (the last may be shorter). T1 showed that PalmDOC text with no trailing entries **crashes the Oasis**. Never write compression 2 with flags 0.
- **The text is ASCII.** Every non-ASCII character in markup becomes a numeric character reference, and in CSS a `\XXXX ` escape. That is how a 4,096-byte cut never splits a character. It is the form measured in *Lonely Planet Rome* (kindlegen): 6,568 `&#x…;` references.
- **Record order and header words are Annex A's Calibre shape:** record 0, text, a pad record, the fragment / skeleton / guide / NCX indexes with their CNCX records, images, then FDST, FLIS, FCIS (the 52-byte measured form, **not** the wiki's) and EOF.
- **Provenance rule (spec §Provenance):** allowed sources are the MobileRead wiki, the device-presence spec appendix, `electron/main/services/mobi-header.ts`, and **the bytes of real files**. **Do not read** Calibre's or KindleUnpack's source, or any other GPL implementation. Calibre may be **run** as an oracle once (Task 5), never imported or depended on by `pytest`.
- **A structure with no Annex B row does not ship** (spec §Provenance, rule 3). Task 5 writes Annex B.
- **No new dependency.** `sidecar/requirements.txt` does not change.
- `convert_format`, `sidecar/main.py`, `sidecar/conversion/converter.py` and everything under `electron/` and `src/` are **out of scope**.
- **No `any` types; nothing reads `formats[0]`; Markdown prose is not hard-wrapped** (`CLAUDE.md`).
- **Two consecutive failed repairs on the same test → stop and hand back** (`CLAUDE.md` §Escalate).
- **Commits** end with the `Co-Authored-By:` line the session's attribution instruction gives. Run `/verify` immediately before any commit that is not docs-only or tests-only (repo rule).
- **Test helpers import as `tests.azw3_kf8`**, because `sidecar/tests/` is a package. `conftest.py` puts `sidecar/` on the path.

## Review Focus

These are inputs the spec implies but its slices do not test, most likely to bite first. Each has a pinning test in the task that owns the code.

1. **A book whose table of contents is missing, or points outside the spine, or at an anchor that does not exist.** It must still convert: a one-entry TOC, and fallbacks with a warning, never a crash. Pinned in Task 4 (`test_a_book_without_a_table_of_contents_gets_one_entry`, `test_toc_entries_and_links_outside_the_book_fall_back_with_warnings`).
2. **A title of 1,024 bytes or more.** The app's reader treats it as unreadable, so the writer cuts it at a character boundary below that. Pinned in Task 4 (`test_a_title_of_1024_bytes_or_more_is_cut_so_the_app_can_still_read_it`).
3. **Images over 128 KiB, or in a type the device may not take (WebP, SVG).** Every measured image record is under 131,072 B. Large or foreign images become smaller JPEGs, and SVG is dropped with a warning (spec D4). Pinned in Task 4 (`test_images_over_128_kib_or_of_other_types_become_smaller_jpegs`) and Task 3 (`test_images_are_embedded_by_number_and_missing_ones_are_dropped_with_a_warning`).
4. **Publisher XHTML with HTML named entities (`&nbsp;`) and XHTML self-closing tags (`<a id="x"/>`).** An HTML parser would nest everything after a self-closing tag inside it, and an XML parser rejects `&nbsp;`. Pinned in Task 3 (`test_the_markup_is_ascii_with_numeric_references`, `test_xhtml_self_closing_elements_stay_empty`).
5. **A table of contents of more than 255 entries.** The measured files never exceed two hex digits per NCX label. A third digit must not break label order, because `build_index` refuses unsorted labels and the whole conversion would fail. Pinned in Task 1 (`test_a_table_of_contents_over_255_entries_keeps_its_labels_in_order`).

---

## How this plan's code was checked before it was written

Every module below was built and run in a scratch copy of `sidecar/` (`/tmp/azw3-plan`, never committed) before being pasted here.

- **Byte-identical to real files:** `build_index` rebuilds the skeleton, fragment, NCX and guide index records of four real files (*Red Rising*, *American War*, *The Transparency Society*, *Patent, Copyright & Trademark*) **byte for byte**, header and data records, 16 of 16. `ncx_index` rebuilds *Patent*'s three-level TOC byte for byte from the tree alone. Task 1's golden test pins one of these, *The Transparency Society*'s guide index.
- **The 60-book sample:** the writer converts all of 60 randomly drawn EPUB-only library books without an error, from a 75 KB novella to a 238 MB cookbook. The slowest took 24.0 s, under the spec's 30-second target.
- **The oracle:** the three gate books (Task 5) round-tripped through `ebook-convert` back to EPUB with **every spine word intact**: 84,308, 36,823 and 88,798 words.

The suites below pass on that scratch copy: 232 tests, the 187 already on `main` plus 45.

## File Structure

| File | Responsibility |
| --- | --- |
| `sidecar/conversion/azw3/indexes.py` | Forward varints, CNCX records, INDX header/data records, and the skeleton / fragment / NCX / guide tables. |
| `sidecar/conversion/azw3/epub.py` | `read_epub` — spine, members, media types, cover, TOC (EPUB 3 nav, else NCX), guide, metadata (reusing `extractors/epub_metadata.py`). |
| `sidecar/conversion/azw3/markup.py` | `build_part` — one spine file → skeleton + fragment in ASCII, with `aid`s, flow/embed links and fixed-width link placeholders; `css_flow`. |
| `sidecar/conversion/azw3/writer.py` | `build_azw3` / `write_azw3` — records, record 0, EXTH, images, FDST/FLIS/FCIS/EOF, the D3 read-back, the D5 atomic write. |
| `scripts/azw3-spike.py` | CLI for the gate: one EPUB → `.azw3` + the device's cover-cache JPEG. |
| `sidecar/tests/azw3_kf8.py` | Test-only: an independent KF8 reader (wiki rules, literal offsets) and a minimal EPUB builder. |
| `sidecar/tests/test_azw3_indexes.py`, `test_azw3_epub.py`, `test_azw3_markup.py`, `test_azw3_writer.py` | One suite per module. |
| `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` | Gains **Annex B** (Task 5): slice 1b's provenance log and the D6 device results. |

---

### Task 1: Index tables

**Files:**
- Create: `sidecar/conversion/azw3/indexes.py`
- Create: `sidecar/tests/azw3_kf8.py` (test helper, used by every later task)
- Test: `sidecar/tests/test_azw3_indexes.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `forward_varint(value: int) -> bytes`, `pad4(data: bytes) -> bytes`, `class Cncx` (`add(text) -> int`, `record() -> bytes`)
  - `encode_entry(label: bytes, values: dict[int, list[int]], table: TagTable) -> bytes`
  - `build_index(table, entries: list[tuple[bytes, dict[int, list[int]]]], cncx_records: int) -> list[bytes]`, returning `[header_record, data_record]`
  - `@dataclass Piece(start, skeleton_length, insert_at, fragment_length, selector)`, `skeleton_index(pieces) -> list[bytes]` (2 records), `fragment_index(pieces) -> list[bytes]` (3 records, the last its CNCX)
  - `@dataclass NavPoint(title, fid, off, pos, children)`, `ncx_index(roots, flow_length) -> list[bytes]` (3 records)
  - `guide_index(references: list[tuple[str, str, int, int]]) -> list[bytes]` (3 records)
  - Constants `SKELETON_TAGS`, `FRAGMENT_TAGS`, `NCX_TAGS`, `GUIDE_TAGS`, `MAX_RECORD_BYTES = 0x10000`
  - Test helper `tests/azw3_kf8.py`: `read_varint`, `read_index(records, first) -> Index`, `read_kf8(data) -> Kf8` (with `.word(at)`, `.index(word_at)`, `.flows()`, `.exth`, `.text`, `.records`, `.rec0`), `build_epub(...)`, `xhtml(body, title, head)`, `CONTAINER`.

**Annex B rows this task's code needs (Task 5 writes them):** forward varint (wiki: *Variable-width integers*), CNCX (Annex A *CNCX record*), INDX header and data records (Annex A *INDX header record* / *INDX data record*, now rebuilt byte for byte), the four TAGX tables and their entry layouts (Annex A *Skeleton / Fragment / NCX / Guide index*), and the NCX label width beyond two digits (**not measured**; the spike widens all labels alike so they stay sorted).

- [ ] **Step 1: Write the test helper.** Create `sidecar/tests/azw3_kf8.py`:

```python
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
```

- [ ] **Step 2: Write the failing tests.** Create `sidecar/tests/test_azw3_indexes.py`:

```python
import struct

import pytest

from tests.azw3_kf8 import read_index, read_varint
from conversion.azw3.indexes import (
    FRAGMENT_TAGS,
    GUIDE_TAGS,
    NCX_TAGS,
    SKELETON_TAGS,
    Cncx,
    NavPoint,
    Piece,
    build_index,
    encode_entry,
    forward_varint,
    fragment_index,
    guide_index,
    ncx_index,
    skeleton_index,
)

# The guide index of *The Transparency Society*'s cached azw3 (Calibre 5.31.1),
# a file the owner's Kindle holds and opens — header, data and CNCX records.
REAL_GUIDE = [
    bytes.fromhex(
        "494e4458000000c0000000000000000000000002000000e0000000010000fde9"
        "ffffffff00000002000000000000000000000000000000010000000000000000"
        "0000000000000000000000000000000000000000000000000000000000000000"
        "0000000000000000000000000000000000000000000000000000000000000000"
        "0000000000000000000000000000000000000000000000000000000000000000"
        "0000000000000000000000000000000000000000000000c00000000000000000"
        "54414758000000180000000101010100060202000000000103746f6300020000"
        "4944585400d80000"
    ),
    bytes.fromhex(
        "494e4458000000c0000000000000000100000000000000d400000002ffffffff"
        "ffffffff00000000000000000000000000000000000000000000000000000000"
        "0000000000000000000000000000000000000000000000000000000000000000"
        "0000000000000000000000000000000000000000000000000000000000000000"
        "0000000000000000000000000000000000000000000000000000000000000000"
        "0000000000000000000000000000000000000000000000000000000000000000"
        "04746578740380818003746f63038682800000004944585400c000c9"
    ),
    bytes.fromhex("855469746c6588436f6e74656e747300"),
]


def test_forward_varint_matches_the_wikis_example_and_round_trips():
    assert forward_varint(0x11111) == bytes([0x04, 0x22, 0x91])
    for value in (0, 1, 127, 128, 16_383, 16_384, 2**28 + 5):
        assert read_varint(forward_varint(value), 0) == (value, len(forward_varint(value)))


def test_a_negative_varint_is_refused():
    with pytest.raises(ValueError):
        forward_varint(-1)


def test_cncx_strings_are_length_prefixed_and_addressed_by_offset():
    cncx = Cncx()
    assert cncx.add("Title") == 0
    assert cncx.add("Contents") == 6
    assert cncx.record() == bytes.fromhex("855469746c6588436f6e74656e747300")


def test_rebuilding_a_real_guide_index_reproduces_its_bytes():
    assert guide_index([("toc", "Contents", 2, 0), ("text", "Title", 1, 0)]) == REAL_GUIDE


def test_control_bytes_count_groups_under_each_mask():
    # skeleton: two groups under mask 3 (0x02) and two under mask 12 (0x08)
    entry = encode_entry(b"SKEL0000000000", {1: [1, 1], 6: [0, 431, 0, 431]}, SKELETON_TAGS)
    assert entry[0] == 14 and entry[15] == 0x0A
    # a child NCX entry with no children: tags 1, 2, 3, 4, 21 and 6 present
    entry = encode_entry(b"0B", {1: [9], 2: [9], 3: [0], 4: [1], 21: [5], 6: [7, 0]}, NCX_TAGS)
    assert entry[3] == 0x9F


def test_a_value_count_the_mask_cannot_hold_is_refused():
    with pytest.raises(ValueError):
        encode_entry(b"x", {1: [1, 1, 1]}, SKELETON_TAGS)  # 3 groups fill mask 3: means "count follows"
    with pytest.raises(ValueError):
        encode_entry(b"x", {2: [1, 2]}, FRAGMENT_TAGS)  # 2 groups under a one-bit mask
    with pytest.raises(ValueError):
        encode_entry(b"x", {6: [1]}, GUIDE_TAGS)  # half a group


def test_an_index_header_and_data_record_read_back():
    entries = [(b"a", {1: [3], 6: [1, 2]}), (b"b", {1: [300], 6: [0, 70_000]})]
    head, data = build_index(GUIDE_TAGS, entries, cncx_records=1)
    assert len(head) % 4 == 0 and len(data) % 4 == 0
    assert struct.unpack_from(">I", head, 0x34)[0] == 1
    index = read_index([head, data, b""], 0)
    assert index.entries == entries


def test_labels_out_of_order_or_no_entries_are_refused():
    with pytest.raises(ValueError):
        build_index(GUIDE_TAGS, [(b"b", {1: [0]}), (b"a", {1: [0]})], 0)
    with pytest.raises(ValueError):
        build_index(GUIDE_TAGS, [], 0)


def test_an_index_too_big_for_one_record_is_refused():
    entries = [(b"%05d" % i, {1: [2**27], 6: [2**27, 2**27]}) for i in range(7_000)]
    with pytest.raises(ValueError):
        build_index(GUIDE_TAGS, entries, 0)


def test_skeleton_and_fragment_indexes_describe_one_fragment_per_file():
    pieces = [Piece(0, 412, 396, 206, "P-//*[@aid='0']"), Piece(618, 415, 1017, 1584, "P-//*[@aid='7']")]
    skeleton = read_index(skeleton_index(pieces), 0)
    assert skeleton.entries == [
        (b"SKEL0000000000", {1: [1, 1], 6: [0, 412, 0, 412]}),
        (b"SKEL0000000001", {1: [1, 1], 6: [618, 415, 618, 415]}),
    ]
    fragment = read_index(fragment_index(pieces), 0)
    assert [label for label, _ in fragment.entries] == [b"0000000396", b"0000001017"]
    selectors = [fragment.cncx[values[2][0]] for _, values in fragment.entries]
    assert selectors == ["P-//*[@aid='0']", "P-//*[@aid='7']"]
    assert [values[3] + values[4] + values[6] for _, values in fragment.entries] == [[0, 0, 0, 206], [1, 1, 0, 1584]]


def test_the_ncx_is_breadth_first_with_parents_children_and_lengths():
    child_a = NavPoint("A.1", 0, 40, 140)
    child_b = NavPoint("A.2", 0, 90, 190)
    roots = [NavPoint("A", 0, 0, 100, [child_a, child_b]), NavPoint("B", 1, 0, 500)]
    index = read_index(ncx_index(roots, flow_length=800), 0)
    titles = [index.cncx[v[3][0]] for _, v in index.entries]
    assert titles == ["A", "B", "A.1", "A.2"]
    assert [label for label, _ in index.entries] == [b"00", b"01", b"02", b"03"]
    a, b, a1, a2 = (v for _, v in index.entries)
    assert (a[22], a[23], a[2]) == ([2], [3], [400])  # spans its children, up to B
    assert (b[2], b[4], 21 in b, 22 in b) == ([300], [0], False, False)  # runs to the flow's end
    assert (a1[21], a1[4], a1[2], a1[6]) == ([0], [1], [50], [0, 40])
    assert a2[2] == [310]  # the last child runs to the next entry at its depth or shallower: B


def test_a_table_of_contents_over_255_entries_keeps_its_labels_in_order():
    roots = [NavPoint(f"Chapter {i}", 0, i, i) for i in range(300)]
    labels = [label for label, _ in read_index(ncx_index(roots, flow_length=400), 0).entries]
    assert labels[0] == b"000" and labels[255] == b"0FF" and labels[-1] == b"12B"


def test_an_empty_table_of_contents_is_refused():
    with pytest.raises(ValueError):
        ncx_index([], flow_length=10)
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_indexes.py -q`
Expected: FAIL. Collection error `ModuleNotFoundError: No module named 'conversion.azw3.indexes'`.

- [ ] **Step 4: Write the implementation.** Create `sidecar/conversion/azw3/indexes.py`:

```python
"""KF8 index tables: forward varints, CNCX string records and INDX records.

The INDX/TAGX frame follows the MobileRead wiki's generic description; every
header word, tag table, control byte and entry order here was measured from
real files (spec Annex A). The four TAGX tables are written verbatim in their
full form — the Calibre shape, which is what the device has received.
"""

import struct
from dataclasses import dataclass, field

INDX_HEADER_BYTES = 192
MAX_RECORD_BYTES = 0x10000  # IDXT offsets and CNCX references are 16-bit

# (tag, values per group, mask) — one control byte each (Annex A).
TagTable = list[tuple[int, int, int]]
SKELETON_TAGS: TagTable = [(1, 1, 3), (6, 2, 12)]
FRAGMENT_TAGS: TagTable = [(2, 1, 1), (3, 1, 2), (4, 1, 4), (6, 2, 8)]
NCX_TAGS: TagTable = [
    (1, 1, 1), (2, 1, 2), (3, 1, 4), (4, 1, 8),
    (21, 1, 16), (22, 1, 32), (23, 1, 64), (6, 2, 128),
]
GUIDE_TAGS: TagTable = [(1, 1, 1), (6, 2, 2)]

Entry = tuple[bytes, dict[int, list[int]]]


def forward_varint(value: int) -> bytes:
    """7 bits per byte, most significant first; the last byte carries the high bit."""
    if value < 0:
        raise ValueError("a varint is unsigned")
    groups = [value & 0x7F]
    value >>= 7
    while value:
        groups.append(value & 0x7F)
        value >>= 7
    groups.reverse()
    groups[-1] |= 0x80
    return bytes(groups)


def pad4(data: bytes) -> bytes:
    return data + b"\0" * (-len(data) % 4)


class Cncx:
    """One CNCX record: length-prefixed UTF-8 strings, addressed by byte offset."""

    def __init__(self) -> None:
        self._data = bytearray()

    def add(self, text: str) -> int:
        offset = len(self._data)
        raw = text.encode("utf-8")
        self._data += forward_varint(len(raw)) + raw
        if len(self._data) >= MAX_RECORD_BYTES:
            raise ValueError("CNCX strings do not fit one record")
        return offset

    def record(self) -> bytes:
        return pad4(bytes(self._data))


def _tagx(table: TagTable) -> bytes:
    body = b"".join(bytes([tag, count, mask, 0]) for tag, count, mask in table)
    body += bytes([0, 0, 0, 1])  # end of the (only) control byte
    return b"TAGX" + struct.pack(">II", 12 + len(body), 1) + body


def encode_entry(label: bytes, values: dict[int, list[int]], table: TagTable) -> bytes:
    """Label, one control byte, then every present tag's values as forward varints."""
    if not 0 < len(label) < 256:
        raise ValueError("an index label is 1-255 bytes")
    control, payload = 0, b""
    for tag, per_group, mask in table:
        if tag not in values:
            continue
        groups, rest = divmod(len(values[tag]), per_group)
        lowest_bit = mask & -mask
        bits = groups * lowest_bit
        # A multi-bit mask filled completely means "a byte count follows" to a
        # reader, so a group count that fills it cannot be written this way.
        if rest or groups == 0 or bits & ~mask or (bits == mask and mask != lowest_bit):
            raise ValueError(f"tag {tag}: {len(values[tag])} values do not fit mask {mask:#x}")
        control |= bits
        payload += b"".join(forward_varint(v) for v in values[tag])
    return bytes([len(label)]) + label + bytes([control]) + payload


def _indx_header(idxt_at: int, count: int) -> bytearray:
    head = bytearray(INDX_HEADER_BYTES)
    head[0:4] = b"INDX"
    struct.pack_into(">I", head, 0x04, INDX_HEADER_BYTES)
    struct.pack_into(">II", head, 0x14, idxt_at, count)
    return head


def build_index(table: TagTable, entries: list[Entry], cncx_records: int) -> list[bytes]:
    """The INDX header record and one data record holding `entries`, in label order."""
    if not entries:
        raise ValueError("an index needs at least one entry")
    labels = [label for label, _ in entries]
    if labels != sorted(labels):
        raise ValueError("index labels must be in ascending order")

    body, offsets = bytearray(INDX_HEADER_BYTES), []
    for label, values in entries:
        offsets.append(len(body))
        body += encode_entry(label, values, table)
    body = bytearray(pad4(bytes(body)))
    if len(body) + 4 + 2 * len(entries) >= MAX_RECORD_BYTES:
        raise ValueError("index entries do not fit one data record")
    data = _indx_header(len(body), len(entries))
    struct.pack_into(">II", data, 0x08, 0, 1)
    struct.pack_into(">II", data, 0x1C, 0xFFFFFFFF, 0xFFFFFFFF)
    body[:INDX_HEADER_BYTES] = data
    data_record = bytes(body) + pad4(b"IDXT" + b"".join(struct.pack(">H", o) for o in offsets))

    tagx = _tagx(table)
    geometry_at = INDX_HEADER_BYTES + len(tagx)
    geometry = pad4(bytes([len(labels[-1])]) + labels[-1] + struct.pack(">H", len(entries)))
    head = _indx_header(geometry_at + len(geometry), 1)
    struct.pack_into(">I", head, 0x10, 2)
    struct.pack_into(">III", head, 0x1C, 65001, 0xFFFFFFFF, len(entries))
    struct.pack_into(">I", head, 0x34, cncx_records)
    struct.pack_into(">I", head, 0xB4, INDX_HEADER_BYTES)
    header_record = bytes(head) + tagx + geometry + pad4(b"IDXT" + struct.pack(">H", geometry_at))
    return [header_record, data_record]


@dataclass
class Piece:
    """One spine file in flow 0: its skeleton, then its single fragment."""

    start: int  # where the skeleton starts in flow 0
    skeleton_length: int
    insert_at: int  # where the fragment is inserted, in reassembled coordinates
    fragment_length: int
    selector: str  # the fragment's parent: P-//*[@aid='…']


def skeleton_index(pieces: list[Piece]) -> list[bytes]:
    entries = [
        (b"SKEL%010d" % i, {1: [1, 1], 6: [p.start, p.skeleton_length] * 2})
        for i, p in enumerate(pieces)
    ]
    return build_index(SKELETON_TAGS, entries, cncx_records=0)


def fragment_index(pieces: list[Piece]) -> list[bytes]:
    cncx = Cncx()
    entries = [
        (b"%010d" % p.insert_at, {2: [cncx.add(p.selector)], 3: [i], 4: [i], 6: [0, p.fragment_length]})
        for i, p in enumerate(pieces)
    ]
    return build_index(FRAGMENT_TAGS, entries, cncx_records=1) + [cncx.record()]


@dataclass
class NavPoint:
    title: str
    fid: int  # fragment number
    off: int  # byte offset inside that fragment
    pos: int  # reassembled position: the fragment's insert position + off
    children: list["NavPoint"] = field(default_factory=list)


def ncx_index(roots: list[NavPoint], flow_length: int) -> list[bytes]:
    """Entries in breadth-first order, with depth, parent and first/last child (Annex A)."""
    if not roots:
        raise ValueError("a table of contents needs at least one entry")
    order: list[tuple[NavPoint, int, int | None]] = []  # (node, depth, parent index)
    level = [(node, 0, None) for node in roots]
    while level:
        order += level
        start = len(order) - len(level)
        level = [
            (child, depth + 1, start + i)
            for i, (node, depth, _) in enumerate(level)
            for child in node.children
        ]
    index_of = {id(node): i for i, (node, _, _) in enumerate(order)}

    preorder: list[tuple[NavPoint, int]] = []

    def walk(nodes: list[NavPoint], depth: int) -> None:
        for node in nodes:
            preorder.append((node, depth))
            walk(node.children, depth + 1)

    walk(roots, 0)
    length: dict[int, int] = {}
    for k, (node, depth) in enumerate(preorder):
        end = next((n.pos for n, d in preorder[k + 1 :] if d <= depth), flow_length)
        length[id(node)] = max(end - node.pos, 0)

    # Two hex digits is all the measured files use (213 entries at most); a
    # longer table widens every label alike, so they stay in ascending order.
    width = max(2, len(f"{len(order) - 1:X}"))
    cncx = Cncx()
    entries: list[Entry] = []
    for i, (node, depth, parent) in enumerate(order):
        values = {1: [node.pos], 2: [length[id(node)]], 3: [cncx.add(node.title)], 4: [depth]}
        if parent is not None:
            values[21] = [parent]
        if node.children:
            values[22] = [index_of[id(node.children[0])]]
            values[23] = [index_of[id(node.children[-1])]]
        values[6] = [node.fid, node.off]
        entries.append((f"{i:0{width}X}".encode(), values))
    return build_index(NCX_TAGS, entries, cncx_records=1) + [cncx.record()]


def guide_index(references: list[tuple[str, str, int, int]]) -> list[bytes]:
    """(type, title, fid, off) per guide reference; labels are the types, sorted."""
    cncx = Cncx()
    entries = [
        (kind.encode("ascii", "replace"), {1: [cncx.add(title)], 6: [fid, off]})
        for kind, title, fid, off in sorted(references)
    ]
    return build_index(GUIDE_TAGS, entries, cncx_records=1) + [cncx.record()]
```

- [ ] **Step 5: Run them to verify they pass**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_indexes.py -q`
Expected: PASS (13 passed). If `test_rebuilding_a_real_guide_index_reproduces_its_bytes` fails, a header word or the IDXT layout is wrong. Compare the two byte strings at the first difference; the golden is real file bytes and is not to be edited.

- [ ] **Step 6: Run the whole sidecar suite**

Run: `cd sidecar && .venv/bin/python -m pytest -q`
Expected: PASS (200 passed: 187 + 13).

- [ ] **Step 7: Commit**

```bash
git add sidecar/conversion/azw3/indexes.py sidecar/tests/azw3_kf8.py sidecar/tests/test_azw3_indexes.py
git commit -m "feat(sidecar): KF8 index tables — varints, CNCX, INDX and the four tables, byte-identical to real files"
```

---

### Task 2: EPUB reader

**Files:**
- Create: `sidecar/conversion/azw3/epub.py`
- Test: `sidecar/tests/test_azw3_epub.py`

**Interfaces:**
- Consumes: `build_epub`, `xhtml`, `CONTAINER` from `tests/azw3_kf8.py` (Task 1). From the existing `extractors/epub_metadata.py`: `NS`, `MAX_XML_MEMBER_SIZE`, `_opf_path`, `_read_capped`, `extract_epub_metadata`. It is the repo's own EPUB code, and its caps bound untrusted zip members.
- Produces:
  - `resolve(base_file: str, href: str) -> str`: a zip path, keeping a percent-decoded `#fragment`. Task 3 imports it.
  - `@dataclass TocEntry(title: str, href: str, children: list[TocEntry])`
  - `@dataclass Epub(metadata: dict, spine: list[str], files: dict[str, bytes], media_types: dict[str, str], cover: str | None, toc: list[TocEntry], guide: list[tuple[str, str, str]], warnings: list[str])`
  - `read_epub(path: str) -> Epub`, which raises `ValueError` when the spine is empty

- [ ] **Step 1: Write the failing tests.** Create `sidecar/tests/test_azw3_epub.py`:

```python
import zipfile

import pytest

from conversion.azw3.epub import read_epub, resolve
from tests.azw3_kf8 import CONTAINER, build_epub, xhtml


def test_resolve_follows_relative_paths_and_keeps_the_fragment():
    assert resolve("OEBPS/text/c1.xhtml", "../images/a.jpg") == "OEBPS/images/a.jpg"
    assert resolve("OEBPS/text/c1.xhtml", "c2.xhtml#note%201") == "OEBPS/text/c2.xhtml#note 1"
    assert resolve("OEBPS/text/c1.xhtml", "#top") == "OEBPS/text/c1.xhtml#top"


def test_the_spine_cover_toc_and_guide_are_read(tmp_path):
    path = build_epub(
        tmp_path / "b.epub",
        chapters=[("c1.xhtml", xhtml("<p>one</p>")), ("c2.xhtml", xhtml("<p>two</p>"))],
        toc=[("One", "c1.xhtml", [("Inner", "c1.xhtml#x", [])]), ("Two", "c2.xhtml", [])],
        images={"cover.jpg": b"\xff\xd8\xff\xe0jpeg"},
        cover="cover.jpg",
        guide=[("toc", "Contents", "c2.xhtml")],
    )
    epub = read_epub(str(path))
    assert epub.spine == ["OEBPS/c1.xhtml", "OEBPS/c2.xhtml"]
    assert epub.cover == "OEBPS/cover.jpg"
    assert epub.media_types["OEBPS/cover.jpg"] == "image/jpeg"
    assert [(e.title, e.href, [c.title for c in e.children]) for e in epub.toc] == [
        ("One", "OEBPS/c1.xhtml", ["Inner"]),
        ("Two", "OEBPS/c2.xhtml", []),
    ]
    assert epub.toc[0].children[0].href == "OEBPS/c1.xhtml#x"
    assert epub.guide == [("toc", "Contents", "OEBPS/c2.xhtml")]
    assert epub.metadata["title"] == "Test Book"
    assert epub.metadata["authors"][0]["name"] == "Ann Author"


def test_an_epub3_nav_is_preferred_and_unlinked_headings_keep_their_children(tmp_path):
    path = build_epub(tmp_path / "b.epub", chapters=[("c1.xhtml", xhtml("<p>one</p>"))], toc=[("From NCX", "c1.xhtml", [])])
    nav = xhtml(
        '<nav epub:type="toc"><ol><li><a href="c1.xhtml">From &amp; nav</a>'
        '<ol><li><span>Heading</span><ol><li><a href="c1.xhtml#a">Deep</a></li></ol></li></ol>'
        "</li></ol></nav>"
    )
    with zipfile.ZipFile(path, "a") as z:
        z.writestr("OEBPS/nav.xhtml", nav)
    rewrite_opf(path, '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
    epub = read_epub(str(path))
    assert [(e.title, [c.title for c in e.children]) for e in epub.toc] == [("From & nav", ["Deep"])]


def test_a_missing_member_is_a_warning_and_an_empty_spine_is_an_error(tmp_path):
    path = build_epub(tmp_path / "b.epub", chapters=[("c1.xhtml", xhtml("<p>one</p>"))])
    rewrite_opf(path, '<item id="gone" href="gone.jpg" media-type="image/jpeg"/>')
    assert any("gone.jpg" in w for w in read_epub(str(path)).warnings)

    empty = tmp_path / "empty.epub"
    with zipfile.ZipFile(empty, "w") as z:
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr(
            "OEBPS/content.opf",
            '<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata/><manifest/><spine/></package>',
        )
    with pytest.raises(ValueError):
        read_epub(str(empty))


def rewrite_opf(path, extra_manifest_item: str) -> None:
    """Rebuild the zip with one more manifest item in the OPF."""
    with zipfile.ZipFile(path) as z:
        members = {name: z.read(name) for name in z.namelist()}
    opf = members["OEBPS/content.opf"].decode()
    members["OEBPS/content.opf"] = opf.replace("<manifest>", "<manifest>" + extra_manifest_item).encode()
    with zipfile.ZipFile(path, "w") as z:
        for name, data in members.items():
            z.writestr(name, data)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_epub.py -q`
Expected: FAIL. `ModuleNotFoundError: No module named 'conversion.azw3.epub'`.

- [ ] **Step 3: Write the implementation.** Create `sidecar/conversion/azw3/epub.py`:

```python
"""The parts of an EPUB the KF8 writer needs: reading order, members, cover, TOC and guide."""

import posixpath
import zipfile
from dataclasses import dataclass, field
from urllib.parse import unquote, urldefrag

import defusedxml.ElementTree as ET
import lxml.html

from extractors.epub_metadata import (
    MAX_XML_MEMBER_SIZE,
    NS,
    _opf_path,
    _read_capped,
    extract_epub_metadata,
)

MAX_MEMBER_BYTES = 50 * 1024 * 1024  # one chapter or image; the zip is untrusted input
NCX_NS = "http://www.daisy.org/z3986/2005/ncx/"


@dataclass
class TocEntry:
    title: str
    href: str  # zip path, with any '#fragment'
    children: list["TocEntry"] = field(default_factory=list)


@dataclass
class Epub:
    metadata: dict
    spine: list[str]  # zip paths, in reading order
    files: dict[str, bytes]  # every manifest member that could be read, by zip path
    media_types: dict[str, str]
    cover: str | None
    toc: list[TocEntry]
    guide: list[tuple[str, str, str]]  # (type, title, href)
    warnings: list[str] = field(default_factory=list)


def resolve(base_file: str, href: str) -> str:
    """A zip path for `href` as written inside `base_file`, keeping any '#fragment'."""
    path, fragment = urldefrag(href)
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(base_file), unquote(path))) if path else base_file
    return f"{joined}#{unquote(fragment)}" if fragment else joined


def read_epub(path: str) -> Epub:
    with zipfile.ZipFile(path) as z:
        opf_path = _opf_path(z)
        opf = ET.fromstring(_read_capped(z, opf_path, MAX_XML_MEMBER_SIZE))
        warnings: list[str] = []
        items: dict[str, tuple[str, str, str]] = {}  # id -> (zip path, media type, properties)
        manifest = opf.find("opf:manifest", NS)
        for item in manifest.findall("opf:item", NS) if manifest is not None else []:
            href, item_id = item.get("href"), item.get("id")
            if href and item_id:
                items[item_id] = (resolve(opf_path, href), item.get("media-type") or "", item.get("properties") or "")
        files: dict[str, bytes] = {}
        for zip_path, _, _ in items.values():
            try:
                files[zip_path] = _read_capped(z, zip_path, MAX_MEMBER_BYTES)
            except (KeyError, ValueError) as error:
                warnings.append(f"skipped {zip_path}: {error}")

    media_types = {p: m for p, m, _ in items.values()}
    spine_el = opf.find("opf:spine", NS)
    spine = [
        items[ref.get("idref")][0]
        for ref in (spine_el.findall("opf:itemref", NS) if spine_el is not None else [])
        if ref.get("idref") in items and items[ref.get("idref")][0] in files
    ]
    if not spine:
        raise ValueError("the EPUB has no readable spine")

    cover = None
    metadata_el = opf.find("opf:metadata", NS)
    cover_id = next(
        (m.get("content") for m in (metadata_el.findall("opf:meta", NS) if metadata_el is not None else []) if m.get("name") == "cover"),
        None,
    )
    for item_id, (zip_path, media_type, properties) in items.items():
        if (item_id == cover_id or "cover-image" in properties.split()) and media_type.startswith("image/") and zip_path in files:
            cover = zip_path
            break

    toc = _nav_toc(items, files) or _ncx_toc(items, files, spine_el)
    guide_el = opf.find("opf:guide", NS)
    guide = [
        (ref.get("type") or "", ref.get("title") or ref.get("type") or "", resolve(opf_path, ref.get("href")))
        for ref in (guide_el.findall("opf:reference", NS) if guide_el is not None else [])
        if ref.get("type") and ref.get("href")
    ]
    return Epub(extract_epub_metadata(path), spine, files, media_types, cover, toc, guide, warnings)


def _nav_toc(items: dict[str, tuple[str, str, str]], files: dict[str, bytes]) -> list[TocEntry]:
    nav_path = next((p for p, _, props in items.values() if "nav" in props.split() and p in files), None)
    if nav_path is None:
        return []
    doc = lxml.html.document_fromstring(files[nav_path])
    nav = next((n for n in doc.iter("nav") if n.get("epub:type") == "toc"), None)
    ol = nav.find(".//ol") if nav is not None else None
    return _nav_list(ol, nav_path) if ol is not None else []


def _nav_list(ol, nav_path: str) -> list[TocEntry]:
    entries = []
    for li in ol.findall("li"):
        link = li.find("a")
        title = " ".join((link if link is not None else li).text_content().split())
        children = _nav_list(li.find("ol"), nav_path) if li.find("ol") is not None else []
        if link is not None and link.get("href"):
            entries.append(TocEntry(title, resolve(nav_path, link.get("href")), children))
        else:
            entries.extend(children)  # an unlinked heading: keep what is under it
    return entries


def _ncx_toc(items: dict[str, tuple[str, str, str]], files: dict[str, bytes], spine_el) -> list[TocEntry]:
    ncx_id = spine_el.get("toc") if spine_el is not None else None
    ncx_path = items[ncx_id][0] if ncx_id in items else next(
        (p for p, m, _ in items.values() if m == "application/x-dtbncx+xml"), None
    )
    if ncx_path is None or ncx_path not in files:
        return []
    root = ET.fromstring(files[ncx_path])
    nav_map = root.find(f"{{{NCX_NS}}}navMap")
    return _ncx_points(nav_map, ncx_path) if nav_map is not None else []


def _ncx_points(parent, ncx_path: str) -> list[TocEntry]:
    entries = []
    for point in parent.findall(f"{{{NCX_NS}}}navPoint"):
        label = point.find(f"{{{NCX_NS}}}navLabel/{{{NCX_NS}}}text")
        content = point.find(f"{{{NCX_NS}}}content")
        title = " ".join((label.text or "").split()) if label is not None else ""
        children = _ncx_points(point, ncx_path)
        if content is not None and content.get("src"):
            entries.append(TocEntry(title, resolve(ncx_path, content.get("src")), children))
        else:
            entries.extend(children)
    return entries
```

- [ ] **Step 4: Run them to verify they pass, then the suite**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_epub.py -q && .venv/bin/python -m pytest -q`
Expected: PASS (4 passed), then 204 passed.

- [ ] **Step 5: Commit**

```bash
git add sidecar/conversion/azw3/epub.py sidecar/tests/test_azw3_epub.py
git commit -m "feat(sidecar): EPUB reader for the KF8 writer — spine, members, cover, TOC and guide"
```

---

### Task 3: Markup — one spine file to a skeleton and a fragment

**Files:**
- Create: `sidecar/conversion/azw3/markup.py`
- Test: `sidecar/tests/test_azw3_markup.py`

**Interfaces:**
- Consumes: `resolve` from `conversion/azw3/epub.py` (Task 2); `xhtml` from `tests/azw3_kf8.py` (Task 1).
- Produces:
  - `base32(value: int) -> str` (minimal digits, 0–9A–V) and `fixed_base32(value: int, width: int) -> str` (zero-padded; `ValueError` when too wide)
  - `class Resolver(Protocol)` with `stylesheet(path) -> int | None` (1-based flow) and `image(path) -> tuple[int, str] | None` (1-based resource number and MIME type). Task 4's `Resources` implements it.
  - `class Aids` (`next() -> str`), the book-wide `aid` counter
  - `@dataclass Link(at: int, target: str)` and `@dataclass Part(path, skeleton: bytes, fragment: bytes, insert_offset: int, selector: str, anchors: dict[str, int], links: list[Link], warnings: list[str])`
  - `build_part(path: str, data: bytes, aids: Aids, resolver: Resolver) -> Part`
  - `css_flow(path: str, data: bytes) -> tuple[bytes, list[str]]`
  - `LINK_PLACEHOLDER = "kindle:pos:fid:0000:off:0000000000"`, 34 bytes. Task 4 overwrites it in place.

**Annex B rows this task's code needs:** skeleton/fragment split and the `P-//*[@aid='…']` selector (Annex A *Text markup* / *Fragment index*); `aid`, `kindle:flow`, `kindle:embed`, `kindle:pos` and their base-32 widths (Annex A *Text markup*); the link offset pointing at the target element's start tag. That last one was **measured 2026-10-07** on *Red Rising*: `off:000000001P` (57) lands on `<p … id="filepos542"`, and an NCX position is its fragment's insert position plus that offset. Also numeric character references (*Lonely Planet Rome*, 6,568 of them).

- [ ] **Step 1: Write the failing tests.** Create `sidecar/tests/test_azw3_markup.py`:

```python
import re

import pytest

from conversion.azw3.markup import Aids, base32, build_part, css_flow, fixed_base32
from tests.azw3_kf8 import xhtml


class FakeResolver:
    def __init__(self, sheets=(), images=None):
        self.sheets = list(sheets)
        self.images = images or {}

    def stylesheet(self, path):
        return self.sheets.index(path) + 1 if path in self.sheets else None

    def image(self, path):
        return self.images.get(path)


def part(body: str, head: str = "", resolver=None, aids=None):
    return build_part("OEBPS/text/c1.xhtml", xhtml(body, head=head).encode(), aids or Aids(), resolver or FakeResolver())


def test_base32_uses_digits_0_to_v():
    assert [base32(v) for v in (0, 9, 10, 31, 32, 57)] == ["0", "9", "A", "V", "10", "1P"]
    assert fixed_base32(57, 10) == "000000001P"
    with pytest.raises(ValueError):
        fixed_base32(32**4, 4)


def test_the_skeleton_is_the_shell_and_the_fragment_goes_before_body_close():
    p = part("<p>Hello</p>")
    assert p.skeleton.startswith(b'<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head>')
    assert p.skeleton.endswith(b'<body aid="0"></body></html>')
    assert p.skeleton[p.insert_offset :] == b"</body></html>"
    assert p.fragment == b'<p aid="1">Hello</p>'
    assert p.selector == "P-//*[@aid='0']"


def test_the_markup_is_ascii_with_numeric_references():
    p = part("<p>“Café”&nbsp;&mdash; &amp; &lt;</p>")
    assert p.fragment.isascii() and p.skeleton.isascii()
    assert p.fragment == b'<p aid="1">&#8220;Caf&#233;&#8221;&#160;&#8212; &amp; &lt;</p>'


def test_xhtml_self_closing_elements_stay_empty():
    p = part('<p>a<a id="x"/>b</p><div class="gap"/><p>c</p>')
    assert b'<a id="x" aid="2"/>b</p><div class="gap" aid="3"/><p aid="4">c</p>' in p.fragment


def test_aids_run_across_the_book_and_mark_blocks_and_anchors_only():
    aids = Aids()
    first = part("<p>one <em>two</em></p>", aids=aids)
    second = part('<div><span id="s">x</span></div>', aids=aids)
    assert first.fragment == b'<p aid="1">one <em>two</em></p>'
    assert second.selector == "P-//*[@aid='2']"
    assert second.fragment == b'<div aid="3"><span id="s" aid="4">x</span></div>'


def test_anchors_point_at_the_start_tag_of_their_element():
    p = part('<h1>Title</h1><p>text <span id="mid">here</span></p><a name="old">x</a>')
    for anchor, tag in (("mid", b"<span"), ("old", b"<a")):
        assert p.fragment[p.anchors[anchor] :].startswith(tag)
        assert anchor.encode() in p.fragment[p.anchors[anchor] :].split(b">")[0]


def test_internal_links_become_fixed_width_placeholders_and_external_ones_stay():
    p = part('<p><a href="c2.xhtml#n1">1</a> <a href="#top">t</a> <a href="https://x.org/">w</a></p>')
    assert [link.target for link in p.links] == ["OEBPS/text/c2.xhtml#n1", "OEBPS/text/c1.xhtml#top"]
    for link in p.links:
        assert p.fragment[link.at : link.at + 34] == b"kindle:pos:fid:0000:off:0000000000"
    assert b'href="https://x.org/"' in p.fragment


def test_stylesheets_become_flows_and_unknown_links_are_dropped():
    resolver = FakeResolver(sheets=["OEBPS/css/a.css"])
    p = part("<p>x</p>", head='<link rel="stylesheet" href="../css/a.css"/><link rel="stylesheet" href="gone.css"/>', resolver=resolver)
    assert b'<link href="kindle:flow:0001?mime=text/css" rel="stylesheet" type="text/css"/>' in p.skeleton
    assert b"gone.css" not in p.skeleton


def test_images_are_embedded_by_number_and_missing_ones_are_dropped_with_a_warning():
    resolver = FakeResolver(images={"OEBPS/img/a.jpg": (1, "image/jpeg")})
    p = part('<p><img src="../img/a.jpg" alt=""/>after<img src="../img/gone.png"/>tail</p>', resolver=resolver)
    assert b'<img src="kindle:embed:0001?mime=image/jpeg" alt=""/>after' in p.fragment
    assert b"gone.png" not in p.fragment and b"aftertail" in p.fragment
    assert any("gone.png" in w for w in p.warnings)


def test_svg_images_keep_their_xlink_reference():
    resolver = FakeResolver(images={"OEBPS/img/a.jpg": (2, "image/jpeg")})
    body = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../img/a.jpg"/></svg>'
    p = part(body, resolver=resolver)
    assert re.search(rb'href="kindle:embed:0002\?mime=image/jpeg"', p.fragment)


def test_scripts_comments_and_epub_attributes_are_removed():
    p = part('<p epub:type="bodymatter">a<!-- note -->b</p><script>alert(1)</script>')
    assert p.fragment == b'<p aid="1">ab</p>'


def test_a_file_without_a_body_is_refused():
    with pytest.raises(ValueError):
        build_part("x.xhtml", b'<html xmlns="http://www.w3.org/1999/xhtml"><head/></html>', Aids(), FakeResolver())


def test_css_is_ascii_and_embedded_fonts_are_dropped_with_a_warning():
    flow, warnings = css_flow("s.css", "p::before { content: '—' } @font-face { src: url(f.ttf) } h1 { x: 1 }".encode())
    assert flow == b"p::before { content: '\\2014 ' }  h1 { x: 1 }"
    assert warnings == ["s.css: dropped @font-face rules (embedded fonts are out of scope)"]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_markup.py -q`
Expected: FAIL. `ModuleNotFoundError: No module named 'conversion.azw3.markup'`.

- [ ] **Step 3: Write the implementation.** Create `sidecar/conversion/azw3/markup.py`:

```python
"""One spine file → its KF8 skeleton and fragment, in ASCII (spec Annex A, *Text markup*).

The skeleton is the file's <html>…<body> shell with an empty body; the
fragment is the body's content, inserted just before </body>. Everything is
serialized as ASCII — non-ASCII characters become numeric references, the form
measured in a kindlegen file — so a text record cut at exactly 4,096 bytes can
never split a character (spec, *Device experiments*).
"""

import html
import re
from dataclasses import dataclass, field
from html.entities import name2codepoint
from typing import Protocol
from urllib.parse import urlparse

import lxml.html
from lxml import etree

from .epub import resolve

BASE32 = "0123456789ABCDEFGHIJKLMNOPQRSTUV"
XHTML_NS = "http://www.w3.org/1999/xhtml"
XML_NS = "http://www.w3.org/XML/1998/namespace"
XLINK_NS = "http://www.w3.org/1999/xlink"
DECLARATION = b'<?xml version="1.0" encoding="UTF-8"?>\n'
HTML_OPEN = b'<html xmlns="http://www.w3.org/1999/xhtml">'
LINK_PLACEHOLDER = "kindle:pos:fid:0000:off:0000000000"  # fixed width: patched in place later
BLOCK_TAGS = frozenset(
    "address article aside blockquote body dd div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 "
    "header hr li nav ol p pre section table tbody td tfoot th thead tr ul".split()
)
XML_ENTITIES = frozenset({"amp", "lt", "gt", "quot", "apos"})


def base32(value: int) -> str:
    """Digits 0-9A-V, as few as the value needs (an `aid`)."""
    if value < 0:
        raise ValueError("base 32 here is unsigned")
    digits = ""
    while value:
        value, digit = divmod(value, 32)
        digits = BASE32[digit] + digits
    return digits or "0"


def fixed_base32(value: int, width: int) -> str:
    """Zero-padded to `width` digits (flow, embed and position numbers)."""
    digits = base32(value).rjust(width, "0")
    if len(digits) > width:
        raise ValueError(f"{value} needs more than {width} base-32 digits")
    return digits


class Resolver(Protocol):
    def stylesheet(self, path: str) -> int | None: ...  # 1-based flow number
    def image(self, path: str) -> tuple[int, str] | None: ...  # 1-based resource number, MIME type


@dataclass
class Link:
    at: int  # byte offset of the placeholder inside the fragment
    target: str  # zip path, with any '#id'


@dataclass
class Part:
    path: str
    skeleton: bytes
    fragment: bytes
    insert_offset: int  # where the fragment goes inside the skeleton (just before </body>)
    selector: str
    anchors: dict[str, int]  # element id -> offset of that element's start tag in the fragment
    links: list[Link]
    warnings: list[str] = field(default_factory=list)


class Aids:
    """The book-wide `aid` counter: one base-32 value per block element."""

    def __init__(self) -> None:
        self.count = 0

    def next(self) -> str:
        value = base32(self.count)
        self.count += 1
        return value


def _parse(data: bytes) -> etree._Element:
    text = data.decode("utf-8", "replace")
    text = re.sub(r"^\s*<\?xml[^>]*\?>", "", text)
    text = re.sub(r"<!DOCTYPE[^>\[]*(\[[^\]]*\])?\s*>", "", text, flags=re.IGNORECASE)
    # HTML's named entities are not XML's: write them as numbers before parsing.
    text = re.sub(
        r"&([A-Za-z][A-Za-z0-9]*);",
        lambda m: m.group(0) if m.group(1) in XML_ENTITIES or m.group(1) not in name2codepoint
        else f"&#{name2codepoint[m.group(1)]};",
        text,
    )
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=True, huge_tree=False)
    root = etree.fromstring(text.encode("utf-8"), parser)
    if root is None:
        return lxml.html.document_fromstring(text)
    for el in root.iter():
        if isinstance(el.tag, str) and el.tag.startswith(f"{{{XHTML_NS}}}"):
            el.tag = el.tag[len(XHTML_NS) + 2 :]
        for name in list(el.attrib):
            if name.startswith("{") and not name.startswith((f"{{{XML_NS}}}", f"{{{XLINK_NS}}}")):
                del el.attrib[name]  # epub:type and friends
    etree.cleanup_namespaces(root)
    return root


def _remove(el: etree._Element) -> None:
    """Drop an element, keeping its tail text."""
    parent = el.getparent()
    if el.tail:
        previous = el.getprevious()
        if previous is not None:
            previous.tail = (previous.tail or "") + el.tail
        else:
            parent.text = (parent.text or "") + el.tail
    parent.remove(el)


def _ascii(text: str) -> bytes:
    return html.escape(text, quote=False).encode("ascii", "xmlcharrefreplace")


def _embed(el: etree._Element, path: str, resolver: Resolver, warnings: list[str]) -> bool:
    """Point an image at its resource record; False when the book does not hold it."""
    for attr in ("src", f"{{{XLINK_NS}}}href", "href"):
        ref = el.get(attr)
        if ref:
            found = resolver.image(resolve(path, ref))
            if found is None:
                warnings.append(f"{path}: dropped an image that is not in the book: {ref}")
                return False
            el.set(attr, f"kindle:embed:{fixed_base32(found[0], 4)}?mime={found[1]}")
            return True
    return True


def build_part(path: str, data: bytes, aids: Aids, resolver: Resolver) -> Part:
    root = _parse(data)
    warnings: list[str] = []
    for el in list(root.iter(etree.Comment, etree.ProcessingInstruction, "script")):
        _remove(el)
    head = root.find("head")
    body = root.find("body")
    if body is None:
        raise ValueError(f"{path} has no <body>")

    for link in list(head.iter("link")) if head is not None else []:
        flow = resolver.stylesheet(resolve(path, link.get("href", ""))) if "stylesheet" in (link.get("rel") or "") else None
        if flow is None:
            _remove(link)
        else:
            link.attrib.clear()
            link.set("href", f"kindle:flow:{fixed_base32(flow, 4)}?mime=text/css")
            link.set("rel", "stylesheet")
            link.set("type", "text/css")

    targets: list[str] = []
    body.set("aid", aids.next())
    for el in list(body.iter()):
        if el is body or not isinstance(el.tag, str):
            continue
        local = etree.QName(el).localname
        if local in ("img", "image") and not _embed(el, path, resolver, warnings):
            _remove(el)
            continue
        if local == "a" and el.get("href") and not urlparse(el.get("href")).scheme:
            targets.append(resolve(path, el.get("href")))
            el.set("href", LINK_PLACEHOLDER)
        if local in BLOCK_TAGS or el.get("id") or (local == "a" and el.get("name")):
            el.set("aid", aids.next())

    fragment = _ascii(body.text or "") + b"".join(
        etree.tostring(child, encoding="ascii", with_tail=True) for child in body
    )
    shell = etree.Element("body", dict(body.attrib))
    shell.text = ""
    head_bytes = etree.tostring(head, encoding="ascii") if head is not None else b"<head></head>"
    opening = DECLARATION + HTML_OPEN + head_bytes
    body_shell = etree.tostring(shell, encoding="ascii")
    skeleton = opening + body_shell + b"</html>"
    insert_offset = len(opening) + body_shell.index(b"</body>")

    placeholder = LINK_PLACEHOLDER.encode()
    starts, at = [], fragment.find(placeholder)
    while at != -1:
        starts.append(at)
        at = fragment.find(placeholder, at + 1)
    if len(starts) != len(targets):
        raise ValueError(f"{path}: {len(targets)} links but {len(starts)} placeholders")

    anchors: dict[str, int] = {}
    for el in body.iter():
        anchor = el.get("id") or (el.get("name") if el.tag == "a" else None)
        if anchor and el is not body and anchor not in anchors:
            match = re.search(rb'\said="' + el.get("aid").encode() + rb'"', fragment)
            anchors[anchor] = fragment.rindex(b"<", 0, match.start())
    if body.get("id"):
        anchors.setdefault(body.get("id"), 0)

    return Part(
        path=path,
        skeleton=skeleton,
        fragment=fragment,
        insert_offset=insert_offset,
        selector=f"P-//*[@aid='{body.get('aid')}']",
        anchors=anchors,
        links=[Link(at, target) for at, target in zip(starts, targets)],
        warnings=warnings,
    )


def css_flow(path: str, data: bytes) -> tuple[bytes, list[str]]:
    """A stylesheet as an ASCII flow. Embedded fonts are out of scope (spec D4) and dropped."""
    text = data.decode("utf-8", "replace")
    warnings = []
    without_fonts = re.sub(r"@font-face\s*\{[^}]*\}", "", text, flags=re.IGNORECASE)
    if without_fonts != text:
        warnings.append(f"{path}: dropped @font-face rules (embedded fonts are out of scope)")
    text = re.sub(r"@import[^;]*;", "", without_fonts, flags=re.IGNORECASE)
    escaped = "".join(c if ord(c) < 0x80 else f"\\{ord(c):X} " for c in text)
    return escaped.encode("ascii"), warnings
```

- [ ] **Step 4: Run them to verify they pass, then the suite**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_markup.py -q && .venv/bin/python -m pytest -q`
Expected: PASS (13 passed), then 217 passed.

- [ ] **Step 5: Commit**

```bash
git add sidecar/conversion/azw3/markup.py sidecar/tests/test_azw3_markup.py
git commit -m "feat(sidecar): KF8 markup — skeleton and fragment per spine file, in ASCII"
```

---

### Task 4: The writer

**Files:**
- Create: `sidecar/conversion/azw3/writer.py`
- Test: `sidecar/tests/test_azw3_writer.py`

**Interfaces:**
- Consumes: Task 1's `Piece`, `NavPoint`, `skeleton_index`, `fragment_index`, `ncx_index`, `guide_index`; Task 2's `Epub`, `TocEntry`, `read_epub`; Task 3's `Aids`, `Part`, `build_part`, `css_flow`, `fixed_base32`. From slice 1a: `build_exth` (`exth.py`), `read_identity` (`identity.py`), `write_palmdb` (`palmdb.py`), `describe` (`probe.py`, used in a test). From Task 1's helper: `build_epub`, `read_kf8`, `xhtml`.
- Produces:
  - `@dataclass Conversion(data: bytes, uuid: str, title: str, cover: bytes | None, warnings: list[str])`
  - `build_azw3(epub_path: str) -> Conversion`. It raises `ValueError` if the written file does not read back through `read_identity` as written (spec D3).
  - `write_azw3(epub_path: str, out_path: str) -> Conversion`: writes `out_path + ".tmp"`, then `os.replace`; on any failure it removes the temp (spec D5)
  - `fit_image(data: bytes, media_type: str) -> tuple[bytes, str | None]`, `text_records(text: bytes) -> list[bytes]`, `MAX_IMAGE_BYTES = 131_072`

**Annex B rows this task's code needs:** record 0 (every word, Annex A *Record 0* rows; flags 0 and compression 1 from *Device experiments*); EXTH types written: 100/101/103/104/106 (wiki), 108 `Musaeum`, 113 fresh uuid, 125, 131, 201, 203, 204–207 + 535 (Calibre's values, measured; the spike does not vary them), 501, 503, 524. Also the pad record (Annex A, presence 9/9; its length is not load-bearing), image records under 131,072 B (measured maximum 130,912), the FDST / FLIS / 52-byte FCIS / EOF records (Annex A), and the record order (Annex A, the Calibre shape).

- [ ] **Step 1: Write the failing tests.** Create `sidecar/tests/test_azw3_writer.py`:

```python
import io
import os
import re

import pytest
from PIL import Image

from conversion.azw3.identity import read_identity
from conversion.azw3.probe import describe
from conversion.azw3.writer import MAX_IMAGE_BYTES, build_azw3, fit_image, text_records, write_azw3
from tests.azw3_kf8 import build_epub, read_kf8, xhtml


def jpeg(width=60, height=90, noise=False) -> bytes:
    image = Image.effect_noise((width, height), 100).convert("RGB") if noise else Image.new("RGB", (width, height), "red")
    out = io.BytesIO()
    image.save(out, "JPEG", quality=95)
    return out.getvalue()


@pytest.fixture
def book(tmp_path):
    return build_epub(
        tmp_path / "book.epub",
        chapters=[
            ("c1.xhtml", xhtml(
                '<h1>One</h1><p>“Quoted” text<a href="c2.xhtml#n1">1</a></p><img src="cover.jpg" alt=""/>',
                head='<link rel="stylesheet" href="s.css" type="text/css"/>',
            )),
            ("c2.xhtml", xhtml('<h2>Two</h2><p id="n1">The note.</p>' + "<p>filler line</p>" * 400)),
        ],
        toc=[("One", "c1.xhtml", [("Note", "c2.xhtml#n1", [])]), ("Two", "c2.xhtml", [])],
        css={"s.css": "p { margin: 0 }"},
        images={"cover.jpg": jpeg()},
        cover="cover.jpg",
        authors=("First Author", "Second Author"),
    )


def test_the_text_is_uncompressed_ascii_in_4096_byte_records_with_no_trailing_entries(book):
    kf8 = read_kf8(build_azw3(str(book)).data)
    count = int.from_bytes(kf8.rec0[8:10], "big")
    sizes = [len(r) for r in kf8.records[1 : 1 + count]]
    assert count > 1 and set(sizes[:-1]) == {4096} and 0 < sizes[-1] <= 4096
    assert kf8.text.isascii()
    # T1 crashed the Oasis: PalmDOC text without trailing entries. Compression 1
    # and flags 0 travel together, and read_kf8 already insists on compression 1.
    assert kf8.word(0xF0) == 0


def test_text_records_refuse_text_that_is_not_ascii():
    with pytest.raises(ValueError):
        text_records("café".encode())


def test_the_header_words_point_at_records_of_the_measured_kinds(book):
    kf8 = read_kf8(build_azw3(str(book)).data)
    rec = kf8.records
    assert (kf8.word(0x14), kf8.word(0x18), kf8.word(0x1C), kf8.word(0x24)) == (264, 2, 65001, 8)
    for word in (0x50, 0xF4, 0xF8, 0xFC, 0x104):
        assert rec[kf8.word(word)][:4] == b"INDX", hex(word)
    assert kf8.word(0x50) == kf8.word(0xF8)  # the first non-book record is the fragment index
    assert rec[kf8.word(0xC0)][:4] == b"FDST" and kf8.word(0xC4) == 2
    assert rec[kf8.word(0xC8)][:4] == b"FCIS" and rec[kf8.word(0xD0)][:4] == b"FLIS"
    assert rec[kf8.word(0x6C)][:3] == b"\xff\xd8\xff"
    assert rec[-1] == b"\xe9\x8e\r\n"
    assert int.from_bytes(rec[kf8.word(0xC8)][20:24], "big") == len(kf8.text)


def test_flows_are_the_xhtml_then_each_stylesheet(book):
    kf8 = read_kf8(build_azw3(str(book)).data)
    xhtml_flow, css = kf8.flows()
    assert xhtml_flow.startswith(b'<?xml version="1.0" encoding="UTF-8"?>\n<html')
    assert b"kindle:flow:0001?mime=text/css" in xhtml_flow
    assert css == b"p { margin: 0 }"


def test_each_skeleton_and_fragment_reassemble_where_the_indexes_say(book):
    kf8 = read_kf8(build_azw3(str(book)).data)
    flow = kf8.flows()[0]
    skeletons = kf8.index(0xFC).entries
    fragments = kf8.index(0xF8).entries
    for (_, skel), (label, frag) in zip(skeletons, fragments):
        start, length = skel[6][:2]
        shell = flow[start : start + length]
        assert shell.endswith(b"</body></html>")
        frag_start = start + length + frag[6][0]
        assert int(label) == start + shell.index(b"</body></html>")
        assert flow[frag_start : frag_start + frag[6][1]].startswith(b"<h")


def test_links_and_the_ncx_point_at_the_element_they_name(book):
    kf8 = read_kf8(build_azw3(str(book)).data)
    flow = kf8.flows()[0]
    skeletons, fragments = kf8.index(0xFC).entries, kf8.index(0xF8).entries

    def fragment_bytes(fid: int) -> bytes:
        start, length = skeletons[fid][1][6][:2]
        return flow[start + length :]

    fid, off = re.search(rb"kindle:pos:fid:(\w{4}):off:(\w{10})", flow).groups()
    assert fragment_bytes(int(fid, 32))[int(off, 32) :].startswith(b'<p id="n1"')
    ncx = kf8.index(0xF4)
    by_title = {ncx.cncx[v[3][0]]: v for _, v in ncx.entries}
    assert list(by_title) == ["One", "Two", "Note"]
    note = by_title["Note"]
    assert fragment_bytes(note[6][0])[note[6][1] :].startswith(b'<p id="n1"')
    assert note[1][0] == int(fragments[note[6][0]][0]) + note[6][1]
    assert (note[4], note[21]) == ([1], [0])


def test_the_guide_always_has_a_start_of_text(book):
    guide = read_kf8(build_azw3(str(book)).data).index(0x104)
    assert [(label, guide.cncx[v[1][0]], v[6]) for label, v in guide.entries] == [(b"text", "Beginning", [0, 0])]


def test_the_file_reads_back_through_the_apps_own_offsets(book):
    conversion = build_azw3(str(book))
    identity = read_identity(conversion.data)
    assert (identity.title, identity.author, identity.uuid, identity.cdetype) == (
        "Test Book", "Second Author", conversion.uuid, "EBOK",  # the app's reader keeps the last author
    )
    kf8 = read_kf8(conversion.data)
    assert kf8.exth[100] == [b"First Author", b"Second Author"]
    assert kf8.exth[201] == [b"\0\0\0\0"] and kf8.exth[125] == [b"\0\0\0\1"]
    assert conversion.cover == kf8.records[kf8.word(0x6C)]
    assert build_azw3(str(book)).uuid != conversion.uuid  # fresh per file (spec D3)


def test_the_probe_describes_the_written_file(book):
    lines = describe(build_azw3(str(book)).data)
    assert any("INDX" in line for line in lines) and any("FDST" in line for line in lines)


def test_a_title_of_1024_bytes_or_more_is_cut_so_the_app_can_still_read_it(tmp_path):
    path = build_epub(tmp_path / "long.epub", chapters=[("c.xhtml", xhtml("<p>x</p>"))], title="é" * 600)
    identity = read_identity(build_azw3(str(path)).data)
    assert identity.title == "é" * 511  # 1,022 bytes: whole characters under 1,024


def test_toc_entries_and_links_outside_the_book_fall_back_with_warnings(tmp_path):
    path = build_epub(
        tmp_path / "b.epub",
        chapters=[("c.xhtml", xhtml('<p><a href="elsewhere.xhtml">x</a> <a href="#nope">y</a></p>'))],
        toc=[("Gone", "elsewhere.xhtml", []), ("Here", "c.xhtml#nope", [])],
    )
    conversion = build_azw3(str(path))
    ncx = read_kf8(conversion.data).index(0xF4)
    assert [ncx.cncx[v[3][0]] for _, v in ncx.entries] == ["Here"]
    assert any("outside the book" in w for w in conversion.warnings)
    assert any("no such anchor" in w for w in conversion.warnings)


def test_a_book_without_a_table_of_contents_gets_one_entry(tmp_path):
    path = build_epub(tmp_path / "b.epub", chapters=[("c.xhtml", xhtml("<p>x</p>"))], toc=[])
    ncx = read_kf8(build_azw3(str(path)).data).index(0xF4)
    assert [ncx.cncx[v[3][0]] for _, v in ncx.entries] == ["Test Book"]


def test_images_over_128_kib_or_of_other_types_become_smaller_jpegs():
    big = jpeg(1600, 2400, noise=True)
    assert len(big) > MAX_IMAGE_BYTES
    data, mime = fit_image(big, "image/jpeg")
    assert mime == "image/jpeg" and len(data) <= MAX_IMAGE_BYTES
    webp = io.BytesIO()
    Image.new("RGBA", (10, 10), (0, 0, 255, 128)).save(webp, "WEBP")
    data, mime = fit_image(webp.getvalue(), "image/webp")
    assert mime == "image/jpeg" and data[:3] == b"\xff\xd8\xff"
    assert fit_image(b"<svg/>", "image/svg+xml") == (b"<svg/>", None)
    small = jpeg()
    assert fit_image(small, "image/jpeg") == (small, "image/jpeg")


def test_write_leaves_the_file_and_no_temp(book, tmp_path):
    target = tmp_path / "out.azw3"
    conversion = write_azw3(str(book), str(target))
    assert target.read_bytes() == conversion.data
    assert sorted(p.name for p in tmp_path.iterdir()) == ["book.epub", "out.azw3"]


def test_a_write_that_fails_leaves_no_file_and_no_temp(book, tmp_path, monkeypatch):
    def full_disk(*_):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", full_disk)
    with pytest.raises(OSError):
        write_azw3(str(book), str(tmp_path / "out.azw3"))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["book.epub"]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_writer.py -q`
Expected: FAIL. `ModuleNotFoundError: No module named 'conversion.azw3.writer'`.

- [ ] **Step 3: Write the implementation.** Create `sidecar/conversion/azw3/writer.py`:

```python
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
from .indexes import NavPoint, Piece, fragment_index, guide_index, ncx_index, skeleton_index
from .markup import Aids, Part, build_part, css_flow, fixed_base32
from .palmdb import write_palmdb

TEXT_RECORD_BYTES = 4096
MOBI_HEADER_BYTES = 264
MAX_TITLE_BYTES = 1023  # the app's reader refuses 1,024 and over (identity.MAX_TITLE_BYTES)
MAX_IMAGE_BYTES = 131_072  # every image record measured is under 128 KiB (largest 130,912)
KEPT_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif"}
NONE = 0xFFFFFFFF
FLIS = b"FLIS" + struct.pack(">IHHIIHHIII", 8, 65, 0, 0, NONE, 1, 3, 3, 1, NONE)
EOF_RECORD = b"\xe9\x8e\r\n"
# EXTH 204-207 and 535 name the *creator software*. These are the values Calibre
# writes: they say Amazon's kindlegen (Mac, 2.9, build 0730-890adc2), not Musaeum.
# The device has opened every file carrying them and nothing measured says it reads
# them, but no file without them has been tried; the gate keeps them and slice 2
# tests zeroing them. Musaeum signs itself in EXTH 108 (contributor), where Calibre
# signs itself.
CREATOR = [(204, 202), (205, 2), (206, 9), (207, 0)]
CREATOR_BUILD = b"0730-890adc2"


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
            points.append(NavPoint(entry.title or "Untitled", fid, off, pos, children))
    return points


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
    ncx_records = ncx_index(nav, len(flow0))
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
    exth_records += [(kind, u32(value)) for kind, value in CREATOR] + [(535, CREATOR_BUILD)]
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
```

- [ ] **Step 4: Run them to verify they pass, then the suite**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_writer.py -q && .venv/bin/python -m pytest -q`
Expected: PASS (15 passed), then **232 passed**.

- [ ] **Step 5: Commit**

```bash
git add sidecar/conversion/azw3/writer.py sidecar/tests/test_azw3_writer.py
git commit -m "feat(sidecar): the spike KF8 writer — EPUB to AZW3 in the measured shape, read back before it is written"
```

---

### Task 5: The spike CLI, the oracle, Annex B and the device gate

**Files:**
- Create: `scripts/azw3-spike.py`
- Modify: `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` (append **Annex B**)

**Interfaces:**
- Consumes: `write_azw3` and `Conversion` (Task 4).
- Produces: three converted books plus their cover-cache JPEGs in `/tmp/azw3-gate/`, and Annex B. Slice 2's plan is written from that annex.

- [ ] **Step 1: Write the CLI.** Create `scripts/azw3-spike.py`:

```python
#!/usr/bin/env python3
"""Convert one EPUB to AZW3 with the in-house writer, for the slice 1 device gate.

    sidecar/.venv/bin/python scripts/azw3-spike.py "/path/to/Book.epub" /tmp/azw3-gate

Writes `<title>.azw3` and the device's cover-cache entry
`thumbnail_<EXTH 113>_EBOK_portrait.jpg` (fitted inside 330x500, the size
`docs/invariants/device-transfer.md` records) into the output folder, and prints
the size, the time taken and every warning. Copy the .azw3 into the Kindle's
`documents/` and the .jpg into `system/thumbnails/`. Never touches a device or
the library itself.
"""

import io
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))

from PIL import Image  # noqa: E402

from conversion.azw3.writer import write_azw3  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    source, out_dir = Path(argv[1]), Path(argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    target = out_dir / f"{source.stem}.azw3"
    conversion = write_azw3(str(source), str(target))
    elapsed = time.monotonic() - started
    print(f"{target}: {len(conversion.data):,} B in {elapsed:.2f} s, uuid {conversion.uuid}")
    if conversion.cover is not None:
        image = Image.open(io.BytesIO(conversion.cover)).convert("RGB")
        image.thumbnail((330, 500))
        thumb = out_dir / f"thumbnail_{conversion.uuid}_EBOK_portrait.jpg"
        image.save(thumb, "JPEG", quality=85)
        print(f"{thumb}: {thumb.stat().st_size:,} B at {image.width}x{image.height}")
    else:
        print("no cover: the book declares none, so there is no cover-cache entry to write")
    for warning in conversion.warnings:
        print(f"warning: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 2: Convert the three gate books.** These are EPUB-only library books, picked by measuring 60 at random. *Yellowface* is prose: 34 spine files, 33 TOC entries, 64 links. *Darwin's Devices* has images and notes: 51 images, 507 links. *Raspberry Pi for Secret Agents* has a deep TOC: 148 entries, five levels, 47 images. Copy each off the NAS first and work from the copy.

```bash
mkdir -p /tmp/azw3-gate
cp "/Volumes/books/musaeum/books/f0c7f5e1-f40f-4d2b-a847-82287f729f3c/Yellowface A Novel.epub" \
   "/Volumes/books/musaeum/books/a764fbcf-7788-4347-82fc-f335e5e6ecd6/Darwin's Devices.epub" \
   "/Volumes/books/musaeum/books/34938395-af9b-4df4-8aa2-2b1de765d1c2/Raspberry Pi for Secret Agents.epub" \
   /tmp/azw3-gate/
for f in /tmp/azw3-gate/*.epub; do sidecar/.venv/bin/python scripts/azw3-spike.py "$f" /tmp/azw3-gate/out; done
```

Expected: one `.azw3` and one `thumbnail_<uuid>_EBOK_portrait.jpg` per book, each conversion well under 30 s, and no traceback. The scratch run measured 0.14–0.27 s, 1.0–4.1 MB, and thumbnails of 18–30 KB inside 330×500. Record every warning line; each one is a fidelity gap Annex B lists (spec D4).

- [ ] **Step 3: Check each output with the probe and the oracle.** Calibre is a test oracle only and is used here once (spec §Provenance, rule 4):

```bash
for f in /tmp/azw3-gate/out/*.azw3; do
  sidecar/.venv/bin/python scripts/azw3-probe.py "$f" | head -20
  /Applications/calibre.app/Contents/MacOS/ebook-convert "$f" "${f%.azw3}.roundtrip.epub" > "${f%.azw3}.oracle.log" 2>&1; echo "oracle exit $?"
done
```

Expected: the probe shows `INDX` runs, an `FDST`, `FLIS`, `FCIS` and `EOF`, with no traceback. Every oracle exit is 0. Then compare the words of each source EPUB's **spine** files against the round trip's. The scratch run found them identical: 84,308 / 36,823 / 88,798 words. A word count that drops is a finding. Find which spine file lost it before going on.

- [ ] **Step 4: The device gate (manual, owner).** This needs the Kindle and cannot be done by an agent. With the Oasis connected over USB:
  1. Copy the three `.azw3` files into `documents/`.
  2. Copy the three `thumbnail_…_EBOK_portrait.jpg` files into `system/thumbnails/`. This is the cover-cache entry the device looks up by EXTH 113 and 501 (`docs/invariants/device-transfer.md`). It makes the spec's "shows its cover" reading a test of D3.
  3. Eject. Keep airplane mode on.
  4. For each book, record the five D6 readings: **opens**; **shows its cover** in the library; **jumps to chapters from the TOC** (for *Raspberry Pi*, a third-level entry too); **follows one internal link** (a note or a TOC-page link); and **keeps its reading position** across closing and reopening the book.
  5. Note anything that renders wrong, such as a missing image or broken styling.
  6. Delete the files from the device afterwards.

- [ ] **Step 5: Write Annex B.** Append it to the spec, after Annex A's *Device experiments*. Every structure the writer emits gets a row naming its source. The rows below are known now; fill the right-hand column from Steps 2–4.

```markdown
## Annex B — slice 1b provenance log and the D6 gate (YYYY-MM-DD)

| Structure the writer emits | Source |
| --- | --- |
| Forward varints, CNCX records | MobileRead *MOBI* (variable-width integers); Annex A *CNCX record* |
| INDX header + data records, the four TAGX tables (full form) | Annex A *INDX* rows; rebuilt byte for byte from four real files (16/16 records) |
| Skeleton entries (`SKEL` + 10 digits; count ×2; start/length ×2) | Annex A *Skeleton index* |
| Fragment entries (10-digit insert position; selector, file, sequence, offset/length), one fragment per skeleton | Annex A *Fragment index*; the one-per-skeleton shape is Calibre's most common (*Red Rising*) |
| NCX entries (breadth-first; depth; parent; first/last child; length to the next entry at the same depth or shallower) | Annex A *NCX index*; *Patent*'s three-level TOC rebuilt byte for byte from its tree |
| NCX labels wider than two hex digits | **not measured** — every label is widened alike so the order holds; the gate's 148-entry TOC does not exercise it |
| Guide entries, sorted by type; a `text` entry always present | Annex A *Guide index* (labels `text`, `toc`, `copyright-page` measured) |
| Link targets: `kindle:pos:fid:FFFF:off:OOOOOOOOOO` → the target element's start tag; NCX position = fragment insert position + offset | measured 2026-10-07 on *Red Rising* (5 links, 4 NCX entries checked) |
| `aid` on block elements and every id-bearing element; selector `P-//*[@aid='…']` on the body | Annex A *Text markup* / *Fragment index* |
| ASCII text: numeric character references in markup, `\XXXX ` in CSS | *Lonely Planet Rome* (kindlegen): 6,568 references |
| Compression 1, flags 0, exact 4,096-byte records | *Device experiments* T2 |
| Record 0 words, EXTH 100–106/108/113/125/131/201/203/204–207/501/503/524/535 | Annex A *Record 0* and *EXTH* rows (204–207 + 535 are Calibre's measured values) |
| Pad record; FDST; FLIS; 52-byte FCIS; EOF; record order | Annex A |
| Images ≤ 131,072 B, else re-encoded JPEG | Annex A *Resource records*; measured maximum 130,912 B across nine files |
| Cover-cache JPEG `thumbnail_<113>_<501>_portrait.jpg`, fitted inside 330×500 | `docs/invariants/device-transfer.md` |

**Gate books, converted:** size, time, warnings — per book.

**Oracle:** exit codes and spine word counts — per book.

**D6, on the Oasis:**

| Book | Opens | Cover | TOC (incl. deep entry) | Internal link | Reading position | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| *Yellowface* | | | | | | |
| *Darwin's Devices* | | | | | | |
| *Raspberry Pi for Secret Agents* | | | | | | |

**Verdict:** pass (all fifteen readings) → slices 2–4 are authorised (spec D6) / fail → which reading, on which book, and the owner's decision per D6.
```

- [ ] **Step 6: Commit the CLI and Annex B**

```bash
git add scripts/azw3-spike.py docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md
git commit -m "docs: Annex B — slice 1b provenance and the D6 device gate; the spike CLI"
```

- [ ] **Step 7: Stop and hand back.** Report the D6 table, the warnings, the conversion times against the 30-second target, and the oracle word counts. Slice 2's plan is written from that, not before: promote behind `convert_format`, use the real fixtures, and validate against Calibre as the oracle.

---

## Self-review

- **Spec coverage.**
  - D2 (one module per concern behind the existing RPC) → Tasks 1–4. The RPC wiring is slice 2, deliberately.
  - D3 (title, author, a fresh EXTH 113, 501 `EBOK`, cover, TOC; re-read with the app's offsets) → `build_azw3`'s read-back and `test_the_file_reads_back_through_the_apps_own_offsets`.
  - D4 (warnings, never silence; fonts, SVG and fixed layout out of scope) → `css_flow`'s and `_embed`'s warnings, and `Conversion.warnings`.
  - D5 (no half-written file) → `write_azw3` and `test_a_write_that_fails_leaves_no_file_and_no_temp`.
  - D6 / AC2 → Task 5 Step 4.
  - AC4 → the read-back plus `test_the_header_words_point_at_records_of_the_measured_kinds`.
  - AC5 → the D5 test.
  - AC7 → Annex B (Task 5 Step 5).
  - **Not covered, by design:** AC3, AC6 and AC8 belong to slices 2–3.
- **Placeholders.** None in code. Annex B's `YYYY-MM-DD` and empty result cells are a form the executor fills from Steps 2–4, as in slice 1a's Annex A template.
- **Type consistency.** These names are defined once and used with these names throughout: `Piece`, `NavPoint`, `Cncx`, `build_index`, `skeleton_index`, `fragment_index`, `ncx_index`, `guide_index`, `Epub`, `TocEntry`, `read_epub`, `resolve`, `Resolver`, `Aids`, `Part`, `Link`, `build_part`, `css_flow`, `base32`, `fixed_base32`, `Resources`, `Conversion`, `build_azw3`, `write_azw3`, `fit_image`, `text_records`, `MAX_IMAGE_BYTES`, `read_kf8`, `read_index`, `build_epub`, `xhtml`. The placeholder's 34 bytes match `fixed_base32(fid, 4)` + `fixed_base32(off, 10)` plus the fixed text.
- **Review Focus.** All five lines have a named test in the owning task.
