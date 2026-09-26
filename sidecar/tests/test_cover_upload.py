"""A cover taken from a file on this machine — the third way one arrives.

`set_cover_from_file` is the upload's sidecar half (D6 of
`docs/superpowers/specs/2026-09-25-cover-sources-design.md`): a main-process
dialog picked the path, so the file is read here, validated with PIL against the
same floor `score_candidates` applies, and written through `_write_chosen` — the
same 600/200 renditions and the same two fixed filenames as a fetched or a
re-extracted jacket. Nothing downstream can tell an uploaded cover from a chosen
one, which is the point of routing it through the existing writer.

AC12 is a pair of refusals, and the half worth stating plainly is the negative:
a refused upload writes **nothing**. The guard runs before the writer, so
`cover_full.jpg` is never created, and a book that already had a cover keeps
that cover's bytes rather than a 100 px image's.

Every case is offline — no network, no encoder of its own — and the images are
flat-coloured PNGs built in memory, so a rendition's dimensions are the only
thing a case has to measure.
"""

import io
import os

import pytest
from PIL import Image

from pipeline import cover

# A 2:3 portrait, comfortably over the floor and over both rendition sizes, so
# "600 px wide" measures the writer rather than the source: 1200x1600 renders to
# 600x800 and 200x267 (PIL rounds that second one up), and no rendition is a
# no-op.
CHOSEN = (1200, 1600)


def _png(size: tuple, color: tuple = (30, 60, 90)) -> bytes:
    """A flat-coloured PNG: deterministic, tiny, and unmistakably itself."""
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def _file(tmp_path, name: str, data: bytes) -> str:
    path = tmp_path / name
    path.write_bytes(data)
    return str(path)


def _book_dir(tmp_path) -> str:
    out = tmp_path / "out"
    os.makedirs(out, exist_ok=True)
    return str(out)


def _entries(book_dir: str) -> list:
    """Everything in the book's folder, so "nothing was written" is decidable.

    A listing rather than two `exists` calls: a guard that wrote a third file,
    or a partial `cover_full.jpg` beside a refusal, is exactly the failure this
    criterion is about.
    """
    return sorted(os.listdir(book_dir))


