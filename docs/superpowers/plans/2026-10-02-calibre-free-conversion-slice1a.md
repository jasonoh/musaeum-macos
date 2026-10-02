# Calibre-free conversion — slice 1a (gate, container, measurement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settle whether the Oasis needs a converter at all (D1), build the PalmDB/EXTH container code and the reader-compatible identity check the writer will rely on, and measure the KF8 index structures from real files so the rest of slice 1 can be planned from evidence.

**Architecture:** A new package `sidecar/conversion/azw3/` holds one small module per concern (`palmdb`, `exth`, `identity`, `probe`). Nothing is wired into `convert_format` yet — `sidecar/conversion/converter.py` and `sidecar/main.py` are untouched until slice 2. The probe is read-only and describes real files; its output is the input to the provenance annex.

**Tech Stack:** Python 3.12 standard library only (`struct`, `time`, `dataclasses`), pytest 9.1.1. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` (status: *Draft for review — not signed off*; this plan is slice 1 of it, split in two — see "Why this plan stops where it does").

## Global Constraints

- **Provenance rule (spec §Provenance):** allowed sources are the MobileRead wiki, the device-presence spec appendix, `electron/main/services/mobi-header.ts`, and the **bytes of real files**. **Do not read** Calibre's or KindleUnpack's source, or any other GPL implementation. Their *output* and *behaviour* are fair game.
- **A structure with no annex entry does not ship** (spec §Provenance, rule 3). Every structure a task emits gets a row in Annex A (Task 5) naming its source.
- **No new dependency.** `sidecar/requirements.txt` does not change.
- **Calibre is a test oracle only**, never a dependency of `npm test` or `pytest` (spec §Provenance, rule 4).
- **Nothing may read `formats[0]`; no `any` types; Markdown prose is not hard-wrapped** (`CLAUDE.md`).
- `convert_format`'s signature, `sidecar/main.py` and everything under `electron/` and `src/` are **out of scope for this plan** — slice 3 owns them.
- Two consecutive failed repairs on the same test → stop and hand back (`CLAUDE.md` §Escalate).
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Run `/verify` immediately before any commit that is not docs-only or tests-only (repo rule).

## Review Focus

Inputs the spec implies but its slices do not test, most likely first. Each has a pinning test in the task that owns the code.

1. **A title of 1,024 bytes or more.** `mobi-header.ts` treats it as unreadable (`MAX_TITLE_BYTES`), so a writer that embeds a long title silently produces a file the app cannot match. Pinned in Task 4 (`identity` returns `None` for it, which is what a writer must avoid).
2. **A non-Latin-1 title in the PalmDB name field.** The name is a 32-byte Latin-1 label; encoding must replace, not raise. Pinned in Task 3.
3. **A truncated or lying record table** (count says 4, file ends at 2; offsets out of order). Must raise `ValueError`, never `struct.error`/`IndexError`. Pinned in Task 3.
4. **EXTH values that are NUL-padded and EXTH blocks whose length is not a multiple of 4.** The block is padded outside its declared length. Pinned in Task 4.
5. **A file with one record.** The app's reader needs record 1 to size record 0, so a one-record file is "not a MOBI book" — the writer's output check must refuse it. Pinned in Task 4.

---

## Why this plan stops where it does

The spec's slice 1 ends in a throwaway KF8 writer for three EPUBs. Its hard part — the skeleton, fragment and NCX index tables — has **no allowed written source**: the MobileRead MOBI page documents the PalmDOC header, MOBI header fields up to offset 0xf8, EXTH, the generic INDX/TAGX layout, FLIS/FCIS/SRCS and the EOF record, and the MobileRead KF8 page documents none of the KF8 internals (checked 2026-10-02; it points to KindleUnpack, which the provenance rule forbids reading). The only allowed source for those structures is **measuring real files** — which is what Task 5 does. Writing byte-level tasks for index tables now would be inventing them.

So: this plan covers D1, the container code, and the measurement. **When Task 5's annex is complete, a second plan (slice 1b) is written from it**: text records and compression, resource records, the three index tables, the spike driver and the device gate (D6). That is a plan boundary, not a hidden TODO — slice 1b's content *is* Task 5's output.

## File Structure

| File | Responsibility |
| --- | --- |
| `sidecar/conversion/azw3/__init__.py` | Package marker (empty). |
| `sidecar/conversion/azw3/palmdb.py` | `read_records`, `write_palmdb` — the record table every file is wrapped in. |
| `sidecar/conversion/azw3/exth.py` | `build_exth`, `parse_exth` — the metadata block. |
| `sidecar/conversion/azw3/identity.py` | `read_identity` — Python mirror of `mobi-header.ts`; the D3 check. Literal constants, deliberately not shared with the writer. |
| `sidecar/conversion/azw3/probe.py` | `describe` — read-only structural description of a real file. |
| `scripts/azw3-probe.py` | CLI over `describe` for the annex measurements. |
| `sidecar/tests/test_azw3_container.py` | palmdb + exth + identity tests. |
| `sidecar/tests/test_azw3_probe.py` | probe test on a synthetic file. |
| `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` | Gains **Annex A** (Task 5) and the D1 result (Task 1). |

Four modules plus `__init__` — the spec's budget for `sidecar/conversion/` is "≤4"; the probe is read-only tooling that slice 2 may drop.

---

### Task 1: D1 — does the Oasis open an EPUB natively? (manual, owner)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` (record the result under *Open questions*, item 1)

