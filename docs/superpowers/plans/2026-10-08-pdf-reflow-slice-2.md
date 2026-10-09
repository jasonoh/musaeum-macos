# PDF Reflow Slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the pass the owner accepted in slice 1R to production: a `reflow_pdf` sidecar RPC that lays a PDF out once, writes `{book}/derived/reflow.epub` beside its `reflow.json` stamp by temp-write-and-rename, streams progress while it works, and answers *no artifact and one line of reason* for a book it cannot lay out confidently (D2, D6, D7, D9).

**Architecture:** `sidecar/reflow/produce.py` is the new production entry. It checks the stamp against the source PDF's size and mtime (D9), takes a per-book lock so a second open waits and then finds the first one's artifact cached (D7, AC6), runs the accepted pass (`analyse` → `document_entries` → `write_epub`) with a progress callback, verifies the written file, and renames it into place — and it writes nothing anywhere but `{book}/derived/` (AC2). `analyse` learns to report the pass in two phases (`layout` for the helper's streamed pages, `reading` for the page pass), `vision.run_helper` reads the helper's stream off the pipe as it is written and stops mistaking a helper killed mid-book for a short document, and `epub.write_epub` gives every zip entry a fixed date so two runs over one source are byte-identical. `sidecar/main.py` exposes it as `reflow_pdf` with `reflow_progress` notifications.

**Tech Stack:** Python 3.12 (`pypdfium2` 5.13.0, `pypdf` 6.16.1, `Pillow` 12.3.0 — all already pinned, nothing new), pytest 9.1.1, Swift 6.4 / Vision via `xcrun swiftc`, macOS 26.7.1.

**Spec:** `docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md` — slice 2's row, then **D2, D3, D6, D7, D9** and **Annex C.4/C.5 item 10**. Open questions 7–9 are the owner's; this slice neither repairs *Universe*'s G3 witness, nor changes G5's bar, nor removes the gate's exclusions.

**Working directory for every command:** this clone's root, on branch `feat/pdf-reflow-slice-2`. The clone has no venv and no built helper:

```bash
PY=/Users/jasonoh/Projects/musaeum-macos/sidecar/.venv/bin/python
./scripts/build-layout-helper.sh          # needs the Xcode toolchain; 149 KB, gitignored
```

## Resume here (2026-10-08)

No task has started. This plan is committed on `feat/pdf-reflow-slice-2`, branched from `main` at `818a0d8` (slice 1R merged as `b165d8e`; nothing pushed — see the report). The helper is built at `helpers/bin/musaeum-layout` (gitignored, 149 KB), so the reflow suite runs **88 passed, 2 skipped** before and **90 passed** after it exists; the two skips are the real-helper tests. Task 4 needs the NAS at `/Volumes/books/musaeum` mounted **read-only** — it never writes there: it copies each corpus PDF into `dist/reflow-production/` and passes that as the book folder.

Every code block in this plan is complete. Lines marked *measured* were taken on this machine on 2026-10-08, before the plan was written; the commands that produced them are in *What was measured first* below, so any of them can be re-taken.

## Global Constraints

- **No new Python dependency.** `sidecar/requirements.txt` is unchanged (AC9 as amended). Only `pypdfium2`, `pypdf`, `Pillow` and the standard library.
- **The artifact's content rules are frozen.** No threshold, role, outline-filter or figure rule changes in this slice, in either direction: the corpus gate's per-book result in Task 4 must be comparable with Annex C.7 run 2 book by book, because what the owner accepted is the reading of *that* pass. The two rules slice 1R's review left that would move content (`outline.is_junk`'s Roman-folio over-reach, and the 80-character furniture cap) are therefore **placed, not taken** — see *Carried in, and where each one goes* at the end of this plan.
- **D6 is per book and non-fatal:** a book whose verdict is not `ok` writes nothing, returns the one reason, and never raises. Same for a missing folder, a source outside the book folder, an unwritable share.
- **D9:** temp name, verify, rename; a torn pass leaves no residue (no artifact, no `.tmp`, and no empty `derived/` this run created); a stamp is current only when the source's size and mtime **and** the converter version match.
- **D7:** progress on the existing notification channel (`reflow_progress`, `sidecar.ts:34`'s `onNotification`), and one pass per book — the sidecar's pool runs four requests at once, so the lock is real work, not decoration.
- **Nothing outside `{book}/derived/` is written** (AC2): not `metadata.json`, not a format file, not SQLite. `metadata.json` is read for the title, never written.
- **The pipeline writes nothing to stderr** (AC10). The helper's stderr is discarded; pypdf's is suppressed in `produce.py`, because it is not "per-page library chatter on the corpus" alone — measured, a read of the library's damaged PDFs writes thousands of lines (see below).
- **The EPUB stylesheet sets no colour and no typeface**, and no rule here adds one (`sidecar/reflow/epub.py` docstring, `docs/invariants/reader.md`).
- **`vendor/foliate-js` is not touched; no renderer, IPC or preload file is touched.** Slice 3 owns those.
- **Markdown prose is not hard-wrapped** (`CLAUDE.md`, *Markdown*): one line per paragraph in every `.md` edit.
- **Budget:** 7 files in the spec's row (`sidecar/reflow/*`, `sidecar/main.py`, `sidecar/tests/*`) **+ 3 the spec assigns elsewhere**: `scripts/pdf-reflow-probe.py` (the production harness that measures this slice's bar), `docs/data-contracts.md` (the new RPC's row) and `tasks.md` (C2's status line). The row's own budget is met exactly; nothing else is touched.
- **Escalate — stop and hand back — if:** a check fails twice; the corpus gate's per-book result differs from Annex C.7 run 2 (that is the owner's accepted reading, not a tuneable); or two runs over one unchanged source still differ in bytes after Task 2.

## Review Focus

1. **A second open must not start a second pass.** The lock is taken *before* the cache check, so two concurrent `reflow_pdf` calls serialize and the loser finds the winner's stamp current. Pinned in Task 3 (`test_two_calls_on_one_book_run_the_pass_once`, two threads and a helper that counts its own runs).
2. **A failed pass leaves nothing behind.** Not `derived/reflow.epub`, not a `.tmp`, and not an empty `derived/` this run created — and an artifact is only real once its stamp is, so a failure *after* the rename removes the EPUB again. Pinned in Task 3 (`test_a_failure_while_writing_leaves_no_residue`, `test_an_artifact_without_its_stamp_is_removed`).
3. **A helper killed mid-book is not a short book.** A non-zero exit means every page of the requested range the helper never answered becomes an error line, which the per-book verdict weighs (D6 tolerates 25% of text pages). Before this, a killed helper was indistinguishable from a short document and the short one would have been cached as the book's whole reflow. Pinned in Task 1 (`test_reflow_vision.py`) and end to end in Task 3 (`test_a_helper_that_dies_mid_book_is_not_a_short_book`).
4. **Two runs over one unchanged source are byte-identical.** Every zip entry carries a fixed date (measured: they used to carry the clock, so two runs a second apart differed) and the stamp records the *source's* mtime, never "now". Pinned in Task 2 and measured over all six corpus books in Task 4.
5. **Nothing but `derived/` changes.** No `metadata.json` write, no format file, no database — and the source PDF must resolve *inside* the book folder, so a caller cannot aim `derived/` at a folder the app does not own. Pinned in Task 3 (`test_the_pass_writes_nothing_but_its_own_folder`, `test_the_source_must_live_in_the_book_folder`).

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `sidecar/reflow/vision.py` | read the helper's stream as it is written (`on_page`); the header's page count; a non-zero exit's unanswered pages as error lines; `--pages` from either bound | 1 |
| `sidecar/reflow/layout.py` | `analyse(progress=…)`: `layout` pages from the helper, `reading` pages from the pass | 1 |
| `sidecar/tests/test_reflow_vision.py` | the stream's own rules: the header, streaming order, the unanswered pages, the timeout | 1 |
| `sidecar/reflow/epub.py` | a fixed date on every zip entry; the source-page map (D5) in `write_epub`'s report | 2 |
| `sidecar/tests/test_reflow_produce.py` (new) | the artifact's rules: no clock, byte-stability, the page map, then the stamp and its re-runs, temp-write-and-rename, no residue, the fallback, progress, one pass per book | 2, 3 |
| `sidecar/reflow/produce.py` (new) | the production pass: cache, lock, temp/verify/rename, stamp, D6 fallback, `reflow_progress` | 3 |
| `sidecar/main.py` | the `reflow_pdf` RPC, with `notify` | 3 |
| `docs/data-contracts.md` | the RPC's row in the sidecar method table | 3 |
| `scripts/pdf-reflow-probe.py` | `--production`: run the pass over the corpus in a scratch book folder, measure byte-stability, cache, the stamp and residue, and gate the artifacts | 4 |
| `tasks.md` | C2's status line: what slice 2 landed, what slice 3 is next | 4 |

`sidecar/tests/reflow_pdfs.py` — the fixture generator — **needs no change**: the fixtures slice 2's row asks for already exist among its primitives (a two-column page and a plate in `test_reflow_pipeline.book()`, an image-only book in `test_a_textless_book_never_runs_the_helper`, an outline/no-outline pair via `OutlineItem`, and a text-less page inside a text book as a `Page(rects=[…])` between text pages). The new suite builds what it needs from `reflow_pdfs` directly, which is also why the row's budget is met exactly.

