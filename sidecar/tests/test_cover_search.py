"""The wider search: the jackets under the book's *other* identifiers.

`search_candidates` asks the question `cover_candidates` deliberately never asks
(D1 of `docs/superpowers/specs/2026-09-25-cover-sources-design.md`): the ISBNs the
row is known by, then the ISBNs OpenLibrary lists for the same work, and — only
when every one of those missed — `intitle:"…" inauthor:"…"`. The order *is* the
safety argument (D2): an ISBN question cannot return another book, so the
identifier passes are exact, and the fuzzy pass is confined to rows whose own
identifiers are all junk.

The book these cases are modelled on is the one the design was opened for
(`7ae66296-fd60-4e99-8420-ef985e36abd6`, *Topology of Violence*, MIT Press): its
stored ISBN is one Google answers with `totalItems: 0`, and the English jackets it
should be offered instead hang off ISBNs OpenLibrary already lists for the work —
measured 2026-09-25, and the whole reason this slice exists.

Three guarantees are decided in the sidecar and only *rendered* by the picker's
UI slice, so they are pinned here: every entry comes back with `winner: false`
(D3), every entry keeps the `url` a pick needs, and nothing is written or
persisted (D4).

Every case is offline. The three search functions are monkeypatched where the
pipeline calls them, and the cases that must assert a real *query string* stub
`requests.get` in the fetcher module instead — either way, nothing here can reach
the network.
"""

import hashlib
import io
import os
import random
from typing import Optional

from PIL import Image

import pipeline.hydration as hydration
from fetchers import google_books, openlibrary
from pipeline import cover

# --- fixtures --------------------------------------------------------------
#
# The two English volumes of this book, at the sizes the design records: the
# 1352x2103 jacket Google answers `isbn:0262345072` with, and the 800x1245 one it
# answers `isbn:9780262534956` with. Flat colours, because these bytes are handed
# to the pipeline directly and only need to be real, displayable images.
JACKET_TALL = "https://books.google.com/books/content?id=9eRVDwAAQBAJ&printsec=frontcover&zoom=0"
JACKET_WIDE = "https://books.google.com/books/content?id=B-VVDwAAQBAJ&printsec=frontcover&zoom=0"

# The identifiers the row is known by — the ISBN-13 Google does not index at all,
# and its ISBN-10 sibling, which Google does not index either (both measured
# 2026-09-25 with `totalItems: 0`).
KNOWN = {
    "title": "Topology of Violence",
    "author": "Byung-Chul Han",
    "identifiers": {"isbn_13": "9780262345064", "isbn_10": "0262345056"},
}

# What OpenLibrary actually answers for that ISBN-13: one doc, **18** ISBNs for
# the work. Recorded 2026-09-25 from
# `openlibrary.org/search.json?q=isbn:9780262345064&limit=5&fields=*`.
RECORDED_ISBNS = [
    "8934995483",
    "0262345056",
    "8425434173",
    "0262345072",
    "9788934995487",
    "3882214953",
    "9780262345057",
    "9788425434174",
    "9780262345071",
    "9896419396",
    "9780262534956",
    "9780262345064",
    "0262345064",
    "6053160474",
    "9786053160472",
    "9789896419394",
    "9783882214956",
    "0262534959",
]


def _flat(color: tuple, size: tuple) -> bytes:
    """A flat-coloured PNG: deterministic, tiny, and unmistakably an image."""
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def _noise(size: tuple = (200, 300), seed: int = 1) -> bytes:
    """Deterministic noise — incompressible, so it clears the >1 KB download floor.

    Used wherever a case exercises `_resolve_cover`, which is the one path that
    applies `cover.py`'s floor to a real download.
    """
    rng = random.Random(seed)
    raw = bytes(rng.randrange(256) for _ in range(size[0] * size[1] * 3))
    buf = io.BytesIO()
    Image.frombytes("RGB", size, raw).save(buf, "PNG")
    return buf.getvalue()


TALL_BYTES = _flat((180, 20, 200), (1352, 2103))
WIDE_BYTES = _flat((200, 180, 20), (800, 1245))
FETCHED_BYTES = _noise()


class _Response:
    """The little of `requests.Response` these modules touch."""

    def __init__(self, content: bytes = b"", status: int = 200, json_body=None):
        self.content = content
        self.status_code = status
        self._json = json_body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._json