**Interfaces:**
- Consumes: nothing.
- Produces: the D1 result, which gates every later task (AC1). **No writer code is written before this is recorded.**

This task needs the physical device and cannot be done by an agent.

- [ ] **Step 1: Pick one small EPUB** from the library (any book that is EPUB-only) and copy it into the Kindle's `documents/` folder over USB. Eject the Kindle properly.
- [ ] **Step 2: Look for it** in the Oasis's library, with airplane mode on, as normal. Try to open it.
- [ ] **Step 3: Record the result** under *Open questions for review*, item 1 of the spec, as one line: `**Result (YYYY-MM-DD):** listed and opened / listed, would not open / not listed.`
- [ ] **Step 4: Decide.**
  - *Listed and opens:* stop this plan. The design collapses to "delete the call" (spec D1) — slice 3 only, re-planned.
  - *Anything else:* continue to Task 2.
- [ ] **Step 5: Remove the test EPUB from the device**, then commit the one-line spec edit:

```bash
git add docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md
git commit -m "docs: record D1 — native EPUB on the Oasis"
```

(The spec file is currently untracked; this commit adds it. If you want the spec committed on its own first, do that instead and make this a second commit.)

---

### Task 2: Python test environment

**Files:**
- Create: none in the repo (`sidecar/.venv` is git-ignored — confirm with `git check-ignore sidecar/.venv`).

**Interfaces:**
- Consumes: nothing.
- Produces: `sidecar/.venv/bin/python -m pytest` runnable from `sidecar/`. Later tasks use exactly that command.

Measured 2026-10-02: there is **no `sidecar/.venv` on this machine**; system `python3.12` has neither `lxml` nor `pytest`.

- [ ] **Step 1: Create the venv per the dev quickstart**

Run:
```bash
cd /Users/jasonoh/Projects/musaeum-macos
python3.12 -m venv sidecar/.venv
sidecar/.venv/bin/pip install -r sidecar/requirements.txt -r sidecar/requirements-dev.txt
git check-ignore sidecar/.venv
```
Expected: installs cleanly; `git check-ignore` prints `sidecar/.venv`.

- [ ] **Step 2: Run the existing suite for a baseline**

Run: `cd sidecar && .venv/bin/python -m pytest -q`
Expected: PASS. Note the passed count — Task 3 and 4 must leave it at that count plus the new tests. If anything fails here, it is not this plan's fault: stop and report which tests, don't fix them.

