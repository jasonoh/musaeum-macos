"""The production pass, and the rules it rests on.

`produce.reflow_pdf` is the seam slice 3 calls, so what is pinned here is the
artifact (byte-stable across two runs, never half-written, never written at all
for a book the confidence gate refuses), the stamp D9 re-checks, and the
progress D7 shows. The artifact's determinism lives here too: it is a rule of
`write_epub` that no other test file owns, and it is the same bar Task 4
measures over the corpus.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
import zipfile

import pytest

from reflow import gate, produce
from reflow.epub import write_epub
from reflow.model import Block, Document, PageResult
from reflow.outline import Entry
from reflow.produce import artifact_paths, read_stamp, reflow_pdf
from reflow.vision import find_helper
from tests.reflow_pdfs import Page, Rect, Text, write_pdf

FAKE_HELPER = '''#!{interpreter}
"""A stand-in for helpers/musaeum-layout: one region covering each page.

Every knob is an environment variable so one script serves every test:
FAKE_PAGES, FAKE_MARKER (a line per run), FAKE_DIE_AFTER, FAKE_SLEEP.
"""

import json
import os
import sys
import time

pages = int(os.environ.get("FAKE_PAGES", "1"))
marker = os.environ.get("FAKE_MARKER", "")
if marker:
    with open(marker, "a") as fh:
        fh.write("run\\n")
print(json.dumps({{"helper": "musaeum-layout", "version": 1, "supported": True, "pages": pages}}), flush=True)
for n in range(1, pages + 1):
    if os.environ.get("FAKE_SLEEP"):
        time.sleep(float(os.environ["FAKE_SLEEP"]))
    if os.environ.get("FAKE_DIE_AFTER") and n > int(os.environ["FAKE_DIE_AFTER"]):
        sys.exit(1)
    print(json.dumps({{"page": n, "box": [0, 0, 612, 792], "rotation": 0, "ms": 1,
                      "regions": [{{"kind": "paragraph", "order": 0, "bbox": [0, 0, 612, 792], "text": ""}}],
                      "tables": []}}), flush=True)
'''

BODY = [
    "The stars are the story of this page and this line says so plainly.",
    "A second line, long enough that this page counts as a text page.",
]


def text_page(index: int = 0) -> Page:
    return Page(texts=[Text(40, 700 - 16 * k, BODY[(index + k) % 2]) for k in range(12)])


def plate_page() -> Page:
    return Page(rects=[Rect(0, 0, 612, 792, 0.3)])


def book_of_textless_pages(tmp_path):
    """An image-only book: the corpus's *Complete Guide to Asterix*, small."""
    book_dir = tmp_path / "books" / "asterix"
    book_dir.mkdir(parents=True)
    pdf = write_pdf(book_dir / "Asterix.pdf", [plate_page(), plate_page()])
    return str(book_dir), str(pdf)


def a_folder(tmp_path, name: str, title: str = "A Book"):
    """An empty book folder with one text PDF in it."""
    book_dir = tmp_path / "books" / name
    book_dir.mkdir(parents=True, exist_ok=True)
    pdf = write_pdf(book_dir / f"{title}.pdf", [text_page()])
    return str(book_dir), str(pdf)


@pytest.fixture
def helper(tmp_path, monkeypatch):
    """The production path's stand-in for `helpers/musaeum-layout`.

    It writes a marker line per run, which is how "one pass per book" is measured
    without patching anything the production path owns.
    """
    script = tmp_path / "musaeum-layout"
    script.write_text(FAKE_HELPER.format(interpreter=sys.executable))
    script.chmod(0o755)
    marker = tmp_path / "helper-runs.txt"
    monkeypatch.setenv("MUSAEUM_LAYOUT_HELPER", str(script))
    monkeypatch.setenv("FAKE_MARKER", str(marker))
    monkeypatch.setenv("FAKE_PAGES", "3")
    return marker


def runs(marker) -> int:
    return len(marker.read_text().splitlines()) if marker.exists() else 0


@pytest.fixture
def book(tmp_path):
    """A book folder as the app has it: `{title}.pdf` beside its metadata.json.

    `plate=True` puts a text-less page in the middle of a text book — one of the
    fixtures slice 2's row names — so the default book exercises both paths.
    """

    def make(pages: int = 3, title: str = "A Book", plate: bool = True):
        book_dir = tmp_path / "books" / "b1"
        book_dir.mkdir(parents=True, exist_ok=True)
        fixture = [text_page(i) for i in range(pages - 1 if plate else pages)]
        if plate:
            fixture.append(plate_page())
        pdf = write_pdf(book_dir / f"{title}.pdf", fixture)
        (book_dir / "metadata.json").write_text(json.dumps({"title": title}))
        return str(book_dir), str(pdf)

    return make


