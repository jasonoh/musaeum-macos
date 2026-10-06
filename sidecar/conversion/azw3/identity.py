"""What a .mobi/.azw3 says about itself — a Python mirror of `mobi-header.ts`.

This is the check D3 relies on: a written file must be readable by the same
offsets the app reads real files with. Keep the constants literal and in step
with `electron/main/services/mobi-header.ts`, not imported from the writer.
"""

import struct
from dataclasses import dataclass

from .palmdb import read_records

MOBI_MAGIC_AT = 0x10
MOBI_HEADER_LENGTH_AT = 0x14
FULL_TITLE_OFFSET_AT = 0x54
FULL_TITLE_LENGTH_AT = 0x58
EXTH_AUTHOR, EXTH_UUID, EXTH_CDETYPE = 100, 113, 501
MAX_TITLE_BYTES = 1024  # the reader treats a longer title as unreadable


@dataclass
class Identity:
    title: str | None
    author: str | None
    uuid: str | None
    cdetype: str | None


def read_identity(data: bytes) -> Identity | None:
    """The identity in a whole file, or None when it is not a MOBI book."""
    try:
        records = read_records(data)
    except ValueError:
        return None
    if len(records) < 2:  # record 0's length is the distance to record 1
        return None
    rec0 = records[0]
    if rec0[MOBI_MAGIC_AT : MOBI_MAGIC_AT + 4] != b"MOBI":
        return None
    (header_length,) = struct.unpack_from(">I", rec0, MOBI_HEADER_LENGTH_AT)
    exth = _exth_values(rec0, MOBI_MAGIC_AT + header_length)
    return Identity(
        title=_full_title(rec0),
        author=exth.get(EXTH_AUTHOR),
        uuid=exth.get(EXTH_UUID),
        cdetype=exth.get(EXTH_CDETYPE),
    )


def _full_title(rec0: bytes) -> str | None:
    if len(rec0) < FULL_TITLE_LENGTH_AT + 4:
        return None
    (offset,) = struct.unpack_from(">I", rec0, FULL_TITLE_OFFSET_AT)
    (length,) = struct.unpack_from(">I", rec0, FULL_TITLE_LENGTH_AT)
    if length == 0 or length >= MAX_TITLE_BYTES or offset + length > len(rec0):
        return None
    return rec0[offset : offset + length].decode("utf-8", "replace")


def _exth_values(rec0: bytes, at: int) -> dict[int, str]:
    values: dict[int, str] = {}
    if len(rec0) < at + 12 or rec0[at : at + 4] != b"EXTH":
        return values
    length, count = struct.unpack_from(">II", rec0, at + 4)
    end = min(at + length, len(rec0))
    p = at + 12
    for _ in range(count):
        if p + 8 > end:
            break
        kind, size = struct.unpack_from(">II", rec0, p)
        if size < 8:
            break
        if kind in (EXTH_AUTHOR, EXTH_UUID, EXTH_CDETYPE):
            values[kind] = rec0[p + 8 : min(p + size, len(rec0))].decode("utf-8", "replace")
        p += size
    return values
