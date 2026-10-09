# Calibre-free conversion — slice 2 (the writer behind `convert_format`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `convert_format` run the in-house EPUB → AZW3 writer instead of Calibre's `ebook-convert`, keeping the RPC contract, and settle the one open device question the spike left (whether the Oasis needs the creator-software fields). After this slice the sidecar no longer runs Calibre; the Electron side still looks for it until slice 3.

**Architecture:** `converter.py` keeps its name and RPC shape and runs the writer in a **child process** (`python -m conversion.azw3.run`), as the Calibre wrapper ran a child process: the memory of a large book goes back to the OS when it finishes, the sidecar's four worker threads keep the GIL, and a runaway conversion is killed at the existing 300 s timeout. `sidecar/main.py` stops reading `ebook_convert_path`. A new `scripts/azw3-oracle.py` is the spec's one-time Calibre-as-oracle check. The creator-field experiment is a writer option, a CLI flag, and a file for the owner to try on the Oasis.

**Tech Stack:** Python 3.12, `subprocess`, the existing `lxml` / `Pillow` / `defusedxml`, pytest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` — slice 2 of its *Slices* table, AC4, AC5, AC7, **Annex A**, **Device experiments**, **Annex B**. Slice 1's plans: `docs/superpowers/plans/2026-10-02-calibre-free-conversion-slice1a.md` and `…2026-10-07-calibre-free-conversion-slice1b.md`.

## Global Constraints

- **Work on a branch off `main`** (`git switch -c calibre-free-slice2`). A PDF-reflow stream runs in parallel in the same repo (`sidecar/reflow/`, `tasks.md`, `docs/architecture.md`, its own spec). **This plan touches none of those files** except one line of `tasks.md` in Task 4, and `sidecar/main.py` only inside the `convert_format` entry. If a merge conflicts in `main.py`, keep both sides.
- **Provenance rule (spec §Provenance):** never read Calibre's or KindleUnpack's source. Calibre is run as an oracle **once** (Task 2), never imported, and never a dependency of `pytest` or `npm test`.
- **The text form is T2's:** compression 1, extra-data flags 0, exact 4,096-byte records, ASCII. PalmDOC text with flags 0 **crashes the Oasis** (spec, *Device experiments*). This slice does not touch the writer's format, except for the creator fields in Task 3.
- **The RPC contract:** `convert_format({input_path, output_path})` → `{output_path, size_bytes, warnings}`; on failure an RPC `error` whose message is the reason. The Electron caller still sends `ebook_convert_path` until slice 3; it must be accepted and ignored.
- **`electron/` and `src/` are out of scope.** That is slice 3, which the owner approved on 2026-10-06 (9 files across `electron/main` ⇄ `src`).
- **No new dependency** (`sidecar/requirements.txt` does not change). No `any` types; nothing reads `formats[0]`; Markdown prose is not hard-wrapped (`CLAUDE.md`).
- **Two consecutive failed repairs on the same test → stop and hand back** (`CLAUDE.md` §Escalate).
- **Commits** end with the `Co-Authored-By:` line the session's attribution instruction gives. Run `/verify` immediately before any commit that is not docs-only or tests-only (repo rule). The sidecar is what the isolated app launches, so run it even though the app's own code is untouched.
- **Baseline:** `cd sidecar && .venv/bin/python -m pytest -q` is **347 passed, 2 skipped** on `main` as this plan was written. Each task states the count it should reach.

## Decisions this plan makes, for the owner to see

1. **Conversion runs in a child process, not in the sidecar's own threads.** Measured with the spike writer: a 238 MB cookbook peaks at **452 MB**; a 135 MB EPUB (*The Complete Story of Civilization*, 4.7 M words, a 2,899-entry TOC) peaks at **1.1 GB** and takes **75 s** in this measurement (43 s in an earlier one of the same book; both read from the NAS, so the share's speed is in the number). In-process, that spike would sit in the long-lived sidecar and the work would contend with hydration for the GIL. Cost: a fraction of a second of interpreter start-up per conversion (the three slice 1 gate books converted in 0.2–0.3 s each, start-up included). If the owner prefers in-process, Task 1's `converter.py` collapses to a call of `write_azw3` and `run.py` is dropped.
2. **No size guard.** The measured outliers are one book in 5,000. They exceed the 30 s and 500 MB targets in `CLAUDE.md`, but fit the 300 s timeout. A guard that refuses large books would leave them unsendable; the numbers are recorded in Annex C instead. Revisit with a streaming write only if it bites.
3. **The creator-software fields get a device experiment, not a guess.** The spike copies Calibre's EXTH 204–207 and 535, which say "kindlegen Mac 2.9, build 0730-890adc2" — Amazon's tool, not Musaeum. Nothing measured says the firmware reads them, and no file without them has ever been opened on the Oasis. Task 3 builds one file without them and stops for the owner.

## Review Focus

Inputs the spec implies but its slices do not test, most likely to bite first. Each has a pinning test in the task that owns the code.

1. **The Electron side still sends `ebook_convert_path`, possibly pointing at a Calibre that is not installed.** It must be ignored, not validated. Pinned in Task 1 (`test_a_calibre_path_from_an_older_caller_is_accepted_and_ignored`, `test_the_rpc_method_converts_and_ignores_a_stale_calibre_path`).
2. **A conversion that overruns the timeout.** The child is killed and nothing is left at the target or `.tmp`. Pinned in Task 1 (`test_a_conversion_that_overruns_is_killed_and_leaves_nothing_behind`).
3. **A `.tmp` left on the NAS by a conversion that was killed before it could clean up** (the sidecar is quit mid-send). The next attempt removes it. Pinned in Task 1 (`test_a_temp_file_left_by_a_killed_earlier_attempt_does_not_survive_the_next`).
4. **A DRM-encrypted book.** The reason ("encrypted") must reach the RPC error, because that sentence is what the toast and `device_history` show. Pinned in Task 1 (`test_a_failed_conversion_says_why_and_leaves_nothing_behind`).
5. **Real library paths:** spaces, apostrophes, em-dashes (*Darwin's Devices*, *America—Farm to Table*). The child is started with an argument list, never a shell string. Pinned in Task 1 (`test_titles_with_spaces_apostrophes_and_dashes_in_their_paths_convert`).

---

## Verified before this plan was written

The code below was built and run in a scratch copy of `sidecar/` (never committed). The converter tests: **9 pass there, and all 8 that existed when first written were RED against the current Calibre wrapper**. A copy of `sidecar/` made with `electron-builder.yml`'s `extraResources` exclusions (no `tests/`, no `.venv`), run from an unrelated directory, converted a book through the child process. `scripts/azw3-oracle.py` ran on the three slice 1 gate books: all three `ok`, **0 words missing, 0 extra**, 0.2–0.3 s each. The creator-field option was built and the experiment file produced: it differs from the default file only by EXTH 204–207 and 535. The suite there: baseline plus the 9 + 2 tests below.

## File Structure

| File | Responsibility |
| --- | --- |
| `sidecar/conversion/converter.py` | `convert_format` — validates, clears a stale `.tmp`, runs the child process, maps its result or failure to the RPC contract. |
| `sidecar/conversion/azw3/run.py` | The child's entry: `python -m conversion.azw3.run INPUT OUTPUT`; one JSON line on success, `error: <reason>` on stderr and exit 1 on failure. |
| `sidecar/main.py` | The `convert_format` dispatch entry stops reading `ebook_convert_path`. |
| `sidecar/tests/test_converter.py` | The RPC contract and every failure path. |
| `sidecar/conversion/azw3/writer.py`, `sidecar/tests/test_azw3_writer.py`, `scripts/azw3-spike.py` | Task 3: the `creator_fields` option, its tests, the `--no-creator` flag. |
| `scripts/azw3-oracle.py` | The one-time Calibre oracle comparison (Task 2). |
| `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` | Gains **Annex C** (Tasks 2–4). |

---

### Task 1: `convert_format` runs the in-house writer

**Files:**
- Create: `sidecar/conversion/azw3/run.py`
- Modify: `sidecar/conversion/converter.py` (replace its whole body), `sidecar/main.py` (the `convert_format` entry of `METHODS`)
- Test: `sidecar/tests/test_converter.py`

**Interfaces:**
- Consumes: `write_azw3(epub_path: str, out_path: str) -> Conversion` and `Conversion.warnings` from `conversion/azw3/writer.py` (slice 1b). From the existing tests: `build_epub`, `xhtml` (`tests/azw3_kf8.py`), `replace_member`, `ADOBE_ENCRYPTION` (`tests/test_azw3_epub.py`), `read_identity` (`conversion/azw3/identity.py`).
- Produces:
  - `convert_format(input_path: str, output_path: str, ebook_convert_path: str | None = None) -> dict` returning `{"output_path": str, "size_bytes": int, "warnings": list[str]}`; raises `FileNotFoundError` (no source), `ValueError` (not EPUB → AZW3), `RuntimeError` (anything the child reports, or a timeout).
  - Constants `TIMEOUT = 300` and `SIDECAR_ROOT` in `converter.py`.
  - `python -m conversion.azw3.run INPUT OUTPUT` as described above.

**Annex C rows this task needs (Task 4 writes them):** the child-process boundary, the RPC contract, the `.tmp` self-healing rule (spec AC5 as interpreted: a conversion that *fails* leaves nothing; one that is *killed* is cleaned up by the next attempt), and the measured memory and time of the three heaviest books.

- [ ] **Step 1: Write the failing tests.** Create `sidecar/tests/test_converter.py`:

```python
"""`convert_format`: the RPC contract the Calibre wrapper had, now backed by the in-house writer."""