def _source(tmp_path):
    """A file for the artifact to be stamped from — the writer only stats it."""
    source = tmp_path / "A Book.pdf"
    source.write_bytes(b"%PDF-1.4\n% a stand-in for the book's own file\n")
    return source


def _doc(tmp_path, pages: int = 5, figure: bool = False) -> Document:
    doc = Document(source=str(_source(tmp_path)))
    figure_bytes = b"\xff\xd8\xff\xd9" if figure else None
    for i in range(pages):
        blocks = [
            Block("heading", text=f"Chapter {i + 1}", level=1, page=i, top=700.0),
            Block("para", text="Body text on this page, and enough of it to read.", page=i, top=600.0),
        ]
        if figure and i == 0:
            blocks.append(
                Block(
                    "figure", page=i, top=690.0, bottom=500.0, left=80.0, right=500.0,
                    image=figure_bytes, image_width=420, image_height=190, image_type="jpeg",
                )
            )
        doc.pages.append(PageResult(index=i, chars=500, top=792.0, bottom=0.0, blocks=blocks))
    return doc


def test_every_zip_entry_carries_a_fixed_date(tmp_path):
    """Measured 2026-10-08: a str-named entry took the run's own second, so two
    runs a second apart differed and slice 2's byte-stability bar could not be
    met. The figure is here because the images are the entry class that
    measurement named — the four documents *and every image* carried the clock —
    so a suite that never writes one would not notice the image path regressing."""
    out = tmp_path / "one.epub"
    write_epub(_doc(tmp_path, figure=True), str(out), "A Book")
    with zipfile.ZipFile(out) as zf:
        names = zf.namelist()
        assert any(name.startswith("OEBPS/images/") for name in names)
        assert {info.date_time for info in zf.infolist()} == {(1980, 1, 1, 0, 0, 0)}


def test_two_runs_over_one_source_are_byte_identical(tmp_path):
    """The sleep has to cross a *bucket*: a zip entry's DOS timestamp has
    two-second granularity, so a shorter gap can leave two runs in the same one
    and this test would pass against the clock it is here to catch."""
    doc = _doc(tmp_path, figure=True)
    first, second = tmp_path / "one.epub", tmp_path / "two.epub"
    write_epub(doc, str(first), "A Book")
    time.sleep(2.5)
    write_epub(doc, str(second), "A Book")
    assert first.read_bytes() == second.read_bytes()


def test_the_report_maps_each_file_to_the_pages_it_holds(tmp_path):
    """D5: a position in the reflow can name the PDF page it came from without
    re-extracting anything. Two depth-0 entries split the book into two files."""
    doc = _doc(tmp_path, pages=5)
    doc.entries = [Entry("Chapter 1", 0, 0), Entry("Chapter 3", 0, 2)]
    report = write_epub(doc, str(tmp_path / "m.epub"), "A Book")
    assert report["sections"] == 2
    assert report["page_map"] == [
        {"href": "text/c001.xhtml", "title": "Chapter 1", "from_page": 1, "to_page": 2},
        {"href": "text/c002.xhtml", "title": "Chapter 3", "from_page": 3, "to_page": 5},
    ]


def test_a_page_two_files_share_names_both(tmp_path):
    """The map is a span per file, not a partition: a chapter that opens in the
    middle of a page puts that page in both files' spans, which is what the
    artifact does too — c001 holds the page's tail and c002 its heading. The
    exact witness for a page is the `pgN` anchor, and the span is the answer to
    "which file holds page N"."""
    doc = _doc(tmp_path, pages=3)
    doc.entries = [Entry("Chapter 1", 0, 0), Entry("Chapter 2", 0, 1)]
    tail = Block("para", text="The tail of page two's story, before the next chapter opens.", page=1, top=100.0)
    doc.pages[1].blocks.insert(0, tail)  # page two's first block, ahead of the new chapter's heading
    report = write_epub(doc, str(tmp_path / "m.epub"), "A Book")
    spans = [(entry["from_page"], entry["to_page"]) for entry in report["page_map"]]
    assert spans == [(1, 2), (2, 3)]
    with zipfile.ZipFile(tmp_path / "m.epub") as zf:
        assert '<span id="pg2">' in zf.read("OEBPS/text/c001.xhtml").decode()
        assert '<span id="pg2">' in zf.read("OEBPS/text/c002.xhtml").decode()


