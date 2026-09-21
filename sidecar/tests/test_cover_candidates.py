"""The covers a book could wear, and putting one of them on.

`cover_candidates` is the picker's live gather: the same three requests a
hydration makes (the file's own metadata, Google Books, OpenLibrary — D1 of
`docs/superpowers/specs/2026-09-21-cover-choice-design.md`), scored by the same
formula, summarised into something a renderer can actually display. Nothing is
written and nothing is persisted, so there is no stored candidate list to go
stale.

`set_cover` writes a choice. `source='embedded'` re-extracts the file's own
jacket — the one thing neither `fetch_cover` nor a resolved conflict can put
back, because an embedded candidate has no URL — and every other source goes
through `fetch_cover`, so the picker and the conflict queue converge on one
writer rather than two.

Three of the decisions here have a second home, and each case says so where it
matters: the *policy* half of D6 (which source may be named at all) is refused in
the main process, because that is the boundary a renderer can reach; the byte
comparison behind `applied` is the same `_renditions` the writer writes; and the
preview rule is `pipeline.cover.preview_data_url`, shared with the conflict
queue's tiles.

Every case is offline: both fetchers are monkeypatched, and the scoring step's
`_download` answers only the URLs a case registered — an unregistered URL is a
dead candidate, never a live request.
"""

import base64
import hashlib
import io
import os
import zipfile
from typing import Optional

import pytest
from PIL import Image

import pipeline.hydration as hydration
from pipeline import cover

# The candidates the design was opened for, at the sizes the spec records: the
# file's own jacket (1290x1950), OpenLibrary's (307x500) and Google's thumbnail
# (128x198). Every colour is distinct, so a thumb can be traced back to the
# candidate it came from.
FULL_MAX = (600, 1200)

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""


def _image(color: tuple, size: tuple) -> bytes:
    """A flat-coloured PNG: deterministic, tiny, and unmistakably itself."""
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


EMBEDDED = _image((20, 40, 60), (1290, 1950))
GOOGLE = _image((200, 180, 20), (128, 198))
OPENLIB = _image((10, 120, 90), (307, 500))
OUTSIDER = _image((250, 250, 250), (500, 750))

GOOGLE_URL = "https://books.google.com/books/content?id=X&printsec=frontcover&zoom=0"
OPENLIB_URL = "https://covers.openlibrary.org/b/id/13518691-L.jpg"
OUTSIDER_URL = "https://example.test/not-a-candidate.jpg"


def _epub(tmp_path, image: Optional[bytes] = EMBEDDED, identifier: str = "9780374715236") -> str:
    """A synthetic EPUB that carries `image` as its declared cover."""
    path = tmp_path / "book.epub"
    manifest = '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>'
    if image:
        manifest += (
            '<item id="jacket" href="cover.png" media-type="image/png" '
            'properties="cover-image"/>'
        )
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Artificial Intelligence</dc:title>
    <dc:identifier id="bookid">urn:isbn:{identifier}</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>{manifest}</manifest>
  <spine><itemref idref="c1"/></spine>
</package>
"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/c1.xhtml", "<html><body><p>x</p></body></html>")
        if image:
            z.writestr("OEBPS/cover.png", image)
    return str(path)


def _book_dir(tmp_path) -> str:
    out = tmp_path / "out"
    os.makedirs(out, exist_ok=True)
    return str(out)


def _fetchers(monkeypatch, google: Optional[dict] = None, openlib: Optional[dict] = None) -> None:
    """The two online fetchers, answered from a record rather than the network."""
    monkeypatch.setattr(hydration, "fetch_google_books", lambda *a, **k: google)
    monkeypatch.setattr(hydration, "fetch_openlibrary", lambda *a, **k: openlib)
    monkeypatch.setattr(hydration, "fetch_series", lambda *a, **k: None)


def _downloads(monkeypatch, images: dict) -> list:
    """`_download` answers only the registered URLs; anything else is dead.

    Returns the list of URLs it was asked for, so a case can assert that a
    refusal never reached the network.
    """
    asked = []

    def fake(url: str):
        asked.append(url)
        return images.get(url)

    monkeypatch.setattr(cover, "_download", fake)
    return asked


