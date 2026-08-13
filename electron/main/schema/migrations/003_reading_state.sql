-- Reading position, mirrored from metadata.json so library views can show
-- progress without reading thousands of files. Not FTS columns, so the
-- existing sync triggers are unaffected.
ALTER TABLE books ADD COLUMN reading_position TEXT;
ALTER TABLE books ADD COLUMN reading_percent REAL;
ALTER TABLE books ADD COLUMN reading_updated_at TEXT;
