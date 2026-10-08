#!/usr/bin/env python3
"""Reflow the corpus's PDFs and report what came out — the slice-1 gate.

    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --out dist/reflow-spike
    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --book "Attention is All You Need"
    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --gate-only dist/reflow-spike-slice1

The corpus is the six books named in the design's *Open questions for review*
(a two-column textbook, the paper the owner reads, a paper in the reflow set
with no outline, plain prose, a designed cookbook, and an image-only book that
must fall back). Titles resolve through the live database read-only, so this
script carries no paths of its own; each book's PDF is found **by extension**,
like every other lookup in the app.

It writes one EPUB per book into `--out` (inside `dist/`, which is gitignored),
plus `report.json`. It reads the library and writes **only** to the output
directory: no `metadata.json`, no database row, no file inside a book folder.
Each artifact is judged by the gate of the spec's Annex C.4
(sidecar/reflow/gate.py); the script exits 1 if any book fails it.
"""

from __future__ import annotations

import glob
import json
import os
import re
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))

from reflow import analyse, document_entries, write_epub  # noqa: E402
from reflow import gate  # noqa: E402
from reflow.chars import page_chars  # noqa: E402
from reflow.outline import outline_entries  # noqa: E402

DB = os.path.expanduser("~/Library/Application Support/Musaeum/musaeum.db")

# The gate's corpus: (database title, what this book is here to prove).
CORPUS = [
    ("Universe: Solar Systems, Stars, and Galaxies", "two-column textbook, sidebars and callouts"),
    ("Attention is All You Need", "the paper (book also holds an epub; measured as a PDF)"),
    ("Sequence to Sequence Learning with Neural Networks", "a paper in the reflow set, no outline"),
    ("Politics, Philosophy, Culture", "plain single-column academic prose"),
    ("Modernist Cuisine: Volume 1: History & Fundamentals", "designed and caption-heavy"),
    ("The Complete Guide to Asterix", "image-only: the fallback must fire"),
]

GOLDEN = Path(__file__).with_name("reflow-golden.json")

# The corpus book whose correct outcome is *no artifact* (D6).
EXPECT_FALLBACK = {"The Complete Guide to Asterix"}
CHECKS = ("G1", "G2", "G3", "G4", "G5", "G6", "G7")


def load_golden() -> dict[str, list[str]]:
    with open(GOLDEN) as fh:
        return json.load(fh)


def gate_book(
    pdf_path: str,
    epub_path: str,
    *,
    passages: list[str],
    pages: int,
    expected_figures: Optional[int],
    expected_plates: Optional[int] = None,
    exclusions: Optional[dict[int, list]] = None,
    skip_pages: frozenset = frozenset(),
    excluded_words: Optional[Counter] = None,
) -> dict[str, list[str]]:
    """Run G1–G7 (spec Annex C.4) on one artifact against its source PDF.

    `expected_plates=None` means "derive it from the PDF"; the other pipeline
    inputs default to *nothing excluded*, which is how the slice-1 artifacts
    are judged — they recorded no figure boxes and read no page from Vision.
    """
    import pypdfium2 as pdfium

    results: dict[str, list[str]] = {g: [] for g in CHECKS}
    results["G7"] = gate.check_package(epub_path)
    spine = gate.spine_text(epub_path)
    spine_tokens = gate.tokens(spine)
    results["G1"] = gate.check_golden(spine, passages)

    segments: list[list[str]] = []
    rotated: list[str] = []
    upright: list[str] = []
    pdf_counter: Counter = Counter()
    plates = 0
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        for i in range(pages):
            page = pdf[i]
            box = page.get_bbox()
            ev = gate.page_evidence(page, page_chars(page.get_textpage()), (exclusions or {}).get(i, []), box)
            plates += ev.plate_expected
            rotated.extend(ev.rotated)
            upright.extend(ev.upright)
            if i not in skip_pages:
                segments.extend(ev.segments)
                pdf_counter.update(ev.upright)
    finally:
        pdf.close()

    recall, trigrams = gate.trigram_recall(segments, spine_tokens)
    if recall < gate.TRIGRAM_RECALL_MIN:
        results["G2"].append(f"G2 segment trigram recall {recall:.1%} of {trigrams} (needs {gate.TRIGRAM_RECALL_MIN:.0%})")
    results["G3"] = gate.check_rotated(spine_tokens, gate.rotated_only(rotated, upright))
    results["G4"] = gate.check_figures(
        epub_path, expected_figures=expected_figures, expected_plates=plates if expected_plates is None else expected_plates
    )
    outline = outline_entries(pdf_path, pages=pages)
    results["G5"] = gate.check_toc(epub_path, [(e.title, e.depth) for e in outline] if len(outline) >= 2 else None)
    loss, missing = gate.word_loss(pdf_counter, Counter(spine_tokens), excluded_words or Counter())
    if loss > gate.WORD_LOSS_MAX:
        results["G6"].append(f"G6 {loss:.1%} of words lost (top: {missing.most_common(6)})")
    return results


