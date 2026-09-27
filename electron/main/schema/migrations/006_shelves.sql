-- Shelves (docs/superpowers/specs/2026-09-27-bookshelves-design.md, D2).
--
-- `shelves` + `shelf_books` are a cache of {library_root}/shelves.json, which is
-- canonical: every shelf write replaces them from the file it just wrote, and
-- adoption does the same on connect and on Reload. So there are no foreign keys —
-- a member may name a book this machine's catalog does not hold yet, and the rows
-- are swapped wholesale.
--
-- `collections` / `book_collections` (001) were never read or written by any
-- feature. They are dropped only when empty: the guard's named CHECK fails the
-- migration — and with it the transaction, leaving user_version at 5 — rather than
-- discard a row some other build wrote. Measured empty on the dev database (7,121
-- books) 2026-09-27; the guard is for every other machine.

CREATE TEMP TABLE migration_006_guard (
  rows INTEGER CONSTRAINT collections_must_be_empty_before_006 CHECK (rows = 0)
);
INSERT INTO migration_006_guard SELECT COUNT(*) FROM book_collections;
INSERT INTO migration_006_guard SELECT COUNT(*) FROM collections;
DROP TABLE migration_006_guard;

DROP TABLE book_collections;
DROP TABLE collections;

CREATE TABLE shelves (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'manual',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE shelf_books (
  shelf_id  TEXT NOT NULL,
  book_id   TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (shelf_id, book_id)
);

CREATE INDEX idx_shelf_books_book ON shelf_books(book_id);