import os

import pytest

import conversion.converter as converter
import main
from conversion.azw3.identity import read_identity
from conversion.converter import convert_format
from tests.azw3_kf8 import build_epub, xhtml
from tests.test_azw3_epub import ADOBE_ENCRYPTION, replace_member


@pytest.fixture
def epub(tmp_path):
    return build_epub(tmp_path / "Book.epub", chapters=[("c.xhtml", xhtml("<h1>One</h1><p>Hello.</p>"))])


def test_it_returns_the_old_contract_plus_warnings_and_the_file_reads_back(epub, tmp_path):
    out = str(tmp_path / "Book.azw3")
    result = convert_format(str(epub), out)
    assert result == {"output_path": out, "size_bytes": os.path.getsize(out), "warnings": []}
    identity = read_identity(open(out, "rb").read())
    assert (identity.title, identity.author, identity.cdetype) == ("Test Book", "Ann Author", "EBOK")


def test_a_calibre_path_from_an_older_caller_is_accepted_and_ignored(epub, tmp_path):
    out = str(tmp_path / "Book.azw3")
    assert convert_format(str(epub), out, "/no/such/ebook-convert")["output_path"] == out


def test_writer_warnings_come_back_with_the_result(tmp_path):
    path = build_epub(tmp_path / "w.epub", chapters=[("c.xhtml", xhtml("<p>x</p>"))], css={"s.css": "@font-face { src: url(f.ttf) }"})
    replace_member(path, "OEBPS/c.xhtml", xhtml("<p>x</p>", head='<link rel="stylesheet" href="s.css"/>').encode())
    assert any("@font-face" in w for w in convert_format(str(path), str(tmp_path / "w.azw3"))["warnings"])