Run the whole reflow suite at any point with:

```bash
$PY -m pytest sidecar/tests -k reflow -q     # 90 tests once the helper is built
$PY -m pytest sidecar/tests -q               # 349
```

---

## What was measured first (2026-10-08, before Task 1)

1. **The zip entries carry the clock.** Two `write_epub` runs over one document in the same process are byte-identical (the clock's resolution is a second), so the carry-in's "not byte-deterministic" was invisible until a run was made to cross a second boundary: with a `time.sleep(1.2)` between them the two files differ, and the differing field is every str-named entry's `date_time` (`ZipInfo("mimetype")`'s default is already `(1980, 1, 1, 0, 0, 0)`, so only the four documents and the images moved). Task 2 fixes this; **without it slice 2's own bar can never be met.**
2. **Where the pass's time goes** — because that is what decides whether progress can be one number or two. *Universe*, the helper built at `helpers/bin/musaeum-layout`, concurrency 8, render scale 1.5: pages 1–20 — helper 6.07 s (303 ms/page), the Python pass 4.33 s (216 ms/page); pages 1–40 — helper 7.66 s (192 ms/page), pass 13.61 s (340 ms/page). The two halves are within about 20% of each other, so `analyse` reports them as two phases of *the same* page count and a caller can weigh them equally (Task 1).
3. **The corpus does not exercise `is_junk`'s Roman rule**, so the fix cannot move a gate number: across the six outlines, the labels the `^[ivxlcdm]+$` rule drops that are word-like are *Modernist Cuisine*'s `viii`, `xii`, `xiii` — exactly what the rule exists for — and nothing else (0 word-like drops in the other five). The rule still over-reaches in principle: `Civil`, `Mild` and `DIM` all match it, and a strict Roman grammar kills those three while keeping every real folio (`viii`, `xii`, `xiii`, `ix`, `xliv`, `mcmxciv`) — residual words that a strict grammar still drops: `mix`, `civ`. That is why it is *placed* at the end of this plan rather than fixed here.
4. **No corpus book folder holds a `derived/` today**, and the six PDFs total 637 MB (Universe 305 MB, Modernist Cuisine Vol 1 299 MB), which is what Task 4 copies once into `dist/`.
5. **pypdf's chatter goes to the app's log.** `logging.getLogger("pypdf")` at its default level writes `incorrect startxref pointer(2)` / `Ignoring wrong pointing object 2334` to stderr — thousands of lines while walking the library's damaged PDFs, measured by scanning the books that hold one. At `ERROR` the same read is silent. The measured line is AC10's own escape hatch ("or the noise is explicitly suppressed in the pipeline module"), so Task 3 sets it there.
6. **The corpus's own gate numbers are the acceptance baseline.** Annex C.7 run 2: *Universe* fails G3 (7 words) and G5 (222 of 255), *Politics, Philosophy, Culture* fails G5 (21 of 31), *Modernist Cuisine* and *Attention* and *Sequence to Sequence* pass, *Asterix* falls back with no artifact; `gate: 4/6`, exit 1. Task 4's harness gates the production artifacts with the same exclusions and the plan's step compares them with that table.

---

### Task 1: The helper's stream, read as it is written

**Files:**
- Modify: `sidecar/reflow/vision.py`
- Modify: `sidecar/reflow/layout.py`
- Modify: `sidecar/tests/test_reflow_vision.py`

**Interfaces:**
- Consumes: nothing (this is the bottom of the pipeline).
- Produces:
  - `vision.HelperHeader(version: int, pages: Optional[int])` and `vision.HelperStream(header, pages: dict[int, PageLayout])`.
  - `vision.parse_header(line: str) -> HelperHeader` (raises `LayoutUnavailable`).
  - `vision.read_stream(lines: Iterable[str], on_page: Optional[Callable[[int], None]] = None) -> HelperStream` — `on_page(done)` as each page's line is read.
  - `vision.parse_stream(lines) -> dict[int, PageLayout]` — unchanged public shape (the probe and the existing tests use it).
  - `vision.run_helper(pdf_path, *, first=None, last=None, concurrency=8, scale=1.5, helper=None, timeout=None, on_page=None) -> dict[int, PageLayout]` — every page of the requested range the helper never answered is present, as a `PageLayout` whose `error` says so.
  - `layout.analyse(path, limit=None, layouts=None, progress=None) -> Document` — `progress(phase, done, total)` with `phase` `"layout"` (the helper's pages) then `"reading"` (the pass's own pages).

---

- [ ] **Step 1: Take the header out of the stream reader**

`parse_stream` currently validates the header inline and throws it away, which is why nothing can read the helper's `pages` (spec Annex C.5 item 1). Split it: `parse_header` for the first line, `_page_line` for one page's line, and `read_stream` for both together, with `parse_stream` kept as the one-shot face of it. Replace the block in `sidecar/reflow/vision.py` from `def parse_stream(` to the end of that function with:

```python
@dataclass(frozen=True)
class HelperHeader:
    """The helper's first line: the protocol version and the document's pages."""

    version: int
    pages: Optional[int]


@dataclass(frozen=True)
class HelperStream:
    """What the helper said: its header, and a layout for each page it answered."""

    header: HelperHeader
    pages: dict[int, PageLayout]


def parse_header(line: str) -> HelperHeader:
    """The helper's first line, or the one reason it cannot help (D6).

    Read as a function of its own because the page count it carries is what
    turns a short stream into a diagnosable one: without it, a helper that died
    on page 100 of 535 was indistinguishable from a 100-page book.
    """
    try:
        header = json.loads(line)
    except (TypeError, ValueError):
        raise LayoutUnavailable("the layout helper wrote no header") from None
    if not isinstance(header, dict) or header.get("helper") != "musaeum-layout":
        raise LayoutUnavailable("the layout helper wrote no header")
    if not header.get("supported", False):
        raise LayoutUnavailable("page layout needs macOS 26 or later")
    if header.get("version") != HELPER_VERSION:
        raise LayoutUnavailable(f"layout helper version {header.get('version')} (expected {HELPER_VERSION})")
    if header.get("error"):
        raise LayoutUnavailable(f"the layout helper: {header['error']}")
    pages = header.get("pages")
    return HelperHeader(HELPER_VERSION, int(pages) if isinstance(pages, int) else None)


def _page_line(line: str) -> Optional[PageLayout]:
    """One page's line, or `None` when it carries nothing this module can use."""
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
        number = int(obj.get("page", 0))
    except (json.JSONDecodeError, TypeError, ValueError, AttributeError):
        return None
    if number < 1:
        return None
    if obj.get("error"):
        return PageLayout(page=number, error=str(obj["error"]))
    try:
        regions = sorted(
            (Region(int(r["order"]), _box(r["bbox"]), str(r.get("text", ""))) for r in obj.get("regions", [])),
            key=lambda r: r.order,
        )
        tables = [
            Table(
                _box(t["bbox"]),
                tuple(
                    TableCell(
                        int(c["row"]), int(c["col"]), int(c.get("rowspan", 1)), int(c.get("colspan", 1)),
                        _box(c["bbox"]), str(c.get("text", "")),
                    )
                    for c in t.get("cells", [])
                ),
            )
            for t in obj.get("tables", [])
        ]
        return PageLayout(
            number, _box(obj["box"]), int(obj.get("rotation", 0)), regions, tables, int(obj.get("ms", 0))
        )
    except (KeyError, TypeError, ValueError, IndexError) as err:
        return PageLayout(page=number, error=f"malformed page line ({type(err).__name__})")


def read_stream(lines: Iterable[str], on_page: Optional[Callable[[int], None]] = None) -> HelperStream:
    """The helper's whole stream: its header first, then one line per page.

    `lines` is iterated lazily, so a caller can hand it the helper's pipe and get
    `on_page(done)` as each page's line arrives — the helper answers in page
    order while it works, which is what a progress surface needs (D7).
    """
    it = iter(lines)
    try:
        first = next(it)
    except StopIteration:
        first = ""
    header = parse_header(first)
    pages: dict[int, PageLayout] = {}
    for line in it:
        layout = _page_line(line)
        if layout is None:
            continue
        pages[layout.page] = layout
        if on_page is not None:
            on_page(len(pages))
    return HelperStream(header, pages)


def parse_stream(lines: Iterable[str]) -> dict[int, PageLayout]:
    """The pages in a whole helper stream, for callers that want only the map.

    Kept beside `read_stream` because the two are the same reader: this is its
    one-shot face, and the probe's `--gate-only` and this module's own tests use
    it where the header's page count is not the question.
    """
    return read_stream(lines).pages
```

and add `Callable` to the typing import at the top of the file:

```python
from typing import Callable, Iterable, Optional
```

```bash
$PY -m pytest sidecar/tests -k reflow -q
```

Expected: `90 passed` with the helper built (`88 passed, 2 skipped` without it) — the refactor is behaviour-preserving on its own.