---

### Task 3: PalmDB container

**Files:**
- Create: `sidecar/conversion/azw3/__init__.py` (empty), `sidecar/conversion/azw3/palmdb.py`
- Test: `sidecar/tests/test_azw3_container.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `read_records(data: bytes) -> list[bytes]` — records sized from the table; raises `ValueError` on any malformed table.
  - `write_palmdb(name: str, records: list[bytes], now: int | None = None) -> bytes` — a type `BOOK` / creator `MOBI` file.
  - Constants `PALMDB_HEADER_BYTES = 78`, `RECORD_TABLE_ENTRY_BYTES = 8`, `RECORD_COUNT_AT = 76`.

The 78-byte header layout, the 8-byte record entries and the `BOOK`/`MOBI` type and creator are the standard Palm database format (MobileRead wiki, *PDB*) and the device-presence spec appendix (record count at 76, table at 78). **Annex A row to write in Task 5:** confirm each field against a real file's first 100 bytes before the writer ships — in particular the 2-byte gap after the table, the unique-id seed, and the attribute/id bytes, which this task writes from the standard layout rather than from a measurement.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_azw3_container.py`:

```python
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_container.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'conversion.azw3'`.

- [ ] **Step 3: Write the implementation**

Create an empty `sidecar/conversion/azw3/__init__.py`, then `sidecar/conversion/azw3/palmdb.py`:

