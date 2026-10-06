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