def _hydrate(tmp_path, monkeypatch, file_path: str, book_dir: str, **kwargs) -> dict:
    """One full hydration with both online sources stubbed in."""
    _fetchers(
        monkeypatch,
        google={"cover_url": GOOGLE_URL, "cover_data": GOOGLE},
        openlib={"cover_url": OPENLIB_URL},
    )
    _downloads(monkeypatch, {OPENLIB_URL: OPENLIB})
    return hydration.hydrate_metadata(
        book_id="probe",
        file_path=file_path,
        book_dir=book_dir,
        known={},
        source_preferences={},
        **kwargs,
    )


def _stored(book_dir: str) -> bytes:
    with open(os.path.join(book_dir, "cover_full.jpg"), "rb") as fh:
        return fh.read()


def _by_source(candidates: list) -> dict:
    return {c["source"]: c for c in candidates}


# --- the gather ------------------------------------------------------------


def test_the_gather_is_the_files_own_image_and_both_online_ones(tmp_path):
    """AC5, at the level the bytes live at.

    `gather_candidates` is what the refactor moved out of `hydrate_metadata`; the
    embedded candidate is the file's own image byte for byte, the fetcher's
    already-downloaded bytes travel on rather than being fetched twice, and a
    source that supplies none is left without any (the scoring step downloads it
    — the shape Google's placeholder guard made possible in slice 1a).
    """
    file_path = _epub(tmp_path)

    gathered = cover.gather_candidates(
        file_path, {"cover_url": GOOGLE_URL, "cover_data": GOOGLE}, {"cover_url": OPENLIB_URL}
    )

    assert [c["source"] for c in gathered] == ["google_books", "openlibrary", "embedded"]
    assert gathered[0]["data"] == GOOGLE, "the fetcher's bytes travel with its url"
    assert "data" not in gathered[1], "a source with no bytes is downloaded, not skipped"
    assert hashlib.md5(gathered[2]["data"]).hexdigest() == hashlib.md5(EMBEDDED).hexdigest()


def test_the_files_own_jacket_is_a_candidate_with_no_url_and_its_own_thumb(tmp_path, monkeypatch):
    """AC4a. The one candidate a queued conflict can never carry, and the thumb
    that proves it is *this* image and not a neighbour's."""
    _fetchers(
        monkeypatch,
        google={"cover_url": GOOGLE_URL, "cover_data": GOOGLE},
        openlib={"cover_url": OPENLIB_URL},
    )
    _downloads(monkeypatch, {OPENLIB_URL: OPENLIB})
    file_path = _epub(tmp_path)

    candidates = hydration.cover_candidates(file_path, _book_dir(tmp_path), known={})
    embedded = _by_source(candidates)["embedded"]

    assert "url" not in embedded, "absent, not null: that absence is what set_cover refuses on"
    # Byte-for-byte the shared preview rule, so a picker thumb and a conflict
    # tile cannot diverge...
    assert embedded["thumb"] == cover.preview_data_url(EMBEDDED)
    # ...and its pixels are this image, not the candidate next to it
    assert _nearest_fixture(embedded["thumb"]) == "embedded"
    assert (embedded["width"], embedded["height"]) == (1290, 1950)


def test_the_gather_is_ranked_and_shaped_like_the_payload_the_picker_reads(tmp_path, monkeypatch):
    """The ranking and the shape, over the assembled payload rather than a field.

    `winner` is `score_candidates`' head — the candidate `select_cover` would
    write — so the order and the marking have to agree; and every thumb has to be
    a `data:` URL, because the renderer's CSP names no remote origin and a
    candidate it cannot show is a blank tile a person would choose blind.
    """
    _fetchers(
        monkeypatch,
        google={"cover_url": GOOGLE_URL, "cover_data": GOOGLE},
        openlib={"cover_url": OPENLIB_URL},
    )
    _downloads(monkeypatch, {OPENLIB_URL: OPENLIB})
    file_path = _epub(tmp_path)

    candidates = hydration.cover_candidates(file_path, _book_dir(tmp_path), known={})

    scores = [c["score"] for c in candidates]
    assert scores == sorted(scores, reverse=True), "best first: winner is the head"
    assert [c["winner"] for c in candidates].count(True) == 1
    assert candidates[0]["source"] == "embedded", "the 1290x1950 jacket wins on the formula"
    assert all(c["thumb"].startswith("data:image/jpeg;base64,") for c in candidates)
    # ...and each one is *its own* image rather than the winner's, read off the
    # pixels: a label would be right either way, so the colour is what decides it
    assert {c["source"]: _nearest_fixture(c["thumb"]) for c in candidates} == {
        "embedded": "embedded",
        "openlibrary": "openlibrary",
        "google_books": "google_books",
    }
    assert all(set(c) >= {"source", "width", "height", "score", "winner", "applied", "thumb"}
               for c in candidates)


