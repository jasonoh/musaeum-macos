# PDF Support + Calibre PDF Top-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pdf` a first-class Musaeum format (import, covers, hydration, Kindle transfer) and add a re-runnable "Import PDFs from Calibre" top-up tool that attaches skipped PDFs to already-migrated books and imports the ~2,000 PDF-only books.

**Architecture:** The sidecar gains a PDF extractor (`pypdf` metadata + `pypdfium2` page-1 cover render) wired into the existing hydration pipeline, plus a `topup_pdfs` pipeline that matches Calibre records against a library index passed from Node (Goodreads ID → ISBN-13 → normalized title+author) and either copies the PDF into an existing `books/{uuid}/` folder or migrates a new book via the existing `_migrate_one`. Node adds `pdf` to every format allowlist, a no-conversion Kindle rule for PDF, a `startPdfTopUp` orchestrator reusing the migration progress channel, and a top-up entry in the migration wizard.

**Tech Stack:** Python 3.12 sidecar (pypdf, pypdfium2, Pillow, pytest), Electron main (TypeScript, better-sqlite3), React renderer.

**Spec:** `docs/superpowers/specs/2026-07-14-pdf-multimachine-reader-design.md` (Section A).

## Global Constraints

- Format scope is exactly `epub | mobi | azw3 | pdf`. Misc Calibre formats (doc, cbr, cbz, chm, djvu, azw, rar) stay out.
- Calibre's `metadata.db` is only ever opened read-only via the existing immutable-open helper (`extractors/calibre_db.py`). Never write to or lock the Calibre library.
- `ebook-convert` is never invoked for PDFs — a PDF-only book transfers to Kindle as PDF.
- The top-up tool must be idempotent: re-running it skips books whose folder already contains a `.pdf`.
- All IPC handlers stay thin — business logic lives in `electron/main/services/` (per CLAUDE.md).
- TypeScript strict, no `any`. Keep `npm run typecheck` and `npm run lint` clean after every Node-side task.
- Python venv: `sidecar/.venv/bin/python`; run pytest as `sidecar/.venv/bin/python -m pytest sidecar/tests -v` from the repo root.
- Commit after every task (small, descriptive commits; end commit messages with the Claude Code co-author trailer used in this repo).

---

### Task 1: Sidecar PDF extractor + pytest scaffolding

**Files:**
- Modify: `sidecar/requirements.txt`
- Create: `sidecar/requirements-dev.txt`
- Create: `sidecar/extractors/pdf_metadata.py`
- Create: `sidecar/tests/__init__.py` (empty)
- Create: `sidecar/tests/conftest.py`
- Test: `sidecar/tests/test_pdf_metadata.py`

**Interfaces:**
- Produces: `extract_pdf_metadata(file_path: str) -> dict` returning `{"title": str|None, "authors": [{"name": str, "sort": None}], "identifiers": {}}` — same shape the importer's `ExtractedMetadata` expects.
- Produces: `render_pdf_cover(file_path: str) -> bytes | None` — JPEG bytes of page 1, or None on failure. Consumed by Task 2 (hydration) and Task 4 (top-up cover fallback).

- [ ] **Step 1: Add dependencies and install**

Append to `sidecar/requirements.txt`:

```
pypdf>=4.0
pypdfium2>=4.30
```

Create `sidecar/requirements-dev.txt`:

```
-r requirements.txt
pytest>=8.0
```

Run: `sidecar/.venv/bin/pip install -r sidecar/requirements-dev.txt`
Expected: pypdf, pypdfium2, pytest install without errors.

- [ ] **Step 2: Write the failing tests**

Create empty `sidecar/tests/__init__.py`.

Create `sidecar/tests/conftest.py`:

```python
import sys
from pathlib import Path

# Make sidecar modules importable exactly as the sidecar itself imports them
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
```

Create `sidecar/tests/test_pdf_metadata.py`:

```python
import io

import pytest
from PIL import Image
from pypdf import PdfWriter

from extractors.pdf_metadata import extract_pdf_metadata, render_pdf_cover


@pytest.fixture
def pdf_with_metadata(tmp_path):
    path = tmp_path / "sample.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_metadata({"/Title": "Practical SQL", "/Author": "Anthony DeBarros"})
    with open(path, "wb") as fh:
        writer.write(fh)
    return str(path)


@pytest.fixture
def pdf_without_metadata(tmp_path):
    path = tmp_path / "1982_scan_final_v2.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    with open(path, "wb") as fh:
        writer.write(fh)
    return str(path)


def test_extracts_embedded_title_and_author(pdf_with_metadata):
    result = extract_pdf_metadata(pdf_with_metadata)
    assert result["title"] == "Practical SQL"
    assert result["authors"] == [{"name": "Anthony DeBarros", "sort": None}]
    assert result["identifiers"] == {}


def test_missing_metadata_returns_none_title(pdf_without_metadata):
    result = extract_pdf_metadata(pdf_without_metadata)
    assert result["title"] is None
    assert result["authors"] == []


def test_corrupt_file_raises(tmp_path):
    bad = tmp_path / "not_a.pdf"
    bad.write_bytes(b"this is not a pdf")
    with pytest.raises(Exception):
        extract_pdf_metadata(str(bad))


def test_render_cover_returns_decodable_jpeg(pdf_with_metadata):
    data = render_pdf_cover(pdf_with_metadata)
    assert data is not None
    img = Image.open(io.BytesIO(data))
    assert img.format == "JPEG"
    assert img.width >= 400


def test_render_cover_returns_none_for_corrupt_file(tmp_path):
    bad = tmp_path / "not_a.pdf"
    bad.write_bytes(b"junk")
    assert render_pdf_cover(str(bad)) is None
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_pdf_metadata.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'extractors.pdf_metadata'`

