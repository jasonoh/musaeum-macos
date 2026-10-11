-- The fields the user has claimed, as { field: ISO time } JSON, mirrored from
-- metadata.json so a second machine can honour them (portable-decisions D1/D2).
-- Not an FTS column, so the sync triggers are unaffected. NULL = no claims.
ALTER TABLE books ADD COLUMN owned_fields TEXT;