def print_gate(records: list[dict]) -> int:
    """One line per check per book; returns how many books failed."""
    failed = 0
    for r in records:
        title = r["title"]
        if title in EXPECT_FALLBACK:
            ok = r.get("artifact") is None and bool(r.get("reason"))
            print(f"{'PASS' if ok else 'FAIL'}  {title} — G8 fallback ({r.get('reason') or 'an artifact was written'})")
            failed += not ok
            continue
        results = r.get("gate")
        if results is None:
            print(f"FAIL  {title} — no artifact ({r.get('reason', '')})")
            failed += 1
            continue
        bad = [g for g in CHECKS if results.get(g)]
        print(f"{'PASS' if not bad else 'FAIL'}  {title}")
        for g in bad:
            lines = results[g]
            for line in lines[:3]:
                print(f"        {line}")
            if len(lines) > 3:
                print(f"        … and {len(lines) - 3} more {g} failures")
        failed += bool(bad)
    print(f"gate: {len(records) - failed}/{len(records)} books pass")
    return failed


def gate_only(directory: str, root: str, only: Optional[str]) -> int:
    """Judge existing artifacts — the slice-1 negative control — without re-running the pipeline."""
    golden = load_golden()
    with open(os.path.join(directory, "report.json")) as fh:
        previous = {b["title"]: b for b in json.load(fh)["books"]}
    records = []
    for title, _ in CORPUS:
        if only and only.lower() not in title.lower():
            continue
        matched, rel, _ = book(title)
        path = pdf_in(os.path.join(root, rel))
        before = previous.get(matched, {})
        slug = re.sub(r"[^a-zA-Z0-9]+", "-", matched).strip("-")[:60]
        epub_path = os.path.join(directory, f"{slug}.epub")
        rec = {"title": matched, "reason": before.get("reason", ""), "artifact": None}
        if os.path.exists(epub_path) and path:
            print(f"… gating {matched}", file=sys.stderr, flush=True)
            import pypdfium2 as pdfium

            pages = len(pdfium.PdfDocument(path))
            rec["artifact"] = os.path.basename(epub_path)
            rec["gate"] = gate_book(
                path, epub_path, passages=golden.get(matched, []), pages=pages, expected_figures=before.get("figures")
            )
        records.append(rec)
    return 1 if print_gate(records) else 0


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


def run_one(title: str, why: str, root: str, out_dir: str, limit: Optional[int], golden: dict[str, list[str]]) -> dict:
    matched, rel, formats = book(title)
    path = pdf_in(os.path.join(root, rel))
    if not path:
        return {"title": matched, "why": why, "verdict": "no_pdf", "reason": "folder holds no .pdf", "artifact": None}

    rec: dict = {
        "title": matched,
        "why": why,
        "formats": formats,
        "mb": round(os.path.getsize(path) / 1048576, 1),
        "pdf": os.path.basename(path),
    }
    started = time.perf_counter()
    doc = analyse(path, limit=limit)
    doc.entries = document_entries(path, doc)
    rec["seconds"] = round(time.perf_counter() - started, 1)
    rec["pages"] = len(doc.pages)
    rec["ms_per_page"] = round(rec["seconds"] / max(len(doc.pages), 1) * 1000, 1)
    blocks = [b for p in doc.pages for b in p.blocks]
    rec.update(
        verdict=doc.verdict,
        reason=doc.reason,
        text_pages=len(doc.text_pages),
        headings=sum(1 for b in blocks if b.kind == "heading"),
        footnotes=sum(1 for b in blocks if b.kind == "footnote"),
        tables=sum(1 for b in blocks if b.kind == "table"),
        figures=doc.figures_detected,
        plates=doc.plates,
        crop_failures=doc.crop_failures[:5],
        slivers=doc.slivers[:5],
        vision_regions=doc.vision_regions,
        vision_pages=len(doc.vision_pages),
        orphans=doc.orphans,
        layout_errors=doc.layout_errors,
        dropped_running_heads=len(doc.dropped_running_heads),
        running_head_sample=doc.dropped_running_heads[:4],
        outline_entries=doc.outline_entries,
        toc_from="outline" if doc.entries_from_outline else "headings",
        section_titles=[e.title for e in doc.entries[:8]],
    )

    slug = re.sub(r"[^a-zA-Z0-9]+", "-", matched).strip("-")[:60]
    epub_path = os.path.join(out_dir, f"{slug}.epub")
    if doc.verdict != "ok":
        rec["artifact"] = None
        rec["note"] = "fallback: no artifact written, which is what D6 asks for"
        return rec
    rec.update(write_epub(doc, epub_path, matched))
    rec["artifact"] = os.path.relpath(epub_path, out_dir)
    rec["gate"] = gate_book(
        path,
        epub_path,
        passages=golden.get(matched, []),
        pages=len(doc.pages),
        expected_figures=doc.figures_detected,
        exclusions={p.index: p.figure_boxes for p in doc.pages},
        skip_pages=frozenset(doc.vision_pages),
        excluded_words=Counter(gate.tokens("\n".join(doc.dropped_running_heads + doc.dropped_text))),
    )
    return rec