def _explode(*_args, **_kwargs):
    """A fetcher that raises, which is how a broken one behaves from here."""
    raise RuntimeError("the metadata engine's network is unreachable")


def _hit(url: str, data: bytes) -> dict:
    """One searched hit, in the shape `search_by_isbn` returns."""
    return {"source": "google_books", "url": url, "data": data}


# --- the pipeline's own half: which ISBNs get asked, and in what order -----


def _isbn_answers(monkeypatch, answers: dict, asked: list) -> None:
    """`search_by_isbn` from a record; every ISBN asked is appended to `asked`.

    An ISBN with no answer in the record is a miss — which is the state the
    design's own book is in for *both* of its stored identifiers.
    """

    def fake(isbn: str) -> list:
        asked.append(isbn)
        return answers.get(isbn, [])

    monkeypatch.setattr(hydration, "search_by_isbn", fake)


def _work_isbns(monkeypatch, isbns: list, asked: Optional[list] = None) -> None:
    """`known_isbns` from a record, recording the ISBN-13 it was asked about."""

    def fake(title=None, author=None, isbn_13=None) -> list:
        if asked is not None:
            asked.append(isbn_13)
        return list(isbns)

    monkeypatch.setattr(hydration, "known_isbns", fake)


def _title_pass(monkeypatch, calls: list) -> None:
    """Record the title pass instead of running it, answering nothing."""

    def fake(title, author=None) -> list:
        calls.append((title, author))
        return []

    monkeypatch.setattr(hydration, "search_by_title", fake)


def _search(tmp_path, **known) -> list:
    """One search, against whatever the three functions were monkeypatched to."""
    merged = dict(KNOWN)
    merged.update(known)
    return hydration.search_candidates(
        file_path="/Volumes/books/books/book.epub",
        book_dir=str(tmp_path),
        known=merged,
    )


def _tall(monkeypatch, **known):
    """The common setup: the row's ISBNs miss, the work's list carries the jacket.

    Returns `(asked, title_calls)` so a case can assert the sequence *and* that
    the fuzzy pass did or did not run.
    """
    asked: list = []
    title_calls: list = []
    _isbn_answers(monkeypatch, {"9780262345071": [_hit(JACKET_TALL, TALL_BYTES)]}, asked)
    _work_isbns(monkeypatch, ["9780262345071", "9780262534956"])
    _title_pass(monkeypatch, title_calls)
    return asked, title_calls


def test_the_search_reaches_the_identifiers_google_does_not_index(monkeypatch, tmp_path):
    """AC1 — and the case is about the *sequence*, not the hit.

    The row's own ISBN-13 and ISBN-10 are both answered by Google with
    `totalItems: 0`; the jacket hangs off an ISBN only the work's list knows. So
    this asserts every ISBN asked, in order, because "it found a jacket" is also
    true of a search that guessed — and it asserts the fuzzy pass never ran,
    because a title question must not be substituted for an identifier that
    answered.
    """
    asked, title_calls = _tall(monkeypatch)

    found = _search(tmp_path)

    assert asked == ["9780262345064", "0262345056", "9780262345071", "9780262534956"]
    assert [c["url"] for c in found] == [JACKET_TALL]
    assert title_calls == [], "an identifier answered, so the fuzzy pass is not reached"


def test_the_identifier_passes_run_to_the_end_of_the_list(monkeypatch, tmp_path):
    """D2's reason for not stopping at the first hit: two ISBNs, two jackets.

    Measured for this book: `9780262345071` answers the 1352x2103 English jacket
    and `9780262534956` answers the 800x1245 one — the same design, and the better
    of the two is not the one that answers first. A search that returned on its
    first hit would offer one jacket where two exist.
    """
    asked: list = []
    _isbn_answers(
        monkeypatch,
        {
            "9780262534956": [_hit(JACKET_TALL, TALL_BYTES)],
            "9780262345071": [_hit(JACKET_WIDE, WIDE_BYTES)],
        },
        asked,
    )
    _work_isbns(monkeypatch, ["9780262345071", "9780262534956"])
    _title_pass(monkeypatch, [])

    found = _search(tmp_path)

    assert sorted(c["url"] for c in found) == sorted([JACKET_TALL, JACKET_WIDE])
    assert found[0]["url"] == JACKET_TALL, "ranked by the shared formula, best first"
    # The ranking is `score_candidates`', so the order is the same one a fetch
    # would have produced over the same images
    assert [c["score"] for c in found] == sorted(
        (c["score"] for c in found), reverse=True
    )


