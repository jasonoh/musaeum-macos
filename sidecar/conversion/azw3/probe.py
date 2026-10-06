"""Read-only description of a real .mobi/.azw3's structure, for the provenance annex."""

import struct

from .exth import parse_exth
from .palmdb import read_records

# What a record's leading bytes say it is. Observed, not documented: the
# annex records which of these a given file actually contains.
SIGNATURES = [
    (b"INDX", "INDX"), (b"FDST", "FDST"), (b"FLIS", "FLIS"), (b"FCIS", "FCIS"),
    (b"SRCS", "SRCS"), (b"CMET", "CMET"), (b"BOUNDARY", "BOUNDARY"),
    (b"\xe9\x8e\r\n", "EOF"), (b"\xff\xd8\xff", "JPEG"), (b"\x89PNG", "PNG"),
    (b"GIF8", "GIF"), (b"FONT", "FONT"), (b"RESC", "RESC"), (b"CRES", "CRES"),
]


def classify(record: bytes) -> str:
    for prefix, name in SIGNATURES:
        if record.startswith(prefix):
            return name
    return "data"


def describe(data: bytes) -> list[str]:
    """Lines describing the record table, record 0's header words, EXTH and every INDX."""
    records = read_records(data)
    lines = [f"{len(records)} records, {len(data)} bytes"]
    run_start, run_kind = 0, classify(records[0])
    for i in range(1, len(records) + 1):
        kind = classify(records[i]) if i < len(records) else None
        if kind != run_kind:
            lines.append(f"  records {run_start}..{i - 1}: {run_kind}")
            run_start, run_kind = i, kind
    lines += _describe_record_zero(records[0])
    for i, record in enumerate(records):
        if record.startswith(b"INDX"):
            lines += _describe_indx(i, record)
    return lines


def _describe_record_zero(rec0: bytes) -> list[str]:
    lines = ["record 0:"]
    (header_length,) = struct.unpack_from(">I", rec0, 0x14)
    lines.append(f"  header length {header_length}; every u32 word of the MOBI header:")
    for at in range(0x10, min(0x10 + header_length, len(rec0) - 3), 4):
        (word,) = struct.unpack_from(">I", rec0, at)
        lines.append(f"    +{at:#04x} {word:#010x} ({word})")
    exth_at = 0x10 + header_length
    if rec0[exth_at : exth_at + 4] == b"EXTH":
        lines.append("  EXTH:")
        for kind, value in parse_exth(rec0[exth_at:]):
            shown = value.decode("utf-8") if value.isascii() and len(value) < 80 else value[:24].hex()
            lines.append(f"    {kind}: {shown!r} ({len(value)} bytes)")
    return lines


def _describe_indx(number: int, rec: bytes) -> list[str]:
    words = struct.unpack_from(">" + "I" * min(len(rec) // 4, 48), rec, 0)
    lines = [f"INDX record {number} ({len(rec)} bytes); header words:"]
    lines += [f"    +{i * 4:#04x} {w:#010x} ({w})" for i, w in enumerate(words[1:], start=1)]
    (header_length,) = struct.unpack_from(">I", rec, 4)
    if rec[header_length : header_length + 4] == b"TAGX":
        tagx_length, control_bytes = struct.unpack_from(">II", rec, header_length + 4)
        lines.append(f"  TAGX: {control_bytes} control byte(s); (tag, values, mask, end):")
        for at in range(header_length + 12, header_length + tagx_length, 4):
            lines.append(f"    {tuple(rec[at : at + 4])}")
    return lines