def test_a_candidate_that_cannot_be_downloaded_is_simply_absent(tmp_path, monkeypatch):
    """Invariant 12's shape: a dead URL is a missing candidate, not a failure."""
    _fetchers(monkeypatch, openlib={"cover_url": OPENLIB_URL})
    _downloads(monkeypatch, {})
    file_path = _epub(tmp_path)

    candidates = hydration.cover_candidates(file_path, _book_dir(tmp_path), known={})

    assert [c["source"] for c in candidates] == ["embedded"]


# --- `applied`: byte identity, not provenance ------------------------------


def test_applied_is_the_jacket_the_book_is_wearing(tmp_path, monkeypatch):
    """AC4b's first half: a book hydrated *from its own file* wears the embedded
    candidate, and says so — while the same book's row records no source at all,
    which is exactly why this cannot be provenance."""
    file_path = _epub(tmp_path)
    book_dir = _book_dir(tmp_path)
    _hydrate(tmp_path, monkeypatch, file_path, book_dir)

    assert _stored(book_dir) == cover._renditions(EMBEDDED)[0], "the file's jacket won"
    candidates = hydration.cover_candidates(file_path, book_dir, known={})

    assert [c["source"] for c in candidates if c["applied"]] == ["embedded"]
    # The public statement of the same fact: writing it again changes no bytes
    assert cover.write_choice(file_path, book_dir, "embedded", None)["changed"] is False


def test_applied_follows_the_bytes_a_choice_actually_wrote(tmp_path, monkeypatch):
    """AC4b's other direction: after a choice the book wears *that* jacket, and
    the candidate it was is the only one marked."""
    file_path = _epub(tmp_path)
    book_dir = _book_dir(tmp_path)
    _hydrate(tmp_path, monkeypatch, file_path, book_dir)

    _downloads(monkeypatch, {GOOGLE_URL: GOOGLE})
    cover.write_choice(file_path, book_dir, "google_books", GOOGLE_URL)
    candidates = hydration.cover_candidates(file_path, book_dir, known={})

    assert [c["source"] for c in candidates if c["applied"]] == ["google_books"]


def test_a_jacket_from_outside_the_candidate_set_is_applied_to_none(tmp_path, monkeypatch):
    """AC4b, the reading its wording needs: "false for all of them" is only
    reachable when the stored cover is *no* candidate's bytes.

    Choosing one of the candidates necessarily makes that one applied — which is
    the criterion working, not failing. The reachable all-false state is the one
    the conflict queue produces: a resolution downloads a URL the gather has not
    returned (an older rendition, or a source that no longer answers), and then
    no candidate is the jacket on disk.
    """
    file_path = _epub(tmp_path)
    book_dir = _book_dir(tmp_path)
    _hydrate(tmp_path, monkeypatch, file_path, book_dir)

    _downloads(monkeypatch, {OUTSIDER_URL: OUTSIDER, OPENLIB_URL: OPENLIB})
    cover.fetch_cover(book_dir, OUTSIDER_URL, "openlibrary")
    candidates = hydration.cover_candidates(file_path, book_dir, known={})

    assert sorted(c["source"] for c in candidates) == ["embedded", "google_books", "openlibrary"]
    assert [c["applied"] for c in candidates] == [False, False, False]


# --- setting a cover -------------------------------------------------------


