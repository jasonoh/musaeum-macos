"""The merge policy: which source's value survives, and which disagreements
are worth waking the user up for.

Encodes the policy stated in `docs/invariants/metadata-hydration.md`:

  - `title`, `author`, `series` — best candidate applied immediately AND a
    review conflict queued when sources disagree (the book is never left blank)
  - `publisher`, `published_date`, `language` — auto-resolved by source
    priority, never queued
  - `description` — longest candidate wins, never queued
  - source priority google_books > openlibrary/goodreads > calibre > embedded,
    biased by the user's past resolutions

The queue's whole value is that it stays short, so "this disagreement does
*not* queue" is as load-bearing an assertion here as "this one does", and both
directions get their own case.
"""

import json

from pipeline.conflict import merge_metadata


def _fields(conflicts: list) -> set:
    return {c["field"] for c in conflicts}


def _book(title=None, author=None, **rest) -> dict:
    """A source record in the shape the fetchers hand to merge_metadata."""
    data = dict(rest)
    if title is not None:
        data["title"] = title
    if author is not None:
        data["authors"] = [{"name": author, "sort": None}]
    return data


# --- source priority -------------------------------------------------------


def test_higher_priority_source_wins_the_title():
    merged, _ = merge_metadata(
        {
            "embedded": _book(title="the hobbit or there and back again"),
            "google_books": _book(title="The Hobbit"),
        },
        {},
    )

    assert merged["title"] == "The Hobbit"


def test_priority_order_runs_google_over_openlibrary_over_calibre_over_embedded():
    sources = {
        "embedded": _book(title="D"),
        "calibre": _book(title="C"),
        "openlibrary": _book(title="B"),
        "google_books": _book(title="A"),
    }

    assert merge_metadata(sources, {})[0]["title"] == "A"

    del sources["google_books"]
    assert merge_metadata(sources, {})[0]["title"] == "B"

    del sources["openlibrary"]
    assert merge_metadata(sources, {})[0]["title"] == "C"

    del sources["calibre"]
    assert merge_metadata(sources, {})[0]["title"] == "D"


def test_empty_source_records_are_not_candidates():
    # A fetcher that found nothing returns a falsy record rather than being
    # omitted; it must not win a field by being present.
    merged, conflicts = merge_metadata(
        {"google_books": {}, "embedded": _book(title="Piranesi")},
        {},
    )

    assert merged["title"] == "Piranesi"
    assert conflicts == []


def test_a_field_no_source_supplies_is_absent_from_the_merge():
    merged, _ = merge_metadata({"embedded": _book(title="Piranesi")}, {})

    assert "publisher" not in merged
    assert "series" not in merged


# --- reviewed fields: apply the best value *and* queue ---------------------


def test_disagreeing_titles_queue_a_conflict_carrying_every_candidate():
    merged, conflicts = merge_metadata(
        {
            "embedded": _book(title="Hobbit"),
            "google_books": _book(title="The Hobbit"),
        },
        {},
    )

    assert _fields(conflicts) == {"title"}
    (conflict,) = conflicts
    assert {(c["source"], c["value"]) for c in conflict["candidates"]} == {
        ("embedded", "Hobbit"),
        ("google_books", "The Hobbit"),
    }
    # Queued for review, but the book is never left blank in the meantime
    assert merged["title"] == "The Hobbit"


def test_disagreeing_authors_queue_a_conflict():
    merged, conflicts = merge_metadata(
        {
            "embedded": _book(title="Dune", author="Frank Herbert"),
            "google_books": _book(title="Dune", author="Frank P. Herbert"),
        },
        {},
    )

    assert _fields(conflicts) == {"author"}
    assert merged["author"] == "Frank P. Herbert"


def test_agreement_does_not_queue_anything():
    _, conflicts = merge_metadata(
        {
            "embedded": _book(title="Dune", author="Frank Herbert"),
            "google_books": _book(title="Dune", author="Frank Herbert"),
        },
        {},
    )

    assert conflicts == []


def test_punctuation_and_case_alone_are_not_a_disagreement():
    # Comparison is on a normalized form; queueing "Dune" against "DUNE!"
    # would fill the review queue with nothing.
    merged, conflicts = merge_metadata(
        {
            "embedded": _book(title="DUNE!", author="frank herbert"),
            "google_books": _book(title="Dune", author="Frank Herbert"),
        },
        {},
    )

    assert conflicts == []
    # The chosen value still keeps the winning source's own formatting
    assert merged["title"] == "Dune"


def test_a_single_source_never_conflicts_with_itself():
    merged, conflicts = merge_metadata(
        {"embedded": _book(title="Piranesi", author="Susanna Clarke")}, {}
    )

    assert conflicts == []
    assert merged["title"] == "Piranesi"
    assert merged["author"] == "Susanna Clarke"


def test_author_sort_comes_from_the_winning_source():
    merged, _ = merge_metadata(
        {
            "embedded": {"authors": [{"name": "Frank Herbert", "sort": "wrong, sort"}]},
            "google_books": {
                "authors": [{"name": "Frank Herbert", "sort": "Herbert, Frank"}]
            },
        },
        {},
    )

    assert merged["authors"] == [{"name": "Frank Herbert", "sort": "Herbert, Frank"}]


# --- quiet fields: resolve silently ---------------------------------------


def test_publisher_date_and_language_resolve_by_priority_without_queueing():
    merged, conflicts = merge_metadata(
        {
            "embedded": {
                "publisher": "Unknown",
                "published_date": "1965-01-01",
                "language": "und",
            },
            "google_books": {
                "publisher": "Ace Books",
                "published_date": "1990-09-01",
                "language": "en",
            },
        },
        {},
    )

    assert merged["publisher"] == "Ace Books"
    assert merged["published_date"] == "1990-09-01"
    assert merged["language"] == "en"
    assert conflicts == []


