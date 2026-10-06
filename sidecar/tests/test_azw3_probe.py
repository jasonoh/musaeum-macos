import struct

from conversion.azw3.palmdb import write_palmdb
from conversion.azw3.probe import classify, describe


def _synthetic_file() -> bytes:
    rec0 = bytearray(300)
    rec0[0x10:0x14] = b"MOBI"
    struct.pack_into(">I", rec0, 0x14, 232)
    indx = b"INDX" + struct.pack(">I", 192) + bytes(184)  # 192-byte INDX header
    indx += b"TAGX" + struct.pack(">II", 16, 1) + bytes([1, 1, 1, 0, 0, 0, 0, 1])
    return write_palmdb("t", [bytes(rec0), b"\xff\xd8\xff.", b"\xff\xd8\xff.", indx])


def test_classify_names_the_records_the_annex_cares_about():
    assert classify(b"INDX....") == "INDX"
    assert classify(b"\xff\xd8\xff\xe0") == "JPEG"
    assert classify(b"BOUNDARY") == "BOUNDARY"
    assert classify(b"plain text") == "data"


def test_describe_summarises_runs_and_dumps_header_words_and_tagx():
    lines = describe(_synthetic_file())
    assert lines[0] == "4 records, " + str(len(_synthetic_file())) + " bytes"
    assert "  records 1..2: JPEG" in lines
    assert "  records 3..3: INDX" in lines
    assert any("every u32 word of the MOBI header" in line for line in lines)
    assert any(line.startswith("INDX record 3") for line in lines)
    assert any("TAGX: 1 control byte(s)" in line for line in lines)
    assert "    (1, 1, 1, 0)" in lines