def test_a_pass_writes_the_artifact_and_a_stamp_that_names_its_source(book, helper):
    book_dir, pdf = book()
    result = reflow_pdf(book_dir, pdf, book_id="b1")
    assert result["status"] == "produced" and result["reason"] == ""
    assert result["verdict"] == "ok" and result["epub"] == os.path.join("derived", "reflow.epub")
    epub_path, stamp_path = artifact_paths(book_dir)
    assert gate.check_package(epub_path) == []
    assert os.path.getsize(epub_path) == result["bytes"] > 0
    stat = os.stat(pdf)
    stamp = read_stamp(stamp_path)
    assert stamp["version"] == produce.STAMP_VERSION
    assert stamp["converter"] == produce.converter_version()
    assert stamp["source"] == {"name": os.path.basename(pdf), "size": stat.st_size, "mtime": int(stat.st_mtime)}
    assert stamp["pages"] == 3 and stamp["text_pages"] == 2 and stamp["plates"] == 1
    assert [entry["from_page"] for entry in stamp["page_map"]] == [1]
    assert stamp["toc_from"] == "headings" and stamp["toc_entries"] >= 1
    assert result["words"] > 0


def test_the_second_open_reads_the_cache_and_runs_no_pass(book, helper):
    book_dir, pdf = book()
    assert reflow_pdf(book_dir, pdf)["status"] == "produced"
    second = reflow_pdf(book_dir, pdf)
    assert second["status"] == "cached" and second["bytes"] > 0 and second["page_map"]
    assert runs(helper) == 1


def test_the_same_source_written_twice_is_byte_identical(book, helper):
    """Slice 2's own bar, as a rule: forcing a second pass over an unchanged
    source must reproduce the artifact *and* its stamp byte for byte."""
    book_dir, pdf = book()
    assert reflow_pdf(book_dir, pdf)["status"] == "produced"
    epub_path, stamp_path = artifact_paths(book_dir)

    def digest():
        return (
            hashlib.sha256(open(epub_path, "rb").read()).hexdigest(),
            hashlib.sha256(open(stamp_path, "rb").read()).hexdigest(),
        )

    before = digest()
    forced = reflow_pdf(book_dir, pdf, force=True)
    assert forced["status"] == "produced" and runs(helper) == 2
    assert digest() == before


def test_a_touched_source_re_runs_the_pass(book, helper):
    """D9: a replaced PDF is not served from the old stamp. `os.utime` moves the
    mtime alone, which is the finer half of the pair the stamp records."""
    book_dir, pdf = book()
    reflow_pdf(book_dir, pdf)
    later = int(os.stat(pdf).st_mtime) + 60
    os.utime(pdf, (later, later))
    again = reflow_pdf(book_dir, pdf)
    assert again["status"] == "produced" and runs(helper) == 2
    assert read_stamp(artifact_paths(book_dir)[1])["source"]["mtime"] == later
    assert reflow_pdf(book_dir, pdf)["status"] == "cached"


def test_a_replaced_source_re_runs_the_pass(book, helper):
    book_dir, pdf = book()
    reflow_pdf(book_dir, pdf)
    write_pdf(pdf, [text_page(i) for i in range(4)])
    assert reflow_pdf(book_dir, pdf)["status"] == "produced"
    assert read_stamp(artifact_paths(book_dir)[1])["pages"] == 4


def test_a_new_converter_version_re_runs_the_pass(book, helper, monkeypatch):
    book_dir, pdf = book()
    reflow_pdf(book_dir, pdf)
    monkeypatch.setattr(produce, "CONVERTER_VERSION", produce.CONVERTER_VERSION + 1)
    assert reflow_pdf(book_dir, pdf)["status"] == "produced"


def test_a_missing_artifact_under_a_current_stamp_re_runs(book, helper):
    book_dir, pdf = book()
    reflow_pdf(book_dir, pdf)
    os.unlink(artifact_paths(book_dir)[0])
    assert reflow_pdf(book_dir, pdf)["status"] == "produced"


def test_a_book_with_no_text_layer_writes_nothing_and_says_why(tmp_path, helper):
    book_dir, pdf = book_of_textless_pages(tmp_path)
    result = reflow_pdf(book_dir, pdf)
    assert result["status"] == "fallback" and result["verdict"] == "no_text_layer"
    assert result["reason"] == "no page carries a text layer" and result["epub"] == ""
    assert not os.path.exists(os.path.join(book_dir, "derived"))
    assert runs(helper) == 0


