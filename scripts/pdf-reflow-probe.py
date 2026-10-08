#!/usr/bin/env python3
"""Reflow the corpus's PDFs and report what came out — the slice-1 gate.

    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --out dist/reflow-spike
    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --book "Attention is All You Need"
    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --compare   # adds pdfminer.six

The corpus is the six books named in the design's *Open questions for review*
(a two-column textbook, the paper the owner reads, a paper in the reflow set
with no outline, plain prose, a designed cookbook, and an image-only book that
must fall back). Titles resolve through the live database read-only, so this
script carries no paths of its own; each book's PDF is found **by extension**,
like every other lookup in the app.

It writes one EPUB per book into `--out` (inside `dist/`, which is gitignored),
plus `report.json`. It reads the library and writes **only** to the output
directory: no `metadata.json`, no database row, no file inside a book folder.
The numbers it prints are what Annex B of
`docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` is built from,
and it re-derives them rather than quoting the annex.
"""

from __future__ import annotations

import glob
import json
import os
import re
import sqlite3
import sys
import time
import zipfile
from collections import Counter
from html import unescape
from pathlib import Path
from typing import Optional
from xml.etree import ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))

from reflow import analyse, document_sections, write_epub  # noqa: E402

DB = os.path.expanduser("~/Library/Application Support/Musaeum/musaeum.db")
TAG = re.compile(r"<[^>]+>")

# The gate's corpus: (database title, what this book is here to prove).
CORPUS = [
    ("Universe: Solar Systems, Stars, and Galaxies", "two-column textbook, sidebars and callouts"),
    ("Attention is All You Need", "the paper (book also holds an epub; measured as a PDF)"),
    ("Sequence to Sequence Learning with Neural Networks", "a paper in the reflow set, no outline"),
    ("Politics, Philosophy, Culture", "plain single-column academic prose"),
    ("Modernist Cuisine: Volume 1: History & Fundamentals", "designed and caption-heavy"),
    ("The Complete Guide to Asterix", "image-only: the fallback must fire"),
]


def library_root() -> str:
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        row = conn.execute("select value from app_config where key='library_root'").fetchone()
    finally:
        conn.close()
    if not row:
        raise SystemExit("no library_root in the database — is Musaeum set up here?")
    return row[0]


