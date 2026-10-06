import struct

import pytest

from conversion.azw3.palmdb import (
    PALMDB_HEADER_BYTES,
    RECORD_COUNT_AT,
    read_records,
    write_palmdb,
)


def test_records_round_trip_in_order_including_an_empty_one():
    records = [b"abc", b"defgh", b"", b"x" * 50]
    assert read_records(write_palmdb("Title", records, now=1)) == records


def test_the_record_count_sits_where_the_apps_reader_looks():
    data = write_palmdb("Title", [b"a", b"b", b"c"], now=1)
    assert len(data) > PALMDB_HEADER_BYTES
    assert struct.unpack_from(">H", data, RECORD_COUNT_AT)[0] == 3
    assert data[60:68] == b"BOOKMOBI"


def test_a_name_outside_latin_1_is_replaced_not_raised():
    data = write_palmdb("日本語のタイトル" * 10, [b"a"], now=1)
    assert len(data[:32]) == 32
    assert data[31] == 0  # always NUL-terminated


def test_a_file_shorter_than_the_header_is_refused():
    with pytest.raises(ValueError):
        read_records(b"short")


def test_a_record_count_the_file_cannot_hold_is_refused():
    data = write_palmdb("T", [b"a", b"b", b"c", b"d"], now=1)
    with pytest.raises(ValueError):
        read_records(data[: PALMDB_HEADER_BYTES + 8])


def test_offsets_that_run_backwards_or_past_the_end_are_refused():
    data = bytearray(write_palmdb("T", [b"aaaa", b"bbbb"], now=1))
    struct.pack_into(">I", data, PALMDB_HEADER_BYTES + 8, 0xFFFFFFF0)  # record 1 starts past EOF
    with pytest.raises(ValueError):
        read_records(bytes(data))


def test_writing_no_records_is_refused():
    with pytest.raises(ValueError):
        write_palmdb("T", [])


from conversion.azw3.exth import build_exth, parse_exth  # noqa: E402
from conversion.azw3.identity import MAX_TITLE_BYTES, read_identity  # noqa: E402


def _record_zero(title: bytes, exth: bytes, header_length: int = 232) -> bytes:
    """Record 0 built with *literal* offsets — not the writer's constants — so a
    drift between writer and reader fails here instead of on a Kindle."""
    exth_at = 0x10 + header_length
    rec0 = bytearray(exth_at + len(exth) + len(title))
    rec0[0x10:0x14] = b"MOBI"
    struct.pack_into(">I", rec0, 0x14, header_length)
    struct.pack_into(">I", rec0, 0x54, exth_at + len(exth))
    struct.pack_into(">I", rec0, 0x58, len(title))
    rec0[exth_at : exth_at + len(exth)] = exth
    rec0[exth_at + len(exth) :] = title
    return bytes(rec0)


def test_exth_round_trips_and_pads_outside_its_declared_length():
    block = build_exth([(100, b"Ann"), (113, b"u-1"), (501, b"EBOK")])
    assert len(block) % 4 == 0
    declared = struct.unpack_from(">I", block, 4)[0]
    assert declared <= len(block)
    assert parse_exth(block) == [(100, b"Ann"), (113, b"u-1"), (501, b"EBOK")]


def test_parse_exth_refuses_a_block_without_the_magic():
    with pytest.raises(ValueError):
        parse_exth(b"NOPE" + bytes(20))


def test_identity_reads_title_author_uuid_and_cdetype():
    exth = build_exth([(100, "Ünï Author".encode()), (113, b"uuid-1"), (501, b"EBOK")])
    data = write_palmdb("t", [_record_zero("Ünï Title".encode(), exth), b"text"])
    identity = read_identity(data)
    assert identity is not None
    assert (identity.title, identity.author, identity.uuid, identity.cdetype) == (
        "Ünï Title", "Ünï Author", "uuid-1", "EBOK",
    )


@pytest.mark.parametrize("header_length", [232, 248, 256, 264])
def test_exth_is_found_after_whatever_header_length_the_file_declares(header_length):
    exth = build_exth([(100, b"Ann")])
    data = write_palmdb("t", [_record_zero(b"Title", exth, header_length), b"text"])
    assert read_identity(data).author == "Ann"


def test_a_title_of_1024_bytes_is_unreadable_to_the_app():
    data = write_palmdb("t", [_record_zero(b"x" * MAX_TITLE_BYTES, build_exth([])), b"text"])
    assert read_identity(data).title is None


def test_a_file_with_one_record_is_not_a_book_to_the_app():
    data = write_palmdb("t", [_record_zero(b"Title", build_exth([]))])
    assert read_identity(data) is None


def test_a_file_that_is_not_mobi_is_none_not_an_error():
    assert read_identity(b"short") is None
    assert read_identity(write_palmdb("t", [b"\0" * 300, b"x"])) is None
