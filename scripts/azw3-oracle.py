#!/usr/bin/env python3
"""Check the in-house EPUB → AZW3 writer against Calibre, as an oracle, once.

    sidecar/.venv/bin/python scripts/azw3-oracle.py "/path/A.epub" "/path/B.epub" ...

For each EPUB: convert it with `convert_format`, convert the result back to EPUB
with Calibre's `ebook-convert`, and compare the words of the source's reading-order
files with the round trip's. A word the round trip lacks (or invents) is a finding.
A DRM-encrypted book is reported as refused, which is the correct outcome. Calibre
is used as a tool here and nowhere else: this script is never part of `npm test` or
`pytest` (spec §Provenance, rule 4). Reads the EPUBs, writes only under a temp dir.
"""

import collections
import html
import re
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))

from conversion.azw3.epub import read_epub  # noqa: E402
from conversion.azw3.markup import _decode  # noqa: E402
from conversion.converter import convert_format  # noqa: E402

CALIBRE = "/Applications/calibre.app/Contents/MacOS/ebook-convert"
MARKUP = (".html", ".xhtml", ".htm")


def words(names: list[str], read) -> list[str]:
    out: list[str] = []
    for name in names:
        text = re.sub(r"^\s*<\?xml[^>]*\?>", "", _decode(read(name)).lstrip("\ufeff"))
        text = re.sub(r"(?s)<head.*?</head>", " ", text)
        out += html.unescape(re.sub(r"<[^>]+>", " ", text)).split()
    return out


def check(epub: Path, work: Path) -> str:
    started = time.monotonic()
    azw3 = work / f"{epub.stem}.azw3"
    try:
        report = convert_format(str(epub), str(azw3))
    except RuntimeError as error:
        return f"refused: {error}" if "encrypted" in str(error) else f"FAILED: {error}"
    took = time.monotonic() - started
    back = work / f"{epub.stem}.roundtrip.epub"
    run = subprocess.run([CALIBRE, str(azw3), str(back)], capture_output=True, text=True)
    if run.returncode != 0:
        return f"ORACLE FAILED ({run.returncode}): {(run.stderr or run.stdout).strip()[-120:]}"
    source = read_epub(str(epub))
    with zipfile.ZipFile(epub) as z:
        want = collections.Counter(words(source.spine, z.read))
    with zipfile.ZipFile(back) as z:
        got = collections.Counter(words([n for n in sorted(z.namelist()) if n.endswith(MARKUP)], z.read))
    missing, extra = sum((want - got).values()), sum((got - want).values())
    verdict = "ok" if missing == 0 and extra == 0 else "DIFFERS"
    return (
        f"{verdict}: {sum(want.values()):,} source words, {sum(got.values()):,} round trip, "
        f"missing {missing}, extra {extra}; {report['size_bytes']:,} B in {took:.1f} s, "
        f"{len(report['warnings'])} warning(s)"
    )


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    bad = 0
    with tempfile.TemporaryDirectory(prefix="azw3-oracle-") as tmp:
        for name in argv[1:]:
            result = check(Path(name), Path(tmp))
            print(f"{Path(name).name[:46]:46} {result}", flush=True)
            bad += result.startswith(("DIFFERS", "FAILED", "ORACLE FAILED"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