def test_a_jacket_two_isbns_answer_with_is_offered_once(monkeypatch, tmp_path):
    """The dedupe, and why it is keyed on bytes rather than on the url.

    Two ISBNs of one work can reach the *same* volume, and Google serves one
    image from several query-string spellings — so a search that concatenated its
    passes would offer that jacket twice, and by url it would not even notice.
    """
    asked: list = []
    _isbn_answers(
        monkeypatch,
        {
            "9780262345071": [_hit(JACKET_TALL, TALL_BYTES)],
            # ...the same bytes, arriving from a sibling ISBN under another url
            "9780262534956": [
                _hit(JACKET_TALL.replace("9eRVDwAAQBAJ", "ZZZZZZZZZZZ"), TALL_BYTES)
            ],
        },
        asked,
    )
    _work_isbns(monkeypatch, ["9780262345071", "9780262534956"])
    _title_pass(monkeypatch, [])

    found = _search(tmp_path)

    assert [c["url"] for c in found] == [JACKET_TALL], "one image, one tile"


def test_the_sequence_is_bounded_and_deduped_across_both_lists(monkeypatch, tmp_path):
    """D5's request budget, on the sequence rather than on either list.

    Each ISBN asked is a Google request, so the row's two identifiers and the
    work's list are deduped *together* and capped as one sequence: an ISBN the
    row already supplied does not spend a second request, and the run stops after
    `MAX_SEARCH_ISBNS` entries however long the work's list is.
    """
    asked: list = []
    _isbn_answers(monkeypatch, {}, asked)
    _work_isbns(
        monkeypatch,
        # The row's own ISBN-13 is in the work's list too, and a long tail
        # follows it — neither may lengthen the sequence past the cap.
        ["9780262345064", *[f"97800000000{n:02d}" for n in range(9)]],
    )
    _title_pass(monkeypatch, [])

    _search(tmp_path)

    assert asked == [
        "9780262345064",
        "0262345056",
        "9780000000000",
        "9780000000001",
        "9780000000002",
        "9780000000003",
        "9780000000004",
        "9780000000005",
    ]
    assert len(asked) == hydration.MAX_SEARCH_ISBNS


def test_the_bound_leaves_room_for_the_rows_own_identifiers(monkeypatch, tmp_path):
    """AC2a — the bound is *derived*, and this is the bug it prevents.

    A flat cap on the sequence is not a smaller budget, it is a different
    question: measured on the book that produced this feature, a sequence capped
    at six truncated the work's list to four entries, so `9780262534956` — the
    second English jacket, at the work's index 5 — was never asked about, and the
    press offered one jacket where the library could reach two. The row's own
    identifiers are the most precise ones the book has, so they are asked first
    and the work's list is capped on top of them rather than inside their budget.
    """
    assert hydration.MAX_SEARCH_ISBNS == 2 + openlibrary.KNOWN_ISBN_CAP

    asked: list = []
    _isbn_answers(monkeypatch, {}, asked)
    _work_isbns(monkeypatch, [f"97800000000{n:02d}" for n in range(20)])
    _title_pass(monkeypatch, [])

    _search(tmp_path)

    assert asked[:2] == ["9780262345064", "0262345056"]
    assert len(asked) == hydration.MAX_SEARCH_ISBNS
    assert set(asked[2:]) == {
        f"97800000000{n:02d}" for n in range(openlibrary.KNOWN_ISBN_CAP)
    }


def test_a_search_that_finds_nothing_answers_with_nothing(monkeypatch, tmp_path):
    """AC3: every pass runs, nothing answers, the answer is `[]`.

    Not an error and not a sentence: the *picker* is where "nothing was found" is
    said, and a sidecar that threw here would make an empty result
    indistinguishable from a broken one.
    """
    asked: list = []
    _isbn_answers(monkeypatch, {}, asked)
    _work_isbns(monkeypatch, [])
    _title_pass(monkeypatch, [])

    assert _search(tmp_path) == []
    assert asked == ["9780262345064", "0262345056"]


