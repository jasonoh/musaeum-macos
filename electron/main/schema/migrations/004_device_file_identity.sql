-- What each book file on a connected device says about *itself*, keyed by the
-- (size, mtime) its facts were read at.
--
-- Presence matches a library book against the device by the title and author
-- inside each file, because the name a host gave the file only identifies the
-- host: Calibre writes `{author_sort}/{title} - {authors}.ext` with its own
-- spellings, so a filename rule saw 86 of 1,555 book files on a real Kindle
-- where the file's own title reaches 1,343. Reading those headers costs the
-- mount's per-file latency rather than bytes — a full pass is ~72s — and the
-- scan runs on every connect, so the facts are cached here.
--
-- Derived data, deliberately: nothing reads this table as a source of truth,
-- and deleting every row costs one full pass and nothing else. A row is a hit
-- only when the file's current size and mtime still match, so a file replaced
-- under the same name is read again rather than believed.
CREATE TABLE device_file_identity (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  title TEXT,
  author TEXT,
  uuid TEXT,
  cdetype TEXT,
  read_at TEXT NOT NULL
);
