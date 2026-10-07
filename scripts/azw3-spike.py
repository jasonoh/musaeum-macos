#!/usr/bin/env python3
"""Convert one EPUB to AZW3 with the in-house writer, for the slice 1 device gate.

    sidecar/.venv/bin/python scripts/azw3-spike.py "/path/to/Book.epub" /tmp/azw3-gate

Writes `<title>.azw3` and the device's cover-cache entry
`thumbnail_<EXTH 113>_EBOK_portrait.jpg` (fitted inside 330x500, the size
`docs/invariants/device-transfer.md` records) into the output folder, and prints
the size, the time taken and every warning. Copy the .azw3 into the Kindle's
`documents/` and the .jpg into `system/thumbnails/`. Never touches a device or
the library itself.
"""

import io
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))

from PIL import Image  # noqa: E402

from conversion.azw3.writer import write_azw3  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    source, out_dir = Path(argv[1]), Path(argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    target = out_dir / f"{source.stem}.azw3"
    conversion = write_azw3(str(source), str(target))
    elapsed = time.monotonic() - started
    print(f"{target}: {len(conversion.data):,} B in {elapsed:.2f} s, uuid {conversion.uuid}")
    if conversion.cover is not None:
        image = Image.open(io.BytesIO(conversion.cover)).convert("RGB")
        image.thumbnail((330, 500))
        thumb = out_dir / f"thumbnail_{conversion.uuid}_EBOK_portrait.jpg"
        image.save(thumb, "JPEG", quality=85)
        print(f"{thumb}: {thumb.stat().st_size:,} B at {image.width}x{image.height}")
    else:
        print("no cover: the book declares none, so there is no cover-cache entry to write")
    for warning in conversion.warnings:
        print(f"warning: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