def test_a_failing_fetcher_is_a_miss_not_a_failed_search(monkeypatch, tmp_path):
    """Invariant 12 in a new place: every fetcher raising still answers `[]`.

    An unreachable OpenLibrary, a 500 from Google, a parse bug — a search is a
    question asked from a dialog, so its failure is fewer tiles, never an
    exception crossing the RPC boundary and taking the press with it.
    """
    monkeypatch.setattr(hydration, "search_by_isbn", _explode)
    monkeypatch.setattr(hydration, "known_isbns", _explode)
    monkeypatch.setattr(hydration, "search_by_title", _explode)

    assert _search(tmp_path) == []


def test_a_row_with_no_identifiers_falls_straight_to_the_title_pass(monkeypatch, tmp_path):
    """A book whose file is silent about its own identity is the common case.

    `known` carries no ISBN at all, so the identifier passes have nothing to ask
    about and the title pass is the *only* question left — and it must be asked
    with the row's title and author, since there is no identifier to match on.
    """
    asked: list = []
    _isbn_answers(monkeypatch, {}, asked)
    work_asked: list = []
    _work_isbns(monkeypatch, [], work_asked)
    title_calls: list = []
    _title_pass(monkeypatch, title_calls)

    found = _search(tmp_path, identifiers={})

    assert asked == []
    assert found == []
    assert work_asked == [None], "no ISBN-13 to ask the work about"
    assert title_calls == [("Topology of Violence", "Byung-Chul Han")]


# --- D3: what a searched entry may claim ----------------------------------


def test_a_hit_with_no_url_is_not_offered(monkeypatch, tmp_path):
    """D3 — the searched list may only carry entries `set_cover` would accept.

    Every searched hit is online, so one that arrives without a url is not a
    jacket a pick could name: `services/cover-choice.ts` refuses an online source
    whose choice carries no url (its own D6 refusal, shipped with slice 1b), which
    would turn the entry into a tile that cannot be chosen. It is dropped here
    instead. The two fetchers always set a url — which is exactly why this half
    of the contract needs a decider of its own, and why the mutation campaign
    found this guard had none.
    """
    asked: list = []
    _isbn_answers(
        monkeypatch,
        {"9780262345071": [{"source": "google_books", "data": TALL_BYTES}]},
        asked,
    )
    _work_isbns(monkeypatch, ["9780262345071"])
    _title_pass(monkeypatch, [])

    assert _search(tmp_path) == []


def test_no_searched_entry_claims_the_fetchs_mark(monkeypatch, tmp_path):
    """D3, over the payload rather than over a field.

    `winner` means "what a fetch would write", and a fetch would never ask this
    question — so every entry is `false`, without exception and without a
    parameter having been added to `summarise_candidates` for it. Every entry also
    keeps the `url` a pick needs, and a thumb the renderer's CSP can actually
    show, because a tile nobody can see is a tile nobody can choose.
    """
    _tall(monkeypatch)

    found = _search(tmp_path)

    assert len(found) == 1
    for entry in found:
        assert entry["winner"] is False
        assert entry["url"] == JACKET_TALL
        assert entry["thumb"].startswith("data:image/jpeg;base64,")
        assert (entry["width"], entry["height"]) == (1352, 2103)
        assert set(entry) >= {"source", "url", "width", "height", "score", "winner",
                             "applied", "thumb"}


def test_a_searched_jacket_that_is_already_on_disk_reads_as_applied(monkeypatch, tmp_path):
    """D3's other half: `applied` is byte identity, not provenance.

    The book is wearing an English jacket that a *fetch* could not have found —
    exactly the state this feature is for — so the searched tile that matches it
    must say so. A searched group where nothing is ever `applied` would leave the
    person unable to tell which tile is the one on the book.
    """
    book_dir = str(tmp_path)
    with open(os.path.join(book_dir, "cover_full.jpg"), "wb") as fh:
        fh.write(cover._renditions(TALL_BYTES)[0])

    asked: list = []
    _isbn_answers(
        monkeypatch,
        {"9780262345071": [_hit(JACKET_TALL, TALL_BYTES), _hit(JACKET_WIDE, WIDE_BYTES)]},
        asked,
    )
    _work_isbns(monkeypatch, ["9780262345071"])
    _title_pass(monkeypatch, [])

    found = _search(tmp_path)

    assert {c["url"]: c["applied"] for c in found} == {JACKET_TALL: True, JACKET_WIDE: False}