def book(title: str) -> tuple[str, str, list[str]]:
    """(match title, folder, formats) for a title, matched loosely."""
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        row = conn.execute(
            "select title, nas_path, formats from books where title like ? limit 1",
            (title + "%",),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise SystemExit(f"no book titled like {title!r} in the database")
    return row[0], row[1], json.loads(row[2])


def pdf_in(folder: str) -> Optional[str]:
    found = [
        f for f in glob.glob(os.path.join(folder, "*")) if os.path.splitext(f)[1].lower() == ".pdf"
    ]
    return found[0] if found else None


def pdf_words(path: str, pages: int, limit: Optional[int]) -> Counter:
    """Every word the PDF's own text layer holds, as a multiset."""
    import pypdfium2 as pdfium

    counter: Counter = Counter()
    pdf = pdfium.PdfDocument(path)
    try:
        for i in range(min(pages, limit) if limit else pages):
            text = pdf[i].get_textpage().get_text_range()
            counter.update(text.split())
    finally:
        pdf.close()
    return counter


def epub_text(path: str) -> tuple[Counter, list[str]]:
    """The artifact's words, and the entry names of every XHTML it holds."""
    counter: Counter = Counter()
    names: list[str] = []
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            if not name.endswith(".xhtml"):
                continue
            names.append(name)
            raw = zf.read(name).decode("utf-8", "replace")
            text = unescape(TAG.sub(" ", raw))
            counter.update(text.split())
    return counter, names


def validate(path: str) -> list[str]:
    """Structural checks an EPUB reader would refuse the file over."""
    problems: list[str] = []
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        if not names or names[0] != "mimetype":
            problems.append("mimetype is not the first entry")
        info = zf.getinfo("mimetype")
        if info.compress_type != zipfile.ZIP_STORED:
            problems.append("mimetype is compressed")
        if zf.read("mimetype") != b"application/epub+zip":
            problems.append("mimetype has the wrong content")
        for name in ("META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml"):
            if name not in names:
                problems.append(f"{name} is missing")
        for name in names:
            if name.endswith((".xhtml", ".opf", ".ncx", ".xml")):
                try:
                    ElementTree.fromstring(zf.read(name))
                except ElementTree.ParseError as err:
                    problems.append(f"{name} does not parse: {err}")
        try:
            opf = ElementTree.fromstring(zf.read("OEBPS/content.opf"))
            ns = "{http://www.idpf.org/2007/opf}"
            for item in opf.iter(f"{ns}item"):
                href = item.get("href") or ""
                if not href or "://" in href:
                    continue
                if f"OEBPS/{href}" not in names:
                    problems.append(f"manifest href OEBPS/{href} is not in the zip")
        except ElementTree.ParseError as err:  # pragma: no cover - caught above
            problems.append(f"content.opf did not parse: {err}")
        for name in names:
            if name.startswith("OEBPS/images/") and zf.getinfo(name).file_size == 0:
                problems.append(f"{name} is empty")
    return problems


def missing_report(pdf: Counter, art: Counter, dropped: list[str]) -> dict:
    """Words the artifact lost, and words it invented.

    Tokens are compared as multisets, so a reordered page contributes nothing
    here — this measures dropped and duplicated *words*, not order. Hyphenated
    line breaks legitimately change the token set (the pass rejoins them), and
    the dropped running heads are excluded from the count and reported beside
    it, so the number is a floor on real loss rather than a fiction of one.
    """
    missing = pdf - art
    extra = art - pdf
    dropped_words = Counter(w for text in dropped for w in text.split())
    for token, count in dropped_words.items():
        if missing[token] <= count:
            missing.pop(token, None)
        else:
            missing[token] -= count
    total_missing = sum(missing.values())
    return {
        "pdf_words": sum(pdf.values()),
        "artifact_words": sum(art.values()),
        "missing": total_missing,
        "extra": sum(extra.values()),
        "missing_top": missing.most_common(12),
    }


def compare_pdfminer(path: str, limit: Optional[int]) -> Optional[dict]:
    """The same pages through pdfminer.six's layout analysis, for the record."""
    try:
        from pdfminer.high_level import extract_pages
    except Exception:
        return None
    started = time.perf_counter()
    pages = 0
    chars = 0
    try:
        for layout in extract_pages(path, page_numbers=list(range(limit)) if limit else None):
            pages += 1
            chars += len(layout.get_text())
    except Exception as err:  # a comparison that raises is itself a reading
        return {"error": f"{type(err).__name__}: {err}"}
    return {
        "pages": pages,
        "chars": chars,
        "seconds": round(time.perf_counter() - started, 1),
        "ms_per_page": round((time.perf_counter() - started) / max(pages, 1) * 1000, 1),
    }


def run_one(title: str, why: str, root: str, out_dir: str, limit: Optional[int], compare: bool) -> dict:
    matched, rel, formats = book(title)
    folder = os.path.join(root, rel)
    path = pdf_in(folder)
    if not path:
        return {"title": matched, "why": why, "verdict": "no_pdf", "reason": "folder holds no .pdf"}

    rec: dict = {
        "title": matched,
        "why": why,
        "formats": formats,
        "mb": round(os.path.getsize(path) / 1048576, 1),
        "pdf": os.path.basename(path),
    }
    started = time.perf_counter()
    doc = analyse(path, limit=limit)
    sections, outline_entries = document_sections(path, doc)
    doc.sections = sections
    rec["seconds"] = round(time.perf_counter() - started, 1)
    rec["pages"] = len(doc.pages)
    rec["ms_per_page"] = round(rec["seconds"] / max(len(doc.pages), 1) * 1000, 1)

    text_pages = doc.text_pages
    rec["verdict"] = doc.verdict
    rec["reason"] = doc.reason
    rec["text_pages"] = len(text_pages)
    rec["multi_band_pages"] = sum(1 for p in text_pages if p.bands > 1)
    rec["flagged_pages"] = sum(1 for p in text_pages if p.flags)
    rec["cross_band_lines"] = sum(p.cross_band for p in text_pages)
    rec["headings"] = sum(1 for p in doc.pages for b in p.blocks if b.kind == "heading")
    rec["figures"] = sum(1 for p in doc.pages for b in p.blocks if b.kind == "figure")
    rec["dropped_running_heads"] = len(doc.dropped_running_heads)
    rec["running_head_sample"] = doc.dropped_running_heads[:4]
    rec["outline_entries"] = outline_entries
    rec["sections"] = len(sections)
    rec["section_titles"] = [t for t, _ in sections[:8]]

    slug = re.sub(r"[^a-zA-Z0-9]+", "-", matched).strip("-")[:60]
    epub_path = os.path.join(out_dir, f"{slug}.epub")
    if doc.verdict != "ok":
        rec["artifact"] = None
        rec["note"] = "fallback: no artifact written, which is what D6 asks for"
    else:
        rec.update(write_epub(doc, epub_path, matched))
        rec["artifact"] = os.path.relpath(epub_path, out_dir)
        rec["problems"] = validate(epub_path)
        art, names = epub_text(epub_path)
        rec["xhtml_files"] = len(names)
        rec["words"] = missing_report(pdf_words(path, len(doc.pages), limit), art, doc.dropped_running_heads)

    if compare:
        rec["pdfminer"] = compare_pdfminer(path, limit)
    return rec


def print_report(records: list[dict]) -> None:
    print(f"{'book':44s} {'pages':>6s} {'verdict':<15s} {'sect':>5s} {'figs':>5s} "
          f"{'heads':>5s} {'words':>7s} {'lost':>6s} {'extra':>6s} {'sec':>6s} {'ms/pg':>6s}")
    for r in records:
        if r.get("verdict") == "no_pdf":
            print(f"{r['title'][:44]:44s} {'-':>6s} no pdf")
            continue
        words = r.get("words") or {}
        print(
            f"{r['title'][:44]:44s} {r['pages']:>6d} {r['verdict']:<15s} {r['sections']:>5d} "
            f"{r['figures']:>5d} {r['headings']:>5d} {words.get('artifact_words', 0):>7d} "
            f"{words.get('missing', 0):>6d} {words.get('extra', 0):>6d} {r['seconds']:>6.1f} {r['ms_per_page']:>6.1f}"
        )
    print()
    for r in records:
        if r.get("verdict") == "no_pdf":
            continue
        print(f"— {r['title']}")
        print(f"    why       {r['why']}")
        print(f"    formats   {', '.join(r['formats'])}   {r['mb']} MB   {r['pages']} pages")
        print(f"    verdict   {r['verdict']}{' — ' + r['reason'] if r['reason'] else ''}")
        print(f"    pages     {r['text_pages']} with text, {r['multi_band_pages']} multi-band, "
              f"{r['cross_band_lines']} lines cut at a gutter, {r['flagged_pages']} flagged")
        print(f"    structure {r['headings']} headings, {r['figures']} figures, "
              f"{r['sections']} sections (outline: {r['outline_entries']} entries), "
              f"{r['dropped_running_heads']} dropped running heads")
        if r.get("artifact"):
            words = r.get("words") or {}
            print(f"    artifact  {r['artifact']}  {r['bytes'] / 1024:.0f} KB  "
                  f"{words.get('artifact_words', 0)} words  {r['xhtml_files']} xhtml")
            print(f"    loss      {words.get('missing', 0)} words missing, {words.get('extra', 0)} extra "
                  f"(pdf has {words.get('pdf_words', 0)})")
            if words.get("missing_top"):
                print(f"    lost top  {words['missing_top'][:8]}")
            print(f"    validate  {'clean' if not r.get('problems') else r['problems']}")
        else:
            print(f"    artifact  none — {r.get('note', '')}")
        if r.get("pdfminer"):
            print(f"    pdfminer  {r['pdfminer']}")
        print(f"    section titles: {r['section_titles']}")
        print()


def main(argv: list[str]) -> int:
    out_dir = "dist/reflow-spike"
    limit: Optional[int] = None
    only: Optional[str] = None
    compare = False
    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg == "--out":
            i += 1
            out_dir = argv[i]
        elif arg == "--limit":
            i += 1
            limit = int(argv[i])
        elif arg == "--book":
            i += 1
            only = argv[i]
        elif arg == "--compare":
            compare = True
        else:
            print(__doc__, file=sys.stderr)
            return 2
        i += 1

    root = library_root()
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    targets = [c for c in CORPUS if only is None or only.lower() in c[0].lower()]
    if not targets:
        print(f"no corpus book matches {only!r}", file=sys.stderr)
        return 2

    records = []
    for title, why in targets:
        print(f"… {title}", file=sys.stderr, flush=True)
        records.append(run_one(title, why, root, out_dir, limit, compare))

    print_report(records)
    report = os.path.join(out_dir, "report.json")
    with open(report, "w") as fh:
        json.dump({"limit": limit, "books": records}, fh, indent=1)
    print(f"report: {report}")
    passed = [r for r in records if r.get("verdict") == "ok" and not r.get("problems")]
    fallback = [r for r in records if r.get("verdict") != "ok"]
    print(f"gate: {len(passed)}/{len(records)} books produced a clean artifact; "
          f"{len(fallback)} fell back ({[r['title'] for r in fallback]})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
