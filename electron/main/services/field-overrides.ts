import type { Book } from '@shared/book.types'
import { sameBookValue } from '@shared/book.types'
import type { HydratedField, OwnedFields } from '@shared/metadata.types'
import { HYDRATED_KEY_FIELD } from '@shared/metadata.types'
import * as db from './db'

/**
 * The fields the user has set, which a fetch must not touch.
 *
 * A manual edit and a resolved conflict are both decisions, and both used to be
 * overwritten by the next re-fetch: the merge never heard about either one, and
 * the source-priority arithmetic could not have honoured one even if it had
 * (`embedded` peaks at 1 + 2.5 against `google_books` at 4). What the user
 * decides is the strongest source of truth the app has, so it is recorded here
 * and enforced twice — the sidecar is told not to *propose* a locked field, and
 * the merged result is filtered before it is *written*.
 *
 * The map is the book's own record: `{ field: ISO time }` in the row's
 * `owned_fields` column, mirrored into `metadata.json` and `catalog.json`, so a
 * fetch run from another machine honours it too and a claim dies with the row
 * it belongs to (D1 of the portable-decisions design). The time is when the
 * claim was made, which is what orders it against another machine's release.
 * The pre-007 home, `app_config.field_overrides`, is read once by the migration
 * (`db.ts`) and never again.
 */

/** The fields this book's fetches must not touch, in no particular order. */
export function list(bookId: string): HydratedField[] {
  return Object.keys(db.getBook(bookId)?.ownedFields ?? {}) as HydratedField[]
}

/**
 * Record the fields a user just set. Callers pass what they wrote **and the row
 * as it was before the write**, because what makes something a decision is the
 * *difference* — a patch that merely restates the row is not one, and after the
 * write every patch restates it.
 *
 * That guard is also what stops a future caller that sends a whole form from
 * locking every field on a book the user only opened: the editor sends a diff
 * today (`BookEditor.changedFields`), and that is a property of one caller
 * rather than of this contract.
 */
export function markFromPatch(
  bookId: string,
  patch: Partial<Book>,
  before: Book | null,
  now: string = new Date().toISOString()
): HydratedField[] {
  const book = db.getBook(bookId)
  if (!book) return []
  const marked = new Set<HydratedField>()
  for (const [key, value] of Object.entries(patch) as [keyof Book, unknown][]) {
    const field = HYDRATED_KEY_FIELD[key]
    if (!field) continue
    if (before && sameBookValue(before[key], value)) continue
    marked.add(field)
  }
  if (!marked.size) return Object.keys(book.ownedFields) as HydratedField[]

  // A fresh decision about a field already held is still a decision: it takes
  // the new time, which is what orders it against another machine's release.
  const next: OwnedFields = { ...book.ownedFields }
  for (const field of marked) next[field] = now
  db.setOwnedFields(bookId, next, now)
  return Object.keys(next) as HydratedField[]
}

/**
 * Let a fetch propose this field again. Deliberately does not touch the value:
 * releasing is "you may have an opinion about this again", not "forget what I
 * chose". A field that is not held changes nothing, `last_modified` included.
 */
export function release(bookId: string, field: HydratedField): HydratedField[] {
  const book = db.getBook(bookId)
  if (!book || !(field in book.ownedFields)) return list(bookId)
  const next: OwnedFields = { ...book.ownedFields }
  delete next[field]
  db.setOwnedFields(bookId, next)
  return Object.keys(next) as HydratedField[]
}
