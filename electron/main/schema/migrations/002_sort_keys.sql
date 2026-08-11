-- Backfill sort keys for books cached before they were derived on every write
-- path. Without author_sort a book sorts by its display name ("Seth Dickinson"
-- under S instead of D), which hides it from where the author list expects it.
-- musaeum_sort_title / musaeum_author_sort are registered in services/db.ts so
-- the SQL and the TypeScript write paths share one definition.

UPDATE books
   SET sort_title = musaeum_sort_title(title)
 WHERE title IS NOT NULL AND trim(title) <> ''
   AND (sort_title IS NULL OR trim(sort_title) = '');

UPDATE books
   SET author_sort = musaeum_author_sort(author)
 WHERE author IS NOT NULL AND trim(author) <> ''
   AND (author_sort IS NULL OR trim(author_sort) = '');