# --- the fetchers' own half: the queries, and the tile guard --------------
#
# The cases above decide *which* questions are asked and in what order. These
# decide that the questions themselves are the measured ones, and that Google's
# placeholder tile cannot enter through the search door after being kept out of
# the fetch's.

ADVERTISED = (
    "http://books.google.com/books/content?id=9eRVDwAAQBAJ&printsec=frontcover"
    "&img=1&zoom=1&edge=curl&source=gbs_api"
)
BIGGEST = ADVERTISED.replace("zoom=1", "zoom=0").replace("http://", "https://")


def _google(monkeypatch, items: list, images: dict, queries: Optional[list] = None) -> None:
    """`requests.get` for Google's API and for the image URLs in `images`.

    Anything else 404s, which is the honest shape of "this rendition does not
    exist" — and it means no case here can quietly reach the network.
    """

    def fake_get(url, params=None, **_kwargs):
        if url == google_books.API_URL:
            if queries is not None:
                queries.append(params)
            return _Response(json_body={"totalItems": len(items), "items": items})
        if url in images:
            return _Response(images[url])
        return _Response(status=404)

    monkeypatch.setattr(google_books.requests, "get", fake_get)


def _volume(links: Optional[dict] = None, title: str = "Topology of Violence") -> dict:
    return {"volumeInfo": {"title": title, "authors": ["Byung-Chul Han"],
                           "imageLinks": links if links is not None else {"thumbnail": ADVERTISED}}}


def test_the_isbn_search_asks_by_isbn_and_returns_every_answer(monkeypatch):
    """The query form, and the plural answer `fetch_google_books` does not give.

    A volume Google holds no artwork for is not a candidate — there is nothing to
    show — but it must not stop the volumes that do carry artwork: that is the
    difference between a list-returning search and a single best match.
    """
    queries: list = []
    _google(
        monkeypatch,
        [_volume(), _volume({"title": "no artwork"}, title="No artwork")],
        {BIGGEST: FETCHED_BYTES},
        queries,
    )
    monkeypatch.delenv("GOOGLE_BOOKS_API_KEY", raising=False)

    found = google_books.search_by_isbn("9780262345071")

    assert found == [{"source": "google_books", "url": BIGGEST, "data": FETCHED_BYTES}]
    assert queries == [
        {"q": "isbn:9780262345071", "maxResults": 5, "printType": "books"}
    ]


def test_the_title_search_is_structured_and_never_free_text(monkeypatch):
    """AC2's query form, asserted on the recorded query string.

    `intitle:"…" inauthor:"…"`, never `"<title>" <author>`: measured 2026-09-25,
    the structured form of this title answers exactly **1** volume and the
    free-text form answer **300**, most of them other titles by the same author.
    The equality below is the whole assertion — a query that merely contained both
    operators could still be free text beside them.
    """
    queries: list = []
    _google(monkeypatch, [_volume()], {BIGGEST: FETCHED_BYTES}, queries)
    monkeypatch.delenv("GOOGLE_BOOKS_API_KEY", raising=False)

    google_books.search_by_title("Topology of Violence", "Byung-Chul Han")

    assert queries == [
        {
            "q": 'intitle:"Topology of Violence" inauthor:"Byung-Chul Han"',
            "maxResults": 5,
            "printType": "books",
        }
    ]


def test_the_title_search_without_an_author_asks_only_for_the_title(monkeypatch):
    """An absent author is an absent clause, not an empty quoted one."""
    queries: list = []
    _google(monkeypatch, [], {}, queries)

    assert google_books.search_by_title("Topology of Violence") == []
    assert queries[0]["q"] == 'intitle:"Topology of Violence"'


def test_the_api_key_travels_when_it_is_configured(monkeypatch):
    """The search reuses the fetch's key handling rather than inventing its own."""
    monkeypatch.setenv("GOOGLE_BOOKS_API_KEY", "a-key")
    queries: list = []
    _google(monkeypatch, [], {}, queries)

    google_books.search_by_isbn("9780262345071")

    assert queries[0]["key"] == "a-key"


