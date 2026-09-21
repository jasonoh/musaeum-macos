"""The jacket Google holds, and the tile it answers with when it holds none.

Two things changed in `fetchers/google_books.py` and each has its own decider.
The fetcher now asks for the **biggest** rendition rather than the biggest one
*advertised*: measured 2026-09-21, 11 of 11 sampled volumes advertised only
`thumbnail`/`smallThumbnail` (~128 px) and the same volumes answered a `zoom=0`
request with 575x750 … 2164x3398. And it refuses to hand back Google's
"image not available" tile, which is **byte-identical across unrelated volumes**
and large enough to win a cover contest against most embedded covers — the trap
that makes a naive `zoom=1 → zoom=0` rewrite a regression rather than a fix.

Numbers, provenance and the census that re-measures the tile live in
`docs/superpowers/specs/2026-09-21-cover-choice-design.md`. Every case here is
offline: `requests.get` is replaced, so a URL nobody stubbed answers 404 and the
test cannot depend on the network.
"""

import hashlib
import io
import random

from PIL import Image
from requests.exceptions import HTTPError

from fetchers import google_books

# What the API advertises (http, as it ships), and the two forms the fetcher
# may actually request: the biggest rendition, and the advertised one upgraded
# to https.
ADVERTISED = (
    "http://books.google.com/books/content?id=X&printsec=frontcover"
    "&img=1&zoom=1&edge=curl&source=gbs_api"
)
ADVERTISED_HTTPS = ADVERTISED.replace("http://", "https://")
BIGGEST = ADVERTISED.replace("zoom=1", "zoom=0").replace("http://", "https://")
SMALL = ADVERTISED.replace("zoom=1", "zoom=5")


def _image(size=(200, 300), seed=1) -> bytes:
    """Deterministic noise: incompressible, so it is well over the 1 KB floor."""
    rng = random.Random(seed)
    raw = bytes(rng.randrange(256) for _ in range(size[0] * size[1] * 3))
    buf = io.BytesIO()
    Image.frombytes("RGB", size, raw).save(buf, "PNG")
    return buf.getvalue()


def _volume(**over) -> dict:
    volume = {
        "title": "Artificial Intelligence",
        "authors": ["Melanie Mitchell"],
        "industryIdentifiers": [{"type": "ISBN_13", "identifier": "9780374715236"}],
        "imageLinks": {"smallThumbnail": SMALL, "thumbnail": ADVERTISED},
    }
    volume.update(over)
    return volume


class _Response:
    def __init__(self, content: bytes = b"", status: int = 200, json_body=None):
        self.content = content
        self.status_code = status
        self._json = json_body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise HTTPError(f"{self.status_code}")

    def json(self):
        return self._json


def _stub(monkeypatch, volume: dict, images: dict) -> None:
    """`requests.get` for the API and for the image URLs in `images`.

    Anything else 404s, which is the honest shape of "this rendition does not
    exist" — and it means no case here can quietly reach the network.
    """

    def fake_get(url, **_kwargs):
        if url == google_books.API_URL:
            return _Response(json_body={"totalItems": 1, "items": [{"volumeInfo": volume}]})
        if url in images:
            return _Response(images[url])
        return _Response(status=404)

    monkeypatch.setattr(google_books.requests, "get", fake_get)


def _fetch(monkeypatch, volume: dict, images: dict) -> dict:
    """One fetch against the stub, with the two image URLs registered for it."""
    _stub(monkeypatch, volume, images)
    result = google_books.fetch_google_books(isbn_13="9780374715236")
    assert result is not None, "the volume was stubbed, so a miss here is a wiring bug"
    return result


def _sentinel(monkeypatch, data: bytes) -> None:
    """Make `data` the recorded placeholder tile.

    The mechanism is what this file decides; the *value* of the constant is
    decided by the census and pinned by its own case below. Patching it here is
    what lets a case exercise the guard without shipping Google's image.
    """
    monkeypatch.setattr(google_books, "PLACEHOLDER_MD5", hashlib.md5(data).hexdigest())


# --- which rendition is asked for -----------------------------------------


def test_the_biggest_rendition_is_asked_for_first():
    assert google_books._cover_urls({"thumbnail": ADVERTISED}) == [BIGGEST, ADVERTISED_HTTPS]


def test_a_small_thumbnail_is_upgraded_and_kept_as_the_fallback():
    assert google_books._cover_urls({"smallThumbnail": SMALL}) == [
        BIGGEST,
        SMALL.replace("http://", "https://"),
    ]


def test_a_link_without_a_zoom_parameter_is_used_as_it_is():
    plain = "https://books.google.com/books/content?id=X&printsec=frontcover"
    assert google_books._cover_urls({"thumbnail": plain}) == [plain]


def test_no_image_links_is_no_rendition():
    assert google_books._cover_urls({}) == []


def test_the_fetch_returns_the_big_rendition_with_its_bytes(monkeypatch):
    """The wiring, not just the helper: the bytes travel with the url so the
    scoring step does not download the same image a second time."""
    image = _image()
    result = _fetch(monkeypatch, _volume(), {BIGGEST: image})

    assert result["cover_url"] == BIGGEST
    assert result["cover_data"] == image


# --- the placeholder tile --------------------------------------------------


def test_the_tile_is_discarded_in_favour_of_the_advertised_thumbnail(monkeypatch):
    tile, real = _image(seed=7), _image(seed=8)
    _sentinel(monkeypatch, tile)

    result = _fetch(monkeypatch, _volume(), {BIGGEST: tile, ADVERTISED_HTTPS: real})

    assert result["cover_url"] == ADVERTISED_HTTPS
    assert result["cover_data"] == real


def test_a_real_image_that_happens_to_share_the_tiles_size_is_kept(monkeypatch):
    """The false-drop guard: the tile is recognised by its bytes, never by its
    dimensions — a correct cover of the same size must survive."""
    tile, real = _image((575, 750), seed=3), _image((575, 750), seed=4)
    _sentinel(monkeypatch, tile)

    result = _fetch(monkeypatch, _volume(), {BIGGEST: real})

    assert result["cover_url"] == BIGGEST
    assert result["cover_data"] == real


def test_a_rendition_that_cannot_be_downloaded_falls_through(monkeypatch):
    real = _image(seed=9)
    result = _fetch(monkeypatch, _volume(), {ADVERTISED_HTTPS: real})

    assert result["cover_url"] == ADVERTISED_HTTPS
    assert result["cover_data"] == real


def test_every_rendition_being_the_tile_means_no_cover_at_all(monkeypatch):
    """Better no fetched cover than "image not available" standing in for one:
    the book keeps whatever its own file carries."""
    tile = _image(seed=11)
    _sentinel(monkeypatch, tile)

    result = _fetch(monkeypatch, _volume(), {BIGGEST: tile, ADVERTISED_HTTPS: tile})

    assert result["cover_url"] is None
    assert result["cover_data"] is None


def test_the_recorded_placeholder_is_the_one_that_was_measured():
    """A source pin, so a later edit to the constant is visible in a diff.

    The value is not decidable here — only the census can re-measure it (three
    unrelated volumes returned these exact bytes on 2026-09-21: 575x750,
    9,103 B). If Google changes the tile, this case reddens first.
    """
    assert google_books.PLACEHOLDER_MD5 == "a64fa89d7ebc97075c1d363fc5fea71f"
