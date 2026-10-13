-- When a read status was last set, mirrored from metadata.json so the status
-- can be ordered on a clock of its own rather than reading state's shared one
-- (portable-decisions D5). Not an FTS column, so the sync triggers are
-- unaffected. NULL = no status decision recorded yet.
ALTER TABLE books ADD COLUMN read_status_at TEXT;

-- Upgrade seed: before this column, a status decision moved `reading_updated_at`
-- (touchReadingState's whole job), so that clock is this machine's record of
-- when the status last changed. Carrying it over keeps an already-made decision
-- orderable against the other machine's instead of reading as "no clock" and
-- letting the catalog's status win on the next adoption.
UPDATE books SET read_status_at = reading_updated_at WHERE reading_updated_at IS NOT NULL;
