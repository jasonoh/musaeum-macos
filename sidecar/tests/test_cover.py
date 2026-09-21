"""The cover writer's `changed` signal.

Node reports "Cover" as one of the fields a metadata refresh updated, and it
has only this flag to go on: the filenames are fixed (`cover_full.jpg`), so a
re-download of the same image and a genuinely new cover are indistinguishable
from the paths alone.
"""

import base64
import io

from PIL import Image

from pipeline import cover
from pipeline.cover import preview_data_url, previews_for, select_cover


def _image(color: tuple = (20, 40, 60), size: tuple = (400, 600)) -> bytes:
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


# --- previews for the conflict queue --------------------------------------
#
# A cover candidate is an image *URL*, and the renderer's CSP
# (`img-src 'self' musaeum: data: blob:`) refuses every remote origin — so the
# review queue showed two empty tiles labelled Google Books and OpenLibrary, and
# a person had to choose a jacket they could not see. These cases decide the
# thing that fixes it: the candidate travels as a small inlined JPEG.


def _decode(data_url: str) -> Image.Image:
    assert data_url.startswith("data:image/jpeg;base64,")
    return Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1])))


def test_a_preview_is_a_jpeg_data_url_capped_on_its_width():
    preview = preview_data_url(_image(size=(1290, 1950)))

    assert preview is not None
    image = _decode(preview)
    assert image.format == "JPEG"
    assert image.size[0] == cover.PREVIEW_MAX
    assert image.size[1] <= cover.PREVIEW_MAX * 2
    # The cap must not distort the jacket: a 2:3 cover keeps its 2:3
    assert abs(image.size[1] - round(1950 * cover.PREVIEW_MAX / 1290)) <= 1


def test_something_that_is_not_an_image_has_no_preview():
    assert preview_data_url(b"this is not an image") is None
    assert preview_data_url(None) is None
    assert preview_data_url(b"") is None


def test_previews_are_keyed_by_url_and_a_dead_one_is_simply_absent(monkeypatch):
    live, dead = "https://example.test/live.jpg", "https://example.test/dead.jpg"
    monkeypatch.setattr(cover, "_download", lambda url: _image() if url == live else None)

    previews = previews_for([live, dead])

    assert list(previews) == [live]
    assert _decode(previews[live]).format == "JPEG"


def test_a_url_that_is_not_remote_is_never_downloaded(monkeypatch):
    """The renderer hands these in; only an absolute http(s) URL is fetched."""
    calls = []
    monkeypatch.setattr(cover, "_download", lambda url: calls.append(url) or _image())

    previews = previews_for(["file:///etc/passwd", "not a url", "/Volumes/books/x.jpg", None])

    assert previews == {}
    assert calls == []


def test_the_same_url_is_downloaded_once_and_the_call_is_bounded(monkeypatch):
    calls = []

    def counting(url):
        calls.append(url)
        return _image()

    monkeypatch.setattr(cover, "_download", counting)
    urls = [f"https://example.test/{i}.jpg" for i in range(10)]

    previews = previews_for([urls[0], urls[0], urls[1], *urls[2:]])

    assert len(calls) == len(previews) == cover.MAX_PREVIEWS, "deduped, then capped"
    # Every value is a preview and every key a URL it asked for — the shape the
    # renderer renders, asserted over the payload rather than over a component
    assert set(previews) <= set(urls)
    assert all(v.startswith("data:image/jpeg;base64,") for v in previews.values())