def print_report(records: list[dict]) -> None:
    print(f"{'book':44s} {'pages':>6s} {'verdict':<15s} {'toc':>5s} {'figs':>5s} {'plates':>6s} {'ocr':>5s} {'sec':>6s} {'ms/pg':>6s}")
    for r in records:
        if r.get("verdict") == "no_pdf":
            print(f"{r['title'][:44]:44s} {'-':>6s} no pdf")
            continue
        print(
            f"{r['title'][:44]:44s} {r['pages']:>6d} {r['verdict']:<15s} {r.get('toc_entries', 0):>5d} "
            f"{r['figures']:>5d} {r['plates']:>6d} {r['vision_regions']:>5d} {r['seconds']:>6.1f} {r['ms_per_page']:>6.1f}"
        )
    print()
    for r in records:
        if r.get("verdict") == "no_pdf":
            continue
        print(f"— {r['title']}  ({r['why']})")
        print(f"    verdict   {r['verdict']}{' — ' + r['reason'] if r['reason'] else ''}")
        print(f"    toc       from the {r['toc_from']}; {r['outline_entries']} outline entries; first: {r['section_titles'][:4]}")
        print(
            f"    blocks    {r['headings']} headings, {r['footnotes']} footnotes, {r['tables']} tables, "
            f"{r['dropped_running_heads']} furniture dropped, {r['orphans']} orphan chars, {r['layout_errors']} layout errors, "
            f"{r['vision_regions']} regions read from Vision on {r['vision_pages']} pages"
        )
        print(f"    figures   {r['figures']} detected, {r['plates']} plates, crop failures: {r['crop_failures'] or 'none'}")
        print(f"    slivers   {r.get('slivers') or 'none'}")
        if r.get("artifact"):
            print(f"    artifact  {r['artifact']}  {r['bytes'] / 1024:.0f} KB  {r['words']} words  {r['sections']} files")
        print()


def main(argv: list[str]) -> int:
    out_dir = "dist/reflow-spike"
    limit: Optional[int] = None
    only: Optional[str] = None
    gate_dir: Optional[str] = None
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
        elif arg == "--gate-only":
            i += 1
            gate_dir = argv[i]
        else:
            print(__doc__, file=sys.stderr)
            return 2
        i += 1

    root = library_root()
    if gate_dir:
        return gate_only(os.path.abspath(gate_dir), root, only)
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    targets = [c for c in CORPUS if only is None or only.lower() in c[0].lower()]
    if not targets:
        print(f"no corpus book matches {only!r}", file=sys.stderr)
        return 2

    golden = load_golden()
    records = []
    for title, why in targets:
        print(f"… {title}", file=sys.stderr, flush=True)
        records.append(run_one(title, why, root, out_dir, limit, golden))

    print_report(records)
    report = os.path.join(out_dir, "report.json")
    with open(report, "w") as fh:
        json.dump({"limit": limit, "books": records}, fh, indent=1)
    print(f"report: {report}")
    return 1 if print_gate(records) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
