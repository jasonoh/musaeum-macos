"""The cover writer's `changed` signal.

Node reports "Cover" as one of the fields a metadata refresh updated, and it
has only this flag to go on: the filenames are fixed (`cover_full.jpg`), so a
re-download of the same image and a genuinely new cover are indistinguishable
from the paths alone.
"""

import io

from PIL import Image

from pipeline.cover import select_cover


def _image(color: tuple, size: tuple = (400, 600)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def _select(data: bytes, book_dir: str) -> dict:
    """One candidate, from bytes — no network, no scoring ambiguity."""
    return select_cover([{"source": "embedded", "data": data}], book_dir)


def test_first_write_reports_the_cover_as_changed(tmp_path):
    book_dir = str(tmp_path)
    result = _select(_image((20, 40, 60)), book_dir)

    assert result["cover"]["changed"] is True
    assert result["cover"]["full"] == "cover_full.jpg"
    assert (tmp_path / "cover_thumb.jpg").exists()


def test_rewriting_the_same_cover_reports_no_change(tmp_path):
    book_dir = str(tmp_path)
    data = _image((20, 40, 60))
    _select(data, book_dir)

    # A re-fetch that finds the same artwork must not claim the cover changed
    assert _select(data, book_dir)["cover"]["changed"] is False


def test_a_different_cover_reports_a_change(tmp_path):
    book_dir = str(tmp_path)
    _select(_image((20, 40, 60)), book_dir)

    assert _select(_image((200, 180, 20)), book_dir)["cover"]["changed"] is True


def test_a_missing_file_counts_as_a_change(tmp_path):
    book_dir = str(tmp_path)
    data = _image((20, 40, 60))
    _select(data, book_dir)

    # The thumb is what carries the library view; deleting it must not let a
    # rewrite report "nothing changed"
    (tmp_path / "cover_thumb.jpg").unlink()

    assert _select(data, book_dir)["cover"]["changed"] is True