- [ ] **Step 4: Implement the extractor**

Create `sidecar/extractors/pdf_metadata.py`:

```python
"""Embedded PDF metadata + first-page cover rendering.

PDFs rarely carry identifiers, so extraction returns title/author only;
hydration then works from title+author search. Cover: page 1 rendered via
pdfium at ~2x, JPEG-encoded — fed to pipeline.cover._write_cover by callers.
"""

import io
from typing import Optional

from PIL import Image
from pypdf import PdfReader

RENDER_SCALE = 2.0  # 612pt page * 2 ≈ 1224px wide — plenty for a 600px cover


def extract_pdf_metadata(file_path: str) -> dict:
    reader = PdfReader(file_path)
    meta = reader.metadata
    title = (meta.title or "").strip() if meta and meta.title else None
    author = (meta.author or "").strip() if meta and meta.author else None
    return {
        "title": title or None,
        "authors": [{"name": author, "sort": None}] if author else [],
        "identifiers": {},
    }


def render_pdf_cover(file_path: str) -> Optional[bytes]:
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(file_path)
        try:
            if len(pdf) == 0:
                return None
            bitmap = pdf[0].render(scale=RENDER_SCALE)
            image = bitmap.to_pil()
        finally:
            pdf.close()
        if image.mode != "RGB":
            image = image.convert("RGB")
        buf = io.BytesIO()
        image.save(buf, "JPEG", quality=90)
        return buf.getvalue()
    except Exception:
        return None
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_pdf_metadata.py -v`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add sidecar/requirements.txt sidecar/requirements-dev.txt sidecar/extractors/pdf_metadata.py sidecar/tests/
git commit -m "feat(sidecar): PDF metadata extractor + page-1 cover render, pytest scaffolding"
```

---

### Task 2: Wire PDFs into hydration and the sidecar RPC surface

**Files:**
- Modify: `sidecar/pipeline/hydration.py:33-50` (embedded step) and `:86-94` (cover candidates)
- Modify: `sidecar/main.py:38-63` (METHODS table)
- Test: `sidecar/tests/test_hydration_pdf.py`

**Interfaces:**
- Consumes: `extract_pdf_metadata`, `render_pdf_cover` from Task 1.
- Produces: `hydrate_metadata` accepts a `.pdf` `file_path` — embedded title/author come from the PDF Info dict, and the page-1 render competes as an `embedded` cover candidate. New RPC method `extract_pdf_metadata` (params: `{file_path}`), consumed by Node in Task 3.

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/test_hydration_pdf.py`:

```python
import os

import pytest
from pypdf import PdfWriter

import pipeline.hydration as hydration


@pytest.fixture
def pdf_book(tmp_path):
    path = tmp_path / "book.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_metadata({"/Title": "Deep Work", "/Author": "Cal Newport"})
    with open(path, "wb") as fh:
        writer.write(fh)
    return str(path)


def test_hydrate_pdf_uses_embedded_metadata_and_renders_cover(
    pdf_book, tmp_path, monkeypatch
):
    # Offline: neutralize the network fetchers
    monkeypatch.setattr(hydration, "fetch_google_books", lambda *a: None)
    monkeypatch.setattr(hydration, "fetch_openlibrary", lambda *a: None)
    monkeypatch.setattr(hydration, "fetch_series", lambda *a: None)

    book_dir = str(tmp_path / "out")
    os.makedirs(book_dir)
    result = hydration.hydrate_metadata(
        book_id="test-id",
        file_path=pdf_book,
        book_dir=book_dir,
        known={},
        source_preferences={},
    )

    assert result["metadata"]["title"] == "Deep Work"
    assert result["cover"] == {"full": "cover_full.jpg", "thumb": "cover_thumb.jpg"}
    assert os.path.exists(os.path.join(book_dir, "cover_thumb.jpg"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_hydration_pdf.py -v`
Expected: FAIL — `result["metadata"]` lacks the title (embedded step is epub-only today) and `result["cover"]` is None.

- [ ] **Step 3: Generalize the embedded step in hydration.py**

In `sidecar/pipeline/hydration.py`, add to the imports:

```python
from extractors.pdf_metadata import extract_pdf_metadata, render_pdf_cover
```

Replace the embedded-metadata block (currently lines 33–39):

```python
    # 1. Embedded metadata
    embedded = {}
    lower = file_path.lower()
    if os.path.exists(file_path):
        try:
            if lower.endswith(".epub"):
                embedded = extract_epub_metadata(file_path) or {}
            elif lower.endswith(".pdf"):
                embedded = extract_pdf_metadata(file_path) or {}
        except Exception:
            embedded = {}
```

Replace the embedded cover candidate block (currently lines 92–94):

```python
    if lower.endswith(".epub"):
        embedded_cover = extract_embedded_cover(file_path)
    elif lower.endswith(".pdf"):
        embedded_cover = render_pdf_cover(file_path)
    else:
        embedded_cover = None
    if embedded_cover:
        candidates.append({"source": "embedded", "data": embedded_cover})
```

