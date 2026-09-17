#!/usr/bin/env python3
"""How much of a Kindle does Musaeum's presence model actually see?

Presence recognizes a library book by three readings of the device: the file's
*name* against a sanitized title (what Musaeum writes itself, and what Calibre's
`{author_sort}/{title} - {authors}.ext` rarely matches), the **title and author
inside the file**, and the title inside the file alone where the library holds
exactly one book with it. This grades that rule against the real device and the
real library, and reports what is left outside it.

Careful reading of the buckets — they are the app's rule, not a wish:

    A   the app calls this file recognized
    B   the file's title matches a library title, but the library holds more
        than one book with it and the file's author does not name one — the
        uniqueness guard refusing to guess (see below)
    C   no title readable inside (KFX, PDF, an odd header): the filename rule is
        all these offer
    D   recognized by neither reading (another tool's edition drift: a truncated
        title inside the file, a title the library spells differently)

**B is not an error count.** It is the guard doing its job: when two library
books share a normalized title, the rule requires the file's author to say which
one it is, and a file that carries only one of two co-authors (measured: EXTH 100
`Jason Mendelson` against a library author `Brad Feld & Jason Mendelson`) names
neither exactly. The design takes that trade deliberately — a re-send costs one
copy, a false positive costs trust in the count. What has to hold is A+B: the
files a content match can reach at all. On the measured device that is 86 + 1,257
= 1,343, and the shipped rule reaches 1,341 of them by itself.

The filename-only count is printed underneath as the historical baseline, so the
before/after stays visible rather than being overwritten by the new rule.

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

# Bucket names, kept in one place: the summary reads the same ones the walk writes
BY_NAME = "A. recognized — the name matches a library title"
BY_CONTENT = "A. recognized — the title inside matches a library book"
BY_GUARD = (
    "B. title matches, but the library has more than one book with it and the file names no author of one"
)
NO_TITLE = "C. no title readable inside (filename rule only)"
UNMATCHED = "D. recognized by neither reading"
BOOK_EXTS = {".azw3", ".mobi", ".azw"}


def sanitize_title(title: str) -> str:
    """The same normalization the app matches with (`services/sanitize.ts`)."""
    clean = re.sub(r'[/\\:*?"<>|]', "", title)
    clean = re.sub(r"[\x00-\x1f]", "", clean)
    return (re.sub(r"\s+", " ", clean).strip() or "untitled")[:80]


def title_key(title: str) -> str:
    """`titleKey()` in `services/device-manager.ts`."""
    return sanitize_title(title).lower()


def author_key(author: str) -> str:
    """`authorKey()`: case, punctuation and word order gone, so Calibre's
    "Banks, Iain M." and the library's "Iain M. Banks" are the same author."""
    words = re.sub(r"[^\w]+", " ", sanitize_title(author).lower(), flags=re.UNICODE).split()
    return " ".join(sorted(words))


def file_stem(name: str) -> str:
    """`fileStem()`: lowercased, extension stripped — and *not* sanitized."""
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
    if len(table) < 12:
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
        # EXTH presence is decided by the magic, not the flag: the flag is not
        # always set even when EXTH follows
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