def test_a_missing_source_and_a_wrong_format_are_refused_before_anything_runs(epub, tmp_path):
    with pytest.raises(FileNotFoundError):
        convert_format(str(tmp_path / "gone.epub"), str(tmp_path / "gone.azw3"))
    with pytest.raises(ValueError, match="only EPUB to AZW3"):
        convert_format(str(epub), str(tmp_path / "Book.mobi"))
    pdf = tmp_path / "Book.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    with pytest.raises(ValueError, match="only EPUB to AZW3"):
        convert_format(str(pdf), str(tmp_path / "Book.azw3"))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Book.epub", "Book.pdf"]


def test_a_failed_conversion_says_why_and_leaves_nothing_behind(tmp_path):
    drm = build_epub(tmp_path / "drm.epub", chapters=[("c.xhtml", xhtml("<p>x</p>"))])
    replace_member(drm, "META-INF/encryption.xml", ADOBE_ENCRYPTION.encode())
    with pytest.raises(RuntimeError, match="encrypted"):
        convert_format(str(drm), str(tmp_path / "drm.azw3"))
    junk = tmp_path / "junk.epub"
    junk.write_bytes(b"not a zip")
    with pytest.raises(RuntimeError, match="conversion failed"):
        convert_format(str(junk), str(tmp_path / "junk.azw3"))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["drm.epub", "junk.epub"]


def test_a_conversion_that_overruns_is_killed_and_leaves_nothing_behind(epub, tmp_path, monkeypatch):
    monkeypatch.setattr(converter, "TIMEOUT", 0.001)
    with pytest.raises(RuntimeError, match="timed out"):
        convert_format(str(epub), str(tmp_path / "Book.azw3"))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Book.epub"]


def test_a_temp_file_left_by_a_killed_earlier_attempt_does_not_survive_the_next(epub, tmp_path):
    out = tmp_path / "Book.azw3"
    (tmp_path / "Book.azw3.tmp").write_bytes(b"half a file")
    convert_format(str(epub), str(out))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Book.azw3", "Book.epub"]


