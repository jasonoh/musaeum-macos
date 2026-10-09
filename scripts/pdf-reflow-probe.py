#!/usr/bin/env python3
"""Reflow the corpus's PDFs and report what came out — the slice-1 gate.

    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --out dist/reflow-spike
    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --book "Attention is All You Need"
    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --gate-only dist/reflow-spike-slice1
    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --production
    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --production --book "Attention"

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

`--production` is slice 2's half of the same thing: instead of the spike's own
writer it runs the production pass (`sidecar/reflow/produce.py`) over a *copy* of
each corpus PDF placed in `--out`, because the mount is read-only and the pass
writes `derived/` beside the book — and it measures the bar slice 2 is signed off
on (byte-stability across two runs, the cache, the stamp, no residue).
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import time
import zipfile
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


# --- the production pass (slice 2) ------------------------------------------

# Run 2 of the gate (spec Annex C.7) is the owner's accepted reading of this
# pass, so it is the baseline the production artifacts are compared with: these
# are the books it passed, and the source's content rules are frozen, so nothing
# about them may move except the artifact's writer.
PASSED_IN_RUN_2 = {
    "Attention is All You Need",
    "Sequence to Sequence Learning with Neural Networks",
    "Modernist Cuisine: Volume 1: History & Fundamentals",
}

# Slice 2's own bar, per text book: written, byte-stable across two runs,
# cached on the next open, never serving a stale stamp after the source moved,
# re-running the pass for the moved source, and nothing but `derived/` written
# into the book folder.
BAR = ("produced", "byte_stable", "cached", "stamp_not_stale", "stamp_reran", "only_derived_changed")


def _sha(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()[:16]


def _content_digest(path: str) -> str:
    """The artifact's *content* — entries and their bytes — ignoring zip metadata.

    A byte-stability failure has two very different causes (the document moved, or
    only the container's dates/order did), and reporting the pair of digests says
    which without another 30-minute corpus pass.
    """
    with zipfile.ZipFile(path) as zf:
        return hashlib.sha256(b"".join(n.encode() + zf.read(n) for n in sorted(zf.namelist()))).hexdigest()[:16]


def _listing(directory: str) -> list[str]:
    return sorted(os.listdir(directory)) if os.path.isdir(directory) else []


def _run(book_dir: str, pdf: str, *, force: bool = False) -> dict:
    from reflow.produce import reflow_pdf

    started = time.perf_counter()
    result = reflow_pdf(book_dir, pdf, force=force)
    result["wall"] = round(time.perf_counter() - started, 1)
    return result


def gate_artifact(title: str, pdf: str, epub_path: str, golden: dict, rec: dict) -> dict[str, list[str]]:
    """G1–G7 on the artifact the production pass wrote (Annex C.4).

    The exclusions C.4 asks for — the regions read from Vision, the figure labels
    inside written crops, the dropped furniture — are facts about the *source*,
    so they come from laying it out again with `analyse`, the same deterministic
    pass, rather than from the RPC's result, whose consumer is the reader and not
    this probe. Gating the artifact with a fresh record is a cross-check as well:
    if the artifact had come from some other pass, G2 and G6 would move.

    That re-layout is retried while it is degraded, and a degraded one is
    recorded: measured 2026-10-08, a layout whose helper answered no pages at all
    (8 of 9 pages lost) moved G4 and G6 on a book whose own pass had 0 layout
    errors, so a verdict from a degraded record is noise rather than evidence.
    """
    attempts = []
    for _ in range(3):
        doc = analyse(pdf)
        attempts.append({"verdict": doc.verdict, "layout_errors": doc.layout_errors})
        if doc.verdict == "ok":
            break
    rec["gate_layouts"] = attempts
    rec["gate_layout_errors"] = doc.layout_errors
    rec["gate_verdict"] = doc.verdict
    doc.entries = document_entries(pdf, doc)
    return gate_book(
        pdf,
        epub_path,
        passages=golden.get(title, []),
        pages=len(doc.pages),
        expected_figures=doc.figures_detected,
        exclusions={p.index: p.figure_boxes for p in doc.pages},
        skip_pages=frozenset(doc.vision_pages),
        excluded_words=Counter(gate.tokens("\n".join(doc.dropped_running_heads + doc.dropped_text))),
    )


def production_book(title: str, why: str, book_dir: str, pdf: str, golden: dict) -> dict:
    """One corpus book through `reflow_pdf`, measured against slice 2's bar."""
    from reflow.produce import artifact_paths, read_stamp

    epub_path, stamp_path = artifact_paths(book_dir)
    derived = os.path.dirname(epub_path)
    if os.path.isdir(derived):
        # A re-run of this harness starts each book from nothing, so every number
        # below is this run's. (Without this, a second invocation would find the
        # previous run's stamp current and measure a cache hit as if it were the
        # pass.)
        shutil.rmtree(derived)
    before = _listing(book_dir)
    first = _run(book_dir, pdf)
    rec: dict = {
        "title": title,
        "why": why,
        "mb": round(os.path.getsize(pdf) / 1048576, 1),
        "status": first["status"],
        "verdict": first["verdict"],
        "reason": first["reason"],
        "seconds": first["seconds"],
        "pages": first["pages"],
        "text_pages": first["text_pages"],
        "ms_per_page": round(first["seconds"] / max(first["pages"], 1) * 1000, 1),
        "bytes": first["bytes"],
        "toc_entries": first["toc_entries"],
        "figures": first["figures"],
        "plates": first["plates"],
        "layout_errors": first["layout_errors"],
        "vision_regions": first["vision_regions"],
        "artifact": os.path.basename(epub_path) if first["epub"] else None,
    }
    if first["status"] != "produced":
        # A fallback writes nothing, so there is nothing to measure beyond the
        # reason — which `print_gate` reads as the image-only book's G8 result.
        rec["residue"] = [name for name in _listing(os.path.dirname(epub_path)) if name.endswith(".tmp")]
        return rec

    rec["produced"] = True
    first_digest = (_sha(epub_path), _sha(stamp_path))
    first_content = _content_digest(epub_path)
    # The forced second pass is the byte-stability probe. A pass can legitimately
    # *refuse* a book it laid out minutes earlier — D6's posture, and 1R's own
    # record names the helper failing pages on a later run — so a refusal is
    # retried and recorded rather than read as an instability of the artifact.
    # Measured 2026-10-08: one refusal in roughly thirty passes of this corpus.
    attempts: list[dict] = []
    for _ in range(3):
        forced = _run(book_dir, pdf, force=True)
        attempts.append({"status": forced["status"], "verdict": forced["verdict"], "reason": forced["reason"]})
        if forced["status"] == "produced":
            break
    second_digest = (_sha(epub_path), _sha(stamp_path))
    rec["attempts"] = attempts
    rec["digest"] = {"first": first_digest, "second": second_digest}
    rec["content"] = {"first": first_content, "second": _content_digest(epub_path)}
    rec["byte_stable"] = attempts[-1]["status"] == "produced" and first_digest == second_digest
    rec["cached"] = _run(book_dir, pdf)["status"] == "cached"
    rec["residue"] = [name for name in _listing(os.path.dirname(epub_path)) if name.endswith(".tmp")]
    rec["only_derived_changed"] = _listing(book_dir) == sorted([*before, "derived"])

    # A touched source is a different document (D9), so the next pass may never
    # serve the old stamp — and the pass itself has to be able to re-run it. Two
    # calls, because a pass can legitimately *refuse* a book it cannot lay out
    # that time (D6, and 1R's record already names the helper failing pages on a
    # second run); what must never happen is a `cached` answer for a moved
    # source, and what has to be shown is that the pass does re-run.
    later = int(os.stat(pdf).st_mtime) + 60
    os.utime(pdf, (later, later))
    touched = [_run(book_dir, pdf), _run(book_dir, pdf)]
    rec["touched"] = [
        {"status": call["status"], "verdict": call["verdict"], "reason": call["reason"]} for call in touched
    ]
    rec["stamp_not_stale"] = touched[0]["status"] != "cached"
    rec["stamp_reran"] = any(call["status"] == "produced" for call in touched)
    stamp = read_stamp(stamp_path)
    rec["stamp_mtime"] = stamp["source"]["mtime"] if stamp else None
    rec["source_mtime"] = later
    rec["gate"] = gate_artifact(title, pdf, epub_path, golden, rec)
    return rec


def production_failed(records: list[dict]) -> list[str]:
    """Every book's failure against slice 2's own bar, one line each."""
    bad: list[str] = []
    for rec in records:
        title = rec["title"]
        if rec["status"] != "produced":
            if title not in EXPECT_FALLBACK:
                bad.append(f"{title}: no artifact ({rec['status']}: {rec['reason']})")
            continue
        if title in EXPECT_FALLBACK:
            bad.append(f"{title}: wrote an artifact, and its correct outcome is the fallback")
            continue
        bad.extend(f"{title}: {key} is false" for key in BAR if not rec.get(key))
        if not rec.get("stamp_reran") or not rec.get("stamp_not_stale"):
            # Name what the pass actually said for the moved source: a refusal is
            # D6's own posture and a `cached` answer is the defect the stamp
            # exists to prevent, and they are not the same finding.
            bad.append(f"{title}: after the source moved the pass said {rec.get('touched')}")
        if not rec.get("byte_stable"):
            attempts = rec.get("attempts") or []
            if attempts and not any(attempt["status"] == "produced" for attempt in attempts):
                bad.append(f"{title}: the pass refused {len(attempts)} forced attempts: {attempts}")
            else:
                got = rec.get("digest") or {}
                first, second = got.get("first"), got.get("second")
                content = rec.get("content") or {}
                if first == second:
                    bad.append(f"{title}: byte_stable is false with identical digests ({first}) — a pass did not produce")
                else:
                    moved = "epub" if first and second and first[0] != second[0] else "stamp"
                    where = (
                        "its content moved"
                        if content.get("first") != content.get("second")
                        else "only its zip metadata moved, the content did not"
                    )
                    bad.append(f"{title}: byte_stable is false — the {moved} moved ({first} then {second}); {where}")
        if rec.get("residue"):
            bad.append(f"{title}: {rec['residue']} left behind")
        if rec.get("stamp_mtime") != rec.get("source_mtime"):
            bad.append(f"{title}: the stamp does not name the touched source")
    return bad


def gate_regression(records: list[dict]) -> list[str]:
    """A book that passed Annex C.7 run 2 and fails now is a real regression.

    The other direction is printed as news rather than failed: with this slice's
    content rules frozen it should not happen, and if it does the owner is the
    one who reads it (the two G5 failures and *Universe*'s G3 are their open
    questions, not this harness's to settle).
    """
    bad: list[str] = []
    for rec in records:
        title = rec["title"]
        if title in EXPECT_FALLBACK or not rec.get("gate"):
            continue
        if rec.get("gate_layout_errors"):
            # Not a finding about the artifact: the record the checks need is the
            # one the source could not give this time, so the run has to be
            # repeated rather than read.
            bad.append(
                f"{title}: the gate's own layout was degraded {rec['gate_layouts']} — re-run this book, "
                "its verdict is not evidence"
            )
            continue
        failed = [check for check in CHECKS if rec["gate"].get(check)]
        if title in PASSED_IN_RUN_2 and failed:
            bad.append(f"{title}: passed Annex C.7 run 2 and fails {failed} now")
        elif title not in PASSED_IN_RUN_2 and not failed:
            print(f"NOTE  {title}: failed Annex C.7 run 2 and passes the gate now — the owner's to read, not this run's verdict")
    return bad


def print_production(records: list[dict], report: str) -> None:
    print(f"{'book':42s} {'status':<9s} {'pages':>6s} {'sec':>7s} {'ms/pg':>6s} {'MB':>7s} {'toc':>5s} {'figs':>5s} {'stable':>7s} {'cache':>6s}")
    for rec in records:
        print(
            f"{rec['title'][:42]:42s} {rec['status']:<9s} {rec.get('pages', 0):>6d} {rec.get('seconds', 0.0):>7.1f} "
            f"{rec.get('ms_per_page', 0.0):>6.1f} {rec.get('bytes', 0) / 1048576:>7.1f} {rec.get('toc_entries', 0):>5d} "
            f"{rec.get('figures', 0):>5d} {str(bool(rec.get('byte_stable'))):>7s} {str(bool(rec.get('cached'))):>6s}"
        )
    print()
    print_gate(records)
    text_books = [rec for rec in records if rec["title"] not in EXPECT_FALLBACK]
    written = [rec for rec in text_books if rec["status"] == "produced"]
    print(
        f"production: {len(written)}/{len(text_books)} written, "
        f"{sum(1 for r in written if r.get('byte_stable'))} byte-stable across two runs, "
        f"{sum(1 for r in written if r.get('cached'))} cached on the next open, "
        f"{sum(1 for r in written if r.get('stamp_not_stale'))} never served a stale stamp, "
        f"{sum(1 for r in written if r.get('stamp_reran'))} re-ran the pass on a touched source, "
        f"{sum(1 for r in written if r.get('only_derived_changed'))} wrote only derived/"
    )
    for rec in records:
        for attempt in (rec.get("attempts") or []) + (rec.get("touched") or []):
            # A refusal is a *fallback* — no artifact and one reason (D6). A
            # `cached` answer is expected here: it is what the call after a
            # successful re-run must say.
            if attempt["status"] == "fallback":
                print(f"NOTE  {rec['title']}: a pass refused ({attempt['verdict']}: {attempt['reason']})")
    for line in production_failed(records) + gate_regression(records):
        print(f"FAIL  {line}")
    print(f"report: {report}")


def production(directory: str, root: str, only: Optional[str]) -> int:
    """Run `reflow_pdf` over the corpus and measure slice 2's bar.

    The library stays untouched: each book's PDF is copied once, with its mtime,
    into `{directory}/books/{slug}/`, and that copy is the book folder the pass
    writes `derived/` in. Per book: the artifact is written and gated with Annex
    C.4's exclusions; two *runs* over the unchanged source must be byte-identical
    (artifact and stamp); the next open must be served from the cache; a touched
    source must re-run the pass, and be current again afterwards; and nothing but
    `derived/` may appear in the book folder. The exit code answers this slice's
    bar and a regression against Annex C.7 run 2 — the gate's own score is
    printed and read against that table, never asserted here.
    """
    os.makedirs(directory, exist_ok=True)
    golden = load_golden()
    records: list[dict] = []
    for title, why in CORPUS:
        if only and only.lower() not in title.lower():
            continue
        matched, rel, _ = book(title)
        source = pdf_in(os.path.join(root, rel))
        slug = re.sub(r"[^a-zA-Z0-9]+", "-", matched).strip("-")[:60]
        book_dir = os.path.join(directory, "books", slug)
        os.makedirs(book_dir, exist_ok=True)
        if not source:
            records.append({"title": matched, "why": why, "status": "no_pdf", "reason": "folder holds no .pdf"})
            continue
        pdf = os.path.join(book_dir, os.path.basename(source))
        if not os.path.exists(pdf):
            shutil.copy2(source, pdf)  # copy2 keeps the mtime the stamp records
        with open(os.path.join(book_dir, "metadata.json"), "w") as fh:
            json.dump({"title": matched}, fh)
        print(f"… {matched}", file=sys.stderr, flush=True)
        records.append(production_book(matched, why, book_dir, pdf, golden))

    report = os.path.join(directory, "report.json")
    with open(report, "w") as fh:
        json.dump({"books": records}, fh, indent=1)
    print_production(records, report)
    return 1 if production_failed(records) or gate_regression(records) else 0


def main(argv: list[str]) -> int:
    out_dir = "dist/reflow-spike"
    explicit_out = False
    limit: Optional[int] = None
    only: Optional[str] = None
    gate_dir: Optional[str] = None
    production_mode = False
    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg == "--out":
            i += 1
            out_dir = argv[i]
            explicit_out = True
        elif arg == "--limit":
            i += 1
            limit = int(argv[i])
        elif arg == "--book":
            i += 1
            only = argv[i]
        elif arg == "--gate-only":
            i += 1
            gate_dir = argv[i]
        elif arg == "--production":
            production_mode = True
        else:
            print(__doc__, file=sys.stderr)
            return 2
        i += 1

    root = library_root()
    if production_mode:
        return production(os.path.abspath(out_dir if explicit_out else "dist/reflow-production"), root, only)
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