def test_the_placeholder_tile_never_becomes_a_searched_candidate(monkeypatch):
    """The guard travels with the question.

    Google answers `zoom=0` with one shared 575x750 "image not available" tile
    (`PLACEHOLDER_MD5`) for every volume it holds no artwork for. It is bigger
    than anything the API advertises and scores 0.783 against the pipeline's
    formula — high enough to beat most real jackets — so a search that skipped
    `_resolve_cover` would hand a person that tile as a choice. The volume whose
    every rendition is the tile answers *no* candidate, while a sibling in the
    same answer still yields its real one.
    """
    tile = _noise((575, 750), seed=7)
    real = _noise((200, 300), seed=8)
    monkeypatch.setattr(google_books, "PLACEHOLDER_MD5", hashlib.md5(tile).hexdigest())

    tiled = ADVERTISED.replace("?id=9eRVDwAAQBAJ", "?id=TTTTTTTTTTT")
    real_link = ADVERTISED.replace("?id=9eRVDwAAQBAJ", "?id=RRRRRRRRRRR")
    _google(
        monkeypatch,
        [
            _volume({"thumbnail": tiled}, title="Only the placeholder"),
            _volume({"thumbnail": real_link}, title="A real jacket"),
        ],
        {
            BIGGEST: tile,
            tiled.replace("zoom=1", "zoom=0").replace("http://", "https://"): tile,
            real_link.replace("zoom=1", "zoom=0").replace("http://", "https://"): real,
        },
    )

    found = google_books.search_by_isbn("9780262345071")

    assert found == [
        {
            "source": "google_books",
            "url": real_link.replace("zoom=1", "zoom=0").replace("http://", "https://"),
            "data": real,
        }
    ]


def test_a_search_that_cannot_reach_google_answers_with_nothing(monkeypatch):
    """Both halves of the fetcher's promise, since both call the same helper: a
    connection that raises and a response that 500s are each an empty list."""
    monkeypatch.setattr(google_books.requests, "get", _explode)

    assert google_books.search_by_isbn("9780262345071") == []
    assert google_books.search_by_title("Topology of Violence", "Byung-Chul Han") == []

    monkeypatch.setattr(
        google_books.requests, "get", lambda *a, **k: _Response(status=500)
    )

    assert google_books.search_by_isbn("9780262345071") == []
    assert google_books.search_by_title("Topology of Violence", "Byung-Chul Han") == []


def test_a_search_with_nothing_to_ask_about_asks_nothing(monkeypatch):
    """No ISBN and no title is not a query — and must not become a request."""
    queries: list = []
    _google(monkeypatch, [_volume()], {BIGGEST: FETCHED_BYTES}, queries)

    assert google_books.search_by_isbn("") == []
    assert google_books.search_by_title("") == []
    assert queries == []


# --- `known_isbns`: the work's identifier list, search-only (D5) ----------


def _openlibrary(monkeypatch, listed: Optional[list], seen: list) -> None:
    """OpenLibrary's search endpoint, answered from a record.

    `listed` of `None` answers with no docs at all, which is the shape of "the
    work is not there" rather than "the request failed".
    """

    def fake_get(url, params=None, **_kwargs):
        seen.append(params)
        docs = [] if listed is None else [{"isbn": listed}]
        return _Response(json_body={"docs": docs})

    monkeypatch.setattr(openlibrary.requests, "get", fake_get)


