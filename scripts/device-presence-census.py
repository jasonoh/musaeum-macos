#!/usr/bin/env python3
"""How much of a Kindle does Musaeum's presence model actually see?

Presence matches `sanitizeTitle(book.title)` against device file *stems*. Every
other tool names its files its own way — Calibre sends
`{author_sort}/{title} - {authors}.ext`, and titles get mangled on the way
("Algebraist, The", "Homo Deus_"). This reads what each file says about *itself*
and reports how many books a content-based match would recover, so the design in
`docs/superpowers/specs/2026-09-17-device-presence-design.md` rests on a number
rather than a hope.

    python3 scripts/device-presence-census.py                 # this machine's Kindle
    python3 scripts/device-presence-census.py --device /Volumes/Kindle --workers 12

Read-only: it copies the app database to a temp file (a WAL database cannot be
opened read-only without its `-shm`, and the app may be running) and touches
nothing on the device.
"""
from __future__ import annotations

import argparse
import re
import shutil
import sqlite3
import struct
import sys
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

APP_DB = Path.home() / "Library/Application Support/Musaeum/musaeum.db"
BOOK_EXTS = {".azw3", ".mobi", ".azw"}


def sanitize_title(title: str) -> str:
    """The same normalization the app matches with (`services/sanitize.ts`)."""
    clean = re.sub(r'[/\\:*?"<>|]', "", title)
    clean = re.sub(r"[\x00-\x1f]", "", clean)
    return (re.sub(r"\s+", " ", clean).strip() or "untitled")[:80]


def file_stem(name: str) -> str:
    return re.sub(r"\.[^.]+$", "", name).lower()


def walk(root: Path, depth: int = 1, max_depth: int = 2):
    out = []
    try:
        entries = list(root.iterdir())
    except OSError:
        return out
    for entry in entries:
        if entry.name.startswith(".") or entry.name.lower().endswith(".sdr"):
            continue
        if entry.is_dir():
            if depth < max_depth:
                out += walk(entry, depth + 1, max_depth)
        elif entry.suffix.lower() in BOOK_EXTS:
            out.append(entry)
    return out


def record_zero(handle) -> bytes | None:
    """Record 0, sized from the record table rather than guessed.

    A fixed window is not safe: a long EXTH (a blurb, a tag list) pushes record 0
    past it, and the title read then fails on files that are perfectly readable.
    """
    head = handle.read(78)
    if len(head) < 78:
        return None
    count = struct.unpack(">H", head[76:78])[0]
    if count == 0:
        return None
    table = handle.read(count * 8)
    if len(table) < 8:
        return None
    # First entry: 4-byte offset into the file, then attributes and a unique id
    start = struct.unpack(">I", table[0:4])[0]
    end = struct.unpack(">I", table[8:12])[0] if count > 1 else None
    if end is None or end <= start:
        return None
    handle.seek(start)
    return handle.read(end - start)


def embedded_identity(path: Path):
    """(title, author) as the file itself carries them, or None if unreadable."""
    try:
        with path.open("rb") as handle:
            rec0 = record_zero(handle)
        if not rec0 or rec0[16:20] != b"MOBI":
            return None
        title = None
        name_off, name_len = struct.unpack(">II", rec0[0x54:0x5C])
        if 0 < name_len < 1024 and name_off + name_len <= len(rec0):
            title = rec0[name_off : name_off + name_len].decode("utf-8", "replace")

        author = None
        header_len = struct.unpack(">I", rec0[20:24])[0]
        flags = struct.unpack(">I", rec0[0x80:0x84])[0]
        pos = 16 + header_len
        if flags & 0x40 and rec0[pos : pos + 4] == b"EXTH":
            length = struct.unpack(">I", rec0[pos + 4 : pos + 8])[0]
            count = struct.unpack(">I", rec0[pos + 8 : pos + 12])[0]
            p, end = pos + 12, pos + length
            for _ in range(count):
                if p + 8 > end:
                    break
                kind, size = struct.unpack(">II", rec0[p : p + 8])
                if kind == 100:
                    author = rec0[p + 8 : p + size].decode("utf-8", "replace")
                p += size
        return title, author
    except (OSError, struct.error):
        return None


def library_titles(db: Path) -> dict[str, str]:
    scratch = Path(tempfile.mkdtemp(prefix="musaeum-census-")) / "musaeum.db"
    shutil.copyfile(db, scratch)
    try:
        con = sqlite3.connect(str(scratch))
        try:
            return {
                sanitize_title(title).lower(): title
                for (title,) in con.execute("SELECT title FROM books")
            }
        finally:
            con.close()
    finally:
        shutil.rmtree(scratch.parent, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", default="/Volumes/Kindle", help="mounted Kindle root")
    parser.add_argument("--db", default=str(APP_DB), help="Musaeum database to read titles from")
    parser.add_argument("--workers", type=int, default=12, help="parallel header reads")
    args = parser.parse_args()

    documents = Path(args.device) / "documents"
    if not documents.is_dir():
        print(f"no {documents} — is the Kindle mounted?", file=sys.stderr)
        return 2

    titles = library_titles(Path(args.db))
    files = walk(documents)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        identities = list(pool.map(embedded_identity, files))

    buckets: Counter[str] = Counter()
    examples: dict[str, list[tuple[str, str | None]]] = {}
    for path, identity in zip(files, identities):
        by_name = file_stem(path.name) in titles
        inside = sanitize_title(identity[0]).lower() if identity and identity[0] else None
        by_content = bool(inside) and inside in titles

        if by_name:
            kind = "A. matched by filename (presence sees it today)"
        elif by_content:
            kind = "B. RECOVERED by the file's own title"
        elif not inside:
            kind = "C. no title inside the file (KFX/PDF/odd)"
        else:
            kind = "D. still unmatched (its own title matches no library title)"
        buckets[kind] += 1
        examples.setdefault(kind, []).append((str(path.relative_to(documents)), identity[0] if identity else None))

    print(f"library titles: {len(titles):,}   device files read: {len(files):,}\n")
    for kind in sorted(buckets):
        print(f"  {buckets[kind]:>5}  {kind}")
        for name, inside in examples[kind][:4]:
            note = f"   [inside: {inside[:44]}]" if inside else ""
            print(f"           {name[:62]}{note}")
        print()
    reachable = buckets["A. matched by filename (presence sees it today)"] + buckets[
        "B. RECOVERED by the file's own title"
    ]
    print(f"reachable with a content match: {reachable} of {len(files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