def test_the_rpc_method_converts_and_ignores_a_stale_calibre_path(epub, tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(main, "send", sent.append)
    out = str(tmp_path / "Book.azw3")
    params = {"input_path": str(epub), "output_path": out, "ebook_convert_path": "/gone"}
    main.handle_request({"id": 1, "method": "convert_format", "params": params})
    assert sent[0]["error"] is None and sent[0]["result"]["output_path"] == out
    main.handle_request({"id": 2, "method": "convert_format", "params": {"input_path": str(tmp_path / "no.epub"), "output_path": out}})
    assert "Source file not found" in sent[1]["error"]["message"]


def test_titles_with_spaces_apostrophes_and_dashes_in_their_paths_convert(tmp_path):
    folder = tmp_path / "books" / "a764fbcf-7788"
    folder.mkdir(parents=True)
    source = build_epub(folder / "Darwin's Devices — America—Farm to Table.epub", chapters=[("c.xhtml", xhtml("<p>x</p>"))])
    out = str(folder / "Darwin's Devices — America—Farm to Table.azw3")
    assert convert_format(str(source), out)["output_path"] == out
    assert read_identity(open(out, "rb").read()).cdetype == "EBOK"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_converter.py -q`
Expected: FAIL. All nine fail against the Calibre wrapper (the first with `FileNotFoundError: ebook-convert not found at …` or a `TypeError`).

- [ ] **Step 3: Write the child entry.** Create `sidecar/conversion/azw3/run.py`:

```python
"""Child-process entry for `convert_format`: `python -m conversion.azw3.run INPUT OUTPUT`.

The conversion runs outside the long-lived sidecar so a large book's memory goes
back to the OS when it finishes, the sidecar's other threads keep the GIL, and a
runaway conversion can be killed. On success it prints one JSON line
(`size_bytes`, `warnings`); on failure it prints `error: <reason>` to stderr and
exits 1. Nothing is left at OUTPUT or OUTPUT.tmp on failure (spec D5).
"""

import json
import os
import sys

from conversion.azw3.writer import write_azw3


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("error: usage: run INPUT OUTPUT", file=sys.stderr)
        return 2
    try:
        conversion = write_azw3(argv[1], argv[2])
    except Exception as exc:  # noqa: BLE001 — every reason crosses the process boundary as text
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"size_bytes": os.path.getsize(argv[2]), "warnings": conversion.warnings}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 4: Replace the converter.** Overwrite `sidecar/conversion/converter.py` with:

```python
"""EPUB → AZW3, in-house: the one conversion the app asks for (Kindle sends).

The writer is `conversion/azw3/`; this module runs it in a child process (see
`conversion/azw3/run.py`) and keeps the RPC contract the Calibre wrapper had:
`{output_path, size_bytes}` back, an exception with a reason when it cannot.
"""

import json
import os
import subprocess
import sys

TIMEOUT = 300
SIDECAR_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def convert_format(input_path: str, output_path: str, ebook_convert_path: str | None = None) -> dict:
    """Convert an EPUB to an AZW3 beside it.

    `ebook_convert_path` is accepted and ignored: the Electron side still sends it
    until the Calibre plumbing is removed there (spec slice 3).
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Source file not found: {input_path}")
    if not input_path.lower().endswith(".epub") or not output_path.lower().endswith(".azw3"):
        raise ValueError("only EPUB to AZW3 conversion is supported")

    temp = output_path + ".tmp"
    if os.path.exists(temp):
        os.remove(temp)  # left by an earlier attempt that was killed mid-write
    try:
        result = subprocess.run(
            [sys.executable, "-m", "conversion.azw3.run", input_path, output_path],
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
            cwd=SIDECAR_ROOT,
        )
    except subprocess.TimeoutExpired:
        _remove(temp)
        raise RuntimeError(f"conversion timed out after {TIMEOUT} seconds") from None
    if result.returncode != 0:
        _remove(temp)
        lines = [line for line in (result.stderr or "").splitlines() if line.strip()]
        reason = lines[-1].removeprefix("error: ") if lines else f"exit status {result.returncode}"
        raise RuntimeError(f"conversion failed: {reason}")
    if not os.path.exists(output_path):
        raise RuntimeError("conversion reported success but produced no output file")

    report = json.loads(result.stdout.strip().splitlines()[-1])
    return {"output_path": output_path, "size_bytes": report["size_bytes"], "warnings": report["warnings"]}


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
```

- [ ] **Step 5: Stop the dispatch reading the Calibre path.** In `sidecar/main.py`, replace the `convert_format` entry of `METHODS`:

```python
    "convert_format": lambda p: convert_format(
        input_path=p["input_path"],
        output_path=p["output_path"],
        ebook_convert_path=p["ebook_convert_path"],
    ),
```

with:

```python
    # `ebook_convert_path` may still arrive from an older caller; it is ignored.
    "convert_format": lambda p: convert_format(
        input_path=p["input_path"],
        output_path=p["output_path"],
    ),
```

