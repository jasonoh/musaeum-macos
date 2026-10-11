import type { Book } from '@shared/book.types'
import { sortableAuthor, sortableTitle } from '@shared/book.types'

/**
 * The metadata editor's form model: a book as strings, the strings back to
 * `Book` fields, and the diff a save sends. Pure, so the one rule that matters
 * — a save sends what the *person* changed and nothing else — has a decider
 * that does not need a DOM.
 */

export interface FormState {
  title: string
  sortTitle: string
  author: string
  authorSort: string
  seriesName: string
  seriesIndex: string
  seriesTotal: string
  publisher: string
  publishedDate: string
  language: string
  description: string
  tags: string
  isbn10: string
  isbn13: string
  goodreadsId: string
  openlibraryId: string
}

export const EMPTY_FORM: FormState = {
  title: '',
  sortTitle: '',
  author: '',
  authorSort: '',
  seriesName: '',
  seriesIndex: '',
  seriesTotal: '',
  publisher: '',
  publishedDate: '',
  language: '',
  description: '',
  tags: '',
  isbn10: '',
  isbn13: '',
  goodreadsId: '',
  openlibraryId: ''
}

/**
 * A sort key that merely matches the derived form isn't a user choice, so it
 * starts blank — the placeholder tracks the title/author being typed and the
 * save re-derives it. Renaming a book therefore fixes its sort key instead of
 * stranding the old one. A genuinely custom key is shown and left alone.
 */
function customOnly(stored: string | null, derived: string | null): string {
  return stored && stored !== derived ? stored : ''
}

export function toForm(book: Book): FormState {
  return {
    title: book.title,
    sortTitle: customOnly(book.sortTitle, sortableTitle(book.title)),
    author: book.author ?? '',
    authorSort: customOnly(book.authorSort, sortableAuthor(book.author)),
    seriesName: book.seriesName ?? '',
    seriesIndex: book.seriesIndex == null ? '' : String(book.seriesIndex),
    seriesTotal: book.seriesTotal == null ? '' : String(book.seriesTotal),
    publisher: book.publisher ?? '',
    publishedDate: book.publishedDate ?? '',
    language: book.language ?? '',
    description: book.description ?? '',
    tags: book.tags.join(', '),
    isbn10: book.isbn10 ?? '',
    isbn13: book.isbn13 ?? '',
    goodreadsId: book.goodreadsId ?? '',
    openlibraryId: book.openlibraryId ?? ''
  }
}

const trimmed = (s: string): string | null => (s.trim() ? s.trim() : null)

/** Form values → the Book fields they map to, with blanks normalized to null. */
export function toBookFields(form: FormState): Partial<Book> {
  const title = form.title.trim()
  const author = trimmed(form.author)
  const seriesName = trimmed(form.seriesName)
  const index = Number.parseFloat(form.seriesIndex)
  const total = Number.parseInt(form.seriesTotal, 10)
  return {
    title,
    sortTitle: trimmed(form.sortTitle) ?? sortableTitle(title),
    author,
    authorSort: trimmed(form.authorSort) ?? sortableAuthor(author),
    // A book with no series name has no index or total either
    seriesName,
    seriesIndex: seriesName && Number.isFinite(index) ? index : null,
    seriesTotal: seriesName && Number.isFinite(total) ? total : null,
    publisher: trimmed(form.publisher),
    publishedDate: trimmed(form.publishedDate),
    language: trimmed(form.language),
    description: trimmed(form.description),
    tags: form.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    isbn10: trimmed(form.isbn10),
    isbn13: trimmed(form.isbn13),
    goodreadsId: trimmed(form.goodreadsId),
    openlibraryId: trimmed(form.openlibraryId)
  }
}

/** Only the fields whose value differs from the book as loaded. */
export function changedFields(book: Partial<Book>, next: Partial<Book>): Partial<Book> {
  const updates: Partial<Book> = {}
  for (const [key, value] of Object.entries(next) as [keyof Book, unknown][]) {
    const current = book[key]
    const same = Array.isArray(value)
      ? JSON.stringify(value) === JSON.stringify(current)
      : value === current
    if (!same) Object.assign(updates, { [key]: value })
  }
  return updates
}

/**
 * What the person changed in the form, measured against the book **as it was
 * when the panel opened** — never against the live store row.
 *
 * The form is frozen at open but the store is not: a fetch that lands while the
 * panel is up moves the row, and a diff against the row then reads every field
 * the fetch moved as an edit. Measured 2026-10-11 on an isolated profile: with
 * the publisher, description and date changed underneath an open editor, saving
 * only the author recorded all four as the user's (locking three the person
 * never touched) and wrote the form's stale blanks over the fetched values.
 * Both sides go through `toBookFields`, so a stored value the form normalises
 * (trailing space, `''` for null) is not a phantom edit either.
 */
export function editsSince(opened: Book, form: FormState): Partial<Book> {
  return changedFields(toBookFields(toForm(opened)), toBookFields(form))
}
