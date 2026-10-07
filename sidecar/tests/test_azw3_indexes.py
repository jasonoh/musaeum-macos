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