def test_setting_the_files_own_jacket_restores_exactly_its_bytes(tmp_path, monkeypatch):
    """AC6 — the thing this slice adds that nothing could do before.

    An embedded jacket has no URL, so neither a resolved conflict nor the
    picker's other source could put it back; `write_choice` re-extracts it from
    the file and writes the same bytes `_renditions` derives.
    """
    file_path = _epub(tmp_path)
    book_dir = _book_dir(tmp_path)
    _hydrate(tmp_path, monkeypatch, file_path, book_dir)
    _downloads(monkeypatch, {GOOGLE_URL: GOOGLE})
    cover.write_choice(file_path, book_dir, "google_books", GOOGLE_URL)
    assert _stored(book_dir) != cover._renditions(EMBEDDED)[0]

    result = cover.write_choice(file_path, book_dir, "embedded", None)

    assert _stored(book_dir) == cover._renditions(EMBEDDED)[0]
    assert result["changed"] is True
    assert result["source"] == "embedded"
    assert (result["width"], result["height"]) == (1290, 1950)


def test_choosing_the_jacket_already_applied_changes_no_bytes(tmp_path, monkeypatch):
    """AC9a's byte half — decided here, where the bytes are, because the main
    process's copy of this case runs with the sidecar stubbed and would be
    asserting about its own mock.

    `changed` is the writer's own comparison of what it is about to write against
    what is on disk, so `False` *is* the byte comparison.
    """
    file_path = _epub(tmp_path)
    book_dir = _book_dir(tmp_path)
    _hydrate(tmp_path, monkeypatch, file_path, book_dir)
    before = _stored(book_dir)

    result = cover.write_choice(file_path, book_dir, "embedded", None)

    assert result["changed"] is False
    assert _stored(book_dir) == before


def test_a_write_with_nothing_to_write_raises_rather_than_doing_nothing(tmp_path):
    """The mechanics half of D6, and the reason the *policy* half is elsewhere:
    what lives here is what cannot be done at all, not what a person may ask for.

    A named source the gather never produced is refused in the main process
    (`services/cover-choice.ts`), where the renderer's echo can be checked and
    where the refusal is a sentence rather than an exception. Reaching this
    module with no URL to fetch or no jacket to restore is a caller bug, and a
    silent no-op here would read to the user as "the app did nothing".
    """
    book_dir = _book_dir(tmp_path)

    with pytest.raises(ValueError):
        cover.write_choice(str(tmp_path / "book.epub"), book_dir, "google_books", None)

    with pytest.raises(ValueError):
        cover.write_choice(_epub(tmp_path, image=None), book_dir, "embedded", None)


def test_a_locked_cover_is_the_fetchs_business_not_the_pickers(tmp_path, monkeypatch):
    """D4's reading, stated as both halves in one case.

    `hydrate_metadata` gathers nothing at all for a locked cover — selecting one
    would spend a download on an image the user has already chosen over, and that
    is `test_hydration_locks.py`'s case, cited rather than re-written. The
    picker's gather must **not** grow the same guard: reopening the picker to
    choose a different jacket is the only way back from a lock, so a gather that
    refused one would make locking a one-way door.
    """
    file_path = _epub(tmp_path)
    book_dir = _book_dir(tmp_path)

    hydrated = _hydrate(tmp_path, monkeypatch, file_path, book_dir, locked_fields=["cover"])
    assert hydrated["cover"] is None
    assert not os.path.exists(os.path.join(book_dir, "cover_full.jpg"))

    gathered = hydration.cover_candidates(file_path, book_dir, known={})
    assert "embedded" in {c["source"] for c in gathered}


# --- the refactor's verdict ------------------------------------------------