def _bytes(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def _size(path: str) -> tuple:
    with Image.open(path) as img:
        return img.size


# --- the write --------------------------------------------------------------


def test_a_chosen_image_becomes_the_two_fixed_renditions(tmp_path):
    """AC12's positive half: 600 px wide and 200 px wide, aspect preserved.

    The filenames are the ones every other reader of a cover expects and the
    sizes are `_renditions`', so "written through the existing path" is
    measurable here: a second encoder would have to land on these two numbers by
    coincidence. The dimensions in the return value are the *source image's* —
    what the row records is the cover a person chose, not the rendition the app
    made of it.
    """
    book_dir = _book_dir(tmp_path)
    image = _file(tmp_path, "chosen.png", _png(CHOSEN))

    result = cover.set_cover_from_file(book_dir, image)

    full = os.path.join(book_dir, "cover_full.jpg")
    thumb = os.path.join(book_dir, "cover_thumb.jpg")
    assert _size(full) == (600, 800)
    assert _size(thumb) == (200, 267)
    # Aspect preserved, not stamped: the source's own 2:3 within PIL's rounding,
    # which is what "not squashed" means for a jacket
    assert abs(600 / 800 - CHOSEN[0] / CHOSEN[1]) < 0.001
    assert abs(200 / 267 - CHOSEN[0] / CHOSEN[1]) < 0.01
    assert result["full"] == "cover_full.jpg"
    assert result["thumb"] == "cover_thumb.jpg"
    assert (result["width"], result["height"]) == CHOSEN
    assert result["changed"] is True
    # The writer's provenance label. It is returned, never persisted: no reader
    # of a stored cover knows where it came from (D6's "indistinguishable
    # downstream"), and no `source` parameter was taken to get it here.
    assert result["source"] == "upload"


def test_the_two_files_are_the_writers_own_renditions(tmp_path):
    """D6's "no second encoder", asserted against the one function that encodes.

    `_renditions` is what `_write_cover` writes, what `summarise_candidates`
    compares a candidate against to decide `applied`, and what this path writes —
    so a byte-for-byte match is the difference between an uploaded cover being
    indistinguishable downstream and merely looking like it.
    """
    book_dir = _book_dir(tmp_path)
    data = _png(CHOSEN)

    cover.set_cover_from_file(book_dir, _file(tmp_path, "chosen.png", data))

    full, thumb = cover._renditions(data)
    assert _bytes(os.path.join(book_dir, "cover_full.jpg")) == full
    assert _bytes(os.path.join(book_dir, "cover_thumb.jpg")) == thumb


# --- the refusals (AC12) ----------------------------------------------------


@pytest.mark.parametrize(
    "name,payload",
    [
        ("chosen.txt", b"a sentence I wrote, in a file that is not an image"),
        # Three bytes wearing an image extension: what the dialog's filter
        # cannot stop, and the reason the guard reads the bytes rather than
        # trusting the name.
        ("chosen.jpg", b"\x00\x01\x02"),
    ],
)
def test_a_file_that_is_not_an_image_is_refused_and_writes_nothing(tmp_path, name, payload):
    """AC12's first refusal. The sentence is the user's; the empty folder is the proof."""
    book_dir = _book_dir(tmp_path)
    image = _file(tmp_path, name, payload)

    with pytest.raises(ValueError) as refused:
        cover.set_cover_from_file(book_dir, image)

    assert "not an image" in str(refused.value)
    assert _entries(book_dir) == [], "a refused upload writes nothing at all"


def test_a_damaged_image_gets_its_own_sentence_and_writes_nothing(tmp_path):
    """The refusal the guard was missing: a real image it cannot read all of.

    Found by probing the shipped guard rather than by any test that shipped with
    it. A JPEG cut to a third passes `Image.open` — Pillow reads a file's
    dimensions lazily — so the guard used to accept it and the failure surfaced
    later, in the writer's decode, as `OSError: image file is truncated (2 bytes
    not processed)`. Nothing was written either way, so this was never a data
    hazard; what it was is a *sentence* the design promises (D6-d) arriving as a
    Python exception in the dialog's line, for the most plausible damaged file
    there is: a half-finished download.

    Two assertions, because the distinction is the fix: the sentence must say
    the image is damaged, and it must **not** be the "not an image" one — that
    would be false about a file that plainly is one, and it is exactly what the
    guard said before.
    """
    book_dir = _book_dir(tmp_path)
    whole = _png((400, 600))
    cut = _file(tmp_path, "half-downloaded.png", whole[: len(whole) // 3])

    with pytest.raises(ValueError) as refused:
        cover.set_cover_from_file(book_dir, cut)

    assert "damaged" in str(refused.value)
    assert "not an image" not in str(refused.value)
    assert _entries(book_dir) == [], "a refused upload writes nothing at all"


def test_an_image_under_the_floor_is_refused_and_leaves_the_cover_it_found(tmp_path):
    """AC12's second refusal, on the case where a late guard would look like success.

    A book that already wears a cover is the interesting half of "nothing is
    written": the image here is small enough to be refused and real enough to be
    written, so a guard sitting after the write would replace a good jacket with
    a 100 px one and still report a refusal. The bytes are compared, not the
    filenames — a rewrite with identical names is exactly the failure.
    """
    book_dir = _book_dir(tmp_path)
    cover.set_cover_from_file(book_dir, _file(tmp_path, "already.png", _png((640, 960))))
    stamped_full = _bytes(os.path.join(book_dir, "cover_full.jpg"))
    stamped_thumb = _bytes(os.path.join(book_dir, "cover_thumb.jpg"))
    before = _entries(book_dir)

    with pytest.raises(ValueError) as refused:
        cover.set_cover_from_file(book_dir, _file(tmp_path, "small.png", _png((100, 300))))

    message = str(refused.value)
    assert "100x300" in message
    assert "120 px" in message, "the sentence names the floor the person has to clear"
    assert _bytes(os.path.join(book_dir, "cover_full.jpg")) == stamped_full
    assert _bytes(os.path.join(book_dir, "cover_thumb.jpg")) == stamped_thumb
    assert _entries(book_dir) == before


def test_a_path_that_is_not_there_is_refused_rather_than_raising_an_oserror(tmp_path):
    """The dialog's path can have moved between choosing it and pressing the button.

    That is a sentence like the other two, not an `OSError` reaching the renderer
    as a stack-less message about `ENOENT` — the guard is why the read is wrapped
    at all, and this is its only decider.
    """
    book_dir = _book_dir(tmp_path)

    with pytest.raises(ValueError) as refused:
        cover.set_cover_from_file(book_dir, str(tmp_path / "gone.png"))

    assert "could not be read" in str(refused.value)
    assert _entries(book_dir) == []


def test_the_floor_is_the_scorers_floor(tmp_path):
    """The upload refuses exactly the images the picker may not offer.

    120 is `score_candidates`' own line, quoted rather than re-chosen, and this
    is what makes that quoting checkable rather than a claim: one pixel under the
    floor is refused by both, one *on* the floor by neither. A second, slightly
    different number in the guard would pass every other case in this file.
    """
    book_dir = _book_dir(tmp_path)
    on_the_floor = _png((120, 300))
    under = _png((119, 300))

    cover.set_cover_from_file(book_dir, _file(tmp_path, "floor.png", on_the_floor))
    assert os.path.exists(os.path.join(book_dir, "cover_full.jpg"))
    assert cover.score_candidates([{"source": "embedded", "data": on_the_floor}]) != []

    with pytest.raises(ValueError):
        cover.set_cover_from_file(book_dir, _file(tmp_path, "under.png", under))

    assert cover.score_candidates([{"source": "embedded", "data": under}]) == []


# --- the registration -------------------------------------------------------


def test_the_rpc_table_wires_the_upload_method(monkeypatch):
    """The method name across the language boundary, pinned where the guard is.

    The main process asks for `set_cover_from_file` and the sidecar answers for
    whatever key sits in this table, so a typo in either is invisible to both
    suites and shows up only in the running app. The two parameters are the whole
    contract — the folder to write into and the path a dialog chose — and the
    absence of a third is the decision: an upload is not a source (D6-b).
    """
    import main

    seen = {}

    def spy(**kwargs):
        seen.update(kwargs)
        return {}

    monkeypatch.setattr(main, "set_cover_from_file", spy)

    assert main.METHODS["set_cover_from_file"]({"book_dir": "/dir", "image_path": "/x.png"}) == {}

    assert seen == {"book_dir": "/dir", "image_path": "/x.png"}
