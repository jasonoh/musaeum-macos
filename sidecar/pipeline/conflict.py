"""Metadata merging + conflict detection.

Sources agree → auto-resolve. Sources disagree on high-stakes fields
(title, author, series) → pick the best candidate for the merged record AND
queue a conflict for review. Low-stakes fields (publisher, dates, description)
auto-resolve by source priority to keep the review queue quiet.

User resolution history (source_preferences) biases candidate scoring: a
source the user has repeatedly chosen for a field wins ties.
"""

import json
import re

SOURCE_PRIORITY = {
    "google_books": 4,
    "openlibrary": 3,
    "goodreads": 3,
    "calibre": 2,
    "embedded": 1,
}

# Fields where disagreement queues a review conflict
REVIEWED_FIELDS = ("title", "author", "series")


def _norm(value: str) -> str:
    return re.sub(r"[^\w\s]", "", (value or "").lower()).strip()


def _score(source: str, field: str, preferences: dict) -> float:
    base = SOURCE_PRIORITY.get(source, 0)
    learned = preferences.get(field, {}).get(source, 0)
    return base + min(learned, 5) * 0.5


def merge_metadata(sources: dict, preferences: dict) -> tuple:
    """sources: {source_name: normalized metadata dict}.

    Returns (merged: dict, conflicts: list of {field, candidates}).
    """
    merged = {}
    conflicts = []

    def candidates_for(field, value_fn):
        out = []
        for name, data in sources.items():
            if not data:
                continue
            value = value_fn(data)
            if value:
                out.append((name, value))
        return out

    # --- title / author: reviewed fields ---
    for field, value_fn in (
        ("title", lambda d: d.get("title")),
        ("author", lambda d: (d.get("authors") or [{}])[0].get("name")),
    ):
        cands = candidates_for(field, value_fn)
        if not cands:
            continue
        distinct = {}
        for name, value in cands:
            distinct.setdefault(_norm(value), []).append((name, value))
        best_source, best_value = max(cands, key=lambda c: _score(c[0], field, preferences))
        merged[field] = best_value
        if len(distinct) > 1:
            conflicts.append(
                {
                    "field": field,
                    "candidates": [{"source": n, "value": v} for n, v in cands],
                }
            )

    # Preserve author sort when the winning source supplies one
    for name, data in sorted(
        sources.items(), key=lambda kv: -_score(kv[0], "author", preferences)
    ):
        if data and data.get("authors"):
            merged["authors"] = data["authors"]
            break

    # --- series: goodreads is authoritative; conflict when others disagree ---
    series_cands = candidates_for("series", lambda d: d.get("series"))
    if series_cands:
        best = max(series_cands, key=lambda c: _score(c[0], "series", preferences))
        merged["series"] = best[1]
        names = {_norm(s.get("name", "")) for _, s in series_cands}
        if len(names) > 1:
            conflicts.append(
                {
                    "field": "series",
                    "candidates": [
                        {"source": n, "value": json.dumps(s)} for n, s in series_cands
                    ],
                }
            )

    # --- quiet fields: highest-priority source wins, no review ---
    for field in ("publisher", "published_date", "language"):
        cands = candidates_for(field, lambda d, f=field: d.get(f))
        if cands:
            merged[field] = max(cands, key=lambda c: _score(c[0], field, preferences))[1]

    # Description: longest wins — length is the best cheap proxy for quality
    desc_cands = candidates_for("description", lambda d: d.get("description"))
    if desc_cands:
        merged["description"] = max(desc_cands, key=lambda c: len(c[1]))[1]

    # Identifiers and tags: union across sources (higher priority overrides)
    identifiers = {}
    tags = []
    for name, data in sorted(sources.items(), key=lambda kv: _score(kv[0], "identifiers", preferences)):
        if not data:
            continue
        identifiers.update({k: v for k, v in (data.get("identifiers") or {}).items() if v})
        for t in data.get("tags") or []:
            if t not in tags:
                tags.append(t)
    if identifiers:
        merged["identifiers"] = identifiers
    if tags:
        merged["tags"] = tags[:12]

    # Provenance for metadata.json
    fetched = {}
    for name, data in sources.items():
        if data and data.get("fetched_at"):
            fetched[name] = {
                "fetched_at": data["fetched_at"],
                "match_confidence": data.get("match_confidence", 1.0),
            }
    if fetched:
        merged["metadata_sources"] = fetched

    return merged, conflicts
