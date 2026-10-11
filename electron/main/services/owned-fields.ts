import type { HydratedField, OwnedFields } from '@shared/metadata.types'
import { HYDRATED_FIELD_LABELS } from '@shared/metadata.types'

/**
 * The claim map as the record carries it: `{ field: ISO time }`.
 *
 * Pure and dependency-free on purpose — `db.ts` (row ⇄ Book), `catalog.ts`
 * (both files on read) and `library-sync.ts` (adoption) all need the same
 * validator and the same ordering rule, and none of them may import another.
 */
const FIELD_NAMES = new Set<string>(Object.keys(HYDRATED_FIELD_LABELS))

/**
 * Anything → a clean map. Both files that carry it are written by us but read
 * off a share any machine can touch, and the column is JSON text, so every
 * input is `unknown`: a bad value is "no locks" (invariant 12), never a throw,
 * and a bad *member* is dropped without taking its neighbors with it.
 */
export function parseOwnedFields(raw: unknown): OwnedFields {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: OwnedFields = {}
  for (const [key, time] of Object.entries(value)) {
    if (FIELD_NAMES.has(key) && typeof time === 'string' && time !== '') {
      out[key as HydratedField] = time
    }
  }
  return out
}

/** Milliseconds, or `NaN` — every comparison below is written so NaN loses. */
function at(time: string | null | undefined): number {
  return time ? Date.parse(time) : Number.NaN
}

/**
 * Order two machines' opinions about one book, field by field (D2).
 *
 * - On both sides: the strictly newer claim wins; a tie, or a local time that
 *   does not parse, keeps the incoming entry — the same tie rule the reading
 *   reconcile uses, so the two cannot disagree about what "equal" means.
 * - Incoming only: take it. It is another machine's decision.
 * - Local only: an absent entry has no clock, so it is ordered against the
 *   incoming *record's* `last_modified`. A claim not older than that record was
 *   made after the record was written (or is what an upgrade seeded at exactly
 *   that time), so it stands; an older one means the record was rewritten
 *   without it — a release — and it goes. A record with no readable
 *   `last_modified` cannot prove a release, and dropping a decision is the
 *   worse error, so the claim stands.
 */
export function reconcileOwnedFields(
  local: OwnedFields,
  incoming: OwnedFields,
  incomingModifiedAt: string | null
): OwnedFields {
  const recordTime = at(incomingModifiedAt)
  const out: OwnedFields = {}
  const fields = new Set([...Object.keys(local), ...Object.keys(incoming)]) as Set<HydratedField>
  for (const field of fields) {
    const mine = local[field]
    const theirs = incoming[field]
    if (mine && theirs) {
      out[field] = at(mine) > at(theirs) ? mine : theirs
    } else if (theirs) {
      out[field] = theirs
    } else if (mine && !(at(mine) < recordTime)) {
      // `!(a < b)` rather than `a >= b`: NaN on either side must keep the claim
      out[field] = mine
    }
  }
  return out
}

export function sameOwnedFields(a: OwnedFields, b: OwnedFields): boolean {
  const keys = Object.keys(a) as HydratedField[]
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}