- [ ] **Step 4: Register the RPC method in main.py**

In `sidecar/main.py`, add to the imports:

```python
from extractors.pdf_metadata import extract_pdf_metadata
```

Add to the `METHODS` dict, after the `extract_epub_metadata` entry:

```python
    "extract_pdf_metadata": lambda p: extract_pdf_metadata(p["file_path"]),
```

- [ ] **Step 5: Run the full sidecar suite**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests -v`
Expected: all tests pass (Task 1's five + this one).

- [ ] **Step 6: Commit**

```bash
git add sidecar/pipeline/hydration.py sidecar/main.py sidecar/tests/test_hydration_pdf.py
git commit -m "feat(sidecar): hydrate PDFs — embedded Info-dict metadata + page-1 cover candidate"
```

---

### Task 3: Node-side PDF acceptance (types, import, watcher, scan, Kindle rule)

**Files:**
- Modify: `src/types/book.types.ts:1`
- Modify: `electron/main/services/importer.ts:11,92-105`
- Modify: `electron/main/services/file-watcher.ts:7`
- Modify: `electron/main/services/migration.ts:16`
- Modify: `sidecar/pipeline/migrate.py:20`
- Modify: `electron/main/services/transfer-queue.ts:88-110`

**Interfaces:**
- Consumes: sidecar RPC `extract_pdf_metadata` (Task 2).
- Produces: `BookFormat = 'epub' | 'mobi' | 'azw3' | 'pdf'` — every later task relies on this union member existing.

- [ ] **Step 1: Extend the format union**

In `src/types/book.types.ts` line 1:

```typescript
export type BookFormat = 'epub' | 'mobi' | 'azw3' | 'pdf'
```

- [ ] **Step 2: Accept PDFs in the import pipeline**

In `electron/main/services/importer.ts` line 11:

```typescript
const SUPPORTED_FORMATS = new Set(['.epub', '.mobi', '.azw3', '.pdf'])
```

Replace the extraction block (step 1 inside `importOne`, currently the `if (format === 'epub' && sidecar.isAvailable())` branch):

```typescript
    // 1. Extract embedded metadata (EPUB/PDF; other formats fall back to filename)
    emit(job, 'extracting')
    let extracted: ExtractedMetadata = {}
    const extractMethod =
      format === 'epub' ? 'extract_epub_metadata' : format === 'pdf' ? 'extract_pdf_metadata' : null
    if (extractMethod && sidecar.isAvailable()) {
      try {
        extracted = await sidecar.call<ExtractedMetadata>(
          extractMethod,
          { file_path: filePath },
          30_000
        )
      } catch (err) {
        console.error('[import] extraction failed, falling back to filename:', err)
      }
    }
```

- [ ] **Step 3: Accept PDFs in the watcher and migration scan**

`electron/main/services/file-watcher.ts` line 7:

```typescript
const WATCHED_EXTENSIONS = new Set(['.epub', '.mobi', '.azw3', '.pdf'])
```

`electron/main/services/migration.ts` line 16:

```typescript
const BOOK_EXTENSIONS = new Set(['.epub', '.mobi', '.azw3', '.pdf'])
```

`sidecar/pipeline/migrate.py` line 20:

```python
BOOK_EXTENSIONS = (".epub", ".mobi", ".azw3", ".pdf")
```

- [ ] **Step 4: Kindle transfer rule — PDF copies as-is, never converts**

In `electron/main/services/transfer-queue.ts`, replace the conversion fallback block (the `if (!sourceFile) { ... }` that currently converts epub→azw3) with a version that tries PDF direct copy before failing, and never converts a PDF:

```typescript
    if (!sourceFile) {
      const epub = await findFormatFile(bookDir, 'epub')
      if (epub) {
        const convertPath = sidecar.ebookConvertPath()
        if (!convertPath) {
          throw new Error(
            'Calibre not found — install Calibre or set the ebook-convert path in Settings'
          )
        }
        format = 'azw3'
        emit(job, { status: 'converting', format })
        const target = epub.replace(/\.epub$/i, '.azw3')
        await sidecar.call(
          'convert_format',
          { input_path: epub, output_path: target, ebook_convert_path: convertPath },
          300_000
        )
        sourceFile = target
        const formats = [...new Set([...book.formats, format])]
        db.updateBook(book.id, { formats })
        broadcast('libraryChanged')
      } else {
        // PDF-only book: Kindles render PDF natively; conversion output is
        // unacceptable, so PDFs always transfer as-is
        const pdf = await findFormatFile(bookDir, 'pdf')
        if (!pdf) throw new Error('No source file available for conversion')
        sourceFile = pdf
        format = 'pdf'
      }
    }