```bash
git add sidecar/reflow/vision.py
git commit -m "refactor(sidecar): the helper's header is a value of its own

`parse_stream` validated the first line and threw it away, so the header's
`pages` — the helper's own statement of how long the document is — was
unreadable, and a short stream had nothing to be compared against. Splits it
into `parse_header`, `_page_line` and `read_stream`, with `parse_stream` kept as
the one-shot face so the probe and the existing tests are untouched.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Read the helper's stream while it is written**

Replace `run_helper`'s `subprocess.run` call (and the function's docstring and signature) in `sidecar/reflow/vision.py` with the streamed form. The behavioural change is in `_unanswered`: a helper that did not answer every page it was asked for now *says so* once per missing page, so the per-book verdict can weigh them (Task 3 pins that end to end).

Replace the whole `run_helper` function with:

```python
def run_helper(
    pdf_path,
    *,
    first: Optional[int] = None,
    last: Optional[int] = None,
    concurrency: int = 8,
    scale: float = 1.5,
    helper: Optional[str] = None,
    timeout: Optional[float] = None,
    on_page: Optional[Callable[[int], None]] = None,
) -> dict[int, PageLayout]:
    """Lay out pages `first`–`last` (1-based, inclusive; all by default).

    `on_page(done)` is called as each page's line arrives: the helper answers in
    page order while working concurrently, and one page of *Universe* at a
    time takes 0.5–1.3 s, so a pass over a 535-page book is minutes and has to
    report itself (D7).

    Every page of the requested range the helper never answered comes back as a
    `PageLayout` whose `error` says so. Slice 1R's review found the defect this
    closes: a helper killed mid-book was indistinguishable from a short
    document, and the short one would have been cached as the book's whole
    reflow. Missing pages count as layout errors, which is what the per-book
    verdict already weighs (D6 tolerates a quarter of the text pages).

    `last` without `first` asks for pages 1–`last`; `first` alone has no syntax
    in the helper's `--pages a-b`, so the whole document is laid out and the
    caller takes the pages it asked for.
    """
    exe = helper or find_helper()
    if not exe:
        raise LayoutUnavailable("the layout helper is not installed")
    args = [exe, str(pdf_path), "--concurrency", str(concurrency), "--scale", str(scale)]
    if last is not None:
        args += ["--pages", f"{first or 1}-{last}"]
    stream, code = _stream_helper(args, timeout, on_page)
    pages = dict(stream.pages)
    for number in _unanswered(stream.header, first, last):
        pages.setdefault(
            number,
            PageLayout(
                page=number,
                error=f"the layout helper did not answer for this page"
                + (f" (it exited with code {code})" if code else ""),
            ),
        )
    return pages


def _unanswered(header: HelperHeader, first: Optional[int], last: Optional[int]) -> range:
    """The pages of the requested range the helper was asked for and can have.

    Clamped by the header's own page count, so a range that runs past the end of
    the document asks for nothing rather than inventing pages the helper could
    not have answered.
    """
    lo = first or 1
    hi = last if last is not None else header.pages
    if hi is None:
        return range(0)
    if header.pages is not None:
        hi = min(hi, header.pages)
    return range(lo, hi + 1) if hi >= lo else range(0)


def _stream_helper(
    args: list[str], timeout: Optional[float], on_page: Optional[Callable[[int], None]]
) -> tuple[HelperStream, int]:
    """Run the helper and read its stream as it is written — `(stream, exit code)`.

    The helper's stderr is discarded, never passed through: the sidecar's stderr
    is the app's log (AC10), and PDFKit writes "CoreGraphics PDF has logged an
    error" there for many real books.
    """
    try:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    except OSError as err:
        raise LayoutUnavailable(f"the layout helper did not run ({type(err).__name__})") from err
    late: list[bool] = []
    killer = threading.Timer(timeout, lambda: (late.append(True), proc.kill())) if timeout else None
    try:
        if killer is not None:
            killer.start()
        try:
            stream = read_stream(proc.stdout, on_page)
        except LayoutUnavailable:
            if not late:
                proc.kill()
                raise
            # The kill is why the stream stopped where it did, so the timeout
            # below is the reason to report: a half-written stream has no header
            # to be judged on.
            stream = None
    finally:
        if killer is not None:
            killer.cancel()
        proc.wait()
    if late:
        raise LayoutUnavailable("the layout helper ran too long")
    return stream, proc.returncode
```

The `if not late` branch is the plan's own correction, found by the timeout test in Step 4: without it a killed-by-timeout helper raised *"wrote no header"*, because the kill ends the stream before the header line finishes arriving and `parse_header` sees an empty line.

and add `threading` to the imports at the top of the file (`import json` / `import os` / `import subprocess` / `import threading`).

One existing test has to change with the rule, and it changes in this step so every commit is green: that test's fake helper claims two pages in its header and prints one. In `sidecar/tests/test_reflow_vision.py`, replace the import line and `test_run_helper_reads_whatever_helper_it_is_given` with:

```python
from reflow.vision import LayoutUnavailable, find_helper, parse_stream, read_stream, run_helper
```

```python
PAGE_LINE = json.dumps({"page": 1, "box": [0, 0, 1, 1], "regions": [], "tables": []})


def page_line(number: int) -> str:
    return json.dumps({"page": number, "box": [0, 0, 1, 1], "regions": [], "tables": []})


def _header(pages: int) -> str:
    return json.dumps({"helper": "musaeum-layout", "version": 1, "supported": True, "pages": pages})


def _script(tmp_path, lines: list[str], exit_code: int = 0, body: str = ""):
    """A stand-in for the helper, answering exactly `lines`."""
    script = tmp_path / "fake"
    echo = "\n".join(f"echo '{line}'" for line in lines)
    script.write_text("#!/bin/sh\n" + echo + body + (f"\nexit {exit_code}\n" if exit_code else "\n"))
    script.chmod(0o755)
    return script


def test_run_helper_reads_whatever_helper_it_is_given(tmp_path):
    script = _script(tmp_path, [HEADER, PAGE_LINE, page_line(2)])
    assert list(run_helper(tmp_path / "x.pdf", helper=str(script))) == [1, 2]
```

```bash
$PY -m pytest sidecar/tests -k reflow -q
```

Expected: `90 passed` (no skips) with the helper built; `88 passed, 2 skipped` without it.

```bash
git add sidecar/reflow/vision.py sidecar/tests/test_reflow_vision.py
git commit -m "feat(sidecar): read the helper's stream as it is written, and count the pages it never answered

The helper answers pages in page order while it works concurrently, so reading
its pipe as it writes is free progress for a pass that takes minutes on a real
book (D7). Ignoring the exit code was the other half of the defect slice 1R's
review named: a helper killed mid-book looked exactly like a short document and
would have been cached as the book's whole reflow. Every page of the requested
range that never arrived is now an error line, clamped by the header's own page
count so a range past the document's end invents nothing; `--pages` is built
from either bound, so `last` without `first` no longer lays out the whole book.

One existing test's fake helper claimed two pages and printed one; under the
new rule that missing page is an error line, so the fake answers both.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Report the pass in its two phases**

`analyse` runs the helper and then reads every page into blocks. Measured (see *What was measured first*), the two halves cost about the same per page, so both report against the same page count and a caller can weigh them equally.

In `sidecar/reflow/layout.py`, import `Callable`, change `analyse`'s signature and docstring, forward a callback to the helper, and report each page the pass finishes. Replace the `analyse` definition's header with:

```python
def analyse(
    path: str,
    limit: Optional[int] = None,
    layouts: Optional[dict[int, PageLayout]] = None,
    progress: Optional[Callable[[str, int, int], None]] = None,
) -> Document:
    """A whole PDF → a Document the EPUB writer can lay out, or a verdict saying why not.

    `layouts` (keyed by 1-based page number) is the helper's answer; when it
    is `None` the helper is run. A book with no text layer never runs it.

    `progress(phase, done, total)` reports the pass while it runs: `layout` for
    the pages the helper answers, `reading` for the pages this pass turns into
    blocks, both against the same page count — the two halves measured 192–303
    and 216–340 ms per page on *Universe* (20 and 40 pages, 2026-10-08).
    """
```

and replace the two places that do the work inside it:

```python
        if layouts is None:
            def _helper_progress(done: int) -> None:
                if progress is not None:
                    progress("layout", done, count)

            try:
                layouts = run_helper(path, first=1, last=count, on_page=_helper_progress)
            except LayoutUnavailable as err:
                doc.verdict, doc.reason = "no_layout", err.reason
                return doc
        for i in range(count):
            doc.pages.append(_page(pdf[i], i, layouts.get(i + 1), doc))
            if progress is not None:
                progress("reading", i + 1, count)
```

```bash
$PY -m pytest sidecar/tests -k reflow -q
```

Expected: the same `90 passed` — nothing else calls `progress` yet.

```bash
git add sidecar/reflow/layout.py
git commit -m "feat(sidecar): analyse reports its two phases as progress

The helper's pages and the pass's own pages cost about the same per page
(192-303 ms against 216-340 ms on Universe), so both report against the page
count and a reader can weigh them equally (D7).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Pin the stream's rules**

Append five tests to `sidecar/tests/test_reflow_vision.py` (the helpers `PAGE_LINE`, `page_line`, `_header` and `_script` are already there from Step 2):

```python
def test_each_page_is_reported_as_its_line_arrives():
    """The helper answers in page order while it works, so `on_page` counts a
    real pass's pages; a line it cannot use is not a page."""
    seen: list[int] = []
    stream = read_stream([HEADER, PAGE_LINE, "not json", "", page_line(2)], on_page=seen.append)
    assert seen == [1, 2]
    assert stream.header.pages == 2 and sorted(stream.pages) == [1, 2]


