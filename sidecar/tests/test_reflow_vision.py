import json
import platform

import pypdfium2 as pdfium
import pytest

from reflow.chars import page_chars
from reflow.vision import LayoutUnavailable, find_helper, parse_stream, read_stream, run_helper
from tests.reflow_pdfs import Page, Text, write_pdf

HEADER = json.dumps({"helper": "musaeum-layout", "version": 1, "supported": True, "pages": 2})


def test_an_unsupported_machine_is_a_reason():
    with pytest.raises(LayoutUnavailable) as err:
        parse_stream([json.dumps({"helper": "musaeum-layout", "version": 1, "supported": False})])
    assert "macOS 26" in err.value.reason


def test_a_different_helper_version_is_refused():
    with pytest.raises(LayoutUnavailable) as err:
        parse_stream([json.dumps({"helper": "musaeum-layout", "version": 2, "supported": True})])
    assert "version 2" in err.value.reason


def test_no_output_is_a_reason():
    with pytest.raises(LayoutUnavailable) as err:
        parse_stream([])
    assert "no header" in err.value.reason


def test_a_document_the_helper_cannot_open_is_a_reason():
    line = json.dumps({"helper": "musaeum-layout", "version": 1, "supported": True, "error": "cannot open document"})
    with pytest.raises(LayoutUnavailable) as err:
        parse_stream([line])
    assert "cannot open document" in err.value.reason


def test_pages_regions_and_tables_parse_and_bad_lines_are_skipped():
    page = {
        "page": 1, "box": [0, 0, 612, 792], "rotation": 0, "ms": 5,
        "regions": [
            {"kind": "paragraph", "order": 1, "bbox": [1, 2, 3, 4], "text": "b"},
            {"kind": "paragraph", "order": 0, "bbox": [5, 6, 7, 8], "text": "a"},
        ],
        "tables": [{"bbox": [0, 0, 10, 10], "cells": [{"row": 0, "col": 1, "rowspan": 1, "colspan": 2, "bbox": [0, 0, 5, 5], "text": "x"}]}],
    }
    pages = parse_stream([HEADER, json.dumps(page), json.dumps({"page": 2, "error": "vision: boom"}), "not json", ""])
    assert [r.text for r in pages[1].regions] == ["a", "b"]
    assert pages[1].regions[0].bbox == (5.0, 6.0, 7.0, 8.0)
    assert pages[1].tables[0].cells[0].colspan == 2
    assert pages[2].error == "vision: boom" and pages[2].regions == []


def test_a_missing_helper_is_a_reason(monkeypatch, tmp_path):
    monkeypatch.setenv("MUSAEUM_LAYOUT_HELPER", str(tmp_path / "nope"))
    with pytest.raises(LayoutUnavailable) as err:
        run_helper(tmp_path / "x.pdf")
    assert "not installed" in err.value.reason


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


def _real_helper():
    exe = find_helper()
    major = int((platform.mac_ver()[0] or "0").split(".")[0])
    if not exe or major < 26:
        pytest.skip("needs the built layout helper on macOS 26+ (scripts/build-layout-helper.sh)")
    return exe


PARAGRAPH = [Text(72, 700 - 16 * i, f"This is line number {i} of a plain paragraph of text.", 12) for i in range(8)]


def _inside_share(path, layout):
    chars = [c for c in page_chars(pdfium.PdfDocument(path)[0].get_textpage()) if not c.is_space]
    boxes = [r.bbox for r in layout.regions]
    inside = sum(1 for c in chars if any(b[0] - 1 <= c.cx <= b[2] + 1 and b[1] - 1 <= c.cy <= b[3] + 1 for b in boxes))
    return inside / len(chars)


def test_real_helper_regions_land_on_pdf_coordinates(tmp_path):
    exe = _real_helper()
    path = write_pdf(tmp_path / "p.pdf", [Page(texts=PARAGRAPH, crop=(40, 40, 572, 752))])
    layout = run_helper(path, helper=exe)[1]
    assert layout.error is None and layout.regions
    assert layout.box == (40.0, 40.0, 572.0, 752.0)
    assert _inside_share(path, layout) >= 0.9


def test_real_helper_handles_a_rotated_page(tmp_path):
    exe = _real_helper()
    path = write_pdf(tmp_path / "r.pdf", [Page(texts=PARAGRAPH, rotate=90)])
    layout = run_helper(path, helper=exe)[1]
    assert layout.rotation == 90 and layout.regions
    assert _inside_share(path, layout) >= 0.9