```

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean. (`BookFormat` widening is additive; grep for exhaustive switches on `BookFormat` if typecheck complains — none exist today.)

- [ ] **Step 6: Manual smoke test**

With `npm run dev` running and any PDF on hand: drag it into the window. Expected: import overlay runs received → extracting → … → done; the book appears with a page-1 cover (if the sidecar is up) and a `pdf` format chip in the detail panel.

- [ ] **Step 7: Commit**

```bash
git add src/types/book.types.ts electron/main/services/importer.ts electron/main/services/file-watcher.ts electron/main/services/migration.ts electron/main/services/transfer-queue.ts sidecar/pipeline/migrate.py
git commit -m "feat: accept pdf as a first-class format across import, watch, scan, and Kindle transfer"
```

---

### Task 4: Sidecar top-up pipeline (`topup_pdfs`)

**Files:**
- Create: `sidecar/pipeline/topup.py`
- Modify: `sidecar/pipeline/migrate.py:104-111` (cover fallback for PDF-only books)
- Modify: `sidecar/main.py` (METHODS entry)
- Test: `sidecar/tests/test_topup.py`

**Interfaces:**
- Consumes: `read_calibre_db(calibre_path)` (existing), `_migrate_one(record, calibre_path, target_root, seen_isbns, stats)` from `pipeline/migrate.py`, `render_pdf_cover` from Task 1.
- Produces: RPC `topup_pdfs` with params `{job_id, calibre_path, target_root, library_index}` where `library_index` is `[{id, goodreads, isbn_13, title, author, nas_path}]` (nas_path like `books/{uuid}`). Returns `{"attached": [{"book_id": str, "file_size_bytes": int}], "new_books": [<same record shape migrate_library returns>], "stats": {"attached": int, "added": int, "skipped": int}}`. Progress notifications reuse the `migration_progress` channel with `phase: "copying"`.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_topup.py`:

```python
import json
import os

import pytest
from pypdf import PdfWriter

from pipeline.topup import _build_matcher, _normalize, topup_pdfs


def make_pdf(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    with open(path, "wb") as fh:
        writer.write(fh)


def make_calibre_library(tmp_path, records):
    """Build a fake Calibre dir tree; returns its root. records: list of
    dicts with keys path (author/title dir) and files (names to create)."""
    root = tmp_path / "calibre"
    for rec in records:
        for fname in rec["files"]:
            fpath = root / rec["path"] / fname
            if fname.endswith(".pdf"):
                make_pdf(str(fpath))
            else:
                os.makedirs(os.path.dirname(str(fpath)), exist_ok=True)
                fpath.write_bytes(b"placeholder")
    return str(root)


def test_normalize_matches_db_ts_semantics():
    assert _normalize("The Pragmatic Programmer!") == "the pragmatic programmer"
    assert _normalize("  Café,   Crème ") == "café crème"


def test_matcher_precedence_goodreads_then_isbn_then_title_author():
    index = [
        {"id": "a", "goodreads": "111", "isbn_13": None, "title": "X", "author": "Y", "nas_path": "books/a"},
        {"id": "b", "goodreads": None, "isbn_13": "9780000000002", "title": "X", "author": "Y", "nas_path": "books/b"},
        {"id": "c", "goodreads": None, "isbn_13": None, "title": "Deep Work", "author": "Cal Newport", "nas_path": "books/c"},
    ]
    match = _build_matcher(index)
    assert match({"identifiers": {"goodreads": "111"}, "title": "?", "author": "?"})["id"] == "a"
    assert match({"identifiers": {"isbn_13": "9780000000002"}, "title": "?", "author": "?"})["id"] == "b"
    assert match({"identifiers": {}, "title": "DEEP WORK.", "author": "Cal Newport"})["id"] == "c"
    assert match({"identifiers": {}, "title": "Unknown", "author": "Nobody"}) is None


@pytest.fixture
def calibre_and_target(tmp_path, monkeypatch):
    calibre_root = make_calibre_library(
        tmp_path,
        [
            {"path": "Cal Newport/Deep Work (1)", "files": ["Deep Work.pdf", "Deep Work.epub"]},
            {"path": "Anon/PDF Only Book (2)", "files": ["PDF Only Book.pdf"]},
            {"path": "Anon/Epub Only (3)", "files": ["Epub Only.epub"]},
        ],
    )
    # Stub read_calibre_db — the fake dir has no metadata.db
    records = [
        {"calibre_id": 1, "title": "Deep Work", "author": "Cal Newport",
         "path": "Cal Newport/Deep Work (1)", "identifiers": {}, "tags": [],
         "sort_title": None, "author_sort": None, "publisher": None,
         "published_date": None, "description": None, "language": None,
         "rating": None, "series": None},
        {"calibre_id": 2, "title": "PDF Only Book", "author": "Anon",
         "path": "Anon/PDF Only Book (2)", "identifiers": {}, "tags": [],
         "sort_title": None, "author_sort": None, "publisher": None,
         "published_date": None, "description": None, "language": None,
         "rating": None, "series": None},
        {"calibre_id": 3, "title": "Epub Only", "author": "Anon",
         "path": "Anon/Epub Only (3)", "identifiers": {}, "tags": [],
         "sort_title": None, "author_sort": None, "publisher": None,
         "published_date": None, "description": None, "language": None,
         "rating": None, "series": None},
    ]
    import pipeline.topup as topup_mod
    monkeypatch.setattr(topup_mod, "read_calibre_db", lambda p: {"books": records})

    target = tmp_path / "musaeum"
    # "Deep Work" already migrated with an epub
    existing_dir = target / "books" / "uuid-deep-work"
    os.makedirs(existing_dir)
    (existing_dir / "Deep Work.epub").write_bytes(b"placeholder")
    (existing_dir / "metadata.json").write_text(json.dumps({
        "id": "uuid-deep-work", "title": "Deep Work", "formats": ["epub"],
        "last_modified": "2026-07-14T00:00:00Z",
    }))
    index = [{"id": "uuid-deep-work", "goodreads": None, "isbn_13": None,
              "title": "Deep Work", "author": "Cal Newport",
              "nas_path": "books/uuid-deep-work"}]
    return calibre_root, str(target), index


def test_topup_attaches_and_adds(calibre_and_target):
    calibre_root, target, index = calibre_and_target
    notifications = []
    result = topup_pdfs(
        job_id="j1", calibre_path=calibre_root, target_root=target,
        library_index=index, notify=lambda m, p: notifications.append((m, p)),
    )

    # Attached to the existing Deep Work folder
    assert result["stats"] == {"attached": 1, "added": 1, "skipped": 0}
    attached_dir = os.path.join(target, "books", "uuid-deep-work")
    assert any(f.endswith(".pdf") for f in os.listdir(attached_dir))
    meta = json.loads(open(os.path.join(attached_dir, "metadata.json")).read())
    assert "pdf" in meta["formats"]

    # PDF-only book imported as new (epub-only book untouched)
    assert len(result["new_books"]) == 1
    assert result["new_books"][0]["title"] == "PDF Only Book"
    assert result["new_books"][0]["formats"] == ["pdf"]
    assert any(m == "migration_progress" for m, _ in notifications)


def test_topup_is_idempotent(calibre_and_target):
    calibre_root, target, index = calibre_and_target
    first = topup_pdfs(job_id="j1", calibre_path=calibre_root,
                       target_root=target, library_index=index,
                       notify=lambda m, p: None)
    # Second run: the attach target already has a PDF → skipped; the new book
    # from run 1 is not in library_index, so guard via title+author too
    index2 = index + [
        {"id": b["id"], "goodreads": None, "isbn_13": None, "title": b["title"],
         "author": b.get("author"), "nas_path": f"books/{b['id']}"}
        for b in first["new_books"]
    ]
    second = topup_pdfs(job_id="j2", calibre_path=calibre_root,
                        target_root=target, library_index=index2,
                        notify=lambda m, p: None)
    assert second["stats"]["added"] == 0
    assert second["stats"]["attached"] == 0
    assert second["stats"]["skipped"] == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests/test_topup.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.topup'`

