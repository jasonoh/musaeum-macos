CREATE TABLE books (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  sort_title        TEXT,
  author            TEXT,
  author_sort       TEXT,
  publisher         TEXT,
  published_date    TEXT,
  language          TEXT,
  description       TEXT,
  isbn_10           TEXT,
  isbn_13           TEXT,
  goodreads_id      TEXT,
  openlibrary_id    TEXT,
  series_name       TEXT,
  series_index      REAL,
  series_total      INTEGER,
  cover_thumb_path  TEXT,
  cover_full_path   TEXT,
  formats           TEXT,          -- JSON array
  tags              TEXT,          -- JSON array
  rating            INTEGER,       -- 1-5, user-set
  date_added        TEXT,
  last_modified     TEXT,
  file_size_bytes   INTEGER,
  read_status       TEXT DEFAULT 'unread',
  nas_path          TEXT           -- relative to library root
);

CREATE INDEX idx_books_isbn13 ON books(isbn_13);
CREATE INDEX idx_books_series ON books(series_name, series_index);
CREATE INDEX idx_books_author ON books(author);

CREATE VIRTUAL TABLE books_fts USING fts5(
  title, author, series_name, tags, description,
  content='books', content_rowid='rowid'
);

-- Keep the FTS index in sync with the content table
CREATE TRIGGER books_ai AFTER INSERT ON books BEGIN
  INSERT INTO books_fts(rowid, title, author, series_name, tags, description)
  VALUES (new.rowid, new.title, new.author, new.series_name, new.tags, new.description);
END;

CREATE TRIGGER books_ad AFTER DELETE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, author, series_name, tags, description)
  VALUES ('delete', old.rowid, old.title, old.author, old.series_name, old.tags, old.description);
END;

CREATE TRIGGER books_au AFTER UPDATE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, author, series_name, tags, description)
  VALUES ('delete', old.rowid, old.title, old.author, old.series_name, old.tags, old.description);
  INSERT INTO books_fts(rowid, title, author, series_name, tags, description)
  VALUES (new.rowid, new.title, new.author, new.series_name, new.tags, new.description);
END;

CREATE TABLE collections (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  color TEXT
);

CREATE TABLE book_collections (
  book_id       TEXT REFERENCES books(id),
  collection_id TEXT REFERENCES collections(id),
  PRIMARY KEY (book_id, collection_id)
);

CREATE TABLE device_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     TEXT REFERENCES books(id),
  device_id   TEXT,
  device_name TEXT,
  sent_at     TEXT,
  format_sent TEXT,
  error       TEXT
);

CREATE TABLE metadata_conflicts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id       TEXT REFERENCES books(id),
  field         TEXT,
  candidates    TEXT,    -- JSON array of {source, value} objects
  resolved      INTEGER DEFAULT 0,
  resolved_at   TEXT,
  chosen_source TEXT
);

CREATE INDEX idx_conflicts_unresolved ON metadata_conflicts(resolved) WHERE resolved = 0;

CREATE TABLE app_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT INTO app_config (key, value) VALUES ('rest_api_enabled', 'false');
