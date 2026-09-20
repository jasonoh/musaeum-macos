-- device_history keeps its rows when the book they were sent for is deleted.
--
-- The row is a log of what this machine did — "sent to Kindle on this date" —
-- not a child of the book. `replaceAllBooks` (services/db.ts) documents the
-- same intent and turns FK enforcement off to honour it, but the REFERENCES
-- clause here contradicted that everywhere else: sending a book wrote a
-- history row, and from then on `deleteBook` failed with "FOREIGN KEY
-- constraint failed" *after* book-delete.ts had already removed the NAS
-- folder — leaving a library entry whose files were gone.
--
-- Dropping a constraint is not an ALTER in SQLite, so the table is rebuilt and
-- its rows copied across. Nothing references device_history, so this is safe
-- with foreign_keys ON (the pragma the connection sets).
--
-- The column stays for provenance; it simply no longer promises a book exists.

CREATE TABLE device_history_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     TEXT,
  device_id   TEXT,
  device_name TEXT,
  sent_at     TEXT,
  format_sent TEXT,
  error       TEXT
);

INSERT INTO device_history_new (id, book_id, device_id, device_name, sent_at, format_sent, error)
  SELECT id, book_id, device_id, device_name, sent_at, format_sent, error
    FROM device_history;

DROP TABLE device_history;

ALTER TABLE device_history_new RENAME TO device_history;