def test_select_cover_still_decides_the_reported_books_three_candidates(tmp_path, monkeypatch):
    """AC11: the gather and the scoring loop moved, the verdict did not.

    Fed the design's own three descriptors, `select_cover` must still pick the
    file's jacket, stay well outside the review band (so nothing is queued), and
    report no change on a second run. It is also the case that pins what this
    slice deliberately leaves alone: the list a conflict carries is URLs only, so
    an embedded candidate is still not something the queue can offer.
    """
    book_dir = _book_dir(tmp_path)
    _downloads(monkeypatch, {GOOGLE_URL: GOOGLE, OPENLIB_URL: OPENLIB})
    descriptors = [
        {"source": "google_books", "url": GOOGLE_URL},
        {"source": "openlibrary", "url": OPENLIB_URL},
        {"source": "embedded", "data": EMBEDDED},
    ]

    first = cover.select_cover(descriptors, book_dir)
    second = cover.select_cover(descriptors, book_dir)

    assert first["cover"]["source"] == "embedded"
    assert first["review"] is False, "0.22 of margin, against a 15% band"
    assert _stored(book_dir) == cover._renditions(EMBEDDED)[0]
    assert second["cover"]["changed"] is False
    assert sorted(c["source"] for c in first["candidates"]) == ["google_books", "openlibrary"]


def test_the_rpc_table_wires_both_methods_to_the_pipeline(monkeypatch):
    """The registration, which nothing else compares.

    A method name is a string crossing a language boundary: the main process asks
    for `cover_candidates` and the sidecar answers for whatever key sits in this
    table, so a typo there is invisible to both suites and surfaces only in the
    app. The case drives the entries themselves — the keys the TS service actually
    names — and asserts what they hand the pipeline, including the defaults a
    choice relies on (`known` absent, `url` absent for the embedded candidate).
    """
    import main

    seen = {}

    def spy_candidates(**kwargs):
        seen["candidates"] = kwargs
        return []

    def spy_write(**kwargs):
        seen["write"] = kwargs
        return {}

    monkeypatch.setattr(main, "cover_candidates", spy_candidates)
    monkeypatch.setattr(main, "write_choice", spy_write)

    assert main.METHODS["cover_candidates"](
        {"book_id": "b", "file_path": "/book.epub", "book_dir": "/dir", "known": {"title": "T"}}
    ) == []
    assert main.METHODS["set_cover"](
        {"file_path": "/book.epub", "book_dir": "/dir", "source": "google_books", "url": "u"}
    ) == {}

    assert seen["candidates"] == {
        "file_path": "/book.epub",
        "book_dir": "/dir",
        "known": {"title": "T"},
    }
    assert seen["write"] == {
        "file_path": "/book.epub",
        "book_dir": "/dir",
        "source": "google_books",
        "url": "u",
    }

    # The two optional params: an omitted `known` is no identifiers at all, and an
    # omitted `url` is what an embedded choice sends
    main.METHODS["cover_candidates"]({"file_path": "/book.epub", "book_dir": "/dir"})
    main.METHODS["set_cover"]({"file_path": "/book.epub", "book_dir": "/dir", "source": "embedded"})

    assert seen["candidates"]["known"] == {}
    assert seen["write"]["url"] is None


def test_the_sources_a_choice_may_name_are_the_scored_sources():
    """The boundary's copy of the vocabulary, pinned here.

    The main process refuses a `source` outside this set (D6), and it has to:
    that check belongs on the side of the boundary a renderer can reach. Which
    means the set exists in two languages, and this case is the only thing that
    makes a change *here* visible next to the TypeScript copy in a diff.
    """
    assert set(cover.SOURCE_PRIORITY) == {"google_books", "openlibrary", "embedded"}


def _thumb_colour(data_url: str) -> tuple:
    """The flat colour inside a preview — read off its pixels, not its label."""
    raw = base64.b64decode(data_url.split(",", 1)[1])
    pixels = Image.open(io.BytesIO(raw)).convert("RGB").tobytes()
    return (pixels[0], pixels[1], pixels[2])


# The three fixtures' own colours, hundreds of points apart, so a q80 JPEG —
# which moves a flat colour by a point or two — cannot blur them together.
FIXTURE_COLOURS = {
    "embedded": (20, 40, 60),
    "google_books": (200, 180, 20),
    "openlibrary": (10, 120, 90),
}


def _nearest_fixture(data_url: str) -> str:
    """Which candidate's image a thumb is actually showing."""
    colour = _thumb_colour(data_url)
    return min(
        FIXTURE_COLOURS,
        key=lambda name: sum(abs(a - b) for a, b in zip(colour, FIXTURE_COLOURS[name])),
    )