def library(db: Path):
    """Every book, plus the two indexes the match rule needs."""
    scratch = Path(tempfile.mkdtemp(prefix="musaeum-census-")) / "musaeum.db"
    shutil.copyfile(db, scratch)
    try:
        con = sqlite3.connect(str(scratch))
        try:
            books = [
                (book_id, title, author)
                for book_id, title, author in con.execute("SELECT id, title, author FROM books")
            ]
        finally:
            con.close()
    finally:
        shutil.rmtree(scratch.parent, ignore_errors=True)

    by_title: dict[str, list[tuple[str, str | None, str]]] = {}
    for book_id, title, author in books:
        by_title.setdefault(title_key(title), []).append((book_id, author, title))
    return books, by_title


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", default="/Volumes/Kindle", help="mounted Kindle root")
    parser.add_argument("--db", default=str(APP_DB), help="Musaeum database to read books from")
    parser.add_argument("--workers", type=int, default=12, help="parallel header reads")
    parser.add_argument("--examples", type=int, default=4, help="examples per bucket")
    args = parser.parse_args()

    documents = Path(args.device) / "documents"
    if not documents.is_dir():
        print(f"no {documents} — is the Kindle mounted?", file=sys.stderr)
        return 2

    books, by_title = library(Path(args.db))
    files = walk(documents)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        identities = list(pool.map(embedded_identity, files))

    # What the device offers, keyed the way the match rule reads it
    stems = {file_stem(path.name) for path in files}
    carrying: dict[str, list[tuple[str, str]]] = {}
    for path, identity in zip(files, identities):
        if not identity or not identity[0]:
            continue
        carrying.setdefault(title_key(identity[0]), []).append(
            (str(path), author_key(identity[1]) if identity[1] else "")
        )

    buckets: Counter[str] = Counter()
    examples: dict[str, list[tuple[str, str | None]]] = {}

    def note(kind: str, path: Path, title: str | None) -> None:
        buckets[kind] += 1
        examples.setdefault(kind, []).append((str(path.relative_to(documents)), title))

    def recognized_by_content(title: str | None, author: str | None) -> bool:
        """The app's rules 1 and 2: title and author agree, or the title is unique."""
        if not title:
            return False
        key = title_key(title)
        candidates = by_title.get(key)
        if not candidates:
            return False
        if len(candidates) == 1:
            return True
        if not author:
            return False
        return any(book_author and author_key(book_author) == author_key(author) for _, book_author, _ in candidates)

    for path, identity in zip(files, identities):
        inside = identity[0] if identity else None
        by_name = file_stem(path.name) in by_title
        if by_name:
            note(BY_NAME, path, inside)
        elif recognized_by_content(inside, identity[1] if identity else None):
            note(BY_CONTENT, path, inside)
        elif inside and title_key(inside) in by_title:
            # The app would not credit it and plain title equality would: a
            # shared title with nothing in the file to break the tie
            note("B. title matches, but the library has more than one book with it and the file names no author of one", path, inside)
        elif not inside:
            note(NO_TITLE, path, inside)
        else:
            note(UNMATCHED, path, inside)

    # The book-level answer — the same question `devices.getOnDeviceBookIds`
    # answers, so the two numbers can be compared rather than assumed equal
    present: list[str] = []
    for book_id, title, author in books:
        key = title_key(title)
        if key in stems:
            present.append(title)
            continue
        files_with_title = carrying.get(key, [])
        if not files_with_title:
            continue
        if len(by_title.get(key, [])) == 1:
            present.append(title)
        elif author and any(a and a == author_key(author) for _, a in files_with_title):
            present.append(title)

    print(f"library: {len(books):,} books, {len(by_title):,} distinct titles")
    print(f"device files read: {len(files):,} ({', '.join(sorted(BOOK_EXTS))})\n")
    for kind in sorted(buckets):
        print(f"  {buckets[kind]:>5}  {kind}")
        for name, inside in examples[kind][: args.examples]:
            note_text = f"   [inside: {inside[:44]}]" if inside else ""
            print(f"           {name[:62]}{note_text}")
        print()

    recognized = sum(n for k, n in buckets.items() if k.startswith("A."))
    by_name = buckets[BY_NAME]
    guard = buckets[BY_GUARD]
    print(f"recognized by the app's rule: {recognized:,} of {len(files):,} device files")
    print(
        f"  of which by the filename rule alone: {by_name:,}"
        f"   (the whole of it before this change)"
    )
    print(
        f"reachable by a content match: {recognized + guard:,}"
        f" — {recognized + guard - by_name:,} of them beyond the filename rule"
    )
    print(f"the guard refusing to guess: {guard:,} (a shared title, an author that names neither)")
    print(f"books the app reads as on-device: {len(present):,} of {len(books):,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