- [ ] **Step 6: Run the tests and the suite**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_converter.py -q && .venv/bin/python -m pytest -q`
Expected: PASS (9 passed), then **356 passed, 2 skipped**.

- [ ] **Step 7: Mutation-check the failure paths.** One at a time, with the suite run after each and the file restored after, confirm each of these makes a test fail: removing the `os.remove(temp)` line before the child starts; replacing `_remove(temp)` in the timeout branch with `pass`; removing `.removeprefix("error: ")` (the "encrypted" match still passes, so check the message equals `conversion failed: the EPUB is encrypted (DRM) and cannot be converted`). A surviving mutation means a missing test: add it.

- [ ] **Step 8: Prove the packaged sidecar carries it.** The packaged app ships `sidecar/` minus `tests/`, `.venv` and `__pycache__` (`electron-builder.yml`, `extraResources`). Build that copy and convert from an unrelated directory:

```bash
rm -rf /tmp/sidecar-pack && mkdir /tmp/sidecar-pack
rsync -a --exclude .venv --exclude __pycache__ --exclude tests --exclude requirements-dev.txt sidecar/ /tmp/sidecar-pack/
cd / && /Users/jasonoh/Projects/musaeum-macos/sidecar/.venv/bin/python - <<'PY'
import sys
sys.path.insert(0, "/tmp/sidecar-pack")
from conversion.converter import convert_format
print(convert_format("/tmp/azw3-gate/Yellowface A Novel.epub", "/tmp/sidecar-pack/out.azw3"))
PY
```

Expected: a dict with `size_bytes` 998961 and `warnings` `[]` (any EPUB works if the gate book is gone; the point is that it converts with no `tests/` present). Remove `/tmp/sidecar-pack` afterwards.

- [ ] **Step 9: Run `/verify`, then commit**

```bash
git add sidecar/conversion/converter.py sidecar/conversion/azw3/run.py sidecar/main.py sidecar/tests/test_converter.py
git commit -m "feat(sidecar): convert_format runs the in-house AZW3 writer, in a child process"
```

---

### Task 2: The Calibre oracle, once, on a corpus sample

**Files:**
- Create: `scripts/azw3-oracle.py`
- Modify: `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` (begin **Annex C**)

**Interfaces:**
- Consumes: `convert_format` (Task 1), `read_epub` (`conversion/azw3/epub.py`), `_decode` (`conversion/azw3/markup.py`).
- Produces: `scripts/azw3-oracle.py EPUB…` printing one line per book (`ok` / `DIFFERS` / `refused` / `FAILED` / `ORACLE FAILED`), exit 1 if any book differs or fails; and Annex C's first section, which is the spec's slice 2 gate ("the oracle diff clean on the corpus sample").

- [ ] **Step 1: Write the script.** Create `scripts/azw3-oracle.py`:

```python
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
        text = re.sub(r"^\s*<\?xml[^>]*\?>", "", _decode(read(name)).lstrip("﻿"))
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
```

- [ ] **Step 2: Pick the corpus.** Twelve EPUB-only library books under 50 MB (Calibre's round trip of a 200 MB book is slow and says nothing extra), drawn at random, plus the three slice 1 gate books so the numbers continue from Annex B:

```bash
sqlite3 "$HOME/Library/Application Support/Musaeum/musaeum.db" \
  "select nas_path from books where formats = '[\"epub\"]' and file_size_bytes < 50000000 order by random() limit 12" \
  > /tmp/oracle-corpus.txt
