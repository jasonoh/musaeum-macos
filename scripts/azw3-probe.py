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