- [ ] **Step 3: Add the PDF cover fallback to `_migrate_one`**

In `sidecar/pipeline/migrate.py`, add to the imports:

```python
from extractors.pdf_metadata import render_pdf_cover
```

Replace the cover block inside `_migrate_one` (currently `cover = None` through the `except` clause):

```python
    cover = None
    calibre_cover = os.path.join(source_dir, "cover.jpg")
    if os.path.exists(calibre_cover):
        try:
            with open(calibre_cover, "rb") as fh:
                cover = _write_cover(fh.read(), book_dir)
        except Exception:
            cover = None
    if cover is None and formats == ["pdf"]:
        # PDF-only book without a Calibre cover: render page 1
        pdf_file = os.path.join(book_dir, f"{sanitized}.pdf")
        data = render_pdf_cover(pdf_file)
        if data:
            try:
                cover = _write_cover(data, book_dir)
            except Exception:
                cover = None
```

- [ ] **Step 4: Implement `pipeline/topup.py`**

Create `sidecar/pipeline/topup.py`:

```python
"""Re-runnable Calibre PDF top-up.

Attaches PDFs skipped by the initial migration to their already-migrated
books (matched Goodreads ID → ISBN-13 → normalized title+author), and
imports PDF-only Calibre books as new entries via migrate._migrate_one.
Idempotent: a target folder that already contains a .pdf is skipped, and
library-index matches never create duplicates.
"""

import json
import os
from datetime import datetime, timezone
from typing import Callable, Optional

from extractors.calibre_db import read_calibre_db
from pipeline.migrate import _migrate_one, _sanitize


def _normalize(s: str) -> str:
    """Mirror db.ts findByTitleAuthor: lowercase, non-alphanumerics → space."""
    out = "".join(ch if ch.isalnum() else " " for ch in (s or "").lower())
    return " ".join(out.split())


def _build_matcher(library_index: list) -> Callable[[dict], Optional[dict]]:
    by_goodreads = {e["goodreads"]: e for e in library_index if e.get("goodreads")}
    by_isbn = {e["isbn_13"]: e for e in library_index if e.get("isbn_13")}
    by_title_author = {}
    by_title_only = {}
    for e in library_index:
        key = _normalize(e.get("title") or "")
        if not key:
            continue
        by_title_only.setdefault(key, e)
        if e.get("author"):
            by_title_author.setdefault((key, _normalize(e["author"])), e)

    def match(record: dict) -> Optional[dict]:
        ids = record.get("identifiers") or {}
        if ids.get("goodreads") and ids["goodreads"] in by_goodreads:
            return by_goodreads[ids["goodreads"]]
        if ids.get("isbn_13") and ids["isbn_13"] in by_isbn:
            return by_isbn[ids["isbn_13"]]
        nt = _normalize(record.get("title") or "")
        na = _normalize(record.get("author") or "")
        if nt and na and (nt, na) in by_title_author:
            return by_title_author[(nt, na)]
        if nt and not na and nt in by_title_only:
            return by_title_only[nt]
        return None

    return match


def _find_pdf(source_dir: str) -> Optional[str]:
    if not os.path.isdir(source_dir):
        return None
    for f in sorted(os.listdir(source_dir)):
        if f.lower().endswith(".pdf"):
            return os.path.join(source_dir, f)
    return None


def _attach_pdf(pdf_path: str, entry: dict, target_root: str) -> Optional[int]:
    """Copy the PDF into an existing book folder and update metadata.json.
    Returns copied byte size, or None when the folder already has a PDF."""
    import shutil

    book_dir = os.path.join(target_root, entry["nas_path"])
    if not os.path.isdir(book_dir):
        return None
    if any(f.lower().endswith(".pdf") for f in os.listdir(book_dir)):
        return None

    meta_path = os.path.join(book_dir, "metadata.json")
    try:
        with open(meta_path, encoding="utf-8") as fh:
            meta = json.load(fh)
    except Exception:
        meta = {}

    title = meta.get("title") or entry.get("title") or "untitled"
    target = os.path.join(book_dir, f"{_sanitize(title)}.pdf")
    shutil.copy2(pdf_path, target)

    formats = meta.get("formats") or []
    if "pdf" not in formats:
        formats.append("pdf")
    meta["formats"] = formats
    meta["last_modified"] = datetime.now(timezone.utc).isoformat()
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    return os.path.getsize(target)


def topup_pdfs(
    job_id: str,
    calibre_path: str,
    target_root: str,
    library_index: list,
    notify: Callable[[str, dict], None],
) -> dict:
    def progress(**kwargs):
        notify("migration_progress", {"job_id": job_id, **kwargs})

    progress(phase="scanning", completed=0, total=0)
    calibre = read_calibre_db(calibre_path)["books"]

    with_pdf = []
    for record in calibre:
        pdf_path = _find_pdf(os.path.join(calibre_path, record["path"]))
        if pdf_path:
            with_pdf.append((record, pdf_path))

    match = _build_matcher(library_index)
    stats = {"attached": 0, "added": 0, "skipped": 0}
    attached = []
    new_books = []
    migrate_stats = {"migrated": 0, "needsReview": 0, "noMetadata": 0, "duplicates": 0}
    seen_isbns = {e["isbn_13"] for e in library_index if e.get("isbn_13")}
    total = len(with_pdf)

    for i, (record, pdf_path) in enumerate(with_pdf):
        progress(phase="copying", total=total, completed=i,
                 currentTitle=record.get("title"), **stats)
        try:
            entry = match(record)
            if entry is not None:
                size = _attach_pdf(pdf_path, entry, target_root)
                if size is None:
                    stats["skipped"] += 1
                else:
                    stats["attached"] += 1
                    attached.append({"book_id": entry["id"], "file_size_bytes": size})
            else:
                book = _migrate_one(record, calibre_path, target_root,
                                    seen_isbns, migrate_stats)
                if book and "pdf" in book["formats"]:
                    stats["added"] += 1
                    new_books.append(book)
                else:
                    stats["skipped"] += 1
        except Exception as exc:
            stats["skipped"] += 1
            print(f"topup: failed on '{record.get('title')}': {exc}", flush=True)

    progress(phase="done", total=total, completed=total, currentTitle=None, **stats)
    return {"attached": attached, "new_books": new_books, "stats": stats}
```