```python
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_container.py -q`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add sidecar/conversion/azw3/__init__.py sidecar/conversion/azw3/palmdb.py sidecar/tests/test_azw3_container.py
git commit -m "feat(sidecar): PalmDB container reader and writer for the AZW3 spike"
```

---

### Task 4: EXTH block and the app-compatible identity check

**Files:**
- Create: `sidecar/conversion/azw3/exth.py`, `sidecar/conversion/azw3/identity.py`
- Modify: `sidecar/tests/test_azw3_container.py` (append)

**Interfaces:**
- Consumes: `read_records` from Task 3.
- Produces:
  - `build_exth(records: list[tuple[int, bytes]]) -> bytes` — EXTH block, NUL-padded to 4 bytes outside its declared length.
  - `parse_exth(block: bytes) -> list[tuple[int, bytes]]` — `(type, payload)` in file order; raises `ValueError` if the magic is wrong.
  - `Identity(title, author, uuid, cdetype)` dataclass of `str | None`, and `read_identity(data: bytes) -> Identity | None` — `None` for "not a MOBI book".
  - Constants in `identity.py` are **literal** (`0x54`, `0x58`, `100`, `113`, `501`, `1024`) and must stay in step with `electron/main/services/mobi-header.ts`. They are not imported from any writer module — that independence is the check.

**Annex A rows to write in Task 5:** EXTH layout (MobileRead *MOBI*, EXTH section: `"EXTH"`, `u32` length excluding the pad, `u32` count, records of `u32` type + `u32` length including both fields + payload); types 100/113/501 (the same page, and `mobi-header.ts` for why 113 and 501 matter). Record-0 field offsets (device-presence spec appendix).

- [ ] **Step 1: Write the failing tests** — append to `sidecar/tests/test_azw3_container.py`:

```python
from conversion.azw3.exth import build_exth, parse_exth
from conversion.azw3.identity import MAX_TITLE_BYTES, read_identity


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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_container.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'conversion.azw3.exth'`.

- [ ] **Step 3: Write the implementation**

`sidecar/conversion/azw3/exth.py`:

```python
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
    if block[:4] != b"EXTH":
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
```

`sidecar/conversion/azw3/identity.py`:

```python
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_container.py -q`
Expected: PASS (7 from Task 3 + 10 new = 17 passed).

- [ ] **Step 5: Run the whole sidecar suite**

Run: `cd sidecar && .venv/bin/python -m pytest -q`
Expected: PASS — Task 2's baseline count plus 17.

- [ ] **Step 6: Commit**

```bash
git add sidecar/conversion/azw3/exth.py sidecar/conversion/azw3/identity.py sidecar/tests/test_azw3_container.py
git commit -m "feat(sidecar): EXTH block and the app-compatible identity check for the AZW3 spike"
```

---

### Task 5: The probe, and the measurement that writes slice 1b

**Files:**
- Create: `sidecar/conversion/azw3/probe.py`, `scripts/azw3-probe.py`, `sidecar/tests/test_azw3_probe.py`
- Modify: `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` (append **Annex A**)

**Interfaces:**
- Consumes: `read_records` (Task 3), `parse_exth` (Task 4).
- Produces: `describe(data: bytes) -> list[str]`; Annex A, which slice 1b's plan is written from.

- [ ] **Step 1: Write the failing test** — `sidecar/tests/test_azw3_probe.py`:

```python
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_probe.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'conversion.azw3.probe'`.

- [ ] **Step 3: Write the implementation**

`sidecar/conversion/azw3/probe.py`:

```python
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
```

`scripts/azw3-probe.py`:

```python
#!/usr/bin/env python3
"""Describe the structure of a real .azw3/.mobi file, read-only.

    sidecar/.venv/bin/python scripts/azw3-probe.py "/path/to/Book.azw3" > /tmp/book.probe.txt

Prints the record-type runs (which records are text, images, INDX, FDST, ...),
every u32 word of record 0's MOBI header, the EXTH records, and each INDX
record's header words and TAGX table. Reads one file, writes nothing, and never
touches a device — the output is what Annex A of
`docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` is built from.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))

from conversion.azw3.probe import describe  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    print("\n".join(describe(Path(argv[1]).read_bytes())))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 4: Run to verify the test passes, then the suite**

Run: `cd sidecar && .venv/bin/python -m pytest -q`
Expected: PASS (baseline + 17 + 2).

- [ ] **Step 5: Commit the probe**

```bash
git add sidecar/conversion/azw3/probe.py scripts/azw3-probe.py sidecar/tests/test_azw3_probe.py
git commit -m "feat(sidecar): read-only AZW3 structure probe for the provenance annex"
```

- [ ] **Step 6: Choose three reference files** from the library: three `.azw3` files (not `.mobi`) that open on the owner's Oasis and that were **not produced by Musaeum's own conversion** — one short prose book, one with images and footnotes, one with a deep TOC. (The library is at `/Volumes/books/library`; a NAS `find` over the whole tree is slow — measured: it did not finish in 2 minutes — so pick from the app's own book list or query `musaeum.db`, then copy the three files to `/tmp/azw3-ref/` and work from the copies.)

- [ ] **Step 7: Probe each one**

Run, for each file:
```bash
sidecar/.venv/bin/python scripts/azw3-probe.py "/tmp/azw3-ref/<file>.azw3" > "/tmp/azw3-ref/<file>.probe.txt"
```
Expected: a description, no traceback. If `read_records` raises on a real file, **that is a finding** — the container assumptions in Task 3 are wrong; record it and fix Task 3 before going on.

- [ ] **Step 8: Write Annex A** — append to the spec a section with this shape, filled from the probe output and the wiki. Every row names its source; a structure with no row does not ship.

```markdown
## Annex A — slice 1 provenance log (measured YYYY-MM-DD)

**Reference files:** three real `.azw3`, described by `scripts/azw3-probe.py`; sizes and record counts: …

| Structure | Where it is | Fields | Source (wiki section, or file + offset) | Confirmed against real file? |
| --- | --- | --- | --- | --- |
| PalmDB header and record table | bytes 0–77, then 8-byte entries | … incl. the 2-byte gap, id bytes | MobileRead *PDB*; measured | yes/no |
| Record 0: PalmDOC + MOBI header | … | every word the probe printed, with its value in each file | MobileRead *MOBI* to 0xf8; **measured** beyond | |
| EXTH | … | the types present in each file and their payload format | MobileRead *MOBI* EXTH; measured | |
| KF8 boundary / joint-file layout | | Is it joint (KF7+KF8) or KF8-only? where does KF8 begin? | **measured only** | |
| Text records | | compression value, record size, trailing-entry flags, how many records | measured | |
| FDST | | | measured | |
| Skeleton / fragment / NCX / guide INDX | | header words, TAGX tags + masks, entry layout | measured | |
| Resource (image) records | | first-image index, cover record | measured | |
| FLIS / FCIS / SRCS / EOF | | | MobileRead *MOBI* magic records; measured | |
```

Questions the annex must answer, because slice 1b is written from them:

1. Are the reference files **joint** (a MOBI 6 section, a `BOUNDARY` record, then KF8) or **KF8-only**? Which does the Oasis need? (The spec does not say; the three files are the only evidence this plan has, so say how many of each you saw.)
2. Which MOBI-header words beyond 0xf8 point at the FDST, skeleton, fragment, NCX and guide indexes, and the first image — and what do the other words hold?
3. For each INDX: the tag table, the control-byte meaning, and how entries are encoded (variable-width integers, label strings), derived by decoding the probe's raw bytes against known book structure (e.g. the TOC titles you can see in the Oasis).
4. Which text compression do the files use, and does the Oasis accept **uncompressed** (compression = 1, which `test/helpers/mobi.ts` already writes) — the spike's cheapest option if so? This needs a one-record experiment on the device, noted as a manual step in slice 1b.
5. **Would a MOBI 6 (KF7) file suffice?** It has simpler indexes, and the library holds `.mobi` files that open on the Oasis. The spec chose AZW3; if the measurement shows KF8's indexes are the dominant cost, this is a **design decision for the owner** (spec D2/D6), not an implementation detail — report it, don't decide it.

- [ ] **Step 9: Commit the annex**

```bash
git add docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md
git commit -m "docs: Annex A — measured AZW3 structure from three real files"
```

- [ ] **Step 10: Stop and hand back.** Report: the D1 result, whether Task 3's container assumptions held on real files, and the answers to the five questions. Slice 1b's plan (text records, resources, index tables, spike driver, D6 device gate) is written from that — not before.

---

## Self-review

- **Spec coverage.** D1 → Task 1. D3's "writer re-reads its output with the app's offsets" → Task 4 (`identity.py`; wired into the writer in slice 1b/2). AC1 → Task 1 ordering. AC7 and the provenance rule → Global Constraints + Task 5 Annex A. Slice 1's "sidecar/conversion ≤4, probe script, annex" → file table. **Not covered, deliberately:** the spike writer itself, D6's device gate, AC2 — they depend on Task 5's output (see "Why this plan stops where it does"). AC3–AC8 belong to slices 2–4.
- **Placeholders.** The annex template contains `…` and `YYYY-MM-DD` because it is a form the executor fills from measurements; every code step is complete. The slice-1b boundary is stated in the open, not hidden.
- **Type consistency.** `read_records`, `write_palmdb`, `build_exth`, `parse_exth`, `read_identity`, `Identity`, `describe`, `classify`, `MAX_TITLE_BYTES` are defined once and used with those names throughout. The module code above was smoke-run on system Python 3.12 (one struct-format bug caught and fixed) before being written here; the pytest suites themselves have not been run, since the venv does not exist yet (Task 2).
- **Review Focus.** All five lines have a named test: 1 → `test_a_title_of_1024_bytes_is_unreadable_to_the_app`; 2 → `test_a_name_outside_latin_1_is_replaced_not_raised`; 3 → the three `ValueError` tests in Task 3; 4 → `test_exth_round_trips_and_pads_outside_its_declared_length`; 5 → `test_a_file_with_one_record_is_not_a_book_to_the_app`.