def test_an_unreadable_pdf_is_a_reason_not_a_traceback(tmp_path, helper):
    book_dir = tmp_path / "books" / "broken"
    book_dir.mkdir(parents=True)
    pdf = book_dir / "broken.pdf"
    pdf.write_bytes(b"not a pdf at all")
    result = reflow_pdf(str(book_dir), str(pdf))
    assert result["status"] == "fallback" and result["verdict"] == "unreadable" and result["reason"]
    assert not os.path.exists(os.path.join(str(book_dir), "derived"))


def test_a_helper_that_dies_mid_book_is_not_a_short_book(book, helper, monkeypatch):
    """The defect slice 1R's review named: a killed helper was indistinguishable
    from a short document, and the short one would have been cached as the book's
    whole reflow. Five text pages, two answered, three counted."""
    book_dir, pdf = book(pages=5, plate=False)
    monkeypatch.setenv("FAKE_PAGES", "5")
    monkeypatch.setenv("FAKE_DIE_AFTER", "2")
    result = reflow_pdf(book_dir, pdf)
    assert result["status"] == "fallback" and result["verdict"] == "unstable_layout"
    assert result["layout_errors"] == 3 and "3 of 5 text pages" in result["reason"]
    assert not os.path.exists(os.path.join(book_dir, "derived"))


def test_a_page_the_helper_lost_is_tolerated_up_to_a_quarter(book, helper, monkeypatch):
    """D6 tolerates a quarter of the text pages degrading, so one lost page is a
    book that still reads — and the stamp says so, which is what a reviewer of a
    degraded artifact needs."""
    book_dir, pdf = book(pages=5, plate=False)
    monkeypatch.setenv("FAKE_PAGES", "5")
    monkeypatch.setenv("FAKE_DIE_AFTER", "4")
    result = reflow_pdf(book_dir, pdf)
    assert result["status"] == "produced" and result["verdict"] == "ok"
    assert result["layout_errors"] == 1 and read_stamp(artifact_paths(book_dir)[1])["layout_errors"] == 1