def test_known_isbns_is_the_works_list_thirteen_digit_first_deduped_and_capped(monkeypatch):
    """AC4, against the payload OpenLibrary actually answers for this book.

    Recorded 2026-09-25: one doc, **18** ISBNs, of which `fetch_openlibrary` keeps
    exactly one and discards the other 17. The cap of six is a request budget, not
    a preference — each entry is a Google request — and the 13-digit forms come
    first because that is the form Google indexes: the payload's own order starts
    with a 10-digit form, so the ordering is what the list below proves.
    """
    seen: list = []
    _openlibrary(monkeypatch, RECORDED_ISBNS, seen)

    listed = openlibrary.known_isbns(
        title="Topology of Violence", author="Byung-Chul Han", isbn_13="9780262345064"
    )

    assert len(RECORDED_ISBNS) == 18
    assert RECORDED_ISBNS[0] == "8934995483", "the payload's own order leads with a 10"
    assert listed == [
        "9788934995487",
        "9780262345057",
        "9788425434174",
        "9780262345071",
        "9780262534956",
        "9780262345064",
    ]
    assert len(listed) == openlibrary.KNOWN_ISBN_CAP == 6
    assert all(len(i) == 13 for i in listed), "13-digit forms first, whatever order the payload used"
    # Asked by the identifier the row is stored under, and with the same query
    # shape `fetch_openlibrary` uses, because it is the same endpoint
    assert seen == [{"limit": 5, "fields": "*", "q": "isbn:9780262345064"}]


def test_known_isbns_dedupes_a_payload_that_repeats_an_identifier(monkeypatch):
    """The recorded payload happens to repeat nothing, so the dedupe is proved on
    one that does: a work listing the same edition twice must not spend two of its
    six requests on one ISBN."""
    seen: list = []
    _openlibrary(monkeypatch, ["9780262345071", "0262345072", "9780262345071"], seen)

    assert openlibrary.known_isbns(isbn_13="9780262345064") == [
        "9780262345071",
        "0262345072",
    ]


def test_known_isbns_asks_by_title_and_author_when_there_is_no_isbn(monkeypatch):
    """D5's fallback: a file silent about its own ISBN is still searched for."""
    seen: list = []
    _openlibrary(monkeypatch, RECORDED_ISBNS, seen)

    assert openlibrary.known_isbns(title="Topology of Violence", author="Byung-Chul Han")
    assert seen == [
        {
            "limit": 5,
            "fields": "*",
            "title": "Topology of Violence",
            "author": "Byung-Chul Han",
        }
    ]


def test_known_isbns_is_empty_when_there_is_nothing_to_ask_or_nothing_to_read(monkeypatch):
    """Three ways to answer nothing, none of them an exception.

    No question at all (no arguments — no request is made), no docs for the
    question, and a request that raises: the search degrades to the row's own
    identifiers plus the title pass, which is the fallback it already has (D5).
    """
    seen: list = []
    _openlibrary(monkeypatch, RECORDED_ISBNS, seen)

    assert openlibrary.known_isbns() == []
    assert seen == [], "nothing to ask about is not a request"

    _openlibrary(monkeypatch, None, seen)
    assert openlibrary.known_isbns(isbn_13="9780262345064") == []

    monkeypatch.setattr(openlibrary.requests, "get", _explode)
    assert openlibrary.known_isbns(isbn_13="9780262345064") == []


# --- the query string, end to end through the pipeline --------------------


def test_the_title_pass_is_reached_through_the_pipeline_with_a_structured_query(
    monkeypatch, tmp_path
):
    """AC2 end to end: every ISBN misses, so the real fetcher asks the real query.

    The ISBN passes here run the *shipping* `search_by_isbn` against a stubbed
    `requests.get`, which is what makes the recorded query string the one the app
    actually sends rather than a mock's idea of it. Google answers `totalItems: 0`
    to every `isbn:` question — the measured state of this book — and one volume
    to the structured title question.
    """
    queries: list = []
    images = {BIGGEST: FETCHED_BYTES}

    def fake_get(url, params=None, **_kwargs):
        if url == google_books.API_URL:
            query = (params or {}).get("q", "")
            queries.append(query)
            if query.startswith("isbn:"):
                return _Response(json_body={"totalItems": 0, "items": []})
            return _Response(json_body={"totalItems": 1, "items": [_volume()]})
        if url in images:
            return _Response(images[url])
        return _Response(status=404)

    monkeypatch.setattr(google_books.requests, "get", fake_get)
    _work_isbns(monkeypatch, ["9780262345071"])

    found = _search(tmp_path)

    assert queries == [
        "isbn:9780262345064",
        "isbn:0262345056",
        "isbn:9780262345071",
        'intitle:"Topology of Violence" inauthor:"Byung-Chul Han"',
    ]
    assert [c["url"] for c in found] == [BIGGEST]
    assert all(c["winner"] is False for c in found)