def test_a_page_the_helper_never_answered_is_an_error_line(tmp_path):
    """A helper killed mid-book is not a short document: the pages it never
    answered are counted, so the book's verdict can weigh them (D6)."""
    script = _script(tmp_path, [_header(4), PAGE_LINE], exit_code=1)
    pages = run_helper(tmp_path / "x.pdf", first=1, last=4, helper=str(script))
    assert sorted(pages) == [1, 2, 3, 4]
    assert pages[1].error is None
    assert "code 1" in pages[2].error and "code 1" in pages[4].error


def test_the_unanswered_pages_stop_at_the_document_and_at_the_range(tmp_path):
    """A range that runs past the document's end asks for nothing: padding
    pages the helper could not have answered would read as degraded pages."""
    script = _script(tmp_path, [_header(3)], exit_code=1)
    assert sorted(run_helper(tmp_path / "x.pdf", first=2, last=9, helper=str(script))) == [2, 3]
    assert list(run_helper(tmp_path / "x.pdf", first=600, last=700, helper=str(script))) == []


def test_a_zero_exit_with_a_short_stream_is_still_counted(tmp_path):
    """The rule is the *pages*, not the exit code: a helper that returns 0
    having answered one of three pages leaves two degraded pages, and the
    book's verdict is where that is weighed."""
    script = _script(tmp_path, [_header(3), PAGE_LINE])
    pages = run_helper(tmp_path / "x.pdf", first=1, last=3, helper=str(script))
    assert sorted(pages) == [1, 2, 3] and "code" not in pages[2].error


def test_a_helper_that_never_answers_is_a_reason_not_a_hang(tmp_path):
    """`timeout` is the backstop for slice 3's RPC: a helper that hangs is a
    fallback reason, never a sidecar request that never returns."""
    script = _script(tmp_path, [], body="exec sleep 30\n")
    with pytest.raises(LayoutUnavailable) as err:
        run_helper(tmp_path / "x.pdf", helper=str(script), timeout=0.3)
    assert "too long" in err.value.reason
```

```bash
$PY -m pytest sidecar/tests -k reflow -q
```

Expected: `95 passed` with the helper built (`93 passed, 2 skipped` without it).

```bash
git add sidecar/tests/test_reflow_vision.py
git commit -m "test(sidecar): the helper's stream, its header, and the pages it never answered

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Run the whole sidecar suite and hand the task to review**

```bash
$PY -m pytest sidecar/tests -q
```

Expected: `349 passed` (or `347 passed, 2 skipped` with no helper built). Then dispatch the reviewer with: this plan, `sidecar/reflow/vision.py`, `sidecar/reflow/layout.py`, `sidecar/tests/test_reflow_vision.py`, `docs/invariants/packaging-and-python.md` (the helper's own cost and build) and `helpers/musaeum-layout/main.swift` — the last because the stream's contract (page order, one error line per failing page, exit 0 even when a page fails) is the Swift program's, not this module's.

---

### Task 2: An artifact with no clock in it, and its source-page map

**Files:**
- Modify: `sidecar/reflow/epub.py`
- Create: `sidecar/tests/test_reflow_produce.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `epub.write_epub(doc, out_path, title) -> dict` — the report gains `page_map`: `[{"href": "text/c001.xhtml", "title": … , "from_page": 1, "to_page": 12}, …]`, one entry per spine file, 1-based pages (D5). The existing keys (`sections`, `toc_entries`, `images`, `words`, `bytes`, `uid`) are unchanged.
  - `epub._entry(name, *, stored=False) -> zipfile.ZipInfo` and `epub._ZIP_DATE = (1980, 1, 1, 0, 0, 0)`.

- [ ] **Step 1: Give every zip entry a fixed date**

`zf.writestr` with a *name* stamps the entry with `time.localtime()` — measured, two runs over one document 1.2 s apart differ in every such entry's `date_time`. Replace the zip-writing block in `sidecar/reflow/epub.py`:

```python
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(_entry("mimetype", stored=True), "application/epub+zip")
        zf.writestr(_entry("META-INF/container.xml"), _container())
        zf.writestr(
            _entry("OEBPS/content.opf"),
            _opf(uid, title, os.path.basename(doc.source), modified, len(files), [(n, m) for n, _, m in images]),
        )
        zf.writestr(_entry("OEBPS/nav.xhtml"), _nav(items))
        zf.writestr(_entry("OEBPS/toc.ncx"), _ncx(items, uid, title))
        zf.writestr(_entry("OEBPS/style.css"), STYLESHEET)
        for i, (name, blocks) in enumerate(files):
            zf.writestr(_entry(f"OEBPS/text/c{i + 1:03d}.xhtml"), _xhtml(name, blocks, image_names))
        for name, data, _ in images:
            zf.writestr(_entry(f"OEBPS/images/{name}"), data)
```

and add, just above `write_epub`:

```python
# Every zip entry gets the same fixed date. `writestr` stamps an entry with the
# clock when it is given a name, so two runs over one PDF a second apart wrote
# different bytes — which is what slice 2's own bar ("every corpus book's
# artifact byte-stable across two runs") exists to catch. Measured 2026-10-08:
# the mimetype entry, made from a ZipInfo, was already 1980; the four documents
# and every image carried the run's second.
_ZIP_DATE = (1980, 1, 1, 0, 0, 0)


def _entry(name: str, *, stored: bool = False) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=_ZIP_DATE)
    info.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    return info
```

and extend the module docstring's *Deterministic on purpose* paragraph to say what it now covers:

```
**Deterministic on purpose.** The identifier and `dcterms:modified` derive from
the source file's size and mtime, not from the clock, and every zip entry is
written with a fixed date — `writestr` would stamp one with *now* otherwise,
which made two runs a second apart differ. Two runs over one source therefore
produce the same bytes, which is what makes "is this artifact stale?" a
comparable question (D9) and what slice 2's byte-stability bar measures.
```

- [ ] **Step 2: Report the source-page map (D5)**

In `write_epub`, after the `images` collection loop and before the `try: stat = os.stat(doc.source)` block, add:

```python
    # D5's map, the half a page anchor cannot carry: which spine file holds which
    # PDF pages. It is what lets a later "open the original at the page I was on"
    # (or a pdf.js view of the original) work without re-extracting anything.
    page_map = [
        {
            "href": f"text/c{i + 1:03d}.xhtml",
            "title": name,
            "from_page": min(b.page for b in blocks) + 1,
            "to_page": max(b.page for b in blocks) + 1,
        }
        for i, (name, blocks) in enumerate(files)
        if blocks
    ]
```

add `"page_map": page_map,` to the returned report, and add this paragraph to the module docstring after the *The source-page map lives in the file* paragraph:

```
`write_epub`'s report carries the other half of that map: one `page_map` entry
per spine file, with the range of PDF pages it holds (D5).
```

```bash
$PY -m pytest sidecar/tests -k reflow -q
```

Expected: `90 passed` — nothing reads `page_map` yet, and `sections` (the count) is untouched.

```bash
git add sidecar/reflow/epub.py
git commit -m "feat(sidecar): the artifact carries no clock, and reports its source-page map

`writestr` stamps a str-named zip entry with the current time, so two runs over
one PDF a second apart differed in every entry's date_time and slice 2's
byte-stability bar could never be met (measured 2026-10-08). Every entry now
takes a fixed date; the mimetype entry, built from a ZipInfo, already had one.

`write_epub`'s report also gains D5's map: one entry per spine file with the
range of PDF pages it holds, which is the half of the source-page map a page
anchor cannot carry.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Pin the artifact's rules in the new suite**

Create `sidecar/tests/test_reflow_produce.py`. Task 3 appends the production pass's own rules to this file; the docstring says what it owns, so the reviewer can hold it to that:

```python
"""The production pass, and the rules it rests on.

`produce.reflow_pdf` is the seam slice 3 calls, so what is pinned here is the
artifact (byte-stable across two runs, never half-written, never written at all
for a book the confidence gate refuses), the stamp D9 re-checks, and the
progress D7 shows. The artifact's determinism lives here too: it is a rule of
`write_epub` that no other test file owns, and it is the same bar Task 4
measures over the corpus.
"""

from __future__ import annotations

import time
import zipfile

from reflow.epub import write_epub
from reflow.model import Block, Document, PageResult
from reflow.outline import Entry


def _source(tmp_path):
    """A file for the artifact to be stamped from — the writer only stats it."""
    source = tmp_path / "A Book.pdf"
    source.write_bytes(b"%PDF-1.4\n% a stand-in for the book's own file\n")
    return source


def _doc(tmp_path, pages: int = 5) -> Document:
    doc = Document(source=str(_source(tmp_path)))
    for i in range(pages):
        doc.pages.append(
            PageResult(
                index=i,
                chars=500,
                top=792.0,
                bottom=0.0,
                blocks=[
                    Block("heading", text=f"Chapter {i + 1}", level=1, page=i, top=700.0),
                    Block("para", text="Body text on this page, and enough of it to read.", page=i, top=600.0),
                ],
            )
        )
    return doc


def test_every_zip_entry_carries_a_fixed_date(tmp_path):
    """Measured 2026-10-08: a str-named entry took the run's own second, so two
    runs a second apart differed and slice 2's byte-stability bar could not be
    met."""
    out = tmp_path / "one.epub"
    write_epub(_doc(tmp_path), str(out), "A Book")
    with zipfile.ZipFile(out) as zf:
        assert {info.date_time for info in zf.infolist()} == {(1980, 1, 1, 0, 0, 0)}


def test_two_runs_over_one_source_are_byte_identical(tmp_path):
    """The sleep crosses the second the removed clock had as its resolution."""
    doc = _doc(tmp_path)
    first, second = tmp_path / "one.epub", tmp_path / "two.epub"
    write_epub(doc, str(first), "A Book")
    time.sleep(1.1)
    write_epub(doc, str(second), "A Book")
    assert first.read_bytes() == second.read_bytes()


def test_the_report_maps_every_page_to_the_file_that_holds_it(tmp_path):
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
    assert max(entry["to_page"] for entry in report["page_map"]) == len(doc.pages)
```