for rel in $(cat /tmp/oracle-corpus.txt); do for f in /Volumes/books/musaeum/$rel/*.epub; do echo "$f"; done; done > /tmp/oracle-epubs.txt
wc -l /tmp/oracle-epubs.txt
```

Expected: 12 lines. (The paths contain spaces; read the file with `while read`, as in Step 3.) The sample is random on purpose.

- [ ] **Step 3: Run it.** Copy the twelve off the NAS first and work from the copies (`/tmp/oracle-in/`), then:

```bash
mkdir -p /tmp/oracle-in && while IFS= read -r f; do cp "$f" /tmp/oracle-in/; done < /tmp/oracle-epubs.txt
sidecar/.venv/bin/python scripts/azw3-oracle.py /tmp/oracle-in/*.epub "/Volumes/books/musaeum/books/f0c7f5e1-f40f-4d2b-a847-82287f729f3c/Yellowface A Novel.epub" \
  "/Volumes/books/musaeum/books/a764fbcf-7788-4347-82fc-f335e5e6ecd6/Darwin's Devices.epub" \
  "/Volumes/books/musaeum/books/34938395-af9b-4df4-8aa2-2b1de765d1c2/Raspberry Pi for Secret Agents.epub"
```

Expected: every line `ok` (0 missing, 0 extra) or `refused: … encrypted …` for a DRM book, and exit 0. About 10–20 s per book. Each `DIFFERS` is a finding, not a retry: find which spine file lost the words (compare `read_epub(...).spine` against the round trip's files) and **stop and report** rather than patching around it.

- [ ] **Step 4: Begin Annex C.** Append to the spec, after Annex B (create the heading if it is absent):

```markdown
## Annex C — slice 2 (convert_format on the in-house writer), built YYYY-MM-DD

**The oracle (spec slice 2 gate).** `scripts/azw3-oracle.py`, once: each book converted with `convert_format`, converted back to EPUB with Calibre's `ebook-convert`, and the words of the source's reading-order files compared with the round trip's. Fifteen books: twelve drawn at random from the EPUB-only library under 50 MB, plus the three slice 1 gate books.

| Book | Result |
| --- | --- |
| … one row per book, copied from the script's output … | |

**Verdict:** all fifteen … (or: the findings, per book).
```

Fill the table from Step 3's output.

- [ ] **Step 5: Commit**

```bash
git add scripts/azw3-oracle.py docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md
git commit -m "docs: Annex C — the Calibre oracle on a corpus sample; the oracle script"
```

---

### Task 3: The creator-field experiment (owner gate)

**Files:**
- Modify: `sidecar/conversion/azw3/writer.py`, `scripts/azw3-spike.py`
- Test: `sidecar/tests/test_azw3_writer.py` (append)

**Interfaces:**
- Consumes: `build_azw3`, `write_azw3`, `read_identity`, the `book` fixture and `read_kf8` already in `test_azw3_writer.py`.
- Produces: `build_azw3(epub_path, *, creator_fields: bool = True) -> Conversion` and `write_azw3(epub_path, out_path, *, creator_fields: bool = True) -> Conversion`; `scripts/azw3-spike.py [--no-creator] EPUB OUTDIR`. The default stays `True` until the owner reports.

Why: EXTH 204–207 and 535 are *creator software* fields. The spike writes the values Calibre writes (204 = 202, "kindlegen Mac"; 205/206 = 2.9; 535 = `0730-890adc2`), which name Amazon's converter. Every file the Oasis has opened carries them, so they were kept for the slice 1 gate. Nothing measured says the firmware reads them. A writer that claims to be someone else's tool is better off not doing so, if the device does not care.

- [ ] **Step 1: Write the failing tests.** Append to `sidecar/tests/test_azw3_writer.py`:

```python
# --- slice 2: the creator-software fields are an experiment until the Oasis says whether it needs them

CREATOR_TYPES = {204, 205, 206, 207, 535}


def test_creator_software_fields_are_written_by_default_and_can_be_left_out(book):
    default = read_kf8(build_azw3(str(book)).data)
    assert CREATOR_TYPES <= set(default.exth)
    bare = read_kf8(build_azw3(str(book), creator_fields=False).data)
    assert not CREATOR_TYPES & set(bare.exth)
    assert {100, 113, 501, 503, 524} <= set(bare.exth)  # identity and language are untouched


def test_a_file_without_the_creator_fields_still_reads_back_as_written(book):
    conversion = build_azw3(str(book), creator_fields=False)
    identity = read_identity(conversion.data)
    assert (identity.title, identity.uuid, identity.cdetype) == ("Test Book", conversion.uuid, "EBOK")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_writer.py -q -k creator`
Expected: FAIL with `TypeError: build_azw3() got an unexpected keyword argument 'creator_fields'` (both tests).

- [ ] **Step 3: Add the option.** In `sidecar/conversion/azw3/writer.py`:

Change `def build_azw3(epub_path: str) -> Conversion:` to:

```python
def build_azw3(epub_path: str, *, creator_fields: bool = True) -> Conversion:
```

Replace the line

```python
    exth_records += [(kind, u32(value)) for kind, value in CREATOR] + [(535, CREATOR_BUILD)]
```

with:

```python
    if creator_fields:
        exth_records += [(kind, u32(value)) for kind, value in CREATOR] + [(535, CREATOR_BUILD)]
```

Change `def write_azw3(epub_path: str, out_path: str) -> Conversion:` to:

```python
def write_azw3(epub_path: str, out_path: str, *, creator_fields: bool = True) -> Conversion:
```

and, inside it, `conversion = build_azw3(epub_path)` to:

```python
    conversion = build_azw3(epub_path, creator_fields=creator_fields)
```

- [ ] **Step 4: Add the CLI flag.** Overwrite `scripts/azw3-spike.py` with:

```python
#!/usr/bin/env python3
"""Convert one EPUB to AZW3 with the in-house writer, for the slice 1 device gate.

    sidecar/.venv/bin/python scripts/azw3-spike.py [--no-creator] "/path/to/Book.epub" /tmp/azw3-gate

Writes `<title>.azw3` and the device's cover-cache entry
`thumbnail_<EXTH 113>_EBOK_portrait.jpg` (fitted inside 330x500, the size
`docs/invariants/device-transfer.md` records) into the output folder, and prints
the size, the time taken and every warning. `--no-creator` leaves out the
creator-software fields (EXTH 204-207, 535) for the slice 2 device experiment. Copy the .azw3 into the Kindle's
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
    creator_fields = "--no-creator" not in argv
    args = [a for a in argv[1:] if a != "--no-creator"]
    if len(args) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    source, out_dir = Path(args[0]), Path(args[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    target = out_dir / f"{source.stem}.azw3"
    conversion = write_azw3(str(source), str(target), creator_fields=creator_fields)
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
```

- [ ] **Step 5: Run the tests and the suite**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_azw3_writer.py -q -k creator && .venv/bin/python -m pytest -q`
Expected: PASS (2 passed), then **358 passed, 2 skipped**.

- [ ] **Step 6: Build the experiment file.** *Darwin's Devices* has images, notes and a cover, so it exercises more than a plain novel. Use a fresh output folder so no stale cover files are left in it:

```bash
rm -rf /tmp/azw3-creator && mkdir -p /tmp/azw3-creator
cp "/Volumes/books/musaeum/books/a764fbcf-7788-4347-82fc-f335e5e6ecd6/Darwin's Devices.epub" /tmp/azw3-creator/
sidecar/.venv/bin/python scripts/azw3-spike.py --no-creator "/tmp/azw3-creator/Darwin's Devices.epub" /tmp/azw3-creator/out
sidecar/.venv/bin/python scripts/azw3-probe.py "/tmp/azw3-creator/out/Darwin's Devices.azw3" | grep -E "^    (204|205|206|207|535|113|501):"
```

Expected: the converter prints one `.azw3` and one `thumbnail_<uuid>_EBOK_portrait.jpg`; the probe shows only 113 and 501 — no 204–207, no 535.

- [ ] **Step 7: Commit the option**

```bash
git add sidecar/conversion/azw3/writer.py sidecar/tests/test_azw3_writer.py scripts/azw3-spike.py
git commit -m "feat(sidecar): an option to leave the creator-software fields out, for a device experiment"
```

- [ ] **Step 8: The device test (manual, owner).** This needs the Kindle and cannot be done by an agent. Copy `/tmp/azw3-creator/out/Darwin's Devices.azw3` to `documents/` and the `thumbnail_…jpg` to `system/thumbnails/`, eject, airplane mode on. The same five readings as the slice 1 gate: **opens; shows its cover; jumps to chapters from the table of contents; follows one internal link; keeps its reading position across closing and reopening.** Delete both files afterwards.

- [ ] **Step 9: Stop and hand back.** Report the five readings. Task 4 is written to run after that, in whichever session picks it up.

---

### Task 4: Apply the experiment's result, and record the slice

Run this only after the owner's report from Task 3 Step 8.

**Files:**
- Modify: `sidecar/conversion/azw3/writer.py`, `sidecar/tests/test_azw3_writer.py`, `scripts/azw3-spike.py` (all three, per the branch taken below)
- Modify: `docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md` (finish Annex C, set slice 2's status)
- Modify: `tasks.md` (the one line of the Calibre-free entry only)

- [ ] **Step 1 — if all five readings passed: the creator fields go.** In `writer.py`: delete the `CREATOR = [...]` and `CREATOR_BUILD = ...` constants and the comment above them, the `if creator_fields:` block, and the `creator_fields` parameter of both `build_azw3` and `write_azw3` (restore `build_azw3(epub_path)` and `conversion = build_azw3(epub_path)`). In `test_azw3_writer.py`: replace the two `creator` tests with:

```python
def test_no_creator_software_fields_are_written(book):
    """The Oasis does not need them (slice 2 device experiment), and they would name another maker's tool."""
    assert not {204, 205, 206, 207, 535} & set(read_kf8(build_azw3(str(book)).data).exth)
```

In `scripts/azw3-spike.py`: restore the pre-Task-3 `main` (no `--no-creator`; `write_azw3(str(source), str(target))`). Run the suite: **357 passed, 2 skipped** (356 plus the one replacement test, minus nothing else). Re-run `scripts/azw3-spike.py` on the three slice 1 gate books: each output is **68 bytes smaller** than Annex B's size (the five records; measured on *Darwin's Devices*: 3,580,872 → 3,580,804), with 0 warnings.

- [ ] **Step 1 — if any reading failed: the fields stay.** Delete the `creator_fields` parameter and the `if` (the fields are written unconditionally again), delete the two `creator` tests and the CLI flag, and add above `CREATOR` in `writer.py`:

```python
# The Oasis needs these: a file without them failed (slice 2 device experiment,
# <date>, <which reading>). They say "kindlegen Mac 2.9" because that is what the
# firmware has been shown to accept; the values are Calibre's, measured.
```

The suite is back to **356 passed, 2 skipped**.

- [ ] **Step 2: Finish Annex C.** Append to the spec's Annex C:

```markdown
**Measured limits** (the spike writer, in a child process, on the three heaviest real EPUBs): *America—Farm to Table* (238 MB) 21.3 MB out, 18 s, 452 MB peak; *Fodor's New England* (171 MB) 14.1 MB out, 20 s, 427 MB peak; *The Complete Story of Civilization* (135 MB, 4.7 M words) 138.6 MB out, 75 s, 1.1 GB peak. The last exceeds `CLAUDE.md`'s 30 s and 500 MB targets; it fits the 300 s timeout, and no size guard is applied (plan, *Decisions* 2).

**Creator-software fields (EXTH 204–207, 535).** One file without them, *Darwin's Devices*, on the Oasis (owner, <date>): opens <pass/fail>, cover <…>, TOC <…>, link <…>, reading position <…>. Ruling: <the fields are dropped / the fields stay, because …>.

**AC5, as built.** A conversion that fails or times out leaves nothing at the target or at `.tmp` (pinned). A conversion whose process is killed outright cannot clean up after itself; the next attempt for the same book removes the stale `.tmp` before it starts (pinned).

**Status:** slice 2 built; `convert_format` no longer runs Calibre. The Electron side still resolves a Calibre path and sends it (ignored) until slice 3.
```

- [ ] **Step 3: Update the roadmap line.** In `tasks.md`, in the single paragraph of the "Calibre-free Kindle conversion" entry, replace the sentence beginning "**Not wired in:**" through "…the deferred minors in the session ledger summary below." with one stating that slice 2 landed (`convert_format` runs the writer in a child process; the creator-field result; Annex C) and that **slice 3 is next**. Change nothing else in `tasks.md`: another stream edits that file.

- [ ] **Step 4: Run the whole suite and commit**

Run: `cd sidecar && .venv/bin/python -m pytest -q`
Expected: the count in Step 1 for the branch taken, no failures.

```bash
git add sidecar scripts docs/superpowers/specs/2026-10-02-calibre-free-conversion-design.md tasks.md
git commit -m "docs: Annex C — slice 2 recorded; the creator-field experiment applied"
```

- [ ] **Step 5: Hand back.** Report the oracle table, the creator-field ruling, and the measured limits. Slice 3 (the 9 files across `electron/main` ⇄ `src`, plus a comment in `device-covers.test.ts` that mentions `ebook-convert`) is planned next, from the spec; its gate is a send of an EPUB-only book to the real Kindle with `calibre.app` moved aside (AC8).

---

## Self-review

- **Spec coverage.** Slice 2's row: "promote the spike … behind `convert_format`" → Task 1; "real fixtures, pytest cases per structure" → already built in slice 1b (`build_epub` and the writer, markup, index and EPUB suites) and used by Task 1's tests; "the D3 round-trip check" → inside `build_azw3` (every conversion in every test passes it) and re-read in `test_it_returns_the_old_contract_plus_warnings_and_the_file_reads_back`; "Calibre-as-oracle validation run once and logged" → Task 2. AC4 → Task 1's read-back test. AC5 → Task 1's three failure tests, interpreted in Annex C. AC6 (a PDF is never converted; an existing azw3 is never re-converted) → unchanged: `transfer-queue.ts` decides, and Task 1 refuses a non-EPUB. AC7 → Annex C. **Not covered, by design:** AC3 and AC8 belong to slice 3; the `CLAUDE.md` amendment is slice 4. The spec's slice 2 file budget ("≤7") is met: `converter.py`, `run.py`, `main.py`, `test_converter.py`, `writer.py`, `test_azw3_writer.py`, `azw3-spike.py`, plus the new `azw3-oracle.py` and the spec (the spec and a script are not `sidecar/` code, and the brief's 10-file bound holds).
- **Placeholders.** None in code. Annex C's `<date>` and `<pass/fail>` cells are a form the executor fills from Task 2's output and the owner's report, as in the earlier annexes.
- **Type consistency.** `convert_format`, `TIMEOUT`, `SIDECAR_ROOT`, `write_azw3`, `build_azw3`, `creator_fields`, `Conversion.warnings`, `read_identity`, `build_epub`, `xhtml`, `replace_member`, `ADOBE_ENCRYPTION`, `read_kf8` are each defined once and used with those names. The child's stdout line (`size_bytes`, `warnings`) is what `convert_format` parses.
- **Review Focus.** All five lines have a named test in Task 1.
