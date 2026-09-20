import type { Book } from '@shared/book.types'
import { sameBookValue } from '@shared/book.types'
import type { HydratedField } from '@shared/metadata.types'
import { HYDRATED_FIELD_LABELS, HYDRATED_KEY_FIELD } from '@shared/metadata.types'
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
 * Machine-local by design: one JSON value in `app_config`, keyed by book id.
 * The library file does not carry it, so a fetch run from another machine can
 * still move an overridden field. See D1 of
 * `docs/superpowers/specs/2026-09-20-field-overrides-design.md` for that cost
 * and the condition that would move it into `metadata.json`.
 */
const CONFIG_KEY = 'field_overrides'

/** The vocabulary is `HydratedField` — what a fetch may write is what a user may hold. */
const FIELD_NAMES = new Set<string>(Object.keys(HYDRATED_FIELD_LABELS))

/** The stored map, or `{}` — an unreadable value degrades to "no overrides". */
function read(): Record<string, HydratedField[]> {
  const raw = db.getConfig(CONFIG_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, HydratedField[]> = {}
    for (const [bookId, fields] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(fields)) continue
      // An unknown name is dropped rather than trusted: it would be a field no
      // write path could ever match, so keeping it would only mislead the
      // editor into offering a release for nothing.
      const known = fields.filter(
        (f): f is HydratedField => typeof f === 'string' && FIELD_NAMES.has(f)
      )
      if (known.length) out[bookId] = known
    }
    return out
  } catch (err) {
    // Never fatal: a corrupt value means "no overrides", not a failed
    // hydration and not a failed edit (invariant 12)
    console.error('[overrides] unreadable field_overrides, ignoring it:', err)
    return {}
  }
}

function write(map: Record<string, HydratedField[]>): void {
  db.setConfig(CONFIG_KEY, JSON.stringify(map))
}

/** The fields this book's fetches must not touch, in no particular order. */
export function list(bookId: string): HydratedField[] {
  return read()[bookId] ?? []
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
  before: Book | null
): HydratedField[] {
  const marked = new Set<HydratedField>()
  for (const [key, value] of Object.entries(patch) as [keyof Book, unknown][]) {
    const field = HYDRATED_KEY_FIELD[key]
    if (!field) continue
    if (before && sameBookValue(before[key], value)) continue
    marked.add(field)
  }

  const current = list(bookId)
  const next = [...new Set([...current, ...marked])]
  if (next.length === current.length) return current
  write({ ...read(), [bookId]: next })
  return next
}

/**
 * Let a fetch propose this field again. Deliberately does not touch the value:
 * releasing is "you may have an opinion about this again", not "forget what I
 * chose".
 */
export function release(bookId: string, field: HydratedField): HydratedField[] {
  const map = read()
  const next = (map[bookId] ?? []).filter((f) => f !== field)
  const rest = { ...map }
  if (next.length) rest[bookId] = next
  else delete rest[bookId]
  write(rest)
  return next
}