```bash
$PY -m pytest sidecar/tests -k reflow -q
```

Expected: `93 passed` with the helper built (`91 passed, 2 skipped` without it). Then the same three tests must pass twice in a row, and the second run must not be a fluke of the clock:

```bash
$PY -m pytest sidecar/tests/test_reflow_produce.py -q
$PY -m pytest sidecar/tests/test_reflow_produce.py -q
```

```bash
git add sidecar/tests/test_reflow_produce.py
git commit -m "test(sidecar): the artifact's dates, its bytes across two runs, and its page map

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The pass, its stamp, and no residue

**Files:**
- Create: `sidecar/reflow/produce.py`
- Modify: `sidecar/main.py`
- Modify: `docs/data-contracts.md`
- Modify: `sidecar/tests/test_reflow_produce.py` (append)

**Interfaces:**
- Consumes: `epub.write_epub` and `epub.GENERATOR` (Task 2), `layout.analyse(path, limit, layouts, progress)` (Task 1), `outline.document_entries`, `vision.HELPER_VERSION`.
- Produces:
  - `produce.reflow_pdf(book_dir, pdf_path, *, book_id="", force=False, notify=None) -> dict` — `status` ∈ {`produced`, `cached`, `fallback`}, `reason` (D6's one line), `verdict` (`analyse`'s, or `write_failed`), `epub`/`stamp_file` (relative to `book_dir`, `""` when nothing was written), `converter`, `seconds`, and the stats `pages`, `text_pages`, `toc_entries`, `toc_from`, `figures`, `plates`, `words`, `bytes`, `page_map`, `layout_errors`, `vision_regions`.
  - `produce.artifact_paths(book_dir) -> (epub_path, stamp_path)`; `produce.read_stamp(path) -> Optional[dict]`; `produce.stamp_is_current(stamp, stat) -> bool`; `produce.converter_version() -> dict`; `produce.CONVERTER_VERSION`, `produce.STAMP_VERSION`; `produce._write_stamp(path, stamp)` (the seam Task 3's ordering test patches).
  - `main.METHODS["reflow_pdf"]`, streaming `reflow_progress` notifications.

- [ ] **Step 1: Write the pass**

Create `sidecar/reflow/produce.py`:

```python
"""The production pass: a PDF → `{book}/derived/reflow.epub` plus its stamp.

`reflow_pdf` is what the sidecar's RPC calls (spec D7). Around the pass slice 1R
already had (`analyse` → `document_entries` → `write_epub`) it adds the four
things that turn a working spike into a cache on a share:

- **The stamp (D9).** `derived/reflow.json` records the source PDF's size and
  mtime and the converter's version. A pass is skipped only when a stamp and an
  artifact are both there and the stamp matches the file on disk — so a replaced
  PDF, a new sidecar version or a new helper re-runs the pass instead of serving
  a stale rendering.
- **Temp-write, verify, rename (D9).** The EPUB is written to
  `derived/reflow.epub.tmp`, read back, and only then renamed over the old one;
  the stamp is written the same way *after* it, because an artifact no stamp
  describes is not an artifact. A failure at any point removes the temp — its own
  and any earlier run's — and, if this run created `derived/`, the folder.
- **One pass per book (D7, AC6).** The sidecar runs requests on four threads, so
  two opens can ask for the same book at once; a per-artifact lock makes the
  second wait and then find the first one's stamp current.
- **D6's verdict is `analyse`'s.** A book whose verdict is not `ok` writes
  nothing and returns the one line the reader shows.

What it deliberately does not touch: `metadata.json` (read for the title, never
written), any format file, the database, or anything else outside
`{book}/derived/` (AC2). A torn pass is one line on stderr and a fallback (D9,
invariant 12) — never a raised error.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import zipfile
from typing import Callable, Optional

from .epub import GENERATOR, write_epub
from .layout import analyse
from .outline import document_entries
from .vision import HELPER_VERSION

# pypdf logs every damaged xref it walks — "Ignoring wrong pointing object
# 2334", "incorrect startxref pointer(2)" — through `logging`, and Python's
# lastResort handler prints WARNING and above to stderr, which is the app's log
# (AC10). Measured 2026-10-08: walking the library's books that hold a PDF wrote
# thousands of these lines, and the same read at ERROR is silent. AC10's own
# escape hatch is "or the noise is explicitly suppressed in the pipeline
# module", which is this line; the helper's stderr is separately discarded in
# `vision._stream_helper`.
logging.getLogger("pypdf").setLevel(logging.ERROR)

# 1 was the slice-1R spike. Bump this whenever a change in `reflow/` moves the
# artifact's bytes: the stamp re-checks it, which is how a new converter version
# re-runs a pass instead of serving the old rendering (D9).
CONVERTER_VERSION = 2
STAMP_VERSION = 1
DERIVED = "derived"
EPUB_NAME = "reflow.epub"
STAMP_NAME = "reflow.json"
TMP = ".tmp"

# What a pass measured about the book, shared by the stamp and the result.
# `page_map` is D5's map, not a count (`write_epub`'s report also carries
# `sections`, which is the count).
STAT_KEYS = (
    "pages",
    "text_pages",
    "toc_entries",
    "toc_from",
    "figures",
    "plates",
    "words",
    "bytes",
    "page_map",
    "layout_errors",
    "vision_regions",
)
Progress = Callable[[str, int, int], None]
Notifier = Callable[[str, dict], None]

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def artifact_paths(book_dir: str) -> tuple[str, str]:
    """Where a book's artifact and its stamp live (D3)."""
    derived = os.path.join(book_dir, DERIVED)
    return os.path.join(derived, EPUB_NAME), os.path.join(derived, STAMP_NAME)


def converter_version() -> dict:
    """What D9 re-checks: a new sidecar version or a new helper re-runs the pass."""
    return {"sidecar": CONVERTER_VERSION, "helper": HELPER_VERSION, "generator": GENERATOR}


def read_stamp(stamp_path: str) -> Optional[dict]:
    """The stamp as it was written, or `None` when it cannot be read (D9)."""
    try:
        with open(stamp_path, encoding="utf-8") as fh:
            stamp = json.load(fh)
    except (OSError, ValueError):
        return None
    return stamp if isinstance(stamp, dict) else None


def stamp_is_current(stamp: Optional[dict], stat: os.stat_result) -> bool:
    """Would a pass over *this* file write this stamp now?"""
    if not isinstance(stamp, dict) or stamp.get("version") != STAMP_VERSION:
        return False
    source = stamp.get("source") or {}
    return (
        source.get("size") == stat.st_size
        and source.get("mtime") == int(stat.st_mtime)
        and stamp.get("converter") == converter_version()
    )


def _lock_for(path: str) -> threading.Lock:
    """One lock per artifact, so two opens of one book run one pass (AC6).

    One entry per book reflowed in this process: bounded by the library, and
    small.
    """
    with _locks_guard:
        lock = _locks.get(path)
        if lock is None:
            lock = _locks[path] = threading.Lock()
        return lock


def _inside(book_dir: str, path: str) -> bool:
    """D3's `derived/` is the book's: never write it into a folder we do not own."""
    return os.path.realpath(path).startswith(os.path.realpath(book_dir) + os.sep)


def _title(book_dir: str, pdf_path: str) -> str:
    """The EPUB's title: the canonical record's, else the file's own stem."""
    try:
        with open(os.path.join(book_dir, "metadata.json"), encoding="utf-8") as fh:
            title = (json.load(fh) or {}).get("title")
    except (OSError, ValueError):
        title = None
    return str(title or "").strip() or os.path.splitext(os.path.basename(pdf_path))[0]


def _stats(doc, report: dict) -> dict:
    return {
        "pages": len(doc.pages),
        "text_pages": len(doc.text_pages),
        "toc_entries": report["toc_entries"],
        "toc_from": "outline" if doc.entries_from_outline else "headings",
        "figures": doc.figures_detected,
        "plates": doc.plates,
        "words": report["words"],
        "bytes": report["bytes"],
        "page_map": report["page_map"],
        "layout_errors": doc.layout_errors,
        "vision_regions": doc.vision_regions,
    }


def _write_stamp(path: str, stamp: dict) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(stamp, fh, ensure_ascii=False, indent=1)