Note: unmatched Calibre books whose folder also holds an epub/mobi/azw3 get fully migrated by `_migrate_one` (all supported formats copied) — correct behavior: if it wasn't matched, it isn't in Musaeum at all.

- [ ] **Step 5: Register the RPC method**

In `sidecar/main.py`, add to the imports:

```python
from pipeline.topup import topup_pdfs
```

Add to `METHODS` after `migrate_library`:

```python
    "topup_pdfs": lambda p: topup_pdfs(
        job_id=p["job_id"],
        calibre_path=p["calibre_path"],
        target_root=p["target_root"],
        library_index=p.get("library_index") or [],
        notify=notify,
    ),
```

- [ ] **Step 6: Run the full sidecar suite**

Run: `sidecar/.venv/bin/python -m pytest sidecar/tests -v`
Expected: all pass (Tasks 1, 2, and 4 tests).

- [ ] **Step 7: Commit**

```bash
git add sidecar/pipeline/topup.py sidecar/pipeline/migrate.py sidecar/main.py sidecar/tests/test_topup.py
git commit -m "feat(sidecar): re-runnable Calibre PDF top-up pipeline (attach + import)"
```

---

### Task 5: Node orchestration + IPC for the top-up

**Files:**
- Modify: `src/types/metadata.types.ts` (progress fields + option type)
- Modify: `electron/main/services/migration.ts` (new `startPdfTopUp`)
- Modify: `electron/main/ipc/migration.ts`
- Modify: `electron/preload/index.ts:49-55`
- Modify: `src/types/api.types.ts` (migration section)

**Interfaces:**
- Consumes: sidecar RPC `topup_pdfs` (Task 4), `db.getBooks` / `db.updateBook` / `insertMigratedBooks` (existing).
- Produces: `window.Musaeum.migration.startPdfTopUp(calibrePath: string): Promise<MigrationJob>` — progress polled via the existing `getMigrationProgress(jobId)`; `MigrationProgress` gains optional `attached?: number; added?: number; skipped?: number`. Consumed by the wizard UI in Task 6.

- [ ] **Step 1: Extend the shared types**

In `src/types/metadata.types.ts`, extend `MigrationProgress` (after `currentTitle`):

