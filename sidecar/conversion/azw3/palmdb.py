"""PalmDB container: the record table every .mobi/.azw3 file is wrapped in."""

import struct
import time

PALMDB_HEADER_BYTES = 78
RECORD_TABLE_ENTRY_BYTES = 8
RECORD_COUNT_AT = 76
NAME_BYTES = 32


def read_records(data: bytes) -> list[bytes]:
    """Split a PalmDB file into its records, sized from the record table."""
    if len(data) < PALMDB_HEADER_BYTES:
        raise ValueError("file is shorter than a PalmDB header")
    (count,) = struct.unpack_from(">H", data, RECORD_COUNT_AT)
    table_end = PALMDB_HEADER_BYTES + count * RECORD_TABLE_ENTRY_BYTES
    if count == 0 or len(data) < table_end:
        raise ValueError("record table is missing or truncated")
    offsets = [
        struct.unpack_from(">I", data, PALMDB_HEADER_BYTES + i * RECORD_TABLE_ENTRY_BYTES)[0]
        for i in range(count)
    ]
    ends = offsets[1:] + [len(data)]
    previous = table_end
    for start, end in zip(offsets, ends):
        if start < previous or end < start or end > len(data):
            raise ValueError("record offsets are out of order or past the end of the file")
        previous = start
    return [data[start:end] for start, end in zip(offsets, ends)]


def write_palmdb(name: str, records: list[bytes], now: int | None = None) -> bytes:
    """A PalmDB file of type BOOK / creator MOBI holding `records` in order."""
    if not records:
        raise ValueError("a PalmDB file needs at least one record")
    stamp = int(time.time()) if now is None else now
    # The database name is a 32-byte NUL-padded Latin-1 field; the real title
    # lives in record 0, so this one is only ever a label.
    label = name.encode("latin-1", "replace")[: NAME_BYTES - 1].ljust(NAME_BYTES, b"\0")
    header = label + struct.pack(
        ">HH" + "I" * 10 + "H",
        0, 0,  # attributes, version
        stamp, stamp, 0,  # created, modified, last backup
        0, 0, 0,  # modification number, app info, sort info
        int.from_bytes(b"BOOK", "big"),
        int.from_bytes(b"MOBI", "big"),
        2 * len(records) - 1,  # unique id seed
        0,  # next record list
        len(records),
    )
    assert len(header) == PALMDB_HEADER_BYTES, len(header)
    table_end = PALMDB_HEADER_BYTES + len(records) * RECORD_TABLE_ENTRY_BYTES + 2
    offsets, at = [], table_end
    for record in records:
        offsets.append(at)
        at += len(record)
    table = b"".join(
        struct.pack(">IBBH", offset, 0, 0, 2 * i)  # offset, attributes, 3-byte unique id
        for i, offset in enumerate(offsets)
    )
    return header + table + b"\0\0" + b"".join(records)
