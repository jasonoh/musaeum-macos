"""Read-only extraction from Calibre's metadata.db.

Used as identifier seeds during migration — descriptions and covers from
Calibre are intentionally not treated as canonical.
"""

import os
import sqlite3


def read_calibre_db(calibre_path: str) -> dict:
    db_path = os.path.join(calibre_path, "metadata.db")
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"No metadata.db found at {calibre_path}")

    # Immutable open — never write to (or lock) the Calibre database
    conn = sqlite3.connect(f"file:{db_path}?immutable=1", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        books = {}
        for row in conn.execute(
            """
            SELECT b.id, b.title, b.sort AS sort_title, b.author_sort, b.path,
                   b.series_index, b.pubdate,
                   (SELECT name FROM series s
                      JOIN books_series_link l ON l.series = s.id
                      WHERE l.book = b.id) AS series_name,
                   (SELECT group_concat(a.name, ' & ') FROM authors a
                      JOIN books_authors_link l ON l.author = a.id
                      WHERE l.book = b.id) AS authors,
                   (SELECT name FROM publishers p
                      JOIN books_publishers_link l ON l.publisher = p.id
                      WHERE l.book = b.id) AS publisher,
                   (SELECT text FROM comments c WHERE c.book = b.id) AS description,
                   (SELECT lg.lang_code FROM languages lg
                      JOIN books_languages_link l ON l.lang_code = lg.id
                      WHERE l.book = b.id) AS language,
                   (SELECT r.rating FROM ratings r
                      JOIN books_ratings_link l ON l.rating = r.id
                      WHERE l.book = b.id) AS rating
            FROM books b
            """
        ):
            books[row["id"]] = {
                "calibre_id": row["id"],
                "title": row["title"],
                "sort_title": row["sort_title"],
                "author": row["authors"],
                "author_sort": row["author_sort"],
                "path": row["path"],
                "publisher": row["publisher"],
                "published_date": (row["pubdate"] or "")[:10] or None,
                "description": row["description"],
                "language": row["language"],
                "rating": (row["rating"] or 0) // 2 or None,  # calibre uses 0-10
                "series": (
                    {"name": row["series_name"], "index": row["series_index"] or 1.0}
                    if row["series_name"]
                    else None
                ),
                "identifiers": {},
                "tags": [],
            }

        for row in conn.execute("SELECT book, type, val FROM identifiers"):
            book = books.get(row["book"])
            if book is None:
                continue
            kind = row["type"].lower()
            if kind == "isbn":
                key = "isbn_13" if len(row["val"]) == 13 else "isbn_10"
                book["identifiers"][key] = row["val"]
            elif kind in ("goodreads", "openlibrary"):
                book["identifiers"][kind] = row["val"]

        for row in conn.execute(
            """
            SELECT l.book, t.name FROM tags t
            JOIN books_tags_link l ON l.tag = t.id
            """
        ):
            book = books.get(row["book"])
            if book is not None:
                book["tags"].append(row["name"])

        return {"books": list(books.values())}
    finally:
        conn.close()
