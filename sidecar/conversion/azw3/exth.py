"""EXTH: the metadata block that follows the MOBI header in record 0."""

import struct

EXTH_HEADER_BYTES = 12
EXTH_RECORD_HEADER_BYTES = 8


def build_exth(records: list[tuple[int, bytes]]) -> bytes:
    """An EXTH block, padded with NULs to a 4-byte boundary (the pad is outside its length)."""
    body = b"".join(
        struct.pack(">II", kind, EXTH_RECORD_HEADER_BYTES + len(value)) + value
        for kind, value in records
    )
    length = EXTH_HEADER_BYTES + len(body)
    return b"EXTH" + struct.pack(">II", length, len(records)) + body + b"\0" * (-length % 4)


def parse_exth(block: bytes) -> list[tuple[int, bytes]]:
    """The (type, payload) pairs of an EXTH block, in file order."""
    if block[:4] != b"EXTH" or len(block) < EXTH_HEADER_BYTES:
        raise ValueError("not an EXTH block")
    length, count = struct.unpack_from(">II", block, 4)
    end = min(length, len(block))
    records, at = [], EXTH_HEADER_BYTES
    for _ in range(count):
        if at + EXTH_RECORD_HEADER_BYTES > end:
            break
        kind, size = struct.unpack_from(">II", block, at)
        if size < EXTH_RECORD_HEADER_BYTES:
            break
        records.append((kind, block[at + EXTH_RECORD_HEADER_BYTES : min(at + size, end)]))
        at += size
    return records