def test_longest_description_wins_regardless_of_source_priority():
    # Length is the cheap proxy for quality: a one-line Google blurb loses to
    # a full embedded jacket copy.
    merged, conflicts = merge_metadata(
        {
            "google_books": {"description": "A novel."},
            "embedded": {"description": "A novel about a desert planet and spice."},
        },
        {},
    )

    assert merged["description"] == "A novel about a desert planet and spice."
    assert conflicts == []


# --- series ----------------------------------------------------------------


def test_series_from_goodreads_beats_a_lower_priority_source():
    expanse = {"series_name": "The Expanse", "name": "The Expanse", "series_index": 1.0}
    wrong = {"series_name": "Expanse Novels", "name": "Expanse Novels", "series_index": 1.0}

    merged, _ = merge_metadata(
        {"goodreads": {"series": expanse}, "embedded": {"series": wrong}}, {}
    )

    assert merged["series"] == expanse


def test_disagreeing_series_names_queue_a_conflict_with_serialized_candidates():
    expanse = {"name": "The Expanse", "series_index": 1.0}
    wrong = {"name": "Expanse Novels", "series_index": 1.0}

    _, conflicts = merge_metadata(
        {"goodreads": {"series": expanse}, "embedded": {"series": wrong}}, {}
    )

    assert _fields(conflicts) == {"series"}
    (conflict,) = conflicts
    values = {c["source"]: json.loads(c["value"]) for c in conflict["candidates"]}
    assert values == {"goodreads": expanse, "embedded": wrong}


def test_same_series_name_with_a_different_index_does_not_queue():
    # Only the name is compared; an index that differs between sources is not
    # worth a review prompt.
    _, conflicts = merge_metadata(
        {
            "goodreads": {"series": {"name": "The Expanse", "series_index": 1.0}},
            "embedded": {"series": {"name": "The Expanse", "series_index": 1.5}},
        },
        {},
    )

    assert conflicts == []


# --- learned preferences ---------------------------------------------------


def test_repeated_user_resolutions_let_a_lower_priority_source_win():
    sources = {
        "google_books": _book(title="The Hobbit"),
        "calibre": _book(title="Hobbit, The"),
    }

    # Untrained, the higher-priority source wins
    assert merge_metadata(sources, {})[0]["title"] == "The Hobbit"

    # After the user has picked calibre for titles often enough, it does
    trained = {"title": {"calibre": 5}}
    assert merge_metadata(sources, trained)[0]["title"] == "Hobbit, The"


def test_a_learned_preference_is_capped_and_stays_field_scoped():
    sources = {
        "google_books": _book(title="The Hobbit", publisher="Houghton Mifflin"),
        "embedded": _book(title="Hobbit, The", publisher="Allen & Unwin"),
    }

    # embedded (1) + a capped 5 x 0.5 = 3.5 still loses to google_books (4),
    # however many past resolutions are recorded
    merged, _ = merge_metadata(sources, {"title": {"embedded": 99}})
    assert merged["title"] == "The Hobbit"
    # ...and a title preference does not carry over to publisher
    assert merged["publisher"] == "Houghton Mifflin"


# --- identifiers, tags, provenance ----------------------------------------


def test_identifiers_union_across_sources_with_the_best_source_overriding():
    merged, _ = merge_metadata(
        {
            "embedded": {"identifiers": {"isbn_13": "9780000000001", "goodreads": "42"}},
            "google_books": {"identifiers": {"isbn_13": "9780547928227"}},
        },
        {},
    )

    # google_books overrides the isbn it also has; the goodreads id only the
    # lower-priority source knows about survives
    assert merged["identifiers"] == {"isbn_13": "9780547928227", "goodreads": "42"}


def test_blank_identifier_values_are_dropped():
    merged, _ = merge_metadata(
        {"google_books": {"identifiers": {"isbn_13": "9780547928227", "goodreads": None}}},
        {},
    )

    assert merged["identifiers"] == {"isbn_13": "9780547928227"}


def test_tags_union_deduplicates_and_caps_at_twelve():
    merged, _ = merge_metadata(
        {
            "embedded": {"tags": ["Fantasy", "Classics"]},
            "google_books": {"tags": ["Fantasy"] + [f"t{i}" for i in range(20)]},
        },
        {},
    )

    assert len(merged["tags"]) == 12
    assert merged["tags"].count("Fantasy") == 1


def test_provenance_records_every_source_that_reported_a_fetch_time():
    merged, _ = merge_metadata(
        {
            "google_books": {
                "title": "Dune",
                "fetched_at": "2026-09-16T00:00:00Z",
                "match_confidence": 0.8,
            },
            # No fetched_at: embedded metadata was not fetched from anywhere
            "embedded": {"title": "Dune"},
        },
        {},
    )

    assert merged["metadata_sources"] == {
        "google_books": {
            "fetched_at": "2026-09-16T00:00:00Z",
            "match_confidence": 0.8,
        }
    }


def test_match_confidence_defaults_to_full_when_a_fetcher_omits_it():
    merged, _ = merge_metadata(
        {"openlibrary": {"title": "Dune", "fetched_at": "2026-09-16T00:00:00Z"}}, {}
    )

    assert merged["metadata_sources"]["openlibrary"]["match_confidence"] == 1.0


def test_no_sources_at_all_merges_to_nothing_rather_than_raising():
    merged, conflicts = merge_metadata({}, {})

    assert merged == {}
    assert conflicts == []