def test_two_calls_on_one_book_run_the_pass_once(book, helper, monkeypatch):
    """The sidecar's pool runs four requests at once, so two opens can ask for
    the same book together (AC6): the lock is taken before the cache check."""
    book_dir, pdf = book()
    monkeypatch.setenv("FAKE_SLEEP", "0.2")
    results: list[dict] = []

    def call() -> None:
        results.append(reflow_pdf(book_dir, pdf))

    threads = [threading.Thread(target=call) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert runs(helper) == 1
    assert sorted(result["status"] for result in results) == ["cached", "produced"]


def test_progress_carries_the_pages_of_both_phases(book, helper):
    """D7's surface: a reader shows pages of the pass while it runs, and the
    caller's book id comes back on every frame."""
    book_dir, pdf = book()
    frames: list[tuple[str, dict]] = []
    reflow_pdf(book_dir, pdf, book_id="b1", notify=lambda method, params: frames.append((method, params)))
    assert {method for method, _ in frames} == {"reflow_progress"}
    params = [params for _, params in frames]
    assert params[0]["phase"] == "start" and params[-1]["phase"] == "done"
    layout = [p for p in params if p["phase"] == "layout"]
    reading = [p for p in params if p["phase"] == "reading"]
    assert [p["completed"] for p in layout] == [1, 2, 3] and {p["total"] for p in layout} == {3}
    assert [p["completed"] for p in reading] == [1, 2, 3] and {p["total"] for p in reading} == {3}
    assert [p["phase"] for p in params] == ["start"] + ["layout"] * 3 + ["reading"] * 3 + ["writing", "done"]
    assert all(p["book_id"] == "b1" for p in params)


def test_a_cached_book_reports_nothing_but_cached(book, helper):
    book_dir, pdf = book()
    reflow_pdf(book_dir, pdf)
    frames: list[dict] = []
    reflow_pdf(book_dir, pdf, notify=lambda method, params: frames.append(params))
    assert [params["phase"] for params in frames] == ["cached"]


def test_a_failure_while_writing_leaves_no_residue(book, helper, monkeypatch, capsys):
    """AC5. The share is full, `write_epub` raises, and the book keeps the
    original with nothing behind it: no artifact, no `.tmp`, no empty folder."""
    book_dir, pdf = book()

    def no_space(*args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(produce, "write_epub", no_space)
    result = reflow_pdf(book_dir, pdf)
    assert result["status"] == "fallback" and result["verdict"] == "write_failed"
    assert result["reason"] == "the reflow could not be written (OSError)"
    assert sorted(os.listdir(book_dir)) == ["A Book.pdf", "metadata.json"]
    assert "OSError" in capsys.readouterr().err  # D9's one log line


def test_an_artifact_without_its_stamp_is_removed(book, helper, monkeypatch):
    """The stamp lands last, so a failure between the two renames takes the
    artifact with it: an EPUB no stamp describes would be re-run anyway."""
    book_dir, pdf = book()

    def no_stamp(*args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(produce, "_write_stamp", no_stamp)
    result = reflow_pdf(book_dir, pdf)
    assert result["status"] == "fallback"
    assert not os.path.exists(artifact_paths(book_dir)[0])
    assert sorted(os.listdir(book_dir)) == ["A Book.pdf", "metadata.json"]


def test_a_crashed_runs_temp_is_cleared_and_a_live_ones_is_left(book, helper):
    """Temp names are unique per run now, so a killed process's temp would sit
    there for good; age is the only thing that tells it from a concurrent pass's.
    """
    book_dir, pdf = book()
    derived = os.path.join(book_dir, "derived")
    os.makedirs(derived)
    crashed = os.path.join(derived, "reflow.epub.999-1.tmp")
    live = os.path.join(derived, "reflow.json.999-2.tmp")
    for path in (crashed, live):
        with open(path, "w") as fh:
            fh.write("torn")
    old = time.time() - 2 * produce.STALE_TEMP_SECONDS
    os.utime(crashed, (old, old))
    assert reflow_pdf(book_dir, pdf)["status"] == "produced"
    assert sorted(os.listdir(derived)) == ["reflow.epub", "reflow.json", "reflow.json.999-2.tmp"]


def test_a_malformed_stamp_never_raises_and_re_runs(book, helper):
    """A stamp is a file on a share that anyone can edit, and `source` as a list
    used to raise `AttributeError` out of `reflow_pdf` — which came back as an
    RPC error on every open of that book, for good, rather than D6's fallback.
    A stamp missing a stat key was worse in the other direction: it was served as
    a cache hit with zeroes for everything the reader asks about.
    """
    book_dir, pdf = book()
    assert reflow_pdf(book_dir, pdf)["status"] == "produced"
    stamp_path = artifact_paths(book_dir)[1]
    good = json.loads(open(stamp_path).read())
    for broken in (
        {**good, "source": ["x"]},
        {**good, "source": "nope"},
        {k: v for k, v in good.items() if k != "bytes"},
        {**good, "version": produce.STAMP_VERSION + 1},
        ["not", "a", "stamp"],
    ):
        with open(stamp_path, "w") as fh:
            json.dump(broken, fh)
        result = reflow_pdf(book_dir, pdf)
        assert result["status"] == "produced", broken


def test_a_corrupt_artifact_is_not_served_from_the_cache(book, helper):
    """A cache hit is decided on an artifact's bytes, not on its existence: a
    truncated EPUB under a current stamp used to be served forever, and only
    `force` could heal it.
    """
    book_dir, pdf = book()
    assert reflow_pdf(book_dir, pdf)["status"] == "produced"
    epub_path, stamp_path = artifact_paths(book_dir)
    whole = os.path.getsize(epub_path)
    with open(epub_path, "rb+") as fh:
        fh.truncate(whole // 2)
    again = reflow_pdf(book_dir, pdf)
    assert again["status"] == "produced" and os.path.getsize(epub_path) == whole
    assert runs(helper) == 2


def test_the_temp_is_verified_before_it_replaces_the_good_one(book, helper, monkeypatch):
    """D9's "verify" half, which had no witness: a temp that fails its check must
    not replace the artifact already on the share.
    """
    book_dir, pdf = book()
    reflow_pdf(book_dir, pdf)
    epub_path = artifact_paths(book_dir)[0]
    before = open(epub_path, "rb").read()

    def unreadable(*args, **kwargs):
        raise ValueError("the written file is not an EPUB")

    monkeypatch.setattr(produce, "_verify_epub", unreadable)
    result = reflow_pdf(book_dir, pdf, force=True)
    assert result["status"] == "fallback" and result["verdict"] == "write_failed"
    assert open(epub_path, "rb").read() == before
    assert sorted(os.listdir(os.path.dirname(epub_path))) == ["reflow.epub", "reflow.json"]


def test_a_size_only_change_re_runs_the_pass(book, helper, monkeypatch):
    """D9 records the source's size *and* mtime because either can move alone: an
    rsync restore can keep the mtime while the file changes underneath it."""
    book_dir, pdf = book()
    reflow_pdf(book_dir, pdf)
    before = os.stat(pdf)
    write_pdf(pdf, [text_page(i) for i in range(5)])  # a different document, same path
    os.utime(pdf, (before.st_mtime, before.st_mtime))
    monkeypatch.setenv("FAKE_PAGES", "5")
    assert os.stat(pdf).st_size != before.st_size
    again = reflow_pdf(book_dir, pdf)
    assert again["status"] == "produced" and again["pages"] == 5


def test_a_raising_notify_does_not_fail_the_pass(book, helper):
    """The sink is the app's `notify` writing to its stdout pipe, which can be
    gone; a dropped frame costs progress, never an answer (D6, D9)."""
    book_dir, pdf = book()

    def gone(*args, **kwargs):
        raise BrokenPipeError("the app quit first")

    result = reflow_pdf(book_dir, pdf, notify=gone)
    assert result["status"] == "produced" and os.path.exists(artifact_paths(book_dir)[0])


def test_the_pass_writes_nothing_but_its_own_folder(book, helper):
    """AC2 and AC3's posture: the canonical record and every format file are
    byte-identical after a pass, and `derived/` is the only thing that appeared."""
    book_dir, pdf = book()
    before = {name: open(os.path.join(book_dir, name), "rb").read() for name in os.listdir(book_dir)}
    reflow_pdf(book_dir, pdf)
    after = os.listdir(book_dir)
    assert sorted(after) == sorted([*before, "derived"])
    for name, data in before.items():
        assert open(os.path.join(book_dir, name), "rb").read() == data


def test_the_source_must_live_in_the_book_folder(tmp_path, helper):
    """A caller cannot aim `derived/` at a folder the app does not own."""
    book_dir, _ = a_folder(tmp_path, "b1")
    outside = tmp_path / "elsewhere.pdf"
    write_pdf(outside, [text_page()])
    result = reflow_pdf(book_dir, str(outside))
    assert result["status"] == "fallback" and "holds no PDF at that path" in result["reason"]
    assert not os.path.exists(os.path.join(book_dir, "derived"))


def test_a_missing_book_folder_is_a_reason(tmp_path, helper):
    result = reflow_pdf(str(tmp_path / "nowhere"), str(tmp_path / "nowhere.pdf"))
    assert result["status"] == "fallback" and result["reason"] == "the book folder is not there"


def test_pypdf_chatter_never_reaches_the_app_log(tmp_path, caplog):
    """AC10. Measured 2026-10-08: a read of the library's damaged PDFs wrote
    thousands of pypdf warnings to stderr, which is the app's log. `produce` sets
    that logger to ERROR, and AC10 allows exactly that ("or the noise is
    explicitly suppressed in the pipeline module").

    The witness is the log *record*, not stderr: pytest's capture plugin takes
    over stderr, so what has to be true is that pypdf's record is never created
    at ERROR — and that the damaged fixture really does provoke one.
    """
    import logging

    from reflow.outline import outline_entries

    logger = logging.getLogger("pypdf")
    assert logger.level == logging.ERROR

    damaged = tmp_path / "damaged.pdf"
    write_pdf(damaged, [text_page()])
    damaged.write_bytes(damaged.read_bytes().replace(b"startxref\n", b"startxref\n9", 1))

    with caplog.at_level(logging.WARNING, logger="pypdf"):
        outline_entries(str(damaged))
    assert caplog.records, "the fixture has to provoke the chatter for this test to mean anything"

    caplog.clear()
    outline_entries(str(damaged))
    assert caplog.records == []  # at the production level, nothing is even recorded


def test_the_real_helper_produces_a_readable_artifact(book):
    """The one test that needs Vision: the whole production path, from a PDF to
    an EPUB the package checks accept."""
    if find_helper() is None:
        pytest.skip("needs the built layout helper (scripts/build-layout-helper.sh)")
    book_dir, pdf = book()
    result = reflow_pdf(book_dir, pdf)
    assert result["status"] == "produced" and result["figures"] >= 0
    assert gate.check_package(artifact_paths(book_dir)[0]) == []