```typescript
  currentTitle: string | null
  /** PDF top-up runs only */
  attached?: number
  added?: number
  skipped?: number
  error?: string
```

- [ ] **Step 2: Implement `startPdfTopUp` in the migration service**

In `electron/main/services/migration.ts`, extend the `MigratedBookRecord`-consuming module with (place after `startMigration`):

```typescript
interface TopUpResult {
  attached: { book_id: string; file_size_bytes: number }[]
  new_books: MigratedBookRecord[]
  stats: { attached: number; added: number; skipped: number }
}

/**
 * Re-runnable Calibre PDF top-up: attaches skipped PDFs to matched existing
 * books and imports PDF-only Calibre books as new entries. Matching happens
 * in the sidecar against an index of the current library.
 */
export function startPdfTopUp(calibrePath: string): MigrationJob {
  const libraryRoot = nasManager.getLibraryRoot()
  if (!libraryRoot) throw new Error('No library folder is configured')

  const jobId = randomUUID()
  const progress: MigrationProgress = {
    jobId,
    phase: 'scanning',
    total: 0,
    completed: 0,
    migrated: 0,
    needsReview: 0,
    noMetadata: 0,
    duplicates: 0,
    attached: 0,
    added: 0,
    skipped: 0,
    currentTitle: null
  }
  jobs.set(jobId, progress)

  sidecar.onNotification('migration_progress', (params) => {
    const p = params as Partial<MigrationProgress> & { job_id?: string }
    if (p.job_id !== jobId) return
    Object.assign(progress, {
      phase: p.phase ?? progress.phase,
      total: p.total ?? progress.total,
      completed: p.completed ?? progress.completed,
      attached: p.attached ?? progress.attached,
      added: p.added ?? progress.added,
      skipped: p.skipped ?? progress.skipped,
      currentTitle: p.currentTitle ?? progress.currentTitle
    })
  })

  void (async () => {
    try {
      const libraryIndex = db.getBooks().map((b) => ({
        id: b.id,
        goodreads: b.goodreadsId,
        isbn_13: b.isbn13,
        title: b.title,
        author: b.author,
        nas_path: b.nasPath ?? join('books', b.id)
      }))
      const result = await sidecar.call<TopUpResult>(
        'topup_pdfs',
        {
          job_id: jobId,
          calibre_path: calibrePath,
          target_root: libraryRoot,
          library_index: libraryIndex
        },
        // Copying ~2k PDFs over SMB takes a while
        1000 * 60 * 60 * 12
      )
      for (const a of result.attached) {
        const book = db.getBook(a.book_id)
        if (!book) continue
        db.updateBook(a.book_id, {
          formats: [...new Set<BookFormat>([...book.formats, 'pdf'])],
          fileSizeBytes: (book.fileSizeBytes ?? 0) + a.file_size_bytes
        })
      }
      insertMigratedBooks(result.new_books)
      progress.phase = 'done'
      broadcast('libraryChanged')
    } catch (err) {
      progress.phase = 'error'
      progress.error = err instanceof Error ? err.message : String(err)
    }
  })()

  return { jobId }
}
```

(`BookFormat` is already imported in this file; `join` is already imported from `path`.)

- [ ] **Step 3: Register IPC, preload, and API contract**

`electron/main/ipc/migration.ts` — add inside `registerMigrationHandlers`:

```typescript
  handle('migration:startPdfTopUp', (calibrePath: string) =>
    migration.startPdfTopUp(calibrePath)
  )
```

`electron/preload/index.ts` — add to the `migration` object:

```typescript
    startPdfTopUp: (calibrePath) => invoke('migration:startPdfTopUp', calibrePath),
```

`src/types/api.types.ts` — add to the `migration` section of `MusaeumAPI`:

