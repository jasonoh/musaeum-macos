"""Child-process entry for `convert_format`: `python -m conversion.azw3.run INPUT OUTPUT`.

The conversion runs outside the long-lived sidecar so a large book's memory goes
back to the OS when it finishes, the sidecar's other threads keep the GIL, and a
runaway conversion can be killed. On success it prints one JSON line
(`size_bytes`, `warnings`); on failure it prints `error: <reason>` to stderr and
exits 1. Nothing is left at OUTPUT or OUTPUT.tmp on failure (spec D5).
"""

import json
import os
import sys

from conversion.azw3.writer import write_azw3


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("error: usage: run INPUT OUTPUT", file=sys.stderr)
        return 2
    try:
        conversion = write_azw3(argv[1], argv[2])
    except Exception as exc:  # noqa: BLE001 — every reason crosses the process boundary as text
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"size_bytes": os.path.getsize(argv[2]), "warnings": conversion.warnings}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