def _verify_epub(path: str) -> None:
    """The temp file is an EPUB this app can read, before it replaces a good one.

    `ZipFile` reads the central directory at the end of the file and the mimetype
    at its start, so a torn write — the failure a temp name exists to catch —
    fails here. `testzip()` would read every byte of a 56 MB artifact back over
    the share; the head and the tail are what a torn write loses.
    """
    with zipfile.ZipFile(path) as zf:
        if zf.read("mimetype") != b"application/epub+zip":
            raise ValueError("the written file is not an EPUB")
        missing = [
            name
            for name in ("META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml")
            if name not in zf.namelist()
        ]
    if missing:
        raise ValueError(f"the written EPUB has no {missing[0]}")


def _remove(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def reflow_pdf(
    book_dir: str,
    pdf_path: str,
    *,
    book_id: str = "",
    force: bool = False,
    notify: Optional[Notifier] = None,
) -> dict:
    """Produce — or re-use — one book's reflowed EPUB. Never raises (D6, D9).

    `status` is `produced`, `cached` or `fallback`; a fallback wrote nothing and
    carries D6's one line of reason. `notify(method, params)` receives
    `reflow_progress` frames while the pass runs: `phase` is `start`, `layout`,
    `reading`, `writing`, `done`, `cached` or `fallback`, and the two page phases
    carry `completed` of `total`.
    """
    started = time.perf_counter()
    result: dict = {
        "book_id": book_id,
        "status": "fallback",
        "reason": "",
        "verdict": "",
        "epub": "",
        "stamp_file": "",
        "converter": converter_version(),
        "seconds": 0.0,
        "pages": 0,
        "text_pages": 0,
        "toc_entries": 0,
        "toc_from": "",
        "figures": 0,
        "plates": 0,
        "words": 0,
        "bytes": 0,
        "page_map": [],
        "layout_errors": 0,
        "vision_regions": 0,
    }

    def progress(phase: str, done: int = 0, total: int = 0, **extra) -> None:
        if notify is not None:
            notify(
                "reflow_progress",
                {"book_id": book_id, "phase": phase, "completed": done, "total": total, **extra},
            )

    def finish(status: str = "") -> dict:
        if status:
            result["status"] = status
        result["seconds"] = round(time.perf_counter() - started, 1)
        return result

    def fallback(reason: str, verdict: str = "", **extra) -> dict:
        result["reason"] = reason
        result["verdict"] = verdict or result["verdict"]
        progress("fallback", reason=reason, verdict=result["verdict"], **extra)
        return finish("fallback")

    if not os.path.isdir(book_dir):
        return fallback("the book folder is not there")
    if not os.path.isfile(pdf_path) or not _inside(book_dir, pdf_path):
        return fallback("the book folder holds no PDF at that path")
    try:
        stat = os.stat(pdf_path)
    except OSError as err:
        return fallback(f"the PDF cannot be read ({type(err).__name__})")

    epub_path, stamp_path = artifact_paths(book_dir)
    with _lock_for(epub_path):
        if not force and os.path.exists(epub_path):
            stamp = read_stamp(stamp_path)
            if stamp_is_current(stamp, stat):
                result.update({key: stamp.get(key, result[key]) for key in STAT_KEYS})
                result["epub"] = os.path.relpath(epub_path, book_dir)
                result["stamp_file"] = os.path.relpath(stamp_path, book_dir)
                progress("cached", pages=result["pages"], bytes=result["bytes"])
                return finish("cached")

        # An earlier run that died mid-write, cleaned before this one starts, so
        # the folder's contents always mean "the last pass that finished".
        _remove(epub_path + TMP)
        _remove(stamp_path + TMP)
        derived = os.path.dirname(epub_path)
        made_dir = not os.path.isdir(derived)
        placed = False
        placed_stamp = False
        try:
            progress("start")
            doc = analyse(pdf_path, progress=progress)
            doc.entries = document_entries(pdf_path, doc)
            result["verdict"] = doc.verdict
            if doc.verdict != "ok":
                return fallback(doc.reason or "this book cannot be laid out")

            os.makedirs(derived, exist_ok=True)
            progress("writing")
            report = write_epub(doc, epub_path + TMP, _title(book_dir, pdf_path))
            _verify_epub(epub_path + TMP)
            os.replace(epub_path + TMP, epub_path)
            placed = True
            stats = _stats(doc, report)
            _write_stamp(
                stamp_path + TMP,
                {
                    "version": STAMP_VERSION,
                    "converter": converter_version(),
                    "source": {
                        "name": os.path.basename(pdf_path),
                        "size": stat.st_size,
                        "mtime": int(stat.st_mtime),
                    },
                    **stats,
                },
            )
            os.replace(stamp_path + TMP, stamp_path)
            placed_stamp = True
            result.update(stats)
            result["epub"] = os.path.relpath(epub_path, book_dir)
            result["stamp_file"] = os.path.relpath(stamp_path, book_dir)
            progress("done", pages=result["pages"], bytes=result["bytes"], toc_entries=result["toc_entries"])
            return finish("produced")
        except Exception as err:  # noqa: BLE001 — a torn pass is a fallback, not a traceback
            print(f"reflow: {pdf_path}: {type(err).__name__}: {err}", file=sys.stderr, flush=True)
            return fallback(f"the reflow could not be written ({type(err).__name__})", verdict="write_failed")
        finally:
            _remove(epub_path + TMP)
            _remove(stamp_path + TMP)
            if placed and not placed_stamp:
                # An artifact no stamp describes is not an artifact: the next open
                # would re-run anyway, and D6 says a book that could not be
                # produced keeps the original path with nothing behind it.
                _remove(epub_path)
            if made_dir:
                try:
                    os.rmdir(derived)
                except OSError:
                    pass  # something is in it, so it is not this run's residue
```

- [ ] **Step 2: Wire the RPC**

In `sidecar/main.py`, add to the imports:

```python
from reflow.produce import reflow_pdf
```

and to `METHODS`, after the `topup_pdfs` entry:

```python
    # The reflow pipeline (spec D7/D9). Long, loud about its progress and quiet
    # about its failures: a book that cannot be laid out returns one line of
    # reason, never an error, and nothing is written outside `{book}/derived/`.
    # `book_id` is echoed back in every progress frame so the caller can tell two
    # books' passes apart on one notification channel.
    "reflow_pdf": lambda p: reflow_pdf(
        book_dir=p["book_dir"],
        pdf_path=p["pdf_path"],
        book_id=p.get("book_id", ""),
        force=bool(p.get("force")),
        notify=notify,
    ),
```

In `docs/data-contracts.md`, add this row to the sidecar method table after `topup_pdfs`:

```markdown
| `reflow_pdf`            | Reflow a book's PDF into `{book}/derived/reflow.epub` + `reflow.json` (cached; temp-write-and-rename); streams `reflow_progress` notifications |
```

```bash
$PY -m pytest sidecar/tests -q
```

Expected: `349 passed` — import of `main` now pulls `reflow.produce` (and pypdfium2 with it) into the sidecar's start-up, which `test_main_dispatch.py` exercises; nothing else changes.

```bash
git add sidecar/reflow/produce.py sidecar/main.py docs/data-contracts.md
git commit -m "feat(sidecar): the reflow pass, its stamp and its lock, behind reflow_pdf

Promotes the pass slice 1R built to the RPC slice 3 will call: it caches on the
source's size, mtime and converter version (D9), takes one lock per artifact so
two opens of one book run one pass (D7/AC6), writes through a temp name it reads
back before renaming, and lands the stamp last — an artifact no stamp describes
is removed again. A book whose verdict is not ok writes nothing and returns D6's
one line of reason, and nothing outside {book}/derived/ is touched (AC2).

Progress is the reflow_progress channel, in the two phases analyse reports plus
start/writing/done/cached/fallback. pypdf's own warnings are suppressed here:
measured on the library's damaged PDFs they run to thousands of lines on stderr,
which is the app's log (AC10).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Pin the pass's rules**

Append to `sidecar/tests/test_reflow_produce.py`. First the imports and fixtures — replace the file's import block and add the fixtures after `_doc`:

```python
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
```

```python
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
```

Then the tests:

```python
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
    source must reproduce the artifact *and* its stamp byte for byte.
    """
    book_dir, pdf = book()
    assert reflow_pdf(book_dir, pdf)["status"] == "produced"
    epub_path, stamp_path = artifact_paths(book_dir)
    before = (hashlib.sha256(open(epub_path, "rb").read()).hexdigest(), hashlib.sha256(open(stamp_path, "rb").read()).hexdigest())
    forced = reflow_pdf(book_dir, pdf, force=True)
    assert forced["status"] == "produced" and runs(helper) == 2
    after = (hashlib.sha256(open(epub_path, "rb").read()).hexdigest(), hashlib.sha256(open(stamp_path, "rb").read()).hexdigest())
    assert after == before


def test_a_touched_source_re_runs_the_pass(book, helper):
    """D9: a replaced PDF is not served from the old stamp. `os.utime` moves the
    mtime alone, which is the finest half of the pair the stamp records.
    """
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
    book_dir, pdf = book_of_textless_pages(tmp_path)   # see below
    result = reflow_pdf(book_dir, pdf)
    assert result["status"] == "fallback" and result["verdict"] == "no_text_layer"
    assert result["reason"] == "no page carries a text layer" and result["epub"] == ""
    assert not os.path.exists(os.path.join(book_dir, "derived"))
    assert runs(helper) == 0
```

`book_of_textless_pages` is the one fixture the `book` factory cannot make (its `plate=True` default mixes a plate into text pages); add it with the other helpers:

```python
def book_of_textless_pages(tmp_path):
    """An image-only book: the corpus's *Complete Guide to Asterix*, small."""
    book_dir = tmp_path / "books" / "asterix"
    book_dir.mkdir(parents=True)
    pdf = write_pdf(book_dir / "Asterix.pdf", [plate_page(), plate_page()])
    return str(book_dir), str(pdf)
```

```python
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
    whole reflow. Five text pages, two answered, three counted.
    """
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
    degraded artifact needs.
    """
    book_dir, pdf = book(pages=5, plate=False)
    monkeypatch.setenv("FAKE_PAGES", "5")
    monkeypatch.setenv("FAKE_DIE_AFTER", "4")
    result = reflow_pdf(book_dir, pdf)
    assert result["status"] == "produced" and result["verdict"] == "ok"
    assert result["layout_errors"] == 1 and read_stamp(artifact_paths(book_dir)[1])["layout_errors"] == 1


def test_two_calls_on_one_book_run_the_pass_once(book, helper, monkeypatch):
    """The sidecar's pool runs four requests at once, so two opens can ask for
    the same book together (AC6): the lock is taken before the cache check.
    """
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
    caller's book id comes back on every frame.
    """
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
    original with nothing behind it: no artifact, no `.tmp`, no empty folder.
    """
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
    artifact with it: an EPUB no stamp describes would be re-run anyway.
    """
    book_dir, pdf = book()

    def no_stamp(*args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(produce, "_write_stamp", no_stamp)
    result = reflow_pdf(book_dir, pdf)
    assert result["status"] == "fallback"
    assert not os.path.exists(artifact_paths(book_dir)[0])
    assert sorted(os.listdir(book_dir)) == ["A Book.pdf", "metadata.json"]


def test_a_previous_runs_temp_is_cleaned_before_the_next_run(book, helper):
    book_dir, pdf = book()
    derived = os.path.join(book_dir, "derived")
    os.makedirs(derived)
    for name in ("reflow.epub.tmp", "reflow.json.tmp"):
        with open(os.path.join(derived, name), "w") as fh:
            fh.write("torn")
    assert reflow_pdf(book_dir, pdf)["status"] == "produced"
    assert sorted(os.listdir(derived)) == ["reflow.epub", "reflow.json"]


def test_the_pass_writes_nothing_but_its_own_folder(book, helper):
    """AC2 and AC3's posture: the canonical record and every format file are
    byte-identical after a pass, and `derived/` is the only thing that appeared.
    """
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


def test_pypdf_chatter_never_reaches_the_app_log(tmp_path, capsys):
    """AC10. Measured 2026-10-08: a read of the library's damaged PDFs wrote
    thousands of pypdf warnings to stderr, which is the app's log; at ERROR the
    same read is silent, and AC10 allows exactly that ("or the noise is
    explicitly suppressed in the pipeline module").
    """
    import logging

    from reflow.outline import outline_entries

    logger = logging.getLogger("pypdf")
    assert logger.level == logging.ERROR

    damaged = tmp_path / "damaged.pdf"
    write_pdf(damaged, [text_page()])
    damaged.write_bytes(damaged.read_bytes().replace(b"startxref\n", b"startxref\n9", 1))

    level = logger.level
    logger.setLevel(logging.WARNING)
    try:
        outline_entries(str(damaged))
        assert capsys.readouterr().err  # the fixture really does provoke it
    finally:
        logger.setLevel(level)

    outline_entries(str(damaged))
    assert capsys.readouterr().err == ""


def test_the_real_helper_produces_a_readable_artifact(book):
    """The one test that needs Vision: the whole production path, from a PDF to
    an EPUB the package checks accept.
    """
    if find_helper() is None:
        pytest.skip("needs the built layout helper (scripts/build-layout-helper.sh)")
    book_dir, pdf = book()
    result = reflow_pdf(book_dir, pdf)
    assert result["status"] == "produced" and result["figures"] >= 0
    assert gate.check_package(artifact_paths(book_dir)[0]) == []
```

Two helpers those tests use are worth naming as fixtures themselves, so the `book` factory stays about books. Add:

```python
def a_folder(tmp_path, name: str, title: str = "A Book"):
    """An empty book folder with one text PDF in it."""
    book_dir = tmp_path / "books" / name
    book_dir.mkdir(parents=True, exist_ok=True)
    pdf = write_pdf(book_dir / f"{title}.pdf", [text_page()])
    return str(book_dir), str(pdf)
```

```bash
$PY -m pytest sidecar/tests/test_reflow_produce.py -q
```

Expected: all green, and the file twice in a row (the determinism assertions must not depend on the clock's second):

```bash
$PY -m pytest sidecar/tests/test_reflow_produce.py -q
$PY -m pytest sidecar/tests/test_reflow_produce.py -q
$PY -m pytest sidecar/tests -q
```

Expected for the last: `371 passed` with the helper built (`369 passed, 2 skipped` without it) — 349 before this task, plus its 22 tests.

```bash
git add sidecar/tests/test_reflow_produce.py
git commit -m "test(sidecar): the pass's cache, its stamp, its residue and its progress

The rules this slice is answerable for, each against a fake helper that counts
its own runs: the stamp's three re-run triggers (source size, source mtime,
converter version) and its cache hit, one pass per book under two threads, no
residue when the write or the stamp fails, the D6 fallback for a textless book
and for a helper killed mid-book with its three lost pages counted, and the two
progress phases a reader shows. AC2's promise is measured too: metadata.json and
every format file are byte-identical after a pass.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The corpus, through the production path

**Files:**
- Modify: `scripts/pdf-reflow-probe.py`
- Modify: `tasks.md`

**Interfaces:**
- Consumes: `produce.reflow_pdf`, `produce.artifact_paths`, `produce.read_stamp` (Task 3); the probe's own `CORPUS`, `book()`, `pdf_in()`, `gate_book()` and `print_gate()`.
- Produces: `scripts/pdf-reflow-probe.py --production [--out DIR] [--book TITLE]` — writes `{out}/books/{slug}/derived/…` and `{out}/report.json`, prints the per-book measures and the gate, and exits non-zero only for a failure of *this slice's* bar or a book that passed Annex C.7 run 2 and fails now. `PRODUCTION_DIR`, `production_book`, `production_failed`, `gate_regression`.

Why a harness rather than six ad-hoc commands: slice 3 will want exactly this (a way to exercise the production path over the corpus without Electron), and the bar it measures is the one this slice is signed off on. It **never writes to the library**: the mount is read-only and the spike's own rule is "reads the library, writes only to `--out`", so each PDF is copied once into `{out}/books/{slug}/` with its mtime — which is also what makes the stamp's mtime check meaningful on a scratch copy.

- [ ] **Step 1: Add `--production` to the probe**

In `scripts/pdf-reflow-probe.py`, add `import hashlib` and `import shutil` to the imports (both are stdlib and the file already imports `glob`/`json`/`os`/`re`/`sqlite3`/`sys`/`time`), then add the harness at the end of the module, just above `def main(`:

```python
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
# cached on the next open, re-run on a touched source, and nothing but
# `derived/` written into the book folder.
BAR = ("produced", "byte_stable", "cached", "stamp_reran", "only_derived_changed")


def _sha(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()[:16]


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
    """
    doc = analyse(pdf)
    doc.entries = document_entries(pdf, doc)
    rec["gate_layout_errors"] = doc.layout_errors
    rec["gate_verdict"] = doc.verdict
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
    digest = (_sha(epub_path), _sha(stamp_path))
    second = _run(book_dir, pdf, force=True)
    rec["byte_stable"] = second["status"] == "produced" and digest == (_sha(epub_path), _sha(stamp_path))
    rec["cached"] = _run(book_dir, pdf)["status"] == "cached"
    rec["residue"] = [name for name in _listing(os.path.dirname(epub_path)) if name.endswith(".tmp")]
    rec["only_derived_changed"] = _listing(book_dir) == sorted([*before, "derived"])

    # A touched source is a different document (D9), so it re-runs and the fresh
    # stamp is current again afterwards.
    later = int(os.stat(pdf).st_mtime) + 60
    os.utime(pdf, (later, later))
    rec["stamp_reran"] = _run(book_dir, pdf)["status"] == "produced"
    rec["stamp_reran_again"] = _run(book_dir, pdf)["status"] == "cached"
    rec["stamp_mtime"] = read_stamp(stamp_path)["source"]["mtime"] if read_stamp(stamp_path) else None
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
        failed = [check for check in CHECKS if rec["gate"].get(check)]
        if title in PASSED_IN_RUN_2 and failed:
            bad.append(f"{title}: passed Annex C.7 run 2 and fails {failed} now")
        elif title not in PASSED_IN_RUN_2 and not failed:
            print(f"NOTE  {title}: failed Annex C.7 run 2 and passes the gate now — the owner's to read, not this run's verdict")
    return bad


def print_production(records: list[dict], report: str) -> None:
    header = f"{'book':42s} {'status':<9s} {'pages':>6s} {'sec':>7s} {'ms/pg':>6s} {'MB':>7s} {'toc':>5s} {'figs':>5s} {'stable':>7s} {'cache':>6s}"
    print(header)
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
        f"{sum(1 for r in written if r.get('stamp_reran'))} re-ran on a touched source, "
        f"{sum(1 for r in written if r.get('only_derived_changed'))} wrote only derived/"
    )
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
```

In `main`, add the flag to the argument loop (`--out` gains `explicit_out = True` beside `out_dir = argv[i]`, and `production_mode = False` sits with the other option variables):

```python
        elif arg == "--production":
            production_mode = True
```

and, right after `root = library_root()`:

```python
    if production_mode:
        return production(os.path.abspath(out_dir if explicit_out else "dist/reflow-production"), root, only)
```

Add the three invocations to the module docstring's usage block:

```
    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --production
    sidecar/.venv/bin/python scripts/pdf-reflow-probe.py --production --book "Attention"
```

and a sentence to the docstring's "writes only to the output directory" paragraph: `--production` copies each corpus PDF into `--out` and runs the production pass (`sidecar/reflow/produce.py`) over the copy, because the mount is read-only and the pass writes `derived/` beside the book.

```bash
$PY scripts/pdf-reflow-probe.py --production --book "Sequence to Sequence" --out /tmp/reflow-production-smoke
```

Expected in a couple of minutes: one book written, `production: 1/1 written, 1 byte-stable across two runs, 1 cached on the next open, 1 re-ran on a touched source, 1 wrote only derived/`, its gate line, and exit 0.

```bash
git add scripts/pdf-reflow-probe.py
git commit -m "feat(scripts): the probe runs the production pass over the corpus

`--production` copies each corpus PDF into --out (the mount is read-only, and the
pass writes derived/ beside the book), then measures slice 2's bar per book: an
artifact written, two forced runs over the unchanged source byte-identical, the
next open served from the cache, a touched source re-running the pass, and
nothing but derived/ written into the book folder. Each artifact is gated with
Annex C.4's exclusions, computed from a fresh layout of the source, and the exit
code answers this slice's bar plus a regression against the books Annex C.7 run
2 passed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Run the whole corpus through it**

This is the slice's own gate, and it is slow: four full passes and one layout per book, so roughly 25–40 minutes with `Universe` (305 MB, 535 pages) and `Modernist Cuisine` (299 MB, 355 pages) in it.

```bash
$PY scripts/pdf-reflow-probe.py --production 2>&1 | tee /tmp/reflow-production.txt
```

Expected: `production: 5/5 written, 5 byte-stable across two runs, 5 cached on the next open, 5 re-ran on a touched source, 5 wrote only derived/`, exit 0, and `gate: 4/6 books pass` — the same four. **Then compare the per-check lines with Annex C.7 run 2 by hand**, book by book: the content rules are frozen, so *Universe*'s G3 (7 rotated words) and G5 (222 of 255), *Politics*' G5 (21 of 31) and the three passes should read the same numbers, and *Asterix* should read `G8 pass — no artifact`. A book that passed run 2 and fails here stops the slice: report it rather than tuning it. `dist/reflow-production/report.json` carries every measure.

- [ ] **Step 3: Record the outcome in `tasks.md`**

Replace the sentence in C2's entry that begins "**Next, slice 2 — the pipeline, production:**" and runs to "(≤7 files, the spec's own slice row)." with:

```markdown
**Slice 2 — the pipeline, production — landed 2026-10-08** on `feat/pdf-reflow-slice-2`: the pass is promoted behind a `reflow_pdf` RPC with `reflow_progress` notifications (two phases, the helper's streamed pages and the pass's own), `{book}/derived/reflow.epub` beside its `reflow.json` stamp (the source's size and mtime, the converter and helper versions, and D5's source-page map), temp-write-verify-rename with no residue on a torn pass, D6's confidence gate, and one pass per book under the sidecar's four threads. Measured on the corpus through the production path (`scripts/pdf-reflow-probe.py --production`): NUM/NUM text books wrote artifacts, NUM byte-identical (artifact *and* stamp) across two forced runs over the unchanged source, NUM cached on the next open, NUM re-ran on a touched source, nothing written outside `derived/`, and the gate reads the same per-book result as Annex C.7 run 2, which is the point — **the artifact's content rules are frozen** in this slice. Slice 1R's carries that would move content stayed where they belong: `outline.is_junk`'s Roman-folio over-reach (a strict numeral grammar kills `Civil`/`Mild`/`DIM` while keeping `viii`/`xii`/`xiii`; it touches no corpus book) and the 80-character furniture cap are named, measured and left for slice 3, and the two decisions open questions 7–9 carry are still the owner's.
```

filling every NUM from `/tmp/reflow-production.txt` and the pytest count from Task 3's last run.

```bash
git add tasks.md
git commit -m "docs: C2 records slice 2 — the portfolio pipeline is production, and what it measured

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand the slice back**

Report, in this order: the plan's path; per task the commit, the tests and the measured numbers; the corpus table above; what slice 3 needs (below); and the two decisions the owner still owes (open questions 7–9). Do not push.

---

## Carried in, and where each one goes

Slice 1R's reviews left five measured things behind. This plan places every one of them; three are fixed here, two are named for the slice that owns them and the reason it does.

| Carried in | Where it goes, and why |
| --- | --- |
| Artifacts are content-deterministic but not byte-deterministic: every zip entry carries the clock | **Fixed, Task 2.** It is slice 2's own bar, so it cannot be deferred; the fix is one fixed date per entry and a test that crosses the clock's second |
| `vision.run_helper` never reads the header's `pages` and ignores the return code, so a helper killed mid-book looks like a short document; `last` without `first` lays out the whole book | **Fixed, Task 1.** A production pass caches its result *once* (D2), so a short stream silently cached as the whole book is the worst failure this slice could ship; `_unanswered` makes the loss visible to D6's own tolerance, and `--pages` is built from either bound |
| Helpers/bin ships in no bundle: `electron-builder.yml` has no `helpers/` entry, so a packaged build falls back on every book | **Not this slice — slice 3, first step.** The helper's `<extraResources>` entry, and `find_helper()`'s packaged path (`parents[2]/helpers/bin` resolves to `Contents/Resources/helpers/bin`), are packaging work in `electron-builder.yml` and `services/`, and this slice's brief names only `sidecar/`. It is the first thing slice 3 must do after wiring the RPC: a packaged build otherwise reports `no_layout` for every book with no code defect to find. Package cost: 149 KB against AC9's ≤ 1 MB |
| `outline.is_junk`'s `^[ivxlcdm]+$` also drops real titles (`Civil`, `Mild`, `DIM`) | **Not this slice — named for slice 3.** It is a content rule, and this slice's whole claim is that the artifact reads as the one the owner accepted in 1R (the corpus comparison in Task 4). Measured before deciding: a strict Roman grammar (`^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$`) kills all three titles and keeps every real folio; the fix touches no corpus number (0 word-like Roman drops in five of the six outlines, and *Modernist*'s three are exactly the folios the rule exists for); residual words a strict grammar still drops: `mix`, `civ` |
| The 80-character furniture cap leaves *Universe*'s 276–460-character `Copyright … Cengage` footer in the flow on 323 of 530 text pages; five of its chapter titles are truncated by a figure crop over 80% of the page | **Not this slice — the owner's, alongside open questions 7–9.** Both are Annex C.5 threshold rules, and changing either moves the G5/G6 numbers the owner is already deciding the bar for (question 9 names those truncated titles as the repair to make *before* the bar is revisited). Doing it here would change the artifact's content in the same slice that measures it against the accepted reading |

## What slice 3 will need from this one

- **`reflow_pdf`'s result, verbatim:** `status` (`produced`/`cached`/`fallback`), `reason` (D6's one line to show), `verdict`, `epub` and `stamp_file` relative to the book folder, `bytes`, `sections` (`page_map`) for a later "open the original at this page", and `converter`. A `cached` result is a complete one — the reader does not need to re-read the stamp.
- **The notifications:** `reflow_progress` with `{book_id, phase, completed, total}`; `phase` ∈ `start`, `layout`, `reading`, `writing`, `done`, `cached`, `fallback`. The two page phases share one page count, so a bar can show `completed/total` of either or of the sum.
- **The cache rule it can rely on:** the stamp is current only when the source's size and mtime and the converter version match, so slice 3 does not need its own staleness check; and two opens of one book already run one pass.
- **The packaging entry** (first table row above), and **`derived/reflow.epub`'s route**: `book-bytes.ts`'s allowlist needs the one place a reflow file can live, which is `{book}/derived/reflow.epub` and nothing else — the same rule `produce.artifact_paths` encodes.

## Review Focus for the reviewer of this plan (dispatch/close-out)

1. Each task's own *Review Focus* items from *Review Focus* above, pinned by the named test.
2. Every commit's message says what changed and, where the change was forced by a measurement, names the measurement.
3. `git diff main...feat/pdf-reflow-slice-2 --stat`: 7 files in the spec's row plus the probe, `docs/data-contracts.md` and `tasks.md` — nothing else, and no `.md` file hard-wrapped.
4. The corpus comparison with Annex C.7 run 2, book by book, before the slice is called done.