```typescript
    /** Re-runnable: attach Calibre PDFs to existing books + import PDF-only books. */
    startPdfTopUp(calibrePath: string): Promise<MigrationJob>
```

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/types/metadata.types.ts src/types/api.types.ts electron/main/services/migration.ts electron/main/ipc/migration.ts electron/preload/index.ts
git commit -m "feat: startPdfTopUp orchestration + IPC surface for Calibre PDF top-up"
```

---

### Task 6: Wizard UI — "Import PDFs from Calibre"

**Files:**
- Modify: `src/components/migration/MigrationWizard.tsx`

**Interfaces:**
- Consumes: `window.Musaeum.migration.startPdfTopUp` + `getMigrationProgress` (Task 5), `chooseCalibrePath` (existing).
- Produces: user-facing flow; no programmatic consumers.

- [ ] **Step 1: Add the top-up entry point and flow**

In `src/components/migration/MigrationWizard.tsx`:

1. Extend the step type and add a mode flag:

```typescript
type Step = 'source' | 'confirm' | 'running' | 'done' | 'topup-running' | 'topup-done'
```

2. Add a `startTopUp` handler alongside `chooseSource` (reuses `progress`, `error`, and `pollRef` state):

```typescript
  const startTopUp = async () => {
    setError(null)
    const path = await window.Musaeum.migration.chooseCalibrePath()
    if (!path) return
    try {
      const { jobId } = await window.Musaeum.migration.startPdfTopUp(path)
      setStep('topup-running')
      pollRef.current = setInterval(async () => {
        const p = await window.Musaeum.migration.getMigrationProgress(jobId)
        if (!p) return
        setProgress(p)
        if (p.phase === 'done' || p.phase === 'error') {
          clearInterval(pollRef.current)
          if (p.phase === 'done') {
            setStep('topup-done')
            void load()
          } else {
            setError(p.error ?? 'PDF import failed')
          }
        }
      }, 1_000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
```

3. On the `source` step, under the existing "Locate Calibre Library…" button, add the secondary action:

```tsx
              <button
                onClick={() => void startTopUp()}
                className="w-full rounded-md border border-ink-600 px-4 py-2 text-sm text-parchment-dim hover:bg-ink-800 hover:text-parchment"
              >
                Import PDFs from Calibre…
              </button>
              <p className="text-[11px] leading-relaxed text-parchment-faint">
                Already migrated? This re-reads your Calibre library and brings over the
                PDFs the migration skipped — attaching them to books you already have and
                importing PDF-only books as new entries. Safe to run more than once.
              </p>
```

4. Render `topup-running` by reusing the existing running markup (spinner + `Copying books — N of M` + progress bar; extract the current `step === 'running'` JSX into a shared fragment rendered for both `'running'` and `'topup-running'`, with the label text `progress?.phase === 'scanning' ? 'Reading Calibre library' : 'Copying PDFs'` for the top-up case).

5. Add the `topup-done` summary:

```tsx
          {step === 'topup-done' && progress && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-gold-300">
                <CheckIcon className="h-5 w-5" />
                <p className="font-display text-lg">PDF import complete</p>
              </div>
              <dl className="space-y-1.5 rounded-md bg-ink-850 p-4 text-[13px]">
                <Stat label="Attached to existing books" value={progress.attached ?? 0} />
                <Stat label="New books added" value={progress.added ?? 0} highlight />
                <Stat label="Skipped (already present)" value={progress.skipped ?? 0} />
              </dl>
              <button
                onClick={() => openModal(null)}
                className="w-full rounded-md bg-gold-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-gold-400"
              >
                Done
              </button>
            </div>
          )}
```

6. Update the `running` guard so the close button also locks during top-up:

```typescript
  const running =
    (step === 'running' || step === 'topup-running') && (!progress || progress.phase !== 'error')
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 3: Manual smoke test (small scale)**

With `npm run dev`: open the migration wizard → "Import PDFs from Calibre…" → pick a scratch Calibre folder (create one with 2–3 fake book dirs, or re-use a copy of a few real ones — never the live library for the smoke test). Expected: progress runs, summary shows attached/added/skipped, library reloads with the new PDF books.

- [ ] **Step 4: Commit**

```bash
git add src/components/migration/MigrationWizard.tsx
git commit -m "feat(ui): Import PDFs from Calibre flow in migration wizard"
```

---

### Task 7: Docs, changelog, and full verification

**Files:**
- Modify: `CLAUDE.md` (stack table row for sidecar methods; format scope mentions; conventions untouched)
- Modify: `tasks.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update CLAUDE.md**

- Sidecar methods table: add rows `extract_pdf_metadata` ("Parse Info dict + render page-1 cover from PDF") and `topup_pdfs` ("Re-runnable Calibre PDF top-up; streams migration_progress").
- Anywhere the format set is enumerated (Kindle transfer section: "Format preference: azw3 → mobi"), append the rule: "PDF-only books transfer as PDF — never converted."
- Book storage structure example: add `{sanitized-title}.pdf` as a cached-format example line.

- [ ] **Step 2: Update tasks.md and CHANGELOG.md**

- tasks.md: add a "Phase 1.5 — PDF support" done entry (`[x]`) noting import + top-up; add an open `[ ]` item: "Run the PDF top-up against the real Calibre library (after verifying on a scratch subset)".
- CHANGELOG.md: entry under today's date describing PDF format support and the top-up tool.

- [ ] **Step 3: Full verification**

Run all of:

```bash
npm run typecheck && npm run lint
sidecar/.venv/bin/python -m pytest sidecar/tests -v
```

Expected: clean typecheck/lint; all sidecar tests pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md tasks.md CHANGELOG.md
git commit -m "docs: record PDF format support + Calibre top-up tool"
```

---

## Self-Review Notes

- **Spec coverage:** data model (Task 3), import pipeline + extractor + cover render (Tasks 1–3), hydration unchanged-but-generalized (Task 2), Kindle no-convert rule (Task 3), Apple Books (no change needed — `open -a Books` is format-agnostic), top-up attach/new/idempotent + match precedence (Tasks 4–5), wizard surface + summary counts (Task 6), pytest coverage per spec (Tasks 1, 2, 4). Docs (Task 7).
- **Deliberate deviation from spec text:** the spec's testing section mentions vitest for "top-up matching" — matching lives in Python (sidecar owns the top-up), so those tests are pytest (`test_topup.py`). Spec's pytest section already lists top-up classification, so coverage is equivalent. No vitest infra is introduced in Section A; it arrives with Section B where Node-side logic (catalog) actually needs it.
- **Type consistency check:** `library_index` entry shape (`id/goodreads/isbn_13/title/author/nas_path`) is identical in Task 4 (Python consumer + tests) and Task 5 (Node producer). `TopUpResult` matches `topup_pdfs`' return dict. `MigrationProgress.attached/added/skipped` optional fields match the sidecar's notification kwargs and Task 6's summary UI.
