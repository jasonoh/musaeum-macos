"""Two load-bearing hydration branches that had only negative or indirect tests.

- Identifiers the book already carries (from its file, or seeded from Calibre as
  `known`) are definitive: an online fetch may have matched a different edition
  of the same work (docs/invariants/metadata-hydration.md).
- Two cover candidates too close to call queue a `cover` conflict for review
  rather than silently picking one.
"""

import os

import pipeline.hydration as hydration


def _fetchers(monkeypatch, google=None, openlib=None) -> None:
    monkeypatch.setattr(hydration, "fetch_google_books", lambda *a, **k: google)
    monkeypatch.setattr(hydration, "fetch_openlibrary", lambda *a, **k: openlib)
    monkeypatch.setattr(hydration, "fetch_series", lambda *a, **k: None)


def _hydrate(tmp_path, known):
    book_dir = str(tmp_path / "out")
    os.makedirs(book_dir, exist_ok=True)
    return hydration.hydrate_metadata(
        book_id="b",
        file_path=str(tmp_path / "absent.epub"),
        book_dir=book_dir,
        known=known,
        source_preferences={},
    )


def test_a_known_isbn_beats_a_different_fetched_one(tmp_path, monkeypatch):
    _fetchers(
        monkeypatch,
        google={"title": "Same Work", "identifiers": {"isbn_13": "9780000000002"}},
    )
    monkeypatch.setattr(
        hydration, "select_cover", lambda *a, **k: {"cover": None, "review": False, "candidates": []}
    )

    result = _hydrate(tmp_path, {"identifiers": {"isbn_13": "9780000000001"}})

    assert result["metadata"]["identifiers"]["isbn_13"] == "9780000000001"


def test_close_cover_candidates_queue_a_review_conflict(tmp_path, monkeypatch):
    _fetchers(monkeypatch, google={"title": "T"}, openlib={"title": "T"})
    candidates = [
        {"source": "google_books", "url": "https://g.example/c.jpg"},
        {"source": "openlibrary", "url": "https://ol.example/c.jpg"},
    ]
    monkeypatch.setattr(hydration, "gather_candidates", lambda *a, **k: candidates)
    monkeypatch.setattr(
        hydration,
        "select_cover",
        lambda *a, **k: {"cover": None, "review": True, "candidates": candidates},
    )

    result = _hydrate(tmp_path, {})

    cover = [c for c in result["conflicts"] if c["field"] == "cover"]
    assert cover == [
        {
            "field": "cover",
            "candidates": [
                {"source": "google_books", "value": "https://g.example/c.jpg"},
                {"source": "openlibrary", "value": "https://ol.example/c.jpg"},
            ],
        }
    ]
