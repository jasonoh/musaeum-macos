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


class IndexOverflow(ValueError):
    """An index or its string record would not fit one 64 KiB record (the measured shape)."""


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
            raise IndexOverflow("CNCX strings do not fit one record")
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
        raise IndexOverflow("index entries do not fit one data record")
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
